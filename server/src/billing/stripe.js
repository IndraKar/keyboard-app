/**
 * Stripe REST client — no SDK.
 *
 * Stripe's API is form-encoded HTTP with a bearer token, so `fetch` is enough.
 * Keeping the SDK out preserves the property that this package installs and
 * tests with nothing, and it means the only Stripe behaviour in the codebase is
 * the four calls below rather than a dependency's entire surface.
 */

const DEFAULT_API = "https://api.stripe.com/v1";

/**
 * Stripe takes nested params as `a[b][c]=v`, not JSON.
 */
export function formEncode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) formEncode(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => {
      if (typeof item === "object") formEncode(item, `${key}[${i}]`, out);
      else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`);
    });
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join("&");
}

export class StripeError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "StripeError";
    this.status = status;
    this.body = body;
  }
}

/**
 * `apiBase` exists so the whole chain — app, server, webhook — can be exercised
 * against a stand-in Stripe locally. It defaults to the real API and should
 * never be set in production.
 */
export function createStripe({ secretKey, priceId, fetchImpl = fetch, apiBase = DEFAULT_API } = {}) {
  if (!secretKey) throw new Error("Stripe secret key is required");

  async function call(method, path, body, { idempotencyKey } = {}) {
    const headers = {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    };
    // Stripe replays a POST carrying a key it has already seen instead of
    // charging twice. A dropped response on a flaky network is otherwise a
    // double subscription.
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers,
      body: body ? formEncode(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* fall through */ }
    if (!res.ok) {
      const msg = json?.error?.message || `Stripe ${method} ${path} failed with ${res.status}`;
      throw new StripeError(msg, res.status, json);
    }
    return json;
  }

  return {
    /**
     * Hosted Checkout. The card never touches our server, which is the entire
     * point: Stripe's page collects it, so we are never in scope for handling
     * card data.
     *
     * `client_reference_id` carries our user id through to the webhook — it is
     * how `checkout.session.completed` knows whose subscription this is.
     */
    async createCheckoutSession({ userId, successUrl, cancelUrl, customerEmail }) {
      if (!priceId) throw new Error("STRIPE_PRICE_ID is not configured");
      return call("POST", "/checkout/sessions", {
        mode: "subscription",
        client_reference_id: userId,
        customer_email: customerEmail,
        success_url: successUrl,
        cancel_url: cancelUrl,
        line_items: [{ price: priceId, quantity: 1 }],
        // Lets a returning subscriber manage the same customer rather than
        // accumulating a new one per checkout.
        subscription_data: { metadata: { keyvoria_user_id: userId } },
      }, { idempotencyKey: `checkout:${userId}:${Date.now()}` });
    },

    async getSubscription(subscriptionId) {
      return call("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    },

    /**
     * Cancel at period end — at STRIPE, not just in our database.
     *
     * Without this call the user sees "cancelled" in the app and keeps being
     * charged every month, which is the worst bug this system could have.
     */
    async cancelAtPeriodEnd(subscriptionId) {
      return call("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { cancel_at_period_end: true },
        { idempotencyKey: `cancel:${subscriptionId}` });
    },

    async resume(subscriptionId) {
      return call("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { cancel_at_period_end: false },
        { idempotencyKey: `resume:${subscriptionId}` });
    },
  };
}
