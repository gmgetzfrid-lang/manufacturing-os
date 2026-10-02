// lib/signInNext.ts
//
// public-surfaces PHYS-14 (identity-and-session Round G) — the sign-in page
// (app/page.tsx) honours `?next=`. A scanned equipment label with no session
// is sent to `/?next=%2Fassets%2F<tag>` (lib/assetSignIn.ts); after signing
// in, the person lands back on the tag instead of the dashboard.
//
// `next` is attacker-controllable (anyone can mint a sign-in link), so it is
// honoured ONLY as a same-origin relative path — never an open redirect:
//
//   * it starts with a single "/" — not "//" or "/\" (protocol-relative: a
//     browser reads both as another host);
//   * no layer of it, decoded byte by byte as often as it decodes, contains a
//     backslash, a control character (a browser strips tab / CR / LF, so
//     "/<TAB>/evil" would become "//evil") or a scheme ("javascript:",
//     "https:", …), and every layer still starts with a single "/";
//   * the URL parser agrees it stays on this origin, and it does not point
//     back at the sign-in page itself ("/", "/?…", "/#…", "/%2e", …).
//
// Anything else — absent, empty, hostile — falls back to exactly today's
// destination, SIGN_IN_DEFAULT_DESTINATION.
//
// The Microsoft sign-in leaves the page for the provider and comes back as a
// NEW page load at `/` (its redirectTo is unchanged, so the provider's
// redirect allow-list sees the URL it always has). `next` crosses that round
// trip in sessionStorage — per tab, same origin — written just before the
// page navigates away, consumed (read once, always removed) by the next load
// of the sign-in page in that tab, validated again on read and honoured only
// for SIGN_IN_NEXT_STASH_TTL_MS, so an abandoned round trip cannot steer a
// later, unrelated sign-in.

/** Where a successful sign-in lands when no safe `next` was carried —
 *  the page's destination before PHYS-14. */
export const SIGN_IN_DEFAULT_DESTINATION = "/dashboard";

/** sessionStorage key that carries `next` across the Microsoft round trip. */
export const SIGN_IN_NEXT_STASH_KEY = "manufacturingos.signInNext";

/** How long a carried `next` stays honourable: an OAuth round trip finishes
 *  in seconds; an older stash is an abandoned attempt. */
export const SIGN_IN_NEXT_STASH_TTL_MS = 10 * 60 * 1000;

// A scheme anywhere in a decoded layer: letter, then letters / digits / + . -,
// then a colon ("javascript:", "https:", "data:"). A same-origin path has no
// use for one; a value carrying one is refused rather than reasoned about.
const SCHEME = /[a-z][a-z0-9+.-]*:/i;
// C0 controls and DEL — including the tab / CR / LF a browser strips from a URL.
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}
// Percent-decoding is repeated until the value stops changing, at most this
// many times; a value still changing after that is refused.
const MAX_DECODE_LAYERS = 5;
// The sign-in page's own path.
const SIGN_IN_PATH = "/";
const PROBE_ORIGIN = "https://sign-in.invalid";

/** Decode every valid %XX escape as one byte. Byte-wise (not UTF-8 strict) on
 *  purpose: a malformed sequence elsewhere must not hide a "%2F" or "%5C"
 *  that a more lenient decoder downstream would turn into "/" or "\". */
function decodeBytes(s: string): string {
  return s.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Every reading of `raw`: itself, then each percent-decoded layer. Null when
 *  it is still decoding after MAX_DECODE_LAYERS. */
function decodedLayers(raw: string): string[] | null {
  const layers = [raw];
  let cur = raw;
  for (let i = 0; i < MAX_DECODE_LAYERS; i++) {
    const next = decodeBytes(cur);
    if (next === cur) return layers;
    layers.push(next);
    cur = next;
  }
  return decodeBytes(cur) === cur ? layers : null;
}

/** Same origin by the URL parser's own reading, and not the sign-in page. */
function staysOnOriginOffSignIn(layer: string): boolean {
  let u: URL;
  try {
    u = new URL(layer, `${PROBE_ORIGIN}/`);
  } catch {
    return false;
  }
  return u.origin === PROBE_ORIGIN && u.pathname !== SIGN_IN_PATH;
}

/**
 * `raw` when it is a same-origin relative path safe to navigate to after
 * sign-in; otherwise null. `raw` is the value as read from the query string
 * (URLSearchParams has already decoded it once) — the returned string is that
 * value, unchanged, so the destination page decodes it exactly as it would
 * have from a direct link (`/assets/P%20101%2FA` → tag "P 101/A").
 */
export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const layers = decodedLayers(raw);
  if (!layers) return null;
  for (const layer of layers) {
    if (!layer.startsWith("/")) return null;
    if (layer.startsWith("//") || layer.startsWith("/\\")) return null;
    if (layer.includes("\\")) return null;
    if (hasControlChar(layer)) return null;
    if (SCHEME.test(layer)) return null;
    if (!staysOnOriginOffSignIn(layer)) return null;
  }
  return raw;
}

/** The redirect decision: where a successful sign-in lands. */
export function signInDestination(next: unknown): string {
  return safeNextPath(next) ?? SIGN_IN_DEFAULT_DESTINATION;
}

type StashStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** This tab's sessionStorage, or null where storage is unavailable (SSR,
 *  blocked storage, private modes that throw on access). */
function tabStore(): StashStore | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Before leaving for the provider: carry a safe `next` across the round
 *  trip, or clear any earlier one when there is none. Never throws. */
export function stashSignInNext(
  next: string | null | undefined,
  store: StashStore | null = tabStore(),
  now: number = Date.now(),
): void {
  if (!store) return;
  try {
    const safe = safeNextPath(next);
    if (safe) store.setItem(SIGN_IN_NEXT_STASH_KEY, JSON.stringify({ path: safe, at: now }));
    else store.removeItem(SIGN_IN_NEXT_STASH_KEY);
  } catch {
    /* storage refused — the round trip falls back to the default */
  }
}

/** Read and ALWAYS remove the carried `next`: honoured once, only within the
 *  TTL, and only if it is still a safe path. Never throws. */
export function takeStashedSignInNext(
  store: StashStore | null = tabStore(),
  now: number = Date.now(),
): string | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(SIGN_IN_NEXT_STASH_KEY);
    store.removeItem(SIGN_IN_NEXT_STASH_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (typeof parsed?.at !== "number") return null;
    const age = now - parsed.at;
    if (!(age >= 0 && age <= SIGN_IN_NEXT_STASH_TTL_MS)) return null;
    return safeNextPath(parsed.path);
  } catch {
    return null;
  }
}

/**
 * The `next` the sign-in page was opened with, read once on load: the query
 * string's `next` when the URL carries one (safe, or null — a hostile value
 * never falls through to a stash), else the one carried across a Microsoft
 * round trip. The stash is consumed either way.
 */
export function resolveSignInNext(
  search: string,
  store: StashStore | null = tabStore(),
  now: number = Date.now(),
): string | null {
  const stashed = takeStashedSignInNext(store, now);
  const sp = new URLSearchParams(search);
  return sp.has("next") ? safeNextPath(sp.get("next")) : stashed;
}
