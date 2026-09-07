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
import { generateKeyRound, generateScaleRound, keyLevelSpec, SUDDEN_DEATH_MS } from "./keys.js";

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
  keys: {
    id: "keys",
    label: "Key Signature Race",
    generate: (level, seed) => generateKeyRound(level, seed),
    spec: (level) => keyLevelSpec(level),
    lastStanding: true,
    minMsPerAnswer: 400, // reading a signature is recognition, but not instant
    /**
     * The only game with a tiebreak. Ten questions is short enough that a field
     * of good readers can all survive it, and a competition whose common
     * outcome is "no winner" is broken. Survivors go to thirty seconds of
     * "what key is this scale in" — most correct wins.
     */
    suddenDeath: true,
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
export const PHASE = { MAIN: "main", SUDDEN_DEATH: "sudden_death" };

/**
 * How many sudden-death rounds may run before a tie is simply allowed to stand.
 *
 * A tie survives a round only when two players answer the same number correctly
 * AND report the same elapsed time to the millisecond, so this is close to
 * unreachable in practice. It exists because "keep going until someone wins" is
 * the kind of rule that produces an infinite loop the one time it matters.
 */
export const MAX_SUDDEN_DEATH_ROUNDS = 3;
export const END_REASON = {
  COMPLETED: "completed",
  ALL_ELIMINATED: "all_eliminated",
  TIMEOUT: "timeout",
  LAST_STANDING: "last_standing", // Chord/Key Race: everyone else went out
  SUDDEN_DEATH: "sudden_death",   // the tiebreak named a winner
  DRAW: "draw",                   // tied through every permitted tiebreak
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
    // Sudden death (Key Signature Race only). `phase` is "main" until a round
    // ends with two or more players still standing.
    phase: PHASE.MAIN,
    sudden_death: null,
    sd_round: 0,
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
    // Sudden death is scored separately: it is a count race, not an
    // elimination, so it needs its own counters rather than reusing `pos`.
    sd_pos: 0,
    sd_correct: 0,
    sd_elapsed_ms: null,
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

/** Still playing: not out, and not yet done. */
const alive = (m) => [...m.entrants.values()].filter((e) => e.eliminated_at_note === null && !e.finished_at);

/**
 * Not eliminated — which INCLUDES players who finished the round.
 *
 * This is the set the tiebreak is for, and it is deliberately not `alive()`:
 * someone who answered all ten correctly has survived, not left. Using
 * `alive()` here produced an empty contender list, a tiebreak nobody was in,
 * and a draw between no players.
 */
const survivors = (m) => [...m.entrants.values()].filter((e) => e.eliminated_at_note === null);

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

  const e = match.entrants.get(userId);
  if (!e) return { ok: false, reason: "not_in_match" };

  if (match.phase === PHASE.SUDDEN_DEATH) return submitSuddenDeath(match, e, answer, now, clientElapsedMs);

  const openUntil = Math.max(match.ends_at, match.settle_until ?? 0);
  if (now > openUntil) return { ok: false, reason: "time_expired" };
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
 * One sudden-death answer.
 *
 * NOTHING IS ELIMINATED HERE. Sudden death asks who can name more scales in
 * thirty seconds, so a wrong answer costs you the time it took and nothing
 * else. Eliminating on a wrong answer would make the tiebreak a second
 * elimination round rather than the count race it is meant to be — and with two
 * players left, the first person to guess wrong would lose to someone who
 * simply answered nothing.
 */
function submitSuddenDeath(match, e, answer, now, clientElapsedMs) {
  if (now > match.sudden_death.ends_at) return { ok: false, reason: "time_expired" };
  if (!match.sudden_death.contenders.includes(e.user_id)) return { ok: false, reason: "not_in_tiebreak" };

  const expected = match.sudden_death.answers[e.sd_pos];
  if (expected === undefined) return { ok: false, reason: "out_of_questions" };

  const correct = answer === expected;
  if (correct) e.sd_correct += 1;
  e.sd_pos += 1;
  e.sd_elapsed_ms = Number.isFinite(clientElapsedMs) ? clientElapsedMs : e.sd_elapsed_ms;

  return {
    ok: true, correct, eliminated: false, suddenDeath: true,
    pos: e.sd_pos, correctCount: e.sd_correct,
    resolved: resolve(match, now),
  };
}

/**
 * Begin (or repeat) the tiebreak. Contenders keep their main-round standing —
 * being in sudden death already means you survived all ten.
 */
export function startSuddenDeath(match, now = Date.now(), seed) {
  const contenders = survivors(match).map((e) => e.user_id);
  if (contenders.length < 2) throw new Error("sudden death needs at least two contenders");
  match.phase = PHASE.SUDDEN_DEATH;
  match.sd_round += 1;
  const round = generateScaleRound(match.level, seed ?? ((Math.random() * 2 ** 32) >>> 0));
  match.sudden_death = {
    round: match.sd_round,
    contenders,
    questions: round.questions,
    answers: round.answers,
    started_at: now,
    ends_at: now + SUDDEN_DEATH_MS,
  };
  for (const id of contenders) {
    const e = match.entrants.get(id);
    e.sd_pos = 0;
    e.sd_correct = 0;
    e.sd_elapsed_ms = null;
  }
  return match;
}

/**
 * Rank the tiebreak: most correct, then fastest by the player's own clock —
 * the same principle the main round uses, for the same reason.
 * @returns {{winner: string|null, tied: string[]}}
 */
export function suddenDeathResult(match) {
  const sd = match.sudden_death;
  const rows = sd.contenders.map((id) => match.entrants.get(id));
  const best = Math.max(...rows.map((e) => e.sd_correct));
  let leaders = rows.filter((e) => e.sd_correct === best);

  if (leaders.length > 1) {
    const timed = leaders.filter((e) => Number.isFinite(e.sd_elapsed_ms));
    if (timed.length === leaders.length) {
      const fastest = Math.min(...timed.map((e) => e.sd_elapsed_ms));
      leaders = timed.filter((e) => e.sd_elapsed_ms === fastest);
    }
  }
  return leaders.length === 1
    ? { winner: leaders[0].user_id, tied: [] }
    : { winner: null, tied: leaders.map((e) => e.user_id) };
}

/**
 * Decide whether the match is over, and if so who won.
 *
 * A match ends when someone finishes, when everyone is out, or when the clock
 * expires. It always names an outcome — "no winner" is a result, not a hang.
 */
export function resolve(match, now = Date.now()) {
  if (match.state === MATCH_STATE.FINISHED) return match;
  if (match.phase === PHASE.SUDDEN_DEATH) return resolveSuddenDeath(match, now);

  const spec = gameSpec(match.game);
  const finishers = [...match.entrants.values()].filter((e) => e.finished_at);
  const stillAlive = alive(match);

  if (finishers.length > 0) {
    // Open the settle window on the first completion rather than ending here.
    if (match.settle_until === null) match.settle_until = now + SETTLE_MS;
    // End early only when nobody else could still finish.
    if (stillAlive.length === 0 || now >= match.settle_until) {
      return endMainRound(match, END_REASON.COMPLETED, now);
    }
    return match;
  }

  // Chord Race is won by outlasting everyone: once one player is left and the
  // rest are out, there is nothing to play for and the round ends there. The
  // reading race deliberately does not do this — a lone survivor still has to
  // finish the passage, because that game is a race against the music.
  if (spec.lastStanding && stillAlive.length === 1 && match.entrants.size > 1) {
    return finish(match, END_REASON.LAST_STANDING, now);
  }

  if (stillAlive.length === 0) return finish(match, END_REASON.ALL_ELIMINATED, now);
  if (now >= match.ends_at) return endMainRound(match, END_REASON.TIMEOUT, now);
  return match;
}

/**
 * The main round is over. Either that settles it, or it does not.
 *
 * For a game with a tiebreak, "two or more players still standing" is the case
 * the tiebreak exists for — whether they got there by finishing all ten
 * questions or by surviving to the clock. Everything else ends here as usual.
 */
function endMainRound(match, reason, now) {
  const spec = gameSpec(match.game);
  const left = survivors(match);

  if (spec.suddenDeath && left.length >= 2 && match.sd_round < MAX_SUDDEN_DEATH_ROUNDS) {
    return startSuddenDeath(match, now);
  }
  return finish(match, reason, now);
}

/**
 * Sudden death ends when the clock does, or when every contender has answered
 * the whole pool. A clear leader wins; a tie runs it again, up to the cap.
 */
function resolveSuddenDeath(match, now) {
  const sd = match.sudden_death;
  const contenders = sd.contenders.map((id) => match.entrants.get(id));
  const exhausted = contenders.every((e) => e.sd_pos >= sd.answers.length);
  if (now < sd.ends_at && !exhausted) return match;

  const { winner, tied } = suddenDeathResult(match);
  if (winner) {
    match.winner_user_id = winner;
    return finish(match, END_REASON.SUDDEN_DEATH, now);
  }
  if (match.sd_round < MAX_SUDDEN_DEATH_ROUNDS && tied.length >= 2) return startSuddenDeath(match, now);

  // Tied through every permitted round. A shared result is a worse outcome than
  // a winner, and a better one than a loop that never returns.
  match.tied_user_ids = tied;
  return finish(match, END_REASON.DRAW, now);
}

function finish(match, reason, now) {
  match.state = MATCH_STATE.FINISHED;
  match.ended_at = now;
  match.end_reason = reason;
  const ranked = rank(match);
  ranked.forEach((e, i) => {
    match.entrants.get(e.user_id).placement = i + 1;
  });
  if (reason === END_REASON.SUDDEN_DEATH || reason === END_REASON.DRAW) {
    // The tiebreak already decided this; ranking must not overwrite it.
    return match;
  }
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

  // When a match went to the tiebreak, the tiebreak IS the ranking for the
  // players who reached it. Ordering them by their main-round time instead
  // would put someone second who had just won the sudden death.
  const sd = match.sudden_death;
  const inTiebreak = sd ? new Set(sd.contenders) : null;

  return entrants.sort((a, b) => {
    if (inTiebreak) {
      const aT = inTiebreak.has(a.user_id), bT = inTiebreak.has(b.user_id);
      if (aT !== bT) return aT ? -1 : 1;
      if (aT && bT) {
        if (a.sd_correct !== b.sd_correct) return b.sd_correct - a.sd_correct;
        const at = Number.isFinite(a.sd_elapsed_ms) ? a.sd_elapsed_ms : Infinity;
        const bt = Number.isFinite(b.sd_elapsed_ms) ? b.sd_elapsed_ms : Infinity;
        if (at !== bt) return at - bt;
        return 0;
      }
    }
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
 * The one question a player is currently on, and nothing beyond it.
 *
 * Chord Race has to send pitches (see the note at the top of chords.js), so its
 * current answer is derivable; the Key Signature Race's is not — a signature and
 * four options say nothing about which option is right. What both share is that
 * the REST of the round is never sent, so no client can work ahead.
 *
 * Returns null once the player is out, finished, or the match is over.
 */
export function currentFor(match, userId) {
  const e = match.entrants.get(userId);
  if (!e || match.state !== MATCH_STATE.RUNNING) return null;

  if (match.phase === PHASE.SUDDEN_DEATH) {
    if (!match.sudden_death.contenders.includes(userId)) return null;
    const q = match.sudden_death.questions[e.sd_pos];
    if (!q) return null;
    const { answer, ...safe } = q;
    return { index: e.sd_pos, suddenDeath: true, round: match.sudden_death.round, ...safe };
  }

  if (e.eliminated_at_note !== null || e.finished_at) return null;

  if (match.game === "chords") {
    const chord = match.passage.chords[e.pos];
    return chord ? { index: e.pos, notes: chord.notes.slice() } : null;
  }
  if (match.game === "keys") {
    const q = match.passage.questions[e.pos];
    if (!q) return null;
    const { answer, ...safe } = q; // the answer is the one field that never ships
    return { index: e.pos, ...safe };
  }
  return null; // the reading race renders the whole passage up front
}

/**
 * What a client may see mid-match.
 *
 * Other players' progress IS included, because watching the race is the point.
 * The answers are not: the reading race gives staff positions (which is what
 * the player reads anyway), Chord Race gives a count and the qualities to
 * choose between, and the Key Signature Race gives a count and nothing else.
 */
export function publicView(match, forUserId = null) {
  const p = match.passage;
  const round =
    match.game === "chords"
      ? { game: "chords", count: p.count, qualities: p.qualities.slice() }
      : match.game === "keys"
        ? { game: "keys", count: p.count, suddenDeathMs: p.suddenDeathMs }
        : { game: "reading", clef: p.clef, key: p.key, dias: p.dias, bars: p.bars };

  const sd = match.sudden_death;
  return {
    id: match.id,
    game: match.game,
    level: match.level,
    state: match.state,
    phase: match.phase,
    endsAt: match.phase === PHASE.SUDDEN_DEATH ? sd.ends_at : match.ends_at,
    seconds: match.seconds,
    round,
    // Kept under its old name so existing reading-race clients still work.
    passage: round,
    answerCount: p.answers.length,
    noteCount: p.answers.length,
    current: forUserId ? currentFor(match, forUserId) : null,
    suddenDeath: sd
      ? { round: sd.round, endsAt: sd.ends_at, contenders: sd.contenders.slice() }
      : null,
    winnerUserId: match.winner_user_id,
    tiedUserIds: match.tied_user_ids ?? null,
    endReason: match.end_reason,
    players: rank(match).map((e) => ({
      userId: e.user_id,
      name: e.display_name,
      pos: e.pos,
      out: e.eliminated_at_note !== null,
      done: !!e.finished_at,
      sdCorrect: e.sd_correct,
      placement: e.placement,
      you: e.user_id === forUserId,
    })),
  };
}
