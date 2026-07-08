import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultStaticRoot = path.resolve(__dirname, '..', '..');
const defaultConfigPath = path.join(os.homedir(), '.config', 'vibe99-web', 'config.json');

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function parsePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 7777;
}

const configPath = process.env.VIBE99_WEB_CONFIG || argValue('--config') || defaultConfigPath;
const force = hasArg('--force');

if (fs.existsSync(configPath) && !force) {
  console.log(`config exists: ${configPath}`);
  console.log('use --force to overwrite it');
  process.exit(0);
}

const token = process.env.VIBE99_WEB_TOKEN || crypto.randomBytes(24).toString('hex');
const staticRoot = process.env.VIBE99_STATIC_ROOT || argValue('--static-root') || defaultStaticRoot;
const port = parsePort(process.env.VIBE99_WEB_PORT || argValue('--port'));
const host = process.env.VIBE99_WEB_HOST || argValue('--host') || '0.0.0.0';
const defaultCwd = process.env.VIBE99_DEFAULT_CWD || argValue('--default-cwd') || os.homedir();
const settingsFile =
  process.env.VIBE99_WEB_SETTINGS ||
  argValue('--settings-file') ||
  path.join(os.homedir(), '.config', 'vibe99-web', 'settings.json');

const config = {
  port,
  host,
  token,
  staticRoot,
  defaultCwd,
  defaultTabTitle: 'Vibe99',
  scrollbackCapBytes: 524288,
  maxSessions: 16,
  settingsFile,
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(`wrote config: ${configPath}`);
console.log(`staticRoot: ${staticRoot}`);
console.log(`token: ${token}`);
console.log(`local URL: http://127.0.0.1:${port}/?token=${token}&name=desk`);
console.log(`remote URL: http://<HOST_IP>:${port}/?token=${token}&name=laptop`);
