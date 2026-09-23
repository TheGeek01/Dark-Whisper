# Dark-Whisper

A Windows dictation workspace. Press `Ctrl+Q` to add a **quick note** to today's note file, or start a **session** and Dark-Whisper writes a Markdown document as you speak. Pauses in your speech start new paragraphs, each stamped with the time, and every finished paragraph is quietly re-transcribed at higher quality.

Transcription runs on a **built-in [whisper.cpp](https://github.com/ggml-org/whisper.cpp) server** that ships with the app, so a fresh install needs nothing else: pick a speech model, and everything works offline. You can still point the app at OpenAI's Whisper API or any other compatible server instead.

## Features

- **Quick Notes** - `Ctrl+Q` (customizable) from any application starts a note in `Quick Notes/YYYY-MM-DD.md`; all of a day's notes go in one file, each starting with the date and time
- **Sessions** - A Markdown document per meeting or idea, written live as you speak, in the folder you pick
- **Timestamped Paragraphs** - A pause in speech (5 seconds by default) starts a new paragraph with the time; Pause and Resume do the same
- **Paragraph Refinement** - Each finished paragraph is re-transcribed with your main model and replaced in the file, unless you have edited it; silent paragraphs are skipped with Silero VAD, so Whisper's invented "Thank you." never lands in your notes
- **Workspace** - Vault library with pinned Quick Notes, folder counts, recent documents and full-text search that jumps to the matching line; the document with its times in the margin; a details panel with each paragraph's refinement state
- **Light and Dark Themes** - Switch from the header; the window draws its own title bar
- **Keyboard Shortcuts** - Global shortcuts for Quick Notes (`Ctrl+Q`), Record (`Ctrl+Alt+R`), Pause/Resume (`Ctrl+Alt+P`) and Stop (`Ctrl+Alt+S`), all changeable in Settings
- **Mic Mute as Pause** - Muting the microphone (in Windows, with a hardware key, or with the mute button on the mic itself) pauses recording
- **Built-in Transcription Server** - Bundled whisper.cpp server, started and supervised by the app; no separate install
- **Speech Model Manager** - Download SHA256-verified GGML models from Hugging Face, or paste your own model link
- **GPU Acceleration** - Vulkan build works on NVIDIA, AMD and Intel GPUs, with automatic CPU fallback
- **Works Offline** - Nothing leaves your machine when using the built-in server
- **External API Support** - Point at OpenAI's Whisper API or a self-hosted server instead
- **System Tray Integration** - Runs from the system tray with recording and server status
- **Auto-Start on Login** - Launches minimized at Windows startup
- **Automatic Updates** - New releases download in the background; restart from the header or tray to install (never during a recording)

## System Requirements

- **Operating System:** Windows 10 or later (x64)
- **Runtime:** Node.js 24+ (for development only)
- **Microphone:** Working microphone with Windows permissions enabled
- **Disk Space:** 100 MB for the app, plus the speech model you choose (74 MB - 1.6 GB)
- **GPU (optional):** Any Vulkan-capable GPU for faster transcription; the app falls back to CPU automatically
- **Transcription:** The built-in server (default), or an OpenAI API key / compatible server

Audio recording uses SoX, which is bundled with the app. You do not need to install it.

### Choosing How Transcription Runs

You have three options:

#### Option 1: Built-in Server (Default, Recommended)

Transcription runs locally in a whisper.cpp server that ships with the app.

**Setup:**
1. Install and start the app
2. Click **Download recommended model** on the setup banner (or the model chip in the header, then Download)
3. Wait for the download, then press `Ctrl+Q` for a quick note or click **Record**

**Pros:**
- Complete privacy - audio never leaves your machine
- Works offline, no API keys, no usage costs
- GPU accelerated where available

**Cons:**
- A one-off model download (547 MB for the recommended model)
- Transcription speed depends on your hardware

#### Option 2: OpenAI Hosted Service

Use OpenAI's cloud-hosted Whisper API - no local model download required.

**Setup:**
1. Get an API key from [OpenAI Platform](https://platform.openai.com/api-keys)
2. Open Dark-Whisper Settings (gear icon)
3. Set **Transcription server** to **External API**, then configure:
   - **API Endpoint:** `https://api.openai.com/v1`
   - **API Token:** Your OpenAI API key (starts with `sk-`)
4. Start recording!

**Pros:**
- No local server setup required
- Always up-to-date with latest models
- Handles all compute requirements
- Works from anywhere

**Cons:**
- Requires internet connection
- Usage-based pricing (see [OpenAI Pricing](https://openai.com/api/pricing/))
- Audio sent to OpenAI servers

#### Option 3: Your Own Whisper API Server

Run a separate Whisper API server, for example [whisper-api](https://github.com/dniasoff/whisper-api/), and point the app at it. This is the setup existing users already have, and upgrades keep it.

**Setup:**
1. Download the latest installer from [whisper-api releases](https://github.com/dniasoff/whisper-api/releases)

2. Run the installer and follow the setup wizard

3. Start the API server (runs on `http://127.0.0.1:4444` by default)

4. In Settings, set **Transcription server** to **External API** and enter the URL

**Pros:**
- Share one server between machines or applications
- Use a server tuned differently from the bundled one

**Cons:**
- Requires separate setup and maintenance
- You manage updates

**Other Options:**
- Any OpenAI-compatible Whisper API server
- Self-hosted cloud instances

## Installation

### For End Users

1. Download the latest installer: `Dark-Whisper-Setup-<version>.exe`
2. Run the installer and follow the setup wizard
3. The application will appear in your system tray after installation
4. Open the window from the tray and click **Download recommended model** on the setup banner
5. Once the status line turns green (`Ready`), press `Ctrl+Q` anywhere for a quick note, or click **Record** for a session

To use OpenAI or your own server instead, switch **Transcription server** to **External API** in Settings (see the options above).

### For Developers

1. Clone the repository:
```bash
git clone https://github.com/TheGeek01/Dark-Whisper.git
cd Dark-Whisper
```

2. Install dependencies:
```bash
npm install
```

3. Fetch the whisper.cpp server for local runs (downloads the official CPU build pinned in `whisper.version`):
```bash
npm run whisper:fetch
```

4. Start in development mode:
```bash
npm run dev
```

5. Build for production:
```bash
npm run build
npm run build:windows
```

For a GPU (Vulkan) server build, set `WHISPER_SERVER_DIR` to a folder containing your own `whisper-server.exe`, or take the `whisper-server` artifact from a CI run (see [Releases and CI](#releases-and-ci)).

## Usage

### Basic Operation

1. The application runs in your system tray (bottom right corner); open the window from there
2. Press **`Ctrl+Q`** (or your configured shortcut) anywhere, or click **Quick Notes**, to start a quick note
3. Speak; the note appears in `Quick Notes/YYYY-MM-DD.md` in your vault as you talk
4. Press the shortcut again (or **Stop**) to finish

Each quick note starts with a line like `**2026-09-16 14:32**`. Pause (or a few seconds of silence) ends the paragraph; when you resume, a new one starts with the time, e.g. `**14:35**`. Every note made on one day goes into the same file, even one that runs past midnight. A quick note cannot start while a session records, and a session cannot start during a quick note.

### The Workspace

The window has three panes under a header:

- **Header** — status (Ready, Recording, Refining *n*, or a server problem with **Restart** and **Open log**), **Quick Notes**, the model chip (live → refine model; opens the Models dialog), **Record**, **Stop**, **Pause**, the theme switch and Settings.
- **Library** (left) — search (Ctrl+K or Ctrl+F): type to filter titles, press Enter (or pause) to search the text of every document, and click a result to jump to and highlight that line. **VAULT** lists your folders with document counts, **Quick Notes** always first. Click a folder to make it the target for new sessions. The ⋯ menu on a document renames, moves, opens it in your editor, shows it in Explorer or moves it to the Recycle Bin. **RECENT** lists the five documents changed last. **New Session** starts a session in the selected folder; the ••• menu at the bottom creates a folder, changes the vault or shows it in Explorer. Keyboard: ↑/↓, ←/→, Enter, F2 (rename), Delete.
- **Document** (centre) — the selected document, read-only, with each paragraph's time in the left margin. While it records, a level meter and a **Live** badge show at the top. The toolbar opens it in your editor, copies its path or text, changes the text size (**Aa**) and enters focus mode (Esc leaves). Edits you make elsewhere (Obsidian, VS Code) appear within a second.
- **Details** (right, collapsible) — **Session** or **Quick Note** (state, microphone, models, elapsed time, waiting to refine, folder, messages), **Blocks** (each paragraph's time and refinement state; click one to jump to it) and **Document** (created, path, duration, language, models). Each section folds away.

### Recording a Session

1. Select a folder in the library if the session belongs to a project (otherwise it goes to the vault root)
2. Click **Record** (or **New Session**) and speak. The new document opens in the centre and follows your words; scroll up to read back, and **Jump to live** to return
3. Click **Pause** to pause and **Resume** to carry on. Muting your microphone pauses as well; unmuting resumes
4. Click **Stop** when you are done. The document cannot be renamed, moved or deleted while it is recording

The live text comes from a small, fast model (`liveModelId`, `base.en` by default), which must be installed in the Models screen. Each paragraph ends at a pause in your speech (the app measures the microphone level; 5 seconds by default), on Pause, or after **Longest paragraph** minutes. When a paragraph ends, its audio is sent to the built-in server, which re-transcribes it with your main model and replaces the paragraph in the file, keeping its time line. The details panel's "Waiting to refine" count shows the queue, and each paragraph gets a state (pending / refining… / refined). An earlier recording keeps refining after you start a new one.

- **Your edits win.** A paragraph you changed is never overwritten. If another program (an editor, Obsidian) changes the file while you record, appending carries on, the paragraphs you edited are marked **skipped**, and every other paragraph is still refined.
- **Reload before you save.** An editor keeps its own copy of the file. The app keeps appending while you record, so accept your editor's "file changed, reload?" prompt before typing; saving an old copy overwrites the text written since.
- **Memory.** With **Refine during recording** on *Auto*, refinement waits until you stop when the live and main models together exceed 2 GB. *Always* refines while recording; *After stopping* always waits.
- **External API.** In External API mode, refinement is off unless you tick **Refine session blocks through this API**, because it would send your audio to that server.
- **Audio.** Recording audio is kept in `%APPDATA%\Dark-Whisper\sessions\<id>\` (about 115 MB per hour) and deleted once every paragraph is refined, unless **Keep session audio** is on. Audio left behind by a crash is reported in the log at the next start and left on disk.
- A document looks like this:

```markdown
---
title: untitled
created: 2026-09-16T10:06:12.958Z
duration: 245
liveModel: ggml-base.en.bin
refineModel: ggml-large-v3-turbo-q5_0.bin
...
---

<!-- dw:block 1 t=0-38 -->
**2026-09-16 10:06**
The refined text of the first paragraph.

<!-- dw:block 2 t=38-95 -->
**10:07**
...
```

The `<!-- dw:block … -->` markers and the time lines are how paragraphs are found again; leave them in place if you edit the file.

### Managing Speech Models

Click the model chip in the header, or **Models…** in the tray menu:

- **Download** a model from the list. `large-v3-turbo-q5_0` (547 MB) is recommended for GPUs; `small.en-q5_1` (181 MB) or `base.en` (141 MB) suit CPU-only machines.
- **Use** switches the active model; the server restarts and reloads.
- **Delete** removes a model from disk.
- **Custom model** accepts any Hugging Face `.bin` link of the form `https://huggingface.co/<owner>/<repo>/resolve/<revision>/<file>.bin`, for example a distil-whisper GGML build.

Downloads are verified against Hugging Face's SHA256 and checked for the GGML format before they are used. Models are stored in `%APPDATA%\Dark-Whisper\models\`.

### Configuring Settings

1. Click on the Dark-Whisper icon in the system tray
2. Click "Settings" (gear icon) in the application window
3. Configure the following options:
   - **Transcription server** - **Built-in** (bundled whisper.cpp) or **External API**
   - **Force CPU** - Built-in only; use if GPU transcription fails or misbehaves
   - **Skip silence when refining (VAD)** - Built-in only; removes paragraphs that contain no speech (default on)
   - **API Endpoint** - External only; URL where the Whisper API is running
   - **API Token** - External only; authentication token if your API requires one
   - **Update automatically** - Check for a new release at start-up and every 6 hours (default on). **Check for updates** checks now either way; a found update downloads in the background and installs when you restart from the header or tray, or on the next quit
   - **Shortcuts** - Global shortcuts for Quick Notes, Record / New Session, Pause / Resume and Stop. Click a box and press the keys (Esc cancels, Backspace clears to none). A shortcut needs Ctrl, Alt or Win unless it is an F-key; a box says so if another app already uses its keys
   - **Session microphone** - The microphone recordings use (the list fills in once a recording has started)
   - **Vault folder** - Where documents are written; pick it with **Choose folder…** (default `Documents\Dark-Whisper`, created automatically on first start if it doesn't exist yet). A custom folder you choose is never created for you — if it goes missing, the library shows "Vault not found" until you choose or recreate it.
   - **Live model** - The fast model for live text (default `ggml-base.en.bin`)
   - **Language** - Transcription language (default `en`)
   - **Longest paragraph (minutes)** - A paragraph closes after this long even without a pause (default 2)
   - **Refine during recording** - *Auto*, *Always* or *After stopping*
   - **Start a new paragraph after this many seconds of silence** - 1–60 (default 5)
   - **Keep session audio** - Keep the WAV files after refinement
   - **Refine session blocks through this API** - External API only

   The theme (dark or light) is switched with the moon/sun button in the header and remembered.

4. Settings are saved when you click Save. Changing server mode, Force CPU or the VAD setting restarts the server.

### Status Line

The header shows what is recording, or else what the transcription server is doing:

| Indicator | Meaning |
|-----------|---------|
| Red, pulsing - `Recording` / `Quick note` | Something is recording |
| Amber - `Paused` / `Refining 2` | Paused, or paragraphs still being refined |
| Grey - `No model installed` | Download a model to finish setup |
| Amber - `Loading model…` | The server is starting or reloading |
| Green - `Ready` | Ready; hover for the model, backend (GPU/CPU) and whether VAD is on |
| Red - `Server error: …` | With **Restart** and **Open log** buttons |
| Blue - `External API — <url>` | Using an external server |

### System Tray Menu

Right-click the Dark-Whisper icon in the system tray to:
- **Show/Hide** - Toggle the application window
- **Quick note, Record, Pause/Resume, Stop** - The same actions as the header buttons and shortcuts, with the shortcuts shown beside them
- **Models…** - Open the speech model manager
- **Exit** - Close the application

The tray tooltip mirrors the status line, or the session or quick note state while one is recording.

## How It Works

### Quick Note Flow

```
User presses Ctrl+Q
        ↓
Quick Notes/YYYY-MM-DD.md opened (created if missing);
  numbering continues after the paragraphs already in it
        ↓
Recording runs exactly like a session (below)
        ↓
User presses Ctrl+Q again → last paragraph queued for refinement
```

### Session Flow

```
Record (or a quick note)
        ↓
whisper-stream.exe (live model) listens to the microphone;
  SoX streams the same microphone to the app, which writes
  audio-<n>.wav and measures its level
        ↓
Each finished sentence → appended to the .md file
        ↓
A pause in speech (or Pause, or the length cap) → paragraph
  closed, its text hashed, a refinement job queued;
  the next words open a new paragraph with the time
        ↓
Paragraph audio sliced from the WAV → POSTed to whisper-server
  → paragraph replaced if its text still matches the hash
        ↓
Stop → final paragraph queued, duration written;
  audio deleted once the queue is empty
```

### Built-in Server Lifecycle

```
App starts
        ↓
Any leftover server from a previous crash is ended
        ↓
whisper-server.exe starts on a free localhost port,
  loading the selected model (Vulkan build first, CPU on fallback)
        ↓
App polls /health until the model is loaded → "Ready"
        ↓
Crash? Restarts after 1s, 5s, 15s, then reports an error
        ↓
App quits → server is stopped
```

### Technical Details

- **Sample Rate:** 16000 Hz (optimized for speech recognition, and what whisper.cpp expects)
- **Audio Format:** WAV/LPCM16 (PCM 16-bit mono)
- **Request Timeout:** 5 minutes with the built-in server, 30 seconds with an external API
- **Server Binding:** `127.0.0.1` only, on a port chosen at startup
- **Model Location:** `%APPDATA%\Dark-Whisper\models\`
- **VAD Model:** `ggml-silero-v6.2.0.bin` (Silero, 885 KB), bundled and copied to `%APPDATA%\Dark-Whisper\models\`
- **Server Log:** `%APPDATA%\Dark-Whisper\logs\whisper-server.log` (last 500 lines, per run)
- **Recording Audio:** `%APPDATA%\Dark-Whisper\sessions\<id>\` (32 kB/s while recording)
- **Live Engine Log:** `%APPDATA%\Dark-Whisper\logs\stream.log`
- **Settings Storage:** Local JSON in AppData (electron-store)

## Configuration

Settings are stored in the `%APPDATA%\Dark-Whisper\` directory. You can also manually edit the configuration by accessing:

```
C:\Users\[YourUsername]\AppData\Roaming\Dark-Whisper\
```

| Setting | Values | Notes |
|---------|--------|-------|
| `serverMode` | `builtin` / `external` | Fresh installs default to `builtin`; upgrades keep `external` |
| `modelId` | model file name | The active speech model |
| `forceCpu` | `true` / `false` | Skip the GPU build |
| `gpuFallbackVersion` | version string or `null` | Set when a GPU start failed, so CPU is used next time |
| `shortcut`, `recordShortcut`, `pauseShortcut`, `stopShortcut` | Electron accelerator, e.g. `Ctrl+Alt+R`; `""` for none | Quick Notes, Record, Pause/Resume and Stop; defaults `Ctrl+Q`, `Ctrl+Alt+R`, `Ctrl+Alt+P`, `Ctrl+Alt+S` |
| `apiUrl`, `apiToken` | | As shown in Settings |
| `vaultPath` | folder | Where documents go |
| `liveModelId` | model file name | Fast model for live text; default `ggml-base.en.bin` |
| `language` | language code | Default `en` |
| `refineDuringRecording` | `auto` / `always` / `afterStop` | Default `auto` |
| `refineWithExternalApi` | `true` / `false` | Default `false` |
| `refineVad` | `true` / `false` | Default `true` |
| `blockMinutes` | 1-30 | Default `2` |
| `silenceGapSeconds` | 1-60 | Seconds of silence that start a new paragraph; default `5` |
| `theme` | `dark` / `light` | Default `dark` |
| `autoUpdate` | `true` / `false` | Check for updates at start-up and every 6 hours; default `true` |
| `keepSessionAudio` | `true` / `false` | Default `false` |
| `captureDeviceName` | device name | Empty means the system default |

**Upgrading from Whisper Desktop:** at first start, Dark-Whisper moves `config.json`, `models`, `logs` and `recordings` from `%APPDATA%\whisper-desktop\` (or `%APPDATA%\Whisper Desktop\`) into `%APPDATA%\Dark-Whisper\`, so settings and downloaded models carry over.

### Transcription API Endpoints

Whether built-in or external, the app talks to the same two endpoints:

```
GET  /health or /v1/health           - Readiness / health check
POST /v1/audio/transcriptions        - Transcribe audio file
```

The built-in server is started with `--inference-path /v1/audio/transcriptions`, so the same request works either way.

### Example API Request

```bash
curl -X POST http://127.0.0.1:4444/v1/audio/transcriptions \
  -F "file=@recording.wav" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Troubleshooting

### Shortcut Not Working

- **Problem:** A shortcut does nothing
- **Solution:**
  - Open Settings: a shortcut another app already uses says "In use by another app" next to it. Pick different keys
  - Record does nothing while something is recording, and Pause and Stop do nothing when nothing is
  - Some keyboard layouts type characters with Ctrl+Alt (AltGr); if a Ctrl+Alt shortcut gets in the way of typing, change it

### No Audio Recorded

- **Problem:** Recording produces no audio or empty file
- **Solution:**
  - Verify microphone is connected and enabled
  - Check Windows Sound settings (Settings → Sound)
  - Test microphone in Windows Sound Recorder
  - Pick the right input in Settings → **Session microphone**
  - Restart the application

### Built-in Server Won't Start

- **Problem:** Status line is red (`Server error: …`)
- **Solution:**
  - Click **Open log** to see the server's own output (`%APPDATA%\Dark-Whisper\logs\whisper-server.log`)
  - `Model failed to load` usually means a damaged model file: delete it in the Models screen and download it again
  - Tick **Force CPU** in Settings if the GPU build crashes or your driver is unstable
  - Click **Restart** in the main window after changing anything

### Transcription Is Slow

- **Problem:** Paragraphs take a long time to be refined
- **Solution:**
  - Check whether the status line says `(CPU)` — the app falls back to CPU when no Vulkan GPU is found
  - Update your GPU driver (Vulkan support ships with it), then click **Restart**
  - Or switch to a smaller model: `small.en-q5_1` or `base.en` are much faster on CPU

### API Connection Fails

- **Problem:** Error connecting to Whisper API
- **Solution:**

  **If using OpenAI Hosted Service:**
  - Verify your API key is correct in Settings
  - Check that API endpoint is set to `https://api.openai.com/v1`
  - Ensure you have internet connectivity
  - Verify your OpenAI account has credits/active subscription
  - Test API key: `curl https://api.openai.com/v1/models -H "Authorization: Bearer YOUR_KEY"`

  **If using the Built-in Server:**
  - The error mentions the built-in server: click **Restart** in the main window
  - Check the status line is green (`Ready`)
  - Check the server log via **Open log**

  **If using an External API Server:**
  - Ensure your server is running (see [whisper-api](https://github.com/dniasoff/whisper-api/))
  - Verify API is running: `curl http://127.0.0.1:4444/v1/health`
  - Check API endpoint URL in Settings (default: `http://127.0.0.1:4444`)
  - Ensure no firewall is blocking port 4444
  - Check application logs (see Development below)

### Session Problems

- **"Live model … is not installed"** - download `base.en` (or whichever `liveModelId` you set) in the Models screen
- **No text appears** - check the session microphone in Settings; a microphone that is no longer present falls back to the default and says so in the session line. `%APPDATA%\Dark-Whisper\logs\stream.log` has the engine's output
- **A new paragraph started mid-sentence** - the live engine crashed and was restarted (the panel says so); the audio recording continued. Older documents show this as "recording interrupted and resumed"
- **"File changed outside the app — edited blocks won't be refined"** - another program changed the document while recording. Paragraphs you edited keep your text and are marked skipped; the rest are still refined. Reload the file in your editor before saving
- **Paragraphs split too often, or not at all** - change **Start a new paragraph after this many seconds of silence** in Settings. A very noisy room can hide pauses; the length cap still ends a paragraph
- **"Could not open today's quick note"** - something blocks `Quick Notes/YYYY-MM-DD.md` in the vault (for example a folder with that name, or a file another program has locked)
- **A paragraph disappeared** - its audio held no speech (the details panel shows "removed — no speech"). If real speech is being removed, untick **Skip silence when refining (VAD)** and report it
- **Paragraphs are never refined** - the built-in server must be `Ready`; in External API mode refinement is off unless enabled in Settings

### Microphone Permission Issues

- **Problem:** Windows says app doesn't have microphone access
- **Solution:**
  - Go to Settings → Privacy & Security → Microphone
  - Ensure Dark-Whisper is enabled
  - You may need to add the installed application path to the microphone access list

## Development

### Available Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run watch` | Watch and auto-compile TypeScript |
| `npm start` | Build and launch the application |
| `npm run dev` | Development mode with hot reload |
| `npm run lint` | Check code style with ESLint |
| `npm run lint:fix` | Fix linting issues automatically |
| `npm test` | Run Jest unit tests |
| `npm test:watch` | Run tests in watch mode |
| `npm test:coverage` | Generate code coverage report |
| `npm run whisper:fetch` | Download the pinned whisper.cpp CPU server and `whisper-stream` into `resources/whisper/cpu` |
| `npm run stream:probe -- <model> [capture id]` | Run the live engine alone and print what it hears |
| `npm run build:renderer` | Compile the window code and copy marked/DOMPurify |
| `npm run smoke:workspace` | End-to-end check of the workspace in a throwaway vault |
| `npm run build:windows` | Build Windows NSIS installer |

### Project Structure

```
Dark-Whisper/
├── src/
│   ├── appIdentity.ts             # App name and user-data migration (imported first)
│   ├── main.ts                    # Electron main process, lifecycle, tray, IPC
│   ├── preload.ts                 # Secure IPC bridge
│   ├── shared/api.ts              # Types shared by main, preload and renderer
│   ├── shared/shortcuts.ts        # Shortcut defaults and key rules (main and Settings)
│   ├── renderer/                  # Window code (ES modules → public/js)
│   │   ├── app.ts, state.ts       # Entry point and app state
│   │   ├── header.ts, library.ts, document.ts, sessionPanel.ts, dialogs.ts, theme.ts, levelMeter.ts
│   │   └── format.ts, libraryTree.ts, documentView.ts, sessionModel.ts, headerModel.ts   # DOM-free, tested
│   ├── services/
│   │   ├── shortcutRegistry.ts    # Registers the global shortcuts, reports conflicts
│   │   ├── updateService.ts       # Update checks, download state, restart rules
│   │   ├── updateRuntime.ts       # electron-updater wiring for the above
│   │   ├── soxPath.ts             # Bundled SoX location
│   │   ├── apiService.ts          # Transcription HTTP client
│   │   ├── settingsService.ts     # Settings persistence (electron-store)
│   │   ├── settingsMigration.ts   # Setting defaults and clamping
│   │   ├── modelCatalog.ts        # Curated model list, URL and GGML validation
│   │   ├── modelManager.ts        # Model download, verify, list, delete
│   │   ├── vadModel.ts            # The pinned Silero VAD model: verify and install
│   │   ├── whisperServer.ts       # Server supervisor state machine
│   │   ├── serverOutput.ts        # Server log parsing, restart backoff
│   │   ├── serverPaths.ts         # Server binary resolution
│   │   ├── serverGate.ts          # Recording gate and status text
│   │   ├── whisperRuntime.ts      # Electron/Node wiring for the above
│   │   ├── userDataMigration.ts   # Which legacy user-data entries to move
│   │   ├── streamOutput.ts        # whisper-stream output parsing
│   │   ├── streamEngine.ts        # Live engine supervisor
│   │   ├── streamRuntime.ts       # Live engine and SoX recording wiring
│   │   ├── pcmFileSink.ts         # Writes SoX's raw audio to a WAV
│   │   ├── audioLevel.ts          # Audio level and the silence rule for paragraphs
│   │   ├── windowTheme.ts         # Title bar colours per theme
│   │   ├── sessionPaths.ts        # Session ids and audio file names
│   │   ├── documentStore.ts       # Vault Markdown files: append, blocks, hash guard, search
│   │   ├── guardedStore.ts        # Detects outside edits between the app's own writes
│   │   ├── guardRegistry.ts       # One guard per document, shared between recordings
│   │   ├── quickNotes.ts          # The daily quick-note file; start rules
│   │   ├── blockMath.ts           # Audio time ranges → WAV byte ranges
│   │   ├── sessionService.ts      # One recording: segments → paragraphs, jobs
│   │   ├── blockRefiner.ts        # Refinement queue and memory guard
│   │   ├── micMuteOutput.ts       # Core Audio mute shim and its output
│   │   ├── micMuteService.ts      # Microphone mute polling
│   │   ├── sessionRuntime.ts      # Electron/Node wiring for sessions
│   │   ├── libraryService.ts      # Vault tree, search, moves, path guard
│   │   ├── libraryWatch.ts        # Change batching, polling diff
│   │   └── libraryRuntime.ts      # Library IPC and vault watcher
│   └── __tests__/                 # Unit tests
├── public/
│   └── index.html, app.css        # Workspace markup, dark and light themes
├── assets/
│   ├── icon.svg, icon-16.svg, icon-24.svg   # Icon sources (npm run icon:build)
│   └── dark-whisper.ico           # Application icon (generated from the SVGs)
├── scripts/
│   ├── fetch-whisper.js           # Dev: download pinned whisper.cpp CPU binaries
│   ├── stream-probe.js            # Dev: run the live engine alone
│   ├── dev-cdp.mjs                # Dev: evaluate in a running instance
│   └── workspace-smoke.mjs        # End-to-end workspace checks
├── resources/whisper/             # Server binaries (generated, gitignored)
├── docs/superpowers/              # Design spec and implementation plan
├── dist/                          # Compiled JavaScript (generated)
├── whisper.version                # Pinned whisper.cpp build tag
├── whisper-vad.json               # Pinned Silero VAD model
├── electron-builder.yml           # Packaging and publishing config
├── package.json                   # Dependencies and scripts
├── tsconfig.json                  # TypeScript configuration
└── README.md                      # This file
```

The `services` layer is deliberately split: the `*Runtime.ts` modules (and the settings and SoX path services) touch Electron; everything else is free of Electron imports, so it can be unit-tested directly.

### Technology Stack

- **Framework:** Electron 44.4.0
- **Language:** TypeScript 6.0.3
- **Transcription:** whisper.cpp `b5130` (CPU and Vulkan builds)
- **HTTP Client:** Axios 1.20.0
- **Audio Recording:** node-mic 1.0.1 (bundled SoX)
- **Settings Storage:** electron-store 11.0.2
- **Build Tool:** electron-builder 26.15.3
- **Testing:** Jest 30.5.1 with ts-jest
- **Code Quality:** ESLint 10 with typescript-eslint

### Releases and CI

`.github/workflows/publish.yml` runs on a `v*.*.*` tag:

1. **Lint** and **Test** on Ubuntu.
2. **Build whisper.cpp server** on Windows: installs the pinned Vulkan SDK and SDL2, compiles `whisper-server` and `whisper-stream` twice (CPU and Vulkan) from the tag in `whisper.version`, transcribes a sample clip as a smoke test, fetches and checks the pinned Silero VAD model, checks that the VAD server returns nothing for silence, and uploads the binaries as an artifact. Results are cached per whisper.cpp, SDK and SDL2 version.
3. **Build and Release**: downloads that artifact into `resources/whisper/`, builds the NSIS installer, and publishes a GitHub Release with the installer, its `.blockmap` and `latest.yml`. Installed apps update from `latest.yml` of the newest published (not draft) release, so keep those three assets on every release.

To cut a release: `git tag v1.2.0 && git push origin v1.2.0`.

When bumping `whisper.version`, re-check the server's stderr strings in `serverOutput.ts` (`classifyServerLine`) and whisper-stream's output in `streamOutput.ts` — both supervisors recognise messages by text.

### Security

The application implements several security measures:

- **Context Isolation** - Renderer process cannot directly access Node.js APIs
- **Preload Bridge** - Only whitelisted IPC commands are exposed to renderer
- **No nodeIntegration** - Node.js APIs not available in renderer process
- **IPC Type Safety** - Defined interfaces for all inter-process communication
- **Restricted File Access** - File system access limited to userData directory
- **Model Download Verification** - Curated models are pinned to SHA256 hashes; custom links must be `https://huggingface.co/...` and every download is checked for the GGML format before use
- **Model Path Validation** - Model identifiers are re-validated in the main process, so the renderer cannot reach outside the models directory
- **Localhost-only Server** - The built-in server binds `127.0.0.1` and is never started with ffmpeg conversion enabled
- **Sanitised documents** - Markdown is rendered with marked and cleaned with DOMPurify; a locked-down Content-Security-Policy (`default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; font-src 'none'; media-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`) blocks scripts and any remote or UNC (`//host/share`) image reference in a note, and links open in your browser, never in the app window

Note: the built-in server has no authentication, so other programs running as you on the same machine could use it while the app is open. That is the normal trade-off for a single-user desktop app.

### Building the Installer

To create a Windows installer:

```bash
npm run build:windows
```

The installer will be created in the `release/` directory as `Dark-Whisper-Setup-<version>.exe`.

**Note:** Building requires Windows and administrative privileges for the NSIS installer creation.

### Development Debugging

To view debug output and logs:

1. Open DevTools: Press `Ctrl+Shift+I` in the app window
2. Check the Console tab for application logs
3. Monitor the Network tab to see API calls

## Performance Considerations

- **Memory Usage:** 80-150MB for the app, plus the model held by the server while it runs (roughly 0.6-1.8 GB depending on the model)
- **CPU:** Minimal except during recording and transcription; CPU transcription is the heavy case
- **Storage:** Recording audio is deleted once refined; models stay until you delete them
- **Startup:** The server loads the model once at launch, so the first refinement is not slower than the rest

## Limitations

- **Windows Only:** Currently supports Windows 10 and later (x64) only
- **One Server at a Time:** Either the built-in server or a single external endpoint
- **One Recording at a Time:** A quick note is refused while a session records, and the other way round
- **Audio Quality:** Dependent on microphone and system audio capture
- **Internet Required:** For model downloads, and when using OpenAI's hosted service
- **GPU Support:** Vulkan only; there is no CUDA-specific build

## Future Enhancements

Potential features for future releases:

- [ ] Multi-language support in the UI
- [ ] Recording history and replay
- [ ] Batch transcription
- [ ] macOS and Linux support
- [ ] Model choice per language

## Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

Please ensure:
- Code follows ESLint rules (`npm run lint:fix`)
- Tests pass (`npm test`)
- TypeScript has no errors (`npm run build`)
- New logic lives in an Electron-free module under `src/services/` where possible, so it can be unit-tested (see [DEVELOPMENT.md](DEVELOPMENT.md))

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

**MIT License Summary:**
- ✅ Commercial use
- ✅ Modification
- ✅ Distribution
- ✅ Private use
- ⚠️ License and copyright notice required
- ❌ Liability
- ❌ Warranty

## Support

For issues, feature requests, or questions:

1. **GitHub Issues:** https://github.com/TheGeek01/Dark-Whisper/issues
2. **Email:** ghostline@blackhaven-dynamics.net

When reporting a transcription problem, please include the status line text and, if the server errored, the contents of `%APPDATA%\Dark-Whisper\logs\whisper-server.log` (and `stream.log` for session problems).

## Acknowledgments

- Built with [Electron](https://www.electronjs.org/)
- Speech recognition powered by [OpenAI's Whisper](https://github.com/openai/whisper)
- Local inference by [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT)
- Models hosted by [ggerganov/whisper.cpp on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp)
- Audio processing with [SoX](http://sox.sourceforge.net/)
- Forked from [dniasoff/whisper-desktop](https://github.com/dniasoff/whisper-desktop)
- Alternative external API: [whisper-api](https://github.com/dniasoff/whisper-api/)

## Changelog

### Version 1.5.1 (Latest)

- Refining a paragraph whose audio holds no speech no longer reports "Refinement failed … Invalid response from API". An empty transcription is read as silence heard, so the paragraph is removed when VAD is on and its live text is kept when it is off.

### Version 1.5.0

- Automatic updates: the app checks GitHub at start-up and every 6 hours, downloads a new version in the background, and offers **Update … — Restart** in the header and tray. Settings has **Update automatically** and **Check for updates**.
- Pause mutes the microphone the recording uses (Settings → Session microphone), not the Windows default one.
- The tray menu has Record, Pause/Resume and Stop, with their shortcuts.

### Version 1.4.0

- Global shortcuts for Record (Ctrl+Alt+R), Pause/Resume (Ctrl+Alt+P) and Stop (Ctrl+Alt+S) next to Quick Notes (Ctrl+Q); set them in Settings by pressing the keys.
- After unmuting, pauses start new paragraphs again straight away (the room's noise level was misjudged for 30 seconds).
- Renaming a note to a name that differs only in letter case no longer adds "-2".
- Large vaults no longer make the app stall while the library is scanned or searched.
- A recording that is still refining keeps showing its paragraph states after the next one starts.

### Version 1.3.0

- Quick notes: Ctrl+Q (or Quick Notes in the header) records into one file per day in the Quick Notes folder, with a date and time at the start of each note.
- Recordings are split into paragraphs after 5 seconds of silence (adjustable), each with its time in the margin. Each paragraph is refined on its own.
- New look: a header with Record, Stop and Pause, a sidebar with pinned Quick Notes, folder counts and recent documents, a collapsible details panel, and a light theme.
- Muting a microphone with its own mute button (which Windows does not see) now pauses recording too; unmuting resumes.
- Silent paragraphs are skipped: the built-in server uses Silero VAD, so "Thank you." and similar invented text no longer appear.
- Search results now jump to the matching line.
- Font size and focus mode for reading.
- An earlier recording keeps refining after a new one starts.
- Removed: paste-into-any-app dictation.

### Version 1.2.1

- Editing the document in another editor during a session no longer stops refinement: only the blocks you edited are skipped
- A file a sync client briefly locks is no longer mistaken for an outside edit
- Session audio is deleted after the recorder releases it (it could be left behind on Windows)

### Version 1.2.0

- Three-pane workspace: vault library with folders and search, live document view, session panel with per-block refinement state; quick dictation moves to the header
- Documents are sanitised and a strict Content-Security-Policy blocks scripts and remote or network (UNC) images
- The default vault folder is created on first start
- Renamed to Dark-Whisper; user data moves to `%APPDATA%\Dark-Whisper` on first start
- Live sessions: whisper-stream writes a Markdown document in a vault folder as you speak
- Completed blocks are re-transcribed with the main model, and never overwrite your edits
- Microphone mute pauses a session; the hotkey pauses and resumes it
- New settings for the vault, live model, language, block length, refinement, headings and session audio

### Version 1.1.0

- Built-in whisper.cpp transcription server, bundled and supervised by the app
- Speech model manager: SHA256-verified downloads from Hugging Face, plus custom model links
- GPU (Vulkan) transcription with automatic CPU fallback, and a Force CPU setting
- Server status line with Restart and Open log, and a setup banner for first run
- Settings gained a Built-in / External API choice; existing installs keep their external API
- Upgraded to Electron 44, TypeScript 6 and ESLint 10; replaced nut-js with libnut, clearing all npm audit findings
- CI builds the CPU and Vulkan servers and attaches the installer to a GitHub Release

### Version 1.0.0

- Initial release
- Global hotkey recording with customizable shortcut
- Automatic transcription with Whisper API
- Auto-paste to active window
- System tray integration
- Configurable settings (hotkey, API endpoint, token)
- Auto-start on Windows login
- Real-time recording status display
- Automatic recording cleanup

---

**Made with ❤️ for faster note-taking and transcription**

