import { beforeEach, describe, expect, it } from "vitest";

import {
  type AccountAgent,
  connectIntentFromFragment,
  dismissAccountSave,
  getAccountSaveState,
  runAccountSaver,
  type SaverDeps,
  SIGN_IN_WINDOW_MS,
} from "./accounts-connect";
import { GithubSecretError } from "./github-secrets";

describe("connectIntentFromFragment", () => {
  it("reads the agent and the GitHub token without touching the URL", () => {
    expect(connectIntentFromFragment("#gh=gho_x&connect=codex")).toEqual({ agent: "codex", githubToken: "gho_x" });
    expect(connectIntentFromFragment("#connect=claude")).toEqual({ agent: "claude", githubToken: null });
    expect(connectIntentFromFragment("#gh=gho_x")).toEqual({ agent: null, githubToken: "gho_x" });
  });
  it("ignores an agent that is not on the list", () => {
    expect(connectIntentFromFragment("#connect=opencode").agent).toBeNull();
    expect(connectIntentFromFragment("#connect=claude%3Brm").agent).toBeNull();
    expect(connectIntentFromFragment("").agent).toBeNull();
  });
});

/** A box whose sign-in lands after `landsAfter` polls, and a GitHub that records what it saved. */
function world(opts: { landsAfter?: number; saveFails?: GithubSecretError; enabled?: boolean } = {}) {
  let polls = 0;
  let clock = 0;
  const pendingOnBox = new Map<AccountAgent, { secret: string; value: string }>();
  const saved: { token: string; repo: string; name: string; value: string }[] = [];
  const deps: SaverDeps = {
    pending: async () => {
      if (opts.enabled === false) return null;
      polls += 1;
      if (polls > (opts.landsAfter ?? 0)) pendingOnBox.set("codex", { secret: "FREEAGENT_CODEX_AUTH", value: "b64" });
      return { repo: "polats/freeagent", pending: [...pendingOnBox.keys()] };
    },
    take: async (agent) => pendingOnBox.get(agent) ?? null,
    done: async (agent) => {
      pendingOnBox.delete(agent);
    },
    save: async (input) => {
      if (opts.saveFails) throw opts.saveFails;
      saved.push(input);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, saved, pendingOnBox, polls: () => polls };
}

describe("runAccountSaver", () => {
  beforeEach(() => dismissAccountSave());

  it("waits for the sign-in, saves it scoped to the box's repo, then clears the box's copy", async () => {
    const w = world({ landsAfter: 3 });
    await runAccountSaver({ agent: "codex", githubToken: "gho_x" }, w.deps);
    expect(w.saved).toEqual([{ token: "gho_x", repo: "polats/freeagent", name: "FREEAGENT_CODEX_AUTH", value: "b64" }]);
    expect(w.pendingOnBox.size).toBe(0);
    expect(getAccountSaveState()).toEqual({ kind: "saved", agent: "codex" });
    expect(w.polls()).toBe(4);
  });

  it("keeps the box's copy when the save fails, so opening the box again retries", async () => {
    const w = world({ saveFails: new GithubSecretError("save", 403) });
    await runAccountSaver({ agent: "codex", githubToken: "gho_x" }, w.deps);
    expect(w.pendingOnBox.size).toBe(1);
    expect(getAccountSaveState()).toEqual({ kind: "failed", agent: "codex", reason: "save 403" });
  });

  it("with no GitHub token, says where to save it and touches nothing", async () => {
    const w = world();
    await runAccountSaver({ agent: "codex", githubToken: null }, w.deps);
    expect(w.saved).toEqual([]);
    expect(w.pendingOnBox.size).toBe(1);
    expect(getAccountSaveState()).toEqual({ kind: "no-token", agent: "codex" });
  });

  it("without an agent to wait for, saves what is already waiting and stops after one look", async () => {
    const w = world({ landsAfter: 5 });
    await runAccountSaver({ agent: null, githubToken: "gho_x" }, w.deps);
    expect(w.polls()).toBe(1);
    expect(w.saved).toEqual([]);
  });

  it("gives up when the sign-in window closes", async () => {
    const w = world({ landsAfter: Number.POSITIVE_INFINITY });
    await runAccountSaver({ agent: "codex", githubToken: "gho_x" }, w.deps);
    expect(w.saved).toEqual([]);
    expect(w.polls()).toBe(SIGN_IN_WINDOW_MS / 2000 + 1);
  });

  it("does nothing on a box where accounts are off", async () => {
    const w = world({ enabled: false });
    await runAccountSaver({ agent: "codex", githubToken: "gho_x" }, w.deps);
    expect(getAccountSaveState()).toEqual({ kind: "idle" });
  });
});
