// Renders the SVG sources in assets/ into assets/dark-whisper.ico.
//   npm run icon:build
//   npm run icon:build -- --preview <file.png>    also writes a sheet of every size on dark and light
// Chromium rasterises the SVG at each size, so no image library is needed.
import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(root, 'assets', 'dark-whisper.ico');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// The six-bar waveform blurs below 40 px, so small sizes use four bars drawn on whole pixels:
// icon-16.svg is sharp at 16 and 32, icon-24.svg at 24 (the Windows 11 taskbar at 100%).
function sourceFor(size) {
  if (size === 24) return 'icon-24.svg';
  if (size < 40) return 'icon-16.svg';
  return 'icon.svg';
}

const previewArg = process.argv.indexOf('--preview');
const previewFile = previewArg > 0 ? process.argv[previewArg + 1] : null;

function svgUrl(name) {
  return `data:image/svg+xml;base64,${fs.readFileSync(path.join(root, 'assets', name)).toString('base64')}`;
}

// Straight (not premultiplied) RGBA, top row first, and the same image as PNG.
async function render(win, size) {
  const { rgba, png } = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(svgUrl(sourceFor(size)))};
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ${size};
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, ${size}, ${size});
    const data = ctx.getImageData(0, 0, ${size}, ${size}).data;
    let text = '';
    for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    return { rgba: btoa(text), png: canvas.toDataURL('image/png').split(',')[1] };
  })()`);
  return { rgba: Buffer.from(rgba, 'base64'), png: Buffer.from(png, 'base64') };
}

// A 32-bit BMP image as stored in an .ico: bottom-up BGRA, doubled height, then the AND mask.
function bmpImage(size, rgba) {
  const header = Buffer.alloc(40);
  const maskRow = Math.ceil(size / 32) * 4;
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const pixels = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(maskRow * size);
  for (let y = 0; y < size; y++) {
    const from = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const s = (from * size + x) * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
      // Renderers that ignore alpha use the mask: set it for fully transparent pixels.
      if (rgba[s + 3] === 0) mask[y * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

// 256 px is stored as PNG to keep the file small; smaller sizes stay BMP, which NSIS requires.
function icoFile(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

// Every size on a dark and a light background, then the small sizes magnified 6x pixel for pixel.
async function writePreview(win, pngs, file) {
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const pngs = ${JSON.stringify(pngs.map(({ size, png }) => ({ size, url: `data:image/png;base64,${png.toString('base64')}` })))};
    const images = [];
    for (const { size, url } of pngs) {
      const img = new Image();
      img.src = url;
      await img.decode();
      images.push({ size, img });
    }
    const canvas = document.createElement('canvas');
    canvas.width = 1160;
    canvas.height = 820;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const band = (y, h, bg) => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, y, canvas.width, h);
      let x = 20;
      for (const { size, img } of images) {
        ctx.drawImage(img, x, y + Math.round((h - size) / 2));
        x += size + 24;
      }
    };
    band(0, 300, '#202020');
    band(300, 300, '#f3f3f3');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 600, canvas.width, 220);
    let x = 20;
    for (const { size, img } of images.filter((i) => i.size <= 32)) {
      ctx.drawImage(img, x, 610, size * 6, size * 6);
      x += size * 6 + 20;
    }
    return canvas.toDataURL('image/png');
  })()`);
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  try {
    await win.loadURL('data:text/html,<!doctype html><title>icon</title>');
    const rendered = [];
    for (const size of SIZES) rendered.push({ size, ...(await render(win, size)) });
    const images = rendered.map(({ size, rgba, png }) => ({ size, data: size >= 256 ? png : bmpImage(size, rgba) }));
    fs.writeFileSync(OUTPUT, icoFile(images));
    console.log(`Wrote ${path.relative(root, OUTPUT)} (${SIZES.join(', ')} px)`);
    if (previewFile) {
      await writePreview(win, rendered, previewFile);
      console.log(`Wrote preview ${previewFile}`);
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
