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
  variant: string
  dateOfBirth: string // YYYY-MM-DD
  remindsBirthday: boolean
  remindsChristmas: boolean
  remindsMothersDay: boolean
}

function emptyPerson(): PersonEntry {
  return {
    name: '',
    variant: 'Mum',
    dateOfBirth: '',
    remindsBirthday: true,
    remindsChristmas: true,
    remindsMothersDay: true,
  }
}

function RemindersPage() {
  const [email, setEmail] = useState('')
  const [people, setPeople] = useState<PersonEntry[]>([emptyPerson()])
  const [expanded, setExpanded] = useState<boolean[]>([false])
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const updatePerson = (index: number, patch: Partial<PersonEntry>) => {
    setPeople((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  }

  const expandPerson = (index: number) => {
    setExpanded((prev) => prev.map((open, i) => (i === index ? true : open)))
  }

  const addPerson = () => {
    setPeople((prev) => [...prev, emptyPerson()])
    setExpanded((prev) => [...prev, true])
  }

  const removePerson = (index: number) => {
    setPeople((prev) => prev.filter((_, i) => i !== index))
    setExpanded((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setStatus('submitting')
    setErrorMessage(null)

    const peoplePayload = people
      .filter((p) => p.name.trim() && (p.remindsBirthday ? p.dateOfBirth : true))
      .map((p) => ({
        name: p.name.trim(),
        variant: p.variant,
        // DOB is required by the backend even if birthday reminder is off,
        // because per-person Christmas / Mother's Day still key off the person.
        // If the user turned birthday off and didn't enter DOB, default to
        // a placeholder that keeps the row valid; we won't emit birthday events.
        dateOfBirth: p.dateOfBirth || '2000-01-01',
        remindsBirthday: p.remindsBirthday,
        remindsChristmas: p.remindsChristmas,
        remindsMothersDay: p.remindsMothersDay,
      }))

    if (peoplePayload.length === 0) {
      setStatus('error')
      setErrorMessage('Please add at least one person.')
      return
    }

    try {
      const res = await fetch('/api/public/hooks/save-reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          people: peoplePayload,
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
                expanded={expanded[index]}
                onExpand={() => expandPerson(index)}
                onChange={(patch) => updatePerson(index, patch)}
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
  expanded,
  onExpand,
  onChange,
  onRemove,
}: {
  person: PersonEntry
  index: number
  expanded: boolean
  onExpand: () => void
  onChange: (patch: Partial<PersonEntry>) => void
  onRemove?: () => void
}) {
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={onExpand}
        className="w-full rounded-lg border border-dashed border-pink-400 px-4 py-3 text-sm font-medium text-pink-600 hover:bg-pink-50"
      >
        {index === 0 ? 'Set a reminder' : `Person ${index + 1}`}
      </button>
    )
  }

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
        <label className="block text-sm font-medium text-gray-700">
          Who is the reminder for?
        </label>
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
        <label className="block text-sm font-medium text-gray-700">
          What is she known as?
        </label>
        <select
          value={person.variant}
          onChange={(e) => onChange({ variant: e.target.value })}
          className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 shadow-sm focus:border-pink-500 focus:outline-none focus:ring-pink-500"
        >
          {MUM_VARIANTS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4">
        <p className="mb-2 text-sm font-medium text-gray-700">Reminder about</p>
        <div className="space-y-2">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={person.remindsBirthday}
              onChange={(e) => onChange({ remindsBirthday: e.target.checked })}
              className="h-5 w-5 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
            />
            <span className="text-gray-900">Birthday</span>
          </label>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={person.remindsChristmas}
              onChange={(e) => onChange({ remindsChristmas: e.target.checked })}
              className="h-5 w-5 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
            />
            <span className="text-gray-900">Christmas</span>
          </label>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={person.remindsMothersDay}
              onChange={(e) => onChange({ remindsMothersDay: e.target.checked })}
              className="h-5 w-5 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
            />
            <span className="text-gray-900">Mother's Day</span>
          </label>
        </div>
      </div>

      {person.remindsBirthday && (
        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700">
            When was she born?
          </label>
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
      )}
    </div>
  )
}
