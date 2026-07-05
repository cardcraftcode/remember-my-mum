import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { upsertCustomerAndPeople, type PersonInput } from '@/lib/reminders.server'
import { MUM_VARIANTS, type MumVariant } from '@/lib/mum-variants'

const MumVariantSchema = z.enum([...MUM_VARIANTS] as [string, ...string[]])

const PersonSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Accept ISO YYYY-MM-DD from the account extension; or DD/MM / DD/MM/YYYY
  // from the checkout extension.
  dateOfBirth: z
    .string()
    .regex(/^(?:\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}(?:\/\d{4})?)$/),
  mumVariants: z.array(MumVariantSchema).default([]),
})

const bodySchema = z.object({
  email: z.string().email(),
  order_id: z.union([z.string(), z.number(), z.null()]).optional(),
  people: z.array(PersonSchema).optional(),
  reminders: z.object({
    birthday: z.boolean(),
    christmas: z.boolean(),
    mothers_day: z.boolean(),
  }),
  shop_domain: z.string().optional(),
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

// Normalise DD/MM or DD/MM/YYYY into ISO YYYY-MM-DD. Year defaults to 2000
// when omitted, matching prior behaviour for checkout submissions.
function toIsoDate(input: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input
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

        const { email, people, reminders, shop_domain } = parsed.data

        const peopleInput: PersonInput[] = reminders.birthday && people
          ? people.map((p) => ({
              name: p.name,
              dateOfBirth: toIsoDate(p.dateOfBirth),
              mumVariants: p.mumVariants as MumVariant[],
              remindsBirthday: true,
            }))
          : []

        try {
          const result = await upsertCustomerAndPeople({
            email,
            shopDomain: shop_domain ?? 'shopify-checkout',
            people: peopleInput,
            remindsChristmas: reminders.christmas,
            remindsMothersDay: reminders.mothers_day,
            appBaseUrl: new URL(request.url).origin,
          })
          return json(200, { ok: true, customer_id: result.customer.id })
        } catch (err) {
          console.error('save-reminders failed', err)
          return json(500, {
            error: err instanceof Error ? err.message : 'Unknown error',
          })
        }
      },
    },
  },
})
