import { createServerFn } from '@tanstack/react-start'
import { getCookie, setCookie, deleteCookie } from '@tanstack/react-start/server'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'
import {
  getShopifyCustomerAccountDomain,
  shopifyCustomerAccountFetchHeaders,
  verifyGuestToken,
} from './shopify.server'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const guestSecret = process.env.GUEST_TOKEN_SECRET || process.env.SHOPIFY_API_SECRET

const SESSION_COOKIE = 'momcards_session'
const OAUTH_COOKIE = 'momcards_oauth'

function getSupabaseAdmin() {
  return createClient<Database>(supabaseUrl, supabaseServiceRoleKey, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  })
}

export type SessionPayload = {
  customerId: string
  email: string
  shopifyCustomerId?: string | null
}

async function signSession(payload: SessionPayload): Promise<string> {
  if (!guestSecret) throw new Error('Missing session secret')
  const { SignJWT } = await import('jose')
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(new TextEncoder().encode(guestSecret))
}

export async function readSessionCookie(): Promise<SessionPayload | null> {
  const token = getCookie(SESSION_COOKIE)
  if (!token) return null
  try {
    if (!guestSecret) throw new Error('Missing session secret')
    const { jwtVerify } = await import('jose')
    const { payload } = await jwtVerify(token, new TextEncoder().encode(guestSecret), {
      algorithms: ['HS256'],
    })
    return {
      customerId: payload.customerId as string,
      email: payload.email as string,
      shopifyCustomerId: payload.shopifyCustomerId as string | null | undefined,
    }
  } catch {
    return null
  }
}

export function deleteSessionCookie() {
  deleteCookie(SESSION_COOKIE)
}

export async function verifyGuestAndSignSession(token: string) {
  if (!guestSecret) {
    throw new Error('Missing guest token secret')
  }

  const { customerId, email } = await verifyGuestToken(token, guestSecret)

  const supabaseAdmin = getSupabaseAdmin()
  const { data: customer, error } = await supabaseAdmin
    .from('reminder_customers')
    .select('*')
    .eq('id', customerId)
    .eq('email', email)
    .single()

  if (error || !customer) {
    throw new Error('Customer not found')
  }

  const session = await signSession({
    customerId: customer.id,
    email: customer.email,
    shopifyCustomerId: customer.shopify_customer_id,
  })
  setCookie(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  })

  return { customerId: customer.id, email: customer.email }
}

export async function createGuestToken(customerId: string) {
  if (!guestSecret) {
    throw new Error('Missing guest token secret')
  }

  const supabaseAdmin = getSupabaseAdmin()
  const { data: customer, error } = await supabaseAdmin
    .from('reminder_customers')
    .select('*')
    .eq('id', customerId)
    .single()

  if (error || !customer) {
    throw new Error('Customer not found')
  }

  const { signGuestToken } = await import('./shopify.server')
  const token = await signGuestToken(
    { customerId: customer.id, email: customer.email, version: 1 },
    guestSecret,
    '365d',
  )

  return { token }
}

export async function exchangeShopifyAuthCode(data: {
  code: string
  state: string
  shopDomain: string
}) {
  if (!process.env.SHOPIFY_APP_API_KEY || !process.env.SHOPIFY_API_SECRET) {
    throw new Error('Missing Shopify credentials')
  }

  const oauthCookie = getCookie(OAUTH_COOKIE)
  if (!oauthCookie) {
    throw new Error('OAuth cookie missing or expired')
  }

  let oauthState: { state: string; code_verifier: string; origin: string; shopDomain: string }
  try {
    if (!guestSecret) throw new Error('Missing session secret')
    const { jwtVerify } = await import('jose')
    const { payload } = await jwtVerify(oauthCookie, new TextEncoder().encode(guestSecret), {
      algorithms: ['HS256'],
    })
    oauthState = payload as typeof oauthState
  } catch {
    throw new Error('Invalid OAuth state cookie')
  }

  const shopDomain = getShopifyCustomerAccountDomain(data.shopDomain)

  if (!shopDomain) {
    throw new Error('Missing Shopify customer account domain')
  }

  if (oauthState.state !== data.state || oauthState.shopDomain !== shopDomain) {
    throw new Error('OAuth state mismatch')
  }

  deleteCookie(OAUTH_COOKIE)

  const openidConfigRes = await fetch(
    `https://${shopDomain}/.well-known/openid-configuration`,
    { headers: shopifyCustomerAccountFetchHeaders() },
  )

  if (!openidConfigRes.ok) {
    throw new Error('Failed to discover Shopify OpenID configuration')
  }

  const openidConfig = (await openidConfigRes.json()) as {
    token_endpoint: string
  }

  const tokenResponse = await fetch(openidConfig.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(
        `${process.env.SHOPIFY_APP_API_KEY}:${process.env.SHOPIFY_API_SECRET}`,
      ).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.SHOPIFY_APP_API_KEY,
      redirect_uri: `${oauthState.origin}/auth/shopify/callback`,
      code: data.code,
      code_verifier: oauthState.code_verifier,
    }).toString(),
  })

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text()
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorBody}`)
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string
    id_token?: string
    expires_in: number
    refresh_token?: string
  }

  let email: string | null = null
  let shopifyCustomerId: string | null = null

  if (tokenData.id_token) {
    const [, payloadB64] = tokenData.id_token.split('.')
    if (payloadB64) {
      const payload = JSON.parse(
        Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
      ) as { email?: string; sub?: string }
      email = payload.email ?? null
      shopifyCustomerId = payload.sub ? `gid://shopify/Customer/${payload.sub}` : null
    }
  }

  if (!email) {
    const customerApiConfigRes = await fetch(
      `https://${shopDomain}/.well-known/customer-account-api`,
      { headers: shopifyCustomerAccountFetchHeaders() },
    )
    if (!customerApiConfigRes.ok) {
      throw new Error('Failed to discover Customer Account API configuration')
    }
    const customerApiConfig = (await customerApiConfigRes.json()) as {
      api_version: string
      endpoint: string
    }

    const customerRes = await fetch(customerApiConfig.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Customer-Access-Token': tokenData.access_token,
      },
      body: JSON.stringify({
        query: `
          query {
            customer {
              id
              email
            }
          }
        `,
      }),
    })

    if (!customerRes.ok) {
      throw new Error('Failed to fetch customer from Customer Account API')
    }

    const customerJson = (await customerRes.json()) as {
      data?: { customer?: { id?: string; email?: string } }
      errors?: unknown[]
    }
    if (customerJson.errors?.length) {
      throw new Error(JSON.stringify(customerJson.errors))
    }
    email = customerJson.data?.customer?.email ?? null
    shopifyCustomerId = customerJson.data?.customer?.id ?? null
  }

  if (!email) {
    throw new Error('Could not retrieve customer email from Shopify')
  }

  const supabaseAdmin = getSupabaseAdmin()
  const { data: existing, error: findError } = await supabaseAdmin
    .from('reminder_customers')
    .select('*')
    .eq('email', email)
    .maybeSingle()

  if (findError) throw findError

  let customer: Database['public']['Tables']['reminder_customers']['Row']
  if (existing) {
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('reminder_customers')
      .update({
        shopify_customer_id: shopifyCustomerId ?? existing.shopify_customer_id,
        shop_domain: data.shopDomain,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single()
    if (updateError || !updated) throw updateError ?? new Error('Failed to update customer')
    customer = updated
  } else {
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('reminder_customers')
      .insert({
        email,
        shopify_customer_id: shopifyCustomerId,
        shop_domain: data.shopDomain,
        consent_timestamp: new Date().toISOString(),
      })
      .select()
      .single()
    if (insertError || !inserted) throw insertError ?? new Error('Failed to insert customer')
    customer = inserted
  }

  const session = await signSession({
    customerId: customer.id,
    email: customer.email,
    shopifyCustomerId: customer.shopify_customer_id,
  })
  setCookie(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  })

  return {
    customerId: customer.id,
    email: customer.email,
    shopifyCustomerId: customer.shopify_customer_id,
  }
}

// Backwards-compatible exports (kept for direct server use only).
export const verifyGuestDashboardToken = createServerFn({ method: 'POST' })
  .validator((input: unknown) => z.object({ token: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => verifyGuestAndSignSession(data.token))

export const createGuestDashboardLink = createServerFn({ method: 'POST' })
  .validator((input: unknown) => z.object({ customerId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => createGuestToken(data.customerId))

export const exchangeShopifyAuth = createServerFn({ method: 'POST' })
  .validator((input: unknown) =>
    z
      .object({
        code: z.string().min(1),
        state: z.string().min(1),
        shopDomain: z.string().min(1),
      })
      .parse(input),
  )
  .handler(async ({ data }) => exchangeShopifyAuthCode(data))
