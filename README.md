# SAP CAP Remote Debugger

[![npm version](https://badge.fury.io/js/sap-cap-debugger.svg)](https://badge.fury.io/js/sap-cap-debugger)
[![npm yearly downloads](https://img.shields.io/npm/dy/sap-cap-debugger.svg)](https://www.npmjs.com/package/sap-cap-debugger)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/sap-cap-debugger.svg)](https://nodejs.org/)

> **Remote debug SAP CAP (Node.js) apps running on SAP BTP Cloud Foundry — in one command.** Attach **Chrome DevTools** or **VS Code** to a live container over `cf ssh`, with automatic port assignment, multi-app debugging, and multi-space (SSO) workspaces.

`npx sap-cap-debugger my-app` (or `cds-debug my-app`) gets you from "my CAP service is misbehaving in the cloud" to a breakpoint in your editor — no redeploy, no code changes, no manual SSH tunnels.

A production-ready solution for **remote debugging SAP Cloud Application Programming (CAP) applications** deployed on **SAP Business Technology Platform (BTP) Cloud Foundry**. This tool simplifies remote debugging setup with automatic port assignment, multi-app support, and direct Chrome DevTools / VS Code attach.

It enables the Node.js inspector (port 9229) inside a running CF container using `cf ssh` and `kill -USR1`, then forwards it locally (so you can attach with DevTools). It also supports Cloud Foundry SSO (`cf login --sso`) and multi-space “workspaces” (isolated CF targets via `CF_HOME`) so you can debug apps across different org/space targets concurrently.

> **💡 Command Names**: You can use either `npx sap-cap-debugger` or `cds-debug` (if installed globally). Both commands work identically throughout this documentation.

## 🚀 Quick Start

```bash
# Debug an application (interactive selection if no name provided)
npx sap-cap-debugger my-cap-app

# Or install globally
npm install -g sap-cap-debugger
cds-debug my-cap-app
```

## ✨ Features

- **🎯 One-Command Setup** - Complete remote debugging setup with a single command
- **🚀 Multi-App Support** - Debug multiple applications simultaneously with different ports
- **🔌 Auto Port Assignment** - Automatically assigns available ports for each app
- **🧹 Smart Cleanup** - Interactive cleanup for specific apps or all sessions
- **📊 Status Monitoring** - Real-time status checking with active/inactive session indicators
- **🔧 Multiple Debuggers** - Support for Chrome DevTools, VS Code, or both
- **📱 Interactive Mode** - Interactive app selection when no app name is provided
- **⚡ Production-Ready** - Proper error handling, logging, and session management

## 📋 Prerequisites

- **Node.js** 14.0.0 or higher
- **Cloud Foundry CLI** installed and configured
- **SAP CAP application** deployed on Cloud Foundry
- **SSH access** enabled for your Cloud Foundry space

## 🛠️ Installation

### Option 1: NPX (Recommended)

Run directly without installation:

```bash
npx sap-cap-debugger my-app-name
```

### Option 2: Global Installation

```bash
npm install -g sap-cap-debugger

# Use either command name
cds-debug my-app-name
# or
npx sap-cap-debugger my-app-name
```

### Option 3: Local Installation

```bash
npm install --save-dev sap-cap-debugger
npx sap-cap-debugger my-app-name
```

## 📖 Usage

### Basic Commands

```bash
# Debug an application (interactive selection if no name provided)
npx sap-cap-debugger
cds-debug

# Debug specific application
npx sap-cap-debugger my-cap-app
cds-debug my-cap-app

# Debug with custom port
npx sap-cap-debugger my-app --port 9230
cds-debug my-app --port 9230

# Debug with VS Code debugger
npx sap-cap-debugger my-app --debugger vscode
cds-debug my-app --debugger vscode

# Check debugging status
npx sap-cap-debugger status
cds-debug status

# Clean up debugging sessions
npx sap-cap-debugger cleanup
cds-debug cleanup

# List available applications
npx sap-cap-debugger apps
cds-debug apps

# Show help
npx sap-cap-debugger --help
cds-debug --help
```

### Command Options

| Option | Description | Default |
|--------|-------------|---------|
| `--port, -p` | Debug port number | Auto-assigned (9229+) |
| `--debugger, -d` | Debugger type | `chrome` |
| `--verbose, -v` | Enable verbose logging | `false` |
| `--help, -h` | Display help for command | - |

**Debugger Types**: `chrome`, `vscode`, `both`

### Examples

```bash
# Debug with Chrome DevTools (default)
npx sap-cap-debugger collaboration-srv

# Debug with VS Code
npx sap-cap-debugger collaboration-srv --debugger vscode

# Debug with both debuggers
npx sap-cap-debugger collaboration-srv --debugger both

# Debug with custom port
npx sap-cap-debugger collaboration-srv --port 9230

# Verbose output
npx sap-cap-debugger collaboration-srv --verbose

# Interactive app selection
npx sap-cap-debugger
```

## 🚀 Multi-App Debugging

The tool supports debugging multiple applications simultaneously:

- Each app gets its own local port (auto-assigned starting from 9229)
- Each app has its own SSH tunnel to its container
- Each app's inspector runs on port 9229 in its own container
- Chrome DevTools opens directly to the correct debugging session for each app

**Example:**
```bash
# Start debugging first app
npx sap-cap-debugger app1-srv

# Start debugging second app (gets port 9230 automatically)
npx sap-cap-debugger app2-srv

# Check status of all sessions
npx sap-cap-debugger status
```

## 🧭 Workspaces (Multiple CF Spaces/Subaccounts)

Cloud Foundry CLI normally targets one org/space at a time. To debug apps across **different spaces or subaccounts concurrently**, this tool supports **workspaces**.

A workspace is an isolated Cloud Foundry login context backed by CF CLI’s supported config override `CF_HOME`, so you can keep multiple targets logged in at once.

### Workspace commands

```bash
# Add a workspace (prompts for API + login method)
cds-debug workspace add

# List workspaces
cds-debug workspace list

# Remove a workspace (metadata only)
cds-debug workspace remove pp
```

### Debugging with workspaces

```bash
# Pick workspace interactively (if multiple exist)
cds-debug my-app

# Or choose explicitly
cds-debug --workspace pp my-app

# Debug another app in a different workspace at the same time (use a different port)
cds-debug --workspace qa other-app --port 9230
```

## 🔧 VS Code Configuration

For VS Code debugging, ensure your `.vscode/launch.json` contains:

```json
{
  "version": "1.0.0",
  "configurations": [
    {
      "name": "Debug CAP App Remote",
      "type": "node",
      "request": "attach",
      "address": "127.0.0.1",
      "port": 9229,
      "restart": true,
      "localRoot": "${workspaceFolder}",
      "remoteRoot": "/home/vcap/app",
      "skipFiles": [
        "<node_internals>/**"
      ]
    }
  ]
}
```

**Note**: Update the `port` value if you're using a custom port or debugging multiple apps.

## 🎯 How It Works

The tool uses the `kill -USR1` approach to enable the Node.js inspector on an already running process, which bypasses networking issues that occur with direct SSH tunneling.

### Process Flow

1. **Prerequisites Check** - Verifies CF CLI and required tools
2. **App Verification** - Checks app status and starts if needed
3. **SSH Setup** - Enables SSH access (`cf enable-ssh`) and restarts the app if SSH was off, so the change actually takes effect
4. **Connectivity Gate** - Confirms `cf ssh` to the container really works before tunneling
5. **Port Assignment** - Automatically assigns an available local port (or uses the one you specify)
6. **Tunnel Creation** - Opens an SSH tunnel forwarding `localhost:<port>` → remote `9229`
7. **Inspector Enablement** - Signals the running process with remote `kill -USR1 $(pgrep node)` to turn on the Node.js inspector on port 9229 (no second process, no redeploy)
8. **DevTools Launch** - Opens `chrome://inspect`, where the discovered target's **inspect** link attaches Chrome DevTools (Chrome blocks navigating to `devtools://` URLs directly)
9. **Tunnel Held Open** - The CLI stays running to keep the SSH tunnel alive; press `Ctrl+C` to stop and clean up
10. **Session Management** - Tracks and manages multiple debugging sessions

## 🔍 Status Monitoring

Check the status of all debugging sessions:

```bash
npx sap-cap-debugger status
cds-debug status
```

The status command displays:
- **🟢 Active sessions** - Sessions with active SSH tunnels
- **🔴 Inactive sessions** - Stale sessions that can be cleaned up
- Port numbers, Node.js PIDs, and session start times

## 🧹 Cleanup

Clean up debugging sessions interactively:

```bash
# Interactive cleanup (select specific sessions or all)
npx sap-cap-debugger cleanup
cds-debug cleanup

# Clean up specific app
npx sap-cap-debugger cleanup my-app-name
cds-debug cleanup my-app-name
```

The cleanup command:
- Shows active and inactive sessions
- Allows selection of specific sessions or all
- Kills SSH tunnel processes
- Frees up debugging ports
- Removes session records

## 🚨 Troubleshooting

### SSH Tunnel Connection Refused

```bash
# Check if the application is running
npx sap-cap-debugger status

# Check application logs
cf logs my-app-name --recent

# Try again
npx sap-cap-debugger my-app-name
```

### Application Not Starting

```bash
# Check application logs
cf logs my-app-name --recent

# Verify Node.js path
cf ssh my-app-name -c "which node"

# Check application structure
cf ssh my-app-name -c "ls -la /home/vcap/app"
```

### Debugger Not Connecting

```bash
# Verify SSH tunnel
npx sap-cap-debugger status

# Check if process is still running
cf ssh my-app-name -c "ps aux | grep node"

# Clean up and retry
npx sap-cap-debugger cleanup
npx sap-cap-debugger my-app-name
```

### Manual Debugging Steps

If the automated setup fails, use the manual command:

```bash
npx sap-cap-debugger manual my-app-name
```

This will show step-by-step manual instructions.

## 🏗️ Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/HatriGt/sap-cap-debugger.git
cd sap-cap-debugger

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Run linting
npm run lint
```

### Project Structure

```
src/
├── bin/
│   └── cap-debug.ts          # CLI entry point
├── lib/
│   ├── cap-debugger.ts       # Main debugger class
│   ├── cloudfoundry.ts       # CF operations
│   ├── port-manager.ts       # Port management
│   ├── ssh-tunnel.ts         # SSH tunnel management
│   └── debugger-launcher.ts  # Debugger launching
├── utils/
│   ├── logger.ts             # Logging utilities
│   └── command.ts            # Command execution
└── types/
    └── index.ts              # TypeScript types
```

## ❓ FAQ

**How do I remote debug a SAP CAP (Node.js) app running on SAP BTP Cloud Foundry?**
Run `npx sap-cap-debugger <app-name>`. The tool enables `cf ssh`, opens an SSH tunnel to the container, turns on the Node.js inspector on port `9229`, and opens `chrome://inspect` so you can attach Chrome DevTools or VS Code — without redeploying or changing your code.

**How do I attach Chrome DevTools to a Node.js process on Cloud Foundry?**
Once the tunnel is up, the tool opens `chrome://inspect`; click the **inspect** link next to the discovered `localhost:9229` target. (Chrome intentionally blocks opening `devtools://` URLs directly, so `chrome://inspect` is the supported one-click launcher.)

**Do I need to redeploy or modify my CAP app to debug it?**
No. The inspector is enabled on the already-running process with `kill -USR1 $(pgrep node)` — no `--inspect` flag, no second process, no redeploy.

**Does this work with `cds debug` and CAP v8+?**
Yes. It works with CAP v7, v8, and later. CAP v8+ ships a built-in `cds debug`, but this tool adds multi-app debugging, automatic port assignment, multi-space/SSO workspaces, and direct Chrome DevTools / VS Code attach.

**Can I debug apps in multiple Cloud Foundry spaces or subaccounts at the same time?**
Yes — use [workspaces](#-workspaces-multiple-cf-spacessubaccounts). Each workspace is an isolated CF login (`CF_HOME`), so you can debug across different org/space/subaccount targets concurrently, each on its own local port.

**What are the requirements?**
Node.js 14+, the Cloud Foundry CLI, SSH enabled for your space, and a SAP CAP app deployed on Cloud Foundry. See [Prerequisites](#-prerequisites).

## 🤝 Contributing

We welcome contributions! Here's how to get started:

1. Fork and clone the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes and test: `npm test && npm run lint`
4. Commit your changes: `git commit -m "feat: Add amazing feature"`
5. Push to the branch: `git push origin feature/amazing-feature`
6. Create a Pull Request

### Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `style:` - Code style changes
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Based on the [SAP Community Blog](https://community.sap.com/t5/technology-blogs-by-sap/set-up-remote-debugging-to-diagnose-cap-applications-node-js-stack-at/ba-p/13515376) approach
- Inspired by the SAP Cloud SDK remote debugging guide
- Built for the SAP CAP community

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/HatriGt/sap-cap-debugger/issues)
- **Discussions**: [GitHub Discussions](https://github.com/HatriGt/sap-cap-debugger/discussions)

## 🔗 Related Projects

- [SAP Cloud Application Programming](https://cap.cloud.sap/)
- [SAP Cloud SDK](https://sap.github.io/cloud-sdk/)
- [SAP Business Technology Platform](https://www.sap.com/products/technology-platform.html)

**Keywords**: `cds-debug`, SAP CAP remote debugging, SAP BTP Cloud Foundry, `cf ssh`, Node inspector 9229, `kill -USR1`, `cf login --sso`, multiple spaces, workspaces, Chrome DevTools, VS Code attach.

---

**Note**: This tool works with SAP CAP applications of all versions (v7, v8, and later). While CAP v8+ includes the built-in `cds debug` command, this tool provides additional features like multi-app debugging, automatic port assignment, and direct DevTools integration that may be useful for advanced debugging scenarios.

---

<div align="center">
  <p>Made with ❤️ for the SAP CAP Community</p>
  <p>
    <a href="https://github.com/HatriGt/sap-cap-debugger">GitHub</a> •
    <a href="https://www.npmjs.com/package/sap-cap-debugger">NPM</a> •
    <a href="https://github.com/HatriGt/sap-cap-debugger/issues">Issues</a>
  </p>
</div>
