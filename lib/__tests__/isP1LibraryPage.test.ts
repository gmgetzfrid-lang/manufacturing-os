// @vitest-environment jsdom
//
// identity-and-session Round G — package IS-P1: the library page's limbs re-
// owned to it (app/(protected)/documents/[libraryId]/page.tsx).
//
//   XEDGE-5 / PHYS-13  the two /d/ copy actions build on the configured
//                      public origin (publicOrigin()), as RelatedPanel and the
//                      projects' /submit links do — never the page's host.
//   REV-19             saveMetadata routes every save that WRITES a
//                      controlled-issue status through lib/revisions.ts
//                      changeDocumentStatus (the same one checked write; then,
//                      when the database row it read says the write issued
//                      the document, the compliance clocks and
//                      DOCUMENT_ISSUED), as the bulk editor and the un-archive
//                      do — the route never trusts the page's copy of the
//                      status; a save to a status that issues nothing is
//                      unchanged.
//   DRLS-14            the deploy prerequisite of 20261149: handleBulkDelete
//                      reads each delete's { error } and row count, keeps a
//                      refused document on screen and says why in the
//                      database's own words.
//
// A page module exports nothing else, so each handler is LIFTED from the page
// source, transpiled and run with its dependencies passed in (the pattern of
// prjRoundGJ12.test.ts) — the code under test is the code the page runs. The
// metadata save drives the REAL changeDocumentStatus against the in-memory
// PostgREST (helpers/fakeSupabase), as dcRoundFStatusIssueRecord.test.ts does.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  clockErrors: [] as string[],
  refuse: null as null | { code: string; message: string },
  /** The status-issue basis read (documents select("*")) fails. */
  failBasisRead: false,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const real = makeFakeSupabase(state.db);
    return {
      ...real,
      from: (t: string) => {
        const b = real.from(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
        if (t !== "documents" || !state.failBasisRead) return b;
        const failing: Record<string, unknown> = {};
        failing.eq = () => failing;
        failing.maybeSingle = async () => ({ data: null, error: { message: "connection reset" } });
        return new Proxy(b, { get: (target, prop: string) => (prop === "select" ? (cols: string) => (cols === "*" ? failing : target.select(cols)) : target[prop]) });
      },
      rpc: async (fn: string) => ({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }),
    };
  },
}));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn(), makeLibraryStoragePath: vi.fn(), uniqueUploadName: (n: string) => n }));
vi.mock("@/lib/principal", () => ({ resolveActorPrincipal: vi.fn(async (i: { uid: string }) => ({ uid: i.uid, role: "DocCtrl", roles: ["DocCtrl"] })) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/checkoutEpisodes", () => ({ getActiveEpisode: vi.fn(async () => null), postEpisodeSystemMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/intents", () => ({ getMyEditBase: vi.fn(async () => undefined), recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/branches", () => ({ announceBranchOpened: vi.fn(async () => {}) }));
vi.mock("@/lib/postPublish", () => ({ runPostPublishSideEffects: vi.fn(async () => {}), notifyPackagesOfRetirement: vi.fn(async () => {}) }));
vi.mock("@/lib/reviewCycles", () => ({
  onDocumentIssued: vi.fn(async (i: { writeErrors?: string[] }) => { i.writeErrors?.push(...state.clockErrors); }),
}));
vi.mock("@/lib/acknowledgments", () => ({ onDocumentIssuedAck: vi.fn(async () => {}) }));
vi.mock("@/lib/retention", () => ({ recomputeRetention: vi.fn(async () => {}) }));
vi.mock("@/lib/staleCopies", () => ({ recallRetiredDocument: vi.fn(async () => {}), withdrawRetirementRecall: vi.fn(async () => 0) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })) };
});

import { supabase } from "@/lib/supabase";
import { changeDocumentStatus } from "@/lib/revisions";
import { recallRetiredDocument } from "@/lib/staleCopies";
import { isIssueTransition, isIssueRefusal, isControlledIssueStatus, isRetiredStatus } from "@/lib/issueStatus";
import { isUnguardedEntryIntoForce } from "@/lib/documentStatusOptions";
import { computeUniquenessKey } from "@/lib/uniqueness";
import { publicOrigin } from "@/lib/publicOrigin";
import { onDocumentIssued } from "@/lib/reviewCycles";
import { onDocumentIssuedAck } from "@/lib/acknowledgments";

const PAGE = "app/(protected)/documents/[libraryId]/page.tsx";
const page = readFileSync(join(process.cwd(), PAGE), "utf8");

/** The page's `const <name> = ...` handler, up to the next `const ` at the
 *  component's indent, transpiled and returned from a factory that takes the
 *  names it closes over. */
function lift<T>(name: string, deps: string[]): (d: Record<string, unknown>) => T {
  const start = page.search(new RegExp(`\\n  const ${name} = (async )?\\(`));
  expect(start, name).toBeGreaterThan(0);
  const end = page.indexOf("\n  const ", start + 10);
  const code = page.slice(start, end);
  const js = ts.transpileModule(
    `function factory({ ${deps.join(", ")} }) {${code}\nreturn ${name};\n}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
  ).outputText;
  return new Function(`${js}\nreturn factory;`)() as (d: Record<string, unknown>) => T;
}

const T = (t: string) => (state.db.tables[t] ??= []);
const ORG = "o1";
beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.clockErrors = [];
  state.refuse = null;
  state.failBasisRead = false;
  state.db.beforeUpdate!.documents = (next) => { if (state.refuse) throw state.refuse; return next; };
});

// ── XEDGE-5 / PHYS-13 ────────────────────────────────────────────────────
describe("XEDGE-5 / PHYS-13 — the library page's /d/ links are built on the configured public origin", () => {
  const saved = process.env.NEXT_PUBLIC_SITE_URL;
  afterEach(() => { if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL; else process.env.NEXT_PUBLIC_SITE_URL = saved; });

  it("Ctrl+C copies https://<configured site>/d/<number>, not the host the controller is browsing (a preview deploy)", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://docs.example-plant.com/";
    expect(window.location.origin).toBe("http://localhost:3000"); // the page's own host — what it used to copy
    const writes: string[] = [];
    const setError = vi.fn();
    const copy = lift<() => void>("copySelectionLinks", ["sortedDocs", "selectedDocIds", "publicOrigin", "navigator", "setError"])({
      sortedDocs: [{ id: "a", documentNumber: "P-101 A" }, { id: "b", title: "Unnumbered sketch" }, { id: "c", documentNumber: "P-102" }],
      selectedDocIds: new Set(["a", "b"]),
      publicOrigin,
      navigator: { clipboard: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } } },
      setError,
    });
    copy();
    expect(writes).toEqual(["https://docs.example-plant.com/d/P-101%20A\nUnnumbered sketch"]);
    expect(setError).toHaveBeenCalledWith("Copied 2 document links to the clipboard.");
  });

  it("the context menu's Copy link uses the same builder; window.location.origin no longer appears in the page", () => {
    expect(page).toContain("void navigator.clipboard?.writeText(`${publicOrigin()}/d/${encodeURIComponent(doc.documentNumber!)}`);");
    expect(page).toContain('import { publicOrigin } from "@/lib/publicOrigin";');
    expect(page).not.toMatch(/window\.location\.origin/);
  });
});

// ── DRLS-14 deploy prerequisite ──────────────────────────────────────────
describe("DRLS-14 — the bulk delete checks every delete and keeps a refused document on screen with the database's sentence", () => {
  type Answer = { data: Array<{ id: string }> | null; error: { message: string } | null };
  function harness(answers: Record<string, Answer>, docs = [
    { id: "d1", documentNumber: "P-101" }, { id: "d2", documentNumber: "P-102" }, { id: "d3", title: "Sketch" },
  ]) {
    const st = {
      documents: docs as Array<{ id: string; documentNumber?: string; title?: string }>,
      selected: new Set(docs.map((d) => d.id)),
      selectedDoc: { id: "d1" } as unknown,
      error: null as string | null,
      alerts: [] as Array<{ title: string; message: string }>,
      deletes: [] as string[],
    };
    const sb = {
      from: (table: string) => ({
        select: () => ({ in: () => ({ eq: async () => ({ data: [], error: null }) }) }),
        delete: () => ({ eq: (_c: string, id: string) => ({ select: async (cols: string) => {
          expect(table).toBe("documents"); expect(cols).toBe("id");
          st.deletes.push(id);
          return answers[id] ?? { data: [{ id }], error: null };
        } }) }),
      }),
    };
    const run = lift<() => Promise<void>>("handleBulkDelete", ["supabase", "selectedDocIds", "documents", "setError", "setDocuments", "setSelectedDocIds", "setSelectedDoc", "appConfirm", "appAlert"])({
      supabase: sb,
      selectedDocIds: st.selected,
      documents: st.documents,
      setError: (v: string | null) => { st.error = v; },
      setDocuments: (f: (p: typeof st.documents) => typeof st.documents) => { st.documents = f(st.documents); },
      setSelectedDocIds: (v: Set<string>) => { st.selected = v; },
      setSelectedDoc: (v: unknown) => { st.selectedDoc = v; },
      appConfirm: async () => true,
      appAlert: async (a: { title: string; message: string }) => { st.alerts.push(a); },
    });
    return { st, run };
  }
  const SENTENCE = "P-102 carries the record of who confirmed, acknowledged or approved it (0 distribution confirmation(s), 0 read-and-understood acknowledgment(s) or waiver(s), 1 review sign-off(s)), so it cannot be deleted. Archive it instead: archiving keeps the record.";

  it("a refusal (20261149's evidence guard) keeps that document listed and selected, and shows the sentence; the others are deleted", async () => {
    const { st, run } = harness({ d2: { data: null, error: { message: SENTENCE } } });
    await run();
    expect(st.deletes).toEqual(["d1", "d2", "d3"]); // one checked statement each
    expect(st.documents.map((d) => d.id)).toEqual(["d2"]);
    expect([...st.selected]).toEqual(["d2"]);
    expect(st.error).toContain(SENTENCE);
    expect(st.error).toMatch(/^Delete failed: 1 of 3 documents could not be deleted and is still here \(left selected\); 2 were deleted\./);
    expect(st.alerts).toHaveLength(1);
    expect(st.alerts[0].title).toBe("Some documents were not deleted");
    expect(st.alerts[0].message).toContain(`P-102: ${SENTENCE}`);
  });

  it("a delete that matched no row (RLS filtered it) is a refusal too — never shown as deleted", async () => {
    const { st, run } = harness({ d3: { data: [], error: null } });
    await run();
    expect(st.documents.map((d) => d.id)).toEqual(["d3"]);
    expect(st.error).toMatch(/Sketch: the database deleted nothing/);
  });

  it("regression — when every delete lands: all removed, selection cleared, inspector closed, nothing to say (exactly as before)", async () => {
    const { st, run } = harness({});
    await run();
    expect(st.documents).toEqual([]);
    expect(st.selected.size).toBe(0);
    expect(st.selectedDoc).toBeNull();
    expect(st.error).toBeNull();
    expect(st.alerts).toEqual([]);
  });

  it("the legal-hold refusal before the confirm is unchanged, and the single delete (DRLS-17) is untouched", () => {
    const body = page.slice(page.indexOf("  const handleBulkDelete = async () => {"), page.indexOf("  const handleBulkArchive = async () => {"));
    expect(body).toMatch(/\.in\("id", Array\.from\(selectedDocIds\)\)\.eq\("legal_hold", true\);/);
    expect(body).toContain('await supabase.from("documents").delete().eq("id", id).select("id");');
    expect(body).not.toMatch(/await supabase\.from\("documents"\)\.delete\(\)\.eq\("id", id\);/);
    expect(page).toContain('.from("documents")\n        .delete()\n        .eq("id", docId)\n        .select("id");');
  });
});

// ── REV-19: the metadata editor's limb ───────────────────────────────────
describe("REV-19 — saveMetadata routes every save that writes an issue status through changeDocumentStatus", () => {
  function seed(id: string, extra: Row = {}) {
    const d: Row = {
      id, org_id: ORG, library_id: "lib1", collection_id: null, document_number: id.toUpperCase(), title: id, rev: "2",
      status: "Draft", current_version_id: `${id}-v2`, pending_version_id: null, review_control: null, metadata: {},
      retired_issue_status: null, retired_issue_version_id: null, ...extra,
    };
    T("documents").push(d);
    if (d.current_version_id) T("document_versions").push({ id: d.current_version_id, org_id: ORG, record_id: id, revision_label: "2" });
    return d;
  }
  const asDoc = (d: Row) => ({ id: d.id, orgId: ORG, libraryId: "lib1", documentNumber: d.document_number, title: d.title, rev: d.rev, status: d.status, currentVersionId: d.current_version_id ?? undefined, metadata: d.metadata });
  const issued = () => T("audit_logs").filter((a) => a.action === "DOCUMENT_ISSUED");
  function save(d: Row, opts: { activeRole?: string | null; uid?: string | null; pageSees?: Row; cds?: typeof changeDocumentStatus } = {}) {
    const st = { error: null as string | null, alerts: [] as Array<{ title: string; message: string }> };
    const fn = lift<(next: unknown) => Promise<void>>("saveMetadata", ["selectedDoc", "uid", "userEmail", "activeRole", "activeOrgId", "library", "supabase", "changeDocumentStatus", "isIssueTransition", "isUnguardedEntryIntoForce", "isControlledIssueStatus", "isRetiredStatus", "computeUniquenessKey", "setError", "appAlert"])({
      selectedDoc: asDoc({ ...d, ...(opts.pageSees ?? {}) }), uid: opts.uid === undefined ? "ctl1" : opts.uid, userEmail: "ctl@example.com",
      activeRole: opts.activeRole === undefined ? "DocCtrl" : opts.activeRole, activeOrgId: ORG,
      library: { orgId: ORG, uniquenessKeys: ["documentNumber"] }, supabase, changeDocumentStatus: opts.cds ?? changeDocumentStatus, isIssueTransition, isUnguardedEntryIntoForce, isControlledIssueStatus, isRetiredStatus, computeUniquenessKey,
      setError: (v: string | null) => { st.error = v; },
      appAlert: async (a: { title: string; message: string }) => { st.alerts.push(a); },
    });
    return { st, fn };
  }
  const updates = () => state.db.calls.filter((c) => c.table === "documents" && c.method === "update");
  const basisReads = () => state.db.calls.filter((c) => c.table === "documents" && c.method === "select" && c.args[0] === "*");

  it("Draft → Issued: ONE checked UPDATE carrying every edited column, then both clocks and DOCUMENT_ISSUED (door metadata, the signed-in role)", async () => {
    const d = seed("d1");
    const { st, fn } = save(d);
    await fn({ metadata: { unit: "CDU" }, core: { title: "Overhead P&ID", documentNumber: "D1", status: "Issued" } });
    expect(updates()).toHaveLength(1);
    expect(Object.keys(updates()[0].args[0] as Row).sort()).toEqual(["document_number", "metadata", "status", "title", "uniqueness_key", "updated_at", "updated_by"]);
    expect(T("documents")[0]).toMatchObject({ status: "Issued", title: "Overhead P&ID", metadata: { unit: "CDU" }, updated_by: "ctl1" });
    expect(onDocumentIssued).toHaveBeenCalledTimes(1);
    expect(onDocumentIssuedAck).toHaveBeenCalledTimes(1);
    expect(issued()).toHaveLength(1);
    expect(issued()[0]).toMatchObject({ resource_id: "d1", user_id: "ctl1", user_email: "ctl@example.com", user_role: "DocCtrl" });
    expect(issued()[0].details).toMatchObject({ door: "metadata", fromStatus: "Draft", toStatus: "Issued", versionId: "d1-v2", putBack: false, complianceClocksStarted: true });
    expect(st.error).toBeNull();
    expect(st.alerts).toEqual([]);
  });

  it("DEC-91 §1: with no role known the record omits it (user_role NULL), never a placeholder", async () => {
    const d = seed("d2", { status: "In Review" });
    const { fn } = save(d, { activeRole: null });
    await fn({ metadata: {}, core: { title: "d2", documentNumber: "D2", status: "Issued" } });
    expect(issued()[0].user_role).toBeNull();
  });

  it("a refusal (the guard's issue rule) is thrown in the database's words, prefixed as before — the editor still recognises it", async () => {
    const d = seed("d3");
    state.refuse = { code: "42501", message: "D3: a revision that was not reviewed can't be made a controlled issue in this library." };
    const { fn } = save(d);
    const err = await fn({ metadata: {}, core: { title: "d3", documentNumber: "D3", status: "Issued" } }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/^Save refused — nothing was saved: D3: a revision that was not reviewed/);
    expect(isIssueRefusal(err?.message)).toBe(true);
    expect(issued()).toEqual([]);
    expect(onDocumentIssued).not.toHaveBeenCalled();
  });

  it("clocks that did not fully start: the save stands, and the page says so (do not save it again)", async () => {
    state.clockErrors = ["the review cycle row was refused"];
    const d = seed("d4");
    const { st, fn } = save(d);
    await fn({ metadata: {}, core: { title: "d4", documentNumber: "D4", status: "Issued" } });
    expect(T("documents")[0].status).toBe("Issued");
    expect(st.error).toMatch(/D4 was saved as Issued, but 1 follow-up step did not complete\. The status change stands and is not rolled back — do not save it again\. the review cycle row was refused/);
    expect(st.alerts[0]?.title).toBe("Saved — follow-up steps did not complete");
  });

  it("an issuing save with no sign-in known is refused before anything is written", async () => {
    const d = seed("d5");
    const { fn } = save(d, { uid: null });
    await expect(fn({ metadata: {}, core: { title: "d5", documentNumber: "D5", status: "Issued" } })).rejects.toThrow(/^Save refused — nothing was saved:/);
    expect(updates()).toEqual([]);
  });

  it("regression — a metadata save of an Issued document (the editor always sends the status) is ONE checked UPDATE with exactly the old columns; nothing to issue, no clock, no record, no note", async () => {
    const d = seed("d6", { status: "Issued" });
    const { st, fn } = save(d);
    await fn({ metadata: { unit: "VDU" }, core: { title: "Renamed", documentNumber: "D6", status: "Issued" } });
    expect(updates()).toHaveLength(1);
    expect(Object.keys(updates()[0].args[0] as Row).sort()).toEqual(["document_number", "metadata", "status", "title", "uniqueness_key", "updated_at", "updated_by"]);
    expect(T("documents")[0]).toMatchObject({ status: "Issued", title: "Renamed", metadata: { unit: "VDU" }, updated_by: "ctl1" });
    expect(basisReads()).toHaveLength(1); // the route reads the row: the page's copy decides nothing
    expect(issued()).toEqual([]);
    expect(onDocumentIssued).not.toHaveBeenCalled();
    expect(onDocumentIssuedAck).not.toHaveBeenCalled();
    expect(st.error).toBeNull(); // "already issued" is what this page showed — nothing to say
    expect(st.alerts).toEqual([]);
  });

  it("regression — a save to a status that issues nothing (Issued → Draft) is the bare checked write, no basis read", async () => {
    const d7 = seed("d7", { status: "Issued" });
    const { st, fn } = save(d7);
    await fn({ metadata: {}, core: { title: "d7", documentNumber: "D7", status: "Draft" } });
    expect(T("documents").find((r) => r.id === "d7")!.status).toBe("Draft");
    expect(updates()).toHaveLength(1);
    expect(basisReads()).toEqual([]);
    expect(issued()).toEqual([]);
    expect(st.error).toBeNull();
  });

  // ─── document-control P28 (PROD-17): a save to a RETIRED status ───────
  it("P28: Issued → Void goes through changeDocumentStatus — still ONE checked UPDATE with exactly the columns the bare write carried, one basis read, nothing issued, nothing said", async () => {
    const d = seed("r1", { status: "Issued" });
    const cds = vi.fn(changeDocumentStatus);
    const { st, fn } = save(d, { cds });
    await fn({ metadata: { unit: "CDU" }, core: { title: "r1", documentNumber: "R1", status: "Void" } });
    expect(cds).toHaveBeenCalledTimes(1);
    expect(cds.mock.calls[0][0]).toMatchObject({ orgId: ORG, documentId: "r1", toStatus: "Void", door: "metadata", actorUserId: "ctl1", actorEmail: "ctl@example.com", actorRole: "DocCtrl" });
    expect(updates()).toHaveLength(1);
    expect(Object.keys(updates()[0].args[0] as Row).sort()).toEqual(["document_number", "metadata", "status", "title", "uniqueness_key", "updated_at", "updated_by"]);
    expect(T("documents").find((r) => r.id === "r1")).toMatchObject({ status: "Void", updated_by: "ctl1", metadata: { unit: "CDU" } });
    expect(basisReads()).toHaveLength(1);
    expect(issued()).toEqual([]);
    expect(st.error).toBeNull();
    expect(st.alerts).toEqual([]);
  });

  it("P28: a retired save the database filters to no row keeps the bare write's sentence", async () => {
    const d = seed("r2", { status: "Issued" });
    state.db.refuseWrites.add("documents");
    const { fn } = save(d);
    await expect(fn({ metadata: {}, core: { title: "r2", documentNumber: "R2", status: "Archived" } }))
      .rejects.toThrow(/^Save refused — nothing was saved: the database updated no document \(you may no longer have edit access to it\)\.$/);
  });

  it("P28 fix pass: before the signed-in member is known a retired save is refused, nothing written — as the issue route refuses — never a retirement that tells nobody", async () => {
    const d = seed("r3", { status: "Issued" });
    const cds = vi.fn(changeDocumentStatus);
    const { fn } = save(d, { uid: null, cds });
    await expect(fn({ metadata: {}, core: { title: "r3", documentNumber: "R3", status: "Superseded" } }))
      .rejects.toThrow(/^Save refused — nothing was saved: this save writes the status Superseded, which can retire the document \(its copy holders recalled, its watchers told\), and who is saving it \(your sign-in and workspace\) is not known yet\. Try again in a moment\.$/);
    expect(cds).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
    expect(basisReads()).toEqual([]);
    expect(T("documents").find((r) => r.id === "r3")!.status).toBe("Issued");
  });

  it("P28 fix pass: a title fix on a document already Archived whose basis read fails is no retirement — the page's held status is passed, nothing is recalled; the save lands", async () => {
    const d = seed("r4", { status: "Archived" });
    const cds = vi.fn(changeDocumentStatus);
    state.db.selectErrors!.documents = (cols) => (cols === "*" ? { message: "503 basis read" } : null);
    const { st, fn } = save(d, { cds });
    await fn({ metadata: {}, core: { title: "r4 fixed", documentNumber: "R4", status: "Archived" } });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(cds.mock.calls[0][0]).toMatchObject({ toStatus: "Archived", heldStatus: "Archived" });
    expect(T("documents").find((r) => r.id === "r4")).toMatchObject({ status: "Archived", title: "r4 fixed" });
    expect(recallRetiredDocument).not.toHaveBeenCalled();
    expect(st.error).toBeNull();
  });

  it("P28 fix pass: REGRESSION — the same failed read on a save that changes the status (page holds Issued, saves Archived) still recalls (an unknown prior recalls)", async () => {
    const d = seed("r5", { status: "Issued" });
    state.db.selectErrors!.documents = (cols) => (cols === "*" ? { message: "503 basis read" } : null);
    const { fn } = save(d);
    await fn({ metadata: {}, core: { title: "r5", documentNumber: "R5", status: "Archived" } });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(recallRetiredDocument).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recallRetiredDocument).mock.calls[0][0]).toMatchObject({ documentId: "r5", newStatus: "Archived", recallCopyHolders: true });
  });

  it("review fix — the page's copy is stale: it shows Issued, another change moved the row back to Draft; a typo fix that carries Issued ISSUES it, so it is recorded with its clocks, and the person is told", async () => {
    const d = seed("d9", { status: "Draft" });
    const { st, fn } = save(d, { pageSees: { status: "Issued" } });
    await fn({ metadata: {}, core: { title: "Overhead P&ID (typo fixed)", documentNumber: "D9", status: "Issued" } });
    expect(updates()).toHaveLength(1);
    expect(T("documents")[0]).toMatchObject({ status: "Issued", title: "Overhead P&ID (typo fixed)" });
    expect(issued()).toHaveLength(1);
    expect(issued()[0].details).toMatchObject({ door: "metadata", fromStatus: "Draft", toStatus: "Issued", versionId: "d9-v2", putBack: false });
    expect(onDocumentIssued).toHaveBeenCalledTimes(1);
    expect(onDocumentIssuedAck).toHaveBeenCalledTimes(1);
    expect(st.error).toMatch(/^D9 was issued by this save: another change after this page loaded had moved it out of issue/);
    expect(st.alerts).toEqual([]);
  });

  it("review fix — the stale-copy issue whose clocks did not fully start says both: issued by this save, and the follow-up that did not complete", async () => {
    state.clockErrors = ["the review cycle row was refused"];
    const d = seed("d10", { status: "In Review" });
    const { st, fn } = save(d, { pageSees: { status: "Issued" } });
    await fn({ metadata: {}, core: { title: "d10", documentNumber: "D10", status: "Issued" } });
    expect(issued()).toHaveLength(1);
    expect(st.error).toMatch(/^D10 was issued by this save: .* D10 was saved as Issued, but 1 follow-up step did not complete\./);
    expect(st.alerts[0]?.title).toBe("Saved — follow-up steps did not complete");
  });

  it("REV-26 (P25 review fix) — the stale copy's entry INTO FORCE: the page shows Issued, another change had moved the row to IFC; the save puts it in force (recorded as entryIntoForce, the roster opened, the review clock left as it was) and the page says THAT — never 'moved it out of issue'", async () => {
    const d = seed("d14", { status: "IFC" });
    const { st, fn } = save(d, { pageSees: { status: "Issued" } });
    await fn({ metadata: {}, core: { title: "d14 (title fixed)", documentNumber: "D14", status: "Issued" } });
    expect(T("documents")[0]).toMatchObject({ status: "Issued", title: "d14 (title fixed)" });
    expect(issued()).toHaveLength(1);
    expect(issued()[0].details).toMatchObject({ door: "metadata", fromStatus: "IFC", toStatus: "Issued", versionId: "d14-v2", putBack: false, entryIntoForce: true });
    expect(onDocumentIssued).not.toHaveBeenCalled();
    expect(onDocumentIssuedAck).toHaveBeenCalledTimes(1);
    expect(st.error).toBe("D14 was put in force by this save: another change after this page loaded had moved it to a status no gate reads as in force (or given it its first revision), and this save carries its status as Issued — the entry into force is recorded on its history, the acknowledgment roster opened and the review clock left as it was.");
    expect(st.error).not.toMatch(/out of issue/);
    expect(st.alerts).toEqual([]);
  });

  it("the opposite stale copy: the page shows Draft → Issued, the row was already issued by another change — the save issues nothing and says so (unchanged)", async () => {
    const d = seed("d11", { status: "Issued" });
    const { st, fn } = save(d, { pageSees: { status: "Draft" } });
    await fn({ metadata: {}, core: { title: "d11", documentNumber: "D11", status: "Issued" } });
    expect(issued()).toEqual([]);
    expect(onDocumentIssued).not.toHaveBeenCalled();
    expect(st.error).toMatch(/^D11 was already issued when this save reached it/);
  });

  it("the row before the save cannot be read: an issuing save says what was not recorded; a save of a document the page showed issued says it cannot tell whether it issued it", async () => {
    state.failBasisRead = true;
    const a = seed("d12", { status: "Draft" });
    const ra = save(a);
    await ra.fn({ metadata: {}, core: { title: "d12", documentNumber: "D12", status: "Issued" } });
    expect(issued()).toEqual([]);
    expect(ra.st.error).toMatch(/^D12 was saved as Issued, but 1 follow-up step did not complete\..*its status before the change could not be read/);
    const b = seed("d13", { status: "Issued" });
    const rb = save(b);
    await rb.fn({ metadata: {}, core: { title: "d13", documentNumber: "D13", status: "Issued" } });
    expect(issued()).toEqual([]);
    expect(rb.st.error).toMatch(/^D13 was saved, but its state just before the save could not be read, so whether this save issued it is unknown/);
    expect(rb.st.alerts).toEqual([]);
    // REV-30 (intelligence I-12): both read-failed sentences are true before
    // and after 20261205 — the bulk editor's wording, never "no issue record
    // was written" (since 20261205 the database writes it, if it was one).
    const since = "this editor wrote no issue record (since database update 20261205 the database records the issue itself, if it was one)";
    expect(ra.st.error).toContain(since);
    expect(rb.st.error).toContain(since);
    for (const e of [ra.st.error, rb.st.error]) expect(e).not.toMatch(/no issue record was written|or issue record —/);
  });

  it("REV-30 — the read-failed branch names a refused follow-up row (recordError), on both sentences, as the bulk editor does", async () => {
    const refused = async () => ({ issued: false, putBack: false, complianceClockErrors: [], notRecordedBecause: "read_failed" as const, recordError: "new row violates row-level security policy" });
    const a = seed("d15", { status: "Draft" });
    const ra = save(a, { cds: refused as unknown as typeof changeDocumentStatus });
    await ra.fn({ metadata: {}, core: { title: "d15", documentNumber: "D15", status: "Issued" } });
    expect(ra.st.error).toMatch(/^D15 was saved as Issued, but 2 follow-up steps did not complete\./);
    expect(ra.st.error).toContain("The record that no clock was started could not be written (new row violates row-level security policy), so the document's history does not say so.");
    const b = seed("d16", { status: "Issued" });
    const rb = save(b, { cds: refused as unknown as typeof changeDocumentStatus });
    await rb.fn({ metadata: {}, core: { title: "d16", documentNumber: "D16", status: "Issued" } });
    expect(rb.st.error).toMatch(/^D16 was saved, but its state just before the save could not be read/);
    expect(rb.st.error).toContain("The record that no clock was started could not be written (new row violates row-level security policy), so the document's history does not say so.");
    // …and without a refused row, neither sentence names one
    const ok = async () => ({ issued: false, putBack: false, complianceClockErrors: [], notRecordedBecause: "read_failed" as const, recordError: null });
    const c = save(seed("d17", { status: "Issued" }), { cds: ok as unknown as typeof changeDocumentStatus });
    await c.fn({ metadata: {}, core: { title: "d17", documentNumber: "D17", status: "Issued" } });
    expect(c.st.error).not.toContain("could not be written");
  });

  it("regression — a register row with no revision (rev editable): ONE UPDATE with rev in the payload (DRLS-15); nothing to issue, nothing recorded", async () => {
    const d = seed("d8", { current_version_id: null, status: "Draft" });
    const { st, fn } = save(d);
    await fn({ metadata: {}, core: { title: "d8", documentNumber: "D8", rev: "B", status: "Issued" } });
    expect(updates()).toHaveLength(1);
    expect((updates()[0].args[0] as Row).rev).toBe("B");
    expect(issued()).toEqual([]);
    expect(st.error).toBeNull();
  });

  it("REV-26 (document-control P25): IFC -> Issued in the metadata editor is recorded as an issue — a first entry into force: the acknowledgment roster opens, the review clock is left as it was — and the page says nothing misleading (no \"issued by this save\" sentence)", async () => {
    const d = seed("d9", { status: "IFC" });
    const { st, fn } = save(d);
    await fn({ metadata: {}, core: { title: "d9", documentNumber: "D9", status: "Issued" } });
    expect(updates()).toHaveLength(1);
    expect(T("documents").find((r) => r.id === "d9")!.status).toBe("Issued");
    expect(issued()).toHaveLength(1);
    expect(issued()[0].details).toMatchObject({
      door: "metadata", fromStatus: "IFC", toStatus: "Issued", putBack: false, entryIntoForce: true,
      complianceClocksStarted: false, reviewClockReset: false, acknowledgmentRosterOpened: true,
    });
    expect(onDocumentIssued).not.toHaveBeenCalled();
    expect(onDocumentIssuedAck).toHaveBeenCalledTimes(1);
    expect(st.error).toBeNull();
  });

  it("REGRESSION (P25) — a metadata save that keeps IFC (the status untouched) records nothing and says nothing", async () => {
    const d = seed("d10", { status: "IFC" });
    const { st, fn } = save(d);
    await fn({ metadata: {}, core: { title: "renamed", documentNumber: "D10", status: "IFC" } });
    expect(updates()).toHaveLength(1);
    expect(issued()).toEqual([]);
    expect(st.error).toBeNull();
  });

  it("source: the bare write and its checks are byte-for-byte the DRLS-15 ones; the issue route is the one changeDocumentStatus call", () => {
    const body = page.slice(page.indexOf("  const saveMetadata = async ("), page.indexOf("  const saveInlineDocNumber = async ("));
    // document-control P28 (PROD-17): two calls — the issue route and the retirement route
    expect(body.match(/changeDocumentStatus\(/g)).toHaveLength(2);
    expect(body).toContain('orgId, documentId: selectedDoc.id, toStatus, door: "metadata",');
    expect(body).toContain("actorUserId: uid, actorEmail: userEmail ?? null, actorRole: activeRole ?? null,");
    expect(body).toContain("patch: payload,");
    // the route is chosen by the status WRITTEN, never by the page's copy of the status
    expect(body).toContain("if (toStatus !== undefined && isControlledIssueStatus(toStatus)) {");
    // REV-26 (document-control P25): the page's view counts a move into force out of IFC as an issue too (it picks the sentence only)
    expect(body).toContain("const pageSawIssue = toStatus !== undefined && (isIssueTransition({ fromStatus: selectedDoc.status, toStatus, hasCurrentRevision: !!selectedDoc.currentVersionId })\n      || isUnguardedEntryIntoForce({ fromStatus: selectedDoc.status, toStatus, hasCurrentRevision: !!selectedDoc.currentVersionId }));");
    expect(body.match(/pageSawIssue/g)!.length).toBeGreaterThan(1);
    expect(body).not.toMatch(/if \(toStatus !== undefined && isIssueTransition\(/);
  });
});
