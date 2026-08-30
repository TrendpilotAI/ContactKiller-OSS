#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";

const STEPS = ["map", "crawl", "download", "search"] as const;
const LAYOUT = [
  "00-scope",
  "01-public-site/raw",
  "01-public-site/screenshots",
  "02-authenticated-product/logs",
  "02-authenticated-product/pages",
  "02-authenticated-product/screenshots",
  "03-docs-api-mcp/crawl",
  "03-docs-api-mcp/download",
  "04-reviews/reddit",
  "04-reviews/web",
  "05-analysis",
  "manifests",
] as const;

type Step = (typeof STEPS)[number];
type CommandStatus = "planned" | "running" | "succeeded" | "failed";

interface Options {
  product: string;
  slug: string;
  url: string;
  docsUrl: string;
  runRoot: string;
  limit: number;
  maxDepth: number;
  steps: Step[];
  includePaths?: string;
  excludePaths?: string;
  includeSubdomains: boolean;
  screenshots: boolean;
  execute: boolean;
  force: boolean;
}

interface ArtifactPlan {
  kind: "file" | "directory";
  path: string;
}

interface CommandPlan {
  id: string;
  step: Step;
  cwd: string;
  argv: string[];
  display: string;
  sourceUrls: string[];
  artifacts: ArtifactPlan[];
  status: CommandStatus;
  exitCode?: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

interface ArtifactRecord extends ArtifactPlan {
  exists: boolean;
  bytes?: number;
}

interface Manifest {
  schemaVersion: 1;
  createdAt: string;
  completedAt?: string;
  mode: "dry-run" | "execute";
  product: string;
  slug: string;
  runRoot: string;
  settings: {
    url: string;
    docsUrl: string;
    limit: number;
    maxDepth: number;
    steps: Step[];
    includePaths?: string;
    excludePaths?: string;
    includeSubdomains: boolean;
    screenshots: boolean;
  };
  urls: {
    seed: string[];
    discovered: string[];
  };
  commands: CommandPlan[];
  artifacts: ArtifactRecord[];
}

const HELP = `
Create a bounded, repeatable competitor-research capture plan.

Usage:
  bun scripts/research-product.ts --product <name> --url <https-url> [options]

Required:
  --product <name>            Product name, for example "Mesh"
  --url <url>                 Public product URL

Options:
  --docs-url <url>            Docs/API URL; defaults to --url
  --output <directory>        Exact run directory. Defaults to
                              research/competitors/<product>/<YYYY-MM-DD>
  --limit <1-250>             Page ceiling for map/crawl/download (default: 40)
  --max-depth <1-8>           Crawl depth ceiling (default: 3)
  --steps <csv>               map,crawl,download,search (default: all)
  --include-paths <csv>       Firecrawl path allowlist, such as /docs,/api
  --exclude-paths <csv>       Firecrawl path denylist, such as /legal,/blog
  --include-subdomains        Allow subdomains in map/crawl/download
  --screenshots               Capture one screenshot per downloaded public page
  --execute                   Create folders and call Firecrawl (default: dry-run)
  --force                     Permit Firecrawl to reuse existing artifact targets
  -h, --help                  Show this help

Authentication:
  Uses Firecrawl's existing login or FIRECRAWL_API_KEY from the environment.
  This tool never accepts, prints, or persists an API key.

Examples:
  bun scripts/research-product.ts --product Mesh --url https://me.sh
  bun scripts/research-product.ts --product Mesh --url https://me.sh \\
    --docs-url https://library.me.sh/ --limit 50 --screenshots --execute
`;

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("--product must contain at least one letter or number");
  return slug;
}

function normalizeUrl(value: string, flag: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${flag} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${flag} must use http or https`);
  }
  parsed.hash = "";
  return parsed.toString();
}

function boundedInteger(value: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be an integer`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < min || parsed > max) {
    throw new Error(`${flag} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseSteps(value: string): Step[] {
  const requested = value.split(",").map((step) => step.trim()).filter(Boolean);
  if (requested.length === 0) throw new Error("--steps must not be empty");
  const invalid = requested.filter((step) => !STEPS.includes(step as Step));
  if (invalid.length > 0) throw new Error(`Unknown step(s): ${invalid.join(", ")}`);
  return STEPS.filter((step) => requested.includes(step));
}

function validatePathFilter(value: string, flag: string): string {
  const paths = value.split(",").map((path) => path.trim()).filter(Boolean);
  if (paths.length === 0 || paths.some((path) => !path.startsWith("/"))) {
    throw new Error(`${flag} must be a comma-separated list of paths beginning with /`);
  }
  return paths.join(",");
}

function parseArgs(argv: string[]): Options {
  let product: string | undefined;
  let url: string | undefined;
  let docsUrl: string | undefined;
  let output: string | undefined;
  let limit = 40;
  let maxDepth = 3;
  let steps: Step[] = [...STEPS];
  let includePaths: string | undefined;
  let excludePaths: string | undefined;
  let includeSubdomains = false;
  let screenshots = false;
  let execute = false;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        console.log(HELP.trim());
        process.exit(0);
        break;
      case "--product":
        product = valueAfter(argv, index, arg);
        index += 1;
        break;
      case "--url":
        url = valueAfter(argv, index, arg);
        index += 1;
        break;
      case "--docs-url":
        docsUrl = valueAfter(argv, index, arg);
        index += 1;
        break;
      case "--output":
        output = valueAfter(argv, index, arg);
        index += 1;
        break;
      case "--limit":
        limit = boundedInteger(valueAfter(argv, index, arg), arg, 1, 250);
        index += 1;
        break;
      case "--max-depth":
        maxDepth = boundedInteger(valueAfter(argv, index, arg), arg, 1, 8);
        index += 1;
        break;
      case "--steps":
        steps = parseSteps(valueAfter(argv, index, arg));
        index += 1;
        break;
      case "--include-paths":
        includePaths = validatePathFilter(valueAfter(argv, index, arg), arg);
        index += 1;
        break;
      case "--exclude-paths":
        excludePaths = validatePathFilter(valueAfter(argv, index, arg), arg);
        index += 1;
        break;
      case "--include-subdomains":
        includeSubdomains = true;
        break;
      case "--screenshots":
        screenshots = true;
        break;
      case "--execute":
        execute = true;
        break;
      case "--force":
        force = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!product) throw new Error("--product is required");
  if (!url) throw new Error("--url is required");

  const slug = slugify(product);
  const normalizedUrl = normalizeUrl(url, "--url");
  const normalizedDocsUrl = normalizeUrl(docsUrl ?? url, "--docs-url");
  const date = new Date().toISOString().slice(0, 10);
  const runRoot = resolve(output ?? join("research", "competitors", slug, date));
  if (runRoot === parse(runRoot).root) throw new Error("--output cannot be a filesystem root");

  return {
    product,
    slug,
    url: normalizedUrl,
    docsUrl: normalizedDocsUrl,
    runRoot,
    limit,
    maxDepth,
    steps,
    includePaths,
    excludePaths,
    includeSubdomains,
    screenshots,
    execute,
    force,
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=,@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function displayCommand(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

function addPathFilters(argv: string[], options: Options): void {
  if (options.includePaths) argv.push("--include-paths", options.includePaths);
  if (options.excludePaths) argv.push("--exclude-paths", options.excludePaths);
}

function commandPlan(options: Options): CommandPlan[] {
  const plans: CommandPlan[] = [];
  const publicRaw = join(options.runRoot, "01-public-site", "raw");
  const crawlDir = join(options.runRoot, "03-docs-api-mcp", "crawl");
  const downloadDir = join(options.runRoot, "03-docs-api-mcp", "download");
  const reviewWeb = join(options.runRoot, "04-reviews", "web");
  const reviewReddit = join(options.runRoot, "04-reviews", "reddit");

  if (options.steps.includes("map")) {
    const artifact = join(publicRaw, "map-all.json");
    const argv = [
      "firecrawl", "map", options.url, "--wait", "--limit", String(options.limit),
      "--ignore-query-parameters", "--json", "--pretty", "-o", artifact,
    ];
    if (options.includeSubdomains) argv.push("--include-subdomains");
    plans.push({
      id: "map-public-site",
      step: "map",
      cwd: options.runRoot,
      argv,
      display: displayCommand(argv),
      sourceUrls: [options.url],
      artifacts: [{ kind: "file", path: artifact }],
      status: "planned",
    });
  }

  if (options.steps.includes("crawl")) {
    const artifact = join(crawlDir, "docs-crawl.json");
    const argv = [
      "firecrawl", "crawl", options.docsUrl, "--wait", "--progress",
      "--limit", String(options.limit), "--max-depth", String(options.maxDepth),
      "--ignore-query-parameters", "--pretty", "-o", artifact,
    ];
    addPathFilters(argv, options);
    if (options.includeSubdomains) argv.push("--allow-subdomains");
    plans.push({
      id: "crawl-docs-api-mcp",
      step: "crawl",
      cwd: options.runRoot,
      argv,
      display: displayCommand(argv),
      sourceUrls: [options.docsUrl],
      artifacts: [{ kind: "file", path: artifact }],
      status: "planned",
    });
  }

  if (options.steps.includes("download")) {
    const artifact = join(downloadDir, ".firecrawl");
    const argv = [
      "firecrawl", "experimental", "download", options.docsUrl,
      "--limit", String(options.limit), "--format", "markdown,links",
      "--only-main-content", "--yes",
    ];
    addPathFilters(argv, options);
    if (options.includeSubdomains) argv.push("--allow-subdomains");
    if (options.screenshots) argv.push("--screenshot");
    plans.push({
      id: "download-docs-api-mcp",
      step: "download",
      cwd: downloadDir,
      argv,
      display: displayCommand(argv),
      sourceUrls: [options.docsUrl],
      artifacts: [{ kind: "directory", path: artifact }],
      status: "planned",
    });
  }

  if (options.steps.includes("search")) {
    const searchLimit = Math.min(options.limit, 10);
    const searches = [
      {
        id: "search-product-reviews",
        query: `${options.product} contact relationship management reviews`,
        artifact: join(reviewWeb, "search-reviews.json"),
      },
      {
        id: "search-reddit-reviews",
        query: `site:reddit.com ${options.product} contacts relationship management review`,
        artifact: join(reviewReddit, "search-reddit.json"),
      },
    ];

    for (const search of searches) {
      const argv = [
        "firecrawl", "search", search.query, "--limit", String(searchLimit),
        "--sources", "web", "--scrape", "--scrape-formats", "markdown,links",
        "--only-main-content", "--json", "-o", search.artifact,
      ];
      plans.push({
        id: search.id,
        step: "search",
        cwd: options.runRoot,
        argv,
        display: displayCommand(argv),
        sourceUrls: [],
        artifacts: [{ kind: "file", path: search.artifact }],
        status: "planned",
      });
    }
  }

  return plans;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function artifactRecords(commands: CommandPlan[]): Promise<ArtifactRecord[]> {
  const records: ArtifactRecord[] = [];
  for (const artifact of commands.flatMap((command) => command.artifacts)) {
    try {
      const details = await stat(artifact.path);
      records.push({
        ...artifact,
        exists: true,
        ...(details.isFile() ? { bytes: details.size } : {}),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      records.push({ ...artifact, exists: false });
    }
  }
  return records;
}

function collectUrls(value: unknown, urls: Set<string>): void {
  if (typeof value === "string") {
    const matches = value.match(/https?:\/\/[^\s<>"')\]]+/g);
    for (const match of matches ?? []) {
      try {
        const parsed = new URL(match);
        parsed.hash = "";
        urls.add(parsed.toString());
      } catch {
        // Ignore non-URL prose fragments in scraped content.
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, urls);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectUrls(item, urls);
  }
}

async function discoveredUrls(commands: CommandPlan[], seedUrls: string[]): Promise<string[]> {
  const urls = new Set(seedUrls);
  for (const artifact of commands.flatMap((command) => command.artifacts)) {
    if (artifact.kind !== "file" || !artifact.path.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(await readFile(artifact.path, "utf8"));
      collectUrls(parsed, urls);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }
  return [...urls].sort();
}

async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function runCommand(command: CommandPlan): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(command.argv[0], command.argv.slice(1), {
      cwd: command.cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command.id} terminated by ${signal}`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

function relativeManifest(manifest: Manifest): Manifest {
  const makeRelative = (path: string): string => {
    const result = relative(manifest.runRoot, path);
    return result && !result.startsWith("..") && !isAbsolute(result) ? result : path;
  };
  return {
    ...manifest,
    commands: manifest.commands.map((command) => ({
      ...command,
      cwd: makeRelative(command.cwd) || ".",
      artifacts: command.artifacts.map((artifact) => ({ ...artifact, path: makeRelative(artifact.path) })),
    })),
    artifacts: manifest.artifacts.map((artifact) => ({ ...artifact, path: makeRelative(artifact.path) })),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const commands = commandPlan(options);
  const seed = [...new Set([options.url, options.docsUrl])];
  const manifest: Manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    mode: options.execute ? "execute" : "dry-run",
    product: options.product,
    slug: options.slug,
    runRoot: options.runRoot,
    settings: {
      url: options.url,
      docsUrl: options.docsUrl,
      limit: options.limit,
      maxDepth: options.maxDepth,
      steps: options.steps,
      includePaths: options.includePaths,
      excludePaths: options.excludePaths,
      includeSubdomains: options.includeSubdomains,
      screenshots: options.screenshots,
    },
    urls: { seed, discovered: seed },
    commands,
    artifacts: await artifactRecords(commands),
  };

  if (!options.execute) {
    console.log(JSON.stringify(relativeManifest(manifest), null, 2));
    console.error("\nDry run only. Re-run with --execute to create folders and call Firecrawl.");
    return;
  }

  if (!options.force) {
    const conflicts: string[] = [];
    for (const artifact of commands.flatMap((command) => command.artifacts)) {
      if (await pathExists(artifact.path)) conflicts.push(artifact.path);
    }
    if (conflicts.length > 0) {
      throw new Error(`Artifact target(s) already exist; use a new --output or --force:\n${conflicts.join("\n")}`);
    }
  }

  for (const directory of LAYOUT) await mkdir(join(options.runRoot, directory), { recursive: true });
  const manifestPath = join(
    options.runRoot,
    "manifests",
    `research-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await writeManifest(manifestPath, relativeManifest(manifest));

  for (const command of commands) {
    command.status = "running";
    command.startedAt = new Date().toISOString();
    await writeManifest(manifestPath, relativeManifest(manifest));
    let exitCode: number;
    try {
      exitCode = await runCommand(command);
    } catch (error) {
      command.status = "failed";
      command.error = error instanceof Error ? error.message : String(error);
      command.finishedAt = new Date().toISOString();
      manifest.artifacts = await artifactRecords(commands);
      manifest.urls.discovered = await discoveredUrls(commands, seed);
      await writeManifest(manifestPath, relativeManifest(manifest));
      throw error;
    }
    command.exitCode = exitCode;
    command.finishedAt = new Date().toISOString();
    command.status = exitCode === 0 ? "succeeded" : "failed";
    manifest.artifacts = await artifactRecords(commands);
    manifest.urls.discovered = await discoveredUrls(commands, seed);
    await writeManifest(manifestPath, relativeManifest(manifest));
    if (exitCode !== 0) throw new Error(`${command.id} failed with exit code ${exitCode}`);
  }

  manifest.completedAt = new Date().toISOString();
  manifest.artifacts = await artifactRecords(commands);
  manifest.urls.discovered = await discoveredUrls(commands, seed);
  await writeManifest(manifestPath, relativeManifest(manifest));
  console.log(`Research capture completed: ${options.runRoot}`);
  console.log(`Manifest: ${manifestPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
