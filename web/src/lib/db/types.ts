export type Platform = 'google' | 'icloud' | 'whatsapp' | 'contacts_plus'
export type OAuthProvider = 'google' | 'icloud'
export type ContactFilter = 'all' | 'personal' | 'fa'

export interface EmailDto {
  id: string
  contact_id: string
  email: string
  label: string | null
  is_primary: boolean
  created_at: string
}

export interface PhoneDto {
  id: string
  contact_id: string
  phone: string
  label: string | null
  is_primary: boolean
  created_at: string
}

export interface PlatformLinkDto {
  id: string
  contact_id: string
  platform: Platform
  platform_id: string
  last_synced_at: string | null
  sync_hash: string | null
  created_at: string
}

export interface ContactDto {
  id: string
  first_name: string | null
  last_name: string | null
  display_name: string
  company: string | null
  job_title: string | null
  notes: string | null
  is_financial_advisor: boolean
  created_at: string
  updated_at: string
  emails: EmailDto[]
  phones: PhoneDto[]
  platform_links: PlatformLinkDto[]
}

export interface ConflictDto {
  id: string
  contact_id: string
  field: string
  value_a: string | null
  value_b: string | null
  source_a: string | null
  source_b: string | null
  resolved: boolean
  resolved_value: string | null
  created_at: string
  resolved_at: string | null
  contact: {
    first_name: string | null
    last_name: string | null
  } | null
}
