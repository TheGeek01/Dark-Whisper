export const LEGACY_APP_DIRS: readonly string[] = ['whisper-desktop', 'Whisper Desktop'];

// Everything else in a legacy profile (Electron caches, GPU caches) is disposable.
export const MIGRATED_ENTRIES: readonly string[] = ['config.json', 'models', 'logs', 'recordings'];

export interface LegacyDir {
  path: string;
  entries: string[];
}

export interface MigrationPlan {
  from: string;
  entries: string[];
}

export interface TargetEntry {
  name: string;
  isDirectory: boolean;
  size: number; // bytes, for files
  childCount: number; // entries inside, for directories
}

// An entry only counts as "already migrated" if it actually holds something:
// a non-empty directory, or a file with bytes in it. A same-named empty
// directory (e.g. a placeholder some other startup code created) must not
// block a retry.
export function meaningfulTargetEntries(entries: TargetEntry[]): string[] {
  return entries.filter((entry) => (entry.isDirectory ? entry.childCount > 0 : entry.size > 0)).map((entry) => entry.name);
}

export function planUserDataMigration(input: { targetEntries: string[]; legacyDirs: LegacyDir[] }): MigrationPlan | null {
  for (const dir of input.legacyDirs) {
    const entries = MIGRATED_ENTRIES.filter((name) => dir.entries.includes(name) && !input.targetEntries.includes(name));
    if (entries.length > 0) {
      return { from: dir.path, entries };
    }
  }
  return null;
}

// Pure(ish) filesystem seam so the migration's execution logic can be unit-tested
// without touching a real disk or importing electron. appIdentity.ts supplies the
// real fs-backed implementation; tests supply a fake.
export interface MigrationFs {
  rename(from: string, to: string): void;
  copy(from: string, to: string): void;
  remove(path: string): void;
  mkdir(path: string): void;
}

export type MigrationStep =
  | { entry: string; result: 'renamed' }
  | { entry: string; result: 'copied' } // copied, source removed
  | { entry: string; result: 'copied-source-kept'; error: string } // copy ok, source remove failed
  | { entry: string; result: 'failed'; error: string }; // copy failed; partial target cleaned if possible

// Error codes worth falling back to copy-then-remove for: a different volume (EXDEV);
// the entry is momentarily locked, e.g. antivirus/indexer scanning a freshly written
// file (EBUSY); or — on Windows — renameSync refusing to rename a directory onto an
// existing one, even an empty one (EPERM).
export const FALLBACK_CODES: readonly string[] = ['EXDEV', 'EBUSY', 'EPERM'];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function migrateEntries(plan: MigrationPlan, targetDir: string, io: MigrationFs, join: (a: string, b: string) => string): MigrationStep[] {
  try {
    io.mkdir(targetDir);
  } catch (mkdirError) {
    const error = errorMessage(mkdirError);
    return plan.entries.map((entry) => ({ entry, result: 'failed' as const, error }));
  }

  const steps: MigrationStep[] = [];

  for (const entry of plan.entries) {
    const from = join(plan.from, entry);
    const to = join(targetDir, entry);

    try {
      io.rename(from, to);
      steps.push({ entry, result: 'renamed' });
      continue;
    } catch (renameError) {
      const code = (renameError as NodeJS.ErrnoException | undefined)?.code;
      if (!code || !FALLBACK_CODES.includes(code)) {
        steps.push({ entry, result: 'failed', error: errorMessage(renameError) });
        continue;
      }

      try {
        io.copy(from, to);
      } catch (copyError) {
        try {
          io.remove(to);
        } catch {
          // Best-effort cleanup only: never let a cleanup failure escape or mask
          // the original copy error.
        }
        steps.push({ entry, result: 'failed', error: errorMessage(copyError) });
        continue;
      }

      try {
        io.remove(from);
        steps.push({ entry, result: 'copied' });
      } catch (removeError) {
        // Copy succeeded but we couldn't clean up the source: the target now has a
        // complete copy, so it must never be touched — the source is the one that
        // still needs attention (and will simply be seen again, harmlessly, next launch).
        steps.push({ entry, result: 'copied-source-kept', error: errorMessage(removeError) });
      }
    }
  }

  return steps;
}
