import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { upsertCustomerAndPeople, getSupabaseAdmin } from '@/lib/reminders.server'
import { verifyShopifySessionToken } from '@/lib/shopify.server'
import { MUM_VARIANTS } from '@/lib/mum-variants'

const VariantSchema = z.enum([...MUM_VARIANTS] as [string, ...string[]])

const PersonSchema = z.object({
  name: z.string().trim().min(1).max(120),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  variant: VariantSchema,
  remindsBirthday: z.boolean().default(true),
  remindsChristmas: z.boolean().default(true),
  remindsMothersDay: z.boolean().default(true),
})

const ReminderPayloadSchema = z.object({
  email: z.string().email(),
  shopDomain: z.string().min(1),
  people: z.array(PersonSchema).default([]),
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
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS_HEADERS }),

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

        const admin = getSupabaseAdmin()

        const { data: customer, error: customerError } = await admin
          .from('reminder_customers')
          .select('id')
          .eq('shopify_customer_id', tokenCustomerId)
          .maybeSingle()

        if (customerError) {
          console.error('Customer lookup failed', customerError)
          return textResponse('Failed to load reminders', 500)
        }

        if (!customer) {
          return jsonResponse({ people: [] })
        }

        const { data: people, error: peopleErr } = await admin
          .from('reminder_people')
          .select(
            'id, name, date_of_birth, variant, reminds_birthday, reminds_christmas, reminds_mothers_day',
          )
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
            variant: p.variant,
            remindsBirthday: p.reminds_birthday,
            remindsChristmas: p.reminds_christmas,
            remindsMothersDay: p.reminds_mothers_day,
          })),
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
          const admin = getSupabaseAdmin()

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

          const result = await upsertCustomerAndPeople({
            email: payload.email,
            shopDomain: payload.shopDomain,
            shopifyCustomerId: tokenCustomerId,
            people: payload.people,
            replaceAll: true,
            consentTimestamp: new Date(),
            appBaseUrl: new URL(request.url).origin,
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
