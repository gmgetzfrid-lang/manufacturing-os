// projects-and-cost QUAL-10 (projects Round G J12) — the project evidence
// pack carries the quality program: every checklist with every item (its
// status, applicability, evidence citations and who decided it — the
// automated sweep marked as automated), the turnover package and the punch
// list. A read that fails is said to have failed, never printed as "none".

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  errors: {} as Record<string, string>,
  inCalls: [] as Array<{ table: string; n: number }>,
}));
vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    const answer = () => state.errors[table]
      ? { data: null, error: { message: state.errors[table] } }
      : { data: (state.tables[table] ?? []).filter((r) => preds.every((p) => p(r))), error: null };
    const c: Row = {};
    const h: ProxyHandler<Row> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(answer());
        return (...args: unknown[]) => {
          if (prop === "eq") preds.push((r) => r[args[0] as string] === args[1]);
          if (prop === "in") { state.inCalls.push({ table, n: (args[1] as unknown[]).length }); preds.push((r) => (args[1] as unknown[]).includes(r[args[0] as string])); }
          if (prop === "maybeSingle") { const a = answer(); return Promise.resolve({ data: a.data?.[0] ?? null, error: a.error }); }
          return new Proxy(c, h);
        };
      },
    };
    return new Proxy(c, h);
  }
  return { supabase: { from: (t: string) => chain(t) } };
});

import {
  gatherProjectQualityEvidence, gatherProjectEvidence, renderProjectEvidenceHtml, checklistItemDecider, PROJECT_PACK_COVERAGE,
} from "@/lib/evidencePack";
import { MACHINE_ACTOR_SWEEP, MACHINE_ACTOR_ASSESSMENT } from "@/lib/checklistEngine";

beforeEach(() => {
  state.errors = {};
  state.inCalls = [];
  state.tables = {
    projects: [{ id: "p1", name: "Unit 300 repipe", status: "active" }],
    project_members: [], milestones: [], audit_logs: [], transmittals: [],
    project_checklists: [
      { id: "cl1", project_id: "p1", title: "PSSR", kind: "pssr", status: "complete", completed_at: "2026-09-30T00:00:00Z", completed_by_name: "jchen", completed_basis: "human" },
      { id: "cl2", project_id: "p1", title: "MI walkdown", kind: "mi", status: "open" },
    ],
    checklist_items: [
      { id: "i1", checklist_id: "cl1", seq: 1, text: "Hydrotest records on file", applicability: "applies", status: "satisfied",
        evidence: [{ label: 'Document on file: "E-301 Hydrotest Report"', documentId: "d1aaaaaaaaaa", source: "auto" }], updated_by: null, updated_by_name: MACHINE_ACTOR_SWEEP, updated_at: "2026-09-29T00:00:00Z" },
      { id: "i2", checklist_id: "cl1", seq: 2, text: "Relief valves tagged", applicability: "na", status: "na", evidence: [],
        manual_note: "No relief valves in this scope", updated_by: "u-b", updated_by_name: "jchen", updated_at: "2026-09-28T00:00:00Z" },
      { id: "i3", checklist_id: "cl2", seq: 1, text: "<script>x</script>", applicability: "applies", status: "open", evidence: { label: "legacy photo", source: "manual" }, updated_by: null, updated_by_name: null },
    ],
    turnover_items: [
      { id: "t1", project_id: "p1", name: "Weld map", status: "waived", required: true, review_note: "Weld log accepted instead", reviewed_by_name: "pat", reviewed_at: "2026-09-27T00:00:00Z" },
      { id: "t2", project_id: "p1", name: "Spare parts list", status: "pending", required: false },
    ],
    punch_items: [
      { id: "pu1", project_id: "p1", title: "Missing insulation", location: "Rack 3", status: "done", closure_note: "Insulated 9/26", closed_by_name: "jchen", closed_at: "2026-09-26T00:00:00Z" },
    ],
  };
});

describe("QUAL-10 — the quality program in the project evidence pack", () => {
  it("gathers every checklist with its own items, the turnover package and the punch list", async () => {
    const q = await gatherProjectQualityEvidence("p1");
    expect(q.unread).toEqual([]);
    expect(q.checklists.map((c) => [c.title, c.items.map((i) => i.id)])).toEqual([["PSSR", ["i1", "i2"]], ["MI walkdown", ["i3"]]]);
    expect(q.turnover).toHaveLength(2);
    expect(q.punch).toHaveLength(1);
  });

  it("item rows are read in chunks of 100 checklist ids — a large program never builds one oversized filter", async () => {
    state.tables.project_checklists = Array.from({ length: 230 }, (_, i) => ({ id: `c${i}`, project_id: "p1", title: `L${i}`, status: "open" }));
    await gatherProjectQualityEvidence("p1");
    expect(state.inCalls.filter((c) => c.table === "checklist_items").map((c) => c.n)).toEqual([100, 100, 30]);
  });

  it("the automated sweep and the AI assessment are named as automated; a person is named as themselves", () => {
    expect(checklistItemDecider({ updated_by: null, updated_by_name: MACHINE_ACTOR_SWEEP })).toEqual({ who: `${MACHINE_ACTOR_SWEEP} (automated)`, automated: true });
    expect(checklistItemDecider({ updated_by: null, updated_by_name: MACHINE_ACTOR_ASSESSMENT }).automated).toBe(true);
    expect(checklistItemDecider({ updated_by: "u-b", updated_by_name: "jchen" })).toEqual({ who: "jchen", automated: false });
    // a person's id with a machine-looking name is still the person
    expect(checklistItemDecider({ updated_by: "u-b", updated_by_name: MACHINE_ACTOR_SWEEP }).automated).toBe(false);
  });

  it("renders the three sections before the audit trail: the sweep's green marked [automated] with its citation, the person's N/A with their reason", async () => {
    const html = renderProjectEvidenceHtml(await gatherProjectEvidence("p1"));
    const at = (s: string) => html.indexOf(s);
    expect(at("<h2>Checklists — PSSR / MI / QA-QC (2)</h2>")).toBeGreaterThan(at("<h2>Transmittals"));
    expect(at("<h2>Turnover package (2)</h2>")).toBeGreaterThan(at("<h2>Checklists"));
    expect(at("<h2>Punch list (1)</h2>")).toBeGreaterThan(at("<h2>Turnover package"));
    expect(at("<h2>Audit trail")).toBeGreaterThan(at("<h2>Punch list"));
    expect(html).toMatch(/<tr class="autorow">[\s\S]*?Hydrotest records on file[\s\S]*?<b>satisfied<\/b> <span class="auto">\[automated\]<\/span>[\s\S]*?E-301 Hydrotest Report[\s\S]*?\[automated citation\]/);
    expect(html).toMatch(/Relief valves tagged[\s\S]*?<b>na<\/b>[\s\S]*?jchen[\s\S]*?Reason: No relief valves in this scope/);
    expect(html).toContain("completed");
    expect(html).toContain("(basis: human)");
    expect(html).toContain("legacy photo"); // a legacy single-object chip is still printed
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toMatch(/Weld map[\s\S]*?<b>waived<\/b>[\s\S]*?pat[\s\S]*?Weld log accepted instead/);
    expect(html).toContain("Spare parts list <span class=\"small\">(optional)</span>");
    expect(html).toMatch(/Missing insulation <span class="small">Rack 3<\/span>[\s\S]*?<b>done<\/b>[\s\S]*?jchen[\s\S]*?Insulated 9\/26/);
  });

  it("a failed read is said to have failed — the section is left out, never printed as 'none'", async () => {
    state.errors.turnover_items = "permission denied";
    state.errors.checklist_items = "timeout";
    const html = renderProjectEvidenceHtml(await gatherProjectEvidence("p1"));
    expect(html).toContain("Could not read the turnover items — this section is left out, not empty.");
    expect(html).toContain("Could not read the checklist items — this section is left out, not empty.");
    expect(html).not.toContain("No turnover items.");
    expect(html).toContain("<h2>Punch list (1)</h2>");
  });

  it("the footer says what the pack covers and what it does not", async () => {
    const html = renderProjectEvidenceHtml(await gatherProjectEvidence("p1"));
    expect(PROJECT_PACK_COVERAGE).toMatch(/the quality program \(every checklist with its items, the turnover package and the punch list\)/);
    expect(PROJECT_PACK_COVERAGE).toMatch(/Not included: the documents themselves/);
    expect(html).toContain("the quality program (every checklist with its items, the turnover package and the punch list)");
  });
});
