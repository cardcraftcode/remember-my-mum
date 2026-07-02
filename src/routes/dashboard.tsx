import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getDashboardData, updateReminders } from '@/lib/reminders.functions'
import { getSession, logout, verifyGuestDashboardToken } from '@/lib/auth'
import { MUM_VARIANTS } from '@/lib/mum-variants'


export const Route = createFileRoute('/dashboard')({
  component: DashboardPage,
  loader: async () => {
    const session = await getSession()
    return { session }
  },
})

function DashboardPage() {
  const { session } = Route.useLoaderData()
  const search = useSearch({ from: '/dashboard' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [guestError, setGuestError] = useState<string | null>(null)
  const [isGuestLoading, setIsGuestLoading] = useState(false)

  useEffect(() => {
    const token = (search as { token?: string }).token
    if (token && !session?.customerId) {
      handleGuestToken(token)
    }
  }, [search, session?.customerId])

  const { data: dashboardData, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const result = await getDashboardData()
      return result
    },
    enabled: !!session?.customerId,
    retry: false,
  })


  const updateMutation = useMutation({
    mutationFn: updateReminders,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })

  const handleGuestToken = async (token: string) => {
    setIsGuestLoading(true)
    setGuestError(null)
    try {
      await verifyGuestDashboardToken({ data: { token } })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      navigate({ to: '/dashboard', search: {} })
    } catch (error) {
      setGuestError(
        error instanceof Error ? error.message : 'Could not sign in with this link.',
      )
    } finally {
      setIsGuestLoading(false)
    }
  }

  if (!session?.customerId) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="mx-auto max-w-md rounded-2xl bg-white p-8 shadow-sm">
          <h1 className="mb-2 text-2xl font-semibold text-gray-900">Manage your reminders</h1>
          <p className="mb-6 text-gray-600">
            Sign in with your Shopify account to manage your Mum reminder preferences.
          </p>

          {isGuestLoading && (
            <p className="mb-4 text-sm text-gray-500">Signing you in from your email link...</p>
          )}
          {guestError && (
            <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{guestError}</p>
          )}

          <a
            href="/auth/shopify"
            className="block w-full rounded-lg bg-pink-600 px-4 py-3 text-center font-medium text-white hover:bg-pink-700"
          >
            Sign in with Shopify
          </a>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="mx-auto max-w-2xl">
          <p className="text-gray-600">Loading your reminders...</p>
        </div>
      </div>
    )
  }

  if (!dashboardData) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="mx-auto max-w-2xl">
          <p className="text-red-600">Could not load your reminders. Please try again.</p>
        </div>
      </div>
    )
  }

  const { customer, reminders } = dashboardData
  const birthday = reminders.find((r) => r.event_type === 'birthday')
  const christmas = reminders.find((r) => r.event_type === 'christmas')
  const mothersDay = reminders.find((r) => r.event_type === 'mothers_day')

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-gray-900">Your reminders</h1>
          <button
            onClick={async () => {
              await logout()
              navigate({ to: '/dashboard' })
            }}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Sign out
          </button>
        </div>

        <p className="mb-6 text-gray-600">
          Signed in as <span className="font-medium text-gray-900">{customer.email}</span>
        </p>

        {updateMutation.isError && (
          <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">
            {updateMutation.error instanceof Error
              ? updateMutation.error.message
              : 'Could not save changes.'}
          </p>
        )}

        {updateMutation.isSuccess && (
          <p className="mb-4 rounded-lg bg-green-50 p-3 text-sm text-green-700">
            Your reminders have been saved.
          </p>
        )}

        <ReminderForm
          customer={customer}
          birthday={birthday}
          christmas={christmas}
          mothersDay={mothersDay}
          onSubmit={(values) => updateMutation.mutate({ data: values })}
          isSubmitting={updateMutation.isPending}
        />
      </div>
    </div>
  )
}

type ReminderFormProps = {
  customer: { email: string }
  birthday?: { event_date: string | null; enabled: boolean }
  christmas?: { enabled: boolean }
  mothersDay?: { enabled: boolean }
  onSubmit: (values: {
    mumBirthday: string | null
    remindsBirthday: boolean
    remindsChristmas: boolean
    remindsMothersDay: boolean
  }) => void
  isSubmitting: boolean
}

function ReminderForm({ birthday, christmas, mothersDay, onSubmit, isSubmitting }: ReminderFormProps) {
  const [mumBirthday, setMumBirthday] = useState(birthday?.event_date ?? '')
  const [remindsBirthday, setRemindsBirthday] = useState(birthday?.enabled ?? false)
  const [remindsChristmas, setRemindsChristmas] = useState(christmas?.enabled ?? false)
  const [remindsMothersDay, setRemindsMothersDay] = useState(mothersDay?.enabled ?? false)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({
          mumBirthday: mumBirthday || null,
          remindsBirthday,
          remindsChristmas,
          remindsMothersDay,
        })
      }}
      className="space-y-6 rounded-2xl bg-white p-6 shadow-sm"
    >
      <div>
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={remindsBirthday}
            onChange={(e) => setRemindsBirthday(e.target.checked)}
            className="h-5 w-5 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
          />
          <span className="text-gray-900">Remind me about Mum's birthday</span>
        </label>
        {remindsBirthday && (
          <div className="mt-3 pl-8">
            <label className="block text-sm font-medium text-gray-700">
              Mum's birthday date
            </label>
            <input
              type="date"
              required={remindsBirthday}
              value={mumBirthday}
              onChange={(e) => setMumBirthday(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-pink-500 focus:outline-none focus:ring-pink-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              We'll send reminders 14 and 7 days before the date.
            </p>
          </div>
        )}
      </div>

      <div>
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={remindsChristmas}
            onChange={(e) => setRemindsChristmas(e.target.checked)}
            className="h-5 w-5 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
          />
          <span className="text-gray-900">Remind me about Christmas cards</span>
        </label>
      </div>

      <div>
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={remindsMothersDay}
            onChange={(e) => setRemindsMothersDay(e.target.checked)}
            className="h-5 w-5 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
          />
          <span className="text-gray-900">Remind me about Mother's Day</span>
        </label>
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full rounded-lg bg-pink-600 px-4 py-3 font-medium text-white hover:bg-pink-700 disabled:opacity-50"
      >
        {isSubmitting ? 'Saving...' : 'Save reminders'}
      </button>
    </form>
  )
}
