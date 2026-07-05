import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomBytes } from 'crypto'
import type { Database } from '@/integrations/supabase/types'
import { createKlaviyoClient, type KlaviyoProfilePayload, KlaviyoClient } from './klaviyo.server'
import { nextOccurrenceFor } from './dates.server'

export type Occasion = 'birthday' | 'christmas' | 'mothers_day'

export const ALL_OCCASIONS: Occasion[] = ['birthday', 'christmas', 'mothers_day']

export type PersonInput = {
  name: string
  dateOfBirth: string // YYYY-MM-DD
  variant: string
  remindsBirthday: boolean
  remindsChristmas: boolean
  remindsMothersDay: boolean
}

type UpsertReminderInput = {
  email: string
  shopDomain: string
  shopifyCustomerId?: string | null
  authUserId?: string | null
  people: PersonInput[]
  /** true = sync people set exactly (dashboard/account). false = additive by (name,dob) key. */
  replaceAll?: boolean
  consentTimestamp?: Date
  appBaseUrl?: string
}

export type CustomerRow = Database['public']['Tables']['reminder_customers']['Row']
export type PersonRow = Database['public']['Tables']['reminder_people']['Row']

export type CustomerWithPeople = {
  customer: CustomerRow
  people: PersonRow[]
}

export function getSupabaseAdmin(): SupabaseClient<Database> {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Missing Supabase server credentials')
  }
  return createClient<Database>(supabaseUrl, supabaseServiceRoleKey, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  })
}

function generateVerificationToken(): string {
  return randomBytes(32).toString('hex')
}

function occasionEnabled(person: PersonRow, occasion: Occasion): boolean {
  if (occasion === 'birthday') return person.reminds_birthday
  if (occasion === 'christmas') return person.reminds_christmas
  return person.reminds_mothers_day
}

/**
 * Create or update a customer and reconcile their `reminder_people`.
 *
 * `replaceAll: true` (dashboard, account extension) mirrors the submitted list
 * exactly — new people inserted, existing (matched by (name, dob)) updated,
 * missing ones deleted (with cancel events fired).
 *
 * `replaceAll: false` (checkout, reminders form) is additive — new people
 * added, existing left alone.
 */
export async function upsertCustomerAndPeople(
  input: UpsertReminderInput,
): Promise<CustomerWithPeople> {
  const supabaseAdmin = getSupabaseAdmin()
  const klaviyo = createKlaviyoClient(supabaseAdmin)

  const { data: existing, error: findError } = await supabaseAdmin
    .from('reminder_customers')
    .select('*')
    .eq('email', input.email)
    .maybeSingle()

  if (findError) throw findError

  const now = new Date()
  const consentTimestamp = input.consentTimestamp ?? now

  let customer: CustomerRow

  if (existing) {
    const update: Database['public']['Tables']['reminder_customers']['Update'] = {
      updated_at: now.toISOString(),
      consent_timestamp: consentTimestamp.toISOString(),
    }
    if (input.shopDomain) update.shop_domain = input.shopDomain
    if (input.shopifyCustomerId) update.shopify_customer_id = input.shopifyCustomerId
    if (input.authUserId) update.auth_user_id = input.authUserId

    if (!existing.verified_at) {
      update.verification_token = generateVerificationToken()
      update.verification_sent_at = now.toISOString()
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('reminder_customers')
      .update(update)
      .eq('id', existing.id)
      .select()
      .single()

    if (updateError || !updated) throw updateError ?? new Error('Customer update failed')
    customer = updated
  } else {
    const insert: Database['public']['Tables']['reminder_customers']['Insert'] = {
      email: input.email,
      shop_domain: input.shopDomain,
      shopify_customer_id: input.shopifyCustomerId ?? null,
      auth_user_id: input.authUserId ?? null,
      consent_timestamp: consentTimestamp.toISOString(),
      verified_at: null,
      verification_token: generateVerificationToken(),
      verification_sent_at: now.toISOString(),
    }

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('reminder_customers')
      .insert(insert)
      .select()
      .single()

    if (insertError || !inserted) throw insertError ?? new Error('Customer insert failed')
    customer = inserted
  }

  // Reconcile people
  const { data: existingPeopleRaw, error: existingErr } = await supabaseAdmin
    .from('reminder_people')
    .select('*')
    .eq('customer_id', customer.id)

  if (existingErr) throw existingErr
  const existingPeople = existingPeopleRaw ?? []

  const key = (name: string, dob: string) => `${name.trim().toLowerCase()}|${dob}`
  const existingByKey = new Map(existingPeople.map((p) => [key(p.name, p.date_of_birth), p]))
  const inputKeys = new Set(input.people.map((p) => key(p.name, p.dateOfBirth)))

  for (const p of input.people) {
    const found = existingByKey.get(key(p.name, p.dateOfBirth))
    if (found) {
      const { error: updErr } = await supabaseAdmin
        .from('reminder_people')
        .update({
          variant: p.variant,
          reminds_birthday: p.remindsBirthday,
          reminds_christmas: p.remindsChristmas,
          reminds_mothers_day: p.remindsMothersDay,
        })
        .eq('id', found.id)
      if (updErr) throw updErr
    } else {
      const { error: insErr } = await supabaseAdmin.from('reminder_people').insert({
        customer_id: customer.id,
        name: p.name,
        date_of_birth: p.dateOfBirth,
        variant: p.variant,
        reminds_birthday: p.remindsBirthday,
        reminds_christmas: p.remindsChristmas,
        reminds_mothers_day: p.remindsMothersDay,
      })
      if (insErr) throw insErr
    }
  }

  if (input.replaceAll) {
    for (const p of existingPeople) {
      if (!inputKeys.has(key(p.name, p.date_of_birth))) {
        await emitCancelEventsForPerson({ supabaseAdmin, klaviyo, customer, person: p })
        await supabaseAdmin.from('reminder_people').delete().eq('id', p.id)
      }
    }
  }

  const { data: people, error: peopleErr } = await supabaseAdmin
    .from('reminder_people')
    .select('*')
    .eq('customer_id', customer.id)
    .order('created_at', { ascending: true })

  if (peopleErr) throw peopleErr

  await syncCustomerToKlaviyo({
    supabaseAdmin,
    klaviyo,
    customer,
    people: people ?? [],
    appBaseUrl: input.appBaseUrl,
  })

  return { customer, people: people ?? [] }
}

/**
 * Fire Reminder Cancelled for every currently-active occasion for this person,
 * used just before deletion.
 */
export async function emitCancelEventsForPerson(args: {
  supabaseAdmin: SupabaseClient<Database>
  klaviyo: KlaviyoClient
  customer: CustomerRow
  person: PersonRow
}) {
  const { supabaseAdmin, klaviyo, customer, person } = args
  if (!customer.verified_at) return

  const { data: lastEvents } = await supabaseAdmin
    .from('reminder_event_log')
    .select('occasion, event_type, sent_at')
    .eq('person_id', person.id)
    .order('sent_at', { ascending: false })

  const lastByOccasion = new Map<Occasion, string>()
  for (const e of lastEvents ?? []) {
    const occ = e.occasion as Occasion
    if (!lastByOccasion.has(occ)) lastByOccasion.set(occ, e.event_type)
  }

  for (const occasion of ALL_OCCASIONS) {
    if (lastByOccasion.get(occasion) !== 'created') continue
    const uniqueId = `cancelled-${person.id}-${occasion}-${Date.now()}`
    try {
      await klaviyo.trackEvent({
        email: customer.email,
        metricName: 'Reminder Cancelled',
        uniqueId,
        properties: {
          person_name: person.name,
          occasion,
          variant: person.variant,
        },
      })
      await supabaseAdmin.from('reminder_event_log').insert({
        customer_id: customer.id,
        person_id: person.id,
        occasion,
        event_type: 'cancelled',
        klaviyo_unique_id: uniqueId,
      })
    } catch (err) {
      await klaviyo.logSync(
        customer.id,
        'reminder_cancelled',
        'error',
        { personId: person.id, occasion },
        err instanceof Error ? err.message : String(err),
      )
    }
  }
}

/**
 * Compare the currently-active (person, occasion) reminders against the last
 * event logged per key, then emit Reminder Created / Reminder Cancelled for
 * each diff. No-op unless the customer is verified.
 */
export async function reconcileReminderEvents(args: {
  supabaseAdmin: SupabaseClient<Database>
  klaviyo: KlaviyoClient
  customer: CustomerRow
  people: PersonRow[]
}) {
  const { supabaseAdmin, klaviyo, customer, people } = args
  if (!customer.verified_at) return
  if (people.length === 0) return

  const { data: events } = await supabaseAdmin
    .from('reminder_event_log')
    .select('person_id, occasion, event_type, sent_at')
    .in('person_id', people.map((p) => p.id))
    .order('sent_at', { ascending: false })

  const lastByKey = new Map<string, string>()
  for (const e of events ?? []) {
    const k = `${e.person_id}|${e.occasion}`
    if (!lastByKey.has(k)) lastByKey.set(k, e.event_type)
  }

  const desired = new Set<string>()
  for (const p of people) {
    for (const occ of ALL_OCCASIONS) {
      if (occasionEnabled(p, occ)) desired.add(`${p.id}|${occ}`)
    }
  }

  const previouslyActive = new Set<string>()
  for (const [k, t] of lastByKey) if (t === 'created') previouslyActive.add(k)

  const toCreate = [...desired].filter((k) => !previouslyActive.has(k))
  const toCancel = [...previouslyActive].filter((k) => !desired.has(k))

  const peopleById = new Map(people.map((p) => [p.id, p]))

  for (const k of toCreate) {
    const [personId, occRaw] = k.split('|')
    const occasion = occRaw as Occasion
    const person = peopleById.get(personId)
    if (!person) continue
    const nextOcc = nextOccurrenceFor(occasion, person.date_of_birth)
    const year = nextOcc.slice(0, 4)
    const uniqueId = `created-${personId}-${occasion}-${year}`
    try {
      await klaviyo.trackEvent({
        email: customer.email,
        metricName: 'Reminder Created',
        uniqueId,
        properties: {
          person_name: person.name,
          occasion,
          variant: person.variant,
          next_occurrence: nextOcc,
        },
      })
      await supabaseAdmin.from('reminder_event_log').insert({
        customer_id: customer.id,
        person_id: personId,
        occasion,
        event_type: 'created',
        next_occurrence: nextOcc,
        klaviyo_unique_id: uniqueId,
      })
    } catch (err) {
      await klaviyo.logSync(
        customer.id,
        'reminder_created',
        'error',
        { personId, occasion, nextOcc },
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  for (const k of toCancel) {
    const [personId, occRaw] = k.split('|')
    const occasion = occRaw as Occasion
    const person = peopleById.get(personId)
    if (!person) continue
    const uniqueId = `cancelled-${personId}-${occasion}-${Date.now()}`
    try {
      await klaviyo.trackEvent({
        email: customer.email,
        metricName: 'Reminder Cancelled',
        uniqueId,
        properties: {
          person_name: person.name,
          occasion,
          variant: person.variant,
        },
      })
      await supabaseAdmin.from('reminder_event_log').insert({
        customer_id: customer.id,
        person_id: personId,
        occasion,
        event_type: 'cancelled',
        klaviyo_unique_id: uniqueId,
      })
    } catch (err) {
      await klaviyo.logSync(
        customer.id,
        'reminder_cancelled',
        'error',
        { personId, occasion },
        err instanceof Error ? err.message : String(err),
      )
    }
  }
}

export async function verifyCustomerByToken(
  token: string,
  appBaseUrl?: string,
): Promise<CustomerWithPeople | null> {
  if (!token || token.length < 16) return null

  const supabaseAdmin = getSupabaseAdmin()

  const { data: customer, error } = await supabaseAdmin
    .from('reminder_customers')
    .select('*')
    .eq('verification_token', token)
    .maybeSingle()

  if (error) throw error
  if (!customer) return null

  const now = new Date().toISOString()

  const { data: updated, error: updateError } = await supabaseAdmin
    .from('reminder_customers')
    .update({
      verified_at: customer.verified_at ?? now,
      updated_at: now,
    })
    .eq('id', customer.id)
    .select()
    .single()

  if (updateError || !updated) throw updateError ?? new Error('Verification update failed')

  const { data: people } = await supabaseAdmin
    .from('reminder_people')
    .select('*')
    .eq('customer_id', updated.id)
    .order('created_at', { ascending: true })

  const klaviyo = createKlaviyoClient(supabaseAdmin)
  await syncCustomerToKlaviyo({
    supabaseAdmin,
    klaviyo,
    customer: updated,
    people: people ?? [],
    appBaseUrl,
  })

  return { customer: updated, people: people ?? [] }
}

export async function syncCustomerToKlaviyo(args: {
  supabaseAdmin: SupabaseClient<Database>
  klaviyo: KlaviyoClient
  customer: CustomerRow
  people: PersonRow[]
  appBaseUrl?: string
}) {
  const { supabaseAdmin, klaviyo, customer, people, appBaseUrl } = args

  const klaviyoPayload = buildKlaviyoPayload(customer, people, appBaseUrl)

  try {
    let profile: { id: string; email: string }
    if (customer.klaviyo_profile_id) {
      profile = await klaviyo.updateProfile(customer.klaviyo_profile_id, klaviyoPayload)
    } else {
      profile = await klaviyo.upsertProfile(klaviyoPayload)
      await supabaseAdmin
        .from('reminder_customers')
        .update({ klaviyo_profile_id: profile.id })
        .eq('id', customer.id)
    }

    await klaviyo.logSync(
      customer.id,
      customer.klaviyo_profile_id ? 'update_profile' : 'upsert_profile',
      'success',
      { profileId: profile.id, verified: !!customer.verified_at },
    )

    if (!customer.verified_at && klaviyoPayload.verificationUrl) {
      try {
        await klaviyo.trackEvent({
          email: customer.email,
          metricName: 'Reminders Verification Requested',
          uniqueId: `verify-${customer.id}-${customer.verification_token ?? ''}`,
          properties: {
            verification_url: klaviyoPayload.verificationUrl,
            shop_domain: customer.shop_domain,
          },
        })
        await klaviyo.logSync(customer.id, 'track_verification_event', 'success', {
          profileId: profile.id,
        })
      } catch (eventError) {
        await klaviyo.logSync(
          customer.id,
          'track_verification_event',
          'error',
          { profileId: profile.id },
          eventError instanceof Error ? eventError.message : String(eventError),
        )
      }
    }
  } catch (error) {
    await klaviyo.logSync(
      customer.id,
      customer.klaviyo_profile_id ? 'update_profile' : 'upsert_profile',
      'error',
      klaviyoPayload as unknown as Record<string, unknown>,
      error instanceof Error ? error.message : String(error),
    )
  }

  // After the profile is up to date, diff + emit per-person events.
  await reconcileReminderEvents({ supabaseAdmin, klaviyo, customer, people })
}

export function buildKlaviyoPayload(
  customer: CustomerRow,
  people: PersonRow[],
  appBaseUrl?: string,
): KlaviyoProfilePayload {
  const isVerified = !!customer.verified_at

  const verificationUrl =
    !isVerified && customer.verification_token && appBaseUrl
      ? `${appBaseUrl.replace(/\/$/, '')}/verify-reminders?token=${customer.verification_token}`
      : null

  return {
    email: customer.email,
    shopDomain: customer.shop_domain ?? undefined,
    shopifyCustomerId: customer.shopify_customer_id,
    peopleCount: people.length,
    consentTimestamp: customer.consent_timestamp,
    remindersVerified: isVerified,
    verificationUrl,
  }
}
