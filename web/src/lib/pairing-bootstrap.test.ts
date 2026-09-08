import { describe, expect, it } from "vitest";

import { bootstrapCheckoutFromFragment, bootstrapPairingFromFragment, defaultDeviceLabel, repoFromFragment, tokenFromFragment } from "./pairing-bootstrap";
import { TOKEN_STORAGE_KEY } from "./pairing";

describe("tokenFromFragment", () => {
  it("reads the token wherever it sits in the fragment", () => {
    expect(tokenFromFragment("#token=abc")).toBe("abc");
    expect(tokenFromFragment("#token=abc&x=y")).toBe("abc");
    expect(tokenFromFragment("#x=y&token=abc")).toBe("abc");
    expect(tokenFromFragment("token=abc")).toBe("abc");
  });
  it("answers null for no fragment, another key, or an empty value", () => {
    expect(tokenFromFragment("")).toBeNull();
    expect(tokenFromFragment("#")).toBeNull();
    expect(tokenFromFragment("#s=demo")).toBeNull();
    expect(tokenFromFragment("#token=")).toBeNull();
    expect(tokenFromFragment("#token=%20")).toBeNull();
  });
});

describe("defaultDeviceLabel", () => {
  it("names the platform and the minute", () => {
    const at = new Date("2026-09-07T08:30:00Z");
    expect(defaultDeviceLabel(at, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("iPhone 2026-09-07 08:30");
    expect(defaultDeviceLabel(at, "Mozilla/5.0 (Linux; Android 14)")).toBe("Android 2026-09-07 08:30");
    expect(defaultDeviceLabel(at, "Mozilla/5.0 (X11; Linux)")).toBe("Browser 2026-09-07 08:30");
  });
});

describe("bootstrapPairingFromFragment", () => {
  const win = (hash: string) => {
    const calls: string[] = [];
    return {
      calls,
      win: {
        location: { hash, pathname: "/", search: "" },
        history: {
          // The stub records only the URL argument; History's `data` and `unused` are irrelevant here.
          replaceState: (_data: null, _unused: string, url?: string | URL | null) => {
            calls.push(String(url));
          },
        },
      },
    };
  };
  it("does nothing without a fragment", async () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    const w = win("");
    expect(await bootstrapPairingFromFragment(w.win, async () => ({ token: "never" }))).toBe("none");
    expect(w.calls).toEqual([]);
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
  it("trades the root secret for a device token, stores it, and cleans the URL", async () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    const w = win("#token=root-secret");
    const seen: string[] = [];
    const result = await bootstrapPairingFromFragment(w.win, async (root) => {
      seen.push(root);
      return { token: "device-token" };
    });
    expect(result).toBe("paired");
    expect(seen).toEqual(["root-secret"]);
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("device-token");
    expect(w.calls).toEqual(["/"]);
  });
  it("skips the exchange when a device token already exists, but still cleans the URL", async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, "existing");
    const w = win("#token=root-secret");
    expect(await bootstrapPairingFromFragment(w.win, async () => ({ token: "new" }))).toBe("already-paired");
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("existing");
    expect(w.calls).toEqual(["/"]);
  });
  it("cleans the URL even when enrolment fails", async () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    const w = win("#token=root-secret");
    expect(await bootstrapPairingFromFragment(w.win, async () => { throw new Error("403"); })).toBe("failed");
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(w.calls).toEqual(["/"]);
  });
  it("keeps the rest of the fragment for the checkout step and drops only the secret", async () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    const w = win("#token=root&repo=polats/freeagent");
    expect(await bootstrapPairingFromFragment(w.win, async () => ({ token: "dev" }))).toBe("paired");
    expect(w.calls).toEqual(["/#repo=polats%2Ffreeagent"]);
  });
});

describe("repoFromFragment", () => {
  it("accepts owner/name and nothing else", () => {
    expect(repoFromFragment("#repo=polats/freeagent")).toBe("polats/freeagent");
    expect(repoFromFragment("#token=x&repo=a/b.c")).toBe("a/b.c");
    expect(repoFromFragment("#repo=freeagent")).toBeNull();
    expect(repoFromFragment("#repo=a/b/c")).toBeNull();
    expect(repoFromFragment("#repo=-a/b")).toBeNull();
    expect(repoFromFragment("")).toBeNull();
  });
});

describe("bootstrapCheckoutFromFragment", () => {
  const win = (hash: string) => {
    const calls: string[] = [];
    return { calls, win: { location: { hash, pathname: "/", search: "" }, history: { replaceState: (_d: null, _u: string, url?: string | URL | null) => { calls.push(String(url)); } } } };
  };
  it("does nothing without a repo", async () => {
    const w = win("#token=only");
    expect(await bootstrapCheckoutFromFragment(w.win, async () => ({ paneId: "never" }))).toBeNull();
    expect(w.calls).toEqual([]);
  });
  it("asks for the checkout with the token, answers the pane, and cleans the URL", async () => {
    const w = win("#repo=polats/freeagent&gh=ghp_x");
    const seen: unknown[] = [];
    const pane = await bootstrapCheckoutFromFragment(w.win, async (repo, token) => { seen.push([repo, token]); return { paneId: "w2:p1" }; });
    expect(pane).toBe("w2:p1");
    expect(seen).toEqual([["polats/freeagent", "ghp_x"]]);
    expect(w.calls).toEqual(["/"]);
  });
  it("answers null when the bridge declines, URL cleaned all the same", async () => {
    const w = win("#repo=polats/freeagent");
    expect(await bootstrapCheckoutFromFragment(w.win, async () => null)).toBeNull();
    expect(w.calls).toEqual(["/"]);
  });
});
