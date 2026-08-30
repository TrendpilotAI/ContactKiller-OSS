-- ContactKiller Database Schema
-- Run this in the SQL editor for your own development Supabase project.

-- Contacts table (main entity)
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT,
  last_name TEXT,
  display_name TEXT NOT NULL,
  company TEXT,
  job_title TEXT,
  notes TEXT,
  is_financial_advisor BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Emails table (one contact can have multiple emails)
CREATE TABLE IF NOT EXISTS emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  label TEXT DEFAULT 'personal', -- personal, work, other
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Phones table (one contact can have multiple phones)
CREATE TABLE IF NOT EXISTS phones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  label TEXT DEFAULT 'mobile', -- mobile, home, work, other
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Platform links table (track which platforms a contact exists on)
CREATE TABLE IF NOT EXISTS platform_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, -- 'google', 'icloud', 'whatsapp', 'contacts_plus'
  platform_id TEXT NOT NULL, -- External ID from the platform
  last_synced_at TIMESTAMPTZ,
  sync_hash TEXT, -- Hash of contact data for change detection
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Conflicts table (for manual resolution)
CREATE TABLE IF NOT EXISTS conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  field TEXT NOT NULL, -- Which field has conflict: 'email', 'phone', 'name', etc.
  value_a TEXT,
  value_b TEXT,
  source_a TEXT, -- Platform name
  source_b TEXT, -- Platform name
  resolved BOOLEAN DEFAULT FALSE,
  resolved_value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- Sync logs table (track sync operations)
CREATE TABLE IF NOT EXISTS sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  operation TEXT NOT NULL, -- 'full_sync', 'incremental', 'push', 'pull'
  status TEXT NOT NULL, -- 'started', 'completed', 'failed'
  contacts_processed INTEGER DEFAULT 0,
  conflicts_found INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_contacts_is_fa ON contacts(is_financial_advisor);
CREATE INDEX IF NOT EXISTS idx_contacts_display_name ON contacts(display_name);
CREATE INDEX IF NOT EXISTS idx_emails_contact_id ON emails(contact_id);
CREATE INDEX IF NOT EXISTS idx_emails_email ON emails(email);
CREATE INDEX IF NOT EXISTS idx_phones_contact_id ON phones(contact_id);
CREATE INDEX IF NOT EXISTS idx_platform_links_contact_id ON platform_links(contact_id);
CREATE INDEX IF NOT EXISTS idx_platform_links_platform ON platform_links(platform, platform_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_contact_id ON conflicts(contact_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_resolved ON conflicts(resolved);

-- Enable Row Level Security (RLS)
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE phones ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;

-- Create policies for anonymous access (for development)
-- In production, you'd want to restrict these to authenticated users
CREATE POLICY "Allow anonymous read contacts" ON contacts FOR SELECT TO anon USING (true);
CREATE POLICY "Allow anonymous insert contacts" ON contacts FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow anonymous update contacts" ON contacts FOR UPDATE TO anon USING (true);
CREATE POLICY "Allow anonymous delete contacts" ON contacts FOR DELETE TO anon USING (true);

CREATE POLICY "Allow anonymous read emails" ON emails FOR SELECT TO anon USING (true);
CREATE POLICY "Allow anonymous insert emails" ON emails FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow anonymous update emails" ON emails FOR UPDATE TO anon USING (true);
CREATE POLICY "Allow anonymous delete emails" ON emails FOR DELETE TO anon USING (true);

CREATE POLICY "Allow anonymous read phones" ON phones FOR SELECT TO anon USING (true);
CREATE POLICY "Allow anonymous insert phones" ON phones FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow anonymous update phones" ON phones FOR UPDATE TO anon USING (true);
CREATE POLICY "Allow anonymous delete phones" ON phones FOR DELETE TO anon USING (true);

CREATE POLICY "Allow anonymous read platform_links" ON platform_links FOR SELECT TO anon USING (true);
CREATE POLICY "Allow anonymous insert platform_links" ON platform_links FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow anonymous update platform_links" ON platform_links FOR UPDATE TO anon USING (true);
CREATE POLICY "Allow anonymous delete platform_links" ON platform_links FOR DELETE TO anon USING (true);

CREATE POLICY "Allow anonymous read conflicts" ON conflicts FOR SELECT TO anon USING (true);
CREATE POLICY "Allow anonymous insert conflicts" ON conflicts FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow anonymous update conflicts" ON conflicts FOR UPDATE TO anon USING (true);
CREATE POLICY "Allow anonymous delete conflicts" ON conflicts FOR DELETE TO anon USING (true);

CREATE POLICY "Allow anonymous read sync_logs" ON sync_logs FOR SELECT TO anon USING (true);
CREATE POLICY "Allow anonymous insert sync_logs" ON sync_logs FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow anonymous update sync_logs" ON sync_logs FOR UPDATE TO anon USING (true);

-- Function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for contacts updated_at
CREATE TRIGGER update_contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
