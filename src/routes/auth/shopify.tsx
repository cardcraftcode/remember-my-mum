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
        const shopDomain =
          process.env.SHOPIFY_SHOP_DOMAIN || url.searchParams.get('shop_domain') || ''

        if (!shopDomain) {
          return new Response(
            'Missing Shopify shop domain. Set SHOPIFY_SHOP_DOMAIN or provide ?shop_domain=',
            { status: 400 },
          )
        }

        const origin = url.origin
        const redirectUri = `${origin}/auth/shopify/callback`

        // Discover authorization endpoint
        const openidConfigRes = await fetch(
          `https://${shopDomain}/.well-known/openid-configuration`,
          { headers: { Accept: 'application/json' } },
        )

        if (!openidConfigRes.ok) {
          return new Response('Failed to discover Shopify OpenID configuration', { status: 500 })
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
