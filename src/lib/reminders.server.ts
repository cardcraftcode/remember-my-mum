import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomBytes } from 'crypto'
import type { Database } from '@/integrations/supabase/types'
import { createKlaviyoClient, type KlaviyoProfilePayload, KlaviyoClient } from './klaviyo.server'
import { nextBirthday } from './dates.server'


export type BirthdayEntry = {
  date: string // ISO YYYY-MM-DD
  mumVariants: string[]
}

type UpsertReminderInput = {
  email: string
  shopDomain: string
  shopifyCustomerId?: string | null
  authUserId?: string | null
  // Canonical multi-birthday input. When provided (even if empty array), the
  // customer's birthday reminders are replaced with the given entries.
  birthdays?: BirthdayEntry[]
  remindsChristmas?: boolean
  remindsMothersDay?: boolean
  consentTimestamp?: Date
  // Base URL (e.g. "https://remember-my-mum.lovable.app") used to build the
  // email verification link for unverified customers.
  appBaseUrl?: string
}

export type CustomerWithReminders = {
  customer: Database['public']['Tables']['reminder_customers']['Row']
  reminders: Database['public']['Tables']['reminders']['Row'][]
}

function getSupabaseAdmin(): SupabaseClient<Database> {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Missing Supabase server credentials')
  }

  return createClient<Database>(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

function generateVerificationToken(): string {
  return randomBytes(32).toString('hex')
}


export async function upsertCustomerAndReminders(
  input: UpsertReminderInput,
): Promise<CustomerWithReminders> {
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


  let customer: Database['public']['Tables']['reminder_customers']['Row']

  if (existing) {
    const update: Database['public']['Tables']['reminder_customers']['Update'] = {
      updated_at: now.toISOString(),
      consent_timestamp: consentTimestamp.toISOString(),
    }
    if (input.shopDomain) update.shop_domain = input.shopDomain
    if (input.shopifyCustomerId) update.shopify_customer_id = input.shopifyCustomerId
    if (input.authUserId) update.auth_user_id = input.authUserId

    // If the customer has never verified their email, mint (or refresh) a
    // verification token so we can send them a fresh confirmation link.
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
      // New customers always start unverified — they must click the email link
      // before we send any reminders.
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

  // Append birthday rows when a birthdays array was supplied. Each form
  // submission adds new birthday reminders rather than replacing existing
  // ones, so a shopper who buys a second gift for a different Mum keeps
  // their earlier reminders. If a birthday for the same date already exists
  // we merge in any new mum_variants instead of inserting a duplicate.
  if (input.birthdays !== undefined && input.birthdays.length > 0) {
    const { data: existingBirthdays, error: existingBirthdayErr } = await supabaseAdmin
      .from('reminders')
      .select('id, event_date, mum_variants')
      .eq('customer_id', customer.id)
      .eq('event_type', 'birthday')

    if (existingBirthdayErr) throw existingBirthdayErr

    const existingByDate = new Map(
      (existingBirthdays ?? []).map((r) => [r.event_date, r]),
    )

    const toInsert: Database['public']['Tables']['reminders']['Insert'][] = []

    for (const b of input.birthdays) {
      const existing = existingByDate.get(b.date)
      if (existing) {
        const merged = Array.from(
          new Set([...(existing.mum_variants ?? []), ...b.mumVariants]),
        )
        const { error: mergeErr } = await supabaseAdmin
          .from('reminders')
          .update({ mum_variants: merged, enabled: true })
          .eq('id', existing.id)
        if (mergeErr) throw mergeErr
      } else {
        toInsert.push({
          customer_id: customer.id,
          event_type: 'birthday',
          event_date: b.date,
          enabled: true,
          mum_variants: b.mumVariants,
        })
      }
    }

    if (toInsert.length > 0) {
      const { error: birthdayInsertError } = await supabaseAdmin
        .from('reminders')
        .insert(toInsert)

      if (birthdayInsertError) throw birthdayInsertError
    }
  }

  // Christmas / Mother's Day: single row per customer, keep upsert.
  const singletonEntries: Array<{
    eventType: 'christmas' | 'mothers_day'
    enabled: boolean | undefined
  }> = [
    { eventType: 'christmas', enabled: input.remindsChristmas },
    { eventType: 'mothers_day', enabled: input.remindsMothersDay },
  ]

  for (const entry of singletonEntries) {
    if (entry.enabled === undefined) continue

    const { data: existingReminder, error: existingErr } = await supabaseAdmin
      .from('reminders')
      .select('id')
      .eq('customer_id', customer.id)
      .eq('event_type', entry.eventType)
      .maybeSingle()

    if (existingErr) throw existingErr

    if (existingReminder) {
      const { error: updateErr } = await supabaseAdmin
        .from('reminders')
        .update({ enabled: entry.enabled })
        .eq('id', existingReminder.id)
      if (updateErr) throw updateErr
    } else {
      const { error: insertErr } = await supabaseAdmin
        .from('reminders')
        .insert({
          customer_id: customer.id,
          event_type: entry.eventType,
          event_date: null,
          enabled: entry.enabled,
        })
      if (insertErr) throw insertErr
    }
  }

  const { data: reminders, error: fetchError } = await supabaseAdmin
    .from('reminders')
    .select('*')
    .eq('customer_id', customer.id)

  if (fetchError) throw fetchError

  await syncCustomerToKlaviyo({
    supabaseAdmin,
    klaviyo,
    customer,
    reminders: reminders ?? [],
    appBaseUrl: input.appBaseUrl,
  })

  return { customer, reminders: reminders ?? [] }
}

/**
 * Marks a customer verified using the token from their confirmation email,
 * then re-syncs their profile to Klaviyo so reminder flows can start.
 * Returns the updated customer, or null when the token is invalid/expired.
 */
export async function verifyCustomerByToken(
  token: string,
  appBaseUrl?: string,
): Promise<CustomerWithReminders | null> {
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

  // If already verified (double-click on link), just clear token and return current state.
  const { data: updated, error: updateError } = await supabaseAdmin
    .from('reminder_customers')
    .update({
      verified_at: customer.verified_at ?? now,
      verification_token: null,
      updated_at: now,
    })
    .eq('id', customer.id)
    .select()
    .single()

  if (updateError || !updated) throw updateError ?? new Error('Verification update failed')

  const { data: reminders } = await supabaseAdmin
    .from('reminders')
    .select('*')
    .eq('customer_id', updated.id)

  const klaviyo = createKlaviyoClient(supabaseAdmin)
  await syncCustomerToKlaviyo({
    supabaseAdmin,
    klaviyo,
    customer: updated,
    reminders: reminders ?? [],
    appBaseUrl,
  })

  return { customer: updated, reminders: reminders ?? [] }
}

export async function syncCustomerToKlaviyo(args: {
  supabaseAdmin: SupabaseClient<Database>
  klaviyo: KlaviyoClient
  customer: Database['public']['Tables']['reminder_customers']['Row']
  reminders: Database['public']['Tables']['reminders']['Row'][]
  appBaseUrl?: string
}) {
  const { supabaseAdmin, klaviyo, customer, reminders, appBaseUrl } = args

  const klaviyoPayload = buildKlaviyoPayload(customer, reminders, appBaseUrl)

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
  } catch (error) {
    await klaviyo.logSync(
      customer.id,
      customer.klaviyo_profile_id ? 'update_profile' : 'upsert_profile',
      'error',
      klaviyoPayload as unknown as Record<string, unknown>,
      error instanceof Error ? error.message : String(error),
    )
    // Do not throw — DB write succeeded; Klaviyo failure is logged for retry.
  }
}

export function buildKlaviyoPayload(
  customer: Database['public']['Tables']['reminder_customers']['Row'],
  reminders: Database['public']['Tables']['reminders']['Row'][],
  appBaseUrl?: string,
): KlaviyoProfilePayload {
  const birthdayReminders = reminders
    .filter((r) => r.event_type === 'birthday' && r.enabled && r.event_date)
    .sort((a, b) => (a.event_date ?? '').localeCompare(b.event_date ?? ''))

  const christmasReminder = reminders.find((r) => r.event_type === 'christmas')
  const mothersDayReminder = reminders.find((r) => r.event_type === 'mothers_day')

  const birthdays = birthdayReminders.map((r) => ({
    date: r.event_date!,
    next: nextBirthday(r.event_date!),
    mumVariants: (r.mum_variants ?? []) as string[],
  }))

  const first = birthdays[0]
  const isVerified = !!customer.verified_at

  // Until the customer clicks the verification link, we still write the
  // profile to Klaviyo so a "Verify your email" flow can send the confirmation
  // email — but we force every reminds_* flag to false so no reminder flows
  // can fire for an unverified address.
  const verificationUrl =
    !isVerified && customer.verification_token && appBaseUrl
      ? `${appBaseUrl.replace(/\/$/, '')}/verify-reminders?token=${customer.verification_token}`
      : null

  return {
    email: customer.email,
    shopDomain: customer.shop_domain ?? undefined,
    shopifyCustomerId: customer.shopify_customer_id,
    mumBirthday: first?.date ?? null,
    mumBirthdayNext: first?.next ?? null,
    birthdays,
    remindsBirthday: isVerified && birthdays.length > 0,
    remindsChristmas: isVerified && (christmasReminder?.enabled ?? false),
    remindsMothersDay: isVerified && (mothersDayReminder?.enabled ?? false),
    consentTimestamp: customer.consent_timestamp,
    remindersVerified: isVerified,
    verificationUrl,
  }
}
