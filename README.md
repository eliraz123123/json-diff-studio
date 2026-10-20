# JSON Diff Studio

Two products in one small codebase:

- **Diff tool (free).** Paste two JSON values and see every added, removed and changed field by path, or compare structure only. It runs entirely in the browser.
- **Drift Monitors (paid).** Point a monitor at a JSON API you depend on. It calls the API on a schedule, learns the response schema, and alerts you by email, Slack, Discord or webhook when fields disappear, change type (a `null` where there never was one) or appear.

Why this product, the alternatives considered, and the go-to-market plan: [docs/STRATEGY.md](docs/STRATEGY.md).

## Run locally

Requires Node.js 22.13 or newer. There are no npm dependencies and no build step.

```bash
npm run dev      # http://localhost:4173, monitors may reach localhost, checks every 5 s
npm test
```

Open <http://localhost:4173/app> and sign in with any email. Without an email provider, the sign-in link is printed in the terminal; open it in the browser. To try drift detection locally, point a monitor at any local JSON endpoint, then change what it returns and select **Run check now**.

`npm start` runs in normal mode, where monitors cannot reach private networks.

## Architecture

```
Browser ── index.html + app.js (free diff tool, runs locally)
       └── dashboard.html + dashboard.js ──► JSON API (lib/app.js)
                                              │
     scheduler (lib/scheduler.js) ──► runCheck (lib/monitor.js)
       polls SQLite for due monitors       │ safeRequest (lib/safe-fetch.js): SSRF-safe HTTP
                                           │ observe (lib/drift.js): learned-schema diff
                                           │ notify (lib/alerts.js): email / Slack / webhook
                                           ▼
                                      SQLite (lib/db.js, node:sqlite)
Stripe ── webhook ──► lib/billing.js (plan changes, monitor limits)
```

| Choice | Reason |
|---|---|
| Plain Node, no framework or npm dependencies | Nothing to patch or audit, starts instantly, and one person can understand all of it. The existing tool already worked this way. |
| SQLite (`node:sqlite`) on one instance | Handles thousands of monitors with no database bill. Move to Postgres only when you need several instances. |
| In-process scheduler | No queue to run. It requires a **single instance** (see Deploy). |
| Magic-link sign-in | No passwords to store, hash or reset. |
| Stripe Checkout and Customer Portal via REST | Stripe hosts payment, card updates, invoices and cancellation. We only handle three API calls and a signed webhook. |
| Resend for email | Free tier of 3,000 emails/month, one HTTP call. |
| Schema learning instead of value diffs | Values change on every call, so value diffs are noise. See "How drift detection works". |

### How drift detection works

1. Each response is reduced to a shape: every path, with array items merged under `[]`, mapped to the set of types seen there (`$.data[].amount → number`).
2. The first response becomes the baseline. Later responses are merged into it, so the baseline is the union of everything seen.
3. A path that was never seen before is **added**. A type a path never had before is a **new type** (`number → null | number`). Both alert immediately.
4. A path counts as **removed** only after it is absent from 3 consecutive responses in which its parent object was present. Empty arrays and missing parents never count, so optional fields and empty lists do not cause false alarms.
5. Ignore patterns (`$.meta`, `$.rates.*`) drop dynamic sections, such as maps keyed by ID.
6. Two consecutive failed checks (non-2xx, invalid JSON, timeout) mark the monitor **down**; the next success sends **recovered**.

### Security

- **SSRF:** monitor and webhook URLs are customer input. `safe-fetch.js` validates the address actually dialled (inside the DNS lookup, which defeats DNS rebinding), blocks loopback, private, link-local and metadata ranges, re-checks every redirect, drops credentials on cross-origin redirects, and caps response size, decompressed size and time.
- **Secrets:** saved request headers and webhook URLs are encrypted with AES-256-GCM using a key derived from `APP_SECRET`. The API returns only header names.
- **Sessions:** HttpOnly, SameSite=Lax cookies (Secure over https). State-changing requests must be JSON and same-origin (CSRF protection). Every monitor query is scoped to its owner.
- **Stripe:** webhooks are HMAC-verified with a 5-minute replay window; older events never overwrite newer ones.
- **Abuse limits:** rate limits on sign-in emails and manual checks; plan limits on monitor count and frequency.

## Deploy (Fly.io, about $5–10/month)

The app must run as **exactly one instance**, because the scheduler and SQLite live in one process.

```bash
fly launch --no-deploy --copy-config        # uses fly.toml; pick a unique app name
fly volumes create jds_data --size 1        # SQLite lives here
fly secrets set \
  APP_SECRET="$(openssl rand -base64 32)" \
  BASE_URL="https://your-app.fly.dev" \
  RESEND_API_KEY="re_..." EMAIL_FROM="JSON Diff Studio <alerts@yourdomain.com>" \
  STRIPE_SECRET_KEY="sk_live_..." STRIPE_WEBHOOK_SECRET="whsec_..." \
  STRIPE_PRICE_STARTER="price_..." STRIPE_PRICE_TEAM="price_..."
fly deploy
fly scale count 1
```

Any host that runs a Docker container with a persistent disk also works (Railway, Render, a VPS). The `Dockerfile` is included, and every variable is documented in `.env.example`. **Back up `/data/app.db`**: [Litestream](https://litestream.io) to S3 or R2 is the low-effort option. **Never change `APP_SECRET` after launch**, or saved headers and webhooks can no longer be decrypted.

### Stripe setup (about 15 minutes)

1. Create two products with monthly prices: Starter $19, Team $49. Copy the `price_...` IDs.
2. Developers → Webhooks → add the endpoint `https://YOUR_DOMAIN/api/stripe/webhook` with the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`. Copy the signing secret.
3. Settings → Billing → Customer portal: turn on cancellation and switching between the two prices.
4. Test locally with `stripe listen --forward-to localhost:4173/api/stripe/webhook` and test-mode keys.

The upgrade buttons stay hidden until all four Stripe variables are set.

### Email setup

Create a [Resend](https://resend.com) account, verify your sending domain (SPF and DKIM records), and set `RESEND_API_KEY` and `EMAIL_FROM`.

## Limitations

- Single instance only (see above). Beyond about 5,000 monitors at 1-minute intervals, move checks to a worker pool and the database to Postgres.
- Monitors send GET requests only.
- Array items are sampled (the first 1,000) when learning a shape.
- In the free diff tool, array items are compared by index.
- Rate-limit counters live in memory and reset on restart.
