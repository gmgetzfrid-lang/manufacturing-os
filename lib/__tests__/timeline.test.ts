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
//   SAF-6 / PERF-8  every id list is read TIMELINE_ID_CHUNK ids per request —
//           a project with hundreds of quotes or drawings never sends one
//           oversized filter — and one failed chunk fails the read
//   SAF-6 / SAF-17  the id lists themselves (the project's cost documents,
//           its register, its doc_removed rows) are read whole, paged by id
//           under PostgREST's 1,000-row cap — an award on the oldest of 600
//           quotes and the detach cutoff past row 1,000 still count

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  /** A read of `table` whose .in() list names `id` is refused (a 414 at the gateway, say). */
  failIn: null as { table: string; id: string } | null,
}));

/** A filtering chain: eq / in / not-in / the PostgREST .or() over review_state
 *  are applied to static rows so the queries are exercised, not just called. */
/** PostgREST's max-rows: a read with no range returns at most this many. */
const MAX_ROWS = 1000;
function chain(table: string) {
  const preds: Array<(r: Record<string, unknown>) => boolean> = [];
  let limit: number | null = null;
  let range: [number, number] | null = null;
  let order: [string, boolean] | null = null;
  let failed = false;
  const result = () => {
    let out = (state.rows[table] ?? []).filter((r) => preds.every((p) => p(r)));
    if (order) {
      const [col, asc] = order;
      out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : String(a[col]) > String(b[col]) ? (asc ? 1 : -1) : 0));
    }
    if (range) return out.slice(range[0], Math.min(range[1] + 1, range[0] + MAX_ROWS));
    return out.slice(0, Math.min(limit ?? MAX_ROWS, MAX_ROWS));
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(failed ? { data: null, error: { message: "Request-URI Too Long" } } : { data: result(), error: null });
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        const [col, a1, a2] = args as [string, unknown, unknown];
        if (prop === "eq") preds.push((r) => r[col] === a1);
        if (prop === "in") preds.push((r) => (a1 as unknown[]).includes(r[col]));
        if (prop === "in" && state.failIn?.table === table && (a1 as unknown[]).includes(state.failIn.id)) failed = true;
        if (prop === "not" && a1 === "in") {
          const list = String(a2).replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
          preds.push((r) => !list.includes(String(r[col])));
        }
        if (prop === "or" && col === "review_state.is.null,review_state.eq.approved") {
          preds.push((r) => r.review_state == null || r.review_state === "approved");
        }
        if (prop === "order") order = [col, (a1 as { ascending?: boolean } | undefined)?.ascending !== false];
        if (prop === "limit") limit = Number(col);
        if (prop === "range") range = [Number(col), Number(a1)];
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
  isProjectFeedAction, detachCutoffs, summarizeAudit, CONTROLLED_VERSIONS_ONLY, TIMELINE_ID_CHUNK,
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

beforeEach(() => { state.rows = {}; state.calls = []; state.failIn = null; });

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

describe("SAF-6 / PERF-8 — a busy project's id lists are read in chunks", () => {
  const inSizes = (table: string, col: string) => state.calls
    .filter((c) => c.table === table && c.method === "in" && c.args[0] === col)
    .map((c) => (c.args[1] as unknown[]).length);

  it("250 quotes and 230 drawings: every .in() carries at most 100 ids, and an event from the last chunk still reaches the feed", async () => {
    expect(TIMELINE_ID_CHUNK).toBe(100);
    state.rows.project_activity = [];
    state.rows.cost_documents = Array.from({ length: 250 }, (_, i) => ({ id: `q${i}`, project_id: "p1", created_at: `2026-08-${String((i % 28) + 1).padStart(2, "0")}` }));
    state.rows.project_documents = Array.from({ length: 230 }, (_, i) => ({ project_id: "p1", document_id: `d${i}` }));
    state.rows.audit_logs = [
      audit("21", "COST_DOC_AWARDED", { resource_type: "cost", resource_id: "q249", details: { vendor: "Gulf Mechanical", total: 48000 } }),
      audit("22", "REV_UP", { resource_type: "document", resource_id: "d229" }),
    ];
    state.rows.document_versions = [version("v1", "d228", "approved", "2026-09-23T10:00:00Z")];
    state.rows.document_holds = [];
    const events = await getProjectTimeline({ projectId: "p1" });
    expect(inSizes("audit_logs", "resource_id")).toEqual([100, 100, 50, 100, 100, 30]); // cost docs, then documents
    expect(inSizes("document_versions", "record_id")).toEqual([100, 100, 30]);
    expect(inSizes("document_holds", "document_id")).toEqual([100, 100, 30]);
    const ids = events.map((e) => e.id);
    expect(ids).toContain("audit:21");
    expect(ids).toContain("audit:22");
    expect(ids).toContain("version:v1");
    // The merged feed is still newest-first and capped at the limit.
    const capped = await getProjectTimeline({ projectId: "p1", limit: 2 });
    expect(capped.map((e) => e.id)).toEqual(["version:v1", "audit:22"]);
  });

  it("600 quotes: an award on the OLDEST one still reaches the feed — the cost-document read is paged by id, never capped", async () => {
    state.rows.project_activity = [];
    state.rows.project_documents = [];
    // q000 is the oldest by created_at; the old read took the newest 500.
    state.rows.cost_documents = Array.from({ length: 600 }, (_, i) => ({
      id: `q${String(i).padStart(3, "0")}`, project_id: "p1", created_at: `2026-${String(1 + Math.floor(i / 60)).padStart(2, "0")}-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
    }));
    state.rows.audit_logs = [
      audit("24", "COST_DOC_AWARDED", { resource_type: "cost", resource_id: "q000", details: { vendor: "Oldest Bidder", total: 1000 } }),
    ];
    const events = await getProjectTimeline({ projectId: "p1" });
    expect(events.map((e) => e.summary)).toContain("Quote awarded — Oldest Bidder (1,000)");
    // Every cost document id was asked for (600 ids, 100 per request), and
    // the cost-document read itself went by range, ordered by id.
    expect(inSizes("audit_logs", "resource_id")).toEqual([100, 100, 100, 100, 100, 100]);
    const costReads = state.calls.filter((c) => c.table === "cost_documents");
    expect(costReads.some((c) => c.method === "range")).toBe(true);
    expect(costReads.some((c) => c.method === "limit")).toBe(false);
    expect(costReads.filter((c) => c.method === "order").map((c) => c.args[0])).toEqual(["id"]);
  });

  it("1,200 doc_removed rows and 1,100 links: the detach cutoff past row 1,000 and the link past row 1,000 both hold", async () => {
    state.rows.cost_documents = [];
    // 1,199 detaches of other documents, then the one that matters (id sorts last).
    state.rows.project_activity = [
      ...Array.from({ length: 1199 }, (_, i) => ({
        id: `act-${String(i).padStart(4, "0")}`, project_id: "p1", org_id: "o1", user_id: "own", user_name: "own", type: "doc_removed",
        body: "removed", metadata: { documentId: `old${i}` }, created_at: "2026-01-01T00:00:00Z",
      })),
      {
        id: "act-9999", project_id: "p1", org_id: "o1", user_id: "own", user_name: "own", type: "doc_removed",
        body: "ISO-100 removed from the project", metadata: { documentId: "dx" }, created_at: "2026-09-10T10:00:00Z",
      },
    ];
    // 1,100 linked documents; the one with an event sorts last by id.
    state.rows.project_documents = Array.from({ length: 1100 }, (_, i) => ({ id: `pd-${String(i).padStart(4, "0")}`, project_id: "p1", document_id: `ln${i}` }));
    state.rows.audit_logs = [
      audit("1", "CHECK_OUT", { resource_type: "document", resource_id: "dx", timestamp: "2026-09-05T10:00:00Z" }),
      audit("2", "REV_UP", { resource_type: "document", resource_id: "dx", timestamp: "2026-09-12T10:00:00Z" }),
      audit("3", "REV_UP", { resource_type: "document", resource_id: "ln1099", timestamp: "2026-09-13T10:00:00Z" }),
    ];
    state.rows.document_versions = [];
    state.rows.document_holds = [];
    const ids = (await getProjectTimeline({ projectId: "p1", limit: 500 })).map((e) => e.id);
    expect(ids).toContain("audit:1");      // before the detach: the project's
    expect(ids).not.toContain("audit:2");  // after it: not the project's
    expect(ids).toContain("audit:3");      // the 1,100th link's history
    const ranges = (table: string) => state.calls.filter((c) => c.table === table && c.method === "range").map((c) => c.args[0]);
    expect(ranges("project_documents")).toEqual([0, 1000]);
    expect(ranges("project_activity")).toEqual([0, 1000]);
  });

  it("one refused chunk fails the read — a partial feed is never shown as the whole one", async () => {
    state.rows.project_activity = [];
    state.rows.cost_documents = [];
    state.rows.project_documents = Array.from({ length: 150 }, (_, i) => ({ project_id: "p1", document_id: `d${i}` }));
    state.failIn = { table: "document_versions", id: "d149" };
    await expect(getProjectTimeline({ projectId: "p1" })).rejects.toThrow(/Request-URI Too Long/);
  });
});

describe("SEC-21 (projects Round G J12, review fix 6) — the database's scope stamp is not an event", () => {
  // 20261157's record_milestone_scope_on_delete writes MILESTONE_SCOPE_RECORDED on the milestone's document as
  // a signed-in caller deletes it; lib/milestones.ts then writes MILESTONE_DELETED on the same document.
  const pair = () => [
    audit("21", "MILESTONE_SCOPE_RECORDED", { resource_type: "document", resource_id: "d1", details: { milestoneId: "m1", name: "Hydrotest", projectId: "p1", projectIdFrom: "milestone" }, timestamp: "2026-09-21T10:00:00Z" }),
    audit("22", "MILESTONE_DELETED", { resource_type: "document", resource_id: "d1", details: { milestoneId: "m1", name: "Hydrotest", projectId: "p1", projectIdFrom: "milestone" }, timestamp: "2026-09-21T10:00:01Z" }),
  ];
  it("the document timeline shows one milestone delete as one entry", async () => {
    state.rows.audit_logs = pair();
    const events = await getDocumentTimeline({ documentId: "d1" });
    expect(events.map((e) => e.summary)).toEqual(["Milestone deleted: Hydrotest"]);
  });
  it("the project feed's linked-document rows show it once too", async () => {
    state.rows.project_activity = [];
    state.rows.cost_documents = [];
    state.rows.project_documents = [{ id: "pd1", project_id: "p1", document_id: "d1" }];
    state.rows.audit_logs = pair();
    const events = await getProjectTimeline({ projectId: "p1" });
    expect(events.filter((e) => e.resourceId === "d1").map((e) => e.summary)).toEqual(["Milestone deleted: Hydrotest"]);
  });
  it("the stamp is classed in the one vocabulary, as MILESTONE_DELETED is; the set names it alone", async () => {
    const { SCOPE_STAMP_ACTIONS } = await import("@/lib/timeline");
    expect([...SCOPE_STAMP_ACTIONS]).toEqual(["MILESTONE_SCOPE_RECORDED"]);
    expect(PROJECT_EVENT_VOCABULARY.MILESTONE_SCOPE_RECORDED).toBe("noise");
    expect(hiddenProjectActions()).toContain("MILESTONE_SCOPE_RECORDED");
    // the label stays for the raw audit lists (the admin audit page shows every row)
    expect(summarizeAudit({ action: "MILESTONE_SCOPE_RECORDED", details: { name: "Hydrotest" } })).toBe("Milestone deletion recorded by the database: Hydrotest");
  });

  // J12 review fix 7: the stamp is left out IN THE QUERY, before the row limit — filtered only after it,
  // a window of `limit` rows held about half as many events (each delete's stamp took a row).
  const pairs = (n: number) => Array.from({ length: n }, (_, i) => {
    const at = (s: number) => `2026-09-${String(10 + i).padStart(2, "0")}T10:00:0${s}Z`;
    return [
      audit(`s${i}`, "MILESTONE_SCOPE_RECORDED", { resource_type: "document", resource_id: "d1", details: { milestoneId: `m${i}`, name: `Task ${i}` }, timestamp: at(0) }),
      audit(`d${i}`, "MILESTONE_DELETED", { resource_type: "document", resource_id: "d1", details: { milestoneId: `m${i}`, name: `Task ${i}` }, timestamp: at(1) }),
    ];
  }).flat();
  const stampFilter = { table: "audit_logs", method: "not", args: ["action", "in", '("MILESTONE_SCOPE_RECORDED")'] };
  it("the document timeline's read leaves the stamp out in the query: a 4-row window is 4 deletes, not 2", async () => {
    state.rows.audit_logs = pairs(4);
    const events = await getDocumentTimeline({ documentId: "d1", limit: 4 });
    expect(events.map((e) => e.summary)).toEqual(["Milestone deleted: Task 3", "Milestone deleted: Task 2", "Milestone deleted: Task 1", "Milestone deleted: Task 0"]);
    expect(state.calls).toContainEqual(stampFilter);
  });
  it("the project feed's linked-document read does too", async () => {
    state.rows.project_activity = [];
    state.rows.cost_documents = [];
    state.rows.project_documents = [{ id: "pd1", project_id: "p1", document_id: "d1" }];
    state.rows.audit_logs = pairs(4);
    const events = await getProjectTimeline({ projectId: "p1", limit: 4 });
    expect(events.filter((e) => e.resourceId === "d1").map((e) => e.summary)).toEqual(["Milestone deleted: Task 3", "Milestone deleted: Task 2", "Milestone deleted: Task 1", "Milestone deleted: Task 0"]);
    expect(state.calls.filter((c) => c.table === "audit_logs" && c.method === "not" && c.args[1] === "in" && c.args[2] === '("MILESTONE_SCOPE_RECORDED")')).toHaveLength(1);
  });
});
