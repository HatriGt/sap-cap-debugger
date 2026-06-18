#!/usr/bin/env node

import { Command } from 'commander';
import inquirer from 'inquirer';
import { CAPDebugger } from '../lib/cap-debugger';
import { createLogger } from '../utils/logger';
import { DebugConfig, DebuggerType } from '../types';
import { PortManager } from '../lib/port-manager';
import { CommandExecutor } from '../utils/command';
import pkg from '../../package.json';
import { AuthExpiredError, CloudFoundryClient } from '../lib/cloudfoundry';

const program = new Command();

program
  .name('cds-debug')
  .description('Professional NPX tool for remote debugging SAP CAP applications on Cloud Foundry')
  .version(pkg.version)
  .helpOption('-h, --help', 'Display help for command')
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
  .option('-w, --workspace <name>', 'Workspace name to use (otherwise select interactively)')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (appName, options) => {
    const logger = createLogger(options.verbose);
    const capDebugger = new CAPDebugger(logger);
    const commandExecutor = new CommandExecutor(logger);

    let finalAppName = appName;
    
    // Workspace selection.
    //
    // Workspaces are OPTIONAL and opt-in. By default (no --workspace) we use the
    // AMBIENT cf login - the same `~/.cf` session your normal `cf ssh` uses - so
    // the tool behaves exactly like running the cf commands yourself.
    //
    // Forcing an isolated CF_HOME workspace previously broke `cf ssh` with
    // "You are not authorized to perform the requested action" whenever that
    // workspace's token wasn't SSH-authorized, even though the user's real cf
    // login worked. So we only switch CF_HOME when a workspace is explicitly
    // requested via --workspace <name>.
    const { listWorkspaces, getWorkspace, touchWorkspaceLastUsed } = await import('../lib/workspaces');
    let workspaceName: string | undefined = options.workspace;
    let workspaceCfHomeDir: string | undefined;

    if (workspaceName) {
      const ws = getWorkspace(workspaceName, logger);
      if (!ws) {
        logger.error(`Workspace '${workspaceName}' not found. Use: cds-debug workspace list`);
        process.exit(1);
      }
      workspaceCfHomeDir = ws.cfHomeDir;
      touchWorkspaceLastUsed(workspaceName, logger);
      logger.info(`Using workspace '${workspaceName}' (CF_HOME: ${workspaceCfHomeDir})`);
    } else {
      // No --workspace: use the current/ambient cf login.
      const workspaces = listWorkspaces(logger);
      if (workspaces.length > 0) {
        logger.info('Using your current cf login. To use a saved workspace, pass --workspace <name>.');
      }
    }

    // If no app name provided, show interactive selection (inside chosen workspace)
    if (!finalAppName) {
      try {
        const cfEnv = workspaceCfHomeDir ? { CF_HOME: workspaceCfHomeDir } : undefined;
        const cfClient = new CloudFoundryClient(logger, cfEnv, workspaceName);

        let apps;
        try {
          apps = await cfClient.getApps();
        } catch (e) {
          if (e instanceof AuthExpiredError && workspaceName && workspaceCfHomeDir) {
            const { getWorkspace } = await import('../lib/workspaces');
            const ws = getWorkspace(workspaceName, logger);
            const loginMethod = ws?.loginMethod || 'standard';
            logger.warning(`Cloud Foundry session expired for workspace '${workspaceName}'`);
            const { confirm } = await inquirer.prompt([
              { type: 'confirm', name: 'confirm', message: 'Re-login now?', default: false }
            ]);
            if (!confirm) throw e;

            await commandExecutor.executeWithOutput('cf', loginMethod === 'sso' ? ['login', '--sso'] : ['login'], {
              env: { ...process.env, CF_HOME: workspaceCfHomeDir }
            });
            apps = await cfClient.getApps();
          } else {
            throw e;
          }
        }
        
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
      debugPort = await portManager.getPortForApp(finalAppName, workspaceName);
      logger.stopLoading();
      if (debugPort !== 9229) {
        logger.info(`Using port ${debugPort} for ${finalAppName}`);
      }
    }

    const config: DebugConfig = {
      appName: finalAppName,
      workspaceName,
      workspaceCfHomeDir,
      debugPort: debugPort,
      debuggerType: options.debugger as DebuggerType,
      autoCleanup: false,
      verbose: options.verbose
    };

    const success = await capDebugger.setupDebugging(config);
    process.exit(success ? 0 : 1);
  });

// Workspace management
const workspaceCmd = program
  .command('workspace')
  .description('Manage Cloud Foundry workspaces (isolated CF targets)')
  .addHelpText('after', `
Examples:
  $ cds-debug workspace list
  $ cds-debug workspace add
  $ cds-debug workspace remove pp
  `);

workspaceCmd
  .command('list')
  .description('List configured workspaces')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (options) => {
    const logger = createLogger(options.verbose);
    const { listWorkspaces } = await import('../lib/workspaces');
    const workspaces = listWorkspaces(logger);
    if (workspaces.length === 0) {
      logger.info('No workspaces configured. Run: cds-debug workspace add');
      return;
    }
    console.log('');
    logger.info('Workspaces:');
    for (const w of workspaces) {
      const orgSpace = w.org && w.space ? `${w.org} / ${w.space}` : '';
      const api = options.verbose && w.apiUrl ? `@ ${w.apiUrl}` : '';
      const meta = `${api} ${orgSpace}`.trim();
      console.log(`  • ${w.name}${meta ? ` (${meta})` : ''}`);
    }
    console.log('');
  });

workspaceCmd
  .command('add')
  .description('Add a new workspace (logs into a CF target)')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (options) => {
    const logger = createLogger(options.verbose);
    const { isValidWorkspaceName, getWorkspace, upsertWorkspace, createWorkspaceSkeleton } = await import('../lib/workspaces');
    const commandExecutor = new CommandExecutor(logger);

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'workspaceName',
        message: 'Workspace name (e.g. pp, qa, prod-eu10):',
        validate: (v: string) => isValidWorkspaceName(v) || 'Use 1-48 chars: letters, numbers, dot, dash, underscore'
      },
      {
        type: 'input',
        name: 'apiUrl',
        message: 'CF API endpoint (e.g. https://api.cf.eu10-xxx.hana.ondemand.com):',
        validate: (v: string) => !!v.trim() || 'API endpoint is required'
      },
      {
        type: 'list',
        name: 'loginMethod',
        message: 'Login method:',
        choices: [
          { name: 'Standard (cf login)', value: 'standard' },
          { name: 'SSO (cf login --sso)', value: 'sso' }
        ],
        default: 'standard'
      }
    ]);

    const workspaceName = answers.workspaceName as string;
    if (getWorkspace(workspaceName, logger)) {
      logger.error(`Workspace '${workspaceName}' already exists.`);
      process.exit(1);
    }

    const ws = createWorkspaceSkeleton(workspaceName);
    ws.apiUrl = answers.apiUrl;
    ws.loginMethod = answers.loginMethod;
    upsertWorkspace(ws, logger);

    const env = { ...process.env, CF_HOME: ws.cfHomeDir };

    // Configure API then login interactively
    const apiResult = await commandExecutor.execute('cf', ['api', ws.apiUrl!], { env });
    if (!apiResult.success) {
      logger.error(`Failed to set CF API: ${apiResult.output || apiResult.error}`);
      process.exit(1);
    }

    const loginArgs = ws.loginMethod === 'sso' ? ['login', '--sso'] : ['login'];
    const loginResult = await commandExecutor.executeWithOutput('cf', loginArgs, { env });
    if (!loginResult.success) {
      logger.error(`Login failed: ${loginResult.error}`);
      process.exit(1);
    }

    // Capture target metadata for display
    const targetResult = await commandExecutor.execute('cf', ['target'], { env });
    if (targetResult.success) {
      const lines = targetResult.output.split('\n');
      for (const line of lines) {
        const mApi = line.match(/api endpoint:\s*(.+)\s*/i);
        const mOrg = line.match(/org:\s*(.+)\s*/i);
        const mSpace = line.match(/space:\s*(.+)\s*/i);
        if (mApi?.[1]) ws.apiUrl = mApi[1].trim();
        if (mOrg?.[1]) ws.org = mOrg[1].trim();
        if (mSpace?.[1]) ws.space = mSpace[1].trim();
      }
      upsertWorkspace(ws, logger);
    }

    logger.success(`Workspace '${ws.name}' added.`);
  });

workspaceCmd
  .command('login')
  .description('Login (or re-login) to a workspace')
  .argument('<name>', 'Workspace name')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (name, options) => {
    const logger = createLogger(options.verbose);
    const { getWorkspace, upsertWorkspace } = await import('../lib/workspaces');
    const ws = getWorkspace(name, logger);
    if (!ws) {
      logger.error(`Workspace '${name}' not found.`);
      process.exit(1);
    }

    const commandExecutor = new CommandExecutor(logger);
    const env = { ...process.env, CF_HOME: ws.cfHomeDir };
    const loginArgs = ws.loginMethod === 'sso' ? ['login', '--sso'] : ['login'];

    const loginResult = await commandExecutor.executeWithOutput('cf', loginArgs, { env });
    if (!loginResult.success) {
      logger.error(`Login failed: ${loginResult.error}`);
      process.exit(1);
    }

    // Refresh metadata
    const targetResult = await commandExecutor.execute('cf', ['target'], { env });
    if (targetResult.success) {
      const lines = targetResult.output.split('\n');
      for (const line of lines) {
        const mApi = line.match(/api endpoint:\s*(.+)\s*/i);
        const mOrg = line.match(/org:\s*(.+)\s*/i);
        const mSpace = line.match(/space:\s*(.+)\s*/i);
        if (mApi?.[1]) ws.apiUrl = mApi[1].trim();
        if (mOrg?.[1]) ws.org = mOrg[1].trim();
        if (mSpace?.[1]) ws.space = mSpace[1].trim();
      }
      upsertWorkspace(ws, logger);
    }

    logger.success(`Workspace '${ws.name}' is logged in.`);
  });

workspaceCmd
  .command('remove')
  .description('Remove a workspace')
  .argument('<name>', 'Workspace name')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (name, options) => {
    const logger = createLogger(options.verbose);
    const { getWorkspace, removeWorkspace } = await import('../lib/workspaces');
    const ws = getWorkspace(name, logger);
    if (!ws) {
      logger.error(`Workspace '${name}' not found.`);
      process.exit(1);
    }
    removeWorkspace(name, logger);
    logger.success(`Workspace '${name}' removed (metadata only).`);
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
      // If multiple workspaces have the same app name, ask which one to clean.
      const sessions = capDebugger.getAllSessions().filter(s => s.appName === appName);
      if (sessions.length > 1) {
        const { selected } = await inquirer.prompt([
          {
            type: 'list',
            name: 'selected',
            message: `Multiple sessions found for '${appName}'. Which one to clean?`,
            choices: sessions.map(s => ({
              name: `${s.workspaceName ? `[${s.workspaceName}] ` : ''}${s.appName} (port ${s.debugPort})`,
              value: `${s.workspaceName || ''}::${s.appName}`
            }))
          }
        ]);
        const [wsName] = (selected as string).split('::');
        await capDebugger.cleanup(appName, wsName || undefined);
      } else {
        await capDebugger.cleanup(appName, sessions[0]?.workspaceName);
      }
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
        const key = `${session.workspaceName || ''}::${session.appName}`;
        if (isActive) {
          activeSessions.push(key);
        } else {
          inactiveSessions.push(key);
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
          const isActive = activeSessions.includes(`${s.workspaceName || ''}::${s.appName}`);
          const status = isActive ? '[Active]' : '[Inactive]';
          return {
            name: `${status} ${s.workspaceName ? `[${s.workspaceName}] ` : ''}${s.appName} (port ${s.debugPort})`,
            value: `${s.workspaceName || ''}::${s.appName}`
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
          const [wsName, selectedApp] = (selected as string).split('::');
          logger.info(`Cleaning up ${selectedApp}${wsName ? ` (workspace: ${wsName})` : ''}...`);
          await capDebugger.cleanup(selectedApp, wsName || undefined);
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
