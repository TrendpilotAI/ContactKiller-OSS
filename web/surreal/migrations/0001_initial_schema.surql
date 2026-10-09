-- ContactKiller web prototype: initial SurrealDB schema.
--
-- Every user-owned table carries a read-only `owner` record link and a table
-- permission of `owner = $auth`, so SurrealDB itself enforces tenant isolation
-- for sessions authenticated through the `account` record access method. The
-- web application never holds database credentials with broader scope.

-- Application users. Reachable only through the record access method below.
DEFINE TABLE app_user SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD email ON app_user TYPE string
  ASSERT string::len($value) <= 254 AND $value = string::lowercase($value);
DEFINE FIELD password_hash ON app_user TYPE string;
DEFINE FIELD created_at ON app_user TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX app_user_email ON app_user FIELDS email UNIQUE;

DEFINE ACCESS account ON DATABASE TYPE RECORD
  SIGNUP {
    IF type::is_string($email) = false OR type::is_string($password) = false {
      THROW "invalid_credentials";
    };
    IF string::is_email($email) = false {
      THROW "invalid_email";
    };
    IF string::len($password) < 12 OR string::len($password) > 256 {
      THROW "invalid_password_length";
    };
    RETURN (CREATE app_user SET
      email = string::lowercase(string::trim($email)),
      password_hash = crypto::argon2::generate($password));
  }
  SIGNIN (
    SELECT * FROM app_user
    WHERE email = string::lowercase(string::trim($email))
      AND crypto::argon2::compare(password_hash, $password)
  )
  DURATION FOR TOKEN 8h, FOR SESSION 8h;

-- Canonical mutable contact record owned by one user.
DEFINE TABLE contact SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE owner = $auth;
DEFINE FIELD owner ON contact TYPE record<app_user> READONLY;
DEFINE FIELD first_name ON contact TYPE option<string> | null;
DEFINE FIELD last_name ON contact TYPE option<string> | null;
DEFINE FIELD display_name ON contact TYPE string;
DEFINE FIELD company ON contact TYPE option<string> | null;
DEFINE FIELD job_title ON contact TYPE option<string> | null;
DEFINE FIELD notes ON contact TYPE option<string> | null;
DEFINE FIELD is_financial_advisor ON contact TYPE bool DEFAULT false;
DEFINE FIELD created_at ON contact TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON contact TYPE datetime VALUE time::now();
DEFINE INDEX contact_owner_updated ON contact FIELDS owner, updated_at;
DEFINE INDEX contact_owner_fa ON contact FIELDS owner, is_financial_advisor;

DEFINE TABLE email SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE owner = $auth
    FOR create WHERE owner = $auth AND contact.owner = $auth;
DEFINE FIELD owner ON email TYPE record<app_user> READONLY;
DEFINE FIELD contact ON email TYPE record<contact> READONLY REFERENCE ON DELETE CASCADE;
DEFINE FIELD email ON email TYPE string;
DEFINE FIELD email_lower ON email TYPE string VALUE string::lowercase(email);
DEFINE FIELD label ON email TYPE option<string> | null DEFAULT 'personal';
DEFINE FIELD is_primary ON email TYPE bool DEFAULT false;
DEFINE FIELD created_at ON email TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX email_contact ON email FIELDS contact;
DEFINE INDEX email_owner_lower ON email FIELDS owner, email_lower;

DEFINE TABLE phone SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE owner = $auth
    FOR create WHERE owner = $auth AND contact.owner = $auth;
DEFINE FIELD owner ON phone TYPE record<app_user> READONLY;
DEFINE FIELD contact ON phone TYPE record<contact> READONLY REFERENCE ON DELETE CASCADE;
DEFINE FIELD phone ON phone TYPE string;
DEFINE FIELD label ON phone TYPE option<string> | null DEFAULT 'mobile';
DEFINE FIELD is_primary ON phone TYPE bool DEFAULT false;
DEFINE FIELD created_at ON phone TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX phone_contact ON phone FIELDS contact;

-- Which provider a contact was seen on, with the provider's own identifier.
DEFINE TABLE platform_link SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE owner = $auth
    FOR create WHERE owner = $auth AND contact.owner = $auth;
DEFINE FIELD owner ON platform_link TYPE record<app_user> READONLY;
DEFINE FIELD contact ON platform_link TYPE record<contact> READONLY REFERENCE ON DELETE CASCADE;
DEFINE FIELD platform ON platform_link TYPE string
  ASSERT $value IN ['google', 'icloud', 'whatsapp', 'contacts_plus'];
DEFINE FIELD platform_id ON platform_link TYPE string;
DEFINE FIELD last_synced_at ON platform_link TYPE option<datetime> | null;
DEFINE FIELD sync_hash ON platform_link TYPE option<string> | null;
DEFINE FIELD created_at ON platform_link TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX platform_link_contact_platform ON platform_link FIELDS contact, platform UNIQUE;
DEFINE INDEX platform_link_owner_lookup ON platform_link FIELDS owner, platform, platform_id;

-- Field-level disagreements awaiting manual resolution.
DEFINE TABLE conflict SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE owner = $auth
    FOR create WHERE owner = $auth AND contact.owner = $auth;
DEFINE FIELD owner ON conflict TYPE record<app_user> READONLY;
DEFINE FIELD contact ON conflict TYPE record<contact> READONLY REFERENCE ON DELETE CASCADE;
DEFINE FIELD field ON conflict TYPE string;
DEFINE FIELD value_a ON conflict TYPE option<string> | null;
DEFINE FIELD value_b ON conflict TYPE option<string> | null;
DEFINE FIELD source_a ON conflict TYPE option<string> | null;
DEFINE FIELD source_b ON conflict TYPE option<string> | null;
DEFINE FIELD resolved ON conflict TYPE bool DEFAULT false;
DEFINE FIELD resolved_value ON conflict TYPE option<string> | null;
DEFINE FIELD created_at ON conflict TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD resolved_at ON conflict TYPE option<datetime> | null;
DEFINE INDEX conflict_owner_resolved ON conflict FIELDS owner, resolved, created_at;
DEFINE INDEX conflict_contact ON conflict FIELDS contact;

DEFINE TABLE sync_log SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE owner = $auth;
DEFINE FIELD owner ON sync_log TYPE record<app_user> READONLY;
DEFINE FIELD platform ON sync_log TYPE string;
DEFINE FIELD operation ON sync_log TYPE string;
DEFINE FIELD status ON sync_log TYPE string
  ASSERT $value IN ['started', 'completed', 'failed'];
DEFINE FIELD contacts_processed ON sync_log TYPE int DEFAULT 0;
DEFINE FIELD conflicts_found ON sync_log TYPE int DEFAULT 0;
DEFINE FIELD error_message ON sync_log TYPE option<string> | null;
DEFINE FIELD started_at ON sync_log TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD completed_at ON sync_log TYPE option<datetime> | null;
DEFINE INDEX sync_log_owner_started ON sync_log FIELDS owner, started_at;

-- Provider OAuth credentials. The application encrypts both token fields with
-- AES-256-GCM before writing; the database only ever stores ciphertext.
DEFINE TABLE oauth_token SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE owner = $auth;
DEFINE FIELD owner ON oauth_token TYPE record<app_user> READONLY;
DEFINE FIELD provider ON oauth_token TYPE string ASSERT $value IN ['google', 'icloud'];
DEFINE FIELD access_token_enc ON oauth_token TYPE string;
DEFINE FIELD refresh_token_enc ON oauth_token TYPE option<string> | null;
DEFINE FIELD expires_at ON oauth_token TYPE datetime;
DEFINE FIELD created_at ON oauth_token TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at ON oauth_token TYPE datetime VALUE time::now();
DEFINE INDEX oauth_token_owner_provider ON oauth_token FIELDS owner, provider UNIQUE;
