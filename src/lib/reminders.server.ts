import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'
import { createKlaviyoClient, type KlaviyoProfilePayload } from './klaviyo.server'
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
    }

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('reminder_customers')
      .insert(insert)
      .select()
      .single()

    if (insertError || !inserted) throw insertError ?? new Error('Customer insert failed')
    customer = inserted
  }

  // Replace birthday rows when a birthdays array was supplied.
  if (input.birthdays !== undefined) {
    const { error: deleteError } = await supabaseAdmin
      .from('reminders')
      .delete()
      .eq('customer_id', customer.id)
      .eq('event_type', 'birthday')

    if (deleteError) throw deleteError

    if (input.birthdays.length > 0) {
      const rows: Database['public']['Tables']['reminders']['Insert'][] =
        input.birthdays.map((b) => ({
          customer_id: customer.id,
          event_type: 'birthday',
          event_date: b.date,
          enabled: true,
          mum_variants: b.mumVariants,
        }))

      const { error: birthdayInsertError } = await supabaseAdmin
        .from('reminders')
        .insert(rows)

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

    const insertReminder: Database['public']['Tables']['reminders']['Insert'] = {
      customer_id: customer.id,
      event_type: entry.eventType,
      event_date: null,
      enabled: entry.enabled,
    }

    const { error: reminderError } = await supabaseAdmin
      .from('reminders')
      .upsert(insertReminder, { onConflict: 'customer_id,event_type' })

    if (reminderError) throw reminderError
  }

  const { data: reminders, error: fetchError } = await supabaseAdmin
    .from('reminders')
    .select('*')
    .eq('customer_id', customer.id)

  if (fetchError) throw fetchError

  const klaviyoPayload = buildKlaviyoPayload(customer, reminders ?? [])

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

  return { customer, reminders: reminders ?? [] }
}

export function buildKlaviyoPayload(
  customer: Database['public']['Tables']['reminder_customers']['Row'],
  reminders: Database['public']['Tables']['reminders']['Row'][],
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

  return {
    email: customer.email,
    shopDomain: customer.shop_domain ?? undefined,
    shopifyCustomerId: customer.shopify_customer_id,
    mumBirthday: first?.date ?? null,
    mumBirthdayNext: first?.next ?? null,
    birthdays,
    remindsBirthday: birthdays.length > 0,
    remindsChristmas: christmasReminder?.enabled ?? false,
    remindsMothersDay: mothersDayReminder?.enabled ?? false,
    consentTimestamp: customer.consent_timestamp,
  }
}
