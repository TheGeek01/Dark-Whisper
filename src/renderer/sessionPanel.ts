import type { BlockEvent, SessionStatusView } from '../shared/api.js';
import { documentDetailRows, parseDocument } from './documentView.js';
import { byId, el, icon } from './dom.js';
import { openDocument } from './library.js';
import { BLOCK_LABELS, blockTime, sessionDetailRows, sessionTitle, stateLabel } from './sessionModel.js';
import { getState, subscribe, update } from './state.js';

const COLLAPSED_KEY = 'dark-whisper.panelCollapsed';
const SECTIONS_KEY = 'dark-whisper.panelClosedSections';
const SECTION_IDS = ['session', 'blocks', 'document'] as const;
type SectionId = (typeof SECTION_IDS)[number];

const closedSections = readClosedSections();

function readClosedSections(): Set<SectionId> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SECTIONS_KEY) ?? '[]');
    const list = Array.isArray(parsed) ? parsed : [];
    return new Set(SECTION_IDS.filter((id) => list.includes(id)));
  } catch {
    return new Set();
  }
}

function toggleSection(id: SectionId): void {
  if (closedSections.has(id)) closedSections.delete(id);
  else closedSections.add(id);
  try {
    window.localStorage.setItem(SECTIONS_KEY, JSON.stringify([...closedSections]));
  } catch {
    // Storage unavailable: the choice lasts for this window only.
  }
  renderPanel();
}

function section(id: SectionId, title: string, body: HTMLElement[]): HTMLElement {
  const open = !closedSections.has(id);
  const wrap = el('section', open ? 'panel-section open' : 'panel-section');
  wrap.dataset.section = id;
  const head = el('button', 'section-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open));
  head.append(icon('chevron-down', 'chev'), el('span', 'title', title));
  head.addEventListener('click', () => toggleSection(id));
  wrap.append(head);
  if (open) {
    const content = el('div', 'section-body');
    content.append(...body);
    wrap.append(content);
  }
  return wrap;
}

function details(rows: [string, string | HTMLElement][]): HTMLElement {
  const list = el('dl', 'details');
  for (const [label, value] of rows) {
    const dd = el('dd');
    if (typeof value === 'string') dd.textContent = value;
    else dd.append(value);
    list.append(el('dt', '', label), dd);
  }
  return list;
}

function stateLine(status: SessionStatusView): HTMLElement {
  const line = el('div', 'state-line');
  const tone =
    status.state === 'recording' ? 'rec' : status.state === 'error' ? 'error' : status.state === 'stopped' ? 'idle' : 'busy';
  line.append(el('span', `dot ${tone}`), el('span', '', stateLabel(status)));
  if (status.state === 'recording') {
    const pill = el('span', 'pill');
    pill.append(el('span', 'dot rec'), el('span', '', 'Live'));
    line.append(pill);
  }
  return line;
}

function messageList(messages: readonly string[]): HTMLElement {
  const list = el('ul', 'messages');
  for (const message of messages) list.append(el('li', '', message));
  return list;
}

function jumpToBlock(index: number): void {
  const file = getState().session.status?.documentFile;
  if (!file) return;
  if (getState().selectedFile !== file) openDocument(file);
  update({ scrollToBlock: index });
}

function blockList(blocks: readonly BlockEvent[]): HTMLElement {
  if (blocks.length === 0) return el('p', 'muted', 'No paragraphs yet');
  const list = el('ol', 'blocks');
  for (const block of blocks) {
    const item = el('li', `block-row ${block.state}`);
    item.append(
      el('span', 'num', String(block.blockIndex)),
      el('span', 'range', blockTime(block)),
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
    const body: HTMLElement[] = [details([['State', stateLine(status)], ...sessionDetailRows(status)])];
    if (status.messages.length > 0) body.push(messageList(status.messages));
    nodes.push(section('session', sessionTitle(status), body));
    nodes.push(section('blocks', `Blocks (${session.blocks.length})`, [blockList(session.blocks)]));
  } else if (status && status.messages.length > 0) {
    nodes.push(section('session', 'Messages', [messageList(status.messages)]));
  }

  if (document && document.file === selectedFile) {
    const rows = documentDetailRows(parseDocument(document.content).frontmatter, document.file);
    nodes.push(section('document', 'Document', [details(rows.map((row) => [row.label, row.value]))]));
  }

  if (nodes.length === 0) nodes.push(el('p', 'muted', 'Nothing recorded yet.'));
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
  byId('panelToggleBtn').title = collapsed ? 'Show the panel' : 'Hide the panel';
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
