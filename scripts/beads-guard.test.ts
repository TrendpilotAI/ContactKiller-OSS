import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addLocalFileRemote, assertNoRealRemote, hasTool, initWorkspace, isolatedEnv, sql, type Workspace } from "./beads-test-support";

setDefaultTimeout(180_000);

const guard = resolve(import.meta.dir, "beads-guard.sh");
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

/** Runs the guard in a workspace, after re-checking that no real remote exists. */
function g(workspace: Workspace, env: NodeJS.ProcessEnv, ...args: string[]) {
  assertNoRealRemote(workspace.ws, workspace.env);
  return spawnSync(guard, args, { cwd: workspace.ws, env, encoding: "utf8" });
}

const bd = (workspace: Workspace, ...args: string[]) =>
  spawnSync("bd", args, { cwd: workspace.ws, env: workspace.env, encoding: "utf8" });

describe("test support: assertNoRealRemote is an allowlist", () => {
  function repoWithRemote(dir: string, url?: string): { ws: string; env: NodeJS.ProcessEnv } {
    const env = isolatedEnv(dir);
    const ws = join(dir, "ws");
    mkdirSync(ws);
    execFileSync("git", ["init", "-q"], { cwd: ws, env });
    if (url) execFileSync("git", ["remote", "add", "origin", url], { cwd: ws, env });
    return { ws, env };
  }

  test("a workspace with no remote passes", () => {
    withTempDir((dir) => {
      const { ws, env } = repoWithRemote(dir);
      expect(() => assertNoRealRemote(ws, env)).not.toThrow();
    });
  });

  test.each(["file:///tmp/somewhere.git", "git+file:///tmp/somewhere.git"])("the local file remote %s passes", (url) => {
    withTempDir((dir) => {
      const { ws, env } = repoWithRemote(dir, url);
      expect(() => assertNoRealRemote(ws, env)).not.toThrow();
    });
  });

  test.each([
    "https://github.com/Example/Repo",
    "git+https://github.com/Example/Repo",
    "ssh://git@example.com/repo.git",
    "git@example.com:Example/Repo.git",
    "aws://[bucket]/prefix",
    "gs://bucket/prefix",
    "oci://tenancy/bucket/prefix",
    "/tmp/a-plain-local-path.git",
    "something-unknown://host/repo",
  ])("the remote %s is refused", (url) => {
    withTempDir((dir) => {
      const { ws, env } = repoWithRemote(dir, url);
      expect(() => assertNoRealRemote(ws, env)).toThrow("non-local remote");
    });
  });

  test("fails instead of passing when git cannot be run", () => {
    withTempDir((dir) => {
      const { ws, env } = repoWithRemote(dir);
      expect(() => assertNoRealRemote(ws, { ...env, PATH: "/nonexistent" })).toThrow("cannot check remotes");
    });
  });

  test.skipIf(!hasBd)("fails instead of passing when bd cannot be run in a bd workspace", () => {
    withTempDir((dir) => {
      const { ws, env } = repoWithRemote(dir);
      mkdirSync(join(ws, ".beads"));
      const gitDir = spawnSync("sh", ["-c", "dirname $(command -v git)"], { encoding: "utf8" }).stdout.trim();
      expect(() => assertNoRealRemote(ws, { ...env, PATH: gitDir === "/usr/bin" ? "/usr/bin" : gitDir })).toThrow();
    });
  });
});

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
  function exportAll(w: Workspace, file: string): string {
    const result = bd(w, "export", "--all", "-o", file);
    expect(result.status).toBe(0);
    return readFileSync(file, "utf8").trim();
  }

  test("an unconfigured workspace passes both guards", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir);
      expect(g(w, w.env, "config").status).toBe(0);
      const file = join(dir, "export.jsonl");
      exportAll(w, file);
      expect(g(w, w.env, "listing", file).status).toBe(0);
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
      const w = initWorkspace(dir);
      const config = join(w.ws, ".beads/config.yaml");
      const key = form.includes("singular") ? "exclude_owner" : "exclude_owners";
      if (form.startsWith("set-nested")) {
        expect(bd(w, "config", "set", `export.${key}`, "tester").status).toBe(0);
        expect(readFileSync(config, "utf8")).toMatch(new RegExp(`export:\\s*\\n(?:\\s+.*\\n)*?\\s+${key}:`));
      } else {
        appendFileSync(config, `\nexport.${key}: tester\n`);
      }

      const configResult = g(w, w.env, "config");
      expect(configResult.status).toBe(1);
      expect(configResult.stderr).toContain(`export.${key} is set`);

      // The exclusion really does empty the export while bd still lists the tickets.
      const file = join(dir, "export.jsonl");
      expect(exportAll(w, file)).toBe("");
      expect(bd(w, "list", "--all", "--json").stdout).toContain('"id"');
      const listing = g(w, w.env, "listing", file);
      expect(listing.status).toBe(1);
      expect(listing.stderr).toContain("record counts differ");
    });
  });

  test("the environment variable form is caught by the config guard", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir);
      expect(g(w, { ...w.env, BD_EXPORT_EXCLUDE_OWNERS: "tester" }, "config").status).toBe(1);
    });
  });

  test("a partial export fails the listing guard", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir);
      const file = join(dir, "export.jsonl");
      exportAll(w, file);
      const [first] = readFileSync(file, "utf8").trim().split("\n");
      writeFileSync(file, `${first}\n`);
      expect(g(w, w.env, "listing", file).status).toBe(1);
    });
  });
});

describe.skipIf(!hasDolt)("beads-guard.sh with config-table rows and directory.labels", () => {
  const exportTo = (w: Workspace, file: string): string => {
    expect(bd(w, "export", "--all", "-o", file).status).toBe(0);
    return readFileSync(file, "utf8").trim();
  };

  test("a config-table exclusion is invisible to `bd config get`, empties the export, and fails both guards", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 3);
      sql(w, "INSERT INTO config (`key`, value) VALUES ('export.exclude_owners', 'tester')");

      expect(bd(w, "config", "get", "export.exclude_owners").stdout).toContain("not set");
      const file = join(dir, "export.jsonl");
      expect(exportTo(w, file)).toBe("");

      const config = g(w, w.env, "config");
      expect(config.status).toBe(1);
      expect(config.stderr).toContain("Dolt config table");
      expect(config.stderr).toContain("export.exclude_owners");
      expect(g(w, w.env, "listing", file).status).toBe(1);
    });
  });

  test("a directory.labels filter fails the config guard, and the listing guard ignores it", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 3);
      appendFileSync(join(w.ws, ".beads/config.yaml"), "\ndirectory:\n    labels:\n        ws: nothing-has-this\n");

      const config = g(w, w.env, "config");
      expect(config.status).toBe(1);
      expect(config.stderr).toContain("directory label filter");

      // `bd config get` cannot see the map, and a bare `bd list` is silently filtered; the
      // guard's listing (--skip-labels) is not, so a healthy export still matches it.
      expect(bd(w, "config", "get", "directory.labels").stdout).toContain("not set");
      expect(JSON.parse(bd(w, "list", "--all", "--json").stdout)).toHaveLength(0);
      const file = join(dir, "export.jsonl");
      exportTo(w, file);
      expect(g(w, w.env, "listing", file).status).toBe(0);
    });
  });

  test("the combination (config-table exclusion plus directory.labels) is caught by both guards", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 3);
      sql(w, "INSERT INTO config (`key`, value) VALUES ('export.exclude_owners', 'tester')");
      appendFileSync(join(w.ws, ".beads/config.yaml"), "\ndirectory:\n    labels:\n        ws: nothing-has-this\n");

      const file = join(dir, "export.jsonl");
      expect(exportTo(w, file)).toBe("");
      expect(g(w, w.env, "config").status).toBe(1);
      const listing = g(w, w.env, "listing", file);
      expect(listing.status).toBe(1);
      expect(listing.stderr).toContain("record counts differ");
    });
  });

  test("any directory.label* or export.exclude_owner* key in the config table is rejected, whatever its value", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir);
      sql(w, "INSERT INTO config (`key`, value) VALUES ('directory.labels', '')");
      const result = g(w, w.env, "config");
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
      const dupListed = run(shim(dir, envelope([row("a"), row("a")])), file);
      expect(dupListed.status).toBe(1);
      expect(dupListed.stderr).toContain("record counts differ");
    });
    withTempDir((dir) => {
      const env = shim(dir, envelope([row("a"), row("b")]));
      writeFileSync(join(dir, "export.jsonl"), jsonl([row("a"), row("a")]));
      expect(run(env, join(dir, "export.jsonl")).status).toBe(1);
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

describe.skipIf(!hasBd)("beads-guard.sh refuses dolt.auto-push from every source", () => {
  // These workspaces have no Dolt remote at all, so even a successful "enable"
  // can never push anywhere (and the helper refuses to run if one ever appears).
  test("an unconfigured workspace passes", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 0);
      expect(g(w, w.env, "autopush-files").status).toBe(0);
      expect(g(w, w.env, "config").status).toBe(0);
    });
  });

  test("enabled in the committed config.yaml fails, and so does any mention of it", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 0);
      const config = join(w.ws, ".beads/config.yaml");
      const original = readFileSync(config, "utf8");

      expect(bd(w, "config", "set", "dolt.auto-push", "true").status).toBe(0);
      for (const subcommand of ["autopush-files", "config"]) {
        const result = g(w, w.env, subcommand);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("dolt.auto-push");
      }

      // Even an explicit false must not be committed.
      writeFileSync(config, `${original}\ndolt:\n    auto-push: false\n`);
      const mention = g(w, w.env, "autopush-files");
      expect(mention.status).toBe(1);
      expect(mention.stderr).toContain("must not set it");
    });
  });

  test.each([
    ["config.local.yaml, nested", "dolt:\n    auto-push: true\n"],
    ["config.local.yaml, dotted", "dolt.auto-push: true\n"],
  ])("enabled in %s fails, while an explicit false there passes", (_name, content) => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 0);
      const local = join(w.ws, ".beads/config.local.yaml");
      writeFileSync(local, content);
      const bad = g(w, w.env, "autopush-files");
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("dolt.auto-push is enabled");

      writeFileSync(local, content.replace("true", "false"));
      expect(g(w, w.env, "autopush-files").status).toBe(0);
    });
  });

  test("enabled through BD_DOLT_AUTO_PUSH fails, false passes", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 0);
      expect(g(w, { ...w.env, BD_DOLT_AUTO_PUSH: "true" }, "autopush-files").status).toBe(1);
      expect(g(w, { ...w.env, BD_DOLT_AUTO_PUSH: "false" }, "autopush-files").status).toBe(0);
    });
  });
});

describe.skipIf(!hasDolt)("beads-guard.sh refuses dolt.auto-push in the Dolt config table", () => {
  test("a config-table row enables it invisibly to `bd config get`, and the config guard still fails", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 0);
      sql(w, "INSERT INTO config (`key`, value) VALUES ('dolt.auto-push', 'true')");

      expect(bd(w, "config", "get", "dolt.auto-push").stdout).toContain("not set");
      expect(g(w, w.env, "autopush-files").status).toBe(0);
      const result = g(w, w.env, "config");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Dolt config table enables dolt.auto-push");
    });
  });
});

describe.skipIf(!hasDolt)("beads-guard.sh synced-tables", () => {
  const run = (w: Workspace, out: string) => g(w, w.env, "synced-tables", out);

  test("bd kv values are in the dumped raw config table even though `bd config list` hides them", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      expect(bd(w, "kv", "set", "probe", "hello-from-kv").status).toBe(0);
      expect(bd(w, "config", "list", "--json").stdout).not.toContain("hello-from-kv");
      const out = join(dir, "scan");
      mkdirSync(out);
      expect(run(w, out).status).toBe(0);
      expect(readFileSync(join(out, "synced-tables/config.json"), "utf8")).toContain("hello-from-kv");
    });
  });

  test("a normal workspace passes and its tables are dumped for scanning", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      const out = join(dir, "scan");
      mkdirSync(out);
      expect(run(w, out).status).toBe(0);
      for (const table of ["metadata", "config", "child_counters", "issue_counter", "schema_migrations"]) {
        expect(() => readFileSync(join(out, "synced-tables", `${table}.json`), "utf8")).not.toThrow();
      }
    });
  });

  test.each([
    ["custom_types", "INSERT INTO custom_types (name) VALUES ('secret-type')"],
    ["custom_statuses", "INSERT INTO custom_statuses (name) VALUES ('secret-status')"],
    ["routes", "INSERT INTO routes (prefix, path) VALUES ('x', '/somewhere')"],
  ])("rows in %s fail the guard", (table, insert) => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      sql(w, insert);
      const out = join(dir, "scan");
      mkdirSync(out);
      const result = run(w, out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`synced table ${table} holds`);
    });
  });

  test("a provenance_events row fails (the table must stay empty)", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      const [issue] = JSON.parse(bd(w, "list", "--all", "--json").stdout) as Array<{ id: string }>;
      expect(bd(w, "provenance", "record", "--issue", issue!.id, "--kind", "used", "--source", "test", "--at", "2026-01-01T00:00:00Z").status).toBe(0);
      const out = join(dir, "scan");
      mkdirSync(out);
      const result = run(w, out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("synced table provenance_events holds 1 row");
    });
  });

  test("an unknown table fails the allowlist", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      sql(w, "CREATE TABLE sneaky_notes (id INT PRIMARY KEY, note TEXT)");
      const out = join(dir, "scan");
      mkdirSync(out);
      const result = run(w, out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not on the known list");
      expect(result.stderr).toContain("sneaky_notes");
    });
  });

  test("a changed dolt_ignore set fails", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      sql(w, "INSERT INTO dolt_ignore (pattern, ignored) VALUES ('anything', 1)");
      const out = join(dir, "scan");
      mkdirSync(out);
      const result = run(w, out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dolt_ignore rows changed");
    });
  });

  test("an unexpected metadata key fails", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      sql(w, "INSERT INTO metadata (`key`, value) VALUES ('note_to_self', 'hello')");
      const out = join(dir, "scan");
      mkdirSync(out);
      const result = run(w, out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("note_to_self");
    });
  });

  test.each([
    ["a name with a space (two allowlisted names)", "issues labels"],
    ["a name with a space and one unknown word", "issues extra"],
    ["a name with a newline", "issues\nlabels"],
    ["an upper-case name", "Issues"],
    ["a name with a digit", "issues2"],
    ["a name with a hyphen", "issues-labels"],
  ])("a table named %p is rejected, not substring-matched against the allowlist", (_name, tableName) => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      // Dolt accepts these as quoted identifiers, which is how a hostile database could carry one.
      sql(w, `CREATE TABLE \`${tableName}\` (id INT PRIMARY KEY, note TEXT)`);
      const out = join(dir, "scan");
      mkdirSync(out);
      const result = run(w, out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("the Dolt store");
      expect(result.stderr).toMatch(/not plain identifiers|not on the known list/);
    });
  });

  test("an added un-ignore override row in dolt_ignore fails, not just a changed ignored=1 set", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      sql(w, "INSERT INTO dolt_ignore (pattern, ignored) VALUES ('wisp_comments', 0)");
      const out = join(dir, "scan");
      mkdirSync(out);
      const result = run(w, out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dolt_ignore rows changed");
    });
  });

  test("the current view definitions (dolt_schemas) are dumped for scanning", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      const out = join(dir, "scan");
      mkdirSync(out);
      expect(run(w, out).status).toBe(0);
      expect(readFileSync(join(out, "synced-tables/dolt_schemas.json"), "utf8")).toContain("CREATE");
    });
  });

  test("fails closed when the dolt CLI is not on PATH", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      const noDolt = {
        ...w.env,
        PATH: (w.env.PATH ?? "").split(":").filter((entry) => spawnSync("sh", ["-c", `[ -x "${entry}/dolt" ]`]).status !== 0).join(":"),
      };
      const out = join(dir, "scan");
      mkdirSync(out);
      const result = g(w, noDolt, "synced-tables", out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dolt CLI is required");
    });
  });
});

describe.skipIf(!hasDolt)("beads-guard.sh history (commits after a trusted base)", () => {
  const head = (w: Workspace): string => JSON.parse(bd(w, "vc", "status", "--json").stdout).commit as string;
  const history = (w: Workspace, base: string, out: string) => g(w, w.env, "history", base, out);
  const commit = (w: Workspace, message: string) => sql(w, `CALL DOLT_COMMIT('-Am', '${message}')`);
  // Assembled at run time so this file never contains a private-looking id.
  const privateId = ["bc", "-", "3074cc92"].join("");

  test("benign new commits pass and are dumped; the dump includes commit messages and row diffs", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      const base = head(w);
      expect(bd(w, "create", "--title", "later", "--description", "fine", "--silent").status).toBe(0);
      const out = join(dir, "out");
      mkdirSync(out);
      const result = history(w, base, out);
      expect(result.status).toBe(0);
      expect(readFileSync(join(out, "history/commits.json"), "utf8")).toContain("create issue");
      expect(readFileSync(join(out, "history/diff_issues.json"), "utf8")).toContain("later");
    });
  });

  test("a forbidden config key set and later unset is refused even though the final state is clean", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      const base = head(w);
      sql(w, "INSERT INTO config (`key`, value) VALUES ('export.exclude_owners', 'tester')");
      commit(w, "set the key");
      sql(w, "DELETE FROM config WHERE `key` = 'export.exclude_owners'");
      commit(w, "unset the key");

      // The final state is clean: both current-state guards pass.
      expect(g(w, w.env, "config").status).toBe(0);
      const out = join(dir, "out");
      mkdirSync(out);
      const result = history(w, base, out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("export.exclude_owners");
      expect(result.stderr).toContain("even if unset again");
    });
  });

  test.each(["dolt.auto-push", "directory.labels", "Export.exclude_owner"])("a transient %s key is refused too", (key) => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 0);
      const base = head(w);
      sql(w, `INSERT INTO config (\`key\`, value) VALUES ('${key}', 'x')`);
      commit(w, "set");
      sql(w, `DELETE FROM config WHERE \`key\` = '${key}'`);
      commit(w, "unset");
      const out = join(dir, "out");
      mkdirSync(out);
      expect(history(w, base, out).status).toBe(1);
    });
  });

  test("a private id added and later removed is in the dump, so the scanner refuses it", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 0);
      const base = head(w);
      expect(bd(w, "create", "--title", "temp", "--description", `owner ${privateId}`, "--silent").status).toBe(0);
      const id = (JSON.parse(bd(w, "list", "--all", "--json").stdout) as Array<{ id: string }>)[0]!.id;
      expect(bd(w, "update", id, "--description", "cleaned").status).toBe(0);

      // The final state is clean...
      const final = join(dir, "final.jsonl");
      expect(bd(w, "export", "--all", "-o", final).status).toBe(0);
      expect(readFileSync(final, "utf8")).not.toContain(privateId);
      expect(spawnSync("bun", [resolve(import.meta.dir, "check-public-release.ts"), "--scan-export", final], { encoding: "utf8" }).status).toBe(0);

      // ...but the history dump holds the earlier version, and the scanner refuses it.
      const out = join(dir, "out");
      mkdirSync(out);
      expect(history(w, base, out).status).toBe(0);
      const dump = join(out, "history/diff_issues.json");
      expect(readFileSync(dump, "utf8")).toContain(privateId);
      const scan = spawnSync("bun", [resolve(import.meta.dir, "check-public-release.ts"), "--scan-export", dump], { encoding: "utf8" });
      expect(scan.status).toBe(1);
    });
  });

  test("a table outside the published set (for example an ignored one committed by force) is refused", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 0);
      const base = head(w);
      sql(w, "CREATE TABLE sneaky_notes (id INT PRIMARY KEY, note TEXT)");
      sql(w, "INSERT INTO sneaky_notes VALUES (1, 'x')");
      commit(w, "add a table");
      sql(w, "DROP TABLE sneaky_notes");
      commit(w, "drop it again");
      const out = join(dir, "out");
      mkdirSync(out);
      const result = history(w, base, out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("sneaky_notes");
    });
  });

  test.each([
    ["a space (two allowlisted names)", "issues labels"],
    ["a newline", "issues\nlabels"],
  ])("a table with %s in its name, committed in the range, is refused by the history scan", (_name, tableName) => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 0);
      const base = head(w);
      sql(w, `CREATE TABLE \`${tableName}\` (id INT PRIMARY KEY, note TEXT)`);
      sql(w, `INSERT INTO \`${tableName}\` VALUES (1, 'x')`);
      commit(w, "add an oddly named table");
      const out = join(dir, "out");
      mkdirSync(out);
      const result = history(w, base, out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not plain identifiers");
    });
  });

  test("net.diff is always written, and its content reaches the scanner (a private id only the net diff shows)", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 0);
      const base = head(w);
      const empty = join(dir, "empty");
      mkdirSync(empty);
      expect(history(w, base, empty).status).toBe(0);
      expect(readFileSync(join(empty, "history/net.diff"), "utf8")).toContain("no changes after");

      expect(bd(w, "create", "--title", "t", "--description", `owner ${privateId}`, "--silent").status).toBe(0);
      const out = join(dir, "out");
      mkdirSync(out);
      expect(history(w, base, out).status).toBe(0);
      const diff = join(out, "history/net.diff");
      expect(readFileSync(diff, "utf8")).toContain(privateId);
      const scan = spawnSync("bun", [resolve(import.meta.dir, "check-public-release.ts"), "--scan-export", diff], { encoding: "utf8" });
      expect(scan.status).toBe(1);
    });
  });

  test("a failing dolt diff fails the run instead of being ignored", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 0);
      const base = head(w);
      // A dolt shim that fails only for `dolt diff`; everything else is the real binary.
      const real = spawnSync("sh", ["-c", "command -v dolt"], { encoding: "utf8" }).stdout.trim();
      mkdirSync(join(dir, "shim"));
      writeFileSync(join(dir, "shim/dolt"), `#!/usr/bin/env bash\nif [ "$1" = diff ]; then echo "boom" >&2; exit 1; fi\nexec "${real}" "$@"\n`);
      chmodSync(join(dir, "shim/dolt"), 0o755);
      const out = join(dir, "out");
      mkdirSync(out);
      const result = g(w, { ...w.env, PATH: `${join(dir, "shim")}:${w.env.PATH}` }, "history", base, out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dolt diff");
    });
  });

  test("a failing dolt_schemas history query fails the run instead of falling back to empty rows", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 0);
      const base = head(w);
      // Change a view definition so dolt_schemas appears in the range.
      sql(w, "DROP VIEW ready_issues");
      sql(w, "CREATE VIEW ready_issues AS SELECT * FROM issues");
      commit(w, "change a view");
      const real = spawnSync("sh", ["-c", "command -v dolt"], { encoding: "utf8" }).stdout.trim();
      mkdirSync(join(dir, "shim"));
      writeFileSync(
        join(dir, "shim/dolt"),
        `#!/usr/bin/env bash\ncase "$*" in *dolt_diff_dolt_schemas*) echo "boom" >&2; exit 1 ;; esac\nexec "${real}" "$@"\n`,
      );
      chmodSync(join(dir, "shim/dolt"), 0o755);
      const out = join(dir, "out");
      mkdirSync(out);
      const result = g(w, { ...w.env, PATH: `${join(dir, "shim")}:${w.env.PATH}` }, "history", base, out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("could not read the history of table dolt_schemas");

      // Unshimmed, the changed view definition is dumped so its SQL gets scanned.
      expect(history(w, base, out).status).toBe(0);
      expect(readFileSync(join(out, "history/diff_dolt_schemas.json"), "utf8")).toContain("ready_issues");
    });
  });

  test("a base that is not an ancestor, or not a commit, fails closed", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 0);
      const out = join(dir, "out");
      mkdirSync(out);
      expect(history(w, "0".repeat(32), out).status).toBe(1);
      expect(history(w, "not-a-hash!", out).status).toBe(1);
    });
  });

  test("remote-base finds the remote head, and the unpushed commits after it are what gets scanned", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      addLocalFileRemote(dir, w);
      // The only remote here is a local file remote, so this real push cannot leave the machine.
      expect(bd(w, "dolt", "push", "--no-adopt").status).toBe(0);
      const published = head(w);

      const first = g(w, w.env, "remote-base");
      expect(first.status).toBe(0);
      expect(first.stdout.trim()).toBe(published);

      sql(w, "INSERT INTO config (`key`, value) VALUES ('export.exclude_owners', 'tester')");
      commit(w, "set");
      sql(w, "DELETE FROM config WHERE `key` = 'export.exclude_owners'");
      commit(w, "unset");

      const base = g(w, w.env, "remote-base").stdout.trim();
      expect(base).toBe(published);
      const out = join(dir, "out");
      mkdirSync(out);
      const result = history(w, base, out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("export.exclude_owners");
    });
  });

  test("remote-base prints ROOT when the remote has no Dolt data yet", () => {
    withTempDir((dir) => {
      const w = initWorkspace(dir, 1);
      addLocalFileRemote(dir, w);
      const result = g(w, w.env, "remote-base");
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("ROOT");
    });
  });
});

describe("beads-guard.sh gitleaks hardening", () => {
  function shimGitleaks(dir: string, versionOutput: string): NodeJS.ProcessEnv {
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin/gitleaks"),
      `#!/usr/bin/env bash
if [ "$1" = version ]; then echo "${versionOutput}"; exit 0; fi
echo "$@" > "${join(dir, "args.txt")}"
exit 0
`,
    );
    chmodSync(join(dir, "bin/gitleaks"), 0o755);
    return { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` };
  }

  test.each([
    ["8.30.1", 0],
    ["8.30.0", 0],
    ["8.29.9", 1],
    ["8.31.0", 1],
    ["9.0.0", 1],
    ["", 1],
  ])("gitleaks %p is accepted only for 8.30.x (exit %p)", (version, expected) => {
    withTempDir((dir) => {
      const env = shimGitleaks(dir, version);
      expect(spawnSync(guard, ["gitleaks-version"], { env, encoding: "utf8" }).status).toBe(expected);
    });
  });

  test("scans pass --ignore-gitleaks-allow and an empty ignore file, and drop config overrides", () => {
    withTempDir((dir) => {
      const env = { ...shimGitleaks(dir, "8.30.1"), GITLEAKS_CONFIG: "/tmp/evil.toml", GITLEAKS_CONFIG_TOML: "x" };
      mkdirSync(join(dir, "scan"));
      const result = spawnSync(guard, ["gitleaks", join(dir, "scan")], { env, encoding: "utf8" });
      expect(result.status).toBe(0);
      const args = readFileSync(join(dir, "args.txt"), "utf8");
      expect(args).toContain("dir");
      expect(args).toContain("--ignore-gitleaks-allow");
      expect(args).toMatch(/ -i \S+/);
      expect(args).toContain("--redact");
    });
  });

  const hasGitleaks = spawnSync("sh", ["-c", "gitleaks version | grep -q '^8\\.30\\.'"]).status === 0;

  test.skipIf(!hasGitleaks)("with real gitleaks, neither a .gitleaksignore nor an allow comment suppresses a finding", () => {
    withTempDir((dir) => {
      const scan = join(dir, "scan");
      const cwd = join(dir, "cwd");
      mkdirSync(scan);
      mkdirSync(cwd);
      // Assembled at run time so this file never contains a token-shaped literal.
      const token = ["ghp", "_", "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6"].join("");
      const allow = ["gitleaks", "allow"].join(":");
      writeFileSync(join(scan, "sample.txt"), `token = "${token}" # ${allow}\n`);
      writeFileSync(join(cwd, ".gitleaksignore"), "../scan/sample.txt:github-pat:1\n");

      const result = spawnSync(guard, ["gitleaks", "../scan"], { cwd, encoding: "utf8" });
      expect(result.status).not.toBe(0);
    });
  });
});
