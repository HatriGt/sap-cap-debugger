import { spawn, exec } from 'child_process';
import { Logger } from '../types';

export class SSHTunnelManager {
  private logger: Logger;
  private tunnelProcesses: Map<number, any> = new Map(); // Map<port, process>
  private cfEnv?: Record<string, string>;

  constructor(logger: Logger, cfEnv?: Record<string, string>) {
    this.logger = logger;
    this.cfEnv = cfEnv;
  }

  async createTunnel(appName: string, localPort: number, remotePort: number): Promise<boolean> {
    this.logger.loading(`Creating SSH tunnel for port ${localPort}...`);
    
    return new Promise((resolve) => {
      let resolved = false;
      let timeoutId: NodeJS.Timeout | undefined;
      let stderrOutput = '';

      try {
        // Kill any existing tunnel on this port first
        if (this.tunnelProcesses.has(localPort)) {
          const existingProcess = this.tunnelProcesses.get(localPort);
          if (existingProcess && !existingProcess.killed) {
            this.logger.debug(`Killing existing tunnel on port ${localPort}`);
            existingProcess.kill('SIGTERM');
          }
          this.tunnelProcesses.delete(localPort);
        }

        // Start the SSH tunnel as a background process
        // The appName parameter ensures we connect to the correct app's container
        this.logger.debug(`Creating SSH tunnel: local port ${localPort} -> ${appName}:${remotePort}`);
        const tunnelProcess = spawn('cf', [
          'ssh', '-N', '-T', '-L', `${localPort}:127.0.0.1:${remotePort}`, appName
        ], {
          env: this.cfEnv ? { ...process.env, ...this.cfEnv } : process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false
        });

        // Store the process by port
        this.tunnelProcesses.set(localPort, tunnelProcess);

        // Capture stderr to see error messages
        tunnelProcess.stderr?.on('data', (data: Buffer) => {
          const output = data.toString();
          stderrOutput += output;
          // Log errors immediately (not just debug) so we can see what's wrong
          if (output.toLowerCase().includes('error') || output.toLowerCase().includes('failed')) {
            this.logger.warning(`SSH tunnel stderr: ${output.trim()}`);
          } else {
            this.logger.debug(`SSH tunnel stderr: ${output}`);
          }
        });

        // Set a timeout to prevent hanging
        timeoutId = setTimeout(() => {
          if (!resolved) {
            this.logger.stopLoading();
            this.logger.warning('SSH tunnel creation timed out, but continuing...');
            this.logger.info('This is normal - the tunnel may still work for debugging');
            resolved = true;
            resolve(true);
          }
        }, 10000); // 10 second timeout

        // Handle process events
        tunnelProcess.on('error', (error: any) => {
          if (!resolved) {
            this.logger.stopLoading();
            this.logger.error(`SSH tunnel process error: ${error.message}`);
            if (stderrOutput) {
              this.logger.error(`SSH tunnel stderr: ${stderrOutput}`);
            }
            this.tunnelProcesses.delete(localPort);
            clearTimeout(timeoutId);
            resolved = true;
            resolve(false);
          }
        });

        tunnelProcess.on('exit', (code: number, signal: string) => {
          this.logger.debug(`SSH tunnel process exited with code: ${code}, signal: ${signal}`);
          
          // If process exits immediately with non-zero code, it failed
          if (!resolved && code !== null && code !== 0) {
            this.logger.stopLoading();
            this.logger.error(`SSH tunnel process exited with error code: ${code}`);
            if (stderrOutput) {
              this.logger.error(`SSH tunnel error output: ${stderrOutput.trim()}`);
            }
            this.logger.error(`Failed to create SSH tunnel for ${appName} on port ${localPort}`);
            this.tunnelProcesses.delete(localPort);
            clearTimeout(timeoutId);
            resolved = true;
            resolve(false);
          }
          
          // If process exits with code 0 but we haven't resolved yet, it might have failed
          // (though exit code 0 usually means success, but for SSH tunnels it might exit immediately)
          if (!resolved && code === 0 && signal === null) {
            // This is unusual - SSH tunnels should stay running
            this.logger.warning(`SSH tunnel process exited with code 0 (unexpected for background tunnel)`);
          }
          
          // Remove from map when process exits (but only if we've resolved)
          if (resolved) {
            this.tunnelProcesses.delete(localPort);
          }
        });

        // Wait a moment for the tunnel to establish
        setTimeout(() => {
          if (!resolved) {
            // Check if process is still running
            if (tunnelProcess && tunnelProcess.exitCode === null && !tunnelProcess.killed) {
              this.logger.stopLoading();
              this.logger.success(`SSH tunnel created for ${appName} on port ${localPort}`);
              clearTimeout(timeoutId);
              resolved = true;
              resolve(true);
            } else {
              // Process exited or was killed
              const exitCode = tunnelProcess?.exitCode;
              this.logger.stopLoading();
              if (exitCode !== null && exitCode !== 0) {
                this.logger.error(`SSH tunnel process failed to start (exit code: ${exitCode})`);
                if (stderrOutput) {
                  this.logger.error(`SSH tunnel error: ${stderrOutput.trim()}`);
                }
              } else if (exitCode === 0) {
                this.logger.error(`SSH tunnel process exited immediately (code: 0). This usually means authentication or connection failed.`);
                if (stderrOutput) {
                  this.logger.error(`SSH tunnel error: ${stderrOutput.trim()}`);
                }
              } else {
                this.logger.error(`SSH tunnel process failed to start for ${appName} on port ${localPort}`);
                if (stderrOutput) {
                  this.logger.error(`SSH tunnel error: ${stderrOutput.trim()}`);
                }
              }
              this.tunnelProcesses.delete(localPort);
              clearTimeout(timeoutId);
              resolved = true;
              resolve(false);
            }
          }
        }, 5000); // Increased to 5 seconds to give tunnel more time to establish

      } catch (error) {
        if (!resolved) {
          this.logger.stopLoading();
          this.logger.error(`Failed to create SSH tunnel: ${error}`);
          if (timeoutId) clearTimeout(timeoutId);
          resolved = true;
          resolve(false);
        }
      }
    });
  }

  async killTunnel(port?: number): Promise<void> {
    if (port !== undefined) {
      // Kill specific tunnel for a port
      const tunnelProcess = this.tunnelProcesses.get(port);
      if (tunnelProcess) {
        this.logger.debug(`Killing SSH tunnel for port ${port}...`);
        try {
          tunnelProcess.kill('SIGTERM');
          this.tunnelProcesses.delete(port);
        } catch (error) {
          this.logger.debug(`Error killing tunnel process: ${error}`);
        }
      }
      
      // Also kill any cf ssh processes for this specific port
      try {
        exec(`pkill -f "cf ssh.*-L ${port}:"`, (error: any) => {
          if (error) {
            this.logger.debug(`Error killing cf ssh processes for port ${port}: ${error.message}`);
          }
        });
      } catch (error) {
        this.logger.debug(`Error executing pkill: ${error}`);
      }
    } else {
      // Kill all tunnels
      this.logger.debug('Killing all SSH tunnels...');
      for (const [port, tunnelProcess] of this.tunnelProcesses.entries()) {
        try {
          tunnelProcess.kill('SIGTERM');
        } catch (error) {
          this.logger.debug(`Error killing tunnel process on port ${port}: ${error}`);
        }
      }
      this.tunnelProcesses.clear();
      
      // Also kill any remaining cf ssh processes
      try {
        exec('pkill -f "cf ssh"', (error: any) => {
          if (error) {
            this.logger.debug(`Error killing cf ssh processes: ${error.message}`);
          }
        });
      } catch (error) {
        this.logger.debug(`Error executing pkill: ${error}`);
      }
    }
  }
}
