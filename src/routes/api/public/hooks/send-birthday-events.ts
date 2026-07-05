import { createFileRoute } from '@tanstack/react-router'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'
import { createKlaviyoClient } from '@/lib/klaviyo.server'

/**
 * Daily cron: for every enabled birthday reminder whose (month, day) matches
 * `today + leadDays`, fire a Klaviyo event carrying that birthday's own
 * `date` + `mumVariant`. Klaviyo flows triggered off this metric can render
 * `{{ event.mumVariant }}` and pick the correct variant per birthday, even
 * when the customer has multiple birthdays on their profile.
 *
 * Auth: Supabase anon/publishable key in the `apikey` header (pg_cron).
 */
export const Route = createFileRoute('/api/public/hooks/send-birthday-events')({
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

        let body: { leadDays?: number } = {}
        try {
          body = (await request.json()) as { leadDays?: number }
        } catch {
          // empty body is fine
        }
        const leadDays = Number.isFinite(body.leadDays) ? Number(body.leadDays) : 7

        const supabaseUrl = process.env.SUPABASE_URL
        const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
        if (!supabaseUrl || !supabaseServiceRoleKey) {
          return new Response(
            JSON.stringify({ error: 'Missing Supabase credentials' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const supabase = createClient<Database>(supabaseUrl, supabaseServiceRoleKey, {
          auth: {
            storage: undefined,
            persistSession: false,
            autoRefreshToken: false,
          },
        })

        const klaviyo = createKlaviyoClient(supabase)

        // Compute the target (month, day) in UTC.
        const target = new Date()
        target.setUTCDate(target.getUTCDate() + leadDays)
        const targetMonth = target.getUTCMonth() + 1 // 1-12
        const targetDay = target.getUTCDate() // 1-31
        const currentYear = new Date().getUTCFullYear()

        // Pull all enabled birthday reminders for verified customers.
        const { data: rows, error } = await supabase
          .from('reminders')
          .select(
            'id, event_date, mum_variants, customer:reminder_customers!inner(id, email, verified_at, shop_domain)',
          )
          .eq('event_type', 'birthday')
          .eq('enabled', true)
          .not('event_date', 'is', null)

        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        let sent = 0
        let skipped = 0
        let failed = 0

        for (const row of rows ?? []) {
          const customer = (row as unknown as {
            customer: {
              id: string
              email: string
              verified_at: string | null
              shop_domain: string | null
            }
          }).customer
          if (!customer?.verified_at) {
            skipped++
            continue
          }
          if (!row.event_date) {
            skipped++
            continue
          }
          const [, mm, dd] = row.event_date.split('-').map((n) => parseInt(n, 10))
          if (mm !== targetMonth || dd !== targetDay) {
            skipped++
            continue
          }

          const variants = (row.mum_variants ?? []) as string[]
          const mumVariant = variants[0] ?? 'Mum'

          try {
            await klaviyo.trackEvent({
              email: customer.email,
              metricName: 'Birthday Reminder Due',
              // One event per reminder per year — safe to re-run the cron.
              uniqueId: `birthday-${row.id}-${currentYear}`,
              properties: {
                birthdayDate: row.event_date,
                mumVariant,
                mumVariants: variants,
                leadDays,
                shopDomain: customer.shop_domain,
                reminderId: row.id,
              },
            })
            await klaviyo.logSync(customer.id, 'track_birthday_event', 'success', {
              reminderId: row.id,
              mumVariant,
              birthdayDate: row.event_date,
            })
            sent++
          } catch (err) {
            await klaviyo.logSync(
              customer.id,
              'track_birthday_event',
              'error',
              { reminderId: row.id, birthdayDate: row.event_date },
              err instanceof Error ? err.message : String(err),
            )
            failed++
          }
        }

        return new Response(
          JSON.stringify({
            ok: true,
            leadDays,
            target: `${targetMonth}-${targetDay}`,
            sent,
            skipped,
            failed,
            total: rows?.length ?? 0,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      },
    },
  },
})
