// ── AGENT ACCOUNTS: SIGN IN ONCE, SAVED FOR EVERY BOX ────────────────────────
//
// A cloud box signs in to an agent account (Claude, ChatGPT/Codex) once, with the agent's own
// sign-in running in a pane (`POST /api/accounts/connect`, server.ts). The operator's connect
// command leaves what it got as `<accountsDir>/pending/<agent>.json` = `{secret, value}`: the name
// of the secret to save it under and its value. The phone takes that payload over the routes below
// and saves it to the user's OWN GitHub account — a Codespaces user secret scoped to the box's
// repository, which GitHub injects into every new box — with a GitHub token it holds in memory.
// That token never reaches the bridge; the payload is the only thing that crosses, and only to a
// device that passed the write gate.
//
// The file is deleted only when the phone says the save worked (`done`), so a failed save can be
// retried instead of losing a sign-in. This module is the file half, pure enough to test with a
// temporary directory; the routes are in server.ts beside `/api/checkout`, which they mirror.

import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";

/** The record inside a parsed JSON body, or null when it isn't one. */
function asJsonRecord(value: JsonValue | undefined): JsonObject | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** The agents an account can be connected for. The connect command is given one of these, verbatim. */
export const ACCOUNT_AGENTS = ["claude", "codex"] as const;
export type AccountAgent = (typeof ACCOUNT_AGENTS)[number];

/** An agent name from an untrusted body, or null. It is spliced into a shell line, so it is an allowlist. */
export function parseAccountAgent(v: JsonValue | undefined): AccountAgent | null {
  const agent = asJsonRecord(v)?.agent;
  return ACCOUNT_AGENTS.find((known) => known === agent) ?? null;
}

/**
 * A saved account ready for the phone. `secret` must be a `FREEAGENT_*` name (so a payload can never
 * name, and so overwrite, an unrelated secret of the user's) and `value` fits GitHub's 48 KB cap.
 */
export interface PendingAccount {
  secret: string;
  value: string;
}

const SECRET_NAME = /^FREEAGENT_[A-Z0-9_]{1,90}$/;
const MAX_VALUE_BYTES = 48 * 1024;

/** Validate a pending file's parsed contents. Pure + exported for tests. */
export function parsePendingAccount(v: JsonValue | undefined): PendingAccount | null {
  const o = asJsonRecord(v);
  if (o === null) return null;
  const secret = typeof o.secret === "string" && SECRET_NAME.test(o.secret) ? o.secret : null;
  const value =
    typeof o.value === "string" && o.value !== "" && new TextEncoder().encode(o.value).length <= MAX_VALUE_BYTES
      ? o.value
      : null;
  return secret !== null && value !== null ? { secret, value } : null;
}

function pendingPath(dir: string, agent: AccountAgent): string {
  return join(dir, "pending", `${agent}.json`);
}

/** The agents whose sign-in is waiting to be saved, in {@link ACCOUNT_AGENTS} order. */
export async function pendingAgents(dir: string): Promise<AccountAgent[]> {
  let names: string[];
  try {
    names = await readdir(join(dir, "pending"));
  } catch {
    return [];
  }
  return ACCOUNT_AGENTS.filter((agent) => names.includes(`${agent}.json`));
}

/** One agent's waiting payload, or null when there is none or it is malformed. Does not delete it. */
export async function readPendingAccount(dir: string, agent: AccountAgent): Promise<PendingAccount | null> {
  let raw: string;
  try {
    raw = await readFile(pendingPath(dir, agent), "utf8");
  } catch {
    return null;
  }
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; `parsePendingAccount` re-checks
    // every field before any of it is used.
    return parsePendingAccount(JSON.parse(raw) as JsonValue);
  } catch {
    return null;
  }
}

/** Forget one agent's payload once the phone has saved it. True when there was one to delete. */
export async function clearPendingAccount(dir: string, agent: AccountAgent): Promise<boolean> {
  try {
    await unlink(pendingPath(dir, agent));
    return true;
  } catch {
    return false;
  }
}
