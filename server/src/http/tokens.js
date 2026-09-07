/**
 * Session tokens.
 *
 * M1–M6 (accounts, OAuth) are not built yet, so this module does the smallest
 * honest thing: an HMAC-signed, expiring bearer token. It is NOT an identity
 * provider — it proves only that whoever holds the token was issued one by this
 * server. When real sign-in lands, `verifyToken` is the single seam to replace.
 *
 * The alternative — trusting a plain `X-User-Id` header — would mean anyone
 * could read anyone's subscription by guessing a user id. That is available
 * here only behind an explicit dev flag, and the server says so at boot.
 */

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function sign(payloadB64, secret) {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export function issueToken(userId, secret, { ttlMs = 30 * 864e5, now = Date.now() } = {}) {
  if (!secret) throw new Error("cannot issue a token without a session secret");
  const payload = b64u(JSON.stringify({ sub: userId, exp: now + ttlMs, jti: randomUUID() }));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * @returns {{ok:true, userId:string}|{ok:false, reason:string}}
 * Never throws on malformed input — a bad token is a 401, not a 500.
 */
export function verifyToken(token, secret, now = Date.now()) {
  if (!secret) return { ok: false, reason: "no_session_secret" };
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payload, mac] = parts;

  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(mac);
  // Compare lengths first: timingSafeEqual throws on a length mismatch.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!claims?.sub) return { ok: false, reason: "malformed" };
  if (!(now < claims.exp)) return { ok: false, reason: "expired" };
  return { ok: true, userId: String(claims.sub) };
}
