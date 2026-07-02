import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { MUM_VARIANTS } from '@/lib/mum-variants'


export const Route = createFileRoute('/reminders')({
  component: RemindersPage,
  head: () => ({
    meta: [
      { title: 'Set your Mum reminders — Mom Cards' },
      {
        name: 'description',
        content:
          "Never forget Mum's birthday, Mother's Day or Christmas — we'll send you a friendly reminder.",
      },
      { property: 'og:title', content: 'Set your Mum reminders — Mom Cards' },
      {
        property: 'og:description',
        content:
          "Never forget Mum's birthday, Mother's Day or Christmas — we'll send you a friendly reminder.",
      },
    ],
  }),
})

function RemindersPage() {
  const [email, setEmail] = useState('')
  const [mumBirthday, setMumBirthday] = useState('')
  const [remindsBirthday, setRemindsBirthday] = useState(true)
  const [remindsChristmas, setRemindsChristmas] = useState(true)
  const [remindsMothersDay, setRemindsMothersDay] = useState(true)
  const [mumVariants, setMumVariants] = useState<string[]>([])
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setStatus('submitting')
    setErrorMessage(null)

    // Convert YYYY-MM-DD from <input type="date"> to DD/MM/YYYY expected by API.
    let mum_birthday: string | null = null
    if (remindsBirthday && mumBirthday) {
      const [yyyy, mm, dd] = mumBirthday.split('-')
      mum_birthday = `${dd}/${mm}/${yyyy}`
    }

    try {
      const res = await fetch('/api/public/hooks/save-reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          mum_birthday,
          reminders: {
            birthday: remindsBirthday,
            christmas: remindsChristmas,
            mothers_day: remindsMothersDay,
          },
          shop_domain: 'momcards.co.uk',
          mum_variants: mumVariants,
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
          <h1 className="mb-3 text-2xl font-semibold text-gray-900">You're all set 💌</h1>
          <p className="text-gray-600">
            We'll send you a friendly reminder before each occasion so you never miss a moment
            with Mum.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-pink-50 p-6">
      <div className="mx-auto max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-semibold text-gray-900">Never forget Mum</h1>
          <p className="mt-2 text-gray-600">
            We'll send a gentle reminder before each occasion so you have time to pick the
            perfect card.
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
                  Mum's birthday
                </label>
                <input
                  type="date"
                  required={remindsBirthday}
                  value={mumBirthday}
                  onChange={(e) => setMumBirthday(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-pink-500 focus:outline-none focus:ring-pink-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  We'll email you 14 and 7 days before.
                </p>
              </div>
            )}
          </div>

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

          <div>
            <p className="mb-3 text-sm font-medium text-gray-700">
              What do you call her? (select all that apply)
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {MUM_VARIANTS.map((variant) => (
                <label key={variant} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={mumVariants.includes(variant)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setMumVariants([...mumVariants, variant])
                      } else {
                        setMumVariants(mumVariants.filter((v) => v !== variant))
                      }
                    }}
                    className="h-5 w-5 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
                  />
                  <span className="text-gray-900">{variant}</span>
                </label>
              ))}
            </div>
          </div>


          {status === 'error' && errorMessage && (
            <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{errorMessage}</p>
          )}

          <button
            type="submit"
            disabled={status === 'submitting'}
            className="w-full rounded-lg bg-pink-600 px-4 py-3 font-medium text-white hover:bg-pink-700 disabled:opacity-50"
          >
            {status === 'submitting' ? 'Saving...' : 'Set my reminders'}
          </button>

          <p className="text-center text-xs text-gray-500">
            By submitting, you agree to receive reminder emails from Mom Cards. Unsubscribe
            anytime.
          </p>
        </form>
      </div>
    </div>
  )
}
