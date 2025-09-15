import open = require('open');
import { CommandExecutor } from '../utils/command';
import { Logger, DebuggerType } from '../types';

export class DebuggerLauncher {
  private commandExecutor: CommandExecutor;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.commandExecutor = new CommandExecutor(logger);
  }

  async launchChromeDebugger(port: number): Promise<void> {
    this.logger.step('Opening Chrome Debugger');
    
    // Wait a moment for the debugger to be ready
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    try {
      await open('chrome://inspect/#devices');
      this.logger.success('Chrome debugger opened');
      
      this.logger.info('🔍 Chrome Debugger Instructions:');
      console.log('1. Chrome should now be open at chrome://inspect/#devices');
      console.log(`2. Look for your Node.js process (should show 'localhost:${port}')`);
      console.log('3. Click the \'inspect\' link next to your process');
      console.log('4. This will open the Node.js DevTools for debugging');
      console.log('');
      this.logger.info('💡 Tip: You can also click \'Open dedicated DevTools for Node\' for a better experience');
      console.log('');
    } catch (error) {
      this.logger.warning('Chrome not found. Please open Chrome manually and:');
      console.log('1. Go to chrome://inspect/#devices');
      console.log(`2. Look for your Node.js process (should show 'localhost:${port}')`);
      console.log('3. Click \'inspect\' to start debugging');
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
