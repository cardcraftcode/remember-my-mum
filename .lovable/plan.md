## Cleanup plan: remove customer-level `mum_variants`

Existing reminder data itself is fine — every birthday row already has its own `mum_variants`. The only legacy artefact is the customer-wide `mum_variants` column on `reminder_customers`, added before multi-birthday support. It's now just a rollup and needs to go.

### 1. Migration
Drop the column:
```sql
ALTER TABLE public.reminder_customers DROP COLUMN IF EXISTS mum_variants;
```

### 2. Code changes
- `src/lib/reminders.server.ts` — remove `unionVariants`, `aggregatedVariants`, the `mum_variants` writes on insert/update, and the `mumVariants` field on the customer-level Klaviyo payload.
- `src/lib/reminders.functions.ts` — remove the aggregate/update block that writes `mum_variants` onto the customer row (keep the birthday delete/insert logic).
- `src/lib/klaviyo.server.ts` — remove `mumVariants` from `KlaviyoProfilePayload` and stop setting the customer-wide `mum_variants` property in both `upsertProfile` and `updateProfile`. Per-reminder variants continue to flow through the `birthdays` array property.
- `src/routes/api/public/hooks/save-reminders.ts` — the legacy single-birthday fallback (`mum_birthday` + top-level `mum_variants`) still works; no change needed there (variants land per-birthday). Optional: drop the top-level `mum_variants` field from the schema. **Recommendation: leave the top-level field in the schema for one release** so any in-flight Shopify extension callers keep working; it's already consumed only when the legacy `mum_birthday` path is used.
- `src/routes/dashboard.tsx` — no change (already reads per-reminder variants).

### 3. Klaviyo
On the next sync per customer, the profile-level `mum_variants` property will simply stop being updated (Klaviyo keeps the old value until overwritten). If you want it actively cleared in Klaviyo, say so and I'll add a one-off backfill that PATCHes each profile to null out `mum_variants`. Otherwise it just becomes stale and unused.

### 4. Verification
- Save reminders from the app, confirm birthday rows carry `mum_variants` and no error.
- Confirm Klaviyo sync log entry is `success`.
- Types regenerate after migration; typecheck passes.

No data deletion is required — the birthday rows and customer records stay as-is.