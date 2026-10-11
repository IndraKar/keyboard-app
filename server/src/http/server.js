/**
 * Boot the Keyvoria server.
 *
 * Configuration is environment-only. Two decisions are made here and announced
 * loudly, because getting either wrong is silent and expensive:
 *
 *  - WHICH STORE. With DATABASE_URL set it is Postgres; without, it is the
 *    in-memory store, which forgets every subscription on restart. That is
 *    correct for local development and catastrophic in production, so a
 *    production boot without a database warns on every start.
 *  - WHETHER BILLING IS LIVE. Without STRIPE_SECRET_KEY the checkout endpoint
 *    returns 503 rather than pretending to sell anything.
 */

import http from "node:http";
import { createApp, sweep } from "./app.js";
import { createMemoryStore } from "../store/memory.js";
import { createPostgresStore } from "../store/postgres.js";
import { createMatchmaker } from "../competition/matchmaking.js";
import { createStripe } from "../billing/stripe.js";

const PORT = Number(process.env.PORT || 8787);
const DEV_AUTH = process.env.KEYVORIA_DEV_AUTH === "1";
const ALLOW_UNSIGNED = process.env.KEYVORIA_ALLOW_UNSIGNED_WEBHOOKS === "1";
const SWEEP_INTERVAL_MS = 15 * 60_000;
const IS_PROD = process.env.NODE_ENV === "production";

const banner = [];

// ---------------------------------------------------------------------- store
let store;
if (process.env.DATABASE_URL) {
  store = await createPostgresStore({ connectionString: process.env.DATABASE_URL });
  banner.push("store: postgres");
} else {
  store = createMemoryStore();
  banner.push("store: IN-MEMORY (nothing survives a restart)");
}

// --------------------------------------------------------------------- stripe
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = createStripe({
    secretKey: process.env.STRIPE_SECRET_KEY,
    priceId: process.env.STRIPE_PRICE_ID,
  });
  const live = process.env.STRIPE_SECRET_KEY.startsWith("sk_live");
  banner.push(`stripe: ${live ? "LIVE KEYS — real charges" : "test mode"}`);
} else {
  banner.push("stripe: not configured (checkout returns 503)");
}

const app = createApp({
  store,
  stripe,
  matchmaker: createMatchmaker(),
  config: {
    devAuth: DEV_AUTH,
    sessionSecret: process.env.KEYVORIA_SESSION_SECRET || null,
    allowUnsignedWebhooks: ALLOW_UNSIGNED,
    allowedOrigin: process.env.KEYVORIA_ALLOWED_ORIGIN || "*",
    successUrl: process.env.KEYVORIA_SUCCESS_URL || null,
    cancelUrl: process.env.KEYVORIA_CANCEL_URL || null,
    webhookSecrets: {
      stripe: process.env.STRIPE_WEBHOOK_SECRET || null,
      paypal: process.env.PAYPAL_WEBHOOK_SECRET || null,
      apple_app_store: process.env.APPLE_WEBHOOK_SECRET || null,
      google_play: process.env.GOOGLE_WEBHOOK_SECRET || null,
    },
  },
});

const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`[keyvoria] listening on :${PORT}`);
  banner.forEach((line) => console.log("[keyvoria] " + line));

  if (DEV_AUTH) console.warn("[keyvoria] DEV AUTH IS ON — 'Bearer dev:<userId>' is accepted as any user. Never in production.");
  if (ALLOW_UNSIGNED) console.warn("[keyvoria] UNSIGNED WEBHOOKS ARE ACCEPTED — anyone who finds the URL can grant a subscription. Never in production.");
  if (!process.env.KEYVORIA_SESSION_SECRET && !DEV_AUTH) {
    console.warn("[keyvoria] no KEYVORIA_SESSION_SECRET set: every authenticated request will 401.");
  }
  if (IS_PROD) {
    if (!process.env.DATABASE_URL) console.error("[keyvoria] PRODUCTION WITHOUT A DATABASE: paid subscriptions will be lost on the next restart.");
    if (stripe && !process.env.STRIPE_WEBHOOK_SECRET) console.error("[keyvoria] STRIPE CONFIGURED BUT NO WEBHOOK SECRET: payments will never be recorded.");
    if (DEV_AUTH || ALLOW_UNSIGNED) console.error("[keyvoria] DEV SWITCHES ARE ON IN PRODUCTION. Turn them off.");
  }
});

// Webhooks get dropped. The sweep is what stops a missed period-end from
// handing someone Premium indefinitely.
const timer = setInterval(() => {
  sweep(store, Date.now())
    .then((changed) => { if (changed.length) console.log(`[keyvoria] sweep updated ${changed.length} subscription(s)`); })
    .catch((err) => console.error("[keyvoria] sweep failed", err));
}, SWEEP_INTERVAL_MS);
timer.unref();

/* Hosts send SIGTERM and then kill. Finish in-flight requests first: one of
   them could be a webhook that has charged a card but not yet recorded it. */
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[keyvoria] ${sig} — draining`);
    server.close(async () => {
      try { if (store.close) await store.close(); } catch {}
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
