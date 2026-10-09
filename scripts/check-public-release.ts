#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { extname, isAbsolute, posix, relative, resolve } from "node:path";

interface ReleaseManifest {
  schemaVersion: number;
  allowedFiles: string[];
  reviewedBinaryDigests: Record<string, string>;
  requiredBinarySidecars: Record<string, string[]>;
  forbiddenPrefixes: string[];
  forbiddenExtensions: string[];
  forbiddenExtensionExceptions?: string[];
  allowedEmailDomains: string[];
  maxFileSizeBytes: number;
  requiredVcardMarker: string;
}

interface Finding {
  path: string;
  reason: string;
}

const root = resolve(import.meta.dir, "..");

const scanExportIndex = process.argv.indexOf("--scan-export");
const scanMode = scanExportIndex !== -1;
const scanExportPaths = scanMode ? process.argv.slice(scanExportIndex + 1) : [];
if (scanMode && scanExportPaths.length === 0) {
  throw new Error("--scan-export requires at least one file path");
}
const manifestPath = "PUBLIC_RELEASE_MANIFEST.json";
const manifest = JSON.parse(
  readFileSync(resolve(root, manifestPath), "utf8"),
) as ReleaseManifest;

if (manifest.schemaVersion !== 3) {
  throw new Error(`Unsupported public-release manifest version: ${manifest.schemaVersion}`);
}

const findings: Finding[] = [];

function add(path: string, reason: string): void {
  findings.push({ path, reason });
}

function requireStringArray(name: keyof ReleaseManifest, value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${String(name)} must be an array of non-empty strings`);
  }
}

requireStringArray("allowedFiles", manifest.allowedFiles);
requireStringArray("forbiddenPrefixes", manifest.forbiddenPrefixes);
requireStringArray("forbiddenExtensions", manifest.forbiddenExtensions);
const forbiddenExtensionExceptions = manifest.forbiddenExtensionExceptions ?? [];
requireStringArray("forbiddenExtensionExceptions", forbiddenExtensionExceptions);
requireStringArray("allowedEmailDomains", manifest.allowedEmailDomains);

if (
  !manifest.reviewedBinaryDigests
  || typeof manifest.reviewedBinaryDigests !== "object"
  || Array.isArray(manifest.reviewedBinaryDigests)
) {
  throw new Error("reviewedBinaryDigests must be a path-to-SHA-256 object");
}
if (
  !manifest.requiredBinarySidecars
  || typeof manifest.requiredBinarySidecars !== "object"
  || Array.isArray(manifest.requiredBinarySidecars)
) {
  throw new Error("requiredBinarySidecars must be a path-to-sidecar-list object");
}

if (!Number.isSafeInteger(manifest.maxFileSizeBytes) || manifest.maxFileSizeBytes <= 0) {
  throw new Error("maxFileSizeBytes must be a positive safe integer");
}
if (manifest.requiredVcardMarker !== "X-CONTACTKILLER-SYNTHETIC:TRUE") {
  throw new Error("requiredVcardMarker must be X-CONTACTKILLER-SYNTHETIC:TRUE");
}

function isCanonicalRepositoryPath(path: string): boolean {
  if (!path || path.includes("\\") || path.startsWith("/") || isAbsolute(path)) return false;
  if (posix.normalize(path) !== path || path === "." || path.startsWith("../")) return false;
  const resolved = resolve(root, path);
  const fromRoot = relative(root, resolved);
  return fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort(comparePaths);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

for (const path of manifest.allowedFiles) {
  if (!isCanonicalRepositoryPath(path)) add(manifestPath, `non-canonical allowed path: ${path}`);
}
const reviewedBinaryPaths = Object.keys(manifest.reviewedBinaryDigests);
const sidecarBinaryPaths = Object.keys(manifest.requiredBinarySidecars);
for (const path of reviewedBinaryPaths) {
  if (!isCanonicalRepositoryPath(path)) add(manifestPath, `non-canonical binary path: ${path}`);
  const digest = manifest.reviewedBinaryDigests[path];
  if (!digest || !/^[a-f0-9]{64}$/u.test(digest)) {
    add(manifestPath, `reviewed binary digest must be lowercase SHA-256: ${path}`);
  }
}
for (const path of forbiddenExtensionExceptions) {
  if (!manifest.allowedFiles.includes(path)) {
    add(manifestPath, `forbidden-extension exception is not present in allowedFiles: ${path}`);
  }
}
for (const path of duplicates(manifest.allowedFiles)) {
  add(manifestPath, `duplicate allowed path: ${path}`);
}
for (const binaryPath of sidecarBinaryPaths) {
  if (!isCanonicalRepositoryPath(binaryPath)) {
    add(manifestPath, `non-canonical sidecar owner path: ${binaryPath}`);
  }
  const sidecars = manifest.requiredBinarySidecars[binaryPath];
  if (!Array.isArray(sidecars) || sidecars.length === 0) {
    add(manifestPath, `reviewed binary must declare at least one source or provenance sidecar: ${binaryPath}`);
    continue;
  }
  for (const sidecar of sidecars) {
    if (typeof sidecar !== "string" || !isCanonicalRepositoryPath(sidecar)) {
      add(manifestPath, `non-canonical binary sidecar path for ${binaryPath}: ${String(sidecar)}`);
    }
  }
  for (const sidecar of duplicates(sidecars)) {
    add(manifestPath, `duplicate binary sidecar for ${binaryPath}: ${sidecar}`);
  }
  const expectedSidecarOrder = [...sidecars].sort(comparePaths);
  if (expectedSidecarOrder.some((sidecar, index) => sidecar !== sidecars[index])) {
    add(manifestPath, `binary sidecars must remain sorted for reviewability: ${binaryPath}`);
  }
}

const expectedOrder = [...manifest.allowedFiles].sort(comparePaths);
if (expectedOrder.some((path, index) => path !== manifest.allowedFiles[index])) {
  add(manifestPath, "allowedFiles must remain lexicographically sorted for reviewability");
}

const allowedFiles = new Set(manifest.allowedFiles);
const reviewedBinaryDigests = new Map(Object.entries(manifest.reviewedBinaryDigests));
const forbiddenExtensions = new Set(manifest.forbiddenExtensions.map((value) => value.toLowerCase()));
const forbiddenExtensionExceptionPaths = new Set(forbiddenExtensionExceptions);
const allowedEmailDomains = new Set(manifest.allowedEmailDomains.map((value) => value.toLowerCase()));

if ([...reviewedBinaryPaths].sort(comparePaths).some((path, index) => path !== reviewedBinaryPaths[index])) {
  add(manifestPath, "reviewedBinaryDigests keys must remain sorted for reviewability");
}
if ([...sidecarBinaryPaths].sort(comparePaths).some((path, index) => path !== sidecarBinaryPaths[index])) {
  add(manifestPath, "requiredBinarySidecars keys must remain sorted for reviewability");
}
for (const path of reviewedBinaryPaths) {
  if (!allowedFiles.has(path)) add(manifestPath, `binary path is not present in allowedFiles: ${path}`);
  if (!Object.hasOwn(manifest.requiredBinarySidecars, path)) {
    add(manifestPath, `reviewed binary has no source or provenance sidecar declaration: ${path}`);
  }
}
for (const path of sidecarBinaryPaths) {
  if (!reviewedBinaryDigests.has(path)) {
    add(manifestPath, `sidecar declaration belongs to an unreviewed binary: ${path}`);
  }
  for (const sidecar of manifest.requiredBinarySidecars[path] ?? []) {
    if (!allowedFiles.has(sidecar)) {
      add(manifestPath, `binary sidecar is not present in allowedFiles: ${sidecar}`);
    }
    if (sidecar === path) add(manifestPath, `binary cannot be its own sidecar: ${path}`);
  }
}

function pathExistsWithoutFollowingLinks(path: string): boolean {
  try {
    lstatSync(resolve(root, path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const listed = scanMode ? [] : execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter(pathExistsWithoutFollowingLinks)
  .sort(comparePaths);
const listedFiles = new Set(listed);

for (const path of manifest.allowedFiles) {
  if (!scanMode && !listedFiles.has(path)) add(path, "allowlisted public file is missing from the release tree");
}
for (const path of listed) {
  if (!allowedFiles.has(path)) add(path, "file is not in the exact public-release allowlist");
}

const emailPattern = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/giu;
const internationalPhonePattern = /\+(?:[0-9][0-9 \t()./-]{6,}[0-9])/gu;
const domesticNanpPhonePattern =
  /(?<![0-9A-Za-z])(?:1[ \t./-]*)?(?:\([2-9][0-9]{2}\)|[2-9][0-9]{2})[ \t./-]*[2-9][0-9]{2}[ \t./-]*[0-9]{4}(?![0-9A-Za-z])/gu;
const supabaseProjectHostPattern = /\bhttps?:\/\/[a-z0-9]{20}\.supabase\.co(?:[/:?#]|$)/iu;
const supabaseDashboardProjectPattern = /\bhttps?:\/\/(?:app\.)?supabase\.com\/(?:dashboard\/)?project\/[a-z0-9]{8,}(?:[/?#]|$)/iu;
const supabaseProjectRefPattern = /\b(?:SUPABASE_PROJECT_REF|supabase[_-]?project[_-]?(?:id|ref)|project[_-]?ref)\s*[:=]\s*["']?[a-z0-9]{20}\b/iu;

function scanTextContent(path: string, text: string): void {
  if (supabaseProjectHostPattern.test(text)) {
    add(path, "Supabase project-specific API URL detected");
  }
  if (supabaseDashboardProjectPattern.test(text)) {
    add(path, "Supabase project-specific dashboard URL detected");
  }
  if (supabaseProjectRefPattern.test(text)) {
    add(path, "Supabase project reference detected");
  }

  for (const match of text.matchAll(emailPattern)) {
    const domain = match[1]?.toLowerCase();
    if (domain && !allowedEmailDomains.has(domain)) {
      add(path, `non-example email domain detected: ${domain}`);
    }
  }

  const phoneCandidates = new Map<string, string>();
  for (const pattern of [internationalPhonePattern, domesticNanpPhonePattern]) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].replace(/\s+/gu, " ").trim();
      phoneCandidates.set(value.replace(/\D/gu, ""), value);
    }
  }
  for (const value of phoneCandidates.values()) {
    if (!isReservedExamplePhone(value)) {
      add(path, "non-reserved phone-like value detected");
    }
  }
}

// Written so that this file's own source cannot match any pattern below.
const privateIdentifierPatterns: Array<[RegExp, string]> = [
  [/\bbc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu, "private cloud-agent id"],
  [/\bbc[\W_][0-9a-f]{8,}/iu, "private cloud-agent id (short form)"],
  [new RegExp("GS-C" + "K-", "iu"), "private factory task id"],
  [new RegExp("GS[\\W_]*C" + "K[\\W_]*\\d", "iu"), "private factory task id"],
  [/grok[\W_]?shi[p]/iu, "private originating-agent name"],
  [new RegExp("/home/bo" + "x/", "iu"), "private machine path"],
  [/\/workspac[e]\//iu, "private machine path"],
  [/agent-dat[a]\//iu, "private machine path"],
  [new RegExp("GOCSP" + "X-[A-Za-z0-9_-]{20,}", "u"), "Google OAuth client secret"],
  [/Beare[r]\s+[A-Za-z0-9._~+/-]{20,}/u, "bearer token"],
];

function scanPrivateIdentifiers(path: string, text: string): void {
  for (const [pattern, label] of privateIdentifierPatterns) {
    if (pattern.test(text)) add(path, `${label} detected; public files and tickets must use opaque aliases and carry no private values`);
  }
}

function isReservedExamplePhone(value: string): boolean {
  const digits = value.replace(/\D/gu, "");
  return /^(?:1)?[2-9][0-9]{2}55501[0-9]{2}$/u.test(digits);
}

function isProbablyBinary(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return true;
  }
  return bytes.some((byte) =>
    (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127);
}

const sidecarOwners = new Map<string, string[]>();
for (const [binaryPath, sidecars] of Object.entries(manifest.requiredBinarySidecars)) {
  if (!Array.isArray(sidecars)) continue;
  for (const sidecar of sidecars) {
    if (typeof sidecar !== "string") continue;
    const owners = sidecarOwners.get(sidecar) ?? [];
    owners.push(binaryPath);
    sidecarOwners.set(sidecar, owners);
  }
}

function hasSidecarMetadata(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && typeof value === "object" && Object.keys(value).length > 0;
}

function validateBinarySidecar(path: string, text: string, extension: string): void {
  if (!sidecarOwners.has(path)) return;

  if (extension === ".svg") {
    if (!/<svg(?:\s|>)/iu.test(text)) {
      add(path, "reviewed binary source sidecar is not a recognizable SVG document");
    }
    return;
  }

  if (extension === ".json") {
    let metadata: unknown;
    try {
      metadata = JSON.parse(text);
    } catch {
      add(path, "reviewed binary prompt/provenance sidecar is not valid JSON");
      return;
    }
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
      add(path, "reviewed binary prompt/provenance sidecar must be a JSON object");
      return;
    }
    const record = metadata as Record<string, unknown>;
    if (
      !hasSidecarMetadata(record.prompt)
      && !hasSidecarMetadata(record.provenance)
      && !hasSidecarMetadata(record.source)
    ) {
      add(path, "reviewed binary JSON sidecar has no prompt, provenance, or source metadata");
    }
    return;
  }

  add(path, "reviewed binary sidecar must be source SVG or JSON prompt/provenance metadata");
}

for (const path of listed) {
  const absolutePath = resolve(root, path);
  const stats = lstatSync(absolutePath);

  if (manifest.forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
    add(path, "path is explicitly forbidden from public releases");
  }
  if (stats.isSymbolicLink()) {
    add(path, "symbolic links require explicit release review and are not permitted");
    continue;
  }
  if (!stats.isFile()) {
    add(path, "non-regular release entries are not permitted");
    continue;
  }
  const extension = extname(path).toLowerCase();
  if (forbiddenExtensions.has(extension) && !forbiddenExtensionExceptionPaths.has(path)) {
    add(path, `forbidden release extension ${extension}`);
  }
  if (stats.size > manifest.maxFileSizeBytes) {
    add(path, `file exceeds the ${manifest.maxFileSizeBytes}-byte public-source limit (${stats.size} bytes)`);
    continue;
  }

  const bytes = readFileSync(absolutePath);
  const binary = isProbablyBinary(bytes);
  const expectedDigest = reviewedBinaryDigests.get(path);
  if (binary && !expectedDigest) {
    add(path, "binary content has no reviewed SHA-256 digest");
    continue;
  }
  if (!binary && expectedDigest) {
    add(path, "reviewedBinaryDigests entry no longer contains detectable binary content");
    continue;
  }
  if (binary) {
    const actualDigest = createHash("sha256").update(bytes).digest("hex");
    if (actualDigest !== expectedDigest) {
      add(path, "binary SHA-256 differs from the reviewed digest");
    }
    if (sidecarOwners.has(path)) {
      add(path, "a reviewed binary cannot serve as a text source/provenance sidecar");
    }
    continue;
  }

  const text = bytes.toString("utf8");
  validateBinarySidecar(path, text, extension);
  if (extension === ".vcf") {
    const markerPattern = new RegExp(`^${manifest.requiredVcardMarker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\r?$`, "mu");
    if (!markerPattern.test(text)) {
      add(path, `synthetic vCard marker is missing: ${manifest.requiredVcardMarker}`);
    }
  }

  scanTextContent(path, text);
  scanPrivateIdentifiers(path, text);
}

for (const exportPath of scanExportPaths) {
  const bytes = readFileSync(resolve(exportPath));
  if (bytes.length === 0) {
    add(exportPath, "export is empty");
    continue;
  }
  if (bytes.length > manifest.maxFileSizeBytes) {
    add(exportPath, `export exceeds the ${manifest.maxFileSizeBytes}-byte limit (${bytes.length} bytes)`);
    continue;
  }
  if (isProbablyBinary(bytes)) {
    add(exportPath, "export contains binary content");
    continue;
  }
  const text = bytes.toString("utf8");
  scanTextContent(exportPath, text);
  scanPrivateIdentifiers(exportPath, text);
}

if (findings.length > 0) {
  console.error("Public-release check failed:\n");
  for (const finding of findings) console.error(`- ${finding.path}: ${finding.reason}`);
  process.exit(1);
}

if (scanMode) {
  console.log(`Export scan passed for ${scanExportPaths.length} file(s).`);
  process.exit(0);
}

console.log(
  `Public-release check passed for ${listed.length} exact files (${reviewedBinaryDigests.size} reviewed binary).`,
);
