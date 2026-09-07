/**
 * In-memory store — the reference implementation of the storage interface.
 *
 * Everything above this line is pure logic, so the whole backend is testable
 * without Postgres. `schema.sql` is the production shape; a `pg` adapter
 * implements the same six methods against it.
 */
export function createMemoryStore() {
  const subsByUser = new Map();
  const subsByProviderId = new Map();
  const processedEvents = new Set();

  const key = (provider, id) => `${provider}:${id}`;

  return {
    async putSubscription(sub) {
      subsByUser.set(sub.user_id, sub);
      if (sub.provider_subscription_id) {
        subsByProviderId.set(key(sub.provider, sub.provider_subscription_id), sub);
      }
      return sub;
    },
    async getSubscription(userId) {
      return subsByUser.get(userId) ?? null;
    },
    async getSubscriptionByProviderId(provider, providerSubscriptionId) {
      return subsByProviderId.get(key(provider, providerSubscriptionId)) ?? null;
    },
    async hasProcessedEvent(eventId) {
      return processedEvents.has(eventId);
    },
    async markEventProcessed(eventId) {
      processedEvents.add(eventId);
    },
    /** Anything whose period or grace window has passed and is not yet expired. */
    async listSubscriptionsNeedingSweep(now) {
      return [...subsByUser.values()].filter(
        (s) => s.status !== "expired" &&
          ((s.current_period_end && now >= s.current_period_end) ||
           (s.grace_ends_at && now >= s.grace_ends_at))
      );
    },
    _reset() { subsByUser.clear(); subsByProviderId.clear(); processedEvents.clear(); },
  };
}
