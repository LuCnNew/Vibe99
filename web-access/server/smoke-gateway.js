import { RealtimeGateway } from './gateway.js';
import { encodeBinary, encodeEvent, BIN_WRITE } from './protocol.js';

const sessions = {
  setBroadcastSink() {},
  listSessions() { return []; },
  resize() {},
  createTerminal({ paneId }) {
    return { paneId, reattached: true, outputSeq: 12 };
  },
  getOutputSince() {
    return {
      reset: false,
      fromSeq: 0,
      toSeq: 12,
      chunks: [{ seq: 0, data: Buffer.from('legacy-history') }],
    };
  },
};
const gateway = new RealtimeGateway({
  config: {},
  auth: {},
  sessions,
  settings: {},
  concurrency: {},
});

function makeClient(id, bufferedAmount = 0) {
  const sent = [];
  const ws = {
    readyState: 1,
    bufferedAmount,
    send(frame, options) { sent.push({ frame, binary: options?.binary === true }); },
    close() {},
  };
  const client = {
    ws,
    id,
    name: id,
    sizes: new Map(),
    protocolVersion: 2,
    subscriptions: new Map([['p1', 1]]),
    bulkQueue: [],
    bulkBytes: 0,
    bulkScheduled: false,
    bulkTimer: null,
  };
  gateway._clients.set(id, client);
  return { client, sent };
}

const ordered = makeClient('ordered');
gateway._enqueueBulk(
  ordered.client,
  encodeBinary(BIN_WRITE, 'p1', 'last-output'),
  'p1',
  1,
);
gateway._broadcast(
  encodeEvent('terminal-exit', { paneId: 'p1', exitCode: 0 }),
  { paneId: 'p1', ordered: true },
);

const switched = makeClient('switched');
gateway._enqueueBulk(
  switched.client,
  encodeBinary(BIN_WRITE, 'p1', 'droppable-output'),
  'p1',
  1,
);
gateway._broadcast(
  encodeEvent('terminal-exit', { paneId: 'p1', exitCode: 0 }),
  { paneId: 'p1', ordered: true },
);
gateway._onMessage(
  switched.client,
  Buffer.from(JSON.stringify({
    kind: 'req',
    id: 'unsub',
    op: 'terminal-unsubscribe',
    payload: { paneId: 'p1' },
  })),
  false,
);

const slow = makeClient('slow', 999999);
for (let i = 0; i < 5; i += 1) {
  gateway._enqueueBulk(slow.client, Buffer.alloc(1024 * 1024), 'p1', 1);
}

const legacy = makeClient('legacy');
legacy.client.protocolVersion = 1;
legacy.client.subscriptions.clear();
gateway._onMessage(
  legacy.client,
  Buffer.from(JSON.stringify({
    kind: 'req',
    id: 'legacy-create',
    op: 'terminal-create',
    payload: { paneId: 'p1', cols: 80, rows: 24 },
  })),
  false,
);
gateway._broadcast(
  encodeBinary(BIN_WRITE, 'p1', 'legacy-live'),
  { paneId: 'p1' },
);

await new Promise((resolve) => setTimeout(resolve, 30));

const eventType = (entry) => {
  if (entry.binary) return 'binary';
  try { return JSON.parse(String(entry.frame)).type || 'response'; } catch { return 'text'; }
};
const orderedTypes = ordered.sent.map(eventType);
const switchedTypes = switched.sent.map(eventType);
const slowTypes = slow.sent.map(eventType);
const legacyTypes = legacy.sent.map(eventType);

const orderedExit = orderedTypes[0] === 'binary' && orderedTypes[1] === 'terminal-exit';
const exitSurvivesUnsubscribe =
  !switchedTypes.includes('binary') &&
  switchedTypes.includes('terminal-exit');
const slowClientBounded =
  slow.client.bulkBytes === 0 &&
  !slow.client.subscriptions.has('p1') &&
  slowTypes.includes('terminal-resync-required');
const legacyCompatible =
  legacyTypes[0] === 'response' &&
  legacyTypes.filter((type) => type === 'binary').length === 2;

const ok = orderedExit && exitSurvivesUnsubscribe && slowClientBounded && legacyCompatible;
console.log(JSON.stringify({
  orderedTypes,
  switchedTypes,
  slowTypes,
  legacyTypes,
  orderedExit,
  exitSurvivesUnsubscribe,
  slowClientBounded,
  legacyCompatible,
  result: ok ? 'PASS' : 'FAIL',
}, null, 2));

process.exit(ok ? 0 : 1);
