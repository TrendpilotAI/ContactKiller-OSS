REMOVE INDEX platform_link_owner_identity ON platform_link;
DEFINE INDEX platform_link_owner_lookup ON platform_link FIELDS owner, platform, platform_id;
