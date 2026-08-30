import { createBrowserClient } from '@supabase/ssr'

// Using untyped client until schema is deployed to Supabase
// TODO: Generate types from Supabase after running migration
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
