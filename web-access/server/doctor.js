import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig } from './config.js';
import { loadPty } from './pty-loader.js';

const defaultConfigPath = path.join(os.homedir(), '.config', 'vibe99-web', 'config.json');
const configPath = process.env.VIBE99_WEB_CONFIG || defaultConfigPath;

const checks = [];

function pass(label, detail = '') {
  checks.push({ ok: true, label, detail });
}

function fail(label, detail = '') {
  checks.push({ ok: false, label, detail });
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major === 22) pass('Node version', process.version);
  else fail('Node version', `${process.version}; expected Node 22`);
}

function checkFile(label, filePath) {
  if (fs.existsSync(filePath)) pass(label, filePath);
  else fail(label, `${filePath} not found`);
}

function checkPackage(staticRoot) {
  const require = createRequire(path.join(staticRoot, 'package.json'));
  for (const pkg of ['@xterm/xterm', '@xterm/addon-fit', '@homebridge/node-pty-prebuilt-multiarch']) {
    try {
      const pkgJson = require.resolve(`${pkg}/package.json`);
      pass(`dependency ${pkg}`, pkgJson);
    } catch (e) {
      fail(`dependency ${pkg}`, e.message);
    }
  }
}

function checkPty(staticRoot) {
  try {
    const pty = loadPty({ staticRoot });
    if (typeof pty.spawn === 'function') pass('node-pty load', '@homebridge/node-pty-prebuilt-multiarch');
    else fail('node-pty load', 'module loaded but spawn is missing');
  } catch (e) {
    fail('node-pty load', e.message);
  }
}

function checkPort(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('listening', () => {
      server.close(() => {
        pass('port availability', `${host}:${port} can be bound`);
        resolve();
      });
    });
    server.once('error', (e) => {
      fail('port availability', `${host}:${port}: ${e.code || e.message}`);
      resolve();
    });
    server.listen(port, host);
  });
}

async function main() {
  checkNode();

  let config = null;
  try {
    config = loadConfig(configPath);
    pass('config', configPath);
  } catch (e) {
    fail('config', `${configPath}: ${e.message}`);
  }

  if (config) {
    checkFile('renderer', path.join(config.staticRoot, 'src', 'renderer.js'));
    checkFile('styles', path.join(config.staticRoot, 'src', 'styles.css'));
    checkFile('root package', path.join(config.staticRoot, 'package.json'));
    checkPackage(config.staticRoot);
    checkPty(config.staticRoot);
    await checkPort(config.host, config.port);
  }

  for (const check of checks) {
    console.log(`${check.ok ? 'OK  ' : 'FAIL'} ${check.label}${check.detail ? ` - ${check.detail}` : ''}`);
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    console.log(`\n${failed.length} check(s) failed. Run npm run setup if config is missing.`);
    process.exit(1);
  }

  console.log('\nAll checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
