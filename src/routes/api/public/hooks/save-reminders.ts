import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { upsertCustomerAndReminders } from '@/lib/reminders.server'
import { MUM_VARIANTS } from '@/lib/mum-variants'

// Public endpoint called by the Shopify Checkout UI Extension on the
// Thank You page. Called cross-origin from *.myshopify.com and the
// shop's checkout domain, so it must set CORS headers.
//
// Body shape (from shopify-extension/extensions/mum-reminders):
//   { email, order_id?, mum_birthday? (DD/MM), reminders: { birthday, christmas, mothers_day }, mum_variants? }


const bodySchema = z.object({
  email: z.string().email(),
  order_id: z.union([z.string(), z.number(), z.null()]).optional(),
  mum_birthday: z
    .string()
    .regex(/^\d{2}\/\d{2}(\/\d{4})?$/)
    .nullable()
    .optional(),
  reminders: z.object({
    birthday: z.boolean(),
    christmas: z.boolean(),
    mothers_day: z.boolean(),
  }),
  shop_domain: z.string().optional(),
  mum_variants: z.array(z.enum([...MUM_VARIANTS] as [string, ...string[]])).optional(),
})


const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400',
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

// Convert "DD/MM" or "DD/MM/YYYY" to ISO "YYYY-MM-DD".
// Year defaults to 2000 when omitted (used only as a placeholder;
// nextBirthday() re-projects to the next upcoming occurrence).
function parseBirthday(input: string | null | undefined): string | null {
  if (!input) return null
  const parts = input.split('/')
  const dd = parts[0].padStart(2, '0')
  const mm = parts[1].padStart(2, '0')
  const yyyy = parts[2] ?? '2000'
  return `${yyyy}-${mm}-${dd}`
}

export const Route = createFileRoute('/api/public/hooks/save-reminders')({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      POST: async ({ request }) => {
        let raw: unknown
        try {
          raw = await request.json()
        } catch {
          return json(400, { error: 'Invalid JSON' })
        }

        const parsed = bodySchema.safeParse(raw)
        if (!parsed.success) {
          return json(400, { error: 'Invalid body', issues: parsed.error.issues })
        }

        const { email, mum_birthday, reminders, shop_domain } = parsed.data

        try {
          const result = await upsertCustomerAndReminders({
            email,
            shopDomain: shop_domain ?? 'shopify-checkout',
            mumBirthday: parseBirthday(mum_birthday),
            remindsBirthday: reminders.birthday,
            remindsChristmas: reminders.christmas,
            remindsMothersDay: reminders.mothers_day,
          })
          return json(200, { ok: true, customer_id: result.customer.id })
        } catch (err) {
          return json(500, {
            error: err instanceof Error ? err.message : 'Unknown error',
          })
        }
      },
    },
  },
})
