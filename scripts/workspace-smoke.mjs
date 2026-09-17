// End-to-end check of the workspace against a throwaway vault:  npm run build && npm run smoke:workspace
// It launches its own app instance under a throwaway --user-data-dir profile (so it never touches
// the real installed app's settings, even while a packaged copy is running and holds the
// single-instance lock), with a copy of the live model dropped into that profile if one is
// installed for the real app. Its window is shown, unfocused, as a small corner at the bottom
// right of the screen while it runs. It never pauses a session (pausing mutes the real microphone), and
// the throwaway profile means the user's own vault setting is never read or restored. The delete
// check sends one small test note to the Recycle Bin.
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { connect } from './dev-cdp.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9334;
const INSPECT_PORT = 9336;
const ROWS = "[...document.querySelectorAll('#libraryBody .row[data-key]')].map((r) => r.dataset.key).join('|')";
const js = (value) => JSON.stringify(value);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-smoke-profile-'));
const liveModelSrc = path.join(process.env.APPDATA ?? '', 'Dark-Whisper', 'models', 'ggml-base.en.bin');
if (fs.existsSync(liveModelSrc)) {
  fs.mkdirSync(path.join(profile, 'models'), { recursive: true });
  fs.copyFileSync(liveModelSrc, path.join(profile, 'models', 'ggml-base.en.bin'));
}

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-smoke-'));
const vaultFile = (rel) => path.join(vault, ...rel.split('/'));
function write(rel, content) {
  fs.mkdirSync(path.dirname(vaultFile(rel)), { recursive: true });
  fs.writeFileSync(vaultFile(rel), content);
}
write('2026-09-01-0900-kickoff.md', '---\ntitle: Kickoff\ncreated: 2026-09-01T09:00:00Z\n---\n\n<!-- dw:block 1 t=0-120 -->\n**2026-09-01 09:00**\nThe quarterly budget\n');
write('Clients/acme.md', 'plain note\n');
write('Notes/multi.md', '---\ntitle: Multi\n---\n\n<!-- dw:block 1 t=0-9 -->\n**10:15**\nalpha first line\nbudget line two\ngamma third line\n');
write('hostile.md', '# Hostile\n\n<img src=x onerror="window.__pwned=1">\n<script>window.__pwned=2</script>\n');
write('remote-image.md', '# Remote\n\n<img src="//127.0.0.1/share/x.png">\n\n![r](//127.0.0.1/share/y.png)\n');
write('smoke-delete-me.md', 'delete me\n');
const today = (() => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const child = spawn(
  electronPath,
  ['.', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT_PORT}`, `--user-data-dir=${profile}`],
  { cwd: repo, stdio: 'ignore' },
);
let app = null;

async function waitFor(expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await app.evaluate(expression).catch(() => undefined);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return value;
}

async function waitForFile(rel, exists = true, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(vaultFile(rel)) === exists) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

const click = (selector) => app.evaluate(`document.querySelector(${js(selector)}).click()`);

// Electron's userData lock/log files can stay open for a moment after the process is
// killed, so a straight rmSync can race a still-closing handle with EPERM. Retry briefly.
function rmDir(dir) {
  const deadline = Date.now() + 5000;
  const wake = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      Atomics.wait(wake, 0, 0, 250);
    }
  }
}

async function answerAsk({ text, choice } = {}) {
  await waitFor("document.getElementById('askDialog').open");
  if (text !== undefined) await app.evaluate(`document.getElementById('askInput').value = ${js(text)}`);
  if (choice !== undefined) await app.evaluate(`document.getElementById('askSelect').value = ${js(choice)}`);
  await click('#askOkBtn');
}

async function menuAction(file, label) {
  await click(`[data-key=${js(`doc:${file}`)}] .row-menu`);
  await app.evaluate(
    `[...document.querySelectorAll('#rowMenu .menu-item')].find((b) => b.textContent === ${js(label)}).click()`,
  );
}

try {
  app = await connect(PORT);
  await waitFor("document.readyState === 'complete' && Boolean(window.api)");
  // Chromium renders nothing for a hidden window with a title bar overlay, and dialogs never
  // report closing. Show the window without focus, with only its corner on screen.
  const main = await connect(INSPECT_PORT, 60, 'node');
  await main.evaluate(`(() => {
    const { BrowserWindow, screen } = process.mainModule.require('electron');
    const win = BrowserWindow.getAllWindows()[0];
    const area = screen.getPrimaryDisplay().workArea;
    win.setPosition(area.x + area.width - 120, area.y + area.height - 120);
    win.showInactive();
  })()`);
  main.close();
  await app.evaluate(`window.api.saveSettings({ vaultPath: ${js(vault)} })`);

  const listed = await waitFor(`(${ROWS}).includes('doc:2026-09-01-0900-kickoff.md') && (${ROWS})`);
  check(
    'the sidebar lists the vault with Quick Notes pinned first',
    Boolean(listed) && listed.startsWith('folder:|folder:Quick Notes|') && listed.includes('folder:Clients') && !listed.includes('doc:Clients/acme.md'),
    listed,
  );
  const counts = await app.evaluate("document.querySelector('[data-key=\"folder:Clients\"] .count')?.textContent");
  check('folders show document counts', counts === '1', counts);
  const recent = await app.evaluate("document.querySelectorAll('#libraryBody .row.recent').length");
  check('recent documents are listed', recent === 5, String(recent));
  const footer = await app.evaluate("document.getElementById('docCount').textContent");
  check('the footer counts documents', footer === '6 documents', footer);

  await click('[data-key="folder:Clients"]');
  check('folders expand', Boolean(await waitFor(`(${ROWS}).includes('doc:Clients/acme.md')`)));

  await app.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))");
  check('Ctrl+K focuses search', await app.evaluate("document.activeElement?.id === 'librarySearch'"));

  await app.evaluate("(() => { const s = document.getElementById('librarySearch'); s.value = 'line two'; s.dispatchEvent(new Event('input')); })()");
  const hit = await waitFor("document.querySelector('#libraryBody .row.hit')?.textContent");
  check('full-text search finds a line', Boolean(hit) && hit.includes('budget line two'), hit);
  await click('#libraryBody .row.hit');
  const marked = await waitFor("document.getElementById('docTitle').textContent === 'Multi' && document.querySelector('#docBody .hit-line')?.textContent.trim()");
  check('a search hit highlights its line only', marked === 'budget line two', marked);
  await app.evaluate("(() => { const s = document.getElementById('librarySearch'); s.value = ''; s.dispatchEvent(new Event('input')); })()");

  await waitFor(`(${ROWS}).includes('doc:2026-09-01-0900-kickoff.md')`);
  await click('[data-key="doc:2026-09-01-0900-kickoff.md"]');
  const margin = await waitFor("document.getElementById('docTitle').textContent === 'Kickoff' && document.querySelector('#docBody .para .time')?.textContent");
  const body = await app.evaluate("document.querySelector('#docBody .para .md').textContent");
  check('clock lines move into the margin', margin === '09:00' && !body.includes('**') && body.includes('quarterly budget'), `${margin} / ${body}`);

  fs.appendFileSync(vaultFile('2026-09-01-0900-kickoff.md'), '\nEdited outside\n');
  check('an outside edit re-renders the document', Boolean(await waitFor("document.getElementById('docBody').textContent.includes('Edited outside')")));

  await click('#fontSizeBtn');
  check('the text size changes', await app.evaluate("document.getElementById('docBody').classList.contains('size-2')"));
  await click('#focusBtn');
  const focused = await app.evaluate("document.getElementById('workspace').classList.contains('focus') && getComputedStyle(document.querySelector('.library')).display === 'none'");
  await app.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  const unfocused = await app.evaluate("!document.getElementById('workspace').classList.contains('focus')");
  check('focus mode hides the side panes and Esc leaves it', focused && unfocused);

  const panel = await app.evaluate("[...document.querySelectorAll('#panelBody .panel-section')].map((s) => s.dataset.section).join(',')");
  check('the panel shows the document section', panel.split(',').includes('document'), panel);
  await click('[data-section="document"] .section-head');
  const collapsed = await app.evaluate("!document.querySelector('[data-section=\"document\"]').classList.contains('open') && !document.querySelector('[data-section=\"document\"] .section-body')");
  await click('[data-section="document"] .section-head');
  check('panel sections collapse and open', collapsed);

  await click('#themeBtn');
  const light = await waitFor("document.documentElement.dataset.theme === 'light' && window.api.getSettings().then((s) => s.theme === 'light')");
  await click('#themeBtn');
  check('the theme switches and is saved', light === true, String(light));

  await click('[data-key="doc:hostile.md"]');
  await waitFor("document.getElementById('docTitle').textContent === 'hostile'");
  const hostile = await app.evaluate(
    "({ pwned: window.__pwned ?? null, scripts: document.querySelectorAll('#docBody script').length, handlers: document.querySelectorAll('#docBody [onerror]').length })",
  );
  check('document HTML is sanitised', hostile.pwned === null && hostile.scripts === 0 && hostile.handlers === 0, js(hostile));

  await app.evaluate(
    "document.addEventListener('securitypolicyviolation', (e) => (window.__cspBlocked ??= []).push(e.blockedURI))",
  );
  await click('[data-key="doc:remote-image.md"]');
  await waitFor("document.getElementById('docTitle').textContent === 'remote-image'");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const remote = await app.evaluate(
    "({ blocked: window.__cspBlocked ?? [], zeroWidth: [...document.querySelectorAll('#docBody img')].every((img) => img.naturalWidth === 0) })",
  );
  check('remote and UNC images are blocked', remote.blocked.length > 0 && remote.zeroWidth, js(remote));

  await click('[data-key="folder:"]');
  await click('#vaultMenuBtn');
  await app.evaluate("[...document.querySelectorAll('#rowMenu .menu-item')].find((b) => b.textContent === 'New folder…').click()");
  await answerAsk({ text: 'Archive' });
  check('a folder can be created from the vault menu', (await waitForFile('Archive')) && Boolean(await waitFor(`(${ROWS}).includes('folder:Archive')`)));

  await menuAction('Clients/acme.md', 'Move to…');
  await answerAsk({ choice: 'Archive' });
  check('a document can be moved', (await waitForFile('Archive/acme.md')) && !fs.existsSync(vaultFile('Clients/acme.md')));

  await click('[data-key="doc:2026-09-01-0900-kickoff.md"]');
  await waitFor("document.getElementById('docTitle').textContent === 'Kickoff'");
  await click('#docRenameBtn');
  await answerAsk({ text: 'Team kickoff' });
  const renamed = (await waitForFile('2026-09-01-0900-team-kickoff.md')) && (await waitFor("document.getElementById('docTitle').textContent === 'Team kickoff'"));
  check('a document can be renamed and stays selected', Boolean(renamed));

  await menuAction('smoke-delete-me.md', 'Delete');
  await answerAsk();
  check('a document can be deleted', await waitForFile('smoke-delete-me.md', false));

  // Recording checks. Never Pause: it mutes the real microphone.
  await click('#quickNoteBtn');
  const quick = await waitFor(
    "window.api.getSessionStatus().then((s) => (s.state === 'recording' || s.state === 'error') && s)",
    20000,
  );
  if (!quick || quick.state !== 'recording') {
    check('a quick note starts', false, quick ? quick.message ?? quick.state : 'did not start');
  } else {
    check('a quick note records into today\'s file', quick.kind === 'quick-note' && quick.documentFile === `Quick Notes/${today}.md`, quick.documentFile);
    const shown = await waitFor(
      `document.getElementById('docTitle').textContent === ${js(today)} && !document.getElementById('liveBadge').hidden && document.getElementById('quickNoteBtn').classList.contains('active') && document.getElementById('recordBtn').disabled`,
    );
    check('the quick note is shown live and Record is disabled', Boolean(shown));
    const refused = await app.evaluate("window.api.startSession({ kind: 'session', folder: '' }).then(() => 'started', (e) => e.message)");
    check('a session cannot start during a quick note', refused.includes('Stop the quick note'), refused);
    await click('#quickNoteBtn');
    const stopped = await waitFor("window.api.getSessionStatus().then((s) => s.state === 'stopped')");
    check('the quick note stops', Boolean(stopped));
    const dayFile = fs.readFileSync(vaultFile(`Quick Notes/${today}.md`), 'utf8');
    check('the day file has its date as title', dayFile.startsWith(`---\ntitle: ${today}\n`), dayFile.slice(0, 40));
  }

  await click('[data-key="folder:Archive"]');
  await click('#recordBtn');
  const status = await waitFor(
    "window.api.getSessionStatus().then((s) => s.kind === 'session' && (s.state === 'recording' || s.state === 'error') && s)",
    20000,
  );
  if (!status || status.state !== 'recording') {
    check('a session starts in the selected folder', false, status ? status.message ?? status.state : 'did not start');
  } else {
    check('a session starts in the selected folder', status.folder === 'Archive' && status.documentFile.startsWith('Archive/'), status.documentFile);
    const live = await waitFor(
      "document.getElementById('docTitle').textContent === 'untitled' && document.querySelectorAll('#libraryBody .rec-dot').length === 1 && !document.getElementById('liveBadge').hidden",
    );
    check('the session document is shown live', Boolean(live));
    const refused = await app.evaluate(
      `window.api.renameDocument(${js(status.documentFile)}, 'x').then(() => 'renamed', (e) => e.message)`,
    );
    check('the recording document cannot be renamed', refused.includes('being recorded'), refused);
    check('the panel shows the session and its paragraphs', Boolean(await waitFor("document.getElementById('panelBody').textContent.includes('Blocks (0)')")));
    await click('#stopBtn');
    const stopped = await waitFor("window.api.getSessionStatus().then((s) => s.state === 'stopped')");
    check('the session stops', Boolean(stopped));
  }
} catch (error) {
  check('smoke run completed', false, error instanceof Error ? error.message : String(error));
} finally {
  app?.close();
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  else child.kill();
  for (const dir of [vault, profile]) {
    try {
      rmDir(dir);
    } catch (error) {
      console.warn(`Could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

console.log(failures.length === 0 ? '\nAll workspace checks passed.' : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
