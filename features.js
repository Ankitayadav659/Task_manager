// Extra features shared by the office version (server.js) and the Firebase version (functions/app.js).
// The same file is used in both - keep them identical.
//   * change history (audit log)        * employee requests: time fix, task review, leave, password help
//   * breaks                            * sign out of all devices / sign a user out
const dbm = require('./db');
const db = () => dbm.db;
const nowISO = () => new Date().toISOString();
const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const nameOf = (id) => (id ? (db().prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || `User #${id}` : 'System');

// ---------------------------------------------------------------- history
function audit({ actorId = null, action, entity, entityId = null, subjectUserId = null, label = '', details = '' }) {
  db().prepare(`INSERT INTO audit_log (at, actor_id, actor_name, action, entity, entity_id, subject_user_id, subject_name, label, details)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nowISO(), actorId, nameOf(actorId), action, entity, entityId, subjectUserId, subjectUserId ? nameOf(subjectUserId) : '',
      String(label || '').slice(0, 300), String(details || '').slice(0, 2000));
}
// every task event (created, started, paused, edited, reviewed, ...) also goes into the history
function auditTaskEvent(taskId, userId, type, note) {
  const t = db().prepare('SELECT title, user_id FROM tasks WHERE id = ?').get(taskId);
  audit({ actorId: userId, action: type, entity: 'task', entityId: taskId, subjectUserId: t ? t.user_id : null, label: t ? t.title : '', details: note });
}

const KINDS = ['time', 'review', 'leave', 'password'];
const BREAK_KINDS = { tea: 'Tea / short break', lunch: 'Lunch', personal: 'Personal', prayer: 'Prayer' };
const ymd = (d) => { d = new Date(d); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
const fmt = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '—');

function rowOut(r) {
  return { ...r, payload: parse(r.payload), original: parse(r.original) };
}
function requestsForTask(taskId) {
  return db().prepare('SELECT * FROM requests WHERE task_id = ? ORDER BY created_at DESC, id DESC').all(taskId).map(rowOut);
}
const admins = () => db().prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all();

// Break minutes of one person between two moments (open breaks count up to `to` / now)
function breakMinutes(userId, from, to) {
  const rows = db().prepare('SELECT started_at, ended_at FROM breaks WHERE user_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)').all(userId, to, from);
  const a = Date.parse(from), b = Math.min(Date.parse(to), Date.now());
  return Math.round(rows.reduce((s, r) => s + Math.max(0, Math.min(b, r.ended_at ? Date.parse(r.ended_at) : Date.now()) - Math.max(a, Date.parse(r.started_at))), 0) / 60000);
}

// At the end-of-day auto-stop, breaks still open are closed at that time
function closeOpenBreaks(stopHHMM) {
  if (!/^\d{2}:\d{2}$/.test(stopHHMM)) return;
  const [h, m] = stopHHMM.split(':').map(Number);
  for (const b of db().prepare('SELECT * FROM breaks WHERE ended_at IS NULL').all()) {
    const stop = new Date(b.started_at); stop.setHours(h, m, 0, 0);
    if (stop.getTime() <= Date.parse(b.started_at)) stop.setDate(stop.getDate() + 1);
    if (Date.now() >= stop.getTime()) db().prepare('UPDATE breaks SET ended_at = ?, note = ? WHERE id = ?').run(stop.toISOString(), 'Closed automatically at the end of the day', b.id);
  }
}

// Routes that work without signing in (registered BEFORE the login check)
function registerPublic(app, h) {
  // "Forgot password?" - the admin gets a request. The answer is the same whether or not the user exists.
  const tries = new Map();
  app.post('/api/password-help', h.wrap((req) => {
    const key = req.ip;
    const rec = (tries.get(key) || []).filter((t) => Date.now() - t < 15 * 60000);
    if (rec.length >= 3) h.fail(429, 'Too many requests. Please wait 15 minutes or speak to your admin.');
    rec.push(Date.now()); tries.set(key, rec);
    const username = String((req.body || {}).username || '').trim().toLowerCase();
    if (!username) h.fail(400, 'Please enter your username');
    const message = String((req.body || {}).message || '').trim().slice(0, 300);
    const u = db().prepare('SELECT id, name, active FROM users WHERE username = ?').get(username);
    if (u && u.active && !db().prepare("SELECT id FROM requests WHERE kind = 'password' AND user_id = ? AND status = 'pending'").get(u.id)) {
      const r = db().prepare(`INSERT INTO requests (kind, user_id, user_name, message, created_at) VALUES ('password', ?, ?, ?, ?)`)
        .run(u.id, u.name, message, nowISO());
      for (const a of admins()) h.notify(a.id, 'request', null, `🔑 ${u.name} cannot sign in`, 'Asked for a password reset. Open Requests to help.');
      audit({ actorId: null, action: 'password_help', entity: 'request', entityId: Number(r.lastInsertRowid), subjectUserId: u.id, details: message || 'Asked for a password reset' });
    }
    return { ok: true, message: 'Your request has been sent to the admin. They will give you a temporary password.' };
  }));
}

function register(app, h) {
  const isAdmin = (req) => req.user.role === 'admin';

  // ------------------------------------------------ sign out
  app.post('/api/me/signout-all', h.wrap((req) => {
    db().prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
    audit({ actorId: req.user.id, action: 'signed_out_everywhere', entity: 'user', entityId: req.user.id, subjectUserId: req.user.id });
    return { ok: true };
  }));
  app.post('/api/users/:id/signout', h.adminOnly, h.wrap((req) => {
    const id = Number(req.params.id);
    const r = db().prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    audit({ actorId: req.user.id, action: 'signed_out_by_admin', entity: 'user', entityId: id, subjectUserId: id, details: `${r.changes} session(s) ended` });
    return { ok: true, ended: r.changes };
  }));

  // ------------------------------------------------ history (admin)
  app.get('/api/audit', h.adminOnly, h.wrap((req) => {
    const q = req.query, where = [], args = [];
    if (q.user_id) { where.push('(subject_user_id = ? OR actor_id = ?)'); args.push(Number(q.user_id), Number(q.user_id)); }
    if (q.entity) { where.push('entity = ?'); args.push(String(q.entity)); }
    if (q.from) { where.push('at >= ?'); args.push(h.toISO(q.from)); }
    if (q.to) { where.push('at < ?'); args.push(h.toISO(q.to)); }
    if (q.task_id) { where.push("entity = 'task' AND entity_id = ?"); args.push(Number(q.task_id)); }
    if (q.q) { where.push('(label LIKE ? OR details LIKE ? OR actor_name LIKE ? OR subject_name LIKE ?)'); const s = `%${q.q}%`; args.push(s, s, s, s); }
    if (q.before) { where.push('id < ?'); args.push(Number(q.before)); }
    return db().prepare(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`).all(...args);
  }));

  // ------------------------------------------------ requests
  app.get('/api/requests', h.wrap((req) => {
    const where = [], args = [];
    if (!isAdmin(req)) { where.push('user_id = ?'); args.push(req.user.id); }
    if (req.query.status) { where.push('status = ?'); args.push(String(req.query.status)); }
    if (req.query.kind) { where.push('kind = ?'); args.push(String(req.query.kind)); }
    return db().prepare(`SELECT * FROM requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY status = 'pending' DESC, created_at DESC, id DESC LIMIT 300`)
      .all(...args).map(rowOut);
  }));

  app.post('/api/requests', h.wrap((req) => {
    const b = req.body || {};
    const kind = b.kind;
    if (!['time', 'review', 'leave'].includes(kind)) h.fail(400, 'Unknown request type');
    const message = h.requireText(b.message, 'Please explain', 5).slice(0, 1000);
    let task = null, payload = {}, original = {};

    if (kind === 'time' || kind === 'review') {
      task = h.getTask(b.task_id);
      if (task.user_id !== req.user.id) h.fail(403, 'This is not your task');
      if (task.archived_at) h.fail(400, 'This task was archived');
      if (db().prepare("SELECT id FROM requests WHERE task_id = ? AND kind = ? AND status = 'pending'").get(task.id, kind)) h.fail(400, 'You already have a request waiting for this task');
    }
    if (kind === 'time') {
      if (task.status === 'pending') h.fail(400, 'This task has not started yet - just start it with the right time');
      const start = b.start_time ? h.toISO(b.start_time) : null;
      const end = b.actual_end ? h.toISO(b.actual_end) : null;
      const brk = Math.max(0, Math.round(Number(b.break_minutes) || 0));
      if (end && task.status !== 'completed') h.fail(400, 'The finish time can only be corrected after the task is done');
      if (start && start !== task.start_time) payload.start_time = start;
      if (end && end !== task.actual_end) payload.actual_end = end;
      if (brk) payload.break_minutes = brk;
      if (!Object.keys(payload).length) h.fail(400, 'Please change at least one time');
      const s = payload.start_time || task.start_time, e = payload.actual_end || task.actual_end || nowISO();
      if (Date.parse(s) > Date.now() + 5 * 60000 || (payload.actual_end && Date.parse(payload.actual_end) > Date.now() + 5 * 60000)) h.fail(400, 'Times cannot be in the future');
      if (Date.parse(e) <= Date.parse(s)) h.fail(400, 'The finish time must be after the start time');
      if (brk && brk >= (Date.parse(e) - Date.parse(s)) / 60000) h.fail(400, 'The break is longer than the whole task');
      original = { start_time: task.start_time, actual_end: task.actual_end, paused_minutes: Math.round(task.paused_minutes || 0), worked_minutes: task.worked_minutes, status: task.status };
    }
    if (kind === 'review') {
      if (task.status !== 'completed') h.fail(400, 'You can ask for a review after the task is done');
      if (task.excused) h.fail(400, 'This task already counts as on time');
      original = { is_late: task.is_late, late_by_minutes: task.late_by_minutes, worked_minutes: task.worked_minutes, planned_minutes: task.planned_minutes, reason_status: task.reason_status };
    }
    if (kind === 'leave') {
      if (!isDay(b.from)) h.fail(400, 'Choose the first day');
      const to = isDay(b.to) ? b.to : b.from;
      if (to < b.from) h.fail(400, 'The last day cannot be before the first day');
      if ((Date.parse(to) - Date.parse(b.from)) / 86400000 > 30) h.fail(400, 'Please ask for at most 31 days at a time');
      if (b.from < ymd(Date.now() - 30 * 86400000)) h.fail(400, 'Leave older than 30 days cannot be requested here - please ask your admin');
      payload = { from: b.from, to, type: b.type === 'half_day' ? 'half_day' : 'leave', skip_sundays: b.skip_sundays !== false };
    }

    const r = db().prepare(`INSERT INTO requests (kind, user_id, user_name, task_id, task_title, payload, original, message, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(kind, req.user.id, req.user.name, task ? task.id : null, task ? task.title : '', JSON.stringify(payload), JSON.stringify(original), message, nowISO());
    const id = Number(r.lastInsertRowid);
    const what = { time: 'asked to correct a task time', review: 'asked for a task review', leave: 'asked for leave' }[kind];
    for (const a of admins()) h.notify(a.id, 'request', task ? task.id : null, `📨 ${req.user.name} ${what}`, task ? task.title : `${payload.from}${payload.to !== payload.from ? ' to ' + payload.to : ''}`);
    if (task) h.logEvent(task.id, req.user.id, 'requested', `${kind === 'time' ? 'Time correction' : 'Review'} requested: ${message}`);
    else audit({ actorId: req.user.id, action: 'requested', entity: 'request', entityId: id, subjectUserId: req.user.id, label: 'Leave', details: `${payload.from} → ${payload.to} (${payload.type}): ${message}` });
    return rowOut(db().prepare('SELECT * FROM requests WHERE id = ?').get(id));
  }));

  app.post('/api/requests/:id/cancel', h.wrap((req) => {
    const r = db().prepare('SELECT * FROM requests WHERE id = ?').get(Number(req.params.id));
    if (!r || (r.user_id !== req.user.id && !isAdmin(req))) h.fail(404, 'Request not found');
    if (r.status !== 'pending') h.fail(400, 'This request was already decided');
    db().prepare("UPDATE requests SET status = 'cancelled', decided_at = ? WHERE id = ?").run(nowISO(), r.id);
    audit({ actorId: req.user.id, action: 'request_cancelled', entity: 'request', entityId: r.id, subjectUserId: r.user_id, label: r.task_title || r.kind });
    return { ok: true };
  }));

  app.post('/api/requests/:id/decide', h.adminOnly, h.wrap((req) => {
    const r = db().prepare('SELECT * FROM requests WHERE id = ?').get(Number(req.params.id));
    if (!r) h.fail(404, 'Request not found');
    if (r.status !== 'pending') h.fail(400, 'This request was already decided');
    const b = req.body || {};
    const decision = b.decision === 'approved' ? 'approved' : b.decision === 'rejected' ? 'rejected' : h.fail(400, 'Choose approve or reject');
    const note = String(b.note || '').trim().slice(0, 1000);
    const p = parse(r.payload);
    let summary = '';

    db().exec('BEGIN');
    try {
      if (decision === 'approved') {
        if (r.kind === 'time') summary = applyTimeFix(h, r, p, req.user.id, note);
        if (r.kind === 'review') {
          const t = h.getTask(r.task_id);
          db().prepare('UPDATE tasks SET excused = 1, updated_at = ? WHERE id = ?').run(nowISO(), t.id);
          h.logEvent(t.id, req.user.id, 'excused', `Review approved - this task now counts as on time${note ? '. Note: ' + note : ''}`);
          summary = 'Task now counts as on time (100%)';
        }
        if (r.kind === 'leave') {
          const del = db().prepare('DELETE FROM leaves WHERE day = ? AND user_id = ?');
          const ins = db().prepare('INSERT INTO leaves (user_id, day, type, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)');
          let n = 0;
          for (let d = new Date(p.from + 'T12:00:00'); ymd(d) <= p.to; d.setDate(d.getDate() + 1)) {
            if (p.skip_sundays && d.getDay() === 0) continue;
            del.run(ymd(d), r.user_id); ins.run(r.user_id, ymd(d), p.type, r.message.slice(0, 200), req.user.id, nowISO()); n++;
          }
          summary = `${n} day(s) of ${p.type === 'half_day' ? 'half-day leave' : 'leave'} added`;
        }
        if (r.kind === 'password') {
          const pw = h.requireText(b.password, 'Temporary password', 6);
          db().prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(h.hashPassword(pw), r.user_id);
          db().prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user_id);
          summary = 'Temporary password set - they must choose a new one when they sign in';
        }
      }
      db().prepare('UPDATE requests SET status = ?, decided_by = ?, decided_by_name = ?, decided_at = ?, decision_note = ? WHERE id = ?')
        .run(decision, req.user.id, req.user.name, nowISO(), note, r.id);
      if (r.task_id && decision === 'rejected') h.logEvent(r.task_id, req.user.id, 'request_rejected', `${r.kind === 'time' ? 'Time correction' : 'Review'} not approved${note ? '. Note: ' + note : ''}`);
      audit({ actorId: req.user.id, action: `request_${decision}`, entity: 'request', entityId: r.id, subjectUserId: r.user_id,
        label: r.task_title || { leave: 'Leave', password: 'Password help' }[r.kind] || r.kind, details: [summary, note && `Note: ${note}`].filter(Boolean).join(' · ') });
      db().exec('COMMIT');
    } catch (e) { db().exec('ROLLBACK'); throw e; }

    if (r.kind !== 'password') {
      const label = { time: 'Time correction', review: 'Review', leave: 'Leave request' }[r.kind];
      h.notify(r.user_id, 'request', r.task_id, `${label} ${decision === 'approved' ? 'approved ✓' : 'not approved'}`, [r.task_title, note].filter(Boolean).join(' — '));
    }
    return rowOut(db().prepare('SELECT * FROM requests WHERE id = ?').get(r.id));
  }));

  // ------------------------------------------------ breaks
  app.get('/api/breaks/current', h.wrap((req) => db().prepare('SELECT * FROM breaks WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC').get(req.user.id) || null));

  app.get('/api/breaks', h.wrap((req) => {
    const uid = isAdmin(req) && req.query.user_id ? Number(req.query.user_id) : req.user.id;
    const from = h.toISO(req.query.from) || new Date(Date.now() - 86400000).toISOString();
    const to = h.toISO(req.query.to) || nowISO();
    return db().prepare('SELECT * FROM breaks WHERE user_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at').all(uid, to, from);
  }));

  app.post('/api/breaks/start', h.wrap((req) => {
    if (db().prepare('SELECT id FROM breaks WHERE user_id = ? AND ended_at IS NULL').get(req.user.id)) h.fail(400, 'You are already on a break');
    const kind = BREAK_KINDS[(req.body || {}).kind] ? req.body.kind : 'tea';
    const ts = nowISO();
    const running = db().prepare("SELECT id FROM tasks WHERE user_id = ? AND status = 'in_progress' AND archived_at IS NULL").all(req.user.id).map((t) => t.id);
    db().exec('BEGIN');
    try {
      for (const id of running) {
        db().prepare("UPDATE tasks SET status='on_hold', paused_at=?, hold_reason=?, updated_at=? WHERE id=?").run(ts, `Break: ${BREAK_KINDS[kind]}`, ts, id);
        h.logEvent(id, req.user.id, 'paused', `On hold. Reason: Break (${BREAK_KINDS[kind]})`);
      }
      db().prepare('INSERT INTO breaks (user_id, kind, started_at, paused_task_ids) VALUES (?, ?, ?, ?)').run(req.user.id, kind, ts, JSON.stringify(running));
      db().exec('COMMIT');
    } catch (e) { db().exec('ROLLBACK'); throw e; }
    return { ok: true, paused: running.length };
  }));

  app.post('/api/breaks/end', h.wrap((req) => {
    const b = db().prepare('SELECT * FROM breaks WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC').get(req.user.id);
    if (!b) h.fail(400, 'You are not on a break');
    const ts = nowISO();
    const mins = (Date.parse(ts) - Date.parse(b.started_at)) / 60000;
    const resume = (req.body || {}).resume !== false;
    let resumed = 0;
    db().exec('BEGIN');
    try {
      db().prepare('UPDATE breaks SET ended_at = ? WHERE id = ?').run(ts, b.id);
      if (resume) {
        for (const id of JSON.parse(b.paused_task_ids || '[]')) {
          const t = db().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
          if (!t || t.status !== 'on_hold' || !String(t.hold_reason || '').startsWith('Break:')) continue; // already changed by hand
          const held = t.paused_at ? (Date.parse(ts) - Date.parse(t.paused_at)) / 60000 : 0;
          db().prepare("UPDATE tasks SET status='in_progress', paused_at=NULL, hold_reason='', paused_minutes=paused_minutes+?, updated_at=? WHERE id=?").run(held, ts, id);
          h.logEvent(id, req.user.id, 'resumed', `Back from break after ${Math.round(held)} min`);
          resumed++;
        }
      }
      db().exec('COMMIT');
    } catch (e) { db().exec('ROLLBACK'); throw e; }
    return { ok: true, minutes: Math.round(mins), resumed };
  }));
}

// A time correction approved by the admin: the original values stay in the request and in the history
function applyTimeFix(h, r, p, adminId, note) {
  const t = h.getTask(r.task_id);
  const start = p.start_time || t.start_time;
  const end = t.status === 'completed' ? (p.actual_end || t.actual_end) : null;
  const paused = (t.paused_minutes || 0) + (p.break_minutes || 0);
  if (end && Date.parse(end) <= Date.parse(start)) h.fail(400, 'Finish time would be before the start time');
  const changes = [];
  if (p.start_time) changes.push(`Start: ${fmt(t.start_time)} → ${fmt(p.start_time)}`);
  if (p.actual_end) changes.push(`Finish: ${fmt(t.actual_end)} → ${fmt(p.actual_end)}`);
  if (p.break_minutes) changes.push(`Break added: ${p.break_minutes} min (not counted as work)`);
  // the planned length stays the same when the start moves
  let expected = t.expected_end;
  if (p.start_time && t.start_time) expected = new Date(Date.parse(t.expected_end) + (Date.parse(p.start_time) - Date.parse(t.start_time))).toISOString();
  let reasonStatus = t.reason_status;
  if (t.status === 'completed') {
    const late = Date.parse(end) > Date.parse(expected) + paused * 60000 + h.LATE_GRACE_MS;
    if (!late) reasonStatus = 'none';
    else if (reasonStatus === 'none') reasonStatus = t.delay_reason ? 'pending' : 'none';
  }
  db().prepare('UPDATE tasks SET start_time=?, expected_end=?, actual_end=?, paused_minutes=?, reason_status=?, updated_at=? WHERE id=?')
    .run(start, expected, end, paused, reasonStatus, nowISO(), t.id);
  h.logEvent(t.id, adminId, 'corrected', `Time corrected (request #${r.id}). ${changes.join(' ; ')}${note ? '. Note: ' + note : ''}`);
  return changes.join(' ; ');
}

module.exports = { audit, auditTaskEvent, register, registerPublic, requestsForTask, breakMinutes, closeOpenBreaks };
