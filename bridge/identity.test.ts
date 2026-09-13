import { describe, expect, test } from "bun:test";

import { GITHUB_USER_URL, verifyGithubOwner, type FetchFn } from "./identity";

// The whole route rests on this one question — "is this GitHub token the owner's?" — so every
// answer GitHub can give is pinned here, and so is what the bridge sends it.

function github(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return answer();
  };
  return { fetchFn, calls };
}

describe("verifyGithubOwner", () => {
  test("asks /user with the token as the bearer and nothing else about it", async () => {
    const { fetchFn, calls } = github(() => Response.json({ login: "polats" }));
    expect(await verifyGithubOwner("gho_x", "polats", fetchFn)).toEqual({ ok: true, login: "polats" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(GITHUB_USER_URL);
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer gho_x");
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("logins compare case-insensitively, as GitHub's do", async () => {
    const { fetchFn } = github(() => Response.json({ login: "Polats" }));
    expect(await verifyGithubOwner("t", " polats ", fetchFn)).toEqual({ ok: true, login: "Polats" });
  });

  test("another account's token is not the owner", async () => {
    const { fetchFn } = github(() => Response.json({ login: "someone-else" }));
    expect(await verifyGithubOwner("t", "polats", fetchFn)).toEqual({ ok: false, reason: "not-owner" });
  });

  test("no owner configured, or no token, is a refusal before GitHub is asked", async () => {
    const { fetchFn, calls } = github(() => Response.json({ login: "polats" }));
    expect(await verifyGithubOwner("t", "", fetchFn)).toEqual({ ok: false, reason: "not-owner" });
    expect(await verifyGithubOwner("", "polats", fetchFn)).toEqual({ ok: false, reason: "not-owner" });
    expect(calls).toHaveLength(0);
  });

  test("GitHub's 401 is the token's problem; anything else GitHub-side is upstream", async () => {
    expect(await verifyGithubOwner("t", "polats", github(() => new Response("bad credentials", { status: 401 })).fetchFn)).toEqual({ ok: false, reason: "unauthorized" });
    expect(await verifyGithubOwner("t", "polats", github(() => new Response("rate limited", { status: 403 })).fetchFn)).toEqual({ ok: false, reason: "upstream" });
    expect(await verifyGithubOwner("t", "polats", github(() => new Response("down", { status: 503 })).fetchFn)).toEqual({ ok: false, reason: "upstream" });
    expect(await verifyGithubOwner("t", "polats", github(() => new Response("<html>", { status: 200 })).fetchFn)).toEqual({ ok: false, reason: "upstream" });
    expect(await verifyGithubOwner("t", "polats", github(() => Response.json({ id: 1 })).fetchFn)).toEqual({ ok: false, reason: "upstream" });
    expect(await verifyGithubOwner("t", "polats", github(() => { throw new Error("ECONNRESET"); }).fetchFn)).toEqual({ ok: false, reason: "upstream" });
  });
});
