import { createFileRoute } from '@tanstack/react-router'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'
import { createKlaviyoClient } from '@/lib/klaviyo.server'
import { buildKlaviyoPayload } from '@/lib/reminders.server'

// Daily cron: recomputes mum_birthday_next for every customer with an
// enabled birthday reminder and pushes the current profile snapshot to
// Klaviyo. Auth: Supabase anon key in `apikey` header (pg_cron).
export const Route = createFileRoute('/api/public/hooks/sync-klaviyo')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = request.headers.get('apikey')
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY
        if (!apiKey || !expected || apiKey !== expected) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        const supabaseUrl = process.env.SUPABASE_URL
        const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
        if (!supabaseUrl || !supabaseServiceRoleKey) {
          return new Response(
            JSON.stringify({ error: 'Missing Supabase credentials' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const supabase = createClient<Database>(
          supabaseUrl,
          supabaseServiceRoleKey,
          {
            auth: {
              storage: undefined,
              persistSession: false,
              autoRefreshToken: false,
            },
          },
        )

        const klaviyo = createKlaviyoClient(supabase)

        const { data: customers, error } = await supabase
          .from('reminder_customers')
          .select('*, reminders(*)')

        if (error) {
          return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          )
        }

        let synced = 0
        let failed = 0

        for (const row of customers ?? []) {
          const { reminders, ...customer } = row as typeof row & {
            reminders: Database['public']['Tables']['reminders']['Row'][]
          }
          const payload = buildKlaviyoPayload(customer, reminders ?? [])

          try {
            let profile: { id: string }
            if (customer.klaviyo_profile_id) {
              profile = await klaviyo.updateProfile(
                customer.klaviyo_profile_id,
                payload,
              )
            } else {
              profile = await klaviyo.upsertProfile(payload)
              await supabase
                .from('reminder_customers')
                .update({ klaviyo_profile_id: profile.id })
                .eq('id', customer.id)
            }
            await klaviyo.logSync(customer.id, 'cron_sync', 'success', {
              profileId: profile.id,
            })
            synced++
          } catch (err) {
            await klaviyo.logSync(
              customer.id,
              'cron_sync',
              'error',
              payload as unknown as Record<string, unknown>,
              err instanceof Error ? err.message : String(err),
            )
            failed++
          }
        }

        return new Response(
          JSON.stringify({ ok: true, synced, failed, total: customers?.length ?? 0 }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      },
    },
  },
})
