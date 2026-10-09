import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scripts = resolve(import.meta.dir);
const expectedIds = join(scripts, "beads-expected-ids.sh");
const appendOnly = join(scripts, "check-audit-append-only.sh");
const bdPush = join(scripts, "bd-push.sh");

type Event = { tool_name: string; issue_id: string };
const lines = (events: Event[]): string => events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
const create = (issue_id: string): Event => ({ tool_name: "bd create", issue_id });
const del = (issue_id: string): Event => ({ tool_name: "bd delete", issue_id });

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "beads-scripts-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ids(args: string[]): { status: number | null; ids: string[]; stderr: string } {
  const result = spawnSync(expectedIds, args, { encoding: "utf8" });
  return { status: result.status, ids: result.stdout.split("\n").filter(Boolean), stderr: result.stderr };
}

describe("beads-expected-ids.sh", () => {
  test("creates are expected and a later delete removes them", () => {
    withTempDir((dir) => {
      const log = join(dir, "log.jsonl");
      writeFileSync(log, lines([create("a"), create("b"), del("a")]));
      expect(ids([log]).ids).toEqual(["b"]);
    });
  });

  test("a re-create after a delete makes the id expected again", () => {
    withTempDir((dir) => {
      const log = join(dir, "log.jsonl");
      writeFileSync(log, lines([create("a"), del("a"), create("a")]));
      expect(ids([log]).ids).toEqual(["a"]);
    });
  });

  test("tool names are matched exactly", () => {
    withTempDir((dir) => {
      const log = join(dir, "log.jsonl");
      writeFileSync(
        log,
        lines([
          create("a"),
          { tool_name: "bd create --force", issue_id: "x" },
          { tool_name: "bd q", issue_id: "y" },
          { tool_name: "bd delete --force", issue_id: "a" },
        ]),
      );
      expect(ids([log]).ids).toEqual(["a"]);
      expect(ids(["--created", log]).ids).toEqual(["a"]);
    });
  });

  test("PR mode takes creates from the baseline but applies the PR's own deletes", () => {
    withTempDir((dir) => {
      const baseline = join(dir, "base.jsonl");
      const log = join(dir, "pr.jsonl");
      const base = [create("a"), create("b")];
      writeFileSync(baseline, lines(base));
      // The PR deletes a published ticket, records a new one, and the new one is ignored.
      writeFileSync(log, lines([...base, del("a"), create("new")]));
      const result = ids([log, baseline]);
      expect(result.status).toBe(0);
      expect(result.ids).toEqual(["b"]);
    });
  });

  test("PR mode does not replay deletes that are part of the shared prefix", () => {
    withTempDir((dir) => {
      const baseline = join(dir, "base.jsonl");
      const log = join(dir, "pr.jsonl");
      const base = [create("a"), del("a"), create("a")];
      writeFileSync(baseline, lines(base));
      writeFileSync(log, lines([...base, create("other")]));
      expect(ids([log, baseline]).ids).toEqual(["a"]);
    });
  });

  test("an empty baseline expects nothing", () => {
    withTempDir((dir) => {
      const baseline = join(dir, "base.jsonl");
      const log = join(dir, "pr.jsonl");
      writeFileSync(baseline, "");
      writeFileSync(log, lines([create("a")]));
      expect(ids([log, baseline]).ids).toEqual([]);
    });
  });

  test("refuses a log that does not extend the baseline", () => {
    withTempDir((dir) => {
      const baseline = join(dir, "base.jsonl");
      const log = join(dir, "pr.jsonl");
      writeFileSync(baseline, lines([create("a")]));
      writeFileSync(log, lines([create("z")]));
      const result = ids([log, baseline]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("does not extend the baseline");
    });
  });
});

describe("check-audit-append-only.sh", () => {
  function repo(dir: string): void {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    mkdirSync(join(dir, ".beads"));
    writeFileSync(join(dir, ".gitkeep"), "");
    git("add", ".");
    git("commit", "-q", "-m", "no log yet");
    writeFileSync(join(dir, ".beads/interactions.jsonl"), lines([create("a")]));
    git("add", ".");
    git("commit", "-q", "-m", "log");
  }

  const run = (dir: string, base: string) =>
    spawnSync(appendOnly, [base], { cwd: dir, encoding: "utf8" });

  test("passes when appended, when unchanged, and when the base has no log", () => {
    withTempDir((dir) => {
      repo(dir);
      expect(run(dir, "HEAD").status).toBe(0);
      expect(run(dir, "HEAD~1").status).toBe(0);
      writeFileSync(join(dir, ".beads/interactions.jsonl"), lines([create("a"), create("b")]));
      expect(run(dir, "HEAD").status).toBe(0);
    });
  });

  test("fails on modification, truncation and removal", () => {
    withTempDir((dir) => {
      repo(dir);
      writeFileSync(join(dir, ".beads/interactions.jsonl"), lines([create("z")]));
      expect(run(dir, "HEAD").status).toBe(1);
      writeFileSync(join(dir, ".beads/interactions.jsonl"), "");
      expect(run(dir, "HEAD").status).toBe(1);
      rmSync(join(dir, ".beads/interactions.jsonl"));
      expect(run(dir, "HEAD").status).toBe(1);
    });
  });

  test("fails closed when the base revision is not available", () => {
    withTempDir((dir) => {
      repo(dir);
      const result = run(dir, "0123456789abcdef0123456789abcdef01234567");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not available");
    });
  });
});

describe("bd-push.sh", () => {
  test.each([
    ["--force"],
    ["--force=true"],
    ["--force-with-lease"],
    ["-f"],
    ["-yf"],
    ["-fy"],
    ["-y"],
    ["-C", "/tmp"],
    ["--directory", "/tmp"],
    ["--directory=/tmp"],
    ["--db", "/tmp/x"],
    ["--readonly"],
    ["--sandbox"],
    ["--dolt-auto-commit", "off"],
    ["--dolt-auto-commit=off"],
    ["--no-adopt"],
    ["--remote"],
    ["--remote", "other"],
    ["--remote=origin"],
    ["--remote", "origin", "--force"],
    ["origin"],
  ])("rejects %s before doing anything", (...args) => {
    const result = spawnSync(bdPush, args, { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unsupported arguments");
  });

  /**
   * A throwaway repo with stub scans and a recording `bd` whose state lives in
   * files (head, export content, dirty marker), so nothing real is pushed.
   */
  function stubbed(dir: string): { env: NodeJS.ProcessEnv; calls: string; state: string; script: string } {
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "state"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "scripts/bd-push.sh"), readFileSync(bdPush));
    writeFileSync(join(dir, "scripts/check-public-release.ts"), 'console.log("release stub");\n');
    for (const stub of ["check-beads-export.sh", "beads-guard.sh"]) {
      writeFileSync(
        join(dir, "scripts", stub),
        '#!/usr/bin/env bash\necho "STUB $(basename "$0") $*" >> "$CALLS"\n[ -f "$STATE/hook-$(basename "$0")" ] && . "$STATE/hook-$(basename "$0")"\nexit 0\n',
      );
    }
    writeFileSync(
      join(dir, "bin/bd"),
      `#!/usr/bin/env bash
echo "bd $*" >> "$CALLS"
case "$1 $2" in
  "dolt commit")
    if [ -f "$STATE/dirty" ]; then echo "Committed 1 change"; rm -f "$STATE/dirty"; else echo "Nothing to commit."; fi ;;
  "vc status") printf '{"branch":"main","commit":"%s","schema_version":1}\n' "$(cat "$STATE/head")" ;;
  "export --all") cp "$STATE/export" "$4" ;;
esac
exit 0
`,
    );
    for (const file of ["scripts/bd-push.sh", "scripts/check-beads-export.sh", "scripts/beads-guard.sh", "bin/bd"]) {
      chmodSync(join(dir, file), 0o755);
    }
    mkdirSync(join(dir, ".beads"));
    const state = join(dir, "state");
    writeFileSync(join(state, "head"), "head-one\n");
    writeFileSync(join(state, "export"), '{"id":"a"}\n');
    const calls = join(dir, "calls.log");
    return {
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, CALLS: calls, STATE: state },
      calls,
      state,
      script: join(dir, "scripts/bd-push.sh"),
    };
  }

  const callsOf = (calls: string): string[] => {
    try {
      return readFileSync(calls, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  const pushed = (calls: string): boolean => callsOf(calls).some((line) => line.startsWith("bd dolt push"));

  test("with no arguments it scans once, re-checks, then pushes with --no-adopt", () => {
    withTempDir((dir) => {
      const { env, calls, script } = stubbed(dir);
      const result = spawnSync(script, [], { cwd: dir, env, encoding: "utf8" });
      expect(result.status).toBe(0);
      const log = callsOf(calls);
      expect(log.filter((line) => line.startsWith("STUB check-beads-export.sh"))).toEqual(["STUB check-beads-export.sh --local"]);
      expect(log.indexOf("bd dolt commit")).toBeLessThan(log.indexOf("STUB check-beads-export.sh --local"));
      expect(log.lastIndexOf("bd dolt commit")).toBeGreaterThan(log.indexOf("STUB check-beads-export.sh --local"));
      expect(log.at(-1)).toBe("bd dolt push --no-adopt");
    });
  });

  test("--remote origin is passed through, and nothing is pushed if a scan fails", () => {
    withTempDir((dir) => {
      const { env, calls, script } = stubbed(dir);
      const ok = spawnSync(script, ["--remote", "origin"], { cwd: dir, env, encoding: "utf8" });
      expect(ok.status).toBe(0);
      expect(callsOf(calls).at(-1)).toBe("bd dolt push --no-adopt --remote origin");

      rmSync(calls);
      writeFileSync(join(dir, "scripts/check-beads-export.sh"), "#!/usr/bin/env bash\nexit 1\n");
      const failed = spawnSync(script, [], { cwd: dir, env, encoding: "utf8" });
      expect(failed.status).not.toBe(0);
      expect(pushed(calls)).toBe(false);
    });
  });

  test("a dirty working set aborts before any scan and nothing is pushed", () => {
    withTempDir((dir) => {
      const { env, calls, state, script } = stubbed(dir);
      writeFileSync(join(state, "dirty"), "");
      const result = spawnSync(script, [], { cwd: dir, env, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("uncommitted changes");
      expect(callsOf(calls).some((line) => line.startsWith("STUB check-beads-export.sh"))).toBe(false);
      expect(pushed(calls)).toBe(false);
    });
  });

  test("content that changes between the scan and the push aborts (Dolt HEAD moves)", () => {
    withTempDir((dir) => {
      const { env, calls, state, script } = stubbed(dir);
      writeFileSync(join(state, "hook-check-beads-export.sh"), 'echo head-two > "$STATE/head"\n');
      const result = spawnSync(script, [], { cwd: dir, env, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Dolt HEAD moved during the scan");
      expect(pushed(calls)).toBe(false);
    });
  });

  test("exported content that changes without a new commit aborts too", () => {
    withTempDir((dir) => {
      const { env, calls, state, script } = stubbed(dir);
      writeFileSync(join(state, "hook-check-beads-export.sh"), `echo '{"id":"a","title":"changed"}' > "$STATE/export"\n`);
      const result = spawnSync(script, [], { cwd: dir, env, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("exported tracker content changed");
      expect(pushed(calls)).toBe(false);
    });
  });

  test("a change that is still uncommitted after the scan aborts", () => {
    withTempDir((dir) => {
      const { env, calls, state, script } = stubbed(dir);
      writeFileSync(join(state, "hook-check-beads-export.sh"), 'touch "$STATE/dirty"\n');
      const result = spawnSync(script, [], { cwd: dir, env, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("uncommitted changes");
      expect(pushed(calls)).toBe(false);
    });
  });
});
