/**
 * M7a — Key Signature Race, the third Competition game.
 *
 * A signature is shown; every player names the key. One wrong answer is out and
 * the last player standing wins, as in Chord Race. What is new here is the
 * ending: ten questions is a short round, and a field of good readers can very
 * plausibly ALL survive it. So a round that ends with two or more players still
 * in goes to SUDDEN DEATH — thirty seconds of "what key is this scale in", most
 * correct wins.
 *
 * That is the part worth understanding. Without it, the common case for skilled
 * players is a ten-question round that produces no winner at all, which is the
 * one outcome a competition cannot have.
 *
 * Unlike Chord Race, this game is NOT meaningfully cheatable: the client is sent
 * the signature to draw and the options to show, and neither reveals which
 * option is right. The answer lives only on the server.
 */

import { KEYS, KEY_TIERS, keyById, keyLabel, signatureGlyphs, scaleOf, scaleMidi } from "../theory/keysignatures.js";
import { makeRng } from "./passage.js";

export const QUESTIONS_PER_ROUND = 10;
export const SUDDEN_DEATH_MS = 30_000;
export const OPTION_COUNT = 4;

/**
 * Levels are cumulative rather than exclusive: level 2 still asks the level 1
 * signatures. A player who has just learned G major should be able to answer
 * one at level 2, and a pool that excluded it would make the middle level
 * *harder* than the top one for the wrong reason.
 *
 * Clocks give six to eight seconds a question. Reading a signature is
 * recognition, not calculation — the time pressure should punish hesitation,
 * not arithmetic.
 */
export const KEY_LEVELS = [
  { level: 1, questions: QUESTIONS_PER_ROUND, seconds: 60, pool: KEY_TIERS[1],
    blurb: "C, G and D and their relative minors" },
  { level: 2, questions: QUESTIONS_PER_ROUND, seconds: 70, pool: [...KEY_TIERS[1], ...KEY_TIERS[2]],
    blurb: "Up to five sharps, and the flat side begins" },
  { level: 3, questions: QUESTIONS_PER_ROUND, seconds: 80, pool: KEY_TIERS[4],
    blurb: "All fifteen signatures" },
];

export function keyLevelSpec(level) {
  const spec = KEY_LEVELS[level - 1];
  if (!spec) throw new Error(`no such key level: ${level}`);
  return spec;
}

/** Fisher-Yates against a seeded rng, so a round can be replayed for audit. */
function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Build the multiple-choice options for one question.
 *
 * The distractors are drawn NEAREST-FIRST by accidental count: if the answer is
 * three sharps, the wrong options are two and four sharps rather than seven
 * flats. Random distractors would make most questions answerable by counting
 * roughly, which tests nothing.
 */
function optionsFor(answer, pool, rng) {
  const others = pool.filter((k) => k.id !== answer.id);
  const distance = (k) =>
    Math.abs((k.sharps - k.flats) - (answer.sharps - answer.flats));
  const ranked = others.sort((a, b) => distance(a) - distance(b) || a.id.localeCompare(b.id));
  // Draw the three distractors from the four NEAREST signatures. A wider window
  // lets four sharps sit beside no accidentals at all, and the eye answers that
  // by counting marks rather than reading the key.
  const near = ranked.slice(0, OPTION_COUNT);
  const picked = shuffled(near, rng).slice(0, Math.min(OPTION_COUNT - 1, others.length));
  return shuffled([answer, ...picked], rng).map((k) => ({ id: k.id, label: keyLabel(k) }));
}

const clefFor = (rng) => (rng() < 0.5 ? "treble" : "bass");

/**
 * Pick an answer, optionally avoiding one key, WITHOUT narrowing the pool the
 * distractors come from. Those are two different sets: an earlier version
 * filtered the whole pool to avoid a repeat, which silently dropped a question
 * to three options and let a distractor come from five steps away instead of
 * four. Both showed up as test failures rather than as anything a player would
 * have reported.
 */
function pickAnswer(pool, rng, avoid) {
  const choices = avoid ? pool.filter((k) => k.id !== avoid) : pool;
  const from = choices.length ? choices : pool;
  return from[Math.floor(rng() * from.length)];
}

/** One "name this signature" question. */
function signatureQuestion(pool, rng, avoid = null) {
  const answer = pickAnswer(pool, rng, avoid);
  return {
    kind: "signature",
    clef: clefFor(rng),
    glyphs: signatureGlyphs(answer),
    options: optionsFor(answer, pool, rng),
    answer: answer.id,
  };
}

/**
 * One "what key is this scale in" question — the sudden-death format.
 *
 * The scale is sent as staff positions AND pitches, because the client both
 * draws and sounds it. Neither reveals the answer any more than the printed
 * page does: reading the tonic off a scale is precisely the skill being tested,
 * which is why this is the tiebreak rather than more signature questions.
 */
function scaleQuestion(pool, rng, avoid = null) {
  const answer = pickAnswer(pool, rng, avoid);
  const mode = rng() < 0.5 ? "major" : "minor";
  const notes = scaleOf(answer, mode);
  return {
    kind: "scale",
    mode,
    clef: "treble",
    notes: notes.map((n) => ({ letter: n.letter, alter: n.alter })),
    midi: scaleMidi(answer, mode, 4),
    options: optionsFor(answer, pool, rng),
    answer: answer.id,
  };
}

export function generateKeyRound(level, seed = (Math.random() * 2 ** 32) >>> 0) {
  const spec = keyLevelSpec(level);
  const rng = makeRng(seed);
  const pool = spec.pool.map(keyById);

  const questions = [];
  for (let i = 0; i < spec.questions; i++) {
    // Never the same signature twice running: two identical staves in a row
    // reads as a rendering bug, and answering the second one is free.
    questions.push(signatureQuestion(pool, rng, questions.at(-1)?.answer ?? null));
  }

  return {
    seed,
    game: "keys",
    level,
    count: spec.questions,
    seconds: spec.seconds,
    questions,
    answers: questions.map((q) => q.answer),
    suddenDeathMs: SUDDEN_DEATH_MS,
  };
}

/**
 * The sudden-death question pool.
 *
 * Generated long — nobody is naming forty scales in thirty seconds — because
 * running out of questions mid-tiebreak would decide the match on pool length
 * rather than on either player.
 */
export function generateScaleRound(level, seed = (Math.random() * 2 ** 32) >>> 0, count = 40) {
  const spec = keyLevelSpec(level);
  const rng = makeRng(seed);
  const pool = spec.pool.map(keyById);
  const questions = [];
  for (let i = 0; i < count; i++) {
    questions.push(scaleQuestion(pool, rng, questions.at(-1)?.answer ?? null));
  }
  return { seed, level, seconds: SUDDEN_DEATH_MS / 1000, questions, answers: questions.map((q) => q.answer) };
}

export { KEYS };
