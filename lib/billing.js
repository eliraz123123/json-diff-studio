import { createHmac } from "node:crypto";
import { safeEqual } from "./crypto.js";
import { planFor } from "./plans.js";

// Talks to Stripe's REST API directly; the three calls we need do not justify the SDK.
async function stripe(config, path, params) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.stripe.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(params)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Stripe: ${data.error?.message ?? response.status}`);
  return data;
}

export function billingEnabled(config) {
  const { secretKey, webhookSecret, prices } = config.stripe;
  return Boolean(secretKey && webhookSecret && prices.starter && prices.team);
}

export async function createCheckoutSession(config, user, planId) {
  const params = {
    mode: "subscription",
    "line_items[0][price]": config.stripe.prices[planId],
    "line_items[0][quantity]": "1",
    success_url: `${config.baseUrl}/app?billing=success`,
    cancel_url: `${config.baseUrl}/app?billing=cancelled`,
    client_reference_id: String(user.id),
    "subscription_data[metadata][user_id]": String(user.id),
    allow_promotion_codes: "true"
  };
  if (user.stripe_customer_id) params.customer = user.stripe_customer_id;
  else params.customer_email = user.email;
  return (await stripe(config, "checkout/sessions", params)).url;
}

export async function createPortalSession(config, user) {
  const session = await stripe(config, "billing_portal/sessions", {
    customer: user.stripe_customer_id,
    return_url: `${config.baseUrl}/app`
  });
  return session.url;
}

export function verifyStripeSignature(rawBody, header, secret, now = Date.now(), toleranceSeconds = 300) {
  if (!header || !secret) return false;
  const pairs = header.split(",").map(part => part.split("="));
  const timestamp = pairs.find(([key]) => key === "t")?.[1];
  const signatures = pairs.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return signatures.some(signature => safeEqual(signature, expected));
}

const ENDED = new Set(["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]);

export function planForSubscription(config, subscription, deleted) {
  if (deleted || ENDED.has(subscription.status)) return "free";
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const match = Object.entries(config.stripe.prices).find(([, id]) => id && id === priceId);
  return match ? match[0] : "free";
}

export function handleStripeEvent(db, config, event, now) {
  const object = event.data?.object ?? {};
  if (event.type === "checkout.session.completed") {
    const userId = Number(object.client_reference_id);
    if (userId && object.customer) {
      db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(object.customer, userId);
    }
    return;
  }
  if (!event.type?.startsWith("customer.subscription.")) return;

  const userId = Number(object.metadata?.user_id);
  const user = (userId && db.prepare("SELECT * FROM users WHERE id = ?").get(userId))
    || db.prepare("SELECT * FROM users WHERE stripe_customer_id = ?").get(object.customer);
  if (!user) return;
  // Stripe does not guarantee delivery order; never let an older event overwrite a newer one.
  if (event.created < user.billing_updated_at) return;
  // An update for a subscription the user has since replaced must not change their plan.
  if (user.stripe_subscription_id && user.stripe_subscription_id !== object.id && event.type !== "customer.subscription.created") return;

  const plan = planForSubscription(config, object, event.type === "customer.subscription.deleted");
  db.prepare(`
    UPDATE users SET plan = ?, stripe_customer_id = ?, stripe_subscription_id = ?, billing_updated_at = ? WHERE id = ?
  `).run(plan, object.customer, plan === "free" ? null : object.id, event.created, user.id);
  enforcePlanLimits(db, user.id, now);
}

// Keeps the number of active monitors within the plan: pauses the newest ones on a
// downgrade and resumes plan-paused ones (oldest first) on an upgrade.
export function enforcePlanLimits(db, userId, now) {
  const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(userId);
  const limit = planFor(user.plan).monitors;
  const active = db.prepare("SELECT id FROM monitors WHERE user_id = ? AND paused = 0 ORDER BY created_at, id").all(userId);
  if (active.length > limit) {
    const pause = db.prepare("UPDATE monitors SET paused = 2 WHERE id = ?");
    for (const { id } of active.slice(limit)) pause.run(id);
    return;
  }
  const waiting = db.prepare("SELECT id FROM monitors WHERE user_id = ? AND paused = 2 ORDER BY created_at, id LIMIT ?")
    .all(userId, limit - active.length);
  const resume = db.prepare("UPDATE monitors SET paused = 0, next_check_at = ? WHERE id = ?");
  for (const { id } of waiting) resume.run(now, id);
}
