// Connecting an agent account once, for every box (bridge/accounts.ts on the other side).
//
// The page that opened this box (freeagent's landing page) hands it `#connect=<agent>` and the
// user's GitHub token as `#gh=`. Before first render this module asks the bridge to run that agent's
// own sign-in in a pane (`POST /api/accounts/connect`) and the app opens on it. While the user signs
// in there, a small loop watches `GET /api/accounts/pending`; when the sign-in lands it takes the
// payload, saves it to the user's GitHub account as a Codespaces secret (lib/github-secrets.ts) and
// tells the bridge it is done, which deletes the box's copy of the payload.
//
// THE GITHUB TOKEN LIVES IN THIS MODULE'S MEMORY AND NOWHERE ELSE. It is read from the fragment
// before pairing strips it, never stored (no localStorage, no sessionStorage, no bridge route sees
// it), and dropped when the loop ends. That is why the app opens on the sign-in pane with a history
// replace instead of a reload: a reload would forget it. Any open that carries `#gh=` also saves
// whatever is already waiting, so a save that failed is retried by opening the box again.

import { saveCodespacesSecret, GithubSecretError } from "./github-secrets";
import { asJsonObject, asJsonString, parseJsonObject } from "./json";
import { authHeader } from "./pairing";

/** The fragment parameter naming the agent to connect. */
export const CONNECT_FRAGMENT_KEY = "connect";
/** The GitHub token, shared with pairing by identity (lib/pairing-bootstrap.ts). */
const GITHUB_TOKEN_FRAGMENT_KEY = "gh";

export const ACCOUNT_AGENTS = ["claude", "codex"] as const;
export type AccountAgent = (typeof ACCOUNT_AGENTS)[number];

/** How the page names each account. Product names, so never translated. */
export const ACCOUNT_NAMES = { claude: "Claude", codex: "ChatGPT" } satisfies Record<AccountAgent, string>;

function fragmentParam(hash: string, key: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const value = raw === "" ? null : new URLSearchParams(raw).get(key);
  return value !== null && value.trim() !== "" ? value.trim() : null;
}

function asAgent(v: string | null | undefined): AccountAgent | null {
  return ACCOUNT_AGENTS.find((agent) => agent === v) ?? null;
}

/** What the fragment asks for: an agent to connect (maybe), and the GitHub token to save with (maybe). */
export interface ConnectIntent {
  agent: AccountAgent | null;
  githubToken: string | null;
}

/** Read — never strip — the connect intent. Must run before pairing, which removes `gh=`. */
export function connectIntentFromFragment(hash: string): ConnectIntent {
  return {
    agent: asAgent(fragmentParam(hash, CONNECT_FRAGMENT_KEY)),
    githubToken: fragmentParam(hash, GITHUB_TOKEN_FRAGMENT_KEY),
  };
}

// ── What the page shows ───────────────────────────────────────────────────────

export type AccountSaveState =
  | { kind: "idle" }
  | { kind: "saving"; agent: AccountAgent }
  | { kind: "saved"; agent: AccountAgent }
  | { kind: "failed"; agent: AccountAgent; reason: string }
  | { kind: "no-token"; agent: AccountAgent };

let state: AccountSaveState = { kind: "idle" };
const listeners = new Set<() => void>();

function setState(next: AccountSaveState): void {
  state = next;
  for (const l of listeners) l();
}

export function getAccountSaveState(): AccountSaveState {
  return state;
}

export function subscribeAccountSave(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dismissAccountSave(): void {
  setState({ kind: "idle" });
}

// ── The bridge side ───────────────────────────────────────────────────────────

/** What the saver needs from the outside world; injectable so the loop is testable without a bridge. */
export interface SaverDeps {
  pending: () => Promise<{ repo: string; pending: AccountAgent[] } | null>;
  take: (agent: AccountAgent) => Promise<{ secret: string; value: string } | null>;
  done: (agent: AccountAgent) => Promise<void>;
  save: (input: { token: string; repo: string; name: string; value: string }) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

async function bridgePending(): Promise<{ repo: string; pending: AccountAgent[] } | null> {
  const res = await fetch("/api/accounts/pending", { headers: authHeader() });
  if (!res.ok) return null;
  const body = parseJsonObject(await res.text());
  const repo = asJsonString(body?.repo) ?? "";
  const list = Array.isArray(body?.pending) ? body.pending : [];
  return { repo, pending: list.map((a) => asAgent(asJsonString(a))).filter((a) => a !== null) };
}

async function bridgeTake(agent: AccountAgent): Promise<{ secret: string; value: string } | null> {
  const res = await fetch("/api/accounts/take", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader() },
    body: JSON.stringify({ agent }),
  });
  if (!res.ok) return null;
  const body = asJsonObject(parseJsonObject(await res.text()));
  const secret = asJsonString(body?.secret);
  const value = asJsonString(body?.value);
  return secret !== undefined && value !== undefined ? { secret, value } : null;
}

async function bridgeDone(agent: AccountAgent): Promise<void> {
  await fetch("/api/accounts/done", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader() },
    body: JSON.stringify({ agent }),
  });
}

const DEFAULT_DEPS: SaverDeps = {
  pending: bridgePending,
  take: bridgeTake,
  done: bridgeDone,
  save: (input) => saveCodespacesSecret(input),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** How long the page waits for a sign-in to finish before giving up (the Codex device code lives 15 min). */
export const SIGN_IN_WINDOW_MS = 20 * 60 * 1000;
const POLL_MS = 2000;

/**
 * Save what the box has waiting. With an agent, keep watching until that agent's sign-in lands (or
 * the window closes); without one, save whatever is already waiting and stop. The token is a local
 * of this call and goes when it returns.
 */
export async function runAccountSaver(intent: ConnectIntent, deps: SaverDeps = DEFAULT_DEPS): Promise<void> {
  const token = intent.githubToken;
  const until = deps.now() + SIGN_IN_WINDOW_MS;
  const saved = new Set<AccountAgent>();
  for (;;) {
    let listing: Awaited<ReturnType<SaverDeps["pending"]>>;
    try {
      listing = await deps.pending();
    } catch {
      listing = { repo: "", pending: [] };
    }
    if (listing === null) return; // the feature is off on this box
    for (const agent of listing.pending) {
      if (saved.has(agent)) continue;
      if (token === null) {
        setState({ kind: "no-token", agent });
        saved.add(agent);
        continue;
      }
      setState({ kind: "saving", agent });
      try {
        const payload = await deps.take(agent);
        if (payload === null) {
          // Taken by another device between the listing and now; nothing of ours to report.
          setState({ kind: "idle" });
          continue;
        }
        await deps.save({ token, repo: listing.repo, name: payload.secret, value: payload.value });
        await deps.done(agent);
        saved.add(agent);
        setState({ kind: "saved", agent });
      } catch (err) {
        saved.add(agent); // one attempt per open; opening the box again retries
        // GitHub's refusals name their step; anything else is the network.
        const reason =
          err instanceof GithubSecretError ? (err.status === 0 ? err.step : `${err.step} ${err.status}`) : "network";
        setState({ kind: "failed", agent, reason });
      }
    }
    const waitingFor = intent.agent;
    if (waitingFor === null || saved.has(waitingFor) || deps.now() >= until) return;
    await deps.sleep(POLL_MS);
  }
}

/**
 * Consume `#connect=<agent>`: strip the fragment, ask the bridge to open that agent's sign-in, and
 * answer the pane to open on — or null when there was nothing to connect or the bridge declined.
 */
export async function bootstrapConnectFromFragment(
  intent: ConnectIntent,
  win: Pick<Window, "location" | "history"> = window,
): Promise<string | null> {
  if (intent.agent === null) return null;
  try {
    win.history.replaceState(null, "", win.location.pathname + win.location.search);
  } catch {
    // Leave the fragment; the connect still runs.
  }
  try {
    const res = await fetch("/api/accounts/connect", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader() },
      body: JSON.stringify({ agent: intent.agent }),
    });
    if (!res.ok) return null;
    return asJsonString(asJsonObject(parseJsonObject(await res.text())?.pane)?.paneId) ?? null;
  } catch {
    return null;
  }
}
