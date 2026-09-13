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
// A second credential rides the same fragment: `#gh=<GitHub access token>`. A box whose bridge
// knows its owner (`COLLIE_GITHUB_OWNER`) enrols a device that proves it holds the owner's GitHub
// sign-in, via `POST /api/pair/github`, so a landing page the user signed in to with GitHub can
// open the box from ANY device without the root secret ever leaving the box's creation. The
// GitHub token is used for that one exchange and dropped, on both ends. When both credentials are
// present GitHub is tried first, and the root secret is the fallback.
//
// The fragment arrives on later loads too: a landing page that keeps the secret per box appends it
// on every open. Those loads are how a phone RECOVERS after the bridge lost its pairing registry
// (a container without a volume that slept and woke, a rebuild, a factory reset): the stored device
// token is dead, every /api answer is `403 device not paired`, and the only credential that still
// works is the root secret in the fragment. So a device that already holds a token first asks the
// bridge whether the token is still good, and re-enrols with the secret only when it is not.
//
// Nothing here runs when there is no fragment, which is every load on a bridge that was not handed
// one.

import { asJsonObject, asJsonString, parseJsonObject } from "./json";
import { NOT_PAIRED_BODY, TOKEN_STORAGE_KEY, authHeader, getDeviceToken, setDeviceToken } from "./pairing";

/** The fragment parameter carrying the root secret. */
export const TOKEN_FRAGMENT_KEY = "token";
/** Fragment parameters naming a repository to check out on first load, and its access token. */
export const REPO_FRAGMENT_KEY = "repo";
/**
 * A GitHub access token. It serves two consumers: pairing by identity (this module's first step),
 * and a private repository's checkout (`bootstrapCheckoutFromFragment`), which is why the pairing
 * step leaves it in the fragment while a `repo=` is present and strips it otherwise.
 */
export const REPO_TOKEN_FRAGMENT_KEY = "gh";

/** One fragment parameter's trimmed value, or null when absent or blank. */
function fragmentParam(hash: string, key: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return null;
  const value = new URLSearchParams(raw).get(key);
  return value !== null && value.trim() !== "" ? value.trim() : null;
}

/** `owner/name` from a `#repo=` fragment, or null. Shape-checked here; the bridge re-validates. */
export function repoFromFragment(hash: string): string | null {
  const repo = fragmentParam(hash, REPO_FRAGMENT_KEY);
  return repo !== null && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : null;
}

/**
 * The root secret a fragment carries, or null. `#token=abc`, `#token=abc&x=y` and `#x=y&token=abc`
 * all answer `abc`; anything else — no fragment, another key, an empty value — answers null.
 * Pure, so the shapes are unit-tested without a window.
 */
export function tokenFromFragment(hash: string): string | null {
  return fragmentParam(hash, TOKEN_FRAGMENT_KEY);
}

/** A label for the device being enrolled — readable under Settings, unique enough not to collide. */
export function defaultDeviceLabel(now: Date = new Date(), ua: string = navigator.userAgent): string {
  const kind = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : "Browser";
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  return `${kind} ${stamp}`;
}

/** The two window facets the bootstrap touches — narrow so a test can hand in a plain object. */
export interface BootstrapWindow {
  location: Pick<Location, "hash" | "pathname" | "search">;
  history: Pick<History, "replaceState">;
}

/**
 * What the bridge says about the device token this phone already holds. `stale` is the one verdict
 * that changes anything: the bridge answered and does not know the token. `unknown` (unreachable,
 * an unexpected status) leaves the token alone — no evidence is not evidence of a dead token.
 */
export type StoredTokenVerdict = "valid" | "stale" | "unknown";

/** What one run of the bootstrap did. `re-paired` is `paired` for a device whose token had died. */
export type BootstrapResult = "paired" | "re-paired" | "already-paired" | "failed" | "none";

/**
 * Something the fragment carried that can mint a device token: the bridge's root secret, or a
 * GitHub access token of the bridge's owner. Each has its own door on the bridge.
 */
export interface PairingCredential {
  kind: "root" | "github";
  token: string;
}

/** The credentials a fragment carries, in the order they are tried: GitHub identity, then root. */
export function credentialsFromFragment(hash: string): PairingCredential[] {
  const out: PairingCredential[] = [];
  const gh = fragmentParam(hash, REPO_TOKEN_FRAGMENT_KEY);
  if (gh !== null) out.push({ kind: "github", token: gh });
  const root = tokenFromFragment(hash);
  if (root !== null) out.push({ kind: "root", token: root });
  return out;
}

/**
 * Consume a `#token=` fragment if there is one: enrol this device with it and store the device
 * token. Resolves once the URL is clean, whether or not enrolment succeeded — a failure is not
 * fatal (the app then shows the ordinary "pair this device" path), but the secret must not stay in
 * the address bar either way.
 *
 * A device that already holds a token does not blindly skip the exchange: it asks the bridge
 * whether that token is still recognised (`probe`) and re-enrols only on a definite "no". A bridge
 * that lost its registry — the wake-from-sleep case — is thus healed by the same fragment the
 * landing page sends on every open, and a bridge that still knows the phone mints nothing new.
 */
export async function bootstrapPairingFromFragment(
  win: BootstrapWindow = window,
  enroll: (credential: PairingCredential, label: string) => Promise<{ token: string }> = enrollWithCredential,
  probe: () => Promise<StoredTokenVerdict> = probeStoredToken,
): Promise<BootstrapResult> {
  const credentials = credentialsFromFragment(win.location.hash);
  if (credentials.length === 0) return "none";
  // Pairing is the first thing the fragment asks for, but not always the only thing (see
  // `bootstrapCheckoutFromFragment`): keep the rest of the fragment for that step, drop the
  // secrets — the GitHub token too, unless a `repo=` still needs it for the checkout, which strips
  // the whole fragment when it is done.
  const clean = () => {
    try {
      const rest = new URLSearchParams(win.location.hash.replace(/^#/, ""));
      rest.delete(TOKEN_FRAGMENT_KEY);
      if (!rest.has(REPO_FRAGMENT_KEY)) rest.delete(REPO_TOKEN_FRAGMENT_KEY);
      const hash = rest.toString();
      win.history.replaceState(null, "", win.location.pathname + win.location.search + (hash ? `#${hash}` : ""));
    } catch {
      // A history API that refuses (sandboxed frame) leaves the fragment; nothing else to do.
    }
  };
  const held = getDeviceToken() !== null;
  if (held && (await probe()) !== "stale") {
    clean();
    return "already-paired";
  }
  const label = defaultDeviceLabel();
  for (const credential of credentials) {
    try {
      const { token } = await enroll(credential, label);
      // Replaces the dead token only now, on success: a failed re-enrolment leaves the old one in
      // place, so the refusal latch (lib/api.ts) can still show the pairing path instead of a
      // device that silently forgot it was ever paired.
      setDeviceToken(token);
      clean();
      return held ? "re-paired" : "paired";
    } catch {
      // Try the next credential; the root secret backs the identity door up.
    }
  }
  clean();
  return "failed";
}

/**
 * Ask the bridge whether the stored device token still names a paired device. `GET /api/devices` is
 * read-level and answers `current`: this token's label, or null when it authenticated as nobody.
 * Under cloud auth an unknown token never gets that far — it is refused with the pairing gate's own
 * `403 device not paired`, which is the same verdict. Anything else (unreachable, 5xx, a proxy's
 * page) is `unknown`: the token may well be fine and the bridge is simply not answering yet.
 */
export async function probeStoredToken(): Promise<StoredTokenVerdict> {
  try {
    const res = await fetch("/api/devices", { headers: authHeader() });
    if (res.status === 403) return (await res.text()).trim() === NOT_PAIRED_BODY ? "stale" : "unknown";
    if (!res.ok) return "unknown";
    const current = asJsonString(parseJsonObject(await res.text())?.current);
    return current !== undefined && current !== "" ? "valid" : "stale";
  } catch {
    return "unknown";
  }
}

/**
 * Consume a `#repo=owner/name[&gh=<token>]` fragment: ask the bridge to check the repository out
 * (`POST /api/checkout`, which opens a Space and runs the operator's clone command in it) and answer
 * the pane to show, or null when there was nothing to do or the bridge declined. The fragment is
 * stripped either way so a reload does not clone twice or keep a token in the address bar.
 */
export async function bootstrapCheckoutFromFragment(
  win: BootstrapWindow = window,
  checkout: (repo: string, token: string | null) => Promise<{ paneId: string } | null> = requestCheckout,
): Promise<string | null> {
  const repo = repoFromFragment(win.location.hash);
  if (repo === null) return null;
  const token = fragmentParam(win.location.hash, REPO_TOKEN_FRAGMENT_KEY);
  try {
    win.history.replaceState(null, "", win.location.pathname + win.location.search);
  } catch {
    // Leave the fragment; the checkout still runs.
  }
  try {
    const result = await checkout(repo, token);
    return result?.paneId ?? null;
  } catch {
    return null;
  }
}

async function requestCheckout(repo: string, token: string | null): Promise<{ paneId: string } | null> {
  const res = await fetch("/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader() },
    body: JSON.stringify(token ? { repo, token } : { repo }),
  });
  if (!res.ok) return null;
  const body = parseJsonObject(await res.text());
  const pane = body?.pane;
  const paneId = asJsonString(asJsonObject(pane)?.paneId);
  return paneId === undefined ? null : { paneId };
}

/** The bridge's door for each credential kind. */
export const PAIRING_DOORS = {
  root: "/api/pair/token",
  github: "/api/pair/github",
} satisfies Record<PairingCredential["kind"], string>;

/** `POST` the credential's door with it as the bearer. Kept out of api.ts's `req` so neither secret
 * ever rides the device-token header path — these are the requests that authorise with something
 * other than this device's own token. */
async function enrollWithCredential(credential: PairingCredential, label: string): Promise<{ token: string }> {
  const door = PAIRING_DOORS[credential.kind];
  const res = await fetch(door, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential.token}` },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error(`${door} → ${res.status}`);
  // Parsed at the I/O boundary with the JSON helpers, like every other bridge reply (lib/json.ts).
  const token = asJsonString(parseJsonObject(await res.text())?.token);
  if (token === undefined || token === "") throw new Error("no token in reply");
  return { token };
}

// Re-exported so a caller can assert the storage key without importing pairing.ts as well.
export { TOKEN_STORAGE_KEY };
