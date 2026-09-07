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
import { GAMES, MAX_PLAYERS, MIN_PLAYERS, publicView, resolve, submitAnswer, MATCH_STATE } from "../competition/match.js";
import { verifyToken, issueToken } from "./tokens.js";
import { verifySignature } from "./signature.js";

const MAX_BODY_BYTES = 64 * 1024; // no route here needs more; caps a trivial DoS
const PROVIDERS = new Set(["stripe", "apple_app_store", "google_play"]);

/** Ladders per game, so one lookup answers "is this a real level?" for both. */
const LADDERS = { reading: LEVELS, chords: CHORD_LEVELS };
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
  config = {},
  now = () => Date.now(),
} = {}) {
  const {
    devAuth = false,
    sessionSecret = null,
    webhookSecrets = {},
    allowUnsignedWebhooks = false,
    allowedOrigin = "*",
  } = config;

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
    res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    if (method === "OPTIONS") { res.writeHead(204); return res.end(); }

    let raw = "";
    if (method === "POST" || method === "DELETE") {
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
          ],
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

        const sig = verifySignature(raw, req.headers["x-keyvoria-signature"], webhookSecrets[provider], {
          now: now(),
          allowUnsigned: allowUnsignedWebhooks,
        });
        if (!sig.ok) return send(res, sig.status, { error: sig.reason });

        const body = parseJson(raw);
        if (!body) return send(res, 400, { error: "invalid_json" });

        let result;
        try {
          result = await handleWebhook(store, provider, body, now());
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

      // --------------------------------------------------------------- auth
      const auth = authenticate(req);
      if (!auth.ok) return send(res, 401, { error: "unauthorized", reason: auth.reason });
      const userId = auth.userId;

      // ------------------------------------------------------ subscriptions
      if (url.pathname === "/v1/subscription" && method === "GET") {
        const sub = await store.getSubscription(userId);
        return send(res, 200, describeSub(sub, now()));
      }

      if (url.pathname === "/v1/subscription/cancel" && method === "POST") {
        const sub = await store.getSubscription(userId);
        if (!sub) return send(res, 404, { error: "no_subscription" });
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
          return send(res, 200, { code: r.code, match: publicView(r.match, userId) });
        }

        if (seg[2] === "private" && seg[3] === "join" && method === "POST") {
          const r = matchmaker.joinPrivate(body.code, userId, name);
          if (!r.ok) return send(res, r.reason === "no_such_lobby" ? 404 : 409, { error: r.reason });
          return send(res, 200, { match: publicView(r.match, userId) });
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
