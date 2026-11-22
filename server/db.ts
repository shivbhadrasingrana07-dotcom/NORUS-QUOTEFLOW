import fs from 'fs';
import path from 'path';
import { WorkspaceState } from '../src/types.ts';
import { createInitialWorkspaceState } from './seedData.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'quoteflow-db.json');

export function loadWorkspace(): WorkspaceState {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DB_PATH)) {
      const initial = createInitialWorkspaceState();
      fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), 'utf-8');
      return initial;
    }
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw) as WorkspaceState;
  } catch {
    const initial = createInitialWorkspaceState();
    saveWorkspace(initial);
    return initial;
  }
}

export function saveWorkspace(state: WorkspaceState): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmpPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmpPath, DB_PATH);
}
