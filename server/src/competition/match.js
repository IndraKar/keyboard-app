/**
 * M7a — the authoritative match engine.
 *
 * Three decisions from roadmap M7a are enforced here rather than trusted to the
 * client:
 *
 *  1. EIGHT PLAYERS, HARD CAP — clamped, never rejected, so a stale client
 *     asking for more still gets a playable match.
 *  2. SERVER-AUTHORITATIVE ELIMINATION — the server holds the passage and rules
 *     on every note. A client patched to skip a wrong note is still out.
 *  3. LOCAL-CLOCK SCORING — ranking uses the elapsed time each player's own
 *     device measured, validated here. Ranking by server arrival would hand
 *     every race to whoever has the shortest ping, which is not a musical skill.
 */

import { generatePassage, levelSpec } from "./passage.js";

export const MAX_PLAYERS = 8; // roadmap M7a — supersedes an earlier "up to 16"
export const MIN_PLAYERS = 2;

export const MATCH_STATE = { LOBBY: "lobby", RUNNING: "running", FINISHED: "finished" };
export const END_REASON = {
  COMPLETED: "completed",
  ALL_ELIMINATED: "all_eliminated",
  TIMEOUT: "timeout",
};

/**
 * Tolerance on a client-reported time. A device clock can drift and a render can
 * lag, so we allow a little slack — but a time that is impossibly fast for the
 * note count, or longer than the round, is rejected and the player falls back to
 * server-observed order. Trusting the number outright would make the leaderboard
 * a self-report.
 */
export const MIN_MS_PER_NOTE = 90; // faster than a human can read and strike
const CLOCK_SLACK_MS = 1500;

/**
 * How long the match stays open after the FIRST completion reaches the server.
 *
 * Without this the local-clock rule is inert: the match would end on whichever
 * completion the server happened to process first, which is decided by network
 * latency — precisely what ranking by the player's own clock exists to prevent.
 * Holding the match open briefly lets other in-flight completions land, and
 * only then are all finishers ranked by their own measured time.
 *
 * It is short enough that nobody notices, and long enough to cover the spread
 * between a good connection and a poor one.
 */
export const SETTLE_MS = 750;

export function createMatch({ id, level, lobbyKind = "matched", joinCode = null, seed, now = Date.now() }) {
  const spec = levelSpec(level);
  return {
    id,
    level,
    lobby_kind: lobbyKind,
    join_code: joinCode,
    state: MATCH_STATE.LOBBY,
    passage: generatePassage(level, seed),
    seconds: spec.seconds,
    entrants: new Map(), // userId -> entrant
    created_at: now,
    started_at: null,
    ends_at: null,
    ended_at: null,
    settle_until: null,
    winner_user_id: null,
    end_reason: null,
  };
}

export function playerCount(match) {
  return match.entrants.size;
}

/** Join a lobby. Returns `{ok}` or a reason — full, started, already in. */
export function join(match, userId, displayName) {
  if (match.state !== MATCH_STATE.LOBBY) return { ok: false, reason: "already_started" };
  if (match.entrants.has(userId)) return { ok: false, reason: "already_joined" };
  if (match.entrants.size >= MAX_PLAYERS) return { ok: false, reason: "match_full" };
  match.entrants.set(userId, {
    user_id: userId,
    display_name: displayName,
    pos: 0,
    eliminated_at_note: null,
    finished_at: null,
    client_elapsed_ms: null,
    placement: null,
  });
  return { ok: true };
}

/**
 * Clamp a requested lobby size. Callers pass user input straight in, so this
 * must never throw — a stale client asking for 16 gets 8, not an error screen.
 */
export function clampLobbySize(requested) {
  const n = Number.isFinite(requested) ? Math.floor(requested) : MIN_PLAYERS;
  return Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n));
}

export function start(match, now = Date.now()) {
  if (match.state !== MATCH_STATE.LOBBY) return { ok: false, reason: "not_in_lobby" };
  if (match.entrants.size < MIN_PLAYERS) return { ok: false, reason: "not_enough_players" };
  match.state = MATCH_STATE.RUNNING;
  match.started_at = now;
  match.ends_at = now + match.seconds * 1000;
  return { ok: true, match };
}

const alive = (m) => [...m.entrants.values()].filter((e) => e.eliminated_at_note === null && !e.finished_at);

/**
 * Rule on one note press. This is the only place elimination happens.
 *
 * `clientElapsedMs` is what the player's device measured from passage render to
 * this press; it is recorded on completion and validated in `rank()`.
 */
export function submitNote(match, userId, midi, { now = Date.now(), clientElapsedMs = null } = {}) {
  if (match.state !== MATCH_STATE.RUNNING) return { ok: false, reason: "not_running" };
  const openUntil = Math.max(match.ends_at, match.settle_until ?? 0);
  if (now > openUntil) return { ok: false, reason: "time_expired" };

  const e = match.entrants.get(userId);
  if (!e) return { ok: false, reason: "not_in_match" };
  if (e.eliminated_at_note !== null) return { ok: false, reason: "eliminated" };
  if (e.finished_at) return { ok: false, reason: "already_finished" };

  const expected = match.passage.notes[e.pos];
  if (midi !== expected) {
    // One wrong note ends the run. The client is not asked whether it agrees.
    e.eliminated_at_note = e.pos;
    return { ok: true, correct: false, eliminated: true, pos: e.pos, resolved: resolve(match, now) };
  }

  e.pos += 1;
  if (e.pos >= match.passage.notes.length) {
    e.finished_at = now;
    e.client_elapsed_ms = clientElapsedMs;
    return { ok: true, correct: true, finished: true, pos: e.pos, resolved: resolve(match, now) };
  }
  return { ok: true, correct: true, finished: false, pos: e.pos, resolved: resolve(match, now) };
}

/**
 * Decide whether the match is over, and if so who won.
 *
 * A match ends when someone finishes, when everyone is out, or when the clock
 * expires. It always names an outcome — "no winner" is a result, not a hang.
 */
export function resolve(match, now = Date.now()) {
  if (match.state === MATCH_STATE.FINISHED) return match;

  const finishers = [...match.entrants.values()].filter((e) => e.finished_at);
  const stillAlive = alive(match);

  if (finishers.length > 0) {
    // Open the settle window on the first completion rather than ending here.
    if (match.settle_until === null) match.settle_until = now + SETTLE_MS;
    // End early only when nobody else could still finish.
    if (stillAlive.length === 0 || now >= match.settle_until) {
      return finish(match, END_REASON.COMPLETED, now);
    }
    return match;
  }
  if (stillAlive.length === 0) return finish(match, END_REASON.ALL_ELIMINATED, now);
  if (now >= match.ends_at) return finish(match, END_REASON.TIMEOUT, now);
  return match;
}

function finish(match, reason, now) {
  match.state = MATCH_STATE.FINISHED;
  match.ended_at = now;
  match.end_reason = reason;
  const ranked = rank(match);
  ranked.forEach((e, i) => {
    match.entrants.get(e.user_id).placement = i + 1;
  });
  const top = ranked[0];
  match.winner_user_id = top && top.finished_at ? top.user_id : null;
  return match;
}

/**
 * Ranking order:
 *   1. finishers, fastest first BY THEIR OWN DEVICE CLOCK
 *   2. survivors, by how far they got
 *   3. eliminated players, by how far they got before going out
 *
 * A finisher whose reported time fails validation is not disqualified — they
 * just fall back to server-observed finish order. Punishing a player for a
 * flaky clock would be worse than the ordering being slightly coarser.
 */
export function rank(match) {
  const noteCount = match.passage.notes.length;
  const entrants = [...match.entrants.values()];

  const scoreOf = (e) => {
    if (!e.finished_at) return null;
    const reported = e.client_elapsed_ms;
    const roundMs = match.seconds * 1000;
    const serverMs = e.finished_at - match.started_at;
    const plausible =
      Number.isFinite(reported) &&
      reported >= noteCount * MIN_MS_PER_NOTE &&
      reported <= roundMs + CLOCK_SLACK_MS;
    return plausible ? reported : serverMs;
  };

  return entrants.sort((a, b) => {
    const af = !!a.finished_at, bf = !!b.finished_at;
    if (af !== bf) return af ? -1 : 1;
    if (af && bf) return scoreOf(a) - scoreOf(b);

    const aOut = a.eliminated_at_note !== null, bOut = b.eliminated_at_note !== null;
    if (aOut !== bOut) return aOut ? 1 : -1;
    return b.pos - a.pos;
  });
}

/** Whether a reported client time would be accepted. Exposed for testing/telemetry. */
export function isPlausibleClientTime(match, elapsedMs) {
  const noteCount = match.passage.notes.length;
  return (
    Number.isFinite(elapsedMs) &&
    elapsedMs >= noteCount * MIN_MS_PER_NOTE &&
    elapsedMs <= match.seconds * 1000 + CLOCK_SLACK_MS
  );
}

/**
 * What a client may see mid-match. Note the passage's expected notes are NOT
 * included beyond what the client already renders — but crucially, other
 * players' progress is, because watching the race is the point.
 */
export function publicView(match, forUserId = null) {
  return {
    id: match.id,
    level: match.level,
    state: match.state,
    endsAt: match.ends_at,
    passage: { clef: match.passage.clef, key: match.passage.key, dias: match.passage.dias, bars: match.passage.bars },
    noteCount: match.passage.notes.length,
    winnerUserId: match.winner_user_id,
    endReason: match.end_reason,
    players: rank(match).map((e) => ({
      userId: e.user_id,
      name: e.display_name,
      pos: e.pos,
      out: e.eliminated_at_note !== null,
      done: !!e.finished_at,
      placement: e.placement,
      you: e.user_id === forUserId,
    })),
  };
}
