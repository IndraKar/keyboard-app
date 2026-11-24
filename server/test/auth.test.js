/**
 * Sign-in, end to end, against a stand-in identity provider.
 *
 * The provider is real in every way that matters: a genuine RSA keypair, a
 * genuine JWKS document, genuinely signed RS256 ID tokens. That is what makes
 * these tests worth anything — a fake that just returns `{ok:true}` would pass
 * whether or not the verification works, which is the one thing being tested.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, createSign, createHash } from "node:crypto";

import { createApp } from "../src/http/app.js";
import { createMemoryStore } from "../src/store/memory.js";
import { createMatchmaker } from "../src/competition/matchmaking.js";
import { createOidc, PROVIDERS, authorizeUrl, pkcePair } from "../src/auth/oidc.js";
import { createAuthFlow } from "../src/auth/pending.js";
import { createJwks, verifyIdToken } from "../src/auth/jwt.js";
import { verifyToken } from "../src/http/tokens.js";

const SECRET = "test-session-secret-at-least-32-chars-long";
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/* ---- a stand-in Google ---------------------------------------------------- */
function makeIdp({ issuer = "https://accounts.google.com", kid = "k1" } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };

  const signIdToken = (claims, { useKid = kid, alg = "RS256" } = {}) => {
    const h = b64u({ alg, kid: useKid, typ: "JWT" });
    const p = b64u(claims);
    const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey).toString("base64url");
    return `${h}.${p}.${sig}`;
  };

  const claimsFor = (over = {}) => ({
    iss: issuer, aud: "client-abc", sub: "google-user-1",
    email: "player@example.com", email_verified: true, name: "Ada Lovelace",
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  });

  return { jwk, signIdToken, claimsFor, privateKey };
}

/**
 * fetch() stand-in: serves the JWKS and the token endpoint.
 *
 * `live.nonce` is how a real provider behaves — it remembers the nonce from the
 * authorize request and stamps it into the ID token. Without that the server's
 * nonce check correctly rejects every login, which is how this harness first
 * found out the check works.
 */
function makeFetch(idp, { onToken, jwksCalls = { n: 0 }, live = {} } = {}) {
  return async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/certs")) {
      jwksCalls.n++;
      return { ok: true, status: 200, json: async () => ({ keys: [idp.jwk] }) };
    }
    const body = new URLSearchParams(opts.body || "");
    const r = onToken
      ? await onToken(body, opts, live)
      : { ok: true, status: 200,
          payload: { id_token: idp.signIdToken(idp.claimsFor({ nonce: live.nonce })) } };
    return { ok: r.ok, status: r.status, text: async () => JSON.stringify(r.payload) };
  };
}

function buildApp(idp, { makeFetchImpl, clients } = {}) {
  const store = createMemoryStore();
  /* Shared with the stand-in provider so it can echo back the nonce it was
     given, the way Google and Yahoo do. */
  const live = {};
  const f = (makeFetchImpl ?? ((l) => makeFetch(idp, { live: l })))(live);
  const oidc = createOidc({
    clients: clients ?? { google: { clientId: "client-abc", clientSecret: "shh" } },
    fetchImpl: f,
    jwks: createJwks({ fetchImpl: f }),
  });
  const app = createApp({
    store, oidc, authFlow: createAuthFlow(), matchmaker: createMatchmaker(),
    config: { sessionSecret: SECRET, oauthClients: { google: { clientId: "client-abc", clientSecret: "shh" } } },
  });
  return { app, store, live };
}

async function serve(app) {
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, r));
  const base = `http://127.0.0.1:${s.address().port}`;
  return {
    base,
    close: () => new Promise((r) => s.close(r)),
    async req(path, opts = {}) {
      const res = await fetch(base + path, { redirect: "manual", ...opts });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* html */ }
      return { status: res.status, json, text, headers: res.headers };
    },
  };
}

/**
 * Drive one complete login. The `live.nonce` capture stands in for the browser
 * carrying the nonce to the provider.
 */
async function signInOnce(s, live, provider = "google") {
  const start = await s.req(`/v1/auth/${provider}/start`, { method: "POST" });
  const u = new URL(start.json.url);
  live.nonce = u.searchParams.get("nonce");
  const cb = await s.req(
    `/v1/auth/${provider}/callback?code=abc&state=${encodeURIComponent(u.searchParams.get("state"))}`);
  return { start, u, cb, result: (await s.req(`/v1/auth/ticket/${start.json.ticket}`)).json };
}

/* ---------------------------------------------------------------- the flow */

test("a full Google sign-in issues a session token for a new account", async () => {
  const idp = makeIdp();
  const { app, store, live } = buildApp(idp);
  const s = await serve(app);
  try {
    const start0 = await s.req("/v1/auth/google/start", { method: "POST" });
    assert.equal(start0.status, 200);
    const u0 = new URL(start0.json.url);
    assert.equal(u0.origin + u0.pathname, PROVIDERS.google.authorizeUrl);
    assert.equal(u0.searchParams.get("response_type"), "code");
    assert.equal(u0.searchParams.get("code_challenge_method"), "S256", "Google gets PKCE");
    assert.match(u0.searchParams.get("redirect_uri"), /\/v1\/auth\/google\/callback$/);
    assert.ok(u0.searchParams.get("nonce"), "every login carries a nonce");
    // nothing to collect yet
    assert.equal((await s.req(`/v1/auth/ticket/${start0.json.ticket}`)).json.status, "pending");

    const { cb, result: got } = await signInOnce(s, live);
    assert.equal(cb.status, 200);
    assert.match(cb.text, /signed in/i);
    assert.doesNotMatch(cb.text, /eyJ/, "the callback page must never carry a token");

    assert.equal(got.status, "ready");
    assert.equal(got.user.name, "Ada Lovelace");
    assert.equal(got.user.email, "player@example.com");

    const v = verifyToken(got.token, SECRET);
    assert.equal(v.ok, true);
    const user = await store.getUser(v.userId);
    assert.equal(user.provider_user_id, "google-user-1");

    // the token works on a real route
    const me = await s.req("/v1/me", { headers: { authorization: `Bearer ${got.token}` } });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.name, "Ada Lovelace");
    assert.equal(me.json.legacy, false);
  } finally { await s.close(); }
});

test("a ticket can only be collected once", async () => {
  const idp = makeIdp();
  const { app, live } = buildApp(idp);
  const s = await serve(app);
  try {
    const { start, result } = await signInOnce(s, live);
    assert.equal(result.status, "ready");
    assert.equal((await s.req(`/v1/auth/ticket/${start.json.ticket}`)).json.status, "pending",
      "a spent ticket must not hand the token out again");
  } finally { await s.close(); }
});

test("signing in twice reaches the same account, and progress follows it", async () => {
  const idp = makeIdp();
  const { app, live } = buildApp(idp);
  const s = await serve(app);
  const signIn = async () => (await signInOnce(s, live)).result;
  try {
    const first = await signIn();
    await s.req("/v1/progress", {
      method: "PUT",
      headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
      body: JSON.stringify({ lifetimeXp: 450, unlocked: { ear: 2, sight: 1, keys: 1, repeat: 1 } }),
    });

    const second = await signIn();          // "another device"
    assert.equal(second.user.id, first.user.id, "same person, same account");
    const prog = await s.req("/v1/progress", { headers: { authorization: `Bearer ${second.token}` } });
    assert.equal(prog.json.progress.lifetimeXp, 450, "progress follows the account, not the device");
  } finally { await s.close(); }
});

test("a replayed or unknown state is refused and fulfils nothing", async () => {
  const idp = makeIdp();
  const { app, live } = buildApp(idp);
  const s = await serve(app);
  try {
    const { start, u } = await signInOnce(s, live);
    const state = u.searchParams.get("state");

    const replay = await s.req(`/v1/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    assert.equal(replay.status, 400);
    assert.equal((await s.req(`/v1/auth/ticket/${start.json.ticket}`)).json.status, "pending");

    const bogus = await s.req("/v1/auth/google/callback?code=abc&state=not-a-real-state");
    assert.equal(bogus.status, 400);
  } finally { await s.close(); }
});

test("the user cancelling at the consent screen is reported, not treated as success", async () => {
  const idp = makeIdp();
  const { app } = buildApp(idp);  // no successful exchange here, so no nonce needed
  const s = await serve(app);
  try {
    const start = await s.req("/v1/auth/google/start", { method: "POST" });
    const state = new URL(start.json.url).searchParams.get("state");
    const cb = await s.req(`/v1/auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    assert.equal(cb.status, 200);
    const r = await s.req(`/v1/auth/ticket/${start.json.ticket}`);
    assert.equal(r.json.status, "error");
    assert.equal(r.json.error, "cancelled");
  } finally { await s.close(); }
});

test("an unconfigured provider is never offered and refuses to start", async () => {
  const idp = makeIdp();
  const { app } = buildApp(idp);
  const s = await serve(app);
  try {
    const list = await s.req("/v1/auth/providers");
    assert.deepEqual(list.json.providers.map((p) => p.id), ["google"], "yahoo has no keys here");
    const y = await s.req("/v1/auth/yahoo/start", { method: "POST" });
    assert.equal(y.status, 503);
    assert.equal(y.json.error, "provider_not_configured");
  } finally { await s.close(); }
});

test("sign-out is honest that a stateless token is not revoked", async () => {
  const idp = makeIdp();
  const { app, live } = buildApp(idp);
  const s = await serve(app);
  try {
    const { result: { token } } = await signInOnce(s, live);
    const out = await s.req("/v1/auth/signout", {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(out.json.ok, true);
    assert.equal(out.json.revoked, false, "it must not claim a revocation it did not perform");
  } finally { await s.close(); }
});

/* ------------------------------------------------- ID token verification */

test("an ID token minted for another client is refused", async () => {
  const idp = makeIdp();
  const { app, live } = buildApp(idp, {
    makeFetchImpl: (l) => makeFetch(idp, { live: l, onToken: async (_b, _o, lv) => ({
      ok: true, status: 200,
      payload: { id_token: idp.signIdToken(idp.claimsFor({ aud: "somebody-elses-client", nonce: lv.nonce })) },
    }) }),
  });
  const s = await serve(app);
  try {
    const { result } = await signInOnce(s, live);
    assert.equal(result.status, "error");
    assert.equal(result.error, "verification_failed");
  } finally { await s.close(); }
});

test("a tampered ID token is refused", async () => {
  const idp = makeIdp();
  const { app, live } = buildApp(idp, {
    makeFetchImpl: (l) => makeFetch(idp, { live: l, onToken: async (_b, _o, lv) => {
      /* Keep the real header and signature; swap the payload for one naming
         somebody else. This is the attack the signature check exists for. */
      const [h, , sig] = idp.signIdToken(idp.claimsFor({ nonce: lv.nonce })).split(".");
      const forged = b64u(idp.claimsFor({ sub: "somebody-else", email: "attacker@example.com", nonce: lv.nonce }));
      return { ok: true, status: 200, payload: { id_token: `${h}.${forged}.${sig}` } };
    } }),
  });
  const s = await serve(app);
  try {
    const { result } = await signInOnce(s, live);
    assert.equal(result.error, "verification_failed");
  } finally { await s.close(); }
});

test("an unsigned 'alg: none' token is refused", async () => {
  const idp = makeIdp();
  const jwks = createJwks({ fetchImpl: makeFetch(idp) });
  const h = b64u({ alg: "none", kid: "k1", typ: "JWT" });
  const p = b64u(idp.claimsFor());
  await assert.rejects(
    () => verifyIdToken(`${h}.${p}.`, {
      jwks, jwksUri: PROVIDERS.google.jwksUri,
      issuer: PROVIDERS.google.issuer, audience: "client-abc",
    }),
    /unsupported alg/
  );
});

test("an expired ID token is refused, and a replayed nonce is caught", async () => {
  const idp = makeIdp();
  const jwks = createJwks({ fetchImpl: makeFetch(idp) });
  const common = {
    jwks, jwksUri: PROVIDERS.google.jwksUri,
    issuer: PROVIDERS.google.issuer, audience: "client-abc",
  };
  const past = Math.floor(Date.now() / 1000) - 7200;
  await assert.rejects(
    () => verifyIdToken(idp.signIdToken(idp.claimsFor({ exp: past, iat: past - 60 })), common),
    /expired/
  );
  await assert.rejects(
    () => verifyIdToken(idp.signIdToken(idp.claimsFor({ nonce: "mine" })), { ...common, nonce: "someone-elses" }),
    /nonce mismatch/
  );
  // and the happy path still passes, so the above are not passing by accident
  const ok = await verifyIdToken(idp.signIdToken(idp.claimsFor({ nonce: "mine" })), { ...common, nonce: "mine" });
  assert.equal(ok.sub, "google-user-1");
});

test("a token from the wrong issuer is refused", async () => {
  const idp = makeIdp();
  const jwks = createJwks({ fetchImpl: makeFetch(idp) });
  await assert.rejects(
    () => verifyIdToken(idp.signIdToken(idp.claimsFor({ iss: "https://evil.example" })), {
      jwks, jwksUri: PROVIDERS.google.jwksUri,
      issuer: PROVIDERS.google.issuer, audience: "client-abc",
    }),
    /unexpected issuer/
  );
});

test("the JWKS is cached, and an unknown kid is not a refetch stampede", async () => {
  const idp = makeIdp();
  const calls = { n: 0 };
  const jwks = createJwks({ fetchImpl: makeFetch(idp, { jwksCalls: calls }), minRefetchMs: 60_000 });
  const common = {
    jwks, jwksUri: PROVIDERS.google.jwksUri,
    issuer: PROVIDERS.google.issuer, audience: "client-abc",
  };
  await verifyIdToken(idp.signIdToken(idp.claimsFor()), common);
  await verifyIdToken(idp.signIdToken(idp.claimsFor()), common);
  assert.equal(calls.n, 1, "the second verify must reuse the cached keys");

  const before = calls.n;
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => verifyIdToken(
      idp.signIdToken(idp.claimsFor(), { useKid: "unknown-" + i }), common), /no signing key/);
  }
  assert.equal(calls.n, before, "unknown kids must not drive a refetch per request");
});

/* ----------------------------------------------------------- PKCE & state */

test("PKCE challenge is the S256 hash of the verifier, and state is not the ticket", () => {
  const { verifier, challenge } = pkcePair();
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));

  const flow = createAuthFlow();
  const a = flow.begin({ provider: "google", verifier });
  assert.notEqual(a.state, a.ticket, "the polling credential must not travel through the provider");
  assert.ok(a.state.length >= 40 && a.ticket.length >= 40);
  const b = flow.begin({ provider: "google", verifier });
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.ticket, b.ticket);
});

test("Yahoo is sent no PKCE parameters", () => {
  const u = new URL(authorizeUrl("yahoo", {
    clientId: "y", redirectUri: "https://x/cb", state: "s", nonce: "n", challenge: "c",
  }));
  assert.equal(u.searchParams.get("code_challenge"), null);
  assert.equal(u.searchParams.get("scope"), "openid email profile");
  assert.equal(u.origin + u.pathname, PROVIDERS.yahoo.authorizeUrl);
});

test("pending logins expire and are swept", () => {
  let t = 0;
  const flow = createAuthFlow({ now: () => t });
  const { state, ticket } = flow.begin({ provider: "google", verifier: "v" });
  t += 11 * 60_000;
  assert.equal(flow.claim(state), null, "an abandoned login must not stay claimable");
  flow.fulfil(ticket, { token: "tok", user: {} });
  t += 6 * 60_000;
  assert.equal(flow.collect(ticket).status, "pending", "an uncollected result must expire too");
});
