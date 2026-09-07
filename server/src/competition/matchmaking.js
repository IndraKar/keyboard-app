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

export function makeCode(rng = Math.random) {
  // No vowels: avoids accidentally generating words, and no 0/O or 1/I mixups.
  const alphabet = "BCDFGHJKLMNPQRSTVWXYZ23456789";
  return Array.from({ length: 5 }, () => alphabet[Math.floor(rng() * alphabet.length)]).join("");
}

export function createMatchmaker({ now = () => Date.now() } = {}) {
  const queues = new Map();   // "game:level" -> [{userId, displayName, target, since}]
  const matches = new Map();  // id -> match
  const byCode = new Map();   // joinCode -> matchId

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
    let code = makeCode(rng);
    while (byCode.has(code)) code = makeCode(rng);
    const match = createMatch({ id: nextId(), game, level, lobbyKind: "private", joinCode: code, now: now() });
    join(match, userId, displayName);
    matches.set(match.id, match);
    byCode.set(code, match.id);
    return { ok: true, match, code };
  }

  function joinPrivate(code, userId, displayName) {
    const id = byCode.get(String(code || "").toUpperCase());
    if (!id) return { ok: false, reason: "no_such_lobby" };
    const match = matches.get(id);
    if (!match) return { ok: false, reason: "no_such_lobby" };
    const r = join(match, userId, displayName);
    return r.ok ? { ok: true, match } : r;
  }

  function startPrivate(code, now2 = now()) {
    const id = byCode.get(String(code || "").toUpperCase());
    const match = id && matches.get(id);
    if (!match) return { ok: false, reason: "no_such_lobby" };
    return start(match, now2);
  }

  return {
    enqueue, leaveQueue, tryForm, createPrivate, joinPrivate, startPrivate,
    get: (id) => matches.get(id) ?? null,
    byCode: (code) => matches.get(byCode.get(String(code || "").toUpperCase())) ?? null,
    queueLength: (level, game = "reading") => (queues.get(qkey(game, level)) ?? []).length,
    all: () => [...matches.values()],
  };
}
