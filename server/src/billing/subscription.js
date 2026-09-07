/**
 * M7 — the subscription lifecycle.
 *
 * Every rule about access lives here, as pure functions over a subscription
 * record. Nothing in this file talks to a provider, a database or a clock it
 * was not handed, which is what makes the money rules testable without a
 * Stripe account.
 *
 * The load-bearing rule: CANCELLING IS A FLAG, NOT A DOWNGRADE. A user who
 * cancels keeps everything they paid for until `current_period_end`. Revoking
 * at the moment of the request would be taking back time they already bought.
 */

export const PRICE_CENTS = 595; // Keyvoria Plus, $5.95/month (PRD §1.4)
export const CURRENCY = "usd";

/** @typedef {"active"|"cancel_pending"|"grace_period"|"billing_retry"|"expired"} SubStatus */

export const STATUS = {
  ACTIVE: "active",
  CANCEL_PENDING: "cancel_pending", // cancelled, still inside the paid period
  GRACE_PERIOD: "grace_period", // payment failed, provider is retrying
  BILLING_RETRY: "billing_retry", // provider still retrying, access held
  EXPIRED: "expired",
};

/**
 * Which statuses grant access. Grace and retry DO grant it: the user has not
 * asked to leave and the provider has not given up, so cutting them off over a
 * card that expired is punishing them for their bank's timing.
 */
const ENTITLING = new Set([
  STATUS.ACTIVE,
  STATUS.CANCEL_PENDING,
  STATUS.GRACE_PERIOD,
  STATUS.BILLING_RETRY,
]);

/**
 * Providers differ in one way that matters: only Stripe lets us cancel on the
 * user's behalf. Apple and Google own their subscriptions, so the app can only
 * send the user to their management surface. Encoding that here — rather than
 * in the UI — means the API cannot accidentally promise a cancellation it has
 * no way to perform.
 */
export const PROVIDERS = {
  stripe: { id: "stripe", label: "Web", canCancelServerSide: true, manageUrl: null },
  apple_app_store: {
    id: "apple_app_store",
    label: "App Store",
    canCancelServerSide: false,
    manageUrl: "https://apps.apple.com/account/subscriptions",
  },
  google_play: {
    id: "google_play",
    label: "Google Play",
    canCancelServerSide: false,
    manageUrl: "https://play.google.com/store/account/subscriptions",
  },
};

export function providerOf(sub) {
  const p = PROVIDERS[sub?.provider];
  if (!p) throw new Error(`unknown provider: ${sub?.provider}`);
  return p;
}

/** Access is DERIVED from status and period end — never stored as a second flag. */
export function isEntitled(sub, now = Date.now()) {
  if (!sub) return false;
  if (!ENTITLING.has(sub.status)) return false;
  // A cancelled subscription keeps access right up to the period boundary.
  if (sub.status === STATUS.CANCEL_PENDING) return now < sub.current_period_end;
  if (sub.status === STATUS.GRACE_PERIOD || sub.status === STATUS.BILLING_RETRY) {
    return now < sub.grace_ends_at;
  }
  return true;
}

export function newSubscription({ userId, provider, providerSubscriptionId, now = Date.now(), periodDays = 30 }) {
  if (!PROVIDERS[provider]) throw new Error(`unknown provider: ${provider}`);
  return {
    user_id: userId,
    provider,
    provider_subscription_id: providerSubscriptionId,
    purchase_platform: provider === "stripe" ? "web" : provider === "apple_app_store" ? "ios" : "android",
    status: STATUS.ACTIVE,
    price_cents: PRICE_CENTS,
    currency: CURRENCY,
    current_period_start: now,
    current_period_end: now + periodDays * 864e5,
    cancel_at_period_end: false,
    cancelled_at: null,
    grace_ends_at: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Ask to cancel. Returns either the updated subscription, or — for a store the
 * server cannot act on — a directive telling the client where to send the user.
 * It never silently succeeds, because a cancel the user believes happened and
 * did not is the worst possible outcome here.
 */
export function requestCancel(sub, now = Date.now()) {
  const provider = providerOf(sub);
  if (!provider.canCancelServerSide) {
    return {
      ok: false,
      reason: "provider_managed",
      provider: provider.id,
      manageUrl: provider.manageUrl,
      message: `Purchased through ${provider.label}. Cancel it there and Keyvoria will update automatically.`,
      subscription: sub,
    };
  }
  if (sub.status === STATUS.EXPIRED) {
    return { ok: false, reason: "already_expired", subscription: sub };
  }
  return {
    ok: true,
    subscription: {
      ...sub,
      status: STATUS.CANCEL_PENDING,
      cancel_at_period_end: true,
      cancelled_at: sub.cancelled_at ?? now,
      updated_at: now,
    },
  };
}

/** Undo a pending cancellation. No billing event: the period was already paid. */
export function resume(sub, now = Date.now()) {
  if (sub.status !== STATUS.CANCEL_PENDING) {
    return { ok: false, reason: "not_cancelled", subscription: sub };
  }
  if (now >= sub.current_period_end) {
    return { ok: false, reason: "period_already_ended", subscription: sub };
  }
  return {
    ok: true,
    subscription: {
      ...sub,
      status: STATUS.ACTIVE,
      cancel_at_period_end: false,
      cancelled_at: null,
      updated_at: now,
    },
  };
}

/**
 * The period boundary. Called by the provider webhook and, because webhooks get
 * lost, by a scheduled sweep — so it must be safe to run twice.
 */
export function advancePeriod(sub, now = Date.now(), periodDays = 30) {
  if (now < sub.current_period_end) return sub; // not due yet: no-op, not an error
  if (sub.cancel_at_period_end) {
    return { ...sub, status: STATUS.EXPIRED, grace_ends_at: null, updated_at: now };
  }
  return {
    ...sub,
    status: STATUS.ACTIVE,
    current_period_start: sub.current_period_end,
    current_period_end: sub.current_period_end + periodDays * 864e5,
    grace_ends_at: null,
    updated_at: now,
  };
}

/** Payment failed. Access is held while the provider retries. */
export function paymentFailed(sub, now = Date.now(), graceDays = 7) {
  if (sub.status === STATUS.EXPIRED) return sub;
  return {
    ...sub,
    status: STATUS.GRACE_PERIOD,
    grace_ends_at: sub.grace_ends_at ?? now + graceDays * 864e5,
    updated_at: now,
  };
}

export function paymentRecovered(sub, now = Date.now(), periodDays = 30) {
  if (sub.status === STATUS.EXPIRED) return sub;
  return {
    ...sub,
    status: sub.cancel_at_period_end ? STATUS.CANCEL_PENDING : STATUS.ACTIVE,
    grace_ends_at: null,
    current_period_start: now,
    current_period_end: now + periodDays * 864e5,
    updated_at: now,
  };
}

/** Grace ran out with no successful payment. */
export function graceExpired(sub, now = Date.now()) {
  if (sub.status !== STATUS.GRACE_PERIOD && sub.status !== STATUS.BILLING_RETRY) return sub;
  if (now < sub.grace_ends_at) return sub;
  return { ...sub, status: STATUS.EXPIRED, updated_at: now };
}

/**
 * What the Profile screen needs, in one call, so the UI never has to reimplement
 * these rules and drift from them.
 */
export function describe(sub, now = Date.now()) {
  if (!sub || sub.status === STATUS.EXPIRED) {
    return { plan: "free", entitled: false, canCancelHere: false, headline: "Free plan" };
  }
  const provider = providerOf(sub);
  const entitled = isEntitled(sub, now);
  return {
    plan: entitled ? "paid" : "free",
    entitled,
    status: sub.status,
    priceCents: sub.price_cents,
    currency: sub.currency,
    renewsAt: sub.cancel_at_period_end ? null : sub.current_period_end,
    accessUntil: sub.cancel_at_period_end ? sub.current_period_end : null,
    purchasedOn: provider.label,
    canCancelHere: provider.canCancelServerSide && sub.status !== STATUS.CANCEL_PENDING,
    manageUrl: provider.canCancelServerSide ? null : provider.manageUrl,
    canResume: sub.status === STATUS.CANCEL_PENDING && now < sub.current_period_end,
    headline:
      sub.status === STATUS.CANCEL_PENDING
        ? "Keyvoria Plus until period end"
        : sub.status === STATUS.GRACE_PERIOD || sub.status === STATUS.BILLING_RETRY
          ? "Keyvoria Plus — payment problem"
          : "Keyvoria Plus",
  };
}
