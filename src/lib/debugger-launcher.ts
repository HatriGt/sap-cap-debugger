import open = require('open');
import { CommandExecutor } from '../utils/command';
import { Logger, DebuggerType } from '../types';
import * as http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class DebuggerLauncher {
  private commandExecutor: CommandExecutor;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.commandExecutor = new CommandExecutor(logger);
  }

  private async fetchInspectorUrl(port: number): Promise<string | null> {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}/json`, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const targets = JSON.parse(data);
            if (Array.isArray(targets) && targets.length > 0) {
              // Get the first target's devtoolsFrontendUrl
              const target = targets[0];
              if (target.devtoolsFrontendUrl) {
                resolve(target.devtoolsFrontendUrl);
                return;
              }
            }
            resolve(null);
          } catch (error) {
            this.logger.debug(`Failed to parse inspector JSON: ${error}`);
            resolve(null);
          }
        });
      });
      
      req.on('error', (error) => {
        this.logger.debug(`Failed to fetch inspector URL: ${error.message}`);
        resolve(null);
      });
      
      req.setTimeout(5000, () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  async launchChromeDebugger(port: number): Promise<void> {
    this.logger.step('Opening Chrome Debugger');

    // Give the inspector a moment, then confirm it's reachable over the tunnel.
    await new Promise(resolve => setTimeout(resolve, 2000));
    this.logger.loading('Checking inspector...');
    const inspectorUrl = await this.fetchInspectorUrl(port);
    this.logger.stopLoading();

    if (inspectorUrl) {
      this.logger.success(`Inspector is reachable on localhost:${port}`);
    } else {
      this.logger.warning(`Could not confirm the inspector on localhost:${port} yet (it may still be warming up).`);
    }

    // IMPORTANT: do NOT navigate Chrome directly to the devtools:// URL.
    // Modern Chrome blocks that (ERR_INVALID_URL), and reopening the same URL
    // just refocuses a stale, disconnected tab. The reliable path is
    // chrome://inspect, which discovers localhost:<port> and provides a working
    // "inspect" link that opens a fresh DevTools session every time.
    try {
      if (process.platform === 'darwin') {
        await execAsync('open -a "Google Chrome" "chrome://inspect/#devices"');
      } else {
        await open('chrome://inspect/#devices', { app: { name: 'google chrome' } });
      }
      this.logger.success('Opened chrome://inspect');
    } catch {
      try {
        await open('chrome://inspect/#devices');
        this.logger.success('Opened chrome://inspect');
      } catch {
        this.logger.warning('Could not open Chrome automatically - open chrome://inspect/#devices manually.');
      }
    }

    console.log('');
    this.logger.info('🔍 In the chrome://inspect tab:');
    console.log(`  1. Under "Remote Target", find the target on localhost:${port} and click "inspect".`);
    console.log(`  2. If it is not listed, click "Configure...", add "localhost:${port}",`);
    console.log(`     keep "Discover network targets" checked, then wait a few seconds.`);
    console.log('');
    this.logger.info('Keep this command running - it holds the SSH tunnel open.');
    console.log('');
  }

  async launchVSCodeDebugger(port: number): Promise<void> {
    this.logger.step('VS Code Debugging Setup');
    
    const codeExists = await this.commandExecutor.checkCommandExists('code');
    
    if (codeExists) {
      this.logger.success('VS Code is available. Please:');
      console.log('1. Open VS Code');
      console.log('2. Go to Run and Debug (Ctrl+Shift+D)');
      console.log('3. Select \'Debug CAP App Remote\' from dropdown');
      console.log('4. Click the play button ▶️');
      console.log('');
      console.log('Or run: code .');
    } else {
      this.logger.warning('VS Code CLI not found. Please open VS Code manually and:');
      console.log('1. Go to Run and Debug (Ctrl+Shift+D)');
      console.log('2. Select \'Debug CAP App Remote\' from dropdown');
      console.log('3. Click the play button ▶️');
    }
    
    this.logger.info('📋 VS Code Launch Configuration:');
    console.log('Ensure your .vscode/launch.json contains:');
    console.log(JSON.stringify({
      version: '1.0.0',
      configurations: [{
        name: 'Debug CAP App Remote',
        type: 'node',
        request: 'attach',
        address: '127.0.0.1',
        port: port,
        restart: true,
        localRoot: '${workspaceFolder}',
        remoteRoot: '/home/vcap/app',
        skipFiles: ['<node_internals>/**']
      }]
    }, null, 2));
    console.log('');
  }

  async launchDebugger(debuggerType: DebuggerType, port: number): Promise<void> {
    switch (debuggerType) {
      case 'chrome':
        await this.launchChromeDebugger(port);
        break;
      case 'vscode':
        await this.launchVSCodeDebugger(port);
        break;
      case 'both':
        await this.launchChromeDebugger(port);
        await this.launchVSCodeDebugger(port);
        break;
    }
  }
}
