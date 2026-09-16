import * as path from 'path';
import {
  candidateServerPaths,
  candidateStreamPaths,
  resolveServerBinary,
  resolveStreamBinary,
  whisperResourceDir,
} from '../services/serverPaths';

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

  it('resolves whisper-stream.exe next to the server binary', () => {
    const packagedStream = path.join('/app/resources', 'whisper', 'cpu', 'whisper-stream.exe');
    expect(candidateStreamPaths('cpu', packaged)).toEqual([packagedStream]);
    expect(resolveStreamBinary('cpu', packaged, (p) => p === packagedStream)).toBe(packagedStream);
    expect(resolveStreamBinary('cpu', packaged, () => false)).toBeNull();
  });

  it('honours WHISPER_SERVER_DIR for the vulkan stream binary only', () => {
    const loc = { ...dev, envDir: '/local/vulkan-build' };
    expect(candidateStreamPaths('vulkan', loc)).toEqual([
      path.join('/local/vulkan-build', 'whisper-stream.exe'),
      path.join('/repo', 'resources', 'whisper', 'vulkan', 'whisper-stream.exe'),
    ]);
    expect(candidateStreamPaths('cpu', loc)).toEqual([path.join('/repo', 'resources', 'whisper', 'cpu', 'whisper-stream.exe')]);
  });
});
