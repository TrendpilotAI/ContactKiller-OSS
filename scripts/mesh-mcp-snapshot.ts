#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = fileURLToPath(new URL("./mesh-search-page.schema.json", import.meta.url));
const LOCAL_MESH_ROOT = resolve(".local/contactkiller/mesh");
const MESH_ENABLED_TOOLS_CONFIG = 'mcp_servers.mesh.enabled_tools=["searchContacts"]';
const MESH_DISABLED_TOOLS_CONFIG = "mcp_servers.mesh.disabled_tools=[]";
const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_INCLUDE_FIELDS = [
  "work_history",
  "education_history",
  "location",
  "birthday",
  "created",
  "interaction_history",
  "message_history",
  "email_history",
  "event_history",
  "notes",
  "integrations",
  "emails",
  "phone_numbers",
  "social_links",
] as const;

const INTEGRATIONS = [
  "calendar",
  "twitter",
  "linkedin",
  "email",
  "messages",
  "apple-contacts",
  "facebook",
  "browser-extension",
  "business-cards",
  "carddav",
  "zapier",
  "make",
  "instagram",
  "whatsapp",
  "bulk-import",
  "google-contacts",
] as const;

interface SnapshotOptions {
  name?: string;
  integration?: (typeof INTEGRATIONS)[number];
  limit: number;
  outputPath: string;
  execute: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CaptureDependencies {
  runCommand?: (command: string, args: string[]) => Promise<CommandResult>;
}

interface SnapshotResult {
  schemaVersion: 1;
  tool: "mcp__mesh__searchContacts";
  capturedAt: string;
  contacts: Array<{
    sourceRecordId: string;
    entityType: "contact";
    sourceUpdatedAt: string | null;
    payloadJson: string;
    emails: string[];
    phones: string[];
    names: string[];
  }>;
}

const HELP = `
Capture a bounded, enriched Mesh contact page through the authenticated MCP server.

Usage:
  bun scripts/mesh-mcp-snapshot.ts [--name <exact name>] [--integration <source>]
    [--limit <1-100>] [--output <local-json>] [--execute]

The default is a dry run. --execute starts an ephemeral, read-only Codex process that
hard-allows only mcp__mesh__searchContacts on the Mesh server. Output is plaintext contact
data and is restricted to a direct file inside .local/contactkiller/mesh/, which Git ignores.
This script exposes no Mesh write, archive, merge, restore, note, or group operation.
`;

function defaultOutputPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(LOCAL_MESH_ROOT, `${timestamp}-search-page.json`);
}

function safeOutputPath(value: string): string {
  const outputPath = resolve(value);
  if (dirname(outputPath) !== LOCAL_MESH_ROOT) {
    throw new Error("--output must be a direct file inside .local/contactkiller/mesh");
  }
  return outputPath;
}

function boundedLimit(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("--limit must be an integer");
  const limit = Number.parseInt(value, 10);
  if (limit < 1 || limit > 100) throw new Error("--limit must be between 1 and 100");
  return limit;
}

export function parseSnapshotArgs(argv: string[]): SnapshotOptions {
  let name: string | undefined;
  let integration: SnapshotOptions["integration"];
  let limit = 25;
  let outputPath = defaultOutputPath();
  let execute = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      console.log(HELP.trim());
      process.exit(0);
    }
    if (flag === "--execute") {
      execute = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--name") name = value.trim();
    else if (flag === "--integration") {
      if (!INTEGRATIONS.includes(value as SnapshotOptions["integration"])) {
        throw new Error(`--integration must be one of: ${INTEGRATIONS.join(", ")}`);
      }
      integration = value as SnapshotOptions["integration"];
    } else if (flag === "--limit") limit = boundedLimit(value);
    else if (flag === "--output") outputPath = safeOutputPath(value);
    else throw new Error(`Unknown option: ${flag}`);
    index += 1;
  }

  if (name !== undefined && !name) throw new Error("--name must not be empty");
  return { name, integration, limit, outputPath, execute };
}

export function buildMeshSearchInput(options: Pick<SnapshotOptions, "name" | "integration" | "limit">): Record<string, unknown> {
  const input: Record<string, unknown> = {
    limit: options.limit,
    include_fields: [...DEFAULT_INCLUDE_FIELDS],
    sort: { field: "relevance", direction: "desc" },
  };
  if (options.name) input.name = [options.name];
  if (options.integration) input.integration = [options.integration];
  return input;
}

export function buildPrompt(input: Record<string, unknown>): string {
  return [
    "Use only the authenticated Mesh MCP server.",
    "Call exactly one tool: mcp__mesh__searchContacts with this JSON input:",
    JSON.stringify(input),
    "Do not call any write or mutation tool. Do not inspect local files and do not run shell commands.",
    "Return every contact from the tool result exactly once and do not invent, enrich, redact, or summarize values.",
    "For each contact, set sourceRecordId to the Mesh contact ID converted to a string, entityType to contact, and payloadJson to the complete raw contact object serialized as compact JSON,",
    "emails and phones to the exact string values present in the result, and names to the displayed/full name plus distinct first/last combinations when available.",
    "Set capturedAt to the current ISO-8601 time. Your final response must match the supplied JSON Schema with no extra prose.",
  ].join("\n");
}

export function buildCodexExecArgs(rawOutputPath: string, emptyWorkspace: string, prompt: string): string[] {
  return [
    "exec",
    "--ephemeral",
    "--sandbox", "read-only",
    "--color", "never",
    "--skip-git-repo-check",
    "-C", emptyWorkspace,
    "-c", MESH_ENABLED_TOOLS_CONFIG,
    "-c", MESH_DISABLED_TOOLS_CONFIG,
    "--output-schema", SCHEMA_PATH,
    "-o", rawOutputPath,
    prompt,
  ];
}

async function run(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
  });
}

async function verifyMeshAuthentication(runCommand: typeof run): Promise<void> {
  const result = await runCommand("codex", ["mcp", "list"]);
  if (result.exitCode !== 0 || !/^mesh\s+https:\/\/mcp\.me\.sh\/mcp\s+.*enabled\s+OAuth\s*$/m.test(result.stdout)) {
    throw new Error("Mesh MCP is not authenticated. Run: codex mcp login mesh --oauth-client-registration dcr");
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function rejectSymbolicLink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`Refusing symbolic link at ${path}`);
    }
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
}

async function ensureLocalMeshRoot(): Promise<void> {
  const localRoot = resolve(".local");
  const contactKillerRoot = resolve(".local/contactkiller");
  for (const path of [localRoot, contactKillerRoot, LOCAL_MESH_ROOT]) {
    await rejectSymbolicLink(path);
  }
  await mkdir(LOCAL_MESH_ROOT, { recursive: true, mode: 0o700 });
  const canonicalWorkingDirectory = await realpath(process.cwd());
  const canonicalRoot = await realpath(LOCAL_MESH_ROOT);
  if (canonicalRoot !== resolve(canonicalWorkingDirectory, ".local/contactkiller/mesh")) {
    throw new Error("Local Mesh output directory resolved outside the current workspace");
  }
  await chmod(LOCAL_MESH_ROOT, 0o700);
}

async function presecureFile(path: string): Promise<void> {
  await rejectSymbolicLink(path);
  const handle = await open(path, "w", 0o600);
  await handle.close();
  await chmod(path, 0o600);
}

async function writeOwnerOnly(path: string, content: string): Promise<void> {
  await presecureFile(path);
  await writeFile(path, content);
  await chmod(path, 0o600);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

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

function parseSnapshotResult(raw: string): SnapshotResult {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Mesh snapshot result was not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mesh snapshot result was not an object");
  }
  const parsed = value as Partial<SnapshotResult>;
  if (
    parsed.schemaVersion !== 1
    || parsed.tool !== "mcp__mesh__searchContacts"
    || typeof parsed.capturedAt !== "string"
    || !isRfc3339Instant(parsed.capturedAt)
    || !Array.isArray(parsed.contacts)
  ) {
    throw new Error("Mesh snapshot did not match the expected result envelope");
  }
  for (const contact of parsed.contacts) {
    if (
      !contact
      || typeof contact !== "object"
      || typeof contact.sourceRecordId !== "string"
      || contact.sourceRecordId.length === 0
      || contact.entityType !== "contact"
      || (contact.sourceUpdatedAt !== null && (
        typeof contact.sourceUpdatedAt !== "string"
        || !isRfc3339Instant(contact.sourceUpdatedAt)
      ))
      || typeof contact.payloadJson !== "string"
      || !isStringArray(contact.emails)
      || !isStringArray(contact.phones)
      || !isStringArray(contact.names)
    ) {
      throw new Error("Mesh snapshot contained an invalid contact record");
    }
  }
  return parsed as SnapshotResult;
}

async function retainRedactedFailureDiagnostic(
  diagnosticPath: string,
  result: CommandResult | null,
): Promise<void> {
  const diagnostic = {
    schemaVersion: 1,
    error: "mesh_snapshot_command_failed",
    recordedAt: new Date().toISOString(),
    exitCode: result?.exitCode ?? null,
    stdoutBytes: result ? Buffer.byteLength(result.stdout) : 0,
    stderrBytes: result ? Buffer.byteLength(result.stderr) : 0,
    outputRedacted: true,
  };
  await writeOwnerOnly(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`);
}

export async function captureSnapshot(
  options: SnapshotOptions,
  dependencies: CaptureDependencies = {},
): Promise<{ outputPath: string; contactCount: number }> {
  if (!options.execute) throw new Error("captureSnapshot requires --execute");
  const runCommand = dependencies.runCommand ?? run;
  const outputPath = safeOutputPath(options.outputPath);
  await verifyMeshAuthentication(runCommand);
  await ensureLocalMeshRoot();
  const emptyWorkspace = resolve(LOCAL_MESH_ROOT, "empty-workspace");
  await rejectSymbolicLink(emptyWorkspace);
  await mkdir(emptyWorkspace, { recursive: true, mode: 0o700 });
  await chmod(emptyWorkspace, 0o700);
  const prompt = buildPrompt(buildMeshSearchInput(options));
  const rawOutputPath = `${outputPath}.raw`;
  const errorPath = `${outputPath}.error.json`;
  await rm(errorPath, { force: true });
  await presecureFile(outputPath);
  try {
    await presecureFile(rawOutputPath);
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }

  const args = buildCodexExecArgs(rawOutputPath, emptyWorkspace, prompt);
  let result: CommandResult;
  try {
    result = await runCommand("codex", args);
  } catch {
    await rm(rawOutputPath, { force: true });
    await rm(outputPath, { force: true });
    await retainRedactedFailureDiagnostic(errorPath, null);
    throw new Error(`Mesh snapshot command could not start; a redacted diagnostic was kept at ${errorPath}`);
  }
  if (result.exitCode !== 0) {
    await rm(rawOutputPath, { force: true });
    await rm(outputPath, { force: true });
    await retainRedactedFailureDiagnostic(errorPath, result);
    throw new Error(`Mesh snapshot failed; a redacted diagnostic was kept locally at ${errorPath}`);
  }

  try {
    await chmod(rawOutputPath, 0o600);
    const parsed = parseSnapshotResult(await readFile(rawOutputPath, "utf8"));
    const snapshot = {
      schemaVersion: parsed.schemaVersion,
      tool: parsed.tool,
      capturedAt: parsed.capturedAt,
      contacts: parsed.contacts.map((contact) => {
        const payload = JSON.parse(contact.payloadJson) as unknown;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error("Mesh contact payload was not an object");
        }
        return {
          sourceRecordId: contact.sourceRecordId,
          entityType: contact.entityType,
          sourceUpdatedAt: contact.sourceUpdatedAt,
          payload,
          emails: contact.emails,
          phones: contact.phones,
          names: contact.names,
        };
      }),
    };
    await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    await chmod(outputPath, 0o600);
    return { outputPath, contactCount: parsed.contacts.length };
  } catch {
    await rm(outputPath, { force: true });
    throw new Error("Mesh snapshot parse or validation failed; no snapshot was retained");
  } finally {
    await rm(rawOutputPath, { force: true });
  }
}

async function main(): Promise<void> {
  const options = parseSnapshotArgs(process.argv.slice(2));
  if (!options.execute) {
    console.log(JSON.stringify({
      mode: "dry-run",
      outputPath: options.outputPath,
      tool: "mcp__mesh__searchContacts",
      input: buildMeshSearchInput(options),
      hardMeshToolAllowlist: ["searchContacts"],
      meshMutatingToolsExposed: false,
    }, null, 2));
    return;
  }
  const result = await captureSnapshot(options);
  console.log(JSON.stringify({ captured: true, ...result }));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
