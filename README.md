# SAP CAP Remote Debugger

[![npm version](https://badge.fury.io/js/sap-cap-debugger.svg)](https://badge.fury.io/js/sap-cap-debugger)
[![npm yearly downloads](https://img.shields.io/npm/dy/sap-cap-debugger.svg)](https://www.npmjs.com/package/sap-cap-debugger)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/sap-cap-debugger.svg)](https://nodejs.org/)

**Version: 1.0.0**

> **NPX tool for remote debugging SAP CAP applications on Cloud Foundry (CAP v7 and earlier)**

A comprehensive, production-ready solution for debugging SAP Cloud Application Programming (CAP) applications deployed on SAP Business Technology Platform (BTP) Cloud Foundry. This tool provides an easy-to-use NPX command that handles all the complexity of setting up remote debugging for CAP applications where the built-in `cds debug` command is not available.

## 🚀 Quick Start

```bash
# Install and run in one command
npx sap-cap-debugger my-cap-app

# Or install globally
npm install -g sap-cap-debugger
cds-debug my-cap-app
```

## ✨ Features

- **🎯 One-Command Setup**: Complete remote debugging setup with a single command
- **🔧 Multiple Debuggers**: Support for Chrome DevTools, VS Code, or both
- **📱 Interactive Mode**: Interactive app selection when no app name is provided
- **🧹 Auto Cleanup**: Comprehensive cleanup of debugging sessions
- **⚡ Professional**: Production-ready with proper error handling and logging
- **📊 Status Monitoring**: Real-time status checking and monitoring
- **🛠️ Manual Fallback**: Manual step-by-step instructions when automation fails

## 📋 Prerequisites

- **Node.js** 14.0.0 or higher
- **Cloud Foundry CLI** installed and configured
- **SAP CAP application** deployed on Cloud Foundry
- **SSH access** enabled for your Cloud Foundry space

## 🛠️ Installation

### Option 1: NPX (Recommended)
```bash
# Run directly without installation
npx sap-cap-debugger setup my-app-name
```

### Option 2: Global Installation
```bash
# Install globally
npm install -g sap-cap-debugger

# Use the command
cds-debug my-app-name
# or
npx sap-cap-debugger my-app-name
```

### Option 3: Local Installation
```bash
# Install in your project
npm install --save-dev sap-cap-debugger

# Use with npx
npx sap-cap-debugger my-app-name
# or use the global command
cds-debug my-app-name
```

## 📖 Usage

### Basic Commands

```bash
# Debug an application (interactive app selection if no name provided)
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

# Debug with both Chrome and VS Code
npx sap-cap-debugger my-app --debugger both
cds-debug my-app --debugger both

# Clean up debugging session
npx sap-cap-debugger cleanup
cds-debug cleanup

# Check debugging status
npx sap-cap-debugger status
cds-debug status

# List available applications
npx sap-cap-debugger apps
cds-debug apps

# Show manual debugging steps
npx sap-cap-debugger manual my-cap-app
cds-debug manual my-cap-app
```

### Command Options

| Option | Description | Default | Values |
|--------|-------------|---------|--------|
| `--port, -p` | Debug port number | `9229` | Any available port |
| `--debugger, -d` | Debugger type | `chrome` | `chrome`, `vscode`, `both` |
| `--verbose, -v` | Enable verbose logging | `false` | `true`, `false` |

### Examples

```bash
# Debug with Chrome DevTools
npx sap-cap-debugger collaboration-srv
# or
cds-debug collaboration-srv

# Debug with VS Code
npx sap-cap-debugger collaboration-srv --debugger vscode
# or
cds-debug collaboration-srv --debugger vscode

# Debug with both debuggers
npx sap-cap-debugger collaboration-srv --debugger both
# or
cds-debug collaboration-srv --debugger both

# Debug with custom port
npx sap-cap-debugger collaboration-srv --port 9230
# or
cds-debug collaboration-srv --port 9230

# Verbose output
npx sap-cap-debugger collaboration-srv --verbose
# or
cds-debug collaboration-srv --verbose

# Interactive app selection
npx sap-cap-debugger
# or
cds-debug
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

## 🎯 How It Works

The tool uses the **`kill -USR1`** approach from SAP Community blogs, which enables the Node.js inspector on an already running process. This bypasses networking issues that occur with direct SSH tunneling.

### Process Flow

1. **Prerequisites Check**: Verifies CF CLI and required tools
2. **App Verification**: Checks app status and starts if needed
3. **SSH Setup**: Enables SSH access for the application
4. **Process Start**: Starts the CAP application normally
5. **Process Detection**: Finds the Node.js process PID
6. **Tunnel Creation**: Creates SSH tunnel for debugging port
7. **Debug Enablement**: Enables debugging with `kill -USR1`
8. **Debugger Launch**: Opens Chrome DevTools or VS Code
9. **Session Management**: Tracks and manages the debugging session

## 🚨 Troubleshooting

### Common Issues

#### SSH Tunnel Connection Refused
```bash
# Check if the application is running
npx sap-cap-debugger status

# Check application logs
cf logs my-app-name --recent

# Try the setup again
npx sap-cap-debugger setup my-app-name
```

#### Application Not Starting
```bash
# Check application logs
cf logs my-app-name --recent

# Verify Node.js path
cf ssh my-app-name -c "which node"

# Check application structure
cf ssh my-app-name -c "ls -la /home/vcap/app"
```

#### Debugger Not Connecting
```bash
# Verify SSH tunnel
npx sap-cap-debugger status

# Check if process is still running
cf ssh my-app-name -c "ps aux | grep node"

# Clean up and retry
npx sap-cap-debugger cleanup
# or
cds-debug cleanup
npx sap-cap-debugger setup my-app-name
```

### Manual Debugging Steps

If the automated setup fails, use the manual command:

```bash
npx sap-cap-debugger manual my-app-name
```

This will show step-by-step manual instructions.

## 🔍 Status Monitoring

```bash
# Check current debugging status
npx sap-cap-debugger status

# List available applications
npx sap-cap-debugger apps
```

## 🧹 Cleanup

```bash
# Clean up debugging session
npx sap-cap-debugger cleanup
# or
cds-debug cleanup
```

This will:
- Kill SSH tunnel processes
- Free up debugging ports
- Clean up any remaining processes
- Reset the debugging environment

## 🏗️ Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/HatriGt/sap-cap-debugger.git
cd sap-cap-debugger

# Install dependencies
bun install

# Build the project
bun run build

# Run tests
bun test

# Run linting
bun run lint
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
├── types/
│   └── index.ts              # TypeScript types
└── __tests__/                # Test files
```

### Publishing to NPM

```bash
# Build the project
bun run build

# Run tests
bun test

# Publish to NPM
npm publish
```

## 🤝 Contributing

We welcome contributions! Here's how to get started:

### Development Setup

```bash
# Fork and clone the repository
git clone https://github.com/HatriGt/sap-cap-debugger.git
cd sap-cap-debugger

# Install dependencies
bun install

# Create a feature branch
git checkout -b feature/amazing-feature

# Make your changes and test
bun test
bun run lint

# Commit and push
git commit -m "Add amazing feature"
git push origin feature/amazing-feature

# Create a Pull Request
```

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

---

**Note**: This tool is specifically designed for SAP CAP applications before version 8, where the built-in `cds debug` command is not available. For CAP v8+ applications, consider using the official `cds debug` command.

---

<div align="center">
  <p>Made with ❤️ for the SAP CAP Community</p>
  <p>
    <a href="https://github.com/HatriGt/sap-cap-debugger">GitHub</a> •
    <a href="https://www.npmjs.com/package/sap-cap-debugger">NPM</a> •
    <a href="https://github.com/HatriGt/sap-cap-debugger/issues">Issues</a>
  </p>
</div>