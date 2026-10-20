# Strategy: which product to build, and how to get the first paying customers

Written October 2026. The competitor notes come from a quick search, not a full market study. Check them before you spend money on marketing.

## Assumptions (correct these if they are wrong)

| Assumption | Why it matters |
|---|---|
| One developer, 10–15 hours a week, comfortable with JavaScript/Node | Rules out anything that needs a team or a long enterprise sales cycle |
| Under $50/month to run, no outside funding | Rules out anything that rents GPUs before it has revenue |
| Self-serve B2B sales to English-speaking developers, no existing audience | Distribution has to come from a free tool, content and direct outreach |
| You want revenue in weeks, not a venture-scale company | Favours narrow tools with a credit-card price over platforms |
| You keep this repo (a free browser JSON diff tool) as a starting point | It is a ready-made source of traffic and a working diff engine |

If you have an enterprise network (for example former colleagues running ML platforms), idea 3 below becomes much more attractive. Tell me and I will re-rank.

## Candidates

### 1. API schema-drift monitor (recommended, and now built)
- **Who pays:** small teams whose product depends on other companies' APIs: SaaS integrations, agencies that build Shopify or Stripe apps, fintechs on banking aggregators, and AI apps calling tool or model APIs.
- **Why they pay:** a vendor quietly drops a field or turns an ID into a string, and their integration breaks in production. They usually find out from a customer. One avoided incident pays for years of a $19 plan.
- **Model:** subscription. Free (2 monitors, hourly), $19 Starter, $49 Team. Limits are on monitors, check frequency and alert channels.
- **Competitors:** generic uptime and API monitors (Checkly, Postman monitors, UptimeRobot) check status codes and hand-written assertions, not schema drift. Page-change tools (PageCrawl) can watch JSON but are noisy. Several small dedicated tools now exist: DriftGuard, DriftSignal, FlareCanary, Versionly and Oxpecker. None of them dominates yet.
- **Biggest risk:** a crowded micro-niche with moderate willingness to pay. Teams may treat it as a nice-to-have and stay on the free plan. Mitigations are below.

### 2. LLM structured-output regression testing
- **Who pays:** teams shipping LLM features who must migrate whenever a model is deprecated.
- **Model:** usage-based or per seat.
- **Competitors:** promptfoo (open source, popular), Braintrust, LangSmith, Humanloop and others, all well funded.
- **Biggest risk:** a solo builder cannot out-ship funded, open-source-led competitors. **Verdict: skip.**

### 3. GPU inference cost optimizer (right-sizing and benchmarking for self-hosted LLMs)
- **Who pays:** ML platform teams spending $20k+ a month on GPUs.
- **Why:** real money is wasted on over-provisioned GPUs, unbatched serving and the wrong serving configurations. This is where deep GPU and inference knowledge creates a genuine edge.
- **Model:** consulting-style audits ($5–15k) that turn into a monitoring subscription.
- **Competitors:** CAST AI, Kubecost, the cloud providers' own tools, and NVIDIA's free tooling (NIM, Dynamo, benchmarking tools).
- **Biggest risk:** it needs access to customer infrastructure, trust and a long sales cycle, and benchmarks need rented GPUs up front. **Verdict: the best fit for deep expertise, the worst fit for "solo, cheap, fast". Revisit if you have an enterprise network.**

### 4. LLM API gateway (cost tracking, caching, fallbacks)
- **Competitors:** Helicone, Portkey, LiteLLM, OpenRouter and the providers themselves. **Verdict: commoditised. Skip.**

### 5. Cloud cost anomaly alerts for small Azure/AWS accounts
- **Competitors:** the free native tools (Azure Cost Management, AWS Cost Anomaly Detection), plus Vantage and CloudZero.
- **Biggest risk:** the free native tools are good enough for small accounts, which are exactly the customers a solo builder can reach. **Verdict: hard to monetise. Skip.**

### 6. Sell the JSON diff tool itself (Pro features, ads)
- **Competitors:** dozens of free online diff tools with years of search ranking.
- **Verdict:** you cannot charge for this. Keep it free as the acquisition channel for idea 1.

## Why idea 1 wins

1. **Shortest path to a credit card.** Self-serve checkout, one clear job, no integration work for the customer: paste a URL and an API key.
2. **Cheap to run.** One small VM with SQLite handles thousands of monitors, at about $5–10 a month. No GPUs.
3. **The engineering is the differentiator.** The naive approach (diff each response against the last one) alerts on every timestamp and every optional field, and users mute it within a week. This build learns a schema as the union of every response it has seen, ignores empty arrays and missing parents, needs three consecutive misses before calling a field removed, and supports ignore patterns. Low noise is what people keep paying for.
4. **Built-in distribution.** The free diff tool brings in developers who are, at that moment, comparing two API responses by hand: exactly the moment this pain shows up.
5. **Honest weakness:** competitors exist, and switching costs are low. You win on alert quality, an easy free tier, and focus on a few verticals, not on the idea itself. If the kill criteria below trigger, stop and move to idea 3.

## What was built (the smallest version that can charge money)

- Free browser diff tool, plus a "Compare structure only" mode that showcases the monitor engine
- Magic-link sign-in (no passwords to store or reset)
- Monitors: URL, encrypted auth headers, interval, ignore paths, alert on all changes or breaking changes only
- Learned-schema drift detection, down and recovered alerts, change history, recent checks
- Alerts by email (Resend), plus Slack, Discord or any webhook on paid plans
- Stripe Checkout, the Stripe customer portal, and webhook-driven plan changes that pause or resume monitors to fit the plan
- SSRF-hardened fetching, so customer URLs cannot reach your server's network or cloud metadata

Deliberately left out until customers ask: teams and multiple users per account, POST and GraphQL monitors, OpenAPI import, status pages, multi-region checks, and an "accept change" workflow.

## Plan for the first 10 paying customers

**Week 0–1: launch**
1. Deploy (see README), set up Stripe products and Resend, and buy a domain.
2. Create 5 public demo monitors on popular APIs you are allowed to poll (for example GitHub's public API or a public status API) and write about any real drift you catch. Real incidents are your best marketing.

**Week 1–4: hand-picked outreach (aim for 30 conversations)**
- **Where the pain is visible:** GitHub issues on API client libraries (search for "response changed", "field missing", "breaking change without notice"), r/webdev, r/SaaS, Shopify partner and Stripe developer communities, and indie-hacker forums. Reply with help first; mention the tool only when it fits.
- **Agencies:** Shopify, HubSpot and Salesforce integration agencies maintain dozens of client integrations. Offer to set up their monitors yourself, free for 30 days.
- **Offer:** founding-customer pricing: the Starter plan at $19 locked for life for the first 20 customers. Use Stripe promotion codes; checkout already accepts them.

**Content that compounds (1 post a week):** "How to detect breaking changes in [Stripe/Shopify/OpenAI] API responses", plus write-ups of drift you actually caught. Each post links to the free diff tool and the monitor sign-up.

**Metrics to watch weekly:** sign-ups → created a monitor (target 60%) → still active after 7 days → paid. Also track alerts per monitor per week. If it is above about 2, noise will drive churn; tune the defaults.

**Kill or pivot criteria:** after 8 weeks and 30+ real conversations, if you have fewer than 3 paying customers, or free users are not keeping monitors active, the pain is not strong enough at this price. Re-read the conversation notes for a stronger adjacent problem (for example monitoring vendor changelogs, or LLM output drift), or move to idea 3.

**Pricing notes:** $19 and $49 are entry points, not the ceiling. The first expansion is an Agency plan at about $149 (300 monitors, client-labelled alerts) once agencies show up. Never discount the free tier; it is your funnel.
