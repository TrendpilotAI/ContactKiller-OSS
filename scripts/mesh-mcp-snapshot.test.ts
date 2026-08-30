import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildCodexExecArgs,
  buildMeshSearchInput,
  buildPrompt,
  captureSnapshot,
  isRfc3339Instant,
  parseSnapshotArgs,
} from "./mesh-mcp-snapshot";

const testOutputs: string[] = [];

afterEach(async () => {
  await Promise.all(testOutputs.splice(0).flatMap((path) => [
    rm(path, { force: true }),
    rm(`${path}.raw`, { force: true }),
    rm(`${path}.error.json`, { force: true }),
  ]));
});

function localOutputPath(label: string): string {
  const outputPath = resolve(`.local/contactkiller/mesh/${label}-${randomUUID()}.json`);
  testOutputs.push(outputPath);
  return outputPath;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function validResult(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    tool: "mcp__mesh__searchContacts",
    capturedAt: "2026-08-30T12:00:00-04:00",
    contacts: [{
      sourceRecordId: "synthetic-1",
      entityType: "contact",
      sourceUpdatedAt: null,
      payloadJson: JSON.stringify({ displayName: "Synthetic Person" }),
      emails: ["synthetic@example.invalid"],
      phones: ["+12025550123"],
      names: ["Synthetic Person"],
    }],
  };
}

function resultWithSourceUpdatedAt(value: string): Record<string, unknown> {
  const result = validResult();
  const contacts = result.contacts as Array<Record<string, unknown>>;
  contacts[0]!.sourceUpdatedAt = value;
  return result;
}

function authenticatedListResult(): { exitCode: number; stdout: string; stderr: string } {
  return {
    exitCode: 0,
    stdout: "mesh  https://mcp.me.sh/mcp  -  enabled  OAuth\n",
    stderr: "",
  };
}

describe("Mesh MCP snapshot planning", () => {
  test("builds a bounded enriched read without mutation tools", () => {
    const options = parseSnapshotArgs([
      "--name", "Synthetic Person",
      "--integration", "whatsapp",
      "--limit", "5",
      "--output", ".local/contactkiller/mesh/test.json",
    ]);
    const input = buildMeshSearchInput(options);
    expect(input).toMatchObject({
      name: ["Synthetic Person"],
      integration: ["whatsapp"],
      limit: 5,
    });
    expect(input.include_fields).toContain("integrations");
    expect(options.execute).toBe(false);
  });

  test("prompt permits one read tool and explicitly excludes writes", () => {
    const prompt = buildPrompt(buildMeshSearchInput({ name: "Synthetic Person", limit: 1 }));
    expect(prompt).toContain("mcp__mesh__searchContacts");
    expect(prompt).toContain("Do not call any write or mutation tool");
    expect(prompt).not.toContain("mcp__mesh__merge_contacts");
  });

  test("hard-allows only Mesh searchContacts in the Codex invocation", () => {
    const args = buildCodexExecArgs("/tmp/result.raw", "/tmp/empty", "bounded prompt");
    expect(args).toEqual(expect.arrayContaining([
      "-c",
      'mcp_servers.mesh.enabled_tools=["searchContacts"]',
      "-c",
      "mcp_servers.mesh.disabled_tools=[]",
      "--output-schema",
    ]));
    expect(args.filter((value) => value.includes("mcp_servers.mesh.enabled_tools"))).toEqual([
      'mcp_servers.mesh.enabled_tools=["searchContacts"]',
    ]);
    expect(args.join(" ")).not.toContain("createContact");
    expect(args.join(" ")).not.toContain("merge_contacts");
  });

  test("rejects unbounded pages, unknown integrations, and output paths outside the local Mesh cache", () => {
    expect(() => parseSnapshotArgs(["--limit", "101"])).toThrow("between 1 and 100");
    expect(() => parseSnapshotArgs(["--integration", "unknown"])).toThrow("must be one of");
    expect(() => parseSnapshotArgs(["--output", "/tmp/mesh.json"])).toThrow("direct file inside");
    expect(() => parseSnapshotArgs([
      "--output", ".local/contactkiller/mesh/nested/mesh.json",
    ])).toThrow("direct file inside");
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

describe("Mesh MCP snapshot local file safety", () => {
  test("presecures raw and final files, retains a 0600 snapshot, and removes raw output", async () => {
    const outputPath = localOutputPath("success");
    let modesDuringCommand: number[] = [];
    const options = parseSnapshotArgs(["--limit", "1", "--output", outputPath, "--execute"]);

    const result = await captureSnapshot(options, {
      runCommand: async (_command, args) => {
        if (args[0] === "mcp") return authenticatedListResult();
        const rawOutputPath = args[args.indexOf("-o") + 1]!;
        modesDuringCommand = [
          (await stat(outputPath)).mode & 0o777,
          (await stat(rawOutputPath)).mode & 0o777,
        ];
        await writeFile(rawOutputPath, JSON.stringify(validResult()));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result).toEqual({ outputPath, contactCount: 1 });
    expect(modesDuringCommand).toEqual([0o600, 0o600]);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(outputPath, "utf8")).capturedAt).toBe("2026-08-30T12:00:00-04:00");
    expect(await pathExists(`${outputPath}.raw`)).toBe(false);
    expect(await pathExists(`${outputPath}.error.json`)).toBe(false);
  });

  test("removes raw and final files when parsing or validation fails", async () => {
    const outputPath = localOutputPath("invalid");
    const options = parseSnapshotArgs(["--limit", "1", "--output", outputPath, "--execute"]);

    for (const invalidResult of [
      "not-json",
      JSON.stringify({ ...validResult(), tool: "mcp__mesh__getContact" }),
      JSON.stringify({ ...validResult(), capturedAt: "2026-02-30T12:00:00Z" }),
      JSON.stringify({ ...validResult(), capturedAt: "2026-08-30T12:00:00" }),
      JSON.stringify(resultWithSourceUpdatedAt("2026-08-30T12:00:00")),
    ]) {
      await expect(captureSnapshot(options, {
        runCommand: async (_command, args) => {
          if (args[0] === "mcp") return authenticatedListResult();
          const rawOutputPath = args[args.indexOf("-o") + 1]!;
          await writeFile(rawOutputPath, invalidResult);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      })).rejects.toThrow("no snapshot was retained");
    }

    expect(await pathExists(outputPath)).toBe(false);
    expect(await pathExists(`${outputPath}.raw`)).toBe(false);
    expect(await pathExists(`${outputPath}.error.json`)).toBe(false);
  });

  test("keeps only a redacted 0600 diagnostic when the Codex command fails", async () => {
    const outputPath = localOutputPath("command-failure");
    const options = parseSnapshotArgs(["--limit", "1", "--output", outputPath, "--execute"]);

    await expect(captureSnapshot(options, {
      runCommand: async (_command, args) => {
        if (args[0] === "mcp") return authenticatedListResult();
        return {
          exitCode: 17,
          stdout: "PRIVATE CONTACT VALUE",
          stderr: "PRIVATE EMAIL VALUE",
        };
      },
    })).rejects.toThrow("redacted diagnostic");

    const diagnosticPath = `${outputPath}.error.json`;
    const diagnostic = await readFile(diagnosticPath, "utf8");
    expect(diagnostic).not.toContain("PRIVATE CONTACT VALUE");
    expect(diagnostic).not.toContain("PRIVATE EMAIL VALUE");
    expect(JSON.parse(diagnostic)).toMatchObject({
      error: "mesh_snapshot_command_failed",
      exitCode: 17,
      outputRedacted: true,
    });
    expect((await stat(diagnosticPath)).mode & 0o777).toBe(0o600);
    expect(await pathExists(outputPath)).toBe(false);
    expect(await pathExists(`${outputPath}.raw`)).toBe(false);
  });
});
