import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getDashboardData,
  createPerson,
  updatePerson,
  deletePerson,
  updateAccountReminders,
} from '@/lib/reminders.functions'
import { getSession, logout, verifyGuestDashboardToken } from '@/lib/auth'
import { MUM_VARIANTS } from '@/lib/mum-variants'

type PersonRow = {
  id: string
  name: string
  date_of_birth: string
  mum_variants: string[] | null
  reminds_birthday: boolean
}

type PersonDraft = {
  name: string
  dateOfBirth: string
  mumVariants: string[]
  remindsBirthday: boolean
}

function emptyDraft(): PersonDraft {
  return { name: '', dateOfBirth: '', mumVariants: [], remindsBirthday: true }
}

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, session?.customerId])

  const { data: dashboardData, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => getDashboardData(),
    enabled: !!session?.customerId,
    retry: false,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['dashboard'] })

  const createMutation = useMutation({
    mutationFn: (draft: PersonDraft) => createPerson({ data: draft }),
    onSuccess: invalidate,
  })
  const updateMutation = useMutation({
    mutationFn: (input: PersonDraft & { id: string }) => updatePerson({ data: input }),
    onSuccess: invalidate,
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deletePerson({ data: { id } }),
    onSuccess: invalidate,
  })
  const accountMutation = useMutation({
    mutationFn: (input: { remindsChristmas: boolean; remindsMothersDay: boolean }) =>
      updateAccountReminders({ data: input }),
    onSuccess: invalidate,
  })

  const handleGuestToken = async (token: string) => {
    setIsGuestLoading(true)
    setGuestError(null)
    try {
      await verifyGuestDashboardToken({ data: { token } })
      invalidate()
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
            Sign in with your Shopify account to manage your reminder preferences.
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

  const { customer, people } = dashboardData as {
    customer: {
      email: string
      reminds_christmas: boolean
      reminds_mothers_day: boolean
    }
    people: PersonRow[]
  }

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

        {(createMutation.isError ||
          updateMutation.isError ||
          deleteMutation.isError ||
          accountMutation.isError) && (
          <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">
            Something went wrong. Please try again.
          </p>
        )}

        <div className="space-y-4">
          {people.length === 0 && (
            <p className="rounded-2xl bg-white p-6 text-gray-600 shadow-sm">
              You haven't added anyone yet. Add someone below to start getting birthday
              reminders.
            </p>
          )}

          {people.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              onSave={(draft) =>
                updateMutation.mutateAsync({ id: person.id, ...draft })
              }
              onDelete={() => deleteMutation.mutateAsync(person.id)}
            />
          ))}

          <AddPersonCard onCreate={(draft) => createMutation.mutateAsync(draft)} />
        </div>

        <div className="mt-8 space-y-3 rounded-2xl bg-white p-6 shadow-sm">
          <p className="text-sm font-medium text-gray-700">Account reminders</p>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={customer.reminds_mothers_day}
              onChange={(e) =>
                accountMutation.mutate({
                  remindsChristmas: customer.reminds_christmas,
                  remindsMothersDay: e.target.checked,
                })
              }
              className="h-5 w-5 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
            />
            <span className="text-gray-900">Remind me about Mother's Day</span>
          </label>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={customer.reminds_christmas}
              onChange={(e) =>
                accountMutation.mutate({
                  remindsChristmas: e.target.checked,
                  remindsMothersDay: customer.reminds_mothers_day,
                })
              }
              className="h-5 w-5 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
            />
            <span className="text-gray-900">Remind me about Christmas cards</span>
          </label>
        </div>
      </div>
    </div>
  )
}

function PersonRow({
  person,
  onSave,
  onDelete,
}: {
  person: PersonRow
  onSave: (draft: PersonDraft) => Promise<unknown>
  onDelete: () => Promise<unknown>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<PersonDraft>({
    name: person.name,
    dateOfBirth: person.date_of_birth,
    mumVariants: person.mum_variants ?? [],
    remindsBirthday: person.reminds_birthday,
  })
  const [saving, setSaving] = useState(false)

  if (!editing) {
    return (
      <div className="rounded-2xl bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-lg font-semibold text-gray-900">{person.name}</p>
            <p className="text-sm text-gray-600">
              {new Date(person.date_of_birth).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            </p>
            {person.mum_variants && person.mum_variants.length > 0 && (
              <p className="mt-1 text-xs text-gray-500">
                {person.mum_variants.join(', ')}
              </p>
            )}
            <p className="mt-2 text-xs text-gray-500">
              Birthday reminder {person.reminds_birthday ? 'on' : 'off'}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(true)}
              className="text-sm text-pink-600 hover:text-pink-700"
            >
              Edit
            </button>
            <button
              onClick={() => {
                if (confirm(`Delete reminder for ${person.name}?`)) onDelete()
              }}
              className="text-sm text-gray-500 hover:text-red-600"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <PersonEditor
      draft={draft}
      setDraft={setDraft}
      submitLabel={saving ? 'Saving...' : 'Save changes'}
      onCancel={() => {
        setDraft({
          name: person.name,
          dateOfBirth: person.date_of_birth,
          mumVariants: person.mum_variants ?? [],
          remindsBirthday: person.reminds_birthday,
        })
        setEditing(false)
      }}
      onSubmit={async () => {
        setSaving(true)
        try {
          await onSave(draft)
          setEditing(false)
        } finally {
          setSaving(false)
        }
      }}
      disabled={saving}
    />
  )
}

function AddPersonCard({
  onCreate,
}: {
  onCreate: (draft: PersonDraft) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<PersonDraft>(emptyDraft())
  const [saving, setSaving] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-2xl border-2 border-dashed border-pink-300 bg-white px-4 py-4 text-sm font-medium text-pink-600 hover:bg-pink-50"
      >
        + Add person
      </button>
    )
  }

  return (
    <PersonEditor
      draft={draft}
      setDraft={setDraft}
      submitLabel={saving ? 'Saving...' : 'Set reminders'}
      onCancel={() => {
        setDraft(emptyDraft())
        setOpen(false)
      }}
      onSubmit={async () => {
        setSaving(true)
        try {
          await onCreate(draft)
          setDraft(emptyDraft())
          setOpen(false)
        } finally {
          setSaving(false)
        }
      }}
      disabled={saving}
    />
  )
}

function PersonEditor({
  draft,
  setDraft,
  onSubmit,
  onCancel,
  submitLabel,
  disabled,
}: {
  draft: PersonDraft
  setDraft: (d: PersonDraft) => void
  onSubmit: () => void | Promise<void>
  onCancel: () => void
  submitLabel: string
  disabled: boolean
}) {
  const toggleVariant = (variant: string, checked: boolean) => {
    const set = new Set(draft.mumVariants)
    if (checked) set.add(variant)
    else set.delete(variant)
    setDraft({ ...draft, mumVariants: Array.from(set) })
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      className="space-y-4 rounded-2xl bg-white p-6 shadow-sm"
    >
      <div>
        <label className="block text-sm font-medium text-gray-700">Name</label>
        <input
          type="text"
          required
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-pink-500 focus:outline-none focus:ring-pink-500"
          placeholder="Mum, Nana Rose, etc."
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">Date of birth</label>
        <input
          type="date"
          required
          value={draft.dateOfBirth}
          onChange={(e) => setDraft({ ...draft, dateOfBirth: e.target.value })}
          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-pink-500 focus:outline-none focus:ring-pink-500"
        />
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-gray-700">
          Known as (select all that apply)
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {MUM_VARIANTS.map((variant) => (
            <label key={variant} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.mumVariants.includes(variant)}
                onChange={(e) => toggleVariant(variant, e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
              />
              <span className="text-sm text-gray-900">{variant}</span>
            </label>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={draft.remindsBirthday}
          onChange={(e) => setDraft({ ...draft, remindsBirthday: e.target.checked })}
          className="h-5 w-5 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
        />
        <span className="text-gray-900">Birthday reminder</span>
      </label>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={disabled}
          className="flex-1 rounded-lg bg-pink-600 px-4 py-2 font-medium text-white hover:bg-pink-700 disabled:opacity-50"
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
