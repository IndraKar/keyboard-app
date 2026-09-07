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
import { generateChordRound, chordLevelSpec } from "./chords.js";

/**
 * The two Competition games. Both produce a round with an `answers` array and
 * a clock; everything below this table is game-agnostic, which is what let the
 * second game reuse the elimination, ranking and settle logic rather than fork
 * it.
 *
 * They differ in exactly two ways, both declared here:
 *  - `lastStanding`: Chord Race is won by being the last one left. The reading
 *    race is won by finishing the passage first, so a lone survivor there still
 *    has to play it out.
 *  - `minMsPerAnswer`: a floor on plausible elapsed time. Striking a key you can
 *    already see is fast; hearing a chord and naming it is not.
 */
export const GAMES = {
  reading: {
    id: "reading",
    label: "Reading Race",
    generate: (level, seed) => generatePassage(level, seed),
    spec: (level) => levelSpec(level),
    lastStanding: false,
    minMsPerAnswer: 90, // faster than a human can read and strike
  },
  chords: {
    id: "chords",
    label: "Chord Race",
    generate: (level, seed) => generateChordRound(level, seed),
    spec: (level) => chordLevelSpec(level),
    lastStanding: true,
    minMsPerAnswer: 500, // a chord has to be heard before it can be named
  },
};

export function gameSpec(game) {
  const g = GAMES[game];
  if (!g) throw new Error(`no such game: ${game}`);
  return g;
}

export const MAX_PLAYERS = 8; // roadmap M7a — supersedes an earlier "up to 16"
export const MIN_PLAYERS = 2;

export const MATCH_STATE = { LOBBY: "lobby", RUNNING: "running", FINISHED: "finished" };
export const END_REASON = {
  COMPLETED: "completed",
  ALL_ELIMINATED: "all_eliminated",
  TIMEOUT: "timeout",
  LAST_STANDING: "last_standing", // Chord Race: everyone else went out
};

/**
 * Tolerance on a client-reported time. A device clock can drift and a render can
 * lag, so we allow a little slack — but a time that is impossibly fast for the
 * note count, or longer than the round, is rejected and the player falls back to
 * server-observed order. Trusting the number outright would make the leaderboard
 * a self-report.
 */
export const MIN_MS_PER_NOTE = 90; // reading race; see GAMES for the per-game floor
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

export function createMatch({ id, game = "reading", level, lobbyKind = "matched", joinCode = null, seed, now = Date.now() }) {
  const g = gameSpec(game);
  const round = g.generate(level, seed);
  return {
    id,
    game,
    level,
    lobby_kind: lobbyKind,
    join_code: joinCode,
    state: MATCH_STATE.LOBBY,
    passage: round,
    seconds: round.seconds,
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
 * Rule on one answer — a key press in the reading race, a named chord quality
 * in Chord Race. This is the only place elimination happens.
 *
 * `clientElapsedMs` is what the player's device measured from the round
 * appearing on their screen to this answer; it is recorded on completion and
 * validated in `rank()`.
 */
export function submitAnswer(match, userId, answer, { now = Date.now(), clientElapsedMs = null } = {}) {
  if (match.state !== MATCH_STATE.RUNNING) return { ok: false, reason: "not_running" };
  const openUntil = Math.max(match.ends_at, match.settle_until ?? 0);
  if (now > openUntil) return { ok: false, reason: "time_expired" };

  const e = match.entrants.get(userId);
  if (!e) return { ok: false, reason: "not_in_match" };
  if (e.eliminated_at_note !== null) return { ok: false, reason: "eliminated" };
  if (e.finished_at) return { ok: false, reason: "already_finished" };

  const expected = match.passage.answers[e.pos];
  if (answer !== expected) {
    // One wrong note ends the run. The client is not asked whether it agrees.
    e.eliminated_at_note = e.pos;
    return { ok: true, correct: false, eliminated: true, pos: e.pos, resolved: resolve(match, now) };
  }

  e.pos += 1;
  if (e.pos >= match.passage.answers.length) {
    e.finished_at = now;
    e.client_elapsed_ms = clientElapsedMs;
    return { ok: true, correct: true, finished: true, pos: e.pos, resolved: resolve(match, now) };
  }
  return { ok: true, correct: true, finished: false, pos: e.pos, resolved: resolve(match, now) };
}

/** The reading race's name for the same thing. */
export const submitNote = submitAnswer;

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

  // Chord Race is won by outlasting everyone: once one player is left and the
  // rest are out, there is nothing to play for and the round ends there. The
  // reading race deliberately does not do this — a lone survivor still has to
  // finish the passage, because that game is a race against the music.
  if (gameSpec(match.game).lastStanding && stillAlive.length === 1 && match.entrants.size > 1) {
    return finish(match, END_REASON.LAST_STANDING, now);
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
  const wonByOutlasting = reason === END_REASON.LAST_STANDING && top && top.eliminated_at_note === null;
  match.winner_user_id = top && (top.finished_at || wonByOutlasting) ? top.user_id : null;
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
  const answerCount = match.passage.answers.length;
  const floor = gameSpec(match.game).minMsPerAnswer;
  const entrants = [...match.entrants.values()];

  const scoreOf = (e) => {
    if (!e.finished_at) return null;
    const reported = e.client_elapsed_ms;
    const roundMs = match.seconds * 1000;
    const serverMs = e.finished_at - match.started_at;
    const plausible =
      Number.isFinite(reported) &&
      reported >= answerCount * floor &&
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
  return (
    Number.isFinite(elapsedMs) &&
    elapsedMs >= match.passage.answers.length * gameSpec(match.game).minMsPerAnswer &&
    elapsedMs <= match.seconds * 1000 + CLOCK_SLACK_MS
  );
}

/**
 * The one chord a player is currently on, and nothing beyond it.
 *
 * The client has to be given pitches in order to sound the chord, so it can
 * always derive the current answer (see the note at the top of chords.js). What
 * it must never get is the REST of the round — that would turn a listening game
 * into a lookup, and would let a patched client answer the whole thing at once.
 * Returns null once the player is out, finished, or the match is over.
 */
export function currentFor(match, userId) {
  if (match.game !== "chords") return null;
  const e = match.entrants.get(userId);
  if (!e || e.eliminated_at_note !== null || e.finished_at) return null;
  if (match.state !== MATCH_STATE.RUNNING) return null;
  const chord = match.passage.chords[e.pos];
  if (!chord) return null;
  return { index: e.pos, notes: chord.notes.slice() };
}

/**
 * What a client may see mid-match.
 *
 * Other players' progress IS included, because watching the race is the point.
 * The answers are not: the reading race gives staff positions (which is what
 * the player reads anyway), and Chord Race gives only a count and the list of
 * qualities to choose between.
 */
export function publicView(match, forUserId = null) {
  const p = match.passage;
  const round = match.game === "chords"
    ? { game: "chords", count: p.count, qualities: p.qualities.slice() }
    : { game: "reading", clef: p.clef, key: p.key, dias: p.dias, bars: p.bars };

  return {
    id: match.id,
    game: match.game,
    level: match.level,
    state: match.state,
    endsAt: match.ends_at,
    seconds: match.seconds,
    round,
    // Kept under its old name so existing reading-race clients still work.
    passage: round,
    answerCount: p.answers.length,
    noteCount: p.answers.length,
    current: forUserId ? currentFor(match, forUserId) : null,
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
