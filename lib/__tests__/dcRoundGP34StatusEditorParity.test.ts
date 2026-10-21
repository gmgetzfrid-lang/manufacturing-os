// document-control Round G — P34 STATUS EDITOR RETIREMENT PARITY II
// (REV-32, REV-33, REV-34; assigned by the integrator at the P31 merge,
// 2026-10-21, DEC-31; ruled under DEC-90 — fail-safe, no regression).
//
//   · REV-33 — lib/revisions.ts gateStatusEditorRetirement: a status editor's
//     Superseded asks supersedeDocument's drawing-class MOC reference (the
//     same rule and sentence, assertSupersessionMoc) and applies the foreign
//     checkout lock (the reason is the override; none → refused); its Void
//     takes authorizePublish's authority / lock / hold pre-check; Archived
//     nothing. The library page's metadata save runs it before its write.
//   · REV-34 — (a)/(d) the library page's bulk archive records retiredFrom /
//     alreadyRetired; (b) the metadata save to Archived writes the archive
//     columns in its same write; (c) finishRetirementDuties closes a
//     superseded row's pending acks (checked) and sends the checkout holder's
//     notice; the SUPERSEDE_DOC record carries the MOC the gate accepted.
//   · REV-32 — the timeline, the activity feed and the admin viewer render
//     VOID_DOC as a retirement ("Voided").
//
// The in-memory PostgREST with the REAL lib/revisions.ts and lib/audit.ts;
// the page's saveMetadata and handleBulkArchive lifted from the page and run.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  emits: [] as Array<Record<string, unknown>>,
  role: "DocCtrl",
  cls: {} as Record<string, string>,
  notifyOk: true as boolean | undefined,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const real = makeFakeSupabase(state.db);
    return { ...real, rpc: async (fn: string) => ({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }) };
  },
}));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn(), makeLibraryStoragePath: vi.fn(), uniqueUploadName: (n: string) => n }));
vi.mock("@/lib/principal", () => ({ resolveActorPrincipal: vi.fn(async (i: { uid: string }) => ({ uid: i.uid, role: state.role, roles: [state.role] })) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => state.notifyOk) }));
vi.mock("@/lib/checkoutEpisodes", () => ({ getActiveEpisode: vi.fn(async () => null), postEpisodeSystemMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/intents", () => ({ getMyEditBase: vi.fn(async () => undefined), recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/branches", () => ({ announceBranchOpened: vi.fn(async () => {}) }));
vi.mock("@/lib/postPublish", () => ({ runPostPublishSideEffects: vi.fn(async () => {}), notifyPackagesOfRetirement: vi.fn(async () => {}) }));
vi.mock("@/lib/reviewCycles", () => ({ onDocumentIssued: vi.fn(async () => {}) }));
vi.mock("@/lib/acknowledgments", () => ({ onDocumentIssuedAck: vi.fn(async () => {}) }));
vi.mock("@/lib/retention", () => ({ recomputeRetention: vi.fn(async () => {}) }));
vi.mock("@/lib/staleCopies", () => ({ recallRetiredDocument: vi.fn(async () => 0), withdrawRetirementRecall: vi.fn(async () => 0) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => 0) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async (d: { id?: string | null }) => state.cls[String(d.id)] ?? null) }));
vi.mock("@/lib/ownership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ownership")>()),
  isEffectiveOwnerOfDocument: vi.fn(async () => false),
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async (p: Record<string, unknown>) => { state.emits.push(p); }) }));
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })) };
});

import { supabase } from "@/lib/supabase";
import {
  changeDocumentStatus, finishRetirementDuties, finishBulkArchive, gateStatusEditorRetirement, isSupersessionMocRequired,
  SUPERSEDE_MOC_REQUIRED, SupersessionMocRequiredError, supersedeDocument, notifyHolderOfRetirement, recallsCopyHolders,
} from "@/lib/revisions";
import { notify } from "@/lib/inAppNotifications";
import { recallRetiredDocument } from "@/lib/staleCopies";
import { isIssueTransition, isControlledIssueStatus, isRetiredStatus } from "@/lib/issueStatus";
import { isUnguardedEntryIntoForce } from "@/lib/documentStatusOptions";
import { computeUniquenessKey } from "@/lib/uniqueness";
import { summarizeAudit } from "@/lib/timeline";
import type { DocumentRecord } from "@/types/schema";

const ORG = "o1";
const ME = "ctl1";
const OTHER = "eng9";
const T = (t: string) => (state.db.tables[t] ??= []);
const audit = (action: string) => T("audit_logs").filter((r) => r.action === action);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
const notifyCalls = () => vi.mocked(notify).mock.calls.map((c) => c[0] as unknown as Record<string, unknown>);

function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: "lib1", collection_id: null, document_number: id.toUpperCase(), title: id, rev: "2",
    status: "Issued", current_version_id: `${id}-v2`, pending_version_id: null, review_control: null, metadata: {},
    retired_issue_status: null, retired_issue_version_id: null, uniqueness_key: `${id}-key`, legal_hold: false,
    checked_out_by: null, checked_out_by_name: null, ...extra,
  };
  T("documents").push(d);
  T("document_versions").push({ id: `${id}-v2`, org_id: ORG, record_id: id, revision_label: "2", superseded_at: null });
  return d;
}
function seedDraftAndShare(id: string) {
  docRow(id).pending_version_id = `${id}-v3`;
  T("document_versions").push({ id: `${id}-v3`, org_id: ORG, record_id: id, revision_label: "3", superseded_at: null });
  T("document_review_signoffs").push({ id: `${id}-so`, document_version_id: `${id}-v3`, status: "pending" });
  T("document_shares").push({ id: `${id}-sh`, document_id: id, org_id: ORG, revoked_at: null, expires_at: null });
}
function seedAck(id: string, ackId: string, acknowledged = false) {
  T("distribution_acks").push({ id: ackId, document_id: id, version_id: `${id}-v2`, acknowledged_at: acknowledged ? "2026-10-01" : null, superseded_at: null });
}
function seedHold(id: string) {
  T("document_holds").push({ id: `${id}-h`, org_id: ORG, document_id: id, reason: "Safety review", released_at: null, opened_at: "2026-10-01" });
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.emits = [];
  state.role = "DocCtrl";
  state.cls = {};
  state.notifyOk = true;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { errorSpy.mockRestore(); warnSpy.mockRestore(); infoSpy.mockRestore(); });

const writes = () => state.db.calls.filter((c) => ["update", "insert", "delete", "upsert"].includes(c.method));
const gate = (id: string, toStatus: string, extra: Partial<Parameters<typeof gateStatusEditorRetirement>[0]> = {}) =>
  gateStatusEditorRetirement({ documentId: id, libraryId: "lib1", orgId: ORG, actorUserId: ME, actorRole: state.role, toStatus, reason: "Obsolete", ...extra });

// ─── REV-33: the gate ─────────────────────────────────────────────────────
describe("REV-33 — gateStatusEditorRetirement: supersedeDocument's pre-write gates for a status editor", () => {
  it("Superseded, drawing-class: refused without an MOC reference of three characters (the same sentence supersedeDocument says), passed with one; nothing written either way", async () => {
    seedDoc("d1"); state.cls.d1 = "drawing";
    const e = await gate("d1", "Superseded").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SupersessionMocRequiredError);
    expect(isSupersessionMocRequired(e)).toBe(true);
    expect((e as Error).message).toBe(SUPERSEDE_MOC_REQUIRED);
    expect(SUPERSEDE_MOC_REQUIRED).toBe("This is a drawing-class document — PSM requires the MOC reference to supersede it (OSHA 1910.119(l)).");
    await expect(gate("d1", "Superseded", { mocReference: " M1 " })).rejects.toThrow(SUPERSEDE_MOC_REQUIRED);
    const ok = await gate("d1", "Superseded", { mocReference: "  MOC-2026-0142 " });
    expect(ok).toEqual({ preState: { checkedOutBy: null, checkedOutByName: null, activeHolds: [] }, mocReference: "MOC-2026-0142" });
    expect(writes()).toEqual([]);
  });

  it("REGRESSION — Superseded, non-drawing (or a class that cannot be resolved), unlocked: passes with no MOC, writing nothing", async () => {
    seedDoc("n1");
    seedDoc("n2"); state.cls.n2 = "procedure";
    expect(await gate("n1", "Superseded")).toMatchObject({ mocReference: null });
    expect(await gate("n2", "Superseded", { reason: null })).toMatchObject({ mocReference: null });
    expect(writes()).toEqual([]);
  });

  it("Superseded over another person's checkout: the reason is the override (passed, the holder returned for the notice); no reason — refused in authorizePublish's words; a lock that cannot be read refuses (fail-closed)", async () => {
    seedDoc("l1", { checked_out_by: OTHER, checked_out_by_name: "Eli" });
    expect(await gate("l1", "Superseded")).toMatchObject({ preState: { checkedOutBy: OTHER, checkedOutByName: "Eli" } });
    await expect(gate("l1", "Superseded", { reason: null })).rejects.toThrow("A reason is required to supersede a document another user has checked out.");
    // my own checkout is no foreign lock
    seedDoc("l2", { checked_out_by: ME });
    expect(await gate("l2", "Superseded", { reason: null })).toMatchObject({ preState: { checkedOutBy: ME } });
    state.db.selectErrors!.documents = (cols) => (cols === "checked_out_by, checked_out_by_name" ? { message: "503" } : null);
    await expect(gate("l2", "Superseded")).rejects.toThrow("Couldn't read whether the document is checked out (503) — nothing was superseded.");
  });

  it("REGRESSION — Superseded keeps the database's authority / hold rule: a held row is not refused by the gate (the publish guard decides, as before)", async () => {
    seedDoc("h1"); seedHold("h1");
    state.role = "Engineer";
    expect(await gate("h1", "Superseded")).toMatchObject({ mocReference: null });
  });

  it("Void: authorizePublish's pre-check — a controller passes; a non-publisher is refused (said as a void); an active hold refuses (said as a void, no force); another person's checkout needs the reason", async () => {
    seedDoc("v1");
    expect(await gate("v1", "Void")).toMatchObject({ preState: { checkedOutBy: null, activeHolds: [] }, mocReference: null });
    state.role = "Engineer";
    await expect(gate("v1", "Void")).rejects.toThrow(/^Voiding a document takes publish authority in this library/);
    state.role = "DocCtrl";
    seedDoc("v2"); seedHold("v2");
    await expect(gate("v2", "Void")).rejects.toThrow("This document has an active hold (Safety review). A held document is not voided — ask Document Control to resolve the hold first.");
    seedDoc("v3", { checked_out_by: OTHER, checked_out_by_name: "Eli" });
    await expect(gate("v3", "Void", { reason: null })).rejects.toThrow("A reason is required to void a document another user has checked out.");
    expect(await gate("v3", "Void")).toMatchObject({ preState: { checkedOutBy: OTHER } });
    expect(writes()).toEqual([]);
  });

  it("Archived: no gate (not ruled; the database decides the archive's refusals)", async () => {
    seedDoc("a1", { checked_out_by: OTHER }); seedHold("a1"); state.cls.a1 = "drawing";
    expect(await gate("a1", "Archived", { reason: null })).toEqual({ preState: null, mocReference: null });
  });

  it("REGRESSION — supersedeDocument itself still refuses a drawing-class supersession without the MOC, in the same words, nothing written", async () => {
    seedDoc("s1"); state.cls.s1 = "drawing";
    const doc = { id: "s1", libraryId: "lib1", documentNumber: "S1", collectionId: null } as unknown as DocumentRecord;
    await expect(supersedeDocument({ doc, replacementDocNumbers: [], libraryId: "lib1", reason: "r", orgId: ORG, actorUserId: ME, actorRole: "DocCtrl" }))
      .rejects.toThrow(SUPERSEDE_MOC_REQUIRED);
    expect(docRow("s1").status).toBe("Issued");
    expect(writes()).toEqual([]);
  });
});

// ─── REV-34 (c): the duties ────────────────────────────────────────────────
describe("REV-34 (c) / REV-33 — finishRetirementDuties: the MOC on the record, the acks closed, the holder told", () => {
  it("Superseded: SUPERSEDE_DOC carries the MOC; the pending acks are closed (acknowledged ones untouched); the holder of another person's checkout gets their notice with the reason (the existing kind)", async () => {
    seedDoc("c1", { status: "Superseded" }); seedDraftAndShare("c1");
    seedAck("c1", "ak1"); seedAck("c1", "ak2", true);
    const out = await finishRetirementDuties({
      orgId: ORG, actorUserId: ME, actorEmail: "cara@x", toStatus: "Superseded", reason: "Replaced", via: "metadata",
      docs: [{ documentId: "c1", label: "C1", retiredFrom: "Issued", mocReference: " MOC-7 ", checkoutHolder: { checkedOutBy: OTHER, checkedOutByName: "Eli" }, libraryId: "lib1" }],
    });
    expect(out).toEqual({ problems: [] });
    expect(audit("SUPERSEDE_DOC")[0].details).toMatchObject({ mocReference: "MOC-7", reason: "Replaced", retiredFrom: "Issued" });
    expect(T("distribution_acks").find((a) => a.id === "ak1")!.superseded_at).toBeTruthy();
    expect(T("distribution_acks").find((a) => a.id === "ak2")!.superseded_at).toBeNull();
    expect(notifyCalls()).toEqual([expect.objectContaining({
      userId: OTHER, kind: "revision_published_over_checkout", title: "Document superseded while you're checked out",
      body: "Superseded by cara@x: Replaced", link: "/documents/lib1?doc=c1", metadata: { action: "supersede", reason: "Replaced" },
    })]);
  });

  it("REGRESSION — no MOC given: mocReference null as before; no holder: no notice; the record's keys are P31's", async () => {
    seedDoc("c2", { status: "Superseded" });
    await finishRetirementDuties({ orgId: ORG, actorUserId: ME, toStatus: "Superseded", reason: "r", via: "bulk_edit", docs: [{ documentId: "c2", label: "C2", retiredFrom: "Issued" }] });
    expect(Object.keys(audit("SUPERSEDE_DOC")[0].details as Row).sort()).toEqual([
      "liveShareLinksLeft", "mocReference", "pendingDraftVoidProblem", "pendingDraftVoided", "reason", "replacementDocNumbers", "resolvedReplacementIds",
      "retiredFrom", "revokedShareLinks", "shareRevokeAuditError", "shareRevokeError", "unresolvedDocNumbers", "versionId", "via",
    ]);
    expect((audit("SUPERSEDE_DOC")[0].details as Row).mocReference).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("an already-Superseded row: the acks are still closed (fail-safe), but the holder is NOT told of a retirement that was not made", async () => {
    seedDoc("c3", { status: "Superseded" }); seedAck("c3", "ak3");
    await finishRetirementDuties({ orgId: ORG, actorUserId: ME, toStatus: "Superseded", reason: "r", via: "bulk_edit", docs: [{ documentId: "c3", label: "C3", alreadyRetired: true, checkoutHolder: { checkedOutBy: OTHER } }] });
    expect(T("distribution_acks")[0].superseded_at).toBeTruthy();
    expect(notify).not.toHaveBeenCalled();
    expect(audit("SUPERSEDE_DOC")[0].details).toMatchObject({ alreadyRetired: true });
  });

  it("an ack closure the database refuses is returned against its row (never silent); a database without the column (42703) has nothing to close — today's path, nothing said", async () => {
    seedDoc("c4", { status: "Superseded" }); seedAck("c4", "ak4");
    state.db.beforeUpdate!.distribution_acks = () => { throw { code: "42501", message: "permission denied for table distribution_acks" }; };
    const out = await finishRetirementDuties({ orgId: ORG, actorUserId: ME, toStatus: "Superseded", reason: "r", via: "metadata", docs: [{ documentId: "c4", label: "C4", retiredFrom: "Issued" }] });
    expect(out.problems).toEqual([{ documentId: "c4", label: "C4", problems: ["its pending acknowledgment requests could not be closed (permission denied for table distribution_acks), so they still read as open"] }]);
    state.db.beforeUpdate!.distribution_acks = () => { throw { code: "42703", message: 'column "superseded_at" does not exist' }; };
    const out2 = await finishRetirementDuties({ orgId: ORG, actorUserId: ME, toStatus: "Superseded", reason: "r", via: "metadata", docs: [{ documentId: "c4", label: "C4", retiredFrom: "Issued" }] });
    expect(out2.problems).toEqual([]);
  });

  it("a holder's notice that could not be sent is returned against the row", async () => {
    seedDoc("c5", { status: "Void" });
    state.notifyOk = false;
    const out = await finishRetirementDuties({ orgId: ORG, actorUserId: ME, toStatus: "Void", reason: "Issued in error", via: "metadata", docs: [{ documentId: "c5", label: "C5", retiredFrom: "Issued", checkoutHolder: { checkedOutBy: OTHER }, libraryId: "lib1" }] });
    expect(out.problems).toEqual([{ documentId: "c5", label: "C5", problems: ["the checkout holder's notice could not be sent"] }]);
    expect(notifyCalls()[0]).toMatchObject({ title: "Document voided while you're checked out", metadata: { action: "void", reason: "Issued in error" } });
  });

  it("REGRESSION — Archived and Void close no acks; Archived tells no holder", async () => {
    seedDoc("c6", { status: "Archived" }); seedAck("c6", "ak6");
    seedDoc("c7", { status: "Void" }); seedAck("c7", "ak7");
    await finishRetirementDuties({ orgId: ORG, actorUserId: ME, toStatus: "Archived", reason: "r", via: "bulk_edit", docs: [{ documentId: "c6", label: "C6", retiredFrom: "Issued", checkoutHolder: { checkedOutBy: OTHER } }] });
    await finishRetirementDuties({ orgId: ORG, actorUserId: ME, toStatus: "Void", reason: "r", via: "metadata", docs: [{ documentId: "c7", label: "C7", retiredFrom: "Issued" }] });
    expect(T("distribution_acks").map((a) => a.superseded_at)).toEqual([null, null]);
    expect(notify).not.toHaveBeenCalled();
    expect(state.db.calls.filter((c) => c.table === "distribution_acks")).toEqual([]);
  });

  it("REGRESSION — notifyHolderOfRetirement says nothing missed for the single doors' callers (no holder, own checkout, a sent notice)", async () => {
    const base = { documentId: "x", libraryId: "lib1", orgId: ORG, actorUserId: ME, verb: "superseded" as const, action: "supersede" as const, reason: "r" };
    expect(await notifyHolderOfRetirement({ ...base, preState: { checkedOutBy: null, checkedOutByName: null, activeHolds: [] } })).toEqual([]);
    expect(await notifyHolderOfRetirement({ ...base, preState: { checkedOutBy: ME, checkedOutByName: null, activeHolds: [] } })).toEqual([]);
    expect(await notifyHolderOfRetirement({ ...base, preState: { checkedOutBy: OTHER, checkedOutByName: null, activeHolds: [] } })).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

// ─── the library page ─────────────────────────────────────────────────────
const page = readFileSync(join(process.cwd(), "app/(protected)/documents/[libraryId]/page.tsx"), "utf8");
function lift<F>(name: string, deps: Record<string, unknown>, replace?: [string, string]): F {
  const start = page.indexOf(`\n  const ${name} = async (`);
  expect(start).toBeGreaterThan(0);
  const end = page.indexOf("\n  const ", start + 10);
  let code = page.slice(start, end);
  if (replace) code = code.replace(replace[0], replace[1]);
  const names = Object.keys(deps);
  const js = ts.transpileModule(`function factory({ ${names.join(", ")} }) {${code}\nreturn ${name};\n}`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return (new Function(`${js}\nreturn factory;`)() as (d: Record<string, unknown>) => F)(deps);
}

describe("REV-33 / REV-34 (b) / (c) — the library page's metadata save into a retired status", () => {
  const asDoc = (d: Row) => ({ id: d.id, orgId: ORG, libraryId: "lib1", collectionId: null, documentNumber: d.document_number, title: d.title, rev: d.rev, status: d.status, currentVersionId: d.current_version_id ?? undefined, metadata: d.metadata });
  function save(d: Row, opts: { pageSees?: Row; answers?: Array<string | null> } = {}) {
    const st = { error: null as string | null, alerts: [] as Array<Record<string, unknown>>, prompts: [] as Array<Record<string, unknown>> };
    const answers = [...(opts.answers ?? ["Obsolete unit", "MOC-2026-0142"])];
    const fn = lift<(next: unknown) => Promise<void>>("saveMetadata", {
      selectedDoc: asDoc({ ...d, ...(opts.pageSees ?? {}) }), uid: ME, userEmail: "cara@x", activeRole: state.role, activeOrgId: ORG,
      library: { orgId: ORG, uniquenessKeys: ["documentNumber"] }, supabase, changeDocumentStatus, finishRetirementDuties,
      gateStatusEditorRetirement, isSupersessionMocRequired, SUPERSEDE_MOC_REQUIRED,
      isIssueTransition, isUnguardedEntryIntoForce, isControlledIssueStatus, isRetiredStatus, computeUniquenessKey,
      setError: (v: string | null) => { st.error = v; },
      appAlert: async (a: Record<string, unknown>) => { st.alerts.push(a); },
      appPrompt: async (o: Record<string, unknown>) => { st.prompts.push(o); return answers.shift() ?? null; },
    });
    return { st, fn };
  }
  const statusWrites = () => state.db.calls.filter((c) => c.table === "documents" && c.method === "update" && "status" in (c.args[0] as Row));
  const BARE = ["document_number", "metadata", "status", "title", "uniqueness_key", "updated_at", "updated_by"];
  const core = (d: Row, status: string) => ({ metadata: {}, core: { title: d.title, documentNumber: d.document_number, status } });

  it("a drawing-class Issued → Superseded: the reason, then the MOC reference asked before the write; the SAME one UPDATE (no supersession column); the MOC on SUPERSEDE_DOC", async () => {
    const d = seedDoc("p1"); state.cls.p1 = "drawing"; seedDraftAndShare("p1");
    const { st, fn } = save(d);
    await fn(core(d, "Superseded"));
    await settle();
    expect(st.prompts.map((p) => p.title)).toEqual(["Set P1 to Superseded?", "MOC reference for P1"]);
    expect(st.prompts[1]).toMatchObject({ required: true, message: `${SUPERSEDE_MOC_REQUIRED} The reference is recorded on its history.` });
    expect(statusWrites()).toHaveLength(1);
    expect(Object.keys(statusWrites()[0].args[0] as Row).sort()).toEqual(BARE);
    expect(docRow("p1").status).toBe("Superseded");
    expect(audit("SUPERSEDE_DOC")[0].details).toMatchObject({ mocReference: "MOC-2026-0142", reason: "Obsolete unit", via: "metadata", retiredFrom: "Issued" });
    // the gate ran before the write
    const write = state.db.calls.indexOf(statusWrites()[0]);
    const lockRead = state.db.calls.findIndex((c) => c.table === "documents" && c.method === "select" && c.args[0] === "checked_out_by, checked_out_by_name");
    expect(lockRead).toBeGreaterThanOrEqual(0);
    expect(lockRead).toBeLessThan(write);
  });

  it("a drawing-class supersession: the MOC prompt cancelled saves nothing; a reference under three characters is refused, nothing saved", async () => {
    const d = seedDoc("p2"); state.cls.p2 = "drawing";
    const a = save(d, { answers: ["Obsolete", null] });
    await expect(a.fn(core(d, "Superseded"))).rejects.toThrow(/^Save cancelled — nothing was saved: superseding P2 takes its MOC reference\.$/);
    const b = save(d, { answers: ["Obsolete", " ab "] });
    await expect(b.fn(core(d, "Superseded"))).rejects.toThrow(`Save refused — nothing was saved: ${SUPERSEDE_MOC_REQUIRED}`);
    expect(statusWrites()).toEqual([]);
    expect(docRow("p2").status).toBe("Issued");
    expect(T("audit_logs")).toEqual([]);
  });

  it("REGRESSION — a non-drawing, unlocked Issued → Superseded: one prompt (the reason), the same one UPDATE as before, no MOC on the record", async () => {
    const d = seedDoc("p3");
    const { st, fn } = save(d);
    await fn(core(d, "Superseded"));
    expect(st.prompts).toHaveLength(1);
    expect(Object.keys(statusWrites()[0].args[0] as Row).sort()).toEqual(BARE);
    expect((audit("SUPERSEDE_DOC")[0].details as Row).mocReference).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("Superseded over another person's checkout: the reason is the recorded override — written, the holder told with the reason, the pending acks closed", async () => {
    const d = seedDoc("p4", { checked_out_by: OTHER, checked_out_by_name: "Eli" }); seedAck("p4", "ak-p4");
    const { st, fn } = save(d);
    await fn(core(d, "Superseded"));
    expect(st.error).toBeNull();
    expect(docRow("p4").status).toBe("Superseded");
    expect(notifyCalls()).toEqual([expect.objectContaining({ userId: OTHER, kind: "revision_published_over_checkout", body: "Superseded by cara@x: Obsolete unit" })]);
    expect(T("distribution_acks")[0].superseded_at).toBeTruthy();
  });

  it("Void: a held document is refused before the write, nothing saved; a non-publisher is refused; another person's checkout — the reason overrides and the holder is told \"voided\"", async () => {
    const h = seedDoc("q1"); seedHold("q1");
    await expect(save(h).fn(core(h, "Void"))).rejects.toThrow("Save refused — nothing was saved: This document has an active hold (Safety review). A held document is not voided — ask Document Control to resolve the hold first.");
    expect(docRow("q1").status).toBe("Issued");
    state.role = "Engineer";
    const n = seedDoc("q2");
    await expect(save(n).fn(core(n, "Void"))).rejects.toThrow(/^Save refused — nothing was saved: Voiding a document takes publish authority/);
    expect(docRow("q2").status).toBe("Issued");
    expect(statusWrites()).toEqual([]);
    state.role = "DocCtrl";
    const l = seedDoc("q3", { checked_out_by: OTHER });
    await save(l).fn(core(l, "Void"));
    expect(docRow("q3").status).toBe("Void");
    expect(notifyCalls()).toEqual([expect.objectContaining({ userId: OTHER, title: "Document voided while you're checked out" })]);
    expect(audit("VOID_DOC")).toHaveLength(1);
    // REGRESSION: Void closes no acks
    expect(state.db.calls.filter((c) => c.table === "distribution_acks")).toEqual([]);
  });

  it("REV-34 (b): Issued → Archived writes archived_at / archived_by / archive_reason in its same write; a metadata-only save on an Archived document leaves them as they were", async () => {
    const d = seedDoc("r1");
    await save(d).fn(core(d, "Archived"));
    expect(statusWrites()).toHaveLength(1);
    expect(Object.keys(statusWrites()[0].args[0] as Row).sort()).toEqual([...BARE, "archive_reason", "archived_at", "archived_by"].sort());
    expect(docRow("r1")).toMatchObject({ status: "Archived", archive_reason: "Obsolete unit", archived_by: ME });
    expect(docRow("r1").archived_at).toBe(docRow("r1").updated_at);
    const e = seedDoc("r2", { status: "Archived", archived_at: "2025-01-01", archived_by: "old", archive_reason: "first" });
    const { st, fn } = save(e);
    await fn({ metadata: { unit: "VDU" }, core: { title: "typo", documentNumber: "R2", status: "Archived" } });
    expect(st.prompts).toEqual([]);
    expect(Object.keys(statusWrites()[1].args[0] as Row).sort()).toEqual(BARE);
    expect(docRow("r2")).toMatchObject({ archived_at: "2025-01-01", archived_by: "old", archive_reason: "first", title: "typo" });
  });

  it("REGRESSION — a title fix on a drawing already Superseded: no prompt, no gate, the same one UPDATE", async () => {
    const d = seedDoc("r3", { status: "Superseded", checked_out_by: OTHER }); state.cls.r3 = "drawing";
    const { st, fn } = save(d);
    await fn({ metadata: {}, core: { title: "fixed", documentNumber: "R3", status: "Superseded" } });
    expect(st.prompts).toEqual([]);
    expect(Object.keys(statusWrites()[0].args[0] as Row).sort()).toEqual(BARE);
    expect(docRow("r3")).toMatchObject({ status: "Superseded", title: "fixed" });
    expect(T("audit_logs").filter((r) => r.action === "SUPERSEDE_DOC")).toEqual([]);
  });

  it("the stale page (it shows Superseded; the drawing is Issued again): the save would supersede it with no MOC — refused, nothing saved; a non-drawing one proceeds as P31 did", async () => {
    const d = seedDoc("r4"); state.cls.r4 = "drawing";
    await expect(save(d, { pageSees: { status: "Superseded" } }).fn(core(d, "Superseded")))
      .rejects.toThrow(`Save refused — nothing was saved: this page shows R4 as already Superseded, but it is Issued now (changed after this page loaded), so this save would supersede it again. ${SUPERSEDE_MOC_REQUIRED} Reload it and set the status with a reason and the MOC reference.`);
    expect(docRow("r4").status).toBe("Issued");
    const n = seedDoc("r5");
    const { st, fn } = save(n, { pageSees: { status: "Superseded" } });
    await fn(core(n, "Superseded"));
    expect(st.prompts).toEqual([]);
    expect(docRow("r5").status).toBe("Superseded");
    expect(audit("SUPERSEDE_DOC")[0].details).toMatchObject({ retiredFrom: "Issued", reason: expect.stringMatching(/^No reason given: the metadata editor saved this document as Superseded/) });
  });

  it("REGRESSION — the recall is still changeDocumentStatus's own, once", async () => {
    const d = seedDoc("r6");
    await save(d).fn(core(d, "Superseded"));
    await settle();
    expect(vi.mocked(recallRetiredDocument).mock.calls.map((x) => x[0].documentId)).toEqual(["r6"]);
  });
});

describe("REV-34 (a) / (d) — the library page's bulk archive records each row's prior, or that it was already Archived", () => {
  function run(ids: string[]) {
    const st = { alerts: [] as Array<Record<string, unknown>> };
    const batch = vi.fn(async (_i: Record<string, unknown>) => 0);
    const documents = ids.map((id) => ({ id, documentNumber: String(docRow(id).document_number), title: id, status: docRow(id).status, currentVersionId: docRow(id).current_version_id }));
    const fn = lift<() => Promise<void>>("handleBulkArchive", {
      selectedDocIds: new Set(ids), activeOrgId: ORG, library: { orgId: ORG }, uid: ME, userEmail: "dana@x", activeRole: "DocCtrl",
      supabase, documents, libraryId: "lib1", recallsCopyHolders, finishBulkArchive,
      appPrompt: async () => "Plant closed",
      appAlert: async (o: Record<string, unknown>) => { st.alerts.push(o); },
      setDocuments: () => {}, setSelectedDocIds: () => {},
      __staleCopies: async () => ({ recallRetiredBatch: batch }),
    }, ['import("@/lib/staleCopies")', "__staleCopies()"]);
    return { st, batch, fn };
  }

  it("an Issued row's ARCHIVE_DOC carries retiredFrom: Issued; an already-Archived row's duties still run (its live link revoked) and its record says alreadyRetired, no retiredFrom", async () => {
    seedDoc("b1");
    seedDoc("b2", { status: "Archived" }); seedDraftAndShare("b2");
    const { fn, batch } = run(["b1", "b2"]);
    await fn();
    await settle();
    const rec = (id: string) => audit("ARCHIVE_DOC").find((r) => r.resource_id === id)!.details as Row;
    expect(rec("b1")).toMatchObject({ retiredFrom: "Issued", via: "bulk_archive", reason: "Plant closed" });
    expect(rec("b1")).not.toHaveProperty("alreadyRetired");
    expect(rec("b2")).toMatchObject({ alreadyRetired: true, revokedShareLinks: 1, pendingDraftVoided: "b2-v3" });
    expect(rec("b2")).not.toHaveProperty("retiredFrom");
    // REGRESSION: the one batched recall, as before
    expect(batch).toHaveBeenCalledTimes(1);
    expect((batch.mock.calls[0][0] as { docs: Array<{ documentId: string; retiredFrom: string | null }> }).docs.map((x) => [x.documentId, x.retiredFrom])).toEqual([["b1", "Issued"], ["b2", "Archived"]]);
  });

  it("a prior the read could not give is unknown on the record (retiredFrom null, priorStatusUnknown), never read as already Archived", async () => {
    seedDoc("b3", { status: "Archived" });
    state.db.selectErrors!.documents = (cols) => (cols === "id, legal_hold, status" ? { message: "503" } : null);
    const { fn } = run(["b3"]);
    await fn();
    const d = audit("ARCHIVE_DOC")[0].details as Row;
    expect(d).toMatchObject({ retiredFrom: null, priorStatusUnknown: true });
    expect(d).not.toHaveProperty("alreadyRetired");
  });
});

// ─── REV-32: the renderers ────────────────────────────────────────────────
describe("REV-32 — VOID_DOC renders as a retirement beside ARCHIVE_DOC / SUPERSEDE_DOC", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("the timeline's sentence is \"Voided\"; its siblings and the default read as before", () => {
    expect(summarizeAudit({ action: "VOID_DOC", details: { reason: "Issued in error", action: "void", via: "metadata" } })).toBe("Voided");
    expect(summarizeAudit({ action: "ARCHIVE_DOC", details: {} })).toBe("Archived");
    expect(summarizeAudit({ action: "ARCHIVE_DOC", details: { action: "unarchive" } })).toBe("Restored from archive");
    expect(summarizeAudit({ action: "SUPERSEDE_DOC", details: {} })).toBe("Document superseded");
    expect(summarizeAudit({ action: "SOME_OTHER_THING", details: {} })).toBe("some other thing");
  });
  it("the timeline's icon, the activity feed's verb and bucket, and the admin viewer's chip know VOID_DOC; the siblings' entries are unchanged", () => {
    const feed = src("components/documents/TimelineFeed.tsx");
    expect(feed).toMatch(/case "VOID_DOC":\s+return \{ Icon: Ban,/);
    expect(feed).toMatch(/case "ARCHIVE_DOC":\s+return \{ Icon: Archive,/);
    expect(feed).toMatch(/case "SUPERSEDE_DOC": return \{ Icon: Stamp,/);
    const activity = src("app/(protected)/activity/page.tsx");
    expect(activity).toMatch(/VOID_DOC:\s+\{ verb: "voided", icon: Ban, tone: "rose" \}/);
    expect(activity).toMatch(/ARCHIVE_DOC:\s+\{ verb: "archived", icon: Trash2, tone: "slate" \}/);
    expect(activity).toContain('["REV_UP", "REV_BACKFILL", "SUPERSEDE_DOC", "VOID_DOC", "DOC_SPLIT", "DOC_MERGED", "DOC_RENUMBERED"].includes(r.action)) cat.revisions++;');
    const admin = src("app/(protected)/admin/audit/page.tsx");
    expect(admin).toMatch(/VOID_DOC:\s+\{ icon: Ban,\s+tone: "bg-rose-50 text-rose-700 border-rose-200" \}/);
    expect(admin).toMatch(/ARCHIVE_DOC:\s+\{ icon: ShieldOff,/);
    // the reason is shown as its siblings' are: in the admin viewer's details, for every row alike
    expect(admin).toContain("JSON.stringify(row.details, null, 2)");
  });
});
