# Deploying the Keyvoria API and switching on Stripe

Start to finish, roughly 45 minutes. Do the whole thing in **test mode** first —
no real card is charged until you deliberately swap the keys in step 8.

Everything below is yours to do: it needs your Stripe account and your hosting
account, and neither can be created on your behalf.

---

## 1. Stripe account and the price

1. Create an account at **dashboard.stripe.com**. Leave the toggle on **Test
   mode** for now.
2. **Product catalogue → + Add product**
   - Name: `Keyvoria Premium`
   - Price: **5.95 USD**, **Recurring**, **Monthly**
3. Save, then open the price and copy its id. It starts with **`price_`**.
   > A `prod_` id is the *product*, not the price. The server needs the
   > `price_` one; the `prod_` one produces "No such price" at checkout.
4. **Developers → API keys** → copy the **Secret key** (`sk_test_…`).

## 2. Database

Any managed Postgres: Render, Neon, Supabase, Fly. Create one and copy its
connection string (`postgres://…`).

Then create the tables:

```bash
psql "$DATABASE_URL" -f src/store/schema.sql
```

The file is safe to re-run — every statement is `IF NOT EXISTS`.

## 3. Deploy

### Render (matches the blueprint in `render.yaml`)

1. **New → Blueprint**, point it at this repo. It reads `render.yaml`, creates
   the web service and the database, and wires `DATABASE_URL` for you.
2. Set the secrets it leaves blank (step 4).

### Anywhere else

The `Dockerfile` is self-contained:

```bash
docker build -t keyvoria-api .
docker run -p 8787:8787 --env-file .env keyvoria-api
```

Fly, Railway, Cloud Run and ECS all take it as-is. The only requirements are a
public HTTPS URL and the environment variables below.

## 4. Environment variables

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | from step 2 |
| `KEYVORIA_SESSION_SECRET` | `openssl rand -hex 32`. Changing it signs everyone out. |
| `STRIPE_SECRET_KEY` | `sk_test_…` from step 1 |
| `STRIPE_PRICE_ID` | `price_…` from step 1 |
| `STRIPE_WEBHOOK_SECRET` | step 5 |
| `KEYVORIA_ALLOWED_ORIGIN` | your site's origin, e.g. `https://keyvoria.com` |
| `KEYVORIA_SUCCESS_URL` | where Stripe returns after payment |
| `KEYVORIA_CANCEL_URL` | where Stripe returns if they back out |

**Never set `KEYVORIA_DEV_AUTH` or `KEYVORIA_ALLOW_UNSIGNED_WEBHOOKS` in
production.** The first lets anyone be any user; the second lets anyone who
finds the URL give themselves a subscription. The server prints an error on
every boot if it catches either one in production.

## 5. The webhook

This is the step everything else depends on: **without it, people pay and the
server never finds out.**

1. **Developers → Webhooks → Add endpoint**
2. URL: `https://your-api-host/v1/webhooks/stripe`
3. Select these events:
   - `checkout.session.completed` — creates the subscription
   - `invoice.payment_succeeded` — renews it
   - `invoice.payment_failed` — starts the grace period
   - `customer.subscription.updated` — cancel / uncancel
   - `customer.subscription.deleted` — expiry
4. Copy the **Signing secret** (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` and
   redeploy.

## 6. Check it works, with no money involved

```bash
curl https://your-api-host/health
# {"ok":true,...}
```

Then, with the Stripe CLI:

```bash
stripe login
stripe listen --forward-to localhost:8787/v1/webhooks/stripe
stripe trigger checkout.session.completed
```

`stripe listen` prints its own `whsec_…` — use that one while forwarding
locally.

A full test purchase: start a checkout from the app, and on Stripe's page use
card **4242 4242 4242 4242**, any future expiry, any CVC, any postcode. Then
check the subscription exists:

```bash
curl -H "Authorization: Bearer <session token>" https://your-api-host/v1/subscription
```

## 7. Point the app at it

The app already speaks to this server — there is no code to write. In the app:

**Profile → Server**, fill in:

- **API address** — your deployed URL, e.g. `https://keyvoria-api.onrender.com`
- **Session token** — generate one on the server:

```bash
KEYVORIA_SESSION_SECRET=<the same secret the server runs with> \
  npm run token -- kay 30
```

Tap **Connect**. The card then reads "Connected · free plan".

From that point the server, not the app, decides who has paid. **Subscribe** calls
`/v1/billing/checkout`, opens Stripe's hosted page in a new tab, and the app polls
until your webhook confirms the payment — then it unlocks on its own, with no
reload. Cancel and resume go through the server too, which tells Stripe before
recording anything locally.

Leave those fields empty and the app runs entirely on the device with the
simulated checkout, which refuses real cards. That is the right mode for showing
the app to someone without a server in front of it.

> **The token is a password.** It identifies a user outright, because real
> sign-in is roadmap M1 and does not exist yet. Do not paste it anywhere public,
> and delete `bin/token.js` once M1 lands.

## 8. Going live

1. Flip the dashboard to **Live mode**.
2. Recreate the product and price there — **test and live objects are separate**,
   so the test `price_` id does not exist in live mode.
3. Swap in the `sk_live_…` key and the live price id.
4. Add the webhook endpoint again in live mode and swap in its new `whsec_…`.
5. Stripe needs your business details and a bank account before it will pay out.

The server prints `stripe: LIVE KEYS — real charges` on boot when live keys are
in use. If you see that unexpectedly, stop.

---

## What breaks this, in order of how expensive it is

**No `DATABASE_URL`.** The server falls back to an in-memory store and forgets
every subscription on the next restart — a deploy, a crash, the host moving the
container. People would pay and silently lose access, and Stripe never resends
the webhooks that would rebuild it. The server logs this as an error on every
production boot. Do not ignore it.

**No `STRIPE_WEBHOOK_SECRET`.** Signed deliveries are rejected, so no payment is
ever recorded. Everyone pays and nobody gets Premium.

**Wrong webhook URL.** Same outcome, and Stripe will show the failures under
Developers → Webhooks. Check there first when a test purchase does not appear.

**`price_` vs `prod_`.** Checkout fails with "No such price".

**Forgetting step 8.2.** Live mode cannot see test-mode prices.

---

## What is not built yet

- **PayPal** is modelled end to end in the subscription logic, but its webhook
  signature scheme (a certificate chain, not a shared secret) is not
  implemented. That endpoint returns **501** rather than trusting an unverified
  delivery.
- **Apple and Google in-app purchase** are modelled for cancellation and
  renewal, but their receipt verification is not written. You only need them if
  you ship in the app stores, where they are mandatory and take 15–30%.
- **Accounts (roadmap M1).** `user_id` is whatever the session token carries, and
  tokens are minted by hand with `npm run token` rather than by a sign-in. Until
  M1 lands, every person who subscribes needs a token generated for them, which
  is fine for you and a few testers and is not a product. `verifyToken` is the
  single seam to replace.
- **Tax.** Digital subscriptions are taxable in many US states and carry VAT in
  the EU/UK. Stripe Tax handles calculation; a merchant of record such as Paddle
  handles calculation *and* filing. Neither is wired up here.
