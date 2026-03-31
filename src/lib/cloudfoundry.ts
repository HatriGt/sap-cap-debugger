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
    text.includes('authentication has expired') ||
    text.includes('invalid token') ||
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

    const netstatExists = await this.commandExecutor.checkCommandExists('netstat');
    if (!netstatExists) {
      this.logger.stopLoading();
      this.logger.error('netstat command is not available');
      return false;
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

  async startAppProcess(appName: string): Promise<CommandResult> {
    this.logger.loading('Starting application process...');
    
    // First, try to detect the correct entry point
    const entryPoint = await this.detectEntryPoint(appName);
    this.logger.update('Starting Node.js process...');
    
    const command = `export PATH='/home/vcap/deps/0/bin:$PATH' && cd /home/vcap/app && /home/vcap/deps/0/bin/node ${entryPoint}`;
    
    const result = await this.cf(['ssh', appName, '-c', command]);
    this.logger.stopLoading();
    return result;
  }

  async detectEntryPoint(appName: string): Promise<string> {
    this.logger.loading('Detecting application entry point...');
    
    // First, try to find server.js files using find command
    const findResult = await this.cf([
      'ssh', appName, '-c', 
      'find /home/vcap/app -maxdepth 3 -name "server.js" -type f 2>/dev/null'
    ]);
    
    if (findResult.success && findResult.output.trim()) {
      const files = findResult.output.trim().split('\n')
        .map(f => f.trim().replace('/home/vcap/app/', ''))
        .filter(f => f.length > 0);
      
      if (files.length > 0) {
        // Prefer root-level, then srv/, then first found
        const entryPoint = files.find(f => f === 'server.js') || 
                          files.find(f => f === 'srv/server.js') ||
                          files[0];
        
        this.logger.stopLoading();
        this.logger.success(`Found entry point: ${entryPoint}`);
        return entryPoint;
      }
    }
    
    // Fallback: Check package.json for main entry point
    this.logger.update('Checking package.json...');
    const packageJsonResult = await this.cf([
      'ssh', appName, '-c', 'cat /home/vcap/app/package.json 2>/dev/null | grep -E "\"main\"|\"start\"" | head -5'
    ]);
    
    if (packageJsonResult.success && packageJsonResult.output.trim()) {
      // Try to extract entry point from package.json
      const mainMatch = packageJsonResult.output.match(/"main"\s*:\s*"([^"]+)"/);
      if (mainMatch && mainMatch[1]) {
        const entryPoint = mainMatch[1];
        // Verify it exists
        const verifyResult = await this.cf([
          'ssh', appName, '-c', `test -f /home/vcap/app/${entryPoint} && echo "exists"`
        ]);
        if (verifyResult.success && verifyResult.output.trim() === 'exists') {
          this.logger.stopLoading();
          this.logger.success(`Found entry point from package.json: ${entryPoint}`);
          return entryPoint;
        }
      }
    }
    
    // Last resort: Check common locations
    this.logger.update('Checking common locations...');
    const commonPaths = ['server.js', 'srv/server.js', 'app/server.js', 'index.js'];
    for (const entryPoint of commonPaths) {
      const result = await this.cf([
        'ssh', appName, '-c', `test -f /home/vcap/app/${entryPoint} && echo "exists"`
      ]);
      if (result.success && result.output.trim() === 'exists') {
        this.logger.stopLoading();
        this.logger.success(`Found entry point: ${entryPoint}`);
        return entryPoint;
      }
    }
    
    // If no entry point found, default to server.js and let it fail with a clear error
    this.logger.stopLoading();
    this.logger.warning('Could not detect entry point, defaulting to server.js');
    return 'server.js';
  }

  async findNodeProcess(appName: string): Promise<ProcessInfo | null> {
    const maxAttempts = 10;
    let attempt = 1;

    while (attempt <= maxAttempts) {
      this.logger.loading(`Finding Node.js process... (attempt ${attempt}/${maxAttempts})`);
      const result = await this.cf(['ssh', appName, '-c', 'ps aux | grep node | grep -v grep']);
      
      if (result.success && result.output.trim()) {
        const lines = result.output.trim().split('\n');
        
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 11 && parts[10] && parts[10].includes('node')) {
            const pid = parseInt(parts[1]);
            if (!isNaN(pid)) {
              this.logger.stopLoading();
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

      this.logger.stopLoading();
      await new Promise(resolve => setTimeout(resolve, 3000));
      attempt++;
    }

    this.logger.stopLoading();
    this.logger.error('Could not find Node.js process after maximum attempts');
    return null;
  }

  async enableDebugging(appName: string, pid: number, debugPort?: number): Promise<boolean> {
    this.logger.loading(`Enabling debugging on process ${pid}...`);
    
    // Note: kill -USR1 always enables inspector on port 9229 on the remote side
    // The debugPort parameter is the LOCAL port, not the remote port
    // The SSH tunnel forwards local port -> remote port 9229
    
    // Check if inspector is already running on the remote side (always port 9229)
    this.logger.update('Checking if inspector is already running...');
    const checkResult = await this.cf([
      'ssh', appName, '-c',
      `netstat -an 2>/dev/null | grep 9229 || ss -an 2>/dev/null | grep 9229 || echo "not found"`
    ]);
    
    if (checkResult.success && checkResult.output.includes('9229')) {
      this.logger.stopLoading();
      this.logger.success('Debugging already enabled on port 9229');
      return true;
    }
    
    // Use kill -USR1 to enable debugging (always uses port 9229 on remote side)
    const result = await this.cf(['ssh', appName, '-c', `kill -USR1 ${pid}`]);
    
    if (result.success) {
      this.logger.stopLoading();
      if (debugPort && debugPort !== 9229) {
        this.logger.info(`Debugging enabled on remote port 9229`);
        this.logger.info(`SSH tunnel forwards local port ${debugPort} -> remote port 9229`);
      } else {
        this.logger.success(`Debugging enabled on process ${pid} (port 9229)`);
      }
      return true;
    } else {
      this.logger.stopLoading();
      this.logger.error('Failed to enable debugging');
      return false;
    }
  }

  async getAppLogs(appName: string): Promise<string> {
    const result = await this.cf(['logs', appName, '--recent']);
    return result.output;
  }
}
