## What we're building

A custom Shopify app + companion web app (this Lovable project) that lets momcards.co.uk customers set reminders for **Mum's birthday, Christmas, and Mother's Day**. Reminder emails are sent by **Klaviyo** as marketing emails (T-14 and T-7 before each event), so you can design, A/B test, and attribute revenue in Klaviyo. This app is the source of truth for the dates and opt-ins; Klaviyo is the send engine.

## User flow

1. After paying, the Shopify Thank You page shows a "Set a reminder so you never forget again" card (Shopify Checkout UI Extension).
2. Customer picks Mum's birthday date and ticks any of: birthday / Christmas / Mother's Day (single opt-in per event).
3. They can save as a guest (email only) or create an account via Shopify Customer Accounts SSO to manage later.
4. Dashboard at `reminders.momcards.co.uk` lets account-holders edit dates, toggle events, unsubscribe.
5. Klaviyo handles the actual emails on its schedule — you edit copy/design there, no redeploy.

## Architecture

```text
Shopify Thank You page
  └─ Checkout UI Extension ──POST──▶ /api/public/shopify/reminders
                                        │
                                        ├─ verifies Shopify session token
                                        ├─ upserts customer + reminders (Lovable Cloud DB)
                                        └─ syncs profile to Klaviyo (custom props + consent)

Dashboard (reminders.momcards.co.uk)
  └─ Shopify Customer Accounts OAuth ─▶ Lovable session
       └─ edit/toggle ─▶ same upsert + Klaviyo sync

Daily cron (09:00 UK)
  └─ recomputes `mum_birthday_next` for every profile, pushes to Klaviyo
     (no emails sent from this app)

Klaviyo (configured once by you)
  ├─ Flow: Birthday  — trigger when mum_birthday_next is T-14, send; T-7, send
  ├─ Flow: Christmas — trigger Dec 11 + Dec 18 for opted-in profiles
  └─ Flow: Mother's Day — trigger 14 + 7 days before UK Mother's Day

Klaviyo unsubscribe webhook ─▶ /api/public/klaviyo/webhook ─▶ flip toggles in DB
```

## Klaviyo profile shape

Each customer becomes a Klaviyo profile with these custom properties, kept in sync on every change:

- `mum_birthday` — ISO date
- `mum_birthday_next` — next future occurrence (drives the flow trigger)
- `reminds_birthday`, `reminds_christmas`, `reminds_mothers_day` — booleans
- `reminder_source` = `momcards_reminders`
- `consent_timestamp` — when they ticked the box (for GDPR/PECR audit)

## Data model (Lovable Cloud)

- `reminder_customers` — id, email (unique), shopify_customer_id (nullable for guests), shop_domain, klaviyo_profile_id, consent_timestamp, created_at
- `reminders` — customer_id, event_type (`birthday` | `christmas` | `mothers_day`), event_date (nullable for fixed-date events), enabled, updated_at
- `klaviyo_sync_log` — customer_id, action, payload_hash, status, error, created_at (for debugging)
- RLS: account-holders read/write only their own row via Shopify SSO claims; guests can only edit via signed email-token link in the dashboard URL.

## Endpoints

- `POST /api/public/shopify/reminders` — checkout extension submit (verifies Shopify session JWT, no account required)
- `GET /api/public/auth/shopify/start` + `POST /api/public/auth/shopify/callback` — Customer Accounts OAuth PKCE for the dashboard
- `POST /api/public/klaviyo/webhook` — signature-verified unsubscribe + profile-deleted events
- `POST /api/public/cron/sync-klaviyo` — daily, HMAC-protected, recomputes next dates and pushes deltas to Klaviyo

## Frontend (this Lovable app)

- `/` — short landing explaining the reminder service
- `/dashboard` — date picker + 3 toggles, "save changes" button
- `/manage?token=...` — guest edit link (signed JWT in email or post-checkout success page)
- `/unsubscribe?token=...` — one-click unsubscribe (also relays to Klaviyo)

## What you'll need to do in Klaviyo (one-time)

1. Generate a **Private API key** with `profiles:write`, `lists:write`, `subscriptions:write` scopes — paste into Lovable secret prompt.
2. Create 3 Flows, each triggered on a custom-property date with two messages (T-14 and T-7). I'll give you exact trigger config.
3. Add a Webhook in Klaviyo → Account → Webhooks pointing at `https://reminders.momcards.co.uk/api/public/klaviyo/webhook` for `profile.subscription.unsubscribed` and `profile.deleted`.

## What you'll need to do in Shopify (one-time)

1. Create a custom app in Shopify Admin → get Admin API token + API secret (to verify checkout extension session tokens).
2. Enable Customer Account API → get OAuth client ID + secret, scopes `openid email customer-account-api:full`.
3. Deploy the Checkout UI Extension (I'll generate the `shopify-extension/` folder; you run `shopify app deploy`).

## Build order

1. Lovable Cloud + DB schema + RLS
2. Klaviyo client wrapper (server-only) + sync function
3. `POST /api/public/shopify/reminders` endpoint
4. Customer Accounts OAuth + dashboard UI
5. Daily cron + Klaviyo webhook
6. Checkout UI Extension scaffold in `shopify-extension/`
7. Landing + manage/unsubscribe pages

## Open item

Subdomain for the dashboard — happy to point `reminders.momcards.co.uk` at this app once published, or use the default `*.lovable.app` URL for now? Affects only the OAuth redirect URI in Shopify.