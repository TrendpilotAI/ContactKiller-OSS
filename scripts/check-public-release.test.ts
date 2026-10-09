import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const checker = resolve(import.meta.dir, "check-public-release.ts");

// Fixtures contain a "~" that is stripped at run time, so this file's own
// source never contains the strings the release check forbids.
const j = (value: string): string => value.replaceAll("~", "");

type Result = { status: number | null; stderr: string };

/** Ticket-data mode: `--scan-export <file>`. */
function scanExport(text: string): Result {
  const dir = mkdtempSync(join(tmpdir(), "release-scan-"));
  try {
    const file = join(dir, "sample.txt");
    writeFileSync(file, text);
    const result = spawnSync("bun", [checker, "--scan-export", file], { encoding: "utf8" });
    return { status: result.status, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Ordinary release-file mode: a tiny repo whose manifest allowlists the sample file. */
function scanReleaseFile(text: string): Result {
  const dir = mkdtempSync(join(tmpdir(), "release-tree-"));
  try {
    mkdirSync(join(dir, "scripts"));
    copyFileSync(checker, join(dir, "scripts/check-public-release.ts"));
    writeFileSync(join(dir, "sample.txt"), text);
    writeFileSync(
      join(dir, "PUBLIC_RELEASE_MANIFEST.json"),
      JSON.stringify({
        schemaVersion: 3,
        allowedFiles: ["PUBLIC_RELEASE_MANIFEST.json", "sample.txt", "scripts/check-public-release.ts"],
        reviewedBinaryDigests: {},
        requiredBinarySidecars: {},
        forbiddenPrefixes: [],
        forbiddenExtensions: [],
        allowedEmailDomains: ["example.com"],
        maxFileSizeBytes: 2000000,
        requiredVcardMarker: "X-CONTACTKILLER-SYNTHETIC:TRUE",
      }),
    );
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const result = spawnSync("bun", [join(dir, "scripts/check-public-release.ts")], { cwd: dir, encoding: "utf8" });
    return { status: result.status, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const modes: Array<[string, (text: string) => Result]> = [
  ["ticket data (--scan-export)", scanExport],
  ["release file", scanReleaseFile],
];

describe.each(modes)("private-value patterns in %s", (_mode, scan) => {
  const forbidden: Array<[string, string]> = [
    ["factory task id", j("G~S-C~K-OSS-EXAMPLE")],
    ["factory task id, lower case", j("g~s-c~k-oss")],
    ["factory task id with a digit, no dashes", j("G~SC~K1")],
    ["factory task id with underscores", j("G~S_C~K_2")],
    ["factory task id with spaces", j("g~s c~k 3")],
    ["full cloud-agent id", j("b~c-3074cc92-bcd6-5e94-b006-1e1ce339f88e")],
    ["cloud-agent id short form", j("b~c-3074cc92")],
    ["cloud-agent id with underscore", j("b~c_3074cc92")],
    ["cloud-agent id with a longer hex run", j("b~c-3074cc92bcd6")],
    ["originating-agent name", j("gro~k-sh~ip")],
    ["originating-agent name, no separator", j("gro~ksh~ip")],
    ["originating-agent name, space", j("Gro~k Sh~ip")],
    ["originating-agent name, underscore", j("GRO~K_SH~IP")],
    ["machine path (home)", j("/ho~me/bo~x/repo")],
    ["Google OAuth client secret", j("GOCS~PX-abcdefghijklmnopqrstuvwx_-12")],
    ["bearer token", j("Bea~rer abcdefghijklmnopqrstuvwxyz0123456789")],
    ["bearer token with extra spaces", j("Bea~rer   abcdefghijklmnopqrstuvwx.yz")],
  ];

  test.each(forbidden)("flags %s", (_name, value) => {
    expect(scan(`note: ${value}\n`).status).toBe(1);
  });

  const allowed: Array<[string, string]> = [
    // This repo's own ticket ids after words that end in "gs".
    ["a ticket id after 'findings'", "findings ck-335"],
    ["a ticket id in parentheses after 'settings'", "settings (ck-85a)"],
    ["a ticket id after 'tags'", "tags ck-8u3, tags: ck-00w"],
    ["a ticket id after 'rings'", "rings: ck-e1a and timings ck-aa6"],
    ["a ticket id after 'logs'", "logs ck-335"],
    ["a word ending in bc followed by hex", "abc-12345678"],
    ["a short bc- suffix", "bc-12"],
    ["upper-case BC with a space and digits", "BC 12345678"],
    ["grok as an ordinary word", "grokking the codebase, then a ship date"],
    ["a short bearer value", "Authorization: Bearer abc"],
    ["bearer as an ordinary word", "Bearer authentication headers"],
    ["a templated bearer header", "Authorization: Bearer ${TOKEN}"],
    ["a short OAuth-looking prefix", "GOCSPX-short"],
    ["a relative workspace word", "the workspace/ folder name without a leading slash"],
    ["factory-looking letters without a digit or dash", "GS and CK are letters"],
  ];

  test.each(allowed)("does not flag %s", (_name, value) => {
    const result = scan(`note: ${value}\n`);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("scope: ticket data is stricter than release files", () => {
  const onlyInTicketData: Array<[string, string]> = [
    ["a workspace-root path (Dockerfile style)", j("WORKDIR /work~space/app")],
    ["an agent data path", j("agent~-data/store")],
    ["a bearer value containing a slash", j("Bea~rer abcdefghij/klmnopqrstuvwxyz")],
  ];

  test.each(onlyInTicketData)("%s is flagged in ticket data but not in a release file", (_name, value) => {
    expect(scanExport(`note: ${value}\n`).status).toBe(1);
    const release = scanReleaseFile(`note: ${value}\n`);
    expect(release.stderr).toBe("");
    expect(release.status).toBe(0);
  });
});
