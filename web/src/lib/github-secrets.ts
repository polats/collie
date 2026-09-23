// Saving a connected agent account to the user's own GitHub account.
//
// A cloud box signs in to an agent once (bridge/accounts.ts). The result is saved as a GitHub
// Codespaces USER secret scoped to the box's repository, which GitHub injects into every new box
// made from it, so the next box starts signed in. The save happens HERE, in the browser, with a
// GitHub token this page holds in memory (lib/accounts-connect.ts): that token can read and write
// the user's repositories, and it never reaches the box.
//
// GitHub accepts a secret only encrypted to the account's public key, as a libsodium sealed box:
// an ephemeral X25519 key pair, a nonce of blake2b-192(ephemeral public key ‖ recipient key), and
// crypto_box of the value; the output is the ephemeral public key followed by the ciphertext. That is
// ~10 lines over tweetnacl + blakejs instead of the 200 KB libsodium build.

import { blake2b } from "blakejs";
import nacl from "tweetnacl";

import { asJsonNumber, asJsonString, parseJsonObject } from "./json";

const API = "https://api.github.com";

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** `crypto_box_seal(value, recipientKey)`, base64 in and out, as GitHub's secrets API wants it. */
export function sealForGithub(recipientKeyB64: string, value: string): string {
  const recipient = fromBase64(recipientKeyB64);
  if (recipient.length !== nacl.box.publicKeyLength) throw new Error("bad public key");
  const ephemeral = nacl.box.keyPair();
  const nonceInput = new Uint8Array(ephemeral.publicKey.length + recipient.length);
  nonceInput.set(ephemeral.publicKey);
  nonceInput.set(recipient, ephemeral.publicKey.length);
  // Copied into this realm's Uint8Array: tweetnacl type-checks with `instanceof`, and TextEncoder
  // or blakejs may hand back one from another realm (a worker, a test environment).
  const nonce = new Uint8Array(blake2b(nonceInput, undefined, nacl.box.nonceLength));
  const message = new Uint8Array(new TextEncoder().encode(value));
  const cipher = nacl.box(message, nonce, recipient, ephemeral.secretKey);
  const sealed = new Uint8Array(ephemeral.publicKey.length + cipher.length);
  sealed.set(ephemeral.publicKey);
  sealed.set(cipher, ephemeral.publicKey.length);
  return toBase64(sealed);
}

/** Why a save did not happen, in the words the page shows. */
export class GithubSecretError extends Error {
  readonly step: "repository" | "key" | "save";
  readonly status: number;
  constructor(step: "repository" | "key" | "save", status: number) {
    super(`GitHub ${step} → ${status}`);
    this.step = step;
    this.status = status;
  }
}

export interface SaveSecretInput {
  token: string;
  /** `owner/name` the secret is scoped to — the repository new boxes are created from. */
  repo: string;
  name: string;
  value: string;
}

/**
 * Save one Codespaces user secret, scoped to one repository. Replaces an existing secret of the same
 * name, which is how connecting again (or as another account) takes effect on the next box.
 */
export async function saveCodespacesSecret(input: SaveSecretInput, fetchImpl: typeof fetch = fetch): Promise<void> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${input.token}`,
    "x-github-api-version": "2022-11-28",
  };
  const repoRes = await fetchImpl(`${API}/repos/${input.repo}`, { headers });
  if (!repoRes.ok) throw new GithubSecretError("repository", repoRes.status);
  // Parsed at the I/O boundary with the JSON helpers, like every other reply (lib/json.ts).
  const repoId = asJsonNumber(parseJsonObject(await repoRes.text())?.id);
  const keyRes = await fetchImpl(`${API}/user/codespaces/secrets/public-key`, { headers });
  if (!keyRes.ok) throw new GithubSecretError("key", keyRes.status);
  const keyBody = parseJsonObject(await keyRes.text());
  const key = asJsonString(keyBody?.key);
  const keyId = asJsonString(keyBody?.key_id);
  if (repoId === undefined || key === undefined || keyId === undefined) throw new GithubSecretError("key", 0);
  const put = await fetchImpl(`${API}/user/codespaces/secrets/${encodeURIComponent(input.name)}`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      encrypted_value: sealForGithub(key, input.value),
      key_id: keyId,
      selected_repository_ids: [repoId],
    }),
  });
  if (!put.ok) throw new GithubSecretError("save", put.status);
}
