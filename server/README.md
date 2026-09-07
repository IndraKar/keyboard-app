# Keyvoria server — M7 (billing) and M7a (Competition Mode)

The parts of Keyvoria Premium that **cannot** live in the client: who is entitled to
what, and who won a race.

## Why this exists as its own thing

The rest of Keyvoria so far is documentation plus a single-file playable
prototype. Two features from the $5.95/month plan can't be built that way:

- **Entitlement.** A paywall drawn in the client is a suggestion. If the check
  isn't on a server, anyone who opens dev tools has Premium.
- **Competition.** If the client generates the passage, it knows the answers
  before the round starts. If the client reports its own result, the leaderboard
  is a self-report. Both have to be server-side or the mode is decorative.

Everything here is plain Node 22 ESM with **no runtime dependencies**, so it
runs and tests with no install step:

```
npm test     # 90 tests, no network, no database
npm start    # http://localhost:8787
```

## Layout

| Path | What it holds |
| --- | --- |
| `src/billing/subscription.js` | The subscription lifecycle as pure functions. Every access rule lives here. |
| `src/billing/webhooks.js` | Stripe / App Store / Play event normalisation, idempotency, and the missed-webhook sweep. |
| `src/competition/passage.js` | Reading Race: passage generation, level ladder 1–5 (PRD F-13). |
| `src/competition/chords.js` | Chord Race: chord generation, level ladder 1–3. |
| `src/competition/match.js` | The match engine: elimination, the settle window, local-clock ranking. |
| `src/competition/matchmaking.js` | Queue by level; private lobbies by share code. |
| `src/store/memory.js` | Reference store — six methods. |
| `src/store/schema.sql` | The Postgres shape those six methods run against. |
| `src/http/` | Routes, session tokens, webhook signature verification. |

## The rules worth knowing before changing anything

**Cancelling is a flag, not a downgrade.** A user who cancels keeps everything
until `current_period_end`. Revoking at the moment of the request takes back
time they already paid for. `isEntitled()` is the only place that decides
access, and it derives it — access is never a second stored flag that can drift.

**Apple and Google cannot be cancelled from here.** They own their
subscriptions. `requestCancel()` returns a directive with a management URL and
leaves the record untouched, rather than pretending locally that a cancellation
happened. A cancel the user believes happened and didn't is the worst outcome
available.

**Webhooks are the authority; the client never is.** A client saying "I
subscribed" is a hint to refetch. And the webhook endpoint **refuses** when no
signing secret is configured — falling open there would let anyone who finds the
URL grant themselves a subscription forever.

**Webhooks also get lost**, so `sweep()` enforces period ends and grace
expiries on a timer. Without it a dropped webhook means someone keeps Premium for
free and nothing ever errors.

**The match holds open for 750 ms after the first finish** (`SETTLE_MS`). This
was found by a test: without it the match ended on whichever completion the
server processed first, which is decided by ping — exactly what ranking by the
player's own clock exists to prevent. Reported times are validated
(`MIN_MS_PER_NOTE`), and a time that fails validation falls back to
server-observed order rather than disqualifying the player.

**Competition has two games, one engine.** Reading Race is won by finishing
first; Chord Race is won by being the last player not eliminated. Those two
differences — `lastStanding` and a per-game floor on plausible answer time —
are declared in the `GAMES` table in `match.js`, and everything else
(elimination, ranking, the settle window, matchmaking, lobbies) is shared.

**Chord Race is cheatable and the reading race is not.** The client has to be
told which pitches to sound, and anyone reading those pitches can compute the
quality. Pre-rendering audio would not fix it — audio can be analysed. So the
round is revealed one chord at a time at each player's own position, answers
have a 500 ms plausibility floor, and the server remains the only authority on
correctness. That bounds the advantage; it does not remove it, and the header of
`chords.js` says so rather than implying the game is secure.

**Competition writes no XP.** Your result depends on your opponents, so it
cannot feed a progression number that is supposed to mean your own skill.

## API

Auth is `Authorization: Bearer <token>`. Tokens are HMAC-signed and expiring
(`src/http/tokens.js`); when real sign-in (M1) lands, `verifyToken` is the one
seam to replace.

| Route | Notes |
| --- | --- |
| `GET /health` | public |
| `GET /v1/competition/levels` | public — the level ladder |
| `GET /v1/subscription` | what the Profile screen renders |
| `POST /v1/subscription/cancel` | 409 + `manageUrl` for App Store / Play |
| `POST /v1/subscription/resume` | undoes a pending cancel |
| `POST /v1/webhooks/:provider` | `stripe` \| `apple_app_store` \| `google_play` |
| `POST /v1/competition/queue` | `{game, level, players}` — `game` is `reading` (default) or `chords` |
| `GET /v1/competition/queue/:level?game=` | poll; also drives the wait-timeout start |
| `DELETE /v1/competition/queue` | leave |
| `POST /v1/competition/private` | open a lobby, returns a 5-character code |
| `POST /v1/competition/private/join` | join by code (case-insensitive) |
| `POST /v1/competition/private/start` | host only |
| `GET /v1/competition/match/:id` | poll the race |
| `POST /v1/competition/match/:id/note` | reading race: `{midi}` |
| `POST /v1/competition/match/:id/answer` | Chord Race: `{answer}`, one of the level's qualities |

Every `/v1/competition/*` route returns **402** without a live subscription.

## Configuration

| Variable | Effect |
| --- | --- |
| `PORT` | default 8787 |
| `KEYVORIA_SESSION_SECRET` | required to verify session tokens |
| `STRIPE_WEBHOOK_SECRET`, `APPLE_WEBHOOK_SECRET`, `GOOGLE_WEBHOOK_SECRET` | per-provider signing secrets; absent ⇒ that endpoint returns 503 |
| `KEYVORIA_ALLOWED_ORIGIN` | CORS origin, default `*` |
| `KEYVORIA_DEV_AUTH=1` | **dev only.** Accepts `Bearer dev:<userId>` as any user and enables `/v1/dev/subscribe`. |
| `KEYVORIA_ALLOW_UNSIGNED_WEBHOOKS=1` | **dev only.** Accepts unsigned webhooks. |

Both dev switches print a warning at boot. They are off by default and
`/v1/dev/*` returns 404 without them, so a production build cannot mint itself a
paid plan.

## What is deliberately not here

- **A payment integration.** Charging money needs a Stripe account and
  Apple/Google merchant accounts under a real legal entity. This server models
  what happens *after* a provider tells it something, which is the part that can
  be built and tested without one.
- **A realtime transport.** Matches are polled over HTTP. WebSockets are a
  transport swap, not a redesign — the engine is already authoritative.
- **A Postgres adapter.** `schema.sql` is the target shape; the memory store
  defines the six methods a `pg` adapter has to implement.
- **Accounts.** M1 isn't built. Session tokens here prove only that this server
  issued them.
