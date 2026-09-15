export type ServerMode = 'builtin' | 'external';

export function initialServerMode(configFileExisted: boolean): ServerMode {
  return configFileExisted ? 'external' : 'builtin';
}
