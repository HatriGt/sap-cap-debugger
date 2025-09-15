#!/usr/bin/env node

import { Command } from 'commander';
import inquirer from 'inquirer';
import { CAPDebugger } from '../lib/cap-debugger';
import { createLogger } from '../utils/logger';
import { DebugConfig, DebuggerType } from '../types';

const program = new Command();

program
  .name('cds-debug')
  .description('Professional NPX tool for remote debugging SAP CAP applications on Cloud Foundry')
  .version('1.0.0')
  .argument('[app-name]', 'Name of the CAP application to debug')
  .option('-p, --port <port>', 'Debug port number', '9229')
  .option('-d, --debugger <type>', 'Debugger type: chrome, vscode, or both', 'chrome')
  .option('-v, --verbose', 'Enable verbose logging', false)
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

    const config: DebugConfig = {
      appName: finalAppName,
      debugPort: parseInt(options.port),
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
  .description('Clean up debugging session')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (options) => {
    const logger = createLogger(options.verbose);
    const capDebugger = new CAPDebugger(logger);
    
    await capDebugger.cleanup();
  });

program
  .command('status')
  .description('Show current debugging status')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (options) => {
    const logger = createLogger(options.verbose);
    const capDebugger = new CAPDebugger(logger);
    
    await capDebugger.showStatus();
  });

program
  .command('apps')
  .description('List available CAP applications')
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
