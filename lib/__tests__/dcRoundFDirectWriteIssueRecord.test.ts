// document-control Round F wave 3 — P23 DIRECT-WRITE ISSUE RECORD: REV-19 (a),
// the app half of the double-record design (DEC-44 (P23)).
//
// Since 20261205 the database writes DOCUMENT_ISSUED for every status-change
// issue (an AFTER UPDATE trigger on documents — the ONE writer, which a direct
// PostgREST write cannot skip; the SQL is driven on PostgreSQL 16, see the
// REV-19 record, and pinned in dcRoundFDirectWriteIssueRecordMigration.test.ts).
// The app's doors:
//   - name their door on the write (the x-mos-issue-door request header —
//     withIssueDoor), so the database's record carries it;
//   - ask document_status_issue_recorded_by_database() before the write
//     (P23 fix pass: the header is sent only when it answers true — a
//     database before 20261205 is sent no custom header) and, when it
//     answers true, write no DOCUMENT_ISSUED of their own (exactly one row),
//     still start the clocks, and record the outcome on a follow-up row —
//     COMPLIANCE_CLOCKS_STARTED, or COMPLIANCE_CLOCKS_NOT_STARTED with what
//     did not start (the database's row says what is owed, never that a
//     clock started); a put-back owes nothing and writes no follow-up;
//   - the rollbacks' put-backs name their door too (p_via), so a rollback is
//     never recorded as a direct database write;
//   - before 20261205 (the function missing: PGRST202), or when the probe
//     answers false or fails, write the record exactly as before.
//
// Driven against the in-memory PostgREST (helpers/fakeSupabase) with the real
// lib/revisions.ts; the trigger is transcribed as a BEFORE UPDATE hook that
// writes the database's row from the header the write carried, so each door
// is shown to leave exactly one record.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

type Probe = "absent" | "true" | "false" | "error" | "throws";
const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  probe: "absent" as Probe,
  probeCalls: 0,
  clockErrors: [] as string[],
  failBasisRead: false,
  /** put_back_retired_issue: absent (PGRST202) or present (restores the row). */
  putBack: "absent" as "absent" | "present",
  rpcHeaders: [] as Array<{ fn: string; name: string; value: string }>,
  /** audit actions whose insert the database refuses (a follow-up row). */
  refuseActions: [] as string[],
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const real = makeFakeSupabase(state.db);
    const thenable = (fn: string, answer: () => { data: unknown; error: unknown }) => {
      const q: Record<string, unknown> = {
        setHeader: (name: string, value: string) => { state.rpcHeaders.push({ fn, name, value }); return q; },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          try { return Promise.resolve(answer()).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); }
        },
      };
      return q;
    };
    return {
      ...real,
      rpc: (fn: string, args: Record<string, unknown> = {}) => {
        if (fn === "document_status_issue_recorded_by_database") {
          state.probeCalls += 1;
          if (state.probe === "throws") throw new Error("fetch failed");
          return thenable(fn, () => state.probe === "absent"
            ? { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }
            : state.probe === "error" ? { data: null, error: { code: "08006", message: "connection reset" } }
            : { data: state.probe === "true", error: null });
        }
        if (fn === "put_back_retired_issue") {
          return thenable(fn, () => {
            if (state.putBack === "absent") return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
            const d = (state.db.tables.documents ?? []).find((r) => r.id === args.p_document_id);
            if (!d) return { data: "no_match", error: null };
            // the function's own write, as the caller (the trigger sees its header)
            const old = { ...d };
            Object.assign(d, { status: args.p_status, archived_at: null, archived_by: null, archive_reason: null });
            if (!RETIRED.includes(String(d.status))) { d.retired_issue_status = null; d.retired_issue_version_id = null; }
            emulateTrigger(d, old, state.rpcHeaders.filter((h) => h.fn === fn).at(-1)?.value ?? null);
            return { data: "restored", error: null };
          });
        }
        throw new Error(`rpc ${fn} is not mocked in this test`);
      },
      from: (t: string) => {
        if (t === "documents" && state.failBasisRead) {
          const b = real.from(t) as unknown as { select: (c: string) => unknown; update: (p: Row) => unknown };
          return {
            select: (cols: string) => {
              if (cols !== "*") return b.select(cols);
              state.failBasisRead = false;
              return { eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "08006", message: "connection reset" } }) }) };
            },
            update: (patch: Row) => b.update(patch),
          };
        }
        return real.from(t);
      },
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
vi.mock("@/lib/staleCopies", () => ({ recallRetiredDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })) };
});

import {
  changeDocumentStatus, unarchiveDocument, putBackRetiredIssue, withIssueDoor, isStatusIssueRecordedByDatabase,
  ISSUE_DOOR_HEADER,
} from "@/lib/revisions";
import { isControlledIssueStatus } from "@/lib/issueStatus";
import { isUnguardedEntryIntoForce } from "@/lib/documentStatusOptions";
import { onDocumentIssued } from "@/lib/reviewCycles";
import { onDocumentIssuedAck } from "@/lib/acknowledgments";
import { logCheckoutEvent } from "@/lib/audit";
import type { DocumentRecord } from "@/types/schema";

const ORG = "o1";
const ME = "ctl1";
const T = (t: string) => (state.db.tables[t] ??= []);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const issuedRows = (id?: string) => T("audit_logs").filter((a) => a.action === "DOCUMENT_ISSUED" && (!id || a.resource_id === id));
const followUps = (id?: string) => T("audit_logs").filter((a) => a.action === "COMPLIANCE_CLOCKS_NOT_STARTED" && (!id || a.resource_id === id));
const startedRows = (id?: string) => T("audit_logs").filter((a) => a.action === "COMPLIANCE_CLOCKS_STARTED" && (!id || a.resource_id === id));
const RETIRED = ["Superseded", "Archived", "Void"];

/** 20261205's record_document_status_issue, transcribed: one DOCUMENT_ISSUED
 *  for a status-only issue (the guard's v_issuing, the pointer unmoved), the
 *  door from the header the write carried (a rollback's door only out of a
 *  retirement, the un-archive's only out of Archived), else 'direct'; the
 *  clock fields what is owed, never started. Only while the probe says the
 *  trigger is installed. */
function emulateTrigger(next: Row, old: Row, header: string | null) {
  if (state.probe !== "true") return;
  if (!next.current_version_id || next.current_version_id !== old.current_version_id) return;
  const from = (old.status as string | null) ?? null;
  const to = (next.status as string | null) ?? null;
  const issuing = (!isControlledIssueStatus(from) && isControlledIssueStatus(to))
    || isUnguardedEntryIntoForce({ fromStatus: from, toStatus: to, hasCurrentRevision: true });
  if (!issuing) return;
  const door = header && (["metadata", "bulk"].includes(header) || (header === "unarchive" && from === "Archived")
    || (["supersede_rollback", "lifecycle_rollback", "reversal_rollback"].includes(header) && RETIRED.includes(String(from)))) ? header : "direct";
  T("audit_logs").push({
    id: `db-${++state.db.seq}`, action: "DOCUMENT_ISSUED", resource_id: next.id, resource_type: "document", org_id: next.org_id, user_id: ME,
    details: {
      door,
      ...(["supersede_rollback", "lifecycle_rollback", "reversal_rollback"].includes(door) ? { compensation: true } : {}),
      fromStatus: from, toStatus: to, complianceClocksStarted: null, recordedBy: "database",
    },
  });
}
/** The header the last documents write carried (the fake records setHeader calls). */
const lastDocumentsHeader = (): string | null => {
  const c = [...state.db.calls].reverse().find((x) => x.table === "documents" && x.method === "setHeader");
  return c ? String(c.args[1]) : null;
};

function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: "lib1", collection_id: null, document_number: id.toUpperCase(), title: id, rev: "2",
    status: "Draft", current_version_id: `${id}-v2`, pending_version_id: null, review_control: null,
    retired_issue_status: null, retired_issue_version_id: null, ...extra,
  };
  T("documents").push(d);
  return d;
}
const asRecord = (d: Row) => ({
  id: d.id, orgId: ORG, libraryId: "lib1", documentNumber: d.document_number, title: d.title, rev: d.rev,
  status: d.status, currentVersionId: d.current_version_id ?? undefined, collectionId: null,
}) as unknown as DocumentRecord;

beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.probe = "absent";
  state.probeCalls = 0;
  state.clockErrors = [];
  state.failBasisRead = false;
  state.putBack = "absent";
  state.rpcHeaders = [];
  state.refuseActions = [];
  state.db.beforeUpdate!.documents = (next, old) => {
    if (!RETIRED.includes(String(next.status))) { next.retired_issue_status = null; next.retired_issue_version_id = null; }
    // the database's record, in the write's own statement
    emulateTrigger(next, old, lastDocumentsHeader());
    return next;
  };
  state.db.beforeInsert!.audit_logs = (row) => {
    if (state.refuseActions.includes(String(row.action))) throw { code: "42501", message: "new row violates row-level security policy" };
    return row;
  };
});

describe("REV-19 (a) (P23) — withIssueDoor names the door; the probe decides who writes the record", () => {
  it("withIssueDoor sets the x-mos-issue-door header when the client can, and leaves the write unchanged otherwise", () => {
    const seen: string[] = [];
    const b = { setHeader(n: string, v: string) { seen.push(`${n}=${v}`); return b; } };
    expect(withIssueDoor(b, "bulk")).toBe(b);
    expect(seen).toEqual([`${ISSUE_DOOR_HEADER}=bulk`]);
    expect(ISSUE_DOOR_HEADER).toBe("x-mos-issue-door");
    const plain = { then: () => undefined };
    expect(withIssueDoor(plain, "metadata")).toBe(plain); // a client without setHeader: as before
    expect(withIssueDoor(b, null)).toBe(b);
    expect(seen).toHaveLength(1); // a null door adds nothing
  });

  it("the probe: true only for an explicit true; missing function, false, an error or a throw → false (the app records, as before)", async () => {
    for (const [p, want] of [["true", true], ["absent", false], ["false", false], ["error", false], ["throws", false]] as const) {
      state.probe = p;
      expect(await isStatusIssueRecordedByDatabase(), p).toBe(want);
    }
  });
});

describe("REV-19 (a) (P23) — each app door leaves exactly one DOCUMENT_ISSUED", () => {
  it("BEFORE 20261205 (the probe's function missing): changeDocumentStatus writes the record itself, exactly as before — and the write carries NO custom header (P23 fix pass)", async () => {
    seedDoc("d1");
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "d1", toStatus: "Issued", door: "metadata", actorUserId: ME, actorEmail: "ctl@example.com", actorRole: "DocCtrl", patch: { title: "Pump P&ID" } });
    expect(out).toEqual({ issued: true, putBack: false, complianceClockErrors: [], recordError: null });
    expect(lastDocumentsHeader()).toBeNull();
    expect(issuedRows("d1")).toHaveLength(1);
    expect(issuedRows("d1")[0].details).toMatchObject({ door: "metadata", fromStatus: "Draft", toStatus: "Issued", putBack: false, reviewPolicyMode: "none", complianceClocksStarted: true });
    expect(issuedRows("d1")[0].details).not.toHaveProperty("recordedBy");
    expect(state.probeCalls).toBe(1);
  });

  it("AFTER 20261205: the metadata door leaves exactly ONE record — the database's, naming the door — the app writes none, the clocks still start, and a COMPLIANCE_CLOCKS_STARTED row says they did", async () => {
    state.probe = "true";
    seedDoc("d2");
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "d2", toStatus: "Issued", door: "metadata", actorUserId: ME, actorEmail: "ctl@example.com", actorRole: "DocCtrl" });
    expect(out).toEqual({ issued: true, putBack: false, complianceClockErrors: [], recordError: null });
    expect(issuedRows("d2")).toHaveLength(1);
    expect(issuedRows("d2")[0].details).toMatchObject({ door: "metadata", recordedBy: "database", complianceClocksStarted: null });
    expect(lastDocumentsHeader()).toBe("metadata");
    expect(followUps("d2")).toHaveLength(0);
    expect(startedRows("d2")).toHaveLength(1);
    expect(startedRows("d2")[0]).toMatchObject({ user_id: ME, user_email: "ctl@example.com", user_role: "DocCtrl" });
    expect(startedRows("d2")[0].details).toEqual({ followsUp: "DOCUMENT_ISSUED", door: "metadata", versionId: "d2-v2", putBack: false, reviewClockReset: true, acknowledgmentRosterOpened: true });
    expect(state.probeCalls).toBe(1);
    expect(onDocumentIssued).toHaveBeenCalledTimes(1);
    expect(onDocumentIssuedAck).toHaveBeenCalledTimes(1);
    expect(docRow("d2").status).toBe("Issued");
  });

  it("AFTER 20261205: the bulk door, and an entry into force out of IFC — one record each, door bulk", async () => {
    state.probe = "true";
    seedDoc("d3", { status: "In Review" });
    seedDoc("d4", { status: "IFC" });
    await changeDocumentStatus({ orgId: ORG, documentId: "d3", toStatus: "Issued", door: "bulk", actorUserId: ME });
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "d4", toStatus: "Issued", door: "bulk", actorUserId: ME });
    expect(out).toMatchObject({ issued: true, putBack: false, entryIntoForce: true });
    expect(issuedRows("d3").map((r) => (r.details as Row).door)).toEqual(["bulk"]);
    expect(issuedRows("d4").map((r) => (r.details as Row).door)).toEqual(["bulk"]);
    // the entry into force's follow-up: the roster opened, the review clock NOT reset
    expect(startedRows("d4")[0].details).toEqual({ followsUp: "DOCUMENT_ISSUED", door: "bulk", versionId: "d4-v2", putBack: false, entryIntoForce: true, reviewClockReset: false, acknowledgmentRosterOpened: true });
  });

  it("AFTER 20261205: the un-archive door (put_back_retired_issue) names itself on the RPC and leaves one record — a put-back owes nothing, so no follow-up row; a rollback's put-back names ITS door, never 'direct'", async () => {
    state.probe = "true";
    state.putBack = "present";
    const d = seedDoc("d5", { status: "Archived", retired_issue_status: "Issued", retired_issue_version_id: "d5-v2" });
    const out = await unarchiveDocument({ doc: asRecord(d), reason: "back", orgId: ORG, actorUserId: ME, actorEmail: "ctl@example.com", restoreStatus: "Issued" } as never);
    expect(out).toMatchObject({ issued: true, putBack: true });
    expect(state.rpcHeaders).toEqual([{ fn: "put_back_retired_issue", name: ISSUE_DOOR_HEADER, value: "unarchive" }]);
    expect(issuedRows("d5")).toHaveLength(1);
    expect(issuedRows("d5")[0].details).toMatchObject({ door: "unarchive", recordedBy: "database" });
    expect((issuedRows("d5")[0].details as Row).compensation).toBeUndefined(); // the un-archive is a person's restore, not a compensation
    expect(followUps("d5")).toHaveLength(0);
    expect(startedRows("d5")).toHaveLength(0);
    expect(state.probeCalls).toBe(1); // asked once, before the write
    // P23 fix pass: every rollback door names itself (p_via) — its put-back
    // of a stamped issue is recorded as that rollback, not a direct write
    for (const via of ["supersede_rollback", "lifecycle_rollback", "reversal_rollback"] as const) {
      state.rpcHeaders = [];
      const id = `d6-${via}`;
      seedDoc(id, { status: "Superseded", retired_issue_status: "Issued", retired_issue_version_id: `${id}-v2` });
      const r = await putBackRetiredIssue({ documentId: id, status: "Issued", door: via, forceHold: true });
      expect(r, via).toEqual({ kind: "landed", recorded: false });
      expect(state.rpcHeaders, via).toEqual([{ fn: "put_back_retired_issue", name: ISSUE_DOOR_HEADER, value: via }]);
      expect(issuedRows(id).map((x) => (x.details as Row).door), via).toEqual([via]);
      expect((issuedRows(id)[0].details as Row).compensation, via).toBe(true); // marked, so a count of issues can leave it out
    }
  });

  it("BEFORE 20261205: no put-back sends the custom header — neither the un-archive nor a rollback (the probe answers missing)", async () => {
    state.putBack = "present";
    for (const via of ["supersede_rollback", "lifecycle_rollback", "reversal_rollback"] as const) {
      seedDoc(`p-${via}`, { status: "Superseded", retired_issue_status: "Issued", retired_issue_version_id: `p-${via}-v2` });
      await putBackRetiredIssue({ documentId: `p-${via}`, status: "Issued", door: via });
    }
    const d = seedDoc("p-un", { status: "Archived", retired_issue_status: "Issued", retired_issue_version_id: "p-un-v2" });
    await unarchiveDocument({ doc: asRecord(d), reason: "back", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" } as never);
    expect(state.rpcHeaders).toEqual([]);
    expect(issuedRows("p-un")).toHaveLength(1); // the app's own record, as before
    expect((issuedRows("p-un")[0].details as Row).recordedBy).toBeUndefined();
  });

  it("BEFORE 20261205: the un-archive's direct write (no put_back_retired_issue either) carries no custom header, and the app records the issue as before; AFTER it, that write names its door", async () => {
    const d = seedDoc("d7", { status: "Archived", retired_issue_status: "Issued", retired_issue_version_id: "d7-v2" });
    await unarchiveDocument({ doc: asRecord(d), reason: "back", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" } as never);
    expect(lastDocumentsHeader()).toBeNull();
    expect(issuedRows("d7")).toHaveLength(1);
    expect(issuedRows("d7")[0].details).toMatchObject({ door: "unarchive", putBack: true });
    expect(issuedRows("d7")[0].details).not.toHaveProperty("recordedBy");
    state.probe = "true";
    const d7b = seedDoc("d7b", { status: "Archived", retired_issue_status: "Issued", retired_issue_version_id: "d7b-v2" });
    await unarchiveDocument({ doc: asRecord(d7b), reason: "back", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" } as never);
    expect(lastDocumentsHeader()).toBe("unarchive");
    expect(issuedRows("d7b").map((r) => (r.details as Row).door)).toEqual(["unarchive"]);
  });

  it("AFTER 20261205: clocks that did not fully start are recorded on a follow-up COMPLIANCE_CLOCKS_NOT_STARTED row (no second DOCUMENT_ISSUED) and returned, as before", async () => {
    state.probe = "true";
    state.clockErrors = ["next_review_date: permission denied"];
    seedDoc("d8");
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "d8", toStatus: "Issued", door: "metadata", actorUserId: ME, actorEmail: "ctl@example.com", actorRole: "DocCtrl" });
    expect(out).toEqual({ issued: true, putBack: false, complianceClockErrors: ["next_review_date: permission denied"], recordError: null });
    expect(issuedRows("d8")).toHaveLength(1);
    expect(followUps("d8")).toHaveLength(1);
    expect(startedRows("d8")).toHaveLength(0);
    expect(followUps("d8")[0]).toMatchObject({ user_id: ME, user_email: "ctl@example.com", user_role: "DocCtrl" });
    expect(followUps("d8")[0].details).toEqual({
      followsUp: "DOCUMENT_ISSUED", door: "metadata", versionId: "d8-v2", putBack: false,
      complianceClockErrors: ["next_review_date: permission denied"],
    });
  });

  it("AFTER 20261205: a follow-up row that cannot be written is said with the clocks — the issue's record stands (recordError stays null)", async () => {
    state.probe = "true";
    state.clockErrors = ["roster: timeout"];
    state.refuseActions = ["COMPLIANCE_CLOCKS_NOT_STARTED"];
    seedDoc("d9");
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "d9", toStatus: "Issued", door: "bulk", actorUserId: ME });
    expect(out.recordError).toBeNull();
    expect(out.complianceClockErrors[0]).toBe("roster: timeout");
    expect(out.complianceClockErrors[1]).toMatch(/^the record of what did not start could not be written \(.*row-level security.*\), so it is not on the document's history$/);
    expect(issuedRows("d9")).toHaveLength(1);
  });

  it("AFTER 20261205: a COMPLIANCE_CLOCKS_STARTED row that cannot be written is said (never a silent success) — the clocks did start, and are not to be started again", async () => {
    state.probe = "true";
    state.refuseActions = ["COMPLIANCE_CLOCKS_STARTED"];
    seedDoc("d9b");
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "d9b", toStatus: "Issued", door: "bulk", actorUserId: ME });
    expect(out.recordError).toBeNull();
    expect(onDocumentIssued).toHaveBeenCalledTimes(1);
    expect(out.complianceClockErrors).toHaveLength(1);
    expect(out.complianceClockErrors[0]).toMatch(/^the clocks started, but the record that they did could not be written \(.*row-level security.*\), so the document's history reads as if they had not — do not start them again$/);
    expect(startedRows("d9b")).toHaveLength(0);
  });

  it("a probe that answers false, fails or throws: the app writes its record (two rows at worst, never none)", async () => {
    for (const p of ["false", "error", "throws"] as const) {
      state.probe = p;
      seedDoc(`e-${p}`);
      const out = await changeDocumentStatus({ orgId: ORG, documentId: `e-${p}`, toStatus: "Issued", door: "bulk", actorUserId: ME });
      expect(out.issued, p).toBe(true);
      expect(issuedRows(`e-${p}`), p).toHaveLength(1);
      expect((issuedRows(`e-${p}`)[0].details as Row).recordedBy, p).toBeUndefined();
    }
  });

  it("AFTER 20261205, the row unreadable before the write: no clock started (as before), and a follow-up row says so beside whatever the database recorded", async () => {
    state.probe = "true";
    seedDoc("d10");
    state.failBasisRead = true;
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "d10", toStatus: "Issued", door: "bulk", actorUserId: ME });
    expect(out).toEqual({ issued: false, putBack: false, complianceClockErrors: [], recordError: null, notRecordedBecause: "read_failed" });
    expect(onDocumentIssued).not.toHaveBeenCalled();
    expect(issuedRows("d10")).toHaveLength(1); // the database's — it read the row as it was
    expect(followUps("d10")).toHaveLength(1);
    expect(followUps("d10")[0].details).toMatchObject({ followsUp: "DOCUMENT_ISSUED", door: "bulk", readFailed: true });
  });

  it("AFTER 20261205, the row unreadable before the write and the follow-up row refused: the outcome says so (recordError), never a silent success", async () => {
    state.probe = "true";
    state.refuseActions = ["COMPLIANCE_CLOCKS_NOT_STARTED"];
    seedDoc("d10b");
    state.failBasisRead = true;
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "d10b", toStatus: "Issued", door: "metadata", actorUserId: ME });
    expect(out.issued).toBe(false);
    expect(out.notRecordedBecause).toBe("read_failed");
    expect(out.recordError).toMatch(/row-level security/);
    expect(followUps("d10b")).toHaveLength(0);
  });

  it("BEFORE 20261205, the row unreadable before the write: exactly as before — nothing recorded, no follow-up", async () => {
    seedDoc("d11");
    state.failBasisRead = true;
    const out = await changeDocumentStatus({ orgId: ORG, documentId: "d11", toStatus: "Issued", door: "bulk", actorUserId: ME });
    expect(out.notRecordedBecause).toBe("read_failed");
    expect(issuedRows("d11")).toHaveLength(0);
    expect(followUps("d11")).toHaveLength(0);
  });

  it("regression — a save that issues nothing writes no record (and a save to a status that is no issue asks no probe and sends no header): Issued → Draft, an Issued row kept Issued, a register row with no revision", async () => {
    for (const p of ["absent", "true"] as const) {
      state.probe = p;
      state.probeCalls = 0;
      seedDoc(`r1-${p}`, { status: "Issued" });
      seedDoc(`r2-${p}`, { status: "Issued" });
      seedDoc(`r3-${p}`, { current_version_id: null });
      expect(await changeDocumentStatus({ orgId: ORG, documentId: `r1-${p}`, toStatus: "Draft", door: "metadata", actorUserId: ME }))
        .toEqual({ issued: false, putBack: false, complianceClockErrors: [], recordError: null });
      expect(state.probeCalls, p).toBe(0);
      expect(lastDocumentsHeader(), p).toBeNull();
      expect((await changeDocumentStatus({ orgId: ORG, documentId: `r2-${p}`, toStatus: "Issued", door: "metadata", actorUserId: ME })).notRecordedBecause).toBe("already_issued");
      expect((await changeDocumentStatus({ orgId: ORG, documentId: `r3-${p}`, toStatus: "Issued", door: "metadata", actorUserId: ME })).notRecordedBecause).toBe("no_current_revision");
      expect(issuedRows().filter((r) => String(r.resource_id).endsWith(p)), p).toHaveLength(0);
      expect(followUps().filter((r) => String(r.resource_id).endsWith(p)), p).toHaveLength(0);
      expect(startedRows().filter((r) => String(r.resource_id).endsWith(p)), p).toHaveLength(0);
      // the two writes TO an issue status asked once each, before the write
      expect(state.probeCalls, p).toBe(2);
    }
    expect(onDocumentIssued).not.toHaveBeenCalled();
  });

  it("regression — the status write's payload is unchanged (the header rides beside it, not in it)", async () => {
    seedDoc("d12");
    await changeDocumentStatus({ orgId: ORG, documentId: "d12", toStatus: "Issued", door: "metadata", actorUserId: ME, patch: { title: "T" } });
    const upd = state.db.calls.find((c) => c.table === "documents" && c.method === "update")!;
    expect(Object.keys(upd.args[0] as Row).sort()).toEqual(["status", "title", "updated_at", "updated_by"]);
  });
});

describe("SESS-6 residual (P23, DEC-91 §1) — an audit role the checkout surfaces do not know is omitted", () => {
  it("logCheckoutEvent with an empty role (what the checkout surfaces now pass for no role) writes user_role NULL, never 'unknown'", async () => {
    const { error } = await logCheckoutEvent({ orgId: ORG, fileId: "d1", userId: ME, userEmail: "ctl@example.com", userRole: "", type: "CHECK_IN" });
    expect(error).toBeNull();
    const row = T("audit_logs").find((a) => a.action === "CHECK_IN")!;
    expect(row.user_role).toBeNull();
    expect(row.user_id).toBe(ME);
  });
});
