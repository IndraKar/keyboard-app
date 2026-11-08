import test from "node:test";
import assert from "node:assert/strict";

import { mergeProgress, normaliseProgress, spentOnUnlocks, TIER_COST } from "../src/progress/merge.js";
import { createMemoryStore } from "../src/store/memory.js";
import { createPostgresStore } from "../src/store/postgres.js";

const base = (over = {}) => normaliseProgress(Object.assign({
  lifetimeXp: 0, exercisesDone: 0, unlocked: { ear:1, sight:1, keys:1, repeat:1 },
}, over));

// --------------------------------------------------------------- derived XP

test("spendable XP is derived from lifetime minus what tiers cost", () => {
  const p = normaliseProgress({ lifetimeXp: 3000, unlocked: { ear: 3, sight: 1, keys: 1, repeat: 1 } });
  // ear tier 2 (750) + tier 3 (1250) = 2000 spent
  assert.equal(spentOnUnlocks(p.unlocked), TIER_COST[2] + TIER_COST[3]);
  assert.equal(p.xp, 1000);
  assert.equal(p.lifetimeXp, 3000, "lifetime is never reduced by spending");
});

test("spendable XP never goes negative, even if the tier prices changed", () => {
  const p = normaliseProgress({ lifetimeXp: 10, unlocked: { ear: 4, sight: 4, keys: 4, repeat: 4 } });
  assert.equal(p.xp, 0, "an existing player must not be left owing XP");
});

// ------------------------------------------------------------------ merging

test("merging takes the higher of every counter that only goes up", () => {
  const phone = base({ lifetimeXp: 900, exercisesDone: 12, practiceSeconds: 600,
                       tierCorrect: { keys: [5, 0, 0, 0] }, compWins: 2 });
  const laptop = base({ lifetimeXp: 750, exercisesDone: 15, practiceSeconds: 400,
                        tierCorrect: { keys: [3, 4, 0, 0] }, compWins: 1 });
  const m = mergeProgress(phone, laptop);
  assert.equal(m.lifetimeXp, 900);
  assert.equal(m.exercisesDone, 15);
  assert.equal(m.practiceSeconds, 600);
  assert.deepEqual(m.tierCorrect.keys, [5, 4, 0, 0], "each cell independently, so neither device loses a tier");
  assert.equal(m.compWins, 2);
});

test("merging is commutative — the order two devices sync in cannot matter", () => {
  const a = base({ lifetimeXp: 900, unlocked: { ear:2, sight:1, keys:3, repeat:1 },
                   tierCorrect: { ear: [12, 2, 0, 0] }, badges: { ear_master: 100 } });
  const b = base({ lifetimeXp: 1200, unlocked: { ear:1, sight:4, keys:2, repeat:1 },
                   tierCorrect: { ear: [7, 9, 0, 0] }, badges: { ear_master: 50, keys_master: 70 } });
  assert.deepEqual(mergeProgress(a, b), mergeProgress(b, a));
});

test("merging is idempotent — a retried save changes nothing", () => {
  const a = base({ lifetimeXp: 525, exercisesDone: 7, tierCorrect: { sight: [7, 0, 0, 0] } });
  const once = mergeProgress(null, a);
  assert.deepEqual(mergeProgress(once, a), once);
  assert.deepEqual(mergeProgress(once, once), once);
});

test("an unlocked tier stays unlocked after a merge with a device that has not seen it", () => {
  const unlockedOnPhone = base({ lifetimeXp: 2000, unlocked: { ear: 3, sight:1, keys:1, repeat:1 } });
  const staleLaptop = base({ lifetimeXp: 2000, unlocked: { ear: 1, sight:1, keys:1, repeat:1 } });
  const m = mergeProgress(unlockedOnPhone, staleLaptop);
  assert.equal(m.unlocked.ear, 3, "a tier that was paid for cannot be taken back");
  assert.equal(m.xp, 0, "and it is still charged for exactly once");
});

test("a badge earned on either device is earned, keeping the earlier moment", () => {
  const m = mergeProgress(
    base({ badges: { perfect: 2000 } }),
    base({ badges: { perfect: 1000, hundred: 3000 } })
  );
  assert.equal(m.badges.perfect, 1000);
  assert.equal(m.badges.hundred, 3000);
});

test("merging with nothing stored yields the incoming copy", () => {
  const a = base({ lifetimeXp: 300 });
  assert.deepEqual(mergeProgress(null, a), a);
  assert.deepEqual(mergeProgress(a, null), a);
  assert.equal(mergeProgress(null, null), null);
});

// ------------------------------------------------- hostile / malformed input

test("rubbish from a client cannot corrupt the stored shape", () => {
  const p = normaliseProgress({
    lifetimeXp: "9999999999999999999999", exercisesDone: -5, practiceSeconds: NaN,
    unlocked: { ear: 99, sight: -3, keys: null, nonsense: 7 },
    tierCorrect: { ear: "not an array", keys: [1, "x", null, 4] },
    badges: { real: 123, fake: "yesterday" },
    xp: 999999,
  });
  /* 1 correct at tier 1 (75) + 4 at tier 4 (600) = 675: the garbage lifetime is
     discarded and the figure comes from the work on record instead. */
  assert.equal(p.lifetimeXp, 675, "a non-numeric lifetime falls back to the derivation, never NaN");
  assert.equal(p.exercisesDone, 0, "negatives are clamped");
  assert.equal(p.practiceSeconds, 0);
  assert.equal(p.unlocked.ear, 4, "tiers are clamped to the real ladder");
  assert.equal(p.unlocked.sight, 1);
  assert.equal(p.unlocked.keys, 1);
  assert.equal(p.unlocked.nonsense, undefined, "unknown categories are dropped");
  assert.deepEqual(p.tierCorrect.ear, [0, 0, 0, 0]);
  assert.deepEqual(p.tierCorrect.keys, [1, 0, 0, 4]);
  assert.deepEqual(p.badges, { real: 123 }, "a badge without a real timestamp is not a badge");
  assert.equal(p.xp, 0, "spendable XP is recomputed, never taken from the client");
});

test("a client cannot set its own spendable XP", () => {
  const p = normaliseProgress({ lifetimeXp: 100, xp: 5_000_000, unlocked: { ear:1, sight:1, keys:1, repeat:1 } });
  assert.equal(p.xp, 100, "xp comes from lifetime minus spend, whatever the client sent");
});

/*
  Worth being plain about: the server does not witness solo practice, so it
  cannot tell an honest tierCorrect from an invented one. A client that lies
  about the work it did gets the XP for it. Competition is different — the
  server holds the passage and rules on every answer — and solo practice would
  need the same treatment to be cheat-resistant. Deriving XP from the work at
  least makes the two consistent, so there is one number to defend later rather
  than two that can disagree.
*/
test("XP always equals the work on record, so the two cannot drift apart", () => {
  const p = normaliseProgress({ lifetimeXp: 0, tierCorrect: { keys: [10, 4, 0, 0] } });
  assert.equal(p.lifetimeXp, 10 * 75 + 4 * 100);
});

test("two devices earning offline ADD UP — the case max-merging got wrong", () => {
  // Each plays five tier-1 exercises in a different category: 375 apiece.
  const phone  = normaliseProgress({ tierCorrect: { keys:  [5,0,0,0] } });
  const laptop = normaliseProgress({ tierCorrect: { sight: [5,0,0,0] } });
  assert.equal(phone.lifetimeXp, 375);
  assert.equal(laptop.lifetimeXp, 375);

  const m = mergeProgress(phone, laptop);
  assert.equal(m.lifetimeXp, 750, "taking the higher of the two would delete half the evening");
  assert.deepEqual(mergeProgress(laptop, phone), m, "and it still does not depend on who syncs first");
});

test("Master Mode XP survives the merge even though it has no tier row", () => {
  const a = normaliseProgress({ masterCorrect: 8 });
  assert.equal(a.lifetimeXp, 8 * 150, "master pays tier-4 rates");
  assert.equal(mergeProgress(a, normaliseProgress({ tierCorrect: { ear: [4,0,0,0] } })).lifetimeXp,
    8 * 150 + 4 * 75);
});

test("XP earned under an older scheme is never reduced by the derivation", () => {
  const legacy = normaliseProgress({ lifetimeXp: 5000, tierCorrect: {} });
  assert.equal(legacy.lifetimeXp, 5000, "no record of the work, but the player still earned it");
});

// ----------------------------------------------------------------- the store

test("the memory store round-trips progress", async () => {
  const store = createMemoryStore();
  assert.equal(await store.getProgress("u1"), null);
  const p = base({ lifetimeXp: 450 });
  await store.putProgress("u1", p, p.lifetimeXp);
  assert.deepEqual(await store.getProgress("u1"), p);
});

function fakePool(rowsFor = () => []) {
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push({ text: text.replace(/\s+/g, " ").trim(), params });
      const rows = rowsFor(text, params) || [];
      return { rows, rowCount: rows.length };
    },
  };
}

test("the postgres write refuses to roll progress backwards", async () => {
  const pool = fakePool(() => [{ payload: { lifetimeXp: 900 } }]);
  const store = await createPostgresStore({ pool });
  await store.putProgress("u1", { lifetimeXp: 900 }, 900);
  const sql = pool.queries[0].text;
  assert.match(sql, /INSERT INTO user_progress/);
  assert.match(sql, /ON CONFLICT \(user_id\) DO UPDATE/);
  assert.match(sql, /WHERE user_progress\.lifetime_xp <= EXCLUDED\.lifetime_xp/,
    "a slow request carrying stale progress must not overwrite a newer one");
});

test("when a concurrent write was further ahead, the stored copy is returned", async () => {
  // No RETURNING row means the guard rejected our write; the follow-up SELECT wins.
  let call = 0;
  const pool = fakePool(() => (++call === 1 ? [] : [{ payload: { lifetimeXp: 5000 } }]));
  const store = await createPostgresStore({ pool });
  const got = await store.putProgress("u1", { lifetimeXp: 10 }, 10);
  assert.equal(got.lifetimeXp, 5000, "we report what is actually stored, not what we tried to store");
});
