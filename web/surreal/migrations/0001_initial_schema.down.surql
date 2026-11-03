-- Rollback for 0001_initial_schema.surql. Destroys all ContactKiller data.
REMOVE ACCESS account ON DATABASE;
REMOVE TABLE oauth_token;
REMOVE TABLE sync_log;
REMOVE TABLE conflict;
REMOVE TABLE platform_link;
REMOVE TABLE phone;
REMOVE TABLE email;
REMOVE TABLE contact;
REMOVE TABLE app_user;
