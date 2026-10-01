// public-surfaces Round F PS-VERIFY — everything around the verify routes:
//   VFY-13  force-dynamic + no-store on all four routes; robots noindex on
//           the four page segments; app/robots.ts; no sitemap lists them.
//   VFY-12  migration 20261134 (verify_scans, RLS on / no policies, the
//           90-day prune for the service role only) — one-paste protocol
//           shape; the ONE cron step; schema-health and export coverage.
//   VFY-14  verify-ticket no longer selects revision_count.
//   VFY-3   buildVerifyUrl never stamps a document-only QR.
//   PHYS-7 / HLD-13 (option b) the label keeps /assets/<tag>, its caption
//           says staff sign-in and fits the label; the protected page sends
//           a no-session scan to sign-in carrying the tag — only on
//           getSession's definitive no-session answer (lib/assetSignIn.ts).
//   VFY-10 / PHYS-10 the hold card's instruction matches the verdict.
//   PKG-12  the cover lists every sheet (continuation pages).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8");
const stripSql = (s: string) => s.replace(/--[^\n]*/g, "");

const ROUTE_MODULES: Record<string, () => Promise<{ dynamic?: string }>> = {
  "app/api/verify/route.ts": () => import("@/app/api/verify/route"),
  "app/api/verify-package/route.ts": () => import("@/app/api/verify-package/route"),
  "app/api/verify-hold/route.ts": () => import("@/app/api/verify-hold/route"),
  "app/api/verify-ticket/route.ts": () => import("@/app/api/verify-ticket/route"),
};
const ROUTES = Object.keys(ROUTE_MODULES);
type LayoutModule = { metadata: { robots: { index: boolean; follow: boolean } } };
const LAYOUT_MODULES: Record<string, () => Promise<LayoutModule>> = {
  "verify": () => import("@/app/verify/layout") as Promise<LayoutModule>,
  "verify-package": () => import("@/app/verify-package/layout") as Promise<LayoutModule>,
  "verify-hold": () => import("@/app/verify-hold/layout") as Promise<LayoutModule>,
  "verify-ticket": () => import("@/app/verify-ticket/layout") as Promise<LayoutModule>,
};

describe("VFY-13 / OFF-1 done-when 3 — the routes state their intent", () => {
  it.each(ROUTES)("%s: export const dynamic = \"force-dynamic\", answers only through verifyJson (no-store), rate-checks and records the scan", async (route) => {
    const mod = await ROUTE_MODULES[route]();
    expect(mod.dynamic).toBe("force-dynamic");
    const s = src(route);
    expect(s).not.toContain("NextResponse.json(");
    expect(s).toContain("verifyJson(");
    expect(s).toContain("const rate = await checkVerifyRate(sb, { ip });");
    expect(s).toContain("recordVerifyScan(sb, {");
  });
  it("the three pages fetch their verdict with cache: no-store", () => {
    expect(src("app/verify/[docId]/page.tsx")).toContain('{ cache: "no-store" }');
    expect(src("app/verify-package/[packageId]/page.tsx")).toContain('{ cache: "no-store" }');
    expect(src("app/verify-hold/[holdId]/page.tsx")).toContain('{ cache: "no-store" }');
  });
});

describe("VFY-13 — never indexed", () => {
  it.each(Object.keys(LAYOUT_MODULES))("app/%s/layout.tsx marks the segment noindex / nofollow", async (seg) => {
    const mod = await LAYOUT_MODULES[seg]();
    expect(mod.metadata.robots.index).toBe(false);
    expect(mod.metadata.robots.follow).toBe(false);
  });
  it("app/robots.ts disallows every scan surface and the short link", async () => {
    const robots = (await import("@/app/robots")).default();
    const rules = Array.isArray(robots.rules) ? robots.rules : [robots.rules];
    const disallow = rules.flatMap((r) => (Array.isArray(r.disallow) ? r.disallow : [r.disallow ?? ""]));
    for (const p of ["/verify/", "/verify-hold/", "/verify-package/", "/verify-ticket/", "/d/", "/api/verify"]) expect(disallow).toContain(p);
  });
  it("no sitemap exists that could list them (a future one must not)", () => {
    const appFiles = readdirSync(join(root, "app"));
    const sitemaps = appFiles.filter((f) => /^sitemap/.test(f));
    for (const f of sitemaps) expect(src(`app/${f}`)).not.toMatch(/verify|\/d\//);
    expect(existsSync(join(root, "public", "sitemap.xml"))).toBe(false);
  });
});

describe("VFY-12 — migration 20261134 (one-paste protocol, service role only)", () => {
  const M = src("supabase/migrations/20261134_ps_roundF_verify_scans.sql");
  const code = stripSql(M);
  it("the inventory is a TEMP table of counts captured BEFORE the transaction; BEGIN / COMMIT; one final SELECT (check, ok, n)", () => {
    const tmp = code.indexOf("CREATE TEMP TABLE IF NOT EXISTS _ps_f34_before AS");
    const begin = code.indexOf("\nBEGIN;");
    const commit = code.indexOf("\nCOMMIT;");
    expect(tmp).toBeGreaterThan(-1);
    expect(begin).toBeGreaterThan(tmp);
    expect(commit).toBeGreaterThan(begin);
    expect((code.match(/\nBEGIN;/g) ?? []).length).toBe(1);
    expect((code.match(/\nCOMMIT;/g) ?? []).length).toBe(1);
    const tail = code.slice(commit);
    expect(tail).toMatch(/SELECT 'verify_scans exists with RLS on and NO policies \(service role only\)' AS check,/);
    expect(tail).toContain("AS ok,");
    expect(tail).toContain("NULL::text AS n");
    expect(tail).toContain("UNION ALL SELECT inventory, NULL, n FROM _ps_f34_before;");
    // exactly one statement after COMMIT — the single result set the editor shows
    const noLiterals = tail.replace(/'(?:[^']|'')*'/g, "''");
    expect(noLiterals.replace("\nCOMMIT;", "").trim().split(";").filter((x) => x.trim()).length).toBe(1);
    // inventory rows are aggregate counts, never customer rows
    const inv = code.slice(tmp, begin);
    expect(inv).not.toMatch(/SELECT \*|ip,|user_agent|target_id/);
  });
  it("verify_scans: the spec's columns, RLS on, NO policies, default grants withdrawn, the window / evidence / prune indexes", () => {
    expect(code).toContain("CREATE TABLE IF NOT EXISTS verify_scans (");
    for (const col of ["id         UUID PRIMARY KEY DEFAULT gen_random_uuid()", "endpoint   TEXT NOT NULL CHECK (endpoint IN ('verify', 'verify-package', 'verify-hold', 'verify-ticket'))", "target_id  UUID", "printed_ref UUID", "verdict    TEXT NOT NULL", "ip         TEXT NOT NULL", "user_agent TEXT", "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"]) {
      expect(code).toContain(col);
    }
    expect(code).toContain("ALTER TABLE verify_scans ENABLE ROW LEVEL SECURITY;");
    expect(code).not.toMatch(/CREATE POLICY/i);
    expect(code).toContain("REVOKE ALL ON TABLE verify_scans FROM anon, authenticated;");
    expect(code).toContain("CREATE INDEX IF NOT EXISTS verify_scans_ip_time_idx ON verify_scans (ip, created_at DESC);");
    expect(code).toContain("CREATE INDEX IF NOT EXISTS verify_scans_target_time_idx ON verify_scans (target_id, created_at DESC);");
    expect(code).toContain("CREATE INDEX IF NOT EXISTS verify_scans_time_idx ON verify_scans (created_at);");
  });
  it("prune_verify_scans: 90 days, SECURITY INVOKER (no definer rights, no uid read), search_path pinned, service_role only", () => {
    const fn = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION prune_verify_scans()"), code.indexOf("\nCOMMIT;"));
    expect(fn).toContain("LANGUAGE sql SET search_path = public AS $$");
    expect(fn).toContain("WITH gone AS (DELETE FROM verify_scans WHERE created_at < NOW() - INTERVAL '90 days' RETURNING 1)");
    expect(fn).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(fn).not.toMatch(/auth\.uid\(\)/);
    expect(fn).toContain("REVOKE ALL ON FUNCTION prune_verify_scans() FROM PUBLIC, anon, authenticated;");
    expect(fn).toContain("GRANT EXECUTE ON FUNCTION prune_verify_scans() TO service_role;");
  });
  it("VFY-12 evidence: printed_ref (the ?v= / ?print= printing) is a column and the column probe counts all eight", () => {
    expect(code).toContain("AND column_name IN ('id', 'endpoint', 'target_id', 'printed_ref', 'verdict', 'ip', 'user_agent', 'created_at')) = 8, NULL");
  });
  it("the prosrc probe quotes its literal the verbatim way ('' inside the LIKE)", () => {
    expect(code).toContain("p.prosrc LIKE '%INTERVAL ''90 days''%'");
  });
  it("it re-creates nothing earlier migrations define (a new table and a new function only)", () => {
    const dir = join(root, "supabase", "migrations");
    for (const f of readdirSync(dir).filter((x) => /^\d{8}.*\.sql$/.test(x) && x !== "20261134_ps_roundF_verify_scans.sql")) {
      const s = readFileSync(join(dir, f), "utf8");
      expect(s, f).not.toMatch(/verify_scans|prune_verify_scans/);
    }
  });
  it("the cron prunes in ONE step on the existing route (no new vercel.json cron)", () => {
    const c = src("app/api/cron/maintenance/route.ts");
    expect((c.match(/sb\.rpc\("prune_verify_scans"\)/g) ?? []).length).toBe(1);
    expect(c).toContain('if (!isMissingFunction(scanPruneErr)) intakeLine(`verify-scans: ${scanPruneErr.message}`);');
    const vercel = JSON.parse(src("vercel.json")) as { crons?: unknown[] };
    expect((vercel.crons ?? []).length).toBeLessThanOrEqual(2);
  });
  it("schema health expects the table; the export coverage excludes it with a reason", async () => {
    const { EXPECTED_TABLES } = await import("@/lib/schemaExpectations");
    expect(EXPECTED_TABLES).toContainEqual({ table: "verify_scans", migration: "20261134_ps_roundF_verify_scans.sql" });
    const { EXPORT_EXCLUDED_TABLES } = await import("@/lib/exportTables");
    expect(EXPORT_EXCLUDED_TABLES.verify_scans).toMatch(/90-day rolling log/);
  });
});

describe("VFY-14 — verify-ticket selects only what it reads (headers / select / limits only — the verdict is drafting-flow's)", () => {
  it("revision_count is gone from the select and the row type", () => {
    const s = src("app/api/verify-ticket/route.ts");
    expect(s).toContain('.select("id, ticket_id, title, unit, status, deliverable_rev, last_modified, history")');
    expect(s).not.toContain("revision_count: number");
  });
});

describe("VFY-3 — buildVerifyUrl never stamps a document-only QR", () => {
  const prev = process.env.NEXT_PUBLIC_SITE_URL;
  beforeEach(() => { process.env.NEXT_PUBLIC_SITE_URL = "https://plant.example.com"; });
  afterEach(() => { if (prev === undefined) delete process.env.NEXT_PUBLIC_SITE_URL; else process.env.NEXT_PUBLIC_SITE_URL = prev; });
  it("no resolvable version → undefined; a version → /verify/<doc>?v=<version>", async () => {
    const { buildVerifyUrl } = await import("@/lib/downloads");
    type Ctx = Parameters<typeof buildVerifyUrl>[0];
    const ctx = (doc: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ doc, fileUrl: "blob:x", userId: "u", ...extra }) as unknown as Ctx;
    expect(buildVerifyUrl(ctx({ id: "doc1", currentVersionId: undefined }))).toBeUndefined();
    expect(buildVerifyUrl(ctx({ id: "doc1", currentVersionId: null }))).toBeUndefined();
    expect(buildVerifyUrl(ctx({ id: "doc1", currentVersionId: "v5" }))).toBe("https://plant.example.com/verify/doc1?v=v5");
    expect(buildVerifyUrl(ctx({ id: "doc1", currentVersionId: "v5" }, { versionId: "v2" }))).toBe("https://plant.example.com/verify/doc1?v=v2");
  });
});

describe("PHYS-7 / HLD-13 (option b) — the equipment label", () => {
  it("keeps the /assets/<tag> path every sticker in the field already carries", async () => {
    const prev = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = "https://plant.example.com";
    const { equipmentLabelUrl } = await import("@/lib/physicalBridge");
    expect(equipmentLabelUrl("FE-201")).toBe("https://plant.example.com/assets/FE-201");
    expect(equipmentLabelUrl("P 101/A")).toBe("https://plant.example.com/assets/P%20101%2FA");
    if (prev === undefined) delete process.env.NEXT_PUBLIC_SITE_URL; else process.env.NEXT_PUBLIC_SITE_URL = prev;
  });
  it("the caption promises only what the landing delivers — staff sign-in — and every line fits the narrowest label", async () => {
    const { LABEL_CAPTION_LINES } = await import("@/lib/physicalBridge");
    expect(LABEL_CAPTION_LINES[0]).toBe("SCAN — STAFF SIGN-IN");
    expect(src("lib/physicalBridge.ts")).not.toContain('"SCAN: drawings · holds · report a problem"');
    const doc = await PDFDocument.create();
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    // single 3.5"×2" sticker: text column = 252 − (8 + 128 + 8) − 8 = 100pt (the sheet's is 136pt)
    LABEL_CAPTION_LINES.forEach((line, i) => {
      expect((i === 0 ? bold : regular).widthOfTextAtSize(line, 7), line).toBeLessThanOrEqual(100);
    });
  });
  it("the sign-in href carries the tag in `next`", async () => {
    const { assetSignInHref } = await import("@/lib/assetSignIn");
    expect(assetSignInHref("FE-201")).toBe("/?next=%2Fassets%2FFE-201");
    expect(assetSignInHref("P 101/A")).toBe(`/?next=${encodeURIComponent("/assets/P%20101%2FA")}`);
  });
  it("the protected page redirects only on getSession's DEFINITIVE no-session answer — not on RoleContext's boot watchdog", () => {
    const s = src("app/(protected)/assets/[tag]/page.tsx");
    expect(s).toContain("const signInHref = assetSignInHref(tag);");
    expect(s).toContain("const maybeSignedOut = booted && !roleLoading && !uid;");
    expect(s).toContain("return watchForNoSession(() => supabase.auth.getSession(), (answer) => {");
    expect(s).toContain('if (answer === "none") router.replace(signInHref);');
    expect(s).toContain("const signedOut = maybeSignedOut && sessionAnswer !== null;");
    // the old redirect on the boot signal alone is gone
    expect(s).not.toContain("if (signedOut) router.replace(signInHref);");
    expect(s).not.toContain("const signedOut = booted && !roleLoading && !uid;");
    // the signed-out branch renders before the data spinner that never ended
    expect(s.indexOf("if (signedOut) {")).toBeLessThan(s.indexOf("if (loading && docs.length === 0 && !asset)"));
  });
});

describe("PHYS-7 — watchForNoSession: booted can flip while getSession is still pending", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  type Answer = { data: { session: unknown } | null; error?: unknown };
  function pending() {
    let resolve!: (a: Answer) => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<Answer>((res, rej) => { resolve = res; reject = rej; });
    return { get: () => p, resolve, reject };
  }
  it("while getSession is pending nothing happens; a session that then arrives never redirects", async () => {
    const { watchForNoSession } = await import("@/lib/assetSignIn");
    const s = pending();
    const answers: string[] = [];
    watchForNoSession(s.get, (a) => answers.push(a));
    await flush();
    expect(answers).toEqual([]); // the boot watchdog fired; getSession has not answered — no redirect
    s.resolve({ data: { session: { user: { id: "u1" } } }, error: null });
    await flush();
    expect(answers).toEqual([]); // signed in after all — stays on the tag
  });
  it("a resolved answer with no session and no error is the one definitive 'none' (the redirect)", async () => {
    const { watchForNoSession } = await import("@/lib/assetSignIn");
    const answers: string[] = [];
    watchForNoSession(async () => ({ data: { session: null }, error: null }), (a) => answers.push(a));
    await flush();
    expect(answers).toEqual(["none"]);
  });
  it("an errored or rejected session read is 'unknown' — offer sign-in, do not navigate away", async () => {
    const { watchForNoSession } = await import("@/lib/assetSignIn");
    const answers: string[] = [];
    watchForNoSession(async () => ({ data: { session: null }, error: new Error("refresh failed: network") }), (a) => answers.push(a));
    watchForNoSession(() => Promise.reject(new Error("offline")), (a) => answers.push(a));
    await flush();
    expect(answers).toEqual(["unknown", "unknown"]);
  });
  it("an answer that arrives after the effect is cleaned up is ignored", async () => {
    const { watchForNoSession } = await import("@/lib/assetSignIn");
    const s = pending();
    const answers: string[] = [];
    const cancel = watchForNoSession(s.get, (a) => answers.push(a));
    cancel();
    s.resolve({ data: { session: null }, error: null });
    await flush();
    expect(answers).toEqual([]);
  });
});

describe("VFY-10 / PHYS-10 — the hold card says what the scan answers", () => {
  it("green only when no hold remains; amber leaves the equipment tagged; each line fits left of the QR", async () => {
    const { HOLD_CARD_SCAN_LINES, HOLD_CARD_TEXT_WIDTH } = await import("@/lib/physicalBridge");
    expect(HOLD_CARD_SCAN_LINES[0]).toContain("GREEN when scanned = no hold remains on this document");
    expect(HOLD_CARD_SCAN_LINES[1]).toContain("leave the equipment tagged");
    expect(src("lib/physicalBridge.ts")).not.toContain("A released hold shows GREEN when scanned — then this tag comes down.");
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    for (const line of HOLD_CARD_SCAN_LINES) expect(regular.widthOfTextAtSize(line, 9), line).toBeLessThanOrEqual(HOLD_CARD_TEXT_WIDTH);
  });
});

describe("PKG-12 — the cover lists every sheet", () => {
  it("coverContentsChunks covers every index exactly once, in order", async () => {
    const { coverContentsChunks, COVER_FIRST_PAGE_ROWS, COVER_CONTINUATION_ROWS } = await import("@/lib/physicalBridge");
    expect(coverContentsChunks(0)).toEqual([]);
    for (const n of [1, 23, 24, 25, 64, 65, 200]) {
      const chunks = coverContentsChunks(n);
      const seen = chunks.flatMap(([a, b]) => Array.from({ length: b - a }, (_, i) => a + i));
      expect(seen, String(n)).toEqual(Array.from({ length: n }, (_, i) => i));
      expect(chunks[0][1] - chunks[0][0]).toBeLessThanOrEqual(COVER_FIRST_PAGE_ROWS);
      for (const [a, b] of chunks.slice(1)) expect(b - a).toBeLessThanOrEqual(COVER_CONTINUATION_ROWS);
    }
    expect(coverContentsChunks(65).length).toBe(3);
  });
  it("a 30-sheet pack builds a two-page cover and no '…and N more sheets' summary", async () => {
    const { buildPackageCover } = await import("@/lib/physicalBridge");
    const docs = Array.from({ length: 30 }, (_, i) => ({ label: `P-${100 + i}`, rev: String(i) }));
    const cover = await buildPackageCover({ packageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", printId: null, name: "TA-2026", docs });
    expect(cover.getPageCount()).toBe(2);
    expect(src("lib/physicalBridge.ts")).not.toContain("more sheets`");
  });
});
