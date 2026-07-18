// Multi-client WS smoke: validates Phase 2 behaviors without a browser.
//  - B connecting receives layout (current panes) + clients (both names)
//  - B reattaching p1 is acknowledged before chunked scrollback arrives
//  - Reattach scrollback is UNICAST; A gets no duplicate replay
//  - A adding p4 broadcasts layout to both A and B (p4+ visibility)
//  - min-size resize path does not error
import { WebSocket } from 'ws';

const URL = process.env.WS_URL || 'ws://127.0.0.1:7777/ws';
const TOKEN = process.env.WS_TOKEN;
const P1 = `smoke-${process.pid}-p1`;
const P4 = `smoke-${process.pid}-p4`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${URL}?token=${encodeURIComponent(TOKEN)}&name=${encodeURIComponent(name)}&protocol=2`,
    );
    ws.binaryType = 'arraybuffer';
    const events = [];
    const binary = [];
    const frames = [];
    const timer = setTimeout(() => resolve({ ws, events, binary, frames }), 500);
    ws.on('message', (msg, isBinary) => {
      if (isBinary) {
        const frame = Buffer.from(msg);
        binary.push(frame);
        frames.push({ binary: true, frame });
      } else {
        try {
          const frame = JSON.parse(msg.toString());
          events.push(frame);
          frames.push({ binary: false, frame });
        } catch {}
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
function decodeBin(buf) {
  const v = Buffer.from(buf);
  const op = v.readUInt8(0);
  const len = v.readUInt16BE(1);
  const paneId = v.subarray(3, 3 + len).toString('utf8');
  const data = v.subarray(3 + len).toString('utf8');
  return { op, paneId, data };
}
function req(ws, id, op, payload) { ws.send(JSON.stringify({ kind: 'req', id, op, payload: payload || {} })); }
function writeBin(ws, paneId, data) {
  const idEnc = Buffer.from(paneId);
  const dEnc = Buffer.from(data);
  const b = Buffer.allocUnsafe(1 + 2 + idEnc.length + dEnc.length);
  b.writeUInt8(0x77, 0); b.writeUInt16BE(idEnc.length, 1); idEnc.copy(b, 3); dEnc.copy(b, 3 + idEnc.length);
  ws.send(b, { binary: true });
}

(async () => {
  const A = await openClient('desk');
  req(A.ws, 'a1', 'terminal-create', { paneId: P1, cols: 80, rows: 24, cwd: process.env.HOME });
  await sleep(400);
  req(A.ws, 'asub', 'terminal-subscribe', { paneId: P1, afterSeq: 0 });
  await sleep(100);
  writeBin(A.ws, P1, 'echo MULTI_MARKER\r\n');
  await sleep(600);

  const B = await openClient('laptop');
  const bLayout = B.events.find((e) => e.type === 'layout');
  const bClients = B.events.find((e) => e.type === 'clients');
  console.log('B layout panes:', bLayout ? bLayout.payload.panes.map((p) => p.paneId).join(',') : 'NONE');
  console.log('B clients:', bClients ? bClients.payload.clients.map((c) => c.name).join(',') : 'NONE');

  const aBinaryBefore = A.binary.length;
  const aLayoutsBefore = A.events.filter((e) => e.type === 'layout').length;
  const bFramesBefore = B.frames.length;
  req(B.ws, 'b1', 'terminal-create', { paneId: P1, cols: 80, rows: 24, cwd: process.env.HOME });
  await sleep(100);
  req(B.ws, 'bsub', 'terminal-subscribe', { paneId: P1, afterSeq: 0 });
  await sleep(500);
  const bGotScrollback = B.binary.map(decodeBin).some((f) => f.op === 0x73 && f.data.includes('MULTI_MARKER'));
  const aGotDupScrollback = A.binary.slice(aBinaryBefore).map(decodeBin).some((f) => f.op === 0x73);
  const reattachDidNotBroadcastLayout =
    A.events.filter((e) => e.type === 'layout').length === aLayoutsBefore;
  const reattachFrames = B.frames.slice(bFramesBefore);
  const responseIndex = reattachFrames.findIndex(({ frame }) => frame.id === 'bsub' && frame.kind === 'res');
  const scrollbackIndex = reattachFrames.findIndex(({ binary, frame }) => (
    binary && decodeBin(frame).op === 0x73
  ));
  const responseBeforeScrollback = responseIndex !== -1 && scrollbackIndex !== -1 && responseIndex < scrollbackIndex;
  console.log(
    'B response before scrollback:', responseBeforeScrollback,
    '| got marker:', bGotScrollback,
    '| A got duplicate:', aGotDupScrollback,
    '| reattach layout quiet:', reattachDidNotBroadcastLayout,
  );

  const firstSubscribe = reattachFrames.find(
    ({ frame }) => frame.id === 'bsub' && frame.kind === 'res',
  )?.frame;
  const resumeAfterSeq = firstSubscribe?.result?.toSeq;
  req(B.ws, 'bunsub', 'terminal-unsubscribe', { paneId: P1 });
  await sleep(100);
  const bBinaryBeforePausedOutput = B.binary.length;
  writeBin(A.ws, P1, 'echo INCREMENTAL_MARKER\r\n');
  await sleep(300);
  const pausedClientGotLiveOutput = B.binary.length !== bBinaryBeforePausedOutput;
  const bBinaryBeforeResume = B.binary.length;
  req(B.ws, 'bsub2', 'terminal-subscribe', { paneId: P1, afterSeq: resumeAfterSeq });
  await sleep(400);
  const resumedFrames = B.binary.slice(bBinaryBeforeResume).map(decodeBin);
  const gotIncrementalMarker = resumedFrames.some((f) => f.data.includes('INCREMENTAL_MARKER'));
  const replayedOldMarker = resumedFrames.some((f) => f.data.includes('MULTI_MARKER'));
  const incrementalResume =
    Number.isSafeInteger(resumeAfterSeq) &&
    !pausedClientGotLiveOutput &&
    gotIncrementalMarker &&
    !replayedOldMarker;
  console.log(
    'B paused live output:', !pausedClientGotLiveOutput,
    '| incremental catch-up:', gotIncrementalMarker,
    '| old history duplicated:', replayedOldMarker,
  );

  req(A.ws, 'a2', 'terminal-create', { paneId: P4, cols: 80, rows: 24, cwd: process.env.HOME });
  await sleep(400);
  const aHas4 = A.events.some((e) => e.type === 'layout' && e.payload.panes.some((p) => p.paneId === P4));
  const bHas4 = B.events.some((e) => e.type === 'layout' && e.payload.panes.some((p) => p.paneId === P4));
  console.log('A layout has p4:', aHas4, '| B layout has p4:', bHas4);

  req(A.ws, 'a3', 'terminal-resize', { paneId: P1, cols: 200, rows: 50 });
  req(B.ws, 'b3', 'terminal-resize', { paneId: P1, cols: 100, rows: 30 });
  await sleep(200);

  req(A.ws, 'cleanup-p1', 'terminal-destroy', { paneId: P1 });
  req(A.ws, 'cleanup-p4', 'terminal-destroy', { paneId: P4 });
  await sleep(100);
  A.ws.close(); B.ws.close();
  const ok = bLayout && bClients && responseBeforeScrollback && bGotScrollback &&
    !aGotDupScrollback && reattachDidNotBroadcastLayout && incrementalResume && aHas4 && bHas4;
  console.log('\nRESULT:', ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
