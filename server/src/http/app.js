/**
 * The HTTP surface for M7 (billing) and M7a (Competition Mode).
 *
 * Exported as a plain `(req, res)` handler rather than a running server so the
 * tests can drive it over a real socket on port 0, and so a deployment can put
 * it behind whatever it likes.
 *
 * Two rules run through every route below:
 *
 *  1. ENTITLEMENT IS CHECKED HERE, NOT IN THE CLIENT. Competition and upload
 *     are paid features; the prototype's paywall screen is a courtesy, not a
 *     gate. A request without a live subscription gets 402 no matter what the
 *     app looked like when it was sent.
 *
 *  2. THE SERVER OWNS THE PASSAGE AND THE RULING. The client posts a key press
 *     and is told whether it survived. It is never asked for its own verdict.
 */

import {
  describe as describeSub, isEntitled, requestCancel, resume, newSubscription,
} from "../billing/subscription.js";
import { handleWebhook, sweep } from "../billing/webhooks.js";
import { LEVELS } from "../competition/passage.js";
import { CHORD_LEVELS, CHORD_LABELS } from "../competition/chords.js";
import { KEY_LEVELS } from "../competition/keys.js";
import { KEYS as KEY_SIGNATURES, KEY_TIERS, keyLabel } from "../theory/keysignatures.js";
import { GAMES, MAX_PLAYERS, MIN_PLAYERS, publicView, resolve, submitAnswer, MATCH_STATE } from "../competition/match.js";
import { normaliseCode, CODE_LENGTH } from "../competition/matchmaking.js";
import { validateDisplayName, validateAvatar, displayNameFor,
         MAX_AVATAR_BYTES, MAX_DISPLAY_NAME } from "../auth/profile.js";
import { verifyToken, issueToken } from "./tokens.js";
import { STATUS } from "../billing/subscription.js";
import { mergeProgress, normaliseProgress, MAX_PROGRESS_BYTES } from "../progress/merge.js";
import { verifySignature } from "./signature.js";
import { PROVIDERS as OIDC_PROVIDERS, authorizeUrl, pkcePair } from "../auth/oidc.js";
import { randomUUID } from "node:crypto";

const MAX_BODY_BYTES = 64 * 1024; // no route here needs more; caps a trivial DoS
const PROVIDERS = new Set(["stripe", "paypal", "apple_app_store", "google_play"]);

/** Ladders per game, so one lookup answers "is this a real level?" for both. */
const LADDERS = { reading: LEVELS, chords: CHORD_LEVELS, keys: KEY_LEVELS };

/**
 * Which header each provider signs with. Stripe sends `Stripe-Signature`; an
 * earlier version read a header of our own invention, so a real Stripe delivery
 * would have arrived unsigned and been rejected 100% of the time.
 *
 * PayPal does NOT use this scheme — it signs with a cert-chain scheme over
 * several transmission headers. Its endpoint therefore stays closed until that
 * is implemented rather than pretending a shared secret verifies it.
 */
const SIGNATURE_HEADER = {
  stripe: "stripe-signature",
  paypal: "paypal-transmission-sig",
  apple_app_store: "x-apple-signature",
  google_play: "x-goog-signature",
};
const VERIFIABLE = new Set(["stripe"]);
/** For messages a person reads, not for logic. */
const PROVIDER_LABELS = {
  stripe: "Keyvoria", paypal: "PayPal",
  apple_app_store: "the App Store", google_play: "Google Play",
};
const STATUS_CANCEL_PENDING = STATUS.CANCEL_PENDING;

/**
 * Public origin of this request — for Stripe's return URLs and, more fussily,
 * for the OAuth redirect URI, which must match what is registered in the
 * Google and Yahoo consoles character for character.
 *
 * Behind a proxy (Render, Fly, a load balancer) the only honest source is
 * x-forwarded-proto. With no proxy header, the connection itself is the
 * answer: a plain HTTP socket on localhost is a developer running the server
 * directly, and telling the provider to come back over https would send them
 * to a port that is not speaking TLS. Anything else defaults to https, because
 * a public deployment that is not behind TLS is a problem of its own.
 */
function publicBase(req) {
  const fwd = req.headers["x-forwarded-proto"];
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
  const proto = fwd ? String(fwd).split(",")[0].trim()
              : req.socket?.encrypted ? "https"
              : local ? "http"
              : "https";
  return `${proto}://${host}`;
}
const validGame = (g) => (Object.hasOwn(LADDERS, g) ? g : null);
const validLevel = (game, level) => Number.isInteger(level) && !!LADDERS[game][level - 1];

function send(res, status, body, extraHeaders = {}) {
  const payload = body === null ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve_, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Drain and discard rather than destroying the socket: killing the
        // connection here means the client sees a reset instead of the 413 and
        // has no idea what it did wrong. Past a wide margin we do give up, so
        // an endless upload cannot hold the connection open forever.
        overflowed = true;
        chunks.length = 0;
        if (size > MAX_BODY_BYTES * 16) req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (overflowed) return reject(Object.assign(new Error("body_too_large"), { status: 413 }));
      resolve_(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/** What the client is allowed to know about an account. No provider subject,
    no verification flags — the app only needs to greet someone by name. */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,                    // what Google or Yahoo calls them
    displayName: displayNameFor(u),  // what they call themselves here
    hasChosenName: !!(u.display_name && u.display_name.trim()),
    avatar: u.avatar || null,
    email: u.email,
    provider: u.provider,
  };
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    /* This page is the end of an OAuth redirect. It carries no token and needs
       no scripts; the headers say so, so a stray injection has nothing to work
       with. */
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  res.end(html);
}

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The page a person actually sees at the end of a sign-in. */
function authPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} \u2014 Keyvoria</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#110f0e;color:#f5f1ec;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}
.card{max-width:380px;text-align:center}
h1{font-size:21px;margin:0 0 10px;letter-spacing:-.01em}
p{color:#a89f96;font-size:14px;margin:0}
.mark{display:flex;gap:3px;justify-content:center;margin-bottom:18px}
.k{width:13px;height:44px;background:#f4ece0;border-radius:0 0 3px 3px}
.k.b{width:9px;height:28px;background:#1c1917}
.k.o{background:#ff8a3d}
</style></head><body><div class="card">
<div class="mark"><div class="k"></div><div class="k b"></div><div class="k"></div>
<div class="k o"></div><div class="k b"></div><div class="k"></div></div>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></div></body></html>`;
}

function parseJson(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return null; // caller turns this into a 400
  }
}

export function createApp({
  store,
  matchmaker,
  stripe = null,          // createStripe(...) in production; null disables checkout
  oidc = null,            // createOidc(...) in production; null disables sign-in
  authFlow = null,        // createAuthFlow(...) — in-flight logins
  config = {},
  now = () => Date.now(),
} = {}) {
  const {
    devAuth = false,
    sessionSecret = null,
    webhookSecrets = {},
    allowUnsignedWebhooks = false,
    allowedOrigin = "*",
    oauthClients = {},
    sessionTtlMs = 90 * 864e5,
  } = config;

  /**
   * Where the provider sends the browser back. It must match what is
   * registered in the Google and Yahoo consoles EXACTLY, character for
   * character, so it is derived from the request's public origin rather than
   * guessed — behind Render's proxy the raw Host header is not the public one.
   */
  const redirectUriFor = (req, provider) => `${publicBase(req)}/v1/auth/${provider}/callback`;

  const signInAvailable = () => (oidc && authFlow ? oidc.available() : []);

  /**
   * Identify the caller.
   *
   * Dev mode accepts `Authorization: Bearer dev:<userId>` so the prototype can
   * be pointed at a local server before sign-in exists. It is off unless
   * explicitly enabled, because in production it would let anyone be anyone.
   */
  function authenticate(req) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return { ok: false, reason: "missing_token" };
    if (devAuth && token.startsWith("dev:")) {
      const id = token.slice(4).trim();
      return id ? { ok: true, userId: id, dev: true } : { ok: false, reason: "malformed" };
    }
    return verifyToken(token, sessionSecret, now());
  }

  /** A queued player may be placed in a match by someone else's poll. */
  function findMatchFor(userId) {
    return matchmaker.all().find(
      (m) => m.entrants.has(userId) && m.state !== MATCH_STATE.FINISHED
    ) ?? null;
  }

  async function entitled(userId) {
    return isEntitled(await store.getSubscription(userId), now());
  }

  const PAYWALL = {
    error: "subscription_required",
    // Same words the app shows, so support never has to translate a code.
    message: "Keyvoria Plus is $5.95 a month. It unlocks Competition Mode, Upload your file, tier 4, and the 61-key keyboard.",
    priceCents: 595,
  };

  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const seg = url.pathname.split("/").filter(Boolean);
    const method = req.method.toUpperCase();

    // The prototype runs from a file:// page or an artifact origin, so the API
    // has to be reachable cross-origin. Credentials are never cookie-based —
    // the bearer token is explicit — so this cannot be used for a CSRF ride.
    res.setHeader("access-control-allow-origin", allowedOrigin);
    res.setHeader("access-control-allow-headers", "authorization,content-type,x-keyvoria-signature");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    if (method === "OPTIONS") { res.writeHead(204); return res.end(); }

    let raw = "";
    /* PUT was missing here, so /v1/progress read an empty body and stored a
       player's progress as all zeroes. Any method that can carry a body must
       be listed. */
    if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
      try {
        raw = await readBody(req);
      } catch (err) {
        return send(res, err.status ?? 400, { error: err.message });
      }
    }

    try {
      // ------------------------------------------------------------- public
      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, service: "keyvoria", milestones: ["M7", "M7a"] });
      }

      if (method === "GET" && url.pathname === "/v1/competition/levels") {
        return send(res, 200, {
          games: [
            { id: "reading", label: GAMES.reading.label, wonBy: "first to finish", levels: LEVELS },
            { id: "chords", label: GAMES.chords.label, wonBy: "last player standing", levels: CHORD_LEVELS },
            {
              id: "keys", label: GAMES.keys.label,
              wonBy: "last player standing, then sudden death",
              levels: KEY_LEVELS.map(({ level, questions, seconds, blurb }) => ({ level, questions, seconds, blurb })),
              suddenDeathMs: 30_000,
            },
          ],
          keySignatures: KEY_SIGNATURES.map((k) => ({
            id: k.id, label: keyLabel(k), sharps: k.sharps, flats: k.flats,
          })),
          keyTiers: KEY_TIERS,
          chordLabels: CHORD_LABELS,
          maxPlayers: MAX_PLAYERS,
          minPlayers: MIN_PLAYERS,
          // The reading ladder under its old key, so a client written against
          // the single-game API keeps working.
          levels: LEVELS,
        });
      }

      // ----------------------------------------------------------- webhooks
      // Before auth: these are called by the provider, not by a user.
      if (method === "POST" && seg[0] === "v1" && seg[1] === "webhooks") {
        const provider = seg[2];
        if (!PROVIDERS.has(provider)) return send(res, 404, { error: "unknown_provider" });

        // Only Stripe's scheme is implemented. Accepting another provider's
        // delivery on a shared secret would be verification theatre.
        if (!VERIFIABLE.has(provider) && !allowUnsignedWebhooks) {
          return send(res, 501, { error: "signature_scheme_not_implemented", provider });
        }
        const header = req.headers[SIGNATURE_HEADER[provider]] ?? req.headers["x-keyvoria-signature"];
        const sig = verifySignature(raw, header, webhookSecrets[provider], {
          now: now(),
          allowUnsigned: allowUnsignedWebhooks,
        });
        if (!sig.ok) return send(res, sig.status, { error: sig.reason });

        const body = parseJson(raw);
        if (!body) return send(res, 400, { error: "invalid_json" });

        let result;
        try {
          result = await handleWebhook(store, provider, body, now(), { stripe });
        } catch (err) {
          // A payload we cannot even identify must still be acknowledged as
          // received-and-rejected, or the provider retries it forever.
          return send(res, 400, { error: String(err.message) });
        }
        // 200 on ignored/duplicate too: anything else asks for a retry we do
        // not want.
        return send(res, 200, {
          applied: result.applied, duplicate: result.duplicate,
          ignored: result.ignored, reason: result.reason ?? null,
        });
      }

      // ------------------------------------------------------------ sign-in
      // All of this is before the auth gate: it is how a caller GETS a token.

      /* Which buttons to draw. A provider with no keys configured is not
         offered, rather than offered and then failing at the consent screen. */
      if (method === "GET" && url.pathname === "/v1/auth/providers") {
        return send(res, 200, {
          providers: signInAvailable().map((id) => ({ id, label: OIDC_PROVIDERS[id].label })),
          configured: signInAvailable().length > 0,
        });
      }

      /**
       * Begin a sign-in.
       *
       * Returns a URL for the app to OPEN, plus a ticket to poll. The app is
       * inside a sandboxed cross-origin iframe: it cannot navigate the top
       * frame, and a postMessage back from the popup is not dependable there.
       * Polling a ticket works in every case, and is the same shape as the
       * Stripe checkout flow this app already uses.
       */
      if (method === "POST" && seg[0] === "v1" && seg[1] === "auth" && seg[3] === "start") {
        const provider = seg[2];
        if (!OIDC_PROVIDERS[provider]) return send(res, 404, { error: "unknown_provider" });
        if (!oidc || !authFlow) return send(res, 503, { error: "sign_in_not_configured" });
        if (!oidc.configured(provider)) {
          return send(res, 503, { error: "provider_not_configured", provider });
        }
        const { verifier, challenge } = OIDC_PROVIDERS[provider].pkce ? pkcePair() : {};
        let begun;
        try {
          begun = authFlow.begin({ provider, verifier });
        } catch {
          return send(res, 503, { error: "too_many_sign_ins" });
        }
        return send(res, 200, {
          url: authorizeUrl(provider, {
            clientId: oauthClients[provider].clientId,
            redirectUri: redirectUriFor(req, provider),
            state: begun.state,
            nonce: begun.nonce,
            challenge,
          }),
          ticket: begun.ticket,
          pollMs: 1500,
        });
      }

      /**
       * The provider sends the browser back here.
       *
       * This responds with a human-facing HTML page, not JSON: a person is
       * looking at it. It never puts the session token in the page — the token
       * goes to the ticket, which only the app that started the login holds.
       * Putting it in the URL or the body would leak it into history and logs.
       */
      if (method === "GET" && seg[0] === "v1" && seg[1] === "auth" && seg[3] === "callback") {
        const provider = seg[2];
        if (!OIDC_PROVIDERS[provider]) return send(res, 404, { error: "unknown_provider" });
        if (!oidc || !authFlow) return send(res, 503, { error: "sign_in_not_configured" });

        const rec = authFlow.claim(url.searchParams.get("state"));
        /* No pending record means the state is wrong, replayed or expired.
           Nothing is fulfilled, because we do not know whose login this is. */
        if (!rec || rec.provider !== provider) {
          return sendHtml(res, 400, authPage("Sign-in could not be completed",
            "This sign-in link has already been used or has expired. Close this window and try again."));
        }

        const err = url.searchParams.get("error");
        if (err) {
          authFlow.reject(rec.ticket, err === "access_denied" ? "cancelled" : "provider_error");
          return sendHtml(res, 200, authPage("Sign-in cancelled",
            "You can close this window and go back to Keyvoria."));
        }

        const code = url.searchParams.get("code");
        if (!code) {
          authFlow.reject(rec.ticket, "no_code");
          return sendHtml(res, 400, authPage("Sign-in could not be completed",
            "The provider did not return an authorization code. Close this window and try again."));
        }

        let identity;
        try {
          identity = await oidc.exchange(provider, {
            code,
            redirectUri: redirectUriFor(req, provider),
            verifier: rec.verifier,
            nonce: rec.nonce,
          });
        } catch (e) {
          /* Logged for the operator; the page stays vague, because the detail
             is about our configuration, not about this person. */
          console.error("[keyvoria] sign-in failed:", e.message);
          authFlow.reject(rec.ticket, "verification_failed");
          return sendHtml(res, 400, authPage("Sign-in could not be completed",
            "Keyvoria could not verify that sign-in. Close this window and try again."));
        }

        if (!sessionSecret) {
          authFlow.reject(rec.ticket, "no_session_secret");
          return sendHtml(res, 500, authPage("Sign-in could not be completed",
            "This server has no session secret configured."));
        }

        const { user, created } = await store.upsertUserByIdentity({
          id: randomUUID(),
          provider,
          providerUserId: identity.subject,
          email: identity.email,
          emailVerified: identity.emailVerified,
          name: identity.name,
          now: now(),
        });

        authFlow.fulfil(rec.ticket, {
          token: issueToken(user.id, sessionSecret, { ttlMs: sessionTtlMs, now: now() }),
          user: publicUser(user),
        });
        return sendHtml(res, 200, authPage(
          created ? "You\u2019re signed in" : "Welcome back",
          "Keyvoria has your account. You can close this window \u2014 the app has already picked it up."
        ));
      }

      /**
       * The app polls here while the window is open. Single use: the token is
       * handed over exactly once, so a ticket that leaks afterwards is spent.
       */
      if (method === "GET" && seg[0] === "v1" && seg[1] === "auth" && seg[2] === "ticket" && seg[3]) {
        if (!authFlow) return send(res, 503, { error: "sign_in_not_configured" });
        const r = authFlow.collect(seg[3]);
        if (r.status === "ready") {
          return send(res, 200, { status: "ready", token: r.token, user: r.user, expiresInMs: sessionTtlMs });
        }
        if (r.status === "error") return send(res, 200, { status: "error", error: r.error });
        return send(res, 200, { status: "pending" });
      }

      // --------------------------------------------------------------- auth
      const auth = authenticate(req);
      if (!auth.ok) return send(res, 401, { error: "unauthorized", reason: auth.reason });
      const userId = auth.userId;

      /* Who the bearer of this token is. The app calls it on load to decide
         whether it is still signed in, rather than trusting a flag it saved
         on the device: a token can expire while the device still believes
         otherwise. */
      if (method === "GET" && url.pathname === "/v1/me") {
        const user = store.getUser ? await store.getUser(userId) : null;
        return send(res, 200, {
          userId,
          user: user ? publicUser(user) : null,
          /* True for a token minted by `npm run token` rather than a real
             sign-in, so the app can say so instead of showing a blank name. */
          legacy: !user,
        });
      }

      /**
       * The player's own name and picture.
       *
       * Separate from /v1/me because this one is written as well as read, and
       * because identity (who the provider says you are) and presentation
       * (what you call yourself here) should not share an endpoint — a bug in
       * one must not be able to overwrite the other.
       */
      if (url.pathname === "/v1/profile" && (method === "GET" || method === "PUT")) {
        if (!store.getUser) return send(res, 501, { error: "accounts_not_available" });
        const user = await store.getUser(userId);
        if (!user) return send(res, 404, { error: "no_account", message: "This token has no account behind it." });

        if (method === "GET") return send(res, 200, { profile: publicUser(user) });

        const body = parseJson(raw);
        if (body === null) return send(res, 400, { error: "invalid_json" });

        const patch = {};
        if (body.displayName !== undefined) {
          const v = validateDisplayName(body.displayName);
          if (!v.ok) return send(res, 400, { error: v.reason, message: v.message });
          patch.displayName = v.name;
        }
        if (body.avatar !== undefined) {
          const v = validateAvatar(body.avatar);
          if (!v.ok) return send(res, 400, { error: v.reason, message: v.message });
          patch.avatar = v.avatar;
        }
        if (!Object.keys(patch).length) return send(res, 400, { error: "nothing_to_change" });

        const updated = await store.updateProfile(userId, patch);
        return send(res, 200, { profile: publicUser(updated) });
      }

      /**
       * Delete the account, and everything attached to it.
       *
       * THE SUBSCRIPTION IS CANCELLED FIRST, AND A FAILURE THERE STOPS THE
       * DELETE. Removing our record of a live subscription does not stop
       * Stripe charging the card — it only destroys the evidence that it is
       * happening, leaving someone billed monthly for an account that no
       * longer exists and no way for us to see it. Better to refuse and say
       * so than to delete into that state.
       */
      if (url.pathname === "/v1/account" && method === "DELETE") {
        if (!store.deleteUser) return send(res, 501, { error: "accounts_not_available" });

        const sub = await store.getSubscription(userId);
        if (sub && sub.status !== STATUS.EXPIRED && sub.provider_subscription_id) {
          if (sub.provider === "stripe") {
            if (!stripe) {
              return send(res, 503, {
                error: "billing_not_configured",
                message: "This account has a subscription and billing is not reachable, so it cannot be deleted safely yet.",
              });
            }
            try {
              await stripe.cancelAtPeriodEnd(sub.provider_subscription_id);
            } catch (err) {
              return send(res, 502, {
                error: "cancel_failed",
                message: "Your subscription could not be cancelled, so nothing was deleted. Try again, or cancel in Keyvoria first.",
              });
            }
          } else {
            /* Apple and Google own their subscriptions; we cannot cancel one
               on the user's behalf, so deleting here would leave them paying
               a store for an account that is gone. */
            const p = PROVIDER_LABELS[sub.provider] || sub.provider;
            return send(res, 409, {
              error: "provider_managed_subscription",
              message: `Cancel your subscription in ${p} first — otherwise you would keep being charged for an account that no longer exists.`,
            });
          }
        }

        const existed = await store.deleteUser(userId);
        return send(res, 200, {
          deleted: existed,
          subscriptionCancelled: !!(sub && sub.status !== STATUS.EXPIRED),
          message: "Your account and everything in it has been deleted.",
        });
      }

      /**
       * Sign out.
       *
       * Honest about what it does: these tokens are stateless HMACs with no
       * server-side session to destroy, so this revokes nothing. The client
       * discards the token, which ends the session on that device, and the
       * response says exactly that rather than implying a revocation that did
       * not happen. Real revocation needs a denylist keyed on the token's
       * `jti`, which is a change to verifyToken, not to this route.
       */
      if (method === "POST" && url.pathname === "/v1/auth/signout") {
        return send(res, 200, {
          ok: true,
          revoked: false,
          message: "Discard the token on the device. It stays valid until it expires.",
        });
      }

      // ------------------------------------------------------ subscriptions
      /**
       * Start a subscription. Returns a Stripe Checkout URL for the client to
       * open; the card is collected by Stripe, never by us, so no card data
       * ever reaches this server.
       */
      if (url.pathname === "/v1/billing/checkout" && method === "POST") {
        if (!stripe) return send(res, 503, { error: "billing_not_configured" });
        const existing = await store.getSubscription(userId);
        if (isEntitled(existing, now())) {
          return send(res, 409, { error: "already_subscribed", subscription: describeSub(existing, now()) });
        }
        const body = parseJson(raw);
        if (body === null) return send(res, 400, { error: "invalid_json" });
        try {
          const session = await stripe.createCheckoutSession({
            userId,
            customerEmail: typeof body.email === "string" ? body.email : undefined,
            successUrl: config.successUrl || `${publicBase(req)}/subscribed`,
            cancelUrl: config.cancelUrl || `${publicBase(req)}/`,
          });
          return send(res, 200, { url: session.url, sessionId: session.id });
        } catch (err) {
          console.error("[keyvoria] checkout failed", err.message);
          return send(res, 502, { error: "checkout_failed", message: err.message });
        }
      }

      /**
       * Progress, per account.
       *
       * The device is not a safe place to keep this: the app runs in a
       * cross-origin iframe, and mobile Safari blocks third-party storage, so
       * every localStorage write throws and every finished lesson is lost when
       * the tab closes. Signed in, the account holds it instead.
       */
      if (url.pathname === "/v1/progress" && method === "GET") {
        const stored = await store.getProgress(userId);
        return send(res, 200, { progress: stored ? normaliseProgress(stored) : null });
      }

      /**
       * Save progress. The body is MERGED with what is stored rather than
       * replacing it — see progress/merge.js. Two devices, or a retry of a
       * request that already landed, must not delete lessons somebody played.
       */
      if (url.pathname === "/v1/progress" && method === "PUT") {
        if (raw.length > MAX_PROGRESS_BYTES) return send(res, 413, { error: "progress_too_large" });
        const body = parseJson(raw);
        if (body === null) return send(res, 400, { error: "invalid_json" });

        const incoming = normaliseProgress(body.progress ?? body);
        const stored = await store.getProgress(userId);
        const merged = mergeProgress(stored, incoming);
        const saved = await store.putProgress(userId, merged, merged.lifetimeXp);
        return send(res, 200, { progress: normaliseProgress(saved) });
      }

      /**
       * Wipe progress for this account.
       *
       * Needed because merging never decreases anything: without an explicit
       * delete, "Reset all progress" in the app would clear the device and
       * then have every counter merged straight back from the server on the
       * next sync. The one operation that must not merge is the one whose
       * entire purpose is to go backwards.
       */
      if (url.pathname === "/v1/progress" && method === "DELETE") {
        await store.deleteProgress(userId);
        return send(res, 200, { progress: null, reset: true });
      }

      if (url.pathname === "/v1/subscription" && method === "GET") {
        const sub = await store.getSubscription(userId);
        return send(res, 200, describeSub(sub, now()));
      }

      if (url.pathname === "/v1/subscription/cancel" && method === "POST") {
        const sub = await store.getSubscription(userId);
        if (!sub) return send(res, 404, { error: "no_subscription" });
        /**
         * Tell Stripe BEFORE recording it locally. In the other order, a failed
         * API call leaves the app showing "cancelled" while the card keeps
         * being charged every month — the worst outcome this system can
         * produce. If Stripe refuses, nothing local changes and the user sees
         * an error they can act on.
         */
        if (sub.provider === "stripe" && stripe && sub.status !== STATUS_CANCEL_PENDING) {
          try {
            await stripe.cancelAtPeriodEnd(sub.provider_subscription_id);
          } catch (err) {
            console.error("[keyvoria] stripe cancel failed", err.message);
            return send(res, 502, { error: "cancel_failed", message: err.message });
          }
        }
        const r = requestCancel(sub, now());
        if (!r.ok) {
          // Not an error the user caused: Apple and Google own the cancel, and
          // the client needs the URL to send them there.
          const status = r.reason === "provider_managed" ? 409 : 400;
          return send(res, status, {
            error: r.reason, message: r.message ?? null, manageUrl: r.manageUrl ?? null,
            subscription: describeSub(r.subscription, now()),
          });
        }
        await store.putSubscription(r.subscription);
        return send(res, 200, describeSub(r.subscription, now()));
      }

      if (url.pathname === "/v1/subscription/resume" && method === "POST") {
        const sub = await store.getSubscription(userId);
        if (!sub) return send(res, 404, { error: "no_subscription" });
        if (sub.provider === "stripe" && stripe) {
          try {
            await stripe.resume(sub.provider_subscription_id);
          } catch (err) {
            console.error("[keyvoria] stripe resume failed", err.message);
            return send(res, 502, { error: "resume_failed", message: err.message });
          }
        }
        const r = resume(sub, now());
        if (!r.ok) return send(res, 409, { error: r.reason });
        await store.putSubscription(r.subscription);
        return send(res, 200, describeSub(r.subscription, now()));
      }

      /**
       * Dev-only: grant a subscription without a payment provider, so the app
       * and Competition can be exercised end to end before Stripe exists. It
       * is refused outright unless dev auth is on — there is no configuration
       * in which a production build can mint itself a paid plan.
       */
      if (url.pathname === "/v1/dev/subscribe" && method === "POST") {
        if (!devAuth) return send(res, 404, { error: "not_found" });
        const sub = newSubscription({
          userId, provider: "stripe", providerSubscriptionId: `dev_${userId}`, now: now(),
        });
        await store.putSubscription(sub);
        return send(res, 200, describeSub(sub, now()));
      }

      if (url.pathname === "/v1/dev/token" && method === "POST") {
        if (!devAuth || !sessionSecret) return send(res, 404, { error: "not_found" });
        return send(res, 200, { token: issueToken(userId, sessionSecret, { now: now() }) });
      }

      // ------------------------------------------------------- competition
      if (seg[0] === "v1" && seg[1] === "competition") {
        if (!(await entitled(userId))) return send(res, 402, PAYWALL);

        const body = method === "GET" ? {} : parseJson(raw);
        if (body === null) return send(res, 400, { error: "invalid_json" });
        const name = String(body.displayName || url.searchParams.get("name") || "Player").slice(0, 24);

        // POST /v1/competition/queue — join the ladder for a level of a game.
        if (seg[2] === "queue" && method === "POST") {
          const game = validGame(body.game ?? "reading");
          if (!game) return send(res, 400, { error: "invalid_game" });
          const level = Number(body.level);
          if (!validLevel(game, level)) return send(res, 400, { error: "invalid_level" });
          const r = matchmaker.enqueue(userId, name, level, Number(body.players ?? 8), game);
          if (!r.ok) return send(res, 409, { error: r.reason });
          return send(res, 200, {
            waiting: r.waiting, match: r.match ? publicView(r.match, userId) : null,
          });
        }

        // GET /v1/competition/queue/:level — poll. Polling is also what drives
        // the wait-timeout path, so a lone pair of players still get a match.
        if (seg[2] === "queue" && seg[3] && method === "GET") {
          const game = validGame(url.searchParams.get("game") ?? "reading");
          if (!game) return send(res, 400, { error: "invalid_game" });
          const level = Number(seg[3]);
          if (!validLevel(game, level)) return send(res, 400, { error: "invalid_level" });
          const mine = findMatchFor(userId);
          if (mine) return send(res, 200, { waiting: 0, match: publicView(mine, userId) });
          const r = matchmaker.tryForm(level, game);
          const placed = r.match?.entrants.has(userId) ? r.match : findMatchFor(userId);
          return send(res, 200, {
            waiting: matchmaker.queueLength(level, game),
            match: placed ? publicView(placed, userId) : null,
          });
        }

        if (seg[2] === "queue" && method === "DELETE") {
          const game = validGame(body.game ?? url.searchParams.get("game") ?? "reading");
          if (!game) return send(res, 400, { error: "invalid_game" });
          const level = Number(body.level ?? url.searchParams.get("level"));
          return send(res, 200, { left: matchmaker.leaveQueue(userId, level, game) });
        }

        // Private lobbies — the "everyone in the same room" case.
        if (seg[2] === "private" && !seg[3] && method === "POST") {
          const game = validGame(body.game ?? "reading");
          if (!game) return send(res, 400, { error: "invalid_game" });
          const level = Number(body.level);
          if (!validLevel(game, level)) return send(res, 400, { error: "invalid_level" });
          const r = matchmaker.createPrivate(userId, name, level, Math.random, game);
          if (!r.ok) return send(res, 503, { error: r.reason });
          return send(res, 200, { code: r.code, match: publicView(r.match, userId) });
        }

        if (seg[2] === "private" && seg[3] === "join" && method === "POST") {
          /* Rate-limit on the account, not the socket. A classroom is one
             network, so limiting per IP would throttle the very case this
             feature exists for — everyone in one room joining at once. */
          const r = matchmaker.joinPrivate(body.code, userId, name, userId);
          if (!r.ok) {
            const status = r.reason === "no_such_lobby" ? 404
                         : r.reason === "too_many_attempts" ? 429 : 409;
            return send(res, status, { error: r.reason });
          }
          return send(res, 200, { match: publicView(r.match, userId), code: normaliseCode(body.code) });
        }

        if (seg[2] === "private" && seg[3] === "start" && method === "POST") {
          const match = matchmaker.byCode(body.code);
          if (!match) return send(res, 404, { error: "no_such_lobby" });
          // Only the player who opened the lobby may start it, or an early
          // arrival could start the race before their friends have joined.
          const host = [...match.entrants.keys()][0];
          if (host !== userId) return send(res, 403, { error: "not_host" });
          const r = matchmaker.startPrivate(body.code, now());
          if (!r.ok) return send(res, 409, { error: r.reason });
          return send(res, 200, { match: publicView(match, userId) });
        }

        // GET /v1/competition/match/:id — poll the race. Resolving on read is
        // what ends a match nobody finished: the clock has to be enforced by
        // someone, and it cannot be the client that ran out of time.
        if (seg[2] === "match" && seg[3] && !seg[4] && method === "GET") {
          const match = matchmaker.get(seg[3]);
          if (!match || !match.entrants.has(userId)) return send(res, 404, { error: "no_such_match" });
          resolve(match, now());
          return send(res, 200, { match: publicView(match, userId) });
        }

        // POST /v1/competition/match/:id/{note,answer} — the only scoring path.
        // Two spellings, one handler: the reading race posts a MIDI number, and
        // Chord Race posts a quality name.
        if (seg[2] === "match" && seg[3] && (seg[4] === "note" || seg[4] === "answer") && method === "POST") {
          const match = matchmaker.get(seg[3]);
          if (!match || !match.entrants.has(userId)) return send(res, 404, { error: "no_such_match" });

          let answer;
          if (match.game === "chords") {
            answer = String(body.answer ?? "");
            if (!match.passage.qualities.includes(answer)) {
              return send(res, 400, { error: "invalid_answer" });
            }
          } else if (match.game === "keys") {
            answer = String(body.answer ?? "");
            // Must be one of the fifteen real signatures. Checking against the
            // question's own options would leak which four were offered.
            if (!KEY_SIGNATURES.some((k) => k.id === answer)) {
              return send(res, 400, { error: "invalid_answer" });
            }
          } else {
            answer = Number(body.midi ?? body.answer);
            if (!Number.isInteger(answer) || answer < 0 || answer > 127) {
              return send(res, 400, { error: "invalid_midi" });
            }
          }

          const clientElapsedMs = body.clientElapsedMs === undefined ? null : Number(body.clientElapsedMs);
          const r = submitAnswer(match, userId, answer, { now: now(), clientElapsedMs });
          if (!r.ok) return send(res, 409, { error: r.reason, match: publicView(match, userId) });
          return send(res, 200, {
            correct: r.correct, eliminated: !!r.eliminated, finished: !!r.finished,
            pos: r.pos, match: publicView(match, userId),
          });
        }
      }

      return send(res, 404, { error: "not_found" });
    } catch (err) {
      // Never leak a stack to a client; never swallow it from the operator.
      console.error("[keyvoria] unhandled", err);
      return send(res, 500, { error: "internal_error" });
    }
  };
}

export { sweep };
