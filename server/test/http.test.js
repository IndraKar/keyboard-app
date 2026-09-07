import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createApp } from "../src/http/app.js";
import { createMemoryStore } from "../src/store/memory.js";
import { createMatchmaker } from "../src/competition/matchmaking.js";
import { issueToken } from "../src/http/tokens.js";
import { buildSignature } from "../src/http/signature.js";
import { diatonicToMidi, keyAlterations } from "../src/competition/passage.js";
import { STATUS } from "../src/billing/subscription.js";

const SECRET = "test-session-secret";
const HOOK_SECRET = "whsec_test";

/** Spin up a real server on an ephemeral port so the tests exercise the socket. */
async function withServer(config, fn) {
  const store = createMemoryStore();
  const matchmaker = createMatchmaker();
  const app = createApp({ store, matchmaker, config: { sessionSecret: SECRET, ...config } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  try {
    await fn({ call, store, matchmaker, base });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const dev = (id) => `dev:${id}`;

// ------------------------------------------------------------------- basics

test("health and the level table are public", async () => {
  await withServer({}, async ({ call }) => {
    assert.equal((await call("GET", "/health")).status, 200);
    const levels = await call("GET", "/v1/competition/levels");
    assert.equal(levels.status, 200);
    assert.equal(levels.body.levels.length, 5);
    assert.equal(levels.body.levels[4].seconds, 90);
    assert.equal(levels.body.maxPlayers, 8, "roadmap M7a caps a lobby at 8");
  });
});

test("an unauthenticated request is refused, not served as an anonymous user", async () => {
  await withServer({}, async ({ call }) => {
    assert.equal((await call("GET", "/v1/subscription")).status, 401);
  });
});

test("a signed token authenticates; a tampered one does not", async () => {
  await withServer({}, async ({ call }) => {
    const token = issueToken("u1", SECRET);
    assert.equal((await call("GET", "/v1/subscription", { token })).status, 200);

    const [payload, mac] = token.split(".");
    const forged = `${payload}.${mac.slice(0, -1)}${mac.at(-1) === "A" ? "B" : "A"}`;
    assert.equal((await call("GET", "/v1/subscription", { token: forged })).status, 401);

    const expired = issueToken("u1", SECRET, { ttlMs: -1 });
    assert.equal((await call("GET", "/v1/subscription", { token: expired })).status, 401);
  });
});

test("dev auth is off unless asked for, and the dev grant is unreachable without it", async () => {
  await withServer({}, async ({ call }) => {
    assert.equal((await call("GET", "/v1/subscription", { token: dev("u1") })).status, 401);
    const r = await call("POST", "/v1/dev/subscribe", { token: issueToken("u1", SECRET), body: {} });
    assert.equal(r.status, 404, "a production build must not be able to mint itself a paid plan");
  });
});

// ------------------------------------------------------------ subscriptions

test("subscribe, cancel, keep access, resume — over HTTP", async () => {
  await withServer({ devAuth: true }, async ({ call }) => {
    const token = dev("u1");

    assert.equal((await call("GET", "/v1/subscription", { token })).body.plan, "free");

    const paid = await call("POST", "/v1/dev/subscribe", { token, body: {} });
    assert.equal(paid.body.plan, "paid");
    assert.equal(paid.body.priceCents, 595);

    const cancelled = await call("POST", "/v1/subscription/cancel", { token, body: {} });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, STATUS.CANCEL_PENDING);
    assert.equal(cancelled.body.entitled, true, "cancelling must not revoke time already paid for");
    assert.ok(cancelled.body.accessUntil > Date.now());

    const resumed = await call("POST", "/v1/subscription/resume", { token, body: {} });
    assert.equal(resumed.body.status, STATUS.ACTIVE);
    assert.equal((await call("POST", "/v1/subscription/resume", { token, body: {} })).status, 409);
  });
});

test("cancelling a store-managed subscription returns 409 and the store's URL", async () => {
  await withServer({ devAuth: true }, async ({ call, store }) => {
    const { newSubscription } = await import("../src/billing/subscription.js");
    await store.putSubscription(newSubscription({
      userId: "u2", provider: "apple_app_store", providerSubscriptionId: "a1",
    }));
    const r = await call("POST", "/v1/subscription/cancel", { token: dev("u2"), body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "provider_managed");
    assert.match(r.body.manageUrl, /apple\.com/);
    assert.equal(r.body.subscription.entitled, true, "the subscription is untouched");
  });
});

test("cancelling with no subscription is 404, not a silent 200", async () => {
  await withServer({ devAuth: true }, async ({ call }) => {
    assert.equal((await call("POST", "/v1/subscription/cancel", { token: dev("nobody"), body: {} })).status, 404);
  });
});

// ---------------------------------------------------------------- webhooks

test("an unsigned webhook is REFUSED when no secret is configured", async () => {
  await withServer({}, async ({ call }) => {
    const r = await call("POST", "/v1/webhooks/stripe", {
      body: { id: "e1", type: "invoice.payment_succeeded", providerSubscriptionId: "sub_1" },
    });
    assert.equal(r.status, 503, "falling open here would let anyone grant themselves a subscription");
    assert.equal(r.body.error, "webhook_secret_not_configured");
  });
});

test("a correctly signed webhook is applied once; a replay is a no-op; a forged one is rejected", async () => {
  await withServer({ webhookSecrets: { stripe: HOOK_SECRET } }, async ({ call, store }) => {
    const { newSubscription } = await import("../src/billing/subscription.js");
    const sub = newSubscription({ userId: "u3", provider: "stripe", providerSubscriptionId: "sub_9" });
    await store.putSubscription(sub);

    const payload = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", providerSubscriptionId: "sub_9", cancel_at_period_end: true });
    const headers = { "x-keyvoria-signature": buildSignature(payload, HOOK_SECRET) };

    const first = await call("POST", "/v1/webhooks/stripe", { body: payload, headers });
    assert.equal(first.status, 200);
    assert.equal(first.body.applied, true);
    assert.equal((await store.getSubscription("u3")).status, STATUS.CANCEL_PENDING);

    const replay = await call("POST", "/v1/webhooks/stripe", { body: payload, headers });
    assert.equal(replay.body.duplicate, true);
    assert.equal(replay.body.applied, false);

    const forged = await call("POST", "/v1/webhooks/stripe", {
      body: payload, headers: { "x-keyvoria-signature": buildSignature(payload, "wrong-secret") },
    });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.error, "bad_signature");
  });
});

test("a stale signature is rejected even though the digest is right", async () => {
  await withServer({ webhookSecrets: { stripe: HOOK_SECRET } }, async ({ call }) => {
    const payload = JSON.stringify({ id: "evt_old", type: "invoice.payment_succeeded", providerSubscriptionId: "x" });
    const r = await call("POST", "/v1/webhooks/stripe", {
      body: payload,
      headers: { "x-keyvoria-signature": buildSignature(payload, HOOK_SECRET, Date.now() - 60 * 60_000) },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "signature_too_old");
  });
});

test("an unknown provider path is a 404, and unmapped events are acknowledged", async () => {
  await withServer({ webhookSecrets: { stripe: HOOK_SECRET } }, async ({ call, store }) => {
    assert.equal((await call("POST", "/v1/webhooks/paypal", { body: {} })).status, 404);

    const { newSubscription } = await import("../src/billing/subscription.js");
    await store.putSubscription(newSubscription({ userId: "u4", provider: "stripe", providerSubscriptionId: "s4" }));
    const payload = JSON.stringify({ id: "evt_odd", type: "customer.subscription.trial_will_end", providerSubscriptionId: "s4" });
    const r = await call("POST", "/v1/webhooks/stripe", {
      body: payload, headers: { "x-keyvoria-signature": buildSignature(payload, HOOK_SECRET) },
    });
    assert.equal(r.status, 200, "a 4xx here would make the provider retry forever");
    assert.equal(r.body.ignored, true);
  });
});

// ------------------------------------------------------------- competition

/** Work out what the client would have to play, the way the client would. */
function expectedNotes(view) {
  const alter = keyAlterations(view.passage.key);
  return view.passage.dias.map((d) => diatonicToMidi(d, alter));
}

test("Competition is behind the paywall, in the server, not the UI", async () => {
  await withServer({ devAuth: true }, async ({ call }) => {
    const r = await call("POST", "/v1/competition/queue", { token: dev("free1"), body: { level: 1 } });
    assert.equal(r.status, 402);
    assert.equal(r.body.error, "subscription_required");
    assert.match(r.body.message, /\$5\.95/);
  });
});

test("two subscribers queue, race, and the server rules on every note", async () => {
  await withServer({ devAuth: true }, async ({ call }) => {
    const a = dev("alice"), b = dev("bob");
    for (const t of [a, b]) await call("POST", "/v1/dev/subscribe", { token: t, body: {} });

    const q1 = await call("POST", "/v1/competition/queue", { token: a, body: { level: 1, players: 2, displayName: "Alice" } });
    assert.equal(q1.body.match, null, "one player is not a race");

    const q2 = await call("POST", "/v1/competition/queue", { token: b, body: { level: 1, players: 2, displayName: "Bob" } });
    assert.ok(q2.body.match, "the second player fills the lobby and the match starts");
    const view = q2.body.match;
    assert.equal(view.state, "running");
    assert.equal(view.noteCount, 4);

    // Alice, still polling, must be told where her match went.
    const poll = await call("GET", "/v1/competition/queue/1", { token: a });
    assert.equal(poll.body.match.id, view.id);

    const notes = expectedNotes(view);
    const id = view.id;

    // Bob plays a wrong note first: one mistake and he is out.
    const wrong = await call("POST", `/v1/competition/match/${id}/note`, {
      token: b, body: { midi: notes[0] === 60 ? 61 : 60 },
    });
    assert.equal(wrong.body.correct, false);
    assert.equal(wrong.body.eliminated, true);

    // Alice plays it clean.
    let last;
    for (let i = 0; i < notes.length; i++) {
      last = await call("POST", `/v1/competition/match/${id}/note`, {
        token: a, body: { midi: notes[i], clientElapsedMs: 400 * (i + 1) },
      });
      assert.equal(last.status, 200);
      assert.equal(last.body.correct, true, `note ${i} should be accepted`);
    }
    assert.equal(last.body.finished, true);
    assert.equal(last.body.match.state, "finished", "with everyone else out, the match ends immediately");
    assert.equal(last.body.match.winnerUserId, "alice");

    const alicePlacing = last.body.match.players.find((p) => p.userId === "alice");
    assert.equal(alicePlacing.placement, 1);
    assert.equal(alicePlacing.you, true);

    // A note after the match is over changes nothing.
    const late = await call("POST", `/v1/competition/match/${id}/note`, { token: a, body: { midi: notes[0] } });
    assert.equal(late.status, 409);
  });
});

test("a match you are not in is not readable, and rubbish input is rejected", async () => {
  await withServer({ devAuth: true }, async ({ call }) => {
    const a = dev("alice"), b = dev("bob"), c = dev("carol");
    for (const t of [a, b, c]) await call("POST", "/v1/dev/subscribe", { token: t, body: {} });
    await call("POST", "/v1/competition/queue", { token: a, body: { level: 1, players: 2 } });
    const q = await call("POST", "/v1/competition/queue", { token: b, body: { level: 1, players: 2 } });
    const id = q.body.match.id;

    assert.equal((await call("GET", `/v1/competition/match/${id}`, { token: c })).status, 404);
    assert.equal((await call("GET", "/v1/competition/match/nope", { token: a })).status, 404);
    assert.equal((await call("POST", `/v1/competition/match/${id}/note`, { token: a, body: { midi: 999 } })).status, 400);
    assert.equal((await call("POST", "/v1/competition/queue", { token: c, body: { level: 9 } })).status, 400);
    assert.equal((await call("POST", "/v1/competition/queue", { token: c, body: "{oops" })).status, 400);
  });
});

test("a private lobby is joined by code and started only by its host", async () => {
  await withServer({ devAuth: true }, async ({ call }) => {
    const host = dev("host"), guest = dev("guest");
    for (const t of [host, guest]) await call("POST", "/v1/dev/subscribe", { token: t, body: {} });

    const made = await call("POST", "/v1/competition/private", { token: host, body: { level: 3, displayName: "Host" } });
    assert.equal(made.status, 200);
    assert.match(made.body.code, /^[BCDFGHJKLMNPQRSTVWXYZ2-9]{5}$/);
    const code = made.body.code;

    assert.equal((await call("POST", "/v1/competition/private/join", { token: guest, body: { code: "ZZZZZ" } })).status, 404);

    const joined = await call("POST", "/v1/competition/private/join", { token: guest, body: { code: code.toLowerCase() } });
    assert.equal(joined.status, 200, "codes are read back to a friend out loud — case must not matter");
    assert.equal(joined.body.match.players.length, 2);

    assert.equal((await call("POST", "/v1/competition/private/start", { token: guest, body: { code } })).status, 403);

    const started = await call("POST", "/v1/competition/private/start", { token: host, body: { code } });
    assert.equal(started.status, 200);
    assert.equal(started.body.match.state, "running");
    assert.equal(started.body.match.level, 3);
  });
});

test("leaving the queue actually removes you", async () => {
  await withServer({ devAuth: true }, async ({ call }) => {
    const a = dev("solo");
    await call("POST", "/v1/dev/subscribe", { token: a, body: {} });
    await call("POST", "/v1/competition/queue", { token: a, body: { level: 2, players: 4 } });
    assert.equal((await call("GET", "/v1/competition/queue/2", { token: a })).body.waiting, 1);
    assert.equal((await call("DELETE", "/v1/competition/queue", { token: a, body: { level: 2 } })).body.left, true);
    assert.equal((await call("GET", "/v1/competition/queue/2", { token: a })).body.waiting, 0);
  });
});

test("an oversized body is refused before it is parsed", async () => {
  await withServer({ devAuth: true }, async ({ call }) => {
    const r = await call("POST", "/v1/dev/subscribe", { token: dev("u1"), body: "x".repeat(70 * 1024) });
    assert.equal(r.status, 413);
  });
});

// ------------------------------------------------------ Chord Race over HTTP

test("the levels endpoint advertises all three games and how each is won", async () => {
  await withServer({}, async ({ call }) => {
    const r = await call("GET", "/v1/competition/levels");
    assert.equal(r.body.games.length, 3);
    const [reading, chords, keys] = r.body.games;
    assert.equal(keys.id, "keys");
    assert.equal(keys.levels.length, 3);
    assert.equal(keys.levels[0].questions, 10, "ten questions, as specified");
    assert.match(keys.wonBy, /sudden death/);
    assert.equal(keys.suddenDeathMs, 30_000);
    assert.equal(r.body.keySignatures.length, 15, "all fifteen signatures ship to the client");
    assert.deepEqual(r.body.keyTiers["1"], ["C", "G", "D"]);
    assert.deepEqual(r.body.keyTiers["2"], ["A", "B", "F", "E"]);
    assert.equal(r.body.keyTiers["3"].length, 8);
    assert.equal(r.body.keyTiers["4"].length, 15);
    assert.equal(reading.id, "reading");
    assert.equal(reading.levels.length, 5);
    assert.equal(chords.id, "chords");
    assert.equal(chords.levels.length, 3);
    assert.equal(chords.wonBy, "last player standing");
    assert.deepEqual(chords.levels[0].qualities, ["major", "minor"]);
    assert.deepEqual(chords.levels[2].qualities,
      ["major", "minor", "major7", "minor7", "augmented", "diminished"]);
    assert.equal(r.body.chordLabels.major7, "Major 7th");
  });
});

test("Chord Race is gated by the same subscription check", async () => {
  await withServer({ devAuth: true }, async ({ call }) => {
    const r = await call("POST", "/v1/competition/queue", { token: dev("free2"), body: { game: "chords", level: 1 } });
    assert.equal(r.status, 402);
  });
});

test("a chord match: one wrong quality is out, and the survivor wins by outlasting", async () => {
  await withServer({ devAuth: true }, async ({ call, matchmaker }) => {
    const a = dev("ann"), b = dev("ben");
    for (const t of [a, b]) await call("POST", "/v1/dev/subscribe", { token: t, body: {} });

    await call("POST", "/v1/competition/queue", { token: a, body: { game: "chords", level: 1, players: 2, displayName: "Ann" } });
    const q = await call("POST", "/v1/competition/queue", { token: b, body: { game: "chords", level: 1, players: 2, displayName: "Ben" } });
    const view = q.body.match;
    assert.equal(view.game, "chords");
    assert.equal(view.answerCount, 8);
    assert.deepEqual(view.round.qualities, ["major", "minor"]);
    assert.ok(view.current.notes.length >= 3, "the client is given the pitches it has to sound");
    assert.equal(view.current.index, 0);

    const id = view.id;
    // Read the real answer the way only the server can, to drive the test.
    const truth = matchmaker.get(id).passage.answers;

    const right = await call("POST", `/v1/competition/match/${id}/answer`, {
      token: a, body: { answer: truth[0], clientElapsedMs: 1200 },
    });
    assert.equal(right.body.correct, true);
    assert.equal(right.body.match.current.index, 1, "the next chord is revealed only now");

    const wrong = await call("POST", `/v1/competition/match/${id}/answer`, {
      token: b, body: { answer: truth[0] === "major" ? "minor" : "major" },
    });
    assert.equal(wrong.body.correct, false);
    assert.equal(wrong.body.eliminated, true);
    assert.equal(wrong.body.match.state, "finished");
    assert.equal(wrong.body.match.endReason, "last_standing");
    assert.equal(wrong.body.match.winnerUserId, "ann",
      "Ann wins on chord 2 of 8 — last player standing, exactly as specified");
  });
});

test("a chord answer outside the level's own pool is refused", async () => {
  await withServer({ devAuth: true }, async ({ call }) => {
    const a = dev("ann"), b = dev("ben");
    for (const t of [a, b]) await call("POST", "/v1/dev/subscribe", { token: t, body: {} });
    await call("POST", "/v1/competition/queue", { token: a, body: { game: "chords", level: 1, players: 2 } });
    const q = await call("POST", "/v1/competition/queue", { token: b, body: { game: "chords", level: 1, players: 2 } });
    const id = q.body.match.id;

    // Diminished is a level 3 quality; it is not on level 1's answer buttons.
    assert.equal((await call("POST", `/v1/competition/match/${id}/answer`, { token: a, body: { answer: "diminished" } })).status, 400);
    assert.equal((await call("POST", `/v1/competition/match/${id}/answer`, { token: a, body: { answer: 60 } })).status, 400);
    assert.equal((await call("POST", "/v1/competition/queue", { token: a, body: { game: "chords", level: 4 } })).status, 400);
    assert.equal((await call("POST", "/v1/competition/queue", { token: a, body: { game: "solitaire", level: 1 } })).status, 400);
  });
});

test("the two games queue separately over HTTP", async () => {
  await withServer({ devAuth: true }, async ({ call }) => {
    const a = dev("ann"), b = dev("ben");
    for (const t of [a, b]) await call("POST", "/v1/dev/subscribe", { token: t, body: {} });
    await call("POST", "/v1/competition/queue", { token: a, body: { game: "reading", level: 1, players: 2 } });
    const q = await call("POST", "/v1/competition/queue", { token: b, body: { game: "chords", level: 1, players: 2 } });
    assert.equal(q.body.match, null, "different games must not be matched together");
    assert.equal((await call("GET", "/v1/competition/queue/1?game=chords", { token: b })).body.waiting, 1);
    assert.equal((await call("GET", "/v1/competition/queue/1", { token: a })).body.waiting, 1);
  });
});

test("a private chord lobby is created, joined and started as one", async () => {
  await withServer({ devAuth: true }, async ({ call }) => {
    const host = dev("h2"), guest = dev("g2");
    for (const t of [host, guest]) await call("POST", "/v1/dev/subscribe", { token: t, body: {} });
    const made = await call("POST", "/v1/competition/private", { token: host, body: { game: "chords", level: 3 } });
    assert.equal(made.body.match.game, "chords");
    assert.equal(made.body.match.round.qualities.length, 6);
    await call("POST", "/v1/competition/private/join", { token: guest, body: { code: made.body.code } });
    const started = await call("POST", "/v1/competition/private/start", { token: host, body: { code: made.body.code } });
    assert.equal(started.body.match.state, "running");
    assert.equal(started.body.match.answerCount, 12);
  });
});

// ----------------------------------------------- Key Signature Race over HTTP

test("a key race over HTTP: ten questions, one wrong is out, survivor wins", async () => {
  await withServer({ devAuth: true }, async ({ call, matchmaker }) => {
    const a = dev("kay"), b = dev("lee");
    for (const t of [a, b]) await call("POST", "/v1/dev/subscribe", { token: t, body: {} });

    await call("POST", "/v1/competition/queue", { token: a, body: { game: "keys", level: 1, players: 2, displayName: "Kay" } });
    const q = await call("POST", "/v1/competition/queue", { token: b, body: { game: "keys", level: 1, players: 2, displayName: "Lee" } });
    const view = q.body.match;
    assert.equal(view.game, "keys");
    assert.equal(view.answerCount, 10);
    assert.equal(view.round.suddenDeathMs, 30_000);
    assert.equal(view.current.kind, "signature");
    // Three options at level 1, because its pool IS three signatures. A fourth
    // would have to be drawn from a tier the player has not been taught yet.
    assert.equal(view.current.options.length, 3);
    assert.equal(view.current.answer, undefined, "the answer must never reach a client");

    const id = view.id;
    const truth = matchmaker.get(id).passage.answers;

    const right = await call("POST", `/v1/competition/match/${id}/answer`, { token: a, body: { answer: truth[0], clientElapsedMs: 900 } });
    assert.equal(right.body.correct, true);
    assert.equal(right.body.match.current.index, 1);

    const wrong = await call("POST", `/v1/competition/match/${id}/answer`, { token: b, body: { answer: truth[0] === "C" ? "G" : "C" } });
    assert.equal(wrong.body.eliminated, true);
    assert.equal(wrong.body.match.state, "finished");
    assert.equal(wrong.body.match.endReason, "last_standing");
    assert.equal(wrong.body.match.winnerUserId, "kay");
  });
});

test("two survivors reach sudden death over HTTP, and the tiebreak is scored there", async () => {
  await withServer({ devAuth: true }, async ({ call, matchmaker }) => {
    const a = dev("kay"), b = dev("lee");
    for (const t of [a, b]) await call("POST", "/v1/dev/subscribe", { token: t, body: {} });
    await call("POST", "/v1/competition/queue", { token: a, body: { game: "keys", level: 1, players: 2 } });
    const q = await call("POST", "/v1/competition/queue", { token: b, body: { game: "keys", level: 1, players: 2 } });
    const id = q.body.match.id;
    const truth = matchmaker.get(id).passage.answers;

    // Both answer all ten correctly.
    let last;
    for (const t of [a, b]) {
      for (let i = 0; i < 10; i++) {
        last = await call("POST", `/v1/competition/match/${id}/answer`, { token: t, body: { answer: truth[i], clientElapsedMs: 500 * (i + 1) } });
      }
    }
    const view = last.body.match;
    assert.equal(view.state, "running", "ten questions with nobody out cannot be the end");
    assert.equal(view.phase, "sudden_death");
    assert.deepEqual(view.suddenDeath.contenders.sort(), ["kay", "lee"]);
    assert.equal(view.current.kind, "scale", "the tiebreak asks what key the scale is in");
    assert.equal(view.current.notes.length, 8);
    assert.equal(view.current.midi.length, 8);
    assert.equal(view.current.answer, undefined);

    const sd = matchmaker.get(id).sudden_death;
    const r = await call("POST", `/v1/competition/match/${id}/answer`, { token: a, body: { answer: sd.answers[0], clientElapsedMs: 1200 } });
    assert.equal(r.body.correct, true);
    assert.equal(r.body.eliminated, false, "the tiebreak eliminates nobody");
    assert.equal(r.body.match.players.find((p) => p.userId === "kay").sdCorrect, 1);
  });
});

test("an answer that is not one of the fifteen signatures is refused", async () => {
  await withServer({ devAuth: true }, async ({ call }) => {
    const a = dev("kay"), b = dev("lee");
    for (const t of [a, b]) await call("POST", "/v1/dev/subscribe", { token: t, body: {} });
    await call("POST", "/v1/competition/queue", { token: a, body: { game: "keys", level: 1, players: 2 } });
    const q = await call("POST", "/v1/competition/queue", { token: b, body: { game: "keys", level: 1, players: 2 } });
    const id = q.body.match.id;
    assert.equal((await call("POST", `/v1/competition/match/${id}/answer`, { token: a, body: { answer: "H" } })).status, 400);
    assert.equal((await call("POST", "/v1/competition/queue", { token: a, body: { game: "keys", level: 4 } })).status, 400);
  });
});
