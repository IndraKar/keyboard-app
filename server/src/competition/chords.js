/**
 * M7a — Chord Race, the second Competition game.
 *
 * A chord is played; every player names its quality. One wrong answer and you
 * are out, and the LAST PLAYER STANDING wins — unlike the reading race, which
 * is won by finishing first. That difference is the point of having two games:
 * one rewards speed under accuracy, the other rewards accuracy under pressure.
 *
 * The three levels widen the pool of qualities rather than speeding anything
 * up, because what makes a chord hard to name is how many things it could have
 * been:
 *   1. major / minor                       — the fundamental distinction
 *   2. + major 7th / minor 7th             — four notes, and the third now has company
 *   3. + augmented / diminished            — the fifth stops being a landmark
 *
 * ── A limit worth stating plainly ────────────────────────────────────────────
 * The client synthesises the chord, so it must be told which pitches to sound,
 * and anyone who can read those pitches can compute the quality. There is no
 * arrangement that avoids this while the sound is generated on the device —
 * pre-rendered audio would only move the problem, since audio can be analysed.
 *
 * So this game is cheatable by a patched client in a way the reading race is
 * not, and we do not pretend otherwise. What we do instead:
 *   - reveal ONE chord at a time, at the player's own position, so a cheater
 *     cannot precompute a whole round;
 *   - enforce a floor on answer time (a human has to actually hear the chord);
 *   - keep the server as the only authority on whether an answer was right.
 * That bounds the advantage rather than eliminating it, which is the honest
 * description of what is achievable here.
 */

import { makeRng } from "./passage.js";

/** Quality → semitones above the root. */
export const CHORD_INTERVALS = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  major7: [0, 4, 7, 11],
  minor7: [0, 3, 7, 10],
  augmented: [0, 4, 8],
  diminished: [0, 3, 6],
};

export const CHORD_LABELS = {
  major: "Major",
  minor: "Minor",
  major7: "Major 7th",
  minor7: "Minor 7th",
  augmented: "Augmented",
  diminished: "Diminished",
};

/**
 * Chord counts and clocks are balance, not rules — they are here so they can be
 * retuned without touching the engine. The counts are long enough that a round
 * is usually decided by an elimination rather than by running out of chords,
 * which is what "last player standing" needs to mean anything.
 */
export const CHORD_LEVELS = [
  { level: 1, count: 8,  seconds: 40, qualities: ["major", "minor"] },
  { level: 2, count: 10, seconds: 55, qualities: ["major", "minor", "major7", "minor7"] },
  { level: 3, count: 12, seconds: 70, qualities: ["major", "minor", "major7", "minor7", "augmented", "diminished"] },
];

export function chordLevelSpec(level) {
  const spec = CHORD_LEVELS[level - 1];
  if (!spec) throw new Error(`no such chord level: ${level}`);
  return spec;
}

/**
 * Roots sit in C3–C4. Low enough to sound like a chord rather than a chime,
 * high enough that the top of a major 7th (root + 11) still lands inside the
 * free 32-key range — the same reason the reading race stays in that window.
 */
const ROOT_LO = 48, ROOT_HI = 60;

export function generateChordRound(level, seed = (Math.random() * 2 ** 32) >>> 0) {
  const spec = chordLevelSpec(level);
  const rng = makeRng(seed);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  const chords = [];
  let previous = null;
  for (let i = 0; i < spec.count; i++) {
    let quality = pick(spec.qualities);
    // Never three of the same quality in a row: a run of majors tempts a player
    // into answering by pattern instead of by ear, which is not the skill.
    if (chords.length >= 2 && quality === previous && chords.at(-2).quality === quality) {
      quality = pick(spec.qualities.filter((q) => q !== quality));
    }
    previous = quality;
    const root = ROOT_LO + Math.floor(rng() * (ROOT_HI - ROOT_LO + 1));
    chords.push({ root, quality, notes: CHORD_INTERVALS[quality].map((iv) => root + iv) });
  }

  return {
    seed,
    game: "chords",
    level,
    count: spec.count,
    seconds: spec.seconds,
    qualities: spec.qualities.slice(), // the answer buttons the client shows
    chords,
    answers: chords.map((c) => c.quality),
  };
}
