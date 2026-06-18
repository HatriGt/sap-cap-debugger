import { CloudFoundryClient } from './cloudfoundry';
import { PortManager } from './port-manager';
import { SSHTunnelManager } from './ssh-tunnel';
import { DebuggerLauncher } from './debugger-launcher';
import { DebugConfig, DebugSession, Logger, AppStatus } from '../types';
import * as readline from 'readline';
import { AuthExpiredError } from './cloudfoundry';
import { getWorkspace, touchWorkspaceLastUsed } from './workspaces';

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
    return await this.setupDebuggingInner(config, false);
  }

  private async setupDebuggingInner(config: DebugConfig, retriedAuth: boolean): Promise<boolean> {
    // Ensure CF operations and tunnel use the selected workspace CF_HOME (if any)
    const cfHomeDir = config.workspaceCfHomeDir || (config.workspaceName ? getWorkspace(config.workspaceName, this.logger)?.cfHomeDir : undefined);
    const cfEnv = cfHomeDir ? { CF_HOME: cfHomeDir } : undefined;
    this.cfClient = new CloudFoundryClient(this.logger, cfEnv, config.workspaceName);
    this.sshTunnel = new SSHTunnelManager(this.logger, cfEnv);
    if (config.workspaceName) {
      touchWorkspaceLastUsed(config.workspaceName, this.logger);
    }

    try {
      // Check prerequisites
      if (!await this.cfClient.checkPrerequisites()) {
        return false;
      }

      // Verify the app exists in the current target
      this.logger.loading('Checking application...');
      const apps = await this.cfClient.getApps();
      let appStatus = apps.find(app => app.name === config.appName) || null;
      this.logger.stopLoading();

      if (!appStatus) {
        this.logger.error(`Application '${config.appName}' not found in current space`);
        await this.showAvailableApps();
        return false;
      }

      // STEP 1: check the SSH flag (cf ssh-enabled).
      // STEP 2: if not enabled, run cf enable-ssh. Enabling SSH only takes effect
      // on instances started afterwards, so a freshly-enabled app MUST be
      // restarted (tracked via justEnabled) before cf ssh will work.
      const sshFlagEnabled = await this.cfClient.checkSSHEnabled(config.appName);
      let justEnabled = false;
      if (!sshFlagEnabled) {
        this.logger.info(`SSH is not enabled. Running 'cf enable-ssh ${config.appName}'...`);
        await this.cfClient.enableSSH(config.appName);
        justEnabled = true;
      } else {
        this.logger.success(`SSH is enabled for '${config.appName}'`);
      }

      // STEP 3: make sure the application is started.
      this.logger.loading('Checking application status...');
      appStatus = await this.cfClient.getAppStatus(config.appName);
      this.logger.stopLoading();
      if (!appStatus || appStatus.status !== 'started') {
        this.logger.warning(`Application '${config.appName}' is not started (status: ${appStatus?.status ?? 'unknown'})`);
        this.logger.loading('Starting the application...');
        if (!await this.cfClient.startApp(config.appName)) {
          this.logger.stopLoading();
          this.logger.error(`Failed to start application. Check logs with: cf logs ${config.appName} --recent`);
          return false;
        }
        this.logger.stopLoading();
      } else {
        this.logger.success(`Application '${config.appName}' is running`);
      }

      // STEP 4: make cf ssh work.
      // If we just enabled SSH, the running instances predate it and must be
      // cycled - restart right away (no point testing first, it will fail).
      let restarted = false;
      if (justEnabled) {
        this.logger.info('SSH was just enabled - restarting the app so it takes effect...');
        if (!await this.cfClient.restartApp(config.appName)) {
          this.logger.error(`Failed to restart '${config.appName}'.`);
          return false;
        }
        restarted = true;
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      // Confirm cf ssh works. If it still fails and we haven't restarted yet
      // (flag was already enabled but instances are stale), restart once and
      // re-test - exactly like doing it by hand.
      let sshWorks = await this.cfClient.testSSHConnection(config.appName);
      if (!sshWorks && !restarted) {
        this.logger.warning('cf ssh is not authorized yet - restarting the app so SSH takes effect...');
        if (!await this.cfClient.restartApp(config.appName)) {
          this.logger.error(`Failed to restart '${config.appName}'.`);
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
        sshWorks = await this.cfClient.testSSHConnection(config.appName);
      }
      if (!sshWorks) {
        this.logger.error(`Cannot open an SSH session to '${config.appName}' even after a restart.`);
        this.logger.error('If SSH is blocked at the space level, run:');
        this.logger.error(`  cf allow-space-ssh <your-space>   (then retry)`);
        this.logger.error(`Verify manually: cf ssh ${config.appName} -c 'echo ok'`);
        return false;
      }

      // Clean up any previous session / stale local port for this app.
      const existingSession = this.portManager.getSession(config.appName, config.workspaceName);
      if (existingSession) {
        this.logger.info(`Cleaning up existing session for ${config.appName}...`);
        await this.cleanup(config.appName, config.workspaceName);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      if (await this.portManager.isPortInUse(config.debugPort)) {
        this.logger.info(`Port ${config.debugPort} is in use, attempting to clean up...`);
        await this.portManager.cleanupPort(config.debugPort);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      // The remote inspector always listens on 9229 (that's what kill -USR1
      // enables), regardless of the local debug port.
      const remoteInspectorPort = 9229;

      // STEP 5a: enable the inspector on the remote node process(es), exactly
      // like the manual command: cf ssh <app> -c 'kill -USR1 $(pgrep node)'.
      this.logger.info(`Enabling debugging for ${config.appName}...`);
      if (!await this.cfClient.enableDebugging(config.appName, 0, config.debugPort)) {
        this.logger.error(`Failed to enable debugging for ${config.appName}`);
        return false;
      }
      this.logger.success(`Debugging enabled for ${config.appName} (remote port ${remoteInspectorPort})`);

      // STEP 5b: open the SSH tunnel, like the manual command:
      // cf ssh -N -T -L <debugPort>:127.0.0.1:9229 <app>.
      this.logger.loading(`Creating SSH tunnel for ${config.appName}...`);
      this.logger.info(`Tunnel: localhost:${config.debugPort} -> ${config.appName}:${remoteInspectorPort}`);
      const tunnelCreated = await this.sshTunnel.createTunnel(config.appName, config.debugPort, remoteInspectorPort);
      this.logger.stopLoading();

      if (!tunnelCreated) {
        this.logger.error(`Failed to create SSH tunnel for ${config.appName} on port ${config.debugPort}`);
        this.logger.error('This might be due to:');
        this.logger.error('  - Cloud Foundry SSH connection limit');
        this.logger.error('  - Network connectivity issues');
        this.logger.error(`Try running: cf ssh ${config.appName} -c 'echo test' to verify SSH access`);
        return false;
      }

      this.logger.success(`SSH tunnel created: localhost:${config.debugPort} -> ${config.appName}:${remoteInspectorPort}`);

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
        workspaceName: config.workspaceName,
        nodePid: 0,
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
      if (error instanceof AuthExpiredError) {
        const wsName = error.workspaceName || config.workspaceName;
        if (wsName && !retriedAuth) {
          const ws = getWorkspace(wsName, this.logger);
          const loginMethod = ws?.loginMethod || 'standard';
          this.logger.warning(`Cloud Foundry session expired for workspace '${wsName}'`);
          const { confirm } = await this.askForConfirmation('Re-login now? (y/N): ');
          if (!confirm) {
            this.logger.error('Cannot continue without Cloud Foundry login.');
            return false;
          }

          // Interactive re-login using the selected workspace CF_HOME
          this.logger.loading('Re-authenticating with Cloud Foundry...');
          const reauthResult = await this.cfClient.login(loginMethod);
          this.logger.stopLoading();
          if (!reauthResult?.success) {
            this.logger.error('Re-login failed.');
            return false;
          }

          // Retry once
          return await this.setupDebuggingInner({ ...config }, true);
        }
      }

      this.logger.error(`Setup failed: ${error}`);
      return false;
    }
  }

  async cleanup(appName?: string, workspaceName?: string): Promise<void> {
    if (appName) {
      // Cleanup specific app
      this.logger.loading(`Cleaning up debugging session for ${appName}...`);
      
      const session = this.portManager.getSession(appName, workspaceName);
      if (session) {
        // Kill the SSH tunnel for this specific port
        await this.sshTunnel.killTunnel(session.debugPort);
        await this.portManager.cleanupPort(session.debugPort);
        this.portManager.removeSession(appName, workspaceName);
        if (this.currentSession && this.currentSession.appName === appName && (this.currentSession.workspaceName || '') === (workspaceName || '')) {
          this.currentSession = null;
        }
        this.logger.stopLoading();
        const wsLabel = workspaceName ? ` (workspace: ${workspaceName})` : '';
        this.logger.success(`Cleanup complete for ${appName}${wsLabel}!`);
      } else {
        this.logger.stopLoading();
        this.logger.warning(`No active session found for ${appName}${workspaceName ? ` in workspace ${workspaceName}` : ''}`);
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
        console.log(`  ${session.workspaceName ? `[${session.workspaceName}] ` : ''}${session.appName}`);
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
        console.log(`  ${session.workspaceName ? `[${session.workspaceName}] ` : ''}${session.appName}`);
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
    if (config.workspaceName) {
      console.log(`  • Workspace: ${config.workspaceName}`);
    }
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
