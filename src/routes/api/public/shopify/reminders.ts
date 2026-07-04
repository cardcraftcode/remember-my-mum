import { createFileRoute } from '@tanstack/react-router'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from '@/integrations/supabase/types'
import { upsertCustomerAndReminders } from '@/lib/reminders.server'
import { verifyShopifySessionToken } from '@/lib/shopify.server'

const BirthdayEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mumVariants: z.array(z.string()).default([]),
})

const ReminderPayloadSchema = z.object({
  email: z.string().email(),
  shopDomain: z.string().min(1),
  // New multi-birthday shape.
  birthdays: z.array(BirthdayEntrySchema).optional(),
  // Legacy single-birthday fields — used only if `birthdays` is absent.
  mumBirthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  remindsBirthday: z.boolean().optional(),
  remindsChristmas: z.boolean().optional(),
  remindsMothersDay: z.boolean().optional(),
})

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...(init?.headers ?? {}),
    },
  })
}

function textResponse(body: string, status: number) {
  return new Response(body, { status, headers: { ...CORS_HEADERS } })
}

export const Route = createFileRoute('/api/public/shopify/reminders')({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, { status: 204, headers: CORS_HEADERS }),

      GET: async ({ request }) => {
        const authHeader = request.headers.get('authorization')
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return textResponse('Missing session token', 401)
        }
        const token = authHeader.replace('Bearer ', '')

        let claims: { iss: string; sub?: string }
        try {
          claims = await verifyShopifySessionToken(token)
        } catch (error) {
          console.error('Shopify session token verification failed', error)
          return textResponse('Invalid session token', 401)
        }
        const tokenCustomerId = claims.sub
        if (!tokenCustomerId) {
          return textResponse('Session token missing customer identity', 401)
        }

        const supabaseUrl = process.env.SUPABASE_URL
        const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
        if (!supabaseUrl || !supabaseServiceRoleKey) {
          return textResponse('Server misconfigured', 500)
        }
        const admin = createClient<Database>(supabaseUrl, supabaseServiceRoleKey, {
          auth: {
            storage: undefined,
            persistSession: false,
            autoRefreshToken: false,
          },
        })

        const { data: customer, error: customerError } = await admin
          .from('reminder_customers')
          .select('id, email')
          .eq('shopify_customer_id', tokenCustomerId)
          .maybeSingle()

        if (customerError) {
          console.error('Customer lookup failed', customerError)
          return textResponse('Failed to load reminders', 500)
        }

        if (!customer) {
          return jsonResponse({
            birthdays: [],
            remindsChristmas: false,
            remindsMothersDay: false,
          })
        }

        const { data: reminders, error: remindersError } = await admin
          .from('reminders')
          .select('event_type, event_date, enabled, mum_variants')
          .eq('customer_id', customer.id)

        if (remindersError) {
          console.error('Reminders lookup failed', remindersError)
          return textResponse('Failed to load reminders', 500)
        }

        const birthdays = (reminders ?? [])
          .filter((r) => r.event_type === 'birthday' && r.enabled && r.event_date)
          .map((r) => ({
            date: r.event_date as string,
            mumVariants: (r.mum_variants ?? []) as string[],
          }))
        const remindsChristmas = (reminders ?? []).some(
          (r) => r.event_type === 'christmas' && r.enabled,
        )
        const remindsMothersDay = (reminders ?? []).some(
          (r) => r.event_type === 'mothers_day' && r.enabled,
        )

        return jsonResponse({ birthdays, remindsChristmas, remindsMothersDay })
      },

      POST: async ({ request }) => {
        const authHeader = request.headers.get('authorization')
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return textResponse('Missing session token', 401)
        }

        const token = authHeader.replace('Bearer ', '')

        let claims: { iss: string; sub?: string }
        try {
          claims = await verifyShopifySessionToken(token)
        } catch (error) {
          console.error('Shopify session token verification failed', error)
          return new Response('Invalid session token', { status: 401 })
        }

        // The Shopify session token's `sub` is the customer's GID.
        // We MUST bind the write to this token-derived identity — not to the
        // client-supplied email — otherwise any authenticated customer can
        // overwrite another customer's record by sending their email.
        const tokenCustomerId = claims.sub
        if (!tokenCustomerId) {
          return new Response('Session token missing customer identity', {
            status: 401,
          })
        }

        let body: unknown
        try {
          body = await request.json()
        } catch {
          return new Response('Invalid JSON body', { status: 400 })
        }

        const parsed = ReminderPayloadSchema.safeParse(body)
        if (!parsed.success) {
          return new Response(JSON.stringify(parsed.error.format()), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        const payload = parsed.data

        try {
          // Ensure the email in the payload isn't already bound to a
          // different Shopify customer.
          const supabaseUrl = process.env.SUPABASE_URL
          const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
          if (!supabaseUrl || !supabaseServiceRoleKey) {
            throw new Error('Missing Supabase server credentials')
          }
          const admin = createClient<Database>(
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

          const { data: existing, error: lookupError } = await admin
            .from('reminder_customers')
            .select('id, email, shopify_customer_id')
            .eq('email', payload.email)
            .maybeSingle()

          if (lookupError) {
            console.error('Customer lookup failed', lookupError)
            return new Response('Failed to save reminders. Please try again.', {
              status: 500,
            })
          }

          if (
            existing &&
            existing.shopify_customer_id &&
            existing.shopify_customer_id !== tokenCustomerId
          ) {
            // Email belongs to a different Shopify customer — refuse.
            return new Response('Forbidden', { status: 403 })
          }

          // Derive canonical birthday list from either the new or legacy shape.
          let birthdayInput: Array<{ date: string; mumVariants: string[] }> = []
          if (payload.remindsBirthday === false) {
            birthdayInput = []
          } else if (payload.birthdays && payload.birthdays.length > 0) {
            birthdayInput = payload.birthdays
          } else if (payload.mumBirthday) {
            birthdayInput = [{ date: payload.mumBirthday, mumVariants: [] }]
          }

          const result = await upsertCustomerAndReminders({
            email: payload.email,
            shopDomain: payload.shopDomain,
            // Always derive from the verified token, never trust the client.
            shopifyCustomerId: tokenCustomerId,
            birthdays: birthdayInput,
            remindsChristmas: payload.remindsChristmas ?? false,
            remindsMothersDay: payload.remindsMothersDay ?? false,
            consentTimestamp: new Date(),
          })

          return Response.json({
            success: true,
            customerId: result.customer.id,
            reminders: result.reminders,
          })
        } catch (error) {
          console.error('Failed to save reminders', error)
          return new Response(
            'Failed to save reminders. Please try again.',
            { status: 500 },
          )
        }
      },
    },
  },
})
