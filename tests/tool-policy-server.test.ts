import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeVault } from "./fixtures.js";

const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const ENTRY = join(process.cwd(), "src", "index.ts");

/** Env for the child server: inherit, minus any tool-gating vars, plus overrides. */
function serverEnv(vaultPath: string, overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.OBSIDIAN_TOOLS;
  delete env.OBSIDIAN_ALLOW_WRITES;
  env.OBSIDIAN_VAULT_PATH = vaultPath;
  return { ...env, ...overrides };
}

async function withClient<T>(
  vaultPath: string,
  overrides: Record<string, string>,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({ name: "tool-policy-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, ENTRY],
    env: serverEnv(vaultPath, overrides),
    stderr: "ignore",
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function toolNames(vaultPath: string, overrides: Record<string, string>): Promise<string[]> {
  return withClient(vaultPath, overrides, async (client) => {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  });
}

/** Spawn the server expecting it to die at startup; return { code, stderr }. */
function startupFailure(
  vaultPath: string,
  overrides: Record<string, string>
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, ENTRY], {
      env: serverEnv(vaultPath, overrides),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("default exposure is the read surface plus get_config", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const names = await toolNames(fx.vaultPath, {});
    assert.equal(names.length, 25);
    assert.ok(names.includes("get_config"));
    assert.ok(names.includes("search_notes"));
    assert.ok(!names.includes("write_note"));
    assert.ok(!names.includes("set_task_state"));
  } finally {
    await fx.cleanup();
  }
});

test("OBSIDIAN_TOOLS=all exposes all 46 tools", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const names = await toolNames(fx.vaultPath, { OBSIDIAN_TOOLS: "all" });
    assert.equal(names.length, 46);
    assert.ok(names.includes("bulk_edit"));
  } finally {
    await fx.cleanup();
  }
});

test("negative-first policy trims the read surface without exposing writes", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const names = await toolNames(fx.vaultPath, { OBSIDIAN_TOOLS: "-templates,-tasks" });
    assert.ok(!names.includes("list_templates"));
    assert.ok(!names.includes("list_tasks"));
    assert.ok(!names.includes("write_note"));
    assert.equal(names.length, 23);
  } finally {
    await fx.cleanup();
  }
});

test("mode-slice policy exposes selected writes only", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const names = await toolNames(fx.vaultPath, { OBSIDIAN_TOOLS: "reads,tasks.write" });
    assert.ok(names.includes("set_task_state"));
    assert.ok(!names.includes("write_note"));
    assert.equal(names.length, 26);
  } finally {
    await fx.cleanup();
  }
});

test("calling a policy-excluded tool errors, naming the policy", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    await withClient(fx.vaultPath, { OBSIDIAN_TOOLS: "search" }, async (client) => {
      const result = await client.callTool({
        name: "write_note",
        arguments: { path: "x", content: "y" },
      });
      assert.equal(result.isError, true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.match(text, /OBSIDIAN_TOOLS/);
      assert.match(text, /"search"/);
      // excluded READ tools are refused the same way
      const read = await client.callTool({ name: "list_tasks", arguments: {} });
      assert.equal(read.isError, true);
    });
  } finally {
    await fx.cleanup();
  }
});

test("get_config is exposed and callable under a minimal policy", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    await withClient(fx.vaultPath, { OBSIDIAN_TOOLS: "search" }, async (client) => {
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "get_config"));
      const result = await client.callTool({ name: "get_config", arguments: { section: "tools" } });
      assert.equal(result.isError ?? false, false);
      const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(payload.policy, "search");
      assert.deepEqual(payload.exposed, ["get_config", "search_notes", "search_notes_ranked"]);
    });
  } finally {
    await fx.cleanup();
  }
});

test("startup fails loud on an unknown selector", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const { code, stderr } = await startupFailure(fx.vaultPath, { OBSIDIAN_TOOLS: "reads,templats" });
    assert.notEqual(code, 0);
    assert.match(stderr, /templats/);
  } finally {
    await fx.cleanup();
  }
});

test("startup fails loud when the retired OBSIDIAN_ALLOW_WRITES is set", async () => {
  const fx = await makeVault([{ path: "a.md", content: "# A\n" }]);
  try {
    const { code, stderr } = await startupFailure(fx.vaultPath, { OBSIDIAN_ALLOW_WRITES: "1" });
    assert.notEqual(code, 0);
    assert.match(stderr, /OBSIDIAN_TOOLS/);
  } finally {
    await fx.cleanup();
  }
});
