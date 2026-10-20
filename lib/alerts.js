import { decrypt } from "./crypto.js";
import { planFor } from "./plans.js";

export function createMailer(config) {
  const { resendApiKey, from } = config.email;
  if (!resendApiKey) {
    return {
      async send({ to, subject, text }) {
        console.log(`\n[email not configured — printing instead]\nTo: ${to}\nSubject: ${subject}\n\n${text}\n`);
      }
    };
  }
  return {
    async send({ to, subject, text }) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text })
      });
      if (!response.ok) throw new Error(`Email failed with ${response.status}: ${await response.text()}`);
    }
  };
}

function describe(change) {
  if (change.type === "added") return `+ added    ${change.path} (${change.after})`;
  if (change.type === "removed") return `- removed  ${change.path} (was ${change.before})`;
  return `~ new type ${change.path}: ${change.before} → ${change.after}`;
}

export function formatAlert({ monitor, event, baseUrl }) {
  const titles = {
    drift: `Response shape changed: ${event.summary}`,
    down: `Endpoint is failing: ${event.summary}`,
    recovered: "Endpoint recovered"
  };
  const lines = event.changes.slice(0, 25).map(describe);
  if (event.changes.length > 25) lines.push(`…and ${event.changes.length - 25} more`);
  const text = [
    `${monitor.name}: ${titles[event.kind]}`,
    monitor.url,
    "",
    ...lines,
    lines.length ? "" : null,
    `Open the monitor: ${baseUrl}/app#monitor-${monitor.id}`
  ].filter(line => line !== null).join("\n");
  return { subject: `[${monitor.name}] ${titles[event.kind]}`, text };
}

function webhookBody(url, alert, monitor, event) {
  const { hostname } = new URL(url);
  if (hostname === "hooks.slack.com") return { text: alert.text };
  if (hostname === "discord.com" || hostname === "discordapp.com") return { content: alert.text.slice(0, 1900) };
  return {
    text: alert.text,
    monitor: { id: monitor.id, name: monitor.name, url: monitor.url },
    event: { kind: event.kind, summary: event.summary, changes: event.changes }
  };
}

export function createNotifier({ config, mailer, request }) {
  return {
    async notify({ monitor, event }) {
      const alert = formatAlert({ monitor, event, baseUrl: config.baseUrl });
      const jobs = [];
      if (monitor.email_alerts) jobs.push(mailer.send({ to: monitor.user_email, ...alert }));
      // A webhook saved on a paid plan stays stored after a downgrade but stops firing.
      if (monitor.alert_webhook_enc && planFor(monitor.user_plan).webhooks) {
        const url = decrypt(monitor.alert_webhook_enc, config.appSecret);
        jobs.push(request(url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "JSONDiffStudio-Alerts/1.0" },
          body: JSON.stringify(webhookBody(url, alert, monitor, event)),
          allowPrivate: config.allowPrivateTargets,
          maxRedirects: 0,
          timeoutMs: 10_000
        }).then(response => {
          if (response.status >= 300) throw new Error(`Webhook answered ${response.status}`);
        }));
      }
      for (const result of await Promise.allSettled(jobs)) {
        if (result.status === "rejected") console.error(`Alert for monitor ${monitor.id} failed:`, result.reason.message);
      }
    }
  };
}
