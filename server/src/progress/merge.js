/**
 * Merging two copies of a player's progress.
 *
 * Two devices, or one device and the server, can each hold a version the other
 * has not seen. Last-write-wins would throw away whichever session finished
 * second, which for a learning app means silently deleting lessons somebody
 * actually played.
 *
 * So nothing here depends on which copy is "newer":
 *
 *  - Counters that only ever go up — lifetime XP, exercises done, per-tier
 *    clears, best streaks, badges — take the HIGHER of the two. Merging is then
 *    commutative and idempotent: the order the copies arrive in cannot change
 *    the result, and merging twice is the same as merging once.
 *
 *  - SPENDABLE XP IS NOT STORED. It is recomputed as lifetime XP minus what the
 *    unlocked tiers cost. It is the one figure that goes down, so merging it
 *    directly would either resurrect spent XP or charge for a tier twice;
 *    deriving it removes the conflict rather than resolving it.
 */

/** Must match TIER_COST in the client. A tier costs this once, per category. */
export const TIER_COST = { 1: 0, 2: 750, 3: 1250, 4: 2000 };
/** Must match TIER_XP in the client: what one correct exercise is worth. */
export const TIER_XP = { 1: 75, 2: 100, 3: 125, 4: 150 };
export const CATEGORIES = ["ear", "sight", "keys", "repeat"];

const num = (v) => (Number.isFinite(v) ? v : 0);
const maxNum = (a, b) => Math.max(num(a), num(b));

/** What every tier currently unlocked has cost, across all categories. */
export function spentOnUnlocks(unlocked = {}) {
  let spent = 0;
  for (const cat of CATEGORIES) {
    const upTo = Math.max(1, Math.min(4, num(unlocked[cat]) || 1));
    for (let t = 1; t <= upTo; t++) spent += TIER_COST[t];
  }
  return spent;
}

/**
 * Lifetime XP implied by the work recorded.
 *
 * Taking the higher of two lifetime totals is wrong, and it is the one place
 * max-merging fails: two devices that each earn 375 while offline have earned
 * 750 between them, and max reports 375 — half the player's evening deleted.
 *
 * Per-tier counters do not have that problem, because they are separate cells
 * that merge independently. So lifetime XP is derived from them instead of
 * being merged, exactly as spendable XP is derived rather than merged.
 */
export function derivedLifetimeXp(p = {}) {
  let xp = 0;
  for (const cat of CATEGORIES) {
    const row = Array.isArray(p.tierCorrect?.[cat]) ? p.tierCorrect[cat] : [];
    for (let t = 1; t <= 4; t++) xp += num(row[t - 1]) * TIER_XP[t];
  }
  /* Master Mode pays tier-4 rates and has no tier row of its own. */
  xp += num(p.masterCorrect) * TIER_XP[4];
  return xp;
}

function mergeCounterMap(a = {}, b = {}) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) out[k] = maxNum(a?.[k], b?.[k]);
  return out;
}

function mergeTierCorrect(a = {}, b = {}) {
  const out = {};
  const cats = new Set([...CATEGORIES, ...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const cat of cats) {
    const x = Array.isArray(a?.[cat]) ? a[cat] : [];
    const y = Array.isArray(b?.[cat]) ? b[cat] : [];
    out[cat] = [0, 1, 2, 3].map((i) => maxNum(x[i], y[i]));
  }
  return out;
}

/**
 * Merge two progress payloads. Either may be null.
 * Commutative and idempotent: merge(a,b) equals merge(b,a), merge(a,a) equals a.
 */
export function mergeProgress(a, b) {
  if (!a) return b ? normaliseProgress(b) : null;
  if (!b) return normaliseProgress(a);

  const unlocked = {};
  for (const cat of CATEGORIES) {
    unlocked[cat] = Math.max(1, Math.min(4, maxNum(a.unlocked?.[cat] || 1, b.unlocked?.[cat] || 1)));
  }

  return normaliseProgress({
    lifetimeXp: maxNum(a.lifetimeXp, b.lifetimeXp),
    exercisesDone: maxNum(a.exercisesDone, b.exercisesDone),
    exercisesCorrect: maxNum(a.exercisesCorrect, b.exercisesCorrect),
    practiceSeconds: maxNum(a.practiceSeconds, b.practiceSeconds),
    perfectSessions: maxNum(a.perfectSessions, b.perfectSessions),
    masterRuns: maxNum(a.masterRuns, b.masterRuns),
    compWins: maxNum(a.compWins, b.compWins),
    compPlayed: maxNum(a.compPlayed, b.compPlayed),
    compBestNotes: maxNum(a.compBestNotes, b.compBestNotes),
    masterCorrect: maxNum(a.masterCorrect, b.masterCorrect),
    unlocked,
    tierCorrect: mergeTierCorrect(a.tierCorrect, b.tierCorrect),
    perfectByCat: mergeCounterMap(a.perfectByCat, b.perfectByCat),
    masterBest: mergeCounterMap(a.masterBest, b.masterBest),
    /* A badge earned on either device is earned. Keep the earlier timestamp:
       the achievement happened when it happened. */
    badges: (() => {
      const out = {};
      for (const k of new Set([...Object.keys(a.badges || {}), ...Object.keys(b.badges || {})])) {
        const x = a.badges?.[k], y = b.badges?.[k];
        out[k] = x && y ? Math.min(x, y) : (x || y);
      }
      return out;
    })(),
  });
}

/** Fill in defaults and derive spendable XP. Safe on untrusted input. */
export function normaliseProgress(p = {}) {
  const unlocked = {};
  for (const cat of CATEGORIES) {
    unlocked[cat] = Math.max(1, Math.min(4, Math.floor(num(p.unlocked?.[cat])) || 1));
  }
  const out = {
    /* Replaced below by the higher of what was reported and what the recorded
       work implies — see derivedLifetimeXp. */
    lifetimeXp: Math.max(0, Math.floor(num(p.lifetimeXp))),
    exercisesDone: Math.max(0, Math.floor(num(p.exercisesDone))),
    exercisesCorrect: Math.max(0, Math.floor(num(p.exercisesCorrect))),
    practiceSeconds: Math.max(0, Math.floor(num(p.practiceSeconds))),
    perfectSessions: Math.max(0, Math.floor(num(p.perfectSessions))),
    masterRuns: Math.max(0, Math.floor(num(p.masterRuns))),
    compWins: Math.max(0, Math.floor(num(p.compWins))),
    compPlayed: Math.max(0, Math.floor(num(p.compPlayed))),
    compBestNotes: Math.max(0, Math.floor(num(p.compBestNotes))),
    masterCorrect: Math.max(0, Math.floor(num(p.masterCorrect))),
    unlocked,
    tierCorrect: mergeTierCorrect(p.tierCorrect, {}),
    perfectByCat: mergeCounterMap(p.perfectByCat, {}),
    masterBest: mergeCounterMap(p.masterBest, {}),
    badges: Object.fromEntries(Object.entries(p.badges || {}).filter(([, v]) => Number.isFinite(v))),
  };
  /* Never lower than the work on record, so two devices earning in parallel
     add up; never lower than what was reported either, so a player who earned
     XP under an older scheme keeps it. */
  out.lifetimeXp = Math.max(out.lifetimeXp, derivedLifetimeXp(out));

  /* Derived, never stored. Clamped at zero: a tier table that changed under an
     existing player must not leave them owing XP. */
  out.xp = Math.max(0, out.lifetimeXp - spentOnUnlocks(out.unlocked));
  return out;
}

/** Guard against a client sending something enormous. */
export const MAX_PROGRESS_BYTES = 16 * 1024;
