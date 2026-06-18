import { CommandExecutor } from '../utils/command';
import { AppStatus, ProcessInfo, CommandResult } from '../types';
import { Logger } from '../types';

export class AuthExpiredError extends Error {
  workspaceName?: string;
  constructor(message: string, workspaceName?: string) {
    super(message);
    this.name = 'AuthExpiredError';
    this.workspaceName = workspaceName;
  }
}

function isCfAuthError(output: string): boolean {
  const text = (output || '').toLowerCase();
  return (
    text.includes('not authenticated') ||
    text.includes('not logged in') ||
    text.includes('authentication has expired') ||
    text.includes('invalid token') ||
    text.includes('token expired') ||
    (text.includes('token') && text.includes('log back in')) ||
    text.includes('unauthorized') ||
    (text.includes('request error') && (text.includes(' 401') || text.includes(' 403'))) ||
    text.includes('status code: 401') ||
    text.includes('status code: 403')
  );
}

export class CloudFoundryClient {
  private commandExecutor: CommandExecutor;
  private logger: Logger;
  private cfEnv?: Record<string, string>;
  private workspaceName?: string;

  constructor(logger: Logger, cfEnv?: Record<string, string>, workspaceName?: string) {
    this.logger = logger;
    this.commandExecutor = new CommandExecutor(logger);
    this.cfEnv = cfEnv;
    this.workspaceName = workspaceName;
  }

  private async cf(args: string[], options: any = {}): Promise<CommandResult> {
    const result = await this.commandExecutor.execute('cf', args, {
      ...options,
      env: this.cfEnv ? { ...process.env, ...this.cfEnv } : options.env
    });

    if (!result.success && isCfAuthError(result.output || result.error || '')) {
      throw new AuthExpiredError('Cloud Foundry authentication appears to have expired.', this.workspaceName);
    }

    return result;
  }

  async login(loginMethod: 'standard' | 'sso' = 'standard'): Promise<CommandResult> {
    // Keep it interactive; caller decides whether to prompt user first.
    // timeout: 0 means no timeout in execa.
    const args = loginMethod === 'sso' ? ['login', '--sso'] : ['login'];
    return await this.cf(args, { timeout: 0 });
  }

  async checkPrerequisites(): Promise<boolean> {
    this.logger.loading('Checking prerequisites...');

    const cfExists = await this.commandExecutor.checkCommandExists('cf');
    if (!cfExists) {
      this.logger.stopLoading();
      this.logger.error('Cloud Foundry CLI (cf) is not installed or not in PATH');
      return false;
    }

    // Port checks use netstat first and fall back to lsof, so either one is enough.
    // Don't hard-fail when netstat is missing (it's not installed by default on many
    // modern systems) as long as lsof is available.
    const netstatExists = await this.commandExecutor.checkCommandExists('netstat');
    const lsofExists = await this.commandExecutor.checkCommandExists('lsof');
    if (!netstatExists && !lsofExists) {
      this.logger.stopLoading();
      this.logger.error('Neither netstat nor lsof is available; one is required for port checks');
      return false;
    }
    if (!netstatExists) {
      this.logger.debug('netstat not found; falling back to lsof for port checks');
    }

    this.logger.stopLoading();
    this.logger.success('Prerequisites check passed');
    return true;
  }

  async getApps(): Promise<AppStatus[]> {
    this.logger.loading('Fetching applications...');
    const result = await this.cf(['apps']);
    this.logger.stopLoading();
    
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
    this.logger.loading(`Starting application: ${appName}...`);
    
    const result = await this.cf(['start', appName]);
    
    if (result.success) {
      this.logger.stopLoading();
      this.logger.success(`Application ${appName} started successfully`);
      return true;
    } else {
      this.logger.stopLoading();
      this.logger.error(`Failed to start application: ${result.error}`);
      return false;
    }
  }

  async enableSSH(appName: string): Promise<boolean> {
    this.logger.loading(`Enabling SSH access for application: ${appName}...`);
    
    const result = await this.cf(['enable-ssh', appName]);
    
    if (result.success) {
      this.logger.stopLoading();
      this.logger.success('SSH access enabled');
      return true;
    } else {
      this.logger.stopLoading();
      this.logger.warning('SSH access may already be enabled or failed to enable');
      return false;
    }
  }

  async checkSSHEnabled(appName: string): Promise<boolean> {
    this.logger.loading(`Checking SSH access for application: ${appName}...`);
    
    const result = await this.cf(['ssh-enabled', appName]);
    
    if (result.success) {
      const output = result.output.toLowerCase().trim();
      
      // More flexible pattern matching - check for "enabled" or "true" (not just "ssh is enabled")
      // Common formats:
      // - "ssh is enabled"
      // - "ssh enabled"
      // - "ssh support is enabled for app '...'."
      // - "enabled"
      // - "true" (some CF versions)
      if (output.includes('enabled') || output.includes('true')) {
        // Make sure it's not explicitly disabled
        if (!output.includes('disabled') && !output.includes('false')) {
          this.logger.stopLoading();
          this.logger.success('SSH access is already enabled');
          return true;
        }
      }
      
      // Explicitly disabled
      if (output.includes('disabled') || output.includes('false')) {
        this.logger.stopLoading();
        this.logger.info('SSH access is disabled');
        return false;
      }
      
      // Log the actual output for debugging
      this.logger.debug(`SSH status output: ${result.output}`);
    }
    
    // If we can't determine status, try a direct SSH test
    this.logger.update('Testing SSH connection...');
    const sshTest = await this.cf([
      // -T: disable pseudo-tty allocation (more reliable in non-interactive execution)
      'ssh', '-T', appName, '-c', 'echo "test"'
    ], {
      // First SSH attempt can be slow due to key exchange / initial handshake.
      timeout: 15000
    });
    
    if (sshTest.success) {
      this.logger.stopLoading();
      this.logger.success('SSH access is working (verified by test)');
      return true;
    }
    
    // If we can't determine status, assume it's disabled
    this.logger.stopLoading();
    this.logger.warning('Could not determine SSH status, assuming disabled');
    return false;
  }

  async findNodeProcess(appName: string): Promise<ProcessInfo | null> {
    const maxAttempts = 15;
    let attempt = 1;

    while (attempt <= maxAttempts) {
      this.logger.loading(`Finding Node.js process... (attempt ${attempt}/${maxAttempts})`);

      // Use `pgrep`, the same primitive as the proven manual command
      // (`kill -USR1 $(pgrep node)`). pgrep is reliably available in the CF
      // Diego container, whereas `ps aux` may be missing or produce output that
      // doesn't match strict column parsing - which caused "Could not find
      // Node.js process" even though `pgrep node` worked manually.
      // `pgrep -l node` prints "<pid> <name>"; we fall back to bare `pgrep node`
      // (just "<pid>") if -l isn't supported.
      const result = await this.cf(['ssh', '-T', appName, '-c', 'pgrep -l node || pgrep node']);

      if (result.success && result.output.trim()) {
        // Output may also contain SSH/connection noise on stderr; only lines that
        // start with a PID are real matches.
        const lines = result.output.trim().split('\n').map(l => l.trim()).filter(Boolean);

        for (const line of lines) {
          const match = line.match(/^(\d+)(?:\s+(\S+))?/);
          if (match) {
            const pid = parseInt(match[1], 10);
            if (!isNaN(pid)) {
              this.logger.stopLoading();
              this.logger.success(`Found Node.js process with PID: ${pid}`);
              return {
                pid,
                name: match[2] || 'node',
                command: line
              };
            }
          }
        }
      }

      this.logger.stopLoading();
      await new Promise(resolve => setTimeout(resolve, 3000));
      attempt++;
    }

    this.logger.stopLoading();
    this.logger.error('Could not find Node.js process after maximum attempts');
    return null;
  }

  async enableDebugging(appName: string, pid: number, debugPort?: number): Promise<boolean> {
    this.logger.loading('Enabling debugging (kill -USR1) on Node.js process(es)...');
    this.logger.debug(`Detected primary Node.js PID ${pid}; signalling all node processes via pgrep`);

    // Mirror the proven manual command exactly:
    //   cf ssh <app> -c 'kill -USR1 $(pgrep node)'
    //
    // We deliberately signal EVERY Node.js process via `pgrep node` rather than a
    // single guessed PID. CAP containers commonly run more than one node process
    // (a launcher/parent plus the actual server worker); signalling only one can
    // miss the process that serves requests, so the inspector never opens on 9229
    // and DevTools attaches to a tunnel with no live inspector behind it
    // ("disconnected"). Sending USR1 to a process that is already inspecting is a
    // harmless no-op, so signalling all of them is safe.
    //
    // kill -USR1 always enables the inspector on remote port 9229; the SSH tunnel
    // forwards the local debugPort to that remote 9229.
    const result = await this.cf(['ssh', appName, '-c', 'kill -USR1 $(pgrep node)']);

    if (result.success) {
      this.logger.stopLoading();
      this.logger.success('Debugging enabled on Node.js process(es) (remote port 9229)');
      if (debugPort && debugPort !== 9229) {
        this.logger.info(`SSH tunnel forwards local port ${debugPort} -> remote port 9229`);
      }
      return true;
    } else {
      this.logger.stopLoading();
      this.logger.error(`Failed to enable debugging: ${result.error || result.output || 'unknown error'}`);
      return false;
    }
  }

  async getAppLogs(appName: string): Promise<string> {
    const result = await this.cf(['logs', appName, '--recent']);
    return result.output;
  }
}
