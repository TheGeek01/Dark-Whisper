import type { BlockEvent } from '../shared/api.js';
import {
  absolutePath,
  clockParts,
  documentTitle,
  hitNeedle,
  lineIndexContaining,
  mergeLiveText,
  parseDocument,
  partIndexForLine,
  plainText,
  type DocumentPart,
} from './documentView.js';
import { byId, el } from './dom.js';
import { initLevelMeter } from './levelMeter.js';
import { recordingFile, renameDocument } from './library.js';
import { BLOCK_LABELS, clearPendingText, isSessionRunning } from './sessionModel.js';
import { getState, subscribe, update, type AppState } from './state.js';
import { reportError, toast } from './toast.js';

const FOLLOW_THRESHOLD_PX = 40;
const FONT_SIZE_KEY = 'dark-whisper.fontSize';
const FONT_SIZES = 3;
const DEFAULT_FONT_SIZE = 1;
const LINE_BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th';

let readSeq = 0;
let shownFile: string | null = null;
let follow = true;
let readError: string | null = null;
let refinedSignature = '';
let wasRunning = false;
let wasSessionDocument = false;
let fontSize = DEFAULT_FONT_SIZE;

function isLiveDocument(): boolean {
  const file = getState().selectedFile;
  return file !== null && file === recordingFile();
}

// The selected document belongs to the current run (recording, or stopped and still refining).
function isSessionDocument(): boolean {
  const { selectedFile, session } = getState();
  return selectedFile !== null && session.status !== null && session.status.documentFile === selectedFile;
}

async function loadDocument(): Promise<void> {
  const file = getState().selectedFile;
  const seq = ++readSeq;
  if (!file) {
    readError = null;
    update({ document: null });
    return;
  }
  try {
    const document = await window.api.readDocument(file);
    if (seq !== readSeq) return;
    readError = null;
    const session = isLiveDocument() ? clearPendingText(getState().session) : getState().session;
    update({ document, session });
  } catch (error) {
    if (seq !== readSeq) return;
    readError = error instanceof Error ? error.message : String(error);
    update({ document: null });
  }
}

// The only innerHTML in the renderer: marked output, always sanitised first.
function renderMarkdown(target: HTMLElement, markdown: string): void {
  target.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true, breaks: true }));
}

function renderPart(part: DocumentPart, blocks: readonly BlockEvent[], liveIndex: number | null, isLastOfLive: boolean): HTMLElement {
  if (part.kind === 'gap') {
    const gap = el('div', 'gap', 'recording interrupted');
    gap.dataset.line = String(part.line);
    return gap;
  }
  const row = el('section', part.kind === 'block' ? 'para' : 'para intro');
  row.dataset.line = String(part.line);
  const margin = el('div', 'margin');
  if (part.kind === 'block') {
    row.dataset.block = String(part.index);
    row.classList.toggle('live', part.index === liveIndex);
    if (!part.continued) {
      const { date, time } = clockParts(part.clock);
      if (time) {
        const stamp = el('div', 'time', time);
        stamp.title = date ? `${date} ${time}` : time;
        margin.append(stamp);
      }
      // A refined paragraph is the normal end state: only other states are worth a badge.
      const event = blocks.find((b) => b.blockIndex === part.index);
      if (event && event.state !== 'refined') {
        const badge = el('span', `badge ${event.state}`, BLOCK_LABELS[event.state]);
        if (event.message) badge.title = event.message;
        margin.append(badge);
      }
    }
  }
  const content = el('div', 'md');
  renderMarkdown(content, part.markdown);
  if (part.kind === 'block' && part.index === liveIndex && isLastOfLive) content.append(el('span', 'cursor', '▌'));
  row.append(margin, content);
  return row;
}

function setBarVisible(visible: boolean): void {
  byId('docRenameBtn').hidden = !visible;
  byId('docToolbar').hidden = !visible;
}

function currentParts(): DocumentPart[] {
  const { document, session } = getState();
  if (!document) return [];
  const parts = parseDocument(document.content).parts;
  return isLiveDocument() ? mergeLiveText(parts, session.pendingText, session.blocks) : parts;
}

function renderDocument(): void {
  const { selectedFile, document, session, tree } = getState();
  const body = byId('docBody');
  const title = byId('docTitle');
  const jump = byId('jumpLiveBtn');
  const live = selectedFile !== null && isLiveDocument();
  byId('liveBadge').hidden = !live;
  byId('levelMeter').hidden = !live;

  if (!selectedFile) {
    title.textContent = 'Select a document';
    setBarVisible(false);
    jump.hidden = true;
    const hint = tree && tree.exists && tree.documents.length === 0 ? 'Start a session or a quick note to begin.' : '';
    body.replaceChildren(el('p', 'empty-state', hint));
    return;
  }
  if (!document || document.file !== selectedFile) {
    setBarVisible(false);
    jump.hidden = true;
    if (readError) {
      title.textContent = selectedFile;
      body.replaceChildren(el('p', 'error-state', `Could not open this document: ${readError}`));
    } else {
      title.textContent = 'Loading…';
      body.replaceChildren();
    }
    return;
  }

  const parsed = parseDocument(document.content);
  const parts = currentParts();
  const blocks = isSessionDocument() ? session.blocks : [];
  const liveIndex = live && session.status ? session.status.blockIndex : null;
  const lastOfLive = liveIndex === null ? -1 : parts.map((p) => p.kind === 'block' && p.index === liveIndex).lastIndexOf(true);

  const previousTop = body.scrollTop;
  title.textContent = documentTitle(parsed.frontmatter, document.file);
  setBarVisible(true);
  body.replaceChildren(...parts.map((part, i) => renderPart(part, blocks, liveIndex, i === lastOfLive)));

  if (live && follow) body.scrollTop = body.scrollHeight;
  else body.scrollTop = previousTop;
  jump.hidden = !live || follow;
  applyPendingScroll(parts);
}

function flash(target: Element | null): void {
  if (!target) return;
  target.scrollIntoView({ block: 'start' });
  target.classList.remove('flash');
  void (target as HTMLElement).offsetWidth; // restart the animation
  target.classList.add('flash');
}

// With breaks: true, one paragraph holds several source lines separated by <br>.
function lineGroups(block: Element): Node[][] {
  const groups: Node[][] = [[]];
  for (const node of [...block.childNodes]) {
    if (node.nodeName === 'BR') groups.push([]);
    else groups[groups.length - 1].push(node);
  }
  return groups.filter((group) => group.length > 0);
}

// Wraps the rendered line that holds the search match, or returns null.
function highlightLine(section: Element, needle: string): HTMLElement | null {
  const content = section.querySelector('.md');
  if (!content) return null;
  for (const block of content.querySelectorAll(LINE_BLOCKS)) {
    const groups = lineGroups(block);
    const index = lineIndexContaining(
      groups.map((group) => group.map((node) => node.textContent ?? '').join('')),
      needle,
    );
    if (index === -1) continue;
    const nodes = groups[index];
    const span = el('span', 'hit-line');
    nodes[0].parentNode?.insertBefore(span, nodes[0]);
    span.append(...nodes);
    return span;
  }
  return null;
}

function applyPendingScroll(parts: DocumentPart[]): void {
  const { scrollToLine, scrollToBlock, document } = getState();
  if (scrollToLine === null && scrollToBlock === null) return;
  const body = byId('docBody');
  follow = false;
  if (scrollToLine !== null) {
    const index = partIndexForLine(parts, scrollToLine);
    const section = index === -1 ? null : body.children[index];
    const needle = document ? hitNeedle(document.content, scrollToLine) : '';
    const line = section ? highlightLine(section, needle) : null;
    if (line) line.scrollIntoView({ block: 'center' });
    else flash(section ?? body.firstElementChild);
  } else {
    flash(body.querySelector(`[data-block="${scrollToBlock}"]`));
  }
  // Clear after this render so the scroll happens once.
  setTimeout(() => update({ scrollToLine: null, scrollToBlock: null }), 0);
}

function onStateChange(state: AppState, changed: ReadonlySet<keyof AppState>): void {
  if (changed.has('selectedFile') && state.selectedFile !== shownFile) {
    shownFile = state.selectedFile;
    follow = true;
    readError = null;
    wasSessionDocument = isSessionDocument();
    void loadDocument();
  }
  let sessionRelevant = false;
  if (changed.has('session')) {
    const running = isSessionRunning(state.session.status);
    const signature = state.session.blocks
      .filter((b) => b.state === 'refined')
      .map((b) => b.blockIndex)
      .join(',');
    const stoppedNow = wasRunning && !running;
    const isDoc = isSessionDocument();
    // Render on a session change only when the open document is, or just was, the session
    // document: unrelated notes must not lose the reader's text selection.
    sessionRelevant = isDoc || wasSessionDocument;
    if (isDoc && (signature !== refinedSignature || stoppedNow)) void loadDocument();
    refinedSignature = signature;
    wasRunning = running;
    wasSessionDocument = isDoc;
  }
  if (
    changed.has('document') ||
    changed.has('selectedFile') ||
    (changed.has('session') && sessionRelevant) ||
    // The tree only affects the empty-state hint text, which only shows with nothing selected.
    (changed.has('tree') && state.selectedFile === null) ||
    (changed.has('scrollToLine') && state.scrollToLine !== null) ||
    (changed.has('scrollToBlock') && state.scrollToBlock !== null)
  ) {
    renderDocument();
  }
}

function onScroll(): void {
  if (!isLiveDocument()) return;
  const body = byId('docBody');
  follow = body.scrollHeight - body.scrollTop - body.clientHeight < FOLLOW_THRESHOLD_PX;
  byId('jumpLiveBtn').hidden = follow;
}

function readFontSize(): number {
  try {
    const raw = window.localStorage.getItem(FONT_SIZE_KEY);
    const size = raw === null ? DEFAULT_FONT_SIZE : Number(raw);
    return Number.isInteger(size) && size >= 0 && size < FONT_SIZES ? size : DEFAULT_FONT_SIZE;
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

function applyFontSize(size: number): void {
  fontSize = size;
  const body = byId('docBody');
  for (let i = 0; i < FONT_SIZES; i++) body.classList.toggle(`size-${i}`, i === size);
  try {
    window.localStorage.setItem(FONT_SIZE_KEY, String(size));
  } catch {
    // Storage unavailable: the size lasts for this window only.
  }
}

function setFocusMode(on: boolean): void {
  byId('workspace').classList.toggle('focus', on);
  byId('focusBtn').title = on ? 'Leave focus mode (Esc)' : 'Focus mode';
}

export function initDocument(): void {
  applyFontSize(readFontSize());
  initLevelMeter();
  byId('docRenameBtn').addEventListener('click', () => {
    const { selectedFile, tree } = getState();
    const doc = tree?.documents.find((d) => d.file === selectedFile);
    if (!doc) return;
    if (doc.file === recordingFile()) {
      toast('Stop recording before renaming this document.');
      return;
    }
    renameDocument(doc).catch(reportError);
  });
  byId('docCopyBtn').addEventListener('click', () => {
    window.api.copyText(plainText(currentParts())).then(() => toast('Text copied'), reportError);
  });
  byId('docCopyPathBtn').addEventListener('click', () => {
    const { selectedFile, tree } = getState();
    if (!selectedFile || !tree) return;
    window.api.copyText(absolutePath(tree.root, selectedFile)).then(() => toast('Path copied'), reportError);
  });
  byId('docOpenBtn').addEventListener('click', () => {
    const file = getState().selectedFile;
    if (file) window.api.openDocumentExternally(file).catch(reportError);
  });
  byId('fontSizeBtn').addEventListener('click', () => applyFontSize((fontSize + 1) % FONT_SIZES));
  byId('focusBtn').addEventListener('click', () => setFocusMode(!byId('workspace').classList.contains('focus')));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.querySelector('dialog[open]')) setFocusMode(false);
  });
  byId('jumpLiveBtn').addEventListener('click', () => {
    follow = true;
    const body = byId('docBody');
    body.scrollTop = body.scrollHeight;
    byId('jumpLiveBtn').hidden = true;
  });
  byId('docBody').addEventListener('scroll', onScroll);
  window.api.onLibraryChanged(({ paths }) => {
    const file = getState().selectedFile;
    if (file && !isLiveDocument() && (paths.length === 0 || paths.includes(file))) void loadDocument();
  });
  subscribe(onStateChange);
  renderDocument();
}
