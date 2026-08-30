CREATE TABLE IF NOT EXISTS ingestion_runs (
  run_id VARCHAR PRIMARY KEY,
  source_system VARCHAR NOT NULL,
  source_account VARCHAR NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  input_sha256 VARCHAR NOT NULL,
  input_path VARCHAR,
  record_count BIGINT NOT NULL DEFAULT 0,
  status VARCHAR NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  metadata JSON
);

CREATE TABLE IF NOT EXISTS source_records (
  observation_id VARCHAR PRIMARY KEY,
  source_record_key VARCHAR NOT NULL,
  run_id VARCHAR NOT NULL REFERENCES ingestion_runs(run_id),
  source_system VARCHAR NOT NULL,
  source_account VARCHAR NOT NULL,
  entity_type VARCHAR NOT NULL,
  source_record_id VARCHAR NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  source_updated_at TIMESTAMPTZ,
  payload_sha256 VARCHAR NOT NULL,
  payload JSON NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_observations (
  identity_observation_id VARCHAR PRIMARY KEY,
  observation_id VARCHAR NOT NULL REFERENCES source_records(observation_id),
  identity_kind VARCHAR NOT NULL CHECK (identity_kind IN ('email', 'phone', 'name')),
  raw_value VARCHAR NOT NULL,
  normalized_value VARCHAR,
  merge_eligible BOOLEAN NOT NULL DEFAULT false,
  is_primary BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS reconciliation_decisions (
  decision_id VARCHAR PRIMARY KEY,
  decided_at TIMESTAMPTZ NOT NULL,
  decision_type VARCHAR NOT NULL CHECK (
    decision_type IN ('protect', 'merge', 'classify_personal', 'classify_business', 'quarantine', 'restore')
  ),
  source_record_keys JSON NOT NULL,
  rationale VARCHAR NOT NULL,
  approved_by VARCHAR NOT NULL,
  rollback_reference VARCHAR
);

CREATE TABLE IF NOT EXISTS sentinel_contacts (
  sentinel_id VARCHAR PRIMARY KEY,
  label VARCHAR NOT NULL,
  expected_identity_kind VARCHAR NOT NULL CHECK (expected_identity_kind IN ('email', 'phone')),
  expected_identity_hash VARCHAR NOT NULL,
  protected BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS source_records_lookup_idx
  ON source_records(source_system, source_account, entity_type, source_record_id);

CREATE INDEX IF NOT EXISTS identity_observations_lookup_idx
  ON identity_observations(identity_kind, normalized_value);

CREATE OR REPLACE VIEW current_source_records AS
SELECT * EXCLUDE (recency_rank)
FROM (
  SELECT
    source_records.*,
    row_number() OVER (
      PARTITION BY source_record_key
      ORDER BY captured_at DESC, observation_id DESC
    ) AS recency_rank
  FROM source_records
)
WHERE recency_rank = 1;

CREATE OR REPLACE VIEW source_inventory AS
SELECT
  source_system,
  source_account,
  entity_type,
  count(*) AS current_record_count,
  max(captured_at) AS latest_capture
FROM current_source_records
GROUP BY source_system, source_account, entity_type;

CREATE OR REPLACE VIEW duplicate_identity_candidates AS
SELECT
  identity_observations.identity_kind,
  identity_observations.normalized_value,
  count(DISTINCT current_source_records.source_record_key) AS source_record_count,
  count(DISTINCT current_source_records.source_system || ':' || current_source_records.source_account) AS source_count
FROM identity_observations
JOIN current_source_records USING (observation_id)
WHERE identity_observations.merge_eligible
  AND identity_observations.normalized_value IS NOT NULL
GROUP BY identity_observations.identity_kind, identity_observations.normalized_value
HAVING count(DISTINCT current_source_records.source_record_key) > 1;
