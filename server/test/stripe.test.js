import test from "node:test";
import assert from "node:assert/strict";

import { createStripe, formEncode, StripeError } from "../src/billing/stripe.js";
import { normalise, handleWebhook, EVENT } from "../src/billing/webhooks.js";
import { createMemoryStore } from "../src/store/memory.js";
import { createPostgresStore } from "../src/store/postgres.js";
import { newSubscription, STATUS, isEntitled } from "../src/billing/subscription.js";

const T0 = Date.UTC(2026, 0, 1);
const SECS = (ms) => Math.floor(ms / 1000);

/** A fetch stand-in that records calls and replays canned responses. */
function fakeFetch(responses = []) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = responses[i++] ?? { status: 200, json: {} };
    return {
      ok: r.status < 400,
      status: r.status,
      text: async () => JSON.stringify(r.json),
    };
  };
  fn.calls = calls;
  return fn;
}

// --------------------------------------------------------------- form encoding

test("params are encoded the way Stripe expects, not as JSON", () => {
  assert.equal(formEncode({ mode: "subscription" }), "mode=subscription");
  assert.equal(
    formEncode({ line_items: [{ price: "price_1", quantity: 1 }] }),
    "line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1"
  );
  assert.equal(
    decodeURIComponent(formEncode({ subscription_data: { metadata: { keyvoria_user_id: "u1" } } })),
    "subscription_data[metadata][keyvoria_user_id]=u1"
  );
  // undefined must drop out rather than become the string "undefined"
  assert.equal(formEncode({ a: 1, b: undefined, c: null }), "a=1");
});

// ------------------------------------------------------------------ the client

test("creating a checkout session posts the right call", async () => {
  const f = fakeFetch([{ status: 200, json: { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" } }]);
  const stripe = createStripe({ secretKey: "sk_test_x", priceId: "price_123", fetchImpl: f });

  const s = await stripe.createCheckoutSession({
    userId: "u1", successUrl: "https://app/ok", cancelUrl: "https://app/no",
  });
  assert.equal(s.url, "https://checkout.stripe.com/c/pay/cs_1");

  const call = f.calls[0];
  assert.equal(call.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.authorization, "Bearer sk_test_x");
  assert.match(call.headers["content-type"], /x-www-form-urlencoded/);
  assert.ok(call.headers["idempotency-key"], "a dropped response must not double-subscribe");

  const body = decodeURIComponent(call.body);
  assert.match(body, /mode=subscription/);
  assert.match(body, /client_reference_id=u1/, "the webhook needs this to know whose subscription it is");
  assert.match(body, /line_items\[0\]\[price\]=price_123/);
});

test("a missing price id fails loudly rather than creating a free subscription", async () => {
  const stripe = createStripe({ secretKey: "sk_test_x", fetchImpl: fakeFetch() });
  await assert.rejects(() => stripe.createCheckoutSession({ userId: "u1" }), /STRIPE_PRICE_ID/);
});

test("a Stripe error surfaces its message and status", async () => {
  const f = fakeFetch([{ status: 400, json: { error: { message: "No such price: price_nope" } } }]);
  const stripe = createStripe({ secretKey: "sk_test_x", priceId: "price_nope", fetchImpl: f });
  await assert.rejects(
    () => stripe.createCheckoutSession({ userId: "u1" }),
    (e) => e instanceof StripeError && e.status === 400 && /No such price/.test(e.message)
  );
});

test("cancel and resume hit the subscription endpoint with the right flag", async () => {
  const f = fakeFetch([{ status: 200, json: {} }, { status: 200, json: {} }]);
  const stripe = createStripe({ secretKey: "sk_test_x", fetchImpl: f });
  await stripe.cancelAtPeriodEnd("sub_9");
  await stripe.resume("sub_9");
  assert.equal(f.calls[0].url, "https://api.stripe.com/v1/subscriptions/sub_9");
  assert.equal(decodeURIComponent(f.calls[0].body), "cancel_at_period_end=true");
  assert.equal(decodeURIComponent(f.calls[1].body), "cancel_at_period_end=false");
});

// ------------------------------------------------- REAL Stripe event payloads

/**
 * These fixtures are the shape Stripe actually delivers. The previous parser
 * read a flat `providerSubscriptionId` that Stripe has never sent — it passed
 * its own hand-written tests and would have failed on every live delivery.
 */
const checkoutCompleted = {
  id: "evt_checkout", type: "checkout.session.completed",
  data: { object: {
    object: "checkout.session", id: "cs_1", mode: "subscription",
    subscription: "sub_live_1", client_reference_id: "u_kay", customer: "cus_1",
  } },
};
const subscriptionUpdated = (cancel) => ({
  id: "evt_upd_" + cancel, type: "customer.subscription.updated",
  data: { object: {
    object: "subscription", id: "sub_live_1",
    cancel_at_period_end: cancel, current_period_end: SECS(T0 + 60 * 864e5),
  } },
});
const invoicePaid = {
  id: "evt_inv", type: "invoice.payment_succeeded",
  data: { object: {
    object: "invoice", subscription: "sub_live_1",
    lines: { data: [{ period: { end: SECS(T0 + 90 * 864e5) } }] },
  } },
};

test("a real checkout.session.completed is read correctly", () => {
  const ev = normalise("stripe", checkoutCompleted);
  assert.equal(ev.type, EVENT.SUBSCRIBED);
  assert.equal(ev.providerSubscriptionId, "sub_live_1", "it lives in data.object.subscription");
  assert.equal(ev.userId, "u_kay", "carried through from client_reference_id");
});

test("a real subscription event is read from data.object.id, not a flat field", () => {
  const a = normalise("stripe", subscriptionUpdated(true));
  assert.equal(a.providerSubscriptionId, "sub_live_1");
  assert.equal(a.type, EVENT.CANCELLED);
  assert.equal(a.periodEnd, T0 + 60 * 864e5, "Stripe sends seconds; we keep millis");

  assert.equal(normalise("stripe", subscriptionUpdated(false)).type, EVENT.UNCANCELLED);
});

test("a real invoice event finds the subscription and the new period end", () => {
  const ev = normalise("stripe", invoicePaid);
  assert.equal(ev.type, EVENT.RENEWED);
  assert.equal(ev.providerSubscriptionId, "sub_live_1");
  assert.equal(ev.periodEnd, T0 + 90 * 864e5);
});

test("a one-off checkout is not treated as a subscription", () => {
  const ev = normalise("stripe", {
    id: "evt_x", type: "checkout.session.completed",
    data: { object: { object: "checkout.session", mode: "payment", client_reference_id: "u1" } },
  });
  assert.equal(ev.type, null);
});

// ------------------------------------------------------------- end to end flow

test("a first-time subscriber is CREATED by the checkout webhook", async () => {
  const store = createMemoryStore();
  assert.equal(await store.getSubscription("u_kay"), null);

  const r = await handleWebhook(store, "stripe", checkoutCompleted, T0);
  assert.equal(r.applied, true);
  assert.equal(r.created, true);

  const sub = await store.getSubscription("u_kay");
  assert.ok(sub, "the payment must produce a subscription, not an unknown_subscription");
  assert.equal(sub.provider_subscription_id, "sub_live_1");
  assert.equal(sub.price_cents, 595);
  assert.ok(isEntitled(sub, T0));
});

test("the checkout webhook asks Stripe for the true period end when it can", async () => {
  const store = createMemoryStore();
  const stripe = { getSubscription: async () => ({ current_period_end: SECS(T0 + 45 * 864e5) }) };
  await handleWebhook(store, "stripe", checkoutCompleted, T0, { stripe });
  const sub = await store.getSubscription("u_kay");
  assert.equal(sub.current_period_end, T0 + 45 * 864e5,
    "Stripe knows about trials and proration; 'now + 30 days' does not");
});

test("a checkout webhook replayed by Stripe creates exactly one subscription", async () => {
  const store = createMemoryStore();
  await handleWebhook(store, "stripe", checkoutCompleted, T0);
  const again = await handleWebhook(store, "stripe", checkoutCompleted, T0 + 1000);
  assert.equal(again.duplicate, true);
  assert.equal(again.applied, false);
});

test("a renewal uses Stripe's period end rather than adding thirty days", async () => {
  const store = createMemoryStore();
  await handleWebhook(store, "stripe", checkoutCompleted, T0);
  const r = await handleWebhook(store, "stripe", invoicePaid, T0 + 30 * 864e5);
  assert.equal(r.applied, true);
  assert.equal(r.subscription.current_period_end, T0 + 90 * 864e5);
  assert.equal(r.subscription.status, STATUS.ACTIVE);
});

test("the full live sequence: subscribe, cancel at Stripe, expire", async () => {
  const store = createMemoryStore();
  await handleWebhook(store, "stripe", checkoutCompleted, T0);
  await handleWebhook(store, "stripe", subscriptionUpdated(true), T0 + 2 * 864e5);

  let sub = await store.getSubscription("u_kay");
  assert.equal(sub.status, STATUS.CANCEL_PENDING);
  assert.ok(isEntitled(sub, T0 + 3 * 864e5), "cancelling never takes back time already paid for");

  await handleWebhook(store, "stripe", {
    id: "evt_del", type: "customer.subscription.deleted",
    data: { object: { object: "subscription", id: "sub_live_1" } },
  }, T0 + 31 * 864e5);
  sub = await store.getSubscription("u_kay");
  assert.equal(sub.status, STATUS.EXPIRED);
  assert.ok(!isEntitled(sub, T0 + 31 * 864e5));
});

// ------------------------------------------------------------ postgres mapping

/** A pool stand-in: records SQL and returns rows, so the adapter is testable
 *  without a database. */
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

test("postgres rows map to the same shape the rest of the code expects", async () => {
  const row = {
    user_id: "u1", provider: "stripe", provider_subscription_id: "sub_1",
    purchase_platform: "web", status: "active", price_cents: 595, currency: "usd",
    current_period_start: new Date(T0), current_period_end: new Date(T0 + 30 * 864e5),
    cancel_at_period_end: false, cancelled_at: null, grace_ends_at: null,
    created_at: new Date(T0), updated_at: new Date(T0),
  };
  const pool = fakePool(() => [row]);
  const store = await createPostgresStore({ pool });
  const sub = await store.getSubscription("u1");

  assert.equal(sub.current_period_end, T0 + 30 * 864e5, "timestamptz becomes epoch millis");
  assert.equal(sub.cancelled_at, null, "null stays null, not NaN");
  assert.equal(sub.price_cents, 595);
  assert.ok(isEntitled(sub, T0));
});

test("saving a subscription upserts on user, so resubscribing cannot leave two rows", async () => {
  const pool = fakePool(() => []);
  const store = await createPostgresStore({ pool });
  await store.putSubscription(newSubscription({
    userId: "u1", provider: "stripe", providerSubscriptionId: "sub_1", now: T0,
  }));
  const sql = pool.queries[0].text;
  assert.match(sql, /INSERT INTO subscriptions/);
  assert.match(sql, /ON CONFLICT \(user_id\) DO UPDATE/);
  assert.ok(pool.queries[0].params[7] instanceof Date, "millis are converted to Date for pg");
});

test("event idempotency is enforced by the primary key, not a prior read", async () => {
  const pool = fakePool(() => []);
  const store = await createPostgresStore({ pool });
  await store.markEventProcessed("evt_1", "stripe");
  const sql = pool.queries[0].text;
  assert.match(sql, /INSERT INTO processed_webhook_events/);
  assert.match(sql, /ON CONFLICT \(event_id\) DO NOTHING/,
    "two concurrent deliveries must not both pass a check-then-act");
});

test("the sweep query matches the partial index that exists for it", async () => {
  const pool = fakePool(() => []);
  const store = await createPostgresStore({ pool });
  await store.listSubscriptionsNeedingSweep(T0);
  const sql = pool.queries[0].text;
  assert.match(sql, /status <> 'expired'/);
  assert.match(sql, /current_period_end <= \$1/);
  assert.match(sql, /grace_ends_at <= \$1/);
  assert.match(sql, /LIMIT/, "an unbounded sweep would read the whole table");
});
