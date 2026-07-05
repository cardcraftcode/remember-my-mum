import { type SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/integrations/supabase/types'

const KLAVIYO_API_BASE = 'https://a.klaviyo.com/api'

type KlaviyoProfile = {
  id: string
  email: string
  properties?: Record<string, unknown>
}

export type KlaviyoProfilePayload = {
  email: string
  shopDomain?: string
  shopifyCustomerId?: string | null
  peopleCount?: number
  consentTimestamp?: string | null
  remindersVerified?: boolean
  verificationUrl?: string | null
}

function buildAttributes(payload: Partial<KlaviyoProfilePayload>) {
  const properties: Record<string, unknown> = {
    reminder_source: 'momcards_reminders',
  }
  if (payload.shopDomain) properties.shop_domain = payload.shopDomain
  if (payload.shopifyCustomerId !== undefined) {
    properties.shopify_customer_id = payload.shopifyCustomerId
  }
  if (payload.peopleCount !== undefined) properties.people_count = payload.peopleCount
  if (payload.consentTimestamp) properties.consent_timestamp = payload.consentTimestamp
  if (payload.remindersVerified !== undefined) {
    properties.reminders_verified = payload.remindersVerified
  }
  if (payload.verificationUrl !== undefined) {
    properties.verification_url = payload.verificationUrl
  }

  const attributes: Record<string, unknown> = { properties }
  if (payload.email) attributes.email = payload.email
  return attributes
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
        revision: '2024-10-15',
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
    const body = {
      data: { type: 'profile', attributes: buildAttributes(payload) },
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
    const body = {
      data: {
        type: 'profile',
        id: profileId,
        attributes: buildAttributes(payload),
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

  async trackEvent(args: {
    email: string
    metricName: string
    properties?: Record<string, unknown>
    uniqueId?: string
  }): Promise<void> {
    const body = {
      data: {
        type: 'event',
        attributes: {
          properties: args.properties ?? {},
          unique_id: args.uniqueId,
          metric: {
            data: { type: 'metric', attributes: { name: args.metricName } },
          },
          profile: {
            data: { type: 'profile', attributes: { email: args.email } },
          },
        },
      },
    }
    await this.request('/events/', {
      method: 'POST',
      body: JSON.stringify(body),
    })
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
  if (!apiKey) throw new Error('Missing KLAVIYO_PRIVATE_API_KEY')
  return new KlaviyoClient(apiKey, supabase)
}
