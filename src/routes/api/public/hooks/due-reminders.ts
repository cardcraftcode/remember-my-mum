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
 * For each verified customer × person × active occasion, compute days-until
 * next_occurrence and emit `Reminder Due In 14 Days` / `Reminder Due In 7 Days`
 * when it hits the window. Idempotent via reminder_event_log.klaviyo_unique_id.
 *
 * Auth: Supabase publishable/anon key in `apikey` header.
 *
 * Testing:
 *   POST with body { "force": true } to bypass the day-window check and emit
 *   a `Reminder Due In 14 Days` for every verified active person/occasion,
 *   using a timestamped unique_id so repeated runs still fire.
 */

const WINDOWS: Array<{ days: number; metric: string; prefix: string; type: 'due_14' | 'due_7' }> = [
  { days: 14, metric: 'Reminder Due In 14 Days', prefix: 'due14', type: 'due_14' },
  { days: 7, metric: 'Reminder Due In 7 Days', prefix: 'due7', type: 'due_7' },
]

function daysBetweenUtc(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime()
  const to = new Date(`${toIso}T00:00:00Z`).getTime()
  return Math.round((to - from) / 86_400_000)
}

export const Route = createFileRoute('/api/public/hooks/due-reminders')({
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

        let force = false
        try {
          const body = (await request.json()) as { force?: boolean } | null
          force = Boolean(body?.force)
        } catch {
          // empty body ok
        }

        const supabase = getSupabaseAdmin()
        const klaviyo = createKlaviyoClient(supabase)

        const { data: customers, error } = await supabase
          .from('reminder_customers')
          .select('id, email, verified_at, reminder_people(*)')
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

              const nextOcc = nextOccurrenceFor(occasion as Occasion, person.date_of_birth)
              const daysUntil = daysBetweenUtc(today, nextOcc)
              const year = nextOcc.slice(0, 4)

              const windows = force ? [WINDOWS[0]] : WINDOWS.filter((w) => w.days === daysUntil)
              if (windows.length === 0) {
                skipped++
                continue
              }

              for (const w of windows) {
                const uniqueId = force
                  ? `${w.prefix}-${person.id}-${occasion}-${year}-force-${Date.now()}`
                  : `${w.prefix}-${person.id}-${occasion}-${year}`

                if (!force) {
                  const { data: existing } = await supabase
                    .from('reminder_event_log')
                    .select('id')
                    .eq('klaviyo_unique_id', uniqueId)
                    .maybeSingle()
                  if (existing) {
                    skipped++
                    continue
                  }
                }

                try {
                  await klaviyo.trackEvent({
                    email: customer.email,
                    metricName: w.metric,
                    uniqueId,
                    properties: {
                      person_name: person.name,
                      occasion,
                      variant: person.variant,
                      next_occurrence: nextOcc,
                      days_until: w.days,
                    },
                  })
                  await supabase.from('reminder_event_log').insert({
                    customer_id: customer.id,
                    person_id: person.id,
                    occasion,
                    event_type: w.type,
                    next_occurrence: nextOcc,
                    klaviyo_unique_id: uniqueId,
                  })
                  emitted++
                } catch (err) {
                  await klaviyo.logSync(
                    customer.id,
                    'due_reminders',
                    'error',
                    { personId: person.id, occasion, nextOcc, window: w.days },
                    err instanceof Error ? err.message : String(err),
                  )
                  failed++
                }
              }
            }
          }
        }

        return new Response(
          JSON.stringify({ ok: true, emitted, skipped, failed, force }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      },
    },
  },
})
