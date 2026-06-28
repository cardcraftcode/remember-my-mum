import { jwtVerify, SignJWT } from 'jose'

const SHOPIFY_APP_API_KEY = process.env.SHOPIFY_APP_API_KEY
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET

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
