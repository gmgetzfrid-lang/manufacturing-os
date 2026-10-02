// @vitest-environment jsdom
//
// document-control Round F wave 3 — P17 GUARD & EDITOR FOLLOW-UPS: REV-19's
// bulk-editor limb.
//
//   A bulk status change that ISSUES a row (isIssueTransition — a row with a
//   current revision leaving Draft / In Review / a retirement for an issue
//   status) now goes through lib/revisions.ts changeDocumentStatus: the same
//   one checked UPDATE (status, the recomputed uniqueness key, updated_at /
//   updated_by), then the compliance clocks it owes and the DOCUMENT_ISSUED
//   record (door "bulk"). A refusal is named as before; an issue whose clocks
//   or record did not follow is named after the apply. Every row that issues
//   nothing — and a custom-field edit — is written exactly as before, and
//   P15's entry-into-force hold check (an IFC row → Issued) is unchanged.
//
// Rendered (jsdom) against the in-memory PostgREST with the REAL
// BulkEditModal, lib/revisions.ts, lib/audit and lib/holdGate; the clocks'
// two entry points are spies (as dcRoundFStatusIssueRecord does).
//
// P17 review fix: the record and the clocks name the signed-in user (email
// and role from useRole), and a row written as an issue that
// changeDocumentStatus did not record as one (its status before the write
// could not be read) is named after the apply — never a silent success.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  clockErrors: [] as string[],
  /** documentId → the guard's refusal for a write to it */
  refuse: {} as Record<string, string>,
  updatePayloads: [] as Array<{ id: unknown; payload: Record<string, unknown> }>,
  /** documents whose pre-write read (changeDocumentStatus's select("*")) fails */
  failRead: new Set<string>(),
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const real = makeFakeSupabase(state.db);
    return {
      ...real,
      from: (t: string) => {
        const b = real.from(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
        if (t !== "documents") return b;
        // record every documents UPDATE payload (what was written, in one statement)
        return new Proxy(b, {
          get(target, prop: string) {
            if (prop === "select") {
              return (cols: string) => {
                const q = target.select(cols) as Record<string, (...a: unknown[]) => unknown>;
                if (cols !== "*") return q;
                return new Proxy(q, {
                  get(qt, qp: string) {
                    if (qp !== "eq") return qt[qp];
                    return (col: string, val: unknown) => (col === "id" && state.failRead.has(String(val))
                      ? { maybeSingle: async () => ({ data: null, error: { message: "network error" } }) }
                      : qt.eq(col, val));
                  },
                });
              };
            }
            if (prop !== "update") return target[prop];
            return (payload: Record<string, unknown>) => {
              const q = target.update(payload) as Record<string, (...a: unknown[]) => unknown>;
              return new Proxy(q, {
                get(qt, qp: string) {
                  if (qp !== "eq") return qt[qp];
                  return (col: string, val: unknown) => {
                    if (col === "id") state.updatePayloads.push({ id: val, payload });
                    return qt.eq(col, val);
                  };
                },
              });
            };
          },
        });
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
// the signed-in user, as the protected layout's RoleProvider gives it
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ uid: "ctl1", userEmail: "cara@example.com", activeRole: "DocCtrl" }) }));
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })) };
});

import BulkEditModal from "@/components/documents/BulkEditModal";
import { onDocumentIssued } from "@/lib/reviewCycles";
import { onDocumentIssuedAck } from "@/lib/acknowledgments";
import { isIssueTransition } from "@/lib/issueStatus";
import type { DocumentRecord, LibraryConfig } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "o1";
const ME = "ctl1";
const HOLD = "Document has an active hold; release the hold before issuing it.";
const RETIRED = ["Superseded", "Archived", "Void"];
const T = (t: string) => (state.db.tables[t] ??= []);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const issuedRecords = () => T("audit_logs").filter((a) => a.action === "DOCUMENT_ISSUED");

function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: "lib1", collection_id: null, document_number: id.toUpperCase(), title: id, rev: "2",
    status: "Draft", current_version_id: `${id}-v2`, pending_version_id: null, review_control: null, metadata: {},
    retired_issue_status: null, retired_issue_version_id: null, uniqueness_key: `${id}-key`, ...extra,
  };
  T("documents").push(d);
  if (d.current_version_id) T("document_versions").push({ id: d.current_version_id, org_id: ORG, record_id: id, revision_label: "2" });
  return d;
}
const asRecord = (d: Row) => ({
  id: d.id, documentNumber: d.document_number, title: d.title, rev: d.rev, status: d.status,
  metadata: d.metadata ?? {}, libraryId: "lib1", currentVersionId: (d.current_version_id as string | null) ?? undefined,
}) as unknown as DocumentRecord;
const LIB = (extra: Partial<LibraryConfig> = {}) => ({ id: "lib1", orgId: ORG, customColumns: [], uniquenessKeys: ["documentNumber"], ...extra }) as unknown as LibraryConfig;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.clockErrors = [];
  state.refuse = {};
  state.updatePayloads = [];
  state.failRead = new Set();
  // the guard's part these tests need: its refusal, and the retirement stamp cleared on an exit (20261144)
  state.db.beforeUpdate!.documents = (next) => {
    const r = state.refuse[String(next.id)];
    if (r) throw { code: "23514", message: r };
    if (!RETIRED.includes(String(next.status))) { next.retired_issue_status = null; next.retired_issue_version_id = null; }
    return next;
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = () => act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); });
const button = (label: string) => {
  const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.includes(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
};
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}
const labelled = (label: string) => {
  const l = Array.from(host.querySelectorAll("label")).find((x) => x.textContent?.trim() === label);
  if (!l) throw new Error(`no label "${label}"`);
  return l.parentElement!.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;
};
async function applyStatus(docs: DocumentRecord[], value: string, library = LIB()) {
  const onApplied = vi.fn();
  await act(async () => {
    root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs, library, actorUserId: ME, onApplied }));
  });
  await act(async () => setValue(labelled("New value") as HTMLSelectElement, value));
  await act(async () => { button(`Apply to ${docs.length}`).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
  return onApplied;
}

describe("REV-19 (P17) — the bulk editor's issuing rows start the clocks and are recorded", () => {
  it("Draft / In Review rows set to Issued: each is written once, starts the review clock and the acknowledgment roster, and is recorded DOCUMENT_ISSUED (door bulk)", async () => {
    const a = seedDoc("a1");
    const b = seedDoc("a2", { status: "In Review" });
    const onApplied = await applyStatus([asRecord(a), asRecord(b)], "Issued");
    expect(host.textContent).toMatch(/Applied to 2 documents\./);
    expect(onApplied).toHaveBeenCalledTimes(1);
    for (const id of ["a1", "a2"]) expect(docRow(id)).toMatchObject({ status: "Issued", updated_by: ME });
    // one UPDATE per row, carrying the status (no second write)
    expect(state.updatePayloads.map((u) => [u.id, u.payload.status])).toEqual([["a1", "Issued"], ["a2", "Issued"]]);
    expect(onDocumentIssued).toHaveBeenCalledTimes(2);
    expect(onDocumentIssuedAck).toHaveBeenCalledTimes(2);
    expect(issuedRecords().map((r) => [r.resource_id, r.org_id, r.user_id])).toEqual([["a1", ORG, ME], ["a2", ORG, ME]]);
    expect(issuedRecords()[0].details).toMatchObject({ door: "bulk", fromStatus: "Draft", toStatus: "Issued", versionId: "a1-v2", rev: "2", putBack: false, complianceClocksStarted: true });
    expect(issuedRecords()[1].details).toMatchObject({ door: "bulk", fromStatus: "In Review", toStatus: "Issued" });
    expect(host.querySelector('[data-testid="bulk-issue-follow-ups"]')).toBeNull();
    // P17 review fix: who issued it — the email and role on the record, the name on the clocks
    for (const r of issuedRecords()) expect(r).toMatchObject({ user_email: "cara@example.com", user_role: "DocCtrl" });
    expect(onDocumentIssued).toHaveBeenCalledWith(expect.objectContaining({ userId: ME, userName: "cara@example.com" }));
    expect(onDocumentIssuedAck).toHaveBeenCalledWith(expect.objectContaining({ actorId: ME, actorName: "cara@example.com" }));
  });

  it("P17 review fix: an issuing row whose status before the change could not be read is written but not recorded as an issue — the modal names it after the apply instead of a plain success", async () => {
    const a = seedDoc("e1");
    const b = seedDoc("e2");
    state.failRead.add("e1");
    await applyStatus([asRecord(a), asRecord(b)], "Issued");
    // both writes landed (the guard decides the write; the read only decides the record)
    expect(docRow("e1").status).toBe("Issued");
    expect(docRow("e2").status).toBe("Issued");
    expect(host.textContent).toMatch(/Applied to 2 documents\./);
    // e1 has no record and no clock — and is named; e2 is recorded as before
    expect(issuedRecords().map((r) => r.resource_id)).toEqual(["e2"]);
    expect(onDocumentIssued).toHaveBeenCalledTimes(1);
    const box = host.querySelector('[data-testid="bulk-issue-follow-ups"]')!;
    expect(box).not.toBeNull();
    expect(box.textContent).toMatch(/1 issued row — follow-up steps did not complete/);
    const items = Array.from(box.querySelectorAll("li")).map((li) => li.textContent ?? "");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatch(/^E1 — The status was changed, but it was not recorded as an issue/);
    expect(items[0]).toContain("no review clock or acknowledgment roster was started and no issue record was written");
    // P17 integrator fix: a failed read keeps the "start its clocks" advice — nothing was recorded
    expect(items[0]).toContain("its status before the change could not be read");
    expect(items[0]).toContain("start its clocks from the document");
    expect(items[0]).not.toMatch(/already issued/);
    expect(host.querySelector('[data-testid="bulk-not-issued-rows"]')).toBeNull();
  });

  it("P17 integrator fix: a row someone else ISSUED between page load and apply is named as already issued — nothing owed, never the 'start its clocks' advice (which would restart a review clock)", async () => {
    const a = seedDoc("k1");
    const b = seedDoc("k2");
    const pageCopies = [asRecord(a), asRecord(b)]; // both Draft on the page
    docRow("k1").status = "Issued"; // …issued by another door after the page loaded
    await applyStatus(pageCopies, "Issued");
    expect(docRow("k1").status).toBe("Issued");
    expect(docRow("k2").status).toBe("Issued");
    expect(host.textContent).toMatch(/Applied to 2 documents\./);
    // k1: no record or clock from this change (it issued nothing); k2 recorded as before
    expect(issuedRecords().map((r) => r.resource_id)).toEqual(["k2"]);
    expect(onDocumentIssued).toHaveBeenCalledTimes(1);
    // not a follow-up: nothing did "not complete"
    expect(host.querySelector('[data-testid="bulk-issue-follow-ups"]')).toBeNull();
    const box = host.querySelector('[data-testid="bulk-not-issued-rows"]')!;
    expect(box).not.toBeNull();
    expect(box.textContent).toMatch(/1 row was not issued by this change — nothing more is owed/);
    const items = Array.from(box.querySelectorAll("li")).map((li) => li.textContent ?? "");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatch(/^K1 — it was already issued when this change reached it/);
    expect(items[0]).toContain("nothing more is owed for this change");
    expect(items[0]).toContain("Do not start its clocks again from here");
    expect(host.textContent).not.toContain("start its clocks from the document");
  });

  it("P17 integrator fix: a row whose current revision is gone by the apply is named as having nothing to issue — no follow-up, no clock advice", async () => {
    const a = seedDoc("z1");
    const page = asRecord(a); // the page saw a current revision
    docRow("z1").current_version_id = null;
    await applyStatus([page], "Issued");
    expect(docRow("z1").status).toBe("Issued");
    expect(issuedRecords()).toEqual([]);
    expect(host.querySelector('[data-testid="bulk-issue-follow-ups"]')).toBeNull();
    const items = Array.from(host.querySelectorAll('[data-testid="bulk-not-issued-rows"] li')).map((li) => li.textContent ?? "");
    expect(items).toEqual(["Z1 — it has no current revision, so there was nothing to issue: no clock or issue record is owed for it."]);
  });

  it("an unstamped archive restored to Issued in bulk is recorded without resetting the review clock (no evidence of a new issue) — only the roster opens", async () => {
    const a = seedDoc("r1", { status: "Archived" });
    await applyStatus([asRecord(a)], "Issued");
    expect(docRow("r1").status).toBe("Issued");
    expect(onDocumentIssued).not.toHaveBeenCalled();
    expect(onDocumentIssuedAck).toHaveBeenCalledTimes(1);
    expect(issuedRecords()[0].details).toMatchObject({ door: "bulk", fromStatus: "Archived", putBack: null, reviewClockReset: false, acknowledgmentRosterOpened: true });
  });

  it("a refused issuing row is named in the database's words, marked, and has no record or clock; the other rows keep the change", async () => {
    const a = seedDoc("h1");
    const b = seedDoc("h2");
    state.refuse.h1 = HOLD;
    await applyStatus([asRecord(a), asRecord(b)], "Issued");
    const items = Array.from(host.querySelectorAll('[data-testid="bulk-refused-rows"] li')).map((li) => li.textContent);
    expect(items).toEqual([`H1 — not issued: ${HOLD}`]);
    expect(host.textContent).toMatch(/The other 1 row was applied — each row is its own write, so nothing was rolled back\./);
    expect(docRow("h1").status).toBe("Draft");
    expect(issuedRecords().map((r) => r.resource_id)).toEqual(["h2"]);
    expect(onDocumentIssued).toHaveBeenCalledTimes(1);
  });

  it("an issue whose clocks did not fully start is applied AND named after the apply — the change stands, do not repeat it", async () => {
    state.clockErrors = ["review cycle: next_review_date was not set (permission denied)"];
    const a = seedDoc("c1");
    await applyStatus([asRecord(a)], "Issued");
    expect(docRow("c1").status).toBe("Issued");
    expect(host.textContent).toMatch(/Applied to 1 document\./);
    const box = host.querySelector('[data-testid="bulk-issue-follow-ups"]')!;
    expect(box.textContent).toMatch(/1 issued row — follow-up steps did not complete/);
    expect(box.textContent).toMatch(/The status change stands and is not rolled back — do not apply it again\./);
    expect(box.textContent).toContain("C1 — ");
    expect(box.textContent).toContain("next_review_date was not set (permission denied)");
    expect(issuedRecords()[0].details).toMatchObject({ complianceClockErrors: expect.arrayContaining([expect.stringContaining("next_review_date")]) });
  });

  it("the recomputed uniqueness key rides in the SAME update as the issuing status", async () => {
    const a = seedDoc("u1");
    await applyStatus([asRecord(a)], "Issued", LIB({ uniquenessKeys: ["documentNumber", "status"] } as Partial<LibraryConfig>));
    expect(state.updatePayloads).toHaveLength(1);
    expect(state.updatePayloads[0].payload).toMatchObject({ status: "Issued", updated_by: ME });
    expect(typeof state.updatePayloads[0].payload.uniqueness_key).toBe("string");
    expect(docRow("u1").uniqueness_key).toBe(state.updatePayloads[0].payload.uniqueness_key);
    expect(issuedRecords()).toHaveLength(1);
  });
});

describe("REV-19 (P17) — REGRESSION: every bulk edit that issues nothing is written exactly as before", () => {
  it("rows the change does not issue (already issued; no current revision; Issued → Draft / Superseded / Archived) — one bare UPDATE each, the same payload, no record, no clock", async () => {
    const rows = [
      seedDoc("n1", { status: "Issued" }),
      seedDoc("n2", { current_version_id: null }),
    ];
    for (const r of rows) expect(isIssueTransition({ fromStatus: r.status as string, toStatus: "Issued", hasCurrentRevision: !!r.current_version_id })).toBe(false);
    await applyStatus(rows.map(asRecord), "Issued");
    expect(state.updatePayloads.map((u) => u.id)).toEqual(["n1", "n2"]);
    for (const u of state.updatePayloads) expect(Object.keys(u.payload).sort()).toEqual(["status", "updated_at", "updated_by"]);
    expect(issuedRecords()).toEqual([]);
    expect(onDocumentIssued).not.toHaveBeenCalled();
    expect(onDocumentIssuedAck).not.toHaveBeenCalled();
    for (const to of ["Draft", "Superseded", "Archived"]) {
      act(() => root.unmount()); root = createRoot(host);
      state.db = newFakeDb(); state.updatePayloads = [];
      const d = seedDoc(`x-${to}`, { status: "Issued" });
      await applyStatus([asRecord(d)], to);
      expect(docRow(`x-${to}`).status).toBe(to);
      expect(state.updatePayloads).toHaveLength(1);
      expect(issuedRecords()).toEqual([]);
    }
    expect(onDocumentIssued).not.toHaveBeenCalled();
  });

  it("a custom-field edit is the same metadata write as before (no status, no record)", async () => {
    const d = seedDoc("m1");
    const lib = LIB({ customColumns: [{ key: "area", label: "Area", type: "text" }] } as unknown as Partial<LibraryConfig>);
    await act(async () => {
      root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs: [asRecord(d)], library: lib, actorUserId: ME }));
    });
    await act(async () => setValue(labelled("Field to change") as HTMLSelectElement, "custom:area"));
    await act(async () => setValue(labelled("New value") as HTMLInputElement, "Unit 200"));
    await act(async () => { button("Apply to 1").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(state.updatePayloads).toHaveLength(1);
    expect(Object.keys(state.updatePayloads[0].payload).sort()).toEqual(["metadata", "updated_at", "updated_by"]);
    expect(docRow("m1")).toMatchObject({ status: "Draft", metadata: { area: "Unit 200" } });
    expect(issuedRecords()).toEqual([]);
  });

  it("P15 / DEC-77 unchanged: an IFC row set to Issued is hold-checked by the modal and written as before — a held one is refused and never written, and neither is recorded as a REV-18 issue", async () => {
    const free = seedDoc("f1", { status: "IFC" });
    const held = seedDoc("f2", { status: "IFC" });
    T("document_holds").push({ id: "hh", org_id: ORG, document_id: "f2", reason: "Other", notes: "Vendor query", released_at: null, opened_at: "2026-09-01" });
    await applyStatus([asRecord(free), asRecord(held)], "Issued");
    expect(state.updatePayloads.map((u) => u.id)).toEqual(["f1"]);
    expect(docRow("f1").status).toBe("Issued");
    expect(docRow("f2").status).toBe("IFC");
    const items = Array.from(host.querySelectorAll('[data-testid="bulk-refused-rows"] li')).map((li) => li.textContent ?? "");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatch(/^F2 — Document has an active hold/);
    expect(issuedRecords()).toEqual([]);
  });
});
