-- One recorded disagreement per contact, field, and pair of values. Retried or
-- concurrent syncs would otherwise file the same conflict twice.
--
-- If duplicates already exist, stop with instructions instead of failing deep
-- inside the index build.
LET $duplicates = (
  SELECT owner, contact, field, value_a, value_b, count() AS filed
  FROM conflict
  GROUP BY owner, contact, field, value_a, value_b
);
IF array::len(array::filter($duplicates, |$row| $row.filed > 1)) > 0 {
  THROW "0005 cannot add a unique conflict index: the same (owner, contact, field, value_a, value_b) is filed more than once. List them with: SELECT owner, contact, field, value_a, value_b, array::group(id) AS ids, count() AS filed FROM conflict GROUP BY owner, contact, field, value_a, value_b. Keep one row per group (DELETE the others by id; prefer keeping a resolved one), then run db:migrate again.";
};

DEFINE INDEX conflict_unique_disagreement ON conflict FIELDS owner, contact, field, value_a, value_b UNIQUE;
