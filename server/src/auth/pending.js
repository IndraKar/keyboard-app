/**
 * In-flight sign-ins.
 *
 * Two short-lived records, deliberately kept apart:
 *
 *  - PENDING, keyed by `state`. Created when the browser is sent to the
 *    provider; read when the provider sends it back. Holds the PKCE verifier
 *    and the nonce.
 *  - READY, keyed by `ticket`. Created when the callback succeeds; read once by
 *    the app, which has been polling for it.
 *
 * They are separate because `state` makes a round trip through the provider and
 * lands in redirect URLs, browser history and access logs, while `ticket` is a
 * bearer credential for a session token and must never appear in any of those.
 * Collapsing them into one value would mean anyone who could read a URL could
 * claim the login.
 *
 * In memory, because these live for seconds. The cost of a restart mid-login is
 * that the user presses the button again; the cost of persisting them is a
 * table of credentials with a sixty-second useful life.
 */

import { randomUUID } from "node:crypto";
import { randomUrlSafe } from "./oidc.js";

export const PENDING_TTL_MS = 10 * 60_000;  // the user may dawdle on a consent screen
export const READY_TTL_MS = 5 * 60_000;     // the app is polling; it should be seconds
export const MAX_PENDING = 10_000;          // a ceiling, so a flood cannot exhaust memory

export function createAuthFlow({ now = () => Date.now() } = {}) {
  const pending = new Map(); // state -> {provider, verifier, nonce, ticket, expiresAt, returnTo}
  const ready = new Map();   // ticket -> {token, user, expiresAt}

  function sweep() {
    const t = now();
    for (const [k, v] of pending) if (t >= v.expiresAt) pending.delete(k);
    for (const [k, v] of ready) if (t >= v.expiresAt) ready.delete(k);
  }

  return {
    /** Start a login. Returns the values that go into the authorize URL. */
    begin({ provider, verifier, returnTo }) {
      sweep();
      if (pending.size >= MAX_PENDING) throw new Error("too many sign-ins in flight");
      const state = randomUrlSafe(32);
      const nonce = randomUUID();
      const ticket = randomUrlSafe(32);
      pending.set(state, {
        provider, verifier, nonce, ticket, returnTo,
        expiresAt: now() + PENDING_TTL_MS,
      });
      return { state, nonce, ticket };
    },

    /** Consume the pending record. Single use: a replayed callback finds nothing. */
    claim(state) {
      sweep();
      const rec = pending.get(String(state || ""));
      if (!rec) return null;
      pending.delete(state);
      return now() < rec.expiresAt ? rec : null;
    },

    /** The callback succeeded; park the result for the poller. */
    fulfil(ticket, { token, user }) {
      sweep();
      ready.set(ticket, { token, user, expiresAt: now() + READY_TTL_MS });
    },

    /** The callback failed; tell the poller so it can stop and say why. */
    reject(ticket, message) {
      sweep();
      ready.set(ticket, { error: message || "sign_in_failed", expiresAt: now() + READY_TTL_MS });
    },

    /**
     * Collect the result. Single use — the token is handed over exactly once,
     * so a ticket leaking afterwards is worth nothing.
     */
    collect(ticket) {
      sweep();
      const rec = ready.get(String(ticket || ""));
      if (!rec) return { status: "pending" };
      ready.delete(ticket);
      if (rec.error) return { status: "error", error: rec.error };
      return { status: "ready", token: rec.token, user: rec.user };
    },

    _sizes: () => ({ pending: pending.size, ready: ready.size }),
  };
}
