// document-control Round G — P31 RETIREMENT DOOR PARITY (REV-31's remainder,
// assigned by the integrator at the P28 merge, 2026-10-21, DEC-31; ruled
// under DEC-90: fail-safe, no regression).
//
//   · lib/revisions.ts finishRetirementDuties — finishBulkArchive generalised
//     to Superseded and Void: per retired row, after the door's write, the
//     review draft voided, the live share links revoked, then the record
//     (ARCHIVE_DOC / SUPERSEDE_DOC / VOID_DOC) with the one reason, `via` and
//     `retiredFrom` — the single doors' order; a duty that did not complete
//     returned against its row.
//   · lib/auditActions.ts — VOID_DOC registered (revisions, destructive).
//   · changeDocumentStatus says when its write RETIRED the document
//     (`retired`), by the same rule its recall fires on.
//   · the library page's metadata save (saveMetadata, lifted from the page and
//     run against the in-memory PostgREST with the REAL changeDocumentStatus
//     and finishRetirementDuties): a save to Void / Superseded / Archived does
//     its single door's duties; REGRESSION per door — status-only,
//     metadata-only, mixed edits, a non-retiring status — the same one UPDATE
//     with the same columns as before, and no new duty for a save that does
//     not retire.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  emits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const real = makeFakeSupabase(state.db);
    return { ...real, rpc: async (fn: string) => ({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }) };
  },
}));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn(), makeLibraryStoragePath: vi.fn(), uniqueUploadName: (n: string) => n }));
vi.mock("@/lib/principal", () => ({ resolveActorPrincipal: vi.fn(async (i: { uid: string }) => ({ uid: i.uid, role: "DocCtrl", roles: ["DocCtrl"] })) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/checkoutEpisodes", () => ({ getActiveEpisode: vi.fn(async () => null), postEpisodeSystemMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/intents", () => ({ getMyEditBase: vi.fn(async () => undefined), recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/branches", () => ({ announceBranchOpened: vi.fn(async () => {}) }));
vi.mock("@/lib/postPublish", () => ({ runPostPublishSideEffects: vi.fn(async () => {}), notifyPackagesOfRetirement: vi.fn(async () => {}) }));
vi.mock("@/lib/reviewCycles", () => ({ onDocumentIssued: vi.fn(async () => {}) }));
vi.mock("@/lib/acknowledgments", () => ({ onDocumentIssuedAck: vi.fn(async () => {}) }));
vi.mock("@/lib/retention", () => ({ recomputeRetention: vi.fn(async () => {}) }));
vi.mock("@/lib/staleCopies", () => ({ recallRetiredDocument: vi.fn(async () => 0), withdrawRetirementRecall: vi.fn(async () => 0) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async (p: Record<string, unknown>) => { state.emits.push(p); }) }));
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })) };
});

import { supabase } from "@/lib/supabase";
import { changeDocumentStatus, finishRetirementDuties, finishBulkArchive, gateStatusEditorRetirement, isSupersessionMocRequired, SUPERSEDE_MOC_REQUIRED } from "@/lib/revisions";
import { recallRetiredDocument } from "@/lib/staleCopies";
import { auditActionDef, isDestructiveAuditAction, AUDIT_ACTIONS } from "@/lib/auditActions";
import { isIssueTransition, isControlledIssueStatus, isRetiredStatus } from "@/lib/issueStatus";
import { isUnguardedEntryIntoForce } from "@/lib/documentStatusOptions";
import { computeUniquenessKey } from "@/lib/uniqueness";

const ORG = "o1";
const ME = "ctl1";
const T = (t: string) => (state.db.tables[t] ??= []);
const audit = (action: string) => T("audit_logs").filter((r) => r.action === action);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: "lib1", collection_id: null, document_number: id.toUpperCase(), title: id, rev: "2",
    status: "Issued", current_version_id: `${id}-v2`, pending_version_id: null, review_control: null, metadata: {},
    retired_issue_status: null, retired_issue_version_id: null, uniqueness_key: `${id}-key`, legal_hold: false, ...extra,
  };
  T("documents").push(d);
  T("document_versions").push({ id: `${id}-v2`, org_id: ORG, record_id: id, revision_label: "2", superseded_at: null });
  return d;
}
/** An in-flight review draft (one open sign-off) and one live share link. */
function seedDraftAndShare(id: string) {
  docRow(id).pending_version_id = `${id}-v3`;
  T("document_versions").push({ id: `${id}-v3`, org_id: ORG, record_id: id, revision_label: "3", superseded_at: null });
  T("document_review_signoffs").push({ id: `${id}-so`, document_version_id: `${id}-v3`, status: "pending" });
  T("document_shares").push({ id: `${id}-sh`, document_id: id, org_id: ORG, revoked_at: null, expires_at: null });
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.emits = [];
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { errorSpy.mockRestore(); warnSpy.mockRestore(); });

// ─── the registry ─────────────────────────────────────────────────────────
describe("ruling 2 — Void has a registered audit action and its label", () => {
  it("VOID_DOC is registered in the revisions category beside ARCHIVE_DOC / SUPERSEDE_DOC, counted destructive, read as \"Void Doc\"", () => {
    expect(auditActionDef("VOID_DOC")).toEqual({ action: "VOID_DOC", category: "revisions", label: "Void Doc", destructive: true });
    expect(isDestructiveAuditAction("VOID_DOC")).toBe(true);
    expect(auditActionDef("ARCHIVE_DOC")!.label).toBe("Archive Doc");
    expect(auditActionDef("SUPERSEDE_DOC")!.label).toBe("Supersede Doc");
    // registered once
    expect(AUDIT_ACTIONS.filter((d) => d.action === "VOID_DOC")).toHaveLength(1);
  });
});

// ─── the duties ───────────────────────────────────────────────────────────
describe("ruling 1 — finishRetirementDuties: each retired row's draft voided, links revoked, its single door's record", () => {
  it("Superseded: the draft voided, the link revoked (SHARE_LINK_REVOKED), and a SUPERSEDE_DOC record with supersedeDocument's fields — the one reason, no replacement, no MOC — plus via and retiredFrom; nothing sent", async () => {
    seedDoc("s1", { status: "Superseded" }); seedDraftAndShare("s1");
    const out = await finishRetirementDuties({
      orgId: ORG, actorUserId: ME, actorEmail: "cara@x", actorRole: "DocCtrl", toStatus: "Superseded", reason: "  Replaced by the 2027 set ", via: "bulk_edit",
      docs: [{ documentId: "s1", label: "S1", versionId: "s1-v2", retiredFrom: "Issued" }],
    });
    expect(out).toEqual({ problems: [] });
    expect(docRow("s1").pending_version_id).toBeNull();
    expect(T("document_review_signoffs")[0].status).toBe("void");
    expect(T("document_versions").find((v) => v.id === "s1-v3")!.superseded_at).toBeTruthy();
    expect(T("document_shares")[0]).toMatchObject({ revoked_by: ME });
    expect(audit("SHARE_LINK_REVOKED").map((r) => r.details)).toEqual([expect.objectContaining({ shareId: "s1-sh", via: "retirement" })]);
    expect(audit("SUPERSEDE_DOC")).toHaveLength(1);
    expect(audit("SUPERSEDE_DOC")[0]).toMatchObject({ resource_id: "s1", resource_type: "document", org_id: ORG, user_id: ME, user_email: "cara@x", user_role: "DocCtrl" });
    expect(audit("SUPERSEDE_DOC")[0].details).toEqual({
      reason: "Replaced by the 2027 set", mocReference: null, replacementDocNumbers: [], resolvedReplacementIds: [], unresolvedDocNumbers: [],
      via: "bulk_edit", retiredFrom: "Issued",
      pendingDraftVoided: "s1-v3", pendingDraftVoidProblem: null,
      revokedShareLinks: 1, shareRevokeError: null, liveShareLinksLeft: 0, shareRevokeAuditError: null,
      versionId: "s1-v2",
    });
    expect(audit("ARCHIVE_DOC")).toEqual([]);
    expect(state.emits).toEqual([]);
    expect(recallRetiredDocument).not.toHaveBeenCalled();
  });

  it("Void: the same duties and a VOID_DOC record (logRevisionEvent's shape) with the reason, action void, via, retiredFrom", async () => {
    seedDoc("v1", { status: "Void" }); seedDraftAndShare("v1");
    const out = await finishRetirementDuties({
      orgId: ORG, actorUserId: ME, actorEmail: "cara@x", actorRole: "DocCtrl", toStatus: "Void", reason: "Issued in error", via: "metadata",
      docs: [{ documentId: "v1", label: "V1", versionId: "v1-v2", retiredFrom: "Issued" }],
    });
    expect(out).toEqual({ problems: [] });
    expect(docRow("v1").pending_version_id).toBeNull();
    expect(T("document_shares")[0].revoked_at).toBeTruthy();
    expect(audit("VOID_DOC")).toHaveLength(1);
    expect(audit("VOID_DOC")[0]).toMatchObject({ resource_id: "v1", resource_type: "document", user_email: "cara@x", user_role: "DocCtrl" });
    expect(audit("VOID_DOC")[0].details).toEqual({
      reason: "Issued in error", action: "void", via: "metadata", retiredFrom: "Issued",
      pendingDraftVoided: "v1-v3", pendingDraftVoidProblem: null,
      revokedShareLinks: 1, shareRevokeError: null, liveShareLinksLeft: 0, shareRevokeAuditError: null,
      versionId: "v1-v2",
    });
  });

  it("the order is the single door's: the draft void (sign-offs, then the pointer), then the link revocation, then the record", async () => {
    seedDoc("o1d", { status: "Void" }); seedDraftAndShare("o1d");
    await finishRetirementDuties({ orgId: ORG, actorUserId: ME, toStatus: "Void", reason: "x", via: "metadata", docs: [{ documentId: "o1d", label: "O", retiredFrom: "Issued" }] });
    const at = (table: string, method: string) => state.db.calls.findIndex((c) => c.table === table && c.method === method);
    const signoffVoid = at("document_review_signoffs", "update");
    const pointer = state.db.calls.findIndex((c) => c.table === "documents" && c.method === "update" && "pending_version_id" in (c.args[0] as Row));
    const revoke = at("document_shares", "update");
    const record = state.db.calls.findIndex((c) => c.table === "audit_logs" && c.method === "insert" && (c.args[0] as Row).action === "VOID_DOC");
    expect(signoffVoid).toBeGreaterThanOrEqual(0);
    expect(signoffVoid).toBeLessThan(pointer);
    expect(pointer).toBeLessThan(revoke);
    expect(revoke).toBeLessThan(record);
  });

  it("an unreadable prior is on the record (retiredFrom null, priorStatusUnknown); a caller that gives no prior writes the record as before (finishBulkArchive's ARCHIVE_DOC byte for byte)", async () => {
    seedDoc("u1", { status: "Archived" });
    seedDoc("u2", { status: "Archived" });
    await finishRetirementDuties({ orgId: ORG, actorUserId: ME, toStatus: "Archived", reason: "r", via: "bulk_edit", docs: [{ documentId: "u1", label: "U1", retiredFrom: null, priorStatusUnknown: true }] });
    expect(audit("ARCHIVE_DOC")[0].details).toMatchObject({ reason: "r", action: "archive", via: "bulk_edit", retiredFrom: null, priorStatusUnknown: true });
    await finishBulkArchive({ orgId: ORG, actorUserId: ME, reason: "r", via: "bulk_archive", docs: [{ documentId: "u2", label: "U2" }] });
    const rec = audit("ARCHIVE_DOC").find((r) => r.resource_id === "u2")!;
    expect(Object.keys(rec.details as Row).sort()).toEqual([
      "action", "liveShareLinksLeft", "pendingDraftVoidProblem", "pendingDraftVoided", "reason", "revokedShareLinks",
      "shareRevokeAuditError", "shareRevokeError", "versionId", "via",
    ]);
  });

  it("a duty that does not complete is returned against its row — named, never silent; the other rows complete; one apply, one reason", async () => {
    seedDoc("e1", { status: "Void" }); seedDraftAndShare("e1");
    seedDoc("e2", { status: "Void" });
    seedDoc("e3", { status: "Void" });
    state.db.beforeUpdate!.document_shares = () => { throw { code: "42501", message: "permission denied for table document_shares" }; };
    state.db.beforeInsert!.audit_logs = (row) => {
      if (row.action === "VOID_DOC" && row.resource_id === "e2") throw { code: "42501", message: "audit insert refused" };
      return row;
    };
    const out = await finishRetirementDuties({
      orgId: ORG, actorUserId: ME, toStatus: "Void", reason: "one reason", via: "metadata",
      docs: ["e1", "e2", "e3"].map((id) => ({ documentId: id, label: id.toUpperCase(), retiredFrom: "Issued" })),
    });
    expect(out.problems.map((p) => p.label)).toEqual(["E1", "E2"]);
    expect(out.problems[0].problems).toEqual([
      "its share links could not be revoked (permission denied for table document_shares)",
      "1 share link is still live on it (another person's — Document Control must revoke it)",
    ]);
    expect(out.problems[1].problems).toEqual(["its VOID_DOC record could not be written (audit insert refused), so the void and its reason are not on its history"]);
    expect(audit("VOID_DOC").map((r) => r.resource_id).sort()).toEqual(["e1", "e3"]);
    expect(new Set(audit("VOID_DOC").map((r) => (r.details as Row).reason))).toEqual(new Set(["one reason"]));
  });

  it("a status that is not a retired one writes nothing and says so (never a silent success)", async () => {
    seedDoc("n1"); seedDraftAndShare("n1");
    const out = await finishRetirementDuties({ orgId: ORG, actorUserId: ME, toStatus: "Draft", reason: "x", via: "metadata", docs: [{ documentId: "n1", label: "N1" }] });
    expect(out.problems).toEqual([{ documentId: "n1", label: "N1", problems: ["its retirement duties stopped part-way (Draft is not a retired status)"] }]);
    expect(docRow("n1").pending_version_id).toBe("n1-v3");
    expect(T("document_shares")[0].revoked_at).toBeNull();
    expect(T("audit_logs")).toEqual([]);
  });
});

// ─── changeDocumentStatus says when it retired ─────────────────────────────
describe("changeDocumentStatus — `retired` (asked with reportRetirement), by the rule its recall fires on", () => {
  it("Issued → Void: retired from Issued; Archived → Archived (a re-save): no retirement, the outcome exactly as before; Issued → Draft: none", async () => {
    seedDoc("c1");
    seedDoc("c2", { status: "Archived" });
    seedDoc("c3");
    const a = await changeDocumentStatus({ orgId: ORG, documentId: "c1", toStatus: "Void", door: "metadata", actorUserId: ME, reportRetirement: true });
    expect(a).toEqual({ issued: false, putBack: false, complianceClockErrors: [], recordError: null, retired: { retiredFrom: "Issued", priorStatusUnknown: false } });
    const b = await changeDocumentStatus({ orgId: ORG, documentId: "c2", toStatus: "Archived", door: "metadata", actorUserId: ME, reportRetirement: true });
    expect(b).toEqual({ issued: false, putBack: false, complianceClockErrors: [], recordError: null });
    const c = await changeDocumentStatus({ orgId: ORG, documentId: "c3", toStatus: "Draft", door: "metadata", actorUserId: ME, reportRetirement: true });
    expect(c).toEqual({ issued: false, putBack: false, complianceClockErrors: [], recordError: null });
    await settle();
    expect(vi.mocked(recallRetiredDocument).mock.calls.map((x) => x[0].documentId)).toEqual(["c1"]);
  });

  it("REGRESSION: a caller that does not ask (every caller before P31) gets the outcome exactly as before", async () => {
    seedDoc("c5");
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "c5", toStatus: "Void", door: "metadata", actorUserId: ME });
    expect(out).toEqual({ issued: false, putBack: false, complianceClockErrors: [], recordError: null });
  });

  it("a prior the read cannot give (twice, heldStatus given) is a retirement, as for the recall — retiredFrom null, priorStatusUnknown", async () => {
    seedDoc("c4", { status: "Archived" });
    state.db.selectErrors!.documents = (cols) => (cols === "*" ? { message: "503" } : null);
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "c4", toStatus: "Archived", door: "metadata", actorUserId: ME, heldStatus: "Archived", reportRetirement: true });
    expect(out.retired).toEqual({ retiredFrom: null, priorStatusUnknown: true });
  });
});

// ─── the library page's metadata save ─────────────────────────────────────
const page = readFileSync(join(process.cwd(), "app/(protected)/documents/[libraryId]/page.tsx"), "utf8");
function liftSave(deps: Record<string, unknown>): (next: unknown) => Promise<void> {
  const start = page.indexOf("\n  const saveMetadata = async (");
  expect(start).toBeGreaterThan(0);
  const end = page.indexOf("\n  const ", start + 10);
  const names = Object.keys(deps);
  const js = ts.transpileModule(`function factory({ ${names.join(", ")} }) {${page.slice(start, end)}\nreturn saveMetadata;\n}`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return (new Function(`${js}\nreturn factory;`)() as (d: Record<string, unknown>) => (next: unknown) => Promise<void>)(deps);
}

describe("ruling 1 / ruling 3 — the metadata editor's save to Void / Superseded / Archived", () => {
  const asDoc = (d: Row) => ({ id: d.id, orgId: ORG, libraryId: "lib1", documentNumber: d.document_number, title: d.title, rev: d.rev, status: d.status, currentVersionId: d.current_version_id ?? undefined, metadata: d.metadata });
  function save(d: Row, opts: { pageSees?: Row; answer?: string | null } = {}) {
    const st = { error: null as string | null, alerts: [] as Array<Record<string, unknown>>, prompts: [] as Array<Record<string, unknown>> };
    const fn = liftSave({
      selectedDoc: asDoc({ ...d, ...(opts.pageSees ?? {}) }), uid: ME, userEmail: "cara@x", activeRole: "DocCtrl", activeOrgId: ORG,
      library: { orgId: ORG, uniquenessKeys: ["documentNumber"] }, supabase, changeDocumentStatus, finishRetirementDuties,
      // document-control P34 (REV-33): the retirement gate the save runs first
      gateStatusEditorRetirement, isSupersessionMocRequired, SUPERSEDE_MOC_REQUIRED,
      isIssueTransition, isUnguardedEntryIntoForce, isControlledIssueStatus, isRetiredStatus, computeUniquenessKey,
      setError: (v: string | null) => { st.error = v; },
      appAlert: async (a: Record<string, unknown>) => { st.alerts.push(a); },
      appPrompt: async (o: Record<string, unknown>) => { st.prompts.push(o); return opts.answer === undefined ? "Obsolete unit" : opts.answer; },
    });
    return { st, fn };
  }
  const statusWrites = () => state.db.calls.filter((c) => c.table === "documents" && c.method === "update" && "status" in (c.args[0] as Row));
  const BARE_COLUMNS = ["document_number", "metadata", "status", "title", "uniqueness_key", "updated_at", "updated_by"];

  for (const [to, action, verb] of [["Void", "VOID_DOC", "voiding"], ["Superseded", "SUPERSEDE_DOC", "superseding"], ["Archived", "ARCHIVE_DOC", "archiving"]] as const) {
    it(`status-only Issued → ${to}: ONE reason asked; the SAME one UPDATE with the same columns as before; then the draft voided, the link revoked and the ${action} record (reason, via metadata, retiredFrom Issued) — after the write; nothing more said`, async () => {
      const d = seedDoc(`m-${to}`); seedDraftAndShare(`m-${to}`);
      const { st, fn } = save(d);
      await fn({ metadata: {}, core: { title: d.title, documentNumber: d.document_number, status: to } });
      await settle();
      expect(st.prompts).toHaveLength(1);
      expect(st.prompts[0]).toMatchObject({ title: `Set ${String(d.document_number)} to ${to}?`, placeholder: `Reason for ${verb}`, required: true });
      // REGRESSION: the one status write, the same columns (no supersession column added) —
      // document-control P34 (REV-34 (b)): a save to Archived carries the archive columns in that write
      expect(statusWrites()).toHaveLength(1);
      expect(Object.keys(statusWrites()[0].args[0] as Row).sort()).toEqual(to === "Archived" ? [...BARE_COLUMNS, "archive_reason", "archived_at", "archived_by"].sort() : BARE_COLUMNS);
      if (to === "Archived") expect(docRow(`m-${to}`)).toMatchObject({ archive_reason: "Obsolete unit", archived_by: ME });
      expect(docRow(`m-${to}`)).toMatchObject({ status: to, updated_by: ME });
      // the duties
      expect(docRow(`m-${to}`).pending_version_id).toBeNull();
      expect(T("document_review_signoffs")[0].status).toBe("void");
      expect(T("document_shares")[0].revoked_at).toBeTruthy();
      expect(audit(action)).toHaveLength(1);
      expect(audit(action)[0].details).toMatchObject({ reason: "Obsolete unit", via: "metadata", retiredFrom: "Issued", pendingDraftVoided: `m-${to}-v3`, revokedShareLinks: 1, versionId: `m-${to}-v2` });
      // the order: the status write first, then the duties
      const write = state.db.calls.indexOf(statusWrites()[0]);
      expect(write).toBeLessThan(state.db.calls.findIndex((c) => c.table === "document_review_signoffs" && c.method === "update"));
      // the recall is changeDocumentStatus's own, once
      expect(vi.mocked(recallRetiredDocument).mock.calls.map((x) => [x[0].documentId, x[0].newStatus])).toEqual([[`m-${to}`, to]]);
      expect(st.error).toBeNull();
      expect(st.alerts).toEqual([]);
    });
  }

  it("P31 fix pass — the reason prompt promises a recall only for an issued document: a Draft voided gets the same duties and record, its watchers told, its copy holders NOT recalled", async () => {
    const d = seedDoc("dv", { status: "Draft" }); seedDraftAndShare("dv");
    const { st, fn } = save(d);
    await fn({ metadata: {}, core: { title: d.title, documentNumber: d.document_number, status: "Void" } });
    await settle();
    expect(st.prompts).toHaveLength(1);
    const message = String(st.prompts[0].message);
    expect(message).toMatch(/its copy holders are recalled if it was issued, and its watchers told/);
    expect(message).not.toMatch(/its copy holders are recalled and its watchers told/);
    expect(docRow("dv")).toMatchObject({ status: "Void", pending_version_id: null });
    expect(audit("VOID_DOC")).toHaveLength(1);
    expect(audit("VOID_DOC")[0].details).toMatchObject({ retiredFrom: "Draft", via: "metadata" });
    const recalls = vi.mocked(recallRetiredDocument).mock.calls.map((x) => x[0]);
    expect(recalls).toHaveLength(1);
    expect(recalls[0]).toMatchObject({ documentId: "dv", newStatus: "Void", recallCopyHolders: false });
  });

  it("mixed edits (title, metadata and Issued → Void): the same one UPDATE carrying every edited column, then the duties", async () => {
    const d = seedDoc("mx"); seedDraftAndShare("mx");
    const { fn } = save(d);
    await fn({ metadata: { unit: "CDU" }, core: { title: "Renamed", documentNumber: "MX-1", status: "Void" } });
    expect(statusWrites()).toHaveLength(1);
    expect(Object.keys(statusWrites()[0].args[0] as Row).sort()).toEqual(BARE_COLUMNS);
    expect(docRow("mx")).toMatchObject({ status: "Void", title: "Renamed", document_number: "MX-1", metadata: { unit: "CDU" } });
    expect(audit("VOID_DOC")).toHaveLength(1);
    expect(docRow("mx").pending_version_id).toBeNull();
  });

  it("REGRESSION — metadata-only on a document already Archived (the editor sends the status it shows): no prompt, the same one UPDATE, NO new duty (draft, links, record untouched)", async () => {
    const d = seedDoc("mo", { status: "Archived" }); seedDraftAndShare("mo");
    const { st, fn } = save(d);
    await fn({ metadata: { unit: "VDU" }, core: { title: "Fixed typo", documentNumber: "MO", status: "Archived" } });
    expect(st.prompts).toEqual([]);
    expect(statusWrites()).toHaveLength(1);
    expect(Object.keys(statusWrites()[0].args[0] as Row).sort()).toEqual(BARE_COLUMNS);
    expect(docRow("mo")).toMatchObject({ status: "Archived", title: "Fixed typo", metadata: { unit: "VDU" }, pending_version_id: "mo-v3" });
    expect(T("document_shares")[0].revoked_at).toBeNull();
    expect(T("document_review_signoffs")[0].status).toBe("pending");
    expect(audit("ARCHIVE_DOC")).toEqual([]);
    expect(st.error).toBeNull();
  });

  it("REGRESSION — a non-retiring status (Issued → Draft): the bare checked write as before, no prompt, no duty, no record", async () => {
    const d = seedDoc("nr"); seedDraftAndShare("nr");
    const { st, fn } = save(d);
    await fn({ metadata: {}, core: { title: "nr", documentNumber: "NR", status: "Draft" } });
    expect(st.prompts).toEqual([]);
    expect(statusWrites()).toHaveLength(1);
    expect(docRow("nr")).toMatchObject({ status: "Draft", pending_version_id: "nr-v3" });
    expect(T("document_shares")[0].revoked_at).toBeNull();
    expect(T("audit_logs").filter((r) => ["VOID_DOC", "ARCHIVE_DOC", "SUPERSEDE_DOC", "SHARE_LINK_REVOKED"].includes(String(r.action)))).toEqual([]);
  });

  it("Cancel saves nothing; a blank reason is refused, nothing saved", async () => {
    const d = seedDoc("cx");
    const a = save(d, { answer: null });
    await expect(a.fn({ metadata: {}, core: { title: "cx", documentNumber: "CX", status: "Void" } })).rejects.toThrow(/^Save cancelled — nothing was saved: setting the status to Void retires the document and takes a reason\.$/);
    const b = save(d, { answer: "   " });
    await expect(b.fn({ metadata: {}, core: { title: "cx", documentNumber: "CX", status: "Void" } })).rejects.toThrow(/^Save refused — nothing was saved: setting the status to Void retires the document and takes a reason\.$/);
    expect(statusWrites()).toEqual([]);
    expect(docRow("cx").status).toBe("Issued");
    expect(T("audit_logs")).toEqual([]);
  });

  it("the stale page (it shows Archived; another session put the row back to Issued): no prompt, the save retires it — so the duties run, the record carrying the sentence naming this door", async () => {
    const d = seedDoc("st"); seedDraftAndShare("st");
    const { st, fn } = save(d, { pageSees: { status: "Archived" } });
    await fn({ metadata: {}, core: { title: "st typo", documentNumber: "ST", status: "Archived" } });
    expect(st.prompts).toEqual([]);
    expect(docRow("st")).toMatchObject({ status: "Archived", pending_version_id: null });
    expect(audit("ARCHIVE_DOC")[0].details).toMatchObject({
      reason: "No reason given: the metadata editor saved this document as Archived without asking one (this page showed it as already Archived).",
      via: "metadata", retiredFrom: "Issued",
    });
    // document-control P34 (REV-34 (b)): the row read first says this save archives it — the archive columns ride in the write
    expect(docRow("st")).toMatchObject({ archived_by: ME, archive_reason: "No reason given: the metadata editor saved this document as Archived without asking one (this page showed it as already Archived)." });
  });

  it("a duty that did not complete is said (the status change stands; do not save it again), its steps named", async () => {
    const d = seedDoc("df"); seedDraftAndShare("df");
    state.db.beforeUpdate!.document_shares = () => { throw { code: "42501", message: "permission denied" }; };
    const { st, fn } = save(d);
    await fn({ metadata: {}, core: { title: "df", documentNumber: "DF", status: "Void" } });
    expect(docRow("df").status).toBe("Void");
    expect(st.error).toMatch(/^DF was saved as Void, but 2 follow-up steps did not complete\. The status change stands and is not rolled back — do not save it again\. its share links could not be revoked \(permission denied\) 1 share link is still live on it/);
    expect(st.alerts).toHaveLength(1);
    expect(st.alerts[0]).toMatchObject({ title: "Saved — follow-up steps did not complete", tone: "danger" });
    expect(audit("VOID_DOC")).toHaveLength(1);
  });

  it("a refused write (no row) does none of it: the bare write's sentence, no duty, no record", async () => {
    const d = seedDoc("rf"); seedDraftAndShare("rf");
    state.db.refuseWrites.add("documents");
    const { fn } = save(d);
    await expect(fn({ metadata: {}, core: { title: "rf", documentNumber: "RF", status: "Superseded" } }))
      .rejects.toThrow(/^Save refused — nothing was saved: the database updated no document/);
    expect(T("document_shares")[0].revoked_at).toBeNull();
    expect(T("audit_logs").filter((r) => r.action === "SUPERSEDE_DOC")).toEqual([]);
  });

  it("source: the page's metadata save asks the reason BEFORE changeDocumentStatus and runs the duties after it, only on `retired`; the bulk archive is unchanged (finishBulkArchive)", () => {
    const start = page.indexOf("const saveMetadata = async (");
    const body = page.slice(start, page.indexOf("const saveInlineDocNumber = async", start));
    const prompt = body.indexOf("await appPrompt({");
    const write = body.indexOf("retiredOutcome = await changeDocumentStatus({");
    const duties = body.indexOf("await finishRetirementDuties({");
    expect(prompt).toBeGreaterThan(0);
    expect(prompt).toBeLessThan(write);
    expect(write).toBeLessThan(duties);
    expect(body.slice(write, duties)).toContain("reportRetirement: true,");
    expect(body.slice(write, duties)).toContain("if (retiredOutcome.retired) {");
    const bulk = page.slice(page.indexOf("const handleBulkArchive = async"), page.indexOf("const handleStageSelected = "));
    expect(bulk).toContain("await finishBulkArchive({");
    expect(bulk).not.toContain("finishRetirementDuties");
  });
});
