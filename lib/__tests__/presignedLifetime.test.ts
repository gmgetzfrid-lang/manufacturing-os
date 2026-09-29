// document-control Round F — P2 EGRESS: the presigned-URL lifetime is a
// SERVER decision (EGR-4 / PKG-11 / XEDGE-6 dw3, DEC-44 §2).
//
//   * /api/storage/download-url used to sign whatever `?expiresIn=` said —
//     `parseInt(… || "3600")`, no ceiling, NaN passed through — so a member
//     could mint a week-long bearer URL that outlived their membership, an
//     ACL deny and a hold. The lifetime now resolves through ONE pure helper:
//     absent → the default, a non-integer → 400, anything else clamped into
//     [60, 3600]; the response says what was granted and is never cacheable.
//   * /api/storage/resolve signs on the same ceiling and is no-store too.
//   * A census over every getSignedUrl call under app/api: no literal above
//     the ceiling, no caller-controlled value anywhere.
//   * The CLIENT half of the contract (lib/storage): the shared cache is keyed
//     by path and remembers the window the server GRANTED, never the one the
//     caller asked for — five image callers used to ask for a week, and a
//     cache that believed them would have served a dead URL for seven days.
//     subscribeSignedUrl re-signs before the granted window closes; a census
//     over the client call sites proves nobody asks above the ceiling.
//   * Resilience of the re-sign (second fix pass): a re-sign that fails for a
//     transient reason (the network after a laptop wakes, a 5xx) keeps the
//     URL the caller holds and retries on a bounded backoff — only a REFUSAL
//     (4xx) ends the subscription with `null`. The margin is a quarter of the
//     granted window capped at a minute, so a short grant is never dead on
//     arrival. Avatars hold their subscription only while mounted.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
  tables: {} as Record<string, { data?: unknown; error?: unknown }>,
  signed: [] as Array<{ expiresIn?: number }>,
}));

function chain(table: string) {
  const result = () => state.tables[table] ?? { data: null, error: null };
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        const r = result();
        return (resolve: (v: unknown) => void) => resolve({ data: r.data ?? null, error: r.error ?? null });
      }
      return (..._args: unknown[]) => {
        if (prop === "maybeSingle" || prop === "single") {
          const r = result();
          const d = Array.isArray(r.data) ? (r.data[0] ?? null) : (r.data ?? null);
          return Promise.resolve({ data: d, error: r.error ?? null });
        }
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(async () =>
        state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
    },
    from: (t: string) => chain(t),
    rpc: vi.fn(async () => ({ data: false, error: null })),
  },
}));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "client-token" } } })) } },
}));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({})) }, R2_BUCKET: "test-bucket" }));
vi.mock("@aws-sdk/client-s3", () => ({ GetObjectCommand: class {}, HeadObjectCommand: class {} }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_client: unknown, _cmd: unknown, opts?: { expiresIn?: number }) => {
    state.signed.push(opts ?? {});
    return "https://signed.example/get";
  }),
}));

import { GET as downloadUrl } from "@/app/api/storage/download-url/route";
import { GET as resolveUrl } from "@/app/api/storage/resolve/route";
import {
  resolvePresignedLifetime, PRESIGNED_MAX_SECONDS, PRESIGNED_MIN_SECONDS, PRESIGNED_DEFAULT_SECONDS,
} from "@/lib/presignedLifetime";
import { getSignedUrlForPath, peekSignedUrl, subscribeSignedUrl, clearSignedUrlCache } from "@/lib/storage";
import { holdAvatarUrl, cachedAvatarUrl, onProfilesChanged, clearProfileCache, heldAvatarPathCount } from "@/lib/userProfiles";

const root = process.cwd();
const ORG = "12345678-1234-1234-1234-123456789abc";
const KEY = `orgs/${ORG}/documents/lib/P-101.pdf`;

const download = (qs = "") => downloadUrl(new NextRequest(
  `https://app/api/storage/download-url?path=${encodeURIComponent(KEY)}${qs}`,
  { headers: { authorization: "Bearer t" } },
));
const resolve = () => resolveUrl(new NextRequest(
  `https://app/api/storage/resolve?path=${encodeURIComponent(KEY)}`,
  { headers: { authorization: "Bearer t" } },
));

beforeEach(() => {
  state.user = { id: "u1", email: "u1@example.com" };
  state.tables = { org_members: { data: { uid: "u1" } }, document_versions: { data: null } };
  state.signed = [];
});

describe("resolvePresignedLifetime — absent → default, non-integer → refused, otherwise clamped", () => {
  it("pins the ceiling: 60 ≤ default ≤ 3600, and the ceiling IS the app's own default", () => {
    expect(PRESIGNED_MIN_SECONDS).toBe(60);
    expect(PRESIGNED_MAX_SECONDS).toBe(3600);
    expect(PRESIGNED_DEFAULT_SECONDS).toBe(3600);
    expect(PRESIGNED_MIN_SECONDS).toBeLessThanOrEqual(PRESIGNED_DEFAULT_SECONDS);
    expect(PRESIGNED_DEFAULT_SECONDS).toBeLessThanOrEqual(PRESIGNED_MAX_SECONDS);
  });
  it("absent or blank → the default, not clamped", () => {
    for (const raw of [null, undefined, "", "   "]) {
      expect(resolvePresignedLifetime(raw)).toEqual({ ok: true, seconds: PRESIGNED_DEFAULT_SECONDS, clamped: false });
    }
  });
  it("an in-range integer is granted as asked", () => {
    expect(resolvePresignedLifetime("3600")).toEqual({ ok: true, seconds: 3600, clamped: false });
    expect(resolvePresignedLifetime("60")).toEqual({ ok: true, seconds: 60, clamped: false });
    expect(resolvePresignedLifetime(" 900 ")).toEqual({ ok: true, seconds: 900, clamped: false });
  });
  it("out-of-range integers are clamped into [MIN, MAX] and say so", () => {
    expect(resolvePresignedLifetime("604800")).toEqual({ ok: true, seconds: 3600, clamped: true });
    expect(resolvePresignedLifetime("3601")).toEqual({ ok: true, seconds: 3600, clamped: true });
    expect(resolvePresignedLifetime("5")).toEqual({ ok: true, seconds: 60, clamped: true });
    expect(resolvePresignedLifetime("0")).toEqual({ ok: true, seconds: 60, clamped: true });
    expect(resolvePresignedLifetime("-1")).toEqual({ ok: true, seconds: 60, clamped: true });
  });
  it("anything that is not a plain integer is refused, never NaN-through", () => {
    for (const raw of ["abc", "3600.5", "1e3", "0x10", "Infinity", "NaN", "3600s", "36 00", "+3600"]) {
      const r = resolvePresignedLifetime(raw);
      expect(r.ok, raw).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/integer/);
    }
  });
});

describe("GET /api/storage/download-url — the lifetime is the server's (EGR-4 / PKG-11)", () => {
  it("clamps a week to the ceiling, returns the granted lifetime, and is no-store", async () => {
    const res = await download("&expiresIn=604800");
    expect(res.status).toBe(200);
    expect(state.signed).toEqual([{ expiresIn: PRESIGNED_MAX_SECONDS }]);
    const body = await res.json() as { url: string; expiresIn: number };
    expect(body.url).toBe("https://signed.example/get");
    expect(body.expiresIn).toBe(PRESIGNED_MAX_SECONDS);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("refuses garbage with 400 before touching the presigner", async () => {
    for (const raw of ["abc", "3600.5", "1e3", "NaN"]) {
      state.signed = [];
      const res = await download(`&expiresIn=${encodeURIComponent(raw)}`);
      expect(res.status, raw).toBe(400);
      expect(state.signed, raw).toEqual([]);
    }
  });
  it("absent → the default; too small → the floor", async () => {
    let res = await download();
    expect(res.status).toBe(200);
    expect(state.signed).toEqual([{ expiresIn: PRESIGNED_DEFAULT_SECONDS }]);
    state.signed = [];
    res = await download("&expiresIn=5");
    expect(res.status).toBe(200);
    expect(state.signed).toEqual([{ expiresIn: PRESIGNED_MIN_SECONDS }]);
    expect(((await res.json()) as { expiresIn: number }).expiresIn).toBe(PRESIGNED_MIN_SECONDS);
  });
  it("the gates in front still hold: no session → 401 and nothing signed", async () => {
    state.user = null;
    const res = await download("&expiresIn=3600");
    expect(res.status).toBe(401);
    expect(state.signed).toEqual([]);
  });
});

describe("GET /api/storage/resolve — the same ceiling, no-store", () => {
  it("signs on the shared ceiling and reports it", async () => {
    state.tables.document_versions = { data: { org_id: ORG, archived_at: null, archive_id: null } };
    const res = await resolve();
    expect(res.status).toBe(200);
    expect(state.signed).toEqual([{ expiresIn: PRESIGNED_MAX_SECONDS }]);
    const body = await res.json() as { archived: boolean; url: string; expiresIn: number };
    expect(body.archived).toBe(false);
    expect(body.expiresIn).toBe(PRESIGNED_MAX_SECONDS);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("getSignedUrl census under app/api — no issuer is looser than the ceiling", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }
  /** The text of one call from `getSignedUrl(` to its balancing `)`. */
  function callText(src: string, at: number): string {
    let depth = 0;
    for (let i = at; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") { depth--; if (depth === 0) return src.slice(at, i + 1); }
    }
    return src.slice(at);
  }
  const routes = walk(join(root, "app", "api")).filter((p) => p.endsWith("route.ts"));
  const calls: Array<{ file: string; text: string; src: string }> = [];
  for (const file of routes) {
    const src = readFileSync(file, "utf8");
    let i = src.indexOf("getSignedUrl(");
    while (i >= 0) {
      calls.push({ file: file.replace(root + "/", ""), text: callText(src, i), src });
      i = src.indexOf("getSignedUrl(", i + 1);
    }
  }

  it("censuses every signing site (upload-url, multipart, resolve, download-url, transmittal)", () => {
    const files = new Set(calls.map((c) => c.file));
    for (const f of [
      "app/api/storage/upload-url/route.ts", "app/api/storage/multipart/route.ts",
      "app/api/storage/resolve/route.ts", "app/api/storage/download-url/route.ts", "app/api/transmittal/route.ts",
    ]) expect(files.has(f), f).toBe(true);
  });

  it("every lifetime is a literal ≤ the ceiling or the shared resolver's answer — never a query parameter", () => {
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const c of calls) {
      const lit = c.text.match(/expiresIn\s*:\s*(\d+)\b/);
      if (lit) {
        expect(Number(lit[1]), `${c.file}: ${c.text}`).toBeLessThanOrEqual(PRESIGNED_MAX_SECONDS);
        continue;
      }
      const ident = c.text.match(/expiresIn\s*:\s*([A-Za-z_$][\w$.]*)/) ?? c.text.match(/\{\s*(expiresIn)\s*\}/);
      expect(ident, `${c.file}: no lifetime found in ${c.text}`).not.toBeNull();
      const name = ident![1];
      expect(
        name === "PRESIGNED_MAX_SECONDS" || name === "PRESIGNED_DEFAULT_SECONDS" || name === "lifetime.seconds",
        `${c.file}: lifetime "${name}" is not the shared ceiling or the resolver's answer`,
      ).toBe(true);
      expect(c.src, `${c.file} must take its lifetime from lib/presignedLifetime`).toMatch(/from "@\/lib\/presignedLifetime"/);
    }
  });

  it("the download-url route no longer parses expiresIn itself", () => {
    const src = readFileSync(join(root, "app/api/storage/download-url/route.ts"), "utf8");
    expect(src).not.toMatch(/parseInt\(/);
    expect(src).toMatch(/resolvePresignedLifetime\(req\.nextUrl\.searchParams\.get\("expiresIn"\)\)/);
    expect(src).toMatch(/"Cache-Control": "no-store"/);
    const resolveSrc = readFileSync(join(root, "app/api/storage/resolve/route.ts"), "utf8");
    expect(resolveSrc).toMatch(/expiresIn: PRESIGNED_MAX_SECONDS/);
    expect(resolveSrc).toMatch(/"Cache-Control": "no-store"/);
  });
});

// ── the client half: lib/storage caches what was GRANTED, keyed by path ──────
describe("lib/storage — the client cache honours the granted window, not the requested one", () => {
  const PATH = "orgs/o1/branding/logo.png";
  const fetches: string[] = [];
  let answer: () => Record<string, unknown> = () => ({ url: "https://r2/signed-1", expiresIn: PRESIGNED_MAX_SECONDS });
  let seq = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T08:00:00Z"));
    fetches.length = 0;
    seq = 0;
    answer = () => ({ url: `https://r2/signed-${++seq}`, expiresIn: PRESIGNED_MAX_SECONDS });
    clearSignedUrlCache();
    clearProfileCache();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      fetches.push(String(input));
      return new Response(JSON.stringify(answer()), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a caller asking for a week gets the URL, but the cache expires it when the SERVER said it does", async () => {
    const before = Date.now();
    const url = await getSignedUrlForPath(PATH, 604800);
    expect(url).toBe("https://r2/signed-1");
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatch(/expiresIn=604800/); // the request still says what it wants; the server decides
    const cached = peekSignedUrl(PATH);
    expect(cached?.url).toBe(url);
    expect(cached!.expiresAt).toBeLessThanOrEqual(before + PRESIGNED_MAX_SECONDS * 1000);
    expect(cached!.expiresAt).toBeGreaterThan(before + (PRESIGNED_MAX_SECONDS - 5) * 1000);
  });

  it("is keyed by PATH alone — a different requested window does not fork a second entry", async () => {
    await getSignedUrlForPath(PATH, 604800);
    expect(await getSignedUrlForPath(PATH)).toBe("https://r2/signed-1");
    expect(await getSignedUrlForPath(PATH, 900)).toBe("https://r2/signed-1");
    expect(fetches).toHaveLength(1);
  });

  it("re-signs once the granted window is within the safety margin — never serves the dead URL", async () => {
    await getSignedUrlForPath(PATH, 604800);
    vi.setSystemTime(Date.now() + (PRESIGNED_MAX_SECONDS - 120) * 1000); // 2 min of life left
    expect(peekSignedUrl(PATH)?.url).toBe("https://r2/signed-1");
    vi.setSystemTime(Date.now() + 90 * 1000);                              // 30 s left — inside the margin
    expect(peekSignedUrl(PATH)).toBeUndefined();
    expect(await getSignedUrlForPath(PATH, 604800)).toBe("https://r2/signed-2");
    expect(fetches).toHaveLength(2);
  });

  it("a server that does not report the grant is assumed to have signed for at most the ceiling", async () => {
    answer = () => ({ url: "https://r2/legacy" });
    const before = Date.now();
    await getSignedUrlForPath(PATH, 604800);
    expect(peekSignedUrl(PATH)!.expiresAt).toBe(before + PRESIGNED_MAX_SECONDS * 1000);
    clearSignedUrlCache();
    answer = () => ({ url: "https://r2/legacy-short" });
    await getSignedUrlForPath(PATH, 600);
    expect(peekSignedUrl(PATH)!.expiresAt).toBe(before + 600 * 1000);
  });

  it("subscribeSignedUrl hands out a URL now and a fresh one before the granted window closes; unsubscribe stops it", async () => {
    const seen: Array<string | null> = [];
    const stop = subscribeSignedUrl(PATH, (u) => seen.push(u));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["https://r2/signed-1"]);
    await vi.advanceTimersByTimeAsync((PRESIGNED_MAX_SECONDS - 61) * 1000);
    expect(seen).toEqual(["https://r2/signed-1"]);                          // still live — no needless re-sign
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual(["https://r2/signed-1", "https://r2/signed-2"]); // re-signed at the margin, not after the 403
    expect(fetches).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(PRESIGNED_MAX_SECONDS * 1000);
    expect(seen).toHaveLength(2);
    expect(fetches).toHaveLength(2);
  });

  it("a path that cannot be signed is reported once as null and not retried", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const seen: Array<string | null> = [];
    const stop = subscribeSignedUrl(PATH, (u) => seen.push(u));
    await vi.advanceTimersByTimeAsync(PRESIGNED_MAX_SECONDS * 2000);
    expect(seen).toEqual([null]);
    stop();
  });

  // ── Second fix pass: a failed re-sign is not the end of the image ──────

  /** fetch that fails `failures` times (rejecting like a dropped connection
   *  or answering `status`) and then signs normally. */
  function flakyFetch(failures: number, status?: number) {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      fetches.push(String(input));
      if (n++ < failures) {
        if (status) return new Response("busy", { status });
        throw new TypeError("Failed to fetch");
      }
      return new Response(JSON.stringify(answer()), { status: 200, headers: { "content-type": "application/json" } });
    }));
  }

  it("a re-sign that fails transiently keeps the URL the caller holds and retries — never null, never a dead image", async () => {
    const seen: Array<string | null> = [];
    const stop = subscribeSignedUrl(PATH, (u) => seen.push(u));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["https://r2/signed-1"]);
    flakyFetch(1);                                                            // the hourly re-sign hits a dropped connection
    await vi.advanceTimersByTimeAsync((PRESIGNED_MAX_SECONDS - 60) * 1000);  // the margin: re-sign attempted and failed
    expect(fetches).toHaveLength(2);
    expect(seen).toEqual(["https://r2/signed-1"]);                          // no null — the caller keeps what it has
    await vi.advanceTimersByTimeAsync(14_000);
    expect(fetches).toHaveLength(2);                                          // not yet — bounded backoff, not a hammer
    await vi.advanceTimersByTimeAsync(1_000);                                 // 15 s after the failure
    expect(fetches).toHaveLength(3);
    expect(seen).toEqual(["https://r2/signed-1", "https://r2/signed-2"]);
    expect(peekSignedUrl(PATH)?.url).toBe("https://r2/signed-2");
    stop();
  });

  it("the retry backs off 15 s → 30 s → 60 s (capped), resets after a success, and a 5xx is transient too", async () => {
    flakyFetch(4, 503);
    const seen: Array<string | null> = [];
    const stop = subscribeSignedUrl(PATH, (u) => seen.push(u));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toHaveLength(1);                                          // failed
    await vi.advanceTimersByTimeAsync(15_000); expect(fetches).toHaveLength(2); // +15 s
    await vi.advanceTimersByTimeAsync(30_000); expect(fetches).toHaveLength(3); // +30 s
    await vi.advanceTimersByTimeAsync(60_000); expect(fetches).toHaveLength(4); // +60 s
    await vi.advanceTimersByTimeAsync(60_000); expect(fetches).toHaveLength(5); // +60 s (capped) — this one signs
    expect(seen).toEqual(["https://r2/signed-1"]);                          // nothing but the real URL ever reached the caller
    flakyFetch(1);
    await vi.advanceTimersByTimeAsync((PRESIGNED_MAX_SECONDS - 60) * 1000);  // next margin: fails once
    expect(fetches).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(15_000);                                // backoff restarted at 15 s after a success
    expect(fetches).toHaveLength(7);
    expect(seen).toEqual(["https://r2/signed-1", "https://r2/signed-2"]);
    stop();
  });

  it("coming back online (or to the foreground) retries at once instead of waiting out the backoff", async () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as string });
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    flakyFetch(1);
    const seen: Array<string | null> = [];
    const stop = subscribeSignedUrl(PATH, (u) => seen.push(u));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toHaveLength(1);
    expect(seen).toEqual([]);
    win.dispatchEvent(new Event("online"));                                   // wifi is back — do not wait 15 s
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toHaveLength(2);
    expect(seen).toEqual(["https://r2/signed-1"]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetches).toHaveLength(2);                                          // the backoff timer was replaced, not doubled up
    // Not in a failed state: neither event triggers a call.
    win.dispatchEvent(new Event("online"));
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toHaveLength(2);
    // A hidden tab waits for the foreground.
    flakyFetch(1);
    await vi.advanceTimersByTimeAsync((PRESIGNED_MAX_SECONDS - 60) * 1000 - 15_000); // the margin of the URL signed at t=0
    expect(fetches).toHaveLength(3);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toHaveLength(3);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toHaveLength(4);
    expect(seen).toEqual(["https://r2/signed-1", "https://r2/signed-2"]);
    stop();
    win.dispatchEvent(new Event("online"));                                   // unsubscribed: listeners are gone
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetches).toHaveLength(4);
  });

  it("a REFUSAL (403 / 404 / 400) ends the subscription with one null — the route's answer will not change on retry", async () => {
    for (const status of [403, 404, 400]) {
      clearSignedUrlCache();
      fetches.length = 0;
      vi.stubGlobal("fetch", vi.fn(async (input: string) => { fetches.push(String(input)); return new Response("no", { status }); }));
      const seen: Array<string | null> = [];
      const stop = subscribeSignedUrl(PATH, (u) => seen.push(u));
      await vi.advanceTimersByTimeAsync(PRESIGNED_MAX_SECONDS * 2000);
      expect(seen, String(status)).toEqual([null]);
      expect(fetches, String(status)).toHaveLength(1);
      stop();
    }
    // 429 is the server asking for patience, not an answer about the path.
    clearSignedUrlCache();
    fetches.length = 0;
    flakyFetch(1, 429);
    const seen: Array<string | null> = [];
    const stop = subscribeSignedUrl(PATH, (u) => seen.push(u));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(seen).toEqual(["https://r2/signed-1"]);
    stop();
  });

  it("the margin is a quarter of the granted window, capped at 60 s — a 60 s grant is live on arrival and re-signed at 45 s", async () => {
    answer = () => ({ url: `https://r2/short-${++seq}`, expiresIn: 60 });
    const seen: Array<string | null> = [];
    const stop = subscribeSignedUrl(PATH, (u) => seen.push(u));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["https://r2/short-1"]);
    expect(peekSignedUrl(PATH)?.url).toBe("https://r2/short-1");             // live, not refused by a 60 s margin
    expect(peekSignedUrl(PATH)?.margin).toBe(15_000);
    await vi.advanceTimersByTimeAsync(44_000);
    expect(fetches).toHaveLength(1);
    expect(peekSignedUrl(PATH)?.url).toBe("https://r2/short-1");
    await vi.advanceTimersByTimeAsync(1_000);                                 // 45 s: inside the 15 s margin
    expect(fetches).toHaveLength(2);
    expect(seen).toEqual(["https://r2/short-1", "https://r2/short-2"]);
    stop();
    // The hour keeps its full minute.
    clearSignedUrlCache();
    answer = () => ({ url: "https://r2/hour", expiresIn: PRESIGNED_MAX_SECONDS });
    await getSignedUrlForPath(PATH);
    expect(peekSignedUrl(PATH)?.margin).toBe(60_000);
  });

  // ── Avatars: the subscription lives exactly as long as an avatar shows the path ──

  it("holdAvatarUrl is ref-counted per path: one subscription shared by every mounted avatar, ended by the last release", async () => {
    const AV = "avatars/u1/avatar-1.png";
    let notified = 0;
    const off = onProfilesChanged(() => { notified++; });
    expect(cachedAvatarUrl(AV)).toBeUndefined();
    const releaseA = holdAvatarUrl(AV);
    const releaseB = holdAvatarUrl(AV);                                       // the same person in two rows
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toHaveLength(1);
    expect(cachedAvatarUrl(AV)).toBe("https://r2/signed-1");
    expect(notified).toBe(1);                                                 // one re-render for one new URL
    expect(heldAvatarPathCount()).toBe(1);
    const releaseC = holdAvatarUrl(AV);                                       // mounted onto a live URL: nothing to announce
    await vi.advanceTimersByTimeAsync(0);
    expect(notified).toBe(1);
    releaseA(); releaseA();                                                   // double release is harmless
    releaseC();
    await vi.advanceTimersByTimeAsync((PRESIGNED_MAX_SECONDS - 60) * 1000);  // B is still on screen: re-signed at the margin
    expect(fetches).toHaveLength(2);
    expect(cachedAvatarUrl(AV)).toBe("https://r2/signed-2");
    expect(notified).toBe(2);
    releaseB();                                                               // the last avatar showing it unmounts
    expect(heldAvatarPathCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PRESIGNED_MAX_SECONDS * 1000);
    expect(fetches).toHaveLength(2);                                          // no re-sign for a path nobody is looking at
    expect(notified).toBe(2);
    holdAvatarUrl(AV);                                                        // back on screen after the hour: signed again
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toHaveLength(3);
    off();
  });

  it("a refused avatar path is marked null once and never held or re-fetched; a transient failure is not a mark", async () => {
    const AV = "avatars/u2/avatar-9.png";
    vi.stubGlobal("fetch", vi.fn(async (input: string) => { fetches.push(String(input)); return new Response("no", { status: 403 }); }));
    const releaseRefused = holdAvatarUrl(AV);
    await vi.advanceTimersByTimeAsync(0);
    expect(cachedAvatarUrl(AV)).toBeNull();
    releaseRefused();
    expect(heldAvatarPathCount()).toBe(0);
    holdAvatarUrl(AV);                                                        // a later mount asks nothing
    await vi.advanceTimersByTimeAsync(PRESIGNED_MAX_SECONDS * 1000);
    expect(fetches).toHaveLength(1);
    const AV2 = "avatars/u3/avatar-2.png";
    flakyFetch(1);
    const release = holdAvatarUrl(AV2);
    await vi.advanceTimersByTimeAsync(0);
    expect(cachedAvatarUrl(AV2)).toBeUndefined();                             // not resolved yet — not "could not be signed"
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cachedAvatarUrl(AV2)).toMatch(/^https:\/\/r2\/signed-/);
    release();
  });

  it("source pins: UserAvatar holds the path from its effect (released on unmount); the branding provider seeds or clears the logo before subscribing", () => {
    const avatar = readFileSync(join(root, "components/ui/UserAvatar.tsx"), "utf8");
    expect(avatar).toMatch(/return holdAvatarUrl\(avatarPath\);/);
    expect(avatar).not.toMatch(/resolveAvatarUrl/);
    const branding = readFileSync(join(root, "components/providers/OrgBrandingProvider.tsx"), "utf8");
    const seed = branding.indexOf("setLogoUrl(peekSignedUrl(logoPath)?.url ?? null);");
    const sub = branding.indexOf("return subscribeSignedUrl(logoPath, setLogoUrl);");
    expect(seed).toBeGreaterThan(-1);
    expect(sub).toBeGreaterThan(seed);
    const profiles = readFileSync(join(root, "lib/userProfiles.ts"), "utf8");
    expect(profiles).not.toMatch(/resolveAvatarUrl|avatarSubscriptions/);
  });

  it("census: no client call site asks for more than the ceiling (the five week-long sites are gone)", () => {
    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        if (f === "node_modules" || f === "__tests__" || f === ".next") return [];
        return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
      });
    }
    const files = ["components", "lib", "app"].flatMap((d) => walk(join(root, d)));
    const offenders: string[] = [];
    let seen = 0;
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\b(getSignedUrlForPath|resolveFileUrl|resolveFileUrlDetailed)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
        seen++;
        const args = m[2].split(",").map((s) => s.trim());
        const lifetime = args[1];
        if (lifetime && /^\d+$/.test(lifetime) && Number(lifetime) > PRESIGNED_MAX_SECONDS) offenders.push(`${file.replace(root + "/", "")}: ${m[0]}`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(10);
    expect(offenders).toEqual([]);
    // the five former week-long callers read the shared cache instead of keeping their own
    for (const f of ["components/providers/OrgBrandingProvider.tsx", "components/documents/PageBackground.tsx", "components/documents/NodeCover.tsx", "lib/userProfiles.ts"]) {
      expect(readFileSync(join(root, f), "utf8"), f).toMatch(/subscribeSignedUrl\(/);
    }
    expect(readFileSync(join(root, "app/(protected)/admin/branding/page.tsx"), "utf8")).not.toMatch(/604800/);
  });
});
