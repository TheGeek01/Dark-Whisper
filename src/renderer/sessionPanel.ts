import type { BlockEvent } from '../shared/api.js';
import { frontmatterRows, parseDocument } from './documentView.js';
import { byId, el } from './dom.js';
import { formatClock } from './format.js';
import { openDocument } from './library.js';
import { BLOCK_LABELS, isSessionRunning, sessionSummary } from './sessionModel.js';
import { getState, subscribe, update } from './state.js';

const COLLAPSED_KEY = 'dark-whisper.panelCollapsed';

function details(rows: [string, string][]): HTMLElement {
  const list = el('dl', 'details');
  for (const [label, value] of rows) list.append(el('dt', '', label), el('dd', '', value));
  return list;
}

function jumpToBlock(index: number): void {
  const file = getState().session.status?.documentFile;
  if (!file) return;
  if (getState().selectedFile !== file) openDocument(file);
  update({ scrollToBlock: index });
}

function blockList(blocks: readonly BlockEvent[]): HTMLElement {
  if (blocks.length === 0) return el('p', 'muted', 'No blocks yet');
  const list = el('ol', 'blocks');
  for (const block of blocks) {
    const item = el('li', `block-row ${block.state}`);
    item.append(
      el('span', 'num', String(block.blockIndex)),
      el('span', 'range', `${formatClock(block.startSec)}–${formatClock(block.endSec)}`),
      el('span', `badge ${block.state}`, BLOCK_LABELS[block.state]),
    );
    if (block.message) item.append(el('div', 'msg', block.message));
    item.addEventListener('click', () => jumpToBlock(block.blockIndex));
    list.append(item);
  }
  return list;
}

function renderPanel(): void {
  const { session, document, selectedFile } = getState();
  const status = session.status;
  const nodes: HTMLElement[] = [];

  if (status && status.sessionId) {
    const mic = status.muted === true ? `${status.microphone} (muted)` : status.microphone;
    nodes.push(
      el('h2', '', 'Session'),
      details([
        ['State', sessionSummary(status)],
        ['Microphone', mic],
        ['Live model', status.liveModel],
        ['Refine model', status.refineModel],
        ['Folder', status.folder || 'Vault root'],
        ['Waiting to refine', String(status.refining)],
      ]),
      el('h2', '', 'Blocks'),
      blockList(session.blocks),
    );
  }

  if (status && status.messages.length > 0) {
    const list = el('ul', 'messages');
    for (const message of status.messages) list.append(el('li', '', message));
    nodes.push(el('h2', '', 'Messages'), list);
  }

  const showsLiveDocument = status !== null && isSessionRunning(status) && status.documentFile === selectedFile;
  if (document && document.file === selectedFile && !showsLiveDocument) {
    const rows = frontmatterRows(parseDocument(document.content).frontmatter);
    nodes.push(
      el('h2', '', 'Document'),
      rows.length > 0 ? details(rows.map((row) => [row.label, row.value])) : el('p', 'muted', 'No details recorded'),
    );
  }

  if (nodes.length === 0) nodes.push(el('p', 'muted', 'No session yet.'));
  byId('panelBody').replaceChildren(...nodes);
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function setCollapsed(collapsed: boolean): void {
  byId('workspace').classList.toggle('panel-collapsed', collapsed);
  const toggle = byId('panelToggleBtn');
  toggle.textContent = collapsed ? '⟨' : '⟩';
  toggle.title = collapsed ? 'Show the panel' : 'Hide the panel';
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage unavailable: the choice lasts for this window only.
  }
}

export function initSessionPanel(): void {
  setCollapsed(readCollapsed());
  byId('panelToggleBtn').addEventListener('click', () => {
    setCollapsed(!byId('workspace').classList.contains('panel-collapsed'));
  });
  subscribe((_state, changed) => {
    if (changed.has('session') || changed.has('document') || changed.has('selectedFile')) renderPanel();
  });
  renderPanel();
}
