/**
 * In-memory store — the reference implementation of the storage interface.
 *
 * Everything above this line is pure logic, so the whole backend is testable
 * without Postgres. `schema.sql` is the production shape; a `pg` adapter
 * implements the same methods against it.
 */
export function createMemoryStore() {
  const subsByUser = new Map();
  const subsByProviderId = new Map();
  const processedEvents = new Set();
  const progressByUser = new Map();
  const usersById = new Map();
  const usersByIdentity = new Map();

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
    async getProgress(userId) {
      return progressByUser.get(userId) ?? null;
    },
    async putProgress(userId, payload, lifetimeXp) {
      progressByUser.set(userId, payload);
      return payload;
    },
    async deleteProgress(userId) {
      return progressByUser.delete(userId);
    },

    /**
     * Find the account for a provider identity, or create it. Matching is on
     * (provider, provider_user_id) only — see schema.sql on why not the email.
     */
    async upsertUserByIdentity({ id, provider, providerUserId, email, emailVerified, name, now }) {
      const k = key(provider, providerUserId);
      const existing = usersByIdentity.get(k);
      if (existing) {
        /* Refresh what the provider now says, but never the id: that is what
           every other table points at. */
        existing.email = email ?? existing.email;
        existing.email_verified = emailVerified ?? existing.email_verified;
        existing.name = name ?? existing.name;
        existing.last_seen_at = now;
        return { user: existing, created: false };
      }
      const user = {
        id, provider, provider_user_id: providerUserId,
        email: email ?? null, email_verified: !!emailVerified, name: name ?? null,
        display_name: null, avatar: null,
        created_at: now, last_seen_at: now,
      };
      usersById.set(id, user);
      usersByIdentity.set(k, user);
      return { user, created: true };
    },

    async getUser(userId) {
      return usersById.get(userId) ?? null;
    },

    /** Only the fields the player owns; identity fields are not settable. */
    async updateProfile(userId, { displayName, avatar }) {
      const u = usersById.get(userId);
      if (!u) return null;
      if (displayName !== undefined) u.display_name = displayName;
      if (avatar !== undefined) u.avatar = avatar;
      return u;
    },

    async deleteUser(userId) {
      const u = usersById.get(userId);
      if (!u) return false;
      usersById.delete(userId);
      usersByIdentity.delete(key(u.provider, u.provider_user_id));
      progressByUser.delete(userId);
      const sub = subsByUser.get(userId);
      if (sub) {
        subsByUser.delete(userId);
        if (sub.provider_subscription_id) {
          subsByProviderId.delete(key(sub.provider, sub.provider_subscription_id));
        }
      }
      return true;
    },
    _reset() { subsByUser.clear(); subsByProviderId.clear(); processedEvents.clear();
               progressByUser.clear(); usersById.clear(); usersByIdentity.clear(); },
  };
}
