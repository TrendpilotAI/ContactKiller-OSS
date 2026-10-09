// Shared helpers for tests that drive a real `bd`. Every workspace they create has
// no Dolt remote at all (or, for the push-related tests, only a local file remote),
// and every helper refuses to continue if a real network remote shows up.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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
  for (const name of ["BD_DOLT_AUTO_PUSH", "GH_TOKEN", "GITHUB_TOKEN", "BEADS_DIR", "BEADS_DB"]) delete env[name];
  return env;
}

const NETWORK_REMOTE = /(https?:\/\/|ssh:\/\/|git@|git\+https|git\+ssh|github\.com)/i;

/**
 * Throws if the workspace has any git remote or Dolt remote that is not a local
 * file remote. Called before anything that could possibly push.
 */
export function assertNoRealRemote(ws: string, env: NodeJS.ProcessEnv): void {
  const outputs: string[] = [];
  const git = spawnSync("git", ["remote", "-v"], { cwd: ws, env, encoding: "utf8" });
  outputs.push(git.stdout ?? "");
  const bd = spawnSync("bd", ["dolt", "remote", "list"], { cwd: ws, env, encoding: "utf8" });
  outputs.push(bd.stdout ?? "");
  const stores = join(ws, ".beads/embeddeddolt");
  if (existsSync(stores) && hasTool("dolt")) {
    for (const name of spawnSync("ls", [stores], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)) {
      const sql = spawnSync("dolt", ["sql", "-r", "csv", "-q", "SELECT url FROM dolt_remotes"], {
        cwd: join(stores, name),
        env,
        encoding: "utf8",
      });
      outputs.push(sql.stdout ?? "");
    }
  }
  const joined = outputs.join("\n");
  if (NETWORK_REMOTE.test(joined)) {
    throw new Error(`refusing to run: the test workspace ${ws} has a network remote configured:\n${joined}`);
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
