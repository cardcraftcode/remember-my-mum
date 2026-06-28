import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'
import { verifyGuestToken } from './shopify.server'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const guestSecret = process.env.GUEST_TOKEN_SECRET || process.env.SHOPIFY_API_SECRET

const VerifyGuestTokenSchema = z.object({
  token: z.string().min(1),
})

const ExchangeShopifyAuthSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  shopDomain: z.string().min(1),
})

function getSupabaseAdmin() {
  return createClient<Database>(supabaseUrl, supabaseServiceRoleKey, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  })
}

export const verifyGuestDashboardToken = createServerFn({ method: 'POST' })
  .validator((input: unknown) => VerifyGuestTokenSchema.parse(input))
  .handler(async ({ data }) => {
    if (!guestSecret) {
      throw new Error('Missing guest token secret')
    }

    const { customerId, email, version } = await verifyGuestToken(data.token, guestSecret)

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

    return { customerId, email, version }
  })

export const exchangeShopifyAuthCode = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ExchangeShopifyAuthSchema.parse(input))
  .handler(async ({ data }) => {
    if (!process.env.SHOPIFY_APP_API_KEY || !process.env.SHOPIFY_API_SECRET) {
      throw new Error('Missing Shopify credentials')
    }

    // Discover token endpoint
    const openidConfigRes = await fetch(
      `https://${data.shopDomain}/.well-known/openid-configuration`,
      { headers: { Accept: 'application/json' } },
    )

    if (!openidConfigRes.ok) {
      throw new Error('Failed to discover Shopify OpenID configuration')
    }

    const openidConfig = (await openidConfigRes.json()) as {
      token_endpoint: string
    }

    // Look up stored verifier by state
    const supabaseAdmin = getSupabaseAdmin()
    const { data: verifier, error: verifierError } = await supabaseAdmin
      .from('shopify_auth_states')
      .select('*')
      .eq('state', data.state)
      .single()

    if (verifierError || !verifier) {
      throw new Error('Invalid or expired OAuth state')
    }

    // Delete verifier to prevent replay
    await supabaseAdmin.from('shopify_auth_states').delete().eq('id', verifier.id)

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
        redirect_uri: `${verifier.origin}/auth/shopify/callback`,
        code: data.code,
        code_verifier: verifier.code_verifier,
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

    // Extract email from id_token if available, otherwise call Customer Account API
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
      // Fallback: query Customer Account API
      const customerApiConfigRes = await fetch(
        `https://${data.shopDomain}/.well-known/customer-account-api`,
        { headers: { Accept: 'application/json' } },
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

    // Upsert customer record
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

    return {
      customerId: customer.id,
      email: customer.email,
      shopifyCustomerId: customer.shopify_customer_id,
    }
  })

export const createGuestDashboardLink = createServerFn({ method: 'POST' })
  .validator((input: unknown) => z.object({ customerId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    if (!guestSecret) {
      throw new Error('Missing guest token secret')
    }

    const supabaseAdmin = getSupabaseAdmin()
    const { data: customer, error } = await supabaseAdmin
      .from('reminder_customers')
      .select('*')
      .eq('id', data.customerId)
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
  })
