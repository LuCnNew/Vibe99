#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const webAccessRoot = path.join(repoRoot, 'web-access');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const args = process.argv.slice(2);
const skipInstall = args.includes('--skip-install');
const skipDoctor = args.includes('--skip-doctor');
const setupArgs = args.filter((arg) => arg !== '--skip-install' && arg !== '--skip-doctor');

function run(command, commandArgs, cwd) {
  console.log(`\n$ ${[command, ...commandArgs].join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function npmInstallArgs(cwd) {
  return fs.existsSync(path.join(cwd, 'package-lock.json')) ? ['ci'] : ['install'];
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 22) {
    console.error(`Node ${process.version} is active, but Vibe99 Web Access expects Node 22.`);
    console.error('Install and activate Node 22 first, for example:');
    console.error('  nvm install 22');
    console.error('  nvm use 22');
    process.exit(1);
  }
}

checkNode();

if (!skipInstall) {
  run(npmCmd, npmInstallArgs(repoRoot), repoRoot);
  run(npmCmd, npmInstallArgs(webAccessRoot), webAccessRoot);
}

run(npmCmd, ['run', 'setup', '--', ...setupArgs], webAccessRoot);

if (!skipDoctor) {
  run(npmCmd, ['run', 'doctor'], webAccessRoot);
}

console.log('\nWeb Access setup finished.');
console.log('Start it with: npm run start:web');
