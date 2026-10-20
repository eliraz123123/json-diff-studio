import { decrypt } from "./crypto.js";
import { transaction } from "./db.js";
import { isBreaking, observe, summarizeDrift } from "./drift.js";

const FAILURES_BEFORE_DOWN = 2;
const KEEP_CHECKS = 500;
const KEEP_EVENTS = 500;
const USER_AGENT = "JSONDiffStudio-Monitor/1.0";

async function fetchJson(monitor, { config, request }) {
  try {
    const headers = monitor.headers_enc ? JSON.parse(decrypt(monitor.headers_enc, config.appSecret)) : {};
    const response = await request(monitor.url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT, ...headers },
      allowPrivate: config.allowPrivateTargets
    });
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, statusCode: response.status, error: `HTTP ${response.status}` };
    }
    try {
      return { ok: true, statusCode: response.status, value: JSON.parse(response.body) };
    } catch {
      return { ok: false, statusCode: response.status, error: "Response body is not valid JSON" };
    }
  } catch (error) {
    return { ok: false, statusCode: null, error: error.message || String(error) };
  }
}

// `monitor` is a monitors row joined with the owner's `user_email` and `user_plan`.
export async function runCheck({ db, config, notifier, request, now }, monitor) {
  const startedAt = now();
  const outcome = await fetchJson(monitor, { config, request });
  const durationMs = now() - startedAt;

  let state = monitor.state ? JSON.parse(monitor.state) : null;
  let { status, failure_streak: failureStreak } = monitor;
  let changes = [];
  const events = [];

  if (outcome.ok) {
    try {
      const result = observe(state, outcome.value, { ignore: JSON.parse(monitor.ignore_paths) });
      state = result.state;
      changes = result.changes;
      if (result.baselineCaptured) {
        events.push({ kind: "baseline", summary: `Learned ${Object.keys(state.baseline).length} fields from the first response`, changes: [] });
      } else if (changes.length) {
        events.push({ kind: "drift", summary: summarizeDrift(changes), changes });
      }
    } catch (error) {
      outcome.ok = false;
      outcome.error = error.message;
    }
  }

  if (outcome.ok) {
    if (status === "down") events.push({ kind: "recovered", summary: "Endpoint is returning valid JSON again", changes: [] });
    status = "healthy";
    failureStreak = 0;
  } else {
    failureStreak += 1;
    if (failureStreak >= FAILURES_BEFORE_DOWN && status !== "down") {
      status = "down";
      events.push({ kind: "down", summary: outcome.error, changes: [] });
    }
  }

  const checkedAt = now();
  const saved = transaction(db, () => {
    // Matching on url skips the write if the monitor was deleted or re-pointed mid-check.
    const updated = db.prepare(`
      UPDATE monitors SET state = ?, status = ?, failure_streak = ?, last_checked_at = ?, last_status_code = ?, last_error = ?
      WHERE id = ? AND url = ?
    `).run(state ? JSON.stringify(state) : null, status, failureStreak, checkedAt, outcome.statusCode, outcome.ok ? null : outcome.error, monitor.id, monitor.url);
    if (updated.changes === 0) return false;

    db.prepare(`
      INSERT INTO checks (monitor_id, checked_at, ok, status_code, duration_ms, error, change_count) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(monitor.id, checkedAt, outcome.ok ? 1 : 0, outcome.statusCode, durationMs, outcome.ok ? null : outcome.error, changes.length);
    const insertEvent = db.prepare("INSERT INTO events (monitor_id, created_at, kind, summary, changes) VALUES (?, ?, ?, ?, ?)");
    for (const event of events) insertEvent.run(monitor.id, checkedAt, event.kind, event.summary, JSON.stringify(event.changes));
    db.prepare("DELETE FROM checks WHERE monitor_id = ? AND id <= (SELECT id FROM checks WHERE monitor_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)")
      .run(monitor.id, monitor.id, KEEP_CHECKS);
    db.prepare("DELETE FROM events WHERE monitor_id = ? AND id <= (SELECT id FROM events WHERE monitor_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)")
      .run(monitor.id, monitor.id, KEEP_EVENTS);
    return true;
  });
  if (!saved) return { skipped: true };

  for (const event of events) {
    if (event.kind === "baseline") continue;
    if (event.kind === "drift" && monitor.notify === "breaking" && !event.changes.some(isBreaking)) continue;
    await notifier.notify({ monitor, event });
  }

  return { ok: outcome.ok, statusCode: outcome.statusCode, durationMs, error: outcome.ok ? null : outcome.error, status, changes, events };
}
