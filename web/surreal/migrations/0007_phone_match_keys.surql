-- Persist each phone's match key next to its raw text. The key (E.164 plus any
-- extension, decided by the importer that had the most information: Google's
-- canonical form, or a plain parse) is what matching compares; raw text is never
-- re-parsed to build the identity index, so a number cannot silently change
-- meaning later (for example a Mexican national number being read as US).
--
--   phone_key = a string  : the match key
--   phone_key = NULL      : the value is not a keyable number
--   phone_key = NONE      : not computed yet (rows that predate this migration,
--                           or whose raw text was just edited); the application
--                           computes it the next time it builds the index.
DEFINE FIELD phone_key ON phone TYPE option<string> | null;
DEFINE INDEX phone_owner_key ON phone FIELDS owner, phone_key;

-- Editing a phone's raw text without also supplying its key would leave a key
-- that describes the old text. Reset it so it is recomputed, never trusted.
DEFINE EVENT phone_key_stale ON TABLE phone
  WHEN $event = "UPDATE" AND $before.phone != $after.phone AND $before.phone_key = $after.phone_key
  THEN {
    UPDATE $after.id SET phone_key = NONE;
  };
