import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

const VerifyGuestTokenSchema = z.object({
  token: z.string().min(1),
})

const ExchangeShopifyAuthSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  shopDomain: z.string().min(1),
})

export const getSession = createServerFn({ method: 'GET' })
  .validator(() => true)
  .handler(async () => {
    const { readSessionCookie } = await import('./auth.server')
    return (await readSessionCookie()) ?? { customerId: null, email: null, shopifyCustomerId: null }
  })

export const logout = createServerFn({ method: 'POST' })
  .validator(() => true)
  .handler(async () => {
    const { deleteSessionCookie } = await import('./auth.server')
    deleteSessionCookie()
    return { success: true }
  })

export const verifyGuestDashboardToken = createServerFn({ method: 'POST' })
  .validator((input: unknown) => VerifyGuestTokenSchema.parse(input))
  .handler(async ({ data }) => {
    const { verifyGuestAndSignSession } = await import('./auth.server')
    return verifyGuestAndSignSession(data.token)
  })

// createGuestDashboardLink is deliberately not exported as a server function.
// It would be a public HTTP endpoint that hands out a session token for any
// customer UUID. If you need to generate a login link, call createGuestToken()
// from trusted server-side code (webhook, cron) and email the resulting link
// to the customer.


export const exchangeShopifyAuthCode = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ExchangeShopifyAuthSchema.parse(input))
  .handler(async ({ data }) => {
    const { exchangeShopifyAuthCode: exchange } = await import('./auth.server')
    return exchange(data)
  })
