CREATE TABLE public.shopify_auth_states (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  state TEXT NOT NULL UNIQUE,
  code_verifier TEXT NOT NULL,
  origin TEXT NOT NULL,
  shop_domain TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (now() + interval '10 minutes')
);

CREATE INDEX shopify_auth_states_expires_at_idx ON public.shopify_auth_states(expires_at);

GRANT ALL ON public.shopify_auth_states TO service_role;
ALTER TABLE public.shopify_auth_states ENABLE ROW LEVEL SECURITY;
-- No policies: service_role only

-- Cron metadata table (used by external scheduler or logging)
CREATE TABLE public.cron_run_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_name TEXT NOT NULL,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  finished_at TIMESTAMP WITH TIME ZONE,
  records_processed INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX cron_run_log_job_name_idx ON public.cron_run_log(job_name, created_at DESC);

GRANT ALL ON public.cron_run_log TO service_role;
ALTER TABLE public.cron_run_log ENABLE ROW LEVEL SECURITY;
-- No policies: service_role only
