// Office Task Manager - API server
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { db, hashPassword, verifyPassword } = require('./db');
const features = require('./features'); // history, requests, breaks (shared with the other version)

const PORT = Number(process.env.PORT) || 3000;
const SESSION_HOURS = 12;
const LATE_GRACE_MS = 60 * 1000;
const ARCHIVE_WINDOW_MIN = 30;            // employees can archive a started/finished task this long after adding it            // 1 minute grace before a task counts as late
const PRIORITY_WEIGHT = { urgent: 4, high: 3, medium: 2, low: 1 };
const PRIORITIES = Object.keys(PRIORITY_WEIGHT);
const STATUSES = ['pending', 'in_progress', 'on_hold', 'completed'];

const app = express();
app.disable('x-powered-by');
// When published through a secure tunnel (Cloudflare) the requests arrive from this same PC;
// trusting only the local proxy gives the real visitor IP (needed for the login lock) and HTTPS detection.
app.set('trust proxy', 'loopback');

// Security headers for every response
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------- helpers
const nowISO = () => new Date().toISOString();

function toISO(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(req.user && req.user.role !== 'admin' ? hideRatings(out) : out);
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
};

// Ratings are visible to admin only - strip them from every response sent to employees
const RATING_KEYS = new Set(['score', 'grade', 'stars']);
function hideRatings(v) {
  if (Array.isArray(v)) return v.map(hideRatings);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!RATING_KEYS.has(k)) o[k] = hideRatings(x);
    return o;
  }
  return v;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function notify(userId, type, taskId, title, body = '') {
  db.prepare('INSERT INTO notifications (user_id, type, task_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, type, taskId, title, body, nowISO());
}

// ---- leave / holiday helpers (days are the server PC's local date, YYYY-MM-DD)
const ymd = (d) => { d = new Date(d); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const LEAVE_TYPES = ['leave', 'half_day', 'holiday'];
const FULL_OFF = (l) => l && (l.type === 'leave' || l.type === 'holiday');
// Returns fn(userId, day) -> {type, note} | null for the given date range
function leaveLookup(fromDay, toDay) {
  const rows = db.prepare('SELECT user_id, day, type, note FROM leaves WHERE day >= ? AND day <= ?').all(fromDay, toDay);
  const map = new Map();
  for (const r of rows) {
    const key = `${r.user_id ?? '*'}|${r.day}`;
    if (!map.has(key)) map.set(key, r);
  }
  return (userId, day) => map.get(`*|${day}`) || map.get(`${userId}|${day}`) || null;
}

function logEvent(taskId, userId, type, note = '') {
  db.prepare('INSERT INTO task_events (task_id, user_id, type, note, at) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, userId, type, note, nowISO());
  features.auditTaskEvent(taskId, userId, type, note); // permanent history
}

const publicUser = (u) => u && ({
  id: u.id, name: u.name, username: u.username, role: u.role, department: u.department,
  designation: u.designation, active: !!u.active, must_change_password: !!u.must_change_password,
  created_at: u.created_at,
});

// ---------------------------------------------------------------- auto-stop forgotten tasks
// A task still running at the office closing time (setting "auto_stop_time", default 20:00) is put on hold
// AT that time, so forgotten tasks never keep counting overnight. The employee is then asked when it really finished.
const getSetting = (key, def) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : def; };
// first moment the daily stop time (HH:MM, local) happens after `fromMs`
function nextStopAfter(fromMs, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(fromMs); d.setHours(h, m, 0, 0);
  if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}
let lastAutoStopCheck = 0;
function autoStopForgotten(force = false) {
  const now = Date.now();
  if (!force && now - lastAutoStopCheck < 60000) return;
  lastAutoStopCheck = now;
  const stop = getSetting('auto_stop_time', '20:00');
  if (!/^\d{2}:\d{2}$/.test(stop)) return; // "off"
  const lastRun = db.prepare("SELECT MAX(at) AS at FROM task_events WHERE task_id = ? AND type IN ('started','resumed')");
  for (const t of db.prepare("SELECT * FROM tasks WHERE status = 'in_progress' AND archived_at IS NULL").all()) {
    const runningSince = Math.max(Date.parse(t.start_time), Date.parse(lastRun.get(t.id).at || t.start_time));
    const at = nextStopAfter(runningSince, stop);
    if (now < at) continue;
    const label = new Date(at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
    db.prepare("UPDATE tasks SET status='on_hold', paused_at=?, hold_reason=?, auto_paused=1, updated_at=? WHERE id=?")
      .run(new Date(at).toISOString(), 'Auto-stopped at end of day', nowISO(), t.id);
    logEvent(t.id, null, 'paused', `Auto-stopped at ${label} — it was still running at the end of the day`);
    notify(t.user_id, 'autostop', t.id, 'A task was still running — its clock was stopped',
      `${t.title} · stopped at ${label}. Please tell when you really finished it.`);
  }
  features.closeOpenBreaks(stop);
}
app.use((req, res, next) => { try { autoStopForgotten(); } catch (e) { console.error('auto-stop:', e.message); } next(); });

// ---------------------------------------------------------------- auth middleware
function auth(req, res, next) {
  const token = parseCookies(req).tm_session;
  if (token) {
    const row = db.prepare(`SELECT u.*, s.expires_at AS session_expires_at, s.token AS session_token FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`).get(token, nowISO());
    if (row) {
      req.user = row;
      // a temporary password (set by admin) must be replaced before anything else can be used
      const open = ['/api/me', '/api/me/password', '/api/logout'];
      if (row.must_change_password && !open.includes(req.originalUrl.split('?')[0])) {
        return res.status(403).json({ error: 'Please choose your own password first', must_change_password: true });
      }
      return next();
    }
  }
  res.status(401).json({ error: 'Please log in' });
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access only' });
  next();
}

// ---------------------------------------------------------------- scoring
// Each task gets a 0-100 score:
//  * finished on/before expected end            -> 100
//  * late, delay reason accepted by admin       -> 100
//  * late otherwise                             -> planned time / actual working time (hold time excluded)
//  * late and reason rejected                   -> above minus 10 points
//  * still open but past expected end           -> provisional score the same way (0 if never started)
function enrichTask(t, nowMs = Date.now()) {
  const start = t.start_time ? Date.parse(t.start_time) : null;
  const expected = Date.parse(t.expected_end);
  const planned = start != null ? Math.max(1, (expected - start) / 60000) : null;

  // Hold time stops the clock: the deadline moves forward by the time spent on hold
  let holdMin = t.paused_minutes || 0;
  if (t.status === 'on_hold' && t.paused_at) holdMin += Math.max(0, nowMs - Date.parse(t.paused_at)) / 60000;
  const effExpected = expected + holdMin * 60000;

  let worked = null;
  if (start != null && t.status !== 'pending') {
    const end = t.status === 'completed' ? Date.parse(t.actual_end) : nowMs;
    worked = Math.max(0, (end - start) / 60000 - holdMin);
  }

  const completed = t.status === 'completed';
  const isLate = completed && Date.parse(t.actual_end) > effExpected + LATE_GRACE_MS;
  // a task on hold is never "overdue" - its clock is stopped
  const overdue = !completed && t.status !== 'on_hold' && nowMs > effExpected + LATE_GRACE_MS;

  let score = null;
  const efficiency = () => (worked && planned ? Math.min(100, (planned / Math.max(worked, 0.01)) * 100) : 0);
  if (completed) {
    if (!isLate || t.reason_status === 'accepted' || t.excused) score = 100;
    else {
      score = efficiency();
      if (t.reason_status === 'rejected') score = Math.max(0, score - 10);
    }
  } else if (overdue) {
    score = t.status === 'pending' ? 0 : efficiency();
  }

  return {
    ...t,
    planned_minutes: planned != null ? Math.round(planned) : null,
    worked_minutes: worked != null ? Math.round(worked) : null,
    hold_minutes: Math.round(holdMin),
    effective_expected_end: new Date(effExpected).toISOString(),
    is_late: isLate,
    overdue,
    late_by_minutes: isLate ? Math.round((Date.parse(t.actual_end) - effExpected) / 60000)
      : overdue ? Math.round((nowMs - effExpected) / 60000) : 0,
    score: score != null ? Math.round(score) : null,
    excused: !!t.excused,
  };
}

function gradeFor(score) {
  if (score == null) return { grade: 'No data', stars: 0 };
  if (score >= 90) return { grade: 'Excellent', stars: 5 };
  if (score >= 75) return { grade: 'Good', stars: 4 };
  if (score >= 60) return { grade: 'Average', stars: 3 };
  if (score >= 40) return { grade: 'Needs Improvement', stars: 2 };
  return { grade: 'Poor', stars: 1 };
}

function summarize(tasks) {
  let wSum = 0, wScore = 0, onTime = 0, late = 0, completed = 0, overdueOpen = 0, worked = 0;
  const counts = { pending: 0, in_progress: 0, on_hold: 0, completed: 0 };
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] || 0) + 1;
    if (t.worked_minutes) worked += t.worked_minutes;
    if (t.status === 'completed') {
      completed++;
      if (t.is_late && !t.excused) late++; else onTime++;
    } else if (t.overdue) overdueOpen++;
    if (t.score != null) {
      const w = PRIORITY_WEIGHT[t.priority] || 2;
      wSum += w; wScore += w * t.score;
    }
  }
  const score = wSum ? Math.round(wScore / wSum) : null;
  return {
    score, ...gradeFor(score),
    total: tasks.length, completed, on_time: onTime, late, overdue_open: overdueOpen,
    on_time_rate: completed ? Math.round((onTime / completed) * 100) : null,
    worked_minutes: Math.round(worked),
    counts,
  };
}

// ---------------------------------------------------------------- task queries
function queryTasks(f = {}) {
  const where = [], args = [];
  // archived tasks are left out everywhere (lists, scores, reports); only the admin's "Archived" filter shows them
  where.push(f.status === 'archived' ? 't.archived_at IS NOT NULL' : 't.archived_at IS NULL');
  if (f.user_id) { where.push('t.user_id = ?'); args.push(Number(f.user_id)); }
  if (f.status === 'overdue') {
    where.push("t.status != 'completed' AND t.expected_end < ?"); args.push(new Date(Date.now() - LATE_GRACE_MS).toISOString());
  } else if (f.status === 'active') {
    where.push("t.status IN ('in_progress','on_hold')");
  } else if (f.status && STATUSES.includes(f.status)) {
    where.push('t.status = ?'); args.push(f.status);
  }
  if (f.priority && PRIORITIES.includes(f.priority)) { where.push('t.priority = ?'); args.push(f.priority); }
  if (f.from) { where.push('COALESCE(t.start_time, t.created_at) >= ?'); args.push(toISO(f.from)); }
  if (f.to) { where.push('COALESCE(t.start_time, t.created_at) <= ?'); args.push(toISO(f.to)); }
  if (f.reason_status) { where.push('t.reason_status = ?'); args.push(f.reason_status); }
  if (f.q) {
    where.push('(t.title LIKE ? OR t.description LIKE ? OR t.category LIKE ?)');
    const q = `%${f.q}%`; args.push(q, q, q);
  }
  const sql = `SELECT t.*, u.name AS user_name, u.department AS user_department, a.name AS assigned_by_name,
                      p.title AS parent_title, (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) AS comment_count
               FROM tasks t
               JOIN users u ON u.id = t.user_id
               LEFT JOIN users a ON a.id = t.assigned_by
               LEFT JOIN tasks p ON p.id = t.parent_task_id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY CASE t.status WHEN 'in_progress' THEN 0 WHEN 'on_hold' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
                        COALESCE(t.start_time, t.created_at) DESC
               LIMIT 2000`;
  const now = Date.now();
  return db.prepare(sql).all(...args).map((t) => enrichTask(t, now));
}

function getTask(id) {
  const t = queryTasksById(id);
  if (!t) fail(404, 'Task not found');
  return t;
}
function queryTasksById(id) {
  const row = db.prepare(`SELECT t.*, u.name AS user_name, u.department AS user_department, a.name AS assigned_by_name,
                                 p.title AS parent_title, (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) AS comment_count
                          FROM tasks t JOIN users u ON u.id = t.user_id
                          LEFT JOIN users a ON a.id = t.assigned_by
                          LEFT JOIN tasks p ON p.id = t.parent_task_id
                          WHERE t.id = ?`).get(Number(id));
  return row ? enrichTask(row) : null;
}

function ownTask(req) {
  const t = getTask(req.params.id);
  if (req.user.role !== 'admin' && t.user_id !== req.user.id) fail(403, 'This is not your task');
  if (req.user.role !== 'admin' && t.archived_at) fail(404, 'This task was archived');
  return t;
}

function requireText(v, name, min = 1) {
  const s = String(v ?? '').trim();
  if (s.length < min) fail(400, min > 1 ? `${name} must be at least ${min} characters` : `${name} is required`);
  return s;
}

// ---------------------------------------------------------------- auth routes
// Brute-force protection: 5 wrong passwords from the same PC for the same username -> locked for 5 minutes
const MAX_TRIES = 5, LOCK_MIN = 5;
const loginFails = new Map();
app.post('/api/login', wrap((req, res) => {
  const { username, password } = req.body || {};
  const key = `${req.ip}|${String(username || '').trim().toLowerCase()}`;
  const rec = loginFails.get(key);
  if (rec && rec.lockedUntil > Date.now()) {
    fail(429, `Too many wrong attempts. Please wait ${Math.ceil((rec.lockedUntil - Date.now()) / 60000)} minute(s) or ask your admin.`);
  }
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!u || !verifyPassword(password || '', u.password_hash)) {
    const r = rec && rec.lockedUntil <= Date.now() && rec.lockedUntil ? { count: 0 } : (rec || { count: 0 });
    r.count += 1;
    r.lockedUntil = r.count >= MAX_TRIES ? Date.now() + LOCK_MIN * 60000 : 0;
    loginFails.set(key, r);
    fail(401, r.lockedUntil ? `Too many wrong attempts. Login is locked for ${LOCK_MIN} minutes.`
      : `Wrong username or password (${MAX_TRIES - r.count} attempt${MAX_TRIES - r.count === 1 ? '' : 's'} left)`);
  }
  loginFails.delete(key);
  if (!u.active) fail(403, 'Your account is deactivated. Contact admin.');
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowISO());
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, u.id, nowISO(), exp);
  // "Secure" (HTTPS-only) cookie when opened through the public HTTPS link
  res.setHeader('Set-Cookie', `tm_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${req.secure ? '; Secure' : ''}`);
  return { user: publicUser(u) };
}));

app.post('/api/logout', wrap((req, res) => {
  const token = parseCookies(req).tm_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `tm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${req.secure ? '; Secure' : ''}`);
  return { ok: true };
}));

// helpers given to the shared features module
const H = { wrap, fail, adminOnly, getTask, logEvent, notify, requireText, toISO, hashPassword, LATE_GRACE_MS };
features.registerPublic(app, H); // "Forgot password?" works without signing in

app.use('/api', auth);

app.get('/api/me', wrap((req) => ({ user: publicUser(req.user), session: { hours: SESSION_HOURS, expires_at: req.user.session_expires_at } })));
// Admin settings (end-of-day auto-stop time)
const allSettings = () => ({ auto_stop_time: getSetting('auto_stop_time', '20:00'), work_hours_per_day: Number(getSetting('work_hours_per_day', '8')), session_hours: SESSION_HOURS });
app.get('/api/settings', adminOnly, wrap(() => allSettings()));
app.put('/api/settings', adminOnly, wrap((req) => {
  const b = req.body || {};
  const save = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
  const before = allSettings();
  if (b.auto_stop_time !== undefined) {
    const v = String(b.auto_stop_time || '').trim();
    if (v !== 'off' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) fail(400, 'Use a time like 20:00, or "off"');
    save('auto_stop_time', v);
  }
  if (b.work_hours_per_day !== undefined) {
    const h = Number(b.work_hours_per_day);
    if (!(h >= 1 && h <= 16)) fail(400, 'Working hours per day must be between 1 and 16');
    save('work_hours_per_day', Math.round(h * 2) / 2);
  }
  const after = allSettings();
  const diff = Object.keys(after).filter((k) => after[k] !== before[k]).map((k) => `${k}: ${before[k]} → ${after[k]}`);
  if (diff.length) features.audit({ actorId: req.user.id, action: 'settings_changed', entity: 'settings', details: diff.join(' ; ') });
  return after;
}));

// Addresses employees can use to reach this server (shown to admin in "Employee PC setup")
app.get('/api/server-info', adminOnly, wrap(() => ({
  urls: [`http://${os.hostname()}:${PORT}`, ...Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${PORT}`)],
})));

// Everyone can change their own password (and must, after the admin gives a temporary one).
// Other devices signed in with the old password are signed out.
app.post('/api/me/password', wrap((req) => {
  const { current, next } = req.body || {};
  if (!verifyPassword(current || '', req.user.password_hash)) fail(400, 'Current password is wrong');
  const pw = requireText(next, 'New password', 8);
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) fail(400, 'Use at least 8 characters with letters and numbers');
  if (pw === current) fail(400, 'The new password must be different from the current one');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(pw), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.user.session_token);
  features.audit({ actorId: req.user.id, action: 'password_changed', entity: 'user', entityId: req.user.id, subjectUserId: req.user.id,
    details: req.user.must_change_password ? 'Replaced the temporary password' : 'Changed own password' });
  return { ok: true };
}));

// ---------------------------------------------------------------- users (admin)
app.get('/api/users', wrap((req) => {
  if (req.user.role !== 'admin') fail(403, 'Admin access only');
  return db.prepare('SELECT * FROM users ORDER BY role, active DESC, name').all().map(publicUser);
}));

app.post('/api/users', adminOnly, wrap((req) => {
  const b = req.body || {};
  const name = requireText(b.name, 'Name');
  const username = requireText(b.username, 'Username').toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) fail(400, 'Username: 3-30 chars, letters/numbers/._- only');
  const password = requireText(b.password, 'Password', 6);
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) fail(400, 'Username already exists');
  const role = b.role === 'admin' ? 'admin' : 'employee';
  const r = db.prepare(`INSERT INTO users (name, username, password_hash, role, department, designation, must_change_password, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, 1, ?)`) // the first password is temporary
    .run(name, username, hashPassword(password), role, String(b.department || '').trim(), String(b.designation || '').trim(), nowISO());
  const id = Number(r.lastInsertRowid);
  features.audit({ actorId: req.user.id, action: 'user_created', entity: 'user', entityId: id, subjectUserId: id, label: username, details: `Role: ${role}` });
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}));

app.put('/api/users/:id', adminOnly, wrap((req) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) fail(404, 'User not found');
  const b = req.body || {};
  const active = b.active === undefined ? u.active : (b.active ? 1 : 0);
  const role = b.role === undefined ? u.role : (b.role === 'admin' ? 'admin' : 'employee');
  if (u.id === req.user.id && (!active || role !== 'admin')) fail(400, 'You cannot deactivate or demote yourself');
  db.prepare('UPDATE users SET name = ?, department = ?, designation = ?, role = ?, active = ? WHERE id = ?')
    .run(b.name !== undefined ? requireText(b.name, 'Name') : u.name,
      b.department !== undefined ? String(b.department).trim() : u.department,
      b.designation !== undefined ? String(b.designation).trim() : u.designation,
      role, active, u.id);
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  const nu = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  const diff = ['name', 'department', 'designation', 'role'].filter((k) => nu[k] !== u[k]).map((k) => `${k}: "${u[k] || ''}" → "${nu[k] || ''}"`);
  if (diff.length) features.audit({ actorId: req.user.id, action: 'user_updated', entity: 'user', entityId: u.id, subjectUserId: u.id, label: u.username, details: diff.join(' ; ') });
  if (nu.active !== u.active) {
    features.audit({ actorId: req.user.id, action: nu.active ? 'user_reactivated' : 'user_deactivated', entity: 'user', entityId: u.id, subjectUserId: u.id, label: u.username,
      details: nu.active ? 'Can sign in again' : 'Signed out and cannot sign in. Past tasks and records are kept.' });
  }
  return publicUser(nu);
}));

app.post('/api/users/:id/reset-password', adminOnly, wrap((req) => {
  const pw = requireText((req.body || {}).password, 'Password', 6);
  const id = Number(req.params.id);
  // a password given by the admin is temporary: the user chooses their own at the next sign-in
  const r = db.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?').run(hashPassword(pw), id === req.user.id ? 0 : 1, id);
  if (!r.changes) fail(404, 'User not found');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare("UPDATE requests SET status = 'approved', decided_by = ?, decided_by_name = ?, decided_at = ?, decision_note = 'Temporary password set from the Employees page' WHERE kind = 'password' AND user_id = ? AND status = 'pending'")
    .run(req.user.id, req.user.name, nowISO(), id);
  features.audit({ actorId: req.user.id, action: 'password_reset', entity: 'user', entityId: id, subjectUserId: id, details: 'Temporary password set by admin; signed out everywhere' });
  return { ok: true };
}));

// ---------------------------------------------------------------- tasks
app.get('/api/tasks', wrap((req) => {
  const f = { ...req.query };
  if (req.user.role !== 'admin') { f.user_id = req.user.id; if (f.status === 'archived') f.status = ''; }
  return queryTasks(f);
}));

app.get('/api/tasks/:id', wrap((req) => {
  const t = ownTask(req);
  const events = db.prepare(`SELECT e.*, u.name AS user_name FROM task_events e LEFT JOIN users u ON u.id = e.user_id
                             WHERE e.task_id = ? ORDER BY e.at, e.id`).all(t.id);
  const children = db.prepare('SELECT id, title, status FROM tasks WHERE parent_task_id = ?').all(t.id);
  return { ...t, events, children, requests: features.requestsForTask(t.id) };
}));

function insertTask(fields, actorId) {
  const ts = nowISO();
  const r = db.prepare(`INSERT INTO tasks (user_id, title, description, category, priority, status, start_time, expected_end,
                         actual_end, delay_reason, reason_status, parent_task_id, assigned_by, created_at, updated_at, completed_logged_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(fields.user_id, fields.title, fields.description || '', fields.category || '', fields.priority, fields.status,
      fields.start_time, fields.expected_end, fields.actual_end || null, fields.delay_reason || '',
      fields.reason_status || 'none', fields.parent_task_id || null, fields.assigned_by || null, ts, ts,
      fields.status === 'completed' ? ts : null);
  return Number(r.lastInsertRowid);
}

function checkNotFuture(iso, label) {
  if (Date.parse(iso) > Date.now() + 5 * 60000) fail(400, `${label} cannot be in the future`);
}

app.post('/api/tasks', wrap((req) => {
  const b = req.body || {};
  const isAdmin = req.user.role === 'admin';
  const userId = isAdmin && b.user_id ? Number(b.user_id) : req.user.id;
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
  if (!target) fail(400, 'Employee not found or inactive');

  const title = requireText(b.title, 'Task title');
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'medium';
  const mode = ['start', 'plan', 'completed'].includes(b.mode) ? b.mode : 'start';
  const expected = toISO(b.expected_end);
  if (!expected) fail(400, 'Expected end time is required');
  let start = toISO(b.start_time);
  if (mode === 'start' && !start) start = nowISO();
  if (mode !== 'plan' && !start) fail(400, 'Start time is required');
  if (start && Date.parse(expected) <= Date.parse(start)) fail(400, 'Expected end must be after start time');
  if (mode === 'start') checkNotFuture(start, 'Start time');

  const fields = {
    user_id: userId, title, priority, description: String(b.description || '').trim(),
    category: String(b.category || '').trim(), status: mode === 'start' ? 'in_progress' : mode === 'plan' ? 'pending' : 'completed',
    start_time: start, expected_end: expected, assigned_by: userId !== req.user.id ? req.user.id : null,
  };

  if (mode === 'completed') {
    const actual = toISO(b.actual_end);
    if (!actual) fail(400, 'Actual end time is required');
    checkNotFuture(actual, 'Actual end time');
    if (Date.parse(actual) < Date.parse(start)) fail(400, 'Actual end cannot be before start time');
    fields.actual_end = actual;
    if (Date.parse(actual) > Date.parse(expected) + LATE_GRACE_MS) {
      fields.delay_reason = requireText(b.delay_reason, 'Delay reason', 5);
      fields.reason_status = 'pending';
    }
  }

  const id = insertTask(fields, req.user.id);
  logEvent(id, req.user.id, 'created', fields.assigned_by ? `Assigned by ${req.user.name}` : 'Task created');
  if (fields.assigned_by) {
    notify(userId, 'assigned', id, `New task from ${req.user.name}`,
      `${title} · ${priority[0].toUpperCase() + priority.slice(1)} priority · due ${new Date(expected).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })}`);
  }
  if (mode === 'start') logEvent(id, req.user.id, 'started', 'Work started');
  if (mode === 'completed') logEvent(id, req.user.id, 'completed', fields.delay_reason ? `Completed late. Reason: ${fields.delay_reason}` : 'Logged as completed');
  return getTask(id);
}));

app.put('/api/tasks/:id', wrap((req) => {
  const t = ownTask(req);
  const isAdmin = req.user.role === 'admin';
  if (t.status === 'completed' && !isAdmin) fail(400, 'Completed tasks can only be edited by admin');
  const b = req.body || {};
  const changes = [];
  const next = {
    title: b.title !== undefined ? requireText(b.title, 'Task title') : t.title,
    description: b.description !== undefined ? String(b.description).trim() : t.description,
    category: b.category !== undefined ? String(b.category).trim() : t.category,
    priority: PRIORITIES.includes(b.priority) ? b.priority : t.priority,
    start_time: b.start_time !== undefined ? toISO(b.start_time) : t.start_time,
    expected_end: b.expected_end !== undefined ? toISO(b.expected_end) : t.expected_end,
    actual_end: isAdmin && b.actual_end !== undefined && t.status === 'completed' ? toISO(b.actual_end) : t.actual_end,
  };
  if (!next.expected_end) fail(400, 'Expected end time is required');
  if (t.status !== 'pending' && !next.start_time) fail(400, 'Start time is required');
  if (next.start_time && Date.parse(next.expected_end) <= Date.parse(next.start_time)) fail(400, 'Expected end must be after start time');
  if (next.actual_end && next.start_time && Date.parse(next.actual_end) < Date.parse(next.start_time)) fail(400, 'Actual end cannot be before start');

  const fmt = (v) => (v ? new Date(v).toLocaleString('en-IN') : '-');
  if (next.title !== t.title) changes.push(`Title: "${t.title}" → "${next.title}"`);
  if (next.priority !== t.priority) changes.push(`Priority: ${t.priority} → ${next.priority}`);
  if (next.start_time !== t.start_time) changes.push(`Start: ${fmt(t.start_time)} → ${fmt(next.start_time)}`);
  if (next.actual_end !== t.actual_end) changes.push(`Actual end: ${fmt(t.actual_end)} → ${fmt(next.actual_end)}`);
  if (next.expected_end !== t.expected_end) {
    // Moving a deadline after work started affects rating, so the employee must explain it (visible to admin)
    let note = `Expected end: ${fmt(t.expected_end)} → ${fmt(next.expected_end)}`;
    if (t.status !== 'pending' && !isAdmin) note += ` | Reason: ${requireText(b.change_reason, 'Reason for changing expected end', 5)}`;
    changes.push(note);
  }
  if (next.description !== t.description || next.category !== t.category) changes.push('Details updated');

  let reasonStatus = t.reason_status, delayReason = t.delay_reason;
  if (t.status === 'completed') {
    const late = Date.parse(next.actual_end) > Date.parse(next.expected_end) + LATE_GRACE_MS;
    if (!late) reasonStatus = 'none';
    else if (reasonStatus === 'none') reasonStatus = delayReason ? 'pending' : 'none';
  }

  db.prepare(`UPDATE tasks SET title=?, description=?, category=?, priority=?, start_time=?, expected_end=?, actual_end=?,
              reason_status=?, delay_reason=?, updated_at=? WHERE id=?`)
    .run(next.title, next.description, next.category, next.priority, next.start_time, next.expected_end, next.actual_end,
      reasonStatus, delayReason, nowISO(), t.id);
  if (changes.length) logEvent(t.id, req.user.id, 'edited', changes.join(' ; '));
  return getTask(t.id);
}));

app.post('/api/tasks/:id/start', wrap((req) => {
  const t = ownTask(req);
  if (t.status !== 'pending') fail(400, 'Only planned tasks can be started');
  const b = req.body || {};
  const start = toISO(b.start_time) || nowISO();
  checkNotFuture(start, 'Start time');
  const expected = toISO(b.expected_end) || t.expected_end;
  if (Date.parse(expected) <= Date.parse(start)) fail(400, 'Expected end must be after start time');
  db.prepare("UPDATE tasks SET status='in_progress', start_time=?, expected_end=?, updated_at=? WHERE id=?")
    .run(start, expected, nowISO(), t.id);
  logEvent(t.id, req.user.id, 'started', 'Work started');
  return getTask(t.id);
}));

app.post('/api/tasks/:id/pause', wrap((req) => {
  const t = ownTask(req);
  if (t.status !== 'in_progress') fail(400, 'Only running tasks can be put on hold');
  const b = req.body || {};
  const reason = requireText(b.reason, 'Reason for hold', 3);
  const ts = nowISO();
  let newTask = null;

  db.exec('BEGIN');
  try {
    db.prepare("UPDATE tasks SET status='on_hold', paused_at=?, hold_reason=?, updated_at=? WHERE id=?").run(ts, reason, ts, t.id);
    let note = `On hold. Reason: ${reason}`;
    if (b.new_task && String(b.new_task.title || '').trim()) {
      const nt = b.new_task;
      const expected = toISO(nt.expected_end);
      if (!expected || Date.parse(expected) <= Date.now()) fail(400, 'New work: expected end must be in the future');
      const id = insertTask({
        user_id: t.user_id, title: requireText(nt.title, 'New work title'), description: String(nt.description || '').trim(),
        category: String(nt.category || '').trim(), priority: PRIORITIES.includes(nt.priority) ? nt.priority : 'high',
        status: 'in_progress', start_time: ts, expected_end: expected, parent_task_id: t.id,
      });
      logEvent(id, req.user.id, 'created', `New work came in while working on "${t.title}"`);
      logEvent(id, req.user.id, 'started', 'Work started');
      note += ` | New work added: "${nt.title.trim()}"`;
      newTask = id;
    }
    logEvent(t.id, req.user.id, 'paused', note);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { task: getTask(t.id), new_task: newTask ? getTask(newTask) : null };
}));

app.post('/api/tasks/:id/resume', wrap((req) => {
  const t = ownTask(req);
  if (t.status !== 'on_hold') fail(400, 'Task is not on hold');
  const mins = t.paused_at ? (Date.now() - Date.parse(t.paused_at)) / 60000 : 0;
  db.prepare("UPDATE tasks SET status='in_progress', paused_at=NULL, hold_reason='', auto_paused=0, paused_minutes=paused_minutes+?, updated_at=? WHERE id=?")
    .run(mins, nowISO(), t.id);
  logEvent(t.id, req.user.id, 'resumed', `Resumed after ${Math.round(mins)} min on hold`);
  return getTask(t.id);
}));

app.post('/api/tasks/:id/complete', wrap((req) => {
  const t = ownTask(req);
  if (!['in_progress', 'on_hold'].includes(t.status)) fail(400, 'Only started tasks can be completed');
  const b = req.body || {};
  let actual = toISO(b.actual_end) || nowISO();
  checkNotFuture(actual, 'Actual end time');
  // time pickers work in whole minutes: finishing in the same minute as the start is fine
  if (Date.parse(actual) < Date.parse(t.start_time) && Date.parse(t.start_time) - Date.parse(actual) < 60000) actual = t.start_time;
  if (Date.parse(actual) < Date.parse(t.start_time)) fail(400, 'Actual end cannot be before start time');
  let paused = t.paused_minutes || 0;
  if (t.status === 'on_hold' && t.paused_at && Date.parse(actual) > Date.parse(t.paused_at)) {
    paused += (Date.parse(actual) - Date.parse(t.paused_at)) / 60000;
  }
  // deadline moves forward by all the time spent on hold
  const late = Date.parse(actual) > Date.parse(t.expected_end) + paused * 60000 + LATE_GRACE_MS;
  const reason = late ? requireText(b.delay_reason, 'Reason for delay', 5) : String(b.delay_reason || '').trim();
  const ts = nowISO();
  db.prepare(`UPDATE tasks SET status='completed', auto_paused=0, actual_end=?, paused_at=NULL, paused_minutes=?, delay_reason=?,
              reason_status=?, updated_at=?, completed_logged_at=? WHERE id=?`)
    .run(actual, paused, reason, late ? 'pending' : 'none', ts, ts, t.id);
  logEvent(t.id, req.user.id, 'completed', late ? `Completed late. Reason: ${reason}` : 'Completed on time');
  return getTask(t.id);
}));

app.post('/api/tasks/:id/reason', wrap((req) => {
  const t = ownTask(req);
  if (t.status !== 'completed' || !t.is_late) fail(400, 'A delay reason is only needed for late tasks');
  if (t.reason_status === 'accepted') fail(400, 'Reason already accepted');
  const reason = requireText((req.body || {}).delay_reason, 'Reason for delay', 5);
  db.prepare("UPDATE tasks SET delay_reason=?, reason_status='pending', updated_at=? WHERE id=?").run(reason, nowISO(), t.id);
  logEvent(t.id, req.user.id, 'reason', `Delay reason updated: ${reason}`);
  return getTask(t.id);
}));

app.post('/api/tasks/:id/review', adminOnly, wrap((req) => {
  const t = getTask(req.params.id);
  const { decision, note } = req.body || {};
  if (!['accepted', 'rejected'].includes(decision)) fail(400, 'Decision must be accepted or rejected');
  if (!t.is_late) fail(400, 'This task was not late');
  db.prepare('UPDATE tasks SET reason_status=?, admin_note=?, updated_at=? WHERE id=?').run(decision, String(note || '').trim(), nowISO(), t.id);
  logEvent(t.id, req.user.id, 'reviewed', `Delay reason ${decision}${note ? ': ' + note : ''}`);
  notify(t.user_id, 'reviewed', t.id, `Delay reason ${decision}`, `${t.title}${note ? ' — ' + note : ''}`);
  return getTask(t.id);
}));

// Employees never delete: a task added by mistake is archived (kept, but hidden from lists and scores).
// Own task, not assigned by admin: a planned task any time; a started/finished one only within
// 30 minutes of adding it - so finished work cannot be hidden later.
app.post('/api/tasks/:id/archive', wrap((req) => {
  const t = ownTask(req);
  if (t.archived_at) fail(400, 'This task is already archived');
  if (req.user.role !== 'admin') {
    if (t.assigned_by) fail(400, 'Tasks assigned by admin cannot be archived');
    const recent = Date.now() - Date.parse(t.created_at) < ARCHIVE_WINDOW_MIN * 60000;
    if (t.status !== 'pending' && !recent) fail(400, `Started or finished tasks can only be archived within ${ARCHIVE_WINDOW_MIN} minutes of adding them`);
  }
  const reason = String((req.body || {}).reason || '').trim().slice(0, 300) || 'Added by mistake';
  const ts = nowISO();
  // a running task is put on hold first, so no time keeps counting while it is archived
  if (t.status === 'in_progress') db.prepare("UPDATE tasks SET status='on_hold', paused_at=?, hold_reason=? WHERE id=?").run(ts, 'Archived', t.id);
  db.prepare('UPDATE tasks SET archived_at=?, archived_by=?, updated_at=? WHERE id=?').run(ts, req.user.id, ts, t.id);
  logEvent(t.id, req.user.id, 'archived', `Archived. Reason: ${reason}`);
  return { ok: true };
}));

app.post('/api/tasks/:id/restore', adminOnly, wrap((req) => {
  const t = getTask(req.params.id);
  if (!t.archived_at) fail(400, 'This task is not archived');
  const ts = nowISO();
  db.prepare('UPDATE tasks SET archived_at=NULL, archived_by=NULL, updated_at=? WHERE id=?').run(ts, t.id);
  logEvent(t.id, req.user.id, 'restored', 'Restored from archive');
  return getTask(t.id);
}));

// Permanent delete: admin only
app.delete('/api/tasks/:id', adminOnly, wrap((req) => {
  const t = getTask(req.params.id);
  // the task and its timeline are removed, but the history keeps a copy of what was deleted
  features.audit({ actorId: req.user.id, action: 'deleted', entity: 'task', entityId: t.id, subjectUserId: t.user_id, label: t.title,
    details: `Permanently deleted. Status: ${t.status}; start: ${t.start_time || '-'}; expected end: ${t.expected_end}; actual end: ${t.actual_end || '-'}; worked: ${t.worked_minutes ?? '-'} min` });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
  return { ok: true };
}));

// ---------------------------------------------------------------- comments (admin <-> employee, per task)
function markRead(userId, taskId) {
  db.prepare(`INSERT INTO comment_reads (user_id, task_id, last_read_at) VALUES (?, ?, ?)
              ON CONFLICT(user_id, task_id) DO UPDATE SET last_read_at = excluded.last_read_at`).run(userId, taskId, nowISO());
}

app.get('/api/tasks/:id/comments', wrap((req) => {
  const t = ownTask(req);
  const rows = db.prepare(`SELECT c.id, c.body, c.created_at, c.user_id, u.name AS user_name, u.role AS user_role
                           FROM task_comments c LEFT JOIN users u ON u.id = c.user_id
                           WHERE c.task_id = ? ORDER BY c.created_at, c.id`).all(t.id);
  markRead(req.user.id, t.id);
  return rows;
}));

app.post('/api/tasks/:id/comments', wrap((req) => {
  const t = ownTask(req);
  const body = requireText((req.body || {}).body, 'Comment');
  if (body.length > 2000) fail(400, 'Comment is too long (max 2000 characters)');
  const r = db.prepare('INSERT INTO task_comments (task_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(t.id, req.user.id, body, nowISO());
  markRead(req.user.id, t.id);
  return db.prepare(`SELECT c.id, c.body, c.created_at, c.user_id, u.name AS user_name, u.role AS user_role
                     FROM task_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?`).get(r.lastInsertRowid);
}));

// Tasks with comments from someone else that this user has not read yet
app.get('/api/comments/unread', wrap((req) => {
  const isAdmin = req.user.role === 'admin';
  return db.prepare(`SELECT t.id AS task_id, t.title, ou.name AS owner_name, COUNT(*) AS count, MAX(c.created_at) AS last_at,
                            (SELECT u2.name FROM task_comments c2 LEFT JOIN users u2 ON u2.id = c2.user_id WHERE c2.task_id = t.id ORDER BY c2.created_at DESC, c2.id DESC LIMIT 1) AS last_by,
                            (SELECT c2.body FROM task_comments c2 WHERE c2.task_id = t.id ORDER BY c2.created_at DESC, c2.id DESC LIMIT 1) AS last_body
                     FROM task_comments c
                     JOIN tasks t ON t.id = c.task_id
                     JOIN users ou ON ou.id = t.user_id
                     LEFT JOIN comment_reads r ON r.task_id = t.id AND r.user_id = ?
                     WHERE (c.user_id IS NULL OR c.user_id != ?) AND (r.last_read_at IS NULL OR c.created_at > r.last_read_at) AND t.archived_at IS NULL
                       ${isAdmin ? '' : 'AND t.user_id = ?'}
                     GROUP BY t.id ORDER BY last_at DESC LIMIT 50`)
    .all(...(isAdmin ? [req.user.id, req.user.id] : [req.user.id, req.user.id, req.user.id]));
}));

// ---------------------------------------------------------------- notifications (task assigned, reason reviewed)
app.get('/api/notifications/unread', wrap((req) => db.prepare(`
  SELECT n.*, t.priority, t.expected_end, t.status AS task_status FROM notifications n LEFT JOIN tasks t ON t.id = n.task_id
  WHERE n.user_id = ? AND n.read_at IS NULL ORDER BY n.created_at DESC, n.id DESC LIMIT 30`).all(req.user.id)));

app.post('/api/notifications/read', wrap((req) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (ids.length) {
    db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`)
      .run(nowISO(), req.user.id, ...ids);
  } else {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(nowISO(), req.user.id);
  }
  return { ok: true };
}));

// ---------------------------------------------------------------- leave & holidays
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));

app.get('/api/leaves', wrap((req) => {
  const from = isDay(req.query.from) ? req.query.from : '0000-00-00';
  const to = isDay(req.query.to) ? req.query.to : '9999-12-31';
  const isAdmin = req.user.role === 'admin';
  return db.prepare(`SELECT l.*, u.name AS user_name FROM leaves l LEFT JOIN users u ON u.id = l.user_id
                     WHERE l.day >= ? AND l.day <= ? ${isAdmin ? '' : 'AND (l.user_id IS NULL OR l.user_id = ?)'}
                     ORDER BY l.day, l.user_id IS NOT NULL, u.name`).all(...(isAdmin ? [from, to] : [from, to, req.user.id]));
}));

app.post('/api/leaves', adminOnly, wrap((req) => {
  const b = req.body || {};
  const type = LEAVE_TYPES.includes(b.type) ? b.type : fail(400, 'Choose leave, half day or holiday');
  const from = isDay(b.from) ? b.from : fail(400, 'Choose a valid start date');
  const to = isDay(b.to) ? b.to : from;
  if (to < from) fail(400, 'End date cannot be before start date');
  let userId = null;
  if (type !== 'holiday') {
    userId = Number(b.user_id);
    if (!db.prepare("SELECT id FROM users WHERE id = ? AND role = 'employee'").get(userId)) fail(400, 'Choose an employee');
  }
  const note = type === 'holiday' ? requireText(b.note, 'Holiday name') : String(b.note || '').trim();
  const days = [];
  for (let d = new Date(from + 'T12:00:00'); ymd(d) <= to; d.setDate(d.getDate() + 1)) {
    if (b.skip_sundays && d.getDay() === 0) continue;
    days.push(ymd(d));
    if (days.length > 62) fail(400, 'Please add at most 62 days at a time');
  }
  const del = db.prepare(`DELETE FROM leaves WHERE day = ? AND ${userId == null ? 'user_id IS NULL' : 'user_id = ?'}`);
  const ins = db.prepare('INSERT INTO leaves (user_id, day, type, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const day of days) {
      if (userId == null) del.run(day); else del.run(day, userId);
      ins.run(userId, day, type, note, req.user.id, nowISO());
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  features.audit({ actorId: req.user.id, action: 'leave_added', entity: 'leave', subjectUserId: userId, label: type, details: `${days[0] || from} → ${days[days.length - 1] || to} (${days.length} day(s))${note ? ': ' + note : ''}` });
  return { added: days.length };
}));

app.delete('/api/leaves/:id', adminOnly, wrap((req) => {
  const l = db.prepare('SELECT * FROM leaves WHERE id = ?').get(Number(req.params.id));
  const r = db.prepare('DELETE FROM leaves WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) fail(404, 'Entry not found');
  features.audit({ actorId: req.user.id, action: 'leave_removed', entity: 'leave', entityId: l.id, subjectUserId: l.user_id, label: l.type, details: `${l.day}${l.note ? ': ' + l.note : ''}` });
  return { ok: true };
}));

// ---------------------------------------------------------------- stats
app.get('/api/stats/ratings', wrap((req) => {
  const isAdmin = req.user.role === 'admin';
  const users = isAdmin
    ? db.prepare("SELECT * FROM users WHERE role = 'employee' AND active = 1 ORDER BY name").all()
    : [req.user];
  const userFilter = isAdmin && req.query.user_id ? Number(req.query.user_id) : null;
  const lk = leaveLookup('0000-00-00', '9999-12-31');
  return users
    .filter((u) => !userFilter || u.id === userFilter)
    .map((u) => {
      const tasks = excuseLeaveDays(queryTasks({ user_id: u.id, from: req.query.from, to: req.query.to }), u.id, lk);
      return { user: publicUser(u), ...summarize(tasks) };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}));

// Open tasks that fell due on a leave/holiday day must not pull the rating down
function excuseLeaveDays(tasks, userId, lk) {
  return tasks.map((t) => (t.status !== 'completed' && t.score != null && FULL_OFF(lk(userId, ymd(t.expected_end)))
    ? { ...t, score: null, due_on_leave: true } : t));
}

// Daily report: every task an employee worked on during one day (from/to = that day's local start/end)
function dayReport(users, from, to, now = Date.now()) {
  const day = ymd(Date.parse(from) + 3600000); // +1h guards against a midnight edge
  const lk = leaveLookup(day, day);
  const rows = db.prepare(`SELECT t.*, u.name AS user_name, a.name AS assigned_by_name, p.title AS parent_title, (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) AS comment_count
                           FROM tasks t JOIN users u ON u.id = t.user_id
                           LEFT JOIN users a ON a.id = t.assigned_by
                           LEFT JOIN tasks p ON p.id = t.parent_task_id
                           WHERE t.user_id = ? AND t.archived_at IS NULL AND (
                             (t.start_time IS NOT NULL AND t.status != 'pending' AND t.start_time < ?
                               AND (t.status != 'completed' OR t.actual_end >= ?))
                             OR (t.status = 'pending' AND t.expected_end >= ? AND t.expected_end < ?))
                           ORDER BY COALESCE(t.start_time, t.expected_end)`);
  return users.map((u) => {
    const leave = lk(u.id, day);
    let tasks = rows.all(u.id, to, from, from, to).map((t) => enrichTask(t, now));
    if (FULL_OFF(leave)) tasks = tasks.map((t) => (t.status !== 'completed' ? { ...t, score: null, due_on_leave: true } : t));
    const longest = tasks.reduce((m, t) => ((t.worked_minutes || 0) > (m?.worked_minutes || 0) ? t : m), null);
    const sum = summarize(tasks);
    if (FULL_OFF(leave) && sum.score == null) Object.assign(sum, { grade: leave.type === 'holiday' ? 'Holiday' : 'On leave', stars: 0 });
    const workHours = Number(getSetting('work_hours_per_day', '8')) || 8;
    return { user: publicUser(u), ...sum, leave: leave ? { type: leave.type, note: leave.note } : null, longest_task_id: longest ? longest.id : null, tasks,
      break_minutes: features.breakMinutes(u.id, from, to), work_hours: workHours,
      overtime_minutes: Math.max(0, Math.round(sum.worked_minutes - workHours * 60)) };
  });
}
const activeEmployees = () => db.prepare("SELECT * FROM users WHERE role = 'employee' AND active = 1 ORDER BY name").all();

app.get('/api/reports/daily', wrap((req) => {
  const from = toISO(req.query.from), to = toISO(req.query.to);
  if (!from || !to) fail(400, 'from and to are required');
  return dayReport(req.user.role === 'admin' ? activeEmployees() : [req.user], from, to);
}));

// Office progress: team + per-employee rating for each of the last N days (admin)
app.get('/api/stats/trend', adminOnly, wrap((req) => {
  const start = toISO(req.query.from);
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 62);
  if (!start) fail(400, 'from is required');
  const users = activeEmployees();
  const now = Date.now();
  const out = [];
  for (let i = 0; i < days; i++) {
    const d0 = new Date(Date.parse(start) + i * 86400000), d1 = new Date(d0.getTime() + 86400000);
    if (d0.getTime() > now) break;
    const rep = dayReport(users, d0.toISOString(), d1.toISOString(), now);
    const scored = rep.filter((r) => r.score != null);
    out.push({
      day: d0.toISOString(),
      team_score: scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : null,
      completed: rep.reduce((s, r) => s + r.tasks.filter((t) => t.status === 'completed' && Date.parse(t.actual_end) >= d0.getTime() && Date.parse(t.actual_end) < d1.getTime()).length, 0),
      worked_minutes: rep.reduce((s, r) => s + r.worked_minutes, 0),
      employees: rep.map((r) => ({ id: r.user.id, score: r.score, tasks: r.tasks.length, completed: r.completed, leave: r.leave ? r.leave.type : null })),
    });
  }
  return { users: users.map(publicUser), days: out };
}));

app.get('/api/stats/dashboard', adminOnly, wrap((req) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const from = req.query.from || today.toISOString();
  const employees = db.prepare("SELECT * FROM users WHERE role = 'employee' AND active = 1 ORDER BY name").all();
  const open = queryTasks({ status: 'active' });
  const overdue = queryTasks({ status: 'overdue' });
  const todayTasks = queryTasks({ from });
  const completedToday = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status='completed' AND actual_end >= ? AND archived_at IS NULL").get(today.toISOString()).c;
  const pendingReviews = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE reason_status='pending' AND archived_at IS NULL").get().c;

  const todayKey = ymd(today);
  const lk = leaveLookup(todayKey, todayKey);
  const live = employees.map((u) => {
    const mine = open.filter((t) => t.user_id === u.id);
    const running = mine.filter((t) => t.status === 'in_progress');
    const leave = lk(u.id, todayKey);
    return {
      user: publicUser(u),
      leave: leave ? { type: leave.type, note: leave.note } : null,
      state: running.length ? 'working' : FULL_OFF(leave) ? 'on_leave' : mine.length ? 'on_hold' : 'idle',
      tasks: mine,
      overdue: overdue.filter((t) => t.user_id === u.id).length,
    };
  });

  const activity = db.prepare(`SELECT e.*, u.name AS user_name, t.title AS task_title FROM task_events e
                               LEFT JOIN users u ON u.id = e.user_id JOIN tasks t ON t.id = e.task_id
                               WHERE t.archived_at IS NULL OR e.type = 'archived'
                               ORDER BY e.at DESC, e.id DESC LIMIT 20`).all();

  return {
    kpi: {
      employees: employees.length,
      working_now: live.filter((l) => l.state === 'working').length,
      on_leave: live.filter((l) => l.state === 'on_leave').length,
      in_progress: open.filter((t) => t.status === 'in_progress').length,
      on_hold: open.filter((t) => t.status === 'on_hold').length,
      completed_today: completedToday,
      tasks_today: todayTasks.length,
      overdue: overdue.length,
      pending_reviews: pendingReviews,
    },
    live, overdue: overdue.slice(0, 15), activity,
  };
}));

// ---------------------------------------------------------------- task assistant (built-in, no internet needed)
// Looks at the tasks and gives: a short summary, the main reasons for delays, and the next actions to take.
const REASON_GROUPS = [
  ['Waiting for information / approval', /wait|approv|pending from|data from|reply|response|confirm|document/i],
  ['Client / customer', /client|customer|party|vendor|buyer|trader/i],
  ['Urgent work came in', /urgent|boss|admin|priority|switched to|new work/i],
  ['Changes / rework', /change|correction|rework|revis|redo|mistake|extra|scope|again/i],
  ['Meeting / call', /meeting|call|discussion/i],
  ['System / internet issue', /system|internet|server|network|software|computer|\bpc\b|power|electric|bug|down|slow/i],
  ['Break / personal', /lunch|break|personal|tea|leave|sick/i],
];
const reasonGroup = (text) => (REASON_GROUPS.find(([, re]) => re.test(text || '')) || ['Other'])[0];

function groupCount(items) {
  const m = new Map();
  for (const x of items) m.set(x, (m.get(x) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count, pct: Math.round((count / items.length) * 100) }));
}

// delay reasons + how accurate the planning is, for a set of finished tasks
function delayInsights(done, holdNotes) {
  const late = done.filter((t) => t.is_late);
  const planned = done.filter((t) => t.planned_minutes && t.worked_minutes != null);
  const ratio = planned.length ? planned.reduce((s, t) => s + t.worked_minutes, 0) / Math.max(1, planned.reduce((s, t) => s + t.planned_minutes, 0)) : null;
  return {
    finished: done.length,
    late: late.length,
    late_pct: done.length ? Math.round((late.length / done.length) * 100) : 0,
    reasons: groupCount(late.map((t) => reasonGroup(t.delay_reason))),
    interruptions: groupCount(holdNotes.map(reasonGroup)).slice(0, 4),
    time_used_pct: ratio == null ? null : Math.round(ratio * 100), // 120 = tasks take 20% longer than planned
  };
}

function planningTip(ins) {
  if (ins.time_used_pct == null || ins.finished < 3) return null;
  if (ins.time_used_pct >= 115) return `Tasks take about ${ins.time_used_pct - 100}% longer than planned. Add a little extra time when you plan.`;
  if (ins.time_used_pct <= 80) return `Tasks finish about ${100 - ins.time_used_pct}% faster than planned. You can plan shorter times.`;
  return 'Planned times match the real times well. Keep planning the same way.';
}

const holdNotesFor = (userIds, sinceIso) => {
  if (!userIds.length) return [];
  return db.prepare(`SELECT e.note FROM task_events e JOIN tasks t ON t.id = e.task_id
                     WHERE e.type = 'paused' AND e.at >= ? AND t.archived_at IS NULL AND t.user_id IN (${userIds.map(() => '?').join(',')})`)
    .all(sinceIso, ...userIds)
    .map((r) => String(r.note || '').replace(/^On hold\. Reason:\s*/i, '').split('|')[0].trim())
    .filter((n) => n && !/^Auto-stopped/i.test(n));
};

function employeeAssistant(user) {
  const now = Date.now();
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
  const d2 = new Date(d1); d2.setDate(d2.getDate() + 1);
  const since = new Date(now - 30 * 86400000).toISOString();
  const all = queryTasks({ user_id: user.id });
  const pending = all.filter((t) => t.status === 'pending');
  const running = all.filter((t) => t.status === 'in_progress');
  const paused = all.filter((t) => t.status === 'on_hold');
  const todayPending = pending.filter((t) => Date.parse(t.start_time) >= d0 && Date.parse(t.start_time) < d1);
  const tomorrow = pending.filter((t) => Date.parse(t.start_time) >= d1 && Date.parse(t.start_time) < d2);
  const missed = pending.filter((t) => t.overdue);
  const left = todayPending.filter((t) => !t.overdue);
  const leftMin = left.reduce((s, t) => s + (t.planned_minutes || 0), 0);
  const done30 = queryTasks({ user_id: user.id, status: 'completed', from: since });
  const ins = delayInsights(done30, holdNotesFor([user.id], since));
  const unread = db.prepare(`SELECT COUNT(DISTINCT c.task_id) AS n FROM task_comments c JOIN tasks t ON t.id = c.task_id
                             LEFT JOIN comment_reads r ON r.task_id = t.id AND r.user_id = ?
                             WHERE t.user_id = ? AND t.archived_at IS NULL AND c.user_id != ? AND (r.last_read_at IS NULL OR c.created_at > r.last_read_at)`).get(user.id, user.id, user.id).n;

  const actions = [];
  const add = (a) => actions.push(a);
  for (const t of running.filter((x) => x.overdue)) add({ icon: '⏰', text: `“${t.title}” is ${t.late_by_minutes} min over its planned time. Finish it, or pause it if something else came up.`, task_id: t.id, buttons: ['complete', 'pause'] });
  for (const t of paused.filter((x) => x.auto_paused)) add({ icon: '🌙', text: `“${t.title}” was left running. Confirm when you finished it.`, task_id: t.id, buttons: ['complete', 'resume'] });
  for (const t of missed.slice(0, 3)) add({ icon: '⚠️', text: `“${t.title}” was planned for ${new Date(t.start_time).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })} and has not started. Start it now or move it.`, task_id: t.id, buttons: ['qstart', 'move'] });
  for (const t of all.filter((x) => x.status === 'completed' && x.is_late && x.reason_status === 'rejected').slice(0, 2)) add({ icon: '📝', text: `Your admin returned the delay reason for “${t.title}”. Update the reason.`, task_id: t.id, buttons: ['reason'] });
  if (unread) add({ icon: '💬', text: `You have unread messages from your admin on ${unread} task${unread > 1 ? 's' : ''}.`, buttons: ['messages'] });
  for (const t of paused.filter((x) => !x.auto_paused).slice(0, 2)) if (!running.length) add({ icon: '⏸', text: `“${t.title}” is paused. Resume it when you are ready.`, task_id: t.id, buttons: ['resume'] });
  // the best next task: urgent/high first, then the earliest start
  const prio = { urgent: 0, high: 1, medium: 2, low: 3 };
  const next = [...left].sort((a, b) => (prio[a.priority] - prio[b.priority]) || (Date.parse(a.start_time) - Date.parse(b.start_time)))[0];
  if (next && !running.length) add({ icon: '▶', text: `Next: start “${next.title}”${next.priority === 'urgent' || next.priority === 'high' ? ` (${next.priority} priority)` : ''}, planned for ${new Date(next.start_time).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })}.`, task_id: next.id, buttons: ['qstart'] });
  if (!todayPending.length && !running.length && new Date().getHours() < 17) add({ icon: '📋', text: 'Nothing planned for the rest of today. Add your next task on the Today page.', buttons: ['today'] });
  if (new Date().getHours() >= 16 && !tomorrow.length) add({ icon: '🗓️', text: 'Nothing is planned for tomorrow yet. Plan tomorrow in the Calendar.', buttons: ['calendar'] });

  const parts = [];
  parts.push(running.length ? `You are working on “${running[0].title}”.` : 'No task is running right now.');
  parts.push(left.length ? `${left.length} task${left.length > 1 ? 's' : ''} left for today (${Math.round(leftMin / 6) / 10} h planned).` : 'No more tasks planned for today.');
  if (missed.length) parts.push(`${missed.length} planned task${missed.length > 1 ? 's were' : ' was'} missed.`);
  if (paused.length) parts.push(`${paused.length} paused.`);
  if (tomorrow.length) parts.push(`${tomorrow.length} planned for tomorrow.`);
  return {
    for: 'employee', summary: parts.join(' '),
    counts: { running: running.length, paused: paused.length, today_left: left.length, missed: missed.length, tomorrow: tomorrow.length },
    actions: actions.slice(0, 6),
    insights: { ...ins, tip: planningTip(ins), period: 'last 30 days' },
  };
}

function adminAssistant() {
  const now = Date.now();
  const since = new Date(now - 30 * 86400000).toISOString();
  const emps = activeEmployees();
  const open = queryTasks({ status: 'active' });
  const overdue = queryTasks({ status: 'overdue' });
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
  const pendingToday = queryTasks({ status: 'pending', from: d0.toISOString(), to: d1.toISOString() });
  const reviews = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE reason_status = 'pending' AND archived_at IS NULL").get().n;
  const done30 = queryTasks({ status: 'completed', from: since });
  const ins = delayInsights(done30, holdNotesFor(emps.map((u) => u.id), since));
  const todayKey = ymd(d0);
  const lk = leaveLookup(todayKey, todayKey);

  const people = emps.map((u) => {
    const mine = open.filter((t) => t.user_id === u.id);
    const od = overdue.filter((t) => t.user_id === u.id);
    const fin = done30.filter((t) => t.user_id === u.id);
    return {
      id: u.id, name: u.name, on_leave: FULL_OFF(lk(u.id, todayKey)),
      running: mine.filter((t) => t.status === 'in_progress').length,
      overdue: od.length, planned_today: pendingToday.filter((t) => t.user_id === u.id).length,
      late_pct: fin.length ? Math.round((fin.filter((t) => t.is_late).length / fin.length) * 100) : null, finished: fin.length,
      top_reason: groupCount(fin.filter((t) => t.is_late).map((t) => reasonGroup(t.delay_reason)))[0]?.label || null,
    };
  });

  const actions = [];
  if (reviews) actions.push({ icon: '📝', text: `${reviews} delay reason${reviews > 1 ? 's are' : ' is'} waiting for your review.`, buttons: ['reviews'] });
  for (const p of people.filter((x) => x.overdue).sort((a, b) => b.overdue - a.overdue).slice(0, 3)) actions.push({ icon: '⚠️', text: `Follow up with ${p.name}: ${p.overdue} overdue task${p.overdue > 1 ? 's' : ''}.`, user_id: p.id, buttons: ['employee'] });
  const idle = people.filter((p) => !p.on_leave && !p.running && new Date().getHours() >= 10 && new Date().getHours() < 18);
  if (idle.length) actions.push({ icon: '💤', text: `${idle.map((p) => p.name.split(' ')[0]).join(', ')} ${idle.length > 1 ? 'have' : 'has'} no task running right now.`, buttons: ['overview'] });
  const noPlan = people.filter((p) => !p.on_leave && !p.planned_today && !p.running);
  if (noPlan.length && new Date().getHours() < 15) actions.push({ icon: '📋', text: `No tasks planned today for ${noPlan.map((p) => p.name.split(' ')[0]).join(', ')}. You can assign work.`, buttons: ['assign'] });
  const worst = people.filter((p) => p.finished >= 3 && p.late_pct >= 40).sort((a, b) => b.late_pct - a.late_pct)[0];
  if (worst) actions.push({ icon: '📉', text: `${worst.name} finished ${worst.late_pct}% of tasks late in the last 30 days${worst.top_reason ? ` — mostly “${worst.top_reason}”` : ''}. Worth a quick talk.`, user_id: worst.id, buttons: ['employee'] });
  if (ins.reasons[0] && ins.late >= 3) actions.push({ icon: '🔎', text: `Most delays are due to “${ins.reasons[0].label}” (${ins.reasons[0].pct}% of late tasks). Fixing this would help the whole team.`, buttons: [] });

  const running = people.reduce((s, p) => s + p.running, 0);
  const summary = [
    `${running} of ${emps.length} employee${emps.length !== 1 ? 's are' : ' is'} working right now.`,
    `${overdue.length} task${overdue.length !== 1 ? 's are' : ' is'} overdue.`,
    `${pendingToday.length} task${pendingToday.length !== 1 ? 's' : ''} still planned for today.`,
    reviews ? `${reviews} delay reason${reviews > 1 ? 's' : ''} to review.` : '',
  ].filter(Boolean).join(' ');
  return { for: 'admin', summary, actions: actions.slice(0, 7), people, insights: { ...ins, tip: planningTip(ins), period: 'last 30 days' } };
}

app.get('/api/assistant', wrap((req) => (req.user.role === 'admin' ? adminAssistant() : employeeAssistant(req.user))));

// ---------------------------------------------------------------- CSV export
app.get('/api/export/tasks.csv', adminOnly, (req, res) => {
  const rows = queryTasks(req.query);
  const cols = [
    ['ID', 'id'], ['Employee', 'user_name'], ['Department', 'user_department'], ['Task', 'title'], ['Category', 'category'],
    ['Priority', 'priority'], ['Status', 'status'], ['Start', 'start_time'], ['Expected End', 'expected_end'],
    ['Actual End', 'actual_end'], ['Planned (min)', 'planned_minutes'], ['Worked (min)', 'worked_minutes'],
    ['Hold (min)', 'paused_minutes'], ['Late', 'is_late'], ['Late By (min)', 'late_by_minutes'], ['Delay Reason', 'delay_reason'],
    ['Reason Status', 'reason_status'], ['Admin Note', 'admin_note'], ['Score', 'score'], ['Assigned By', 'assigned_by_name'],
  ];
  const fmtCell = (k, v) => {
    if (v == null) return '';
    if (['start_time', 'expected_end', 'actual_end'].includes(k)) return new Date(v).toLocaleString('en-IN');
    if (k === 'paused_minutes') return Math.round(v);
    if (k === 'is_late') return v ? 'Yes' : 'No';
    return v;
  };
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [cols.map((c) => esc(c[0])).join(',')]
    .concat(rows.map((r) => cols.map(([, k]) => esc(fmtCell(k, r[k]))).join(',')))
    .join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tasks-report-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + csv);
});

features.register(app, H); // history, requests, breaks, sign out everywhere
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------------------------------------------------------------- employee PC setup (desktop icon)
// Built at start-up with this server's PC name + IP, so employees' icons always point here.
// Contains only a shortcut launcher - no data and no secrets.
const SETUP_ZIP = path.join(__dirname, 'data', 'WorkTrack-Setup.zip');
function buildEmployeeSetup(ips) {
  const src = path.join(__dirname, 'employee-setup');
  if (process.platform !== 'win32' || !fs.existsSync(src)) return;
  const tmp = path.join(__dirname, 'data', 'employee-setup-build', 'WorkTrack-Setup');
  try {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    fs.cpSync(src, tmp, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'desktop', 'worktrack.ico'), path.join(tmp, 'worktrack.ico'));
    fs.writeFileSync(path.join(tmp, 'config.txt'), [
      '# WorkTrack office server addresses (tried in this order)',
      `http://${os.hostname()}:${PORT}`,
      ...ips.map((ip) => `http://${ip}:${PORT}`),
      '',
    ].join('\r\n'));
    const zipTmp = `${SETUP_ZIP}.tmp.zip`;
    require('child_process').execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -LiteralPath '${tmp.replace(/'/g, "''")}' -DestinationPath '${zipTmp.replace(/'/g, "''")}' -Force`],
    (err) => {
      if (err) return console.log('Employee setup zip could not be created:', err.message);
      fs.renameSync(zipTmp, SETUP_ZIP);
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    });
  } catch (e) { console.log('Employee setup zip could not be created:', e.message); }
}

app.get('/download/WorkTrack-Setup.zip', (req, res) => {
  // office network only: the setup contains this PC's local address, which is not shared on the internet link
  if (req.secure || req.get('cf-connecting-ip')) return res.status(404).send('Not available on the internet link.');
  if (!fs.existsSync(SETUP_ZIP)) return res.status(503).send('Setup file is being prepared, please try again in a minute.');
  res.download(SETUP_ZIP, 'WorkTrack-Setup.zip');
});

// ---------------------------------------------------------------- start
function openBrowser() {
  if (process.env.OPEN_BROWSER !== '1' || process.platform !== 'win32') return;
  require('child_process').exec(`start "" http://localhost:${PORT}`);
}

const server = app.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\n==============================================');
  console.log('  Office Task Manager is running');
  console.log(`  On this PC:        http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  Employees' PCs:    http://${ip}:${PORT}`));
  console.log('  Keep this window open while office is working.');
  console.log('==============================================\n');
  openBrowser();
  buildEmployeeSetup(ips);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\nTask Manager is ALREADY RUNNING on port ${PORT} (another window is open).`);
    console.log(`Opening http://localhost:${PORT} in your browser. You can close this window.\n`);
    openBrowser();
    setTimeout(() => process.exit(0), 1500);
  } else {
    console.error('Could not start server:', e.message);
    process.exit(1);
  }
});
