import * as path from 'path';

export type Backend = 'vulkan' | 'cpu';

export const SERVER_EXE = 'whisper-server.exe';
export const STREAM_EXE = 'whisper-stream.exe';

export interface BinaryLocations {
  envDir?: string;
  resourcesPath: string;
  appPath: string;
  isPackaged: boolean;
}

export function whisperResourceDir(loc: BinaryLocations): string {
  return loc.isPackaged ? path.join(loc.resourcesPath, 'whisper') : path.join(loc.appPath, 'resources', 'whisper');
}

function candidatePaths(backend: Backend, loc: BinaryLocations, exe: string): string[] {
  const candidates: string[] = [];
  if (backend === 'vulkan' && loc.envDir) {
    candidates.push(path.join(loc.envDir, exe));
  }
  candidates.push(path.join(whisperResourceDir(loc), backend, exe));
  return candidates;
}

export function candidateServerPaths(backend: Backend, loc: BinaryLocations): string[] {
  return candidatePaths(backend, loc, SERVER_EXE);
}

export function candidateStreamPaths(backend: Backend, loc: BinaryLocations): string[] {
  return candidatePaths(backend, loc, STREAM_EXE);
}

export function resolveServerBinary(backend: Backend, loc: BinaryLocations, exists: (p: string) => boolean): string | null {
  return candidateServerPaths(backend, loc).find(exists) ?? null;
}

export function resolveStreamBinary(backend: Backend, loc: BinaryLocations, exists: (p: string) => boolean): string | null {
  return candidateStreamPaths(backend, loc).find(exists) ?? null;
}
