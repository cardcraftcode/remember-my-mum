import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { MUM_VARIANTS } from '@/lib/mum-variants'

export const Route = createFileRoute('/reminders')({
  component: RemindersPage,
  head: () => ({
    meta: [
      { title: 'Set your reminders — Mom Cards' },
      {
        name: 'description',
        content:
          "Never forget a birthday, Mother's Day or Christmas — we'll send a friendly reminder in time to send a card.",
      },
      { property: 'og:title', content: 'Set your reminders — Mom Cards' },
      {
        property: 'og:description',
        content:
          "Never forget a birthday, Mother's Day or Christmas — we'll send a friendly reminder in time to send a card.",
      },
    ],
  }),
})

type PersonEntry = {
  name: string
  dateOfBirth: string // YYYY-MM-DD
  mumVariants: string[]
}

function emptyPerson(): PersonEntry {
  return { name: '', dateOfBirth: '', mumVariants: [] }
}

function RemindersPage() {
  const [email, setEmail] = useState('')
  const [people, setPeople] = useState<PersonEntry[]>([emptyPerson()])
  const [remindsChristmas, setRemindsChristmas] = useState(true)
  const [remindsMothersDay, setRemindsMothersDay] = useState(true)
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const updatePerson = (index: number, patch: Partial<PersonEntry>) => {
    setPeople((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  }

  const toggleVariant = (index: number, variant: string, checked: boolean) => {
    setPeople((prev) =>
      prev.map((p, i) => {
        if (i !== index) return p
        const set = new Set(p.mumVariants)
        if (checked) set.add(variant)
        else set.delete(variant)
        return { ...p, mumVariants: Array.from(set) }
      }),
    )
  }

  const addPerson = () => setPeople((prev) => [...prev, emptyPerson()])
  const removePerson = (index: number) =>
    setPeople((prev) => prev.filter((_, i) => i !== index))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setStatus('submitting')
    setErrorMessage(null)

    const peoplePayload = people
      .filter((p) => p.name.trim() && p.dateOfBirth)
      .map((p) => ({
        name: p.name.trim(),
        dateOfBirth: p.dateOfBirth,
        mumVariants: p.mumVariants,
      }))

    try {
      const res = await fetch('/api/public/hooks/save-reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          people: peoplePayload,
          reminders: {
            birthday: peoplePayload.length > 0,
            christmas: remindsChristmas,
            mothers_day: remindsMothersDay,
          },
          shop_domain: 'momcards.co.uk',
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Could not save your reminders.')
      }

      setStatus('success')
    } catch (err) {
      setStatus('error')
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong.')
    }
  }

  if (status === 'success') {
    return (
      <div className="min-h-screen bg-pink-50 p-6">
        <div className="mx-auto max-w-md rounded-2xl bg-white p-8 shadow-sm text-center">
          <h1 className="mb-3 text-2xl font-semibold text-gray-900">Check your inbox 💌</h1>
          <p className="text-gray-600">
            We've sent a confirmation email to{' '}
            <span className="font-medium">{email}</span>. Click the link inside to
            activate your reminders — we won't send anything until you confirm.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-pink-50 p-6">
      <div className="mx-auto max-w-lg">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-semibold text-gray-900">Never forget an occasion</h1>
          <p className="mt-2 text-gray-600">
            Add each person you'd like a reminder for.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-6 rounded-2xl bg-white p-6 shadow-sm"
        >
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700">
              Your email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-pink-500 focus:outline-none focus:ring-pink-500"
              placeholder="you@example.com"
            />
          </div>

          <div className="space-y-4">
            {people.map((person, index) => (
              <PersonCard
                key={index}
                person={person}
                index={index}
                onChange={(patch) => updatePerson(index, patch)}
                onToggleVariant={(variant, checked) =>
                  toggleVariant(index, variant, checked)
                }
                onRemove={people.length > 1 ? () => removePerson(index) : undefined}
              />
            ))}

            <button
              type="button"
              onClick={addPerson}
              className="w-full rounded-lg border border-dashed border-pink-400 px-4 py-2 text-sm font-medium text-pink-600 hover:bg-pink-50"
            >
              + Add another person
            </button>
          </div>

          <div className="space-y-3 border-t border-gray-100 pt-6">
            <p className="text-sm font-medium text-gray-700">Account reminders</p>
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={remindsMothersDay}
                onChange={(e) => setRemindsMothersDay(e.target.checked)}
                className="h-5 w-5 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
              />
              <span className="text-gray-900">Remind me about Mother's Day</span>
            </label>
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

          {status === 'error' && errorMessage && (
            <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{errorMessage}</p>
          )}

          <button
            type="submit"
            disabled={status === 'submitting'}
            className="w-full rounded-lg bg-pink-600 px-4 py-3 font-medium text-white hover:bg-pink-700 disabled:opacity-50"
          >
            {status === 'submitting' ? 'Saving...' : 'Set reminders'}
          </button>

          <p className="text-center text-xs text-gray-500">
            By submitting, you agree to receive reminder emails from Mom Cards.
            Unsubscribe anytime.
          </p>
        </form>
      </div>
    </div>
  )
}

function PersonCard({
  person,
  index,
  onChange,
  onToggleVariant,
  onRemove,
}: {
  person: PersonEntry
  index: number
  onChange: (patch: Partial<PersonEntry>) => void
  onToggleVariant: (variant: string, checked: boolean) => void
  onRemove?: () => void
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-pink-50/40 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-700">Person {index + 1}</p>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-xs text-gray-500 hover:text-red-600"
          >
            Remove
          </button>
        )}
      </div>

      <div className="mt-3">
        <label className="block text-sm font-medium text-gray-700">Name</label>
        <input
          type="text"
          required
          value={person.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-pink-500 focus:outline-none focus:ring-pink-500"
          placeholder="Mum, Nana Rose, etc."
        />
      </div>

      <div className="mt-3">
        <label className="block text-sm font-medium text-gray-700">Date of birth</label>
        <input
          type="date"
          required
          value={person.dateOfBirth}
          onChange={(e) => onChange({ dateOfBirth: e.target.value })}
          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-pink-500 focus:outline-none focus:ring-pink-500"
        />
        <p className="mt-1 text-xs text-gray-500">
          We'll email you a week before the date.
        </p>
      </div>

      <div className="mt-4">
        <p className="mb-2 text-sm font-medium text-gray-700">
          Known as (select all that apply)
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {MUM_VARIANTS.map((variant) => (
            <label key={variant} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={person.mumVariants.includes(variant)}
                onChange={(e) => onToggleVariant(variant, e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
              />
              <span className="text-sm text-gray-900">{variant}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
