// lib/friendlyError.ts: say what went wrong in plain words, and what to do.
//
// Raw messages from the database or the network ("JSON object requested,
// multiple (or no) rows returned", "Failed to fetch", "new row violates
// row-level security policy", a bare 500) never reach the screen. Messages
// the app writes itself ("Pick a file first.") pass through unchanged.

export type ErrorKind =
  | "network" | "signin" | "access" | "not-found" | "conflict" | "in-use"
  | "too-large" | "too-many" | "timeout" | "server" | "unknown";

export interface FriendlyError {
  /** What happened, in one plain sentence. */
  message: string;
  /** What to do next. */
  next: string;
  kind: ErrorKind;
  /** Trying again could work (a dropped connection, a busy server). */
  retry: boolean;
}

const WORDS: Record<ErrorKind, Omit<FriendlyError, "kind">> = {
  network: { message: "No connection to the server.", next: "Check your connection, then try again.", retry: true },
  signin: { message: "Your sign-in has expired.", next: "Sign in again, then try again.", retry: false },
  access: { message: "You don't have access to this.", next: "Ask an admin in your workspace for access.", retry: false },
  "not-found": { message: "That record wasn't found.", next: "It may have been removed, or you may not have access to it. Reload the page to see the latest.", retry: true },
  conflict: { message: "That already exists.", next: "Use a different name or number.", retry: false },
  "in-use": { message: "This is still used somewhere else.", next: "Remove or move what uses it first.", retry: false },
  "too-large": { message: "That file is too large.", next: "Try a smaller file.", retry: false },
  "too-many": { message: "Too many requests at once.", next: "Wait a moment, then try again.", retry: true },
  timeout: { message: "That took too long to answer.", next: "Try again. If it keeps happening, narrow what you asked for.", retry: true },
  server: { message: "The server had a problem.", next: "Try again in a minute.", retry: true },
  unknown: { message: "Something went wrong.", next: "Try again. If it keeps happening, tell your admin what you were doing.", retry: true },
};

/** Words that mark a message as machine-made (not for people). */
const RAW = /\b(json|pgrst|postgres|postgrest|sql|syntax|relation|column|violates|constraint|null value|uuid|undefined|typeerror|referenceerror|cannot read|is not a function|unexpected token|stack|jwt|rpc|schema|duplicate key|foreign key|row-level|rls|enoent|econn|status code|http|fetch|xhr|abort|\{|\})/i;

function pick(e: unknown): { msg: string; status?: number; code?: string; name?: string } {
  if (e == null) return { msg: "" };
  if (typeof e === "string") return { msg: e };
  if (typeof e === "number") return { msg: "", status: e };
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    const msg = typeof o.message === "string" ? o.message : typeof o.error_description === "string" ? o.error_description : typeof o.error === "string" ? o.error : "";
    const rawStatus = o.status ?? o.statusCode;
    const status = typeof rawStatus === "number" ? rawStatus : typeof rawStatus === "string" && /^\d{3}$/.test(rawStatus) ? Number(rawStatus) : undefined;
    const code = typeof o.code === "string" ? o.code : typeof o.code === "number" ? String(o.code) : undefined;
    const name = typeof o.name === "string" ? o.name : undefined;
    return { msg, status, code, name };
  }
  return { msg: String(e) };
}

/** The kind of failure behind an error, from its code, status or words. */
export function errorKind(e: unknown): ErrorKind {
  const { msg, status, code, name } = pick(e);
  const m = msg.toLowerCase();
  const c = (code ?? "").toUpperCase();
  if (name === "AbortError" || c === "57014" || /timed? ?out|timeout|statement timeout/.test(m)) return "timeout";
  if (/failed to fetch|networkerror|network error|load failed|fetch failed|err_internet|offline|econnre|enotfound|network request failed/.test(m)) return "network";
  if (status === 401 || c === "PGRST301" || c === "PGRST302" || /jwt (expired|malformed)|invalid jwt|not authenticated|auth session missing|refresh token/.test(m)) return "signin";
  if (status === 403 || c === "42501" || /permission denied|row-level security|not authori[sz]ed|forbidden/.test(m)) return "access";
  if (status === 404 || c === "PGRST116" || /json object requested|no rows|not found/.test(m)) return "not-found";
  if (status === 409 || c === "23505" || /duplicate key|already exists/.test(m)) return "conflict";
  if (c === "23503" || /foreign key/.test(m)) return "in-use";
  if (status === 413 || /payload too large|too large|entity too large|exceeds the maximum/.test(m)) return "too-large";
  if (status === 429 || /rate limit|too many requests/.test(m)) return "too-many";
  if ((status && status >= 500) || /internal server error|bad gateway|service unavailable|gateway timeout/.test(m)) return "server";
  return "unknown";
}

/** What went wrong and what to do, in plain words. A message the app wrote
 *  for people is kept as it is. */
export function explainError(e: unknown): FriendlyError {
  const kind = errorKind(e);
  if (kind !== "unknown") return { kind, ...WORDS[kind] };
  const { msg } = pick(e);
  const clean = msg.trim();
  if (clean && clean.length <= 200 && !RAW.test(clean)) {
    return { kind, message: /[.!?]$/.test(clean) ? clean : `${clean}.`, next: WORDS.unknown.next, retry: true };
  }
  return { kind, ...WORDS.unknown };
}

/** One plain sentence for an error, ready to show: "No connection to the
 *  server. Check your connection, then try again." */
export function friendlyError(e: unknown): string {
  const f = explainError(e);
  return `${f.message} ${f.next}`;
}

export default friendlyError;
