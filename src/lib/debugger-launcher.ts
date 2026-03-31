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

  private getDevtoolsBaseUrl(inspectorUrl: string): string | null {
    const trimmed = inspectorUrl.trim();
    if (!trimmed.startsWith('devtools://')) return null;

    const withoutQuery = trimmed.split('?')[0];
    // Some Chrome versions use js_app.html, some use inspector.html. We keep the exact base
    // returned by Node, just stripping query params (workaround for ERR_INVALID_URL).
    return withoutQuery || null;
  }

  async launchChromeDebugger(port: number): Promise<void> {
    this.logger.step('Opening Chrome Debugger');
    
    // Wait a moment for the debugger to be ready
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    try {
      // Try to fetch the devtoolsFrontendUrl from the inspector JSON endpoint
      this.logger.loading('Fetching inspector URL...');
      const inspectorUrl = await this.fetchInspectorUrl(port);
      this.logger.stopLoading();
      
      if (inspectorUrl) {
        // Node's devtoolsFrontendUrl can be a devtools:// URL. Some Chrome versions refuse
        // direct navigation to devtools:// with query params (ERR_INVALID_URL). A common
        // workaround is to open the base devtools page first (no params), then open the
        // full URL.
        this.logger.info(`Opening DevTools for port ${port}...`);
        this.logger.debug(`Inspector URL: ${inspectorUrl}`);
        
        const isMac = process.platform === 'darwin';
        const devtoolsBaseUrl = this.getDevtoolsBaseUrl(inspectorUrl);
        
        if (isMac) {
          try {
            if (devtoolsBaseUrl) {
              this.logger.info('Trying direct DevTools open (two-step workaround)...');
              await execAsync(`open -a "Google Chrome" "${devtoolsBaseUrl}"`);
              await new Promise(resolve => setTimeout(resolve, 300));
              await execAsync(`open -a "Google Chrome" "${inspectorUrl}"`);
              this.logger.success('Chrome DevTools opened directly!');
              console.log('');
              this.logger.info('🎉 DevTools should now be open with your debugging session');
              console.log('');
              return;
            }

            // If inspectorUrl isn't devtools://, just open it directly.
            await execAsync(`open -a "Google Chrome" "${inspectorUrl}"`);
            this.logger.success('Chrome DevTools opened directly!');
            console.log('');
            this.logger.info('🎉 DevTools should now be open with your debugging session');
            console.log('');
            return;
          } catch (error: any) {
            this.logger.warning(`Could not open with Chrome app: ${error.message}`);
            this.logger.warning('Falling back to inspector listing page...');
          }
        }

        // Non-macOS (or macOS fallback): attempt the same two-step workaround if devtools://
        try {
          if (devtoolsBaseUrl) {
            this.logger.info('Trying direct DevTools open (two-step workaround)...');
            await open(devtoolsBaseUrl, { app: { name: 'google chrome' } });
            await new Promise(resolve => setTimeout(resolve, 300));
            await open(inspectorUrl, { app: { name: 'google chrome' } });
            this.logger.success('Chrome DevTools opened directly!');
            console.log('');
            this.logger.info('🎉 DevTools should now be open with your debugging session');
            console.log('');
            return;
          }

          await open(inspectorUrl, { app: { name: 'google chrome' } });
          this.logger.success('Chrome DevTools opened directly!');
          console.log('');
          this.logger.info('🎉 DevTools should now be open with your debugging session');
          console.log('');
          return;
        } catch (openError) {
          this.logger.warning('Could not open DevTools URL directly.');
          this.logger.warning('Falling back to inspector listing page...');
        }

        // Last fallback: open the JSON listing page so user can click the link.
        await open(`http://localhost:${port}/json`);
        this.logger.info(`Opened http://localhost:${port}/json`);
        this.logger.info('Please click on the "devtoolsFrontendUrl" link to open DevTools');
        console.log('');
        return;
      }
      
      // Fallback to chrome://inspect if we can't fetch the URL
      this.logger.warning('Could not fetch inspector URL, opening chrome://inspect instead');
      try {
        await open('chrome://inspect/#devices', { app: { name: 'google chrome' } });
        this.logger.success('Chrome debugger opened');
      } catch (chromeError) {
        // If that fails, try without specifying the app
        await open('chrome://inspect/#devices');
        this.logger.success('Chrome debugger opened');
      }
      
      this.logger.info('🔍 Chrome Debugger Instructions:');
      console.log('1. Chrome should now be open at chrome://inspect/#devices');
      console.log(`2. Look for your Node.js process (should show 'localhost:${port}')`);
      console.log('3. Click the \'inspect\' link next to your process');
      console.log('4. This will open the Node.js DevTools for debugging');
      console.log('');
      console.log(`💡 Alternative: Open http://localhost:${port}/json and click the devtoolsFrontendUrl link`);
      console.log('');
    } catch (error) {
      this.logger.warning('Failed to open Chrome. Please open Chrome manually and:');
      console.log(`1. Go to http://localhost:${port}/json`);
      console.log('2. Copy the devtoolsFrontendUrl and open it in Chrome');
      console.log('3. Or go to chrome://inspect/#devices and configure manually');
    }
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
