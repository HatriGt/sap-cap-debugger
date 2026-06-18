import { CommandExecutor } from '../utils/command';
import { AppStatus, CommandResult } from '../types';
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

  // Full stop+start cycle. Needed to make SSH enablement take effect: enabling
  // SSH does NOT affect already-running instances, and `cf start` is a no-op
  // when the app is already started - only `cf restart` cycles the instances so
  // `cf ssh` becomes authorized.
  async restartApp(appName: string): Promise<boolean> {
    this.logger.loading(`Restarting application: ${appName} (so SSH takes effect)...`);
    // cf restart blocks until the app is up and can take a few minutes.
    const result = await this.cf(['restart', appName], { timeout: 300000 });
    this.logger.stopLoading();
    if (result.success) {
      this.logger.success(`Application ${appName} restarted`);
      return true;
    }
    this.logger.error(`Failed to restart application: ${result.error || result.output}`);
    return false;
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

  // Step 1: read the app-level SSH flag via `cf ssh-enabled`.
  async checkSSHEnabled(appName: string): Promise<boolean> {
    this.logger.loading(`Checking SSH flag (cf ssh-enabled ${appName})...`);
    const result = await this.cf(['ssh-enabled', appName]);
    this.logger.stopLoading();

    // Output is like: "ssh support is enabled for app 'X'." / "... disabled ...".
    const output = (result.output || '').toLowerCase();
    const enabled = result.success && output.includes('enabled') && !output.includes('disabled');
    this.logger.debug(`cf ssh-enabled output: ${(result.output || '').trim()}`);
    return enabled;
  }

  // Step 4: confirm `cf ssh` actually works before we rely on it. Mirrors the
  // working manual invocation `cf ssh <app> -c '<cmd>'` (no -T). Retries because
  // the first connection - especially right after enabling SSH - can be slow,
  // and surfaces the real failure (not authorized / timeout / host key) so it
  // isn't hidden behind --verbose.
  async testSSHConnection(appName: string): Promise<boolean> {
    const marker = '__cds_ssh_ok__';
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.logger.loading(`Testing cf ssh to ${appName}... (attempt ${attempt}/${maxAttempts})`);
      const sshTest = await this.cf(['ssh', appName, '-c', `echo ${marker}`], { timeout: 60000 });
      this.logger.stopLoading();

      if (sshTest.success && sshTest.output.includes(marker)) {
        this.logger.success('cf ssh is working');
        return true;
      }

      const detail = (sshTest.output || sshTest.error || '').trim();
      if (detail) {
        this.logger.warning(`cf ssh failed: ${detail.split('\n').slice(0, 3).join(' | ')}`);
      }
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 4000));
      }
    }
    return false;
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
