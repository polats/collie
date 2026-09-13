// ── PAIRING BY PROVIDER IDENTITY ────────────────────────────────────────────────────────────────
//
// A box on a public PaaS URL has one owner: the account that created it. `POST /api/pair/github`
// lets that owner enrol a device by proving who they are to GitHub instead of by holding the root
// secret or reading a code off a terminal they cannot reach. The phone sends a GitHub access token
// as the bearer; this module asks GitHub whose token it is and answers whether that login is the
// configured owner (`COLLIE_GITHUB_OWNER`). The token is used for that one question and dropped —
// nothing here stores it, logs it, or hands it on.
//
// Kept apart from server.ts for the same reason the STT providers are: the route lives inside
// `Bun.serve`, so the only thing a test can hold is a function with the network behind a seam.

import type { JsonValue } from "./json";
import { jsonRecord, jsonStringField } from "./stt/json";

/** The one outbound call, injectable so a test can answer as GitHub would. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export const GITHUB_USER_URL = "https://api.github.com/user";
/** GitHub's `/user` normally answers well under a second; this bounds a stalled edge, not a slow one. */
export const IDENTITY_TIMEOUT_MS = 10_000;

/**
 * What verification concluded. Three refusals on purpose: the phone's remedy differs for each —
 * sign in to GitHub again, sign in as the right account, or try again later — and a proxy's status
 * must never be mistaken for GitHub's own answer.
 */
export type OwnerVerdict =
  | { ok: true; login: string }
  | { ok: false; reason: "unauthorized" | "not-owner" | "upstream" };

/**
 * Whether `token` belongs to GitHub user `owner`. Logins are compared case-insensitively, as
 * GitHub itself treats them. `owner` empty is the feature off and answers `not-owner` — a bridge
 * with no owner configured must never enrol anyone this way, whatever GitHub says.
 */
export async function verifyGithubOwner(
  token: string,
  owner: string,
  fetchFn: FetchFn = (url, init) => fetch(url, init),
): Promise<OwnerVerdict> {
  if (owner.trim() === "" || token.trim() === "") return { ok: false, reason: "not-owner" };
  let res: Response;
  try {
    res = await fetchFn(GITHUB_USER_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "collie-pair-github",
      },
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "upstream" };
  }
  if (res.status === 401) return { ok: false, reason: "unauthorized" };
  if (!res.ok) return { ok: false, reason: "upstream" };
  let body: JsonValue;
  try {
    // SAFETY: `Response.json()` output IS a JsonValue by construction; the one field used is
    // shape-checked below.
    body = (await res.json()) as JsonValue;
  } catch {
    return { ok: false, reason: "upstream" };
  }
  const login = jsonStringField(jsonRecord(body)?.login);
  if (login === null || login === "") return { ok: false, reason: "upstream" };
  return login.toLowerCase() === owner.trim().toLowerCase()
    ? { ok: true, login }
    : { ok: false, reason: "not-owner" };
}
