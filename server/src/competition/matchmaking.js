/**
 * M7a — matchmaking.
 *
 * Two ways into a match, one code path:
 *  - MATCHED: queue by level, fill to a target size, start.
 *  - PRIVATE: a join code. This is how "everyone in the same room" is served —
 *    a classroom or a group of friends skips the queue. No LAN or Bluetooth
 *    transport exists, and none is needed.
 *
 * The queue starts a match when it is full OR when the wait exceeds a floor and
 * there are at least MIN_PLAYERS. A race that starts with three players beats a
 * perfect eight-player race nobody waited for.
 */

import { createMatch, join, start, clampLobbySize, MAX_PLAYERS, MIN_PLAYERS, gameSpec } from "./match.js";

export const DEFAULT_TARGET = 8;
export const MAX_WAIT_MS = 12_000;

let seq = 0;
const nextId = () => `m_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/**
 * The join code, four characters, meant to be read aloud across a room.
 *
 * No vowels, so it cannot land on a word by accident, and no 0/O or 1/I, which
 * are the pairs people get wrong when reading a code out. That leaves 29
 * symbols and 29^4 = 707,281 codes.
 *
 * Not four DIGITS, which is what a short code usually means: 10,000 codes is
 * few enough that a script could walk the whole space in seconds and drop into
 * strangers' games. Four of these is 70x harder, reads aloud just as easily,
 * and joining is rate-limited on top (see createMatchmaker).
 */
export const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ23456789";
export const CODE_LENGTH = 4;

export function makeCode(rng = Math.random) {
  return Array.from({ length: CODE_LENGTH },
    () => CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)]).join("");
}

/** Codes are read aloud and typed back, so be forgiving about how they arrive. */
export function normaliseCode(input) {
  return String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
    .replace(/O/g, "0").replace(/I/g, "1")   /* said "oh"/"eye", meant zero/one */
    .replace(/0/g, "").replace(/1/g, "")     /* ...but neither is in the alphabet */
    .slice(0, CODE_LENGTH);
}

/** Wrong guesses allowed per caller before joining is refused for a while. */
export const JOIN_ATTEMPT_LIMIT = 10;
export const JOIN_ATTEMPT_WINDOW_MS = 60_000;

export function createMatchmaker({ now = () => Date.now() } = {}) {
  const queues = new Map();   // "game:level" -> [{userId, displayName, target, since}]
  const matches = new Map();  // id -> match
  const byCode = new Map();   // joinCode -> matchId
  const misses = new Map();   // who -> {n, until} — wrong codes, for rate limiting

  /* A four-character code is short enough to be worth guessing at, so wrong
     guesses are counted. A correct join does not count against anyone, so a
     room full of friends typing the same code is never throttled. */
  function tooManyMisses(who) {
    if (!who) return false;
    const rec = misses.get(who);
    if (!rec) return false;
    if (now() >= rec.until) { misses.delete(who); return false; }
    return rec.n >= JOIN_ATTEMPT_LIMIT;
  }
  function noteMiss(who) {
    if (!who) return;
    const rec = misses.get(who);
    if (!rec || now() >= rec.until) {
      misses.set(who, { n: 1, until: now() + JOIN_ATTEMPT_WINDOW_MS });
    } else {
      rec.n++;
    }
  }

  // Queues are per game AND per level. Sharing a queue across the two games
  // would put a reading player and a chord player in the same match, which is
  // not a difficulty mismatch — it is two different games.
  const qkey = (game, level) => `${game}:${level}`;

  function enqueue(userId, displayName, level, requestedSize = DEFAULT_TARGET, game = "reading") {
    gameSpec(game); // throws on an unknown game rather than opening a queue nobody can join
    const target = clampLobbySize(requestedSize);
    const k = qkey(game, level);
    const q = queues.get(k) ?? [];
    if (q.some((w) => w.userId === userId)) return { ok: false, reason: "already_queued" };
    q.push({ userId, displayName, target, since: now() });
    queues.set(k, q);
    return tryForm(level, game);
  }

  function leaveQueue(userId, level, game = "reading") {
    const q = queues.get(qkey(game, level));
    if (!q) return false;
    const i = q.findIndex((w) => w.userId === userId);
    if (i === -1) return false;
    q.splice(i, 1);
    return true;
  }

  /** Form a match if the queue is full enough, or has waited long enough. */
  function tryForm(level, game = "reading") {
    const q = queues.get(qkey(game, level)) ?? [];
    if (q.length === 0) return { ok: true, waiting: 0, match: null };

    const target = clampLobbySize(Math.min(...q.map((w) => w.target)));
    const waited = now() - q[0].since;
    const full = q.length >= target;
    const timedOut = q.length >= MIN_PLAYERS && waited >= MAX_WAIT_MS;
    if (!full && !timedOut) return { ok: true, waiting: q.length, match: null };

    const taking = q.splice(0, Math.min(target, MAX_PLAYERS));
    const match = createMatch({ id: nextId(), game, level, now: now() });
    for (const w of taking) join(match, w.userId, w.displayName);
    start(match, now());
    matches.set(match.id, match);
    return { ok: true, waiting: q.length, match };
  }

  function createPrivate(userId, displayName, level, rng = Math.random, game = "reading") {
    gameSpec(game);
    /* Retry on collision, but not forever: if the space is genuinely full the
       honest answer is to say so rather than spin. */
    let code = makeCode(rng), tries = 0;
    while (byCode.has(code)) {
      if (++tries > 200) return { ok: false, reason: "no_codes_available" };
      code = makeCode(rng);
    }
    const match = createMatch({ id: nextId(), game, level, lobbyKind: "private", joinCode: code, now: now() });
    join(match, userId, displayName);
    matches.set(match.id, match);
    byCode.set(code, match.id);
    return { ok: true, match, code };
  }

  function joinPrivate(code, userId, displayName, who = userId) {
    if (tooManyMisses(who)) return { ok: false, reason: "too_many_attempts" };
    const id = byCode.get(normaliseCode(code));
    if (!id) { noteMiss(who); return { ok: false, reason: "no_such_lobby" }; }
    const match = matches.get(id);
    if (!match) { noteMiss(who); return { ok: false, reason: "no_such_lobby" }; }
    /* A finished room is not a room. Without this, a code stays joinable after
       the game has ended and the joiner waits in a lobby that never starts. */
    if (match.state === "finished") { noteMiss(who); return { ok: false, reason: "lobby_closed" }; }
    const r = join(match, userId, displayName);
    return r.ok ? { ok: true, match } : r;
  }

  function startPrivate(code, now2 = now()) {
    const id = byCode.get(normaliseCode(code));
    const match = id && matches.get(id);
    if (!match) return { ok: false, reason: "no_such_lobby" };
    return start(match, now2);
  }

  return {
    enqueue, leaveQueue, tryForm, createPrivate, joinPrivate, startPrivate,
    get: (id) => matches.get(id) ?? null,
    byCode: (code) => matches.get(byCode.get(normaliseCode(code))) ?? null,
    /* Freeing the code once a room is done, so the short space does not fill
       up with rooms nobody is in any more. */
    releaseCode: (code) => byCode.delete(normaliseCode(code)),
    queueLength: (level, game = "reading") => (queues.get(qkey(game, level)) ?? []).length,
    all: () => [...matches.values()],
  };
}
