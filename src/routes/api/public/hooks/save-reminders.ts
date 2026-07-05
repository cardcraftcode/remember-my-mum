import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { upsertCustomerAndPeople, type PersonInput } from '@/lib/reminders.server'
import { MUM_VARIANTS } from '@/lib/mum-variants'

const VariantSchema = z.enum([...MUM_VARIANTS] as [string, ...string[]])

const PersonSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Accept ISO YYYY-MM-DD (web) or DD/MM/YYYY (checkout)
  dateOfBirth: z.string().regex(/^(?:\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})$/),
  variant: VariantSchema,
  remindsBirthday: z.boolean().default(true),
  remindsChristmas: z.boolean().default(true),
  remindsMothersDay: z.boolean().default(true),
})

const bodySchema = z.object({
  email: z.string().email(),
  order_id: z.union([z.string(), z.number(), z.null()]).optional(),
  people: z.array(PersonSchema).min(1),
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

function toIsoDate(input: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input
  const [dd, mm, yyyy] = input.split('/')
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
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

        const { email, people, shop_domain } = parsed.data

        const peopleInput: PersonInput[] = people.map((p) => ({
          name: p.name,
          dateOfBirth: toIsoDate(p.dateOfBirth),
          variant: p.variant,
          remindsBirthday: p.remindsBirthday,
          remindsChristmas: p.remindsChristmas,
          remindsMothersDay: p.remindsMothersDay,
        }))

        try {
          const result = await upsertCustomerAndPeople({
            email,
            shopDomain: shop_domain ?? 'shopify-checkout',
            people: peopleInput,
            replaceAll: false,
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
