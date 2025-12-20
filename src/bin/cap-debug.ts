#!/usr/bin/env node

import { Command } from 'commander';
import inquirer from 'inquirer';
import { CAPDebugger } from '../lib/cap-debugger';
import { createLogger } from '../utils/logger';
import { DebugConfig, DebuggerType } from '../types';
import { PortManager } from '../lib/port-manager';

const program = new Command();

program
  .name('cds-debug')
  .description('Professional NPX tool for remote debugging SAP CAP applications on Cloud Foundry')
  .version('1.0.0')
  .usage('[app-name] [options]')
  .addHelpText('after', `
Examples:
  $ npx sap-cap-debugger claimmgmt-srv          Start debugging an app
  $ npx sap-cap-debugger                         Interactive app selection
  $ npx sap-cap-debugger --port 9230 my-app     Use custom port
  $ npx sap-cap-debugger status                 Show debugging status
  $ npx sap-cap-debugger cleanup                 Clean up sessions
  $ npx sap-cap-debugger apps                    List available apps

Commands:
  status    Show current debugging sessions
  cleanup   Clean up debugging session(s)
  apps      List available CAP applications
  manual    Show manual debugging steps

For more information, visit: https://github.com/HatriGt/sap-cap-debugger
  `)
  .argument('[app-name]', 'Name of the CAP application to debug')
  .option('-p, --port <port>', 'Debug port number (default: auto-assigned)', '9229')
  .option('-d, --debugger <type>', 'Debugger type: chrome, vscode, or both (default: chrome)', 'chrome')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .option('-h, --help', 'Display help for command')
  .action(async (appName, options) => {
    const logger = createLogger(options.verbose);
    const capDebugger = new CAPDebugger(logger);

    let finalAppName = appName;
    
    // If no app name provided, show interactive selection
    if (!finalAppName) {
      try {
        const cfClient = new (await import('../lib/cloudfoundry')).CloudFoundryClient(logger);
        const apps = await cfClient.getApps();
        
        if (apps.length === 0) {
          logger.error('No applications found in current space');
          process.exit(1);
        }

        const { selectedApp } = await inquirer.prompt([
          {
            type: 'list',
            name: 'selectedApp',
            message: 'Select an application to debug:',
            choices: apps.map(app => ({
              name: `${app.name} (${app.status})`,
              value: app.name
            }))
          }
        ]);
        
        finalAppName = selectedApp;
      } catch (error) {
        logger.error(`Failed to get applications: ${error}`);
        process.exit(1);
      }
    }

    // Interactive port handling
    let debugPort: number;
    const portManager = new PortManager(logger);
    
    if (options.port && options.port !== '9229') {
      // Port explicitly specified
      debugPort = parseInt(options.port);
    } else {
      // Auto-assign port
      logger.loading('Assigning debug port...');
      debugPort = await portManager.getPortForApp(finalAppName);
      logger.stopLoading();
      if (debugPort !== 9229) {
        logger.info(`Using port ${debugPort} for ${finalAppName}`);
      }
    }

    const config: DebugConfig = {
      appName: finalAppName,
      debugPort: debugPort,
      debuggerType: options.debugger as DebuggerType,
      autoCleanup: false,
      verbose: options.verbose
    };

    const success = await capDebugger.setupDebugging(config);
    process.exit(success ? 0 : 1);
  });

// Add subcommands
program
  .command('cleanup')
  .description('Clean up debugging session(s)')
  .addHelpText('after', `
Examples:
  $ npx sap-cap-debugger cleanup                 Interactive cleanup
  $ npx sap-cap-debugger cleanup my-app          Clean up specific app
  `)
  .argument('[app-name]', 'Specific app to cleanup (or all if not specified)')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (appName, options) => {
    const logger = createLogger(options.verbose);
    const capDebugger = new CAPDebugger(logger);
    
    if (appName) {
      await capDebugger.cleanup(appName);
    } else {
      // Interactive cleanup
      logger.loading('Loading sessions...');
      const sessions = capDebugger.getAllSessions();
      logger.stopLoading();
      
      if (sessions.length === 0) {
        logger.info('No active debugging sessions');
        return;
      }
      
      // Check which sessions are actually active
      logger.loading('Checking session status...');
      const portManager = new (await import('../lib/port-manager')).PortManager(logger);
      const activeSessions: string[] = [];
      const inactiveSessions: string[] = [];
      
      for (const session of sessions) {
        const isActive = await portManager.isPortInUse(session.debugPort);
        if (isActive) {
          activeSessions.push(session.appName);
        } else {
          inactiveSessions.push(session.appName);
        }
      }
      logger.stopLoading();
      
      // Show info about inactive sessions
      if (inactiveSessions.length > 0) {
        logger.info(`Found ${inactiveSessions.length} inactive session(s) that can be cleaned up`);
      }
      
      // Build choices with status indicators
      const choices = [
        { name: 'Clean up all sessions', value: '__all__' },
        ...sessions.map(s => {
          const isActive = activeSessions.includes(s.appName);
          const status = isActive ? '[Active]' : '[Inactive]';
          return {
            name: `${status} ${s.appName} (port ${s.debugPort})`,
            value: s.appName
          };
        })
      ];
      
      try {
        const answer = await inquirer.prompt([
          {
            type: 'list',
            name: 'selectedSession',
            message: 'Select session to cleanup:',
            choices: choices,
            pageSize: 10
          }
        ]);
        
        const selected = answer.selectedSession;
        
        if (!selected) {
          logger.info('No session selected. Exiting...');
          return;
        }
        
        if (selected === '__all__') {
          logger.info('Cleaning up all sessions...');
          await capDebugger.cleanup();
        } else {
          logger.info(`Cleaning up ${selected}...`);
          await capDebugger.cleanup(selected);
        }
      } catch (error: any) {
        // Handle Ctrl+C gracefully
        if (error.isTtyError) {
          logger.error('Prompt couldn\'t be rendered in the current environment');
        } else if (error.name === 'ExitPromptError' || error.message?.includes('User force closed')) {
          logger.info('Cancelled by user');
        } else {
          logger.error(`Failed to get user input: ${error.message || error}`);
        }
        process.exit(1);
      }
    }
  });

program
  .command('status')
  .description('Show current debugging status')
  .addHelpText('after', `
Examples:
  $ npx sap-cap-debugger status                 Show all active sessions
  `)
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (options) => {
    const logger = createLogger(options.verbose);
    const capDebugger = new CAPDebugger(logger);
    
    await capDebugger.showStatus();
  });

program
  .command('apps')
  .description('List available CAP applications')
  .addHelpText('after', `
Examples:
  $ npx sap-cap-debugger apps                   List all apps in current space
  `)
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (options) => {
    const logger = createLogger(options.verbose);
    
    try {
      const cfClient = new (await import('../lib/cloudfoundry')).CloudFoundryClient(logger);
      const apps = await cfClient.getApps();
      
      if (apps.length === 0) {
        logger.info('No applications found in current space');
        return;
      }

      console.log('');
      logger.info('Available CAP Applications:');
      console.log('');
      
      apps.forEach(app => {
        const statusColor = app.status === 'started' ? '🟢' : '🔴';
        console.log(`  ${statusColor} ${app.name} (${app.status})`);
        if (app.urls.length > 0) {
          console.log(`     URLs: ${app.urls.join(', ')}`);
        }
      });
      
      console.log('');
    } catch (error) {
      logger.error(`Failed to get applications: ${error}`);
      process.exit(1);
    }
  });

program
  .command('manual')
  .description('Show manual debugging steps')
  .addHelpText('after', `
Examples:
  $ npx sap-cap-debugger manual                 Show manual steps
  $ npx sap-cap-debugger manual my-app          Show manual steps for specific app
  `)
  .argument('[app-name]', 'Name of the CAP application')
  .option('-p, --port <port>', 'Debug port number', '9229')
  .action((appName, options) => {
    const port = options.port || '9229';
    
    console.log('');
    console.log('🎯 Manual Remote Debugging Steps');
    console.log('');
    console.log('If the automated setup fails, follow these manual steps:');
    console.log('');
    
    console.log('📱 STEP 1: Start the Application');
    console.log('----------------------------------------');
    console.log(`cf ssh ${appName || '<app-name>'} -c "export PATH='/home/vcap/deps/0/bin:$PATH' && cd /home/vcap/app && /home/vcap/deps/0/bin/node srv/server.js"`);
    console.log('');
    
    console.log('📱 STEP 2: Create SSH Tunnel (in another terminal)');
    console.log('----------------------------------------');
    console.log(`cf ssh -N -T -L ${port}:127.0.0.1:${port} ${appName || '<app-name>'}`);
    console.log('');
    
    console.log('📱 STEP 3: Find Node.js Process (in another terminal)');
    console.log('----------------------------------------');
    console.log(`cf ssh ${appName || '<app-name>'} -c "ps aux | grep node"`);
    console.log('');
    
    console.log('📱 STEP 4: Enable Debugging (same terminal as step 3)');
    console.log('----------------------------------------');
    console.log(`cf ssh ${appName || '<app-name>'} -c "kill -USR1 <PID>"`);
    console.log('');
    
    console.log('📱 STEP 5: Verify Tunnel');
    console.log('----------------------------------------');
    console.log(`netstat -an | grep ${port}`);
    console.log('');
    
    console.log('🔧 STEP 6: Start VS Code Debugging');
    console.log('----------------------------------------');
    console.log('1. Open VS Code');
    console.log('2. Go to Run and Debug (Ctrl+Shift+D)');
    console.log('3. Select \'Debug CAP App Remote\' from dropdown');
    console.log('4. Click the play button ▶️');
    console.log('');
  });

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('');
  console.log('⚠️  Use "npx sap-cap-debugger cleanup" or "cds-debug cleanup" to stop debugging when done');
  process.exit(0);
});

program.parse();
