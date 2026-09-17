import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// The SoX binary bundled with node-mic: unpacked next to app.asar when packaged, in
// node_modules in development, else whatever is on PATH.
export function getSoxPath(): string {
  const appPath = app.getAppPath();
  if (appPath.includes('.asar')) {
    const resourcesDir = path.dirname(appPath);
    const asarPath = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'node-mic', 'sox-win32', 'sox.exe');
    if (fs.existsSync(asarPath)) return asarPath;
  }
  const devPath = path.join(appPath, 'node_modules', 'node-mic', 'sox-win32', 'sox.exe');
  if (fs.existsSync(devPath)) return devPath;
  return 'sox';
}
