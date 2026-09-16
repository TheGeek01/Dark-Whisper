import { app, shell } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AudioEntry, BYTES_PER_SECOND, WAV_HEADER_BYTES, slicesForRange, wavHeader } from './blockMath';
import { RefineQueue, shouldRefineDuringRecording } from './blockRefiner';
import { BlockRef, DocumentStore, Frontmatter, ReplaceOutcome } from './documentStore';
import { MicMuteService } from './micMuteService';
import { buildShimArgs, parseMuteOutput } from './micMuteOutput';
import { RefineJob, SessionService, SessionStoreLike } from './sessionService';
import { newSessionId } from './sessionPaths';
import { CaptureDevice } from './streamOutput';
import { getSettings } from './settingsService';
import { startLiveEngine, stopLiveEngine, streamEngine, sessionsRoot, sessionAudioManifest } from './streamRuntime';
import { transcribeAudio } from './apiService';
import { modelManager, whisperServer } from './whisperRuntime';

export interface SessionStatusView {
  state: 'idle' | 'starting' | 'recording' | 'paused' | 'stopped' | 'error';
  documentPath: string | null;
  blockIndex: number;
  durationSec: number;
  refining: number;
  message?: string;
  muted: boolean | null;
}

const EXTERNAL_EDIT_MESSAGE = 'File edited outside the app — refinement paused for this session';

// Wraps the document store so every write first checks that nobody else changed the file since
// our previous write (spec §5.3). Once tripped, appending carries on but no block is replaced.
class GuardedStore implements SessionStoreLike {
  private lastHash = '';
  edited = false;

  constructor(
    private readonly store: DocumentStore,
    private readonly onEdited: () => void,
  ) {}

  private beforeWrite(file: string): void {
    if (this.edited || this.lastHash === '') return;
    if (this.store.fileHash(file) !== this.lastHash) {
      this.edited = true;
      this.onEdited();
    }
  }

  private afterWrite(file: string): void {
    this.lastHash = this.store.fileHash(file);
  }

  noteWrite(file: string): void {
    this.afterWrite(file);
  }

  openBlock(file: string, block: BlockRef, heading?: string): void {
    this.beforeWrite(file);
    this.store.openBlock(file, block, heading);
    this.afterWrite(file);
  }

  appendSegment(file: string, text: string): void {
    this.beforeWrite(file);
    this.store.appendSegment(file, text);
    this.afterWrite(file);
  }

  appendLine(file: string, line: string): void {
    this.beforeWrite(file);
    this.store.appendLine(file, line);
    this.afterWrite(file);
  }

  readBlockText(file: string, index: number): string | null {
    return this.store.readBlockText(file, index);
  }

  replaceBlock(file: string, index: number, text: string, expectedHash: string): ReplaceOutcome {
    this.beforeWrite(file);
    if (this.edited) return 'skipped-edited';
    const outcome = this.store.replaceBlock(file, index, text, expectedHash);
    this.afterWrite(file);
    return outcome;
  }

  updateFrontmatter(file: string, patch: { duration: number }): void {
    this.beforeWrite(file);
    this.store.updateFrontmatter(file, patch);
    this.afterWrite(file);
  }
}

// Everything one session owns. A stopped session keeps refining in the background after a new
// one starts, so its callbacks must never reach for "the current session".
interface SessionContext {
  id: string;
  documentPath: string;
  service: SessionService;
  queue: RefineQueue;
  store: GuardedStore;
  stopped: boolean;
  audioRemoved: boolean;
  pausedByApp: boolean;
}

const listeners = new Set<(v: SessionStatusView) => void>();
const segmentListeners = new Set<(s: { text: string; blockIndex: number }) => void>();
const finishing = new Set<SessionContext>();

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
  const info = current?.service.getInfo();
  let state: SessionStatusView['state'] = 'idle';
  if (isSessionActive() && engine.state === 'error') state = 'error';
  else if (isSessionActive() && engine.state === 'starting') state = 'starting';
  else if (info) state = info.state;

  let refining = 0;
  for (const ctx of liveContexts()) refining += ctx.queue.pending();

  return {
    state,
    documentPath: current?.documentPath ?? null,
    blockIndex: info?.blockIndex ?? 0,
    durationSec: info?.durationSec ?? 0,
    refining,
    message: (isSessionActive() ? engine.message : undefined) ?? statusMessage,
    muted: micMute.isMuted(),
  };
}

// The manifest comes from streamRuntime's SoX recorder (absolute paths, real-time audio).
// Durations are derived from the files' current size, because the newest file is still growing.
function audioManifest(): AudioEntry[] {
  return sessionAudioManifest().map((entry) => {
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
  // The recorder's manifest is replaced when the next session starts; an older session's audio
  // can no longer be located after that.
  if (current !== ctx) return null;
  const slices = slicesForRange(audioManifest(), job.startSec, job.endSec);
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
  if (ctx.store.edited) return false;
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
  const abandoned = !refinementAllowed(ctx) && refinementBlockedForGood(ctx);
  if (ctx.queue.pending() > 0 && !abandoned) return;
  ctx.audioRemoved = true;
  finishing.delete(ctx);
  if (!getSettings().keepSessionAudio) {
    fs.rmSync(path.join(sessionsRoot(), ctx.id), { recursive: true, force: true });
  }
  emit();
}

// A server that is merely starting may still become ready; these conditions will not change.
function refinementBlockedForGood(ctx: SessionContext): boolean {
  const settings = getSettings();
  return ctx.store.edited || (settings.serverMode === 'external' && !settings.refineWithExternalApi);
}

function uniqueDocumentId(vaultPath: string, base: string): string {
  let id = base;
  for (let n = 2; fs.existsSync(path.join(vaultPath, `${id}-untitled.md`)); n++) {
    id = `${base}-${n}`;
  }
  return id;
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
  ctx.service.setPaused(paused);
  emit();
}

export async function startSession(): Promise<SessionStatusView> {
  if (isSessionActive()) throw new Error('A session is already recording');
  if (current && !current.audioRemoved) finishing.add(current);

  const settings = getSettings();
  const documents = new DocumentStore(settings.vaultPath);
  const id = newSessionId(new Date());
  statusMessage = undefined;

  const created = new Date().toISOString();
  const frontmatter: Frontmatter = {
    title: 'untitled',
    created,
    updated: created,
    duration: 0,
    language: settings.language,
    liveModel: settings.liveModelId,
    refineModel: settings.modelId ?? 'none',
    app: `dark-whisper ${app.getVersion()}`,
  };
  const base = id.replace(/^(\d{4})(\d{2})(\d{2})-(\d{4})\d{2}$/, '$1-$2-$3-$4');
  const documentPath = documents.createDocument(uniqueDocumentId(settings.vaultPath, base), frontmatter);

  let ctx: SessionContext | null = null;
  const store = new GuardedStore(documents, () => {
    statusMessage = EXTERNAL_EDIT_MESSAGE;
    ctx?.queue.setAllowed(false);
    emit();
  });
  store.noteWrite(documentPath);

  const service = new SessionService({
    store,
    enqueueRefine: (job) => ctx?.queue.enqueue(job),
    blockMinutes: settings.blockMinutes,
    timestampHeadings: settings.timestampHeadings,
  });

  const queue = new RefineQueue({
    sliceAudio: (job) => (ctx ? sliceAudio(ctx, job) : Promise.resolve(null)),
    transcribe: (wav) => transcribeAudio(wav),
    cleanup: (wav) => fs.rmSync(wav, { force: true }),
    apply: (blockIndex, text) => service.applyRefinement(blockIndex, text),
    report: (event) => {
      if (event.kind === 'failed') {
        statusMessage = `Refinement failed for block ${event.blockIndex}`;
      }
      emit();
    },
  });

  ctx = { id, documentPath, service, queue, store, stopped: false, audioRemoved: false, pausedByApp: false };
  current = ctx;
  queue.setAllowed(refinementAllowed(ctx));
  service.begin({ id, documentPath });
  service.onInfo(() => emit());

  const device = settings.captureDeviceName
    ? lastDevices.find((d) => d.name === settings.captureDeviceName)
    : undefined;
  if (settings.captureDeviceName && !device) {
    statusMessage = `Microphone "${settings.captureDeviceName}" not found — using the default device`;
  }

  // The first poll reports the current mute state, so a session started muted begins paused.
  micMute.start();
  try {
    await startLiveEngine({ sessionId: id, captureId: device?.index ?? null, deviceName: device?.name });
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
  stopLiveEngine();
  micMute.stop();
  const unmute = ctx.pausedByApp;
  ctx.service.end();
  ctx.stopped = true;
  emit();
  if (unmute) {
    await micMute.setMuted(false).catch((error) => console.error('Could not unmute the microphone:', error));
  }
  void settle(ctx);
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
  current.service.segment(segment);
  const blockIndex = current.service.getInfo().blockIndex;
  for (const l of segmentListeners) l({ text: segment.text, blockIndex });
});
// SoX keeps recording across engine relaunches, so the audio timeline stays continuous and
// only the document needs a gap marker, which sessionService writes from its own launch count.
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
