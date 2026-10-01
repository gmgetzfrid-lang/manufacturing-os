// projects Round G — SEC-7 and the egress limb of SEC-1 (DEC-49): a
// presigned download arrives as an ATTACHMENT unless an in-app viewer asks
// for inline AND the key is a PDF or a raster image; an inline URL pins its
// Content-Type; the in-app viewer renders only a PDF (its one frame) or a
// raster image (an <img>, never a frame), re-typed to exactly that.
//
// The route tests sign with the REAL presigner (a real S3 client with inert
// credentials — presigning is local), so the assertions read the actual
// `response-content-disposition` / `response-content-type` parameters the
// browser will receive back as headers.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
  tables: {} as Record<string, { data?: unknown; error?: unknown }>,
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
          return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
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
// A REAL client: the route's getSignedUrl runs for real, offline.
vi.mock("@/lib/r2", async () => {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return {
    r2: new S3Client({
      region: "auto",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "AKTEST", secretAccessKey: "SKTEST" },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }),
    R2_BUCKET: "test-bucket",
  };
});

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GET as downloadUrl } from "@/app/api/storage/download-url/route";
import {
  presignedGetDisposition, inlineTypeForKey, wantsInline, storageKeyFilename, viewerRenderKind,
  INLINE_TYPES_BY_EXTENSION,
} from "@/lib/presignedDisposition";
import { getSignedUrlForPath, resolveFileUrl, peekSignedUrl, clearSignedUrlCache, subscribeSignedUrl } from "@/lib/storage";

const root = process.cwd();
const ORG = "12345678-1234-1234-1234-123456789abc";
const read = (f: string) => readFileSync(join(root, f), "utf8");

beforeEach(() => {
  state.user = { id: "u1", email: "u1@example.com" };
  state.tables = { org_members: { data: { uid: "u1" } }, document_versions: { data: null } };
});

describe("presignedGetDisposition — attachment by default, inline only when asked AND safe", () => {
  it("the default is an attachment for every kind of key, and no type is pinned", () => {
    for (const key of ["orgs/o/a.pdf", "orgs/o/b.png", "orgs/o/payload.html", "orgs/o/c.svg", "orgs/o/noext", "orgs/o/d.dwg"]) {
      const d = presignedGetDisposition(key, false);
      expect(d.inline, key).toBe(false);
      expect(d.contentType, key).toBeNull();
      expect(d.overrides.ResponseContentDisposition, key).toMatch(/^attachment; filename="/);
      expect(d.overrides.ResponseContentType, key).toBeUndefined();
    }
  });
  it("inline, when asked, only for a PDF or a raster image — and the type is pinned", () => {
    expect(presignedGetDisposition("orgs/o/P-101.PDF", true)).toEqual({
      inline: true,
      contentType: "application/pdf",
      overrides: {
        ResponseContentDisposition: `inline; filename="P-101.PDF"; filename*=UTF-8''P-101.PDF`,
        ResponseContentType: "application/pdf",
      },
    });
    expect(presignedGetDisposition("orgs/o/photo.jpg", true).overrides.ResponseContentType).toBe("image/jpeg");
    expect(presignedGetDisposition("orgs/o/photo.jpeg", true).overrides.ResponseContentType).toBe("image/jpeg");
    expect(presignedGetDisposition("orgs/o/x.webp", true).contentType).toBe("image/webp");
  });
  it("asking for inline on anything a browser would render as a PAGE still gets an attachment", () => {
    for (const key of ["orgs/o/payload.html", "orgs/o/x.htm", "orgs/o/drawing.svg", "orgs/o/x.xml", "orgs/o/x.xhtml",
      "orgs/o/x.js", "orgs/o/x.txt", "orgs/o/noext", "orgs/o/.pdf", "orgs/o/x.pdf.html", "orgs/o/x.html.png.svg"]) {
      const d = presignedGetDisposition(key, true);
      expect(d.inline, key).toBe(false);
      expect(d.overrides.ResponseContentDisposition, key).toMatch(/^attachment;/);
    }
    expect(Object.values(INLINE_TYPES_BY_EXTENSION).some((t) => /svg|html|xml|javascript/.test(t))).toBe(false);
  });
  it("the file name is the key's last segment, folded safe for a header", () => {
    expect(storageKeyFilename("orgs/o/lib/P-101 Rev B.pdf")).toBe("P-101 Rev B.pdf");
    expect(storageKeyFilename("orgs/o/")).toBe("file");
    const d = presignedGetDisposition(`orgs/o/Ölplan "A"\r\n.pdf`, false).overrides.ResponseContentDisposition;
    expect(d).not.toMatch(/[\r\n]/);
    expect(d).toMatch(/^attachment; filename="Olplan A.pdf"; filename\*=UTF-8''%C3%96lplan%20A.pdf$/);
  });
  it("wantsInline: only an explicit 1 / true", () => {
    for (const v of ["1", "true", " TRUE "]) expect(wantsInline(v), v).toBe(true);
    for (const v of [null, undefined, "", "0", "false", "yes", "inline"]) expect(wantsInline(v), String(v)).toBe(false);
  });
  it("inlineTypeForKey reads the LAST extension only", () => {
    expect(inlineTypeForKey("a/b/c.tar.pdf")).toBe("application/pdf");
    expect(inlineTypeForKey("a/b/c.pdf.exe")).toBeNull();
  });
});

describe("viewerRenderKind — what the in-app viewer may frame", () => {
  it("PDF and raster images, case-insensitive, parameters stripped — re-typed to the canonical type", () => {
    expect(viewerRenderKind("application/pdf")).toEqual({ kind: "pdf", type: "application/pdf" });
    expect(viewerRenderKind("Application/PDF; charset=binary")).toEqual({ kind: "pdf", type: "application/pdf" });
    expect(viewerRenderKind("image/png")).toEqual({ kind: "image", type: "image/png" });
    expect(viewerRenderKind("image/jpeg")).toEqual({ kind: "image", type: "image/jpeg" });
  });
  it("never HTML, SVG, XML, script, text, octet-stream or an empty type", () => {
    for (const t of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/xml",
      "text/javascript", "text/plain", "application/octet-stream", "", null, undefined]) {
      expect(viewerRenderKind(t), String(t)).toBeNull();
    }
  });
});

describe("the real presigner carries the disposition on the URL (SEC-1 done-when 4)", () => {
  const client = new S3Client({
    region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com",
    credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
  });
  it("default: response-content-disposition=attachment, no type override", async () => {
    const d = presignedGetDisposition("orgs/o/payload.html", false);
    const url = new URL(await getSignedUrl(client, new GetObjectCommand({ Bucket: "b", Key: "orgs/o/payload.html", ...d.overrides }), { expiresIn: 60 }));
    expect(url.searchParams.get("response-content-disposition")).toBe(`attachment; filename="payload.html"; filename*=UTF-8''payload.html`);
    expect(url.searchParams.get("response-content-type")).toBeNull();
    // Signed, not appended: the override is covered by the signature.
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("GET /api/storage/download-url — the signed URL's disposition (SEC-7)", () => {
  const sign = async (key: string, qs = "") => {
    const res = await downloadUrl(new NextRequest(
      `https://app/api/storage/download-url?path=${encodeURIComponent(key)}${qs}`,
      { headers: { authorization: "Bearer t" } },
    ));
    const body = await res.json() as { url: string; expiresIn: number; disposition: string; contentType: string | null };
    return { res, body, url: new URL(body.url) };
  };

  it("DEFAULT: attachment, named after the key — even for a PDF", async () => {
    const { res, body, url } = await sign(`orgs/${ORG}/libraries/l1/P-101.pdf`);
    expect(res.status).toBe(200);
    expect(url.searchParams.get("response-content-disposition")).toBe(`attachment; filename="P-101.pdf"; filename*=UTF-8''P-101.pdf`);
    expect(url.searchParams.get("response-content-type")).toBeNull();
    expect(body.disposition).toBe("attachment");
    expect(body.contentType).toBeNull();
    // What P2 EGRESS landed is untouched: the granted window and no-store.
    expect(body.expiresIn).toBe(3600);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("a stored HTML upload is an attachment whatever the caller asks", async () => {
    for (const qs of ["", "&inline=1", "&inline=true"]) {
      const { body, url } = await sign(`orgs/${ORG}/project-intake/p1/abc-payload.html`, qs);
      expect(url.searchParams.get("response-content-disposition"), qs).toMatch(/^attachment; filename="abc-payload.html"/);
      expect(body.disposition, qs).toBe("attachment");
    }
  });

  it("inline=1 on a PDF: inline, and the Content-Type is pinned to application/pdf", async () => {
    const { body, url } = await sign(`orgs/${ORG}/libraries/l1/P-101.pdf`, "&inline=1");
    expect(url.searchParams.get("response-content-disposition")).toMatch(/^inline; filename="P-101.pdf"/);
    expect(url.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(body).toMatchObject({ disposition: "inline", contentType: "application/pdf" });
  });

  it("anything but an explicit opt-in is an attachment", async () => {
    for (const qs of ["&inline=0", "&inline=yes", "&inline="]) {
      const { body } = await sign(`orgs/${ORG}/libraries/l1/P-101.pdf`, qs);
      expect(body.disposition, qs).toBe("attachment");
    }
  });
});

describe("lib/storage — attachment by default, inline only where a caller opts in", () => {
  const fetches: string[] = [];
  let seq = 0;
  beforeEach(() => {
    clearSignedUrlCache();
    fetches.length = 0;
    seq = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      fetches.push(String(input));
      return new Response(JSON.stringify({ url: `https://r2/signed-${++seq}`, expiresIn: 3600 }), { status: 200 });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("getSignedUrlForPath asks for no inline by default; { inline: true } asks for it; the two are cached apart", async () => {
    const PATH = "orgs/o1/lib/P-1.pdf";
    const attachment = await getSignedUrlForPath(PATH);
    expect(fetches[0]).not.toMatch(/inline=/);
    const inline = await getSignedUrlForPath(PATH, undefined, { inline: true });
    expect(fetches[1]).toMatch(/&inline=1$/);
    expect(inline).not.toBe(attachment);
    // Each is reused from its own entry; the image seed reads the attachment one.
    expect(await getSignedUrlForPath(PATH)).toBe(attachment);
    expect(await getSignedUrlForPath(PATH, undefined, { inline: true })).toBe(inline);
    expect(fetches).toHaveLength(2);
    expect(peekSignedUrl(PATH)?.url).toBe(attachment);
  });

  it("resolveFileUrl is the viewers' resolver: it asks for inline", async () => {
    await resolveFileUrl("orgs/o1/lib/P-2.pdf");
    expect(fetches[0]).toMatch(/&inline=1$/);
  });

  it("subscribeSignedUrl (images on screen) asks for an attachment", async () => {
    const stop = subscribeSignedUrl("orgs/o1/branding/logo.png", () => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetches[0]).not.toMatch(/inline=/);
    stop();
  });
});

describe("census — every presigned GET issuer under app/api and lib signs a disposition", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return f === "__tests__" || f === "node_modules" ? [] : walk(p);
      return /\.tsx?$/.test(p) ? [p] : [];
    });
  }
  // The two known bare issuers, both SEC-18 and both owned elsewhere:
  // /api/storage/resolve (the archive-aware opener — drafting-flow DF-P11,
  // which re-checks its ACL after document-control P2) and
  // lib/dataExport.ts (the data-export envelope's per-file URLs —
  // admin-and-org P2, the export contract). Each adopts
  // presignedGetDisposition in its own package. Named here so they stay
  // visible and nothing joins them.
  const KNOWN_UNSIGNED = new Set(["app/api/storage/resolve/route.ts", "lib/dataExport.ts"]);
  it("download-url carries one (the transmittal portal no longer signs — it streams, TRX-5); nothing new signs a bare GetObjectCommand", () => {
    const issuers: string[] = [];
    const bare: string[] = [];
    for (const file of [...walk(join(root, "app", "api")), ...walk(join(root, "lib"))]) {
      const src = readFileSync(file, "utf8");
      if (!/getSignedUrl\(/.test(src) || !/new GetObjectCommand\(/.test(src)) continue;
      const rel = file.replace(root + "/", "");
      issuers.push(rel);
      if (!/ResponseContentDisposition|\.\.\.disposition\.overrides/.test(src) && !KNOWN_UNSIGNED.has(rel)) bare.push(rel);
    }
    expect(issuers).toEqual(expect.arrayContaining([
      "app/api/storage/download-url/route.ts", ...KNOWN_UNSIGNED,
    ]));
    expect(issuers).not.toContain("app/api/transmittal/route.ts");
    expect(bare).toEqual([]);
  });
});

describe("source pins — the viewer (SEC-1 egress limb) and the reviewed inline callers", () => {
  const viewer = read("components/viewers/SecureDocViewer.tsx");
  it("the viewer asks the route for inline — it is a reviewed inline caller", () => {
    expect(viewer).toMatch(/\/api\/storage\/download-url\?path=\$\{encodeURIComponent\(url\)\}&expiresIn=3600&inline=1/);
  });
  it("it frames only what viewerRenderKind admits, re-typed to that exact type", () => {
    expect(viewer).toMatch(/const view = viewerRenderKind\(blob\.type\);/);
    expect(viewer).toMatch(/URL\.createObjectURL\(new Blob\(\[blob\], \{ type: view\.type \}\)\)/);
    expect(viewer).not.toMatch(/URL\.createObjectURL\(blob\)/);
    // The old unconditional direct-stream fallback is gone.
    expect(viewer).not.toMatch(/setBlobUrl\(resolvedUrl\);/);
    expect(viewer).toMatch(/blobUrl && blobKind === 'pdf' \?/);
  });
  it("an image is an <img>, never a frame — the PDF frame is the viewer's only frame", () => {
    expect(viewer).toMatch(/blobUrl && blobKind === 'image' \? \([\s\S]*?<img\s+src=\{blobUrl\}/);
    expect((viewer.match(/<iframe/g) ?? []).length).toBe(1);
    expect(viewer).toMatch(/blobUrl && blobKind === 'pdf' \? \([\s\S]*?<iframe\s/);
    // A forward guard only: the PDF frame carries no sandbox today (DEC-49 —
    // Chromium refuses its PDF viewer in a sandboxed frame), so this pins
    // nothing present; it refuses a future sandbox that grants allow-* tokens.
    expect(viewer).not.toMatch(/sandbox=["{][^"}]*allow-/);
  });
  it("a legacy cross-origin URL is shown only when its path NAMES a PDF or a raster image — never framed blind", () => {
    expect(viewer).toMatch(/return viewerRenderKind\(inlineTypeForKey\(u\.pathname\)\)\?\.kind \?\? null;/);
    expect(viewer).not.toMatch(/return 'pdf';/);
    // What that rule admits, by name: a .pdf or an image — not .html / .svg / no extension.
    const kindFor = (path: string) => viewerRenderKind(inlineTypeForKey(new URL(path, "https://r2.example").pathname))?.kind ?? null;
    expect(kindFor("/bucket/orgs/o/P-101.pdf")).toBe("pdf");
    expect(kindFor("/bucket/orgs/o/photo.JPG")).toBe("image");
    for (const p of ["/bucket/orgs/o/payload.html", "/bucket/orgs/o/d.svg", "/bucket/orgs/o/noext", "/bucket/orgs/o/x.pdf/"]) {
      expect(kindFor(p), p).toBeNull();
    }
  });
  it("the framing callers outside the viewer opt in explicitly; the lib's viewer resolvers ask for inline", () => {
    expect(read("app/(protected)/requests/[id]/page.tsx")).toMatch(/getSignedUrlForPath\(file\.url, undefined, \{ inline: true \}\)/);
    expect(read("components/knowledge/CitedPageViewer.tsx")).toMatch(/getSignedUrlForPath\(view\.fileKey, undefined, \{ inline: true \}\)/);
    const storage = read("lib/storage.ts");
    expect(storage).toMatch(/const url = await getPresignedDownloadUrl\(value, expiresIn, true\);/);
    expect(storage).toMatch(/return await getPresignedDownloadUrl\(value, expiresIn, true\);/);
    expect(storage).toMatch(/return getPresignedDownloadUrl\(path, expiresIn, opts\.inline === true\);/);
  });
});
