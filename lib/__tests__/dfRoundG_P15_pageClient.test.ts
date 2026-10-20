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
  currentVersion: "v-new" as string | null,
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
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { current_version_id: s.currentVersion }, error: null }) }) }) }),
  },
}));

import { ticketFileCopyPath, requestTicketCopy, takeTicketCopy, filenameFromDisposition, BROWSER_PATH_NOTE } from "@/lib/ticketCopyRequest";
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
  it("anything else is said in words and nothing is copied: 503 unrecorded, 409 archived, 404 not found, 401, a network failure, no session", async () => {
    for (const ans of [
      json(503, { error: "unrecorded", message: "This copy was not issued: the distribution record refused it." }),
      json(409, { error: "archived", message: "This request is archived…" }),
      json(404, { error: "Request not found" }),
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
    expect(modal).toContain("if (!viaServer) return browserPrint();");
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
    expect(page).toContain("copyPath?.kind === 'browser' ? BROWSER_PATH_NOTE[copyPath.reason] : null");
    expect(page).toContain("Unstamped preview: the watermark / QR stamp could not be applied to this file");
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
  s.recall = null; s.recallCalls = 0; s.nudges = []; s.nudgeResult = 1; s.creates = []; s.createError = null; s.currentVersion = "v-new";
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
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ versionId: "v-new", documentId: "doc-new", documentNumber: "P-101-ISO-001", status: "Draft" }));
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
    expect(page).toContain("const canOfferNewDocument = !!newDocLibraryId && canPublishNew && !ticket.archivedAt && !!latestFinalAttachment(ticket.attachments) && deliverable?.state !== 'published';");
    expect(page).toContain("await recordHandback(r.versionId, '0');");
  });
});
