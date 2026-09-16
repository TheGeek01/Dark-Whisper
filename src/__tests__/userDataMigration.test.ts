import {
  planUserDataMigration,
  meaningfulTargetEntries,
  migrateEntries,
  LEGACY_APP_DIRS,
  MIGRATED_ENTRIES,
  type MigrationFs,
  type MigrationPlan,
} from '../services/userDataMigration';

describe('planUserDataMigration', () => {
  it('lists legacy directories oldest name first', () => {
    expect(LEGACY_APP_DIRS).toEqual(['whisper-desktop', 'Whisper Desktop']);
    expect(MIGRATED_ENTRIES).toEqual(['config.json', 'models', 'logs', 'recordings']);
  });

  it('moves nothing when every entry is already in the target', () => {
    expect(
      planUserDataMigration({
        targetEntries: ['config.json', 'models', 'logs', 'recordings'],
        legacyDirs: [{ path: 'C:/AppData/whisper-desktop', entries: ['config.json'] }],
      }),
    ).toBeNull();
  });

  it('retries only the entries still missing from the target', () => {
    expect(
      planUserDataMigration({
        targetEntries: ['config.json', 'logs'],
        legacyDirs: [
          {
            path: 'C:/AppData/whisper-desktop',
            entries: ['config.json', 'models', 'logs', 'recordings'],
          },
        ],
      }),
    ).toEqual({ from: 'C:/AppData/whisper-desktop', entries: ['models', 'recordings'] });
  });

  it('does nothing when there is no legacy directory', () => {
    expect(planUserDataMigration({ targetEntries: [], legacyDirs: [] })).toBeNull();
  });

  it('moves only the entries we own, in a stable order', () => {
    expect(
      planUserDataMigration({
        targetEntries: [],
        legacyDirs: [
          {
            path: 'C:/AppData/whisper-desktop',
            entries: ['recordings', 'config.json', 'Cache', 'models', 'whisper-server.pid'],
          },
        ],
      }),
    ).toEqual({ from: 'C:/AppData/whisper-desktop', entries: ['config.json', 'models', 'recordings'] });
  });

  it('prefers the first legacy directory that holds something of ours', () => {
    const plan = planUserDataMigration({
      targetEntries: [],
      legacyDirs: [
        { path: 'C:/AppData/whisper-desktop', entries: ['Cache'] },
        { path: 'C:/AppData/Whisper Desktop', entries: ['config.json', 'logs'] },
      ],
    });
    expect(plan).toEqual({ from: 'C:/AppData/Whisper Desktop', entries: ['config.json', 'logs'] });
  });

  it('ignores legacy directories that hold none of our entries', () => {
    expect(
      planUserDataMigration({
        targetEntries: [],
        legacyDirs: [{ path: 'C:/AppData/whisper-desktop', entries: ['Cache', 'GPUCache'] }],
      }),
    ).toBeNull();
  });
});

describe('meaningfulTargetEntries', () => {
  it('does not count an empty directory', () => {
    expect(meaningfulTargetEntries([{ name: 'models', isDirectory: true, size: 0, childCount: 0 }])).toEqual([]);
  });

  it('counts a directory with at least one child', () => {
    expect(meaningfulTargetEntries([{ name: 'models', isDirectory: true, size: 0, childCount: 1 }])).toEqual(['models']);
  });

  it('does not count a zero-byte file', () => {
    expect(meaningfulTargetEntries([{ name: 'config.json', isDirectory: false, size: 0, childCount: 0 }])).toEqual([]);
  });

  it('counts a file with bytes', () => {
    expect(meaningfulTargetEntries([{ name: 'config.json', isDirectory: false, size: 246, childCount: 0 }])).toEqual(['config.json']);
  });

  it('returns only the blocking names from a mixed list', () => {
    expect(
      meaningfulTargetEntries([
        { name: 'models', isDirectory: true, size: 0, childCount: 0 },
        { name: 'logs', isDirectory: true, size: 0, childCount: 2 },
        { name: 'config.json', isDirectory: false, size: 0, childCount: 0 },
        { name: 'recordings', isDirectory: false, size: 512, childCount: 0 },
      ]),
    ).toEqual(['logs', 'recordings']);
  });
});

describe('planUserDataMigration + meaningfulTargetEntries integration', () => {
  it('still migrates models when the target has an empty models directory', () => {
    const targetEntries = meaningfulTargetEntries([{ name: 'models', isDirectory: true, size: 0, childCount: 0 }]);
    expect(
      planUserDataMigration({
        targetEntries,
        legacyDirs: [{ path: 'C:/AppData/whisper-desktop', entries: ['models'] }],
      }),
    ).toEqual({ from: 'C:/AppData/whisper-desktop', entries: ['models'] });
  });
});

describe('migrateEntries', () => {
  const join = (a: string, b: string) => `${a}/${b}`;
  const onePlan: MigrationPlan = { from: 'legacy', entries: ['models'] };

  function codeError(code: string): NodeJS.ErrnoException {
    const error = new Error(code) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  }

  function makeFakeFs(overrides: Partial<{ [K in keyof MigrationFs]: MigrationFs[K] }> = {}): MigrationFs & {
    calls: { rename: string[][]; copy: string[][]; remove: string[]; mkdir: string[] };
  } {
    const calls = { rename: [] as string[][], copy: [] as string[][], remove: [] as string[], mkdir: [] as string[] };
    return {
      calls,
      rename(from: string, to: string) {
        calls.rename.push([from, to]);
        overrides.rename?.(from, to);
      },
      copy(from: string, to: string) {
        calls.copy.push([from, to]);
        overrides.copy?.(from, to);
      },
      remove(path: string) {
        calls.remove.push(path);
        overrides.remove?.(path);
      },
      mkdir(path: string) {
        calls.mkdir.push(path);
        overrides.mkdir?.(path);
      },
    };
  }

  it('reports "renamed" when rename succeeds, and never calls copy', () => {
    const io = makeFakeFs();
    const steps = migrateEntries(onePlan, 'target', io, join);
    expect(steps).toEqual([{ entry: 'models', result: 'renamed' }]);
    expect(io.calls.copy).toEqual([]);
  });

  it('falls back to copy-then-remove when rename throws EXDEV, reporting "copied"', () => {
    const io = makeFakeFs({
      rename: () => {
        throw codeError('EXDEV');
      },
    });
    const steps = migrateEntries(onePlan, 'target', io, join);
    expect(steps).toEqual([{ entry: 'models', result: 'copied' }]);
    expect(io.calls.copy).toEqual([['legacy/models', 'target/models']]);
    expect(io.calls.remove).toEqual(['legacy/models']);
  });

  it('keeps both copies (never touches the target) when the source cannot be removed after a successful copy', () => {
    // Regression test for the data-loss bug: cpSync fully succeeds, only the
    // source rmSync throws (e.g. EBUSY on one locked file inside a large
    // directory) — the target copy is complete and must be left alone.
    const io = makeFakeFs({
      rename: () => {
        throw codeError('EBUSY');
      },
      remove: (path: string) => {
        if (path === 'legacy/models') throw codeError('EBUSY');
      },
    });
    const steps = migrateEntries(onePlan, 'target', io, join);
    expect(steps).toEqual([{ entry: 'models', result: 'copied-source-kept', error: 'EBUSY' }]);
    expect(io.calls.remove).toEqual(['legacy/models']);
    expect(io.calls.remove).not.toContain('target/models');
  });

  it('cleans up a partial target copy exactly once when copy itself throws after an EPERM rename', () => {
    const io = makeFakeFs({
      rename: () => {
        throw codeError('EPERM');
      },
      copy: () => {
        throw new Error('copy blew up');
      },
    });
    const steps = migrateEntries(onePlan, 'target', io, join);
    expect(steps).toEqual([{ entry: 'models', result: 'failed', error: 'copy blew up' }]);
    expect(io.calls.remove).toEqual(['target/models']);
  });

  it('never lets the cleanup removal itself escape, and still reports "failed"', () => {
    const io = makeFakeFs({
      rename: () => {
        throw codeError('EPERM');
      },
      copy: () => {
        throw new Error('copy blew up');
      },
      remove: () => {
        throw new Error('cleanup blew up too');
      },
    });
    let steps: ReturnType<typeof migrateEntries> | undefined;
    expect(() => {
      steps = migrateEntries(onePlan, 'target', io, join);
    }).not.toThrow();
    expect(steps).toEqual([{ entry: 'models', result: 'failed', error: 'copy blew up' }]);
  });

  it('fails without attempting a copy for a non-fallback error code', () => {
    const io = makeFakeFs({
      rename: () => {
        throw codeError('ENOENT');
      },
    });
    const steps = migrateEntries(onePlan, 'target', io, join);
    expect(steps).toEqual([{ entry: 'models', result: 'failed', error: 'ENOENT' }]);
    expect(io.calls.copy).toEqual([]);
    expect(io.calls.remove).toEqual([]);
  });

  it('keeps processing later entries after one entry fails', () => {
    const twoEntryPlan: MigrationPlan = { from: 'legacy', entries: ['config.json', 'logs'] };
    const io = makeFakeFs({
      rename: (from: string) => {
        if (from === 'legacy/config.json') throw codeError('ENOENT');
      },
    });
    const steps = migrateEntries(twoEntryPlan, 'target', io, join);
    expect(steps).toEqual([
      { entry: 'config.json', result: 'failed', error: 'ENOENT' },
      { entry: 'logs', result: 'renamed' },
    ]);
  });

  it('reports every entry as failed, without throwing, when mkdir fails', () => {
    const twoEntryPlan: MigrationPlan = { from: 'legacy', entries: ['config.json', 'logs'] };
    const io = makeFakeFs({
      mkdir: () => {
        throw new Error('mkdir blew up');
      },
    });
    const steps = migrateEntries(twoEntryPlan, 'target', io, join);
    expect(steps).toEqual([
      { entry: 'config.json', result: 'failed', error: 'mkdir blew up' },
      { entry: 'logs', result: 'failed', error: 'mkdir blew up' },
    ]);
    expect(io.calls.rename).toEqual([]);
  });
});
