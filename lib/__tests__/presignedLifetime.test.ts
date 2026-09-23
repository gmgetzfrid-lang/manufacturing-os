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

import { describe, it, expect, vi, beforeEach } from "vitest";
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
