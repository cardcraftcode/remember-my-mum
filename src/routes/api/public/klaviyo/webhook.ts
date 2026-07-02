import { createFileRoute } from '@tanstack/react-router'
import { createHmac, timingSafeEqual } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'

// Klaviyo webhook: handles unsubscribe + profile-deleted events and flips
// the matching reminder toggles off in our DB. Signature verified with
// HMAC-SHA256 over the raw request body using KLAVIYO_WEBHOOK_SECRET.
export const Route = createFileRoute('/api/public/klaviyo/webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.KLAVIYO_WEBHOOK_SECRET
        if (!secret) {
          return new Response(
            JSON.stringify({ error: 'Webhook secret not configured' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const rawBody = await request.text()
        const signatureHeader =
          request.headers.get('x-klaviyo-signature') ||
          request.headers.get('klaviyo-signature') ||
          ''

        const expected = createHmac('sha256', secret)
          .update(rawBody)
          .digest('base64')

        const sig = Buffer.from(signatureHeader)
        const exp = Buffer.from(expected)
        if (sig.length !== exp.length || !timingSafeEqual(sig, exp)) {
          return new Response(
            JSON.stringify({ error: 'Invalid signature' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          )
        }

        let payload: {
          type?: string
          data?: {
            type?: string
            attributes?: {
              event_name?: string
              metric?: { name?: string }
              email?: string
              profile?: { email?: string }
            }
          }
        }
        try {
          payload = JSON.parse(rawBody)
        } catch {
          return new Response(
            JSON.stringify({ error: 'Invalid JSON' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const attrs = payload.data?.attributes ?? {}
        const eventName =
          attrs.event_name || attrs.metric?.name || payload.type || ''
        const email = attrs.email || attrs.profile?.email

        if (!email) {
          return new Response(JSON.stringify({ ok: true, skipped: 'no email' }), {
            headers: { 'Content-Type': 'application/json' },
          })
        }

        const supabase = createClient<Database>(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          {
            auth: {
              storage: undefined,
              persistSession: false,
              autoRefreshToken: false,
            },
          },
        )

        const { data: customer } = await supabase
          .from('reminder_customers')
          .select('id')
          .eq('email', email)
          .maybeSingle()

        if (!customer) {
          return new Response(
            JSON.stringify({ ok: true, skipped: 'unknown email' }),
            { headers: { 'Content-Type': 'application/json' } },
          )
        }

        const lower = eventName.toLowerCase()
        const isUnsubscribe =
          lower.includes('unsubscrib') || lower.includes('suppress')
        const isDelete = lower.includes('delet')

        if (isUnsubscribe || isDelete) {
          await supabase
            .from('reminders')
            .update({ enabled: false })
            .eq('customer_id', customer.id)

          await supabase.from('klaviyo_sync_log').insert({
            customer_id: customer.id,
            action: isDelete ? 'webhook_delete' : 'webhook_unsubscribe',
            status: 'success',
            payload: payload as unknown as Database['public']['Tables']['klaviyo_sync_log']['Insert']['payload'],
          })
        }

        return new Response(
          JSON.stringify({ ok: true, event: eventName }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      },
    },
  },
})
