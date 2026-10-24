// Database upgrades shared by the office version and the Firebase version (same file in both).
// Called once by db.js after its own migrations.
module.exports = function upgrade(db) {
  const version = () => db.prepare('PRAGMA user_version').get().user_version;

  // v5: change history, employee requests (time fix / review / leave / password help), breaks, excused tasks
  if (version() < 5) {
    db.exec(`
      -- Permanent history of important changes. No links to other tables on purpose:
      -- names are copied in, so the history stays even when a user is deactivated or a task is deleted.
      CREATE TABLE IF NOT EXISTS audit_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        at              TEXT NOT NULL,
        actor_id        INTEGER,
        actor_name      TEXT NOT NULL DEFAULT 'System',
        action          TEXT NOT NULL,
        entity          TEXT NOT NULL,          -- task | user | leave | request | settings
        entity_id       INTEGER,
        subject_user_id INTEGER,                -- whose record it is (task owner, the user changed, ...)
        subject_name    TEXT DEFAULT '',
        label           TEXT DEFAULT '',        -- task title, etc.
        details         TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
      CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_log(subject_user_id);

      -- Requests from employees that the admin decides on
      CREATE TABLE IF NOT EXISTS requests (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        kind            TEXT NOT NULL,          -- time | review | leave | password
        user_id         INTEGER,
        user_name       TEXT DEFAULT '',
        task_id         INTEGER,
        task_title      TEXT DEFAULT '',
        payload         TEXT NOT NULL DEFAULT '{}',   -- what is asked for (JSON)
        original        TEXT NOT NULL DEFAULT '{}',   -- the values before any change (JSON)
        message         TEXT DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | cancelled
        decided_by      INTEGER,
        decided_by_name TEXT DEFAULT '',
        decided_at      TEXT,
        decision_note   TEXT DEFAULT '',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
      CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user_id);

      -- Breaks (tea, lunch, personal): running tasks are put on hold for the break
      CREATE TABLE IF NOT EXISTS breaks (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL,
        kind            TEXT NOT NULL,
        started_at      TEXT NOT NULL,
        ended_at        TEXT,
        paused_task_ids TEXT NOT NULL DEFAULT '[]',
        note            TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_breaks_user ON breaks(user_id, started_at);

      -- a task the admin excused after a review request counts as on time (100%)
      ALTER TABLE tasks ADD COLUMN excused INTEGER NOT NULL DEFAULT 0;

      INSERT OR IGNORE INTO settings (key, value) VALUES ('work_hours_per_day', '8');

      -- start the history with everything already recorded on tasks
      INSERT INTO audit_log (at, actor_id, actor_name, action, entity, entity_id, subject_user_id, subject_name, label, details)
        SELECT e.at, e.user_id, COALESCE(a.name, 'System'), e.type, 'task', e.task_id, t.user_id, COALESCE(o.name, ''), t.title, COALESCE(e.note, '')
        FROM task_events e JOIN tasks t ON t.id = e.task_id
        LEFT JOIN users a ON a.id = e.user_id LEFT JOIN users o ON o.id = t.user_id
        ORDER BY e.at, e.id;

      PRAGMA user_version = 5;`);
  }
};
