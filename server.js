import { createApp } from "./lib/app.js";
import { loadConfig } from "./lib/config.js";

const config = loadConfig();
const app = createApp({ config });

if (!config.email.resendApiKey) console.warn("RESEND_API_KEY is not set: sign-in links and alerts are printed to this log (development only).");
if (config.allowPrivateTargets) console.warn("ALLOW_PRIVATE_TARGETS is on: monitors can reach this machine's network. Never enable it in production.");

app.server.listen(config.port, () => {
  console.log(`JSON Diff Studio: ${config.baseUrl} (listening on port ${config.port})`);
  app.scheduler.start();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    console.log(`${signal} received, finishing running checks…`);
    await app.close();
    process.exit(0);
  });
}
