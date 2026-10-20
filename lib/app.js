import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMailer, createNotifier } from "./alerts.js";
import {
  createLoginToken, destroySession, normalizeEmail, redeemLoginToken, sessionCookie, sessionUser
} from "./auth.js";
import {
  billingEnabled, createCheckoutSession, createPortalSession, enforcePlanLimits, handleStripeEvent, verifyStripeSignature
} from "./billing.js";
import { decrypt, encrypt } from "./crypto.js";
import { openDatabase } from "./db.js";
import { runCheck } from "./monitor.js";
import { effectiveIntervalMinutes, INTERVALS, PLANS, planFor } from "./plans.js";
import { createRateLimiter } from "./rate-limit.js";
import { safeRequest } from "./safe-fetch.js";
import { createScheduler, MONITOR_WITH_OWNER } from "./scheduler.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = "text/html; charset=utf-8";
const JS = "text/javascript; charset=utf-8";
const STATIC = {
  "/": ["index.html", HTML],
  "/index.html": ["index.html", HTML],
  "/app": ["dashboard.html", HTML],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", JS],
  "/dashboard.js": ["dashboard.js", JS],
  "/diff.js": ["diff.js", JS],
  "/shape.js": ["shape.js", JS]
};
const CSP = [
  "default-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "expect"]);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp({ config, mailer = createMailer(config), request = safeRequest, now = Date.now, fetchSubscriptions }) {
  const db = openDatabase(config.databasePath);
  const notifier = createNotifier({ config, mailer, request });
  const scheduler = createScheduler({
    db,
    intervalMs: config.schedulerIntervalMs,
    now,
    runCheck: monitor => runCheck({ db, config, notifier, request, now }, monitor)
  });
  const loginLimiter = createRateLimiter({ limit: 5, windowMs: 15 * 60_000, now });
  // Per user, not per monitor: deleting and recreating a monitor must not reset the quota.
  const manualCheckLimiter = createRateLimiter({ limit: 5, windowMs: 60_000, now });
  const createLimiter = createRateLimiter({ limit: 30, windowMs: 60 * 60_000, now });
  const secureCookies = config.baseUrl.startsWith("https://");
  const allowedOrigin = new URL(config.baseUrl).origin;

  const clientIp = req => {
    if (config.trustProxy) {
      const forwarded = req.headers["fly-client-ip"] ?? req.headers["x-forwarded-for"]?.split(",")[0];
      if (forwarded) return String(forwarded).trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  // Unpausing or relearning must not let a user check faster than their plan allows.
  const earliestCheck = (row, user, intervalMinutes = row.interval_minutes) => Math.max(
    now(),
    (row.last_checked_at ?? 0) + effectiveIntervalMinutes(intervalMinutes, user.plan) * 60_000
  );

  const countActive = userId => db.prepare("SELECT COUNT(*) AS count FROM monitors WHERE user_id = ? AND paused = 0").get(userId).count;

  function loadMonitor(user, id) {
    const row = db.prepare("SELECT * FROM monitors WHERE id = ? AND user_id = ?").get(Number(id), user.id);
    if (!row) throw new HttpError(404, "Monitor not found");
    return row;
  }

  function publicMonitor(row, user) {
    const state = row.state ? JSON.parse(row.state) : null;
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      headerNames: JSON.parse(row.header_names),
      intervalMinutes: row.interval_minutes,
      effectiveIntervalMinutes: effectiveIntervalMinutes(row.interval_minutes, user.plan),
      ignorePaths: JSON.parse(row.ignore_paths),
      notify: row.notify,
      emailAlerts: Boolean(row.email_alerts),
      alertWebhookHost: row.alert_webhook_enc ? new URL(decrypt(row.alert_webhook_enc, config.appSecret)).host : null,
      paused: row.paused !== 0,
      pausedReason: row.paused === 2 ? "plan" : row.paused === 1 ? "user" : null,
      status: row.status,
      lastCheckedAt: row.last_checked_at,
      lastStatusCode: row.last_status_code,
      lastError: row.last_error,
      nextCheckAt: row.paused ? null : row.next_check_at,
      learnedFields: state ? Object.keys(state.baseline).length : 0,
      createdAt: row.created_at
    };
  }

  function validateMonitor(body, user, existing) {
    const plan = planFor(user.plan);
    const fields = {};
    const has = key => Object.hasOwn(body, key);

    if (!existing || has("name")) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 100) throw new HttpError(400, "Name must be 1–100 characters.");
      fields.name = name;
    }
    if (!existing || has("url")) {
      let url;
      try {
        url = new URL(body.url);
      } catch {
        throw new HttpError(400, "Enter a full URL, including https://.");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "URL must use http or https.");
      if (url.username || url.password) throw new HttpError(400, "Put credentials in a header (for example Authorization), not in the URL.");
      if (url.href.length > 2048) throw new HttpError(400, "URL is too long.");
      fields.url = url.href;
    }
    if (has("headers") || !existing) {
      const headers = body.headers ?? {};
      if (typeof headers !== "object" || Array.isArray(headers)) throw new HttpError(400, "Headers must be an object.");
      const entries = Object.entries(headers);
      if (entries.length > 20) throw new HttpError(400, "Use at most 20 headers.");
      const clean = {};
      for (const [name, value] of entries) {
        const key = name.trim().toLowerCase();
        if (!HEADER_NAME.test(key) || FORBIDDEN_HEADERS.has(key)) throw new HttpError(400, `Header "${name}" is not allowed.`);
        if (typeof value !== "string" || value.length > 4096 || /[\r\n\0]/.test(value)) throw new HttpError(400, `Header "${name}" has an invalid value.`);
        clean[key] = value;
      }
      fields.headers_enc = entries.length ? encrypt(JSON.stringify(clean), config.appSecret) : null;
      fields.header_names = JSON.stringify(Object.keys(clean));
    }
    if (!existing || has("intervalMinutes")) {
      const interval = Number(body.intervalMinutes ?? plan.minIntervalMinutes);
      if (!INTERVALS.includes(interval)) throw new HttpError(400, `Interval must be one of ${INTERVALS.join(", ")} minutes.`);
      if (interval < plan.minIntervalMinutes) {
        throw new HttpError(402, `The ${plan.name} plan checks at most every ${plan.minIntervalMinutes} minutes. Upgrade for faster checks.`);
      }
      fields.interval_minutes = interval;
    }
    if (has("ignorePaths")) {
      const paths = body.ignorePaths;
      if (!Array.isArray(paths) || paths.length > 50 || paths.some(path => typeof path !== "string" || !path.startsWith("$") || path.length > 300 || path.split("*").length > 11)) {
        throw new HttpError(400, "Ignore paths must be up to 50 paths that start with $ (for example $.meta.requestId).");
      }
      fields.ignore_paths = JSON.stringify(paths);
    }
    if (has("notify")) {
      if (!["all", "breaking"].includes(body.notify)) throw new HttpError(400, "Notify must be \"all\" or \"breaking\".");
      fields.notify = body.notify;
    }
    if (has("emailAlerts")) fields.email_alerts = body.emailAlerts ? 1 : 0;
    if (has("alertWebhook")) {
      if (!body.alertWebhook) {
        fields.alert_webhook_enc = null;
      } else if (!plan.webhooks) {
        throw new HttpError(402, `Slack, Discord and webhook alerts are not included in the ${plan.name} plan. Upgrade to add one, or use email alerts.`);
      } else {
        let url;
        try {
          url = new URL(body.alertWebhook);
        } catch {
          throw new HttpError(400, "Alert webhook must be a full https:// URL.");
        }
        if (url.protocol !== "https:" && !config.allowPrivateTargets) throw new HttpError(400, "Alert webhook must use https.");
        fields.alert_webhook_enc = encrypt(url.href, config.appSecret);
      }
    }
    return fields;
  }

  const routes = [];
  const route = (method, pattern, handler, options = {}) => routes.push({ method, pattern, handler, auth: true, ...options });

  route("GET", /^\/api\/plans$/, () => ({ plans: Object.values(PLANS), intervals: INTERVALS, billingEnabled: billingEnabled(config) }), { auth: false });

  route("POST", /^\/api\/auth\/login$/, async ({ body, req }) => {
    const email = normalizeEmail(body.email);
    if (!email) throw new HttpError(400, "Enter a valid email address.");
    if (!loginLimiter(`ip:${clientIp(req)}`) || !loginLimiter(`email:${email}`)) {
      throw new HttpError(429, "Too many sign-in requests. Try again in a few minutes.");
    }
    const token = createLoginToken(db, email, now());
    await mailer.send({
      to: email,
      subject: "Your JSON Diff Studio sign-in link",
      text: `Sign in to JSON Diff Studio:\n${config.baseUrl}/app?login=${token}\n\nThe link works once and expires in 15 minutes. If you did not ask for it, ignore this email.`
    });
    return { ok: true };
  }, { auth: false });

  route("POST", /^\/api\/auth\/verify$/, ({ body, res }) => {
    const result = redeemLoginToken(db, body.token, now());
    if (!result) throw new HttpError(400, "This sign-in link is invalid or has expired. Request a new one.");
    res.setHeader("Set-Cookie", sessionCookie(result.session, secureCookies));
    return { ok: true };
  }, { auth: false });

  route("POST", /^\/api\/auth\/logout$/, ({ req, res }) => {
    destroySession(db, req.headers.cookie);
    res.setHeader("Set-Cookie", sessionCookie(null, secureCookies));
    return { ok: true };
  }, { auth: false });

  route("GET", /^\/api\/me$/, ({ user }) => ({
    user: { email: user.email, plan: user.plan, hasBilling: Boolean(user.stripe_customer_id) },
    plan: planFor(user.plan),
    usage: { activeMonitors: countActive(user.id) },
    billingEnabled: billingEnabled(config)
  }));

  route("GET", /^\/api\/monitors$/, ({ user }) => ({
    monitors: db.prepare("SELECT * FROM monitors WHERE user_id = ? ORDER BY created_at DESC, id DESC").all(user.id)
      .map(row => publicMonitor(row, user))
  }));

  route("POST", /^\/api\/monitors$/, ({ body, user }) => {
    if (!createLimiter(`user:${user.id}`)) throw new HttpError(429, "Too many monitors created recently. Try again later.");
    const fields = validateMonitor(body, user, null);
    const plan = planFor(user.plan);
    if (countActive(user.id) >= plan.monitors) {
      throw new HttpError(402, `The ${plan.name} plan includes ${plan.monitors} active monitors. Upgrade or pause one to add another.`);
    }
    const time = now();
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO monitors (user_id, name, url, headers_enc, header_names, interval_minutes, ignore_paths, notify, email_alerts, alert_webhook_enc, next_check_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id, fields.name, fields.url, fields.headers_enc, fields.header_names, fields.interval_minutes,
      fields.ignore_paths ?? "[]", fields.notify ?? "all", fields.email_alerts ?? 1, fields.alert_webhook_enc ?? null, time, time
    );
    scheduler.tick();
    return { monitor: publicMonitor(loadMonitor(user, lastInsertRowid), user) };
  });

  route("GET", /^\/api\/monitors\/(\d+)$/, ({ params, user }) => {
    const row = loadMonitor(user, params[0]);
    const state = row.state ? JSON.parse(row.state) : null;
    return {
      monitor: publicMonitor(row, user),
      schema: state?.baseline ?? {},
      events: db.prepare("SELECT id, created_at, kind, summary, changes FROM events WHERE monitor_id = ? ORDER BY id DESC LIMIT 50").all(row.id)
        .map(event => ({ ...event, changes: JSON.parse(event.changes) })),
      checks: db.prepare("SELECT checked_at, ok, status_code, duration_ms, error, change_count FROM checks WHERE monitor_id = ? ORDER BY id DESC LIMIT 30").all(row.id)
    };
  });

  route("PATCH", /^\/api\/monitors\/(\d+)$/, ({ params, body, user }) => {
    const row = loadMonitor(user, params[0]);
    const fields = validateMonitor(body, user, row);
    if (Object.hasOwn(body, "paused")) {
      if (body.paused) fields.paused = 1;
      else if (row.paused !== 0) {
        const plan = planFor(user.plan);
        if (countActive(user.id) >= plan.monitors) {
          throw new HttpError(402, `The ${plan.name} plan includes ${plan.monitors} active monitors. Upgrade or pause another one first.`);
        }
        fields.paused = 0;
        fields.next_check_at = earliestCheck(row, user);
      }
    }
    if (fields.interval_minutes && fields.interval_minutes !== row.interval_minutes && !row.paused) {
      fields.next_check_at = Math.min(row.next_check_at, earliestCheck(row, user, fields.interval_minutes));
    }
    // Un-ignoring a path would report everything under it as "added"; relearn instead.
    const oldIgnore = JSON.parse(row.ignore_paths);
    if (fields.ignore_paths && oldIgnore.some(path => !JSON.parse(fields.ignore_paths).includes(path))) {
      Object.assign(fields, { state: null, generation: row.generation + 1 });
    }
    if (fields.url && fields.url !== row.url) {
      Object.assign(fields, { state: null, generation: row.generation + 1, status: "pending", failure_streak: 0, last_error: null, next_check_at: earliestCheck(row, user) });
      // Saved headers are write-only; re-pointing the monitor at another host must not
      // send them there. New headers in the same request are kept.
      if (new URL(fields.url).origin !== new URL(row.url).origin && !Object.hasOwn(body, "headers")) {
        fields.headers_enc = null;
        fields.header_names = "[]";
      }
    }
    const columns = Object.keys(fields);
    if (columns.length) {
      db.prepare(`UPDATE monitors SET ${columns.map(column => `${column} = ?`).join(", ")} WHERE id = ?`)
        .run(...columns.map(column => fields[column]), row.id);
    }
    return { monitor: publicMonitor(loadMonitor(user, row.id), user) };
  });

  route("DELETE", /^\/api\/monitors\/(\d+)$/, ({ params, user }) => {
    const row = loadMonitor(user, params[0]);
    db.prepare("DELETE FROM monitors WHERE id = ?").run(row.id);
    return { ok: true };
  });

  route("POST", /^\/api\/monitors\/(\d+)\/check$/, async ({ params, user }) => {
    const row = loadMonitor(user, params[0]);
    if (!manualCheckLimiter(`user:${user.id}`)) throw new HttpError(429, "Wait a minute before running more checks.");
    if (scheduler.busy()) throw new HttpError(503, "The checker is busy. Try again in a few seconds.");
    const result = await scheduler.run(db.prepare(`${MONITOR_WITH_OWNER} WHERE monitors.id = ?`).get(row.id));
    if (!result) throw new HttpError(500, "The check could not run. Try again shortly.");
    return { result, monitor: publicMonitor(loadMonitor(user, row.id), user) };
  });

  route("POST", /^\/api\/monitors\/(\d+)\/reset$/, ({ params, user }) => {
    const row = loadMonitor(user, params[0]);
    db.prepare("UPDATE monitors SET state = NULL, generation = generation + 1, next_check_at = ? WHERE id = ?").run(earliestCheck(row, user), row.id);
    return { monitor: publicMonitor(loadMonitor(user, row.id), user) };
  });

  route("POST", /^\/api\/billing\/checkout$/, async ({ body, user }) => {
    if (!billingEnabled(config)) throw new HttpError(503, "Billing is not configured on this server.");
    if (!["starter", "team"].includes(body.plan)) throw new HttpError(400, "Choose the starter or team plan.");
    if (user.stripe_subscription_id) throw new HttpError(409, "You already have a subscription. Use Manage billing to change plans.");
    return { url: await createCheckoutSession(config, user, body.plan) };
  });

  route("POST", /^\/api\/billing\/portal$/, async ({ user }) => {
    if (!billingEnabled(config)) throw new HttpError(503, "Billing is not configured on this server.");
    if (!user.stripe_customer_id) throw new HttpError(400, "There is no billing account yet.");
    return { url: await createPortalSession(config, user) };
  });

  route("POST", /^\/api\/stripe\/webhook$/, async ({ raw, req }) => {
    if (!verifyStripeSignature(raw, req.headers["stripe-signature"], config.stripe.webhookSecret, now())) {
      throw new HttpError(400, "Invalid signature");
    }
    // A failure here returns 500, so Stripe retries the event later.
    await handleStripeEvent(db, config, JSON.parse(raw.toString("utf8")), now(), fetchSubscriptions);
    return { received: true };
  }, { auth: false, raw: true });

  async function handleApi(req, res, pathname) {
    const match = routes.find(entry => entry.pattern.test(pathname) && entry.method === req.method);
    if (!match) {
      const exists = routes.some(entry => entry.pattern.test(pathname));
      throw new HttpError(exists ? 405 : 404, exists ? "Method not allowed" : "Not found");
    }
    const raw = req.method === "GET" ? Buffer.alloc(0) : await readBody(req, 1_000_000);
    let body = {};
    if (!match.raw && req.method !== "GET") {
      // Requiring JSON forces a CORS preflight for cross-site requests; the Origin check
      // rejects any that get through. Together they stop CSRF against cookie sessions.
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Send JSON");
      if (req.headers.origin && req.headers.origin !== allowedOrigin) throw new HttpError(403, "Cross-origin request blocked");
      try {
        body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      } catch {
        throw new HttpError(400, "Request body is not valid JSON");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Request body must be a JSON object");
    }
    const user = match.auth ? sessionUser(db, req.headers.cookie, now()) : null;
    if (match.auth && !user) throw new HttpError(401, "Sign in to continue");
    const params = pathname.match(match.pattern).slice(1);
    return match.handler({ req, res, body, raw, user, params });
  }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, "http://localhost");
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (secureCookies) res.setHeader("Strict-Transport-Security", "max-age=31536000");

    if (pathname.startsWith("/api/")) {
      try {
        const data = await handleApi(req, res, pathname);
        sendJson(res, 200, data);
      } catch (error) {
        if (error instanceof HttpError) sendJson(res, error.status, { error: error.message });
        else {
          console.error(error);
          sendJson(res, 500, { error: "Something went wrong. Try again." });
        }
      }
      return;
    }

    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    const entry = STATIC[pathname];
    if (!entry || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    try {
      const content = await readFile(join(root, entry[0]));
      res.writeHead(200, { "Content-Type": entry[1], "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch {
      res.writeHead(500);
      res.end("Could not load file");
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      console.error(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  return {
    server,
    db,
    scheduler,
    enforcePlanLimits: userId => enforcePlanLimits(db, userId, now()),
    async close() {
      scheduler.stop();
      await scheduler.idle();
      await new Promise(resolve => server.close(resolve));
      db.close();
    }
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "Request body is too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
