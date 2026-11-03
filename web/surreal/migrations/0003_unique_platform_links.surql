-- One provider identity belongs to one contact per user. Without this, two
-- concurrent syncs could each create a contact for the same Google person.
--
-- If the database already holds duplicates, the migration stops here instead of
-- failing deep inside the index build.
LET $duplicates = (
  SELECT owner, platform, platform_id, count() AS links
  FROM platform_link
  GROUP BY owner, platform, platform_id
);
IF array::len(array::filter($duplicates, |$row| $row.links > 1)) > 0 {
  THROW "0003 cannot add a unique platform link index: several contacts share one (owner, platform, platform_id). List them with: SELECT owner, platform, platform_id, array::group(contact) AS contacts, count() AS links FROM platform_link GROUP BY owner, platform, platform_id. Keep one contact per identity (merge or DELETE the others, which also removes their links), then run db:migrate again.";
};

REMOVE INDEX platform_link_owner_lookup ON platform_link;
DEFINE INDEX platform_link_owner_identity ON platform_link FIELDS owner, platform, platform_id UNIQUE;
