import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleStripeEvent, verifyStripeSignature } from "./billing.js";
import { openDatabase } from "./db.js";

const config = { stripe: { prices: { starter: "price_starter", team: "price_team" } } };

function sign(body, secret, timestamp) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

test("verifies Stripe webhook signatures with a replay window", () => {
  const body = Buffer.from('{"id":"evt_1"}');
  const now = 1_700_000_000_000;
  const header = sign(body, "whsec_test", now / 1000);
  assert.equal(verifyStripeSignature(body, header, "whsec_test", now), true);
  assert.equal(verifyStripeSignature(body, header, "whsec_other", now), false);
  assert.equal(verifyStripeSignature(Buffer.from('{"id":"evt_2"}'), header, "whsec_test", now), false);
  assert.equal(verifyStripeSignature(body, header, "whsec_test", now + 10 * 60_000), false);
  assert.equal(verifyStripeSignature(body, undefined, "whsec_test", now), false);
});

function setup() {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users (id, email, created_at) VALUES (1, 'a@example.com', 0)").run();
  const insert = db.prepare("INSERT INTO monitors (user_id, name, url, interval_minutes, next_check_at, created_at) VALUES (1, ?, 'https://example.com', 60, 0, ?)");
  for (let index = 0; index < 5; index += 1) insert.run(`m${index}`, index);
  return db;
}

const subscriptionEvent = (type, created, overrides = {}) => ({
  type,
  created,
  data: { object: { id: "sub_1", customer: "cus_1", status: "active", metadata: { user_id: "1" }, items: { data: [{ price: { id: "price_starter" } }] }, ...overrides } }
});

const pausedStates = db => db.prepare("SELECT paused FROM monitors ORDER BY created_at").all().map(row => row.paused);

test("subscription events set the plan and resume plan-paused monitors", () => {
  const db = setup();
  // Free plan allows 2 active monitors.
  handleStripeEvent(db, config, subscriptionEvent("customer.subscription.deleted", 1), 0);
  assert.deepEqual(pausedStates(db), [0, 0, 2, 2, 2]);

  handleStripeEvent(db, config, subscriptionEvent("customer.subscription.created", 2), 0);
  const user = db.prepare("SELECT * FROM users WHERE id = 1").get();
  assert.equal(user.plan, "starter");
  assert.equal(user.stripe_customer_id, "cus_1");
  assert.equal(user.stripe_subscription_id, "sub_1");
  assert.deepEqual(pausedStates(db), [0, 0, 0, 0, 0]);
});

test("ignores events older than the last one applied", () => {
  const db = setup();
  handleStripeEvent(db, config, subscriptionEvent("customer.subscription.deleted", 10), 0);
  handleStripeEvent(db, config, subscriptionEvent("customer.subscription.updated", 5), 0);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = 1").get().plan, "free");
});

test("an unpaid or unknown-price subscription falls back to free", () => {
  const db = setup();
  handleStripeEvent(db, config, subscriptionEvent("customer.subscription.created", 1, { status: "incomplete" }), 0);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = 1").get().plan, "free");
  handleStripeEvent(db, config, subscriptionEvent("customer.subscription.updated", 2, { items: { data: [{ price: { id: "price_unknown" } }] } }), 0);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = 1").get().plan, "free");
});
