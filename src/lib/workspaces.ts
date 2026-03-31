import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceConfig } from '../types';
import { Logger } from '../types';

const CDS_DEBUG_DIRNAME = '.cds-debug';
const WORKSPACES_FILENAME = 'workspaces.json';
const CF_WORKSPACES_DIRNAME = 'cf-workspaces';

export type WorkspaceStore = {
  version: 1;
  workspaces: WorkspaceConfig[];
};

function nowIso(): string {
  return new Date().toISOString();
}

export function getCdsDebugBaseDir(): string {
  return path.join(os.homedir(), CDS_DEBUG_DIRNAME);
}

export function getWorkspacesFilePath(): string {
  return path.join(getCdsDebugBaseDir(), WORKSPACES_FILENAME);
}

export function getWorkspaceCfHomeDir(workspaceName: string): string {
  return path.join(getCdsDebugBaseDir(), CF_WORKSPACES_DIRNAME, workspaceName);
}

export function ensureBaseDirs(): void {
  fs.mkdirSync(getCdsDebugBaseDir(), { recursive: true });
  fs.mkdirSync(path.join(getCdsDebugBaseDir(), CF_WORKSPACES_DIRNAME), { recursive: true });
}

export function isValidWorkspaceName(name: string): boolean {
  // Keep it simple: filesystem-safe, easy to type, no spaces.
  // Allowed: letters, numbers, underscore, dash, dot.
  return /^[a-zA-Z0-9._-]{1,48}$/.test(name);
}

export function loadWorkspaceStore(logger?: Logger): WorkspaceStore {
  ensureBaseDirs();
  const filePath = getWorkspacesFilePath();
  if (!fs.existsSync(filePath)) {
    return { version: 1, workspaces: [] };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WorkspaceStore>;
    const workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    return { version: 1, workspaces: workspaces as WorkspaceConfig[] };
  } catch (e) {
    logger?.debug(`Failed to read workspaces store, starting fresh: ${e}`);
    return { version: 1, workspaces: [] };
  }
}

export function saveWorkspaceStore(store: WorkspaceStore, logger?: Logger): void {
  ensureBaseDirs();
  const filePath = getWorkspacesFilePath();
  try {
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
  } catch (e) {
    logger?.debug(`Failed to save workspaces store: ${e}`);
  }
}

export function listWorkspaces(logger?: Logger): WorkspaceConfig[] {
  const store = loadWorkspaceStore(logger);
  const hydrated = store.workspaces.map(w => hydrateFromCfConfig(w, logger));
  // Persist any newly discovered metadata (org/space/api)
  store.workspaces = hydrated;
  saveWorkspaceStore(store, logger);
  return hydrated.slice().sort((a, b) => (b.lastUsedAt || '').localeCompare(a.lastUsedAt || ''));
}

export function getWorkspace(name: string, logger?: Logger): WorkspaceConfig | undefined {
  const store = loadWorkspaceStore(logger);
  const found = store.workspaces.find(w => w.name === name);
  if (!found) return undefined;
  const hydrated = hydrateFromCfConfig(found, logger);
  if (hydrated !== found) {
    const idx = store.workspaces.findIndex(w => w.name === name);
    store.workspaces[idx] = hydrated;
    saveWorkspaceStore(store, logger);
  }
  return hydrated;
}

export function upsertWorkspace(workspace: WorkspaceConfig, logger?: Logger): void {
  const store = loadWorkspaceStore(logger);
  const idx = store.workspaces.findIndex(w => w.name === workspace.name);
  if (idx >= 0) {
    store.workspaces[idx] = workspace;
  } else {
    store.workspaces.push(workspace);
  }
  saveWorkspaceStore(store, logger);
}

export function touchWorkspaceLastUsed(name: string, logger?: Logger): void {
  const store = loadWorkspaceStore(logger);
  const idx = store.workspaces.findIndex(w => w.name === name);
  if (idx < 0) return;
  store.workspaces[idx] = { ...store.workspaces[idx], lastUsedAt: nowIso() };
  saveWorkspaceStore(store, logger);
}

export function removeWorkspace(name: string, logger?: Logger): void {
  const store = loadWorkspaceStore(logger);
  store.workspaces = store.workspaces.filter(w => w.name !== name);
  saveWorkspaceStore(store, logger);
}

export function createWorkspaceSkeleton(name: string): WorkspaceConfig {
  const cfHomeDir = getWorkspaceCfHomeDir(name);
  const iso = nowIso();
  return {
    name,
    cfHomeDir,
    createdAt: iso,
    lastUsedAt: iso
  };
}

function hydrateFromCfConfig(workspace: WorkspaceConfig, logger?: Logger): WorkspaceConfig {
  // If metadata already present, keep it.
  if (workspace.apiUrl && workspace.org && workspace.space) return workspace;

  try {
    const cfgPaths = [
      path.join(workspace.cfHomeDir, 'config.json'),
      path.join(workspace.cfHomeDir, '.cf', 'config.json')
    ];
    const cfgPath = cfgPaths.find(p => fs.existsSync(p));
    if (!cfgPath) return workspace;
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw) as any;

    const apiUrl: string | undefined = parsed?.Target || parsed?.ApiEndpoint || parsed?.APIEndpoint || parsed?.ApiEndpointUrl;
    const org: string | undefined = parsed?.OrganizationFields?.Name;
    const space: string | undefined = parsed?.SpaceFields?.Name;

    const next: WorkspaceConfig = { ...workspace };
    if (!next.apiUrl && typeof apiUrl === 'string') next.apiUrl = apiUrl;
    if (!next.org && typeof org === 'string') next.org = org;
    if (!next.space && typeof space === 'string') next.space = space;
    return next;
  } catch (e) {
    logger?.debug(`Failed to hydrate workspace '${workspace.name}' from cf config: ${e}`);
    return workspace;
  }
}

