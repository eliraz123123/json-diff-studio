import { effectiveIntervalMinutes } from "./plans.js";

export const MONITOR_WITH_OWNER = `
  SELECT monitors.*, users.email AS user_email, users.plan AS user_plan
  FROM monitors JOIN users ON users.id = monitors.user_id
`;

// Polls SQLite for due monitors. One process owns the schedule, so this must run on a
// single instance; see README "Deploy".
export function createScheduler({ db, runCheck, intervalMs = 15_000, concurrency = 4, now = Date.now }) {
  const running = new Map();
  const due = db.prepare(`${MONITOR_WITH_OWNER} WHERE monitors.paused = 0 AND monitors.next_check_at <= ? ORDER BY monitors.next_check_at LIMIT ?`);
  const reschedule = db.prepare("UPDATE monitors SET next_check_at = ? WHERE id = ?");
  let timer = null;

  function run(monitor) {
    if (running.has(monitor.id)) return running.get(monitor.id);
    reschedule.run(now() + effectiveIntervalMinutes(monitor.interval_minutes, monitor.user_plan) * 60_000, monitor.id);
    const job = Promise.resolve()
      .then(() => runCheck(monitor))
      .catch(error => {
        console.error(`Check for monitor ${monitor.id} crashed:`, error);
        return null;
      })
      .finally(() => running.delete(monitor.id));
    running.set(monitor.id, job);
    return job;
  }

  function tick() {
    if (running.size >= concurrency) return;
    for (const monitor of due.all(now(), concurrency + running.size)) {
      if (running.size >= concurrency) break;
      if (!running.has(monitor.id)) run(monitor);
    }
  }

  return {
    run,
    tick,
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      tick();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    idle: () => Promise.all(running.values())
  };
}
