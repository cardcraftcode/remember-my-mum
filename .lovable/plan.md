
## Goal

Switch from an event-row model (birthday / christmas / mothers_day rows) to a **people** list. Each person is one row the user manages by name. Christmas and Mother's Day stay as **account-level** toggles.

## New data model

Two tables, replacing `reminders` and `reminder_customers` entirely.

```text
reminder_customers          (mostly as today, minus the singletons)
├─ id, email, auth_user_id, shopify_customer_id, shop_domain
├─ klaviyo_profile_id, consent_timestamp, verified_at, verification_token…
├─ reminds_christmas     boolean  default true   ← moved onto the customer
└─ reminds_mothers_day   boolean  default true   ← moved onto the customer

reminder_people
├─ id, customer_id (fk)
├─ name              text  not null        ← user-supplied identifier ("Mum", "Nana Rose")
├─ date_of_birth     date  not null
├─ mum_variants      text[] not null default '{}'
├─ reminds_birthday  boolean not null default true
├─ created_at, updated_at
```

- Person is the unit the UI edits/deletes.
- Birthday opt-in lives per-person (so you can silence one without deleting).
- Christmas / Mother's Day are single account toggles, rendered above/below the list.

Old `reminders` table + `event_type` enum are dropped. Clean slate — no data migration.

## UI: `/reminders` (create) and `/dashboard` (manage)

Both pages share a single "person editor" component.

- `/reminders` (public/checkout landing): email + a list of people (starts with one blank card) + two account toggles + **Set reminders** button.
- `/dashboard` (signed-in): shows the list of saved people as cards with Edit / Delete, an **Add person** button, and the two account toggles which save on change. Adding a new person opens the same editor inline; Save button says "Set reminders" for new, "Save changes" for existing.

Each person card shows:
- Name (text input, required)
- Date of birth (date input, required)
- Variants (checkbox grid from `MUM_VARIANTS`)
- Birthday reminder toggle (default on)

Account section (once per page):
- Mother's Day reminder (default on)
- Christmas reminder (default on)

Design keeps the current pink/white shadcn-ish look — no visual redesign in scope.

## Server functions & endpoints

Rewritten around people, not events.

- `src/lib/reminders.functions.ts`
  - `getDashboardData()` → `{ customer, people }`
  - `createPerson({ name, dateOfBirth, mumVariants, remindsBirthday })`
  - `updatePerson({ id, … })`
  - `deletePerson({ id })`
  - `updateAccountReminders({ remindsChristmas, remindsMothersDay })`
- `src/lib/reminders.server.ts` — `upsertCustomerAndPeople(...)` replaces `upsertCustomerAndReminders`. Checkout / save-reminders hook append a person rather than a birthday row.
- `src/routes/api/public/shopify/reminders.ts` (headless account extension) — GET returns `{ people, remindsChristmas, remindsMothersDay }`; POST accepts the same shape.
- `src/routes/api/public/hooks/save-reminders.ts` — accept `people: [{ name, dateOfBirth, mumVariants }]` (still one person from the current checkout form, but shape is future-proof).

## Checkout & account extensions

- `shopify-extension/extensions/mum-reminders/src/Checkout.tsx`: add a **Name** field to the existing single-person form; submit as one person.
- `shopify-extension/extensions/account-reminders/src/ReminderPage.tsx`: replace single-birthday UI with the same people-list editor (add / edit / delete), plus the two account toggles.

## Klaviyo payload

`buildKlaviyoPayload` becomes:

```ts
{
  email, shopDomain, shopifyCustomerId,
  people: [{ name, dateOfBirth, next, mumVariants, remindsBirthday }],
  peopleCount,
  remindsChristmas, remindsMothersDay,
  remindersVerified, verificationUrl, consentTimestamp,
}
```

The old `mumBirthday` / `mumBirthdayNext` / `birthdays` top-level fields are removed — Klaviyo flows that referenced them need to switch to the per-event pattern below.

## Birthday cron

`src/routes/api/public/hooks/send-birthday-events.ts` iterates `reminder_people` where `reminds_birthday = true` and DOB matches `today + leadDays`, and fires one `Birthday Reminder Due` Klaviyo event per person, with properties:

```ts
{ personName, birthdayDate, mumVariant: mum_variants[0], mumVariants, personId }
```

`uniqueId: `birthday-${person.id}-${year}`` for idempotency. Templates use `{{ event.personName }}` and `{{ event.mumVariant }}` — this is what makes multi-birthday reminders finally work correctly.

## Migration plan (one migration)

1. `DROP TABLE public.reminders;`
2. `DROP TYPE public.reminder_event_type;` (if it exists as an enum)
3. `ALTER TABLE public.reminder_customers ADD COLUMN reminds_christmas boolean NOT NULL DEFAULT true, ADD COLUMN reminds_mothers_day boolean NOT NULL DEFAULT true;`
4. `CREATE TABLE public.reminder_people (…)` + GRANTs to `authenticated` and `service_role` + RLS enabled + policy "Customers can manage own people" scoped through `reminder_customers.auth_user_id = auth.uid()` + `updated_at` trigger using existing `set_updated_at()`.

No `anon` grant on either table — reads always go through server functions.

## Out of scope

- Visual redesign of the pages (same look & feel).
- Renaming `mum_variants` → something more generic.
- Multi-person checkout (checkout stays single-person for now; account page is where you add more).

## Rollout order

1. Migration (drop old, add new, alter customer).
2. `reminders.server.ts` + `reminders.functions.ts` rewrite.
3. `/reminders` + `/dashboard` UI rewrite.
4. Headless `account-reminders` extension rewrite.
5. `mum-reminders` checkout extension: add Name field, update submitted payload.
6. `save-reminders` hook + `shopify/reminders` route: new payload shape.
7. `send-birthday-events` cron: iterate people.
8. `buildKlaviyoPayload` update + note in-Klaviyo template changes needed.

I'll leave a short note at the end listing the Klaviyo template variables you'll need to swap (`event.mumVariant`, `event.personName`, `event.birthdayDate`) so you can update flows in the Klaviyo UI.
