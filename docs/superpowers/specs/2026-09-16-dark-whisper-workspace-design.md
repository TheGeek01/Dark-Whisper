# Dark-Whisper: Three-Pane Workspace — Design

**Date:** 2026-09-16
**Status:** Draft for review
**Stage:** 2 of 2. Builds on `2026-09-15-dark-whisper-live-sessions-design.md` (stage 1: engine, vault, refinement). This stage replaces the temporary session strip and the single-column window with a workspace.

## 1. Goal

Stage 1 writes a Markdown document as you speak, but the window only shows a scrolling text box. This stage turns the window into a workspace: a library of every session in the vault, a readable view of the selected document that follows a live session, and a panel that shows what the session and its refinement are doing.

**Success criteria**
- Every document in the vault is reachable from the library within two clicks, and search finds text in any of them.
- During a session, its document is shown automatically, new text appears within ~2 s, and each block's refinement state is visible.
- An edit made in Obsidian (or any editor) shows up in the app within a second, without a restart.
- Quick dictation keeps working, from the hotkey and from the header.
- A vault of 500 documents opens and searches without a noticeable pause (< 1 s).

**Non-goals**
- Editing documents inside the app. The document view is read-only; "Open in editor" hands the file to the user's own editor.
- Tags, export to other formats, speaker labels, drag-and-drop, a light theme.

## 2. Decisions

| Topic | Decision |
|---|---|
| Editing | Read-only view; Rename, Move, Delete, Open in editor, Reveal in Explorer |
| Right pane | Session details: state, duration, microphone, mute, models, per-block refinement state, messages; the selected document's frontmatter when no session runs |
| Library | Folder tree (folders are projects), newest first, search box; create folders; move documents via a menu |
| New sessions | Written to the folder selected in the library, else the vault root |
| Quick dictation | Lives in a compact header bar alongside server status and session controls |
| Renderer stack | Vanilla TypeScript compiled to ES modules; no framework, no bundler |
| Markdown | `marked` rendering, `DOMPurify` sanitising |
| Delete | Moves to the Recycle Bin (`shell.trashItem`) |
| Theme | One dark theme; the Models and Settings dialogs are restyled to match |

## 3. Layout

Default window 1200×760, minimum 900×560, still starting hidden in the tray.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Dark-Whisper ● Ready — large-v3-turbo (GPU) │ 🎤 Dictate  "last text…" ⧉ │
│                         [● Start session] [⏸] [■]   🧠  ⚙️              │
├───────────────┬──────────────────────────────────────┬───────────────┤
│ 🔍 search     │  2026-09-16-0706-untitled   ✎ ⧉ ↗   │ Session       │
│ ▾ Vault       │  ────────────────────────────────    │ recording 4:12│
│   ▸ Clients   │  Block 1  ✓ refined                  │ mic: TONOR    │
│   ▾ Notes     │  The refined text of the first…      │ muted: no     │
│     today …   │                                      │ live base.en  │
│   2026-09-16… │  Block 2  ⟳ refining                 │ refine turbo  │
│   2026-09-15… │  …                                   │ Blocks        │
│ [+ folder]    │  Block 3  (live) ▌                   │ 1 ✓ 2 ⟳ 3 …   │
│               │                                      │ Messages      │
└───────────────┴──────────────────────────────────────┴───────────────┘
```

### 3.1 Header
- Server status dot and text (today's status line).
- Quick dictation: a **Dictate** button (start/stop), its state (idle / recording / transcribing), the last transcription truncated to one line, and **Copy**.
- Session controls: **Start session** when idle; **Pause/Resume** and **Stop** while a session runs. Start is disabled while quick dictation records, and Dictate is disabled while a session runs, matching the main-process rules.
- **Models** (🧠) and **Settings** (⚙️) open the existing dialogs.

### 3.2 Library (left, 260 px)
- A search box. Typing filters document titles immediately; pressing Enter (or pausing 300 ms with 2+ characters) runs a full-text search, and the results replace the tree until the box is cleared. A result shows the document title and the matching line; clicking it opens the document and scrolls to the line.
- The folder tree: the vault root, then folders alphabetically, then documents newest first (by `created`, falling back to file modification time). Folders remember their expanded state for the session.
- A document row shows its title and date; the recording document has a red dot.
- The row menu (⋯ or right-click): **Rename…**, **Move to…** (a folder picker listing vault folders), **Open in editor**, **Reveal in Explorer**, **Delete** (confirmation, then Recycle Bin).
- **+ folder** creates a folder inside the selected folder (or the root).
- Selecting a folder makes it the target for the next session.
- Keyboard: ↑/↓ move the selection, ←/→ collapse/expand, Enter opens, F2 renames, Delete deletes (with confirmation), Ctrl+F focuses search.

### 3.3 Document (centre)
- A title bar: the title, **Rename** (✎), **Copy all** (⧉, the body without frontmatter or block markers), **Open in editor** (↗).
- The body is rendered from Markdown. Frontmatter is not shown here (it is in the right pane). Each `<!-- dw:block n t=a-b -->` starts a block section with a small caption: `Block n · mm:ss–mm:ss` and a state badge when the document belongs to the current or a still-refining session. Gap markers render as a subtle "recording interrupted" divider. A document without block markers renders as plain Markdown.
- For the recording document: the view follows new text while scrolled to the bottom; if the user scrolls up, following pauses and a **Jump to live** button appears. Segments are appended to the live block's text directly; a block whose state becomes `refined` triggers one re-read of the file.
- Empty states: "Select a document" when nothing is selected; "Start a session to begin" when the vault is empty.

### 3.4 Session panel (right, 280 px, collapsible)
- **Session** (while a session runs or refines): state, elapsed duration, microphone name, mute state, live and refine models, target folder.
- **Blocks:** one row per block — number, time range, state (`live`, `empty`, `queued`, `refining`, `refined`, `skipped`, `failed`) with the message for skipped/failed. Clicking a row scrolls the document to that block.
- **Messages:** the session's status messages (device fallback, external edit detected, refinement failures, watcher fallback), newest first, kept for the session.
- With no session: the selected document's frontmatter (created, duration, language, models, app version).

## 4. Architecture

```
public/index.html ── markup only
public/app.css
public/vendor/{marked,purify}.min.js   (copied from node_modules at build)
public/js/*.js                          (compiled from src/renderer)

src/renderer/            tsconfig.renderer.json → ES2022 modules
  libraryTree.ts         pure: build/sort/filter the tree, expanded state     (Jest)
  documentView.ts        pure: split content → frontmatter + blocks + gaps     (Jest)
  sessionModel.ts        pure: apply status/segment/block events → view state  (Jest)
  app.ts                 state object, IPC subscriptions, pane re-render calls
  header.ts library.ts document.ts sessionPanel.ts dialogs.ts toast.ts   (DOM)

src/services/
  libraryService.ts      Electron-free: vault tree, folder create, move,
                         rename/delete delegation, path guard               (Jest)
  libraryRuntime.ts      IPC wiring, fs.watch with debounce + polling fallback,
                         trash, open/reveal
  sessionRuntime.ts      (modified) target folder, session-block events,
                         richer status
```

Rules carried over from stage 1: Electron-free modules hold the logic and are unit-tested; runtime modules only wire. Renderer modules under `src/renderer/` must not import anything from `src/services/` except types (`import type`), because the renderer cannot load CommonJS.

The pure renderer modules are compiled twice in effect: by `tsconfig.renderer.json` for the app, and by ts-jest for tests. They must not touch `document` or `window`.

**Risk to verify first:** ES module scripts (`<script type="module">`) loaded from `file://` in Electron 44. If they do not load, bundle `src/renderer/app.ts` with esbuild into one file instead; nothing else in the design changes.

## 5. Main-process interfaces

### 5.1 IPC (invoke)

| Channel | Arguments | Result |
|---|---|---|
| `library-tree` | — | `LibraryTree` (below) |
| `library-search` | `query: string` | `SearchHit[]` (relative `file`, `line`, `text`), at most 200 |
| `document-read` | `file` | `{ file, content, mtimeMs }` |
| `document-rename` | `file, title` | new relative path |
| `document-move` | `file, folder` | new relative path (`-2`, `-3`… on a clash) |
| `document-delete` | `file` | — (Recycle Bin) |
| `folder-create` | `parent, name` | new relative folder path |
| `document-open-external` | `file` | — (`shell.openPath`) |
| `document-reveal` | `file` | — (`shell.showItemInFolder`) |
| `choose-vault` | — | chosen absolute path or `null` (`dialog.showOpenDialog`, directory) |
| `session-start` | `folder?: string` | `SessionStatusView` |

```ts
interface LibraryTree {
  root: string;                       // absolute vault path, for display only
  exists: boolean;                    // false → "Vault not found"
  folders: FolderNode[];              // nested
  documents: LibraryDocument[];       // flat; each carries its folder
}
interface FolderNode { path: string; name: string; children: FolderNode[] }   // path relative, '' = root
interface LibraryDocument { file: string; folder: string; title: string; created: string; mtimeMs: number; readable: boolean }
```

All `file` and `folder` values crossing IPC are relative to the vault with forward slashes.

### 5.2 Events (main → renderer)

| Channel | Payload |
|---|---|
| `library-changed` | `{ paths: string[] }` relative paths that changed; debounced 300 ms |
| `session-block` | `{ sessionId, blockIndex, startSec, endSec, state, message? }`; `state` is `live` \| `empty` \| `queued` \| `refining` \| `refined` \| `skipped` \| `failed` |
| `session-status` | stage-1 view plus `sessionId`, `microphone`, `liveModel`, `refineModel`, `folder`, `messages: string[]`, `blocks` (the latest `session-block` payload per block) |

### 5.3 Guards
- **Path guard:** every renderer-supplied path is joined to the vault, normalised, and rejected unless it is inside the vault (`path.relative` does not start with `..` and is not absolute). Only `.md` files are accepted as documents. Folder names are trimmed, and `/ \ : * ? " < > |` and names `.`/`..` are rejected.
- **Recording document:** rename, move and delete of the document a session is recording are refused with a message. After the session stops they are allowed, even while its blocks still refine; refinement then targets the new path (`sessionRuntime` is told about renames and moves of its documents).
- **Session target folder:** must exist inside the vault; otherwise the session starts in the root and says so.

### 5.4 Block events
`sessionRuntime` emits `session-block`:
- `live` when a block opens; `queued` when it closes with text (`SessionService` enqueue); `empty` when it closes without text (no job).
- `refining` on `RefineEvent.started`; `refined` on `replaced`; `skipped` / `failed` with their messages.
- The session keeps the last state per block, so a renderer that opens mid-session gets the full list from `session-status` (`blocks` field).

## 6. Vault watching

- `fs.watch(vault, { recursive: true })`, collecting changed relative paths and emitting `library-changed` 300 ms after the last change.
- If `fs.watch` throws or emits `error`, fall back to polling the tree every 5 s (comparing paths and mtimes) and add a session-panel message.
- The watcher restarts when `vaultPath` changes in Settings.
- The renderer reloads the tree on every `library-changed`, and re-reads the open document only when its path is in `paths` and it is not the recording document. The recording document is re-read on `refined` block events and once after stop.

## 7. Rendering and security

- `marked` renders Markdown; `DOMPurify.sanitize` cleans the HTML before insertion. This is the only `innerHTML` assignment in the renderer, and it takes sanitised output only.
- Block captions and badges are built with DOM APIs (`textContent`).
- Links: `mainWindow.webContents.setWindowOpenHandler` and a `will-navigate` handler deny navigation; `http:`/`https:` links open with `shell.openExternal`, everything else is ignored.
- A Content-Security-Policy meta tag: `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'`. Remote images in a document do not load.
- The preload stays type-only (`require("electron")` only).

## 8. Settings changes

- **Vault folder** becomes a read-only path with **Choose folder…** (`choose-vault`).
- **Session microphone** and the rest of the stage-1 fields stay.
- Changing the vault reloads the library and restarts the watcher; it is refused while a session records.

## 9. Error handling

| Situation | Behaviour |
|---|---|
| Vault missing or unreadable | Library shows "Vault not found: <path>" and **Choose folder…**; Start session is disabled |
| A document cannot be read | Tree row shows a warning icon; the document pane shows the error text |
| Rename/move/delete fails (locked, permission) | Toast with the reason; tree reloaded from disk |
| Name clash on move | `-2`, `-3`… suffix, never overwrite |
| Watcher unavailable | Polling every 5 s; message in the session panel |
| Document changed on disk while shown | Re-rendered, scroll position kept when possible |
| Search with no matches | "No matches" in the library |

## 10. Removed

- The stage-1 session strip and its CSS.
- The single-column layout, the status box and the transcription box (their content moves to the header).
- The Settings "Vault folder" text input (replaced by the picker).

## 11. Testing

**Jest (no DOM, no Electron)**
- `libraryService`: tree on a temp vault (nested folders, non-`.md` files ignored, unreadable file flagged); path guard (`..`, absolute paths, other drives, non-`.md`); folder creation (sanitising, clash); move with clashes; rename delegation.
- `libraryTree`: sorting (folders A–Z, documents newest first, missing `created`), title filter, expanded-state preservation across reloads.
- `documentView`: frontmatter split; blocks with time ranges; gap markers; content before the first block; no markers at all; malformed markers treated as text.
- `sessionModel`: block-state transitions; events for an unknown block; out-of-order `refined` before `refining`; segment append to the live block; reset on a new session.

**Real app (CDP script, as in stage 1)**
- Panes render; the library lists a prepared test vault; search finds a line; creating a folder and moving a document update the tree; rename refuses the recording document; a session started with a folder selected writes there and is selected automatically; an external edit to a closed document re-renders it.

**Manual checklist**
- Obsidian open on the same vault while recording and while browsing.
- A 500-document vault: open time and search time.
- Keyboard-only navigation of the library.
- A document with remote images and links: images blocked, links open in the browser.
- Window at minimum size; right pane collapsed.

## 12. Risks

- **ES modules over `file://`** — verified in the first plan task; esbuild bundle is the fallback.
- **`fs.watch` recursive** on network drives and some sync folders is unreliable — polling fallback.
- **Large documents** (multi-hour sessions, ~100 kB of text) re-rendered on each refinement — acceptable at this size; if not, re-render only the refined block's section.
- **Renames during refinement** — handled by telling `sessionRuntime` the new path (§5.3).
