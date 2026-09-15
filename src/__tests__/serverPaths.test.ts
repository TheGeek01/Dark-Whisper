import * as path from 'path';
import { candidateServerPaths, resolveServerBinary, whisperResourceDir } from '../services/serverPaths';

describe('serverPaths', () => {
  const dev = { resourcesPath: '/electron/resources', appPath: '/repo', isPackaged: false };
  const packaged = { resourcesPath: '/app/resources', appPath: '/app/resources/app.asar', isPackaged: true };

  it('uses the repo resources folder in development and resourcesPath when packaged', () => {
    expect(whisperResourceDir(dev)).toBe(path.join('/repo', 'resources', 'whisper'));
    expect(whisperResourceDir(packaged)).toBe(path.join('/app/resources', 'whisper'));
  });

  it('checks WHISPER_SERVER_DIR first for the vulkan backend only', () => {
    const loc = { ...dev, envDir: '/local/vulkan-build' };
    expect(candidateServerPaths('vulkan', loc)).toEqual([
      path.join('/local/vulkan-build', 'whisper-server.exe'),
      path.join('/repo', 'resources', 'whisper', 'vulkan', 'whisper-server.exe'),
    ]);
    expect(candidateServerPaths('cpu', loc)).toEqual([path.join('/repo', 'resources', 'whisper', 'cpu', 'whisper-server.exe')]);
  });

  it('returns the first existing candidate or null', () => {
    const cpu = path.join('/app/resources', 'whisper', 'cpu', 'whisper-server.exe');
    expect(resolveServerBinary('cpu', packaged, (p) => p === cpu)).toBe(cpu);
    expect(resolveServerBinary('vulkan', packaged, () => false)).toBeNull();
  });
});
