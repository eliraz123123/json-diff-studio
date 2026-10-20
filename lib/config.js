export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const port = Number(env.PORT || 4173);
  const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, "");

  let appSecret = env.APP_SECRET;
  if (!appSecret) {
    if (production) throw new Error("APP_SECRET is required in production. Generate one with: openssl rand -base64 32");
    appSecret = "development-only-secret-do-not-use-in-production";
  } else if (appSecret.length < 32) {
    throw new Error("APP_SECRET must be at least 32 characters");
  }

  return {
    production,
    port,
    baseUrl,
    appSecret,
    databasePath: env.DATABASE_PATH || "data/app.db",
    trustProxy: env.TRUST_PROXY === "true",
    // Lets monitors reach localhost and private networks. Only for local development and tests.
    allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === "true",
    schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS || 15_000),
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || "",
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
      prices: { starter: env.STRIPE_PRICE_STARTER || "", team: env.STRIPE_PRICE_TEAM || "" }
    },
    email: {
      resendApiKey: env.RESEND_API_KEY || "",
      from: env.EMAIL_FROM || "JSON Diff Studio <alerts@example.com>"
    }
  };
}
