#!/usr/bin/env node
/**
 * Mint a session token.
 *
 * A stopgap until accounts (roadmap M1) exist. The API authenticates with a
 * signed token, and right now nothing issues one in production — there is no
 * sign-in yet. This prints one so the app can be pointed at a real server
 * today.
 *
 *   KEYVORIA_SESSION_SECRET=... node bin/token.js <userId> [days]
 *
 * The token IS the credential: anyone holding it is that user. Treat it like a
 * password, and when M1 lands, delete this file.
 */
import { issueToken } from "../src/http/tokens.js";

const [, , userId, days] = process.argv;
const secret = process.env.KEYVORIA_SESSION_SECRET;

if (!userId) {
  console.error("usage: KEYVORIA_SESSION_SECRET=... node bin/token.js <userId> [days]");
  process.exit(1);
}
if (!secret) {
  console.error("KEYVORIA_SESSION_SECRET is not set — it must match the running server's.");
  process.exit(1);
}

const ttlMs = (Number(days) || 30) * 864e5;
console.log(issueToken(userId, secret, { ttlMs }));
