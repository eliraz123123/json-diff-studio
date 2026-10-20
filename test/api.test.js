import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../lib/app.js";
import { loadConfig } from "../lib/config.js";

// End-to-end: sign in, create a monitor against a local API, change that API's response
// and check that drift is recorded and alerted.
async function start(t) {
  let response = { id: 1, name: "Ada", plan: { tier: "pro" } };
  let webhookCalls = [];
  const target = createServer((req, res) => {
    if (req.url === "/hook") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => { webhookCalls.push(JSON.parse(body)); res.end("ok"); });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...response, seenAuth: req.headers["x-api-key"] ?? null }));
  });
  await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));

  const emails = [];
  const config = loadConfig({ DATABASE_PATH: ":memory:", ALLOW_PRIVATE_TARGETS: "true", BASE_URL: "http://localhost:0" });
  const app = createApp({ config, mailer: { send: async message => { emails.push(message); } } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); target.close(); });

  const call = async (path, { method = "GET", body, cookie, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(method === "GET" ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {})
    });
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  };

  async function signIn(email) {
    assert.equal((await call("/api/auth/login", { method: "POST", body: { email } })).status, 200);
    const token = emails.at(-1).text.match(/login=([\w-]+)/)[1];
    const verified = await call("/api/auth/verify", { method: "POST", body: { token } });
    assert.equal(verified.status, 200);
    assert.equal((await call("/api/auth/verify", { method: "POST", body: { token } })).status, 400, "links are single use");
    return verified.headers.get("set-cookie").split(";")[0];
  }

  return {
    app, call, emails, signIn,
    targetUrl: `http://127.0.0.1:${target.address().port}/user`,
    hookUrl: `http://127.0.0.1:${target.address().port}/hook`,
    setResponse: value => { response = value; },
    webhookCalls: () => webhookCalls
  };
}

test("monitors an endpoint and alerts on schema drift", async t => {
  const env = await start(t);
  const cookie = await env.signIn("Owner@Example.com");
  const free = await env.call("/api/monitors", { method: "POST", cookie, body: { name: "x", url: env.targetUrl, intervalMinutes: 60, alertWebhook: env.hookUrl } });
  assert.equal(free.status, 402, "webhook alerts need a paid plan");
  env.app.db.prepare("UPDATE users SET plan = 'starter' WHERE email = ?").run("owner@example.com");

  const me = await env.call("/api/me", { cookie });
  assert.equal(me.data.user.email, "owner@example.com");
  assert.equal(me.data.user.plan, "starter");

  const created = await env.call("/api/monitors", {
    method: "POST",
    cookie,
    body: { name: "Users API", url: env.targetUrl, headers: { "X-Api-Key": "k-123" }, intervalMinutes: 60, alertWebhook: env.hookUrl }
  });
  assert.equal(created.status, 200);
  const id = created.data.monitor.id;
  assert.deepEqual(created.data.monitor.headerNames, ["x-api-key"]);
  assert.equal(JSON.stringify(created.data).includes("k-123"), false, "header values are never returned");

  await env.app.scheduler.idle();
  let detail = await env.call(`/api/monitors/${id}`, { cookie });
  assert.equal(detail.data.monitor.status, "healthy");
  assert.equal(detail.data.events[0].kind, "baseline");
  assert.deepEqual(detail.data.schema["$.plan.tier"], ["string"]);
  assert.deepEqual(detail.data.schema["$.seenAuth"], ["string"], "the saved header is sent");

  env.setResponse({ id: "1", name: "Ada", plan: { tier: "pro" }, email: "ada@example.com" });
  const checked = await env.call(`/api/monitors/${id}/check`, { method: "POST", cookie });
  assert.equal(checked.status, 200);
  assert.deepEqual(checked.data.result.changes.map(change => [change.type, change.path]), [
    ["added", "$.email"],
    ["changed", "$.id"]
  ]);

  detail = await env.call(`/api/monitors/${id}`, { cookie });
  assert.equal(detail.data.events[0].kind, "drift");
  assert.equal(detail.data.events[0].summary, "1 new type · 1 added");
  const alertEmail = env.emails.at(-1);
  assert.equal(alertEmail.to, "owner@example.com");
  assert.match(alertEmail.text, /~ new type \$\.id: number → number \| string/);
  assert.equal(env.webhookCalls().length, 1);
  assert.equal(env.webhookCalls()[0].event.kind, "drift");
});

test("enforces plan limits, ownership and CSRF rules", async t => {
  const env = await start(t);
  const owner = await env.signIn("owner@example.com");
  const other = await env.signIn("other@example.com");
  const body = { name: "API", url: env.targetUrl, intervalMinutes: 60 };

  assert.equal((await env.call("/api/monitors", { method: "POST", cookie: owner, body })).status, 200);
  const second = await env.call("/api/monitors", { method: "POST", cookie: owner, body });
  assert.equal(second.status, 200);
  const third = await env.call("/api/monitors", { method: "POST", cookie: owner, body });
  assert.equal(third.status, 402, "free plan allows two active monitors");

  const fast = await env.call("/api/monitors", { method: "POST", cookie: other, body: { ...body, intervalMinutes: 5 } });
  assert.equal(fast.status, 402, "free plan cannot check every 5 minutes");

  const id = second.data.monitor.id;
  assert.equal((await env.call(`/api/monitors/${id}`, { cookie: other })).status, 404);
  assert.equal((await env.call(`/api/monitors/${id}`, { method: "DELETE", cookie: other })).status, 404);
  assert.equal((await env.call("/api/monitors")).status, 401);

  const crossSite = await env.call(`/api/monitors/${id}`, { method: "DELETE", cookie: owner, headers: { Origin: "https://evil.example" } });
  assert.equal(crossSite.status, 403);
  const form = await fetch(`http://127.0.0.1:${env.app.server.address().port}/api/monitors/${id}`, {
    method: "DELETE", headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded" }
  });
  assert.equal(form.status, 415);

  const paused = await env.call(`/api/monitors/${id}`, { method: "PATCH", cookie: owner, body: { paused: true } });
  assert.equal(paused.data.monitor.paused, true);
  assert.equal((await env.call("/api/monitors", { method: "POST", cookie: owner, body })).status, 200, "pausing frees a slot");
  const resumed = await env.call(`/api/monitors/${id}`, { method: "PATCH", cookie: owner, body: { paused: false } });
  assert.equal(resumed.status, 402, "cannot resume past the limit");
});

test("rejects monitors pointed at private networks when not allowed", async t => {
  const config = loadConfig({ DATABASE_PATH: ":memory:" });
  const app = createApp({ config, mailer: { send: async () => {} } });
  t.after(() => app.close());
  app.db.prepare("INSERT INTO users (id, email, created_at) VALUES (1, 'a@example.com', 0)").run();
  app.db.prepare("INSERT INTO monitors (id, user_id, name, url, interval_minutes, next_check_at, created_at) VALUES (1, 1, 'meta', 'http://169.254.169.254/latest/meta-data', 60, 0, 0)").run();
  const monitor = app.db.prepare("SELECT monitors.*, 'a@example.com' AS user_email, 'free' AS user_plan FROM monitors").get();
  const result = await app.scheduler.run(monitor);
  assert.equal(result.ok, false);
  assert.match(result.error, /private or reserved/);
});

test("a signed Stripe webhook upgrades the plan; an unsigned one is rejected", async t => {
  const { createHmac } = await import("node:crypto");
  const config = loadConfig({
    DATABASE_PATH: ":memory:",
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    STRIPE_PRICE_STARTER: "price_starter",
    STRIPE_PRICE_TEAM: "price_team"
  });
  const app = createApp({ config, mailer: { send: async () => {} } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  app.db.prepare("INSERT INTO users (id, email, created_at) VALUES (7, 'buyer@example.com', 0)").run();

  const payload = JSON.stringify({
    type: "customer.subscription.created",
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "sub_9", customer: "cus_9", status: "active", metadata: { user_id: "7" }, items: { data: [{ price: { id: "price_team" } }] } } }
  });
  const url = `http://127.0.0.1:${app.server.address().port}/api/stripe/webhook`;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", "whsec_test").update(`${timestamp}.${payload}`).digest("hex");

  const forged = await fetch(url, { method: "POST", body: payload, headers: { "Stripe-Signature": `t=${timestamp},v1=${"0".repeat(64)}` } });
  assert.equal(forged.status, 400);
  assert.equal(app.db.prepare("SELECT plan FROM users WHERE id = 7").get().plan, "free");

  const signed = await fetch(url, { method: "POST", body: payload, headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}` } });
  assert.equal(signed.status, 200);
  assert.equal(app.db.prepare("SELECT plan FROM users WHERE id = 7").get().plan, "team");
});
