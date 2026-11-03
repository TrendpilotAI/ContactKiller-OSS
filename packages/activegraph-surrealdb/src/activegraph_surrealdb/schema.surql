-- ActiveGraph SurrealDB schema, version 1.
--
-- Every statement is idempotent (IF NOT EXISTS), so apply_schema() can run on
-- every open. Changing a definition requires a new schema version: existing
-- definitions are never altered in place.
--
-- Event payloads, projection data and provenance are stored as JSON strings so
-- that round trips are byte-exact and independent of SurrealDB value coercion.

-- Schema version marker (one record: ag_meta:schema).
DEFINE TABLE IF NOT EXISTS ag_meta SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS version ON ag_meta TYPE string;

-- Run metadata (ActiveGraph RunRecord), keyed by run_id: ag_run:⟨run_id⟩.
DEFINE TABLE IF NOT EXISTS ag_run SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS run_id ON ag_run TYPE string;
DEFINE FIELD IF NOT EXISTS parent_run_id ON ag_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS forked_at_event_id ON ag_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS label ON ag_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON ag_run TYPE string;
DEFINE FIELD IF NOT EXISTS goal ON ag_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS frame_id ON ag_run TYPE option<string>;
DEFINE INDEX IF NOT EXISTS ag_run_run_id ON ag_run FIELDS run_id UNIQUE;

-- Writer head per run, the compare-and-swap token for appends and truncation.
-- head_seq is the highest retained seq (NONE when the run is empty).
-- last_seq is the highest seq ever allocated; it never decreases, so a
-- truncate followed by an append still moves the head. Keyed by run_id.
DEFINE TABLE IF NOT EXISTS ag_run_head SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS run_id ON ag_run_head TYPE string;
DEFINE FIELD IF NOT EXISTS head_seq ON ag_run_head TYPE option<int>;
DEFINE FIELD IF NOT EXISTS last_seq ON ag_run_head TYPE int;
DEFINE FIELD IF NOT EXISTS event_count ON ag_run_head TYPE int;
DEFINE FIELD IF NOT EXISTS appended_at ON ag_run_head TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS ag_run_head_run_id ON ag_run_head FIELDS run_id UNIQUE;

-- The append-only event log. seq orders events within a run.
DEFINE TABLE IF NOT EXISTS ag_event SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS run_id ON ag_event TYPE string;
DEFINE FIELD IF NOT EXISTS seq ON ag_event TYPE int;
DEFINE FIELD IF NOT EXISTS event_id ON ag_event TYPE string;
DEFINE FIELD IF NOT EXISTS type ON ag_event TYPE string;
DEFINE FIELD IF NOT EXISTS actor ON ag_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS payload ON ag_event TYPE string;
DEFINE FIELD IF NOT EXISTS frame_id ON ag_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS caused_by ON ag_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS timestamp ON ag_event TYPE string;
DEFINE INDEX IF NOT EXISTS ag_event_run_seq ON ag_event FIELDS run_id, seq UNIQUE;
DEFINE INDEX IF NOT EXISTS ag_event_run_event_id ON ag_event FIELDS run_id, event_id UNIQUE;

-- Compaction snapshot blobs, keyed by state hash: ag_snapshot:⟨state_hash⟩.
DEFINE TABLE IF NOT EXISTS ag_snapshot SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS state_hash ON ag_snapshot TYPE string;
DEFINE FIELD IF NOT EXISTS blob ON ag_snapshot TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON ag_snapshot TYPE string;

-- Graph projection (SurrealGraphStore). graph_id scopes one projection, so
-- several projections can share a database. Record ids: [graph_id, entity_id].
DEFINE TABLE IF NOT EXISTS ag_object SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS graph_id ON ag_object TYPE string;
DEFINE FIELD IF NOT EXISTS object_id ON ag_object TYPE string;
DEFINE FIELD IF NOT EXISTS type ON ag_object TYPE string;
DEFINE FIELD IF NOT EXISTS version ON ag_object TYPE int;
DEFINE FIELD IF NOT EXISTS data ON ag_object TYPE string;
DEFINE FIELD IF NOT EXISTS provenance ON ag_object TYPE string;
DEFINE INDEX IF NOT EXISTS ag_object_graph_type ON ag_object FIELDS graph_id, type;

DEFINE TABLE IF NOT EXISTS ag_relation SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS graph_id ON ag_relation TYPE string;
DEFINE FIELD IF NOT EXISTS relation_id ON ag_relation TYPE string;
DEFINE FIELD IF NOT EXISTS source ON ag_relation TYPE string;
DEFINE FIELD IF NOT EXISTS target ON ag_relation TYPE string;
DEFINE FIELD IF NOT EXISTS type ON ag_relation TYPE string;
DEFINE FIELD IF NOT EXISTS data ON ag_relation TYPE string;
DEFINE FIELD IF NOT EXISTS provenance ON ag_relation TYPE string;
DEFINE INDEX IF NOT EXISTS ag_relation_graph_source ON ag_relation FIELDS graph_id, source;
DEFINE INDEX IF NOT EXISTS ag_relation_graph_target ON ag_relation FIELDS graph_id, target;

DEFINE TABLE IF NOT EXISTS ag_patch SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS graph_id ON ag_patch TYPE string;
DEFINE FIELD IF NOT EXISTS patch_id ON ag_patch TYPE string;
DEFINE FIELD IF NOT EXISTS target ON ag_patch TYPE string;
DEFINE FIELD IF NOT EXISTS status ON ag_patch TYPE string;
DEFINE FIELD IF NOT EXISTS patch ON ag_patch TYPE string;
DEFINE INDEX IF NOT EXISTS ag_patch_graph ON ag_patch FIELDS graph_id;
