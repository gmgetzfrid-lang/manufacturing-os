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
//
// Fix pass (review of the wave-2 branch): the 90-day ceiling is measured on
// the database's clock (created_at := now() on a live INSERT, immutable
// after; up to an hour of browser skew clamped); the on_hold refusal on the
// public surface publishes only the hold's category; a refused attempt on a
// known share leaves a bounded "refused" access row; the modal's "resolves
// to" runs the routes' own version rule; revoke is idempotent on a revoked
// row; document_share_refusal answers only for the caller's orgs; the
// download_audits payload's columns exist in the replayed schema.
//
// Second fix pass: the accessor's IP is kept only on the controller-read
// trail (bump_share_access keeps its arity and writes no IP); a share
// download ahead of 20261068 is recorded once in the pre-20261068 shape
// instead of refused; served opens are bounded per share per client IP per
// minute; the minting tier is re-asked at serve time (creatorMayShare);
// document_share_refusal answers only for a document the caller can read;
// the audit writes on mint / revoke are checked (auditWarning); the modal
// says "couldn't confirm" for a refusal it could not read.
//
// Verification fix: an explicit ACL download deny naming the share's CREATOR
// stops the link serving (creatorMayShare over lib/downloadDeny.ts, the rule
// /api/storage/download-url applies to members — SHR-3 criterion 3); the
// 20261080 INSERT rail has no download-deny arm (no SQL predicate exists —
// SHR-14). 20261081 upgrades a draft-era table in place and empties
// access_last_ip. The modal's failed context read leaves no confirmed refusal.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { shareExpiryFor, shareStatusRefusal, versionServable, SHARE_MAX_DAYS, SHARE_DEFAULT_DAYS } from "@/lib/shareRules";
import { shareFooterNotice, requestMeta, publicShareHoldReason } from "@/lib/shareServe";

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
  // per-call outcomes, consumed in order before insertError applies (null = the call succeeds)
  insertErrorQueue: {} as Record<string, Array<{ message: string; code?: string } | null>>,
  docError: null as null | { message: string },
  // the share creator's org_members row (the serve-time tier check)
  creatorMember: { role: "DocCtrl", roles: ["DocCtrl"] } as Row | null,
  creatorMemberError: null as null | { message: string },
  // the creator's teams (the download-deny check reads them only when the index carries a download deny)
  teams: { data: [] as Row[], error: null as null | { message: string } },
  auditError: null as null | string,
  updateRows: [] as Row[],
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  rpcCalls: [] as Array<{ fn: string; args: Row }>,
  rpcResult: { data: null as unknown, error: null as null | { message: string } },
  origin: "https://app.example.com",
  authorized: true,
  audits: [] as Row[],
  // the order the bytes, the stamp and the two record writes happened in
  seq: [] as string[],
  versionError: null as null | { message: string },
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
        state.seq.push(`insert:${table}`);
        const queue = state.insertErrorQueue[table];
        const err = queue && queue.length ? (queue.shift() ?? undefined) : state.insertError[table];
        return { data: err ? null : [payload], error: err ?? null };
      }
      if (op === "update") return { data: state.updateRows, error: null };
      if (table === "document_holds") return state.holds;
      if (table === "team_members") return state.teams;
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
            if (table === "documents") return Promise.resolve(state.docError ? { data: null, error: state.docError } : { data: state.doc, error: null });
            if (table === "org_members") return Promise.resolve({ data: state.creatorMemberError ? null : state.creatorMember, error: state.creatorMemberError });
            if (table === "orgs") return Promise.resolve({ data: { name: "Org A" }, error: null });
            if (table === "document_versions") {
              if (state.versionError) return Promise.resolve({ data: null, error: state.versionError });
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
vi.mock("@/lib/publicOrigin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/publicOrigin")>()),
  publicOrigin: () => state.origin,
  // the server's configured origin (NEXT_PUBLIC_SITE_URL, else Vercel's production domain)
  configuredPublicOrigin: () => state.origin,
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (e: Row) => { state.audits.push(e); return { error: state.auditError }; }) }));
vi.mock("@aws-sdk/client-s3", () => ({ GetObjectCommand: class { constructor(public input: unknown) {} } }));
const r2 = vi.hoisted(() => ({ send: vi.fn(async () => { state.seq.push("r2"); return { Body: { transformToByteArray: async () => new Uint8Array([9, 9, 9]) } }; }) }));
vi.mock("@/lib/r2", () => ({ r2, R2_BUCKET: "bucket" }));
const stamp = vi.hoisted(() => ({ calls: [] as Row[] }));
vi.mock("@/lib/stamping", () => ({ applyStampToPdfDoc: vi.fn(async (_d: unknown, opts: Row) => { stamp.calls.push(opts); state.seq.push("stamp"); }) }));
vi.mock("pdf-lib", () => ({ PDFDocument: { load: vi.fn(async () => ({ save: async () => new Uint8Array([1, 2, 3]) })) } }));

const TOKEN = "t".repeat(32);
const liveShare = (): Row => ({ id: "s1", org_id: "orgA", document_id: "docA", created_by: "u1", expires_at: null, revoked_at: null });
const issuedDoc = (over: Row = {}): Row => ({
  id: "docA", document_number: "P-101", title: "Relief P&ID", name: null, rev: "A", status: "Issued", archived_at: null,
  current_version_id: "v-cur", library_id: "lib1", ...over,
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
  state.insertErrorQueue = {};
  state.docError = null;
  state.creatorMember = { role: "DocCtrl", roles: ["DocCtrl"] };
  state.creatorMemberError = null;
  state.teams = { data: [], error: null };
  state.auditError = null;
  state.updateRows = [];
  state.calls = [];
  state.rpcCalls = [];
  state.rpcResult = { data: null, error: null };
  state.origin = "https://app.example.com";
  state.authorized = true;
  state.audits = [];
  state.seq = [];
  state.versionError = null;
  stamp.calls = [];
  r2.send.mockClear();
});

const fileGet = async (headers: Record<string, string> = {}, base = "https://app") => {
  const { GET } = await import("@/app/api/share/file/route");
  return GET(new NextRequest(`${base}/api/share/file?token=${TOKEN}`, { headers }));
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
  it("an active hold refuses (423 on_hold) with only the hold's PUBLIC category — never the operator's free text; an UNREADABLE hold set refuses too (fail-closed) without the database error", async () => {
    state.holds = { data: [
      { id: "h1", reason: "Field Verification Needed", opened_at: null, opened_by_name: null },
      { id: "h2", reason: "waiting on legal re: incident at Unit 3 relief valve", opened_at: null, opened_by_name: null },
    ], error: null };
    let res = await fileGet();
    expect(res.status).toBe(423);
    let body = await res.json();
    expect(body).toEqual({ error: "on_hold", reason: "This document is under an active hold (Field Verification Needed).", unreadable: false, documentStatus: "Issued" });
    expect(JSON.stringify(body)).not.toMatch(/legal|Unit 3|relief valve/);
    state.holds = { data: [], error: { message: "permission denied for table document_holds" } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    res = await fileGet();
    expect(res.status).toBe(423);
    body = await res.json();
    expect(body).toMatchObject({ error: "on_hold", unreadable: true, reason: expect.stringMatching(/could not be confirmed/) });
    expect(JSON.stringify(body)).not.toMatch(/permission denied|document_holds/);
    // the detail is logged on the server, not sent to the outsider
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/hold state unreadable/), expect.objectContaining({ share: "s1", detail: expect.stringMatching(/permission denied/) }));
    err.mockRestore();
    expect(r2.send).not.toHaveBeenCalled();
    expect(inserted("download_audits")).toHaveLength(0);
  });
  it("publicShareHoldReason: predefined categories only (deduplicated), a free-text-only hold reads as a bare hold, unreadable is a fixed sentence", () => {
    const h = (reason: string) => ({ id: reason, reason, openedAt: null, openedByName: null });
    expect(publicShareHoldReason({ unreadable: false, holds: [h("Client Review"), h("Client Review"), h("Missing Vendor Data")] }))
      .toBe("This document is under an active hold (Client Review, Missing Vendor Data).");
    expect(publicShareHoldReason({ unreadable: false, holds: [h("Suspect dimension on sheet 2")] })).toBe("This document is under an active hold.");
    expect(publicShareHoldReason({ unreadable: true, holds: [] })).toBe("This document's hold status could not be confirmed, so it is being treated as on hold.");
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
    // ordering: the bucket read, then the stamp, then the distribution record, then the access trail —
    // and the response only after all of them (the route awaited each before returning)
    expect(state.seq).toEqual(["r2", "stamp", "insert:download_audits", "insert:document_share_accesses"]);
  });
  it("with no configured origin the verify QR is built on the request URL's origin when it carries a public host (Vercel's custom domain; SHR-11)", async () => {
    // Only a runtime that builds req.nextUrl from the host the recipient
    // reached (Vercel, or next.config experimental.trustHostHeader) gets
    // here; `next start` never does — see the next case.
    state.origin = "";
    const res = await fileGet({}, "https://docs.plant.example");
    expect(res.status).toBe(200);
    expect(stamp.calls[0].verifyUrl).toBe("https://docs.plant.example/verify/docA?v=v-cur");
    expect(String(stamp.calls[0].footerNotice)).toMatch(/Scan the QR/);
    expect(inserted("download_audits")).toHaveLength(1);
    // a configured origin still wins over the request's host
    state.origin = "https://app.example.com"; stamp.calls = [];
    await fileGet({}, "https://docs.plant.example");
    expect(stamp.calls[0].verifyUrl).toBe("https://app.example.com/verify/docA?v=v-cur");
  });
  it("self-hosted under `next start` (the Docker image) with NEXT_PUBLIC_SITE_URL unset: the request URL is the BIND address, so every share download is refused LOUDLY until the variable is set (SHR-11)", async () => {
    // Next 16's router builds the request URL as
    // `${protocol}://${opts.hostname || "localhost"}:${opts.port}${req.url}`
    // (next/dist/server/lib/router-utils/resolve-routes.js) and never reads
    // the Host header unless experimental.trustHostHeader is set. So what
    // `next start` hands this route — whatever host the recipient typed — is
    // http://localhost:3000 (or 0.0.0.0 with -H 0.0.0.0): never a fallback,
    // always the refusal, and the Host / X-Forwarded-Host headers are ignored.
    state.origin = "";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const base of ["http://localhost:3000", "http://0.0.0.0:3000"]) {
      state.inserts = []; stamp.calls = []; r2.send.mockClear(); err.mockClear();
      const res = await fileGet({ host: "docs.plant.example", "x-forwarded-host": "docs.plant.example", "x-forwarded-proto": "https" }, base);
      expect(res.status, base).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("unverifiable");
      // the recipient is not told anyone was notified — nobody is
      expect(body.message).not.toMatch(/has been told/);
      expect(body.message).toMatch(/Ask the person who shared it to contact their Document Control/);
      expect(r2.send).not.toHaveBeenCalled();
      expect(stamp.calls).toHaveLength(0);
      expect(inserted("download_audits")).toHaveLength(0);
      expect(inserted("document_share_accesses")).toEqual([expect.objectContaining({ kind: "refused", reason: "unverifiable", share_id: "s1" })]);
      expect(String(err.mock.calls[0]?.[0])).toMatch(/NEXT_PUBLIC_SITE_URL[\s\S]*bind address/);
    }
    err.mockRestore();
  });
  it("with no configured origin on a host an outsider cannot open (*.vercel.app, loopback), the download is refused LOUDLY — no bytes read, no copy, no record, the refusal on the access trail (SHR-11)", async () => {
    state.origin = "";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const base of ["https://myapp-git-feature-acme.vercel.app", "http://localhost:3000", "http://127.0.0.1:3000"]) {
      state.inserts = []; stamp.calls = []; r2.send.mockClear(); err.mockClear();
      const res = await fileGet({ "x-forwarded-for": "198.51.100.7" }, base);
      expect(res.status, base).toBe(503);
      expect((await res.json()).error).toBe("unverifiable");
      expect(r2.send).not.toHaveBeenCalled();
      expect(stamp.calls).toHaveLength(0);
      expect(inserted("download_audits")).toHaveLength(0);
      expect(inserted("document_share_accesses")).toEqual([expect.objectContaining({ kind: "refused", reason: "unverifiable", share_id: "s1" })]);
      expect(String(err.mock.calls[0]?.[0])).toMatch(/no public origin for the verify QR[\s\S]*NEXT_PUBLIC_SITE_URL/);
    }
    err.mockRestore();
  });
  it("the footer never tells a reader to scan a QR the copy does not carry (shareFooterNotice, SHR-11 item 1)", async () => {
    const { shareFooterNotice } = await import("@/lib/shareServe");
    const without = shareFooterNotice({ label: "P-101", rev: "B", status: "Issued", verifyUrl: undefined });
    expect(without).not.toMatch(/QR/);
    expect(without).toMatch(/Verify the current revision/);
    expect(shareFooterNotice({ label: "P-101", rev: "B", status: "Issued", verifyUrl: "https://x/verify/d" })).toMatch(/Scan the QR/);
  });
  it("ahead of 20261068 (the missing-column refusal) the record is retried ONCE in the pre-20261068 shape — recorded, attributed to the sharer, and served; never a wholesale lockout", async () => {
    for (const missing of [
      { message: "Could not find the 'share_id' column of 'download_audits' in the schema cache", code: "PGRST204" },
      { message: "column \"source\" of relation \"download_audits\" does not exist", code: "42703" },
      { message: "null value in column \"user_id\" of relation \"download_audits\" violates not-null constraint", code: "23502" },
    ]) {
      state.inserts = []; state.seq = [];
      state.insertErrorQueue["download_audits"] = [missing, null];
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await fileGet({ "x-forwarded-for": "198.51.100.7" });
      expect(res.status, missing.code).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      const [first, retry] = inserted("download_audits");
      expect(first).toMatchObject({ share_id: "s1", source: "share_link", user_id: null });
      // the retry names ONLY the pre-20261068 columns, attributed to the sharer as the table then required
      expect(retry).toEqual({
        org_id: "orgA", document_id: "docA", version_id: "v-cur", user_id: "u1", user_email: null,
        created_at: expect.any(String), expires_at: expect.any(String), watermark_policy_id: null,
      });
      expect(inserted("download_audits")).toHaveLength(2);
      // the deploy order is named as exactly that, and the copy still went out recorded
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/DEPLOY ORDER: download_audits lacks the 20261068 columns/), expect.objectContaining({ share: "s1", message: missing.message }));
      expect(err).not.toHaveBeenCalledWith(expect.stringMatching(/share download refused/), expect.anything());
      expect(state.seq).toEqual(["r2", "stamp", "insert:download_audits", "insert:download_audits", "insert:document_share_accesses"]);
      expect(inserted("document_share_accesses")).toEqual([expect.objectContaining({ kind: "download", ip: "198.51.100.7" })]);
      err.mockRestore();
    }
  });
  it("a download_audits write refused in BOTH shapes refuses the download (503 unrecorded) — a copy never leaves unrecorded", async () => {
    state.insertError["download_audits"] = { message: "column \"share_id\" does not exist", code: "PGRST204" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fileGet();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unrecorded" });
    expect(res.headers.get("content-type")).not.toBe("application/pdf");
    expect(inserted("download_audits")).toHaveLength(2); // the share shape, then the one pre-20261068 retry
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/DEPLOY ORDER: download_audits lacks the 20261068 columns/), expect.anything());
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/download_audits insert failed/), expect.objectContaining({ share: "s1", message: expect.stringMatching(/share_id/) }));
    // the refused download is still an attempt on the trail; no download row
    expect(inserted("document_share_accesses")).toEqual([expect.objectContaining({ kind: "refused", reason: "unrecorded", version_id: "v-cur" })]);
    expect(stamp.calls).toHaveLength(1); // the copy was prepared, and still did not leave
    err.mockRestore();
  });
  it("a refusal that is NOT the missing migration (a timeout, RLS, a CHECK) is not retried: 503 unrecorded after one attempt", async () => {
    for (const other of [
      { message: "canceling statement due to statement timeout", code: "57014" },
      { message: "new row for relation \"download_audits\" violates check constraint \"download_audits_attributed\"", code: "23514" },
    ]) {
      state.inserts = [];
      state.insertError["download_audits"] = other;
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await fileGet();
      expect(res.status, other.code).toBe(503);
      expect(inserted("download_audits"), other.code).toHaveLength(1);
      expect(err).not.toHaveBeenCalledWith(expect.stringMatching(/DEPLOY ORDER/), expect.anything());
      err.mockRestore();
    }
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
  it("the minting tier is re-asked at SERVE time (DEC-46 §1): a link whose creator is no longer a controller or a granted publisher of the library stops serving (410, authority_lapsed); fail-closed", async () => {
    const tierCalls = () => state.rpcCalls.filter((c) => c.fn === "user_can_publish_on_library");
    // a controller by the role COLLECTION (headline Viewer, additive DocCtrl) serves without asking the library
    state.creatorMember = { role: "Viewer", roles: ["Viewer", "DocCtrl"] };
    expect((await fileGet()).status).toBe(200);
    expect(tierCalls()).toHaveLength(0);
    expect(state.calls).toContainEqual({ table: "org_members", method: "eq", args: ["uid", "u1"] });
    expect(state.calls).toContainEqual({ table: "org_members", method: "eq", args: ["status", "active"] });
    // not a controller: the library's publish evaluator decides, asked for the CREATOR on the document's library
    state.creatorMember = { role: "Engineer", roles: ["Engineer"] };
    state.rpcResult = { data: true, error: null };
    state.inserts = [];
    expect((await fileGet()).status).toBe(200);
    expect(tierCalls().at(-1)).toEqual({ fn: "user_can_publish_on_library", args: { p_library: "lib1", p_uid: "u1", p_org: "orgA" } });
    // a Viewer-minted link from before the tier existed, or a publisher whose grant was withdrawn
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [label, setup] of [
      ["no publish grant", () => { state.creatorMember = { role: "Viewer", roles: ["Viewer"] }; state.rpcResult = { data: false, error: null }; }],
      ["the evaluator errored", () => { state.creatorMember = { role: "Engineer", roles: ["Engineer"] }; state.rpcResult = { data: null, error: { message: "timeout" } }; }],
      ["no longer an active member", () => { state.creatorMember = null; state.rpcResult = { data: true, error: null }; }],
      ["membership unreadable", () => { state.creatorMemberError = { message: "down" }; state.rpcResult = { data: true, error: null }; }],
      ["no library to hold a grant on", () => { state.creatorMember = { role: "Engineer", roles: ["Engineer"] }; state.doc = issuedDoc({ library_id: null }); state.rpcResult = { data: true, error: null }; }],
    ] as Array<[string, () => void]>) {
      state.creatorMemberError = null; state.doc = issuedDoc(); state.inserts = [];
      setup();
      r2.send.mockClear();
      const res = await fileGet();
      expect(res.status, label).toBe(410);
      expect(await res.json(), label).toEqual({ error: "revoked" });
      expect(r2.send, label).not.toHaveBeenCalled();
      expect(inserted("document_share_accesses"), label).toEqual([expect.objectContaining({ kind: "refused", reason: "authority_lapsed" })]);
      expect((await resolveGet()).status, label).toBe(410);
    }
    err.mockRestore();
    // the documents read carries the library the grant is asked on
    const sel = state.calls.find((c) => c.table === "documents" && c.method === "select");
    expect(String(sel?.args[0])).toMatch(/\blibrary_id\b/);
    // the check runs AFTER the read decision and BEFORE the status / hold / version steps
    const serve = src("lib/shareServe.ts");
    const body = serve.slice(serve.indexOf("export async function resolveShareForServing"));
    expect(body.indexOf("await creatorMayShare(sb, s, d)")).toBeGreaterThan(body.indexOf("await shareStillAuthorized("));
    expect(body.indexOf("await creatorMayShare(sb, s, d)")).toBeLessThan(body.indexOf("shareStatusRefusal(d)"));
    expect(serve).toMatch(/memberHoldsAny\(member as \{ role\?: unknown; roles\?: unknown \}, SHARE_CONTROLLER_ROLES\)/);
  });
  it("an explicit ACL download deny naming the CREATOR stops the link serving (SHR-3 criterion 3): by uid, any role in the collection, or team; controllers not exempt (the member route's rule); fail-closed; a deny naming someone else serves", async () => {
    const denyDownload = (deny: Row) => issuedDoc({ acl_index: { allow: {}, deny } });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [label, setup] of [
      ["the creator's uid", () => { state.doc = denyDownload({ users: { download: ["u1"] } }); }],
      ["an ADDITIVE role in the creator's collection", () => { state.creatorMember = { role: "Engineer-2", roles: ["Engineer-2", "Contractor"] }; state.doc = denyDownload({ roles: { download: ["Contractor"] } }); }],
      ["one of the creator's teams", () => { state.teams = { data: [{ team_id: "t-field" }], error: null }; state.doc = denyDownload({ teams: { download: ["t-field"] } }); }],
      ["a controller named by uid (the member download route exempts no one)", () => { state.creatorMember = { role: "Admin", roles: ["Admin"] }; state.doc = denyDownload({ users: { download: ["u1"] } }); }],
      ["the creator's teams unreadable while a download deny exists (fail-closed)", () => { state.teams = { data: [], error: { message: "down" } }; state.doc = denyDownload({ users: { download: ["someone-else"] } }); }],
    ] as Array<[string, () => void]>) {
      // a granted publisher: the tier alone would serve
      state.creatorMember = { role: "Engineer-2", roles: ["Engineer-2"] }; state.rpcResult = { data: true, error: null };
      state.teams = { data: [], error: null }; state.inserts = [];
      setup();
      r2.send.mockClear();
      const res = await fileGet();
      expect(res.status, label).toBe(410);
      expect(await res.json(), label).toEqual({ error: "revoked" });
      expect(r2.send, label).not.toHaveBeenCalled();
      expect(inserted("download_audits"), label).toHaveLength(0);
      expect(inserted("document_share_accesses"), label).toEqual([expect.objectContaining({ kind: "refused", reason: "authority_lapsed" })]);
      expect((await resolveGet()).status, label).toBe(410);
    }
    err.mockRestore();
    // a download deny naming someone else, a READ-only deny entry, or no index at all: the link serves
    for (const doc of [
      denyDownload({ users: { download: ["u2"] }, roles: { download: ["Viewer"] }, teams: { download: ["t-other"] } }),
      denyDownload({ users: { read: ["u1"] } }),
      issuedDoc({ acl_index: null }),
    ]) {
      state.doc = doc; state.creatorMember = { role: "Engineer-2", roles: ["Engineer-2"] }; state.rpcResult = { data: true, error: null };
      state.teams = { data: [{ team_id: "t-field" }], error: null };
      expect((await fileGet()).status).toBe(200);
    }
    // the documents read carries the index; the check is the member route's own helper, asked inside creatorMayShare
    const sel = state.calls.filter((c) => c.table === "documents" && c.method === "select").at(-1);
    expect(String(sel?.args[0])).toMatch(/\bacl_index\b/);
    const serve = src("lib/shareServe.ts");
    expect(serve).toContain('import { memberDownloadDenied, type DownloadDenyIndex } from "@/lib/downloadDeny";');
    const may = serve.slice(serve.indexOf("export async function creatorMayShare"));
    expect(may.indexOf("await memberDownloadDenied(sb, { orgId: s.org_id, uid: s.created_by, aclIndex: d.acl_index ?? null })"))
      .toBeLessThan(may.indexOf("memberHoldsAny(member"));
    expect(may).toMatch(/if \(download\.unreadable\) \{[\s\S]*?return false;\s*\n\s*\}\s*\n\s*if \(download\.denied\) return false;/);
    const route = src("app/api/storage/download-url/route.ts");
    expect(route).toContain('import { memberDownloadDenied, type DownloadDenyIndex } from "@/lib/downloadDeny";');
    expect(route).toMatch(/const \{ denied \} = await memberDownloadDenied\(supabaseAdmin, \{/);
    expect(route).not.toMatch(/dl\.users\?\.download/); // the inline copy is gone: one rule, two callers
  });
  it("a refused attempt on a KNOWN share leaves one 'refused' access row with the reason, IP and UA (SHR-10); an unknown token leaves none", async () => {
    const cases: Array<[Row, Row | null, boolean, string, number]> = [
      [{ ...liveShare(), revoked_at: "2026-01-01" }, issuedDoc(), true, "revoked", 410],
      [{ ...liveShare(), expires_at: "2000-01-01T00:00:00Z" }, issuedDoc(), true, "expired", 410],
      [liveShare(), null, true, "notfound", 404],
      [liveShare(), issuedDoc(), false, "authority_lapsed", 410],
      [liveShare(), issuedDoc({ status: "Void" }), true, "withdrawn", 410],
      [liveShare(), issuedDoc(), true, "on_hold", 423],
    ];
    for (const [share, doc, authorized, reason, status] of cases) {
      state.share = share; state.doc = doc; state.authorized = authorized; state.inserts = [];
      state.holds = reason === "on_hold" ? { data: [{ id: "h1", reason: "Client Review", opened_at: null, opened_by_name: null }], error: null } : { data: [], error: null };
      const res = await fileGet({ "x-forwarded-for": "192.0.2.4, 10.0.0.1", "user-agent": "Old/1" });
      expect(res.status, reason).toBe(status);
      const rows = inserted("document_share_accesses");
      expect(rows, reason).toHaveLength(1);
      expect(rows[0], reason).toMatchObject({ share_id: "s1", org_id: "orgA", document_id: "docA", version_id: null, kind: "refused", reason, ip: "192.0.2.4", user_agent: "Old/1" });
      expect(String(rows[0].refused_minute), reason).toMatch(/T\d\d:\d\d:00\.000Z$/);
      expect(inserted("download_audits")).toHaveLength(0);
    }
    // the bytes route with no servable version: refused "nofile"
    state.share = liveShare(); state.doc = issuedDoc(); state.authorized = true; state.holds = { data: [], error: null };
    state.versionById = {}; state.latest = []; state.inserts = [];
    expect((await fileGet()).status).toBe(404);
    expect(inserted("document_share_accesses")).toEqual([expect.objectContaining({ kind: "refused", reason: "nofile" })]);
    // an unknown token has no share to attribute to: nothing is written
    state.share = null; state.inserts = [];
    expect((await fileGet()).status).toBe(404);
    expect((await resolveGet()).status).toBe(404);
    expect(state.inserts).toHaveLength(0);
  });
  it("refused rows are BOUNDED to one per share per minute and served opens to one per share per client IP per minute: the unique violation is the bound working, not an error; a download row is never bounded", async () => {
    const { recordShareAccess } = await import("@/lib/shareServe");
    const sb = makeClient() as unknown as Parameters<typeof recordShareAccess>[0];
    const share = liveShare() as unknown as Parameters<typeof recordShareAccess>[1]["share"];
    const base = { share, documentId: "docA", versionId: null, ip: null, userAgent: null };
    await recordShareAccess(sb, { ...base, kind: "refused", reason: "revoked", now: new Date("2026-09-30T12:00:05.123Z") });
    await recordShareAccess(sb, { ...base, kind: "refused", reason: "revoked", now: new Date("2026-09-30T12:00:55.900Z") });
    const [a, b] = inserted("document_share_accesses");
    expect(a.refused_minute).toBe("2026-09-30T12:00:00.000Z");
    expect(b.refused_minute).toBe(a.refused_minute); // same minute → the same key under the unique index
    await recordShareAccess(sb, { ...base, kind: "resolve", now: new Date("2026-09-30T12:00:05Z") });
    expect(inserted("document_share_accesses")[2]).not.toHaveProperty("refused_minute");
    expect(inserted("document_share_accesses")[2]).not.toHaveProperty("reason");
    // a served open carries ITS minute (the key of the per-IP bound); a download carries neither
    expect(inserted("document_share_accesses")[2]).toMatchObject({ kind: "resolve", resolve_minute: "2026-09-30T12:00:00.000Z" });
    await recordShareAccess(sb, { ...base, kind: "download", now: new Date("2026-09-30T12:00:05Z") });
    expect(inserted("document_share_accesses")[3]).not.toHaveProperty("resolve_minute");
    expect(inserted("document_share_accesses")[3]).not.toHaveProperty("refused_minute");
    // the database refusing the second row of a minute (23505) is silent and not an error
    state.insertError["document_share_accesses"] = { message: "duplicate key value violates unique constraint \"document_share_accesses_refused_bound\"", code: "23505" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await recordShareAccess(sb, { ...base, kind: "refused", reason: "revoked" })).toEqual({ error: null, bounded: true });
    state.share = { ...liveShare(), revoked_at: "2026-01-01" };
    expect((await resolveGet()).status).toBe(410);
    // a scripted loop on a LIVE token: the open's row is bounded, the page still answers
    expect(await recordShareAccess(sb, { ...base, kind: "resolve" })).toEqual({ error: null, bounded: true });
    state.share = liveShare();
    expect((await resolveGet()).status).toBe(200);
    expect(err).not.toHaveBeenCalled();
    // a 23505 on a download row is NOT swallowed
    expect((await recordShareAccess(sb, { ...base, kind: "download" })).error).toMatch(/duplicate key/);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
  it("EGR-3: every column the share download record names exists on download_audits (schema.sql + every numbered ADD COLUMN) — column drift fails here", async () => {
    await fileGet();
    const payload = inserted("download_audits")[0];
    expect(payload).toBeTruthy();
    const schema = src("supabase/schema.sql");
    const create = between(schema, "CREATE TABLE IF NOT EXISTS download_audits (", "\n);");
    const columns = new Set(
      create.split("\n").slice(1).map((l) => l.trim().match(/^([a-z_][a-z0-9_]*)\s/)?.[1]).filter((c): c is string => !!c),
    );
    const files = readdirSync(join(root, "supabase", "migrations")).filter((f) => /^\d{8}/.test(f) && f.endsWith(".sql")).sort();
    for (const f of files) {
      for (const m of stripSqlComments(mig(f)).matchAll(/ALTER TABLE (?:public\.)?download_audits\s+ADD COLUMN (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)) columns.add(m[1]);
    }
    expect(columns).toContain("share_id"); // the 20261068 columns really were found
    expect(columns).toContain("source");
    for (const k of Object.keys(payload)) expect(columns.has(k), `download_audits has no column ${k}`).toBe(true);
    // the pre-20261068 retry names ONLY the columns schema.sql itself creates (nothing a later migration adds)
    const base = new Set(
      create.split("\n").slice(1).map((l) => l.trim().match(/^([a-z_][a-z0-9_]*)\s/)?.[1]).filter((c): c is string => !!c),
    );
    state.inserts = [];
    state.insertErrorQueue["download_audits"] = [{ message: "Could not find the 'source' column", code: "PGRST204" }, null];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await fileGet()).status).toBe(200);
    err.mockRestore();
    const retry = inserted("download_audits")[1];
    expect(retry).toBeTruthy();
    for (const k of Object.keys(retry)) expect(base.has(k), `the pre-20261068 table has no column ${k}`).toBe(true);
  });
});

// ── 3. /api/share/resolve ────────────────────────────────────────────────────
describe("GET /api/share/resolve — the page says what the server decided", () => {
  it("returns the served version's rev label, the control status and the expiry; records the open (IP on the controller-only trail); bumps the counter WITHOUT the IP", async () => {
    state.share = { ...liveShare(), expires_at: "2027-01-01T00:00:00Z" };
    const res = await resolveGet({ "x-forwarded-for": "203.0.113.9", "user-agent": "Phone/1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      documentId: "docA", versionId: "v-cur", documentNumber: "P-101", title: "Relief P&ID", rev: "B", status: "Issued",
      orgName: "Org A", expiresAt: "2027-01-01T00:00:00Z", fileUrl: `/api/share/file?token=${TOKEN}`,
    });
    expect(inserted("document_share_accesses")[0]).toMatchObject({ kind: "resolve", ip: "203.0.113.9", user_agent: "Phone/1", version_id: "v-cur", resolve_minute: expect.stringMatching(/T\d\d:\d\d:00\.000Z$/) });
    expect(inserted("download_audits")).toHaveLength(0); // resolve is not a download
    // document_shares is readable by every member who can read the document: the counter carries no IP
    expect(state.rpcCalls).toEqual([{ fn: "bump_share_access", args: { p_share: "s1" } }]);
    expect(src("app/api/share/resolve/route.ts")).not.toMatch(/p_ip/);
  });
  it("a refused counter RPC is logged, never swallowed, and does not fail the resolve (SHR-12)", async () => {
    state.rpcResult = { data: null, error: { message: "PGRST202 function not found" } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await resolveGet();
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/bump_share_access failed/), expect.objectContaining({ message: expect.stringMatching(/PGRST202/) }));
    err.mockRestore();
  });
  it("withdrawn and held documents are refused on the metadata path too — the status reason, and only the hold's public category", async () => {
    state.doc = issuedDoc({ status: "Void" });
    let res = await resolveGet();
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: "withdrawn", documentStatus: "Void" });
    expect(inserted("document_share_accesses")).toEqual([expect.objectContaining({ kind: "refused", reason: "withdrawn" })]);
    state.doc = issuedDoc(); state.inserts = [];
    // free-text ("Other…") operator reason: an outsider sees that there is a hold, not what was typed
    state.holds = { data: [{ id: "h1", reason: "Suspect dimension", opened_at: null, opened_by_name: null }], error: null };
    res = await resolveGet();
    expect(res.status).toBe(423);
    const body = await res.json();
    expect(body).toMatchObject({ error: "on_hold", reason: "This document is under an active hold." });
    expect(JSON.stringify(body)).not.toMatch(/Suspect dimension/);
    // no resolve row and no counter bump — only the refused attempt
    expect(inserted("document_share_accesses")).toEqual([expect.objectContaining({ kind: "refused", reason: "on_hold" })]);
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
  it("shareRefusalState says whether a refusal is CONFIRMED (status / archive / an open hold — what the routes refuse) or only UNCONFIRMED (this browser's read failed: minting refused, but the links may be serving)", async () => {
    const { shareRefusalState } = await import("@/lib/documentShares");
    expect(await shareRefusalState("docA")).toBeNull();
    state.doc = issuedDoc({ status: "Void" });
    expect(await shareRefusalState("docA")).toEqual({ reason: expect.stringMatching(/withdrawn \(void\)/), confirmed: true });
    state.doc = issuedDoc();
    state.holds = { data: [{ id: "h1", reason: "Client Review", opened_at: null, opened_by_name: null }], error: null };
    expect(await shareRefusalState("docA")).toEqual({ reason: expect.stringMatching(/Client Review/), confirmed: true });
    state.holds = { data: [], error: { message: "permission denied" } };
    expect(await shareRefusalState("docA")).toEqual({ reason: expect.stringMatching(/treated as held/), confirmed: false });
    state.holds = { data: [], error: null };
    state.docError = { message: "timeout" };
    expect(await shareRefusalState("docA")).toEqual({ reason: expect.stringMatching(/Couldn't confirm the document's status \(timeout\)/), confirmed: false });
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
    expect(share.auditWarning).toBeNull();
    expect(state.audits).toEqual([expect.objectContaining({ action: "SHARE_LINK_CREATED", resourceId: "docA", resourceType: "document", orgId: "orgA", userId: "u1" })]);
    state.inserts = []; state.audits = [];
    state.insertError["document_shares"] = { message: "new row violates row-level security policy for table \"document_shares\"", code: "42501" };
    await expect(createShareLink(input)).rejects.toThrow(SHARE_MINT_REFUSED);
    expect(state.audits).toHaveLength(0);
  });
  it("revoke touches only a LIVE row and selects it back (zero rows on a live row throws — EGRESS-7); writes SHARE_LINK_REVOKED on the document", async () => {
    const { revokeShareLink } = await import("@/lib/documentShares");
    state.updateRows = [];
    await expect(revokeShareLink("s1", "u1")).rejects.toThrow(/was not revoked/);
    expect(state.audits).toHaveLength(0);
    state.updateRows = [{ id: "s1", org_id: "orgA", document_id: "docA" }];
    expect(await revokeShareLink("s1", "u1")).toEqual({ auditWarning: null });
    expect(state.calls).toContainEqual({ table: "document_shares", method: "is", args: ["revoked_at", null] });
    expect(state.calls).toContainEqual({ table: "document_shares", method: "select", args: ["id, org_id, document_id"] });
    expect(state.audits).toEqual([expect.objectContaining({ action: "SHARE_LINK_REVOKED", resourceId: "docA", orgId: "orgA", userId: "u1", details: { shareId: "s1" } })]);
  });
  it("revoking a row that is ALREADY revoked (double click, stale modal, a second controller) is a no-op success with no second audit row", async () => {
    const { revokeShareLink } = await import("@/lib/documentShares");
    state.updateRows = []; // the .is("revoked_at", null) filter matched nothing
    state.share = { ...liveShare(), revoked_at: "2026-09-30T10:00:00Z" };
    await expect(revokeShareLink("s1", "u2")).resolves.toEqual({ auditWarning: null });
    expect(state.calls).toContainEqual({ table: "document_shares", method: "select", args: ["id, revoked_at"] });
    expect(state.audits).toHaveLength(0);
  });
  it("the SHARE_LINK_CREATED / SHARE_LINK_REVOKED audit writes are CHECKED: a refused audit row leaves the link change standing and hands the caller a warning, never a silent success", async () => {
    const { createShareLink, revokeShareLink } = await import("@/lib/documentShares");
    state.auditError = "new row violates row-level security policy for table \"audit_logs\"";
    const made = await createShareLink(input);
    expect(made.id).toBe("new-share"); // the link exists
    expect(made.auditWarning).toMatch(/^The link was created, but its audit record could not be written \(new row violates row-level security/);
    state.updateRows = [{ id: "s1", org_id: "orgA", document_id: "docA" }];
    const done = await revokeShareLink("s1", "u1");
    expect(done.auditWarning).toMatch(/^The link was revoked, but its audit record could not be written/);
    expect(state.audits.map((a) => a.action)).toEqual(["SHARE_LINK_CREATED", "SHARE_LINK_REVOKED"]);
    // the modal shows it (non-fatal: the change stood)
    const m = src("components/documents/ShareLinkModal.tsx");
    expect(m).toContain("setAuditNotice(made.auditWarning);");
    expect(m).toContain("setAuditNotice(done.auditWarning);");
    expect(m).toMatch(/\{auditNotice && \(/);
  });
  it("a browser clock AHEAD of the database's: the 90-day pick overshoots the server ceiling by the skew, which 20261080 clamps (up to 1 hour) rather than refuses; a refusal past that reads as a sentence", async () => {
    const { createShareLink, SHARE_EXPIRY_REFUSED } = await import("@/lib/documentShares");
    const serverNow = Date.UTC(2026, 8, 30, 12);
    const clientNow = serverNow + 3_000; // the laptop's clock runs 3 s fast
    const exp = shareExpiryFor(SHARE_MAX_DAYS, clientNow);
    if (!exp.ok) throw new Error("90 days must be allowed");
    const overshootMs = new Date(exp.expiresAt).getTime() - (serverNow + SHARE_MAX_DAYS * 86_400_000);
    expect(overshootMs).toBe(3_000);
    const guard = between(stripSqlComments(mig("20261080_dc_roundF_share_minting_and_revocation.sql")), "IF TG_OP = 'INSERT' THEN", "RETURN NEW;");
    const tol = guard.match(/NEW\.expires_at > NEW\.created_at \+ interval '90 days' \+ interval '(\d+) hour' THEN/);
    expect(tol, "the INSERT branch's skew tolerance").not.toBeNull();
    expect(Number(tol![1]) * 3_600_000).toBeGreaterThan(overshootMs);
    expect(guard).toMatch(/IF NEW\.expires_at > NEW\.created_at \+ interval '90 days' THEN\s*\n\s*NEW\.expires_at := NEW\.created_at \+ interval '90 days';/);
    // beyond the tolerance the guard raises; the modal shows a sentence, not the exception text
    state.insertError["document_shares"] = { message: "document_shares: a share must expire within 90 days of its creation", code: "P0001" };
    await expect(createShareLink(input)).rejects.toThrow(SHARE_EXPIRY_REFUSED);
    expect(SHARE_EXPIRY_REFUSED).not.toMatch(/document_shares:/);
    expect(state.audits).toHaveLength(0);
  });
  it("loadShareDocumentContext resolves what a link serves by the ROUTES' rule (SHR-7): the served row's label, nothing for an unpublished current row, 'unknown' on a read error", async () => {
    const { loadShareDocumentContext } = await import("@/lib/documentShares");
    let ctx = await loadShareDocumentContext("docA");
    expect(ctx.served).toEqual({ kind: "served", rev: "B" }); // revision_label, not documents.rev ("A")
    expect(state.calls).toContainEqual({ table: "documents", method: "select", args: ["rev, status, archived_at, library_id, current_version_id"] });
    state.versionById = { "v-cur": publishedVersion({ review_state: "in_review" }) };
    state.latest = [publishedVersion({ id: "v-old", revision_label: "A" })];
    ctx = await loadShareDocumentContext("docA");
    expect(ctx.served).toEqual({ kind: "none" }); // refused, not walked past — the server answers nofile too
    state.versionError = { message: "timeout" };
    ctx = await loadShareDocumentContext("docA");
    expect(ctx.served).toEqual({ kind: "unknown", error: "timeout" });
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
    // no cross-tenant oracle: another org's document reads 'not_found' (the service role is unscoped) ...
    expect(fn).toMatch(/LEFT JOIN documents d ON d\.id = p_doc AND d\.org_id = p_org\s*\n\s*AND \(auth\.uid\(\) IS NULL OR p_org IN \(SELECT my_org_ids\(\)\)\)\s*\n/);
    // ... and no in-org oracle: a private / hidden document the caller cannot read reads 'not_found' too —
    // the same node_visible call the INSERT policy already requires, so no legitimate mint changes
    expect(fn).toMatch(/AND \(auth\.uid\(\) IS NULL OR node_visible\(d\.visibility, d\.acl_index, d\.org_id,\s*\n\s*d\.owner_user_id, d\.collection_id, d\.library_id\)\);\s*\n\$\$;/);
    const tail = m.slice(m.indexOf("\nCOMMIT;"));
    expect(tail).toMatch(/answers only for a document the caller can read/);
    expect(tail).toContain("prosrc LIKE '%auth.uid() IS NULL OR node_visible(d.visibility, d.acl_index, d.org_id,%'");
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
    // the ceiling is measured on the DATABASE's clock: a live INSERT is born now(), whatever created_at the client sent
    const ins = between(next, "IF TG_OP = 'INSERT' THEN", "RETURN NEW;");
    expect(ins).toMatch(/IF NEW\.revoked_at IS NULL THEN\s*\n(?:\s*--[^\n]*\n)*\s*NEW\.created_at := now\(\);/);
    expect(ins).not.toMatch(/COALESCE\(NEW\.created_at/);
    expect(ins.indexOf("NEW.created_at := now();")).toBeLessThan(ins.indexOf("RAISE EXCEPTION"));
    expect(ins).toMatch(/IF NEW\.expires_at IS NULL\s*\n\s*OR NEW\.expires_at > NEW\.created_at \+ interval '90 days' \+ interval '1 hour' THEN/);
    expect(ins).toMatch(/IF NEW\.expires_at > NEW\.created_at \+ interval '90 days' THEN\s*\n\s*NEW\.expires_at := NEW\.created_at \+ interval '90 days';/);
    // ... and created_at never moves after (the UPDATE path), so the ceiling cannot be walked forward
    expect(added).toContain("IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN");
    expect(added).toContain("RAISE EXCEPTION 'document_shares: created_at is immutable — the 90-day expiry ceiling is measured from it';");
    expect(next.indexOf("IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN")).toBeGreaterThan(next.indexOf("IF TG_OP = 'INSERT' THEN"));
    // a row with no created_at has no anchor: its expiry may only move earlier
    expect(next).toMatch(/NEW\.expires_at > COALESCE\(OLD\.created_at \+ interval '90 days', OLD\.expires_at\)\) THEN/);
    // a row born revoked (restore, DEC-45) is exempt from the INSERT expiry rule and keeps its created_at
    expect(ins.indexOf("IF NEW.revoked_at IS NULL THEN")).toBeLessThan(ins.indexOf("NEW.created_at := now();"));
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
    expect(tbl).toMatch(/kind\s+TEXT NOT NULL CHECK \(kind IN \('resolve', 'download', 'refused'\)\)/);
    expect(tbl).toMatch(/\breason\s+TEXT,/);
    expect(tbl).toMatch(/refused_minute TIMESTAMPTZ,/);
    expect(tbl).toMatch(/resolve_minute TIMESTAMPTZ,/);
    expect(tbl).toMatch(/CHECK \(\(kind = 'refused'\) = \(reason IS NOT NULL AND refused_minute IS NOT NULL\)\)/);
    expect(tbl).toMatch(/CONSTRAINT document_share_accesses_resolve_shape\s*\n\s*CHECK \(\(kind = 'resolve'\) = \(resolve_minute IS NOT NULL\)\)/);
    expect(tbl).toMatch(/\bip\s+TEXT,/);
    expect(tbl).toMatch(/user_agent\s+TEXT,/);
    // the bound on refused attempts: one per share per minute
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS document_share_accesses_refused_bound\s*\n\s*ON document_share_accesses\(share_id, refused_minute\) WHERE kind = 'refused';/);
    // ... and on served opens: one per share per client IP per minute (a NULL IP is one bucket, not unbounded)
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS document_share_accesses_resolve_bound\s*\n\s*ON document_share_accesses\(share_id, \(COALESCE\(ip, ''\)\), resolve_minute\) WHERE kind = 'resolve';/);
    expect(m).toMatch(/document_share_accesses_refused_bound/);
    expect(code).toMatch(/ALTER TABLE document_share_accesses ENABLE ROW LEVEL SECURITY;/);
    const policies = [...code.matchAll(/CREATE POLICY (\w+) ON document_share_accesses FOR (\w+)/g)].map((x) => [x[1], x[2]]);
    expect(policies).toEqual([["document_share_accesses_controller_select", "SELECT"]]);
    expect(between(code, "CREATE POLICY document_share_accesses_controller_select", ";")).toMatch(/USING \(is_org_controller\(org_id\)\)/);
  });

  it("bump_share_access keeps its arity (a deployed route's call resolves across the apply): the 20260818 body byte-carried, only the CREATE-time pin added, no IP, service_role only", () => {
    // no arity change: the one-argument function is NOT dropped (the route already deployed calls it by
    // { p_share } through the apply); a two-argument twin from an earlier draft is dropped if present
    expect(code).not.toMatch(/DROP FUNCTION IF EXISTS bump_share_access\(uuid\);/);
    expect(code).toMatch(/DROP FUNCTION IF EXISTS bump_share_access\(uuid, text\);/);
    const live = between(m18, "CREATE OR REPLACE FUNCTION bump_share_access(p_share uuid)", "$$;");
    const next = between(m, "CREATE OR REPLACE FUNCTION bump_share_access(p_share uuid)", "$$;");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual(["RETURNS void LANGUAGE sql SECURITY DEFINER AS $$"]);
    expect(onlyInB).toEqual(["RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$"]);
    // the accessor IP never lands on document_shares (readable by every member who can read the document):
    // the only assignment to the column is the apply-time clear
    expect([...code.matchAll(/access_last_ip\s*=\s*([^\s;]+)/g)].map((x) => x[1])).toEqual(["NULL"]);
    expect(code).toMatch(/UPDATE document_shares SET access_last_ip = NULL WHERE access_last_ip IS NOT NULL;/);
    expect(code).toMatch(/COMMENT ON COLUMN document_shares\.access_last_ip IS\s*\n\s*'Unused by design/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION bump_share_access\(uuid\) FROM PUBLIC;/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION bump_share_access\(uuid\) FROM anon;/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION bump_share_access\(uuid\) FROM authenticated;/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION bump_share_access\(uuid\) TO service_role;/);
    const tail = m.slice(m.indexOf("\nCOMMIT;"));
    for (const like of tail.matchAll(/LIKE\s+'([^']*)'/g)) expect(like[1], like[0]).not.toMatch(/::/);
    expect(tail).toMatch(/to_regprocedure\('bump_share_access\(uuid, text\)'\) IS NULL/);
    expect(tail).toMatch(/prosrc NOT LIKE '%access_last_ip%'/);
    expect(tail).toMatch(/indexname = 'document_share_accesses_resolve_bound'/);
  });

  it("idempotent over a paste of an EARLIER draft: the draft-era table is brought to this shape before any index names a new column; the DEC-30 inventory is captured before the transaction; ONE final result set", () => {
    const create = code.indexOf("CREATE TABLE IF NOT EXISTS document_share_accesses (");
    const firstIndex = code.indexOf("CREATE INDEX IF NOT EXISTS document_share_accesses_share_idx");
    const upgrade = code.slice(create, firstIndex);
    for (const col of ["reason TEXT", "refused_minute TIMESTAMPTZ", "resolve_minute TIMESTAMPTZ"]) {
      expect(upgrade).toContain(`ALTER TABLE document_share_accesses ADD COLUMN IF NOT EXISTS ${col};`);
    }
    // a draft-era open satisfies the shape CHECK before it is added (its own created_at as its key)
    expect(upgrade).toMatch(/UPDATE document_share_accesses SET resolve_minute = created_at\s*\n\s*WHERE kind = 'resolve' AND resolve_minute IS NULL;/);
    expect(upgrade.indexOf("UPDATE document_share_accesses SET resolve_minute")).toBeLessThan(upgrade.indexOf("DO $$"));
    // each constraint add is GUARDED by pg_constraint (a re-run is a no-op); the first draft's kind CHECK is replaced only when it lacks 'refused'
    for (const name of ["document_share_accesses_refused_shape", "document_share_accesses_resolve_shape"]) {
      expect(upgrade).toMatch(new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_constraint[\\s\\S]*?conname = '${name}'\\) THEN\\s*\\n\\s*ALTER TABLE document_share_accesses ADD CONSTRAINT ${name}`));
    }
    expect(upgrade).toMatch(/conname = 'document_share_accesses_kind_check'\s*\n\s*AND pg_get_constraintdef\(oid\) NOT LIKE '%refused%'\) THEN/);
    expect(upgrade).toMatch(/ADD CONSTRAINT document_share_accesses_kind_check\s*\n\s*CHECK \(kind IN \('resolve', 'download', 'refused'\)\);/);
    // the resolve bound comes after the upgrade
    expect(code.indexOf("document_share_accesses_resolve_bound")).toBeGreaterThan(code.indexOf("ADD COLUMN IF NOT EXISTS resolve_minute"));
    // DEC-30: the rows the clear empties are counted before BEGIN; the tail carries them and the probe
    const head = code.slice(0, code.indexOf("BEGIN;"));
    expect(head).toMatch(/CREATE TEMP TABLE dc_round_f_81_before AS[\s\S]*COUNT\(\*\)::text AS n\s*\n\s*FROM document_shares\s*\n\s*WHERE access_last_ip IS NOT NULL;/);
    const tail = code.slice(code.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);
    expect(tail).toContain("SELECT inventory, NULL, n FROM dc_round_f_81_before");
    expect(tail).toMatch(/'no share carries access_last_ip \(cleared on apply; nothing writes it\)',\s*\n\s*\(SELECT COUNT\(\*\) = 0 FROM document_shares WHERE access_last_ip IS NOT NULL\)/);
    // ONE statement after COMMIT: the final SELECT (string literals blanked before counting semicolons)
    expect(tail.replace(/'(?:[^']|'')*'/g, "''").trim().split(";").filter((x) => x.trim()).length).toBe(1);
    expect(tail.trim().startsWith("SELECT")).toBe(true);
  });

  it("the numbered sequence's LAST definition of each share object is this package's", () => {
    const files = readdirSync(join(root, "supabase", "migrations")).filter((f) => /^\d{8}/.test(f) && f.endsWith(".sql")).sort();
    const lastDefining = (re: RegExp) => files.filter((f) => re.test(stripSqlComments(mig(f)))).at(-1);
    // P12 WAVE-2 RESIDUALS (SHR-14) re-creates the INSERT rail from 20261080's body + the download-deny arm
    expect(lastDefining(/CREATE POLICY document_shares_insert ON/)).toBe("20261140_dc_roundF_share_download_deny_rail.sql");
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
    // SHR-7: "resolves to" is the ROUTES' answer (lib/shareRules resolveServedVersion via loadShareDocumentContext),
    // refused-with-reason when the document cannot serve — not documents.rev
    expect(m).toContain("setServed(ctx.served);");
    expect(m).toContain('served.kind === "served" ? `resolves to Rev ${served.rev || "0"}`');
    expect(m).toContain("{!dead && resolvesTo && <span");
    expect(m).not.toMatch(/resolves to Rev \{currentRev/);
    // the copy promises nothing the lifecycle does not deliver: split / merge do not revoke, reverse restores
    // Issued, and archive-time revocation is another package's — so it says "stops serving … may be revoked"
    expect(m).not.toMatch(/permanently once/);
    expect(m).not.toMatch(/superseding the document revokes it/);
    expect(m).not.toMatch(/serves again if that is undone/);
    expect(m).toContain("A link stops serving while the document is held, withdrawn or archived, and may be revoked when it is superseded, split, merged or archived.");
    // a refusal this browser could not CONFIRM (a failed read) never reads as "not serving"
    expect(m).toContain("shareRefusalState(documentId),");
    expect(m).toContain("setRefusalConfirmed(why?.confirmed ?? true);");
    expect(m).toContain(`: refusal && !refusalConfirmed ? "couldn't confirm whether it is serving"`);
    expect(m.indexOf("refusal && !refusalConfirmed ?")).toBeLessThan(m.indexOf(': refusal ? "not serving now'));
    expect(m).toMatch(/\{refusalConfirmed\s*\n\s*\? <span>No new link can be created, and existing links are not serving: \{refusal\}<\/span>\s*\n\s*: <span>No new link can be created: \{refusal\} Whether existing links are serving couldn&rsquo;t be confirmed/);
    // what a row cannot know (its creator's current authority) is stated, not guessed
    expect(m).toMatch(/A link serves on its creator&rsquo;s current authority: it also stops serving if they leave the organisation, can no longer read this document, are denied download on it, or no longer hold Document Control \/ Admin or a publish grant on this library\./);
    // EGRESS-8 path: an unreadable document loads no context (no "Document not found" banner), and a list
    // failure never marks the caller as a non-minter
    const refresh = between(m, "const refresh = useCallback(async () => {", "}, [documentId, orgId, createdBy, isController]);");
    expect(refresh.indexOf("if (!readableNow) {")).toBeGreaterThan(-1);
    expect(refresh.indexOf("if (!readableNow) {")).toBeLessThan(refresh.indexOf("await loadShareDocumentContext(documentId)"));
    expect(refresh).toContain("catch (e) { setListError((e as Error).message); }");
    expect(refresh).not.toMatch(/setCanMint\(false\)/);
    // a failed context read never leaves an earlier read's CONFIRMED refusal standing: the refusal is reset
    // to an unconfirmed one, so the banner and "resolves to" say "couldn't confirm", never "not serving"
    const failed = refresh.slice(refresh.indexOf("await loadShareDocumentContext(documentId)"));
    const catchBody = failed.slice(failed.indexOf("} catch (e) {"), failed.indexOf("} finally"));
    expect(catchBody).toContain("setError((e as Error).message); setCanMint(null); setServed(null);");
    expect(catchBody).toMatch(/setRefusal\("Couldn't confirm the document's state; it is treated as unshareable\."\);\s*\n\s*setRefusalConfirmed\(false\);/);
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
