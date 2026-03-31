import { CommandExecutor } from '../utils/command';
import { Logger, DebugSession } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getCdsDebugBaseDir } from './workspaces';

export class PortManager {
  private commandExecutor: CommandExecutor;
  private logger: Logger;
  private sessionFile: string;
  private basePort: number = 9229;

  constructor(logger: Logger) {
    this.logger = logger;
    this.commandExecutor = new CommandExecutor(logger);
    // Store sessions under ~/.cds-debug/ to keep all tool state together.
    // We still read the legacy file if present for backward compatibility.
    this.sessionFile = path.join(getCdsDebugBaseDir(), 'sessions.json');
  }

  private loadSessions(): DebugSession[] {
    try {
      const legacyFile = path.join(os.homedir(), '.cap-debugger-sessions.json');
      const fileToRead = fs.existsSync(this.sessionFile) ? this.sessionFile : (fs.existsSync(legacyFile) ? legacyFile : null);
      if (fileToRead) {
        const content = fs.readFileSync(fileToRead, 'utf-8');
        const sessions = JSON.parse(content);
        // Convert startTime strings back to Date objects
        return sessions.map((s: any) => ({
          ...s,
          startTime: new Date(s.startTime)
        }));
      }
    } catch (error) {
      this.logger.debug(`Failed to load sessions: ${error}`);
    }
    return [];
  }

  private saveSessions(sessions: DebugSession[]): void {
    try {
      fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
      fs.writeFileSync(this.sessionFile, JSON.stringify(sessions, null, 2));
    } catch (error) {
      this.logger.debug(`Failed to save sessions: ${error}`);
    }
  }

  async getPortForApp(appName: string, workspaceName?: string): Promise<number> {
    this.logger.loading(`Assigning port for ${appName}...`);
    const sessions = this.loadSessions();
    const existingSession = sessions.find(s => s.appName === appName && (s.workspaceName || '') === (workspaceName || ''));
    
    if (existingSession) {
      // Verify port is still in use
      if (await this.isPortInUse(existingSession.debugPort)) {
        this.logger.update(`Found existing session, cleaning up port ${existingSession.debugPort}...`);
        // Clean up any processes on this port to ensure it's ready for reuse
        await this.cleanupPort(existingSession.debugPort);
        this.logger.stopLoading();
        this.logger.info(`Using existing port ${existingSession.debugPort} for ${appName}`);
        return existingSession.debugPort;
      } else {
        // Port is free, remove stale session
        this.removeSession(appName, workspaceName);
      }
    }
    
    // Find new available port
    this.logger.update('Finding available port...');
    const port = await this.findAvailablePort();
    this.logger.stopLoading();
    this.logger.info(`Assigned port ${port} for ${appName}`);
    return port;
  }

  async findAvailablePort(startPort?: number): Promise<number> {
    const basePort = startPort || this.basePort;
    const sessions = this.loadSessions();
    const usedPorts = new Set(sessions.map(s => s.debugPort));
    
    let port = basePort;
    const maxPort = basePort + 100; // Check up to 100 ports ahead
    let checked = 0;
    
    while (port < maxPort) {
      // Check if port is already assigned to a session
      if (!usedPorts.has(port)) {
        // Also check if port is actually in use
        if (!(await this.isPortInUse(port))) {
          return port;
        }
      }
      port++;
      checked++;
      // Update spinner every 10 ports checked
      if (checked % 10 === 0) {
        this.logger.update(`Checking ports... (checked ${checked})`);
      }
    }
    
    throw new Error(`No available port found in range ${basePort}-${maxPort}`);
  }

  saveSession(session: DebugSession): void {
    const sessions = this.loadSessions();
    const existingIndex = sessions.findIndex(s =>
      s.appName === session.appName && (s.workspaceName || '') === (session.workspaceName || '')
    );
    
    if (existingIndex >= 0) {
      sessions[existingIndex] = session;
    } else {
      sessions.push(session);
    }
    
    this.saveSessions(sessions);
  }

  getSession(appName: string, workspaceName?: string): DebugSession | null {
    const sessions = this.loadSessions();
    return sessions.find(s => s.appName === appName && (s.workspaceName || '') === (workspaceName || '')) || null;
  }

  getAllSessions(): DebugSession[] {
    return this.loadSessions();
  }

  removeSession(appName: string, workspaceName?: string): void {
    const sessions = this.loadSessions();
    const filtered = sessions.filter(s => !(s.appName === appName && (s.workspaceName || '') === (workspaceName || '')));
    this.saveSessions(filtered);
  }

  clearAllSessions(): void {
    this.saveSessions([]);
  }

  async isPortInUse(port: number): Promise<boolean> {
    // Method 1: Check netstat for LISTEN or ESTABLISHED (SSH tunnels show as ESTABLISHED)
    const netstatResult = await this.commandExecutor.execute('netstat', ['-an']);
    
    if (netstatResult.success) {
      const hasListen = netstatResult.output.includes(`:${port}`) && netstatResult.output.includes('LISTEN');
      const hasEstablished = netstatResult.output.includes(`:${port}`) && netstatResult.output.includes('ESTABLISHED');
      if (hasListen || hasEstablished) {
        return true;
      }
    }
    
    // Method 2: Check lsof (more reliable for SSH tunnels)
    const lsofResult = await this.commandExecutor.execute('lsof', ['-i', `:${port}`]);
    if (lsofResult.success && lsofResult.output.trim()) {
      // lsof returns process info if port is in use
      return true;
    }
    
    return false;
  }

  async killProcessesOnPort(port: number): Promise<boolean> {
    this.logger.loading(`Killing processes on port ${port}...`);
    
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

    // Also kill any cf ssh processes for this specific port
    await this.commandExecutor.execute('pkill', ['-f', `cf ssh.*-L ${port}:`]);
    this.logger.stopLoading();
    
    return true;
  }

  async verifyPort(port: number, maxAttempts: number = 15): Promise<boolean> {
    this.logger.loading(`Verifying port ${port}...`);
    
    let attempt = 1;
    
    while (attempt <= maxAttempts) {
      if (await this.isPortInUse(port)) {
        this.logger.stopLoading();
        this.logger.success(`Port ${port} is in use`);
        return true;
      }
      
      this.logger.update(`Waiting for port... (attempt ${attempt}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempt++;
    }
    
    this.logger.stopLoading();
    this.logger.warning(`Port ${port} verification failed, but continuing...`);
    return false;
  }

  async cleanupPort(port: number): Promise<void> {
    await this.killProcessesOnPort(port);
    
    // Verify cleanup
    this.logger.loading(`Verifying port ${port} is free...`);
    if (await this.isPortInUse(port)) {
      this.logger.stopLoading();
      this.logger.warning(`Port ${port} is still in use after cleanup`);
    } else {
      this.logger.stopLoading();
      this.logger.success(`Port ${port} is free`);
    }
  }
}
