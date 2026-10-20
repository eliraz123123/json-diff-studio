export const PLANS = {
  free: { id: "free", name: "Free", priceMonthly: 0, monitors: 2, minIntervalMinutes: 60, webhooks: false },
  starter: { id: "starter", name: "Starter", priceMonthly: 19, monitors: 20, minIntervalMinutes: 5, webhooks: true },
  team: { id: "team", name: "Team", priceMonthly: 49, monitors: 100, minIntervalMinutes: 1, webhooks: true }
};

export const INTERVALS = [1, 5, 15, 30, 60, 360, 1440];

export function planFor(id) {
  return PLANS[id] ?? PLANS.free;
}

// A downgrade keeps each monitor's chosen interval but never checks faster than the plan allows.
export function effectiveIntervalMinutes(intervalMinutes, planId) {
  return Math.max(intervalMinutes, planFor(planId).minIntervalMinutes);
}
