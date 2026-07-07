import path from 'node:path';
import { createRequire } from 'node:module';

// node-pty ships a prebuilt native binary downloaded from GitHub at install
// time — flaky on this host. Instead we reuse the already-installed copy from
// the Vibe99 project tree (config.staticRoot/node_modules), same package &
// version Vibe99 uses. Returns the node-pty module.
export function loadPty({ staticRoot } = {}) {
  const base = staticRoot ?? process.cwd();
  const require = createRequire(path.join(base, 'package.json'));
  return require('@homebridge/node-pty-prebuilt-multiarch');
}
