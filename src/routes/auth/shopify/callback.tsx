import { createFileRoute, redirect } from '@tanstack/react-router'
import { exchangeShopifyAuthCode } from '@/lib/auth.server'

export const Route = createFileRoute('/auth/shopify/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const error = url.searchParams.get('error')
        const errorDescription = url.searchParams.get('error_description')

        if (error) {
          return new Response(`Shopify authentication error: ${errorDescription || error}`, {
            status: 400,
          })
        }

        if (!code || !state) {
          return new Response('Missing authorization code or state', { status: 400 })
        }

        // We need the shop domain to complete the exchange. Try to read it from a cookie first
        // through the server function, or fall back to env if available.
        const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN || ''
        if (!shopDomain) {
          return new Response(
            'Missing SHOPIFY_SHOP_DOMAIN environment variable. Set it to your Shopify domain (e.g. momcards.myshopify.com).',
            { status: 500 },
          )
        }

        try {
          await exchangeShopifyAuthCode({ data: { code, state, shopDomain } })
        } catch (err) {
          console.error('Shopify OAuth callback failed', err)
          return new Response(
            `Authentication failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            { status: 500 },
          )
        }

        throw redirect({ to: '/dashboard' })
      },
    },
  },
})
