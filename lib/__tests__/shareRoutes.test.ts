// document-control Round F — P1 SHARE (+ public-surfaces PKG-3 SHARE-LINKS).
//
//   * lib/shareRules.ts — the pure rules: expiry (never-expires refused, 90-day
//     ceiling), the status refusal (Draft + NOT_CURRENT_STATUSES + archived),
//     the servable-version test (published, not a branch, not superseded).
//   * lib/shareServe.ts — the ONE decision both public routes run: a
//     Superseded / Void / Archived / Draft or held document is REFUSED with
//     the reason (fail-closed on an unreadable hold set); the current
//     pointer must name a published row; the fallback carries the same
//     filters; the footer says "scan the QR" only when a QR was stamped.
//     (DRLS-5, EGR-5, REV-10, SHR-3, SHR-6, SHR-7, SHR-11, DIST-6)
//   * /api/share/file — the distribution record is written BEFORE the bytes
//     leave, attributed to the SHARE (user_id NULL, share_id, source), and
//     a refused write refuses the download (DIST-7 / EGR-3 / SHR-5 / PHYS-8);
//     one access row per download with IP + UA (SHR-10).
//   * /api/share/resolve — status / rev of the served version on the page,
//     an access row per open, the counter RPC checked (SHR-12).
//   * lib/documentShares.ts — minting: refused expiry, refused status / hold
//     with the reason, the RLS refusal mapped to a sentence, an audit row on
//     create and on revoke (DIST-6 / SHR-4 / EGR-6).
//   * 20261080 / 20261081 — shape-pinned; the INSERT policy and the anchor
//     guard are byte-carried from 20261037 / 20261026 (lineDiff), the
//     counter function from 20260818; the SQL status set equals the app's.
//   * ShareLinkModal / the landing page — no "never expires", publicOrigin
//     for the copied link and QR (PHYS-13), the "always current" statement.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { shareExpiryFor, shareStatusRefusal, versionServable, SHARE_MAX_DAYS, SHARE_DEFAULT_DAYS } from "@/lib/shareRules";
import { shareFooterNotice, requestMeta } from "@/lib/shareServe";

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8");
const mig = (f: string) => readFileSync(join(root, "supabase", "migrations", f), "utf8");
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
const stripSqlComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");

// ── one Proxy-chain client for the routes (service role) and the lib (browser)
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  share: null as null | Row,
  doc: null as null | Row,
  holds: { data: [] as Row[], error: null as null | { message: string } },
  versionById: {} as Record<string, Row>,
  latest: [] as Row[],
  inserts: [] as Array<{ table: string; payload: Row }>,
  insertError: {} as Record<string, { message: string; code?: string } | undefined>,
  updateRows: [] as Row[],
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  rpcCalls: [] as Array<{ fn: string; args: Row }>,
  rpcResult: { data: null as unknown, error: null as null | { message: string } },
  origin: "https://app.example.com",
  authorized: true,
  audits: [] as Row[],
}));

function makeClient() {
  function chain(table: string) {
    let op: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    const eqs: Array<[string, unknown]> = [];
    const c: Row = {};
    const terminal = () => {
      if (op === "insert") {
        state.inserts.push({ table, payload });
        const err = state.insertError[table];
        return { data: err ? null : [payload], error: err ?? null };
      }
      if (op === "update") return { data: state.updateRows, error: null };
      if (table === "document_holds") return state.holds;
      if (table === "document_versions") return { data: state.latest, error: null };
      return { data: null, error: null };
    };
    const handler: ProxyHandler<Row> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(terminal());
        return (...args: unknown[]) => {
          state.calls.push({ table, method: prop, args });
          if (prop === "insert") { op = "insert"; payload = args[0] as Row; }
          if (prop === "update") { op = "update"; payload = args[0] as Row; }
          if (prop === "eq") eqs.push([args[0] as string, args[1]]);
          if (prop === "maybeSingle" || prop === "single") {
            if (op === "insert") {
              state.inserts.push({ table, payload });
              const err = state.insertError[table];
              return Promise.resolve({ data: err ? null : { id: "new-share", ...payload }, error: err ?? null });
            }
            if (table === "document_shares") return Promise.resolve({ data: state.share, error: null });
            if (table === "documents") return Promise.resolve({ data: state.doc, error: null });
            if (table === "orgs") return Promise.resolve({ data: { name: "Org A" }, error: null });
            if (table === "document_versions") {
              const id = eqs.find(([k]) => k === "id")?.[1] as string | undefined;
              return Promise.resolve({ data: (id && state.versionById[id]) || null, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          }
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return {
    from: (t: string) => chain(t),
    rpc: vi.fn(async (fn: string, args: Row) => { state.rpcCalls.push({ fn, args }); return state.rpcResult; }),
    auth: { getSession: async () => ({ data: { session: null } }) },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeClient() }));
vi.mock("@/lib/supabase", () => ({ supabase: makeClient() }));
vi.mock("@/lib/shareAuthorization", () => ({ shareStillAuthorized: vi.fn(async () => state.authorized) }));
vi.mock("@/lib/publicOrigin", () => ({ publicOrigin: () => state.origin }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (e: Row) => { state.audits.push(e); return { error: null }; }) }));
vi.mock("@aws-sdk/client-s3", () => ({ GetObjectCommand: class { constructor(public input: unknown) {} } }));
const r2 = vi.hoisted(() => ({ send: vi.fn(async () => ({ Body: { transformToByteArray: async () => new Uint8Array([9, 9, 9]) } })) }));
vi.mock("@/lib/r2", () => ({ r2, R2_BUCKET: "bucket" }));
const stamp = vi.hoisted(() => ({ calls: [] as Row[] }));
vi.mock("@/lib/stamping", () => ({ applyStampToPdfDoc: vi.fn(async (_d: unknown, opts: Row) => { stamp.calls.push(opts); }) }));
vi.mock("pdf-lib", () => ({ PDFDocument: { load: vi.fn(async () => ({ save: async () => new Uint8Array([1, 2, 3]) })) } }));

const TOKEN = "t".repeat(32);
const liveShare = (): Row => ({ id: "s1", org_id: "orgA", document_id: "docA", created_by: "u1", expires_at: null, revoked_at: null });
const issuedDoc = (over: Row = {}): Row => ({
  id: "docA", document_number: "P-101", title: "Relief P&ID", name: null, rev: "A", status: "Issued", archived_at: null,
  current_version_id: "v-cur", ...over,
});
const publishedVersion = (over: Row = {}): Row => ({
  id: "v-cur", file_url: "org/docA/v-cur.pdf", revision_label: "B", review_state: "approved", is_branch: false, superseded_at: null, ...over,
});

beforeEach(() => {
  state.share = liveShare();
  state.doc = issuedDoc();
  state.holds = { data: [], error: null };
  state.versionById = { "v-cur": publishedVersion() };
  state.latest = [];
  state.inserts = [];
  state.insertError = {};
  state.updateRows = [];
  state.calls = [];
  state.rpcCalls = [];
  state.rpcResult = { data: null, error: null };
  state.origin = "https://app.example.com";
  state.authorized = true;
  state.audits = [];
  stamp.calls = [];
  r2.send.mockClear();
});

const fileGet = async (headers: Record<string, string> = {}) => {
  const { GET } = await import("@/app/api/share/file/route");
  return GET(new NextRequest(`https://app/api/share/file?token=${TOKEN}`, { headers }));
};
const resolveGet = async (headers: Record<string, string> = {}) => {
  const { GET } = await import("@/app/api/share/resolve/route");
  return GET(new NextRequest(`https://app/api/share/resolve?token=${TOKEN}`, { headers }));
};
const inserted = (table: string) => state.inserts.filter((i) => i.table === table).map((i) => i.payload);

// ── 1. the pure rules ────────────────────────────────────────────────────────
describe("lib/shareRules — expiry, status, servable version", () => {
  it("never-expires (0) and anything past 90 days are REFUSED, never clamped; default is 30", () => {
    const now = Date.UTC(2026, 8, 23);
    expect(SHARE_DEFAULT_DAYS).toBe(30);
    expect(SHARE_MAX_DAYS).toBe(90);
    for (const bad of [0, -1, NaN, Infinity, 91, 365]) expect(shareExpiryFor(bad, now).ok).toBe(false);
    expect(shareExpiryFor(0, now)).toMatchObject({ ok: false, reason: expect.stringMatching(/must expire/) });
    expect(shareExpiryFor(91, now)).toMatchObject({ ok: false, reason: expect.stringMatching(/at most 90 days/) });
    expect(shareExpiryFor(undefined, now)).toEqual({ ok: true, expiresAt: new Date(now + 30 * 86_400_000).toISOString() });
    expect(shareExpiryFor(90, now)).toEqual({ ok: true, expiresAt: new Date(now + 90 * 86_400_000).toISOString() });
    expect(shareExpiryFor(1, now)).toEqual({ ok: true, expiresAt: new Date(now + 86_400_000).toISOString() });
  });
  it("refuses Draft, every NOT_CURRENT status (the shared set) and an archived record, with the reason; Issued / Locked pass", () => {
    expect(shareStatusRefusal({ status: "Draft" })).toMatch(/draft/);
    for (const s of NOT_CURRENT_STATUSES) expect(shareStatusRefusal({ status: s })).toMatch(new RegExp(`withdrawn \\(${s.toLowerCase()}\\)`));
    expect(shareStatusRefusal({ status: "Issued", archived_at: "2026-01-01" })).toMatch(/archived/);
    expect(shareStatusRefusal({ status: "Issued" })).toBeNull();
    expect(shareStatusRefusal({ status: "Locked", archived_at: null })).toBeNull();
  });
  it("a version serves only when it has a file, is null/approved, not a branch and not superseded", () => {
    expect(versionServable(publishedVersion())).toBe(true);
    expect(versionServable(publishedVersion({ review_state: null }))).toBe(true);
    expect(versionServable(publishedVersion({ review_state: "in_review" }))).toBe(false);
    expect(versionServable(publishedVersion({ is_branch: true }))).toBe(false);
    expect(versionServable(publishedVersion({ superseded_at: "2026-01-01" }))).toBe(false);
    expect(versionServable(publishedVersion({ file_url: null }))).toBe(false);
    expect(versionServable(null)).toBe(false);
  });
  it("the footer instructs a scan ONLY when a verify URL was stamped, and states the served rev, status and the always-current rule", () => {
    const withQr = shareFooterNotice({ label: "P-101", rev: "B", status: "Issued", verifyUrl: "https://x/verify/d?v=v" });
    expect(withQr).toMatch(/^P-101 Rev B \(Issued\) at time of download — a share always serves the current revision\. Scan the QR/);
    const noQr = shareFooterNotice({ label: "P-101", rev: "B", status: "Issued", verifyUrl: undefined });
    expect(noQr).not.toMatch(/QR/);
    expect(noQr).toMatch(/Verify the current revision/);
  });
  it("requestMeta takes the first forwarded-for hop and the user agent, bounded, never identity", () => {
    const meta = requestMeta(new NextRequest("https://app/x", { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1", "user-agent": "UA/1" } }));
    expect(meta).toEqual({ ip: "203.0.113.9", userAgent: "UA/1" });
    expect(requestMeta(new NextRequest("https://app/x"))).toEqual({ ip: null, userAgent: null });
    expect(requestMeta(new NextRequest("https://app/x", { headers: { "user-agent": "x".repeat(600) } })).userAgent).toHaveLength(512);
  });
});

// ── 2. /api/share/file ───────────────────────────────────────────────────────
describe("GET /api/share/file — refuses before any byte leaves", () => {
  it("a Superseded document is refused with the reason (410 withdrawn): no bucket read, no record", async () => {
    state.doc = issuedDoc({ status: "Superseded" });
    const res = await fileGet();
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: "withdrawn", reason: expect.stringMatching(/withdrawn \(superseded\)/), documentStatus: "Superseded" });
    expect(r2.send).not.toHaveBeenCalled();
    expect(inserted("download_audits")).toHaveLength(0);
  });
  it("Void, Archived, Draft and archived_at are all refused (the routes read status now)", async () => {
    for (const doc of [issuedDoc({ status: "Void" }), issuedDoc({ status: "Archived" }), issuedDoc({ status: "Draft" }), issuedDoc({ archived_at: "2026-02-02" })]) {
      state.doc = doc; state.inserts = [];
      const res = await fileGet();
      expect(res.status, JSON.stringify(doc)).toBe(410);
      expect((await res.json()).error).toBe("withdrawn");
    }
    expect(r2.send).not.toHaveBeenCalled();
    // the document select carries status + archived_at and the org join
    const sel = state.calls.find((c) => c.table === "documents" && c.method === "select");
    expect(String(sel?.args[0])).toMatch(/\bstatus\b/);
    expect(String(sel?.args[0])).toMatch(/\barchived_at\b/);
    expect(state.calls).toContainEqual({ table: "documents", method: "eq", args: ["org_id", "orgA"] });
  });
  it("an active hold refuses (423 on_hold) naming the hold; an UNREADABLE hold set refuses too (fail-closed)", async () => {
    state.holds = { data: [{ id: "h1", reason: "Field Verification Needed", opened_at: null, opened_by_name: null }], error: null };
    let res = await fileGet();
    expect(res.status).toBe(423);
    expect(await res.json()).toMatchObject({ error: "on_hold", reason: expect.stringMatching(/Field Verification Needed/), unreadable: false });
    state.holds = { data: [], error: { message: "boom" } };
    res = await fileGet();
    expect(res.status).toBe(423);
    expect(await res.json()).toMatchObject({ error: "on_hold", unreadable: true });
    expect(r2.send).not.toHaveBeenCalled();
    expect(inserted("download_audits")).toHaveLength(0);
  });
  it("a current pointer at an in_review row (SHR-6 failure window) is NOT served and NOT fallen past; a branch / superseded current row likewise", async () => {
    for (const bad of [{ review_state: "in_review" }, { is_branch: true }, { superseded_at: "2026-01-01" }]) {
      state.versionById = { "v-cur": publishedVersion(bad) };
      state.latest = [publishedVersion({ id: "v-old", file_url: "old.pdf", revision_label: "A" })];
      state.calls = [];
      const res = await fileGet();
      expect(res.status, JSON.stringify(bad)).toBe(404);
      expect((await res.json()).error).toBe("nofile");
      // no fallback query ran — the pointer names an unpublished row, an anomaly to refuse
      expect(state.calls.filter((c) => c.table === "document_versions" && c.method === "order")).toHaveLength(0);
    }
    expect(r2.send).not.toHaveBeenCalled();
  });
  it("the fallback (no current pointer) excludes branches and superseded rows at the query AND refuses one that slips through", async () => {
    state.doc = issuedDoc({ current_version_id: null });
    state.latest = [publishedVersion({ id: "v-branch", is_branch: true })];
    const res = await fileGet();
    expect(res.status).toBe(404);
    expect(state.calls).toContainEqual({ table: "document_versions", method: "eq", args: ["is_branch", false] });
    expect(state.calls).toContainEqual({ table: "document_versions", method: "is", args: ["superseded_at", null] });
    expect(state.calls).toContainEqual({ table: "document_versions", method: "or", args: ["review_state.is.null,review_state.eq.approved"] });
    expect(state.calls).toContainEqual({ table: "document_versions", method: "not", args: ["file_url", "is", null] });
    // a clean fallback row serves
    state.latest = [publishedVersion({ id: "v-old", file_url: "old.pdf", revision_label: "A" })];
    const ok = await fileGet();
    expect(ok.status).toBe(200);
    expect(inserted("download_audits")[0]).toMatchObject({ version_id: "v-old" });
  });
  it("happy path: the record lands BEFORE the bytes, attributed to the SHARE; the copy names the SERVED version's label; the footer says scan", async () => {
    const res = await fileGet({ "x-forwarded-for": "198.51.100.7", "user-agent": "Vendor/2" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // filename from document_versions.revision_label ("B"), not documents.rev ("A") — SHR-7
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="P-101_RevB.pdf"');
    const audit = inserted("download_audits");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      org_id: "orgA", document_id: "docA", version_id: "v-cur", user_id: null, user_email: null,
      share_id: "s1", source: "share_link", watermark_policy_id: null,
    });
    expect(audit[0]).not.toHaveProperty("user_id", "u1");
    // the access row: IP + UA, kind download, no identity
    const access = inserted("document_share_accesses");
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({ share_id: "s1", org_id: "orgA", document_id: "docA", version_id: "v-cur", kind: "download", ip: "198.51.100.7", user_agent: "Vendor/2" });
    expect(Object.keys(access[0])).not.toContain("email");
    // the stamp: the served label, the status, the verify URL, and the scan instruction
    expect(stamp.calls).toHaveLength(1);
    expect(stamp.calls[0]).toMatchObject({ watermarkText: "UNCONTROLLED — SHARED COPY", verifyUrl: "https://app.example.com/verify/docA?v=v-cur" });
    expect(String(stamp.calls[0].footerNotice)).toMatch(/^P-101 Rev B \(Issued\)/);
    expect(String(stamp.calls[0].footerNotice)).toMatch(/Scan the QR/);
    // ordering: the record was inserted before the response was built (r2 read happened, then the insert)
    const idxR2 = state.calls.findIndex((c) => c.table === "download_audits" && c.method === "insert");
    expect(idxR2).toBeGreaterThan(-1);
  });
  it("with no public origin there is no verify URL and the footer never says 'scan' (SHR-11)", async () => {
    state.origin = "";
    const res = await fileGet();
    expect(res.status).toBe(200);
    expect(stamp.calls[0].verifyUrl).toBeUndefined();
    expect(String(stamp.calls[0].footerNotice)).not.toMatch(/QR/);
    expect(String(stamp.calls[0].footerNotice)).toMatch(/Verify the current revision/);
  });
  it("a refused download_audits write REFUSES the download (503 unrecorded) — a copy never leaves unrecorded", async () => {
    state.insertError["download_audits"] = { message: "column \"share_id\" does not exist", code: "PGRST204" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fileGet();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unrecorded" });
    expect(res.headers.get("content-type")).not.toBe("application/pdf");
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/download_audits insert failed/), expect.objectContaining({ share: "s1", message: expect.stringMatching(/share_id/) }));
    err.mockRestore();
  });
  it("an unstamped delivery (not a stampable PDF) records source share_link_unstamped", async () => {
    const { PDFDocument } = await import("pdf-lib");
    (PDFDocument.load as unknown as { mockImplementationOnce: (f: () => Promise<never>) => void }).mockImplementationOnce(async () => { throw new Error("encrypted"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fileGet();
    expect(res.status).toBe(200);
    expect(inserted("download_audits")[0]).toMatchObject({ source: "share_link_unstamped", share_id: "s1", user_id: null });
    warn.mockRestore();
  });
  it("revoked / expired / cross-org / lapsed-authority refusals are unchanged and come before the status gate", async () => {
    state.share = { ...liveShare(), revoked_at: "2026-01-01" };
    expect((await fileGet()).status).toBe(410);
    state.share = { ...liveShare(), expires_at: "2000-01-01T00:00:00Z" };
    expect((await fileGet()).status).toBe(410);
    state.share = liveShare(); state.doc = null;
    expect((await fileGet()).status).toBe(404);
    state.doc = issuedDoc({ status: "Superseded" }); state.authorized = false;
    const res = await fileGet();
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe("revoked");
  });
});

// ── 3. /api/share/resolve ────────────────────────────────────────────────────
describe("GET /api/share/resolve — the page says what the server decided", () => {
  it("returns the served version's rev label, the control status and the expiry; records the open; bumps the counter with the IP", async () => {
    state.share = { ...liveShare(), expires_at: "2027-01-01T00:00:00Z" };
    const res = await resolveGet({ "x-forwarded-for": "203.0.113.9", "user-agent": "Phone/1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      documentId: "docA", versionId: "v-cur", documentNumber: "P-101", title: "Relief P&ID", rev: "B", status: "Issued",
      orgName: "Org A", expiresAt: "2027-01-01T00:00:00Z", fileUrl: `/api/share/file?token=${TOKEN}`,
    });
    expect(inserted("document_share_accesses")[0]).toMatchObject({ kind: "resolve", ip: "203.0.113.9", user_agent: "Phone/1", version_id: "v-cur" });
    expect(inserted("download_audits")).toHaveLength(0); // resolve is not a download
    expect(state.rpcCalls).toEqual([{ fn: "bump_share_access", args: { p_share: "s1", p_ip: "203.0.113.9" } }]);
  });
  it("a refused counter RPC is logged, never swallowed, and does not fail the resolve (SHR-12)", async () => {
    state.rpcResult = { data: null, error: { message: "PGRST202 function not found" } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await resolveGet();
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/bump_share_access failed/), expect.objectContaining({ message: expect.stringMatching(/PGRST202/) }));
    err.mockRestore();
  });
  it("withdrawn and held documents are refused on the metadata path too, with the reason", async () => {
    state.doc = issuedDoc({ status: "Void" });
    let res = await resolveGet();
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: "withdrawn", documentStatus: "Void" });
    state.doc = issuedDoc();
    state.holds = { data: [{ id: "h1", reason: "Suspect dimension", opened_at: null, opened_by_name: null }], error: null };
    res = await resolveGet();
    expect(res.status).toBe(423);
    expect(await res.json()).toMatchObject({ error: "on_hold", reason: expect.stringMatching(/Suspect dimension/) });
    expect(inserted("document_share_accesses")).toHaveLength(0);
    expect(state.rpcCalls).toHaveLength(0);
  });
  it("an unservable version resolves with fileUrl null (the page says so) rather than an error", async () => {
    state.versionById = {}; state.latest = [];
    const res = await resolveGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fileUrl: null, versionId: null, rev: "A" });
  });
});

// ── 4. lib/documentShares — minting ──────────────────────────────────────────
describe("lib/documentShares — who may mint, what, for how long; audit rows", () => {
  const input = { orgId: "orgA", documentId: "docA", createdBy: "u1", createdByName: "u" };
  it("refuses never-expires and >90 days before touching the database", async () => {
    const { createShareLink } = await import("@/lib/documentShares");
    await expect(createShareLink({ ...input, expiresInDays: 0 })).rejects.toThrow(/must expire/);
    await expect(createShareLink({ ...input, expiresInDays: 120 })).rejects.toThrow(/at most 90 days/);
    expect(state.inserts).toHaveLength(0);
    expect(state.calls.filter((c) => c.table === "documents")).toHaveLength(0);
  });
  it("refuses a Superseded / archived / held document with the reason, and never inserts", async () => {
    const { createShareLink, describeShareRefusal } = await import("@/lib/documentShares");
    state.doc = issuedDoc({ status: "Superseded" });
    await expect(createShareLink(input)).rejects.toThrow(/withdrawn \(superseded\)/);
    state.doc = issuedDoc({ archived_at: "2026-01-01" });
    await expect(createShareLink(input)).rejects.toThrow(/archived/);
    state.doc = issuedDoc();
    state.holds = { data: [{ id: "h1", reason: "Field Verification Needed", opened_at: null, opened_by_name: null }], error: null };
    await expect(createShareLink(input)).rejects.toThrow(/active hold \(Field Verification Needed\)/);
    state.holds = { data: [], error: { message: "down" } };
    expect(await describeShareRefusal("docA")).toMatch(/treated as held/); // fail-closed
    expect(state.inserts).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });
  it("mints with the computed expiry, writes SHARE_LINK_CREATED; maps a policy refusal to the sentence", async () => {
    const { createShareLink, SHARE_MINT_REFUSED } = await import("@/lib/documentShares");
    const share = await createShareLink({ ...input, expiresInDays: 7, note: "for John" });
    expect(state.inserts[0].table).toBe("document_shares");
    const payload = state.inserts[0].payload;
    expect(payload).toMatchObject({ org_id: "orgA", document_id: "docA", created_by: "u1", note: "for John" });
    expect(typeof payload.expires_at).toBe("string");
    expect(new Date(payload.expires_at as string).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(String(payload.token)).toHaveLength(32);
    expect(share.id).toBe("new-share");
    expect(state.audits).toEqual([expect.objectContaining({ action: "SHARE_LINK_CREATED", resourceId: "docA", resourceType: "document", orgId: "orgA", userId: "u1" })]);
    state.inserts = []; state.audits = [];
    state.insertError["document_shares"] = { message: "new row violates row-level security policy for table \"document_shares\"", code: "42501" };
    await expect(createShareLink(input)).rejects.toThrow(SHARE_MINT_REFUSED);
    expect(state.audits).toHaveLength(0);
  });
  it("revoke selects the row back (zero rows throws — EGRESS-7) and writes SHARE_LINK_REVOKED on the document", async () => {
    const { revokeShareLink } = await import("@/lib/documentShares");
    state.updateRows = [];
    await expect(revokeShareLink("s1", "u1")).rejects.toThrow(/was not revoked/);
    expect(state.audits).toHaveLength(0);
    state.updateRows = [{ id: "s1", org_id: "orgA", document_id: "docA" }];
    await revokeShareLink("s1", "u1");
    expect(state.calls).toContainEqual({ table: "document_shares", method: "select", args: ["id, org_id, document_id"] });
    expect(state.audits).toEqual([expect.objectContaining({ action: "SHARE_LINK_REVOKED", resourceId: "docA", orgId: "orgA", userId: "u1", details: { shareId: "s1" } })]);
  });
  it("canMintShare: controllers always; otherwise the database's publish evaluator, failing closed", async () => {
    const { canMintShare } = await import("@/lib/documentShares");
    expect(await canMintShare({ orgId: "orgA", uid: "u1", libraryId: null, isController: true })).toBe(true);
    expect(await canMintShare({ orgId: "orgA", uid: "u1", libraryId: null, isController: false })).toBe(false);
    state.rpcResult = { data: true, error: null };
    expect(await canMintShare({ orgId: "orgA", uid: "u1", libraryId: "lib1", isController: false })).toBe(true);
    expect(state.rpcCalls.at(-1)).toEqual({ fn: "user_can_publish_on_library", args: { p_library: "lib1", p_uid: "u1", p_org: "orgA" } });
    state.rpcResult = { data: null, error: { message: "nope" } };
    expect(await canMintShare({ orgId: "orgA", uid: "u1", libraryId: "lib1", isController: false })).toBe(false);
  });
});

// ── 5. the migrations ────────────────────────────────────────────────────────
describe("20261080 — minting tier, refusal rail, durable revocation, 90-day ceiling", () => {
  const m = mig("20261080_dc_roundF_share_minting_and_revocation.sql");
  const code = stripSqlComments(m);
  const m37 = mig("20261037_rp_phase3b_read_ownership_and_version_integrity.sql");
  const m26 = mig("20261026_document_shares_anchor_integrity.sql");

  it("captures the DEC-30 inventory BEFORE the transaction (aggregate counts only) and ends in ONE result set with the fixed shape", () => {
    const temp = m.indexOf("CREATE TEMP TABLE dc_round_f_80_before AS");
    const begin = m.indexOf("\nBEGIN;");
    const commit = m.indexOf("\nCOMMIT;");
    expect(temp).toBeGreaterThan(0);
    expect(m.slice(0, temp)).toMatch(/DROP TABLE IF EXISTS dc_round_f_80_before;\s*$/);
    expect(begin).toBeGreaterThan(temp);
    expect(commit).toBeGreaterThan(begin);
    const inv = m.slice(temp, begin);
    expect(inv).toMatch(/never-expiring rows already older than 90 days/);
    expect(inv).toMatch(/under an active hold/);
    expect(inv).toMatch(/could not mint after apply/);
    expect(inv).not.toMatch(/SELECT\s+(token|uid|user_id|id)\b/i);
    for (const s of inv.split("UNION ALL")) expect(s).toMatch(/COUNT\(\*\)/);
    const tail = m.slice(commit);
    expect(tail).toMatch(/AS check,/);
    expect(tail).toMatch(/AS ok,/);
    expect(tail).toMatch(/NULL::text AS n/);
    expect(tail).toMatch(/SELECT inventory, NULL, n FROM dc_round_f_80_before/);
    for (const like of tail.matchAll(/LIKE\s+'([^']*)'/g)) expect(like[1], like[0]).not.toMatch(/::/);
    expect(tail.split("UNION ALL").length).toBeGreaterThan(10);
  });

  it("document_share_refusal is SECURITY DEFINER with search_path pinned, and its status set is the app's NOT_CURRENT_STATUSES plus Draft", () => {
    const fn = between(code, "CREATE OR REPLACE FUNCTION document_share_refusal(p_doc uuid, p_org uuid)", "REVOKE ALL ON FUNCTION document_share_refusal");
    expect(fn).toMatch(/RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public/);
    const set = fn.match(/WHEN d\.status IN \(([^)]*)\) THEN 'withdrawn:'/)?.[1] ?? "";
    const sqlStatuses = [...set.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(sqlStatuses).toEqual([...NOT_CURRENT_STATUSES].sort());
    expect(fn).toMatch(/WHEN d\.status = 'Draft' THEN 'draft'/);
    expect(fn).toMatch(/WHEN d\.archived_at IS NOT NULL THEN 'archived'/);
    expect(fn).toMatch(/document_holds h WHERE h\.document_id = d\.id AND h\.released_at IS NULL\) THEN 'on_hold'/);
    expect(fn).toMatch(/LEFT JOIN documents d ON d\.id = p_doc AND d\.org_id = p_org/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION document_share_refusal\(uuid, uuid\) FROM PUBLIC;/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION document_share_refusal\(uuid, uuid\) TO authenticated, service_role;/);
  });

  it("the INSERT policy is the 20261037 body byte-carried plus exactly the two P1 arms", () => {
    const live = between(m37, "CREATE POLICY document_shares_insert ON document_shares", ");");
    const next = between(m, "CREATE POLICY document_shares_insert ON document_shares", "\n);");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA.filter((x) => x.trim() !== "")).toEqual([]);
    for (const l of onlyInB.filter((x) => x.trim() !== "")) {
      const t = l.trim();
      expect(
        t.startsWith("--") || t === "AND (" || t === ")" || t === "OR EXISTS ("
          || t.includes("is_org_controller(document_shares.org_id)")
          || t.includes("user_can_publish_on_library(d.library_id, auth.uid()::text, document_shares.org_id)")
          || t.includes("document_share_refusal(document_shares.document_id, document_shares.org_id) IS NULL")
          || t === "SELECT 1 FROM documents d" || t === "WHERE d.id = document_shares.document_id",
        `unexpected new line: ${l}`,
      ).toBe(true);
    }
    expect(next).toMatch(/node_visible\(d\.visibility, d\.acl_index, d\.org_id,\s*\n\s*d\.owner_user_id, d\.collection_id, d\.library_id\)/);
    expect(next).toMatch(/document_shares\.created_by = auth\.uid\(\)/);
    expect(code).toMatch(/DROP POLICY IF EXISTS document_shares_insert ON document_shares;/);
  });

  it("DELETE is controller-only; SELECT and UPDATE policies are not touched", () => {
    const del = between(code, "CREATE POLICY document_shares_delete ON document_shares FOR DELETE USING (", ");");
    expect(del).toMatch(/is_org_controller\(document_shares\.org_id\)/);
    expect(del).not.toMatch(/created_by/);
    expect(code).not.toMatch(/CREATE POLICY document_shares_org_select/);
    expect(code).not.toMatch(/CREATE POLICY document_shares_update/);
  });

  it("the anchor guard is the 20261026 body byte-carried plus the INSERT branch and the revocation / expiry rails, fired BEFORE INSERT OR UPDATE", () => {
    const live = between(m26, "CREATE OR REPLACE FUNCTION document_shares_anchor_immutable()", "DROP TRIGGER IF EXISTS document_shares_anchor_guard");
    const next = between(m, "CREATE OR REPLACE FUNCTION document_shares_anchor_immutable()", "DROP TRIGGER IF EXISTS document_shares_anchor_guard");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([]);
    const added = onlyInB.filter((x) => x.trim() !== "").map((x) => x.trim());
    expect(added).toContain("IF TG_OP = 'INSERT' THEN");
    expect(added).toContain("IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN");
    expect(added).toContain("RAISE EXCEPTION 'document_shares: a revoked share stays revoked — create a new share instead';");
    expect(added).toContain("IF OLD.revoked_at IS NOT NULL AND NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN");
    expect(added.filter((l) => l === "RAISE EXCEPTION 'document_shares: a share must expire within 90 days of its creation';")).toHaveLength(2);
    expect(next).toMatch(/NEW\.expires_at > COALESCE\(NEW\.created_at, now\(\)\) \+ interval '90 days'/);
    expect(next).toMatch(/NEW\.expires_at > COALESCE\(OLD\.created_at, now\(\)\) \+ interval '90 days'/);
    // a row born revoked (restore, DEC-45) is exempt from the INSERT expiry rule
    expect(next).toMatch(/IF NEW\.revoked_at IS NULL\s*\n\s*AND \(NEW\.expires_at IS NULL/);
    expect(next).toMatch(/LANGUAGE plpgsql SET search_path = public/);
    expect(code).toMatch(/CREATE TRIGGER document_shares_anchor_guard\s*\n\s*BEFORE INSERT OR UPDATE ON document_shares\s*\n\s*FOR EACH ROW EXECUTE FUNCTION document_shares_anchor_immutable\(\);/);
    // the backfill caps every live row at created_at + 90 days, inside the transaction, after the guard
    const backfill = code.indexOf("UPDATE document_shares\n   SET expires_at = COALESCE(created_at, now()) + interval '90 days'");
    expect(backfill).toBeGreaterThan(code.indexOf("CREATE TRIGGER document_shares_anchor_guard"));
    expect(backfill).toBeLessThan(code.indexOf("\nCOMMIT;"));
    expect(code.slice(backfill, backfill + 300)).toMatch(/WHERE revoked_at IS NULL\s*\n\s*AND \(expires_at IS NULL OR expires_at > COALESCE\(created_at, now\(\)\) \+ interval '90 days'\);/);
  });
});

describe("20261081 — the per-access record and the pinned counter", () => {
  const m = mig("20261081_dc_roundF_share_access_log.sql");
  const code = stripSqlComments(m);
  const m18 = mig("20260818_followups_rls.sql");

  it("document_share_accesses: RLS on, one controller SELECT policy, no member write policy, attribution uuids not FKs", () => {
    const tbl = between(code, "CREATE TABLE IF NOT EXISTS document_share_accesses (", ");");
    expect(tbl).toMatch(/share_id\s+UUID NOT NULL,/);
    expect(tbl).not.toMatch(/REFERENCES/);
    expect(tbl).toMatch(/kind\s+TEXT NOT NULL CHECK \(kind IN \('resolve', 'download'\)\)/);
    expect(tbl).toMatch(/\bip\s+TEXT,/);
    expect(tbl).toMatch(/user_agent\s+TEXT,/);
    expect(code).toMatch(/ALTER TABLE document_share_accesses ENABLE ROW LEVEL SECURITY;/);
    const policies = [...code.matchAll(/CREATE POLICY (\w+) ON document_share_accesses FOR (\w+)/g)].map((x) => [x[1], x[2]]);
    expect(policies).toEqual([["document_share_accesses_controller_select", "SELECT"]]);
    expect(between(code, "CREATE POLICY document_share_accesses_controller_select", ";")).toMatch(/USING \(is_org_controller\(org_id\)\)/);
  });

  it("bump_share_access: old arity dropped; new (uuid, text) is the 20260818 body plus the access_last_ip line, pinned, service_role only", () => {
    expect(code).toMatch(/DROP FUNCTION IF EXISTS bump_share_access\(uuid\);/);
    const live = between(m18, "CREATE OR REPLACE FUNCTION bump_share_access(p_share uuid)", "$$;");
    const next = between(m, "CREATE OR REPLACE FUNCTION bump_share_access(p_share uuid, p_ip text)", "$$;");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([
      "CREATE OR REPLACE FUNCTION bump_share_access(p_share uuid)",
      "RETURNS void LANGUAGE sql SECURITY DEFINER AS $$",
      "         access_last_at = now()",
    ]);
    expect(onlyInB).toEqual([
      "CREATE OR REPLACE FUNCTION bump_share_access(p_share uuid, p_ip text)",
      "RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$",
      "         access_last_at = now(),",
      "         access_last_ip = p_ip",
    ]);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION bump_share_access\(uuid, text\) FROM PUBLIC;/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION bump_share_access\(uuid, text\) FROM anon;/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION bump_share_access\(uuid, text\) FROM authenticated;/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION bump_share_access\(uuid, text\) TO service_role;/);
    const tail = m.slice(m.indexOf("\nCOMMIT;"));
    for (const like of tail.matchAll(/LIKE\s+'([^']*)'/g)) expect(like[1], like[0]).not.toMatch(/::/);
    expect(tail).toMatch(/to_regprocedure\('bump_share_access\(uuid\)'\) IS NULL/);
  });

  it("the numbered sequence's LAST definition of each share object is this package's", () => {
    const files = readdirSync(join(root, "supabase", "migrations")).filter((f) => /^\d{8}/.test(f) && f.endsWith(".sql")).sort();
    const lastDefining = (re: RegExp) => files.filter((f) => re.test(stripSqlComments(mig(f)))).at(-1);
    expect(lastDefining(/CREATE POLICY document_shares_insert ON/)).toBe("20261080_dc_roundF_share_minting_and_revocation.sql");
    expect(lastDefining(/CREATE POLICY document_shares_delete ON/)).toBe("20261080_dc_roundF_share_minting_and_revocation.sql");
    expect(lastDefining(/CREATE OR REPLACE FUNCTION document_shares_anchor_immutable\(\)/)).toBe("20261080_dc_roundF_share_minting_and_revocation.sql");
    expect(lastDefining(/CREATE OR REPLACE FUNCTION bump_share_access\(/)).toBe("20261081_dc_roundF_share_access_log.sql");
    expect(lastDefining(/CREATE POLICY document_shares_org_select ON/)).toBe("20261066_rp_roundE_share_list_read_decision.sql");
    expect(lastDefining(/CREATE POLICY document_shares_update ON/)).toBe("20261026_document_shares_anchor_integrity.sql");
  });
});

// ── 6. the modal and the landing page ────────────────────────────────────────
describe("ShareLinkModal / the landing page — the stated model", () => {
  it("the modal offers no never-expires option, caps at 90, builds the link and QR on publicOrigin, and gates minting on the tier + the refusal", async () => {
    const m = src("components/documents/ShareLinkModal.tsx");
    expect(m).not.toMatch(/Never expires/);
    expect(m).not.toMatch(/window\.location\.origin/);
    expect(m).toContain('import { publicOrigin } from "@/lib/publicOrigin";');
    expect(m).toContain("const baseUrl = origin ? `${origin}/share/` : \"/share/\";");
    expect(m).toContain('const isController = hasAnyRole(["Admin", "DocCtrl"]);');
    expect(m).toContain("const showCreate = readable && canMint === true && refusal === null;");
    expect(m).toMatch(/A share always serves the <b>current<\/b> revision/);
    expect(m).toMatch(/resolves to Rev \{currentRev \|\| "0"\}/);
    const { DURATION_OPTIONS } = await import("@/components/documents/ShareLinkModal");
    expect(DURATION_OPTIONS.every((o) => o.days > 0 && o.days <= SHARE_MAX_DAYS)).toBe(true);
    expect(Math.max(...DURATION_OPTIONS.map((o) => o.days))).toBe(SHARE_MAX_DAYS);
  });
  it("the landing page renders withdrawn / on_hold with the server's reason, states the always-current rule and the status, and no longer claims a counted access", () => {
    const p = src("app/share/[token]/page.tsx");
    expect(p).toMatch(/body\?\.error === "withdrawn"/);
    expect(p).toMatch(/body\?\.error === "on_hold"/);
    expect(p).toMatch(/state === "withdrawn" &&/);
    expect(p).toMatch(/state === "on_hold" &&/);
    expect(p).toMatch(/always serves the <b>current<\/b> revision/);
    expect(p).toMatch(/\{data\.status \? ` · \$\{data\.status\}` : ""\}/);
    expect(p).not.toMatch(/Access counted on the distribution record/);
    expect(p).toMatch(/Each download is recorded on the distribution record/);
    expect(p).toMatch(/body\?\.error === "unrecorded"/);
  });
  it("no file outside lib/publicOrigin.ts under the share surface reads window.location.origin (PHYS-13)", () => {
    for (const f of ["components/documents/ShareLinkModal.tsx", "app/share/[token]/page.tsx", "lib/documentShares.ts"]) {
      expect(src(f), f).not.toMatch(/window\.location\.origin/);
    }
  });
});
