// lib/requestLog.ts - every call the browser makes to the database, as one
// fetch the Supabase client uses (lib/supabase.ts).
//
// Two jobs:
//  1. One answer for the same question asked twice at once. When the side
//     menu, the bell and a page each read the same rows at the same moment,
//     one request goes out and each caller gets its own copy of the answer.
//     Only reads (GET, HEAD) without an abort signal are shared, and only
//     while the first is still on its way: nothing is kept afterwards.
//  2. The timing view (?timing=1): each request's table or route, how long
//     it took and how many rows came back. Nothing else is kept: no address
//     query (it holds ids and emails), no headers, no tokens, no bodies.

export interface TimedRequest {
  id: number;
  /** performance.now() when it started. */
  at: number;
  /** How long until the answer's headers came back; null while waiting. */
  ms: number | null;
  /** The table, function or route asked ("tickets", "rpc search", "/api/auth/membership"). */
  what: string;
  method: string;
  /** Rows in the answer (from the Content-Range header), when it says. */
  rows: number | null;
  /** A count asked for (HEAD with count): the total the server counted. */
  count?: number | null;
  status: number | null;
  /** Answered by a request already on its way (no request of its own). */
  shared?: boolean;
}

const MAX = 400;
const log: TimedRequest[] = [];
const listeners = new Set<() => void>();
let seq = 0;
let recording: boolean | null = null;

/** Whether this tab records request timings (?timing=1, kept for the tab until ?timing=0). */
export function timingOn(): boolean {
  if (recording !== null) return recording;
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("timing");
    if (q === "1") window.sessionStorage.setItem("mos.timing", "1");
    if (q === "0") window.sessionStorage.removeItem("mos.timing");
    recording = window.sessionStorage.getItem("mos.timing") === "1";
  } catch {
    recording = false;
  }
  return recording;
}

/** Turn the timing view off for this tab. */
export function timingOff(): void {
  recording = false;
  try { window.sessionStorage.removeItem("mos.timing"); } catch { /* private mode */ }
  emit();
}

export function timedRequests(): readonly TimedRequest[] { return log; }

export function onTimedRequest(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

let emitQueued = false;
function emit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => { emitQueued = false; listeners.forEach((fn) => fn()); });
}

/** The table or route a request is for, never its query or ids. */
export function whatOf(url: string): string {
  try {
    const u = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    const p = u.pathname;
    let m = p.match(/^\/rest\/v1\/rpc\/([^/]+)/);
    if (m) return `rpc ${m[1]}`;
    m = p.match(/^\/rest\/v1\/([^/]+)/);
    if (m) return m[1];
    m = p.match(/^\/auth\/v1\/([^/?]+)/);
    if (m) return `auth ${m[1]}`;
    m = p.match(/^\/storage\/v1\/([^/]+)/);
    if (m) return `storage ${m[1]}`;
    m = p.match(/^\/functions\/v1\/([^/]+)/);
    if (m) return `function ${m[1]}`;
    // App routes: the path with ids folded away.
    return p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
  } catch {
    return "request";
  }
}

/** Rows in an answer, from its Content-Range ("0-24/25" is 25 rows; "* /25" none). */
function rowsOf(res: Response): number | null {
  const range = res.headers.get("content-range");
  if (!range) return null;
  const m = range.match(/^(\d+)-(\d+)/);
  if (m) return Number(m[2]) - Number(m[1]) + 1;
  return range.startsWith("*") ? 0 : null;
}

function record(entry: TimedRequest) {
  if (log.length >= MAX) log.splice(0, log.length - MAX + 1);
  log.push(entry);
  emit();
}

const inflight = new Map<string, Promise<Response>>();

function headerOf(init: RequestInit | undefined, name: string): string {
  const h = init?.headers;
  if (!h) return "";
  if (h instanceof Headers) return h.get(name) ?? "";
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1] ?? "";
  const rec = h as Record<string, string>;
  for (const k of Object.keys(rec)) if (k.toLowerCase() === name) return rec[k];
  return "";
}

/** The fetch the Supabase client uses: shares identical reads in flight,
 *  and times every request when the timing view is on. */
export const loggedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const timed = timingOn();
  const entry: TimedRequest | null = timed
    ? { id: ++seq, at: performance.now(), ms: null, what: whatOf(url), method, rows: null, status: null }
    : null;
  const done = (res: Response) => {
    if (entry) {
      entry.ms = Math.round(performance.now() - entry.at); entry.status = res.status;
      if (method === "HEAD") {
        const total = (res.headers.get("content-range") ?? "").split("/")[1];
        entry.count = total && /^\d+$/.test(total) ? Number(total) : null;
      } else entry.rows = rowsOf(res);
      emit();
      // No row count in the headers (a proxy kept them back): count the
      // answer's rows from a copy, after the caller has it.
      if (entry.rows === null && res.ok && method === "GET" && (res.headers.get("content-type") ?? "").includes("json")) {
        const e = entry;
        void res.clone().text().then((t) => {
          const j: unknown = JSON.parse(t);
          e.rows = Array.isArray(j) ? j.length : j && typeof j === "object" ? 1 : 0;
          emit();
        }).catch(() => undefined);
      }
    }
    return res;
  };
  const failed = (e: unknown) => {
    if (entry) { entry.ms = Math.round(performance.now() - entry.at); entry.status = 0; emit(); }
    throw e;
  };

  const shareable = (method === "GET" || method === "HEAD") && !init?.signal && !(input instanceof Request);
  if (!shareable) {
    if (entry) record(entry);
    return fetch(input, init).then(done, failed);
  }
  // Who is asking is part of the question: never share across sign-ins.
  const key = [method, url, headerOf(init, "authorization"), headerOf(init, "accept"), headerOf(init, "prefer"),
    headerOf(init, "range"), headerOf(init, "accept-profile")].join("\n");
  let p = inflight.get(key);
  if (p) {
    if (entry) { entry.shared = true; record(entry); }
  } else {
    if (entry) record(entry);
    p = fetch(input, init);
    inflight.set(key, p);
    const mine = p;
    void mine.then(() => undefined, () => undefined).finally(() => { if (inflight.get(key) === mine) inflight.delete(key); });
  }
  // Each caller reads its own copy; the first answer is never handed out.
  return p.then((res) => done(res.clone()), failed);
};
