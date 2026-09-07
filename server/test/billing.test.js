import test from "node:test";
import assert from "node:assert/strict";

import {
  PRICE_CENTS, STATUS, newSubscription, requestCancel, resume, advancePeriod,
  paymentFailed, paymentRecovered, graceExpired, isEntitled, describe,
} from "../src/billing/subscription.js";
import { handleWebhook, normalise, sweep, EVENT } from "../src/billing/webhooks.js";
import { createMemoryStore } from "../src/store/memory.js";

const DAY = 864e5;
const T0 = Date.UTC(2026, 0, 1);
const stripeSub = (now = T0) =>
  newSubscription({ userId: "u1", provider: "stripe", providerSubscriptionId: "sub_1", now });

test("price is $5.95", () => {
  assert.equal(PRICE_CENTS, 595);
  assert.equal(stripeSub().price_cents, 595);
});

test("a new subscription is active and entitled", () => {
  const s = stripeSub();
  assert.equal(s.status, STATUS.ACTIVE);
  assert.ok(isEntitled(s, T0));
});

test("cancelling does NOT revoke access — it runs to period end", () => {
  const s = stripeSub();
  const { ok, subscription } = requestCancel(s, T0 + DAY);
  assert.ok(ok);
  assert.equal(subscription.status, STATUS.CANCEL_PENDING);
  assert.equal(subscription.cancel_at_period_end, true);

  // Still entitled the instant after cancelling, and the day before period end.
  assert.ok(isEntitled(subscription, T0 + DAY));
  assert.ok(isEntitled(subscription, subscription.current_period_end - 1));
  // And not after.
  assert.ok(!isEntitled(subscription, subscription.current_period_end));
});

test("cancel then resume before period end restores the subscription", () => {
  const cancelled = requestCancel(stripeSub(), T0 + DAY).subscription;
  const { ok, subscription } = resume(cancelled, T0 + 2 * DAY);
  assert.ok(ok);
  assert.equal(subscription.status, STATUS.ACTIVE);
  assert.equal(subscription.cancel_at_period_end, false);
  assert.equal(subscription.cancelled_at, null);
});

test("resume is refused once the period has ended", () => {
  const cancelled = requestCancel(stripeSub(), T0).subscription;
  const r = resume(cancelled, cancelled.current_period_end + 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "period_already_ended");
});

test("Apple and Google cannot be cancelled server-side — the API says so and hands back a URL", () => {
  for (const provider of ["apple_app_store", "google_play"]) {
    const s = newSubscription({ userId: "u1", provider, providerSubscriptionId: "x" });
    const r = requestCancel(s);
    assert.equal(r.ok, false, `${provider} must not report a server-side cancel`);
    assert.equal(r.reason, "provider_managed");
    assert.match(r.manageUrl, /^https:\/\//);
    // Crucially the subscription is UNCHANGED — no local state pretending it cancelled.
    assert.equal(r.subscription.status, STATUS.ACTIVE);
    assert.equal(r.subscription.cancel_at_period_end, false);
  }
});

test("period end expires a cancelled subscription and renews an active one", () => {
  const active = stripeSub();
  const renewed = advancePeriod(active, active.current_period_end);
  assert.equal(renewed.status, STATUS.ACTIVE);
  assert.equal(renewed.current_period_start, active.current_period_end);

  const cancelled = requestCancel(active, T0).subscription;
  const expired = advancePeriod(cancelled, cancelled.current_period_end);
  assert.equal(expired.status, STATUS.EXPIRED);
  assert.ok(!isEntitled(expired, cancelled.current_period_end));
});

test("advancePeriod before the boundary is a no-op, so the sweep is safe to run often", () => {
  const s = stripeSub();
  assert.equal(advancePeriod(s, T0 + DAY), s);
});

test("a failed payment keeps access during grace, and expires when grace runs out", () => {
  const s = stripeSub();
  const failing = paymentFailed(s, T0 + DAY);
  assert.equal(failing.status, STATUS.GRACE_PERIOD);
  assert.ok(isEntitled(failing, T0 + 2 * DAY), "grace must not cut a paying user off mid-retry");

  const recovered = paymentRecovered(failing, T0 + 3 * DAY);
  assert.equal(recovered.status, STATUS.ACTIVE);
  assert.equal(recovered.grace_ends_at, null);

  const dead = graceExpired(failing, failing.grace_ends_at);
  assert.equal(dead.status, STATUS.EXPIRED);
  assert.ok(!isEntitled(dead, failing.grace_ends_at));
});

test("grace start time does not reset on repeated failures", () => {
  const a = paymentFailed(stripeSub(), T0);
  const b = paymentFailed(a, T0 + 3 * DAY);
  assert.equal(b.grace_ends_at, a.grace_ends_at, "a second failure must not extend the grace window");
});

test("describe() gives the Profile screen everything, without it reimplementing the rules", () => {
  const cancelled = requestCancel(stripeSub(), T0).subscription;
  const d = describe(cancelled, T0 + DAY);
  assert.equal(d.plan, "paid");
  assert.equal(d.entitled, true);
  assert.equal(d.accessUntil, cancelled.current_period_end);
  assert.equal(d.renewsAt, null);
  assert.equal(d.canResume, true);

  const apple = newSubscription({ userId: "u", provider: "apple_app_store", providerSubscriptionId: "a" });
  const ad = describe(apple, T0);
  assert.equal(ad.canCancelHere, false);
  assert.equal(ad.purchasedOn, "App Store");
  assert.match(ad.manageUrl, /apple\.com/);

  assert.equal(describe(null).plan, "free");
});

// ------------------------------------------------------------------ webhooks

test("stripe cancel/uncancel is read from the flag, not the event name", () => {
  const a = normalise("stripe", { id: "e1", type: "customer.subscription.updated", cancel_at_period_end: true });
  assert.equal(a.type, EVENT.CANCELLED);
  const b = normalise("stripe", { id: "e2", type: "customer.subscription.updated", cancel_at_period_end: false });
  assert.equal(b.type, EVENT.UNCANCELLED);
});

test("an unmapped provider event is acknowledged, not treated as an error", async () => {
  const store = createMemoryStore();
  await store.putSubscription(stripeSub());
  const r = await handleWebhook(store, "stripe", {
    id: "e_new", type: "customer.subscription.trial_will_end", providerSubscriptionId: "sub_1",
  });
  assert.equal(r.applied, false);
  assert.equal(r.ignored, true);
  assert.equal(r.reason, "unmapped_event");
});

test("a replayed webhook is applied exactly once", async () => {
  const store = createMemoryStore();
  await store.putSubscription(stripeSub());

  const event = { id: "evt_renew_1", type: "invoice.payment_succeeded", providerSubscriptionId: "sub_1" };
  const first = await handleWebhook(store, "stripe", event, T0 + 31 * DAY);
  assert.equal(first.applied, true);
  const endAfterFirst = first.subscription.current_period_end;

  const second = await handleWebhook(store, "stripe", event, T0 + 31 * DAY);
  assert.equal(second.duplicate, true);
  assert.equal(second.applied, false);

  const stored = await store.getSubscription("u1");
  assert.equal(stored.current_period_end, endAfterFirst,
    "a replayed renewal must not extend the period a second time");
});

test("a webhook for an unknown subscription is recorded, so it stops being retried", async () => {
  const store = createMemoryStore();
  const r = await handleWebhook(store, "stripe", {
    id: "evt_orphan", type: "invoice.payment_succeeded", providerSubscriptionId: "sub_missing",
  });
  assert.equal(r.ignored, true);
  assert.equal(r.reason, "unknown_subscription");
  assert.ok(await store.hasProcessedEvent("evt_orphan"));
});

test("a store cancellation arrives by webhook and is honoured", async () => {
  const store = createMemoryStore();
  await store.putSubscription(
    newSubscription({ userId: "u2", provider: "google_play", providerSubscriptionId: "g1", now: T0 })
  );
  const r = await handleWebhook(store, "google_play", {
    id: "g_evt_1", type: "SUBSCRIPTION_CANCELED", providerSubscriptionId: "g1",
  }, T0 + DAY);
  assert.equal(r.applied, true);
  assert.equal(r.subscription.status, STATUS.CANCEL_PENDING);
  assert.ok(isEntitled(r.subscription, T0 + DAY), "a store cancel still runs to period end");
});

test("the sweep catches a missed period end", async () => {
  const store = createMemoryStore();
  const cancelled = requestCancel(stripeSub(), T0).subscription;
  await store.putSubscription(cancelled);

  // No webhook ever arrives.
  const changed = await sweep(store, cancelled.current_period_end + DAY);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status, STATUS.EXPIRED);

  const again = await sweep(store, cancelled.current_period_end + 2 * DAY);
  assert.equal(again.length, 0, "the sweep must be idempotent");
});

test("full lifecycle: subscribe, cancel, keep access, expire, resubscribe", async () => {
  const store = createMemoryStore();
  let s = stripeSub();
  await store.putSubscription(s);
  assert.ok(isEntitled(s, T0));

  s = requestCancel(s, T0 + 5 * DAY).subscription;
  await store.putSubscription(s);
  assert.ok(isEntitled(s, T0 + 29 * DAY), "still paid up on day 29");

  await sweep(store, s.current_period_end + 1);
  s = await store.getSubscription("u1");
  assert.equal(s.status, STATUS.EXPIRED);
  assert.ok(!isEntitled(s, s.current_period_end + 1));

  const fresh = newSubscription({ userId: "u1", provider: "stripe", providerSubscriptionId: "sub_2", now: s.current_period_end + DAY });
  await store.putSubscription(fresh);
  assert.ok(isEntitled(await store.getSubscription("u1"), fresh.current_period_start));
});
