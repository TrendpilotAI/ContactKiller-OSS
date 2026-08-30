-- ContactKiller Security Migration
-- Adds user_id to tables, replaces anonymous RLS with authenticated policies
-- Run this in Supabase SQL Editor after 001_initial_schema.sql

-- ============================================
-- 1. ADD USER_ID TO TABLES
-- ============================================

-- Add user_id to contacts (required for RLS)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Add user_id to sync_logs
ALTER TABLE sync_logs ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Add index for user lookups
CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_user_id ON sync_logs(user_id);

-- ============================================
-- 2. DROP DANGEROUS ANONYMOUS POLICIES
-- ============================================

-- Contacts
DROP POLICY IF EXISTS "Allow anonymous read contacts" ON contacts;
DROP POLICY IF EXISTS "Allow anonymous insert contacts" ON contacts;
DROP POLICY IF EXISTS "Allow anonymous update contacts" ON contacts;
DROP POLICY IF EXISTS "Allow anonymous delete contacts" ON contacts;

-- Emails
DROP POLICY IF EXISTS "Allow anonymous read emails" ON emails;
DROP POLICY IF EXISTS "Allow anonymous insert emails" ON emails;
DROP POLICY IF EXISTS "Allow anonymous update emails" ON emails;
DROP POLICY IF EXISTS "Allow anonymous delete emails" ON emails;

-- Phones
DROP POLICY IF EXISTS "Allow anonymous read phones" ON phones;
DROP POLICY IF EXISTS "Allow anonymous insert phones" ON phones;
DROP POLICY IF EXISTS "Allow anonymous update phones" ON phones;
DROP POLICY IF EXISTS "Allow anonymous delete phones" ON phones;

-- Platform links
DROP POLICY IF EXISTS "Allow anonymous read platform_links" ON platform_links;
DROP POLICY IF EXISTS "Allow anonymous insert platform_links" ON platform_links;
DROP POLICY IF EXISTS "Allow anonymous update platform_links" ON platform_links;
DROP POLICY IF EXISTS "Allow anonymous delete platform_links" ON platform_links;

-- Conflicts
DROP POLICY IF EXISTS "Allow anonymous read conflicts" ON conflicts;
DROP POLICY IF EXISTS "Allow anonymous insert conflicts" ON conflicts;
DROP POLICY IF EXISTS "Allow anonymous update conflicts" ON conflicts;
DROP POLICY IF EXISTS "Allow anonymous delete conflicts" ON conflicts;

-- Sync logs
DROP POLICY IF EXISTS "Allow anonymous read sync_logs" ON sync_logs;
DROP POLICY IF EXISTS "Allow anonymous insert sync_logs" ON sync_logs;
DROP POLICY IF EXISTS "Allow anonymous update sync_logs" ON sync_logs;

-- ============================================
-- 3. CREATE SECURE AUTHENTICATED POLICIES
-- ============================================

-- Contacts: Users can only access their own contacts
CREATE POLICY "users_own_contacts" ON contacts
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Emails: Access via parent contact ownership
CREATE POLICY "users_own_emails" ON emails
  FOR ALL USING (
    EXISTS (SELECT 1 FROM contacts WHERE contacts.id = emails.contact_id AND contacts.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM contacts WHERE contacts.id = emails.contact_id AND contacts.user_id = auth.uid())
  );

-- Phones: Access via parent contact ownership
CREATE POLICY "users_own_phones" ON phones
  FOR ALL USING (
    EXISTS (SELECT 1 FROM contacts WHERE contacts.id = phones.contact_id AND contacts.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM contacts WHERE contacts.id = phones.contact_id AND contacts.user_id = auth.uid())
  );

-- Platform links: Access via parent contact ownership
CREATE POLICY "users_own_platform_links" ON platform_links
  FOR ALL USING (
    EXISTS (SELECT 1 FROM contacts WHERE contacts.id = platform_links.contact_id AND contacts.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM contacts WHERE contacts.id = platform_links.contact_id AND contacts.user_id = auth.uid())
  );

-- Conflicts: Access via parent contact ownership
CREATE POLICY "users_own_conflicts" ON conflicts
  FOR ALL USING (
    EXISTS (SELECT 1 FROM contacts WHERE contacts.id = conflicts.contact_id AND contacts.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM contacts WHERE contacts.id = conflicts.contact_id AND contacts.user_id = auth.uid())
  );

-- Sync logs: Users can only see their own sync logs
CREATE POLICY "users_own_sync_logs" ON sync_logs
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- 4. CREATE OAUTH TOKENS TABLE (SIMPLE VERSION)
-- ============================================

-- Store OAuth tokens securely (RLS protected, no app-level encryption needed)
-- Supabase encrypts data at rest by default
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'icloud')),
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

-- Enable RLS on oauth_tokens
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;

-- Users can only access their own tokens
CREATE POLICY "users_own_tokens" ON oauth_tokens
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_provider ON oauth_tokens(user_id, provider);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens(expires_at);

-- Trigger to update updated_at
CREATE TRIGGER update_oauth_tokens_updated_at
  BEFORE UPDATE ON oauth_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 5. ADD PERFORMANCE INDEXES
-- ============================================

-- Email lookup (case-insensitive)
CREATE INDEX IF NOT EXISTS idx_emails_email_lower ON emails(LOWER(email));

-- Phone lookup
CREATE INDEX IF NOT EXISTS idx_phones_phone ON phones(phone);

-- Platform link lookup
CREATE INDEX IF NOT EXISTS idx_platform_links_lookup ON platform_links(platform, platform_id);

-- Unresolved conflicts
CREATE INDEX IF NOT EXISTS idx_conflicts_unresolved ON conflicts(contact_id) WHERE resolved = false;

-- ============================================
-- DONE
-- ============================================
-- After running this migration:
-- 1. Users must be authenticated to access any data
-- 2. Each user can only see their own contacts
-- 3. OAuth tokens are stored with RLS protection
