// Reset the password of an admin (or any user) directly on the server PC.
// Run with RESET-Admin-Password.bat - you type the new password yourself.
const readline = require('readline');
const { db, hashPassword } = require('./db');

const tty = !!process.stdin.isTTY;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
const clean = (a) => String(a).replace(/^﻿/, '').replace(/\r$/, '');
const ask = (q, hidden = false) => new Promise((resolve) => {
  if (!hidden || !tty) return rl.question(q, (a) => resolve(hidden ? clean(a) : clean(a).trim()));
  // hide typed characters for the password
  const write = rl._writeToOutput;
  rl._writeToOutput = (s) => { if (s.includes(q)) write.call(rl, s); else write.call(rl, '*'); };
  rl.question(q, (a) => { rl._writeToOutput = write; process.stdout.write('\n'); resolve(clean(a)); });
});

(async () => {
  const admins = db.prepare("SELECT id, username, name, active FROM users WHERE role = 'admin' ORDER BY id").all();
  console.log('\n=== WorkTrack: Reset Password ===\n');
  console.log('Admin accounts:');
  admins.forEach((u) => console.log(`  - ${u.username}  (${u.name})${u.active ? '' : '  [inactive]'}`));
  console.log('');

  const username = (await ask('Username to reset [admin]: ')) || 'admin';
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) { console.log(`\nNo user named "${username}". Nothing changed.`); return rl.close(); }

  const pw = await ask('New password (min 6 characters): ', true);
  if (pw.length < 6) { console.log('\nPassword too short. Nothing changed.'); return rl.close(); }
  const pw2 = await ask('Type the new password again: ', true);
  if (pw !== pw2) { console.log('\nPasswords do not match. Nothing changed.'); return rl.close(); }

  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, active = 1 WHERE id = ?').run(hashPassword(pw), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  console.log(`\nDone! Password for "${user.username}" has been reset. You can log in now.\n`);
  rl.close();
})();
