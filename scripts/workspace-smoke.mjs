// End-to-end check of the workspace against a throwaway vault:  npm run build && npm run smoke:workspace
// It launches its own app instance under a throwaway --user-data-dir profile (so it never touches
// the real installed app's settings, even while a packaged copy is running and holds the
// single-instance lock), with a copy of the live model dropped into that profile if one is
// installed for the real app. It never pauses a session (pausing mutes the real microphone), and
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
const ROWS = "[...document.querySelectorAll('#libraryBody .row')].map((r) => r.dataset.key).join('|')";
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
write('2026-09-01-0900-kickoff.md', '---\ntitle: Kickoff\ncreated: 2026-09-01T09:00:00Z\n---\n\n<!-- dw:block 1 t=0-120 -->\nThe quarterly budget\n');
write('Clients/acme.md', 'plain note\n');
write('hostile.md', '# Hostile\n\n<img src=x onerror="window.__pwned=1">\n<script>window.__pwned=2</script>\n');
write('smoke-delete-me.md', 'delete me\n');

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const child = spawn(
  electronPath,
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`],
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
  await app.evaluate(`window.api.saveSettings({ vaultPath: ${js(vault)} })`);

  const listed = await waitFor(`(${ROWS}).includes('doc:2026-09-01-0900-kickoff.md') && (${ROWS})`);
  check('library lists the vault', Boolean(listed) && listed.includes('folder:Clients') && !listed.includes('doc:Clients/acme.md'), listed);

  await click('[data-key="folder:Clients"]');
  check('folders expand', Boolean(await waitFor(`(${ROWS}).includes('doc:Clients/acme.md')`)));

  await app.evaluate("(() => { const s = document.getElementById('librarySearch'); s.value = 'budget'; s.dispatchEvent(new Event('input')); })()");
  const hit = await waitFor("document.querySelector('#libraryBody .row.hit')?.textContent");
  check('full-text search finds a line', Boolean(hit) && hit.includes('The quarterly budget'), hit);
  await app.evaluate("(() => { const s = document.getElementById('librarySearch'); s.value = ''; s.dispatchEvent(new Event('input')); })()");

  await waitFor(`(${ROWS}).includes('doc:2026-09-01-0900-kickoff.md')`);
  await click('[data-key="doc:2026-09-01-0900-kickoff.md"]');
  const caption = await waitFor("document.getElementById('docTitle').textContent === 'Kickoff' && document.querySelector('#docBody .caption')?.textContent");
  check('a document opens with its blocks', Boolean(caption) && caption.startsWith('Block 1'), caption);

  fs.appendFileSync(vaultFile('2026-09-01-0900-kickoff.md'), '\nEdited outside\n');
  check('an outside edit re-renders the document', Boolean(await waitFor("document.getElementById('docBody').textContent.includes('Edited outside')")));

  await click('[data-key="doc:hostile.md"]');
  await waitFor("document.getElementById('docTitle').textContent === 'hostile'");
  const hostile = await app.evaluate(
    "({ pwned: window.__pwned ?? null, scripts: document.querySelectorAll('#docBody script').length, handlers: document.querySelectorAll('#docBody [onerror]').length })",
  );
  check('document HTML is sanitised', hostile.pwned === null && hostile.scripts === 0 && hostile.handlers === 0, js(hostile));

  await click('[data-key="folder:"]');
  await click('#newFolderBtn');
  await answerAsk({ text: 'Archive' });
  check('a folder can be created', (await waitForFile('Archive')) && Boolean(await waitFor(`(${ROWS}).includes('folder:Archive')`)));

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

  await click('[data-key="folder:Archive"]');
  await click('#sessionStartBtn');
  const status = await waitFor(
    "window.api.getSessionStatus().then((s) => (s.state === 'recording' || s.state === 'error') && s)",
    20000,
  );
  if (!status || status.state !== 'recording') {
    check('a session starts in the selected folder', false, status ? status.message ?? status.state : 'did not start');
  } else {
    check('a session starts in the selected folder', status.folder === 'Archive' && status.documentFile.startsWith('Archive/'), status.documentFile);
    const live = await waitFor(
      "document.getElementById('docTitle').textContent === 'untitled' && document.querySelectorAll('#libraryBody .rec-dot').length === 1 && document.querySelector('#docBody .caption')?.textContent",
    );
    check('the session document is shown live', Boolean(live) && live.includes('live'), live);
    const refused = await app.evaluate(
      `window.api.renameDocument(${js(status.documentFile)}, 'x').then(() => 'renamed', (e) => e.message)`,
    );
    check('the recording document cannot be renamed', refused.includes('being recorded'), refused);
    check('the session panel shows the blocks', Boolean(await waitFor("document.getElementById('panelBody').textContent.includes('Blocks')")));
    await click('#sessionStopBtn');
    const stopped = await waitFor("window.api.getSessionStatus().then((s) => s.state === 'stopped' && s.blocks[0]?.state)");
    check('the session stops', Boolean(stopped), stopped);
  }
} catch (error) {
  check('smoke run completed', false, error instanceof Error ? error.message : String(error));
} finally {
  app?.close();
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  else child.kill();
  rmDir(vault);
  rmDir(profile);
}

console.log(failures.length === 0 ? '\nAll workspace checks passed.' : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
