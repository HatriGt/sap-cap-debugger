export interface DebugConfig {
  appName: string;
  workspaceName?: string;
  workspaceCfHomeDir?: string;
  debugPort: number;
  debuggerType: 'chrome' | 'vscode' | 'both';
  autoCleanup: boolean;
  verbose: boolean;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  command: string;
}

export interface AppStatus {
  name: string;
  status: 'started' | 'stopped' | 'unknown';
  instances: string;
  memory: string;
  disk: string;
  urls: string[];
}

export interface DebugSession {
  appName: string;
  workspaceName?: string;
  nodePid: number;
  sshTunnelPid: number;
  appProcessPid: number;
  debugPort: number;
  startTime: Date;
}

export type WorkspaceLoginMethod = 'standard' | 'sso';

export interface WorkspaceConfig {
  name: string;
  cfHomeDir: string;
  apiUrl?: string;
  org?: string;
  space?: string;
  loginMethod?: WorkspaceLoginMethod;
  createdAt: string; // ISO string
  lastUsedAt: string; // ISO string
}

export interface CommandResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number;
}

export type DebuggerType = 'chrome' | 'vscode' | 'both';

export interface Logger {
  info: (message: string) => void;
  success: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
  step: (message: string) => void;
  debug: (message: string) => void;
  loading: (message: string) => void;
  stopLoading: () => void;
  update: (message: string) => void;
}
