import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const guard = resolve(import.meta.dir, "beads-guard.sh");
const hasTool = (tool: string): boolean => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const hasBd = hasTool("bd") && hasTool("jq");

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "beads-guard-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("beads-guard.sh no-allow", () => {
  const run = (dir: string) => spawnSync(guard, ["no-allow", dir], { encoding: "utf8" });
  // Assembled so this file does not itself contain the allow marker.
  const marker = ["gitleaks", "allow"].join(":");

  test("passes on clean files and fails when any file contains the marker", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "a.jsonl"), '{"id":"x"}\n');
      expect(run(dir).status).toBe(0);
      mkdirSync(join(dir, "nested"));
      writeFileSync(join(dir, "nested/b.json"), `[{"note":"# ${marker}"}]\n`);
      const result = run(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("allow comment");
    });
  });

  test("treats a grep error (missing directory) as a failure, not a pass", () => {
    const result = run("/nonexistent-beads-guard-dir");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("grep failed");
  });
});

describe.skipIf(!hasBd)("beads-guard.sh with a real bd database", () => {
  function workspace(dir: string): NodeJS.ProcessEnv {
    const env = {
      ...process.env,
      HOME: dir,
      DO_NOT_TRACK: "1",
      BD_NON_INTERACTIVE: "1",
      BEADS_ACTOR: "tester",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "owner@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "owner@example.com",
    };
    const ws = join(dir, "ws");
    mkdirSync(ws);
    execFileSync("git", ["init", "-q"], { cwd: ws, env });
    execFileSync("git", ["config", "user.email", "owner@example.com"], { cwd: ws, env });
    execFileSync("git", ["config", "user.name", "t"], { cwd: ws, env });
    execFileSync("bd", ["init", "--non-interactive", "--prefix", "t", "--skip-hooks", "--skip-agents"], { cwd: ws, env, stdio: "pipe" });
    execFileSync("bd", ["create", "--title", "one", "--description", "d", "--silent"], { cwd: ws, env, stdio: "pipe" });
    execFileSync("bd", ["create", "--title", "two", "--description", "d", "--silent"], { cwd: ws, env, stdio: "pipe" });
    return env;
  }

  const bd = (ws: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
    spawnSync("bd", args, { cwd: ws, env, encoding: "utf8" });
  const g = (ws: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
    spawnSync(guard, args, { cwd: ws, env, encoding: "utf8" });

  function exportAll(ws: string, env: NodeJS.ProcessEnv, file: string): void {
    const result = bd(ws, env, "export", "--all", "-o", file);
    expect(result.status).toBe(0);
  }

  test("an unconfigured workspace passes both guards", () => {
    withTempDir((dir) => {
      const env = workspace(dir);
      const ws = join(dir, "ws");
      expect(g(ws, env, "config").status).toBe(0);
      const file = join(dir, "export.jsonl");
      exportAll(ws, env, file);
      expect(g(ws, env, "listing", file).status).toBe(0);
    });
  });

  const forms: Array<[string, string]> = [
    ["nested plural", "set-nested-plural"],
    ["nested singular", "set-nested-singular"],
    ["dotted plural", "dotted-plural"],
    ["dotted singular", "dotted-singular"],
  ];

  test.each(forms)("an owner exclusion set as %s fails the config guard and the listing guard", (_name, form) => {
    withTempDir((dir) => {
      const env = workspace(dir);
      const ws = join(dir, "ws");
      const config = join(ws, ".beads/config.yaml");
      const key = form.includes("singular") ? "exclude_owner" : "exclude_owners";
      if (form.startsWith("set-nested")) {
        expect(bd(ws, env, "config", "set", `export.${key}`, "tester").status).toBe(0);
        expect(readFileSync(config, "utf8")).toMatch(new RegExp(`export:\\s*\\n(?:\\s+.*\\n)*?\\s+${key}:`));
      } else {
        appendFileSync(config, `\nexport.${key}: tester\n`);
      }

      const configResult = g(ws, env, "config");
      expect(configResult.status).toBe(1);
      expect(configResult.stderr).toContain(`export.${key} is set`);

      // The exclusion really does empty the export while bd still lists the tickets.
      const file = join(dir, "export.jsonl");
      exportAll(ws, env, file);
      expect(readFileSync(file, "utf8").trim()).toBe("");
      expect(bd(ws, env, "list", "--all", "--json").stdout).toContain('"id"');
      const listing = g(ws, env, "listing", file);
      expect(listing.status).toBe(1);
      expect(listing.stderr).toContain("listed but not exported");
    });
  });

  test("the environment variable form is caught by the config guard", () => {
    withTempDir((dir) => {
      const env = workspace(dir);
      const ws = join(dir, "ws");
      const result = g(ws, { ...env, BD_EXPORT_EXCLUDE_OWNERS: "tester" }, "config");
      expect(result.status).toBe(1);
    });
  });

  test("a partial export fails the listing guard", () => {
    withTempDir((dir) => {
      const env = workspace(dir);
      const ws = join(dir, "ws");
      const file = join(dir, "export.jsonl");
      exportAll(ws, env, file);
      const [first] = readFileSync(file, "utf8").trim().split("\n");
      writeFileSync(file, `${first}\n`);
      expect(g(ws, env, "listing", file).status).toBe(1);
    });
  });
});
