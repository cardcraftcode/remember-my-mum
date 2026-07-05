import { createFileRoute } from '@tanstack/react-router'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'
import { createKlaviyoClient } from '@/lib/klaviyo.server'

/**
 * Daily cron: for every person whose birthday matches `today + leadDays`
 * (month + day), fire a `Birthday Reminder Due` Klaviyo event carrying the
 * person's name, DOB, and mum-variant so flow templates can render
 * `{{ event.personName }}` and `{{ event.mumVariant }}` correctly, even when
 * a customer has more than one person set up.
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

        const target = new Date()
        target.setUTCDate(target.getUTCDate() + leadDays)
        const targetMonth = target.getUTCMonth() + 1
        const targetDay = target.getUTCDate()
        const currentYear = new Date().getUTCFullYear()

        const { data: rows, error } = await supabase
          .from('reminder_people')
          .select(
            'id, name, date_of_birth, mum_variants, reminds_birthday, customer:reminder_customers!inner(id, email, verified_at, shop_domain)',
          )
          .eq('reminds_birthday', true)

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
          const [, mm, dd] = row.date_of_birth.split('-').map((n) => parseInt(n, 10))
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
              uniqueId: `birthday-${row.id}-${currentYear}`,
              properties: {
                personName: row.name,
                birthdayDate: row.date_of_birth,
                mumVariant,
                mumVariants: variants,
                leadDays,
                shopDomain: customer.shop_domain,
                personId: row.id,
              },
            })
            await klaviyo.logSync(customer.id, 'track_birthday_event', 'success', {
              personId: row.id,
              personName: row.name,
              mumVariant,
              birthdayDate: row.date_of_birth,
            })
            sent++
          } catch (err) {
            await klaviyo.logSync(
              customer.id,
              'track_birthday_event',
              'error',
              { personId: row.id, birthdayDate: row.date_of_birth },
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
