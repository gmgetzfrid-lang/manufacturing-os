// projects Round G (J11) — projects-tab SEC-18 (DEC-49): the two presigned-GET
// issuers that signed a bare GetObjectCommand — /api/storage/resolve (the
// archive-aware opener) and lib/dataExport.ts (the data-export envelope's
// per-file URLs) — now sign the same disposition download-url does.
//
// Signed with the REAL presigner (a real S3 client with inert credentials —
// presigning is local), so the assertions read the actual
// `response-content-disposition` / `response-content-type` parameters the
// browser receives back as headers. Only `send` (the HeadObject probe) is
// stubbed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
  tables: {} as Record<string, { data?: unknown; error?: unknown }>,
  headFails: false,
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
      return () => {
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
  },
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => chain(t) }),
}));
vi.mock("@/lib/r2", async () => {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: "https://acct.r2.cloudflarestorage.com",
    credentials: { accessKeyId: "AKTEST", secretAccessKey: "SKTEST" },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  // The presigner never calls send(); the route's HeadObject probe does.
  Object.assign(client, {
    send: vi.fn(async () => {
      if (state.headFails) throw new Error("NotFound");
      return { ContentLength: 10, ContentType: "text/html" };
    }),
  });
  return { r2: client, R2_BUCKET: "test-bucket" };
});

import { GET as resolve } from "@/app/api/storage/resolve/route";
import { runOrgExport } from "@/lib/dataExport";

const ORG = "12345678-1234-1234-1234-123456789abc";
const root = process.cwd();

beforeEach(() => {
  state.user = { id: "u1", email: "u1@example.com" };
  state.headFails = false;
  state.tables = {
    org_members: { data: { uid: "u1" } },
    document_versions: { data: { org_id: ORG, archived_at: null, archive_id: null } },
    archive_settings: { data: null },
  };
});

describe("GET /api/storage/resolve — the archive-aware opener signs a disposition (SEC-18)", () => {
  const open = async (key: string, qs = "") => {
    const res = await resolve(new NextRequest(
      `https://app/api/storage/resolve?path=${encodeURIComponent(key)}${qs}`,
      { headers: { authorization: "Bearer t" } },
    ));
    const body = await res.json() as { archived: boolean; url: string; disposition: string; contentType: string | null };
    return { res, body, url: new URL(body.url) };
  };

  it("DEFAULT: an attachment named after the key, no type pinned, never cacheable", async () => {
    const { res, body, url } = await open(`orgs/${ORG}/libraries/l1/P-101.pdf`);
    expect(res.status).toBe(200);
    expect(body.archived).toBe(false);
    expect(url.searchParams.get("response-content-disposition")).toBe(`attachment; filename="P-101.pdf"; filename*=UTF-8''P-101.pdf`);
    expect(url.searchParams.get("response-content-type")).toBeNull();
    expect(body).toMatchObject({ disposition: "attachment", contentType: null });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("a stored HTML / SVG upload is an attachment whatever the caller asks", async () => {
    for (const key of [`orgs/${ORG}/project-intake/p1/abc-payload.html`, `orgs/${ORG}/project-intake/p1/x.svg`]) {
      for (const qs of ["", "&inline=1", "&inline=true"]) {
        const { body, url } = await open(key, qs);
        expect(url.searchParams.get("response-content-disposition"), key + qs).toMatch(/^attachment; filename="/);
        expect(url.searchParams.get("response-content-type"), key + qs).toBeNull();
        expect(body.disposition, key + qs).toBe("attachment");
      }
    }
  });

  it("inline=1 on a PDF or a raster image: inline, with the type pinned", async () => {
    const pdf = await open(`orgs/${ORG}/libraries/l1/P-101.pdf`, "&inline=1");
    expect(pdf.url.searchParams.get("response-content-disposition")).toMatch(/^inline; filename="P-101.pdf"/);
    expect(pdf.url.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(pdf.body).toMatchObject({ disposition: "inline", contentType: "application/pdf" });
    const png = await open(`orgs/${ORG}/libraries/l1/photo.png`, "&inline=1");
    expect(png.url.searchParams.get("response-content-type")).toBe("image/png");
  });

  it("the archived answer is unchanged (no URL is signed for a shed binary)", async () => {
    state.tables.document_versions = { data: { org_id: ORG, archived_at: "2026-09-01T00:00:00Z", archive_id: "a1" } };
    const res = await resolve(new NextRequest(
      `https://app/api/storage/resolve?path=${encodeURIComponent(`orgs/${ORG}/libraries/l1/P-101.pdf`)}`,
      { headers: { authorization: "Bearer t" } },
    ));
    expect(await res.json()).toMatchObject({ archived: true, archiveId: "a1" });
  });

  it("the new-tab opener asks for inline — it is a reviewed inline caller", () => {
    const src = readFileSync(join(root, "components/archive/ArchiveAwareOpen.tsx"), "utf8");
    expect(src).toMatch(/\/api\/storage\/resolve\?path=\$\{encodeURIComponent\(path\)\}&inline=1/);
  });
});

describe("lib/dataExport — every per-file URL in the envelope is an attachment (SEC-18)", () => {
  it("an intake upload stored as HTML, a PDF and a logo: each URL carries the attachment disposition and no type", async () => {
    state.tables = {
      document_versions: {
        data: [
          { file_url: `orgs/${ORG}/project-intake/p1/abc-payload.html`, size: 12 },
          { file_url: `orgs/${ORG}/libraries/l1/P-101.pdf`, size: 34 },
        ],
      },
      asset_photos: { data: [{ file_url: `orgs/${ORG}/assets/photo.png`, file_size: 56 }] },
      org_configurations: { data: [{ key: "branding", data: { logoPath: `orgs/${ORG}/branding/logo.svg` } }] },
    };
    const env = await runOrgExport({
      supabaseUrl: "https://db", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u1", exporterEmail: "u1@example.com",
      presignedUrlSeconds: 600,
    });
    const byPath = new Map(env.files.map((f) => [f.path, f.presignedUrl]));
    expect(byPath.size).toBe(4);
    for (const [path, raw] of byPath) {
      expect(raw, path).toBeTruthy();
      const url = new URL(raw);
      const name = path.split("/").pop();
      expect(url.searchParams.get("response-content-disposition"), path).toMatch(new RegExp(`^attachment; filename="${name!.replace(/\./g, "\\.")}"`));
      expect(url.searchParams.get("response-content-type"), path).toBeNull();
      expect(url.searchParams.get("X-Amz-Expires"), path).toBe("600");
    }
  });
});

describe("lib/dataExport — a contractor door upload's URL is signed for UNTRUSTED_CONTENT_ORIGIN (projects-tab GAP-401, J16)", () => {
  const files = () => ({
    document_versions: {
      data: [
        { file_url: `orgs/${ORG}/project-intake/p1/abc-payload.html`, size: 12 },
        { file_url: `orgs/${ORG}/project-intake/p1/redlines/abc-mark.png`, size: 13 },
        { file_url: `orgs/${ORG}/libraries/l1/P-101.pdf`, size: 34 },
      ],
    },
    cost_documents: { data: [{ file_url: `orgs/${ORG}/project-costs/p1/quote-abc-bid.pdf`, size: 21 }] },
  });
  const exportUrls = async () => {
    state.tables = files();
    const env = await runOrgExport({
      supabaseUrl: "https://db", serviceRoleKey: "k", orgId: ORG, exporterUserId: "u1", exporterEmail: "u1@example.com",
      presignedUrlSeconds: 600,
    });
    return new Map(env.files.map((f) => [f.path, new URL(f.presignedUrl)]));
  };
  const stub = (origin: string) => {
    vi.stubEnv("R2_ACCOUNT_ID", "acct");
    vi.stubEnv("R2_BUCKET_NAME", "test-bucket");
    vi.stubEnv("R2_ACCESS_KEY_ID", "AKTEST");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "SKTEST");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.refinery.example");
    vi.stubEnv("UNTRUSTED_CONTENT_ORIGIN", origin);
  };
  afterEach(() => { vi.unstubAllEnvs(); });

  it("set: the door's drawing, redline and quote are signed path-style on storage's account host; a controlled drawing stays on the bucket host — every URL still an attachment", async () => {
    stub("https://acct.r2.cloudflarestorage.com");
    const urls = await exportUrls();
    expect(urls.size).toBe(4);
    for (const key of [`orgs/${ORG}/project-intake/p1/abc-payload.html`, `orgs/${ORG}/project-intake/p1/redlines/abc-mark.png`, `orgs/${ORG}/project-costs/p1/quote-abc-bid.pdf`]) {
      const u = urls.get(key)!;
      expect(u.origin, key).toBe("https://acct.r2.cloudflarestorage.com");
      expect(u.pathname, key).toBe(`/test-bucket/${key}`);
      expect(u.searchParams.get("response-content-disposition"), key).toMatch(/^attachment; filename="/);
      expect(u.searchParams.get("X-Amz-Expires"), key).toBe("600");
    }
    const controlled = urls.get(`orgs/${ORG}/libraries/l1/P-101.pdf`)!;
    expect(controlled.host).toBe("test-bucket.acct.r2.cloudflarestorage.com");
    expect(controlled.searchParams.get("response-content-disposition")).toMatch(/^attachment; filename="P-101\.pdf"/);
  });

  it("unset (or refused): every URL is signed exactly as before, on the bucket host", async () => {
    for (const origin of ["", "https://files.example.com"]) {
      stub(origin);
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const urls = await exportUrls();
      for (const [key, u] of urls) expect(u.host, `${origin} ${key}`).toBe("test-bucket.acct.r2.cloudflarestorage.com");
      spy.mockRestore();
    }
  });

  it("the export calls signStorageGet and no longer presigns with getSignedUrl itself", () => {
    const src = readFileSync(join(root, "lib/dataExport.ts"), "utf8");
    expect(src).toMatch(/presignedUrl = await signStorageGet\(\s*new GetObjectCommand\(\{ Bucket: R2_BUCKET, Key: path, \.\.\.disposition\.overrides \}\),\s*\{ expiresIn \},\s*\);/);
    expect(src).not.toMatch(/getSignedUrl\(/);
  });
});
