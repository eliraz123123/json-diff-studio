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

const event = (type, overrides = {}) => ({
  type,
  data: { object: { id: "sub_1", customer: "cus_1", status: "active", metadata: { user_id: "1" }, ...overrides } }
});
const subscription = (id, status, price) => ({ id, status, items: { data: [{ price: { id: price } }] } });
const stripeSays = (...subscriptions) => async customer => {
  assert.equal(customer, "cus_1");
  return subscriptions;
};
const plan = db => db.prepare("SELECT plan, stripe_subscription_id FROM users WHERE id = 1").get();
const pausedStates = db => db.prepare("SELECT paused FROM monitors ORDER BY created_at").all().map(row => row.paused);

test("the plan follows Stripe's current subscriptions and resizes active monitors", async () => {
  const db = setup();
  await handleStripeEvent(db, config, event("customer.subscription.deleted"), 0, stripeSays());
  assert.deepEqual({ ...plan(db) }, { plan: "free", stripe_subscription_id: null });
  assert.deepEqual(pausedStates(db), [0, 0, 2, 2, 2], "free plan keeps the two oldest monitors");

  await handleStripeEvent(db, config, event("customer.subscription.created"), 0, stripeSays(subscription("sub_1", "active", "price_starter")));
  assert.deepEqual({ ...plan(db) }, { plan: "starter", stripe_subscription_id: "sub_1" });
  assert.equal(db.prepare("SELECT stripe_customer_id FROM users WHERE id = 1").get().stripe_customer_id, "cus_1");
  assert.deepEqual(pausedStates(db), [0, 0, 0, 0, 0]);
});

test("a stale or out-of-order event cannot downgrade a paying customer", async () => {
  const db = setup();
  // The "incomplete" created event lands after the "active" update, in the same second.
  await handleStripeEvent(db, config, event("customer.subscription.created", { status: "incomplete" }), 0, stripeSays(subscription("sub_1", "active", "price_team")));
  assert.equal(plan(db).plan, "team");
});

test("with two subscriptions, cancelling one keeps the plan the other pays for", async () => {
  const db = setup();
  await handleStripeEvent(db, config, event("customer.subscription.deleted", { id: "sub_2" }), 0,
    stripeSays(subscription("sub_1", "active", "price_starter"), subscription("sub_2", "canceled", "price_team")));
  assert.deepEqual({ ...plan(db) }, { plan: "starter", stripe_subscription_id: "sub_1" });
});

test("unpaid, incomplete and unknown-price subscriptions count as free", async () => {
  const db = setup();
  await handleStripeEvent(db, config, event("customer.subscription.updated"), 0, stripeSays(
    subscription("a", "incomplete", "price_team"), subscription("b", "unpaid", "price_team"), subscription("c", "active", "price_other")
  ));
  assert.equal(plan(db).plan, "free");
});

test("checkout completion links the customer and syncs the plan", async () => {
  const db = setup();
  await handleStripeEvent(db, config, { type: "checkout.session.completed", data: { object: { client_reference_id: "1", customer: "cus_1" } } }, 0,
    stripeSays(subscription("sub_1", "trialing", "price_team")));
  assert.equal(plan(db).plan, "team");
});
