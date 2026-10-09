-- Drop the stored values too: REMOVE FIELD leaves them in the rows, and they
-- would reappear, stale, if the migration were applied again after the raw text
-- had been edited.
UPDATE phone UNSET phone_key;
REMOVE EVENT phone_key_stale ON TABLE phone;
REMOVE INDEX phone_owner_key ON phone;
REMOVE FIELD phone_key ON phone;
