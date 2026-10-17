// Builds "Portable\WorkTrack-Portable.zip": a ready-to-run copy of WorkTrack for ANY Windows PC.
// It includes its own Node.js (runtime\node.exe), so the other PC needs NO Node.js, Python or install.
// The package is FRESH: it contains no employees, tasks or passwords from this office.
//   default login on first start:  admin / admin@123  (must be changed at first login)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = __dirname;
const OUT_ROOT = path.join(APP, 'Portable');
const NAME = 'WorkTrack-Portable';
const out = path.join(OUT_ROOT, NAME);
const zip = path.join(OUT_ROOT, `${NAME}.zip`);

const ITEMS = [
  'server.js', 'db.js', 'backup.js', 'reset-password.js', 'package.json', 'package-lock.json', 'README.md',
  'START-TaskManager.bat', 'STOP-WorkTrack.bat', 'INSTALL-Desktop-Shortcut.bat', 'RESET-Admin-Password.bat',
  'BACKUP-Now.bat', 'SETUP-Daily-Backup.bat', 'public', 'desktop', 'employee-setup', 'node_modules',
];

fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(zip, { force: true });
fs.mkdirSync(path.join(out, 'runtime'), { recursive: true });

for (const item of ITEMS) {
  const src = path.join(APP, item);
  if (!fs.existsSync(src)) continue;
  // never ship this office's logo-less build tools or data; logo.png is kept if you added one
  fs.cpSync(src, path.join(out, item), { recursive: true, filter: (s) => !s.endsWith('make-icon.js') });
}

// bundled Node.js runtime = the same node.exe that is running this script
fs.copyFileSync(process.execPath, path.join(out, 'runtime', 'node.exe'));
fs.writeFileSync(path.join(out, 'runtime', 'NOTICE.txt'),
  `node.exe is Node.js ${process.version} (MIT License, https://github.com/nodejs/node/blob/main/LICENSE).\r\n` +
  'It is included so WorkTrack runs without installing anything.\r\n');

// one-click start file at the top level
fs.writeFileSync(path.join(out, 'Open WorkTrack.bat'), [
  '@echo off',
  'cd /d "%~dp0"',
  'start "" "%WINDIR%\\System32\\wscript.exe" "%~dp0desktop\\WorkTrack.vbs"',
  '',
].join('\r\n'));

fs.writeFileSync(path.join(out, 'READ-ME-FIRST.txt'), [
  'WorkTrack - Office Task Manager  (portable version)',
  '====================================================',
  '',
  'NOTHING TO INSTALL. No Node.js, no Python needed - everything is inside this folder.',
  '',
  'START (on the PC that will be the office server)',
  '  1. Right-click the zip -> "Extract All..." (do not run it from inside the zip).',
  '     Put the folder somewhere permanent, e.g. C:\\WorkTrack or Desktop.',
  '  2. Double-click  "Open WorkTrack.bat".',
  '     - If Windows Firewall asks, click "Allow access" (so other PCs can connect).',
  '     - If Windows shows "Windows protected your PC", click "More info" -> "Run anyway".',
  '  3. First login:  username  admin   password  admin@123',
  '     You will be asked to set your own admin password immediately.',
  '  4. Optional: double-click INSTALL-Desktop-Shortcut.bat  -> WorkTrack icon on the Desktop.',
  '  5. Optional: double-click SETUP-Daily-Backup.bat         -> automatic backup every evening.',
  '',
  'OTHER EMPLOYEES',
  '  They do not need this zip. On their PC they open Chrome/Edge and go to',
  '  http://<server-PC-IP>:3000   (the address is written in data\\server.log after start).',
  '',
  'TOOLS IN THIS FOLDER',
  '  Open WorkTrack.bat          start WorkTrack and open its window',
  '  STOP-WorkTrack.bat          stop the server',
  '  BACKUP-Now.bat              make a backup now (saved in "Backup folder")',
  '  RESET-Admin-Password.bat    forgot the admin password',
  '',
  'Requirements: Windows 10 or 11 (64-bit).',
  '',
].join('\r\n'));

console.log('Creating zip (this can take a minute)...');
execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
  `Compress-Archive -LiteralPath '${out.replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -CompressionLevel Optimal -Force`], { stdio: 'inherit' });
console.log(`\nPortable package ready:\n  ${zip}  (${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)`);
