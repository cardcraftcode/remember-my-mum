import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomBytes } from 'crypto'
import type { Database } from '@/integrations/supabase/types'
import { createKlaviyoClient, type KlaviyoProfilePayload, KlaviyoClient } from './klaviyo.server'
import { nextBirthday } from './dates.server'

export type PersonInput = {
  name: string
  dateOfBirth: string // YYYY-MM-DD
  mumVariants: string[]
  remindsBirthday?: boolean
}

type UpsertReminderInput = {
  email: string
  shopDomain: string
  shopifyCustomerId?: string | null
  authUserId?: string | null
  people?: PersonInput[]
  remindsChristmas?: boolean
  remindsMothersDay?: boolean
  consentTimestamp?: Date
  appBaseUrl?: string
}

export type CustomerRow = Database['public']['Tables']['reminder_customers']['Row']
export type PersonRow = Database['public']['Tables']['reminder_people']['Row']

export type CustomerWithPeople = {
  customer: CustomerRow
  people: PersonRow[]
}

function getSupabaseAdmin(): SupabaseClient<Database> {
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

/**
 * Creates or updates a customer and (additively) appends any people
 * supplied in the payload. Existing people with the same (name, date_of_birth)
 * are merged (mum_variants unioned, reminds_birthday preserved as OR).
 *
 * `remindsChristmas` / `remindsMothersDay` are additive too: only ever turned
 * on by a submission, never off — so a checkout form with unchecked boxes
 * won't silently disable an existing preference.
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

    // Additive: only turn account toggles ON, never OFF.
    if (input.remindsChristmas === true) update.reminds_christmas = true
    if (input.remindsMothersDay === true) update.reminds_mothers_day = true

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
      reminds_christmas: input.remindsChristmas ?? true,
      reminds_mothers_day: input.remindsMothersDay ?? true,
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

  if (input.people !== undefined && input.people.length > 0) {
    const { data: existingPeople, error: existingErr } = await supabaseAdmin
      .from('reminder_people')
      .select('id, name, date_of_birth, mum_variants, reminds_birthday')
      .eq('customer_id', customer.id)

    if (existingErr) throw existingErr

    const key = (name: string, dob: string) =>
      `${name.trim().toLowerCase()}|${dob}`

    const existingByKey = new Map(
      (existingPeople ?? []).map((p) => [key(p.name, p.date_of_birth), p]),
    )

    const toInsert: Database['public']['Tables']['reminder_people']['Insert'][] = []

    for (const p of input.people) {
      const found = existingByKey.get(key(p.name, p.dateOfBirth))
      if (found) {
        const merged = Array.from(
          new Set([...(found.mum_variants ?? []), ...p.mumVariants]),
        )
        const { error: mergeErr } = await supabaseAdmin
          .from('reminder_people')
          .update({
            mum_variants: merged,
            reminds_birthday:
              found.reminds_birthday || (p.remindsBirthday ?? true),
          })
          .eq('id', found.id)
        if (mergeErr) throw mergeErr
      } else {
        toInsert.push({
          customer_id: customer.id,
          name: p.name,
          date_of_birth: p.dateOfBirth,
          mum_variants: p.mumVariants,
          reminds_birthday: p.remindsBirthday ?? true,
        })
      }
    }

    if (toInsert.length > 0) {
      const { error: insertErr } = await supabaseAdmin
        .from('reminder_people')
        .insert(toInsert)
      if (insertErr) throw insertErr
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
 * Marks a customer verified using the token from their confirmation email,
 * then re-syncs their profile to Klaviyo so reminder flows can start.
 * Returns the updated customer, or null when the token is invalid/expired.
 */
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
}

export function buildKlaviyoPayload(
  customer: CustomerRow,
  people: PersonRow[],
  appBaseUrl?: string,
): KlaviyoProfilePayload {
  const enabledBirthdayPeople = people
    .filter((p) => p.reminds_birthday)
    .sort((a, b) => a.date_of_birth.localeCompare(b.date_of_birth))

  const peoplePayload = enabledBirthdayPeople.map((p) => ({
    name: p.name,
    dateOfBirth: p.date_of_birth,
    next: nextBirthday(p.date_of_birth),
    mumVariants: (p.mum_variants ?? []) as string[],
    remindsBirthday: p.reminds_birthday,
  }))

  const isVerified = !!customer.verified_at

  const verificationUrl =
    !isVerified && customer.verification_token && appBaseUrl
      ? `${appBaseUrl.replace(/\/$/, '')}/verify-reminders?token=${customer.verification_token}`
      : null

  return {
    email: customer.email,
    shopDomain: customer.shop_domain ?? undefined,
    shopifyCustomerId: customer.shopify_customer_id,
    people: peoplePayload,
    peopleCount: people.length,
    remindsChristmas: isVerified && customer.reminds_christmas,
    remindsMothersDay: isVerified && customer.reminds_mothers_day,
    consentTimestamp: customer.consent_timestamp,
    remindersVerified: isVerified,
    verificationUrl,
  }
}
