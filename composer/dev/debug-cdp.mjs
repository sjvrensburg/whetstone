// Throwaway diagnostic driver: drives headless Chrome over CDP, loads the
// harper debug page, waits for it to print DONE, and dumps the log + console.
import { spawn } from 'node:child_process';

const PORT = 9333;
const URL_TO_TEST = process.argv[2] ?? 'http://localhost:5199/dev/debug-harper.html';

const chrome = spawn(
  'google-chrome',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/ws-debug-profile',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('chrome did not come up');
}

try {
  const target = await getTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let id = 0;
  const pending = new Map();
  const consoleLines = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      consoleLines.push(`[console.${msg.params.type}] ${args}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleLines.push(
        `[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`,
      );
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL_TO_TEST });

  let text = '';
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const res = await send('Runtime.evaluate', {
      expression: 'document.getElementById("out")?.textContent ?? "(no out)"',
      returnByValue: true,
    });
    text = res?.result?.value ?? '';
    if (text.includes('DONE')) break;
  }

  console.log('=== page log ===');
  console.log(text);
  console.log('=== console ===');
  console.log(consoleLines.join('\n') || '(none)');
  ws.close();
} finally {
  chrome.kill('SIGKILL');
}
