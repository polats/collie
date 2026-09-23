import { blake2b } from "blakejs";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { GithubSecretError, saveCodespacesSecret, sealForGithub } from "./github-secrets";

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** crypto_box_seal_open, the other half, so a round trip proves GitHub can read what we send. */
function open(sealed: string, kp: nacl.BoxKeyPair): string | null {
  const bytes = unb64(sealed);
  const epk = bytes.slice(0, 32);
  const nonceInput = new Uint8Array(64);
  nonceInput.set(epk);
  nonceInput.set(kp.publicKey, 32);
  const plain = nacl.box.open(bytes.slice(32), new Uint8Array(blake2b(nonceInput, undefined, 24)), epk, kp.secretKey);
  return plain === null ? null : new TextDecoder().decode(plain);
}

describe("sealForGithub", () => {
  it("round-trips through a libsodium-shaped sealed box", () => {
    const kp = nacl.box.keyPair();
    const sealed = sealForGithub(b64(kp.publicKey), "sk-ant-oat01-example");
    expect(open(sealed, kp)).toBe("sk-ant-oat01-example");
    // 32-byte ephemeral key + 16-byte MAC + the message.
    expect(unb64(sealed).length).toBe(32 + 16 + "sk-ant-oat01-example".length);
  });
  it("uses a fresh ephemeral key every time", () => {
    const kp = nacl.box.keyPair();
    expect(sealForGithub(b64(kp.publicKey), "x")).not.toBe(sealForGithub(b64(kp.publicKey), "x"));
  });
  it("refuses a key of the wrong size", () => {
    expect(() => sealForGithub(b64(new Uint8Array(16)), "x")).toThrow();
  });
});

describe("saveCodespacesSecret", () => {
  const kp = nacl.box.keyPair();
  function github(overrides: Partial<Record<"repo" | "key" | "put", number>> = {}) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const impl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/repos/polats/freeagent")) {
        return new Response(JSON.stringify({ id: 42 }), { status: overrides.repo ?? 200 });
      }
      if (url.endsWith("/user/codespaces/secrets/public-key")) {
        return new Response(JSON.stringify({ key: b64(kp.publicKey), key_id: "k1" }), { status: overrides.key ?? 200 });
      }
      return new Response(null, { status: overrides.put ?? 201 });
    };
    return { impl, calls };
  }

  it("seals to the user's key and scopes the secret to the one repository", async () => {
    const { impl, calls } = github();
    await saveCodespacesSecret({ token: "gho_x", repo: "polats/freeagent", name: "FREEAGENT_CODEX_AUTH", value: "v" }, impl);
    const put = calls.at(-1)!;
    expect(put.url).toBe("https://api.github.com/user/codespaces/secrets/FREEAGENT_CODEX_AUTH");
    expect(put.init?.method).toBe("PUT");
    const body = JSON.parse(String(put.init?.body));
    expect(body.key_id).toBe("k1");
    expect(body.selected_repository_ids).toEqual([42]);
    expect(open(body.encrypted_value, kp)).toBe("v");
    // The value never travels in the clear.
    expect(String(put.init?.body)).not.toContain('"v"');
    for (const c of calls) expect(new Headers(c.init?.headers).get("authorization")).toBe("Bearer gho_x");
  });

  it("names the step that failed", async () => {
    await expect(
      saveCodespacesSecret({ token: "t", repo: "polats/freeagent", name: "FREEAGENT_X", value: "v" }, github({ put: 403 }).impl),
    ).rejects.toEqual(new GithubSecretError("save", 403));
    await expect(
      saveCodespacesSecret({ token: "t", repo: "polats/freeagent", name: "FREEAGENT_X", value: "v" }, github({ repo: 404 }).impl),
    ).rejects.toEqual(new GithubSecretError("repository", 404));
  });
});
