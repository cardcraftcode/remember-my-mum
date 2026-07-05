# Add "Reminder Due In 14 Days" and "Reminder Due In 7 Days" events

## Current state
Klaviyo events emitted today:
- `Reminder Created` (save + yearly re-emit)
- `Reminder Cancelled` (remove/untick)
- `Reminders Verification Requested`

No due-window events. Any 14/7-day timing would have to live inside Klaviyo flows via "Wait until `next_occurrence` − N days".

## Proposal
Emit two new metrics from a dedicated cron:
- `Reminder Due In 14 Days`
- `Reminder Due In 7 Days`

One per person × active occasion × year, idempotent via `klaviyo_unique_id`.

## New cron route
`src/routes/api/public/hooks/due-reminders.ts` — auth via `apikey` header (same pattern as `yearly-reemit`).

For each verified customer × person × active occasion (birthday/christmas/mothers_day):
1. Compute `next_occurrence` via `nextOccurrenceFor`.
2. `days_until = next_occurrence − today` (whole days, UTC).
3. If `days_until == 14` → emit `Reminder Due In 14 Days`.
4. If `days_until == 7`  → emit `Reminder Due In 7 Days`.
5. Insert into `reminder_event_log` with `event_type = 'due_14' | 'due_7'` and `klaviyo_unique_id = due{14|7}-<personId>-<occasion>-<year>`.
6. Before emitting, check the log for that same `klaviyo_unique_id` — skip if present (safe re-runs).

### Event payload
```
{ person_name, occasion, variant, next_occurrence, days_until: 14 | 7 }
```
Profile is `email`; `unique_id` guarantees Klaviyo-side dedupe too.

### DB
No schema change. `reminder_event_log.event_type` has no CHECK constraint, so `'due_14'` / `'due_7'` slot in.

## pg_cron — every 2 minutes (testing)
Scheduled via `supabase--insert` (not migration), body `{}`, POSTing to the stable prod URL:
```sql
select cron.schedule(
  'due-reminders-test',
  '*/2 * * * *',
  $$ select net.http_post(
       url:='https://project--650a08ee-6644-4279-8bb5-d8d767d35ea1.lovable.app/api/public/hooks/due-reminders',
       headers:='{"Content-Type":"application/json","apikey":"<SUPABASE_PUBLISHABLE_KEY>"}'::jsonb,
       body:='{}'::jsonb
     ); $$
);
```
Switch to `'0 2 * * *'` and rename the job (`due-reminders`) once testing is done — I'll drop a one-liner in the plan follow-up.

## Testing question — please confirm one
Because the emit condition is a **strict day-window match** (exactly 14 or 7 days out), running every 2 minutes won't actually fire events unless you seed a person whose `next_occurrence` happens to land on today+14 or today+7. Two ways to make testing tractable:

**A. Seeded fixtures (recommended, no code changes):**
Add a test person with `date_of_birth` set so today's next birthday is exactly 14 days away (or 7). The cron then emits on the next tick; the second tick is a dedup no-op.

**B. Test-mode override in the route:**
Accept `?force=1` (or a request body flag) that ignores the day-window and emits for every active person/occasion using a synthetic `unique_id` (e.g. suffixed with the current timestamp). Easy to trigger from `invoke-server-function`; you don't need pg_cron to hit it at all for exercising the code path.

Which do you want — A, B, or both?

## Files
- **Create** `src/routes/api/public/hooks/due-reminders.ts`
- **Schedule** pg_cron job via `supabase--insert` after route deploys
- No other files touched.

## Not changed
- `Reminder Created` still fires on save (drives profile props + is a useful Klaviyo trigger).
- `Reminder Cancelled` still fires; flows on the new due events should filter "no Cancelled since".
