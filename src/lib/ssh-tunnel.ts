import { spawn } from 'child_process';
import { Logger } from '../types';

export class SSHTunnelManager {
  private logger: Logger;
  private tunnelProcess: any = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async createTunnel(appName: string, localPort: number, remotePort: number): Promise<boolean> {
    this.logger.info(`Creating SSH tunnel for port ${localPort}...`);
    
    return new Promise((resolve) => {
      let resolved = false;
      let timeoutId: NodeJS.Timeout | undefined;

      try {
        // Start the SSH tunnel as a background process
        this.tunnelProcess = spawn('cf', [
          'ssh', '-N', '-T', '-L', `${localPort}:127.0.0.1:${remotePort}`, appName
        ], {
          stdio: 'pipe',
          detached: false
        });

        // Set a timeout to prevent hanging
        timeoutId = setTimeout(() => {
          if (!resolved) {
            this.logger.warning('SSH tunnel creation timed out, but continuing...');
            this.logger.info('This is normal - the tunnel may still work for debugging');
            resolved = true;
            resolve(true);
          }
        }, 10000); // 10 second timeout

        // Handle process events
        this.tunnelProcess.on('error', (error: any) => {
          if (!resolved) {
            this.logger.error(`SSH tunnel process error: ${error.message}`);
            clearTimeout(timeoutId);
            resolved = true;
            resolve(false);
          }
        });

        this.tunnelProcess.on('exit', (code: number) => {
          this.logger.debug(`SSH tunnel process exited with code: ${code}`);
          this.tunnelProcess = null;
        });

        // Wait a moment for the tunnel to establish
        setTimeout(() => {
          if (!resolved) {
            if (this.tunnelProcess && !this.tunnelProcess.killed) {
              this.logger.success(`SSH tunnel created for port ${localPort}`);
              clearTimeout(timeoutId);
              resolved = true;
              resolve(true);
            } else {
              this.logger.error('SSH tunnel process failed to start');
              clearTimeout(timeoutId);
              resolved = true;
              resolve(false);
            }
          }
        }, 3000);

      } catch (error) {
        if (!resolved) {
          this.logger.error(`Failed to create SSH tunnel: ${error}`);
          if (timeoutId) clearTimeout(timeoutId);
          resolved = true;
          resolve(false);
        }
      }
    });
  }

  async killTunnel(): Promise<void> {
    if (this.tunnelProcess) {
      this.logger.info('Killing SSH tunnel...');
      try {
        this.tunnelProcess.kill('SIGTERM');
        this.tunnelProcess = null;
      } catch (error) {
        this.logger.debug(`Error killing tunnel process: ${error}`);
      }
    }
    
    // Also kill any remaining cf ssh processes
    try {
      const { exec } = require('child_process');
      exec('pkill -f "cf ssh"', (error: any) => {
        if (error) {
          this.logger.debug(`Error killing cf ssh processes: ${error.message}`);
        }
      });
    } catch (error) {
      this.logger.debug(`Error executing pkill: ${error}`);
    }
  }

  isTunnelActive(): boolean {
    return this.tunnelProcess !== null;
  }
}
