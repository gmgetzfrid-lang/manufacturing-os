// projects Round G (J11) — projects-and-cost QUAL-15, the closeout half:
// the closeout gate counts a checklist's SIGNED completion, not only its
// items' colours, and a voided checklist is named at closeout with who
// voided it. closeoutGateLines is what the Complete dialog renders, what
// transitionProjectStatus records in the completion's audit row (SAF-14 —
// lib/__tests__/projects.test.ts "records the four gate lines…") and what
// the printed report reads back (parseGateSnapshot).

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  errors: {} as Record<string, { message: string; code?: string }>,
  missingColumns: [] as string[],
  selects: [] as string[],
  calls: [] as string[],
}));

vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    let selected = "";
    const settle = () => {
      const missing = state.missingColumns.find((col) => selected.split(",").map((x) => x.trim()).includes(col));
      if (missing) return Promise.resolve({ data: null, error: { message: `column ${table}.${missing} does not exist`, code: "42703" } });
      const err = state.errors[table];
      return Promise.resolve(err ? { data: null, error: err } : { data: state.tables[table] ?? [], error: null });
    };
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => settle().then(resolve, reject);
        return (...args: unknown[]) => {
          if (prop === "select") { selected = String(args[0]); state.selects.push(`${table}:${selected}`); }
          else if (prop !== "abortSignal" && prop !== "maybeSingle") state.calls.push(`${table}.${prop}(${args.map((a) => JSON.stringify(a)).join(",")})`);
          if (prop === "maybeSingle") return settle().then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : null, error: r.error }));
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ error: null })), logCheckoutEvent: vi.fn(async () => ({ error: null })) }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined), notifyMany: vi.fn(async () => undefined) }));
vi.mock("@/lib/subscriptions", () => ({ listFollowerIds: vi.fn(async () => []) }));
vi.mock("@/lib/checkoutEpisodes", () => ({
  ensureActiveEpisode: vi.fn(async () => null), postEpisodeSystemMessage: vi.fn(async () => undefined),
  reconcileDocumentCheckoutState: vi.fn(async () => undefined), isMissingOutcomeSchema: () => false,
}));

import { gatherProjectSnapshotUncached } from "@/lib/projectSnapshot";
import { closeoutGateLines } from "@/lib/projects";
import { parseGateSnapshot } from "@/lib/projectReport";
import type { ProjectStateSnapshot } from "@/lib/projectHealth";

function snapshot(over: Partial<ProjectStateSnapshot> = {}): ProjectStateSnapshot {
  return {
    hasPurpose: true, hasGoals: true, hasSow: true, jobKind: null,
    budget: 0, committed: 0, spent: 0, cpi: null, accountCount: 0, accountsPinned: 0, partyCount: 0,
    quoteCount: 0, unawardedRfqGroups: 0, pendingCostDocs: 0, openChangeOrders: 0, approvedCoAmount: 0,
    milestoneCount: 0, overdueMilestones: 0, spi: null, hasBaseline: false,
    checklistCount: 0, checklistOpenItems: 0, checklistNeedsEvidence: 0, turnoverRequired: 0, turnoverAccepted: 0, punchOpen: 0,
    intakeLinkCount: 0, membersCount: 1, readFailures: [], notMigrated: [],
    ...over,
  };
}
const gate = (s: ProjectStateSnapshot, key: string) => closeoutGateLines(s).find((l) => l.key === key);

beforeEach(() => {
  state.tables = {}; state.errors = {}; state.missingColumns = []; state.selects = []; state.calls = [];
});

describe("QUAL-15 — closeoutGateLines counts sign-off, not only item colours", () => {
  it("an OPEN checklist whose items are all green is NOT clear: 'not signed off', failing", () => {
    expect(gate(snapshot({ checklistCount: 1, checklistsAwaitingSignoff: 1 }), "checklists"))
      .toEqual({ key: "checklists", ok: false, text: "1 checklist not signed off", openCount: 1 });
  });
  it("the text keeps 'not signed off' apart from 'items unresolved'", () => {
    const l = gate(snapshot({ checklistsAwaitingSignoff: 2, checklistOpenItems: 3, checklistNeedsEvidence: 1 }), "checklists")!;
    expect(l.ok).toBe(false);
    expect(l.text).toBe("2 checklists not signed off · 4 checklist items unresolved");
  });
  it("a completion with no signature on record is named, and fails the gate", () => {
    const l = gate(snapshot({ checklistsCompletedUnsigned: 1 }), "checklists")!;
    expect(l).toMatchObject({ ok: false, text: "1 checklist completed with no signature on record", openCount: 1 });
  });
  it("every checklist signed off (or none at all): 'Checklists clear' — the four lines unchanged", () => {
    const lines = closeoutGateLines(snapshot({ checklistCount: 2, checklistsAwaitingSignoff: 0, checklistsCompletedUnsigned: 0, checklistsVoided: [] }));
    expect(lines.map((l) => l.key)).toEqual(["punch", "turnover", "checklists", "changeOrders"]);
    expect(lines.find((l) => l.key === "checklists")).toEqual({ key: "checklists", ok: true, text: "Checklists clear", openCount: 0 });
  });
  it("a voided checklist is its own FAILING line, naming each one and who voided it — and the report reads it back", () => {
    const s = snapshot({
      checklistsVoided: [
        { id: "c1", title: "PSSR — Unit 3", voidedBy: "dc@example.com" },
        { id: "c2", title: "MI walkdown", voidedBy: null },
      ],
    });
    const lines = closeoutGateLines(s);
    expect(lines.map((l) => l.key)).toEqual(["punch", "turnover", "checklists", "checklistsVoided", "changeOrders"]);
    const v = lines.find((l) => l.key === "checklistsVoided")!;
    expect(v).toEqual({
      key: "checklistsVoided", ok: false, openCount: 2,
      text: "2 checklists voided — PSSR — Unit 3 (voided by dc@example.com); MI walkdown (who voided it is not on record)",
    });
    // The checklist gate itself may read clear: the void is what is shown.
    expect(lines.find((l) => l.key === "checklists")!.ok).toBe(true);
    expect(parseGateSnapshot({ gates: lines })).toContainEqual({ text: v.text, ok: false });
  });
  it("an unreadable 'who voided' says so; an unknown checklist read stays unknown (no voided line from it)", () => {
    expect(gate(snapshot({ checklistsVoided: [{ id: "c1", title: "PSSR", voidedBy: null, voidedByUnreadable: true }] }), "checklistsVoided")!.text)
      .toBe("1 checklist voided — PSSR (who voided it could not be read)");
    const lines = closeoutGateLines(snapshot({ readFailures: ["checklists"], checklistsVoided: [{ id: "c1", title: "PSSR", voidedBy: null }] }));
    expect(lines.find((l) => l.key === "checklists")!.ok).toBeNull();
    expect(lines.find((l) => l.key === "checklistsVoided")).toBeUndefined();
  });
});

describe("QUAL-15 — the snapshot reads the sign-off", () => {
  it("counts an open all-green checklist as awaiting sign-off, a signed completion as done, an unsigned completion as unsigned", async () => {
    state.tables.project_checklists = [
      { id: "c1", status: "open", title: "PSSR", completed_signature_id: null },
      { id: "c2", status: "complete", title: "QA/QC", completed_signature_id: "sig-1" },
      { id: "c3", status: "complete", title: "MI (legacy)", completed_signature_id: null },
    ];
    state.tables.checklist_items = [
      { checklist_id: "c1", status: "satisfied", applicability: "applies" },
      { checklist_id: "c1", status: "na", applicability: "na" },
    ];
    const snap = await gatherProjectSnapshotUncached("o1", "p1");
    expect(snap.checklistOpenItems + snap.checklistNeedsEvidence).toBe(0);
    expect(snap.checklistsAwaitingSignoff).toBe(1);
    expect(snap.checklistsCompletedUnsigned).toBe(1);
    expect(snap.checklistsVoided).toEqual([]);
    expect(state.selects).toContain("project_checklists:id, status, title, completed_signature_id");
    // No voided checklist → no audit read.
    expect(state.selects.some((x) => x.startsWith("audit_logs:"))).toBe(false);
    const l = closeoutGateLines(snap).find((x) => x.key === "checklists")!;
    expect(l).toMatchObject({ ok: false, text: "1 checklist not signed off · 1 checklist completed with no signature on record" });
  });

  it("before 20261136 (no signature column): the legacy read, completions by status, nothing named 'not migrated'", async () => {
    state.missingColumns = ["completed_signature_id"];
    state.tables.project_checklists = [
      { id: "c1", status: "open", title: "PSSR" },
      { id: "c2", status: "complete", title: "QA/QC" },
    ];
    const snap = await gatherProjectSnapshotUncached("o1", "p1");
    expect(state.selects.filter((x) => x.startsWith("project_checklists:"))).toEqual([
      "project_checklists:id, status, title, completed_signature_id",
      "project_checklists:id, status, title",
    ]);
    expect(snap.checklistsAwaitingSignoff).toBe(1);
    expect(snap.checklistsCompletedUnsigned).toBe(0);
    expect(snap.notMigrated).toEqual([]);
    expect(snap.readFailures).toEqual([]);
  });

  it("a voided checklist is read with who voided it from its CHECKLIST_STATUS audit row (newest first)", async () => {
    state.tables.project_checklists = [
      { id: "c1", status: "void", title: "PSSR — Unit 3", completed_signature_id: null },
      { id: "c2", status: "void", title: "Old MI", completed_signature_id: null },
    ];
    state.tables.audit_logs = [
      { user_email: "dc@example.com", details: { checklistId: "c1", status: "void", title: "PSSR — Unit 3" } },
      { user_email: "own@example.com", details: { checklistId: "c1", status: "complete" } },
    ];
    const snap = await gatherProjectSnapshotUncached("o1", "p1");
    expect(snap.checklistsVoided).toEqual([
      { id: "c1", title: "PSSR — Unit 3", voidedBy: "dc@example.com" },
      { id: "c2", title: "Old MI", voidedBy: null },
    ]);
    expect(snap.checklistsAwaitingSignoff).toBe(0);
    expect(state.calls).toContain(`audit_logs.eq("action","CHECKLIST_STATUS")`);
    expect(state.calls).toContain(`audit_logs.eq("resource_id","p1")`);
    const v = closeoutGateLines(snap).find((l) => l.key === "checklistsVoided")!;
    expect(v.ok).toBe(false);
    expect(v.text).toBe("2 checklists voided — PSSR — Unit 3 (voided by dc@example.com); Old MI (who voided it is not on record)");
  });

  it("a refused audit read leaves the voided line standing, saying who voided it could not be read — never a failed checklist gate", async () => {
    state.tables.project_checklists = [{ id: "c1", status: "void", title: "PSSR", completed_signature_id: null }];
    state.errors.audit_logs = { message: "permission denied", code: "42501" };
    const snap = await gatherProjectSnapshotUncached("o1", "p1");
    expect(snap.readFailures).toEqual([]);
    expect(snap.checklistsVoided).toEqual([{ id: "c1", title: "PSSR", voidedBy: null, voidedByUnreadable: true }]);
  });
});
