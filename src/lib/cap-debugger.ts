import { CloudFoundryClient } from './cloudfoundry';
import { PortManager } from './port-manager';
import { SSHTunnelManager } from './ssh-tunnel';
import { DebuggerLauncher } from './debugger-launcher';
import { DebugConfig, DebugSession, Logger, AppStatus } from '../types';
import * as readline from 'readline';

export class CAPDebugger {
  private cfClient: CloudFoundryClient;
  private portManager: PortManager;
  private sshTunnel: SSHTunnelManager;
  private debuggerLauncher: DebuggerLauncher;
  private logger: Logger;
  private currentSession: DebugSession | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
    this.cfClient = new CloudFoundryClient(logger);
    this.portManager = new PortManager(logger);
    this.sshTunnel = new SSHTunnelManager(logger);
    this.debuggerLauncher = new DebuggerLauncher(logger);
  }

  async setupDebugging(config: DebugConfig): Promise<boolean> {
    try {
      // Check prerequisites
      if (!await this.cfClient.checkPrerequisites()) {
        return false;
      }

      // Verify app status
      this.logger.loading('Checking application status...');
      const apps = await this.cfClient.getApps();
      const appStatus = apps.find(app => app.name === config.appName) || null;
      this.logger.stopLoading();
      
      if (!appStatus) {
        this.logger.error(`Application '${config.appName}' not found in current space`);
        await this.showAvailableApps();
        return false;
      }

      if (appStatus.status !== 'started') {
        this.logger.warning(`Application '${config.appName}' is not started (status: ${appStatus.status})`);
        this.logger.loading('Starting the application...');
        if (!await this.cfClient.startApp(config.appName)) {
          this.logger.stopLoading();
          this.logger.error('Failed to start application. Check logs with: cf logs ' + config.appName + ' --recent');
          return false;
        }
        this.logger.stopLoading();
      } else {
        this.logger.success(`Application '${config.appName}' is running`);
      }

      // Check and enable SSH access
      const sshEnabled = await this.cfClient.checkSSHEnabled(config.appName);
      if (!sshEnabled) {
        this.logger.info('SSH access is required for remote debugging');
        this.logger.info('This will enable SSH access and restart your application');
        
        // Ask user for confirmation
        const { confirm } = await this.askForConfirmation('Do you want to enable SSH and restart the app? (y/N): ');
        if (!confirm) {
          this.logger.error('SSH access is required. Exiting...');
          return false;
        }
        
        // Enable SSH
        if (!await this.cfClient.enableSSH(config.appName)) {
          this.logger.error('Failed to enable SSH access');
          return false;
        }
        
        // Restart the app to apply SSH changes
        if (!await this.cfClient.startApp(config.appName)) {
          this.logger.error('Failed to restart application after enabling SSH');
          return false;
        }
        
        // Wait for app to be ready
        this.logger.loading('Waiting for application to be ready...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        this.logger.stopLoading();
      }

      // Cleanup any existing debugging session for this app first
      const existingSession = this.portManager.getSession(config.appName);
      if (existingSession) {
        this.logger.info(`Cleaning up existing session for ${config.appName}...`);
        await this.cleanup(config.appName);
        // Wait a moment for processes to fully terminate
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Use the port from config (already assigned by CLI or user)
      const debugPort = config.debugPort;
      
      // Check if port is in use and clean it up if needed
      if (await this.portManager.isPortInUse(debugPort)) {
        // Check if it's our own session
        const existingSession = this.portManager.getSession(config.appName);
        if (existingSession && existingSession.debugPort === debugPort) {
          // This is our session, it will be cleaned up above
          this.logger.debug(`Port ${debugPort} is in use by existing session for ${config.appName}`);
        } else {
          // Try to clean up the port first
          this.logger.info(`Port ${debugPort} is in use, attempting to clean up...`);
          await this.portManager.cleanupPort(debugPort);
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Check again
          if (await this.portManager.isPortInUse(debugPort)) {
            const otherSession = this.portManager.getAllSessions().find(s => s.debugPort === debugPort && s.appName !== config.appName);
            if (otherSession) {
              this.logger.error(`Port ${debugPort} is already in use by ${otherSession.appName}`);
              return false;
            } else {
              this.logger.warning(`Port ${debugPort} is still in use after cleanup. Proceeding anyway...`);
            }
          }
        }
      }

      // Start the application process
      // Note: The app is already running, but we call this to ensure the process is active
      const appResult = await this.cfClient.startAppProcess(config.appName);
      
      if (!appResult.success) {
        this.logger.error('Failed to start application process');
        return false;
      }

      // Wait for the app to start
      this.logger.loading('Waiting for application to start...');
      await new Promise(resolve => setTimeout(resolve, 8000));
      this.logger.stopLoading();

      // Find Node.js process
      this.logger.loading(`Finding Node.js process for ${config.appName}...`);
      const nodeProcess = await this.cfClient.findNodeProcess(config.appName);
      this.logger.stopLoading();
      
      if (!nodeProcess) {
        this.logger.error(`Failed to find Node.js process for ${config.appName}. Cannot continue.`);
        return false;
      }

      this.logger.info(`Found Node.js process: PID ${nodeProcess.pid} for ${config.appName}`);
      this.logger.info(`Process command: ${nodeProcess.command.substring(0, 80)}...`);

      // Create SSH tunnel - forward local port to remote inspector port
      // IMPORTANT: kill -USR1 always uses port 9229 on the remote side
      // So we must forward to remote port 9229, not config.debugPort
      // Each app has its own container, so each has its own inspector on port 9229
      const remoteInspectorPort = 9229; // kill -USR1 always uses 9229
      this.logger.loading(`Creating SSH tunnel for ${config.appName}...`);
      this.logger.info(`Tunnel: localhost:${config.debugPort} -> ${config.appName}:${remoteInspectorPort}`);
      this.logger.info(`Note: Each app has its own inspector on port ${remoteInspectorPort} in its own container`);
      const tunnelCreated = await this.sshTunnel.createTunnel(config.appName, config.debugPort, remoteInspectorPort);
      this.logger.stopLoading();
      
      if (!tunnelCreated) {
        this.logger.error(`Failed to create SSH tunnel for ${config.appName} on port ${config.debugPort}`);
        this.logger.error('This might be due to:');
        this.logger.error('  - Cloud Foundry SSH connection limit');
        this.logger.error('  - Network connectivity issues');
        this.logger.error('  - Authentication problems');
        this.logger.error(`Try running: cf ssh ${config.appName} -c 'echo test' to verify SSH access`);
        return false;
      }

      this.logger.success(`SSH tunnel created: localhost:${config.debugPort} -> ${config.appName}:${remoteInspectorPort}`);
      this.logger.info(`This tunnel connects to ${config.appName}'s inspector (PID ${nodeProcess.pid})`);

      // Enable debugging on the specific process
      // Note: kill -USR1 always enables inspector on port 9229 on the remote side
      this.logger.info(`Enabling debugging on process ${nodeProcess.pid} for ${config.appName}...`);
      if (!await this.cfClient.enableDebugging(config.appName, nodeProcess.pid, config.debugPort)) {
        this.logger.error(`Failed to enable debugging on process ${nodeProcess.pid} for ${config.appName}`);
        return false;
      }
      
      this.logger.success(`Debugging enabled on PID ${nodeProcess.pid} for ${config.appName} (port ${remoteInspectorPort})`);

      // Wait a moment for tunnel to fully establish
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Verify tunnel is actually working
      this.logger.loading('Verifying tunnel...');
      const portInUse = await this.portManager.isPortInUse(config.debugPort);
      if (!portInUse) {
        this.logger.stopLoading();
        this.logger.error(`Port ${config.debugPort} is not in use - tunnel may have failed`);
        this.logger.error('The SSH tunnel process may have exited. Check the logs above for errors.');
        return false;
      }
      await this.portManager.verifyPort(config.debugPort);
      this.logger.stopLoading();

      // Launch debugger
      await this.debuggerLauncher.launchDebugger(config.debuggerType, config.debugPort);

      // Create session record
      this.currentSession = {
        appName: config.appName,
        nodePid: nodeProcess.pid,
        sshTunnelPid: 0, // We don't track this in the current implementation
        appProcessPid: 0, // We don't track this in the current implementation
        debugPort: config.debugPort,
        startTime: new Date()
      };

      // Save session
      this.portManager.saveSession(this.currentSession);

      this.showDebuggingInfo(config);
      return true;

    } catch (error) {
      this.logger.error(`Setup failed: ${error}`);
      return false;
    }
  }

  async cleanup(appName?: string): Promise<void> {
    if (appName) {
      // Cleanup specific app
      this.logger.loading(`Cleaning up debugging session for ${appName}...`);
      
      const session = this.portManager.getSession(appName);
      if (session) {
        // Kill the SSH tunnel for this specific port
        await this.sshTunnel.killTunnel(session.debugPort);
        await this.portManager.cleanupPort(session.debugPort);
        this.portManager.removeSession(appName);
        if (this.currentSession && this.currentSession.appName === appName) {
          this.currentSession = null;
        }
        this.logger.stopLoading();
        this.logger.success(`Cleanup complete for ${appName}!`);
      } else {
        this.logger.stopLoading();
        this.logger.warning(`No active session found for ${appName}`);
      }
    } else {
      // Cleanup all sessions
      this.logger.loading('Cleaning up all debugging sessions...');
      
      const sessions = this.portManager.getAllSessions();
      for (const session of sessions) {
        // Kill the SSH tunnel for each port
        await this.sshTunnel.killTunnel(session.debugPort);
        await this.portManager.cleanupPort(session.debugPort);
      }
      
      this.portManager.clearAllSessions();
      // Kill any remaining tunnels
      await this.sshTunnel.killTunnel();
      
      this.currentSession = null;
      this.logger.stopLoading();
      this.logger.success('Cleanup complete!');
    }
  }

  getAllSessions(): DebugSession[] {
    return this.portManager.getAllSessions();
  }

  async showStatus(): Promise<void> {
    this.logger.loading('Checking debugging status...');
    
    const sessions = this.portManager.getAllSessions();
    this.logger.stopLoading();
    
    console.log('');
    
    if (sessions.length === 0) {
      console.log('🔍 Active Debugging Sessions:');
      console.log('  No active sessions');
      console.log('');
      return;
    }
    
    // Separate active and inactive sessions
    this.logger.loading('Checking session status...');
    const activeSessions: DebugSession[] = [];
    const inactiveSessions: DebugSession[] = [];
    
    for (const session of sessions) {
      const portInUse = await this.portManager.isPortInUse(session.debugPort);
      if (portInUse) {
        activeSessions.push(session);
      } else {
        inactiveSessions.push(session);
      }
    }
    this.logger.stopLoading();
    
    // Show active sessions
    if (activeSessions.length > 0) {
      console.log('🟢 Active Debugging Sessions:');
      for (const session of activeSessions) {
        const duration = Math.floor((Date.now() - session.startTime.getTime()) / 1000 / 60);
        console.log(`  ${session.appName}`);
        console.log(`    Port: ${session.debugPort}`);
        console.log(`    Node PID: ${session.nodePid}`);
        console.log(`    Started: ${session.startTime.toLocaleString()} (${duration} min ago)`);
        console.log(`    Connect: chrome://inspect or http://localhost:${session.debugPort}`);
        console.log('');
      }
    }
    
    // Show inactive sessions
    if (inactiveSessions.length > 0) {
      console.log('🔴 Inactive Sessions (stale - can be cleaned up):');
      for (const session of inactiveSessions) {
        const duration = Math.floor((Date.now() - session.startTime.getTime()) / 1000 / 60);
        console.log(`  ${session.appName}`);
        console.log(`    Port: ${session.debugPort} (not in use)`);
        console.log(`    Node PID: ${session.nodePid}`);
        console.log(`    Started: ${session.startTime.toLocaleString()} (${duration} min ago)`);
        console.log('');
      }
      console.log('💡 Tip: Run "cds-debug cleanup" to remove inactive sessions');
      console.log('');
    }
    
    if (activeSessions.length === 0 && inactiveSessions.length === 0) {
      console.log('  No sessions found');
      console.log('');
    }
  }

  private async showAvailableApps(): Promise<void> {
    try {
      const apps = await this.cfClient.getApps();
      this.logger.info('Available applications:');
      apps.forEach(app => {
        console.log(`  ${app.name} (${app.status})`);
      });
    } catch (error) {
      this.logger.error('Failed to get available applications');
    }
  }

  private showDebuggingInfo(config: DebugConfig): void {
    console.log('');
    this.logger.success('🎉 Remote debugging setup complete!');
    console.log('');
    console.log('📋 Debugging Information:');
    console.log(`  • Application: ${config.appName}`);
    console.log(`  • Debug Port: ${config.debugPort}`);
    console.log(`  • Debugger Type: ${config.debuggerType}`);
    console.log('');
    console.log('🔧 Next Steps:');
    console.log('  1. Chrome DevTools should be open automatically');
    console.log('  2. Click \'inspect\' on your Node.js process');
    console.log('  3. Set breakpoints in your code');
    console.log('  4. Trigger your application');
    console.log('  5. Use this tool to cleanup when done');
    console.log('');
    console.log(`🧹 To cleanup this app: cds-debug cleanup ${config.appName}`);
    console.log('🧹 To cleanup all: cds-debug cleanup');
    console.log('');
    console.log('⚠️  IMPORTANT: Keep this terminal open! The debugging session will continue running.');
    console.log('   The processes will keep running until you run cleanup');
    console.log('');
  }

  private async askForConfirmation(question: string): Promise<{ confirm: boolean }> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        const confirm = answer.toLowerCase().trim() === 'y' || answer.toLowerCase().trim() === 'yes';
        resolve({ confirm });
      });
    });
  }
}
