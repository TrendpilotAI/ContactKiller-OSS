#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DB = resolve(".local/contactkiller/forensic-cache.duckdb");
const SCHEMA_PATH = fileURLToPath(new URL("./forensic-cache.sql", import.meta.url));

interface IdentityInput {
  emails?: unknown;
  phones?: unknown;
  names?: unknown;
}

export interface SourceInputRecord extends IdentityInput {
  sourceRecordId: string | number;
  entityType?: string;
  sourceUpdatedAt?: string | null;
  payload?: Record<string, unknown>;
  identities?: IdentityInput;
}

interface SnapshotEnvelope {
  contacts?: unknown;
  records?: unknown;
}

interface IngestOptions {
  dbPath: string;
  inputPath: string;
  sourceSystem: string;
  sourceAccount: string;
  capturedAt?: string;
  metadata?: Record<string, unknown>;
}

interface NormalizedSourceRecord {
  observation_id: string;
  source_record_key: string;
  run_id: string;
  source_system: string;
  source_account: string;
  entity_type: string;
  source_record_id: string;
  captured_at: string;
  source_updated_at: string | null;
  payload_sha256: string;
  payload_json: string;
}

interface NormalizedIdentity {
  identity_observation_id: string;
  observation_id: string;
  identity_kind: "email" | "phone" | "name";
  raw_value: string;
  normalized_value: string | null;
  merge_eligible: boolean;
  is_primary: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const HELP = `
Build a local, reproducible forensic cache from contact-source snapshots.

Usage:
  bun scripts/forensic-cache.ts init [--db <path>]
  bun scripts/forensic-cache.ts ingest --input <json-or-ndjson> \\
    --source <mesh|icloud|google|hubspot|lightfield> --account <stable-alias> [--db <path>]
  bun scripts/forensic-cache.ts summary [--db <path>]

Input records:
  {"sourceRecordId":"123","entityType":"contact","payload":{...},
   "emails":["person@example.com"],"phones":["+12025550123"],"names":["Person Name"]}

The input may be a JSON array, NDJSON, or a snapshot object with a contacts/records array.
This cache is a disposable projection, never the source of truth; ActiveGraph's event log is
authoritative. Raw values stay only in the ignored local DuckDB file. Names are never merge keys;
only normalized email addresses and valid E.164 phone numbers are merge-eligible.
`;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function normalizeEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

export function normalizePhone(value: string): string | null {
  const trimmed = value.trim();
  const formattedDigits = trimmed.startsWith("00")
    ? trimmed.slice(2)
    : trimmed.startsWith("+")
      ? trimmed.slice(1)
      : null;
  if (formattedDigits === null || !/^[0-9\s().-]+$/.test(formattedDigits)) return null;
  const digits = formattedDigits.replace(/[\s().-]/g, "");
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

export function normalizeName(value: string): string | null {
  const normalized = value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  return normalized || null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function validatedPath(value: string, label: string): string {
  const absolute = resolve(value);
  if (!isAbsolute(absolute) || absolute === parse(absolute).root) {
    throw new Error(`${label} must resolve to a non-root absolute path`);
  }
  return absolute;
}

const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

export function isRfc3339Instant(value: string): boolean {
  const match = RFC3339_INSTANT.exec(value);
  if (!match) return false;
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  const hour = Number.parseInt(match[4]!, 10);
  const minute = Number.parseInt(match[5]!, 10);
  const second = Number.parseInt(match[6]!, 10);
  const zone = match[8]!;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]!
    || hour > 23
    || minute > 59
    || second > 59
  ) return false;
  if (zone !== "Z") {
    const offsetHour = Number.parseInt(zone.slice(1, 3), 10);
    const offsetMinute = Number.parseInt(zone.slice(4, 6), 10);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function ensureCanonicalDirectory(pathValue: string): Promise<string> {
  const missingSegments: string[] = [];
  let existingPath = pathValue;

  while (true) {
    try {
      const existing = await lstat(existingPath);
      if (!existing.isDirectory() && !existing.isSymbolicLink()) {
        throw new Error(`Database parent path is not a directory: ${existingPath}`);
      }
      break;
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = dirname(existingPath);
      if (parent === existingPath) {
        throw new Error(`Could not resolve a parent directory for ${pathValue}`);
      }
      missingSegments.push(basename(existingPath));
      existingPath = parent;
    }
  }

  let canonicalDirectory = await realpath(existingPath);
  const canonicalInfo = await lstat(canonicalDirectory);
  if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) {
    throw new Error(`Database parent path is not a canonical directory: ${canonicalDirectory}`);
  }

  for (const segment of missingSegments.reverse()) {
    const candidate = resolve(canonicalDirectory, segment);
    const childPath = relative(canonicalDirectory, candidate);
    if (!childPath || childPath.startsWith("..") || isAbsolute(childPath)) {
      throw new Error(`Database parent path escapes its canonical directory: ${pathValue}`);
    }
    try {
      const candidateInfo = await lstat(candidate);
      if (candidateInfo.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link in database parent path: ${candidate}`);
      }
      if (!candidateInfo.isDirectory()) {
        throw new Error(`Database parent path is not a directory: ${candidate}`);
      }
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      await mkdir(candidate, { mode: 0o700 });
    }
    const canonicalCandidate = await realpath(candidate);
    if (dirname(canonicalCandidate) !== canonicalDirectory) {
      throw new Error(`Database parent path escapes its canonical directory: ${candidate}`);
    }
    const canonicalCandidateInfo = await lstat(canonicalCandidate);
    if (!canonicalCandidateInfo.isDirectory() || canonicalCandidateInfo.isSymbolicLink()) {
      throw new Error(`Database parent path is not a canonical directory: ${canonicalCandidate}`);
    }
    canonicalDirectory = canonicalCandidate;
  }

  return canonicalDirectory;
}

async function secureDatabasePath(dbPathValue: string): Promise<string> {
  const requestedPath = validatedPath(dbPathValue, "--db");
  const canonicalParent = await ensureCanonicalDirectory(dirname(requestedPath));
  const parentInfo = await lstat(canonicalParent);
  if ((parentInfo.mode & 0o022) !== 0) {
    throw new Error(`Database parent directory must not be group- or world-writable: ${canonicalParent}`);
  }
  const dbPath = resolve(canonicalParent, basename(requestedPath));
  const childPath = relative(canonicalParent, dbPath);
  if (!childPath || childPath.startsWith("..") || isAbsolute(childPath)) {
    throw new Error("Database path escapes its canonical parent directory");
  }
  try {
    const info = await lstat(dbPath);
    if (info.isSymbolicLink()) throw new Error(`Refusing symbolic-link database path: ${dbPath}`);
    if (!info.isFile()) throw new Error(`Database path is not a regular file: ${dbPath}`);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  return dbPath;
}

function validIsoTimestamp(value: string, label: string): string {
  if (!isRfc3339Instant(value)) {
    throw new Error(`${label} must be an RFC3339 instant with an explicit Z or numeric offset`);
  }
  return new Date(value).toISOString();
}

async function chmodOwnerOnlyIfPresent(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isMissingPath(error)) return;
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new Error(`Refusing symbolic-link database path: ${path}`);
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Database path is not a regular file: ${path}`);
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function run(command: string, args: string[], stdin?: string): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ stdout, stderr, exitCode: code ?? 1 }));
    child.stdin.end(stdin);
  });
}

async function runDuckDb(dbPath: string, sql: string, jsonOutput = false): Promise<string> {
  const args = jsonOutput ? ["-json", dbPath] : [dbPath];
  const result = await run("duckdb", args, sql);
  if (result.exitCode !== 0) {
    throw new Error(`DuckDB failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  return result.stdout;
}

async function parseInput(inputPath: string): Promise<SourceInputRecord[]> {
  const raw = await readFile(inputPath, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`Invalid JSON on NDJSON line ${index + 1}`);
      }
    });
  }

  const candidate = Array.isArray(parsed)
    ? parsed
    : ((parsed as SnapshotEnvelope)?.contacts
      ?? (parsed as SnapshotEnvelope)?.records
      ?? ((parsed as Partial<SourceInputRecord>)?.sourceRecordId !== undefined ? [parsed] : undefined));
  if (!Array.isArray(candidate)) {
    throw new Error("Input must be an array, NDJSON, or an object with a contacts/records array");
  }

  return candidate.map((record, index) => {
    if (!record || typeof record !== "object") throw new Error(`Record ${index + 1} must be an object`);
    const typed = record as Partial<SourceInputRecord>;
    if (typeof typed.sourceRecordId !== "string" && typeof typed.sourceRecordId !== "number") {
      throw new Error(`Record ${index + 1} is missing sourceRecordId`);
    }
    if (typed.payload !== undefined && (!typed.payload || typeof typed.payload !== "object" || Array.isArray(typed.payload))) {
      throw new Error(`Record ${index + 1} payload must be an object`);
    }
    return typed as SourceInputRecord;
  });
}

function normalizedRecords(
  records: SourceInputRecord[],
  runId: string,
  sourceSystem: string,
  sourceAccount: string,
  capturedAt: string,
): { records: NormalizedSourceRecord[]; identities: NormalizedIdentity[] } {
  const outputRecords: NormalizedSourceRecord[] = [];
  const identities: NormalizedIdentity[] = [];

  for (const record of records) {
    const sourceRecordId = String(record.sourceRecordId);
    const entityType = record.entityType?.trim() || "contact";
    const payload = record.payload ?? (record as unknown as Record<string, unknown>);
    const payloadJson = stableJson(payload);
    const payloadSha = sha256(payloadJson);
    const sourceRecordKey = sha256(`${sourceSystem}\u0000${sourceAccount}\u0000${entityType}\u0000${sourceRecordId}`);
    const observationId = sha256(`${sourceRecordKey}\u0000${capturedAt}\u0000${payloadSha}`);
    const sourceUpdatedAt = record.sourceUpdatedAt
      ? validIsoTimestamp(record.sourceUpdatedAt, `sourceUpdatedAt for ${sourceRecordId}`)
      : null;

    outputRecords.push({
      observation_id: observationId,
      source_record_key: sourceRecordKey,
      run_id: runId,
      source_system: sourceSystem,
      source_account: sourceAccount,
      entity_type: entityType,
      source_record_id: sourceRecordId,
      captured_at: capturedAt,
      source_updated_at: sourceUpdatedAt,
      payload_sha256: payloadSha,
      payload_json: payloadJson,
    });

    const identityInput = record.identities ?? record;
    const groups: Array<{
      kind: NormalizedIdentity["identity_kind"];
      values: string[];
      normalize: (value: string) => string | null;
      mergeEligible: boolean;
    }> = [
      { kind: "email", values: stringList(identityInput.emails), normalize: normalizeEmail, mergeEligible: true },
      { kind: "phone", values: stringList(identityInput.phones), normalize: normalizePhone, mergeEligible: true },
      { kind: "name", values: stringList(identityInput.names), normalize: normalizeName, mergeEligible: false },
    ];

    for (const group of groups) {
      group.values.forEach((rawValue, index) => {
        const normalizedValue = group.normalize(rawValue);
        identities.push({
          identity_observation_id: sha256(`${observationId}\u0000${group.kind}\u0000${rawValue}\u0000${normalizedValue ?? ""}`),
          observation_id: observationId,
          identity_kind: group.kind,
          raw_value: rawValue,
          normalized_value: normalizedValue,
          merge_eligible: group.mergeEligible && normalizedValue !== null,
          is_primary: index === 0,
        });
      });
    }
  }

  return { records: outputRecords, identities };
}

export async function initializeLedger(dbPathValue = DEFAULT_DB): Promise<string> {
  const dbPath = await secureDatabasePath(dbPathValue);
  await chmodOwnerOnlyIfPresent(dbPath);
  const schema = await readFile(SCHEMA_PATH, "utf8");
  try {
    await runDuckDb(dbPath, schema);
  } finally {
    await chmodOwnerOnlyIfPresent(dbPath);
  }
  return dbPath;
}

export async function ingestFile(options: IngestOptions): Promise<{ runId: string; recordCount: number; dbPath: string }> {
  const dbPath = await initializeLedger(options.dbPath);
  const inputPath = validatedPath(options.inputPath, "--input");
  const sourceSystem = options.sourceSystem.trim().toLowerCase();
  const sourceAccount = options.sourceAccount.trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(sourceSystem)) {
    throw new Error("--source must use lowercase letters, numbers, hyphens, or underscores");
  }
  if (!sourceAccount || sourceAccount.length > 160) throw new Error("--account must be a stable non-empty alias");

  const inputBytes = await readFile(inputPath);
  const inputSha = sha256(inputBytes);
  const records = await parseInput(inputPath);
  if (records.length === 0) throw new Error("Refusing to create an empty ingestion run");

  const runId = randomUUID();
  const capturedAt = options.capturedAt
    ? validIsoTimestamp(options.capturedAt, "--captured-at")
    : new Date().toISOString();
  const normalized = normalizedRecords(records, runId, sourceSystem, sourceAccount, capturedAt);
  const stagingDir = await mkdtemp(`${tmpdir()}/contactkiller-ledger-`);
  const recordFile = resolve(stagingDir, "records.ndjson");
  const identityFile = resolve(stagingDir, "identities.ndjson");

  try {
    await writeFile(recordFile, `${normalized.records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
    if (normalized.identities.length > 0) {
      await writeFile(identityFile, `${normalized.identities.map((identity) => JSON.stringify(identity)).join("\n")}\n`, { mode: 0o600 });
    }

    const identitySql = normalized.identities.length > 0
      ? `
        INSERT INTO identity_observations
        SELECT
          identity_observation_id,
          observation_id,
          identity_kind,
          raw_value,
          normalized_value,
          merge_eligible,
          is_primary
        FROM read_json_auto(${sqlLiteral(identityFile)}, format = 'newline_delimited')
        ON CONFLICT DO NOTHING;
      `
      : "";
    const metadataJson = stableJson(options.metadata ?? {});
    const sql = `
      BEGIN TRANSACTION;
      INSERT INTO ingestion_runs (
        run_id, source_system, source_account, started_at, input_sha256,
        input_path, record_count, status, metadata
      ) VALUES (
        ${sqlLiteral(runId)}, ${sqlLiteral(sourceSystem)}, ${sqlLiteral(sourceAccount)},
        ${sqlLiteral(capturedAt)}::TIMESTAMPTZ, ${sqlLiteral(inputSha)},
        ${sqlLiteral(inputPath)}, ${records.length}, 'running', ${sqlLiteral(metadataJson)}::JSON
      );

      INSERT INTO source_records
      SELECT
        observation_id,
        source_record_key,
        run_id,
        source_system,
        source_account,
        entity_type,
        source_record_id,
        captured_at::TIMESTAMPTZ,
        CASE WHEN source_updated_at IS NULL THEN NULL ELSE source_updated_at::TIMESTAMPTZ END,
        payload_sha256,
        payload_json::JSON
      FROM read_json_auto(${sqlLiteral(recordFile)}, format = 'newline_delimited')
      ON CONFLICT DO NOTHING;
      ${identitySql}
      UPDATE ingestion_runs
      SET completed_at = now(), status = 'succeeded'
      WHERE run_id = ${sqlLiteral(runId)};
      COMMIT;
    `;
    await runDuckDb(dbPath, sql);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  return { runId, recordCount: records.length, dbPath };
}

export async function ledgerSummary(dbPathValue = DEFAULT_DB): Promise<unknown> {
  const dbPath = await initializeLedger(dbPathValue);
  const output = await runDuckDb(dbPath, `
    SELECT json_object(
      'successful_runs', (SELECT count(*) FROM ingestion_runs WHERE status = 'succeeded'),
      'current_records', (SELECT count(*) FROM current_source_records),
      'duplicate_identity_candidates', (SELECT count(*) FROM duplicate_identity_candidates),
      'sources', (SELECT coalesce(json_group_array(json_object(
        'source_system', source_system,
        'source_account', source_account,
        'entity_type', entity_type,
        'current_record_count', current_record_count,
        'latest_capture', latest_capture
      )), '[]'::JSON) FROM source_inventory)
    ) AS summary;
  `, true);
  const rows = JSON.parse(output) as Array<{ summary: string | Record<string, unknown> }>;
  const summary = rows[0]?.summary ?? {};
  return typeof summary === "string" ? JSON.parse(summary) : summary;
}

interface ParsedCli {
  command: "init" | "ingest" | "summary";
  dbPath: string;
  inputPath?: string;
  sourceSystem?: string;
  sourceAccount?: string;
  capturedAt?: string;
}

export function parseCli(argv: string[]): ParsedCli {
  const [commandValue, ...args] = argv;
  if (commandValue === "--help" || commandValue === "-h" || !commandValue) {
    console.log(HELP.trim());
    process.exit(commandValue ? 0 : 1);
  }
  if (commandValue !== "init" && commandValue !== "ingest" && commandValue !== "summary") {
    throw new Error(`Unknown command: ${commandValue}`);
  }

  let dbPath = DEFAULT_DB;
  let inputPath: string | undefined;
  let sourceSystem: string | undefined;
  let sourceAccount: string | undefined;
  let capturedAt: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--db", "--input", "--source", "--account", "--captured-at"].includes(flag)) {
      throw new Error(`Unknown option: ${flag}`);
    }
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--db") dbPath = value;
    if (flag === "--input") inputPath = value;
    if (flag === "--source") sourceSystem = value;
    if (flag === "--account") sourceAccount = value;
    if (flag === "--captured-at") capturedAt = value;
    index += 1;
  }

  if (commandValue === "ingest" && (!inputPath || !sourceSystem || !sourceAccount)) {
    throw new Error("ingest requires --input, --source, and --account");
  }
  return { command: commandValue, dbPath, inputPath, sourceSystem, sourceAccount, capturedAt };
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.command === "init") {
    const dbPath = await initializeLedger(options.dbPath);
    console.log(JSON.stringify({ initialized: true, dbPath }));
    return;
  }
  if (options.command === "summary") {
    console.log(JSON.stringify(await ledgerSummary(options.dbPath), null, 2));
    return;
  }
  const result = await ingestFile({
    dbPath: options.dbPath,
    inputPath: options.inputPath!,
    sourceSystem: options.sourceSystem!,
    sourceAccount: options.sourceAccount!,
    capturedAt: options.capturedAt,
  });
  console.log(JSON.stringify({ ingested: true, ...result }));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
