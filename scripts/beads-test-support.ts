// Shared helpers for tests that drive a real `bd`. Every workspace they create has
// no Dolt remote at all (or, for the push-related tests, only a local file remote),
// and every helper refuses to continue if a real network remote shows up.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const hasTool = (tool: string): boolean => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;

/** An environment that cannot reach the user's home config, tokens, or telemetry. */
export function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    DO_NOT_TRACK: "1",
    BD_NON_INTERACTIVE: "1",
    BEADS_ACTOR: "tester",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  // CI exports BEADS_AUDIT_BASELINE (and the like) for pull_request runs; none of it may leak into a test workspace.
  for (const name of ["BD_DOLT_AUTO_PUSH", "GH_TOKEN", "GITHUB_TOKEN", "BEADS_DIR", "BEADS_DB", "BEADS_AUDIT_BASELINE", "GITHUB_REPOSITORY"]) {
    delete env[name];
  }
  return env;
}

const ALLOWED_REMOTE = /^(file:\/\/|git\+file:\/\/)/i;

function runOrThrow(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`refusing to run: cannot check remotes because \`${cmd} ${args.join(" ")}\` failed in ${cwd}: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

/** Every remote URL that git, bd and the Dolt store report for a workspace. */
function remoteUrls(ws: string, env: NodeJS.ProcessEnv): string[] {
  const urls: string[] = [];
  // `git remote -v`: "<name>\t<url> (fetch|push)"
  for (const line of runOrThrow("git", ["remote", "-v"], ws, env).split("\n").filter(Boolean)) {
    urls.push(line.split(/\s+/)[1] ?? line);
  }
  if (existsSync(join(ws, ".beads"))) {
    // `bd dolt remote list`: "<name> <url>" lines, or "No remotes configured."
    for (const line of runOrThrow("bd", ["dolt", "remote", "list"], ws, env).split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (/^no remotes configured/i.test(line)) continue;
      urls.push(line.split(/\s+/)[1] ?? line);
    }
    const stores = join(ws, ".beads/embeddeddolt");
    // The Dolt CLI is the most direct view; bd's own remote list above covers the same remotes without it.
    if (existsSync(stores) && hasTool("dolt")) {
      for (const entry of readdirSync(stores, { withFileTypes: true }).filter((e) => e.isDirectory())) {
        const name = entry.name;
        const csv = runOrThrow("dolt", ["sql", "-r", "csv", "-q", "SELECT url FROM dolt_remotes"], join(stores, name), env);
        for (const line of csv.split("\n").slice(1).filter(Boolean)) urls.push(line.replace(/^"|"$/g, ""));
      }
    }
  }
  return urls;
}

/**
 * Throws unless every git, bd and Dolt remote of the workspace is a local file
 * remote (file:// or git+file://). An allowlist: aws://, gs://, oci://, ssh and
 * anything else unknown is refused, and so is any failure to ask. Called before
 * anything that could possibly push.
 */
export function assertNoRealRemote(ws: string, env: NodeJS.ProcessEnv): void {
  const refused = remoteUrls(ws, env).filter((url) => !ALLOWED_REMOTE.test(url));
  if (refused.length > 0) {
    throw new Error(`refusing to run: the test workspace ${ws} has a non-local remote configured: ${refused.join(", ")}`);
  }
}

export interface Workspace {
  ws: string;
  env: NodeJS.ProcessEnv;
  store: string;
}

/** A throwaway git + bd workspace with no remote at all, and `tickets` tickets. */
export function initWorkspace(dir: string, tickets = 2, titles = ["one", "two", "three", "four"]): Workspace {
  const env = isolatedEnv(dir);
  const ws = join(dir, "ws");
  mkdirSync(ws);
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: ws, env, stdio: "pipe" });
  run("git", ["init", "-q"]);
  run("git", ["config", "user.email", "owner@example.com"]);
  run("git", ["config", "user.name", "t"]);
  run("bd", ["init", "--non-interactive", "--prefix", "t", "--skip-hooks", "--skip-agents"]);
  assertNoRealRemote(ws, env);
  for (const title of titles.slice(0, tickets)) run("bd", ["create", "--title", title, "--description", "d", "--silent"]);
  return { ws, env, store: join(ws, ".beads/embeddeddolt/t") };
}

/** Adds a local file remote (a bare git repo with one commit) to a workspace. */
export function addLocalFileRemote(dir: string, workspace: Workspace): string {
  const bare = join(dir, "remote.git");
  const seed = join(dir, "seed");
  const { env } = workspace;
  execFileSync("git", ["init", "-q", "--bare", bare], { env, stdio: "pipe" });
  mkdirSync(seed);
  execFileSync("git", ["init", "-q"], { cwd: seed, env, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "seed"], {
    cwd: seed,
    env,
    stdio: "pipe",
  });
  execFileSync("git", ["push", "-q", bare, "HEAD:refs/heads/main"], { cwd: seed, env, stdio: "pipe" });
  execFileSync("bd", ["dolt", "remote", "add", "origin", `git+file://${bare}`, "--allow-git-origin"], {
    cwd: workspace.ws,
    env,
    stdio: "pipe",
  });
  assertNoRealRemote(workspace.ws, env);
  return bare;
}

export function sql(workspace: Workspace, query: string): void {
  execFileSync("dolt", ["sql", "-q", query], { cwd: workspace.store, env: workspace.env, stdio: "pipe" });
}
