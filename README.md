# Whisper Desktop

A lightweight Windows desktop application that lets you record audio and transcribe it to text with a single keyboard shortcut. The transcribed text is automatically pasted into the active application.

Transcription runs on a **built-in [whisper.cpp](https://github.com/ggml-org/whisper.cpp) server** that ships with the app, so a fresh install needs nothing else: pick a speech model, and dictation works offline. You can still point the app at OpenAI's Whisper API or any other compatible server instead.

## Features

- **Built-in Transcription Server** - Bundled whisper.cpp server, started and supervised by the app; no separate install
- **Speech Model Manager** - Download SHA256-verified GGML models from Hugging Face, or paste your own model link
- **GPU Acceleration** - Vulkan build works on NVIDIA, AMD and Intel GPUs, with automatic CPU fallback
- **Global Hotkey Recording** - Press `Ctrl+Q` (customizable) from any application to start and stop recording
- **Auto-Paste** - Transcribed text is automatically copied to clipboard and pasted into the active window
- **Clipboard Preservation** - Original clipboard contents are restored after pasting
- **Works Offline** - Nothing leaves your machine when using the built-in server
- **External API Support** - Point at OpenAI's Whisper API or a self-hosted server instead
- **System Tray Integration** - Minimizes to system tray with real-time recording and server status
- **Configurable Settings** - Keyboard shortcut, microphone, auto-mute, server mode, API endpoint and token
- **Auto-Mute** - Silences system audio while recording, then restores it
- **Auto-Start on Login** - Launches minimized at Windows startup
- **Error Notifications** - System notifications for recording events and errors
- **Auto Cleanup** - Automatically deletes recordings older than 7 days

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
2. Click **Download recommended model** on the setup banner (or the 🧠 button, then Download)
3. Wait for the download, then dictate with `Ctrl+Q`

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
2. Open Whisper Desktop Settings (gear icon)
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

1. Download the latest installer: `Whisper Desktop.exe`
2. Run the installer and follow the setup wizard
3. The application will appear in your system tray after installation
4. Open the window from the tray and click **Download recommended model** on the setup banner
5. Once the status line turns green (`Ready`), press `Ctrl+Q` anywhere to dictate

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

1. The application runs in your system tray (bottom right corner)
2. Press **`Ctrl+Q`** (or your configured shortcut) anywhere to start recording
3. Speak clearly into your microphone
4. Press the shortcut again to stop (recording also stops automatically after 5 minutes)
5. Transcribed text appears in the app and is automatically pasted to the active application

If the built-in server is not ready, the hotkey does not record. Instead the app tells you why: no model installed (the Models screen opens), the model is still loading, or the server hit an error.

### Managing Speech Models

Click the 🧠 button in the window, or **Models…** in the tray menu:

- **Download** a model from the list. `large-v3-turbo-q5_0` (547 MB) is recommended for GPUs; `small.en-q5_1` (181 MB) or `base.en` (141 MB) suit CPU-only machines.
- **Use** switches the active model; the server restarts and reloads.
- **Delete** removes a model from disk.
- **Custom model** accepts any Hugging Face `.bin` link of the form `https://huggingface.co/<owner>/<repo>/resolve/<revision>/<file>.bin`, for example a distil-whisper GGML build.

Downloads are verified against Hugging Face's SHA256 and checked for the GGML format before they are used. Models are stored in `%APPDATA%\whisper-desktop\models\`.

### Configuring Settings

1. Click on the Whisper Desktop icon in the system tray
2. Click "Settings" (gear icon) in the application window
3. Configure the following options:
   - **Transcription server** - **Built-in** (bundled whisper.cpp) or **External API**
   - **Force CPU** - Built-in only; use if GPU transcription fails or misbehaves
   - **API Endpoint** - External only; URL where the Whisper API is running
   - **API Token** - External only; authentication token if your API requires one
   - **Keyboard Shortcut** - Change the hotkey (e.g., `Alt+R`, `F9`, etc.)
   - **Microphone Device** - Choose which input device records
   - **Auto-mute system audio** - Silence other audio while recording

4. Settings are saved when you click Save. Changing server mode or Force CPU restarts the server.

### Status Line

The main window shows what the transcription server is doing:

| Indicator | Meaning |
|-----------|---------|
| Grey - `No model installed` | Download a model to finish setup |
| Amber - `Loading model…` | The server is starting or reloading |
| Green - `Ready — <model> (GPU/CPU)` | Ready to dictate, and which backend is in use |
| Red - `Server error: …` | With **Restart** and **Open log** buttons |
| Blue - `External API — <url>` | Using an external server |

### System Tray Menu

Right-click the Whisper Desktop icon in the system tray to:
- **Show/Hide** - Toggle the application window
- **Models…** - Open the speech model manager
- **Recording Status** - View current recording status
- **Exit** - Close the application

The tray tooltip mirrors the status line.

## How It Works

### Recording Flow

```
User presses Ctrl+Q
        ↓
Audio recording starts (SoX, 16 kHz mono WAV)
        ↓
User presses Ctrl+Q again (or 5 minute limit)
        ↓
Audio file POSTed to the transcription server
  (built-in whisper.cpp, or your external API)
        ↓
Transcribed text received
        ↓
Text automatically pasted to active window
        ↓
Recording cleaned up
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
- **Maximum Recording:** 5 minutes per recording
- **Request Timeout:** 5 minutes with the built-in server, 30 seconds with an external API
- **Server Binding:** `127.0.0.1` only, on a port chosen at startup
- **Storage Location:** `%APPDATA%\whisper-desktop\recordings\`
- **Model Location:** `%APPDATA%\whisper-desktop\models\`
- **Server Log:** `%APPDATA%\whisper-desktop\logs\whisper-server.log` (last 500 lines, per run)
- **Settings Storage:** Local JSON in AppData (electron-store)

## Configuration

Settings are stored in `%APPDATA%\whisper-desktop\` directory. You can also manually edit the configuration by accessing:

```
C:\Users\[YourUsername]\AppData\Roaming\whisper-desktop\
```

| Setting | Values | Notes |
|---------|--------|-------|
| `serverMode` | `builtin` / `external` | Fresh installs default to `builtin`; upgrades keep `external` |
| `modelId` | model file name | The active speech model |
| `forceCpu` | `true` / `false` | Skip the GPU build |
| `gpuFallbackVersion` | version string or `null` | Set when a GPU start failed, so CPU is used next time |
| `shortcut`, `micDevice`, `autoMuteAudio`, `apiUrl`, `apiToken` | | As shown in Settings |

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

### Hotkey Not Working

- **Problem:** Keyboard shortcut doesn't trigger recording
- **Solution:**
  - Check for keyboard shortcut conflicts with other applications
  - Verify the shortcut is set correctly in Settings
  - Restart the application
  - Ensure Windows allows the application permission to use global hotkeys

### No Audio Recorded

- **Problem:** Recording produces no audio or empty file
- **Solution:**
  - Verify microphone is connected and enabled
  - Check Windows Sound settings (Settings → Sound)
  - Test microphone in Windows Sound Recorder
  - Pick the right input in Settings → **Microphone Device**
  - Restart the application

### Built-in Server Won't Start

- **Problem:** Status line is red (`Server error: …`)
- **Solution:**
  - Click **Open log** to see the server's own output (`%APPDATA%\whisper-desktop\logs\whisper-server.log`)
  - `Model failed to load` usually means a damaged model file: delete it in the Models screen and download it again
  - Tick **Force CPU** in Settings if the GPU build crashes or your driver is unstable
  - Click **Restart** in the main window after changing anything

### Transcription Is Slow

- **Problem:** Dictation takes many seconds to come back
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
  - Check the status line is green (`Ready`) before dictating
  - Check the server log via **Open log**

  **If using an External API Server:**
  - Ensure your server is running (see [whisper-api](https://github.com/dniasoff/whisper-api/))
  - Verify API is running: `curl http://127.0.0.1:4444/v1/health`
  - Check API endpoint URL in Settings (default: `http://127.0.0.1:4444`)
  - Ensure no firewall is blocking port 4444
  - Check application logs (see Development below)

### Text Not Pasting

- **Problem:** Transcribed text doesn't appear in active window
- **Solution:**
  - Click on the target application window to give it focus
  - Ensure application supports text input
  - Try pasting manually (Ctrl+V) to verify clipboard works
  - Some applications may have restrictions on automated pasting
  - Restart the application

### Microphone Permission Issues

- **Problem:** Windows says app doesn't have microphone access
- **Solution:**
  - Go to Settings → Privacy & Security → Microphone
  - Ensure Whisper Desktop is enabled
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
| `npm run whisper:fetch` | Download the pinned whisper.cpp CPU server into `resources/whisper/cpu` |
| `npm run build:windows` | Build Windows NSIS installer |

### Project Structure

```
Dark-Whisper/
├── src/
│   ├── main.ts                    # Electron main process, lifecycle, tray, IPC
│   ├── preload.ts                 # Secure IPC bridge
│   ├── services/
│   │   ├── hotkeyService.ts       # Global keyboard shortcut handling
│   │   ├── recordingService.ts    # SoX recording and device enumeration
│   │   ├── audioControlService.ts # System audio mute/restore
│   │   ├── pasteService.ts        # Clipboard write and Ctrl+V injection
│   │   ├── apiService.ts          # Transcription HTTP client
│   │   ├── settingsService.ts     # Settings persistence (electron-store)
│   │   ├── settingsMigration.ts   # Server-mode default for new vs existing installs
│   │   ├── modelCatalog.ts        # Curated model list, URL and GGML validation
│   │   ├── modelManager.ts        # Model download, verify, list, delete
│   │   ├── whisperServer.ts       # Server supervisor state machine
│   │   ├── serverOutput.ts        # Server log parsing, restart backoff
│   │   ├── serverPaths.ts         # Server binary resolution
│   │   ├── serverGate.ts          # Recording gate and status text
│   │   └── whisperRuntime.ts      # Electron/Node wiring for the above
│   └── __tests__/                 # Unit tests (123 tests, 11 suites)
├── public/
│   └── index.html                 # UI (status, settings, models)
├── assets/
│   └── whisper.ico                # Application icon
├── scripts/
│   └── fetch-whisper.js           # Dev: download pinned whisper.cpp CPU server
├── resources/whisper/             # Server binaries (generated, gitignored)
├── docs/superpowers/              # Design spec and implementation plan
├── dist/                          # Compiled JavaScript (generated)
├── whisper.version                # Pinned whisper.cpp build tag
├── electron-builder.yml           # Packaging and publishing config
├── package.json                   # Dependencies and scripts
├── tsconfig.json                  # TypeScript configuration
└── README.md                      # This file
```

The `services` layer is deliberately split: everything except `whisperRuntime.ts` is free of Electron imports, so it can be unit-tested directly.

### Technology Stack

- **Framework:** Electron 44.4.0
- **Language:** TypeScript 6.0.3
- **Transcription:** whisper.cpp `b5130` (CPU and Vulkan builds)
- **HTTP Client:** Axios 1.20.0
- **Audio Recording:** node-mic 1.0.1 (bundled SoX)
- **Keystroke Injection:** @nut-tree-fork/libnut 4.2.6
- **Settings Storage:** electron-store 11.0.2
- **Build Tool:** electron-builder 26.15.3
- **Testing:** Jest 30.5.1 with ts-jest
- **Code Quality:** ESLint 10 with typescript-eslint

### Releases and CI

`.github/workflows/publish.yml` runs on a `v*.*.*` tag:

1. **Lint** and **Test** on Ubuntu.
2. **Build whisper.cpp server** on Windows: installs the pinned Vulkan SDK, compiles `whisper-server` twice (CPU and Vulkan) from the tag in `whisper.version`, transcribes a sample clip as a smoke test, and uploads the binaries as an artifact. Results are cached per whisper.cpp and SDK version.
3. **Build and Release**: downloads that artifact into `resources/whisper/`, builds the NSIS installer, and publishes a GitHub Release.

To cut a release: `git tag v1.2.0 && git push origin v1.2.0`.

When bumping `whisper.version`, re-check the server's stderr strings in `serverOutput.ts` (`classifyServerLine`) — the supervisor recognises model-load and GPU messages by text.

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

Note: the built-in server has no authentication, so other programs running as you on the same machine could use it while the app is open. That is the normal trade-off for a single-user desktop app.

### Building the Installer

To create a Windows installer:

```bash
npm run build:windows
```

The installer will be created in the `dist/` directory as `Whisper Desktop.exe`.

**Note:** Building requires Windows and administrative privileges for the NSIS installer creation.

### Development Debugging

To view debug output and logs:

1. Open DevTools: Press `Ctrl+Shift+I` in the app window
2. Check the Console tab for application logs
3. Monitor the Network tab to see API calls

## Performance Considerations

- **Memory Usage:** 80-150MB for the app, plus the model held by the server while it runs (roughly 0.6-1.8 GB depending on the model)
- **CPU:** Minimal except during recording and transcription; CPU transcription is the heavy case
- **Storage:** Recordings are temporary and auto-deleted after 7 days; models stay until you delete them
- **Startup:** The server loads the model once at launch, so the first dictation is not slower than the rest

## Limitations

- **Windows Only:** Currently supports Windows 10 and later (x64) only
- **One Server at a Time:** Either the built-in server or a single external endpoint
- **Manual Text Injection:** Uses system clipboard and Ctrl+V for pasting (some applications may not support this)
- **Audio Quality:** Dependent on microphone and system audio capture
- **Internet Required:** For model downloads, and when using OpenAI's hosted service
- **GPU Support:** Vulkan only; there is no CUDA-specific build

## Future Enhancements

Potential features for future releases:

- [ ] Multi-language support in UI (transcription language is currently fixed to English)
- [ ] Dark mode theme
- [ ] Recording history and replay
- [ ] Custom hotkey profiles
- [ ] Batch transcription
- [ ] macOS and Linux support
- [ ] Voice activity detection / silence auto-stop
- [ ] Model choice per language, and language selection in Settings
- [ ] Auto-update (electron-updater)

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

When reporting a transcription problem, please include the status line text and, if the server errored, the contents of `%APPDATA%\whisper-desktop\logs\whisper-server.log`.

## Acknowledgments

- Built with [Electron](https://www.electronjs.org/)
- Speech recognition powered by [OpenAI's Whisper](https://github.com/openai/whisper)
- Local inference by [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT)
- Models hosted by [ggerganov/whisper.cpp on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp)
- Audio processing with [SoX](http://sox.sourceforge.net/)
- Keystroke injection with [libnut](https://github.com/nut-tree/libnut-core)
- Forked from [dniasoff/whisper-desktop](https://github.com/dniasoff/whisper-desktop)
- Alternative external API: [whisper-api](https://github.com/dniasoff/whisper-api/)

## Changelog

### Version 1.1.0 (Latest)

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

