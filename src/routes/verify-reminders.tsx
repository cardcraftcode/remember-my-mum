import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { useSuspenseQuery, queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { verifyCustomerByToken } from '@/lib/reminders.server'


const VerifySchema = z.object({ token: z.string().min(16).max(128) })

const verifyReminders = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown) => VerifySchema.parse(input))
  .handler(async ({ data }) => {
    const request = getRequest()
    const appBaseUrl = new URL(request.url).origin
    const result = await verifyCustomerByToken(data.token, appBaseUrl)
    if (!result) return { ok: false as const }
    return { ok: true as const, email: result.customer.email }
  })

const searchSchema = z.object({ token: z.string().optional() })

export const Route = createFileRoute('/verify-reminders')({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ deps, context }) => {
    if (!deps.token) return { ok: false as const }
    return context.queryClient.ensureQueryData(
      queryOptions({
        queryKey: ['verify-reminders', deps.token],
        queryFn: () => verifyReminders({ data: { token: deps.token! } }),
        staleTime: Infinity,
      }),
    )
  },
  component: VerifyPage,
  head: () => ({
    meta: [
      { title: 'Confirm your reminders — Mom Cards' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  errorComponent: () => (
    <VerifyShell>
      <h1 className="mb-3 text-2xl font-semibold text-gray-900">Something went wrong</h1>
      <p className="text-gray-600">
        We couldn't confirm your reminders. Please try the link again.
      </p>
    </VerifyShell>
  ),
  notFoundComponent: () => (
    <VerifyShell>
      <h1 className="mb-3 text-2xl font-semibold text-gray-900">Link not found</h1>
    </VerifyShell>
  ),
})

function VerifyShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-pink-50 p-6">
      <div className="mx-auto max-w-md rounded-2xl bg-white p-8 shadow-sm text-center">
        {children}
      </div>
    </div>
  )
}

function VerifyPage() {
  const { token } = Route.useSearch()

  const { data } = useSuspenseQuery(
    queryOptions({
      queryKey: ['verify-reminders', token ?? ''],
      queryFn: async () => {
        if (!token) return { ok: false as const }
        return verifyReminders({ data: { token } })
      },
      staleTime: Infinity,
    }),
  )

  if (!token) {
    return (
      <VerifyShell>
        <h1 className="mb-3 text-2xl font-semibold text-gray-900">Missing link</h1>
        <p className="text-gray-600">
          This confirmation link is incomplete. Please open the link from your email.
        </p>
      </VerifyShell>
    )
  }

  if (!data.ok) {
    return (
      <VerifyShell>
        <h1 className="mb-3 text-2xl font-semibold text-gray-900">Link expired</h1>
        <p className="text-gray-600">
          This confirmation link is invalid or has already been used. If you still want
          reminders, submit the form again to get a fresh link.
        </p>
      </VerifyShell>
    )
  }

  return (
    <VerifyShell>
      <h1 className="mb-3 text-2xl font-semibold text-gray-900">You're confirmed 💌</h1>
      <p className="text-gray-600">
        Thanks — we've verified <span className="font-medium">{data.email}</span>. We'll
        send you a reminder before each occasion so you never miss a moment.
      </p>
    </VerifyShell>
  )
}
