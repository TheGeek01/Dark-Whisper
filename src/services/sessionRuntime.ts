import { app, shell } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AudioEntry, BYTES_PER_SECOND, WAV_HEADER_BYTES, slicesForRange, wavHeader } from './blockMath';
import { RefineEvent, RefineQueue, shouldRefineDuringRecording } from './blockRefiner';
import { DocumentStore, Frontmatter } from './documentStore';
import type { GuardedStore } from './guardedStore';
import { GuardRegistry } from './guardRegistry';
import { MicMuteService } from './micMuteService';
import { buildShimArgs, parseMuteOutput } from './micMuteOutput';
import { SilenceTracker } from './audioLevel';
import { RefineJob, SessionService } from './sessionService';
import { prepareQuickNote, startRefusal } from './quickNotes';
import { newSessionId } from './sessionPaths';
import { CaptureDevice } from './streamOutput';
import { getSettings } from './settingsService';
import { SessionAudio, startLiveEngine, stopLiveEngine, streamEngine, sessionsRoot } from './streamRuntime';
import { transcribeAudio } from './apiService';
import { modelManager, whisperServer } from './whisperRuntime';
import type { BlockEvent, BlockState, SessionKind, SessionStartRequest, SessionStatusView } from '../shared/api';
import { LibraryService, toRelative } from './libraryService';

export type { SessionStatusView };

const MAX_MESSAGES = 50;

const REFINE_STATE: Record<RefineEvent['kind'], BlockState> = {
  started: 'refining',
  replaced: 'refined',
  skipped: 'skipped',
  failed: 'failed',
};

const OUTSIDE_EDIT_MESSAGE =
  'File changed outside the app — edited blocks won’t be refined. Reload it in your editor before saving, or it will overwrite new text.';
const EDITED_BLOCK_MESSAGE = 'block edited outside the app';
const AUDIO_REMOVE_ATTEMPTS = 5;
const AUDIO_REMOVE_RETRY_MS = 1000;
// Used before the recorder has started: with no audio, paragraphs split on segment arrival gaps.
const NO_AUDIO = new SilenceTracker();

// Everything one session owns. A stopped session keeps refining in the background after a new
// one starts, so its callbacks must never reach for "the current session".
interface SessionContext {
  id: string;
  kind: SessionKind;
  vaultPath: string;
  folder: string;
  documentPath: string;
  service: SessionService;
  queue: RefineQueue;
  store: GuardedStore;
  // Stops listening to the shared guard and releases it; safe to call more than once.
  releaseGuard(): void;
  stopped: boolean;
  audioRemoved: boolean;
  pausedByApp: boolean;
  outsideEditNoticed: boolean;
  microphone: string;
  liveModel: string;
  refineModel: string;
  // Set once the recorder starts; each run keeps its own, so an older run can still be refined.
  audio: SessionAudio | null;
  messages: string[];
  blocks: Map<number, BlockEvent>;
}

const listeners = new Set<(v: SessionStatusView) => void>();
const segmentListeners = new Set<(s: { text: string; blockIndex: number }) => void>();
const blockListeners = new Set<(event: BlockEvent) => void>();
// App-wide notices (e.g. the vault watcher falling back to polling), newest first.
const notices: string[] = [];
const finishing = new Set<SessionContext>();
const guards = new GuardRegistry();

let current: SessionContext | null = null;
let statusMessage: string | undefined;
let lastDevices: CaptureDevice[] = [];

const micMute = new MicMuteService({
  readMute: () =>
    new Promise((resolve) => {
      const child = spawn('powershell', buildShimArgs('get'), { windowsHide: true });
      let out = '';
      child.stdout.on('data', (c) => (out += String(c)));
      child.on('error', () => resolve(null));
      child.on('close', () => resolve(parseMuteOutput(out)));
    }),
  writeMute: (muted) =>
    new Promise((resolve) => {
      const child = spawn('powershell', buildShimArgs(muted ? 'mute' : 'unmute'), { windowsHide: true });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    }),
  pollMs: 1000,
});

function liveContexts(): Set<SessionContext> {
  const all = new Set(finishing);
  if (current) all.add(current);
  return all;
}

function emit(): void {
  const view = sessionStatus();
  for (const l of listeners) l(view);
}

export function onSessionStatus(listener: (v: SessionStatusView) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onSessionSegment(listener: (s: { text: string; blockIndex: number }) => void): () => void {
  segmentListeners.add(listener);
  return () => segmentListeners.delete(listener);
}

export function onSessionBlock(listener: (event: BlockEvent) => void): () => void {
  blockListeners.add(listener);
  return () => blockListeners.delete(listener);
}

function addMessage(ctx: SessionContext, text: string): void {
  statusMessage = text;
  ctx.messages.unshift(text);
  ctx.messages.splice(MAX_MESSAGES);
}

export function addSessionNotice(text: string): void {
  if (notices[0] === text) return;
  notices.unshift(text);
  notices.splice(MAX_MESSAGES);
  emit();
}

export function clearSessionNotice(text: string): void {
  const index = notices.indexOf(text);
  if (index === -1) return;
  notices.splice(index, 1);
  emit();
}

function recordBlock(
  ctx: SessionContext,
  blockIndex: number,
  state: BlockState,
  message?: string,
  range?: { startSec: number; endSec: number; clock?: string },
): void {
  const previous = ctx.blocks.get(blockIndex);
  const event: BlockEvent = {
    sessionId: ctx.id,
    blockIndex,
    startSec: range?.startSec ?? previous?.startSec ?? 0,
    endSec: range?.endSec ?? previous?.endSec ?? 0,
    clock: range?.clock ?? previous?.clock ?? '',
    state,
    ...(message ? { message } : {}),
  };
  ctx.blocks.set(blockIndex, event);
  for (const l of blockListeners) l(event);
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

export function isRecordingDocument(absolute: string): boolean {
  return isSessionActive() && current !== null && samePath(current.documentPath, absolute);
}

// The library renamed or moved a document; a finished session may still be refining it.
export function documentMoved(from: string, to: string): void {
  for (const ctx of liveContexts()) {
    if (!samePath(ctx.documentPath, from)) continue;
    ctx.documentPath = to;
    ctx.service.setDocumentPath(to);
  }
  guards.moved(from, to);
  emit();
}

// The engine only lists devices once it has launched, so the last list seen is kept for the
// picker and for resolving the saved device name at the next session start (spec §4.4).
export function captureDevices(): CaptureDevice[] {
  return lastDevices.map((d) => ({ ...d }));
}

export function isSessionActive(): boolean {
  return current !== null && !current.stopped;
}

export function sessionStatus(): SessionStatusView {
  const engine = streamEngine.getStatus();
  const ctx = current;
  const info = ctx?.service.getInfo();
  let state: SessionStatusView['state'] = 'idle';
  if (isSessionActive() && engine.state === 'error') state = 'error';
  else if (isSessionActive() && engine.state === 'starting') state = 'starting';
  else if (info) state = info.state;

  let refining = 0;
  for (const c of liveContexts()) refining += c.queue.pending();

  return {
    sessionId: ctx?.id ?? null,
    kind: ctx?.kind ?? 'session',
    state,
    documentPath: ctx?.documentPath ?? null,
    documentFile: ctx ? toRelative(ctx.vaultPath, ctx.documentPath) : null,
    folder: ctx?.folder ?? '',
    blockIndex: info?.blockIndex ?? 0,
    durationSec: info?.durationSec ?? 0,
    refining,
    message: (isSessionActive() ? engine.message : undefined) ?? statusMessage,
    muted: micMute.isMuted(),
    microphone: ctx?.microphone ?? '',
    liveModel: ctx?.liveModel ?? '',
    refineModel: ctx?.refineModel ?? '',
    messages: [...(ctx?.messages ?? []), ...notices],
    blocks: ctx ? [...ctx.blocks.values()].sort((a, b) => a.blockIndex - b.blockIndex) : [],
  };
}

// Durations are derived from the files' current size, because the newest file is still growing.
function audioManifest(ctx: SessionContext): AudioEntry[] {
  return (ctx.audio?.entries ?? []).map((entry) => {
    let size = 0;
    try {
      size = fs.statSync(entry.file).size;
    } catch {
      // Not written yet: treat as empty.
    }
    return {
      file: entry.file,
      startSec: entry.startSec,
      durationSec: Math.max(0, (size - WAV_HEADER_BYTES) / BYTES_PER_SECOND),
    };
  });
}

async function sliceAudio(ctx: SessionContext, job: RefineJob): Promise<string | null> {
  if (ctx.audioRemoved) return null;
  const slices = slicesForRange(audioManifest(ctx), job.startSec, job.endSec);
  if (slices.length === 0) return null;
  const chunks: Buffer[] = [];
  for (const slice of slices) {
    const length = slice.endByte - slice.startByte;
    if (length <= 0) continue;
    const handle = await fs.promises.open(slice.file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, slice.startByte);
      if (bytesRead > 0) chunks.push(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }
  const data = Buffer.concat(chunks);
  if (data.length < BYTES_PER_SECOND) return null; // less than a second of audio is not worth a pass
  const out = path.join(os.tmpdir(), `dw-block-${ctx.id}-${job.blockIndex}-${Date.now()}.wav`);
  await fs.promises.writeFile(out, Buffer.concat([wavHeader(data.length), data]));
  return out;
}

function modelSize(id: string): number {
  const file = modelManager.getModelPath(id);
  if (!file) return 0;
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// Whether this session may be refined at all, and whether it may be refined right now.
function refinementAllowed(ctx: SessionContext): boolean {
  const settings = getSettings();
  if (settings.serverMode === 'external') {
    if (!settings.refineWithExternalApi) return false;
  } else if (whisperServer.getStatus().state !== 'ready') {
    return false;
  }
  if (ctx.stopped) return true;
  const refineBytes = settings.serverMode === 'builtin' && settings.modelId ? modelSize(settings.modelId) : 0;
  return shouldRefineDuringRecording(settings.refineDuringRecording, modelSize(settings.liveModelId), refineBytes);
}

// Session WAVs are removed once every queued block has been refined or skipped (spec §5.4).
async function settle(ctx: SessionContext): Promise<void> {
  ctx.queue.setAllowed(refinementAllowed(ctx));
  if (!ctx.stopped || ctx.audioRemoved) return;
  await ctx.queue.drain();
  if (ctx.audioRemoved) return;
  const abandoned = !refinementAllowed(ctx) && refinementBlockedForGood();
  if (ctx.queue.pending() > 0 && !abandoned) return;
  ctx.audioRemoved = true;
  finishing.delete(ctx);
  ctx.releaseGuard();
  if (!getSettings().keepSessionAudio) {
    await removeSessionAudio(ctx.id);
  }
  emit();
}

// Windows refuses to delete a file another process still has open; the recorder may take a
// moment to let go. A folder that still cannot be removed is reported at the next start.
async function removeSessionAudio(id: string): Promise<void> {
  const dir = path.join(sessionsRoot(), id);
  for (let attempt = 1; attempt <= AUDIO_REMOVE_ATTEMPTS; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === AUDIO_REMOVE_ATTEMPTS) {
        console.error(`Could not remove session audio ${dir}:`, error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, AUDIO_REMOVE_RETRY_MS));
    }
  }
}

// A server that is merely starting may still become ready; these conditions will not change.
function refinementBlockedForGood(): boolean {
  const settings = getSettings();
  return settings.serverMode === 'external' && !settings.refineWithExternalApi;
}

function uniqueDocumentId(dir: string, base: string): string {
  let id = base;
  for (let n = 2; fs.existsSync(path.join(dir, `${id}-untitled.md`)); n++) {
    id = `${base}-${n}`;
  }
  return id;
}

// A missing or invalid target folder falls back to the vault root, with a message.
function resolveTargetFolder(library: LibraryService, folder: string): { folder: string; message?: string } {
  if (!folder) return { folder: '' };
  try {
    const dir = library.resolve(folder, 'folder');
    if (fs.statSync(dir).isDirectory()) return { folder: library.relative(dir) };
  } catch {
    // Reported below.
  }
  return { folder: '', message: `Folder "${folder}" not found — the session was saved in the vault root` };
}

async function applyPause(paused: boolean, source: 'app' | 'mic'): Promise<void> {
  const ctx = current;
  if (!ctx || ctx.stopped) return;
  if ((ctx.service.getInfo().state === 'paused') === paused) return;
  if (source === 'app') {
    await micMute.setMuted(paused);
    ctx.pausedByApp = paused;
  } else {
    ctx.pausedByApp = false;
  }
  streamEngine.setPaused(paused);
  ctx.service.setPaused(paused, streamEngine.elapsedMs());
  emit();
}

export async function startSession(request: SessionStartRequest): Promise<SessionStatusView> {
  const refusal = startRefusal(isSessionActive() && current ? current.kind : null, request.kind);
  if (refusal) throw new Error(refusal);

  const settings = getSettings();
  const documents = new DocumentStore(settings.vaultPath);
  const startedAt = new Date();
  const id = newSessionId(startedAt);
  const created = startedAt.toISOString();
  const details: Omit<Frontmatter, 'title'> = {
    created,
    updated: created,
    duration: 0,
    language: settings.language,
    liveModel: settings.liveModelId,
    refineModel: settings.modelId ?? 'none',
    app: `dark-whisper ${app.getVersion()}`,
  };

  // A quick note appends to today's file in Quick Notes (spec §3.4); a session gets a new
  // document in the selected folder.
  let documentPath: string;
  let folder: string;
  let firstBlockIndex = 1;
  let baseDurationSec = 0;
  let folderMessage: string | undefined;
  if (request.kind === 'quick-note') {
    const target = prepareQuickNote(documents, settings.vaultPath, startedAt, details);
    documentPath = target.documentPath;
    folder = target.folder;
    firstBlockIndex = target.firstBlockIndex;
    baseDurationSec = target.baseDurationSec;
  } else {
    const library = new LibraryService(settings.vaultPath);
    const target = resolveTargetFolder(library, request.folder);
    folder = target.folder;
    folderMessage = target.message;
    const base = id.replace(/^(\d{4})(\d{2})(\d{2})-(\d{4})\d{2}$/, '$1-$2-$3-$4');
    const targetDir = path.join(settings.vaultPath, folder);
    documentPath = documents.createDocument(uniqueDocumentId(targetDir, base), { title: 'untitled', ...details }, folder);
  }

  if (current && !current.audioRemoved) finishing.add(current);
  statusMessage = undefined;

  let ctx: SessionContext | null = null;
  // An outside change that touched no block (a line-ending resave, the frontmatter) is not worth a
  // warning.
  const store = guards.acquire(documentPath, documents);
  const stopListening = store.onOutsideEdit((changed) => {
    if (!ctx) return;
    ctx.service.noteOutsideEdit(changed);
    if (changed.length > 0 && !ctx.outsideEditNoticed) {
      ctx.outsideEditNoticed = true;
      addMessage(ctx, OUTSIDE_EDIT_MESSAGE);
      emit();
    }
  });
  let guardReleased = false;

  const service = new SessionService({
    store,
    enqueueRefine: (job) => ctx?.queue.enqueue(job),
    blockMinutes: settings.blockMinutes,
    silenceGapSec: settings.silenceGapSeconds,
    silence: {
      splitPoint: (afterSec, beforeSec, gapSec) =>
        (ctx?.audio?.silence ?? NO_AUDIO).splitPoint(afterSec, beforeSec, gapSec),
      hasSpeech: (fromSec, toSec) => (ctx?.audio?.silence ?? NO_AUDIO).hasSpeech(fromSec, toSec),
    },
    now: () => new Date(),
  });

  const queue = new RefineQueue({
    sliceAudio: (job) => (ctx ? sliceAudio(ctx, job) : Promise.resolve(null)),
    transcribe: (wav) => transcribeAudio(wav),
    cleanup: (wav) => fs.rmSync(wav, { force: true }),
    apply: (blockIndex, text) => service.applyRefinement(blockIndex, text),
    report: (event) => {
      if (ctx) {
        recordBlock(ctx, event.blockIndex, REFINE_STATE[event.kind], event.message);
        if (event.kind === 'failed') {
          addMessage(ctx, `Refinement failed for block ${event.blockIndex}${event.message ? `: ${event.message}` : ''}`);
        }
      }
      emit();
    },
  });

  const device = settings.captureDeviceName
    ? lastDevices.find((d) => d.name === settings.captureDeviceName)
    : undefined;

  ctx = {
    id,
    kind: request.kind,
    vaultPath: settings.vaultPath,
    folder,
    documentPath,
    service,
    queue,
    store,
    releaseGuard: () => {
      if (guardReleased) return;
      guardReleased = true;
      stopListening();
      guards.release(ctx?.documentPath ?? documentPath);
    },
    stopped: false,
    audioRemoved: false,
    pausedByApp: false,
    outsideEditNoticed: false,
    microphone: device?.name ?? 'System default',
    liveModel: settings.liveModelId,
    refineModel: settings.serverMode === 'external' ? 'External API' : settings.modelId ?? 'none',
    audio: null,
    messages: [],
    blocks: new Map(),
  };
  current = ctx;
  if (folderMessage) addMessage(ctx, folderMessage);
  if (settings.captureDeviceName && !device) {
    addMessage(ctx, `Microphone "${settings.captureDeviceName}" not found — using the default device`);
  }

  const owner = ctx;
  service.onBlock((event) => {
    if (event.state === 'edited') recordBlock(owner, event.blockIndex, 'skipped', EDITED_BLOCK_MESSAGE, event);
    else recordBlock(owner, event.blockIndex, event.state, undefined, event);
  });
  queue.setAllowed(refinementAllowed(ctx));
  service.begin({ id, documentPath, firstBlockIndex, baseDurationSec });
  service.onInfo(() => emit());

  // The first poll reports the current mute state, so a session started muted begins paused.
  micMute.start();
  try {
    ctx.audio = await startLiveEngine({ sessionId: id, captureId: device?.index ?? null, deviceName: device?.name });
  } catch (error) {
    await stopSession();
    throw error;
  }
  emit();
  return sessionStatus();
}

export async function pauseSession(): Promise<void> {
  await applyPause(true, 'app');
}

export async function resumeSession(): Promise<void> {
  await applyPause(false, 'app');
}

export async function stopSession(): Promise<void> {
  const ctx = current;
  if (!ctx || ctx.stopped) return;
  const atMs = streamEngine.elapsedMs();
  const audioStopped = stopLiveEngine();
  micMute.stop();
  const unmute = ctx.pausedByApp;
  ctx.service.end(atMs);
  ctx.stopped = true;
  emit();
  if (unmute) {
    await micMute.setMuted(false).catch((error) => console.error('Could not unmute the microphone:', error));
  }
  void audioStopped
    .then(() => settle(ctx))
    .catch((error) => console.error('Failed to finish the session:', error));
}

// Ctrl+Q and the Quick Notes button: stop a running quick note, else start one. A running
// session is not touched; startSession refuses with a message instead.
export async function toggleQuickNote(): Promise<void> {
  if (isSessionActive() && current?.kind === 'quick-note') {
    await stopSession();
    return;
  }
  await startSession({ kind: 'quick-note' });
}

export async function revealDocument(): Promise<void> {
  if (current) shell.showItemInFolder(current.documentPath);
}

export async function openVault(): Promise<void> {
  const vault = getSettings().vaultPath;
  fs.mkdirSync(vault, { recursive: true });
  await shell.openPath(vault);
}

// Engine → session plumbing, registered once.
streamEngine.onSegment((segment) => {
  if (!isSessionActive() || !current) return;
  if (!current.service.segment(segment)) return;
  const blockIndex = current.service.getInfo().blockIndex;
  for (const l of segmentListeners) l({ text: segment.text, blockIndex });
});
// SoX keeps recording across engine relaunches, so the audio timeline stays continuous; the
// service ends the paragraph at the relaunch.
streamEngine.onLaunch((launch) => {
  if (isSessionActive()) current?.service.launch(launch);
  emit();
});
streamEngine.onStatus((status) => {
  if (status.devices.length > 0) lastDevices = status.devices.map((d) => ({ ...d }));
  emit();
});
micMute.onChange((muted) => {
  void applyPause(muted, 'mic');
});
// The server coming up (or going away) changes whether queued blocks may run.
whisperServer.onStatus(() => {
  for (const ctx of liveContexts()) {
    void settle(ctx);
  }
});

// Stale audio from a crash is reported once and left on disk (spec §5.3).
try {
  for (const dir of fs.readdirSync(sessionsRoot())) {
    console.warn(`Leftover session audio from a previous run: ${path.join(sessionsRoot(), dir)}`);
  }
} catch {
  // No sessions directory yet — nothing to report.
}
