import test from "node:test";
import assert from "node:assert/strict";

import { LEVELS, NOTES_PER_BAR, generatePassage, keyAlterations, diatonicToMidi, levelSpec } from "../src/competition/passage.js";
import {
  MAX_PLAYERS, MIN_PLAYERS, MATCH_STATE, END_REASON, MIN_MS_PER_NOTE, SETTLE_MS,
  createMatch, join, start, submitNote, resolve, rank, clampLobbySize,
  isPlausibleClientTime, publicView,
} from "../src/competition/match.js";
import { createMatchmaker, DEFAULT_TARGET, MAX_WAIT_MS, makeCode } from "../src/competition/matchmaking.js";

const T0 = Date.UTC(2026, 0, 1);
const FREE_LO = 41, FREE_HI = 72; // the 32-key free keyboard, F2–C5

function seatedMatch(level = 1, players = 4, seed = 7) {
  const m = createMatch({ id: "m1", level, seed, now: T0 });
  for (let i = 0; i < players; i++) join(m, `u${i}`, `P${i}`);
  start(m, T0);
  return m;
}
/** Play the whole passage correctly for one player. */
function playAll(m, user, { from = 0, now = T0 + 1000, clientElapsedMs = null } = {}) {
  let r;
  for (let i = from; i < m.passage.notes.length; i++) {
    r = submitNote(m, user, m.passage.notes[i], { now, clientElapsedMs });
  }
  return r;
}

// ------------------------------------------------------------------- levels

test("the level table matches the spec exactly", () => {
  assert.deepEqual(
    LEVELS.map((l) => [l.level, l.bars, l.notes, l.seconds]),
    [[1, 1, 4, 20], [2, 2, 8, 30], [3, 3, 12, 50], [4, 4, 16, 70], [5, 5, 20, 90]]
  );
});

test("four notes to the bar at every level", () => {
  for (const l of LEVELS) assert.equal(l.notes, l.bars * NOTES_PER_BAR);
});

test("key signatures start at level 3", () => {
  assert.deepEqual(LEVELS[0].keys, ["C"]);
  assert.deepEqual(LEVELS[1].keys, ["C"]);
  for (const l of LEVELS.slice(2)) {
    assert.ok(!l.keys.includes("C"), `level ${l.level} must not be in C`);
  }
});

test("a key signature changes the sounding pitch, not just the notation", () => {
  // F on the staff (dia 31) is F4=65 in C, F#4=66 in G major.
  assert.equal(diatonicToMidi(31, {}), 65);
  assert.equal(diatonicToMidi(31, keyAlterations("G")), 66);
  // B in F major sounds Bb.
  assert.equal(diatonicToMidi(27, keyAlterations("F")), 58);
});

test("levels 3+ actually require black keys", () => {
  let black = false;
  for (let s = 1; s < 200 && !black; s++) {
    black = generatePassage(4, s).notes.some((m) => [1, 3, 6, 8, 10].includes(m % 12));
  }
  assert.ok(black, "level 4 should produce accidentals");
});

test("every generated note fits the free 32-key keyboard", () => {
  for (let level = 1; level <= 5; level++) {
    for (let s = 1; s < 60; s++) {
      const p = generatePassage(level, s);
      assert.equal(p.notes.length, levelSpec(level).notes);
      for (const n of p.notes) {
        assert.ok(n >= FREE_LO && n <= FREE_HI, `level ${level} seed ${s} produced ${n}, outside F2–C5`);
      }
    }
  }
});

test("a seed reproduces the same passage, so a match can be audited", () => {
  assert.deepEqual(generatePassage(3, 12345).notes, generatePassage(3, 12345).notes);
  assert.notDeepEqual(generatePassage(3, 1).notes, generatePassage(3, 2).notes);
});

test("passages do not stick to one edge of the range", () => {
  const seen = new Set();
  for (let s = 1; s < 60; s++) generatePassage(5, s).notes.forEach((n) => seen.add(n));
  assert.ok(seen.size > 8, `expected a spread of pitches, saw ${seen.size}`);
});

// -------------------------------------------------------------- the 8 cap

test("eight is the hard cap", () => {
  assert.equal(MAX_PLAYERS, 8);
  const m = createMatch({ id: "m", level: 1, seed: 1 });
  for (let i = 0; i < 8; i++) assert.equal(join(m, `u${i}`, `P${i}`).ok, true);
  const ninth = join(m, "u8", "P8");
  assert.equal(ninth.ok, false);
  assert.equal(ninth.reason, "match_full");
  assert.equal(m.entrants.size, 8);
});

test("a request for more than eight is clamped, not rejected", () => {
  assert.equal(clampLobbySize(16), 8);
  assert.equal(clampLobbySize(64), 8);
  assert.equal(clampLobbySize(1), MIN_PLAYERS);
  assert.equal(clampLobbySize("nonsense"), MIN_PLAYERS);
  assert.equal(clampLobbySize(6), 6);
});

test("every entrant gets the same passage", () => {
  const m = seatedMatch(3, 8);
  assert.equal(m.entrants.size, 8);
  const view = publicView(m, "u0");
  assert.equal(view.noteCount, 12);
  assert.equal(view.players.length, 8);
});

// ------------------------------------------------- authoritative elimination

test("one wrong note eliminates, and the server decides", () => {
  const m = seatedMatch(1, 4);
  const wrong = m.passage.notes[0] === 60 ? 62 : 60;
  const r = submitNote(m, "u0", wrong, { now: T0 + 500 });
  assert.equal(r.correct, false);
  assert.equal(r.eliminated, true);
  assert.equal(m.entrants.get("u0").eliminated_at_note, 0);
});

test("an eliminated player cannot keep submitting", () => {
  const m = seatedMatch(1, 4);
  submitNote(m, "u0", m.passage.notes[0] + 1, { now: T0 + 100 });
  const again = submitNote(m, "u0", m.passage.notes[0], { now: T0 + 200 });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "eliminated");
  assert.equal(m.entrants.get("u0").pos, 0, "a cheating client must not advance after elimination");
});

test("a player not in the match cannot submit", () => {
  const m = seatedMatch(1, 2);
  const r = submitNote(m, "stranger", m.passage.notes[0], { now: T0 + 100 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_in_match");
});

test("finishing the passage wins the match", () => {
  const m = seatedMatch(1, 4);
  playAll(m, "u1", { now: T0 + 3000, clientElapsedMs: 3000 });
  resolve(m, T0 + 3000 + SETTLE_MS + 1);
  assert.equal(m.state, MATCH_STATE.FINISHED);
  assert.equal(m.end_reason, END_REASON.COMPLETED);
  assert.equal(m.winner_user_id, "u1");
  assert.equal(m.entrants.get("u1").placement, 1);
});

test("everyone eliminated ends the match with no winner", () => {
  const m = seatedMatch(1, 3);
  for (const u of ["u0", "u1", "u2"]) submitNote(m, u, m.passage.notes[0] + 1, { now: T0 + 100 });
  assert.equal(m.state, MATCH_STATE.FINISHED);
  assert.equal(m.end_reason, END_REASON.ALL_ELIMINATED);
  assert.equal(m.winner_user_id, null);
});

test("the clock expiring ends the match with no winner", () => {
  const m = seatedMatch(1, 4);
  resolve(m, m.ends_at + 1);
  assert.equal(m.state, MATCH_STATE.FINISHED);
  assert.equal(m.end_reason, END_REASON.TIMEOUT);
  assert.equal(m.winner_user_id, null);
});

test("submissions after time expires are refused", () => {
  const m = seatedMatch(1, 4);
  const r = submitNote(m, "u0", m.passage.notes[0], { now: m.ends_at + 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "time_expired");
});

// ------------------------------------------------------- local-clock scoring

test("ranking uses the player's own clock, so a slow connection does not lose the race", () => {
  // Two players finish within the settle window. "b" reaches the server FIRST
  // (better ping) but "a" played it faster on their own device. The faster
  // performance must win, not the faster connection.
  const m = createMatch({ id: "m3", level: 2, seed: 5, now: T0 });
  join(m, "a", "A"); join(m, "b", "B");
  start(m, T0);
  const ns = m.passage.notes;

  // b's completion lands at server time +4000, reporting 6000ms on its own clock.
  for (const n of ns) submitNote(m, "b", n, { now: T0 + 4000, clientElapsedMs: 6000 });
  assert.equal(m.state, MATCH_STATE.RUNNING, "the match must stay open for in-flight finishes");

  // a's lands 300ms later in server time, but reports only 3000ms played.
  for (const n of ns) submitNote(m, "a", n, { now: T0 + 4300, clientElapsedMs: 3000 });

  resolve(m, T0 + 4000 + SETTLE_MS);
  assert.equal(m.state, MATCH_STATE.FINISHED);
  const finishers = rank(m).filter((e) => e.finished_at).map((e) => e.user_id);
  assert.deepEqual(finishers, ["a", "b"], "the faster own-clock time ranks first");
  assert.equal(m.winner_user_id, "a", "the better performance wins, not the better ping");
});

test("the settle window closes and the match ends", () => {
  const m = seatedMatch(1, 3);
  playAll(m, "u0", { now: T0 + 3000, clientElapsedMs: 3000 });
  assert.equal(m.state, MATCH_STATE.RUNNING, "still open while others might finish");
  resolve(m, T0 + 3000 + SETTLE_MS + 1);
  assert.equal(m.state, MATCH_STATE.FINISHED);
  assert.equal(m.winner_user_id, "u0");
});

test("a lone finisher ends the match at once when nobody else can finish", () => {
  const m = seatedMatch(1, 2);
  submitNote(m, "u1", m.passage.notes[0] + 1, { now: T0 + 100 }); // u1 out
  playAll(m, "u0", { now: T0 + 2000, clientElapsedMs: 2000 });
  assert.equal(m.state, MATCH_STATE.FINISHED, "no one left to wait for");
  assert.equal(m.winner_user_id, "u0");
});

test("an impossible client time is rejected and falls back to server order", () => {
  const m = seatedMatch(1, 2);
  assert.ok(!isPlausibleClientTime(m, 10), "4 notes in 10ms is not human");
  assert.ok(!isPlausibleClientTime(m, m.seconds * 1000 + 60_000), "longer than the round");
  assert.ok(!isPlausibleClientTime(m, NaN));
  assert.ok(isPlausibleClientTime(m, 4 * MIN_MS_PER_NOTE));
  assert.ok(isPlausibleClientTime(m, 5000));

  // A player claiming 1ms still wins if they genuinely finished first — they are
  // ranked by server time, not disqualified.
  playAll(m, "u0", { now: T0 + 6000, clientElapsedMs: 1 });
  resolve(m, T0 + 6000 + SETTLE_MS + 1);
  assert.equal(m.winner_user_id, "u0");
});

test("survivors outrank eliminated players, and both are ranked by progress", () => {
  const m = seatedMatch(3, 4);
  const ns = m.passage.notes;
  submitNote(m, "u0", ns[0], { now: T0 + 100 });
  submitNote(m, "u0", ns[1], { now: T0 + 200 });          // survivor on 2
  submitNote(m, "u1", ns[0], { now: T0 + 100 });
  submitNote(m, "u1", ns[1] + 1, { now: T0 + 200 });      // out at 1
  submitNote(m, "u2", ns[0] + 1, { now: T0 + 100 });      // out at 0
  resolve(m, m.ends_at + 1);

  const order = rank(m).map((e) => e.user_id);
  assert.equal(order[0], "u0", "the furthest survivor leads");
  assert.ok(order.indexOf("u1") < order.indexOf("u2"), "eliminated players rank by progress");
});

test("eliminated players stay visible in the public view", () => {
  const m = seatedMatch(1, 3);
  submitNote(m, "u0", m.passage.notes[0] + 1, { now: T0 + 100 });
  const view = publicView(m, "u1");
  const me = view.players.find((p) => p.userId === "u0");
  assert.ok(me, "an eliminated player must still appear");
  assert.equal(me.out, true);
  assert.equal(view.players.find((p) => p.userId === "u1").you, true);
});

// --------------------------------------------------------------- matchmaking

test("a full queue forms a match immediately", () => {
  const mm = createMatchmaker({ now: () => T0 });
  let last;
  for (let i = 0; i < DEFAULT_TARGET; i++) last = mm.enqueue(`u${i}`, `P${i}`, 1, DEFAULT_TARGET);
  assert.ok(last.match, "eight in the queue should start a match");
  assert.equal(last.match.entrants.size, 8);
  assert.equal(last.match.state, MATCH_STATE.RUNNING);
  assert.equal(mm.queueLength(1), 0);
});

test("a partial queue starts once it has waited long enough", () => {
  let t = T0;
  const mm = createMatchmaker({ now: () => t });
  mm.enqueue("a", "A", 2);
  const before = mm.enqueue("b", "B", 2);
  assert.equal(before.match, null, "two players should not start instantly at target 8");

  t += MAX_WAIT_MS + 1;
  const after = mm.tryForm(2);
  assert.ok(after.match, "waiting past the floor should start the match");
  assert.equal(after.match.entrants.size, 2);
});

test("a queue never forms a match below the minimum", () => {
  let t = T0;
  const mm = createMatchmaker({ now: () => t });
  mm.enqueue("solo", "Solo", 1);
  t += MAX_WAIT_MS * 5;
  assert.equal(mm.tryForm(1).match, null, "one player is not a race");
});

test("private lobbies join by code — this is how one room plays together", () => {
  const mm = createMatchmaker({ now: () => T0 });
  const { match, code } = mm.createPrivate("host", "Host", 3);
  assert.match(code, /^[A-Z0-9]{5}$/);
  assert.equal(match.lobby_kind, "private");

  assert.equal(mm.joinPrivate(code, "friend", "Friend").ok, true);
  assert.equal(mm.joinPrivate(code.toLowerCase(), "friend2", "Friend2").ok, true, "codes are case-insensitive");
  assert.equal(mm.joinPrivate("ZZZZZ", "x", "X").ok, false);

  const started = mm.startPrivate(code, T0);
  assert.equal(started.ok, true);
  assert.equal(mm.byCode(code).state, MATCH_STATE.RUNNING);
});

test("a private lobby obeys the same eight-player cap", () => {
  const mm = createMatchmaker({ now: () => T0 });
  const { code } = mm.createPrivate("host", "Host", 1);
  for (let i = 0; i < 7; i++) assert.equal(mm.joinPrivate(code, `u${i}`, `P${i}`).ok, true);
  const overflow = mm.joinPrivate(code, "u8", "P8");
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, "match_full");
});

test("join codes avoid vowels, so they cannot spell anything", () => {
  for (let i = 0; i < 200; i++) {
    assert.ok(!/[AEIOU01]/.test(makeCode()), "codes should exclude vowels and lookalike digits");
  }
});

test("a match cannot be joined once it is running", () => {
  const m = seatedMatch(1, 2);
  const r = join(m, "late", "Late");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "already_started");
});

test("a match cannot start with fewer than two players", () => {
  const m = createMatch({ id: "m", level: 1, seed: 1 });
  join(m, "only", "Only");
  const r = start(m, T0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_enough_players");
});

// ======================================================================
// Chord Race — the second Competition game
// ======================================================================

const { CHORD_LEVELS, CHORD_INTERVALS, generateChordRound, chordLevelSpec } =
  await import("../src/competition/chords.js");
const { submitAnswer, currentFor, gameSpec, GAMES } = await import("../src/competition/match.js");

function chordMatch(level = 1, players = 4, seed = 11) {
  const m = createMatch({ id: "c1", game: "chords", level, seed, now: T0 });
  for (let i = 0; i < players; i++) join(m, `u${i}`, `P${i}`);
  start(m, T0);
  return m;
}
const answerAt = (m, i) => m.passage.answers[i];
const wrongAt = (m, i) => m.passage.qualities.find((q) => q !== answerAt(m, i));

test("the three chord levels are exactly the qualities that were asked for", () => {
  assert.deepEqual(CHORD_LEVELS[0].qualities, ["major", "minor"]);
  assert.deepEqual(CHORD_LEVELS[1].qualities, ["major", "minor", "major7", "minor7"]);
  assert.deepEqual(CHORD_LEVELS[2].qualities,
    ["major", "minor", "major7", "minor7", "augmented", "diminished"]);
  assert.equal(CHORD_LEVELS.length, 3);
  assert.throws(() => chordLevelSpec(4), /no such chord level/);
});

test("a round only ever asks for qualities its level teaches", () => {
  for (const spec of CHORD_LEVELS) {
    for (let seed = 1; seed <= 200; seed++) {
      const round = generateChordRound(spec.level, seed);
      assert.equal(round.answers.length, spec.count);
      for (const q of round.answers) {
        assert.ok(spec.qualities.includes(q),
          `level ${spec.level} produced ${q}, which it does not teach`);
      }
    }
  }
});

test("chord pitches stay inside the free 32-key range", () => {
  for (const spec of CHORD_LEVELS) {
    for (let seed = 1; seed <= 300; seed++) {
      for (const c of generateChordRound(spec.level, seed).chords) {
        assert.deepEqual(c.notes, CHORD_INTERVALS[c.quality].map((iv) => c.root + iv));
        for (const n of c.notes) {
          assert.ok(n >= FREE_LO && n <= FREE_HI, `chord note ${n} is off the free keyboard`);
        }
      }
    }
  }
});

test("a round is reproducible from its seed, and different seeds differ", () => {
  assert.deepEqual(generateChordRound(2, 42), generateChordRound(2, 42));
  const a = generateChordRound(3, 1).answers.join(), b = generateChordRound(3, 2).answers.join();
  assert.notEqual(a, b);
});

test("no quality appears three times in a row — that would reward guessing a pattern", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const ans = generateChordRound(1, seed).answers; // level 1 has only two options: the worst case
    for (let i = 2; i < ans.length; i++) {
      assert.ok(!(ans[i] === ans[i - 1] && ans[i] === ans[i - 2]),
        `seed ${seed} produced three ${ans[i]} in a row`);
    }
  }
});

test("one wrong quality ends the run, exactly like a wrong note", () => {
  const m = chordMatch(1, 4);
  const r = submitAnswer(m, "u0", wrongAt(m, 0), { now: T0 + 2000 });
  assert.equal(r.correct, false);
  assert.equal(r.eliminated, true);
  assert.equal(submitAnswer(m, "u0", answerAt(m, 0), { now: T0 + 3000 }).reason, "eliminated");
});

test("LAST PLAYER STANDING wins Chord Race without finishing the round", () => {
  const m = chordMatch(2, 3);
  submitAnswer(m, "u0", answerAt(m, 0), { now: T0 + 1000 }); // u0 gets one right
  submitAnswer(m, "u1", wrongAt(m, 0), { now: T0 + 1500 });
  assert.equal(m.state, MATCH_STATE.RUNNING, "two are still in it");

  submitAnswer(m, "u2", wrongAt(m, 0), { now: T0 + 2000 });
  assert.equal(m.state, MATCH_STATE.FINISHED);
  assert.equal(m.end_reason, END_REASON.LAST_STANDING);
  assert.equal(m.winner_user_id, "u0", "the survivor wins even though the round was not completed");
  assert.equal(m.entrants.get("u0").placement, 1);
  assert.equal(m.entrants.get("u0").finished_at, null, "they won by outlasting, not by finishing");
});

test("the reading race does NOT end on a lone survivor — that game is against the music", () => {
  const m = seatedMatch(1, 3);
  submitNote(m, "u1", m.passage.notes[0] === 60 ? 61 : 60, { now: T0 + 500 });
  submitNote(m, "u2", m.passage.notes[0] === 60 ? 61 : 60, { now: T0 + 600 });
  assert.equal(m.state, MATCH_STATE.RUNNING, "the survivor still has to play the passage");
  playAll(m, "u0", { now: T0 + 2000 });
  assert.equal(m.state, MATCH_STATE.FINISHED);
  assert.equal(m.end_reason, END_REASON.COMPLETED);
});

test("everyone out in Chord Race is a result, not a hang, and nobody wins", () => {
  const m = chordMatch(1, 2);
  submitAnswer(m, "u0", wrongAt(m, 0), { now: T0 + 1000 });
  assert.equal(m.state, MATCH_STATE.FINISHED, "one wrong leaves a single survivor");
  assert.equal(m.winner_user_id, "u1");

  const solo = createMatch({ id: "c2", game: "chords", level: 1, seed: 5, now: T0 });
  join(solo, "only", "Only"); join(solo, "other", "Other");
  start(solo, T0);
  submitAnswer(solo, "only", wrongAt(solo, 0), { now: T0 + 100 });
  submitAnswer(solo, "other", answerAt(solo, 0), { now: T0 + 200 });
  assert.equal(solo.winner_user_id, "other");
});

test("finishing the round still respects the settle window, so a rival can land too", () => {
  const m = chordMatch(1, 2);
  const done = m.passage.answers.length;
  let r;
  for (let i = 0; i < done; i++) {
    r = submitAnswer(m, "u0", answerAt(m, i), { now: T0 + 1000 + i, clientElapsedMs: 900 * (i + 1) });
  }
  assert.equal(r.finished, true);
  assert.equal(m.state, MATCH_STATE.RUNNING,
    "u1 is still playing — ending here would hand the win to whoever the server heard from first");

  resolve(m, T0 + 1000 + done + SETTLE_MS);
  assert.equal(m.state, MATCH_STATE.FINISHED);
  assert.equal(m.end_reason, END_REASON.COMPLETED);
  assert.equal(m.winner_user_id, "u0");
});

test("a rival who finishes inside the settle window on a faster own clock wins", () => {
  const m = chordMatch(1, 2);
  const n = m.passage.answers.length;
  for (let i = 0; i < n; i++) submitAnswer(m, "u0", answerAt(m, i), { now: T0 + 5000, clientElapsedMs: 12000 });
  // u1 reaches the server 300ms later but played it 3 seconds faster.
  for (let i = 0; i < n; i++) submitAnswer(m, "u1", answerAt(m, i), { now: T0 + 5300, clientElapsedMs: 9000 });
  resolve(m, T0 + 5000 + SETTLE_MS);
  assert.equal(m.winner_user_id, "u1", "ping must not decide a chord race either");
});

test("a chord answer has a higher plausibility floor than a key press", () => {
  const chords = chordMatch(1, 2), reading = seatedMatch(1, 2);
  assert.equal(gameSpec("chords").minMsPerAnswer, 500);
  assert.equal(gameSpec("reading").minMsPerAnswer, MIN_MS_PER_NOTE);
  // 8 chords in 2s is nobody hearing anything.
  assert.equal(isPlausibleClientTime(chords, 2000), false);
  assert.equal(isPlausibleClientTime(chords, 9000), true);
  // The same 2s over 4 read notes is fast but human.
  assert.equal(isPlausibleClientTime(reading, 2000), true);
});

test("a player is shown ONE chord — their own — and never the rest of the round", () => {
  const m = chordMatch(3, 2);
  const first = currentFor(m, "u0");
  assert.equal(first.index, 0);
  assert.deepEqual(first.notes, m.passage.chords[0].notes);

  submitAnswer(m, "u0", answerAt(m, 0), { now: T0 + 1000 });
  assert.equal(currentFor(m, "u0").index, 1, "the next chord is revealed only once the last is answered");
  assert.equal(currentFor(m, "u1").index, 0, "each player sees their own position, not someone else's");

  submitAnswer(m, "u1", wrongAt(m, 0), { now: T0 + 1200 });
  assert.equal(currentFor(m, "u1"), null, "an eliminated player is shown nothing further");
  assert.equal(currentFor(seatedMatch(1, 2), "u0"), null, "the reading race has no per-chord reveal");
});

test("the public view of a chord match carries the options but not the answers", () => {
  const m = chordMatch(2, 2);
  const v = publicView(m, "u0");
  assert.equal(v.game, "chords");
  assert.equal(v.answerCount, CHORD_LEVELS[1].count);
  assert.deepEqual(v.round.qualities, CHORD_LEVELS[1].qualities);
  const json = JSON.stringify({ ...v, current: null });
  assert.ok(!json.includes("chords\":[{"), "the chord list must not be serialised to a client");
  for (const key of ["answers", "root"]) {
    assert.ok(!json.includes(`"${key}"`), `${key} leaked into the public view`);
  }
  assert.equal(v.current.index, 0, "the player's own current chord is included");
});

test("matchmaking keeps the two games in separate queues", () => {
  const mm = createMatchmaker({ now: () => T0 });
  mm.enqueue("a", "A", 1, 2, "reading");
  const r = mm.enqueue("b", "B", 1, 2, "chords");
  assert.equal(r.match, null, "a chord player must not be pulled into a reading race");
  assert.equal(mm.queueLength(1, "reading"), 1);
  assert.equal(mm.queueLength(1, "chords"), 1);

  const formed = mm.enqueue("c", "C", 1, 2, "chords");
  assert.ok(formed.match);
  assert.equal(formed.match.game, "chords");
  assert.deepEqual([...formed.match.entrants.keys()], ["b", "c"]);
  assert.equal(mm.queueLength(1, "reading"), 1, "the reading queue is untouched");
});

test("a private chord lobby keeps its game", () => {
  const mm = createMatchmaker({ now: () => T0 });
  const { code, match } = mm.createPrivate("host", "Host", 3, Math.random, "chords");
  assert.equal(match.game, "chords");
  assert.equal(match.passage.qualities.length, 6);
  assert.equal(mm.byCode(code).game, "chords");
  assert.throws(() => mm.createPrivate("x", "X", 1, Math.random, "solitaire"), /no such game/);
});

test("both games are registered and disagree only where they should", () => {
  assert.deepEqual(Object.keys(GAMES), ["reading", "chords"]);
  assert.equal(GAMES.reading.lastStanding, false);
  assert.equal(GAMES.chords.lastStanding, true);
  assert.throws(() => createMatch({ id: "x", game: "nope", level: 1 }), /no such game/);
});
