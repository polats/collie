// The cloud-auth hand-off (docs/deployment.md → Variant F).
//
// A page that just created this bridge — a landing page duplicating a Space, say — knows the
// bridge's root secret (`COLLIE_AUTH_TOKEN`) because it generated it. It hands the phone that
// secret ONCE, in the URL fragment: `https://box.example/#token=<secret>`. A fragment never leaves
// the browser (it is not sent in the request, so it is not in any access log), and this module
// consumes it before the app renders: it trades the secret for a device token of this phone's own
// via `POST /api/pair/token`, stores that like any paired token, and strips the fragment from the
// URL so a reload, a share or a screenshot does not carry the root secret anywhere.
//
// Nothing here runs when there is no fragment, which is every load but the first.

import { TOKEN_STORAGE_KEY, getDeviceToken, setDeviceToken } from "./pairing";

/** The fragment parameter carrying the root secret. */
export const TOKEN_FRAGMENT_KEY = "token";

/**
 * The root secret a fragment carries, or null. `#token=abc`, `#token=abc&x=y` and `#x=y&token=abc`
 * all answer `abc`; anything else — no fragment, another key, an empty value — answers null.
 * Pure, so the shapes are unit-tested without a window.
 */
export function tokenFromFragment(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return null;
  const params = new URLSearchParams(raw);
  const token = params.get(TOKEN_FRAGMENT_KEY);
  return token !== null && token.trim() !== "" ? token.trim() : null;
}

/** A label for the device being enrolled — readable under Settings, unique enough not to collide. */
export function defaultDeviceLabel(now: Date = new Date(), ua: string = navigator.userAgent): string {
  const kind = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : "Browser";
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  return `${kind} ${stamp}`;
}

/**
 * Consume a `#token=` fragment if there is one: enrol this device with it and store the device
 * token. Resolves once the URL is clean, whether or not enrolment succeeded — a failure is not
 * fatal (the app then shows the ordinary "pair this device" path), but the secret must not stay in
 * the address bar either way. Idempotent: a device that already holds a token skips the exchange.
 */
/** The two window facets the bootstrap touches — narrow so a test can hand in a plain object. */
export interface BootstrapWindow {
  location: Pick<Location, "hash" | "pathname" | "search">;
  history: Pick<History, "replaceState">;
}

export async function bootstrapPairingFromFragment(
  win: BootstrapWindow = window,
  enroll: (rootToken: string, label: string) => Promise<{ token: string }> = enrollWithRootToken,
): Promise<"paired" | "already-paired" | "failed" | "none"> {
  const rootToken = tokenFromFragment(win.location.hash);
  if (rootToken === null) return "none";
  const clean = () => {
    try {
      win.history.replaceState(null, "", win.location.pathname + win.location.search);
    } catch {
      // A history API that refuses (sandboxed frame) leaves the fragment; nothing else to do.
    }
  };
  if (getDeviceToken() !== null) {
    clean();
    return "already-paired";
  }
  try {
    const { token } = await enroll(rootToken, defaultDeviceLabel());
    setDeviceToken(token);
    clean();
    return "paired";
  } catch {
    clean();
    return "failed";
  }
}

/** `POST /api/pair/token` with the root secret as the bearer. Kept out of api.ts's `req` so the
 * root secret never rides the device-token header path — this is the one request that authorises
 * with something other than this device's own token. */
async function enrollWithRootToken(rootToken: string, label: string): Promise<{ token: string }> {
  const res = await fetch("/api/pair/token", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${rootToken}` },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error(`/api/pair/token → ${res.status}`);
  const body = (await res.json()) as { token?: unknown };
  if (typeof body.token !== "string" || body.token === "") throw new Error("no token in reply");
  return { token: body.token };
}

// Re-exported so a caller can assert the storage key without importing pairing.ts as well.
export { TOKEN_STORAGE_KEY };
