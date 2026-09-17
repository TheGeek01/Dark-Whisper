# Dark-Whisper: Quick Notes and Interface Refresh — Design

**Date:** 2026-09-16
**Status:** Draft for review
**Stage:** 3. Builds on `2026-09-15-dark-whisper-live-sessions-design.md` (engine, vault, refinement) and `2026-09-16-dark-whisper-workspace-design.md` (three-pane workspace). Visual reference: `Dark-Whisper-Interface-Refresh.png` (repo root, not shipped).

## 1. Goal

Replace paste-anywhere dictation with **Quick Note mode**: one Markdown file per day in a Quick Notes folder, collecting short timestamped notes. Split every recording (sessions and quick notes) into paragraphs at pauses in speech, each stamped with the clock time. Restyle the window to match the mockup, and make a search hit jump to the matching line.

**Success criteria**
- Ctrl+Q (or the Quick Notes button) starts recording into `<vault>/Quick Notes/YYYY-MM-DD.md` within 2 s; pressing it again stops.
- All quick notes made on one day end up in one file, in order, each starting with a date-time line.
- 5 s of silence (configurable) starts a new paragraph with a new clock line, in sessions and quick notes alike.
- Refinement keeps every clock line, and an outside edit still skips only the paragraphs that were edited.
- Clicking a search hit scrolls to and highlights the line containing the match.
- The window matches the mockup's layout in dark and light themes.

**Non-goals**
- Paste-into-any-app dictation (removed, not moved).
- Sharing documents, cloud models, editing inside the app.
- Switching the daily file at midnight while a note is recording.

## 2. Decisions

| Topic | Decision |
|---|---|
| Paste-anywhere dictation | Removed: hotkey, header button, tray/menu entries, last-dictation copy button, IPC |
| Quick note refinement | Yes — each paragraph is a refined block, same edit protection as sessions |
| Quick Note lifetime | Toggle: Ctrl+Q / Quick Notes button starts and stops; Pause/Resume as in sessions |
| Midnight | The date is fixed at start; a run past midnight keeps writing to the start day's file |
| Silence gap | Both modes; default 5 s; setting `silenceGapSeconds`; clock time (24 h `HH:MM`) in both modes |
| Paragraph model | A block is a paragraph (Approach A): closes on silence gap, Pause, Stop, or the existing block-length cap |
| Big header button | **Record** — starts a regular session. Outlined **Quick Notes** button toggles Quick Note mode. Stop/Pause act on whichever runs |
| Model chip | Shows `live → refine` model names, opens the existing model picker |
| Theme | Dark (default) and light, toggle in header, saved in settings (`theme`) |
| Title bar | Frameless via Electron `titleBarStyle: 'hidden'` + `titleBarOverlay` (native Windows caption buttons in theme colours) |
| Level meter | Driven by SoX level output; falls back to a pulse on each text arrival |
| Sidebar | Search (Ctrl+K, Ctrl+F), VAULT (folders with recursive counts, Quick Notes pinned first, then loose documents), RECENT (5), New Session, footer count + ••• menu |
| Document toolbar | Open in editor, Copy path, Font size (3 steps), Focus mode. No share |
| Right panel | Collapsible Session / Blocks / Document sections, open state remembered |
| Search jump | Scroll to and highlight the matched line, not the whole block |
| `timestampHeadings` setting | Removed; clock lines are always written |
| Release | v1.3.0 |

## 3. Recording behaviour

### 3.1 Blocks are paragraphs

`SessionService` closes the current block and opens the next one when any of these happens:

1. **Silence gap** — a segment arrives whose start is at least `silenceGapSeconds` after the previous segment's end. The new segment becomes the first text of the new block.
2. **Pause** — the block closes (queued for refinement) and a blank line follows. No `<!-- dw:gap -->` marker is written any more; existing documents that contain it still render.
3. **Resume** — a new block opens.
4. **Stop** — the last block closes, as today.
5. **Length cap** — the existing `blockMinutes` cap still closes a block that runs that long without a pause.

A block that would be empty (e.g. Pause right after a gap opened a block, before any text) is not written; the next text opens it. This keeps the file free of orphan clock lines.

Silence is measured from segment timing reported by whisper-stream (`atMs` and segment end). The implementation plan starts with a probe confirming these timings are stable enough; if they are not, the fallback is wall-clock time between segment arrivals, which is the same rule with slightly later splits.

### 3.2 Clock lines

Every block starts with a visible clock line directly under its marker:

```
<!-- dw:block 7 t=312-331 -->
**14:32**
Programming jobs can actually be done in an hour or less.
```

- The first block of a run (session start, or quick note start) uses the date and time: `**2026-09-16 14:32**`.
- Blocks opened by a silence gap or Resume use the time only: `**14:35**`.
- Time is local, 24-hour, taken from an injected `now()` when the block opens.
- `replaceBlock` already keeps heading lines; it is extended to keep a clock line (matching `^\*\*(\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}\*\*$`) so refinement replaces only the spoken text. `blockTextFrom` excludes clock lines from the text sent to refinement and from the block hash.

### 3.3 Regular sessions

Unchanged except for §3.1–3.2: same file naming, same target folder (selected folder, else vault root).

### 3.4 Quick Note mode

- **Start** (Ctrl+Q, Quick Notes button, tray item): refused with a toast if a session is recording ("Stop the session before starting a quick note"), and a session start is refused while a quick note records.
- **File:** `<vault>/Quick Notes/<YYYY-MM-DD>.md`, date taken once at start. The folder is created if missing. A new file gets the usual frontmatter with `title: YYYY-MM-DD`.
- **Appending:** an existing file is appended to. Block numbering continues after the highest `dw:block` index in the file (`nextBlockIndex(content)`, 1 if none). A hand-made file with no markers is valid.
- **Frontmatter:** `duration` accumulates: the run adds its elapsed seconds to the value it found at start.
- **Session audio / refinement:** each run is its own session (own id, own audio file, own refine queue), exactly like a regular session. Block markers' `t=` values are relative to that run's audio.
- **Stop:** the run finishes like a session: last block queued, refinement continues in the background, audio deleted when done.
- **Panel title:** "Quick Note" instead of "Session".

### 3.5 Two runs on one file

A new quick note can start while an earlier run on the same daily file is still refining. Runtime keeps one `GuardedStore` per file path (a registry with a reference count, released when a run settles). Every run's writes go through that shared guard, so neither sees the other's writes as outside edits. An edit made in another program is reported once to every run holding the guard, and each marks only its own live block (`noteOutsideEdit` already checks `info.blockIndex`). Block indexes cannot collide because the second run numbers after the first run's highest index; the first run opens no new blocks once stopped.

`documentMoved` updates the path for every run sharing the guard.

### 3.6 Removed

- Quick dictation: `main.ts` recording/paste flow, its IPC handlers and preload methods, the tray and menu items, `pasteService` (if nothing else uses it), and the header's last-dictation text and copy button.
- node-mic stays: its SoX binary records session audio.
- Settings `timestampHeadings` (ignored if present in an old settings file).

## 4. Interface

Layout follows the mockup. Colours are CSS tokens on `:root`, with a `[data-theme="light"]` set.

### 4.1 Window and header

- `BrowserWindow` uses `titleBarStyle: 'hidden'` and `titleBarOverlay: { color, symbolColor, height }`, updated when the theme changes. The header is the drag region (`-webkit-app-region: drag`); its controls are `no-drag`.
- Left to right:
  - logo and name
  - status dot and text: Ready / Recording / Refining *n* / server problem with Restart and Open log
  - **Quick Notes** outlined toggle, highlighted while a quick note records
  - model chip `base.en → large-v3-turbo`, which opens the model picker
  - **Record** primary button, which starts a session and is disabled while anything records
  - **Stop** and **Pause/Resume**, enabled only while a run records
  - theme toggle
  - Settings
  - space for the native caption buttons

### 4.2 Sidebar

- Search box with a `Ctrl+K` hint. Ctrl+K and Ctrl+F both focus it.
- **VAULT**
  - Quick Notes is always the first row, with its own icon, even when the folder does not exist yet; selecting it with no folder shows an empty state.
  - Other top-level folders follow, each with a recursive document count, expanding to subfolders as today.
  - Loose root documents come last.
- **RECENT**: the five most recently modified documents, with relative time ("2m ago", "1h ago", "1d ago"), refreshed by the vault watcher and once a minute.
- **New Session** button, the same as Record.
- Footer: "*N* documents" and a **•••** menu with New folder, Change vault, and Show vault in Explorer. It replaces the current "+ folder" link and target label.

### 4.3 Document pane

- Title bar:
  - title and rename pencil
  - while this document is recording, a level meter and a **Live** badge
- Body:
  - each block renders as a row with a left margin column; a clock line is lifted out of the text into the margin (showing `HH:MM`, with the date in a tooltip for date-time lines)
  - blocks without a clock line have an empty margin
  - older documents render as before
- Search jump: the hit carries the file and line. After rendering, the view finds the block containing that source line, then the rendered element or text node containing the hit's text, scrolls it into view and highlights that line for a few seconds. If the text cannot be found (e.g. Markdown changed it), it falls back to the block, as today.
- Bottom toolbar:
  - Open in editor
  - Copy path
  - **Aa** cycles three font sizes, remembered per viewer
  - Focus mode hides both side panes; Esc or the button exits
- Existing behaviour stays: Jump to live, follow while live, block state badges.

### 4.4 Right panel

Three collapsible sections, with open/closed state remembered:

- **Session** (titled **Quick Note** for quick note runs): state, microphone, live model, refine model, elapsed time, waiting to refine, and messages. When nothing records, it shows the most recent run until you select another document, as today.
- **Blocks (*n*)**: index, clock time and state (live / pending / refined / skipped / failed).
- **Document**: created, path, duration, language, live model, refine model, app.

### 4.5 Level meter

`streamRuntime` starts session SoX with its level display enabled (`-S`), parses the level from stderr, and emits `session-level` (0–1) at most 10 times a second. The renderer draws bars from the last ~40 values. If no level arrives within 2 s of recording, the meter pulses on each text event instead. The plan's opening probe confirms SoX's output format on Windows.

## 5. API changes

- `startSession(request: { kind: 'session'; folder: string } | { kind: 'quick-note' })`.
- `SessionStatusView` gains `kind: 'session' | 'quick-note'`. Block events gain `clock: string` (the block's clock line text).
- `onSessionLevel(listener: (level: number) => void)`.
- `toggleQuickNote()` is invoked from the renderer; the Ctrl+Q global shortcut calls the same path in main.
- Settings gain `silenceGapSeconds: number` (1–60, default 5) and `theme: 'dark' | 'light'` (default dark). The Settings dialog shows the silence gap.
- `LibraryTree` documents already carry modification time; if not, `modified` is added for RECENT.
- Dictation methods and events are removed from `DarkWhisperApi`.

## 6. Error handling

| Case | Behaviour |
|---|---|
| Quick Notes folder or daily file cannot be created (permissions, a folder named `YYYY-MM-DD.md`) | The run does not start; a toast gives the reason |
| Daily file locked by another program at start | Retry as `DocumentStore` does today, then the same toast |
| Daily file moved or renamed mid-run | Existing `documentMoved` path, applied to every run sharing the guard |
| Start pressed while the other mode records | Refused with a toast naming the running mode |
| No SoX level output | Meter falls back to pulses |
| Silence timings unreliable (probe) | Wall-clock arrival gap is used instead |
| Invalid `silenceGapSeconds` in settings | Clamped to 1–60 |

## 7. Testing

Unit tests are written first:

- `sessionService`:
  - splitting on a silence gap
  - no split below the gap
  - Pause and Resume produce blocks with no gap marker
  - no empty blocks
  - date-time line on the first block, time lines on later ones
  - numbering from `firstBlockIndex`
- `quickNotes`:
  - daily path
  - `nextBlockIndex` (none, several, out of order)
  - line formats
- `documentStore`: refinement keeps clock lines; clock lines are excluded from the block text and hash.
- Guard registry: two runs on one file see no false outside edits; an outside edit reaches both and marks only the live block's owner; references are released.
- Integration (as in `sessionOutsideEdit.test.ts`):
  - a quick note run appending to a file that an earlier run is still refining
  - a Notepad++-style edit skips only the edited paragraph
- SoX level parser.
- `documentView`:
  - clock-line extraction for the margin
  - locating a hit line inside a block
- `settingsService`: new defaults and clamping.

Beyond the unit tests:

- `npm run smoke:workspace` is extended to cover:
  - sidebar sections (Quick Notes pinned, counts, Recent)
  - toolbar (font size, focus mode)
  - theme toggle
  - search jump highlighting a line
  - Quick Note start and stop on a throwaway profile
- A manual live check with a real microphone on a throwaway profile covers:
  - pause splits
  - two quick notes on one day
  - an outside edit during a quick note
  - the level meter

## 8. Documentation

README (features, shortcuts, 1.3.0 changelog, removal of paste dictation), QUICKSTART, DEVELOPMENT, and the stage-1 spec's note on block boundaries.
