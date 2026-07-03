ALTER TABLE public.reminder_customers
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_token text,
  ADD COLUMN IF NOT EXISTS verification_sent_at timestamptz;

-- Existing rows are treated as already verified (per product decision).
UPDATE public.reminder_customers
SET verified_at = COALESCE(verified_at, now())
WHERE verified_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reminder_customers_verification_token_key
  ON public.reminder_customers (verification_token)
  WHERE verification_token IS NOT NULL;