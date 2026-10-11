/**
 * M7 — provider webhooks.
 *
 * Three providers speak three different event vocabularies. This module
 * normalises them into one internal event set, then applies it through the
 * state machine in `subscription.js`.
 *
 * Two properties matter more than the mapping itself:
 *
 *  1. IDEMPOTENCY. Providers retry, and retries are not rare. Applying
 *     "period advanced" twice would hand a user a free month; applying
 *     "cancelled" twice is harmless but noisy. Every event carries a provider
 *     event id, and an id we have already processed is dropped without
 *     re-applying anything.
 *
 *  2. THE WEBHOOK IS THE AUTHORITY, NOT THE CLIENT. A client saying "I
 *     subscribed" is a hint to refetch, never a grant. Nothing in this file
 *     can be reached from the app's own API surface.
 */

import {
  STATUS,
  advancePeriod,
  graceExpired,
  paymentFailed,
  paymentRecovered,
  newSubscription,
} from "./subscription.js";

/** Internal, provider-agnostic event names. */
export const EVENT = {
  /** A brand-new subscriber: Stripe Checkout completed. Creates the record. */
  SUBSCRIBED: "subscribed",
  RENEWED: "renewed",
  CANCELLED: "cancelled", // user cancelled at the provider (store-managed)
  UNCANCELLED: "uncancelled",
  PAYMENT_FAILED: "payment_failed",
  PAYMENT_RECOVERED: "payment_recovered",
  EXPIRED: "expired",
};

/**
 * Provider event name → internal event. Unmapped names are ignored rather than
 * treated as errors: providers add event types over time, and a new one we do
 * not care about must not fail the endpoint and trigger an infinite retry.
 */
const MAPPINGS = {
  stripe: {
    "checkout.session.completed": EVENT.SUBSCRIBED,
    "invoice.payment_succeeded": EVENT.RENEWED,
    "invoice.paid": EVENT.RENEWED,
    "invoice.payment_failed": EVENT.PAYMENT_FAILED,
    "customer.subscription.updated": null, // resolved from the payload below
    "customer.subscription.deleted": EVENT.EXPIRED,
  },
  apple_app_store: {
    DID_RENEW: EVENT.RENEWED,
    DID_FAIL_TO_RENEW: EVENT.PAYMENT_FAILED,
    DID_CHANGE_RENEWAL_STATUS: null,
    EXPIRED: EVENT.EXPIRED,
    DID_RECOVER: EVENT.PAYMENT_RECOVERED,
  },
  paypal: {
    "PAYMENT.SALE.COMPLETED": EVENT.RENEWED,
    "BILLING.SUBSCRIPTION.PAYMENT.FAILED": EVENT.PAYMENT_FAILED,
    "BILLING.SUBSCRIPTION.CANCELLED": EVENT.CANCELLED,
    "BILLING.SUBSCRIPTION.RE-ACTIVATED": EVENT.UNCANCELLED,
    "BILLING.SUBSCRIPTION.EXPIRED": EVENT.EXPIRED,
    "BILLING.SUBSCRIPTION.SUSPENDED": EVENT.PAYMENT_FAILED,
  },
  google_play: {
    SUBSCRIPTION_RENEWED: EVENT.RENEWED,
    SUBSCRIPTION_IN_GRACE_PERIOD: EVENT.PAYMENT_FAILED,
    SUBSCRIPTION_CANCELED: EVENT.CANCELLED,
    SUBSCRIPTION_RESTARTED: EVENT.UNCANCELLED,
    SUBSCRIPTION_EXPIRED: EVENT.EXPIRED,
    SUBSCRIPTION_RECOVERED: EVENT.PAYMENT_RECOVERED,
  },
};

/**
 * Normalise a raw provider payload.
 * @returns {{eventId:string, provider:string, providerSubscriptionId:string, type:string|null}}
 */
/**
 * Pull the subscription id out of a REAL Stripe event.
 *
 * Stripe puts it in a different place depending on what the event is about: a
 * subscription event carries its own id, while invoices and checkout sessions
 * reference it. An earlier version of this file read a flat
 * `providerSubscriptionId` field that Stripe has never sent — fine against the
 * hand-written fixtures it was tested with, and wrong against every real
 * delivery.
 */
function stripeSubscriptionId(raw) {
  const o = raw?.data?.object ?? {};
  if (o.object === "subscription") return o.id ?? null;
  if (typeof o.subscription === "string") return o.subscription;
  return o.subscription?.id ?? null;
}

/** Stripe timestamps are Unix SECONDS; everything here is millis. */
const secsToMs = (v) => (typeof v === "number" ? v * 1000 : null);

function stripePeriodEnd(raw) {
  const o = raw?.data?.object ?? {};
  if (o.object === "subscription") return secsToMs(o.current_period_end);
  if (o.object === "invoice") {
    const line = o.lines?.data?.[0];
    return secsToMs(line?.period?.end) ?? secsToMs(o.period_end);
  }
  return null;
}

/**
 * Normalise a raw provider payload.
 * @returns {{eventId:string, provider:string, providerSubscriptionId:string,
 *            type:string|null, userId:string|null, periodEnd:number|null}}
 */
export function normalise(provider, raw) {
  const table = MAPPINGS[provider];
  if (!table) throw new Error(`unknown provider: ${provider}`);

  const eventId = raw.eventId ?? raw.id;
  if (!eventId) throw new Error("webhook has no event id — cannot be made idempotent");

  let type = table[raw.type] ?? null;
  let providerSubscriptionId = raw.providerSubscriptionId ?? raw.subscriptionId ?? null;
  let userId = null;
  let periodEnd = null;

  if (provider === "stripe") {
    providerSubscriptionId = providerSubscriptionId ?? stripeSubscriptionId(raw);
    periodEnd = stripePeriodEnd(raw);
    const o = raw?.data?.object ?? {};
    // How the webhook learns whose subscription this is: we set
    // client_reference_id when creating the Checkout session.
    userId = o.client_reference_id ?? o.metadata?.keyvoria_user_id ?? null;

    // Stripe folds cancel/uncancel into one update event; the flag decides which.
    if (raw.type === "customer.subscription.updated") {
      const flag = o.cancel_at_period_end ?? raw.cancel_at_period_end;
      if (flag === true) type = EVENT.CANCELLED;
      else if (flag === false) type = EVENT.UNCANCELLED;
    }
    // A checkout session that is not for a subscription is not our business.
    if (raw.type === "checkout.session.completed" && o.mode && o.mode !== "subscription") {
      type = null;
    }
  }

  if (provider === "apple_app_store" && raw.type === "DID_CHANGE_RENEWAL_STATUS") {
    type = raw.autoRenewStatus === 0 ? EVENT.CANCELLED : EVENT.UNCANCELLED;
  }

  return { eventId: String(eventId), provider, providerSubscriptionId, type, userId, periodEnd };
}

/** Apply one normalised event to a subscription. Pure. */
export function applyEvent(sub, type, now = Date.now(), periodEnd = null) {
  switch (type) {
    case EVENT.RENEWED: {
      // Prefer the provider's own period end: it accounts for trials, proration
      // and plan changes, none of which "now + 30 days" knows about. Fall back
      // to advancing locally only when the event does not carry one.
      if (periodEnd) {
        return {
          ...sub,
          status: sub.cancel_at_period_end ? STATUS.CANCEL_PENDING : STATUS.ACTIVE,
          current_period_start: sub.current_period_end,
          current_period_end: periodEnd,
          grace_ends_at: null,
          updated_at: now,
        };
      }
      // Renewal implies the boundary was reached even if our clock disagrees.
      return advancePeriod({ ...sub, current_period_end: Math.min(sub.current_period_end, now) }, now);
    }
    case EVENT.CANCELLED:
      if (sub.status === STATUS.EXPIRED) return sub;
      return {
        ...sub,
        status: STATUS.CANCEL_PENDING,
        cancel_at_period_end: true,
        cancelled_at: sub.cancelled_at ?? now,
        updated_at: now,
      };
    case EVENT.UNCANCELLED:
      if (sub.status !== STATUS.CANCEL_PENDING) return sub;
      return { ...sub, status: STATUS.ACTIVE, cancel_at_period_end: false, cancelled_at: null, updated_at: now };
    case EVENT.PAYMENT_FAILED:
      return paymentFailed(sub, now);
    case EVENT.PAYMENT_RECOVERED:
      return paymentRecovered(sub, now);
    case EVENT.EXPIRED:
      return { ...sub, status: STATUS.EXPIRED, grace_ends_at: null, updated_at: now };
    default:
      return sub; // unrecognised: acknowledge, change nothing
  }
}

/**
 * Handle a webhook end to end against a store.
 * Returns `{applied, duplicate, ignored, subscription}` so the caller can log
 * precisely why nothing happened, which is most of webhook debugging.
 */
export async function handleWebhook(store, provider, raw, now = Date.now(), opts = {}) {
  const ev = normalise(provider, raw);

  if (await store.hasProcessedEvent(ev.eventId)) {
    return { applied: false, duplicate: true, ignored: false, subscription: null };
  }

  if (!ev.type) {
    await store.markEventProcessed(ev.eventId, provider);
    return { applied: false, duplicate: false, ignored: true, reason: "unmapped_event", subscription: null };
  }

  /**
   * A new subscriber has no record yet — this event is what creates one.
   * Everything else in this file updates something that already exists, so
   * without this branch a first-time Stripe customer would pay and then be
   * reported as "unknown_subscription" forever.
   */
  if (ev.type === EVENT.SUBSCRIBED) {
    if (!ev.userId || !ev.providerSubscriptionId) {
      await store.markEventProcessed(ev.eventId, provider);
      return { applied: false, duplicate: false, ignored: true, reason: "incomplete_checkout", subscription: null };
    }
    let periodEnd = ev.periodEnd;
    // The session does not carry the period end; the subscription does.
    if (!periodEnd && opts.stripe) {
      try {
        const s = await opts.stripe.getSubscription(ev.providerSubscriptionId);
        periodEnd = typeof s?.current_period_end === "number" ? s.current_period_end * 1000 : null;
      } catch { /* fall back to the default period below */ }
    }
    const fresh = newSubscription({
      userId: ev.userId,
      provider,
      providerSubscriptionId: ev.providerSubscriptionId,
      now,
    });
    if (periodEnd) fresh.current_period_end = periodEnd;
    await store.putSubscription(fresh);
    await store.markEventProcessed(ev.eventId, provider);
    return { applied: true, duplicate: false, ignored: false, type: ev.type, created: true, subscription: fresh };
  }

  const sub = await store.getSubscriptionByProviderId(ev.provider, ev.providerSubscriptionId);
  if (!sub) {
    // Record it anyway: retrying forever against a subscription we do not have
    // is how a webhook queue backs up.
    await store.markEventProcessed(ev.eventId, provider);
    return { applied: false, duplicate: false, ignored: true, reason: "unknown_subscription", subscription: null };
  }

  const next = applyEvent(sub, ev.type, now, ev.periodEnd);
  await store.putSubscription(next);
  await store.markEventProcessed(ev.eventId, provider);
  return { applied: true, duplicate: false, ignored: false, type: ev.type, subscription: next };
}

/**
 * The scheduled sweep. Webhooks are best-effort — they get dropped, delayed and
 * mis-delivered — so period ends and grace expiries are also enforced on a
 * timer. Without this, a missed webhook means someone keeps Plus for free
 * indefinitely, and nobody notices because nothing errored.
 */
export async function sweep(store, now = Date.now()) {
  const subs = await store.listSubscriptionsNeedingSweep(now);
  const changed = [];
  for (const sub of subs) {
    let next = advancePeriod(sub, now);
    next = graceExpired(next, now);
    if (next !== sub && next.status !== sub.status) {
      await store.putSubscription(next);
      changed.push(next);
    }
  }
  return changed;
}
