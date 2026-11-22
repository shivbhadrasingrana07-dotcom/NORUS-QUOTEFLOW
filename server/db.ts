import fs from 'fs';
import path from 'path';
import { WorkspaceState } from '../src/types.ts';
import { createInitialWorkspaceState } from './seedData.ts';

function getDbPath(): string {
  if (process.env.QUOTEFLOW_DB_PATH) {
    return path.resolve(process.env.QUOTEFLOW_DB_PATH);
  }
  return path.resolve(process.cwd(), 'data', 'quoteflow-db.json');
}

function ensureWorkspaceSchema(raw: Partial<WorkspaceState>): WorkspaceState {
  const defaults = createInitialWorkspaceState();
  return {
    settings: {
      ...defaults.settings,
      ...(raw.settings || {}),
      uomAliases: {
        ...defaults.settings.uomAliases,
        ...(raw.settings?.uomAliases || {}),
      },
    },
    suppliers: Array.isArray(raw.suppliers) ? raw.suppliers : [],
    items: Array.isArray(raw.items) ? raw.items : [],
    rfqs: Array.isArray(raw.rfqs) ? raw.rfqs : [],
    quotations: Array.isArray(raw.quotations) ? raw.quotations : [],
    awards: Array.isArray(raw.awards) ? raw.awards : [],
    auditLogs: Array.isArray(raw.auditLogs) ? raw.auditLogs : [],
  };
}

let writeChain: Promise<unknown> = Promise.resolve();

export function withWorkspaceLock<T>(task: () => Promise<T> | T): Promise<T> {
  const next = writeChain.then(() => task());
  writeChain = next.catch(() => undefined);
  return next;
}

export function loadWorkspace(): WorkspaceState {
  const dbPath = getDbPath();
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(dbPath)) {
    const initial = createInitialWorkspaceState();
    saveWorkspace(initial);
    return initial;
  }
  const raw = fs.readFileSync(dbPath, 'utf-8');
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceState>;
    return ensureWorkspaceSchema(parsed);
  } catch (err) {
    // Never silently destroy user data on corruption: preserve a backup copy and surface explicit error
    const backupPath = `${dbPath}.corrupt.${Date.now()}.bak`;
    try {
      fs.copyFileSync(dbPath, backupPath);
    } catch {
      // Ignore secondary copy error
    }
    throw new Error(
      `Database file at ${dbPath} is unreadable or corrupted (backup saved to ${path.basename(backupPath)}): ${
        err instanceof Error ? err.message : 'Invalid JSON'
      }`
    );
  }
}

export function saveWorkspace(state: WorkspaceState): void {
  const dbPath = getDbPath();
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const uniqueSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
  const tmpPath = `${dbPath}.${uniqueSuffix}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmpPath, dbPath);
}

export async function mutateWorkspace<T>(
  mutator: (state: WorkspaceState) => Promise<T> | T
): Promise<T> {
  return withWorkspaceLock(async () => {
    const state = loadWorkspace();
    const result = await mutator(state);
    saveWorkspace(state);
    return result;
  });
}
