/**
 * Profiles and account deletion.
 *
 * The deletion tests matter most: a delete that silently leaves a subscription
 * billing is a stranger's card being charged every month for an account that
 * no longer exists, with nothing left on our side showing it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createApp } from "../src/http/app.js";
import { createMemoryStore } from "../src/store/memory.js";
import { createMatchmaker } from "../src/competition/matchmaking.js";
import {
  validateDisplayName, validateAvatar, cleanDisplayName, displayNameFor,
  MAX_AVATAR_BYTES, MIN_DISPLAY_NAME, AVATAR_PRESET_IDS,
} from "../src/auth/profile.js";
import { newSubscription, STATUS } from "../src/billing/subscription.js";

const PNG = (bytes = 64) =>
  "data:image/png;base64," + Buffer.alloc(bytes, 7).toString("base64");

async function serve({ stripe = null } = {}) {
  const store = createMemoryStore();
  await store.upsertUserByIdentity({
    id: "u1", provider: "google", providerUserId: "g1",
    email: "a@b.c", emailVerified: true, name: "Ada Lovelace", now: Date.now(),
  });
  const app = createApp({
    store, stripe, matchmaker: createMatchmaker(),
    config: { devAuth: true, sessionSecret: "x".repeat(40) },
  });
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, r));
  const base = `http://127.0.0.1:${s.address().port}`;
  return {
    store, base,
    close: () => new Promise((r) => s.close(r)),
    async req(path, { method = "GET", body, user = "u1" } = {}) {
      const res = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer dev:${user}`,
                   ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      return { status: res.status, json };
    },
  };
}

/* ------------------------------------------------------------- the name */

test("a chosen name is kept apart from the provider's name", async () => {
  const s = await serve();
  try {
    let r = await s.req("/v1/profile");
    assert.equal(r.json.profile.name, "Ada Lovelace");
    assert.equal(r.json.profile.displayName, "Ada Lovelace", "falls back until one is picked");
    assert.equal(r.json.profile.hasChosenName, false);

    r = await s.req("/v1/profile", { method: "PUT", body: { displayName: "clefhanger" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.profile.displayName, "clefhanger");
    assert.equal(r.json.profile.name, "Ada Lovelace", "the provider's name is untouched");
    assert.equal(r.json.profile.hasChosenName, true);

    // Signing in again refreshes the provider's name and must NOT clobber the
    // gamertag — this is the whole reason they are separate columns.
    await s.store.upsertUserByIdentity({
      id: "ignored", provider: "google", providerUserId: "g1",
      email: "a@b.c", emailVerified: true, name: "Ada L. Byron", now: Date.now(),
    });
    r = await s.req("/v1/profile");
    assert.equal(r.json.profile.name, "Ada L. Byron");
    assert.equal(r.json.profile.displayName, "clefhanger", "the chosen name survives a re-login");
  } finally { await s.close(); }
});

test("names other players will see are cleaned, not trusted", async () => {
  // Direction-override characters can make a name render as something else
  // entirely, which is how one player impersonates another in a list.
  assert.equal(cleanDisplayName("ev‮il"), "evil");
  assert.equal(cleanDisplayName("  spaced   out  "), "spaced out");
  assert.equal(cleanDisplayName("line\u0000break"), "linebreak");
  assert.equal(cleanDisplayName("x".repeat(100)).length, 24);

  assert.equal(validateDisplayName("a").ok, false, `under ${MIN_DISPLAY_NAME} is refused`);
  assert.equal(validateDisplayName("   ").ok, false);
  assert.equal(validateDisplayName("Bo").ok, true);
});

test("a too-short name is refused by the API, not just the app", async () => {
  const s = await serve();
  try {
    const r = await s.req("/v1/profile", { method: "PUT", body: { displayName: "x" } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "too_short");
  } finally { await s.close(); }
});

/* ----------------------------------------------------------- the avatar */

test("avatars must be real images, and small ones", () => {
  assert.equal(validateAvatar(PNG()).ok, true);
  assert.equal(validateAvatar("data:image/jpeg;base64,/9j/4AAQ").ok, true);
  assert.equal(validateAvatar(null).ok, true, "clearing an avatar is allowed");
  assert.equal(validateAvatar("").ok, true);

  // Not an image, and the classic attempt at something executable.
  assert.equal(validateAvatar("https://example.com/me.png").ok, false);
  assert.equal(validateAvatar("javascript:alert(1)").ok, false);
  assert.equal(validateAvatar("data:text/html;base64,PHNjcmlwdD4=").ok, false);
  assert.equal(validateAvatar("data:image/svg+xml;base64,PHN2Zz4=").ok, false,
    "SVG can carry script, so it is not an avatar format");

  const huge = validateAvatar(PNG(MAX_AVATAR_BYTES + 1024));
  assert.equal(huge.ok, false);
  assert.equal(huge.reason, "avatar_too_large");
});

test("an avatar round-trips and can be cleared", async () => {
  const s = await serve();
  try {
    let r = await s.req("/v1/profile", { method: "PUT", body: { avatar: PNG() } });
    assert.equal(r.status, 200);
    assert.ok(r.json.profile.avatar.startsWith("data:image/png;base64,"));

    r = await s.req("/v1/profile", { method: "PUT", body: { displayName: "keys4days" } });
    assert.ok(r.json.profile.avatar, "changing the name must not drop the picture");

    r = await s.req("/v1/profile", { method: "PUT", body: { avatar: null } });
    assert.equal(r.json.profile.avatar, null);
    assert.equal(r.json.profile.displayName, "keys4days", "...and vice versa");
  } finally { await s.close(); }
});

test("an oversized avatar is refused with an explanation, not a raw 413", async () => {
  const s = await serve();
  try {
    // Just over the cap: this has to reach the validator and come back with a
    // message a person can act on. The avatar limit and the HTTP body limit
    // have to stay consistent for that to happen.
    const r = await s.req("/v1/profile", { method: "PUT", body: { avatar: PNG(MAX_AVATAR_BYTES + 512) } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "avatar_too_large");
    assert.match(r.json.message, /too large/i);
  } finally { await s.close(); }
});

test("a legal maximum-size avatar still fits through the request body limit", async () => {
  const s = await serve();
  try {
    const r = await s.req("/v1/profile", { method: "PUT", body: { avatar: PNG(MAX_AVATAR_BYTES - 512) } });
    assert.equal(r.status, 200, "the largest allowed avatar must actually be uploadable");
    assert.ok(r.json.profile.avatar);
  } finally { await s.close(); }
});

/* -------------------------------------------------------- deleting it all */

test("deleting an account removes the account, its progress and its subscription", async () => {
  const s = await serve();
  try {
    await s.req("/v1/progress", { method: "PUT", body: { lifetimeXp: 900 } });
    assert.ok(await s.store.getProgress("u1"));

    const r = await s.req("/v1/account", { method: "DELETE" });
    assert.equal(r.status, 200);
    assert.equal(r.json.deleted, true);

    assert.equal(await s.store.getUser("u1"), null);
    assert.equal(await s.store.getProgress("u1"), null);
    assert.equal(await s.store.getSubscription("u1"), null);
  } finally { await s.close(); }
});

test("a live subscription is cancelled BEFORE the account is deleted", async () => {
  const calls = [];
  const stripe = {
    cancelAtPeriodEnd: async (id) => { calls.push(id); return { ok: true }; },
  };
  const s = await serve({ stripe });
  try {
    await s.store.putSubscription(newSubscription({
      userId: "u1", provider: "stripe", providerSubscriptionId: "sub_live", now: Date.now(),
    }));

    const r = await s.req("/v1/account", { method: "DELETE" });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, ["sub_live"], "Stripe must be told before the row disappears");
    assert.equal(r.json.subscriptionCancelled, true);
    assert.equal(await s.store.getUser("u1"), null);
  } finally { await s.close(); }
});

test("if the cancel fails, NOTHING is deleted", async () => {
  const stripe = {
    cancelAtPeriodEnd: async () => { throw new Error("stripe is down"); },
  };
  const s = await serve({ stripe });
  try {
    await s.store.putSubscription(newSubscription({
      userId: "u1", provider: "stripe", providerSubscriptionId: "sub_live", now: Date.now(),
    }));

    const r = await s.req("/v1/account", { method: "DELETE" });
    assert.equal(r.status, 502);
    assert.equal(r.json.error, "cancel_failed");
    // The account survives. Deleting it here would leave a card being charged
    // every month with nothing on our side recording that it is happening.
    assert.ok(await s.store.getUser("u1"), "the account must survive a failed cancel");
    assert.ok(await s.store.getSubscription("u1"), "and so must the subscription record");
  } finally { await s.close(); }
});

test("a store-managed subscription blocks deletion with an explanation", async () => {
  const s = await serve();
  try {
    await s.store.putSubscription(newSubscription({
      userId: "u1", provider: "apple_app_store", providerSubscriptionId: "1000", now: Date.now(),
    }));
    const r = await s.req("/v1/account", { method: "DELETE" });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "provider_managed_subscription");
    assert.match(r.json.message, /App Store/);
    assert.ok(await s.store.getUser("u1"));
  } finally { await s.close(); }
});

test("an expired subscription is no obstacle", async () => {
  const s = await serve();
  try {
    const sub = newSubscription({
      userId: "u1", provider: "stripe", providerSubscriptionId: "sub_old", now: Date.now(),
    });
    await s.store.putSubscription({ ...sub, status: STATUS.EXPIRED });
    const r = await s.req("/v1/account", { method: "DELETE" });
    assert.equal(r.status, 200, "nothing is billing, so there is nothing to cancel");
    assert.equal(await s.store.getUser("u1"), null);
  } finally { await s.close(); }
});

test("after deletion the token is useless", async () => {
  const s = await serve();
  try {
    await s.req("/v1/account", { method: "DELETE" });
    const r = await s.req("/v1/profile");
    assert.equal(r.status, 404);
    assert.equal(r.json.error, "no_account");
  } finally { await s.close(); }
});

test("displayNameFor never returns an empty label", () => {
  assert.equal(displayNameFor({ display_name: "tag", name: "Real" }), "tag");
  assert.equal(displayNameFor({ display_name: "   ", name: "Real" }), "Real");
  assert.equal(displayNameFor({ display_name: null, name: null }), "Keyvoria player");
  assert.equal(displayNameFor(null), "Keyvoria player");
});

test("the drawn presets are stored as ids, and only known ones", () => {
  for (const id of AVATAR_PRESET_IDS) {
    const r = validateAvatar(id);
    assert.equal(r.ok, true, `${id} should be a valid avatar`);
    assert.equal(r.avatar, id, "stored as the id, not as an image");
  }
  // This column is rendered in other players' browsers, so it is an allowlist.
  assert.equal(validateAvatar("rocket-ship").ok, false);
  assert.equal(validateAvatar("<img onerror=1>").ok, false);
  assert.equal(validateAvatar("../../etc/passwd").ok, false);
});

test("a preset avatar round-trips through the API", async () => {
  const s = await serve();
  try {
    const r = await s.req("/v1/profile", { method: "PUT", body: { avatar: "rocket" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.profile.avatar, "rocket");

    const bad = await s.req("/v1/profile", { method: "PUT", body: { avatar: "not-a-preset" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, "bad_avatar");
  } finally { await s.close(); }
});
