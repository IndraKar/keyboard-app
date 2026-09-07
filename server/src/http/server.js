/**
 * Boot the Keyvoria server.
 *
 * Configuration is environment-only, and the two dangerous switches
 * (KEYVORIA_DEV_AUTH, KEYVORIA_ALLOW_UNSIGNED_WEBHOOKS) are announced loudly at
 * startup. A server that quietly accepts unsigned billing webhooks is a server
 * that gives away subscriptions, so it should be impossible to run one by
 * accident and not notice.
 */

import http from "node:http";
import { createApp, sweep } from "./app.js";
import { createMemoryStore } from "../store/memory.js";
import { createMatchmaker } from "../competition/matchmaking.js";

const PORT = Number(process.env.PORT || 8787);
const DEV_AUTH = process.env.KEYVORIA_DEV_AUTH === "1";
const ALLOW_UNSIGNED = process.env.KEYVORIA_ALLOW_UNSIGNED_WEBHOOKS === "1";
const SWEEP_INTERVAL_MS = 15 * 60_000;

const store = createMemoryStore();
const matchmaker = createMatchmaker();

const app = createApp({
  store,
  matchmaker,
  config: {
    devAuth: DEV_AUTH,
    sessionSecret: process.env.KEYVORIA_SESSION_SECRET || null,
    allowUnsignedWebhooks: ALLOW_UNSIGNED,
    allowedOrigin: process.env.KEYVORIA_ALLOWED_ORIGIN || "*",
    webhookSecrets: {
      stripe: process.env.STRIPE_WEBHOOK_SECRET || null,
      apple_app_store: process.env.APPLE_WEBHOOK_SECRET || null,
      google_play: process.env.GOOGLE_WEBHOOK_SECRET || null,
    },
  },
});

const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`[keyvoria] listening on :${PORT}`);
  console.log(`[keyvoria] store: in-memory (see src/store/schema.sql for the Postgres shape)`);
  if (DEV_AUTH) console.warn("[keyvoria] DEV AUTH IS ON — 'Bearer dev:<userId>' is accepted as any user. Never in production.");
  if (ALLOW_UNSIGNED) console.warn("[keyvoria] UNSIGNED WEBHOOKS ARE ACCEPTED — anyone who finds the URL can grant a subscription. Never in production.");
  if (!process.env.KEYVORIA_SESSION_SECRET && !DEV_AUTH) {
    console.warn("[keyvoria] no KEYVORIA_SESSION_SECRET set: every authenticated request will 401.");
  }
});

// Webhooks get dropped. The sweep is what stops a missed period-end from
// handing someone Plus indefinitely.
const timer = setInterval(() => {
  sweep(store, Date.now())
    .then((changed) => { if (changed.length) console.log(`[keyvoria] sweep updated ${changed.length} subscription(s)`); })
    .catch((err) => console.error("[keyvoria] sweep failed", err));
}, SWEEP_INTERVAL_MS);
timer.unref();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
