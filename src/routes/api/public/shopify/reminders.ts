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

export const Route = createFileRoute('/api/public/shopify/reminders')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authHeader = request.headers.get('authorization')
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return new Response('Missing session token', { status: 401 })
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

          const result = await upsertCustomerAndReminders({
            email: payload.email,
            shopDomain: payload.shopDomain,
            // Always derive from the verified token, never trust the client.
            shopifyCustomerId: tokenCustomerId,
            mumBirthday: payload.mumBirthday ?? null,
            remindsBirthday: payload.remindsBirthday ?? false,
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
