// Throwaway diagnostic: drives the real app's Coach flow headlessly with a
// pre-stored zai config (key from Z_AI_API_KEY) and reports panel/console.
import { spawn } from 'node:child_process';

const PORT = 9335;
const APP = process.argv[2] ?? 'http://localhost:5199/#debug-coach';
const KEY = process.env.Z_AI_API_KEY;
if (!KEY) throw new Error('Z_AI_API_KEY not set');

const chrome = spawn(
  'google-chrome',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/ws-debug-profile-3',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(
        (t) => t.type === 'page',
      );
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
  const logs = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type !== 'debug') {
      logs.push(
        `[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`,
      );
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(
        `[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`,
      );
    }
    if (msg.method === 'Network.responseReceived' && msg.params.response.url.includes('z.ai')) {
      logs.push(`[network] ${msg.params.response.status} ${msg.params.response.url}`);
    }
    if (msg.method === 'Network.loadingFailed') {
      logs.push(`[network-failed] ${msg.params.errorText} (${msg.params.requestId})`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const evaluate = async (expression) =>
    (
      await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    )?.result?.value;

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');

  await send('Page.navigate', { url: APP });
  await sleep(2000);

  // Store coach config BEFORE the app boot path that reads it on click.
  await evaluate(
    `localStorage.setItem('whetstone.coach', JSON.stringify({ provider: 'zai', apiKey: ${JSON.stringify(KEY)}, consentedAt: new Date().toISOString() })); 'stored'`,
  );
  await send('Page.reload');
  await sleep(2500);

  await evaluate(`
    const input = document.querySelector('.ws-claim-form input');
    if (input) { input.value = 'Friction beats detection.'; document.querySelector('.ws-claim-form').requestSubmit(); }
    'gate-done'
  `);
  await sleep(500);

  await evaluate(`document.querySelector('.cm-content').focus(); 'focused'`);
  await send('Input.insertText', {
    text:
      'Universities respond to AI writing tools mostly with detection software, but detection ' +
      'is a losing race. The tools improve faster than the detectors, and false accusations ' +
      'hurt honest students more than cheaters.',
  });
  await sleep(500);

  console.log('clicking Coach…');
  await evaluate(`document.getElementById('coach-btn').click(); 'clicked'`);

  let panel = '';
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    panel = await evaluate(
      `document.getElementById('coach-results')?.textContent ?? document.querySelector('.ws-coach-host')?.textContent ?? ''`,
    );
    if (panel.trim().length > 0) break;
  }

  console.log('=== coach panel ===');
  console.log(panel || '(empty)');

  // Chat flow
  await evaluate(`
    const ta = document.querySelector('.ws-chat-form textarea');
    ta.value = 'What is the weakest part of my argument so far?';
    document.querySelector('.ws-chat-form').requestSubmit();
    'chat-sent'
  `);
  let chat = '';
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    chat = await evaluate(
      `[...document.querySelectorAll('.ws-chat-msg')].map(m => m.className.replace(/ws-chat-msg ws-chat-/, '') + ': ' + m.textContent).join('\\n---\\n')`,
    );
    if (chat && !chat.endsWith('…')) break;
  }
  console.log('=== chat ===');
  console.log(chat || '(empty)');

  console.log('=== console/network ===');
  console.log(logs.join('\n') || '(clean)');
  ws.close();
} finally {
  chrome.kill('SIGKILL');
}
