import { jwtVerify, SignJWT } from 'jose'

const SHOPIFY_APP_API_KEY = process.env.SHOPIFY_APP_API_KEY
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET

const SHOPIFY_CUSTOMER_AUTH_USER_AGENT =
  'Mom Cards Customer Account OAuth (https://momcards.co.uk)'

export function normalizeShopifyDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
}

export function getShopifyCustomerAccountDomain(candidate?: string | null): string {
  const domain = normalizeShopifyDomain(
    process.env.SHOPIFY_CUSTOMER_ACCOUNT_DOMAIN ||
      process.env.SHOPIFY_STOREFRONT_DOMAIN ||
      process.env.SHOPIFY_SHOP_DOMAIN ||
      candidate ||
      '',
  )

  if (!domain || domain.endsWith('.myshopify.com')) {
    return ''
  }

  return domain
}

export function shopifyCustomerAccountFetchHeaders(): HeadersInit {
  return {
    Accept: 'application/json',
    'User-Agent': SHOPIFY_CUSTOMER_AUTH_USER_AGENT,
  }
}

export type ShopifySessionClaims = {
  iss: string
  sub?: string
  aud: string
  exp: number
  nbf: number
  iat: number
  [key: string]: unknown
}

export async function verifyShopifySessionToken(
  token: string,
): Promise<ShopifySessionClaims> {
  if (!SHOPIFY_API_SECRET) {
    throw new Error('Missing SHOPIFY_API_SECRET')
  }
  if (!SHOPIFY_APP_API_KEY) {
    throw new Error('Missing SHOPIFY_APP_API_KEY')
  }

  const secret = new TextEncoder().encode(SHOPIFY_API_SECRET)
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ['HS256'],
    audience: SHOPIFY_APP_API_KEY,
  })

  return payload as ShopifySessionClaims
}

export async function verifyShopifyWebhookSignature(
  body: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  )
  const expected = Buffer.from(mac).toString('base64')
  return signature === expected
}

export async function signGuestToken(
  payload: {
    customerId: string
    email: string
    version: number
  },
  secret: string,
  expiresIn = '7d',
): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return new SignJWT({
    customerId: payload.customerId,
    email: payload.email,
    version: payload.version,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key)
}

export async function verifyGuestToken(
  token: string,
  secret: string,
): Promise<{ customerId: string; email: string; version: number }> {
  const key = new TextEncoder().encode(secret)
  const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })
  return {
    customerId: payload.customerId as string,
    email: payload.email as string,
    version: payload.version as number,
  }
}

export function generateCodeVerifier(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return Buffer.from(array)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Buffer.from(digest)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function generateOAuthState(): string {
  const array = new Uint8Array(16)
  crypto.getRandomValues(array)
  return Buffer.from(array).toString('hex')
}

