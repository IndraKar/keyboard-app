/**
 * Webhook signature verification.
 *
 * A subscription webhook endpoint grants paid access. If it accepts unsigned
 * requests, anyone who finds the URL can give themselves Keyvoria Plus forever
 * by POSTing a renewal. So the default here is to REFUSE when no secret is
 * configured, rather than to fall open — a 503 is a bug report; a fall-open is
 * a silent giveaway.
 *
 * The scheme is Stripe's (`t=<unix>,v1=<hex hmac of "t.body">`), reused for all
 * three providers so there is one code path to get right. Apple sends signed
 * JWS and Google sends Pub/Sub messages; adapting those means replacing this
 * function's body per provider, not the call sites.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const TOLERANCE_MS = 5 * 60_000; // replay window, matching Stripe's default

export function buildSignature(rawBody, secret, timestampMs = Date.now()) {
  const t = Math.floor(timestampMs / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${mac}`;
}

/** @returns {{ok:true}|{ok:false, reason:string, status:number}} */
export function verifySignature(rawBody, header, secret, { now = Date.now(), allowUnsigned = false } = {}) {
  if (!secret) {
    if (allowUnsigned) return { ok: true, unsigned: true };
    return { ok: false, reason: "webhook_secret_not_configured", status: 503 };
  }
  const parts = Object.fromEntries(
    String(header || "").split(",").map((kv) => kv.split("=").map((s) => s.trim()))
  );
  if (!parts.t || !parts.v1) return { ok: false, reason: "malformed_signature", status: 400 };

  const ts = Number(parts.t) * 1000;
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed_signature", status: 400 };
  if (Math.abs(now - ts) > TOLERANCE_MS) return { ok: false, reason: "signature_too_old", status: 400 };

  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${Math.floor(ts / 1000)}.${rawBody}`).digest("hex")
  );
  const given = Buffer.from(String(parts.v1));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_signature", status: 400 };
  }
  return { ok: true };
}
