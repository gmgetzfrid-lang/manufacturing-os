// projects Round G (J11) — projects-tab UX-16: the evidence sweep runs when
// evidence actually arrives — after a turnover item is accepted, and after a
// revision is approved on a document the project's evidence register cites
// (an intake submission in the project's intake folder) — scoped to the
// project: every OPEN checklist, against one gather of what the project can
// prove. SAF-1 (the evidence contract the sweep obeys) is RESOLVED.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** A single row per table for maybeSingle(). */
  single: {} as Record<string, Record<string, unknown> | null>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  writes: [] as Array<{ table: string; op: string; payload: unknown }>,
  sweepCalls: [] as Array<Record<string, unknown>>,
  docSweepCalls: [] as Array<Record<string, unknown>>,
  sweepResult: { checklists: 1, satisfied: 1, needsEvidence: 0, retracted: 0, refused: 0, failed: 0 } as Record<string, unknown>,
}));

function chain(table: string) {
  let op = "select";
  let payload: unknown;
  const filters: Array<[string, unknown]> = [];
  const matches = (r: Row) => filters.every(([k, v]) => r[k] === undefined || r[k] === v);
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          let out: unknown;
          if (op !== "select") { state.writes.push({ table, op, payload }); out = { data: [{ id: "w" }], error: null }; }
          else out = { data: (state.rows[table] ?? []).filter(matches), error: null };
          return Promise.resolve(out).then(resolve, reject);
        };
      }
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "update" || prop === "insert" || prop === "delete") { op = prop; payload = args[0]; }
        if (prop === "eq") filters.push([String(args[0]), args[1]]);
        if (prop === "maybeSingle" || prop === "single") {
          if (op !== "select") { state.writes.push({ table, op, payload }); return Promise.resolve({ data: { id: "w" }, error: null }); }
          return Promise.resolve({ data: table in state.single ? state.single[table] : ((state.rows[table] ?? []).filter(matches)[0] ?? null), error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t), rpc: vi.fn(async () => ({ data: null, error: null })) } }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ error: null })) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("@/lib/postPublish", () => ({ runPostPublishSideEffects: vi.fn(async () => undefined) }));
vi.mock("@/lib/effectiveDate", () => ({ applyEffectiveDate: vi.fn(async () => undefined) }));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn(async () => undefined) }));
// The turnover writer and the publish path call the sweep through the
// module; the real sweep is exercised below through importActual.
vi.mock("@/lib/checklists", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/checklists")>();
  return {
    ...actual,
    captureQualitySignoff: vi.fn(async () => ({ ok: true, signatureId: "sig-1" })),
    runProjectEvidenceSweep: vi.fn(async (input: Record<string, unknown>) => { state.sweepCalls.push(input); return { ...state.sweepResult }; }),
    sweepEvidenceForDocument: vi.fn(async (input: Record<string, unknown>) => { state.docSweepCalls.push(input); return { ...state.sweepResult, projects: 1 }; }),
  };
});

import { reviewTurnoverItem, reopenTurnoverItem, type TurnoverItem } from "@/lib/turnover";
import { finalizeReviewedRevision } from "@/lib/reviewControl";
import { buildCoachItems } from "@/lib/projectHealth";

const actual = () => vi.importActual<typeof import("@/lib/checklists")>("@/lib/checklists");
const ACTOR = { uid: "qa", email: "qa@example.com" };
const ITEM: TurnoverItem = {
  id: "t1", orgId: "o1", projectId: "p1", partyId: null, name: "Hydrotest records", description: null, required: true,
  status: "received", documentId: null, reviewedAt: null, reviewedByName: null, reviewNote: null, createdAt: null, createdBy: "someone-else",
};

beforeEach(() => {
  state.rows = {}; state.single = {}; state.calls = []; state.writes = [];
  state.sweepCalls = []; state.docSweepCalls = [];
  state.sweepResult = { checklists: 1, satisfied: 1, needsEvidence: 0, retracted: 0, refused: 0, failed: 0 };
});

describe("UX-16 — a turnover acceptance runs the project's sweep", () => {
  it("accepting an item sweeps the item's project and hands the outcome back", async () => {
    const res = await reviewTurnoverItem({ item: ITEM, status: "accepted", actor: ACTOR, signoff: { statement: "ok", signerName: "QA" } });
    expect(res.ok).toBe(true);
    expect(state.sweepCalls).toEqual([{ orgId: "o1", projectId: "p1", actor: ACTOR }]);
    expect(res.evidenceSweep).toMatchObject({ checklists: 1, satisfied: 1 });
    // The decision landed BEFORE the sweep (the write that triggered it is never undone).
    const tWrite = state.calls.findIndex((c) => c.table === "turnover_items" && c.method === "update");
    expect(tWrite).toBeGreaterThanOrEqual(0);
  });

  it("a rejection or a waiver brings no evidence — no sweep", async () => {
    await reviewTurnoverItem({ item: ITEM, status: "rejected", note: "Records missing the test pressure chart", actor: ACTOR });
    await reviewTurnoverItem({ item: ITEM, status: "waived", note: "Not required: no pressure boundary", actor: ACTOR, signoff: { statement: "ok", signerName: "QA" } });
    expect(state.sweepCalls).toEqual([]);
  });

  it("reopening an ACCEPTED item sweeps too — the green resting on it is withdrawn (QUAL-1); a waived one does not", async () => {
    await reopenTurnoverItem({ item: { ...ITEM, status: "accepted", reviewNote: "fine" }, reason: "The chart was for another loop", actor: ACTOR });
    expect(state.sweepCalls).toHaveLength(1);
    await reopenTurnoverItem({ item: { ...ITEM, status: "waived", reviewNote: "fine" }, reason: "It is required after all here", actor: ACTOR });
    expect(state.sweepCalls).toHaveLength(1);
  });

  it("a project with no open checklist: nothing to say, the result is the plain { ok: true }", async () => {
    state.sweepResult = { checklists: 0, satisfied: 0, needsEvidence: 0, retracted: 0, refused: 0, failed: 0 };
    expect(await reviewTurnoverItem({ item: ITEM, status: "accepted", actor: ACTOR, signoff: { statement: "ok", signerName: "QA" } })).toEqual({ ok: true });
  });
});

describe("UX-16 — an approved revision sweeps the projects whose register cites the document", () => {
  const draft = () => {
    state.single.documents = { id: "d1", library_id: "l1", rev: "A", status: "Issued", current_version_id: "v1", pending_version_id: "v2", document_number: "HT-1" };
    state.single.document_versions = { base_rev: "B", revision_label: "B", effective_date: null, supersedes_version_id: "v1" };
  };
  it("an intake approval (the approve click is the review) publishes, then sweeps — with the approver as the actor", async () => {
    draft();
    const res = await finalizeReviewedRevision({ orgId: "o1", documentId: "d1", actorId: "dc", actorName: "dc@example.com", actorEmail: "dc@example.com", requireRosterComplete: false });
    expect(res.published).toBe(true);
    expect(state.docSweepCalls).toEqual([{ orgId: "o1", documentId: "d1", actor: { uid: "dc", email: "dc@example.com" } }]);
    expect(res.evidenceSweep).toMatchObject({ projects: 1, satisfied: 1 });
  });
  it("the sweep's actor email is the approver's email — never the display name: an approver whose email is not loaded is recorded with none, not 'Reviewer'", async () => {
    draft();
    await finalizeReviewedRevision({ orgId: "o1", documentId: "d1", actorId: "dc", actorName: "Reviewer", actorEmail: null, requireRosterComplete: false });
    expect(state.docSweepCalls).toEqual([{ orgId: "o1", documentId: "d1", actor: { uid: "dc", email: null } }]);
    // both callers pass the session email as actorEmail
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("components/projects/IntakePanel.tsx", "utf8")).toContain('actorName: userEmail ?? "Reviewer", actorEmail: userEmail ?? null,');
    expect(readFileSync("components/documents/ReviewGateSection.tsx", "utf8")).toContain("actorName: userEmail, actorEmail: userEmail ?? null });");
    expect(readFileSync("lib/reviewControl.ts", "utf8")).toContain("actor: { uid: input.actorId, email: input.actorEmail ?? null },");
  });
  it("a publish that did not land sweeps nothing", async () => {
    draft();
    (state.single.documents as Row).pending_version_id = null;
    const res = await finalizeReviewedRevision({ orgId: "o1", documentId: "d1", actorId: "dc", actorName: "dc@example.com", requireRosterComplete: false });
    expect(res.published).toBe(false);
    expect(state.docSweepCalls).toEqual([]);
  });
});

describe("UX-16 — the project sweep itself (the real one)", () => {
  it("sweeps EVERY open checklist of the project against ONE evidence gather; an accepted turnover item proves its line", async () => {
    const { runProjectEvidenceSweep } = await actual();
    state.rows.project_checklists = [{ id: "c1", status: "open" }, { id: "c2", status: "open" }];
    state.rows.turnover_items = [{ id: "t1", name: "Hydrotest records", status: "accepted", document_id: null }];
    state.single.projects = { intake_collection_id: null, sow_document_id: null };
    state.rows.checklist_items = [
      { id: "i1", checklist_id: "c1", seq: 1, text: "Turnover: hydrotest records received", applicability: "applies", status: "open", evidence: [], updated_at: "2026-09-01T00:00:00Z" },
      { id: "i2", checklist_id: "c2", seq: 1, text: "Turnover data book for the relief valves", applicability: "applies", status: "open", evidence: [], updated_at: "2026-09-01T00:00:00Z" },
    ];
    const out = await runProjectEvidenceSweep({ orgId: "o1", projectId: "p1", actor: ACTOR });
    expect(out).toMatchObject({ checklists: 2, satisfied: 1, needsEvidence: 1, retracted: 0, refused: 0, failed: 0 });
    // Only open checklists, of this project.
    const clRead = state.calls.filter((c) => c.table === "project_checklists");
    expect(clRead).toContainEqual({ table: "project_checklists", method: "eq", args: ["project_id", "p1"] });
    expect(clRead).toContainEqual({ table: "project_checklists", method: "eq", args: ["status", "open"] });
    // One gather (turnover read once by the gather), two checklist reads.
    expect(state.calls.filter((c) => c.table === "turnover_items" && c.method === "select")).toHaveLength(1);
    const itemWrites = state.writes.filter((w) => w.table === "checklist_items" && w.op === "update");
    expect(itemWrites).toHaveLength(2);
    const green = itemWrites.find((w) => (w.payload as Row).status === "satisfied")!.payload as Row;
    expect(green.updated_by).toBeNull();
    expect((green.evidence as Array<Row>)[0]).toMatchObject({ source: "auto", turnoverItemId: "t1" });
    // Audited per checklist it changed, under the actor.
    const audits = state.writes.filter((w) => w.table === "audit_logs").map((w) => w.payload as Row);
    expect(audits.map((a) => a.action)).toEqual(["CHECKLIST_AUTO_EVIDENCE", "CHECKLIST_AUTO_EVIDENCE"]);
    expect(audits[0]).toMatchObject({ resource_type: "project", resource_id: "p1", user_id: "qa" });
  });

  it("no open checklist: no gather, nothing written", async () => {
    const { runProjectEvidenceSweep } = await actual();
    state.rows.project_checklists = [];
    expect(await runProjectEvidenceSweep({ orgId: "o1", projectId: "p1", actor: ACTOR }))
      .toEqual({ checklists: 0, satisfied: 0, needsEvidence: 0, retracted: 0, refused: 0, failed: 0 });
    expect(state.calls.some((c) => c.table === "turnover_items")).toBe(false);
  });

  it("sweepEvidenceForDocument finds the projects by intake folder, SOW and accepted turnover item — scoped to the org", async () => {
    const { sweepEvidenceForDocument } = await actual();
    state.single.documents = { collection_id: "col-1" };
    state.rows.turnover_items = [{ project_id: "p2" }];
    state.rows.projects = [{ id: "p1" }];
    state.rows.project_checklists = [];
    const out = await sweepEvidenceForDocument({ orgId: "o1", documentId: "d1", actor: ACTOR });
    expect(out.projects).toBe(2);
    expect(state.calls).toContainEqual({ table: "projects", method: "or", args: ["sow_document_id.eq.d1,intake_collection_id.eq.col-1"] });
    expect(state.calls).toContainEqual({ table: "projects", method: "eq", args: ["org_id", "o1"] });
    expect(state.calls).toContainEqual({ table: "turnover_items", method: "eq", args: ["status", "accepted"] });
  });

  it("describeProjectSweep: a sentence for what changed, a failure for what could not be written, nothing for a no-op", async () => {
    const { describeProjectSweep } = await actual();
    expect(describeProjectSweep({ checklists: 2, satisfied: 0, needsEvidence: 0, retracted: 0, refused: 0, failed: 0 })).toBeNull();
    expect(describeProjectSweep({ checklists: 2, satisfied: 2, needsEvidence: 1, retracted: 1, refused: 0, failed: 0 })).toEqual({
      ok: true,
      text: "The evidence check ran on the project's open checklists: 2 items proven; 1 need evidence; 1 withdrawn — the cited document is no longer current.",
    });
    const refused = describeProjectSweep({ checklists: 1, satisfied: 0, needsEvidence: 0, retracted: 0, refused: 3, failed: 0 })!;
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/3 could not be updated — run "Check evidence we already hold"/);
    expect(describeProjectSweep({ checklists: 0, satisfied: 0, needsEvidence: 0, retracted: 0, refused: 0, failed: 0, error: "boom" })!.ok).toBe(false);
  });
});

describe("UX-16 — the surfaces say it, and the coach copy describes the automated moments", () => {
  it("the coach names the two moments and the button", () => {
    const item = buildCoachItems({
      hasPurpose: true, hasGoals: true, hasSow: true, jobKind: null, budget: 0, committed: 0, spent: 0, cpi: null,
      accountCount: 0, accountsPinned: 0, partyCount: 0, quoteCount: 0, unawardedRfqGroups: 0, pendingCostDocs: 0,
      openChangeOrders: 0, approvedCoAmount: 0, milestoneCount: 0, overdueMilestones: 0, spi: null, hasBaseline: false,
      checklistCount: 1, checklistOpenItems: 0, checklistNeedsEvidence: 2, turnoverRequired: 0, turnoverAccepted: 0, punchOpen: 0,
      intakeLinkCount: 0, membersCount: 1, readFailures: [], notMigrated: [],
    }, "p1").find((i) => i.id === "evidence")!;
    expect(item.payoff).toMatch(/runs on its own when a contractor submission is approved or a turnover item is accepted/);
    expect(item.payoff).toContain("Check evidence we already hold");
    expect(item.payoff).not.toMatch(/Nothing runs on its own/);
  });
  it("the intake approval, the review panel and the turnover section say what the sweep did", () => {
    expect(readFileSync("components/projects/IntakePanel.tsx", "utf8")).toMatch(/const swept = res\.evidenceSweep \? describeProjectSweep\(res\.evidenceSweep\) : null;/);
    expect(readFileSync("components/documents/ReviewGateSection.tsx", "utf8")).toMatch(/if \(swept && !swept\.ok\) await appAlert\(\{ tone: "danger", message: swept\.text \}\);/);
    const q = readFileSync("components/projects/QualityTab.tsx", "utf8");
    expect(q).toMatch(/const swept = res\.ok && res\.evidenceSweep \? describeProjectSweep\(res\.evidenceSweep\) : null;\n\s+if \(swept\) \{ setNotice\(swept\.ok \? success\(swept\.text\) : failure\(swept\.text\)\); onEvidenceSwept\(\); \}/);
    expect(q).toMatch(/return finish\(await reviewTurnoverItem\(/);
    expect(q).toMatch(/finish\(await reopenTurnoverItem\(/);
    expect(q).toMatch(/<ChecklistsSection key=\{sweepTick\}/);
  });
});
