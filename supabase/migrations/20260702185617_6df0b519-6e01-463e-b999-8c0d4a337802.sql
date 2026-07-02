ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS mum_variants text[] NOT NULL DEFAULT '{}'::text[];

-- Drop the old blanket unique constraint (if it exists under either name)
ALTER TABLE public.reminders DROP CONSTRAINT IF EXISTS reminders_customer_id_event_type_key;
DROP INDEX IF EXISTS public.reminders_customer_id_event_type_key;

-- Keep christmas and mothers_day unique per customer, but allow multiple birthdays
CREATE UNIQUE INDEX IF NOT EXISTS reminders_customer_event_unique_non_birthday
  ON public.reminders (customer_id, event_type)
  WHERE event_type <> 'birthday';