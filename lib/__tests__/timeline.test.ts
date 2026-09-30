// projects Round G — J8 PROJECT-MODEL, lib/timeline.ts (projects-tab GAP-408):
//
//   SAF-6   the project timeline reads the controls program's project- and
//           cost-scoped audit rows through ONE vocabulary map: an award, a
//           change-order decision, a checklist ruling, a turnover review and
//           a punch close reach the feed; cost entries and item-by-item
//           checklist edits stay in audit_logs; status rows are not doubled
//   SAF-16  the three readers apply one visibility rule to document_versions
//           — an in-review or rejected draft never reaches the project feed
//   SAF-17  a detached document's history up to its detach stays on the
//           project timeline; what happens to it afterwards does not

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));

/** A filtering chain: eq / in / not-in / the PostgREST .or() over review_state
 *  are applied to static rows so the queries are exercised, not just called. */
function chain(table: string) {
  const preds: Array<(r: Record<string, unknown>) => boolean> = [];
  let limit: number | null = null;
  let order: [string, boolean] | null = null;
  const result = () => {
    let out = (state.rows[table] ?? []).filter((r) => preds.every((p) => p(r)));
    if (order) {
      const [col, asc] = order;
      out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : String(a[col]) > String(b[col]) ? (asc ? 1 : -1) : 0));
    }
    return limit === null ? out : out.slice(0, limit);
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: result(), error: null });
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        const [col, a1, a2] = args as [string, unknown, unknown];
        if (prop === "eq") preds.push((r) => r[col] === a1);
        if (prop === "in") preds.push((r) => (a1 as unknown[]).includes(r[col]));
        if (prop === "not" && a1 === "in") {
          const list = String(a2).replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
          preds.push((r) => !list.includes(String(r[col])));
        }
        if (prop === "or" && col === "review_state.is.null,review_state.eq.approved") {
          preds.push((r) => r.review_state == null || r.review_state === "approved");
        }
        if (prop === "order") order = [col, (a1 as { ascending?: boolean } | undefined)?.ascending !== false];
        if (prop === "limit") limit = Number(col);
        if (prop === "maybeSingle") return Promise.resolve({ data: result()[0] ?? null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));

import {
  getProjectTimeline, getDocumentTimeline, PROJECT_EVENT_VOCABULARY, hiddenProjectActions,
  isProjectFeedAction, detachCutoffs, summarizeAudit, CONTROLLED_VERSIONS_ONLY,
} from "@/lib/timeline";

const audit = (id: string, action: string, over: Record<string, unknown> = {}) => ({
  id, action, resource_type: "project", resource_id: "p1", org_id: "o1", user_id: "u1",
  user_email: "u1@x.io", user_role: null, details: {}, metadata: null, timestamp: `2026-09-${id.padStart(2, "0")}T10:00:00Z`, ...over,
});
const version = (id: string, record: string, review: string | null, created: string) => ({
  id, org_id: "o1", record_id: record, revision_label: id.toUpperCase(), issue_type: null, change_type: null, change_log: null,
  created_by: "u1", created_by_name: "ann", created_at: created, released_at: null, superseded_at: null, moc_reference: null,
  supersedes_version_id: null, reverted_from_version_id: null, drawn_by_name: null, checked_by_name: null, approved_by_name: null,
  file_hash: null, source_file_name: null, review_state: review,
});

beforeEach(() => { state.rows = {}; state.calls = []; });

describe("SAF-6 — the controls program reaches the project's Activity tab", () => {
  it("an award, an approved change order, a turnover acceptance and a checklist ruling all appear; noise and mirrored rows do not", async () => {
    state.rows.project_activity = [{ id: "a1", project_id: "p1", org_id: "o1", user_id: "u1", user_name: "ann", type: "status_changed", body: "Project completed", metadata: null, created_at: "2026-09-20T10:00:00Z" }];
    state.rows.project_documents = [];
    state.rows.cost_documents = [{ id: "q1", project_id: "p1", created_at: "2026-09-01" }];
    state.rows.audit_logs = [
      audit("2", "CHANGE_ORDER_APPROVED", { details: { coNumber: "CO-003", amount: 12500 } }),
      audit("3", "TURNOVER_REVIEWED", { details: { name: "NDE reports", status: "accepted" } }),
      audit("4", "CHECKLIST_STATUS", { details: { status: "complete", title: "PSSR — Unit 300" } }),
      audit("5", "CHECKLIST_ITEM_UPDATED", { details: { itemId: "i1" } }),          // noise
      audit("6", "PROJECT_COMPLETED", { details: { reason: "done" } }),              // mirrored by the activity row
      audit("7", "COST_DOC_AWARDED", { resource_type: "cost", resource_id: "q1", details: { vendor: "Gulf Mechanical", total: 48000 } }),
      audit("8", "COST_ENTRY_POSTED", { resource_type: "cost", resource_id: "q1" }), // noise
      audit("9", "CHANGE_ORDER_APPROVED", { resource_id: "p-other" }),              // another project's
      audit("10", "PUNCH_STATUS", { details: { title: "Insulation at PSV-12", status: "done" } }),
    ];
    const events = await getProjectTimeline({ projectId: "p1" });
    const summaries = events.map((e) => e.summary);
    expect(summaries).toContain("Quote awarded — Gulf Mechanical (48,000)");
    expect(summaries).toContain("Change order approved CO-003 (12,500)");
    expect(summaries).toContain("Turnover accepted: NDE reports");
    expect(summaries).toContain("Checklist completed: PSSR — Unit 300");
    expect(summaries).toContain("Punch item closed: Insulation at PSV-12");
    const actions = events.map((e) => e.action);
    expect(actions).not.toContain("CHECKLIST_ITEM_UPDATED");
    expect(actions).not.toContain("COST_ENTRY_POSTED");
    expect(actions).not.toContain("PROJECT_COMPLETED");
    expect(events.filter((e) => e.action === "CHANGE_ORDER_APPROVED")).toHaveLength(1);
    // Noise is filtered IN the query (not fetched, then dropped).
    const nots = state.calls.filter((c) => c.table === "audit_logs" && c.method === "not");
    expect(nots).toHaveLength(2);
    for (const n of nots) expect(String(n.args[2])).toContain('"CHECKLIST_ITEM_UPDATED"');
  });

  it("the vocabulary is ONE map; an unclassified action is SHOWN, never silently dropped", () => {
    for (const a of ["COST_DOC_AWARDED", "CHANGE_ORDER_APPROVED", "CHANGE_ORDER_REJECTED", "CHECKLIST_STATUS", "CHECKLIST_ASSESSED", "TURNOVER_REVIEWED", "PUNCH_STATUS"]) {
      expect(PROJECT_EVENT_VOCABULARY[a], a).toBe("milestone");
    }
    for (const a of ["COST_ENTRY_POSTED", "COST_ENTRY_VOIDED", "CHECKLIST_ITEM_UPDATED"]) expect(PROJECT_EVENT_VOCABULARY[a], a).toBe("noise");
    expect(isProjectFeedAction("SOMETHING_NEW_NEXT_YEAR")).toBe(true);
    expect(hiddenProjectActions()).not.toContain("COST_DOC_AWARDED");
    expect(hiddenProjectActions()).toContain("PROJECT_COMPLETED");
    // The MILESTONE_* summarizers the reader carried for years now execute.
    expect(summarizeAudit({ action: "MILESTONE_MISSED", details: { name: "Hydrotest" } })).toBe("Milestone missed: Hydrotest");
    // The map lives in lib/timeline.ts and nowhere else.
    const src = readFileSync(join(process.cwd(), "lib/timeline.ts"), "utf8");
    expect(src.match(/PROJECT_EVENT_VOCABULARY: Readonly<Record<string, ProjectEventClass>> = \{/g)).toHaveLength(1);
  });
});

describe("SAF-16 — one visibility rule for versions in every timeline reader", () => {
  it("an in-review or rejected version of a linked document does not reach the project timeline", async () => {
    state.rows.project_activity = [];
    state.rows.project_documents = [{ project_id: "p1", document_id: "d1" }];
    state.rows.document_versions = [
      version("v1", "d1", null, "2026-09-01T10:00:00Z"),
      version("v2", "d1", "approved", "2026-09-02T10:00:00Z"),
      version("v3", "d1", "in_review", "2026-09-03T10:00:00Z"),
      version("v4", "d1", "rejected", "2026-09-04T10:00:00Z"),
    ];
    const events = await getProjectTimeline({ projectId: "p1" });
    expect(events.filter((e) => e.kind === "version").map((e) => e.id).sort()).toEqual(["version:v1", "version:v2"]);
  });

  it("the document timeline, the revision chain and the project timeline all read CONTROLLED_VERSIONS_ONLY", async () => {
    const src = readFileSync(join(process.cwd(), "lib/timeline.ts"), "utf8");
    expect(src.match(/\.or\(CONTROLLED_VERSIONS_ONLY\)/g)).toHaveLength(3);
    expect(src).not.toMatch(/\.or\("review_state\.is\.null,review_state\.eq\.approved"\)/);
    expect(CONTROLLED_VERSIONS_ONLY).toBe("review_state.is.null,review_state.eq.approved");
    state.rows.document_versions = [version("v9", "d9", "in_review", "2026-09-03T10:00:00Z")];
    expect((await getDocumentTimeline({ documentId: "d9" })).filter((e) => e.kind === "version")).toEqual([]);
  });
});

describe("SAF-17 — detaching a document keeps its history on the project", () => {
  it("a detached document's events up to the detach remain; later ones are not the project's", async () => {
    state.rows.project_documents = [];                                        // d1 was detached
    state.rows.project_activity = [{
      id: "act-rm", project_id: "p1", org_id: "o1", user_id: "own", user_name: "own", type: "doc_removed",
      body: "ISO-100 removed from the project", metadata: { documentId: "d1" }, created_at: "2026-09-10T10:00:00Z",
    }];
    state.rows.audit_logs = [
      audit("1", "CHECK_OUT", { resource_type: "document", resource_id: "d1", timestamp: "2026-09-05T10:00:00Z" }),
      audit("2", "REV_UP", { resource_type: "document", resource_id: "d1", timestamp: "2026-09-12T10:00:00Z" }),
    ];
    const events = await getProjectTimeline({ projectId: "p1" });
    expect(events.map((e) => e.id)).toContain("audit:1");
    expect(events.map((e) => e.id)).not.toContain("audit:2");
    expect(events.map((e) => e.id)).toContain("activity:act-rm");
  });

  it("detachCutoffs: the latest detach wins; a re-linked document is simply linked", () => {
    const rows = [
      { metadata: { documentId: "d1" }, created_at: "2026-09-01T00:00:00Z" },
      { metadata: { documentId: "d1" }, created_at: "2026-09-08T00:00:00Z" },
      { metadata: { documentId: "d2" }, created_at: "2026-09-03T00:00:00Z" },
      { metadata: null, created_at: "2026-09-04T00:00:00Z" },
    ];
    expect([...detachCutoffs(rows, new Set(["d2"])).entries()]).toEqual([["d1", "2026-09-08T00:00:00Z"]]);
  });
});
