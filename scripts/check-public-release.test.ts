import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const checker = resolve(import.meta.dir, "check-public-release.ts");

// Fixtures contain a "~" that is stripped at run time, so this file's own
// source never contains the strings the release check forbids.
const j = (value: string): string => value.replaceAll("~", "");

function scan(text: string): { status: number | null; stderr: string } {
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

describe("--scan-export private-value patterns", () => {
  const forbidden: Array<[string, string]> = [
    ["factory task id", j("G~S-C~K-OSS-EXAMPLE")],
    ["factory task id, lower case", j("g~s-c~k-oss")],
    ["factory task id with a digit, no dashes", j("G~SC~K1")],
    ["factory task id with underscores", j("G~S_C~K_2")],
    ["factory task id with spaces", j("g~s c~k 3")],
    ["factory task id with mixed separators", j("G~s-_ c~K - 9")],
    ["full cloud-agent id", j("b~c-3074cc92-bcd6-5e94-b006-1e1ce339f88e")],
    ["cloud-agent id short form", j("b~c-3074cc92")],
    ["cloud-agent id with underscore", j("b~c_3074cc92")],
    ["cloud-agent id upper case", j("B~C-3074CC92")],
    ["cloud-agent id with a longer hex run", j("b~c-3074cc92bcd6")],
    ["originating-agent name", j("gro~k-sh~ip")],
    ["originating-agent name, no separator", j("gro~ksh~ip")],
    ["originating-agent name, space", j("Gro~k Sh~ip")],
    ["originating-agent name, underscore", j("GRO~K_SH~IP")],
    ["machine path (home)", j("/ho~me/bo~x/repo")],
    ["machine path (workspace)", j("/work~space/project/file.ts")],
    ["machine path (agent data)", j("agent~-data/store")],
    ["Google OAuth client secret", j("GOCS~PX-abcdefghijklmnopqrstuvwx_-12")],
    ["bearer token", j("Bea~rer abcdefghijklmnopqrstuvwxyz0123456789")],
    ["bearer token with extra spaces", j("Bea~rer   abcdefghijklmnopqrstuvwx.yz")],
  ];

  test.each(forbidden)("flags %s", (_name, value) => {
    const result = scan(`note: ${value}\n`);
    expect(result.status).toBe(1);
  });

  const allowed: Array<[string, string]> = [
    ["a word ending in bc followed by hex", "abc-12345678"],
    ["a short bc- suffix", "bc-12"],
    ["grok as an ordinary word", "grokking the codebase, then a ship date"],
    ["a short bearer value", "Authorization: Bearer abc"],
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
