import { CloudFoundryClient } from './cloudfoundry';
import { PortManager } from './port-manager';
import { SSHTunnelManager } from './ssh-tunnel';
import { DebuggerLauncher } from './debugger-launcher';
import { DebugConfig, DebugSession, Logger, AppStatus } from '../types';

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
      const appStatus = await this.cfClient.getAppStatus(config.appName);
      if (!appStatus) {
        this.logger.error(`Application '${config.appName}' not found in current space`);
        await this.showAvailableApps();
        return false;
      }

      if (appStatus.status !== 'started') {
        this.logger.warning(`Application '${config.appName}' is not started (status: ${appStatus.status})`);
        this.logger.info('Attempting to start the application...');
        
        if (!await this.cfClient.startApp(config.appName)) {
          this.logger.error('Failed to start application. Check logs with: cf logs ' + config.appName + ' --recent');
          return false;
        }
      } else {
        this.logger.success(`Application '${config.appName}' is running`);
      }

      // Enable SSH access
      await this.cfClient.enableSSH(config.appName);

      // Cleanup any existing debugging session
      await this.cleanup();

      // Check if port is already in use
      if (await this.portManager.isPortInUse(config.debugPort)) {
        this.logger.warning(`Port ${config.debugPort} is already in use. Debugging may already be running.`);
        return false;
      }

      // Start the application process
      this.logger.step('Starting application process...');
      const appResult = await this.cfClient.startAppProcess(config.appName);
      
      if (!appResult.success) {
        this.logger.error('Failed to start application process');
        return false;
      }

      // Wait for the app to start
      this.logger.info('Waiting for application to start...');
      await new Promise(resolve => setTimeout(resolve, 8000));

      // Find Node.js process
      const nodeProcess = await this.cfClient.findNodeProcess(config.appName);
      if (!nodeProcess) {
        this.logger.error('Failed to find Node.js process. Cannot continue.');
        return false;
      }

      // Create SSH tunnel
      if (!await this.sshTunnel.createTunnel(config.appName, config.debugPort, config.debugPort)) {
        this.logger.error('Failed to create SSH tunnel');
        return false;
      }

      // Enable debugging
      if (!await this.cfClient.enableDebugging(config.appName, nodeProcess.pid)) {
        this.logger.error('Failed to enable debugging');
        return false;
      }

      // Verify tunnel
      await this.portManager.verifyPort(config.debugPort);

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

      this.showDebuggingInfo(config);
      return true;

    } catch (error) {
      this.logger.error(`Setup failed: ${error}`);
      return false;
    }
  }

  async cleanup(): Promise<void> {
    this.logger.info('Cleaning up debugging session...');
    
    await this.sshTunnel.killTunnel();
    await this.portManager.cleanupPort(9229);
    
    this.currentSession = null;
    this.logger.success('Cleanup complete!');
  }

  async showStatus(): Promise<void> {
    this.logger.info('Checking debugging status...');
    
    console.log('');
    console.log('🔍 SSH Processes:');
    // This would need to be implemented with process checking
    console.log('  (SSH process checking not implemented in this version)');
    
    console.log('');
    console.log('🔍 Port 9229 Status:');
    const portInUse = await this.portManager.isPortInUse(9229);
    if (portInUse) {
      console.log('  Port 9229 is in use');
    } else {
      console.log('  Port 9229 is free');
    }
    
    if (this.currentSession) {
      console.log('');
      console.log('🔍 Current Session:');
      console.log(`  App: ${this.currentSession.appName}`);
      console.log(`  Node PID: ${this.currentSession.nodePid}`);
      console.log(`  Debug Port: ${this.currentSession.debugPort}`);
      console.log(`  Started: ${this.currentSession.startTime.toISOString()}`);
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
    console.log('  1. Debugger should be open automatically');
    console.log('  2. Set breakpoints in your code');
    console.log('  3. Trigger your application');
    console.log('  4. Use this tool to cleanup when done');
    console.log('');
    console.log('🧹 To cleanup: npx sap-cap-debugger cleanup');
    console.log('🧹 To cleanup: cds-debug cleanup');
    console.log('');
    console.log('⚠️  IMPORTANT: Keep this terminal open! The debugging session will continue running.');
    console.log('   The processes will keep running until you run cleanup');
    console.log('');
  }
}
