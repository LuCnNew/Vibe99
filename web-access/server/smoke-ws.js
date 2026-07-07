// End-to-end WS smoke test (no browser): auth reject on wrong token, and on
// the right token a full create->write->receive-terminal-data round trip.
import { WebSocket } from 'ws';

const URL = process.env.WS_URL || 'ws://127.0.0.1:7777/ws';
const TOKEN = process.env.WS_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(token, settleMs = 600, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const ws = new WebSocket(`${URL}?token=${encodeURIComponent(token)}`);
    ws.binaryType = 'arraybuffer';
    const hard = setTimeout(() => {
      if (!done) { done = true; try { ws.close(); } catch {} resolve({ ok: false, code: null, reason: 'timeout' }); }
    }, timeoutMs);
    // Server may close POST-handshake (auth reject 4401): settle briefly after
    // open before trusting the connection as established.
    ws.on('open', () => {
      setTimeout(() => { if (!done) { done = true; clearTimeout(hard); resolve({ ok: true, ws }); } }, settleMs);
    });
    ws.on('close', (code) => { if (!done) { done = true; clearTimeout(hard); resolve({ ok: false, code, reason: 'closed' }); } });
    ws.on('error', (e) => { if (!done) { done = true; clearTimeout(hard); resolve({ ok: false, code: null, reason: e.message }); } });
  });
}

function decodeBin(buf) {
  const view = Buffer.from(buf);
  const op = view.readUInt8(0);
  const len = view.readUInt16BE(1);
  const paneId = view.subarray(3, 3 + len).toString('utf8');
  const data = view.subarray(3 + len).toString('utf8');
  return { op, paneId, data };
}

(async () => {
  const bad = await connect('wrong-token');
  console.log('1) wrong token ->', bad.ok ? 'OPENED (unexpected!)' : `rejected code=${bad.code}`);
  const authOk = !bad.ok && bad.code === 4401;

  const good = await connect(TOKEN);
  if (!good.ok) { console.log('2) right token connect FAILED:', good.reason); process.exit(1); }
  const ws = good.ws;
  const marker = 'WSMARKER' + Math.random().toString(36).slice(2, 8);
  const received = [];
  ws.on('message', (msg, isBinary) => {
    if (isBinary) received.push(decodeBin(msg));
  });

  ws.send(JSON.stringify({ kind: 'req', id: 't1', op: 'terminal-create', payload: { paneId: 'p1', cols: 80, rows: 24, cwd: process.env.HOME } }));
  await sleep(500);
  const idEnc = Buffer.from('p1');
  const dEnc = Buffer.from(`echo ${marker}\r\n`);
  const buf = Buffer.allocUnsafe(1 + 2 + idEnc.length + dEnc.length);
  buf.writeUInt8(0x77, 0);
  buf.writeUInt16BE(idEnc.length, 1);
  idEnc.copy(buf, 3);
  dEnc.copy(buf, 3 + idEnc.length);
  ws.send(buf, { binary: true });
  await sleep(700);

  const saw = received.some((f) => f.data.includes(marker));
  console.log(`2) right token: create+write -> marker in terminal-data: ${saw}`);
  ws.close();

  const ok = authOk && saw;
  console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'} (auth=${authOk}, data=${saw})`);
  process.exit(ok ? 0 : 1);
})();
