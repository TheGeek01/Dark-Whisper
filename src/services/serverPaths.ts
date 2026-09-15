import * as path from 'path';

export type Backend = 'vulkan' | 'cpu';

export const SERVER_EXE = 'whisper-server.exe';

export interface BinaryLocations {
  envDir?: string;
  resourcesPath: string;
  appPath: string;
  isPackaged: boolean;
}

export function whisperResourceDir(loc: BinaryLocations): string {
  return loc.isPackaged ? path.join(loc.resourcesPath, 'whisper') : path.join(loc.appPath, 'resources', 'whisper');
}

export function candidateServerPaths(backend: Backend, loc: BinaryLocations): string[] {
  const candidates: string[] = [];
  if (backend === 'vulkan' && loc.envDir) {
    candidates.push(path.join(loc.envDir, SERVER_EXE));
  }
  candidates.push(path.join(whisperResourceDir(loc), backend, SERVER_EXE));
  return candidates;
}

export function resolveServerBinary(backend: Backend, loc: BinaryLocations, exists: (p: string) => boolean): string | null {
  return candidateServerPaths(backend, loc).find(exists) ?? null;
}
