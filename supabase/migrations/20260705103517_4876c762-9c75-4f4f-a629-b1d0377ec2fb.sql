-- Drop legacy event-based reminders table + enum
DROP TABLE IF EXISTS public.reminders CASCADE;
DROP TYPE IF EXISTS public.reminder_event_type;

-- Move Christmas / Mother's Day toggles onto the customer
ALTER TABLE public.reminder_customers
  ADD COLUMN IF NOT EXISTS reminds_christmas boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reminds_mothers_day boolean NOT NULL DEFAULT true;

-- New person-centric table
CREATE TABLE public.reminder_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.reminder_customers(id) ON DELETE CASCADE,
  name text NOT NULL,
  date_of_birth date NOT NULL,
  mum_variants text[] NOT NULL DEFAULT '{}',
  reminds_birthday boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reminder_people_customer_id_idx ON public.reminder_people(customer_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.reminder_people TO authenticated;
GRANT ALL ON public.reminder_people TO service_role;

ALTER TABLE public.reminder_people ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Customers can manage own people"
  ON public.reminder_people
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.reminder_customers c
      WHERE c.id = reminder_people.customer_id
        AND c.auth_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.reminder_customers c
      WHERE c.id = reminder_people.customer_id
        AND c.auth_user_id = auth.uid()
    )
  );

CREATE TRIGGER reminder_people_set_updated_at
  BEFORE UPDATE ON public.reminder_people
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
