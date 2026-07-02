import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/integrations/supabase/types'

const KLAVIYO_API_BASE = 'https://a.klaviyo.com/api'

type KlaviyoProfile = {
  id: string
  email: string
  properties?: Record<string, unknown>
}

export type KlaviyoBirthdayEntry = {
  date: string
  next: string
  mumVariants: string[]
}

export type KlaviyoProfilePayload = {
  email: string
  firstName?: string
  lastName?: string
  shopDomain?: string
  shopifyCustomerId?: string | null
  mumBirthday?: string | null
  mumBirthdayNext?: string | null
  birthdays?: KlaviyoBirthdayEntry[]
  remindsBirthday?: boolean
  remindsChristmas?: boolean
  remindsMothersDay?: boolean
  consentTimestamp?: string | null
}



export class KlaviyoClient {
  private apiKey: string
  private supabase: SupabaseClient<Database>

  constructor(apiKey: string, supabase: SupabaseClient<Database>) {
    this.apiKey = apiKey
    this.supabase = supabase
  }

  private async request(path: string, options: RequestInit): Promise<unknown> {
    const url = `${KLAVIYO_API_BASE}${path}`
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Klaviyo-API-Key ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        revision: '2023-02-24',
        ...options.headers,
      },
    })

    const text = await response.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }

    if (!response.ok) {
      throw new Error(
        `Klaviyo API error ${response.status}: ${JSON.stringify(body)}`,
      )
    }

    return body
  }

  async upsertProfile(payload: KlaviyoProfilePayload): Promise<KlaviyoProfile> {
    const attributes: Record<string, unknown> = {
      email: payload.email,
      properties: {
        reminder_source: 'momcards_reminders',
      },
    }

    if (payload.firstName) attributes.first_name = payload.firstName
    if (payload.lastName) attributes.last_name = payload.lastName
    if (payload.shopDomain) {
      ;(attributes.properties as Record<string, unknown>).shop_domain =
        payload.shopDomain
    }
    if (payload.shopifyCustomerId) {
      ;(attributes.properties as Record<string, unknown>).shopify_customer_id =
        payload.shopifyCustomerId
    }
    if (payload.mumBirthday) {
      ;(attributes.properties as Record<string, unknown>).mum_birthday =
        payload.mumBirthday
    }
    if (payload.mumBirthdayNext) {
      ;(attributes.properties as Record<string, unknown>).mum_birthday_next =
        payload.mumBirthdayNext
    }
    ;(attributes.properties as Record<string, unknown>).reminds_birthday =
      payload.remindsBirthday ?? false
    ;(attributes.properties as Record<string, unknown>).reminds_christmas =
      payload.remindsChristmas ?? false
    ;(attributes.properties as Record<string, unknown>).reminds_mothers_day =
      payload.remindsMothersDay ?? false
    if (payload.consentTimestamp) {
      ;(attributes.properties as Record<string, unknown>).consent_timestamp =
        payload.consentTimestamp
    }
    if (payload.mumVariants && payload.mumVariants.length > 0) {
      ;(attributes.properties as Record<string, unknown>).mum_variants =
        payload.mumVariants
    }
    if (payload.birthdays && payload.birthdays.length > 0) {
      ;(attributes.properties as Record<string, unknown>).birthdays =
        payload.birthdays
    }


    const body = {
      data: {
        type: 'profile',
        attributes,
      },
    }

    const result = (await this.request('/profile-import/', {
      method: 'POST',
      body: JSON.stringify(body),
    })) as {
      data?: {
        id: string
        attributes?: { email: string; properties?: Record<string, unknown> }
      }
    }

    return {
      id: result.data?.id ?? '',
      email: result.data?.attributes?.email ?? payload.email,
      properties: result.data?.attributes?.properties,
    }
  }

  async updateProfile(
    profileId: string,
    payload: Partial<KlaviyoProfilePayload>,
  ): Promise<KlaviyoProfile> {
    const attributes: Record<string, unknown> = {
      properties: {
        reminder_source: 'momcards_reminders',
      },
    }

    if (payload.firstName) attributes.first_name = payload.firstName
    if (payload.lastName) attributes.last_name = payload.lastName
    if (payload.shopDomain) {
      ;(attributes.properties as Record<string, unknown>).shop_domain =
        payload.shopDomain
    }
    if (payload.shopifyCustomerId !== undefined) {
      ;(attributes.properties as Record<string, unknown>).shopify_customer_id =
        payload.shopifyCustomerId
    }
    if (payload.mumBirthday) {
      ;(attributes.properties as Record<string, unknown>).mum_birthday =
        payload.mumBirthday
    }
    if (payload.mumBirthdayNext) {
      ;(attributes.properties as Record<string, unknown>).mum_birthday_next =
        payload.mumBirthdayNext
    }
    ;(attributes.properties as Record<string, unknown>).reminds_birthday =
      payload.remindsBirthday ?? false
    ;(attributes.properties as Record<string, unknown>).reminds_christmas =
      payload.remindsChristmas ?? false
    ;(attributes.properties as Record<string, unknown>).reminds_mothers_day =
      payload.remindsMothersDay ?? false
    if (payload.consentTimestamp) {
      ;(attributes.properties as Record<string, unknown>).consent_timestamp =
        payload.consentTimestamp
    }
    if (payload.mumVariants && payload.mumVariants.length > 0) {
      ;(attributes.properties as Record<string, unknown>).mum_variants =
        payload.mumVariants
    }
    if (payload.birthdays && payload.birthdays.length > 0) {
      ;(attributes.properties as Record<string, unknown>).birthdays =
        payload.birthdays
    }


    const body = {
      data: {
        type: 'profile',
        id: profileId,
        attributes,
      },
    }

    const result = (await this.request(`/profiles/${profileId}/`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })) as {
      data?: {
        id: string
        attributes?: { email: string; properties?: Record<string, unknown> }
      }
    }

    return {
      id: result.data?.id ?? profileId,
      email: result.data?.attributes?.email ?? payload.email ?? '',
      properties: result.data?.attributes?.properties,
    }
  }

  async logSync(
    customerId: string | null,
    action: string,
    status: 'success' | 'error',
    payload: Record<string, unknown> | null,
    error?: string,
  ) {
    await this.supabase.from('klaviyo_sync_log').insert({
      customer_id: customerId,
      action,
      status,
      payload: payload as unknown as Json,
      error: error ?? null,
    })
  }
}

export function createKlaviyoClient(supabase: SupabaseClient<Database>) {
  const apiKey = process.env.KLAVIYO_PRIVATE_API_KEY
  if (!apiKey) {
    throw new Error('Missing KLAVIYO_PRIVATE_API_KEY')
  }
  return new KlaviyoClient(apiKey, supabase)
}

