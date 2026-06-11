// Throwaway diagnostic: drives the real app headlessly — claim gate → type a
// bad sentence → assert grammar underlines appear.
import { spawn } from 'node:child_process';

const PORT = 9334;
const APP = process.argv[2] ?? 'http://localhost:5199/#debug-grammar';

const chrome = spawn(
  'google-chrome',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/ws-debug-profile-2',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const page = (await res.json()).find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      /* retry */
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
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type !== 'debug') {
      consoleLines.push(
        `[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`,
      );
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
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: APP });
  await sleep(2500);

  // Claim gate
  console.log('gate visible:', await evaluate(`!!document.querySelector('.ws-claim-overlay')`));
  await evaluate(`
    const input = document.querySelector('.ws-claim-form input');
    input.value = 'A debug claim about grammar.';
    document.querySelector('.ws-claim-form').requestSubmit();
    'submitted'
  `);
  await sleep(500);

  // Type a sentence with errors into CodeMirror
  await evaluate(`document.querySelector('.cm-content').focus(); 'focused'`);
  await send('Input.insertText', { text: 'She were going too the libary yesterday.' });

  // Wait out lint delay + worker setup, polling for underlines
  let report = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    report = await evaluate(`({
      doc: document.querySelector('.cm-content')?.textContent ?? '',
      lintRanges: document.querySelectorAll('.cm-lintRange').length,
      infoRanges: document.querySelectorAll('.cm-lintRange-info').length,
    })`);
    if (report.lintRanges > 0) break;
  }

  console.log('doc text:', JSON.stringify(report.doc));
  console.log('lint ranges:', report.lintRanges, '| info ranges:', report.infoRanges);
  console.log('console:', consoleLines.join('\n') || '(clean)');
  console.log(report.lintRanges > 0 ? 'UNDERLINES OK' : 'NO UNDERLINES');
  ws.close();
} finally {
  chrome.kill('SIGKILL');
}
