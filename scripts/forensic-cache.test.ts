import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ingestFile,
  initializeLedger,
  isRfc3339Instant,
  ledgerSummary,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  stableJson,
} from "./forensic-cache";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("forensic cache normalization", () => {
  test("normalizes only safe identity keys", () => {
    expect(normalizeEmail(" Alice@Example.COM ")).toBe("alice@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizePhone("00 1 (202) 555-0123")).toBe("+12025550123");
    expect(normalizePhone("+1 202-555-0123")).toBe("+12025550123");
    expect(normalizePhone("(202) 555-0123")).toBeNull();
    expect(normalizePhone("00 0 202 555 0123")).toBeNull();
    expect(normalizePhone("+1234567")).toBeNull();
    expect(normalizePhone("+1 202 CALL-NOW")).toBeNull();
    expect(normalizePhone("+1/202/555/0123")).toBeNull();
    expect(normalizePhone("+1 202 555 0123 ext 4")).toBeNull();
    expect(normalizeName("  Sentinel   Friend ")).toBe("sentinel friend");
  });

  test("canonicalizes object keys before hashing", () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  test("accepts only real RFC3339 instants with explicit timezones", () => {
    expect(isRfc3339Instant("2024-02-29T23:59:59.123Z")).toBe(true);
    expect(isRfc3339Instant("2026-08-30T12:34:56-04:00")).toBe(true);
    expect(isRfc3339Instant("2026-08-30T12:34:56+05:30")).toBe(true);
    expect(isRfc3339Instant("2026-02-30T12:00:00Z")).toBe(false);
    expect(isRfc3339Instant("2025-02-29T12:00:00Z")).toBe(false);
    expect(isRfc3339Instant("2026-08-30T12:00:00")).toBe(false);
    expect(isRfc3339Instant("2026-08-30T12:00:00+24:00")).toBe(false);
  });
});

describe("DuckDB forensic cache", () => {
  test("rejects a final-component database symlink without touching its target", async () => {
    const directory = await mkdtemp(`${tmpdir()}/contactkiller-symlink-test-`);
    temporaryDirectories.push(directory);
    const targetPath = join(directory, "do-not-touch.txt");
    const dbPath = join(directory, "ledger.duckdb");
    await writeFile(targetPath, "sentinel-content", { mode: 0o644 });
    await chmod(targetPath, 0o644);
    await symlink(targetPath, dbPath);

    await expect(initializeLedger(dbPath)).rejects.toThrow("symbolic-link database path");
    expect(await readFile(targetPath, "utf8")).toBe("sentinel-content");
    expect((await stat(targetPath)).mode & 0o777).toBe(0o644);
  });

  test("canonicalizes a parent symlink before creating legitimate nested paths", async () => {
    const directory = await mkdtemp(`${tmpdir()}/contactkiller-parent-test-`);
    temporaryDirectories.push(directory);
    const canonicalParent = join(directory, "canonical-parent");
    const parentAlias = join(directory, "parent-alias");
    await mkdir(canonicalParent, { mode: 0o700 });
    await symlink(canonicalParent, parentAlias);

    const dbPath = await initializeLedger(join(parentAlias, "new", "ledger.duckdb"));
    expect(dbPath).toBe(join(await realpath(canonicalParent), "new", "ledger.duckdb"));
    expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
  });

  test("keeps the DuckDB file owner-readable and owner-writable only", async () => {
    const directory = await mkdtemp(`${tmpdir()}/contactkiller-mode-test-`);
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "ledger.duckdb");

    await initializeLedger(dbPath);
    expect((await stat(dbPath)).mode & 0o777).toBe(0o600);

    await chmod(dbPath, 0o644);
    await initializeLedger(dbPath);
    expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
  });

  test("preserves source records and reports cross-source duplicate identities", async () => {
    const directory = await mkdtemp(`${tmpdir()}/contactkiller-test-`);
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "ledger.duckdb");
    const meshPath = join(directory, "mesh.json");
    const icloudPath = join(directory, "icloud.ndjson");

    await writeFile(meshPath, JSON.stringify({ contacts: [{
      sourceRecordId: 101,
      payload: { first_name: "Synthetic", last_name: "Contact" },
      emails: ["SYNTHETIC@example.com"],
      names: ["Synthetic Contact"],
    }] }));
    await writeFile(icloudPath, `${JSON.stringify({
      sourceRecordId: "icloud-1",
      payload: { fullName: "Synthetic Contact" },
      emails: ["synthetic@example.com"],
      phones: ["+12025550123"],
      names: ["Synthetic Contact"],
    })}\n`);

    await ingestFile({
      dbPath,
      inputPath: meshPath,
      sourceSystem: "mesh",
      sourceAccount: "primary",
      capturedAt: "2026-08-30T12:00:00.000Z",
    });
    await ingestFile({
      dbPath,
      inputPath: icloudPath,
      sourceSystem: "icloud",
      sourceAccount: "personal",
      capturedAt: "2026-08-30T12:01:00.000Z",
    });

    expect(await ledgerSummary(dbPath)).toEqual({
      successful_runs: 2,
      current_records: 2,
      duplicate_identity_candidates: 1,
      sources: expect.arrayContaining([
        expect.objectContaining({ source_system: "mesh", current_record_count: 1 }),
        expect.objectContaining({ source_system: "icloud", current_record_count: 1 }),
      ]),
    });
  });
});
