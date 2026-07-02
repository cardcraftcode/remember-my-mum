import { createFileRoute } from '@tanstack/react-router'
import { setCookie } from '@tanstack/react-start/server'
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateOAuthState,
} from '@/lib/shopify.server'

const OAUTH_COOKIE = 'momcards_oauth'
const guestSecret = process.env.GUEST_TOKEN_SECRET || process.env.SHOPIFY_API_SECRET

export const Route = createFileRoute('/auth/shopify')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!process.env.SHOPIFY_APP_API_KEY) {
          return new Response('Missing Shopify app configuration', { status: 500 })
        }
        if (!guestSecret) {
          return new Response('Missing session secret', { status: 500 })
        }

        const url = new URL(request.url)
        const shopId =
          process.env.SHOPIFY_SHOP_ID || url.searchParams.get('shop_id') || ''

        if (!shopId || !/^\d+$/.test(shopId)) {
          return new Response(
            'Missing or invalid Shopify shop ID. Set SHOPIFY_SHOP_ID (numeric) or provide ?shop_id=',
            { status: 400 },
          )
        }

        const origin = url.origin
        const redirectUri = `${origin}/auth/shopify/callback`

        // Shopify Customer Account API OIDC discovery lives at shopify.com/authentication/{shop_id}
        const discoveryUrl = `https://shopify.com/authentication/${shopId}/.well-known/openid-configuration`

        const openidConfigRes = await fetch(discoveryUrl, {
          headers: { Accept: 'application/json' },
        })

        if (!openidConfigRes.ok) {
          return new Response(
            `Failed to discover Shopify OpenID configuration at ${discoveryUrl} (${openidConfigRes.status})`,
            { status: 500 },
          )
        }

        const openidConfig = (await openidConfigRes.json()) as {
          authorization_endpoint: string
        }

        const state = generateOAuthState()
        const codeVerifier = generateCodeVerifier()
        const codeChallenge = await generateCodeChallenge(codeVerifier)

        // Store state and verifier in a signed cookie
        const { SignJWT } = await import('jose')
        const oauthCookie = await new SignJWT({
          state,
          code_verifier: codeVerifier,
          origin,
          shopDomain,
        })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuedAt()
          .setExpirationTime('10m')
          .sign(new TextEncoder().encode(guestSecret))

        setCookie(OAUTH_COOKIE, oauthCookie, {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          maxAge: 60 * 10,
          path: '/',
        })

        const authUrl = new URL(openidConfig.authorization_endpoint)
        authUrl.searchParams.set('client_id', process.env.SHOPIFY_APP_API_KEY)
        authUrl.searchParams.set('response_type', 'code')
        authUrl.searchParams.set('redirect_uri', redirectUri)
        authUrl.searchParams.set('scope', 'openid email customer-account-api:full')
        authUrl.searchParams.set('state', state)
        authUrl.searchParams.set('code_challenge', codeChallenge)
        authUrl.searchParams.set('code_challenge_method', 'S256')

        return new Response(null, {
          status: 302,
          headers: { Location: authUrl.toString() },
        })
      },
    },
  },
})
