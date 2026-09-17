// Dev helper: evaluate an expression in the running app's window over the DevTools protocol.
//   npx electron . --remote-debugging-port=9333
//   node scripts/dev-cdp.mjs "window.api.getSessionStatus()"
import { pathToFileURL } from 'url';

// type 'page' is the app window; 'node' is the main process when Electron runs with --inspect=<port>.
export async function connect(port = 9333, attempts = 60, type = 'page') {
  let targets = [];
  for (let i = 0; i < attempts; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.some((t) => t.type === type)) break;
    } catch {
      // The app is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const page = targets.find((t) => t.type === type);
  if (!page) throw new Error(`No ${type} target on port ${port}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (message) => {
    const data = JSON.parse(message.data);
    const done = pending.get(data.id);
    if (done) {
      pending.delete(data.id);
      done(data);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  return {
    async evaluate(expression) {
      const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      const details = reply.result?.exceptionDetails;
      if (details) throw new Error(details.exception?.description ?? details.text);
      return reply.result?.result?.value;
    },
    close() {
      ws.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await connect();
  try {
    console.log(JSON.stringify(await app.evaluate(process.argv[2]), null, 2));
  } finally {
    app.close();
  }
}
