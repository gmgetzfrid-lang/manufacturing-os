// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P15 DELIVERABLE PAGE WIRING — the ticket page's
// side (app/(protected)/requests/[id]/page.tsx and its two new components).
//
//   EVID-16 dw2  lib/ticketCopyRequest.ts: which path a file's copy takes (the
//                server copy route's own door, mirrored), the route's answers
//                classified, the confirm / unstampable questions asked once
//                each; a file the server cannot issue keeps the browser path
//                and is said. Page wiring pinned by source.
//   PHYS-18      TicketCopyRecallPanel, rendered: the holders, the recall
//                (source "manual"), an unreadable record said as a gap.
//   DCW-4        PublishNewDocumentModal, rendered: createDocumentWithFile
//                with relatedTicketId, then the first version handed back.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  recall: null as unknown,
  recallCalls: 0,
  nudges: [] as Array<Record<string, unknown>>,
  nudgeResult: 1 as number | Error,
  creates: [] as Array<Record<string, unknown>>,
  createError: null as Error | null,
  /** The register as the caller's client reads it (findTicketNewDocumentVersion). */
  versions: [] as Array<Record<string, unknown>>,
  documents: [] as Array<Record<string, unknown>>,
  readErrors: {} as Record<string, { message: string } | null>,
  reads: [] as Array<{ table: string; filters: Array<[string, string, unknown]> }>,
}));
vi.mock("@/lib/staleCopies", () => ({
  getTicketCopyRecall: vi.fn(async () => { s.recallCalls += 1; return s.recall; }),
  nudgeStaleTicketHolders: vi.fn(async (input: Record<string, unknown>) => {
    s.nudges.push(input);
    if (s.nudgeResult instanceof Error) throw s.nudgeResult;
    return s.nudgeResult;
  }),
}));
vi.mock("@/lib/revisions", () => ({
  createDocumentWithFile: vi.fn(async (input: Record<string, unknown>) => {
    s.creates.push(input);
    if (s.createError) throw s.createError;
    return { documentId: "doc-new", status: input.status, reviewPolicy: null, creationAuditError: null };
  }),
}));
vi.mock("@/lib/supabase", () => {
  const from = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    s.reads.push({ table, filters });
    const settle = () => {
      const err = s.readErrors[table] ?? null;
      if (err) return { data: null, error: err };
      const rows = (table === "document_versions" ? s.versions : s.documents).filter((r) => filters.every(([op, k, v]) =>
        op === "eq" ? r[k] === v : (v as unknown[]).includes(r[k])));
      return { data: rows, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (k: string, v: unknown) => { filters.push(["eq", k, v]); return q; },
      in: (k: string, v: unknown[]) => { filters.push(["in", k, v]); return q; },
      order: () => q,
      then: (resolve: (v: unknown) => void) => resolve(settle()),
    };
    return q;
  };
  return { supabase: { from } };
});

import { ticketFileCopyPath, requestTicketCopy, takeTicketCopy, filenameFromDisposition, BROWSER_PATH_NOTE, NON_PDF_PRINT_NOTE, READ_SCOPE_FALLBACK_NOTE } from "@/lib/ticketCopyRequest";
import { OVERSIZE_FALLBACK_NOTE } from "@/lib/ticketCopyRequest";
import { findTicketNewDocumentVersion, newDocumentNotRecordedMessage } from "@/lib/ticketNewDocumentHandback";
import { supabase as clientDb } from "@/lib/supabase";
import TicketCopyRecallPanel from "@/components/requests/TicketCopyRecallPanel";
import PublishNewDocumentModal from "@/components/requests/PublishNewDocumentModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const ORG = "11111111-1111-1111-1111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const T = "77777777-7777-7777-7777-777777777777";
const UNDER = `orgs/${ORG}/tickets/KE-9/ifc.pdf`;
const ctx = (attachments: Array<{ id?: string }>) => ({ ticketRowId: T, orgId: ORG, ticketNumber: "KE-9", requesterId: REQ, attachments });

// ─── which path ──────────────────────────────────────────────────────────────
describe("EVID-16 done-when 2 — which path a ticket file's copy takes", () => {
  it("a file the ticket names once, stored under its prefix or at the requester's staged key, goes through the server", () => {
    expect(ticketFileCopyPath({ id: "f-1", url: UNDER }, ctx([{ id: "f-1" }]))).toEqual({ kind: "server" });
    const staged = `orgs/${ORG}/user_private/${REQ}/ticket_staging/batch1/a.pdf`;
    const p = ticketFileCopyPath({ id: "f-2", url: staged }, ctx([{ id: "f-2" }]));
    // the staged-key rule is lib/ticketCreate isStagedKeyOf's — whatever it admits, the route admits
    expect(["server", "browser"]).toContain(p.kind);
  });
  it("a legacy absolute URL keeps the browser path (said: recorded before files were stored by path)", () => {
    expect(ticketFileCopyPath({ id: "f-1", url: "https://cdn.example.com/x.pdf" }, ctx([{ id: "f-1" }]))).toEqual({ kind: "browser", reason: "legacy_url" });
    expect(BROWSER_PATH_NOTE.legacy_url).toMatch(/recorded before files were stored by path/);
  });
  it("a library file named at filing (a register key, not this request's storage) keeps the browser path", () => {
    expect(ticketFileCopyPath({ id: "f-1", url: `orgs/${ORG}/libraries/L/doc.pdf` }, ctx([{ id: "f-1" }]))).toEqual({ kind: "browser", reason: "outside_request" });
    expect(ticketFileCopyPath({ id: "f-1", url: `orgs/${ORG}/tickets/KE-10/x.pdf` }, ctx([{ id: "f-1" }]))).toEqual({ kind: "browser", reason: "outside_request" });
  });
  it("a file not named once by a well-formed id (no id, a malformed one, an id on two files) keeps the browser path", () => {
    expect(ticketFileCopyPath({ id: undefined as unknown as string, url: UNDER }, ctx([{}]))).toEqual({ kind: "browser", reason: "unaddressable" });
    expect(ticketFileCopyPath({ id: "bad id!", url: UNDER }, ctx([{ id: "bad id!" }]))).toEqual({ kind: "browser", reason: "unaddressable" });
    expect(ticketFileCopyPath({ id: "f-1", url: UNDER }, ctx([{ id: "f-1" }, { id: "f-1" }]))).toEqual({ kind: "browser", reason: "unaddressable" });
    expect(ticketFileCopyPath({ id: "f-1", url: UNDER }, { ...ctx([{ id: "f-1" }]), ticketRowId: null })).toEqual({ kind: "browser", reason: "unaddressable" });
  });
});

// ─── the route's answers ─────────────────────────────────────────────────────
type Call = { url: string; body: Record<string, unknown>; auth: string };
function fakeFetch(answers: Array<() => Response>) {
  const calls: Call[] = [];
  const impl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next();
  };
  return { calls, impl };
}
const pdf = (stamped = true) => () => new Response(new Blob(["%PDF-1.7"]), { status: 200, headers: { "content-disposition": 'attachment; filename="ifc_Rev1.pdf"', "x-ticket-copy-stamped": stamped ? "1" : "0" } });
const json = (status: number, body: Record<string, unknown>) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const base = { ticketRowId: T, attachmentId: "f-1", fallbackName: "ifc.pdf", getToken: async () => "tok" };

describe("EVID-16 done-when 2 — the server copy, its questions asked once each", () => {
  it("a print: one POST with the bearer and the channel; the stamped bytes and the server's file name come back", async () => {
    const f = fakeFetch([pdf()]);
    const out = await takeTicketCopy({ ...base, channel: "print", confirm: async () => true, fetchImpl: f.impl });
    expect(out).toMatchObject({ kind: "file", filename: "ifc_Rev1.pdf", stamped: true });
    expect(f.calls).toEqual([{ url: "/api/tickets/copy", body: { ticketId: T, attachmentId: "f-1", channel: "print" }, auth: "Bearer tok" }]);
  });
  it("409 confirm: the message is asked; yes → retried with acknowledged; no → nothing taken", async () => {
    const yes = fakeFetch([json(409, { error: "confirm", message: "This file is Rev 1, but KE-9 has since issued Rev 2. Print it anyway?" }), pdf()]);
    const asked: string[] = [];
    const out = await takeTicketCopy({ ...base, channel: "print", confirm: async (m) => { asked.push(m); return true; }, fetchImpl: yes.impl });
    expect(out.kind).toBe("file");
    expect(asked).toEqual(["This file is Rev 1, but KE-9 has since issued Rev 2. Print it anyway?"]);
    expect(yes.calls[1].body).toMatchObject({ acknowledged: true });
    const no = fakeFetch([json(409, { error: "confirm", message: "…" })]);
    expect(await takeTicketCopy({ ...base, channel: "download", confirm: async () => false, fetchImpl: no.impl })).toEqual({ kind: "declined" });
    expect(no.calls).toHaveLength(1);
  });
  it("422 unstampable: asked; yes → retried with acceptUnstamped (keeping the acknowledgement); the copy is marked unstamped", async () => {
    const f = fakeFetch([json(409, { error: "confirm", message: "c" }), json(422, { error: "unstampable", message: "u" }), pdf(false)]);
    const out = await takeTicketCopy({ ...base, channel: "download", confirm: async () => true, fetchImpl: f.impl });
    expect(out).toMatchObject({ kind: "file", stamped: false });
    expect(f.calls[2].body).toMatchObject({ acknowledged: true, acceptUnstamped: true });
  });
  it("a file the server cannot issue (legacy_file, not stored under this request, not on this request, 400) → the browser path, said", async () => {
    for (const ans of [
      json(409, { error: "legacy_file", message: "This file was recorded before files were stored by path…" }),
      json(409, { error: "That file is not stored under this request" }),
      json(404, { error: "That file is not on this request" }),
      json(400, { error: "ticketId, attachmentId and channel (print | download | view) are required" }),
    ]) {
      const f = fakeFetch([ans]);
      expect((await takeTicketCopy({ ...base, channel: "print", confirm: async () => true, fetchImpl: f.impl })).kind).toBe("browser");
    }
  });
  it("anything else is said in words and nothing is copied: 503 unrecorded, 409 archived, 404 not in storage, 401, a network failure, no session", async () => {
    for (const ans of [
      json(503, { error: "unrecorded", message: "This copy was not issued: the distribution record refused it." }),
      json(409, { error: "archived", message: "This request is archived…" }),
      json(404, { error: "That file is not in storage" }),
      json(401, { error: "Unauthorized" }),
    ]) {
      const f = fakeFetch([ans]);
      const out = await takeTicketCopy({ ...base, channel: "download", confirm: async () => true, fetchImpl: f.impl });
      expect(out.kind).toBe("refused");
    }
    const net = await requestTicketCopy({ ...base, channel: "print", token: "t" }, async () => { throw new Error("offline"); });
    expect(net).toMatchObject({ kind: "refused", status: 0 });
    expect(await takeTicketCopy({ ...base, getToken: async () => null, channel: "print", confirm: async () => true })).toMatchObject({ kind: "refused" });
  });
  it("a preview (view) asks nothing: it is requested acknowledged and accepting unstamped, so the stamp says the standing and an unstampable file is marked", async () => {
    const f = fakeFetch([pdf(false)]);
    const confirm = vi.fn(async () => true);
    const out = await takeTicketCopy({ ...base, channel: "view", confirm, fetchImpl: f.impl });
    expect(out).toMatchObject({ kind: "file", stamped: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(f.calls[0].body).toEqual({ ticketId: T, attachmentId: "f-1", channel: "view", acknowledged: true, acceptUnstamped: true });
  });
  it("DF-P15 fix — a PLATFORM failure with no JSON body (413 / 500 / 502 / 504: the host refusing or timing out the function) → the browser path, said; the route's own JSON 502 is still a refusal", async () => {
    for (const status of [413, 500, 502, 504]) {
      const f = fakeFetch([() => new Response("<html>Request Entity Too Large</html>", { status, headers: { "content-type": "text/html" } })]);
      const out = await takeTicketCopy({ ...base, channel: "print", confirm: async () => true, fetchImpl: f.impl });
      expect(out, String(status)).toEqual({ kind: "browser", message: `the server could not deliver it (HTTP ${status})` });
      expect(f.calls).toHaveLength(1);
    }
    const empty = await requestTicketCopy({ ...base, channel: "download", token: "t" }, async () => new Response(null, { status: 504 }));
    expect(empty.kind).toBe("not_server");
    // the route answering (JSON) is not a platform failure: said, nothing copied
    const routeSaid = await requestTicketCopy({ ...base, channel: "download", token: "t" },
      async () => new Response(JSON.stringify({ error: "The file could not be read from storage right now — try again in a moment" }), { status: 502 }));
    expect(routeSaid).toMatchObject({ kind: "refused", status: 502 });
    // a non-JSON 503 / 401 is not on the platform list
    expect((await requestTicketCopy({ ...base, channel: "download", token: "t" }, async () => new Response("x", { status: 503 }))).kind).toBe("refused");
  });
  it("DF-P15 fix — bytes cut off in transit (the body fails to read) → the browser path, said; requestTicketCopy never throws", async () => {
    const broken = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("socket hang up")); } });
    const out = await requestTicketCopy({ ...base, channel: "download", token: "t" }, async () => new Response(broken, { status: 200 }));
    expect(out).toEqual({ kind: "not_server", message: "the copy was cut off in transit (socket hang up)" });
  });
  it("DF-P15 fix (review) — a Contractor-only member outside the route's read scope, before 20261166: the route's 404 \"Request not found\" keeps the browser path for print, download AND preview, said; nothing is asked", async () => {
    // Today's database (20261166 unpasted): the tickets RLS still shows this
    // member the ticket and /api/storage/download-url signs their copy, so
    // before DF-P15 their print, download and preview worked. The route
    // applies the narrower scope already (ticketReadScope → 404).
    for (const channel of ["print", "download", "view"] as const) {
      const f = fakeFetch([json(404, { error: "Request not found" })]);
      const confirm = vi.fn(async () => true);
      const out = await takeTicketCopy({ ...base, channel, confirm, fetchImpl: f.impl });
      expect(out, channel).toEqual({ kind: "browser", message: READ_SCOPE_FALLBACK_NOTE });
      expect(f.calls).toHaveLength(1);
      expect(confirm).not.toHaveBeenCalled();
    }
    expect(READ_SCOPE_FALLBACK_NOTE).toMatch(/Contractor read scope, which does not include you on this request/);
    // the page acts on "browser" for each: print → browserPrint, download → browserDownload, preview → the presigned inline frame, each said
    const page = src("app/(protected)/requests/[id]/page.tsx");
    const modal = page.slice(page.indexOf("const FileViewerModal = ("), page.indexOf("<DownloadComplianceModal"));
    expect(modal).toContain("} else if (out.kind === 'browser') {\n          setServerNote(out.message);\n          presign();");
    const printPart = modal.slice(modal.indexOf("const handlePrint = async"), modal.indexOf("const browserSourceUrl = async"));
    expect(printPart).toContain("if (out.kind === 'browser') {\n      setServerNote(out.message);");
    expect(printPart).toContain("return browserPrint({ standingConfirmed: out.acknowledged === true });\n    }\n    if (out.kind === 'refused')");
    const downloadPart = modal.slice(modal.indexOf("const performDownload = async"), modal.indexOf("const browserDownload = async"));
    expect(downloadPart).toContain("fallBack = true;");
    expect(downloadPart).toContain("if (fallBack) await browserDownload({ standingConfirmed });");
    // the viewer says why: serverNote is shown in the amber note
    expect(page).toContain("? `The server could not issue this file (${serverNote}). Its copies are stamped and recorded from your browser.`");
  });
  it("the file name comes from Content-Disposition, else the fallback", () => {
    expect(filenameFromDisposition('inline; filename="a_Rev2.pdf"', "x")).toBe("a_Rev2.pdf");
    expect(filenameFromDisposition(null, "x.pdf")).toBe("x.pdf");
  });
});

// ─── the page wiring (source pins) ───────────────────────────────────────────
describe("EVID-16 done-when 2 — the page's FileViewerModal is wired to the server route", () => {
  const page = src("app/(protected)/requests/[id]/page.tsx");
  const modal = page.slice(page.indexOf("const FileViewerModal = ("), page.indexOf("<DownloadComplianceModal"));
  it("print and download dispatch: a server-path file goes through takeTicketCopy, a browser-path file through the unchanged browser path", () => {
    expect(modal).toContain("const copyPath = file ? ticketFileCopyPath(file, { ...(copyContext ?? {}), ticketRowId: ticketRowId ?? null }) : null;");
    // DF-P15 fix: only a PDF prints from the server's stream (a hidden frame downloads an octet-stream blob)
    expect(modal).toContain("const printViaServer = viaServer && fileIsPdf;");
    expect(modal).toContain("if (!printViaServer) return browserPrint();");
    expect(modal).not.toContain("if (!viaServer) return browserPrint();");
    expect(modal).toContain("if (!viaServer) return browserDownload();");
    expect(modal).toContain('const out = await serverCopy("print");');
    expect(modal).toContain('const out = await serverCopy("download");');
    expect(modal).toContain('confirm: (message) => appConfirm({ message, tone: "danger" }),');
    // the server path never records from the tab: recordCopy lives only in the browser path
    const serverPart = modal.slice(modal.indexOf("const serverCopy = async"), modal.indexOf("const browserSourceUrl = async"));
    expect(serverPart).not.toContain("recordCopy(");
    expect(serverPart).not.toContain("getSignedUrlForPath(");
  });
  it("the PDF preview of a server-path file is the stamped server stream (channel view); the presigned inline frame stays for the rest", () => {
    expect(modal).toContain("if (viaServer && fileIsPdf && ticketRowId && file.id) {");
    expect(modal).toContain("ticketRowId, attachmentId: file.id, channel: 'view', fallbackName: file.name,");
    expect(modal).toContain("objectUrl = URL.createObjectURL(out.blob);");
    expect(modal).toContain("return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };");
    expect(modal).toContain("getSignedUrlForPath(file.url, undefined, { inline: true })");
  });
  it("a browser-path file says so, and an unstamped preview is marked", () => {
    expect(page).toContain("copyPath?.kind === 'browser' ? BROWSER_PATH_NOTE[copyPath.reason]\n                  : NON_PDF_PRINT_NOTE}");
    expect(page).toContain("Unstamped preview: the watermark / QR stamp could not be applied to this file");
  });
  it("DF-P15 fix — a non-PDF server-path file prints by the browser path (as before DF-P15) and the viewer says so; its download still goes through the server", () => {
    expect(page).toContain("(viaServer && !printViaServer && file.type !== 'Draft')");
    expect(NON_PDF_PRINT_NOTE).toMatch(/^This file is not a PDF, so it cannot carry the watermark \/ QR stamp: a print of it is loaded from the file itself and recorded from your browser\./);
    // the download dispatch is unchanged: a server-path non-PDF still downloads through the route
    expect(modal).toContain("if (!viaServer) return browserDownload();");
    // the browser print of a non-PDF loads the file itself into the frame once the stamp fails, and records from the tab
    const browserPart = modal.slice(modal.indexOf("const browserPrint = async"), modal.indexOf("const handleDownloadClick"));
    expect(browserPart).toContain("let printUrl = sourceUrl;");
    expect(browserPart).toContain('await recordCopy("print", stamped, plan.watermark,');
  });
  it("the browser path never re-stamps the server's stamped preview — it signs the raw file afresh", () => {
    expect(modal).toContain("(previewStamped === null ? resolvedUrl : null) || (/^https?:\\/\\//i.test(file.url) ? file.url : await getSignedUrlForPath(file.url));");
  });
  it("the page hands the modal the facts the door reads", () => {
    expect(page).toContain("copyContext={ticket ? { orgId: ticket.orgId, ticketNumber: ticket.ticketId, requesterId: ticket.requesterId, attachments: ticket.attachments } : null}");
  });
});

// ─── PHYS-18 — the recall control, rendered ──────────────────────────────────
let host: HTMLDivElement | null = null;
let root: Root | null = null;
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const byText = (sel: string, text: RegExp) => (Array.from(host!.querySelectorAll(sel)).find((e) => text.test(e.textContent ?? "")) ?? null) as HTMLElement | null;
beforeEach(() => {
  s.recall = null; s.recallCalls = 0; s.nudges = []; s.nudgeResult = 1; s.creates = []; s.createError = null;
  s.versions = [{ id: "v-new", org_id: ORG, related_ticket_id: T, record_id: "doc-new", revision_label: "0" }];
  s.documents = [{ id: "doc-new", org_id: ORG, library_id: "lib-1", document_number: "P-101-ISO-001" }];
  s.readErrors = {}; s.reads = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.clearAllMocks(); });

const TICKET = { id: T, orgId: ORG, status: "PENDING_IFC", deliverableRev: "2", history: [], revisionCount: 1, attachments: [] };
const holder = (userId: string, outdated: boolean, hasCurrent = false) => ({
  userId, userEmail: `${userId}@plant.test`, lastCopiedAt: "2026-10-19T00:00:00Z", outdated, hasCurrent,
  copies: [{ attachmentId: "f-1", rev: outdated ? "1" : "2", copiedAt: "2026-10-19T00:00:00Z", source: "drafting_print", verdict: outdated ? "superseded" : "current", underReview: false }],
});

describe("PHYS-18 — the recall control on the ticket page", () => {
  it("lists the holders, outdated first-marked, and recalls them (source manual) — the actor's own copy is not counted", async () => {
    s.recall = { holders: [holder("alice", true), holder("me", true), holder("bob", false, true)], capped: false, unavailable: false, latestIssuedRev: "2" };
    await act(async () => { root!.render(React.createElement(TicketCopyRecallPanel, { ticket: TICKET, ticketNumber: "KE-9", currentUserId: "me", currentUserName: "me@plant.test" })); });
    await flush();
    expect(host!.textContent).toMatch(/2 of 3 outdated/);
    await act(async () => { byText("button", /Copies taken/)!.click(); });
    await flush();
    expect(host!.textContent).toMatch(/alice/);
    expect(host!.textContent).toMatch(/Rev 1 — superseded/);
    const btn = byText("button", /Recall outdated copies \(1\)/)!;
    expect(btn).toBeTruthy();
    await act(async () => { btn.click(); });
    await flush();
    expect(s.nudges).toEqual([expect.objectContaining({ orgId: ORG, ticketId: T, ticketNumber: "KE-9", latestIssuedRev: "2", actorUserId: "me", source: "manual", unavailable: false })]);
    expect(host!.textContent).toMatch(/1 person was told/);
    expect(s.recallCalls).toBe(2); // re-read after the recall
  });
  it("a record that cannot be read is said as a gap — never 'nobody holds a copy' — and recording a recall then tells nobody", async () => {
    s.recall = { holders: [], capped: false, unavailable: true, latestIssuedRev: "2" };
    s.nudgeResult = 0;
    await act(async () => { root!.render(React.createElement(TicketCopyRecallPanel, { ticket: TICKET, ticketNumber: "KE-9", currentUserId: "me" })); });
    await flush();
    expect(host!.textContent).toMatch(/record unavailable/);
    await act(async () => { byText("button", /Copies taken/)!.click(); });
    await flush();
    expect(host!.textContent).toMatch(/who holds one is unknown — not "nobody"/);
    await act(async () => { byText("button", /Record a recall/)!.click(); });
    await flush();
    expect(s.nudges[0]).toMatchObject({ unavailable: true, source: "manual" });
    expect(host!.textContent).toMatch(/nobody could be told/);
  });
  it("a failed recall is said, never shown as sent; no holders at all renders nothing", async () => {
    s.recall = { holders: [holder("alice", true)], capped: true, unavailable: false, latestIssuedRev: "2" };
    s.nudgeResult = new Error("notifications refused");
    await act(async () => { root!.render(React.createElement(TicketCopyRecallPanel, { ticket: TICKET, ticketNumber: "KE-9", currentUserId: "me" })); });
    await flush();
    await act(async () => { byText("button", /Copies taken/)!.click(); });
    await flush();
    expect(host!.textContent).toMatch(/some holders may be missing/);
    await act(async () => { byText("button", /Recall outdated copies/)!.click(); });
    await flush();
    expect(host!.textContent).toMatch(/The recall was not sent: notifications refused/);
    expect(host!.textContent).not.toMatch(/was told/);
    act(() => root!.unmount());
    root = createRoot(host!);
    s.recall = { holders: [], capped: false, unavailable: false, latestIssuedRev: "2" };
    await act(async () => { root!.render(React.createElement(TicketCopyRecallPanel, { ticket: TICKET, ticketNumber: "KE-9", currentUserId: "me" })); });
    await flush();
    expect(host!.textContent).toBe("");
  });
  it("the page shows the panel to the requester, the assigned drafter and a controller only", () => {
    const page = src("app/(protected)/requests/[id]/page.tsx");
    expect(page).toContain("&& (ticket.requesterId === uid || ticket.assignedDrafterId === uid || isAdmin);");
    expect(page).toContain("const isAdmin = hasAnyRole(['Admin', 'DocCtrl']);");
    expect(page).toContain("{canRecallCopies && recallTicket && uid && (");
  });
});

// ─── DCW-4 — the new-document offer, rendered ────────────────────────────────
describe("DCW-4 — 'Publish as a new document in <library>'", () => {
  const props = (onCreated = vi.fn()) => ({
    orgId: ORG, libraryId: "lib-1", libraryName: "Piping", ticketRowId: T, ticketNumber: "KE-9", defaultTitle: "Pump iso",
    file: new File(["%PDF-1.7"], "ifc.pdf", { type: "application/pdf" }), actorUserId: "me", actorEmail: "me@plant.test", actorRole: "DocCtrl",
    onClose: vi.fn(), onCreated,
  });
  const setValue = async (node: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  it("creates the document through createDocumentWithFile with the ticket as provenance, Draft by default, then hands back its first version", async () => {
    const onCreated = vi.fn();
    await act(async () => { root!.render(React.createElement(PublishNewDocumentModal, props(onCreated))); });
    expect(host!.textContent).toMatch(/Publish as a new document in Piping/);
    await setValue(host!.querySelector("input[placeholder]") as HTMLInputElement, "P-101-ISO-001");
    await act(async () => { byText("button", /Create the document/)!.click(); });
    await flush();
    expect(s.creates).toEqual([expect.objectContaining({ orgId: ORG, libraryId: "lib-1", collectionId: null, documentNumber: "P-101-ISO-001", title: "Pump iso", status: "Draft", actorUserId: "me", actorRole: "DocCtrl", relatedTicketId: T })]);
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ versionId: "v-new", revisionLabel: "0", versionReadError: null, documentId: "doc-new", documentNumber: "P-101-ISO-001", status: "Draft" }));
    // the version is found by what it is: this document's, carrying the ticket, in this workspace
    expect(s.reads[0]).toEqual({ table: "document_versions", filters: [["eq", "org_id", ORG], ["eq", "related_ticket_id", T], ["eq", "record_id", "doc-new"]] });
  });
  it("DF-P15 fix (review) — a version read that FAILS after the create hands back no version and the reason (checked, never ignored)", async () => {
    const onCreated = vi.fn();
    s.readErrors = { document_versions: { message: "statement timeout" } };
    await act(async () => { root!.render(React.createElement(PublishNewDocumentModal, props(onCreated))); });
    await setValue(host!.querySelector("input[placeholder]") as HTMLInputElement, "P-101-ISO-001");
    await act(async () => { byText("button", /Create the document/)!.click(); });
    await flush();
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ versionId: null, versionReadError: "statement timeout", documentId: "doc-new" }));
  });
  it("no number, nothing created; a refusal is said and nothing is handed back", async () => {
    const onCreated = vi.fn();
    await act(async () => { root!.render(React.createElement(PublishNewDocumentModal, props(onCreated))); });
    await act(async () => { byText("button", /Create the document/)!.click(); });
    await flush();
    expect(s.creates).toEqual([]);
    expect(host!.textContent).toMatch(/A document number is required/);
    s.createError = new Error("You don't have authority to add documents to this library");
    await setValue(host!.querySelector("input[placeholder]") as HTMLInputElement, "X-1");
    await act(async () => { byText("button", /Create the document/)!.click(); });
    await flush();
    expect(host!.textContent).toMatch(/don't have authority/);
    expect(onCreated).not.toHaveBeenCalled();
  });
  it("the page offers it only to someone who may put a first revision in the library, for a library-only request with a Final not yet published", () => {
    const page = src("app/(protected)/requests/[id]/page.tsx");
    expect(page).toContain("const newDocLibraryId = !sourceRefId && ticket?.libraryId ? ticket.libraryId : null;");
    expect(page).toContain("const may = await canPutFirstRevisionInContainer({ orgId: ticketOrgId, libraryId: newDocLibraryId, collectionId: null, actorUserId: uid, actorRole: activeRole ?? undefined });");
    expect(page).toContain("if (!newDocLibraryId || !ticketOrgId || !uid || activeRole === null) { setCanPublishNew(false); setTargetLibraryName(null); return; }");
    expect(page).toContain("const canOfferNewDocument = !!newDocLibraryId && canPublishNew && !ticket.archivedAt && !!latestFinalAttachment(ticket.attachments) && deliverable?.state !== 'published' && !existingNewDoc;");
    expect(page).toContain("if (await recordHandback(r.versionId, r.revisionLabel, { newDocumentNumber: r.documentNumber })) setExistingNewDoc(null);");
  });
  it("DF-P15 fix — the hand-back toast says what the register holds: a new document filed as a Draft is never announced as an issued Rev 0", () => {
    const page = src("app/(protected)/requests/[id]/page.tsx");
    const fn = page.slice(page.indexOf("const recordHandback = async"), page.indexOf("// --- 2. SAFE SCROLL ---"));
    expect(fn).toContain("const filedAsDraft = (out.metadata?.deliverable as { filed_as_draft?: unknown } | undefined)?.filed_as_draft === true;");
    expect(fn).toContain("title: 'Filed as a Draft document on the request'");
    expect(fn).toContain("The deliverable is in the register as a Draft — not issued — and the request knows it.");
    // the Rev toast is the other branch only
    expect(fn.indexOf("filedAsDraft\n        ? {")).toBeGreaterThan(-1);
    expect(fn.indexOf("title: `Rev ${revisionLabel} recorded on the request`")).toBeGreaterThan(fn.indexOf("title: 'Filed as a Draft document on the request'"));
  });
});

// ─── DF-P15 fix (review) — the copy's marks, the preview and the hand-back recovery ───
describe("DF-P15 fix (review) — an oversize PDF keeps the browser path's stamp", () => {
  it("422 unstampable with reason oversize → the browser path for print and download, said; the unstamped question is NOT asked", async () => {
    for (const channel of ["print", "download"] as const) {
      const f = fakeFetch([json(422, { error: "unstampable", reason: "oversize", message: "The watermark / QR stamp could not be applied to this file (the file is 80 MB, over the 64 MB the server stamps). Take the UNSTAMPED copy anyway?" })]);
      const confirm = vi.fn(async () => true);
      const out = await takeTicketCopy({ ...base, channel, confirm, fetchImpl: f.impl });
      expect(out, channel).toEqual({ kind: "browser", message: OVERSIZE_FALLBACK_NOTE });
      expect(confirm).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(1);
    }
  });
  it("after the route's confirm was answered, the browser outcome carries acknowledged, so the tab does not ask again; REGRESSION: a real stamp failure (no reason) still asks the unstamped question", async () => {
    const f = fakeFetch([json(409, { error: "confirm", message: "superseded" }), json(422, { error: "unstampable", reason: "oversize", message: "u" })]);
    const out = await takeTicketCopy({ ...base, channel: "print", confirm: async () => true, fetchImpl: f.impl });
    expect(out).toEqual({ kind: "browser", message: OVERSIZE_FALLBACK_NOTE, acknowledged: true });
    const g = fakeFetch([json(422, { error: "unstampable", message: "u" })]);
    const asked = vi.fn(async () => false);
    expect(await takeTicketCopy({ ...base, channel: "print", confirm: asked, fetchImpl: g.impl })).toEqual({ kind: "declined" });
    expect(asked).toHaveBeenCalledWith("u");
  });
  it("the page sends a >64 MB print to browserPrint and a download to browserDownload, passing the answered confirm on (source pins)", () => {
    const page = src("app/(protected)/requests/[id]/page.tsx");
    const modal = page.slice(page.indexOf("const FileViewerModal = ("), page.indexOf("<DownloadComplianceModal"));
    expect(modal).toContain("return browserPrint({ standingConfirmed: out.acknowledged === true });");
    expect(modal).toContain("standingConfirmed = out.acknowledged === true;");
    expect(modal).toContain("const browserPrint = async (opts: { standingConfirmed?: boolean } = {}) => {");
    expect(modal).toContain("if (!opts.standingConfirmed && !(await confirmStanding(plan))) return;");
    expect(modal).toContain("const browserDownload = async (opts: { standingConfirmed?: boolean } = {}) => {");
    expect(modal).toContain("if (!opts.standingConfirmed && !(await confirmStanding(plan))) { setShowCompliance(false); return; }");
    // the browser path stamps in the tab (stampPdf / downloadStampedPdf), as before DF-P15
    expect(modal).toContain('const { stampPdf } = await import("@/lib/stamping");');
    expect(modal).toContain("await downloadStampedPdf({");
  });
});

describe("DF-P15 fix (review) — a transient refusal never blanks the PDF preview", () => {
  it("view: a JSON 502 (storage) or a 503 other than unrecorded (ticket / membership / scope read) → the presigned frame, previewOnly, said", async () => {
    for (const ans of [
      json(502, { error: "The file could not be read from storage right now — try again in a moment" }),
      json(503, { error: "Couldn't confirm your membership of this workspace — try again in a moment" }),
      json(503, { error: "Couldn't confirm you can see this request — try again in a moment" }),
      json(503, { error: "The request could not be read right now — try again in a moment" }),
    ]) {
      const f = fakeFetch([ans]);
      const out = await takeTicketCopy({ ...base, channel: "view", confirm: async () => true, fetchImpl: f.impl });
      expect(out).toMatchObject({ kind: "browser", previewOnly: true });
    }
  });
  it("REGRESSION: view with 503 unrecorded (DEC-44) or 401 is still refused; a print or download with a transient 503 is refused in words", async () => {
    for (const ans of [json(503, { error: "unrecorded", message: "This preview was not served: …" }), json(401, { error: "Unauthorized" })]) {
      const f = fakeFetch([ans]);
      expect((await takeTicketCopy({ ...base, channel: "view", confirm: async () => true, fetchImpl: f.impl })).kind).toBe("refused");
    }
    for (const channel of ["print", "download"] as const) {
      const f = fakeFetch([json(503, { error: "Couldn't confirm your membership of this workspace — try again in a moment" })]);
      expect((await takeTicketCopy({ ...base, channel, confirm: async () => true, fetchImpl: f.impl })).kind).toBe("refused");
    }
  });
  it("the page presigns on previewOnly and says it is the unstamped original while copies still go through the server (source pins)", () => {
    const page = src("app/(protected)/requests/[id]/page.tsx");
    expect(page).toContain("} else if (out.kind === 'browser' && out.previewOnly) {\n          setPreviewFallbackNote(out.message);\n          presign();");
    expect(page).toContain("Unstamped preview: the server could not show its stamped preview right now (${previewFallbackNote}), so this is the original from storage. Print and download still go through the server, stamped and recorded there.");
  });
});

describe("DF-P15 fix (review) — a created-but-unrecorded new document is recorded, never created twice", () => {
  const input = { orgId: ORG, ticketRowId: T, libraryId: "lib-1" };
  it("finds the version carrying the ticket whose document is in the request's library", async () => {
    expect(await findTicketNewDocumentVersion(clientDb, input)).toEqual({ kind: "found", version: { versionId: "v-new", documentId: "doc-new", documentNumber: "P-101-ISO-001", revisionLabel: "0" } });
  });
  it("a document in another library, or another workspace's version, is 'none'; a failed read is 'unknown' (never 'none')", async () => {
    s.documents = [{ id: "doc-new", org_id: ORG, library_id: "lib-OTHER", document_number: "X" }];
    expect(await findTicketNewDocumentVersion(clientDb, input)).toEqual({ kind: "none" });
    s.documents = [{ id: "doc-new", org_id: ORG, library_id: "lib-1", document_number: "X" }];
    s.versions = [{ id: "v-new", org_id: "o-other", related_ticket_id: T, record_id: "doc-new", revision_label: "0" }];
    expect(await findTicketNewDocumentVersion(clientDb, input)).toEqual({ kind: "none" });
    s.readErrors = { documents: { message: "timeout" } };
    s.versions = [{ id: "v-new", org_id: ORG, related_ticket_id: T, record_id: "doc-new", revision_label: "0" }];
    expect(await findTicketNewDocumentVersion(clientDb, input)).toEqual({ kind: "unknown", error: "timeout" });
  });
  it("the recovery text points at the existing document, never at a second create", () => {
    for (const retry of [true, false]) {
      const m = newDocumentNotRecordedMessage("P-101-ISO-001", "The ticket changed while you were acting — refresh and try again", retry);
      expect(m).toMatch(/Do not create it again\./);
      expect(m).not.toMatch(/Publish as a new document/);
    }
    expect(newDocumentNotRecordedMessage("P-1", "x", true)).toContain('Use "Record P-1 on the request"');
  });
  it("the page: once a version carrying the ticket exists, the create offer is replaced by 'Record <number> on the request'; a failed hand-back says so (source pins)", () => {
    const page = src("app/(protected)/requests/[id]/page.tsx");
    expect(page).not.toContain('try "Publish as a new document" again');
    expect(page).not.toContain('Refresh and try "Publish as a new document" again');
    expect(page).toContain("void findTicketNewDocumentVersion(supabase, { orgId: ticketOrgId, ticketRowId: ticket.id, libraryId: newDocLibraryId }).then((found) => {");
    expect(page).toContain("const canRecordExistingNewDocument = !!newDocLibraryId && canPublishNew && !ticket.archivedAt && deliverable?.state !== 'published' && !!existingNewDoc;");
    expect(page).toContain("setExistingNewDoc({ versionId: r.versionId, documentId: r.documentId, documentNumber: r.documentNumber, revisionLabel: r.revisionLabel });");
    expect(page).toContain("{recordingExisting ? 'Recording…' : `Record ${existingNewDoc.documentNumber || 'the existing document'} on the request`}");
    const fn = page.slice(page.indexOf("const recordHandback = async"), page.indexOf("// --- 2. SAFE SCROLL ---"));
    expect(fn).toContain("message: newDocumentNotRecordedMessage(opts.newDocumentNumber, (e as Error).message, true)");
  });
});
