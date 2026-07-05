
DROP TABLE IF EXISTS public.reminder_people CASCADE;
DROP TABLE IF EXISTS public.reminder_customers CASCADE;

CREATE TABLE public.reminder_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  auth_user_id uuid,
  shopify_customer_id text,
  shop_domain text,
  klaviyo_profile_id text,
  guest_token_version integer NOT NULL DEFAULT 1,
  consent_timestamp timestamptz,
  verified_at timestamptz,
  verification_token text,
  verification_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reminder_customers TO authenticated;
GRANT ALL ON public.reminder_customers TO service_role;
ALTER TABLE public.reminder_customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Customers can view own row" ON public.reminder_customers
  FOR SELECT TO authenticated USING (auth_user_id = auth.uid());
CREATE POLICY "Customers can update own row" ON public.reminder_customers
  FOR UPDATE TO authenticated
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());
CREATE TRIGGER set_reminder_customers_updated
  BEFORE UPDATE ON public.reminder_customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.reminder_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.reminder_customers(id) ON DELETE CASCADE,
  name text NOT NULL,
  date_of_birth date NOT NULL,
  variant text NOT NULL DEFAULT 'Mum',
  reminds_birthday boolean NOT NULL DEFAULT true,
  reminds_christmas boolean NOT NULL DEFAULT true,
  reminds_mothers_day boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reminder_people TO authenticated;
GRANT ALL ON public.reminder_people TO service_role;
ALTER TABLE public.reminder_people ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Customers can manage own people" ON public.reminder_people
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.reminder_customers c
    WHERE c.id = reminder_people.customer_id AND c.auth_user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.reminder_customers c
    WHERE c.id = reminder_people.customer_id AND c.auth_user_id = auth.uid()
  ));
CREATE TRIGGER set_reminder_people_updated
  BEFORE UPDATE ON public.reminder_people
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.reminder_event_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.reminder_customers(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES public.reminder_people(id) ON DELETE CASCADE,
  occasion text NOT NULL CHECK (occasion IN ('birthday','christmas','mothers_day')),
  event_type text NOT NULL CHECK (event_type IN ('created','cancelled')),
  next_occurrence date,
  klaviyo_unique_id text NOT NULL UNIQUE,
  sent_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.reminder_event_log TO service_role;
ALTER TABLE public.reminder_event_log ENABLE ROW LEVEL SECURITY;
CREATE INDEX reminder_event_log_person_occasion_idx
  ON public.reminder_event_log (person_id, occasion, sent_at DESC);
