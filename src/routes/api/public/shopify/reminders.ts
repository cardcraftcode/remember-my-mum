import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { upsertCustomerAndReminders } from '@/lib/reminders.server'
import { verifyShopifySessionToken } from '@/lib/shopify.server'

const ReminderPayloadSchema = z.object({
  email: z.string().email(),
  shopDomain: z.string().min(1),
  shopifyCustomerId: z.string().optional().nullable(),
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
          const result = await upsertCustomerAndReminders({
            email: payload.email,
            shopDomain: payload.shopDomain,
            shopifyCustomerId: payload.shopifyCustomerId,
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
            error instanceof Error ? error.message : 'Failed to save reminders',
            { status: 500 },
          )
        }
      },
    },
  },
})
