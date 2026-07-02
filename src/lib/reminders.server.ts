import { format, parseISO } from 'date-fns'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'
import { createKlaviyoClient, type KlaviyoProfilePayload } from './klaviyo.server'
import { nextBirthday } from './dates.server'
import { MUM_VARIANTS, type MumVariant } from './mum-variants'


type UpsertReminderInput = {
  email: string
  shopDomain: string
  shopifyCustomerId?: string | null
  authUserId?: string | null
  mumBirthday?: string | null
  remindsBirthday?: boolean
  remindsChristmas?: boolean
  remindsMothersDay?: boolean
  consentTimestamp?: Date
  mumVariants?: MumVariant[]
}


export type CustomerWithReminders = {
  customer: Database['public']['Tables']['reminder_customers']['Row']
  reminders: Database['public']['Tables']['reminders']['Row'][]
}

export async function upsertCustomerAndReminders(
  input: UpsertReminderInput,
): Promise<CustomerWithReminders> {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Missing Supabase server credentials')
  }

  const supabaseAdmin = createClient<Database>(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
    },
  })

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
    if (input.mumVariants) update.mum_variants = input.mumVariants


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
      mum_variants: input.mumVariants ?? [],
    }

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('reminder_customers')
      .insert(insert)
      .select()
      .single()

    if (insertError || !inserted) throw insertError ?? new Error('Customer insert failed')
    customer = inserted
  }

  // Upsert reminders
  const reminders: Database['public']['Tables']['reminders']['Row'][] = []

  const reminderEntries: Array<{
    eventType: Database['public']['Enums']['reminder_event_type']
    enabled: boolean | undefined
    date: string | null
  }> = [
    {
      eventType: 'birthday',
      enabled: input.remindsBirthday,
      date: input.mumBirthday ?? null,
    },
    {
      eventType: 'christmas',
      enabled: input.remindsChristmas,
      date: null,
    },
    {
      eventType: 'mothers_day',
      enabled: input.remindsMothersDay,
      date: null,
    },
  ]

  for (const entry of reminderEntries) {
    if (entry.enabled === undefined) continue

    const insertReminder: Database['public']['Tables']['reminders']['Insert'] = {
      customer_id: customer.id,
      event_type: entry.eventType,
      event_date: entry.date,
      enabled: entry.enabled,
    }

    const { data: reminder, error: reminderError } = await supabaseAdmin
      .from('reminders')
      .upsert(insertReminder, { onConflict: 'customer_id,event_type' })
      .select()
      .single()

    if (reminderError) throw reminderError
    if (reminder) reminders.push(reminder)
  }

  // Sync to Klaviyo
  const mumBirthdayNext = input.mumBirthday
    ? nextBirthday(input.mumBirthday)
    : null

  const klaviyoPayload: KlaviyoProfilePayload = {
    email: customer.email,
    shopDomain: customer.shop_domain ?? undefined,
    shopifyCustomerId: customer.shopify_customer_id,
    mumBirthday: input.mumBirthday ?? null,
    mumBirthdayNext,
    remindsBirthday: input.remindsBirthday ?? false,
    remindsChristmas: input.remindsChristmas ?? false,
    remindsMothersDay: input.remindsMothersDay ?? false,
    consentTimestamp: consentTimestamp.toISOString(),
    mumVariants: input.mumVariants ?? customer.mum_variants ?? [],
  }


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
      { profileId: profile.id },
    )
  } catch (error) {
    await klaviyo.logSync(
      customer.id,
      customer.klaviyo_profile_id ? 'update_profile' : 'upsert_profile',
      'error',
      klaviyoPayload,
      error instanceof Error ? error.message : String(error),
    )
    // Do not throw — DB write succeeded; Klaviyo failure is logged for retry.
  }

  return { customer, reminders }
}

export function buildKlaviyoPayload(
  customer: Database['public']['Tables']['reminder_customers']['Row'],
  reminders: Database['public']['Tables']['reminders']['Row'][],
): KlaviyoProfilePayload {
  const birthdayReminder = reminders.find((r) => r.event_type === 'birthday')
  const christmasReminder = reminders.find((r) => r.event_type === 'christmas')
  const mothersDayReminder = reminders.find((r) => r.event_type === 'mothers_day')

  return {
    email: customer.email,
    shopDomain: customer.shop_domain ?? undefined,
    shopifyCustomerId: customer.shopify_customer_id,
    mumBirthday: birthdayReminder?.event_date ?? null,
    mumBirthdayNext: birthdayReminder?.event_date
      ? nextBirthday(birthdayReminder.event_date)
      : null,
    remindsBirthday: birthdayReminder?.enabled ?? false,
    remindsChristmas: christmasReminder?.enabled ?? false,
    remindsMothersDay: mothersDayReminder?.enabled ?? false,
    consentTimestamp: customer.consent_timestamp,
  }
}
