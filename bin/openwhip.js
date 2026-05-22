#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const invokedAs = path.basename(process.argv[1] || '');
if (invokedAs === 'badclaude' || invokedAs === 'badclaude.cmd') {
  console.warn('[DEPRECATED] "badclaude" has been renamed to "openwhip".');
  console.warn('Please run: npm install -g openwhip');
}

const args = process.argv.slice(2);
if (args.includes('--stats') || args.includes('-s')) {
  const pkg = require('../package.json');
  let dataDir;
  if (process.platform === 'win32') {
    dataDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), pkg.name);
  } else if (process.platform === 'darwin') {
    dataDir = path.join(os.homedir(), 'Library', 'Application Support', pkg.name);
  } else {
    dataDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), pkg.name);
  }
  const statsFile = path.join(dataDir, 'stats.json');
  let stats;
  try {
    stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  } catch {
    console.log('No stats yet. Crack the whip first!');
    process.exit(0);
  }
  console.log(`Total cracks: ${stats.crackCount || 0}\n`);
  const entries = Object.entries(stats.appStats || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length > 0) {
    console.log('Cracks by app:');
    for (const [app, count] of entries) {
      console.log(`  ${app.padEnd(32)} ${count}`);
    }
  }
  process.exit(0);
}

let electronBinary;
try {
  electronBinary = require('electron');
} catch (e) {
  console.error('Could not load Electron. Try: npm install -g openwhip');
  process.exit(1);
}

const appPath = path.resolve(__dirname, '..');

const child = spawn(electronBinary, [appPath], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});

child.on('error', (err) => {
  console.error('Failed to start openwhip:', err.message);
  process.exit(1);
});

child.unref();
