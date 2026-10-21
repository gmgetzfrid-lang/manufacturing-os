// document-control Round G — P36 STATUS EDITOR PARITY III (REV-35, REV-36;
// assigned by the integrator at the P34 merge, 2026-10-21, DEC-31; ruled
// under DEC-90 — fail-safe, no regression).
//
//   · REV-36 (1) — lib/revisions.ts retireOverHold: the split / merge source
//     flip and the reversal's park over a hold go through retire_over_hold
//     (20261253) — recorded — and make today's direct write while it is
//     absent (PGRST202 / 42883). The doors' own runs are pinned in
//     dcRoundFLifecycle.test.ts ("REV-36 (P36)"); the database's side in
//     rls/dcP36StatusEditorHoldLeg.test.ts.
//   · REV-36 (3) — the metadata save decides "retires" (its gates) and
//     "retired" (the recall, the duties) from ONE read of the row:
//     changeDocumentStatus takes it as `prior` and makes no read of its own.
//   · REV-36 (4) — the metadata save to Archived runs authorizeArchive's
//     pre-check before the write, refusing in its words.
//   · REV-35 — a status editor's supersession tells the open packages' owners
//     (notifyPackagesOfRetirement, as supersedeDocument), and a holder told
//     personally by the duties is left out of the recall's watchers' FYI
//     (the duties' `holdersTold`, handed to the recall as a promise).
//
// The in-memory PostgREST with the REAL lib/revisions.ts and lib/audit.ts (the
// P34 harness); the page's saveMetadata lifted from the page and run.

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
  /** rpc name → its answer (default PGRST202: the function does not exist yet). */
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const real = makeFakeSupabase(state.db);
    return { ...real, rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      state.rpcCalls.push({ fn, args });
      return state.rpc[fn] ? state.rpc[fn](args) : { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
    } };
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
// P34 final fix pass: finishRetirementDuties closes a superseded row's acks through
// closeStaleAcksForDocumentChecked — the real statement, against this file's database.
vi.mock("@/lib/distributionAcks", async (importOriginal) => ({
  closeStaleAcksForDocument: vi.fn(async () => 0),
  closeStaleAcksForDocumentChecked: (await importOriginal<typeof import("@/lib/distributionAcks")>()).closeStaleAcksForDocumentChecked,
}));
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
  changeDocumentStatus, finishRetirementDuties, gateStatusEditorRetirement, isSupersessionMocRequired, authorizeArchive,
  SUPERSEDE_MOC_REQUIRED, retireOverHold, isMissingRetireOverHoldRpc,
} from "@/lib/revisions";
import { notifyPackagesOfRetirement } from "@/lib/postPublish";
import { notify } from "@/lib/inAppNotifications";
import { recallRetiredDocument } from "@/lib/staleCopies";
import { isIssueTransition, isControlledIssueStatus, isRetiredStatus } from "@/lib/issueStatus";
import { isUnguardedEntryIntoForce } from "@/lib/documentStatusOptions";
import { computeUniquenessKey } from "@/lib/uniqueness";

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
  state.rpc = {};
  state.rpcCalls = [];
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { errorSpy.mockRestore(); warnSpy.mockRestore(); infoSpy.mockRestore(); });


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

// ─── REV-36 (1) — retireOverHold, the single doors' recorded pass ─────────
describe("REV-36 (1) (P36) — lib/revisions.ts retireOverHold: the split / merge / reversal door over a hold, and today's path before the paste", () => {
  it("before 20261253 (PGRST202, or 42883): `absent` — the caller makes its own direct write, as today", async () => {
    expect(await retireOverHold({ documentId: "x", door: "split", reason: "r", at: "t" })).toEqual({ kind: "absent" });
    state.rpc.retire_over_hold = () => ({ data: null, error: { code: "42883", message: "function retire_over_hold(uuid, text, text, timestamptz, text) does not exist" } });
    expect(await retireOverHold({ documentId: "x", door: "split", reason: "r", at: "t" })).toEqual({ kind: "absent" });
    expect(isMissingRetireOverHoldRpc({ code: "PGRST202" })).toBe(true);
    expect(isMissingRetireOverHoldRpc({ code: "23514", message: "Document has an active hold" })).toBe(false);
  });

  it("after it: Document Control's recorded pass (superseded_over_hold), a bare write (superseded), no row (refused, noRow), the guard's refusal (refused, its words), an unknown answer (refused) — and the arguments are the door's own write", async () => {
    const answers: Array<{ data: unknown; error: unknown }> = [
      { data: "superseded_over_hold", error: null }, { data: "superseded", error: null }, { data: "no_match", error: null },
      { data: null, error: { code: "23514", message: "Document has an active hold; a held document can't be superseded or voided here" } }, { data: 42, error: null },
    ];
    state.rpc.retire_over_hold = () => answers.shift()!;
    expect(await retireOverHold({ documentId: "s1", door: "split", reason: "declutter", at: "2026-10-21T10:00:00Z", supersessionMoc: "MOC-1" })).toEqual({ kind: "landed", recorded: true });
    expect(state.rpcCalls[0]).toEqual({ fn: "retire_over_hold", args: { p_document_id: "s1", p_via: "split", p_reason: "declutter", p_at: "2026-10-21T10:00:00Z", p_supersession_moc: "MOC-1" } });
    expect(await retireOverHold({ documentId: "s2", door: "merge", reason: "m", at: "t" })).toEqual({ kind: "landed", recorded: false });
    expect(state.rpcCalls[1].args).toMatchObject({ p_via: "merge", p_supersession_moc: null });
    expect(await retireOverHold({ documentId: "s3", door: "reversal_park", reason: "Reverted split — x", at: "t", supersessionMoc: "IGNORED" })).toEqual({ kind: "refused", reason: "the write was refused", noRow: true });
    expect(state.rpcCalls[2].args).toMatchObject({ p_via: "reversal_park", p_supersession_moc: null });
    expect(await retireOverHold({ documentId: "s4", door: "split", reason: "r", at: "t" })).toEqual({ kind: "refused", reason: "Document has an active hold; a held document can't be superseded or voided here" });
    expect(await retireOverHold({ documentId: "s5", door: "split", reason: "r", at: "t" })).toEqual({ kind: "refused", reason: "the database answered 42" });
  });
});

// ─── REV-36 (3) — changeDocumentStatus decides from the caller's one read ─
describe("REV-36 (3) (P36) — changeDocumentStatus with the caller's read (`prior`): no read of its own; 'retires' and 'retired' from that read", () => {
  const basisReads = () => state.db.calls.filter((c) => c.table === "documents" && c.method === "select" && c.args[0] === "*");
  it("the caller read Issued: the write into Superseded retires (recall + `retired`) — and changeDocumentStatus made NO read of its own", async () => {
    seedDoc("c1");
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "c1", toStatus: "Superseded", door: "metadata", actorUserId: ME, reportRetirement: true, prior: { fromStatus: "Issued", readFailed: false } });
    await settle();
    expect(basisReads()).toEqual([]);
    expect(out.retired).toEqual({ retiredFrom: "Issued", priorStatusUnknown: false });
    expect(recallRetiredDocument).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recallRetiredDocument).mock.calls[0][0]).toMatchObject({ documentId: "c1", retiredFrom: "Issued", recallCopyHolders: true, personallyToldElsewhere: { checkoutHolder: false, packageOwners: false } });
  });

  it("THE RACE, closed: the caller read Superseded (no retirement — no gate ran), the row is something else by the write — no recall and no `retired` (no duties): the decision is the caller's one read, never a second one", async () => {
    seedDoc("c2"); // the row says Issued
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "c2", toStatus: "Superseded", door: "metadata", actorUserId: ME, reportRetirement: true, prior: { fromStatus: "Superseded", readFailed: false } });
    await settle();
    expect(out.retired).toBeUndefined();
    expect(recallRetiredDocument).not.toHaveBeenCalled();
    expect(basisReads()).toEqual([]);
  });

  it("the caller's read failed: the prior is UNKNOWN — a retirement (the recall goes to the copy holders, P28's fail-safe), `retired` with priorStatusUnknown", async () => {
    seedDoc("c3");
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "c3", toStatus: "Archived", door: "metadata", actorUserId: ME, reportRetirement: true, prior: { fromStatus: null, readFailed: true } });
    await settle();
    expect(out.retired).toEqual({ retiredFrom: null, priorStatusUnknown: true });
    expect(vi.mocked(recallRetiredDocument).mock.calls[0][0]).toMatchObject({ retiredFrom: null, recallCopyHolders: true });
  });

  it("REGRESSION: `prior` is honoured only for a write INTO a retired status — an issue status still reads the row as before (its issue record depends on it); omitted, the read is made as before", async () => {
    seedDoc("c4", { status: "Draft" });
    await changeDocumentStatus({ orgId: ORG, documentId: "c4", toStatus: "Issued", door: "metadata", actorUserId: ME, prior: { fromStatus: "Draft", readFailed: false } });
    expect(basisReads()).toHaveLength(1);
    seedDoc("c5");
    await changeDocumentStatus({ orgId: ORG, documentId: "c5", toStatus: "Void", door: "metadata", actorUserId: ME });
    expect(basisReads()).toHaveLength(2);
  });

  it("REV-35: `checkoutHolderTold` rides into the recall as personallyToldElsewhere.checkoutHolder (the duties' answer); omitted, false as before", async () => {
    seedDoc("c6");
    const told = Promise.resolve(true);
    await changeDocumentStatus({ orgId: ORG, documentId: "c6", toStatus: "Superseded", door: "metadata", actorUserId: ME, prior: { fromStatus: "Issued", readFailed: false }, checkoutHolderTold: told });
    await settle();
    const arg = vi.mocked(recallRetiredDocument).mock.calls[0][0] as { personallyToldElsewhere: { checkoutHolder: unknown; packageOwners: boolean } };
    expect(arg.personallyToldElsewhere.checkoutHolder).toBe(told);
    expect(arg.personallyToldElsewhere.packageOwners).toBe(false);
  });
});

// ─── REV-35 — finishRetirementDuties: the package owners and the holder told ─
describe("REV-35 (P36) — finishRetirementDuties: a status editor's supersession tells the open packages' owners as supersedeDocument does, and names the rows whose holder was told", () => {
  const duties = (to: string, docs: Parameters<typeof finishRetirementDuties>[0]["docs"]) =>
    finishRetirementDuties({ orgId: ORG, actorUserId: ME, actorEmail: "cara@x", toStatus: to, reason: "Replaced", via: "bulk_edit", docs });

  it("a superseded row: notifyPackagesOfRetirement — the same producer and arguments supersedeDocument uses (newStatus Superseded, the actor's email as name)", async () => {
    seedDoc("k1");
    await duties("Superseded", [{ documentId: "k1", label: "K1", retiredFrom: "Issued" }]);
    expect(notifyPackagesOfRetirement).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyPackagesOfRetirement).mock.calls[0][0]).toEqual({ orgId: ORG, documentId: "k1", docLabel: "K1", newStatus: "Superseded", actorUserId: ME, actorName: "cara@x" });
  });

  it("REGRESSION: no package notice for a row already Superseded (no retirement made), nor for an archive or a void (supersedeDocument's notice only) — every other recipient as today", async () => {
    seedDoc("k2"); seedDoc("k3"); seedDoc("k4");
    await duties("Superseded", [{ documentId: "k2", label: "K2", alreadyRetired: true }]);
    await duties("Archived", [{ documentId: "k3", label: "K3", retiredFrom: "Issued" }]);
    await duties("Void", [{ documentId: "k4", label: "K4", retiredFrom: "Issued" }]);
    expect(notifyPackagesOfRetirement).not.toHaveBeenCalled();
  });

  it("holdersTold: the row whose holder (someone else) got the notice; never a row whose notice failed, the actor's own checkout, a row with no holder — the key absent when nobody was told (results otherwise unchanged)", async () => {
    seedDoc("k5"); seedDoc("k6"); seedDoc("k7");
    const told = await duties("Superseded", [
      { documentId: "k5", label: "K5", retiredFrom: "Issued", checkoutHolder: { checkedOutBy: OTHER, checkedOutByName: "Eli" }, libraryId: "lib1" },
      { documentId: "k6", label: "K6", retiredFrom: "Issued", checkoutHolder: { checkedOutBy: ME, checkedOutByName: "me" }, libraryId: "lib1" },
      { documentId: "k7", label: "K7", retiredFrom: "Issued" },
    ]);
    expect(told.holdersTold).toEqual(["k5"]);
    state.notifyOk = false;
    seedDoc("k8");
    const missed = await duties("Superseded", [{ documentId: "k8", label: "K8", retiredFrom: "Issued", checkoutHolder: { checkedOutBy: OTHER, checkedOutByName: "Eli" }, libraryId: "lib1" }]);
    expect(missed.holdersTold).toBeUndefined();
    expect(missed.problems[0].problems).toContain("the checkout holder's notice could not be sent");
    seedDoc("k9");
    expect(Object.keys(await duties("Archived", [{ documentId: "k9", label: "K9", retiredFrom: "Issued" }])).sort()).toEqual(["problems"]);
  });

  it("the metadata save's Void tells the holder and names the row too (its recorded lock override)", async () => {
    seedDoc("k10");
    const out = await duties("Void", [{ documentId: "k10", label: "K10", retiredFrom: "Issued", checkoutHolder: { checkedOutBy: OTHER, checkedOutByName: "Eli" }, libraryId: "lib1" }]);
    expect(out.holdersTold).toEqual(["k10"]);
  });
});

// ─── the library page's metadata save ─────────────────────────────────────
describe("REV-36 (3) / (4) and REV-35 (P36) — the library page's metadata save", () => {
  const asDoc = (d: Row) => ({ id: d.id, orgId: ORG, libraryId: "lib1", collectionId: null, documentNumber: d.document_number, title: d.title, rev: d.rev, status: d.status, currentVersionId: d.current_version_id ?? undefined, metadata: d.metadata });
  function save(d: Row, opts: { pageSees?: Row; answers?: Array<string | null> } = {}) {
    const st = { error: null as string | null, alerts: [] as Array<Record<string, unknown>>, prompts: [] as Array<Record<string, unknown>> };
    const answers = [...(opts.answers ?? ["Obsolete unit", "MOC-2026-0142"])];
    const cds = vi.fn(changeDocumentStatus);
    const fn = lift<(next: unknown) => Promise<void>>("saveMetadata", {
      selectedDoc: asDoc({ ...d, ...(opts.pageSees ?? {}) }), uid: ME, userEmail: "cara@x", activeRole: state.role, activeOrgId: ORG,
      library: { orgId: ORG, uniquenessKeys: ["documentNumber"] }, supabase, changeDocumentStatus: cds, finishRetirementDuties,
      gateStatusEditorRetirement, isSupersessionMocRequired, SUPERSEDE_MOC_REQUIRED, authorizeArchive,
      isIssueTransition, isUnguardedEntryIntoForce, isControlledIssueStatus, isRetiredStatus, computeUniquenessKey,
      setError: (v: string | null) => { st.error = v; },
      appAlert: async (a: Record<string, unknown>) => { st.alerts.push(a); },
      appPrompt: async (o: Record<string, unknown>) => { st.prompts.push(o); return answers.shift() ?? null; },
    });
    return { st, fn, cds };
  }
  const statusWrites = () => state.db.calls.filter((c) => c.table === "documents" && c.method === "update" && "status" in (c.args[0] as Row));
  const statusReads = () => state.db.calls.filter((c) => c.table === "documents" && c.method === "select" && c.args[0] === "status");
  const basisReads = () => state.db.calls.filter((c) => c.table === "documents" && c.method === "select" && c.args[0] === "*");
  const core = (d: Row, status: string) => ({ metadata: {}, core: { title: d.title, documentNumber: d.document_number, status } });
  const BARE = ["document_number", "metadata", "status", "title", "uniqueness_key", "updated_at", "updated_by"];

  it("REV-36 (3): ONE read of the row decides the gates, the recall and the duties — handed to changeDocumentStatus as `prior`, which reads nothing itself; the write is the same one UPDATE as before", async () => {
    const d = seedDoc("m1");
    const { fn, cds } = save(d);
    await fn(core(d, "Superseded"));
    await settle();
    expect(statusReads()).toHaveLength(1);
    expect(basisReads()).toHaveLength(0);
    expect(cds.mock.calls[0][0]).toMatchObject({ prior: { fromStatus: "Issued", readFailed: false } });
    expect(Object.keys(statusWrites()[0].args[0] as Row).sort()).toEqual(BARE);
    expect(audit("SUPERSEDE_DOC")[0].details).toMatchObject({ retiredFrom: "Issued", via: "metadata" });
  });

  it("REV-36 (3), fail-safe: the read fails twice on a save this page sees as no retirement (it shows the drawing Superseded): the prior is unknown, so the GATES run too — the drawing's MOC is refused, nothing saved, saying the status could not be read (never claiming it changed)", async () => {
    const d = seedDoc("m2", { status: "Superseded" }); state.cls.m2 = "drawing";
    state.db.selectErrors!.documents = (cols) => (cols === "status" ? { message: "503" } : null);
    const { st, fn } = save(d);
    await expect(fn(core(d, "Superseded"))).rejects.toThrow(
      `Save refused — nothing was saved: this page shows M2 as already Superseded, but its status could not be read just before this save, so this save may supersede it again. ${SUPERSEDE_MOC_REQUIRED} Reload it and set the status with a reason and the MOC reference.`,
    );
    expect(statusReads()).toHaveLength(2);
    expect(st.prompts).toEqual([]);
    expect(statusWrites()).toEqual([]);
  });

  it("REGRESSION: a title fix on a row really in the status it shows (one read, the same status) runs no gate, no recall, no duties — exactly as before", async () => {
    const d = seedDoc("m3", { status: "Superseded" }); state.cls.m3 = "drawing";
    const { st, fn } = save(d);
    await fn({ metadata: {}, core: { title: "m3 fixed", documentNumber: "M3", status: "Superseded" } });
    await settle();
    expect(st.prompts).toEqual([]);
    expect(docRow("m3").title).toBe("m3 fixed");
    expect(recallRetiredDocument).not.toHaveBeenCalled();
    expect(audit("SUPERSEDE_DOC")).toEqual([]);
  });

  it("REV-36 (4): a save that archives runs authorizeArchive's pre-check first — someone without publish authority or ownership is refused in its own words, nothing saved", async () => {
    state.role = "Engineer";
    const d = seedDoc("a1");
    await expect(save(d).fn(core(d, "Archived"))).rejects.toThrow(
      "Save refused — nothing was saved: The document was NOT archived — archiving takes publish authority in this library (Doc Control, a granted publisher or the document's owner). Nothing was changed.",
    );
    expect(statusWrites()).toEqual([]);
    expect(docRow("a1").status).toBe("Issued");
    expect(T("audit_logs")).toEqual([]);
  });

  it("REV-36 (4): a document under legal hold is refused for Document Control too, in authorizeArchive's words, nothing saved", async () => {
    const d = seedDoc("a2", { legal_hold: true });
    await expect(save(d).fn(core(d, "Archived"))).rejects.toThrow(
      "Save refused — nothing was saved: This document is under legal hold and cannot be archived — a controller must release the legal hold first. Nothing was changed.",
    );
    expect(statusWrites()).toEqual([]);
  });

  it("REGRESSION (4): Document Control archiving an unheld document writes the same one UPDATE as before (with P34's archive columns); a title fix on a row already Archived — a legal hold on it included — runs no pre-check", async () => {
    const d = seedDoc("a3");
    await save(d).fn(core(d, "Archived"));
    expect(docRow("a3").status).toBe("Archived");
    expect(Object.keys(statusWrites()[0].args[0] as Row).sort()).toEqual([...BARE, "archive_reason", "archived_at", "archived_by"].sort());
    const h = seedDoc("a4", { status: "Archived", legal_hold: true });
    await save(h).fn({ metadata: {}, core: { title: "a4 fixed", documentNumber: "A4", status: "Archived" } });
    expect(docRow("a4").title).toBe("a4 fixed");
  });

  it("REV-35: Superseded over another person's checkout — the holder is told personally, and the recall's FYI is handed `true` (they are left out of it); the open packages' owners are told", async () => {
    const d = seedDoc("h1", { checked_out_by: OTHER, checked_out_by_name: "Eli" });
    await save(d).fn(core(d, "Superseded"));
    await settle();
    expect(notifyCalls()).toEqual([expect.objectContaining({ userId: OTHER, kind: "revision_published_over_checkout" })]);
    const arg = vi.mocked(recallRetiredDocument).mock.calls[0][0] as { personallyToldElsewhere: { checkoutHolder: PromiseLike<boolean> | boolean } };
    expect(await arg.personallyToldElsewhere.checkoutHolder).toBe(true);
    expect(notifyPackagesOfRetirement).toHaveBeenCalledTimes(1);
  });

  it("REV-35: the holder's notice could not be sent — the FYI is handed `false` (they stay in it: a second notice over none)", async () => {
    state.notifyOk = false;
    const d = seedDoc("h2", { checked_out_by: OTHER, checked_out_by_name: "Eli" });
    await save(d).fn(core(d, "Superseded"));
    await settle();
    const arg = vi.mocked(recallRetiredDocument).mock.calls[0][0] as { personallyToldElsewhere: { checkoutHolder: PromiseLike<boolean> | boolean } };
    expect(await arg.personallyToldElsewhere.checkoutHolder).toBe(false);
  });

  it("REGRESSION (REV-35): no foreign checkout — the recall is exactly as before (`checkoutHolder: false`, `packageOwners: false`)", async () => {
    const d = seedDoc("h3");
    await save(d).fn(core(d, "Superseded"));
    await settle();
    expect(vi.mocked(recallRetiredDocument).mock.calls[0][0]).toMatchObject({ personallyToldElsewhere: { checkoutHolder: false, packageOwners: false } });
  });
});
