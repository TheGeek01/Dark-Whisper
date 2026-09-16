import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  LEGACY_APP_DIRS,
  planUserDataMigration,
  meaningfulTargetEntries,
  migrateEntries,
  type TargetEntry,
  type MigrationFs,
} from './services/userDataMigration';

// Must run before anything calls app.getPath('userData') — electron-store resolves its
// location at import time, so main.ts imports this module first.
app.setName('Dark-Whisper');

function listDir(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
}

// Describe each top-level target entry so a same-named but empty placeholder
// (e.g. one the model manager creates on startup) doesn't block a retry —
// only entries that actually hold something count as "already migrated".
function describeTargetEntry(dir: string, name: string): TargetEntry | null {
  try {
    const stat = fs.statSync(path.join(dir, name));
    if (stat.isDirectory()) {
      const childCount = fs.readdirSync(path.join(dir, name)).length;
      return { name, isDirectory: true, size: 0, childCount };
    }
    return { name, isDirectory: false, size: stat.size, childCount: 0 };
  } catch {
    // Unreadable/vanished between listing and stat-ing: treat as non-blocking.
    return null;
  }
}

const fsIo: MigrationFs = {
  rename: (from, to) => fs.renameSync(from, to),
  copy: (from, to) => fs.cpSync(from, to, { recursive: true }),
  remove: (target) => fs.rmSync(target, { recursive: true, force: true }),
  mkdir: (target) => fs.mkdirSync(target, { recursive: true }),
};

// The whole migration is glue over the tested pure logic in userDataMigration.ts.
// This runs at import time, before any window exists and before there is any
// uncaughtException handler — nothing here may ever throw past this boundary.
try {
  const appData = app.getPath('appData');
  const target = path.join(appData, 'Dark-Whisper');

  const legacyDirs = LEGACY_APP_DIRS.map((name) => path.join(appData, name))
    .map((dir) => ({ path: dir, entries: listDir(dir) }))
    .filter((d): d is { path: string; entries: string[] } => d.entries !== null);

  const targetNames = listDir(target) ?? [];
  const targetDescriptions = targetNames
    .map((name) => describeTargetEntry(target, name))
    .filter((entry): entry is TargetEntry => entry !== null);
  const targetEntries = meaningfulTargetEntries(targetDescriptions);

  const plan = planUserDataMigration({ targetEntries, legacyDirs });

  if (plan) {
    console.warn(`Migrating user data from ${plan.from} to ${target}: ${plan.entries.join(', ')}`);
    const steps = migrateEntries(plan, target, fsIo, path.join);
    for (const step of steps) {
      if (step.result === 'renamed' || step.result === 'copied') {
        console.warn(`Migrated ${step.entry} (${step.result}).`);
      } else if (step.result === 'copied-source-kept') {
        // The target now has a complete copy (won't be touched again); the old
        // copy is just a harmless leftover the user can delete manually.
        console.error(`Copied ${step.entry}, but could not remove the original copy at ${plan.from}: ${step.error}`);
      } else {
        console.error(`Failed to migrate ${step.entry}: ${step.error}`);
      }
    }
  }
} catch (error) {
  console.error('User data migration failed unexpectedly:', error);
}
