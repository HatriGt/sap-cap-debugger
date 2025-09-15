import { CommandExecutor } from '../utils/command';
import { AppStatus, ProcessInfo, CommandResult } from '../types';
import { Logger } from '../types';

export class CloudFoundryClient {
  private commandExecutor: CommandExecutor;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.commandExecutor = new CommandExecutor(logger);
  }

  async checkPrerequisites(): Promise<boolean> {
    this.logger.info('Checking prerequisites...');

    const cfExists = await this.commandExecutor.checkCommandExists('cf');
    if (!cfExists) {
      this.logger.error('Cloud Foundry CLI (cf) is not installed or not in PATH');
      return false;
    }

    const netstatExists = await this.commandExecutor.checkCommandExists('netstat');
    if (!netstatExists) {
      this.logger.error('netstat command is not available');
      return false;
    }

    this.logger.success('Prerequisites check passed');
    return true;
  }

  async getApps(): Promise<AppStatus[]> {
    const result = await this.commandExecutor.execute('cf', ['apps']);
    
    if (!result.success) {
      throw new Error(`Failed to get apps: ${result.error}`);
    }

    const lines = result.output.split('\n');
    const apps: AppStatus[] = [];

    for (const line of lines) {
      if (line.includes('started') || line.includes('stopped')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
          apps.push({
            name: parts[0],
            status: parts[1] as 'started' | 'stopped' | 'unknown',
            instances: parts[2],
            memory: parts[3],
            disk: parts[4] || '',
            urls: parts.slice(5) || []
          });
        }
      }
    }

    return apps;
  }

  async getAppStatus(appName: string): Promise<AppStatus | null> {
    const apps = await this.getApps();
    return apps.find(app => app.name === appName) || null;
  }

  async startApp(appName: string): Promise<boolean> {
    this.logger.info(`Starting application: ${appName}`);
    
    const result = await this.commandExecutor.execute('cf', ['start', appName]);
    
    if (result.success) {
      this.logger.success(`Application ${appName} started successfully`);
      return true;
    } else {
      this.logger.error(`Failed to start application: ${result.error}`);
      return false;
    }
  }

  async enableSSH(appName: string): Promise<boolean> {
    this.logger.info(`Enabling SSH access for application: ${appName}`);
    
    const result = await this.commandExecutor.execute('cf', ['enable-ssh', appName]);
    
    if (result.success) {
      this.logger.success('SSH access enabled');
      return true;
    } else {
      this.logger.warning('SSH access may already be enabled or failed to enable');
      return false;
    }
  }

  async startAppProcess(appName: string): Promise<CommandResult> {
    this.logger.info('Starting application process...');
    
    const command = `export PATH='/home/vcap/deps/0/bin:$PATH' && cd /home/vcap/app && /home/vcap/deps/0/bin/node srv/server.js`;
    
    return await this.commandExecutor.execute('cf', ['ssh', appName, '-c', command]);
  }

  async findNodeProcess(appName: string): Promise<ProcessInfo | null> {
    this.logger.info('Finding Node.js process...');
    
    const maxAttempts = 10;
    let attempt = 1;

    while (attempt <= maxAttempts) {
      const result = await this.commandExecutor.execute('cf', ['ssh', appName, '-c', 'ps aux | grep node | grep -v grep']);
      
      if (result.success && result.output.trim()) {
        const lines = result.output.trim().split('\n');
        
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 11 && parts[10] && parts[10].includes('node')) {
            const pid = parseInt(parts[1]);
            if (!isNaN(pid)) {
              this.logger.success(`Found Node.js process with PID: ${pid}`);
              return {
                pid,
                name: parts[10],
                command: line
              };
            }
          }
        }
      }

      this.logger.info(`Waiting for Node.js process... (attempt ${attempt}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      attempt++;
    }

    this.logger.error('Could not find Node.js process after maximum attempts');
    return null;
  }

  async enableDebugging(appName: string, pid: number): Promise<boolean> {
    this.logger.info(`Enabling debugging on process ${pid}...`);
    
    const result = await this.commandExecutor.execute('cf', ['ssh', appName, '-c', `kill -USR1 ${pid}`]);
    
    if (result.success) {
      this.logger.success(`Debugging enabled on process ${pid}`);
      return true;
    } else {
      this.logger.error('Failed to enable debugging');
      return false;
    }
  }

  async getAppLogs(appName: string): Promise<string> {
    const result = await this.commandExecutor.execute('cf', ['logs', appName, '--recent']);
    return result.output;
  }
}
