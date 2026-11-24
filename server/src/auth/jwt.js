/**
 * ID token verification.
 *
 * An OpenID Connect ID token is the provider's signed statement about who just
 * signed in. We receive it over TLS straight from the provider's token
 * endpoint, so transport alone is a defensible basis for trusting it — Google
 * says as much in its own documentation. We verify the signature anyway,
 * because the alternative is that a single misconfigured token-endpoint URL,
 * or a proxy that is not what it claims, silently becomes an identity oracle.
 * Verification turns that from a breach into a failed login.
 *
 * Built on node:crypto alone, so sign-in adds no runtime dependency and no
 * third-party code to the path that decides who a user is.
 */

import { createPublicKey, verify as cryptoVerify, timingSafeEqual } from "node:crypto";

/** Tolerated clock skew between us and the provider. */
export const CLOCK_SKEW_MS = 120_000;

const dec = (b64u) => Buffer.from(b64u, "base64url");
const jsonPart = (b64u) => JSON.parse(dec(b64u).toString("utf8"));

/**
 * JWKS cache. Keys rotate, so an unknown `kid` is a reason to refetch — but
 * only at a bounded rate, or an attacker could drive unlimited outbound
 * requests by presenting tokens with random kids.
 */
export function createJwks({ fetchImpl = fetch, minRefetchMs = 60_000, now = () => Date.now() } = {}) {
  const cache = new Map(); // uri -> {keys, fetchedAt}

  async function load(uri) {
    const res = await fetchImpl(uri, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.keys)) throw new Error("jwks has no keys");
    cache.set(uri, { keys: body.keys, fetchedAt: now() });
    return body.keys;
  }

  return {
    async keyFor(uri, kid) {
      const hit = cache.get(uri);
      let keys = hit?.keys;
      if (!keys) keys = await load(uri);

      let jwk = keys.find((k) => k.kid === kid);
      if (!jwk && hit && now() - hit.fetchedAt >= minRefetchMs) {
        keys = await load(uri);
        jwk = keys.find((k) => k.kid === kid);
      }
      if (!jwk) throw new Error(`no signing key for kid ${kid}`);
      if (jwk.kty !== "RSA") throw new Error(`unsupported key type ${jwk.kty}`);
      return createPublicKey({ key: jwk, format: "jwk" });
    },
    _cache: cache,
  };
}

/**
 * Verify and decode an ID token.
 *
 * Every check here is load-bearing:
 *  - signature: the token is the provider's, not someone else's
 *  - iss: it came from the provider we think we are talking to
 *  - aud: it was minted FOR US, not for some other site the user also uses.
 *    Skipping this is the classic confused-deputy hole: a token issued to any
 *    other Google client would otherwise sign that person in here.
 *  - exp/iat: it is current
 *  - nonce: it answers the request WE started, not a replayed older one
 */
export async function verifyIdToken(token, {
  jwks, jwksUri, issuer, audience, nonce, now = Date.now(), maxAgeMs = 3600_000,
}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");
  const [h, p, sig] = parts;

  let header, claims;
  try { header = jsonPart(h); claims = jsonPart(p); }
  catch { throw new Error("malformed id_token"); }

  if (header.alg !== "RS256") throw new Error(`unsupported alg ${header.alg}`);

  const key = await jwks.keyFor(jwksUri, header.kid);
  const ok = cryptoVerify("sha256", Buffer.from(`${h}.${p}`), key, dec(sig));
  if (!ok) throw new Error("bad id_token signature");

  const issuers = Array.isArray(issuer) ? issuer : [issuer];
  if (!issuers.includes(claims.iss)) throw new Error(`unexpected issuer ${claims.iss}`);

  // `aud` may be a string or an array; `azp` names the party it was issued to.
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(audience)) throw new Error("id_token was not issued for this client");
  if (claims.azp && claims.azp !== audience) throw new Error("id_token was issued to another client");

  if (typeof claims.exp !== "number" || now >= claims.exp * 1000 + CLOCK_SKEW_MS) {
    throw new Error("id_token expired");
  }
  if (typeof claims.iat === "number") {
    if (now + CLOCK_SKEW_MS < claims.iat * 1000) throw new Error("id_token is from the future");
    if (now - claims.iat * 1000 > maxAgeMs + CLOCK_SKEW_MS) throw new Error("id_token is too old");
  }

  if (nonce !== undefined) {
    const a = Buffer.from(String(claims.nonce ?? ""));
    const b = Buffer.from(String(nonce));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("id_token nonce mismatch");
  }

  if (!claims.sub) throw new Error("id_token has no subject");
  return claims;
}
