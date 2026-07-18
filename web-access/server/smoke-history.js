import { SessionManager } from './session-manager.js';
import { decodeBinary, BIN_WRITE } from './protocol.js';

let onData = null;
const fakePty = {
  spawn() {
    return {
      onData(handler) { onData = handler; },
      onExit() {},
      write() {},
      resize() {},
      kill() {},
    };
  },
};

const broadcasts = [];
const sessions = new SessionManager({
  pty: fakePty,
  config: {
    defaultCwd: process.cwd(),
    scrollbackCapBytes: 10,
    maxSessions: 2,
  },
  broadcast: (frame, meta) => broadcasts.push({ frame, meta }),
});

sessions.createTerminal({ paneId: 'p1', cols: 80, rows: 24, cwd: process.cwd() });

onData('alpha');
const first = sessions.getOutputSince('p1', 0);
onData('beta');
const second = sessions.getOutputSince('p1', 5);
onData('gamma');
const reset = sessions.getOutputSince('p1', 0);

sessions.destroy('p1');
sessions.createTerminal({ paneId: 'utf8', cols: 80, rows: 24, cwd: process.cwd() });
onData('A你B');
const utf8Reset = sessions.getOutputSince('utf8', 2);

sessions.destroy('utf8');
sessions.createTerminal({ paneId: 'oversized', cols: 80, rows: 24, cwd: process.cwd() });
onData('x'.repeat(10000));
const oversized = sessions.getOutputSince('oversized', 0);

const text = (snapshot) => Buffer.concat(snapshot.chunks.map((chunk) => chunk.data)).toString('utf8');
const decodedBroadcasts = broadcasts
  .filter(({ frame }) => Buffer.isBuffer(frame))
  .map(({ frame, meta }) => ({ ...decodeBinary(frame), paneIdMeta: meta?.paneId }));

const ok =
  !first.reset && first.fromSeq === 0 && first.toSeq === 5 && text(first) === 'alpha' &&
  !second.reset && second.fromSeq === 5 && second.toSeq === 9 && text(second) === 'beta' &&
  reset.reset && reset.fromSeq === 5 && reset.toSeq === 14 && text(reset) === 'betagamma' &&
  utf8Reset.reset && utf8Reset.fromSeq === 4 && text(utf8Reset) === 'B' &&
  oversized.reset && text(oversized).length === 10 &&
  oversized.chunks[0].data.buffer.byteLength < 10000 &&
  decodedBroadcasts.length === 5 &&
  decodedBroadcasts.every(
    (frame) => frame.op === BIN_WRITE && frame.paneIdMeta === frame.paneId,
  );

let exitHandler = null;
const maxedSessions = new SessionManager({
  pty: {
    spawn() {
      return {
        onData() {},
        onExit(handler) { exitHandler = handler; },
        write() {},
        resize() {},
        kill() {},
      };
    },
  },
  config: {
    defaultCwd: process.cwd(),
    scrollbackCapBytes: 1024,
    maxSessions: 1,
  },
});
maxedSessions.createTerminal({ paneId: 'only', cols: 80, rows: 24, cwd: process.cwd() });
exitHandler({ exitCode: 0 });
let respawnAtCapacity = false;
try {
  respawnAtCapacity = !maxedSessions.createTerminal({
    paneId: 'only',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
  }).reattached;
} catch {}

console.log(JSON.stringify({
  first: { reset: first.reset, fromSeq: first.fromSeq, toSeq: first.toSeq, text: text(first) },
  second: { reset: second.reset, fromSeq: second.fromSeq, toSeq: second.toSeq, text: text(second) },
  capped: { reset: reset.reset, fromSeq: reset.fromSeq, toSeq: reset.toSeq, text: text(reset) },
  utf8Boundary: {
    reset: utf8Reset.reset,
    fromSeq: utf8Reset.fromSeq,
    toSeq: utf8Reset.toSeq,
    text: text(utf8Reset),
  },
  oversized: {
    reset: oversized.reset,
    fromSeq: oversized.fromSeq,
    toSeq: oversized.toSeq,
    retainedBytes: oversized.chunks[0].data.length,
    backingBytes: oversized.chunks[0].data.buffer.byteLength,
  },
  broadcasts: decodedBroadcasts.length,
  respawnAtCapacity,
  result: ok && respawnAtCapacity ? 'PASS' : 'FAIL',
}, null, 2));

sessions.destroyAll();
maxedSessions.destroyAll();
process.exit(ok && respawnAtCapacity ? 0 : 1);
