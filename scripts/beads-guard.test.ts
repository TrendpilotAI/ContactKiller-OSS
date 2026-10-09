import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(120_000);

const guard = resolve(import.meta.dir, "beads-guard.sh");
const hasTool = (tool: string): boolean => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const hasBd = hasTool("bd") && hasTool("jq");
const hasDolt = hasBd && hasTool("dolt");

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
      expect(listing.stderr).toContain("record counts differ");
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

describe.skipIf(!hasDolt)("beads-guard.sh with config-table rows and directory.labels", () => {
  function workspace(dir: string): { ws: string; env: NodeJS.ProcessEnv } {
    const env = {
      ...process.env,
      HOME: dir,
      DO_NOT_TRACK: "1",
      BD_NON_INTERACTIVE: "1",
      BEADS_ACTOR: "tester",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const ws = join(dir, "ws");
    mkdirSync(ws);
    const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: ws, env, stdio: "pipe" });
    run("git", ["init", "-q"]);
    run("git", ["config", "user.email", "owner@example.com"]);
    run("git", ["config", "user.name", "t"]);
    run("bd", ["init", "--non-interactive", "--prefix", "t", "--skip-hooks", "--skip-agents"]);
    for (const title of ["one", "two", "three"]) run("bd", ["create", "--title", title, "--description", "d", "--silent"]);
    return { ws, env };
  }

  /** Writes a row straight into the Dolt config table, the way a pushed database could carry one. */
  function configTableRow(ws: string, env: NodeJS.ProcessEnv, key: string, value: string): void {
    execFileSync("dolt", ["sql", "-q", `INSERT INTO config (\`key\`, value) VALUES ('${key}', '${value}')`], {
      cwd: join(ws, ".beads/embeddeddolt/t"),
      env,
      stdio: "pipe",
    });
  }

  const guardRun = (ws: string, env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(guard, args, { cwd: ws, env, encoding: "utf8" });
  const exportTo = (ws: string, env: NodeJS.ProcessEnv, file: string): string => {
    const result = spawnSync("bd", ["export", "--all", "-o", file], { cwd: ws, env, encoding: "utf8" });
    expect(result.status).toBe(0);
    return readFileSync(file, "utf8").trim();
  };

  test("a config-table exclusion is invisible to `bd config get`, empties the export, and fails both guards", () => {
    withTempDir((dir) => {
      const { ws, env } = workspace(dir);
      configTableRow(ws, env, "export.exclude_owners", "tester");

      const get = spawnSync("bd", ["config", "get", "export.exclude_owners"], { cwd: ws, env, encoding: "utf8" });
      expect(get.stdout).toContain("not set");

      const file = join(dir, "export.jsonl");
      expect(exportTo(ws, env, file)).toBe("");

      const config = guardRun(ws, env, "config");
      expect(config.status).toBe(1);
      expect(config.stderr).toContain("Dolt config table");
      expect(config.stderr).toContain("export.exclude_owners");

      expect(guardRun(ws, env, "listing", file).status).toBe(1);
    });
  });

  test("a directory.labels filter fails the config guard, and the listing guard ignores it", () => {
    withTempDir((dir) => {
      const { ws, env } = workspace(dir);
      appendFileSync(join(ws, ".beads/config.yaml"), "\ndirectory:\n    labels:\n        ws: nothing-has-this\n");

      const config = guardRun(ws, env, "config");
      expect(config.status).toBe(1);
      expect(config.stderr).toContain("directory label filter");

      // `bd config get` cannot see the map, and a bare `bd list` is silently filtered; the
      // guard's listing (--skip-labels) is not, so a healthy export still matches it.
      const get = spawnSync("bd", ["config", "get", "directory.labels"], { cwd: ws, env, encoding: "utf8" });
      expect(get.stdout).toContain("not set");
      const bare = spawnSync("bd", ["list", "--all", "--json"], { cwd: ws, env, encoding: "utf8" });
      expect(JSON.parse(bare.stdout)).toHaveLength(0);
      const file = join(dir, "export.jsonl");
      exportTo(ws, env, file);
      expect(guardRun(ws, env, "listing", file).status).toBe(0);
    });
  });

  test("the combination (config-table exclusion plus directory.labels) is caught by both guards", () => {
    withTempDir((dir) => {
      const { ws, env } = workspace(dir);
      configTableRow(ws, env, "export.exclude_owners", "tester");
      appendFileSync(join(ws, ".beads/config.yaml"), "\ndirectory:\n    labels:\n        ws: nothing-has-this\n");

      const file = join(dir, "export.jsonl");
      expect(exportTo(ws, env, file)).toBe("");
      expect(guardRun(ws, env, "config").status).toBe(1);
      const listing = guardRun(ws, env, "listing", file);
      expect(listing.status).toBe(1);
      expect(listing.stderr).toContain("record counts differ");
    });
  });

  test("any directory.label* or export.exclude_owner* key in the config table is rejected, whatever its value", () => {
    withTempDir((dir) => {
      const { ws, env } = workspace(dir);
      configTableRow(ws, env, "directory.labels", "");
      const result = guardRun(ws, env, "config");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("directory.labels");
    });
  });
});

describe("beads-guard.sh listing with a stubbed bd", () => {
  function shim(dir: string, listOutput: string): NodeJS.ProcessEnv {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "list.json"), listOutput);
    writeFileSync(join(dir, "bin/bd"), '#!/usr/bin/env bash\nif [ "$1" = list ]; then cat "$LIST_JSON"; fi\n');
    chmodSync(join(dir, "bin/bd"), 0o755);
    return { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, LIST_JSON: join(dir, "list.json") };
  }
  const row = (id: string, updated = "2026-01-01T00:00:00Z") => ({ id, status: "open", updated_at: updated });
  const envelope = (issues: unknown[]) => JSON.stringify({ issues, meta: { count: issues.length }, schema_version: 1 });
  const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const run = (env: NodeJS.ProcessEnv, file: string) => spawnSync(guard, ["listing", file], { env, encoding: "utf8" });

  test("matching envelope and export pass", () => {
    withTempDir((dir) => {
      const env = shim(dir, envelope([row("a"), row("b")]));
      writeFileSync(join(dir, "export.jsonl"), jsonl([row("b"), row("a")]));
      expect(run(env, join(dir, "export.jsonl")).status).toBe(0);
    });
  });

  test("a bare array (unexpected shape) fails closed", () => {
    withTempDir((dir) => {
      const env = shim(dir, JSON.stringify([row("a")]));
      writeFileSync(join(dir, "export.jsonl"), jsonl([row("a")]));
      const result = run(env, join(dir, "export.jsonl"));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unexpected 'bd list --json' shape");
    });
  });

  test("an envelope without meta or schema_version fails closed", () => {
    withTempDir((dir) => {
      const env = shim(dir, JSON.stringify({ issues: [row("a")] }));
      writeFileSync(join(dir, "export.jsonl"), jsonl([row("a")]));
      expect(run(env, join(dir, "export.jsonl")).status).toBe(1);
    });
  });

  test("duplicates on either side fail even when the de-duplicated sets agree", () => {
    withTempDir((dir) => {
      const file = join(dir, "export.jsonl");
      writeFileSync(file, jsonl([row("a")]));
      const dupListed = run(shim(join(dir), envelope([row("a"), row("a")])), file);
      expect(dupListed.status).toBe(1);
      expect(dupListed.stderr).toContain("record counts differ");
    });
    withTempDir((dir) => {
      const env = shim(dir, envelope([row("a"), row("b")]));
      writeFileSync(join(dir, "export.jsonl"), jsonl([row("a"), row("a")]));
      const dupExported = run(env, join(dir, "export.jsonl"));
      expect(dupExported.status).toBe(1);
    });
    withTempDir((dir) => {
      const env = shim(dir, envelope([row("a"), row("a")]));
      writeFileSync(join(dir, "export.jsonl"), jsonl([row("a"), row("a")]));
      const bothDup = run(env, join(dir, "export.jsonl"));
      expect(bothDup.status).toBe(1);
      expect(bothDup.stderr).toContain("duplicate ids");
    });
  });

  test("same ids but a different record (status or updated_at) fails", () => {
    withTempDir((dir) => {
      const env = shim(dir, envelope([row("a", "2026-01-01T00:00:00Z")]));
      writeFileSync(join(dir, "export.jsonl"), jsonl([row("a", "2026-02-02T00:00:00Z")]));
      const result = run(env, join(dir, "export.jsonl"));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("does not hold exactly the records");
    });
  });
});
