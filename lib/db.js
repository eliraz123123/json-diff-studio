import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Each entry runs once, in order; the index is stored in SQLite's user_version.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'free',
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    billing_updated_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX users_stripe_customer ON users(stripe_customer_id);

  CREATE TABLE login_tokens (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  -- paused: 0 = active, 1 = paused by the user, 2 = paused because the plan limit dropped
  CREATE TABLE monitors (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    headers_enc TEXT,
    header_names TEXT NOT NULL DEFAULT '[]',
    interval_minutes INTEGER NOT NULL,
    ignore_paths TEXT NOT NULL DEFAULT '[]',
    notify TEXT NOT NULL DEFAULT 'all',
    email_alerts INTEGER NOT NULL DEFAULT 1,
    alert_webhook_enc TEXT,
    paused INTEGER NOT NULL DEFAULT 0,
    state TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    failure_streak INTEGER NOT NULL DEFAULT 0,
    last_checked_at INTEGER,
    last_status_code INTEGER,
    last_error TEXT,
    next_check_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX monitors_due ON monitors(paused, next_check_at);
  CREATE INDEX monitors_user ON monitors(user_id);

  CREATE TABLE checks (
    id INTEGER PRIMARY KEY,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    checked_at INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    status_code INTEGER,
    duration_ms INTEGER,
    error TEXT,
    change_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX checks_monitor ON checks(monitor_id, id);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    changes TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX events_monitor ON events(monitor_id, id);
  `
];

export function openDatabase(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const { user_version: version } = db.prepare("PRAGMA user_version").get();
  for (let index = version; index < MIGRATIONS.length; index += 1) {
    transaction(db, () => {
      db.exec(MIGRATIONS[index]);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    });
  }
  return db;
}

export function transaction(db, work) {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
