// Database layer - uses Node's built-in SQLite (no extra install needed)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const db = new DatabaseSync(path.join(DATA_DIR, 'taskmanager.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'employee',   -- admin | employee
  department    TEXT DEFAULT '',
  designation   TEXT DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT DEFAULT '',
  category        TEXT DEFAULT '',
  priority        TEXT NOT NULL DEFAULT 'medium',   -- urgent | high | medium | low
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | on_hold | completed
  start_time      TEXT,
  expected_end    TEXT NOT NULL,
  actual_end      TEXT,
  paused_at       TEXT,
  paused_minutes  REAL NOT NULL DEFAULT 0,
  delay_reason    TEXT DEFAULT '',
  reason_status   TEXT NOT NULL DEFAULT 'none',     -- none | pending | accepted | rejected
  admin_note      TEXT DEFAULT '',
  parent_task_id  INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  assigned_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_logged_at TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type     TEXT NOT NULL,
  note     TEXT DEFAULT '',
  at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- when each user last read the comments of a task (for unread badges)
CREATE TABLE IF NOT EXISTS comment_reads (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (user_id, task_id)
);

-- pop-up alerts for a user (e.g. "admin assigned you a task")
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  read_at    TEXT
);

-- leave days (user_id set) and office holidays (user_id NULL = everyone); day = local YYYY-MM-DD
CREATE TABLE IF NOT EXISTS leaves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  type       TEXT NOT NULL,          -- leave | half_day | holiday
  note       TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notif_user  ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_leaves_day  ON leaves(day);
CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user   ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_events_task  ON task_events(task_id);
`);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(String(pw), salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === calc.length && crypto.timingSafeEqual(calc, known);
}

// v1: passwords set by admin are final - clear the old "must change at login" flag once
if (db.prepare('PRAGMA user_version').get().user_version < 1) {
  db.exec('UPDATE users SET must_change_password = 0; PRAGMA user_version = 1;');
}
// v2: remember why a task is on hold (shown on the task card)
if (db.prepare('PRAGMA user_version').get().user_version < 2) {
  db.exec("ALTER TABLE tasks ADD COLUMN hold_reason TEXT DEFAULT ''; PRAGMA user_version = 2;");
}
// v3: tasks left running are stopped automatically at the end of the day (auto_paused = 1 until reviewed)
if (db.prepare('PRAGMA user_version').get().user_version < 3) {
  db.exec(`ALTER TABLE tasks ADD COLUMN auto_paused INTEGER NOT NULL DEFAULT 0;
           CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
           INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_stop_time', '20:00');
           PRAGMA user_version = 3;`);
}

// First run: create the admin account (password must be changed at first login)
const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
if (!adminExists) {
  db.prepare(`INSERT INTO users (name, username, password_hash, role, designation, must_change_password, created_at)
              VALUES (?, ?, ?, 'admin', 'Administrator', 1, ?)`)
    .run('Administrator', 'admin', hashPassword('admin@123'), new Date().toISOString());
  console.log('Default admin created  ->  username: admin   password: admin@123  (change it at first login)');
}

module.exports = { db, hashPassword, verifyPassword };
