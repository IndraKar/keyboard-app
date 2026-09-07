/**
 * M7a — server-side passage generation.
 *
 * The passage is generated HERE and never on a client. A client that could
 * generate (or see) the passage early would have it before the round starts,
 * which is the whole game. Every entrant in a match receives the same passage,
 * produced once at match creation.
 *
 * Level table is PRD F-13. Four notes to the bar throughout, so the level
 * number is also the bar count. Key signatures start at level 3 — that is the
 * difficulty axis that matters for a reading race, because it forces
 * accidentals under time pressure rather than just adding more white keys.
 */

export const LEVELS = [
  { level: 1, bars: 1, notes: 4, seconds: 20, keys: ["C"] },
  { level: 2, bars: 2, notes: 8, seconds: 30, keys: ["C"] },
  { level: 3, bars: 3, notes: 12, seconds: 50, keys: ["G", "F"] },
  { level: 4, bars: 4, notes: 16, seconds: 70, keys: ["D", "Bb"] },
  { level: 5, bars: 5, notes: 20, seconds: 90, keys: ["A", "Eb"] },
];

export const NOTES_PER_BAR = 4;
export function levelSpec(level) {
  const spec = LEVELS[level - 1];
  if (!spec) throw new Error(`no such level: ${level}`);
  return spec;
}

const LETTER_PC = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
const LETTERS = "CDEFGAB";
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];

const KEYS = {
  C: { sharps: 0, flats: 0 },
  G: { sharps: 1, flats: 0 },
  D: { sharps: 2, flats: 0 },
  A: { sharps: 3, flats: 0 },
  F: { sharps: 0, flats: 1 },
  Bb: { sharps: 0, flats: 2 },
  Eb: { sharps: 0, flats: 3 },
};

export function keyAlterations(key) {
  const k = KEYS[key];
  if (!k) throw new Error(`no such key: ${key}`);
  const out = {};
  for (let i = 0; i < k.sharps; i++) out[SHARP_ORDER[i]] = 1;
  for (let i = 0; i < k.flats; i++) out[FLAT_ORDER[i]] = -1;
  return out;
}

/**
 * Staff position (diatonic index) → sounding MIDI pitch, through a key
 * signature. A note keeps its staff position when altered: F# still sits on the
 * F line. This is why passages are stored as positions plus a key rather than
 * as bare pitches — the score and the expected pitch come from one source.
 */
export function diatonicToMidi(dia, alter = {}) {
  const oct = Math.floor(dia / 7);
  const step = ((dia % 7) + 7) % 7;
  const letter = LETTERS[step];
  return (oct + 1) * 12 + LETTER_PC[step] + (alter[letter] ?? 0);
}

/** Deterministic PRNG so a match can be regenerated from its seed for audit. */
export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Build a passage. Notes stay inside the FREE 32-key range (F2–C5) even though
 * Competition is a paid feature: a race decided by who could reach an octave
 * the other player's keyboard does not render would be a bad race.
 */
export function generatePassage(level, seed = (Math.random() * 2 ** 32) >>> 0) {
  const spec = levelSpec(level);
  const rng = makeRng(seed);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  const key = pick(spec.keys);
  const alter = keyAlterations(key);
  const clef = rng() < 0.5 ? "treble" : "bass";

  // Windows chosen so every note lands within F2–C5 with at most one ledger line.
  // The bounds allow for the key signature: a sharp key raises the top note and a
  // flat key lowers the bottom one, so the window is a semitone tighter than the
  // keyboard. Level 4 in A major found this — C5 became C#5 (73) and fell off the
  // end of the free keyboard.
  const [loDia, hiDia] = clef === "treble" ? [28, 34] : [18, 26];
  const maxLeap = level <= 2 ? 1 : 2;

  const dias = [];
  let d = loDia + Math.floor(rng() * (hiDia - loDia + 1));
  for (let i = 0; i < spec.notes; i++) {
    dias.push(d);
    let step = 0;
    while (step === 0) step = Math.floor(rng() * (maxLeap * 2 + 1)) - maxLeap;
    d += step;
    // Reflect off the window rather than clamping: clamping makes passages
    // stick to an edge and repeat the same two notes.
    if (d > hiDia) d = hiDia - (d - hiDia);
    if (d < loDia) d = loDia + (loDia - d);
    d = Math.max(loDia, Math.min(hiDia, d));
  }

  const notes = dias.map((x) => diatonicToMidi(x, alter));
  return {
    seed,
    game: "reading",
    level,
    key,
    clef,
    bars: spec.bars,
    seconds: spec.seconds,
    dias,
    notes,
    // `answers` is the engine's vocabulary: one entry per thing the player must
    // get right, whatever the game. Here they are pitches; in Chord Race they
    // are quality names. The engine never needs to know which.
    answers: notes,
  };
}
