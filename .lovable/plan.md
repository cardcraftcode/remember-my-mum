# Reminders schema v2 — per-person, per-occasion events

## Form (clean rebuild)

1. **Your email**
2. **Person 1 card** (collapsed by default, "Set a reminder" button to expand)
   - Who is the reminder for? *(text)*
   - What is she known as? *(single-select dropdown of MUM_VARIANTS)*
   - Reminder about: **Birthday**, **Christmas**, **Mother's Day** *(three checkboxes, all on by default)*
   - When was she born? *(DD-MM-YYYY, full date required — shown only when Birthday is ticked)*
3. **+ Add another person** (existing dashed-button styling)
4. **Set reminders**

Christmas/Mother's Day become per-person (removed from the account-level checkboxes at the bottom).

## Database (clean slate — drop old tables, recreate)

- `reminder_customers`: `id`, `email` (unique), `shop_domain`, `shopify_customer_id`, `klaviyo_profile_id`, `verified_at`, `verification_token`, `verification_sent_at`, `consent_timestamp`, timestamps.  
  Removes `reminds_christmas` / `reminds_mothers_day` — now per-person.
- `reminder_people`: `id`, `customer_id`, `name`, `date_of_birth` (date, required), `variant` (text, single value), `reminds_birthday` bool, `reminds_christmas` bool, `reminds_mothers_day` bool, timestamps.
- `reminder_event_log`: `id`, `customer_id`, `person_id`, `occasion` ('birthday'|'christmas'|'mothers_day'), `event_type` ('created'|'cancelled'), `next_occurrence` date, `klaviyo_unique_id` (unique), `sent_at`. Used for dedupe and to know what to cancel/re-emit.

RLS + GRANTs as before (authenticated own-row, service_role all).

## Klaviyo payloads

**Profile** (upsert on save/verify):
```json
{ "email": "...", "properties": {
    "reminder_source": "momcards_reminders",
    "reminders_verified": true,
    "people_count": 2
}}
```

**Reminder Created** (one per person × ticked occasion, only after verification):
```json
{ "event": "Reminder Created",
  "customer_properties": { "email": "..." },
  "properties": {
    "person_name": "Jane",
    "occasion": "birthday",
    "variant": "Mum",
    "next_occurrence": "2026-06-12"
  }}
```
`unique_id = "created-<person_id>-<occasion>-<year>"` for dedupe.

**Reminder Cancelled** (fired when a person is deleted, or an occasion is unticked on save):
```json
{ "event": "Reminder Cancelled",
  "customer_properties": { "email": "..." },
  "properties": { "person_name": "Jane", "occasion": "christmas", "variant": "Mum" }}
```

## Flow on save

1. Validate + upsert customer/people. Diff old vs new to determine created/cancelled reminders.
2. Upsert Klaviyo profile with people_count.
3. If unverified → send verification event (existing "Reminders Verification Requested" metric), no created events yet.
4. If verified → emit Reminder Created for each new (person, occasion) and Reminder Cancelled for each removed one. Log to `reminder_event_log`.
5. On verify-link click → mark verified, then emit Reminder Created for all current reminders.

## Yearly re-emit (pg_cron)

New public route `POST /api/public/hooks/yearly-reemit` protected by `apikey` header:
- For every verified customer × person × ticked occasion where the previous `next_occurrence` has passed, compute the new `next_occurrence` and emit a fresh Reminder Created event with a new `unique_id` (`created-<person>-<occasion>-<year>`).
- Scheduled daily at 01:00 UTC; the query only picks up rows whose last event is in the past, so it's idempotent.
- `birthday` → next anniversary of DOB. `christmas` → next Dec 25. `mothers_day` → `ukMothersDay(year)`.

## Downstream updates

- **Checkout extension** (`mum-reminders/Checkout.tsx`): switch to single-variant dropdown, per-person occasion checkboxes, full DOB.
- **Account extension** (`account-reminders/ReminderPage.tsx`): same shape as the web form.
- **save-reminders / shopify/reminders** hooks: accept new payload shape (`people: [{ name, dateOfBirth, variant, remindsBirthday, remindsChristmas, remindsMothersDay }]`, no top-level occasion flags).
- **send-birthday-events cron**: retire — replaced by yearly-reemit + Klaviyo flow delays.
- **sync-klaviyo**: keep, updated to new profile shape.
- **Dashboard**: update to show per-person occasion badges.

## Issues worth flagging

1. **Klaviyo flow delays run from event timestamp**, not from `next_occurrence`. Flows must use "Wait until date property = `next_occurrence` minus 14 days" — a standard Klaviyo action, but worth confirming your flows will be built that way. If flows use fixed "wait N days after event," `next_occurrence` is only useful for segmentation.
2. **Cancelled reminders don't stop already-running Klaviyo flows.** Klaviyo flows are per-profile; a Reminder Cancelled event can be used as a *Trigger Filter / Skip step*, but existing flow recipients continue unless the flow explicitly checks for a matching cancel event. Your flow design needs a "skip if cancelled event received for same person+occasion since trigger" filter.
3. **Verification-first means no events fire until they click.** Same as today — unverified customers generate no `Reminder Created` events. Confirmed by "keep verification."
4. **DOB required** removes the DD/MM-only checkout ergonomics; the checkout extension currently accepts DD/MM. This will slightly increase checkout friction — acceptable per your answer.
5. **`variant` becomes single-value**: existing data (multi-variant arrays) is dropped as part of the clean slate. Confirmed.

## Technical notes

- New DB migration drops `reminder_customers` and `reminder_people` and recreates them with the new shape (no data preserved, per "clean slate"). New `reminder_event_log` table for dedupe/cancel tracking.
- Diffing on save: load existing `reminder_people` + latest per-(person,occasion) rows from `reminder_event_log`, compare against submitted payload, produce two lists (created, cancelled).
- Yearly-reemit route reuses `nextBirthday` and `ukMothersDay` from `dates.server.ts`; adds a `nextChristmas(year)` helper.
- pg_cron schedule set via `supabase--insert` after the route is live, calling the stable `project--<id>.lovable.app` URL with the anon `apikey` header.
