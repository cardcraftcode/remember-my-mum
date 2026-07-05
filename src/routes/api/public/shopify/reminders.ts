import { createFileRoute } from '@tanstack/react-router'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from '@/integrations/supabase/types'
import { upsertCustomerAndPeople } from '@/lib/reminders.server'
import { verifyShopifySessionToken } from '@/lib/shopify.server'

const PersonSchema = z.object({
  name: z.string().trim().min(1).max(120),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mumVariants: z.array(z.string()).default([]),
})

const ReminderPayloadSchema = z.object({
  email: z.string().email(),
  shopDomain: z.string().min(1),
  people: z.array(PersonSchema).default([]),
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
          .select('id, reminds_christmas, reminds_mothers_day')
          .eq('shopify_customer_id', tokenCustomerId)
          .maybeSingle()

        if (customerError) {
          console.error('Customer lookup failed', customerError)
          return textResponse('Failed to load reminders', 500)
        }

        if (!customer) {
          return jsonResponse({
            people: [],
            remindsChristmas: true,
            remindsMothersDay: true,
          })
        }

        const { data: people, error: peopleErr } = await admin
          .from('reminder_people')
          .select('id, name, date_of_birth, mum_variants, reminds_birthday')
          .eq('customer_id', customer.id)
          .order('created_at', { ascending: true })

        if (peopleErr) {
          console.error('People lookup failed', peopleErr)
          return textResponse('Failed to load reminders', 500)
        }

        return jsonResponse({
          people: (people ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            dateOfBirth: p.date_of_birth,
            mumVariants: p.mum_variants ?? [],
            remindsBirthday: p.reminds_birthday,
          })),
          remindsChristmas: customer.reminds_christmas,
          remindsMothersDay: customer.reminds_mothers_day,
        })
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
          return textResponse('Invalid session token', 401)
        }

        const tokenCustomerId = claims.sub
        if (!tokenCustomerId) {
          return textResponse('Session token missing customer identity', 401)
        }

        let body: unknown
        try {
          body = await request.json()
        } catch {
          return textResponse('Invalid JSON body', 400)
        }

        const parsed = ReminderPayloadSchema.safeParse(body)
        if (!parsed.success) {
          return jsonResponse(parsed.error.format(), { status: 400 })
        }

        const payload = parsed.data

        try {
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
            return textResponse('Failed to save reminders. Please try again.', 500)
          }

          if (
            existing &&
            existing.shopify_customer_id &&
            existing.shopify_customer_id !== tokenCustomerId
          ) {
            return textResponse('Forbidden', 403)
          }

          // Replace the customer's people list with the submitted set.
          // First upsert the customer + append any new people via the shared
          // helper, then reconcile deletions/updates for this authenticated
          // customer specifically.
          const result = await upsertCustomerAndPeople({
            email: payload.email,
            shopDomain: payload.shopDomain,
            shopifyCustomerId: tokenCustomerId,
            people: payload.people,
            remindsChristmas: payload.remindsChristmas,
            remindsMothersDay: payload.remindsMothersDay,
            consentTimestamp: new Date(),
          })

          return jsonResponse({
            success: true,
            customerId: result.customer.id,
            people: result.people,
          })
        } catch (error) {
          console.error('Failed to save reminders', error)
          return textResponse('Failed to save reminders. Please try again.', 500)
        }
      },
    },
  },
})
