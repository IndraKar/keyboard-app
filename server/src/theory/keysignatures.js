/**
 * Key signatures — the shared theory table.
 *
 * Used by the Key Signatures curriculum category and by the Competition game of
 * the same name. It lives on its own because getting this wrong is silent: an
 * app that teaches that B major has four sharps produces students who are
 * confidently incorrect, and nothing in the code would ever throw.
 *
 * Everything except the fifteen tonics is DERIVED. The accidentals in a
 * signature, the notes of the scale, the relative minor's spelling — all come
 * out of the sharp/flat order and the tonic letter, so there is no second copy
 * of the theory that can drift from the first.
 */

/** The order accidentals are written in a signature, and never any other. */
export const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
export const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];

const LETTERS = "CDEFGAB";
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const GLYPH = { 1: "♯", [-1]: "♭", 0: "" }; // ♯ ♭

/**
 * The fifteen key signatures. Seven sharps through seven flats, each with its
 * major and relative-minor tonic. C♯/A♯ and C♭/A♭ are included: they are real
 * signatures a reader meets, and a "most complex" tier that stopped at five
 * accidentals would be missing exactly the ones that are hard.
 *
 * `alter` on a tonic is the accidental in ITS OWN name (F♯ major's tonic is F
 * sharpened), which is not the same thing as the signature's contents.
 */
export const KEYS = [
  { id: "C",  sharps: 0, flats: 0, major: { letter: "C", alter: 0 },  minor: { letter: "A", alter: 0 } },
  { id: "G",  sharps: 1, flats: 0, major: { letter: "G", alter: 0 },  minor: { letter: "E", alter: 0 } },
  { id: "D",  sharps: 2, flats: 0, major: { letter: "D", alter: 0 },  minor: { letter: "B", alter: 0 } },
  { id: "A",  sharps: 3, flats: 0, major: { letter: "A", alter: 0 },  minor: { letter: "F", alter: 1 } },
  { id: "E",  sharps: 4, flats: 0, major: { letter: "E", alter: 0 },  minor: { letter: "C", alter: 1 } },
  { id: "B",  sharps: 5, flats: 0, major: { letter: "B", alter: 0 },  minor: { letter: "G", alter: 1 } },
  { id: "F#", sharps: 6, flats: 0, major: { letter: "F", alter: 1 },  minor: { letter: "D", alter: 1 } },
  { id: "C#", sharps: 7, flats: 0, major: { letter: "C", alter: 1 },  minor: { letter: "A", alter: 1 } },
  { id: "F",  sharps: 0, flats: 1, major: { letter: "F", alter: 0 },  minor: { letter: "D", alter: 0 } },
  { id: "Bb", sharps: 0, flats: 2, major: { letter: "B", alter: -1 }, minor: { letter: "G", alter: 0 } },
  { id: "Eb", sharps: 0, flats: 3, major: { letter: "E", alter: -1 }, minor: { letter: "C", alter: 0 } },
  { id: "Ab", sharps: 0, flats: 4, major: { letter: "A", alter: -1 }, minor: { letter: "F", alter: 0 } },
  { id: "Db", sharps: 0, flats: 5, major: { letter: "D", alter: -1 }, minor: { letter: "B", alter: -1 } },
  { id: "Gb", sharps: 0, flats: 6, major: { letter: "G", alter: -1 }, minor: { letter: "E", alter: -1 } },
  { id: "Cb", sharps: 0, flats: 7, major: { letter: "C", alter: -1 }, minor: { letter: "A", alter: -1 } },
];

const BY_ID = new Map(KEYS.map((k) => [k.id, k]));
export function keyById(id) {
  const k = BY_ID.get(id);
  if (!k) throw new Error(`no such key signature: ${id}`);
  return k;
}

/** Note name for a letter + alteration, e.g. ("F", 1) → "F♯". */
export function noteName(letter, alter) {
  if (alter === 2) return letter + "♯♯";
  if (alter === -2) return letter + "♭♭";
  return letter + (GLYPH[alter] ?? "");
}

/** Plain-ASCII name, for ids and test assertions: ("F", 1) → "F#". */
export function asciiName(letter, alter) {
  return letter + (alter > 0 ? "#".repeat(alter) : alter < 0 ? "b".repeat(-alter) : "");
}

/**
 * Which letters the signature alters, and by how much.
 * Returns e.g. {F:1, C:1} for D major — the map every generator reads.
 */
export function alterationsOf(key) {
  const k = typeof key === "string" ? keyById(key) : key;
  const out = {};
  for (let i = 0; i < k.sharps; i++) out[SHARP_ORDER[i]] = 1;
  for (let i = 0; i < k.flats; i++) out[FLAT_ORDER[i]] = -1;
  return out;
}

/** The accidentals in writing order, for drawing the signature on a staff. */
export function signatureGlyphs(key) {
  const k = typeof key === "string" ? keyById(key) : key;
  const order = k.sharps ? SHARP_ORDER.slice(0, k.sharps) : FLAT_ORDER.slice(0, k.flats);
  return order.map((letter) => ({ letter, alter: k.sharps ? 1 : -1 }));
}

export const accidentalCount = (key) => {
  const k = typeof key === "string" ? keyById(key) : key;
  return k.sharps + k.flats;
};

/**
 * The scale, spelled through the signature.
 *
 * This is the answer to "check what notes are first and last in the scale":
 * both are the tonic, which is exactly how a reader identifies the key of a
 * written scale. Seven letters from the tonic, each carrying whatever the
 * signature says — no separate table, so C♯ major comes out as
 * C♯ D♯ E♯ F♯ G♯ A♯ B♯ rather than something with a stray natural in it.
 */
export function scaleOf(key, mode = "major") {
  const k = typeof key === "string" ? keyById(key) : key;
  const alter = alterationsOf(k);
  const tonic = k[mode];
  const start = LETTERS.indexOf(tonic.letter);
  const notes = [];
  for (let i = 0; i < 7; i++) {
    const letter = LETTERS[(start + i) % 7];
    notes.push({ letter, alter: alter[letter] ?? 0 });
  }
  notes.push({ ...notes[0] }); // the octave: first note and last note are the tonic
  return notes;
}

export const scaleNames = (key, mode = "major") => scaleOf(key, mode).map((n) => noteName(n.letter, n.alter));

/** Sounding pitches for a scale, ascending from `startMidi`'s octave. */
export function scaleMidi(key, mode = "major", startOctave = 4) {
  const notes = scaleOf(key, mode);
  const out = [];
  let octave = startOctave;
  let prevIndex = -1;
  for (const n of notes) {
    const idx = LETTERS.indexOf(n.letter);
    if (prevIndex !== -1 && idx <= prevIndex) octave += 1; // wrapped past B
    prevIndex = idx;
    out.push((octave + 1) * 12 + LETTER_PC[n.letter] + n.alter);
  }
  return out;
}

/** "C major / A minor" — the label, because a signature names both at once. */
export function keyLabel(key) {
  const k = typeof key === "string" ? keyById(key) : key;
  return `${noteName(k.major.letter, k.major.alter)} major / ${noteName(k.minor.letter, k.minor.alter)} minor`;
}

/** "two sharps", "one flat", "no sharps or flats" — for teaching the answer. */
export function signatureDescription(key) {
  const k = typeof key === "string" ? keyById(key) : key;
  const n = k.sharps || k.flats;
  if (!n) return "no sharps or flats";
  const words = ["", "one", "two", "three", "four", "five", "six", "seven"];
  return `${words[n]} ${k.sharps ? "sharp" : "flat"}${n > 1 ? "s" : ""}`;
}

/**
 * The four tiers, exactly as specified.
 *
 * Tier 1 is the three signatures a beginner meets first. Tier 2 adds the ones
 * whose relative minors are themselves sharpened (F♯, G♯, C♯ minor), which is
 * the first genuinely confusing step. Tier 3 is everything else — the six- and
 * seven-accidental keys and the flat side beyond F. Tier 4 is all fifteen at
 * once, which is a different skill again: not recalling one signature but
 * telling fifteen apart under time pressure.
 */
export const KEY_TIERS = {
  1: ["C", "G", "D"],
  2: ["A", "B", "F", "E"],
  3: ["F#", "C#", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"],
  4: KEYS.map((k) => k.id),
};

export function tierPool(tier) {
  const pool = KEY_TIERS[tier];
  if (!pool) throw new Error(`no such key-signature tier: ${tier}`);
  return pool.map(keyById);
}
