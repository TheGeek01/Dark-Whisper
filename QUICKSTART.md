# Quick Start Guide - Dark-Whisper

## Setup (One-time)

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Fetch the transcription server**
   ```bash
   npm run whisper:fetch
   ```
   Downloads the official whisper.cpp CPU build pinned in `whisper.version` into `resources/whisper/cpu`: `whisper-server.exe` for dictation and refinement, and `whisper-stream.exe` plus `SDL2.dll` for live sessions. Without this the app starts but reports that the server is not installed.

   For a GPU build, point `WHISPER_SERVER_DIR` at a folder containing your own Vulkan `whisper-server.exe`, or use the `whisper-server` artifact from a CI run.

3. **Build the project**
   ```bash
   npm run build
   ```

## Running the App

### Option 1: Simple Start
```bash
npm start
```

### Option 2: Development Mode (with file watching)
```bash
npm run dev
```
This will automatically rebuild when you change TypeScript files.

### Option 3: Manual Watch + Dev
In one terminal:
```bash
npm run watch
```

In another terminal:
```bash
npm start
```

## First Run Checklist

- ✅ App appears in system tray (the window starts hidden — open it with tray → Show/Hide)
- ✅ Status line shows `No model installed`, then download a model from the banner or the 🧠 button
- ✅ Status line turns green: `Ready — <model> (GPU/CPU)`
- ✅ Microphone is working and permitted in Windows
- ✅ `Ctrl+Q` is not bound to another app
- ✅ Check Windows Sound settings if no audio captured

Using an external API instead? Set **Transcription server → External API** in Settings; no model download is needed.

## Testing

1. Start the app and open the window from the tray
2. Download `tiny.en` (74 MB) in the Models screen — smallest model, fastest to test with
3. Wait for the status line to read `Ready`
4. Press **`Ctrl+Q`**, speak clearly: "Hello, this is a test"
5. Press **`Ctrl+Q`** again to stop
6. The transcription appears in the window and is pasted into whatever had focus

### Testing a session

1. Also download `base.en` (the default live model)
2. Click **Start session**; the new document opens in the centre and fills in as you speak
3. Watch the Session panel on the right: blocks go live → waiting → refining → refined
4. Tip: set **Minutes per block** to 1 to see refinement sooner
5. Click **Stop**; the document stays selected in the library

### Testing the live engine alone

```bash
npm run build
npm run stream:probe -- "%APPDATA%\Dark-Whisper\models\ggml-base.en.bin"
```

Prints each segment as you speak (Ctrl+C to stop). Add a capture id after the model to pick a microphone. It does not record session audio.

## Common Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run watch` | Watch files and auto-compile |
| `npm start` | Build and launch the app |
| `npm run dev` | Development mode with hot reload |
| `npm test` | Run the unit tests (332 tests) |
| `npm run lint` | Check code style |
| `npm run whisper:fetch` | Download the pinned whisper.cpp CPU binaries |
| `npm run stream:probe -- <model>` | Run the live engine alone |
| `npm run build:renderer` | Compile the window code and copy marked/DOMPurify |
| `npm run smoke:workspace` | End-to-end check of the workspace in a throwaway vault |
| `npm run build:windows` | Build the Windows installer |

## File Locations

- **Source Code**: `src/`
- **Window code**: src/renderer/ (compiled to public/js/, generated)
- **Compiled Code**: `dist/` (auto-generated)
- **Server Binaries**: `resources/whisper/{cpu,vulkan}/` (generated, gitignored)
- **Recordings**: `%APPDATA%/Dark-Whisper/recordings/`
- **Speech Models**: `%APPDATA%/Dark-Whisper/models/`
- **Server Log**: `%APPDATA%/Dark-Whisper/logs/whisper-server.log`
- **Live Engine Log**: `%APPDATA%/Dark-Whisper/logs/stream.log`
- **Session Audio**: `%APPDATA%/Dark-Whisper/sessions/`
- **Session Documents**: `Documents/Dark-Whisper/` (the vault; change it in Settings)
- **Settings**: `%APPDATA%/Dark-Whisper/config.json`

## Troubleshooting

**App won't start?**
- Run `npm install` again
- Run `npm run build`
- Check Node.js version (need 24+)

**Status line says the server is not installed?**
- Run `npm run whisper:fetch`
- Or set `WHISPER_SERVER_DIR` to a folder holding `whisper-server.exe`

**Status line red (`Server error`)?**
- Click **Open log**, or read `%APPDATA%/Dark-Whisper/logs/whisper-server.log`
- `Model failed to load` → delete and re-download the model
- Tick **Force CPU** in Settings if the GPU build misbehaves

**`Ctrl+Q` not working?**
- Close other apps using that shortcut, or change it in Settings
- Check the console for hotkey registration errors
- Remember the hotkey is ignored while the server is loading a model

**Session shows no text?**
- Install the live model (`base.en` by default)
- Check **Session microphone** in Settings, and `%APPDATA%/Dark-Whisper/logs/stream.log`

**Installed with npm 12 and there is no `sox.exe`?**
- npm 12 skips dependency install scripts unless approved; run `node scripts/postinstall.js` inside `node_modules/node-mic`, or approve it with `npm install-scripts approve node-mic`

**No audio recorded?**
- Check Windows microphone settings and permissions
- Pick the right device in Settings → Microphone Device
- Test the microphone in another app

**Transcription slow?**
- Check whether the status says `(CPU)`; a GPU build plus a current driver is much faster
- Try a smaller model (`small.en-q5_1`, `base.en`)

**External API connection fails?**
- Verify the server is running, e.g. `curl http://127.0.0.1:4444/v1/health`
- Check the URL in Settings and any firewall rules
