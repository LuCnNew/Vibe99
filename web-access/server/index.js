import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { loadPty } from './pty-loader.js';
import { AuthN } from './auth.js';
import { ConcurrencyCoordinator } from './concurrency.js';
import { SessionManager } from './session-manager.js';
import { SettingsStore } from './settings-store.js';
import { RealtimeGateway } from './gateway.js';
import { logger } from './logger.js';

function main() {
  const homeConfigPath = path.join(os.homedir(), '.config', 'vibe99-web', 'config.json');
  const localConfigPath = path.join(process.cwd(), 'config.json');
  const configPath = process.env.VIBE99_WEB_CONFIG ||
    (fs.existsSync(homeConfigPath) ? homeConfigPath : localConfigPath);
  const config = loadConfig(configPath);
  logger.info(`config loaded from ${configPath}`);

  const pty = loadPty({ staticRoot: config.staticRoot });
  const auth = new AuthN({ token: config.token });
  const concurrency = new ConcurrencyCoordinator();
  const settings = new SettingsStore({ settingsFile: config.settingsFile });
  const sessions = new SessionManager({ pty, config, broadcast: null });
  const gateway = new RealtimeGateway({ config, auth, sessions, settings, concurrency });
  gateway.listen();

  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${sig}; shutting down (all sessions will be killed)`);
    gateway.close();
    sessions.destroyAll();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
