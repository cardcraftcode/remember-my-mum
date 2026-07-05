import { createFileRoute } from '@tanstack/react-router'
import { createKlaviyoClient } from '@/lib/klaviyo.server'
import {
  ALL_OCCASIONS,
  getSupabaseAdmin,
  type Occasion,
  type PersonRow,
} from '@/lib/reminders.server'
import { nextOccurrenceFor } from '@/lib/dates.server'

/**
 * Daily-runnable job: for every verified customer × person × active occasion,
 * check the latest `reminder_event_log` entry. If it's a `created` event whose
 * `next_occurrence` has passed, emit a fresh Reminder Created event with the
 * next year's occurrence date. Idempotent via `klaviyo_unique_id`
 * (`created-<person>-<occasion>-<year>`).
 *
 * Auth: Supabase anon key in `apikey` header (pg_cron).
 */
export const Route = createFileRoute('/api/public/hooks/yearly-reemit')({
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

        const supabase = getSupabaseAdmin()
        const klaviyo = createKlaviyoClient(supabase)

        const { data: customers, error } = await supabase
          .from('reminder_customers')
          .select('id, email, verified_at, shop_domain, reminder_people(*)')
          .not('verified_at', 'is', null)

        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        const today = new Date().toISOString().slice(0, 10)
        let emitted = 0
        let skipped = 0
        let failed = 0

        for (const row of customers ?? []) {
          const { reminder_people: people, ...customer } = row as typeof row & {
            reminder_people: PersonRow[]
          }
          for (const person of people ?? []) {
            for (const occasion of ALL_OCCASIONS) {
              const active =
                (occasion === 'birthday' && person.reminds_birthday) ||
                (occasion === 'christmas' && person.reminds_christmas) ||
                (occasion === 'mothers_day' && person.reminds_mothers_day)
              if (!active) {
                skipped++
                continue
              }

              const { data: lastEvent } = await supabase
                .from('reminder_event_log')
                .select('event_type, next_occurrence')
                .eq('person_id', person.id)
                .eq('occasion', occasion)
                .order('sent_at', { ascending: false })
                .limit(1)
                .maybeSingle()

              if (
                lastEvent &&
                lastEvent.event_type === 'created' &&
                lastEvent.next_occurrence &&
                lastEvent.next_occurrence >= today
              ) {
                skipped++
                continue
              }

              const nextOcc = nextOccurrenceFor(occasion as Occasion, person.date_of_birth)
              const year = nextOcc.slice(0, 4)
              const uniqueId = `created-${person.id}-${occasion}-${year}`

              try {
                await klaviyo.trackEvent({
                  email: customer.email,
                  metricName: 'Reminder Created',
                  uniqueId,
                  properties: {
                    person_name: person.name,
                    occasion,
                    variant: person.variant,
                    next_occurrence: nextOcc,
                  },
                })
                await supabase.from('reminder_event_log').insert({
                  customer_id: customer.id,
                  person_id: person.id,
                  occasion,
                  event_type: 'created',
                  next_occurrence: nextOcc,
                  klaviyo_unique_id: uniqueId,
                })
                emitted++
              } catch (err) {
                await klaviyo.logSync(
                  customer.id,
                  'yearly_reemit',
                  'error',
                  { personId: person.id, occasion, nextOcc },
                  err instanceof Error ? err.message : String(err),
                )
                failed++
              }
            }
          }
        }

        return new Response(
          JSON.stringify({ ok: true, emitted, skipped, failed }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      },
    },
  },
})
