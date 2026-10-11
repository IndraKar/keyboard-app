/**
 * Postgres store — the production implementation of the six-method interface.
 *
 * WHY THIS HAD TO EXIST BEFORE DEPLOYING. The in-memory store keeps every
 * subscription in a JavaScript Map. That is fine for tests and fatal in
 * production: a restart — a deploy, a crash, a host moving the container —
 * silently forgets who has paid. Everyone drops to the free tier, and the
 * provider never resends the webhooks that would rebuild it. Money would have
 * been taken for access that quietly disappeared.
 *
 * The `pg` driver is imported lazily so that `npm test` still runs with no
 * install step and no database. Nothing above this file knows Postgres exists.
 */

/** JS keeps epoch millis; Postgres keeps timestamptz. Convert at the boundary. */
const toDate = (ms) => (ms === null || ms === undefined ? null : new Date(ms));
const toMs = (d) => (d === null || d === undefined ? null : new Date(d).getTime());

function rowToSub(r) {
  if (!r) return null;
  return {
    user_id: r.user_id,
    provider: r.provider,
    provider_subscription_id: r.provider_subscription_id,
    purchase_platform: r.purchase_platform,
    status: r.status,
    price_cents: r.price_cents,
    currency: r.currency,
    current_period_start: toMs(r.current_period_start),
    current_period_end: toMs(r.current_period_end),
    cancel_at_period_end: r.cancel_at_period_end,
    cancelled_at: toMs(r.cancelled_at),
    grace_ends_at: toMs(r.grace_ends_at),
    created_at: toMs(r.created_at),
    updated_at: toMs(r.updated_at),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.connectionString  DATABASE_URL
 * @param {object} [opts.pool]            inject a pool (or a fake) for testing
 */
export async function createPostgresStore({ connectionString, pool } = {}) {
  let db = pool;
  if (!db) {
    const pg = await import("pg");           // lazy: tests never load it
    const Pool = pg.default?.Pool ?? pg.Pool;
    db = new Pool({
      connectionString,
      // Managed Postgres (Render, Fly, Neon, Supabase) terminates TLS with a
      // certificate chain the container does not carry. Verifying it would fail
      // every connection; the connection is still encrypted.
      ssl: /localhost|127\.0\.0\.1/.test(connectionString || "") ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  const q = (text, params) => db.query(text, params);

  return {
    /**
     * Upsert by user. A resubscribe after expiry updates the same row rather
     * than leaving a second one behind for getSubscription to pick between.
     */
    async putSubscription(sub) {
      await q(
        `INSERT INTO subscriptions
           (user_id, provider, provider_subscription_id, purchase_platform, status,
            price_cents, currency, current_period_start, current_period_end,
            cancel_at_period_end, cancelled_at, grace_ends_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         ON CONFLICT (user_id) DO UPDATE SET
           provider = EXCLUDED.provider,
           provider_subscription_id = EXCLUDED.provider_subscription_id,
           purchase_platform = EXCLUDED.purchase_platform,
           status = EXCLUDED.status,
           price_cents = EXCLUDED.price_cents,
           currency = EXCLUDED.currency,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end = EXCLUDED.current_period_end,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           cancelled_at = EXCLUDED.cancelled_at,
           grace_ends_at = EXCLUDED.grace_ends_at,
           updated_at = now()`,
        [sub.user_id, sub.provider, sub.provider_subscription_id, sub.purchase_platform,
         sub.status, sub.price_cents, sub.currency,
         toDate(sub.current_period_start), toDate(sub.current_period_end),
         sub.cancel_at_period_end, toDate(sub.cancelled_at), toDate(sub.grace_ends_at)]
      );
      return sub;
    },

    async getSubscription(userId) {
      const r = await q(`SELECT * FROM subscriptions WHERE user_id = $1`, [userId]);
      return rowToSub(r.rows[0]);
    },

    async getSubscriptionByProviderId(provider, providerSubscriptionId) {
      const r = await q(
        `SELECT * FROM subscriptions WHERE provider = $1 AND provider_subscription_id = $2`,
        [provider, providerSubscriptionId]
      );
      return rowToSub(r.rows[0]);
    },

    /**
     * Idempotency. The INSERT is the guard, not a prior SELECT: two concurrent
     * deliveries of the same event would both pass a check-then-act, and the
     * second would hand out a free month. The primary key cannot be raced.
     */
    async hasProcessedEvent(eventId) {
      const r = await q(`SELECT 1 FROM processed_webhook_events WHERE event_id = $1`, [eventId]);
      return r.rowCount > 0;
    },

    async markEventProcessed(eventId, provider = "unknown") {
      const r = await q(
        `INSERT INTO processed_webhook_events (event_id, provider)
         VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING`,
        [eventId, provider]
      );
      return r.rowCount > 0;   // false means someone else got there first
    },

    /** Exactly the predicate the sweep index was built for. */
    async listSubscriptionsNeedingSweep(now) {
      const t = toDate(now);
      const r = await q(
        `SELECT * FROM subscriptions
          WHERE status <> 'expired'
            AND (current_period_end <= $1 OR (grace_ends_at IS NOT NULL AND grace_ends_at <= $1))
          LIMIT 500`,
        [t]
      );
      return r.rows.map(rowToSub);
    },

    async close() { if (db.end) await db.end(); },
  };
}
