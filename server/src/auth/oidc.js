/**
 * Sign in with Google and Yahoo — OpenID Connect, authorization-code flow.
 *
 * The app runs inside a sandboxed, cross-origin iframe. That rules out the
 * usual browser-side options: a redirect cannot navigate the top frame, and
 * Google Identity Services needs a registered JavaScript origin, which an
 * artifact sandbox does not have a stable one of. So the browser only ever
 * OPENS a window at this server; every secret-bearing step happens here.
 *
 * The client secret never reaches the browser, which is the whole reason the
 * exchange is server-side. The browser gets one thing back: a Keyvoria session
 * token, collected through a single-use ticket (see pending.js).
 */

import { randomBytes, createHash } from "node:crypto";
import { createJwks, verifyIdToken } from "./jwt.js";

export const b64url = (buf) => Buffer.from(buf).toString("base64url");
export const randomUrlSafe = (bytes = 32) => b64url(randomBytes(bytes));

/**
 * Google and Yahoo both speak OIDC, and differ in two ways that matter:
 *
 *  - PKCE. Google supports it; Yahoo's authorization server is not documented
 *    to, and sending parameters a server does not expect is a good way to earn
 *    an opaque invalid_request. We are a CONFIDENTIAL client either way — the
 *    code is exchanged with a client secret from this server — so PKCE here is
 *    defence in depth, not the thing holding the flow up. It is on where it is
 *    known to work.
 *  - Client authentication. Yahoo wants HTTP Basic on the token endpoint.
 *    Google accepts either; Basic is used for both so there is one path.
 */
export const PROVIDERS = {
  google: {
    id: "google",
    label: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    scope: "openid email profile",
    pkce: true,
    // Google only returns a refresh token with these, and we do not want one:
    // Keyvoria needs to know who you are once, not to act for you later.
    extraAuthParams: {},
  },
  yahoo: {
    id: "yahoo",
    label: "Yahoo",
    authorizeUrl: "https://api.login.yahoo.com/oauth2/request_auth",
    tokenUrl: "https://api.login.yahoo.com/oauth2/get_token",
    jwksUri: "https://api.login.yahoo.com/openid/v1/certs",
    issuer: ["https://api.login.yahoo.com"],
    scope: "openid email profile",
    pkce: false,
    extraAuthParams: {},
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/**
 * Point a provider at somewhere else. Exists so the whole flow can be driven
 * end to end against a stand-in identity provider in a browser — the only way
 * to prove the app's half works without a Google account and a public URL.
 *
 * Production never calls this; server.js only does so when the matching
 * KEYVORIA_OIDC_*_BASE variable is set, which is documented as test-only.
 */
export function overrideProviderEndpoints(id, base) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown provider: ${id}`);
  const root = String(base).replace(/\/+$/, "");
  p.authorizeUrl = `${root}/authorize`;
  p.tokenUrl = `${root}/token`;
  p.jwksUri = `${root}/openid/v1/certs`;
  p.issuer = [root];
  return p;
}

const formEncode = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

export const pkcePair = () => {
  const verifier = randomUrlSafe(32);
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};

/**
 * Build the URL the user's browser is sent to.
 *
 * `state` defends the callback against being driven by someone else's login;
 * `nonce` ties the returned ID token to this particular request. They are
 * separate values with separate jobs, and neither is the ticket the client
 * polls with — that one never leaves our side of the exchange.
 */
export function authorizeUrl(provider, { clientId, redirectUri, state, nonce, challenge }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);
  const params = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: p.scope,
    state,
    nonce,
    ...p.extraAuthParams,
  };
  if (p.pkce && challenge) {
    params.code_challenge = challenge;
    params.code_challenge_method = "S256";
  }
  return `${p.authorizeUrl}?${formEncode(params)}`;
}

/**
 * Create the piece that turns an authorization code into a verified identity.
 * `fetchImpl` and `jwks` are injectable so the whole flow is testable against a
 * stand-in provider with a real keypair, rather than only in production.
 */
export function createOidc({ clients, fetchImpl = fetch, jwks = createJwks({ fetchImpl }), now = () => Date.now() } = {}) {
  const configured = (id) => {
    const c = clients?.[id];
    return !!(c && c.clientId && c.clientSecret);
  };

  async function exchange(provider, { code, redirectUri, verifier, nonce }) {
    const p = PROVIDERS[provider];
    if (!p) throw new Error(`unknown provider: ${provider}`);
    const c = clients?.[provider];
    if (!configured(provider)) throw new Error(`${provider} sign-in is not configured on this server`);

    const body = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    };
    if (p.pkce && verifier) body.code_verifier = verifier;

    const res = await fetchImpl(p.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        // Basic auth rather than client_secret_post: Yahoo requires it, Google
        // accepts it, and one path is one path to get wrong.
        authorization: "Basic " + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64"),
      },
      body: formEncode(body),
    });

    const text = await res.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = null; }
    if (!res.ok || !payload) {
      // Never surface the provider's raw body: it can echo the code back.
      throw new Error(`${provider} rejected the sign-in (${res.status} ${payload?.error || "token_exchange_failed"})`);
    }
    if (!payload.id_token) throw new Error(`${provider} returned no id_token`);

    const claims = await verifyIdToken(payload.id_token, {
      jwks,
      jwksUri: p.jwksUri,
      issuer: p.issuer,
      audience: c.clientId,
      nonce,
      now: now(),
    });

    return {
      provider,
      subject: String(claims.sub),
      email: claims.email ? String(claims.email) : null,
      emailVerified: claims.email_verified === true || claims.email_verified === "true",
      name: claims.name ? String(claims.name) :
            claims.given_name ? String(claims.given_name) : null,
    };
  }

  return {
    exchange,
    configured,
    /** Which buttons the app should offer. A provider with no keys is not on. */
    available: () => PROVIDER_IDS.filter(configured),
  };
}
