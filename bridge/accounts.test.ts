import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearPendingAccount,
  parseAccountAgent,
  parsePendingAccount,
  pendingAgents,
  readPendingAccount,
} from "./accounts.ts";
import { cspFor } from "./server.ts";

describe("parseAccountAgent — a name from the fixed list, nothing else", () => {
  test("accepts the listed agents", () => {
    expect(parseAccountAgent({ agent: "claude" })).toBe("claude");
    expect(parseAccountAgent({ agent: "codex" })).toBe("codex");
  });
  test("refuses anything that could reach a shell line differently", () => {
    for (const agent of ["", "Claude", "claude ", "claude; rm -rf /", "opencode", "../x"]) {
      expect(parseAccountAgent({ agent })).toBeNull();
    }
    expect(parseAccountAgent({ agent: 1 })).toBeNull();
    expect(parseAccountAgent("claude")).toBeNull();
    expect(parseAccountAgent(null)).toBeNull();
  });
});

describe("parsePendingAccount — a FREEAGENT_* secret name and a value GitHub will take", () => {
  test("accepts a well-formed payload", () => {
    expect(parsePendingAccount({ secret: "FREEAGENT_CODEX_AUTH", value: "abc" })).toEqual({
      secret: "FREEAGENT_CODEX_AUTH",
      value: "abc",
    });
  });
  test("refuses a secret name outside the FREEAGENT_ namespace, so no other secret can be overwritten", () => {
    for (const secret of ["GITHUB_TOKEN", "freeagent_x", "FREEAGENT_", "FREEAGENT_a", "NVIDIA_NIM_API_KEY"]) {
      expect(parsePendingAccount({ secret, value: "v" })).toBeNull();
    }
  });
  test("refuses an empty or oversized value", () => {
    expect(parsePendingAccount({ secret: "FREEAGENT_X", value: "" })).toBeNull();
    expect(parsePendingAccount({ secret: "FREEAGENT_X", value: "x".repeat(48 * 1024 + 1) })).toBeNull();
    expect(parsePendingAccount({ secret: "FREEAGENT_X", value: 5 })).toBeNull();
  });
});

describe("the pending directory", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "collie-accounts-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("no pending/ at all means nothing waiting", async () => {
    expect(await pendingAgents(dir)).toEqual([]);
    expect(await readPendingAccount(dir, "claude")).toBeNull();
    expect(await clearPendingAccount(dir, "claude")).toBe(false);
  });

  test("lists only known agents, reads without deleting, and deletes on done", async () => {
    await mkdir(join(dir, "pending"));
    await writeFile(join(dir, "pending", "codex.json"), JSON.stringify({ secret: "FREEAGENT_CODEX_AUTH", value: "b64" }));
    await writeFile(join(dir, "pending", "stray.json"), "{}");
    expect(await pendingAgents(dir)).toEqual(["codex"]);

    expect(await readPendingAccount(dir, "codex")).toEqual({ secret: "FREEAGENT_CODEX_AUTH", value: "b64" });
    // A read is not a take: a save that fails can ask again.
    expect(await pendingAgents(dir)).toEqual(["codex"]);

    expect(await clearPendingAccount(dir, "codex")).toBe(true);
    expect(await pendingAgents(dir)).toEqual([]);
    expect(await readdir(join(dir, "pending"))).toEqual(["stray.json"]);
  });

  test("a malformed or out-of-namespace file is not handed out", async () => {
    await mkdir(join(dir, "pending"));
    await writeFile(join(dir, "pending", "claude.json"), "not json");
    expect(await readPendingAccount(dir, "claude")).toBeNull();
    await writeFile(join(dir, "pending", "claude.json"), JSON.stringify({ secret: "GITHUB_TOKEN", value: "x" }));
    expect(await readPendingAccount(dir, "claude")).toBeNull();
  });
});

describe("cspFor — api.github.com is reachable from the page only while accounts are on", () => {
  test("off: the strict policy, unchanged", () => {
    expect(cspFor({ connectCommand: "" })).toContain("connect-src 'self';");
    expect(cspFor({ connectCommand: "" })).not.toContain("github");
  });
  test("on: exactly one extra origin, in connect-src only", () => {
    const csp = cspFor({ connectCommand: "freeagent-connect" });
    expect(csp).toContain("connect-src 'self' https://api.github.com;");
    expect(csp.match(/github/g)?.length).toBe(1);
    expect(csp).toContain("script-src 'self';");
  });
});
