// Makes a complete, restorable backup of WorkTrack into "Backup folder":
//   WorkTrack-Backup-YYYY-MM-DD_HH-MM/
//     app/   -> frontend (public), backend (server.js, db.js), tools, launcher
//     app/data/taskmanager.db -> safe snapshot of all data (taken while the app is running)
//     RESTORE-GUIDE.txt, checksums.txt
//   + the same as a .zip (easy to copy to a pendrive / Google Drive)
// Keeps the newest 30 backups and removes older ones.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const APP = __dirname;
const BACKUP_ROOT = path.join(APP, 'Backup folder');
const KEEP = 30;

// Files and folders that make up the app (node_modules is re-installed on restore, logs are not needed)
const ITEMS = [
  'server.js', 'db.js', 'features.js', 'upgrades.js', 'backup.js', 'reset-password.js', 'package.json', 'package-lock.json', 'README.md',
  'START-TaskManager.bat', 'STOP-WorkTrack.bat', 'INSTALL-Desktop-Shortcut.bat', 'RESET-Admin-Password.bat', 'BACKUP-Now.bat', 'SETUP-Daily-Backup.bat',
  'public', 'desktop', 'employee-setup', 'make-portable.js', 'MAKE-Portable-Zip.bat',
];

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
const name = `WorkTrack-Backup-${stamp}`;
const out = path.join(BACKUP_ROOT, name);
const appOut = path.join(out, 'app');

fs.mkdirSync(path.join(appOut, 'data'), { recursive: true });

// 1. app files
for (const item of ITEMS) {
  const src = path.join(APP, item);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(appOut, item), { recursive: true });
}

// 2. database snapshot - VACUUM INTO writes a clean, consistent copy even while the server is running
const dbFile = path.join(APP, 'data', 'taskmanager.db');
const dbOut = path.join(appOut, 'data', 'taskmanager.db');
if (fs.existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile);
  db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
  db.close();
  // quick integrity check of the snapshot
  const check = new DatabaseSync(dbOut, { readOnly: true });
  const ok = check.prepare('PRAGMA integrity_check').get();
  const counts = {
    users: check.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    tasks: check.prepare('SELECT COUNT(*) AS c FROM tasks').get().c,
  };
  check.close();
  if (Object.values(ok)[0] !== 'ok') throw new Error('Database snapshot failed the integrity check');
  console.log(`Database saved: ${counts.users} users, ${counts.tasks} tasks (integrity OK)`);
}

// 3. restore guide
fs.writeFileSync(path.join(out, 'RESTORE-GUIDE.txt'), [
  'WorkTrack - Office Task Manager : BACKUP',
  `Created: ${now.toLocaleString('en-IN')}`,
  '',
  'WHAT IS INSIDE',
  '  app\\public\\            -> frontend (screens, design, icons)',
  '  app\\server.js, db.js, features.js, upgrades.js -> backend (rules, ratings, security, database, history, requests)',
  '  app\\data\\taskmanager.db -> ALL your data: employees, tasks, comments, leave, ratings',
  '  app\\*.bat              -> start / stop / install / reset password / backup tools',
  '',
  'HOW TO RESTORE (on the same or a new PC)',
  '  1. Install Node.js 22 or newer from https://nodejs.org (skip if already installed).',
  '  2. Copy the "app" folder to where you want WorkTrack (e.g. Desktop) and rename it if you like.',
  '  3. Double-click INSTALL-Desktop-Shortcut.bat  (first time it downloads the needed parts - needs internet once).',
  '  4. Double-click the WorkTrack icon on the Desktop. Log in with your usual admin username and password.',
  '',
  'ONLY THE DATA IS DAMAGED?',
  '  Run STOP-WorkTrack.bat, then copy app\\data\\taskmanager.db from this backup over the one in your',
  '  WorkTrack\\data folder (delete taskmanager.db-wal and taskmanager.db-shm there if present), then start again.',
  '',
  'SECURITY',
  '  - Passwords are stored only as secure hashes (scrypt); nobody can read them, not even from this backup.',
  '  - Still, this backup contains office data. Keep it on a safe pendrive / private Drive, not on shared PCs.',
  '  - checksums.txt lets you confirm no file was changed: run VERIFY in PowerShell with Get-FileHash.',
  '',
].join('\r\n'));

// 4. checksums for every file (detects damaged or tampered copies)
const lines = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name !== 'checksums.txt') lines.push(`${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}  ${path.relative(out, p)}`);
  }
})(out);
fs.writeFileSync(path.join(out, 'checksums.txt'), lines.join('\r\n') + '\r\n');

// 5. zip copy
const zip = `${out}.zip`;
try {
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -LiteralPath '${out.replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -Force`], { stdio: 'ignore' });
} catch { console.log('(Zip could not be created - the folder backup is still complete.)'); }

// 6. keep only the newest backups
const old = fs.readdirSync(BACKUP_ROOT).filter((n) => /^WorkTrack-Backup-[\d_-]+$/.test(n)).sort().reverse().slice(KEEP);
for (const n of old) {
  fs.rmSync(path.join(BACKUP_ROOT, n), { recursive: true, force: true });
  fs.rmSync(path.join(BACKUP_ROOT, `${n}.zip`), { force: true });
}

console.log(`Backup ready:\n  ${out}\n  ${zip}`);
