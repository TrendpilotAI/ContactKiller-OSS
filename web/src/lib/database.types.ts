export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      contacts: {
        Row: {
          id: string
          first_name: string | null
          last_name: string | null
          is_financial_advisor: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          first_name?: string | null
          last_name?: string | null
          is_financial_advisor?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          first_name?: string | null
          last_name?: string | null
          is_financial_advisor?: boolean
          created_at?: string
          updated_at?: string
        }
      }
      emails: {
        Row: {
          id: string
          contact_id: string
          email: string
          label: string | null
        }
        Insert: {
          id?: string
          contact_id: string
          email: string
          label?: string | null
        }
        Update: {
          id?: string
          contact_id?: string
          email?: string
          label?: string | null
        }
      }
      phones: {
        Row: {
          id: string
          contact_id: string
          phone: string
          label: string | null
        }
        Insert: {
          id?: string
          contact_id: string
          phone: string
          label?: string | null
        }
        Update: {
          id?: string
          contact_id?: string
          phone?: string
          label?: string | null
        }
      }
      platform_links: {
        Row: {
          id: string
          contact_id: string
          platform: string
          external_id: string
          last_synced_at: string | null
          sync_status: string
        }
        Insert: {
          id?: string
          contact_id: string
          platform: string
          external_id: string
          last_synced_at?: string | null
          sync_status?: string
        }
        Update: {
          id?: string
          contact_id?: string
          platform?: string
          external_id?: string
          last_synced_at?: string | null
          sync_status?: string
        }
      }
      conflicts: {
        Row: {
          id: string
          contact_id: string
          field: string
          platform_a: string
          value_a: string | null
          platform_b: string
          value_b: string | null
          resolved: boolean
          created_at: string
        }
        Insert: {
          id?: string
          contact_id: string
          field: string
          platform_a: string
          value_a?: string | null
          platform_b: string
          value_b?: string | null
          resolved?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          contact_id?: string
          field?: string
          platform_a?: string
          value_a?: string | null
          platform_b?: string
          value_b?: string | null
          resolved?: boolean
          created_at?: string
        }
      }
      sync_logs: {
        Row: {
          id: string
          platform: string
          started_at: string
          completed_at: string | null
          contacts_synced: number
          conflicts_found: number
          status: string
        }
        Insert: {
          id?: string
          platform: string
          started_at?: string
          completed_at?: string | null
          contacts_synced?: number
          conflicts_found?: number
          status?: string
        }
        Update: {
          id?: string
          platform?: string
          started_at?: string
          completed_at?: string | null
          contacts_synced?: number
          conflicts_found?: number
          status?: string
        }
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
  }
}

// Convenience types
export type Contact = Database['public']['Tables']['contacts']['Row']
export type Email = Database['public']['Tables']['emails']['Row']
export type Phone = Database['public']['Tables']['phones']['Row']
export type PlatformLink = Database['public']['Tables']['platform_links']['Row']
export type Conflict = Database['public']['Tables']['conflicts']['Row']
export type SyncLog = Database['public']['Tables']['sync_logs']['Row']

// Contact with relations
export interface ContactWithDetails extends Contact {
  emails: Email[]
  phones: Phone[]
  platform_links: PlatformLink[]
}
