import type { BlockEvent } from '../shared/api.js';
import {
  blockCaption,
  documentTitle,
  mergeLiveText,
  parseDocument,
  partIndexForLine,
  plainText,
  type DocumentPart,
} from './documentView.js';
import { byId, el } from './dom.js';
import { recordingFile, renameDocument } from './library.js';
import { BLOCK_LABELS, clearPendingText, isSessionRunning } from './sessionModel.js';
import { getState, subscribe, update, type AppState } from './state.js';
import { reportError, toast } from './toast.js';

const FOLLOW_THRESHOLD_PX = 40;
// Matches .flash's 1.6s CSS animation (public/app.css) so the highlight plays before the
// section is rebuilt; renderDocument() replaces every child on each render, so clearing the
// pending scroll too soon (originally 0ms) destroyed the flashed node before it could be seen.
const FLASH_HOLD_MS = 1700;

let readSeq = 0;
let shownFile: string | null = null;
let follow = true;
let readError: string | null = null;
let refinedSignature = '';
let wasRunning = false;

function isLiveDocument(): boolean {
  const file = getState().selectedFile;
  return file !== null && file === recordingFile();
}

// The selected document belongs to the current session (running, or stopped and still refining).
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
  const section = el('section', part.kind === 'block' ? 'block' : 'intro');
  section.dataset.line = String(part.line);
  if (part.kind === 'block') {
    section.dataset.block = String(part.index);
    if (!part.continued) {
      const caption = el('div', 'caption', blockCaption(part));
      const event = blocks.find((b) => b.blockIndex === part.index);
      if (event) {
        const badge = el('span', `badge ${event.state}`, BLOCK_LABELS[event.state]);
        if (event.message) badge.title = event.message;
        caption.append(badge);
      }
      section.append(caption);
    }
  }
  const content = el('div', 'md');
  renderMarkdown(content, part.markdown);
  if (part.kind === 'block' && part.index === liveIndex && isLastOfLive) content.append(el('span', 'cursor', '▌'));
  section.append(content);
  return section;
}

function setBarVisible(visible: boolean): void {
  for (const id of ['docRenameBtn', 'docCopyBtn', 'docOpenBtn']) byId(id).hidden = !visible;
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

  if (!selectedFile) {
    title.textContent = 'Select a document';
    setBarVisible(false);
    jump.hidden = true;
    const hint = tree && tree.exists && tree.documents.length === 0 ? 'Start a session to begin.' : '';
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
    }
    return;
  }

  const parsed = parseDocument(document.content);
  const live = isLiveDocument();
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

function applyPendingScroll(parts: DocumentPart[]): void {
  const { scrollToLine, scrollToBlock } = getState();
  if (scrollToLine === null && scrollToBlock === null) return;
  const body = byId('docBody');
  follow = false;
  if (scrollToLine !== null) {
    const index = partIndexForLine(parts, scrollToLine);
    flash(index === -1 ? body.firstElementChild : body.children[index]);
  } else {
    flash(body.querySelector(`[data-block="${scrollToBlock}"]`));
  }
  // Clear once the flash has had time to play, so the scroll happens once.
  setTimeout(() => update({ scrollToLine: null, scrollToBlock: null }), FLASH_HOLD_MS);
}

function onStateChange(state: AppState, changed: ReadonlySet<keyof AppState>): void {
  if (changed.has('selectedFile') && state.selectedFile !== shownFile) {
    shownFile = state.selectedFile;
    follow = true;
    readError = null;
    void loadDocument();
  }
  if (changed.has('session')) {
    const running = isSessionRunning(state.session.status);
    const signature = state.session.blocks
      .filter((b) => b.state === 'refined')
      .map((b) => b.blockIndex)
      .join(',');
    const stoppedNow = wasRunning && !running;
    if (isSessionDocument() && (signature !== refinedSignature || stoppedNow)) void loadDocument();
    refinedSignature = signature;
    wasRunning = running;
  }
  if (
    changed.has('document') ||
    changed.has('session') ||
    changed.has('tree') ||
    changed.has('selectedFile') ||
    changed.has('scrollToLine') ||
    changed.has('scrollToBlock')
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

export function initDocument(): void {
  byId('docRenameBtn').addEventListener('click', () => {
    const { selectedFile, tree } = getState();
    const doc = tree?.documents.find((d) => d.file === selectedFile);
    if (!doc) return;
    if (doc.file === recordingFile()) {
      toast('Stop the session before renaming its document.');
      return;
    }
    renameDocument(doc).catch(reportError);
  });
  byId('docCopyBtn').addEventListener('click', () => {
    window.api.copyText(plainText(currentParts())).then(() => toast('Copied'), reportError);
  });
  byId('docOpenBtn').addEventListener('click', () => {
    const file = getState().selectedFile;
    if (file) window.api.openDocumentExternally(file).catch(reportError);
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
