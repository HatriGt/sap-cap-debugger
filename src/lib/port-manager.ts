import { CommandExecutor } from '../utils/command';
import { Logger } from '../types';

export class PortManager {
  private commandExecutor: CommandExecutor;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.commandExecutor = new CommandExecutor(logger);
  }

  async isPortInUse(port: number): Promise<boolean> {
    const result = await this.commandExecutor.execute('netstat', ['-an']);
    
    if (result.success) {
      return result.output.includes(`:${port}`) && result.output.includes('LISTEN');
    }
    
    return false;
  }

  async killProcessesOnPort(port: number): Promise<boolean> {
    this.logger.info(`Killing processes on port ${port}...`);
    
    // Try to find processes using the port
    const lsofResult = await this.commandExecutor.execute('lsof', ['-ti', `:${port}`]);
    
    if (lsofResult.success && lsofResult.output.trim()) {
      const pids = lsofResult.output.trim().split('\n');
      
      for (const pid of pids) {
        if (pid.trim()) {
          this.logger.debug(`Killing process ${pid} on port ${port}`);
          await this.commandExecutor.execute('kill', ['-9', pid.trim()]);
        }
      }
    }

    // Also kill any cf ssh processes
    await this.commandExecutor.execute('pkill', ['-f', 'cf ssh']);
    
    return true;
  }

  async verifyPort(port: number, maxAttempts: number = 15): Promise<boolean> {
    this.logger.info(`Verifying port ${port}...`);
    
    let attempt = 1;
    
    while (attempt <= maxAttempts) {
      if (await this.isPortInUse(port)) {
        this.logger.success(`Port ${port} is in use`);
        return true;
      }
      
      this.logger.info(`Waiting for port to be available... (attempt ${attempt}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempt++;
    }
    
    this.logger.warning(`Port ${port} verification failed, but continuing...`);
    return false;
  }

  async cleanupPort(port: number): Promise<void> {
    this.logger.info(`Cleaning up port ${port}...`);
    
    await this.killProcessesOnPort(port);
    
    // Verify cleanup
    if (await this.isPortInUse(port)) {
      this.logger.warning(`Port ${port} is still in use after cleanup`);
    } else {
      this.logger.success(`Port ${port} is free`);
    }
  }
}
