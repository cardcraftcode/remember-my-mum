import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'
import { syncCustomerToKlaviyo, type CustomerRow, type PersonRow } from './reminders.server'
import { createKlaviyoClient } from './klaviyo.server'
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

const PersonInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mumVariants: z.array(MumVariantSchema).default([]),
  remindsBirthday: z.boolean().default(true),
})

const CreatePersonSchema = PersonInputSchema
const UpdatePersonSchema = PersonInputSchema.extend({ id: z.string().uuid() })
const DeletePersonSchema = z.object({ id: z.string().uuid() })
const AccountRemindersSchema = z.object({
  remindsChristmas: z.boolean(),
  remindsMothersDay: z.boolean(),
})

async function requireCustomer() {
  const session = await readSessionCookie()
  if (!session?.customerId) throw new Error('Unauthorized')
  const supabaseAdmin = getSupabaseAdmin()
  const { data: customer, error } = await supabaseAdmin
    .from('reminder_customers')
    .select('*')
    .eq('id', session.customerId)
    .single()
  if (error || !customer) throw new Error('Customer not found')
  return { supabaseAdmin, customer }
}

async function syncAfterChange(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  customer: CustomerRow,
) {
  const { data: people } = await supabaseAdmin
    .from('reminder_people')
    .select('*')
    .eq('customer_id', customer.id)
    .order('created_at', { ascending: true })
  const klaviyo = createKlaviyoClient(supabaseAdmin)
  await syncCustomerToKlaviyo({
    supabaseAdmin,
    klaviyo,
    customer,
    people: (people ?? []) as PersonRow[],
  })
  return (people ?? []) as PersonRow[]
}

export const getDashboardData = createServerFn({ method: 'GET' })
  .inputValidator(() => true)
  .handler(async () => {
    const { supabaseAdmin, customer } = await requireCustomer()
    const { data: people, error } = await supabaseAdmin
      .from('reminder_people')
      .select('*')
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: true })
    if (error) throw error
    return { customer, people: (people ?? []) as PersonRow[] }
  })

export const createPerson = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown) => CreatePersonSchema.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin, customer } = await requireCustomer()
    const { error } = await supabaseAdmin.from('reminder_people').insert({
      customer_id: customer.id,
      name: data.name,
      date_of_birth: data.dateOfBirth,
      mum_variants: data.mumVariants,
      reminds_birthday: data.remindsBirthday,
    })
    if (error) throw error
    const people = await syncAfterChange(supabaseAdmin, customer)
    return { customer, people }
  })

export const updatePerson = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown) => UpdatePersonSchema.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin, customer } = await requireCustomer()
    const { error } = await supabaseAdmin
      .from('reminder_people')
      .update({
        name: data.name,
        date_of_birth: data.dateOfBirth,
        mum_variants: data.mumVariants,
        reminds_birthday: data.remindsBirthday,
      })
      .eq('id', data.id)
      .eq('customer_id', customer.id)
    if (error) throw error
    const people = await syncAfterChange(supabaseAdmin, customer)
    return { customer, people }
  })

export const deletePerson = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown) => DeletePersonSchema.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin, customer } = await requireCustomer()
    const { error } = await supabaseAdmin
      .from('reminder_people')
      .delete()
      .eq('id', data.id)
      .eq('customer_id', customer.id)
    if (error) throw error
    const people = await syncAfterChange(supabaseAdmin, customer)
    return { customer, people }
  })

export const updateAccountReminders = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown) => AccountRemindersSchema.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin, customer } = await requireCustomer()
    const { data: updated, error } = await supabaseAdmin
      .from('reminder_customers')
      .update({
        reminds_christmas: data.remindsChristmas,
        reminds_mothers_day: data.remindsMothersDay,
      })
      .eq('id', customer.id)
      .select()
      .single()
    if (error || !updated) throw error ?? new Error('Update failed')
    const people = await syncAfterChange(supabaseAdmin, updated)
    return { customer: updated, people }
  })
