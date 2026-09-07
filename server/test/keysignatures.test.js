import test from "node:test";
import assert from "node:assert/strict";

import {
  KEYS, KEY_TIERS, keyById, keyLabel, scaleNames, scaleMidi, alterationsOf,
  signatureGlyphs, signatureDescription, accidentalCount, tierPool, SHARP_ORDER, FLAT_ORDER,
} from "../src/theory/keysignatures.js";
import { generateKeyRound, generateScaleRound, KEY_LEVELS, QUESTIONS_PER_ROUND, SUDDEN_DEATH_MS } from "../src/competition/keys.js";

/**
 * The theory table is the one thing here that cannot be "mostly right". Every
 * expected value below is written out by hand rather than derived, so a bug in
 * the derivation cannot also produce the expectation that hides it.
 */
const EXPECTED = [
  ["C",  "C major / A minor",   "",        "C D E F G A B C"],
  ["G",  "G major / E minor",   "F",       "G A B C D E F♯ G"],
  ["D",  "D major / B minor",   "FC",      "D E F♯ G A B C♯ D"],
  ["A",  "A major / F♯ minor",  "FCG",     "A B C♯ D E F♯ G♯ A"],
  ["E",  "E major / C♯ minor",  "FCGD",    "E F♯ G♯ A B C♯ D♯ E"],
  ["B",  "B major / G♯ minor",  "FCGDA",   "B C♯ D♯ E F♯ G♯ A♯ B"],
  ["F#", "F♯ major / D♯ minor", "FCGDAE",  "F♯ G♯ A♯ B C♯ D♯ E♯ F♯"],
  ["C#", "C♯ major / A♯ minor", "FCGDAEB", "C♯ D♯ E♯ F♯ G♯ A♯ B♯ C♯"],
  ["F",  "F major / D minor",   "B",       "F G A B♭ C D E F"],
  ["Bb", "B♭ major / G minor",  "BE",      "B♭ C D E♭ F G A B♭"],
  ["Eb", "E♭ major / C minor",  "BEA",     "E♭ F G A♭ B♭ C D E♭"],
  ["Ab", "A♭ major / F minor",  "BEAD",    "A♭ B♭ C D♭ E♭ F G A♭"],
  ["Db", "D♭ major / B♭ minor", "BEADG",   "D♭ E♭ F G♭ A♭ B♭ C D♭"],
  ["Gb", "G♭ major / E♭ minor", "BEADGC",  "G♭ A♭ B♭ C♭ D♭ E♭ F G♭"],
  ["Cb", "C♭ major / A♭ minor", "BEADGCF", "C♭ D♭ E♭ F♭ G♭ A♭ B♭ C♭"],
];

test("all fifteen signatures name the right keys and spell the right scale", () => {
  assert.equal(KEYS.length, 15);
  for (const [id, label, glyphs, scale] of EXPECTED) {
    const k = keyById(id);
    assert.equal(keyLabel(k), label, `${id} label`);
    assert.equal(signatureGlyphs(k).map((g) => g.letter).join(""), glyphs, `${id} accidentals`);
    assert.equal(scaleNames(k).join(" "), scale, `${id} major scale`);
  }
});

test("accidentals appear in the only order they are ever written", () => {
  for (const k of KEYS) {
    const letters = signatureGlyphs(k).map((g) => g.letter);
    const order = k.sharps ? SHARP_ORDER : FLAT_ORDER;
    assert.deepEqual(letters, order.slice(0, letters.length), `${k.id} out of order`);
    assert.ok(!(k.sharps && k.flats), `${k.id} cannot be both sharp and flat`);
  }
});

test("the first and last note of every scale is the tonic", () => {
  // This is the whole method for reading a scale's key, so it is worth asserting
  // rather than assuming.
  for (const k of KEYS) {
    for (const mode of ["major", "minor"]) {
      const notes = scaleNames(k, mode);
      assert.equal(notes.length, 8);
      assert.equal(notes[0], notes[7], `${k.id} ${mode} does not return to its tonic`);
    }
  }
});

test("relative minors share their major's signature exactly", () => {
  for (const k of KEYS) {
    const major = scaleNames(k, "major").slice(0, 7).sort();
    const minor = scaleNames(k, "minor").slice(0, 7).sort();
    assert.deepEqual(minor, major, `${k.id}: a relative minor uses the same seven notes`);
  }
});

test("every major scale is the right shape in semitones", () => {
  const MAJOR = [2, 2, 1, 2, 2, 2, 1];
  const MINOR = [2, 1, 2, 2, 1, 2, 2];
  for (const k of KEYS) {
    for (const [mode, shape] of [["major", MAJOR], ["minor", MINOR]]) {
      const midi = scaleMidi(k, mode);
      const steps = midi.slice(1).map((m, i) => m - midi[i]);
      assert.deepEqual(steps, shape, `${k.id} ${mode} is not a ${mode} scale`);
    }
  }
});

test("the four tiers are exactly the ones specified, and together cover all fifteen", () => {
  assert.deepEqual(KEY_TIERS[1], ["C", "G", "D"]);
  assert.deepEqual(KEY_TIERS[2], ["A", "B", "F", "E"]);
  assert.deepEqual(KEY_TIERS[3], ["F#", "C#", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"]);
  assert.equal(KEY_TIERS[4].length, 15);

  const one = new Set([...KEY_TIERS[1], ...KEY_TIERS[2], ...KEY_TIERS[3]]);
  assert.equal(one.size, 15, "tiers 1-3 must partition the fifteen with no overlap and no gaps");
  assert.deepEqual([...one].sort(), KEYS.map((k) => k.id).sort());

  // Tier 3 really is the hard end: nothing in it is easier than tier 1's hardest.
  const hardest = (ids) => Math.max(...ids.map((id) => accidentalCount(id)));
  const easiest = (ids) => Math.min(...ids.map((id) => accidentalCount(id)));
  assert.ok(easiest(KEY_TIERS[3]) >= hardest(KEY_TIERS[1]),
    "a tier 3 signature must never be simpler than a tier 1 one");
  assert.equal(hardest(KEY_TIERS[3]), 7);
  assert.equal(tierPool(1).length, 3);
  assert.throws(() => tierPool(5), /no such key-signature tier/);
});

test("alterationsOf drives the accidentals a passage actually sounds", () => {
  assert.deepEqual(alterationsOf("D"), { F: 1, C: 1 });
  assert.deepEqual(alterationsOf("Eb"), { B: -1, E: -1, A: -1 });
  assert.deepEqual(alterationsOf("C"), {});
  assert.equal(signatureDescription("C"), "no sharps or flats");
  assert.equal(signatureDescription("G"), "one sharp");
  assert.equal(signatureDescription("Eb"), "three flats");
});

// ------------------------------------------------------ the competition round

test("a key round is ten questions, as specified", () => {
  for (const spec of KEY_LEVELS) {
    const r = generateKeyRound(spec.level, 3);
    assert.equal(r.count, 10);
    assert.equal(QUESTIONS_PER_ROUND, 10);
    assert.equal(r.questions.length, 10);
    assert.equal(r.answers.length, 10);
    assert.equal(r.suddenDeathMs, SUDDEN_DEATH_MS);
    assert.equal(SUDDEN_DEATH_MS, 30_000, "thirty seconds, as specified");
  }
});

test("levels are cumulative, so an easy signature can still appear at the top level", () => {
  assert.deepEqual(KEY_LEVELS[0].pool, KEY_TIERS[1]);
  assert.ok(KEY_LEVELS[1].pool.includes("C"), "level 2 still asks the level 1 keys");
  assert.equal(KEY_LEVELS[2].pool.length, 15);
});

test("questions only draw from their level's pool, and never repeat back to back", () => {
  for (const spec of KEY_LEVELS) {
    for (let seed = 1; seed <= 300; seed++) {
      const { questions, answers } = generateKeyRound(spec.level, seed);
      for (const a of answers) assert.ok(spec.pool.includes(a), `level ${spec.level} produced ${a}`);
      for (let i = 1; i < answers.length; i++) {
        assert.notEqual(answers[i], answers[i - 1], `seed ${seed} repeated ${answers[i]}`);
      }
      for (const q of questions) {
        const ids = q.options.map((o) => o.id);
        assert.equal(new Set(ids).size, ids.length, "duplicate option");
        assert.equal(ids.filter((i) => i === q.answer).length, 1, "the answer must appear exactly once");
        // Four options, except where the whole pool is smaller: level 1 offers
        // three, because a fourth would come from a tier not yet taught.
        assert.equal(ids.length, Math.min(4, spec.pool.length));
        if (spec.level === 1) assert.equal(ids.length, 3);
        if (spec.level >= 2) assert.equal(ids.length, 4);
        assert.ok(["treble", "bass"].includes(q.clef));
        assert.equal(q.glyphs.length, accidentalCount(q.answer));
      }
    }
  }
});

test("distractors are near neighbours, so the question cannot be answered by counting marks", () => {
  let far = 0, total = 0;
  for (let seed = 1; seed <= 400; seed++) {
    for (const q of generateKeyRound(3, seed).questions) {
      const answer = keyById(q.answer);
      const net = (k) => k.sharps - k.flats;
      for (const o of q.options) {
        if (o.id === q.answer) continue;
        total++;
        if (Math.abs(net(keyById(o.id)) - net(answer)) > 4) far++;
      }
    }
  }
  assert.equal(far, 0, `${far} of ${total} distractors were more than four steps away`);
});

test("every level reaches every key in its pool — no signature is unreachable", () => {
  // The PRNG used to make this false: its first output was degenerate, so
  // whichever choice a generator made first was frozen. This asserts the fix.
  for (const spec of KEY_LEVELS) {
    const seen = new Set();
    for (let seed = 1; seed <= 600; seed++) for (const a of generateKeyRound(spec.level, seed).answers) seen.add(a);
    assert.equal(seen.size, spec.pool.length,
      `level ${spec.level} only ever produced ${seen.size} of its ${spec.pool.length} keys`);
  }
});

test("a round is reproducible from its seed", () => {
  assert.deepEqual(generateKeyRound(2, 4321), generateKeyRound(2, 4321));
  assert.notDeepEqual(generateKeyRound(2, 1).answers, generateKeyRound(2, 2).answers);
});

test("sudden-death questions are scales, with the pitches needed to sound them", () => {
  const r = generateScaleRound(3, 9, 12);
  assert.equal(r.questions.length, 12);
  for (const q of r.questions) {
    assert.equal(q.kind, "scale");
    assert.ok(["major", "minor"].includes(q.mode));
    assert.equal(q.notes.length, 8);
    assert.equal(q.midi.length, 8);
    assert.equal(q.notes[0].letter, q.notes[7].letter, "a scale ends where it started");
    assert.equal(q.midi[7] - q.midi[0], 12, "and an octave higher");
    assert.ok(q.options.some((o) => o.id === q.answer));
  }
});

test("the sudden-death pool is long enough that nobody can exhaust it in 30s", () => {
  const r = generateScaleRound(1, 5);
  // 40 scales in 30 seconds is 750ms each, including hearing them.
  assert.ok(r.questions.length >= 40, "running out of questions would decide the tiebreak on pool length");
});
