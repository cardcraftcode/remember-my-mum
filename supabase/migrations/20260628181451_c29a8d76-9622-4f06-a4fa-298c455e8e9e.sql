
-- Event types enum
CREATE TYPE public.reminder_event_type AS ENUM ('birthday', 'christmas', 'mothers_day');

-- Customers table (one row per email)
CREATE TABLE public.reminder_customers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  shopify_customer_id TEXT,
  shop_domain TEXT,
  klaviyo_profile_id TEXT,
  guest_token_version INTEGER NOT NULL DEFAULT 1,
  consent_timestamp TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX reminder_customers_auth_user_id_idx ON public.reminder_customers(auth_user_id);
CREATE INDEX reminder_customers_email_idx ON public.reminder_customers(lower(email));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.reminder_customers TO authenticated;
GRANT ALL ON public.reminder_customers TO service_role;

ALTER TABLE public.reminder_customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Customers can view own row"
  ON public.reminder_customers FOR SELECT
  TO authenticated
  USING (auth_user_id = auth.uid());

CREATE POLICY "Customers can update own row"
  ON public.reminder_customers FOR UPDATE
  TO authenticated
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

-- Reminders table (one row per customer+event)
CREATE TABLE public.reminders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES public.reminder_customers(id) ON DELETE CASCADE,
  event_type public.reminder_event_type NOT NULL,
  event_date DATE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (customer_id, event_type)
);
CREATE INDEX reminders_customer_idx ON public.reminders(customer_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.reminders TO authenticated;
GRANT ALL ON public.reminders TO service_role;

ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Customers can view own reminders"
  ON public.reminders FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.reminder_customers c
      WHERE c.id = reminders.customer_id AND c.auth_user_id = auth.uid()
    )
  );

CREATE POLICY "Customers can manage own reminders"
  ON public.reminders FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.reminder_customers c
      WHERE c.id = reminders.customer_id AND c.auth_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.reminder_customers c
      WHERE c.id = reminders.customer_id AND c.auth_user_id = auth.uid()
    )
  );

-- Klaviyo sync log (server-only, for debugging)
CREATE TABLE public.klaviyo_sync_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES public.reminder_customers(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB,
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX klaviyo_sync_log_customer_idx ON public.klaviyo_sync_log(customer_id, created_at DESC);

GRANT ALL ON public.klaviyo_sync_log TO service_role;
ALTER TABLE public.klaviyo_sync_log ENABLE ROW LEVEL SECURITY;
-- No policies: service_role only

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER reminder_customers_updated_at
  BEFORE UPDATE ON public.reminder_customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER reminders_updated_at
  BEFORE UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
