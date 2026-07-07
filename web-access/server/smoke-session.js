// CLI smoke test for SessionManager persistence (no WS / no browser needed).
// Validates: create spawns (reattached:false) → write produces output →
// create-again REATTACHES (reattached:true) and replays scrollback.
import { SessionManager } from './session-manager.js';
import { loadPty } from './pty-loader.js';
import { decodeBinary, BIN_WRITE, BIN_SCROLLBACK } from './protocol.js';

const config = {
  staticRoot: process.env.VIBE99_STATIC_ROOT || '/mnt/FAST/Vibe99',
  defaultCwd: process.env.HOME,
  scrollbackCapBytes: 524288,
  maxSessions: 16,
};
const pty = loadPty({ staticRoot: config.staticRoot });

const binaryFrames = [];
const sessions = new SessionManager({
  pty,
  config,
  broadcast: (frame) => {
    if (typeof frame !== 'string') binaryFrames.push(frame);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARKER = 'vibe99-web-persistence-test';

(async () => {
  console.log('1) create p1 →', sessions.createTerminal({ paneId: 'p1', cols: 80, rows: 24, cwd: config.defaultCwd }));
  await sleep(400);
  sessions.write('p1', `echo ${MARKER}\r\n`);
  await sleep(700);

  const dataFrames = binaryFrames.map(decodeBinary).filter((f) => f.op === BIN_WRITE);
  const sawMarker = dataFrames.some((f) => f.data.includes(MARKER));
  console.log(`   terminal-data frames: ${dataFrames.length} | marker seen: ${sawMarker}`);

  binaryFrames.length = 0;
  console.log('2) create p1 again →', sessions.createTerminal({ paneId: 'p1', cols: 80, rows: 24 }));
  await sleep(150);
  const replay = binaryFrames.map(decodeBinary).filter((f) => f.op === BIN_SCROLLBACK);
  const replayHasMarker = replay.some((f) => f.data.includes(MARKER));
  console.log(`   scrollback replay frames: ${replay.length} | replay has marker: ${replayHasMarker}`);

  sessions.destroy('p1');
  const ok = sawMarker && replayHasMarker;
  console.log(`\n3) persistence ${ok ? 'OK ✓' : 'FAILED ✗'}`);
  process.exit(ok ? 0 : 1);
})();
