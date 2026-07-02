import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'
import { createKlaviyoClient } from './klaviyo.server'
import { buildKlaviyoPayload } from './reminders.server'
import { nextBirthday } from './dates.server'
import { readSessionCookie } from './auth.server'
import { MUM_VARIANTS } from './mum-variants'


const supabaseUrl = process.env.SUPABASE_URL!
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function getSupabaseAdmin() {
  return createClient<Database>(supabaseUrl, supabaseServiceRoleKey, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  })
}

const MumVariantSchema = z.enum([...MUM_VARIANTS] as [string, ...string[]])

const BirthdayEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mumVariants: z.array(MumVariantSchema).default([]),
})

const UpdateRemindersSchema = z.object({
  // When provided, the customer's birthday reminders are fully replaced with
  // this list (empty array = no birthday reminders).
  birthdays: z.array(BirthdayEntrySchema).optional(),
  remindsChristmas: z.boolean().optional(),
  remindsMothersDay: z.boolean().optional(),
})


export const getDashboardData = createServerFn({ method: 'GET' })
  .validator(() => true)
  .handler(async () => {
    const session = await readSessionCookie()
    if (!session?.customerId) {
      throw new Error('Unauthorized')
    }

    const supabaseAdmin = getSupabaseAdmin()

    const { data: customer, error: customerError } = await supabaseAdmin
      .from('reminder_customers')
      .select('*')
      .eq('id', session.customerId)
      .single()

    if (customerError || !customer) {
      throw new Error('Customer not found')
    }

    const { data: reminders, error: remindersError } = await supabaseAdmin
      .from('reminders')
      .select('*')
      .eq('customer_id', customer.id)

    if (remindersError) throw remindersError

    return { customer, reminders: reminders ?? [] }
  })

export const updateReminders = createServerFn({ method: 'POST' })
  .validator((input: unknown) => UpdateRemindersSchema.parse(input))
  .handler(async ({ data }) => {
    const session = await readSessionCookie()
    if (!session?.customerId) {
      throw new Error('Unauthorized')
    }

    const supabaseAdmin = getSupabaseAdmin()

    const { data: customer, error: customerError } = await supabaseAdmin
      .from('reminder_customers')
      .select('*')
      .eq('id', session.customerId)
      .single()

    if (customerError || !customer) {
      throw new Error('Customer not found')
    }

    // Aggregate mum_variants union across all birthdays onto the customer row
    // (kept for backward compatibility with existing Klaviyo segments).
    if (data.birthdays !== undefined) {
      const set = new Set<string>()
      for (const b of data.birthdays) for (const v of b.mumVariants) set.add(v)
      const aggregated = Array.from(set)

      const { error: variantUpdateError } = await supabaseAdmin
        .from('reminder_customers')
        .update({ mum_variants: aggregated, updated_at: new Date().toISOString() })
        .eq('id', customer.id)

      if (variantUpdateError) throw variantUpdateError
      customer.mum_variants = aggregated

      // Replace all birthday reminders.
      const { error: deleteError } = await supabaseAdmin
        .from('reminders')
        .delete()
        .eq('customer_id', customer.id)
        .eq('event_type', 'birthday')

      if (deleteError) throw deleteError

      if (data.birthdays.length > 0) {
        const rows: Database['public']['Tables']['reminders']['Insert'][] =
          data.birthdays.map((b) => ({
            customer_id: customer.id,
            event_type: 'birthday',
            event_date: b.date,
            enabled: true,
            mum_variants: b.mumVariants,
          }))

        const { error: insertError } = await supabaseAdmin.from('reminders').insert(rows)
        if (insertError) throw insertError
      }
    }

    const singletonEntries: Array<{
      eventType: 'christmas' | 'mothers_day'
      enabled: boolean | undefined
    }> = [
      { eventType: 'christmas', enabled: data.remindsChristmas },
      { eventType: 'mothers_day', enabled: data.remindsMothersDay },
    ]

    for (const entry of singletonEntries) {
      if (entry.enabled === undefined) continue

      const payload: Database['public']['Tables']['reminders']['Insert'] = {
        customer_id: customer.id,
        event_type: entry.eventType,
        event_date: null,
        enabled: entry.enabled,
      }

      const { error: upsertError } = await supabaseAdmin
        .from('reminders')
        .upsert(payload, { onConflict: 'customer_id,event_type' })

      if (upsertError) throw upsertError
    }

    const { data: reminders } = await supabaseAdmin
      .from('reminders')
      .select('*')
      .eq('customer_id', customer.id)

    // Push to Klaviyo
    const klaviyo = createKlaviyoClient(supabaseAdmin)
    const klaviyoPayload = buildKlaviyoPayload(customer, reminders ?? [])

    try {
      let profile: { id: string }
      if (customer.klaviyo_profile_id) {
        profile = await klaviyo.updateProfile(customer.klaviyo_profile_id, klaviyoPayload)
      } else {
        profile = await klaviyo.upsertProfile(klaviyoPayload)
        await supabaseAdmin
          .from('reminder_customers')
          .update({ klaviyo_profile_id: profile.id })
          .eq('id', customer.id)
      }
      await klaviyo.logSync(customer.id, 'update_reminders', 'success', { profileId: profile.id })
    } catch (error) {
      await klaviyo.logSync(
        customer.id,
        'update_reminders',
        'error',
        klaviyoPayload,
        error instanceof Error ? error.message : String(error),
      )
    }

    return { customer, reminders: reminders ?? [] }
  })

export const recomputeBirthdayNext = createServerFn({ method: 'POST' })
  .validator(() => true)
  .handler(async () => {
    const supabaseAdmin = getSupabaseAdmin()
    const klaviyo = createKlaviyoClient(supabaseAdmin)

    const { data: customers, error } = await supabaseAdmin
      .from('reminder_customers')
      .select('*, reminders(*)')
      .not('klaviyo_profile_id', 'is', null)

    if (error) throw error

    let updated = 0
    for (const row of customers ?? []) {
      const birthday = row.reminders.find((r) => r.event_type === 'birthday')
      if (!birthday?.event_date) continue

      const next = nextBirthday(birthday.event_date)
      const payload = buildKlaviyoPayload(row, row.reminders)

      try {
        if (row.klaviyo_profile_id) {
          await klaviyo.updateProfile(row.klaviyo_profile_id, { ...payload, mumBirthdayNext: next })
          updated++
        }
      } catch (error) {
        await klaviyo.logSync(
          row.id,
          'recompute_birthday',
          'error',
          { next },
          error instanceof Error ? error.message : String(error),
        )
      }
    }

    return { updated }
  })
