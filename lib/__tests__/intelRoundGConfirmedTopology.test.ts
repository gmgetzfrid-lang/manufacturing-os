// intelligence Round G, I-21 CONFIRMED TOPOLOGY — FLOW-14 / GAP-315, and
// ING-10's residual.
//
// The plant's CONFIRMED process flows become a reasoning input for the
// orchestrator's line trace (`trace_pid_lines`): lib/processFlows
// `flowsToLineEdges` reads confirmed rows only — never a proposal, never a
// dismissed row — and lib/orchestrator/tools `loadLineGraph` merges them with
// the sheet co-occurrence graph, each edge naming its basis (lib/pidTrace
// LineEdge.basis), under the same hidden-sheet filter. Its tag-index read is
// paged to the end or to a ceiling, the way the DRAWING FACTS census is.
//
// REGRESSION (the top rule): an org with no confirmed flows — none at all,
// only proposals or dismissals, or a database without the flow table — traces
// EXACTLY as before. The goldens below are the base commit's (6797c48)
// outputs for the same seeds, key order included. So does an equipment-to-
// equipment trace in an org whose only flows have a unit end (fix pass): a
// unit is a whole operating unit, never walked through. And so does any
// answer that does not rest on a confirmed flow, whatever flows the org
// holds elsewhere (fix pass 2): the flows are named only by a route with a
// flow step, a no-route answer at a flow's end (or whose reason the flows
// change), and a neighbourhood a flow reaches into or with feeds / fed_by.
// And a step a confirmed flow takes still cites the sheets that carry its
// pair (fix pass 3: `also_on_sheet`, kept in `drawings`), so where the route
// is the sheets' own, no sheet the base cited is lost. The tag index is paged
// by key (a write mid-read skips no sheet), and the flow read is bounded on
// the trace's clock. Where a flow's route is not the sheets' own (it skips
// equipment the drawings put between the ends), the sheets' route is named
// beside it (fix pass 4: `sheet_route`, the base answer's path and sheets). A
// page that fails behind good pages is a stop, not a lost read; a run reads
// the graph once; and the readability checks have their own time.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
type Err = { code?: string; message: string };

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  errors: {} as Record<string, Err>,
  /** Every query: which client ran it, on what table, with which calls. */
  queries: [] as Array<{ client: string; table: string; calls: Array<[string, unknown[]]> }>,
  /** Controlled documents the caller may read (readableControlledDocIds). */
  readable: new Set<string>(),
  /** A status filter on process_flows that does not hold (belt and braces). */
  ignoreStatusFilter: false,
  /** PostgREST's max-rows: no response holds more rows than this. */
  maxRows: Number.POSITIVE_INFINITY,
  /** A paged read's failure: a page of the table whose first row is this row
   *  of the ordered read, or a later one, fails. */
  pageErrors: {} as Record<string, { from: number; error: Err }>,
  /** The clock Date.now reads, what each tag-index page costs on it, and what
   *  any one query of a table costs on it. */
  now: 0,
  pageCostMs: 0,
  costMs: {} as Record<string, number>,
  /** A failure for one query shape only (a table-wide one is `errors`). */
  failQuery: null as null | ((table: string, calls: Array<[string, unknown[]]>) => Err | null),
  /** The tag-index pages served: where each began in the ordered read. */
  tagPageStarts: [] as number[],
  /** Runs before each tag-index page is answered (a write landing mid-read). */
  beforeTagPage: null as null | ((served: number) => void),
}));

/** A query's filtered, ordered rows, per table array (a seed replaces it) and
 *  per query shape (every call but the window and the keyset cursor): a paged
 *  read of a 50,000-row table filters and sorts once, not once a page. */
const shaped = new WeakMap<Row[], Map<string, Row[]>>();

/** How the fake compares a column with a value, in sorting and in filters:
 *  numbers as numbers (a page), everything else by code unit. */
function cmpCol(x: unknown, y: unknown): number {
  if (typeof x === "number") return x - Number(y);
  const a = String(x ?? ""), b = String(y ?? "");
  return a === b ? 0 : a < b ? -1 : 1;
}

/** A PostgREST `.or()` list as a row predicate: terms split on commas
 *  outside double quotes and parentheses; `and(…)` / `or(…)` nest; a quoted
 *  value is unescaped (backslash escapes); eq / neq / gt / gte / lt / lte. */
function orPredicate(list: string): (r: Row) => boolean {
  const split = (text: string): string[] => {
    const out: string[] = [];
    let cur = ""; let quoted = false; let depth = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted && ch === "\\") { cur += ch + text[i + 1]; i += 1; continue; }
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === "(") depth += 1;
      else if (!quoted && ch === ")") depth -= 1;
      if (!quoted && depth === 0 && ch === ",") { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  };
  const term = (t: string): ((r: Row) => boolean) => {
    const nested = /^(and|or)\(([\s\S]*)\)$/.exec(t);
    if (nested) {
      const parts = split(nested[2]).map(term);
      return nested[1] === "and" ? (r) => parts.every((f) => f(r)) : (r) => parts.some((f) => f(r));
    }
    const i = t.indexOf("."), j = t.indexOf(".", i + 1);
    const col = t.slice(0, i), op = t.slice(i + 1, j);
    let value = t.slice(j + 1);
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    const test: Record<string, (c: number) => boolean> = {
      eq: (c) => c === 0, neq: (c) => c !== 0, gt: (c) => c > 0, gte: (c) => c >= 0, lt: (c) => c < 0, lte: (c) => c <= 0,
    };
    if (!test[op]) throw new Error(`the fake does not read ${op} in an .or() list`);
    return (r) => test[op](cmpCol(r[col], value));
  };
  const parts = split(list).map(term);
  return (r) => parts.some((f) => f(r));
}

function makeChain(client: string, table: string): unknown {
  const calls: Array<[string, unknown[]]> = [];
  db.queries.push({ client, table, calls });
  const result = (): { data: Row[] | null; error: Err | null } => {
    if (db.errors[table]) return { data: null, error: db.errors[table] };
    const failed = db.failQuery?.(table, calls);
    if (failed) return { data: null, error: failed };
    // A tag-index page: the trace's ordered, keyset-paged read.
    const tagPage = table === "knowledge_page_entities" && calls.some(([c]) => c === "order");
    if (tagPage) { db.beforeTagPage?.(db.tagPageStarts.length); db.now += db.pageCostMs; }
    db.now += db.costMs[table] ?? 0;
    const source = db.tables[table] ?? [];
    let win: { from: number; to: number } | null = null;
    let cap: number | null = null;
    for (const [m, a] of calls) {
      if (m === "range") win = { from: Number(a[0]), to: Number(a[1]) };
      else if (m === "limit") cap = Number(a[0]);
    }
    const cursorCalls = new Set(["range", "limit", "gte", "or"]);
    const shape = JSON.stringify([db.ignoreStatusFilter, calls.filter(([m]) => !cursorCalls.has(m))]);
    const byShape = shaped.get(source) ?? new Map<string, Row[]>();
    shaped.set(source, byShape);
    let rows = byShape.get(shape);
    if (!rows) {
      rows = [...source];
      const orders: Array<{ col: string; asc: boolean }> = [];
      for (const [m, a] of calls) {
        const col = String(a[0]);
        if (m === "eq") {
          if (table === "process_flows" && col === "status" && db.ignoreStatusFilter) continue;
          rows = rows.filter((r) => r[col] === a[1]);
        } else if (m === "in") rows = rows.filter((r) => (a[1] as unknown[]).includes(r[col]));
        else if (m === "gt") rows = rows.filter((r) => String(r[col]) > String(a[1]));
        else if (m === "not" && a[1] === "is" && a[2] === null) rows = rows.filter((r) => r[col] != null);
        else if (m === "order") orders.push({ col, asc: (a[1] as { ascending?: boolean } | undefined)?.ascending !== false });
      }
      if (orders.length > 0) {
        rows.sort((x, y) => {
          for (const o of orders) {
            const c = cmpCol(x[o.col], y[o.col]);
            if (c !== 0) return c * (o.asc ? 1 : -1);
          }
          return 0;
        });
      }
      byShape.set(shape, rows);
    }
    // The keyset cursor (`gte` and `or`), on the memoised order: a page's
    // rows, and where in the ordered read it begins.
    const ordered = rows;
    const keep: Array<(r: Row) => boolean> = [];
    for (const [m, a] of calls) {
      if (m === "gte") keep.push((r) => cmpCol(r[String(a[0])], a[1]) >= 0);
      else if (m === "or") keep.push(orPredicate(String(a[0])));
    }
    // A copy, always: the code under test never holds the memoised array.
    rows = keep.length > 0 ? ordered.filter((r) => keep.every((f) => f(r))) : ordered.slice();
    const start = win ? win.from : rows.length > 0 ? ordered.indexOf(rows[0]) : ordered.length;
    if (tagPage) db.tagPageStarts.push(start);
    const failAt = db.pageErrors[table];
    if (tagPage && failAt && start >= failAt.from) return { data: null, error: failAt.error };
    if (win) rows = rows.slice(win.from, win.to + 1);
    if (cap !== null) rows = rows.slice(0, cap);
    if (rows.length > db.maxRows) rows = rows.slice(0, db.maxRows);
    return { data: rows, error: null };
  };
  const h: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === "then") {
        const out = result();
        return (resolve: (v: unknown) => void) => resolve(out);
      }
      return (...args: unknown[]) => {
        calls.push([prop, args]);
        if (prop === "maybeSingle" || prop === "single") {
          const out = result();
          return Promise.resolve(out.error ? out : { data: (out.data ?? [])[0] ?? null, error: null });
        }
        return new Proxy({}, h);
      };
    },
  };
  return new Proxy({}, h);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: { from: (t: string) => makeChain("admin", t), rpc: async () => ({ data: null, error: null }) },
}));
vi.mock("@/lib/supabase", () => ({
  supabase: { from: (t: string) => makeChain("browser", t), rpc: async () => ({ data: null, error: null }) },
}));
vi.mock("@/lib/knowledgeAccess", () => ({
  readableControlledDocIds: vi.fn(async (_p: unknown, ids: string[]) => new Set(ids.filter((id) => db.readable.has(id)))),
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => {}) }));

import {
  toolByName, TOOLS, LINE_GRAPH_ROW_CEILING, LINE_GRAPH_READ_BUDGET_MS, LINE_GRAPH_CHECK_BUDGET_MS, type ToolContext,
} from "@/lib/orchestrator/tools";
import { flowsToLineEdges, unitTraceTag, FLOW_EDGE_CEILING, FLOW_EDGE_PAGE, FLOW_READ_OUT_OF_TIME } from "@/lib/processFlows";
import { tracePath, traceNeighbourhood, normalizeTag, type LineEdge } from "@/lib/pidTrace";
import type { KnowledgePrincipal } from "@/lib/knowledgeAccess";

const ORG = "o1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A_P101 = uuid(101), A_E204 = uuid(204), A_T150 = uuid(150), A_V300 = uuid(300), A_X999 = uuid(999);
const A_K500 = uuid(500), A_K501 = uuid(501);
/** Two more of the org's assets, on no sheet of the regression seed. */
const moreAssets = () => [
  { id: A_K500, org_id: ORG, tag: "K-500", archived: false },
  { id: A_K501, org_id: ORG, tag: "K-501", archived: false },
];

/** The sheet graph's rows: one tag occurrence each. */
let nextEnt = 0;
const ent = (document_id: string, page: number, kind: string, tag: string): Row =>
  ({ id: `e-${String(nextEnt++).padStart(7, "0")}`, org_id: ORG, document_id, page, kind, tag: normalizeTag(tag) });
let nextFlow = 0;
const flow = (from: [string, string], to: [string, string], status: string, extra: Row = {}): Row => ({
  id: `f-${String(nextFlow++).padStart(7, "0")}`, org_id: ORG,
  from_kind: from[0], from_ref: from[1], to_kind: to[0], to_ref: to[1],
  label: null, status, origin: "manual", source_document_id: null, ...extra,
});

/** Knowledge documents: k-a is an upload (org-readable); k-b mirrors a
 *  controlled drawing the Viewer cannot read; k-c one they can. */
function seedBase(extra: Partial<Record<string, Row[]>> = {}) {
  db.tables = {
    knowledge_documents: [
      { id: "k-a", org_id: ORG, name: "PID-100 SHT 1", source_document_id: null },
      { id: "k-b", org_id: ORG, name: "PID-200", source_document_id: "d-hidden" },
      { id: "k-c", org_id: ORG, name: "PFD-01", source_document_id: "d-open" },
    ],
    assets: [
      { id: A_P101, org_id: ORG, tag: "P-101", archived: false },
      { id: A_E204, org_id: ORG, tag: "E-204", archived: false },
      { id: A_T150, org_id: ORG, tag: "T-150", archived: false },
      { id: A_V300, org_id: ORG, tag: "V-300", archived: true },
      { id: A_X999, org_id: "o2", tag: "X-999", archived: false },
    ],
    codebook_entries: [
      { org_id: ORG, kind: "unit", code: "20", label: "Crude" },
      { org_id: ORG, kind: "unit", code: "30", label: "Vacuum" },
      { org_id: ORG, kind: "equipment_type", code: "21", label: "Pumps" },
    ],
    knowledge_page_entities: [],
    process_flows: [],
    ...extra,
  } as Record<string, Row[]>;
}

/** The sheets of the regression seed: P-101 and T-150 on page 1 of k-a (with
 *  a reference to PID-200), T-150 and E-204 on page 2. */
const sheetSeed = () => [
  ent("k-a", 1, "equipment", "P-101"), ent("k-a", 1, "equipment", "T-150"), ent("k-a", 1, "ref", "PID-200"),
  ent("k-a", 2, "equipment", "T-150"), ent("k-a", 2, "equipment", "E-204"),
];

function ctxFor(roles: string[]): ToolContext {
  const principal = {
    uid: "u1", orgId: ORG, role: roles[0] ?? "Viewer", roles, teamIds: [],
    isController: roles.includes("Admin") || roles.includes("DocCtrl"),
  } as unknown as KnowledgePrincipal;
  return { orgId: ORG, userId: "u1", role: roles[0] ?? "Viewer", principal, actorName: "Pat Example", approved: new Set() };
}
const trace = async (args: Record<string, string | number>, roles = ["Viewer"]) =>
  (await toolByName("trace_pid_lines")!.run(args, ctxFor(roles))).data as Record<string, unknown>;
const queriesOf = (table: string) => db.queries.filter((q) => q.table === table);
/** The trace's tag-index pages (ordered; the same-sheet lookup is not). */
const tagPages = () => queriesOf("knowledge_page_entities").filter((q) => q.calls.some(([m]) => m === "order"));
const callArgs = (q: { calls: Array<[string, unknown[]]> }, m: string) => q.calls.filter(([c]) => c === m).map(([, a]) => a);

// The base commit's basis sentence and goldens (6797c48, the same seeds).
const SHEET_BASIS =
  "Derived from equipment appearing together on the same drawing page, plus off-page "
  + "continuation references. This is sheet-level connectivity, not valve-by-valve line "
  + "tracing — intermediate components are only listed once line geometry is captured.";
/** The flow-basis sentences' openings (I-21 fix pass 2). */
const ROUTE_BASIS = /^Two sources, named per step in `route`\./;
const NO_ROUTE_BASIS = /^Searched two sources: CONFIRMED flows on the plant's process map/;
const NEAR_BASIS = /^Two sources\. `connected` is undirected and counts both/;
const GOLDEN_PATH = {
  found: true, path: ["P101", "T150", "E204"], drawings: ["k-a"], crosses_sheets: false,
  components: [], reason: undefined, basis: SHEET_BASIS,
};
const GOLDEN_SAME_SHEET = {
  found: true, path: ["P101", "T150"], drawings: ["k-a"], crosses_sheets: false,
  components: [], reason: undefined, basis: SHEET_BASIS,
  same_sheet: [{ sheet: "PID-100 SHT 1", page: 1 }],
  note:
    "Both tags are drawn on the SAME sheet — tell the reader which sheet and page, and that "
    + "the drawn connection is read off the sheet itself (the viewer rings both tags). Do not "
    + "invent the routing between them.",
};
const GOLDEN_NOT_FOUND = {
  found: false, path: [], drawings: [], crosses_sheets: false, components: [],
  reason: "X-1 doesn't appear on any traced line.", basis: SHEET_BASIS,
};
const GOLDEN_NEAR = {
  start: "T-150",
  connected: [{ tag: "E204", hops: 1 }, { tag: "P101", hops: 1 }, { tag: "PID200", hops: 1 }],
  basis: SHEET_BASIS,
};

/** Every regression case: the same output, keys in the same order. */
async function expectToday() {
  const path = await trace({ start_tag: "P-101", end_tag: "E-204" });
  expect(path).toEqual(GOLDEN_PATH);
  expect(Object.keys(path)).toEqual(Object.keys(GOLDEN_PATH));
  const same = await trace({ start_tag: "P-101", end_tag: "T-150" });
  expect(same).toEqual(GOLDEN_SAME_SHEET);
  expect(Object.keys(same)).toEqual(Object.keys(GOLDEN_SAME_SHEET));
  const none = await trace({ start_tag: "X-1", end_tag: "E-204" });
  expect(none).toEqual(GOLDEN_NOT_FOUND);
  expect(Object.keys(none)).toEqual(Object.keys(GOLDEN_NOT_FOUND));
  const near = await trace({ start_tag: "T-150", hops: 1 });
  expect(near).toEqual(GOLDEN_NEAR);
  expect(Object.keys(near)).toEqual(Object.keys(GOLDEN_NEAR));
}

let clock: { mockRestore: () => void } | null = null;
beforeEach(() => {
  db.tables = {}; db.errors = {}; db.queries = []; db.readable = new Set(["d-open"]);
  db.ignoreStatusFilter = false; db.maxRows = Number.POSITIVE_INFINITY;
  db.pageErrors = {}; db.now = 1_000_000; db.pageCostMs = 0; db.costMs = {}; db.failQuery = null;
  db.tagPageStarts = []; db.beforeTagPage = null;
  nextEnt = 0; nextFlow = 0;
  // The tag-index read's time budget reads Date.now: a test's clock moves
  // only when a page costs something, never with the machine's load.
  clock = vi.spyOn(Date, "now").mockImplementation(() => db.now);
});
afterEach(() => { clock?.mockRestore(); clock = null; });

describe("REGRESSION — an org with no confirmed flows traces exactly as before", () => {
  it("no flows at all: the path, the same-sheet hit, the not-found reason and the neighbourhood are the base commit's", async () => {
    seedBase({ knowledge_page_entities: sheetSeed() });
    await expectToday();
  });

  it("only a proposal and a dismissal between the two: neither is ever walked (the output is unchanged)", async () => {
    seedBase({
      knowledge_page_entities: sheetSeed(),
      process_flows: [
        flow(["asset", A_P101], ["asset", A_E204], "proposed", { origin: "ai", source_document_id: "k-a", label: "proposed feed" }),
        flow(["asset", A_E204], ["asset", A_P101], "dismissed", { origin: "ai", source_document_id: "k-a" }),
        flow(["unit", "20"], ["asset", A_P101], "proposed"),
      ],
    });
    await expectToday();
    // The read asked for the status column's 'confirmed' only.
    for (const q of queriesOf("process_flows")) expect(callArgs(q, "eq")).toContainEqual(["status", "confirmed"]);
  });

  it("…even when the status filter does not hold: a row that is not confirmed never becomes an edge", async () => {
    seedBase({
      knowledge_page_entities: sheetSeed(),
      process_flows: [
        flow(["asset", A_P101], ["asset", A_E204], "proposed", { origin: "ai" }),
        flow(["asset", A_E204], ["asset", A_P101], "dismissed"),
      ],
    });
    db.ignoreStatusFilter = true;
    await expectToday();
    const out = await flowsToLineEdges(ORG, { from: (t: string) => makeChain("admin", t) } as never);
    expect(out).toEqual({ edges: [], state: "ok", truncated: false, skipped: 0, unitNodes: [] });
  });

  it.each([
    ["PGRST205", "Could not find the table 'public.process_flows' in the schema cache"],
    ["42P01", 'relation "process_flows" does not exist'],
    ["42703", "column process_flows.label does not exist"],
  ])("a database without the flow table or column (%s) traces exactly as before — no note, no error", async (code, message) => {
    seedBase({ knowledge_page_entities: sheetSeed(), process_flows: [flow(["asset", A_P101], ["asset", A_E204], "confirmed")] });
    db.errors.process_flows = { code, message };
    await expectToday();
    expect(await flowsToLineEdges(ORG, { from: (t: string) => makeChain("admin", t) } as never))
      .toEqual({ edges: [], state: "missing", truncated: false, skipped: 0, unitNodes: [] });
  });

  it("a column missing on the registry read behind a confirmed flow is 'not installed' too — the trace is unchanged", async () => {
    seedBase({ knowledge_page_entities: sheetSeed(), process_flows: [flow(["asset", A_P101], ["asset", A_E204], "confirmed")] });
    db.errors.assets = { code: "42703", message: "column assets.archived does not exist" };
    await expectToday();
  });

  it("every flow confirmed but read off a sheet the caller cannot open: not walked, the output is unchanged", async () => {
    seedBase({
      knowledge_page_entities: sheetSeed(),
      process_flows: [flow(["asset", A_P101], ["asset", A_E204], "confirmed", { origin: "ai", source_document_id: "k-b" })],
    });
    await expectToday();
  });

  it("an org whose only confirmed flows have a unit end: today's equipment-to-equipment route and neighbourhood, key for key (a unit is never a hub)", async () => {
    // The drawn route is P-101 → X-1 → Y-1 → E-204 across three pages. Unit
    // 20 feeds both ends: walked through, UNIT20 would put them two runs
    // apart and displace the drawn route.
    const sheets = () => [
      ent("k-a", 1, "equipment", "P-101"), ent("k-a", 1, "equipment", "X-1"),
      ent("k-a", 2, "equipment", "X-1"), ent("k-a", 2, "equipment", "Y-1"),
      ent("k-a", 3, "equipment", "Y-1"), ent("k-a", 3, "equipment", "E-204"),
    ];
    const ask = async () => ({
      path: await trace({ start_tag: "P-101", end_tag: "E-204" }),
      nearX: await trace({ start_tag: "X-1", hops: 2 }),
      nearP: await trace({ start_tag: "P-101", hops: 2 }),
    });
    seedBase({ knowledge_page_entities: sheets() });
    const today = await ask();
    // Today's answers, literally (the base commit's for this seed).
    expect(today.path).toEqual({
      found: true, path: ["P101", "X1", "Y1", "E204"], drawings: ["k-a"], crosses_sheets: false,
      components: [], reason: undefined, basis: SHEET_BASIS,
    });
    expect(today.nearP).toEqual({ start: "P-101", connected: [{ tag: "X1", hops: 1 }, { tag: "Y1", hops: 2 }], basis: SHEET_BASIS });

    seedBase({
      knowledge_page_entities: sheets(),
      process_flows: [
        flow(["unit", "20"], ["asset", A_P101], "confirmed", { label: "crude charge" }),
        flow(["unit", "20"], ["asset", A_E204], "confirmed"),
      ],
    });
    const withUnits = await ask();
    expect(withUnits.path).toEqual(today.path);
    expect(Object.keys(withUnits.path)).toEqual(Object.keys(today.path));
    expect(withUnits.nearX).toEqual(today.nearX);
    expect(Object.keys(withUnits.nearX)).toEqual(Object.keys(today.nearX));
    // P-101 is on a unit flow: `connected` is today's (no E-204 two runs away
    // through the unit), and the directional lists name the unit and stop.
    const { confirmed_flows: directional, basis, ...rest } = withUnits.nearP;
    expect(rest).toEqual({ start: "P-101", connected: today.nearP.connected });
    expect(directional).toMatchObject({ feeds: [], fed_by: [{ tag: "UNIT20", hops: 1 }] });
    expect(String(basis)).toMatch(/A UNIT<code> tag is a whole operating unit \(a Site Codebook unit\), not a piece of equipment/);
  });
});

describe("REGRESSION (fix pass 2) — a confirmed flow the answer does not rest on changes nothing", () => {
  it("an org with confirmed flows that touch none of the traced equipment: today's path, same-sheet hit, not-found and neighbourhood, key for key", async () => {
    seedBase({
      knowledge_page_entities: sheetSeed(),
      process_flows: [
        flow(["asset", A_K500], ["asset", A_K501], "confirmed", { label: "cooling water" }),
        flow(["unit", "30"], ["asset", A_K501], "confirmed"),
      ],
    });
    db.tables.assets.push(...moreAssets());
    await expectToday();
    // Not vacuous: the flows are in the graph, and answer where they are asked about.
    const k = await trace({ start_tag: "K-500", end_tag: "K-501" });
    expect(k.route).toEqual([{ from: "K500", to: "K501", basis: "confirmed flow", flow: "K500 feeds K501", stream: "cooling water" }]);
    expect(String(k.basis)).toMatch(ROUTE_BASIS);
  });

  it("a confirmed flow at a route's own end that the route does not take: the route and the same-sheet hit are today's", async () => {
    seedBase({
      knowledge_page_entities: sheetSeed(),
      process_flows: [flow(["asset", A_P101], ["asset", A_K500], "confirmed")],
    });
    db.tables.assets.push(...moreAssets());
    const path = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(path).toEqual(GOLDEN_PATH);
    expect(Object.keys(path)).toEqual(Object.keys(GOLDEN_PATH));
    const same = await trace({ start_tag: "P-101", end_tag: "T-150" });
    expect(same).toEqual(GOLDEN_SAME_SHEET);
    expect(Object.keys(same)).toEqual(Object.keys(GOLDEN_SAME_SHEET));
  });
});

describe("GAP-315 (fix pass 2) — the answer names the flows exactly where it rests on one", () => {
  it("a neighbourhood a confirmed flow reaches into: `connected_through_flow` names those tags, the basis names no `route`, and an empty list is not 'nothing feeds it'", async () => {
    // T-150 shares a sheet with P-101; a confirmed flow P-101 → E-204. T-150
    // is on no flow, so its feeds / fed_by are empty — and E-204 is in
    // `connected` only through the flow.
    seedBase({
      knowledge_page_entities: [ent("k-a", 1, "equipment", "T-150"), ent("k-a", 1, "equipment", "P-101")],
      process_flows: [flow(["asset", A_P101], ["asset", A_E204], "confirmed")],
    });
    const out = await trace({ start_tag: "T-150", hops: 2 });
    expect(out.connected).toEqual([{ tag: "P101", hops: 1 }, { tag: "E204", hops: 2 }]);
    const cf = out.confirmed_flows as Record<string, unknown>;
    expect(cf).toMatchObject({ feeds: [], fed_by: [], connected_through_flow: ["E204"] });
    expect(String(cf.note)).toContain(
      "An empty list means no confirmed flow is recorded that way — NOT that nothing feeds it, or that it feeds nothing.",
    );
    expect(String(out.basis)).toMatch(NEAR_BASIS);
    expect(String(out.basis)).not.toContain("`route`");
    expect(out).not.toHaveProperty("route");
    // Within one run, nothing is there through a flow: today's answer.
    expect(await trace({ start_tag: "T-150", hops: 1 })).toEqual({ start: "T-150", connected: [{ tag: "P101", hops: 1 }], basis: SHEET_BASIS });
  });

  it("a flow that only repeats a sheet pair brings no tag closer; the start's own flow still gives the directional lists", async () => {
    // A — B — C on sheets (C two runs from A); a flow A → C makes C one run
    // away; a flow T-150 → P-101 repeats the sheet pair.
    seedBase({
      knowledge_page_entities: [
        ent("k-a", 1, "equipment", "P-101"), ent("k-a", 1, "equipment", "T-150"),
        ent("k-a", 2, "equipment", "T-150"), ent("k-a", 2, "equipment", "E-204"),
      ],
      process_flows: [flow(["asset", A_T150], ["asset", A_P101], "confirmed"), flow(["asset", A_P101], ["asset", A_E204], "confirmed")],
    });
    const p = await trace({ start_tag: "P-101", hops: 2 });
    expect(p.connected).toEqual([{ tag: "E204", hops: 1 }, { tag: "T150", hops: 1 }]);
    expect(p.confirmed_flows).toMatchObject({
      feeds: [{ tag: "E204", hops: 1 }], fed_by: [{ tag: "T150", hops: 1 }], connected_through_flow: ["E204"],
    });
    const t = await trace({ start_tag: "T-150", hops: 1 });
    expect(t.connected).toEqual([{ tag: "E204", hops: 1 }, { tag: "P101", hops: 1 }]);
    expect(t.confirmed_flows).toMatchObject({ feeds: [{ tag: "P101", hops: 1 }], fed_by: [], connected_through_flow: [] });
    expect(String(t.basis)).toMatch(NEAR_BASIS);
  });

  it("a no-route answer names the flows when its own start or end is on one — with no `route` in the basis", async () => {
    seedBase({
      knowledge_page_entities: [ent("k-a", 2, "equipment", "T-150"), ent("k-a", 2, "equipment", "E-204")],
      process_flows: [flow(["asset", A_P101], ["asset", A_K500], "confirmed")],
    });
    db.tables.assets.push(...moreAssets());
    // P-101 is on a flow alone: without it, P-101 "doesn't appear".
    const onlyFlow = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(onlyFlow).toMatchObject({ found: false, reason: "No traced route connects P-101 to E-204." });
    expect(String(onlyFlow.basis)).toMatch(NO_ROUTE_BASIS);
    expect(String(onlyFlow.basis)).not.toContain("`route`");
    expect(onlyFlow).not.toHaveProperty("route");
    // The end on a flow, the start on a sheet: the same.
    expect(String((await trace({ start_tag: "T-150", end_tag: "K-500" })).basis)).toMatch(NO_ROUTE_BASIS);
    // Neither end on a flow: today's not-found.
    const neither = await trace({ start_tag: "X-1", end_tag: "E-204" });
    expect(neither).toEqual(GOLDEN_NOT_FOUND);
    // P-101 on a sheet too: the sheets alone give the same reason, and the
    // flow at P-101 was still walked — the basis says so.
    seedBase({
      knowledge_page_entities: [
        ent("k-a", 1, "equipment", "P-101"), ent("k-a", 1, "equipment", "V-9"),
        ent("k-a", 2, "equipment", "T-150"), ent("k-a", 2, "equipment", "E-204"),
      ],
      process_flows: [flow(["asset", A_P101], ["asset", A_K500], "confirmed")],
    });
    db.tables.assets.push(...moreAssets());
    const both = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(both).toMatchObject({ found: false, reason: "No traced route connects P-101 to E-204." });
    expect(String(both.basis)).toMatch(NO_ROUTE_BASIS);
  });

  it("a no-route answer names the flows when they change its reason (a flow chain lengthens the search past its run limit)", async () => {
    // S-0 shares a sheet with N-0; confirmed flows N-0 → N-1 → … → N-30.
    // Neither S-0 nor E-204 is on a flow; the sheets alone say "no traced
    // route", the flows push the search to its 25-run limit.
    const chain = Array.from({ length: 31 }, (_, i) => ({ id: uuid(2000 + i), org_id: ORG, tag: `N-${i}`, archived: false }));
    seedBase({
      knowledge_page_entities: [
        ent("k-a", 1, "equipment", "S-0"), ent("k-a", 1, "equipment", "N-0"),
        ent("k-a", 2, "equipment", "T-150"), ent("k-a", 2, "equipment", "E-204"),
      ],
      process_flows: chain.slice(1).map((a, i) => flow(["asset", chain[i].id], ["asset", a.id], "confirmed")),
    });
    db.tables.assets.push(...chain);
    const out = await trace({ start_tag: "S-0", end_tag: "E-204" });
    expect(out).toMatchObject({ found: false, reason: "No route within 25 runs. They may still be connected further out." });
    expect(String(out.basis)).toMatch(NO_ROUTE_BASIS);
    // Without the flows: today's reason and basis.
    seedBase({
      knowledge_page_entities: [
        ent("k-a", 1, "equipment", "S-0"), ent("k-a", 1, "equipment", "N-0"),
        ent("k-a", 2, "equipment", "T-150"), ent("k-a", 2, "equipment", "E-204"),
      ],
    });
    expect(await trace({ start_tag: "S-0", end_tag: "E-204" })).toMatchObject({
      found: false, reason: "No traced route connects S-0 to E-204.", basis: SHEET_BASIS,
    });
  });
});

describe("IRLS-11 (fix pass 2) — a flow citing another workspace's document is not walked, and that document is never named", () => {
  it("a legacy confirmed flow whose source is another org's upload: not walked, its id absent; once the document is the org's own it is walked", async () => {
    const docs = (owner: string) => [
      { id: "k-a", org_id: ORG, name: "PID-100 SHT 1", source_document_id: null },
      { id: "k-x", org_id: owner, name: "Their PID", source_document_id: null },
    ];
    const flows = () => [
      flow(["asset", A_P101], ["asset", A_E204], "confirmed", { origin: "ai", source_document_id: "k-x" }),
      flow(["asset", A_T150], ["asset", A_E204], "confirmed"),
    ];
    seedBase({ process_flows: flows() });
    db.tables.knowledge_documents = docs("o2");
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(out).toMatchObject({ found: false, path: [], drawings: [] });
    expect(JSON.stringify(out)).not.toContain("k-x");
    expect(JSON.stringify(await trace({ start_tag: "E-204", hops: 2 }))).not.toContain("P101");
    // The hand-drawn flow is the org's map and is walked.
    expect((await trace({ start_tag: "T-150", end_tag: "E-204" })).found).toBe(true);
    // The org check is the org's own: by org and by id.
    const check = queriesOf("knowledge_documents").find((q) => callArgs(q, "eq").some(([c]) => c === "org_id"))!;
    expect(callArgs(check, "eq")).toContainEqual(["org_id", ORG]);
    expect(callArgs(check, "in")).toContainEqual(["id", ["k-x"]]);

    seedBase({ process_flows: flows() });
    db.tables.knowledge_documents = docs(ORG);
    expect(await trace({ start_tag: "P-101", end_tag: "E-204" })).toMatchObject({ found: true, path: ["P101", "E204"], drawings: ["k-x"] });
  });

  it("the org check failing hides every flow read off a sheet (fails closed), never the hand-drawn map", async () => {
    seedBase({
      process_flows: [
        flow(["asset", A_P101], ["asset", A_E204], "confirmed", { origin: "ai", source_document_id: "k-a" }),
        flow(["asset", A_T150], ["asset", A_E204], "confirmed"),
      ],
    });
    expect((await trace({ start_tag: "P-101", end_tag: "E-204" })).found).toBe(true);
    db.failQuery = (table, calls) => (table === "knowledge_documents" && calls.some(([m, a]) => m === "eq" && a[0] === "org_id")
      ? { code: "57014", message: "statement timeout" } : null);
    expect((await trace({ start_tag: "P-101", end_tag: "E-204" })).found).toBe(false);
    expect((await trace({ start_tag: "T-150", end_tag: "E-204" })).found).toBe(true);
  });
});

describe("I-21 fix pass 3 — a step a confirmed flow takes keeps the sheet evidence for its pair", () => {
  it("REGRESSION: an org whose confirmed map mirrors its P&IDs keeps the base's drawings, and each step names both sources", async () => {
    // The reviewer's scenario: sheetSeed, plus hand-drawn confirmed flows
    // on both of the route's pairs. The base answer cites k-a.
    seedBase({
      knowledge_page_entities: sheetSeed(),
      process_flows: [
        flow(["asset", A_P101], ["asset", A_T150], "confirmed"),
        flow(["asset", A_T150], ["asset", A_E204], "confirmed"),
      ],
    });
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(out).toMatchObject({
      found: true, path: GOLDEN_PATH.path, drawings: GOLDEN_PATH.drawings, crosses_sheets: false, components: [],
    });
    expect(out.route).toEqual([
      { from: "P101", to: "T150", basis: "confirmed flow", flow: "P101 feeds T150", also_on_sheet: ["k-a"] },
      { from: "T150", to: "E204", basis: "confirmed flow", flow: "T150 feeds E204", also_on_sheet: ["k-a"] },
    ]);
    expect(String(out.basis)).toMatch(ROUTE_BASIS);
    expect(String(out.basis)).toContain("`also_on_sheet`");
  });

  it("flows read off a PFD: the PFD is cited beside the P&ID, never instead of it (the base's list is a subset)", async () => {
    seedBase({
      knowledge_page_entities: sheetSeed(),
      process_flows: [
        flow(["asset", A_P101], ["asset", A_T150], "confirmed", { origin: "ai", source_document_id: "k-c" }),
        flow(["asset", A_T150], ["asset", A_E204], "confirmed", { origin: "ai", source_document_id: "k-c" }),
      ],
    });
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(out.drawings).toEqual(["k-c", "k-a"]);
    for (const d of GOLDEN_PATH.drawings) expect(out.drawings).toContain(d);
    expect((out.route as Array<Record<string, unknown>>).map((st) => st.also_on_sheet)).toEqual([["k-a"], ["k-a"]]);
  });

  it("every sheet that carries the pair is named, in route order; a sheet the caller cannot open is not", async () => {
    // P-101 and E-204 together on k-a page 3, on k-c page 1 (a readable
    // mirror) and on k-b page 1 (a mirror the Viewer cannot read).
    seedBase({
      knowledge_page_entities: [
        ent("k-a", 3, "equipment", "P-101"), ent("k-a", 3, "equipment", "E-204"),
        ent("k-b", 1, "equipment", "P-101"), ent("k-b", 1, "equipment", "E-204"),
        ent("k-c", 1, "equipment", "P-101"), ent("k-c", 1, "equipment", "E-204"),
      ],
      process_flows: [flow(["asset", A_P101], ["asset", A_E204], "confirmed", { label: "crude feed" })],
    });
    const viewer = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(viewer.route).toEqual([
      { from: "P101", to: "E204", basis: "confirmed flow", flow: "P101 feeds E204", stream: "crude feed", also_on_sheet: ["k-a", "k-c"] },
    ]);
    expect(viewer.drawings).toEqual(["k-a", "k-c"]);
    expect(JSON.stringify(viewer)).not.toContain("k-b");
    db.readable.add("d-hidden");
    const allowed = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(allowed.drawings).toEqual(["k-a", "k-b", "k-c"]);
    // Walked the other way, the step still names the sheets.
    const back = await trace({ start_tag: "E-204", end_tag: "P-101" });
    expect((back.route as Array<Record<string, unknown>>)[0]).toMatchObject({ basis: "confirmed flow", also_on_sheet: ["k-a", "k-b", "k-c"] });
  });

  it("an off-page continuation on the pair keeps its mark: crosses_sheets as the sheets alone say it", async () => {
    // On k-a page 1, P-101 and an off-page reference that reads T-150.
    const sheets = () => [ent("k-a", 1, "equipment", "P-101"), ent("k-a", 1, "ref", "T-150")];
    seedBase({ knowledge_page_entities: sheets() });
    const today = await trace({ start_tag: "P-101", end_tag: "T-150" });
    expect(today).toMatchObject({ found: true, path: ["P101", "T150"], drawings: ["k-a"], crosses_sheets: true, basis: SHEET_BASIS });
    seedBase({ knowledge_page_entities: sheets(), process_flows: [flow(["asset", A_P101], ["asset", A_T150], "confirmed")] });
    const out = await trace({ start_tag: "P-101", end_tag: "T-150" });
    expect(out).toMatchObject({ found: true, path: ["P101", "T150"], drawings: ["k-a"], crosses_sheets: true });
    expect(out.route).toEqual([
      { from: "P101", to: "T150", basis: "confirmed flow", flow: "P101 feeds T150", also_on_sheet: ["k-a"], off_page: true },
    ]);
  });

  it("a route through the same tags as the drawings' carries no `sheet_route`: its steps name their sheets", async () => {
    seedBase({
      knowledge_page_entities: sheetSeed(),
      process_flows: [flow(["asset", A_P101], ["asset", A_T150], "confirmed"), flow(["asset", A_T150], ["asset", A_E204], "confirmed")],
    });
    expect(await trace({ start_tag: "P-101", end_tag: "E-204" })).not.toHaveProperty("sheet_route");
  });

  it("a flow step on a pair no sheet carries cites no sheet for it; the sheet step beside it keeps its own", async () => {
    seedBase({
      knowledge_page_entities: [ent("k-a", 2, "equipment", "T-150"), ent("k-a", 2, "equipment", "E-204")],
      process_flows: [flow(["asset", A_P101], ["asset", A_T150], "confirmed", { origin: "ai", source_document_id: "k-c" })],
    });
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(out.route).toEqual([
      { from: "P101", to: "T150", basis: "confirmed flow", flow: "P101 feeds T150" },
      { from: "T150", to: "E204", basis: "same sheet" },
    ]);
    expect(out.drawings).toEqual(["k-c", "k-a"]);
  });
});

describe("I-21 fix pass 4 — a confirmed flow that skips a drawn route never drops it unsaid", () => {
  it("REGRESSION: a PFD flow joining the two ends directly keeps the drawings' route and its P&ID beside it (`sheet_route`)", async () => {
    // The reviewer's scenario: sheetSeed (P-101 – T-150 – E-204 on the P&ID
    // k-a) plus one AI-read confirmed flow P-101 → E-204 off the PFD k-c.
    seedBase({
      knowledge_page_entities: sheetSeed(),
      process_flows: [flow(["asset", A_P101], ["asset", A_E204], "confirmed", { origin: "ai", source_document_id: "k-c" })],
    });
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    // The flow's route is the answer, named as one…
    expect(out).toMatchObject({ found: true, path: ["P101", "E204"], drawings: ["k-c"] });
    expect(out.route).toEqual([{ from: "P101", to: "E204", basis: "confirmed flow", flow: "P101 feeds E204" }]);
    // …and the drawings' own route is the base answer's, beside it.
    expect(out.sheet_route).toEqual({ path: GOLDEN_PATH.path, drawings: GOLDEN_PATH.drawings, crosses_sheets: GOLDEN_PATH.crosses_sheets });
    expect(String(out.basis)).toMatch(ROUTE_BASIS);
    expect(String(out.basis)).toContain(
      "When `sheet_route` is present, the drawings alone give a DIFFERENT route between the two "
      + "(`sheet_route.path`, on the sheets in `sheet_route.drawings`): name both routes, and do not drop the "
      + "equipment the drawn route passes through.",
    );
    // Hand-drawn, the same: the drawn route is named, k-a with it.
    seedBase({ knowledge_page_entities: sheetSeed(), process_flows: [flow(["asset", A_P101], ["asset", A_E204], "confirmed")] });
    const hand = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(hand).toMatchObject({ found: true, path: ["P101", "E204"], drawings: [] });
    expect(hand.sheet_route).toEqual({ path: GOLDEN_PATH.path, drawings: ["k-a"], crosses_sheets: false });
  });

  it("a flow route of the same length through other equipment: the drawn route is named too, with its off-page mark", async () => {
    // Drawn: P-101 and an off-page reference to T-150 on k-a page 1, T-150 and
    // E-204 on page 2. Confirmed: P-101 → K-500 → E-204.
    seedBase({
      knowledge_page_entities: [
        ent("k-a", 1, "equipment", "P-101"), ent("k-a", 1, "ref", "T-150"),
        ent("k-a", 2, "equipment", "T-150"), ent("k-a", 2, "equipment", "E-204"),
      ],
      process_flows: [flow(["asset", A_P101], ["asset", A_K500], "confirmed"), flow(["asset", A_K500], ["asset", A_E204], "confirmed")],
    });
    db.tables.assets.push(...moreAssets());
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(out).toMatchObject({ found: true, path: ["P101", "K500", "E204"], drawings: [], crosses_sheets: false });
    expect(out.sheet_route).toEqual({ path: ["P101", "T150", "E204"], drawings: ["k-a"], crosses_sheets: true });
  });

  it("no drawn route between the two: no `sheet_route`; a sheet hidden from the caller is never one", async () => {
    // The drawn route is on k-b, a mirror the Viewer cannot read.
    seedBase({
      knowledge_page_entities: [
        ent("k-b", 1, "equipment", "P-101"), ent("k-b", 1, "equipment", "T-150"),
        ent("k-b", 2, "equipment", "T-150"), ent("k-b", 2, "equipment", "E-204"),
      ],
      process_flows: [flow(["asset", A_P101], ["asset", A_E204], "confirmed")],
    });
    const viewer = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(viewer).toMatchObject({ found: true, path: ["P101", "E204"] });
    expect(viewer).not.toHaveProperty("sheet_route");
    expect(JSON.stringify(viewer)).not.toContain("k-b");
    db.readable.add("d-hidden");
    expect((await trace({ start_tag: "P-101", end_tag: "E-204" })).sheet_route)
      .toEqual({ path: ["P101", "T150", "E204"], drawings: ["k-b"], crosses_sheets: false });
  });
});

describe("ING-10 residual (fix pass 3) — the tag index is paged by key: a write mid-read never skips a sheet", () => {
  const self = (doc: string, n: number, firstPage = 1) =>
    Array.from({ length: n }, (_, i) => ent(doc, firstPage + i, "self", `${doc}-SELF-${i}`));

  it("a sheet re-indexed while the trace reads (its rows deleted before the third page) shifts no later sheet out of the pages", async () => {
    // k-1 and k-2 fill the first two pages; P-101 and E-204 share k-3 page 1.
    // An OFFSET read's third page (rows 2,000 on) would start at k-4 once
    // k-1's 1,000 rows are gone, and never read k-3.
    const k3 = [ent("k-3", 1, "equipment", "P-101"), ent("k-3", 1, "equipment", "E-204"), ...self("k-3", 998, 2)];
    const rows = [...self("k-1", 1_000), ...self("k-2", 1_000), ...k3, ...self("k-4", 10)];
    seedBase({ knowledge_page_entities: rows });
    db.beforeTagPage = (served) => {
      if (served === 2) db.tables.knowledge_page_entities = rows.filter((r) => r.document_id !== "k-1");
    };
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(out).toMatchObject({ found: true, path: ["P101", "E204"], drawings: ["k-3"] });
    expect(out).not.toHaveProperty("graph_partial");
    // The third page began at k-3's first row (row 1,000 of what was left).
    expect(db.tagPageStarts.slice(0, 3)).toEqual([0, 1_000, 1_000]);
  });

  it("the cursor quotes the tag it carries: a comma, a parenthesis, a dot, a quote or a backslash never splits the list", async () => {
    const odd = { id: "e-odd", org_id: ORG, document_id: "k-f-0000", page: 1_000, kind: "ref", tag: 'X,Y(1).2"Z\\' };
    seedBase({
      knowledge_page_entities: [
        ...Array.from({ length: 999 }, (_, i) => ent("k-f-0000", i + 1, "self", `SELF-${i}`)), odd,
        ent("k-z", 1, "equipment", "P-101"), ent("k-z", 1, "equipment", "E-204"),
      ],
    });
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(out).toMatchObject({ found: true, path: ["P101", "E204"], drawings: ["k-z"] });
    expect(db.tagPageStarts).toEqual([0, 1_000, 1_002]);
    expect(String(callArgs(tagPages()[1], "or")[0][0])).toContain('tag.gt."X,Y(1).2\\"Z\\\\"');
  });
});

describe("fix pass 3 — the confirmed-flow read is bounded on the trace's clock", () => {
  const admin = { from: (t: string) => makeChain("admin", t) } as never;
  /** `n` flows between 2n distinct assets of the org: ⌈2n / 200⌉ asset chunks. */
  const assetPairs = (n: number) => {
    const assets = Array.from({ length: 2 * n }, (_, i) => ({ id: uuid(5000 + i), org_id: ORG, tag: `K-${5000 + i}`, archived: false }));
    const flows = Array.from({ length: n }, (_, i) => flow(["asset", assets[2 * i].id], ["asset", assets[2 * i + 1].id], "confirmed"));
    return { assets, flows };
  };

  it("no round trip starts past the deadline — a flow page, an asset chunk or a codebook chunk — and the read then fails, never half-resolved", async () => {
    // 350 flows, 700 assets: four asset chunks at 4 s each start at 0, 4, 8
    // and 12 s; the fourth is past a 10 s deadline.
    const { assets, flows } = assetPairs(350);
    seedBase({ process_flows: flows });
    db.tables.assets.push(...assets);
    db.costMs.assets = 4_000;
    const out = await flowsToLineEdges(ORG, admin, { deadline: db.now + 10_000 });
    expect(out).toEqual({ edges: [], state: "error", error: FLOW_READ_OUT_OF_TIME, truncated: false, skipped: 0, unitNodes: [] });
    expect(queriesOf("assets")).toHaveLength(3);
    // Without a deadline (every caller but the trace), the read is whole.
    db.queries = [];
    const whole = await flowsToLineEdges(ORG, admin);
    expect(whole.state).toBe("ok");
    expect(whole.edges).toHaveLength(350);
    // A slow codebook read is bounded the same way.
    seedBase({ process_flows: Array.from({ length: 300 }, (_, i) => flow(["unit", `U${i}`], ["unit", `V${i}`], "confirmed")) });
    db.costMs.codebook_entries = 6_000;
    expect((await flowsToLineEdges(ORG, admin, { deadline: db.now + 10_000 })).error).toBe(FLOW_READ_OUT_OF_TIME);
    // And a slow flow page.
    seedBase({ process_flows: Array.from({ length: 2_500 }, () => flow(["unit", "20"], ["unit", "30"], "confirmed")) });
    db.costMs = { process_flows: 6_000 };
    db.queries = [];
    expect((await flowsToLineEdges(ORG, admin, { deadline: db.now + 10_000 })).error).toBe(FLOW_READ_OUT_OF_TIME);
    expect(queriesOf("process_flows")).toHaveLength(2);
  });

  it("the trace passes its own budget: a flow read past it is said, and the sheets answer as before", async () => {
    const { assets, flows } = assetPairs(350);
    seedBase({ knowledge_page_entities: sheetSeed(), process_flows: flows });
    db.tables.assets.push(...assets);
    db.costMs.assets = 4_000;
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    const { confirmed_flows_unavailable: note, ...rest } = out;
    expect(rest).toEqual(GOLDEN_PATH);
    expect(String(note)).toBe(
      "The plant's confirmed process flows could not be read (reading them took longer than one trace may spend on it), "
      + "so this trace uses sheet co-occurrence only. That is NOT the same as the plant having no confirmed flows — say so.",
    );
  });
});

describe("GAP-315 — confirmed flows reach the trace, each step naming its basis", () => {
  it("a confirmed flow joins two pieces of equipment no sheet connects; the route names it, its direction and its stream", async () => {
    seedBase({
      process_flows: [flow(["asset", A_P101], ["asset", A_E204], "confirmed", { label: "crude feed" })],
    });
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(out).toMatchObject({ found: true, path: ["P101", "E204"], drawings: [], crosses_sheets: false, components: [] });
    expect(out.route).toEqual([{ from: "P101", to: "E204", basis: "confirmed flow", flow: "P101 feeds E204", stream: "crude feed" }]);
    expect(String(out.basis)).toMatch(/A "confirmed flow" step is a CONFIRMED flow on the plant's process map/);
    expect(String(out.basis)).toMatch(/A "same sheet" step is equipment appearing together on the same drawing page/);
    expect(String(out.basis)).toMatch(/Proposed or dismissed flows are never used/);
    // Walked the other way, the step says it runs against the flow.
    const back = await trace({ start_tag: "E-204", end_tag: "P-101" });
    expect(back.route).toEqual([{ from: "E204", to: "P101", basis: "confirmed flow", flow: "P101 feeds E204 (this step runs against the flow)", stream: "crude feed" }]);
  });

  it("a mixed route labels the confirmed-flow step and the co-occurrence step apart (acceptance 1)", async () => {
    seedBase({
      knowledge_page_entities: [ent("k-a", 2, "equipment", "T-150"), ent("k-a", 2, "equipment", "E-204")],
      process_flows: [flow(["asset", A_P101], ["asset", A_T150], "confirmed")],
    });
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(out.path).toEqual(["P101", "T150", "E204"]);
    expect(out.route).toEqual([
      { from: "P101", to: "T150", basis: "confirmed flow", flow: "P101 feeds T150" },
      { from: "T150", to: "E204", basis: "same sheet" },
    ]);
    expect(out.drawings).toEqual(["k-a"]);
  });

  it("a proposal between the two is never used, even beside a confirmed flow elsewhere (acceptance 2)", async () => {
    seedBase({
      process_flows: [
        flow(["asset", A_P101], ["asset", A_E204], "proposed", { origin: "ai", source_document_id: "k-a" }),
        flow(["asset", A_E204], ["asset", A_P101], "dismissed"),
        flow(["asset", A_T150], ["asset", A_E204], "confirmed"),
      ],
    });
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(out.found).toBe(false);
    expect(out.reason).toBe("P-101 doesn't appear on any traced line.");
    expect(out).not.toHaveProperty("route");
  });

  it("when a confirmed flow and sheet co-occurrence join the same pair, the flow is the step named — and the sheet is still cited (fix pass 3)", async () => {
    seedBase({
      knowledge_page_entities: [ent("k-a", 3, "equipment", "P-101"), ent("k-a", 3, "equipment", "E-204")],
      process_flows: [flow(["asset", A_P101], ["asset", A_E204], "confirmed")],
    });
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(out.route).toEqual([{ from: "P101", to: "E204", basis: "confirmed flow", flow: "P101 feeds E204", also_on_sheet: ["k-a"] }]);
    expect(out.drawings).toEqual(["k-a"]);
    expect(String(out.basis)).toMatch(/A "confirmed flow" step that lists `also_on_sheet` ALSO has its two tags on the same drawing page of those sheets \(they are in `drawings` too\): name both sources for it\./);
    // The same-sheet hint still names the sheet both are drawn on.
    expect(out.same_sheet).toEqual([{ sheet: "PID-100 SHT 1", page: 3 }]);
  });

  it("a unit end is its Site Codebook unit ('UNIT 20'); ends that do not resolve are left out", async () => {
    seedBase({
      process_flows: [
        flow(["unit", "20"], ["asset", A_P101], "confirmed", { label: "crude charge" }),
        flow(["unit", "99"], ["asset", A_E204], "confirmed"),       // no such codebook unit (AREA-10)
        flow(["unit", "21"], ["asset", A_E204], "confirmed"),       // a code, but not a unit
        flow(["asset", A_V300], ["asset", A_E204], "confirmed"),    // archived equipment
        flow(["asset", A_X999], ["asset", A_E204], "confirmed"),    // another workspace's asset
        flow(["asset", uuid(777)], ["asset", A_E204], "confirmed"), // deleted equipment
        flow(["asset", "not-a-uuid"], ["asset", A_E204], "confirmed"),
      ],
    });
    expect(unitTraceTag("20")).toBe("UNIT20");
    const out = await trace({ start_tag: "Unit 20", end_tag: "P-101" });
    expect(out).toMatchObject({ found: true, path: ["UNIT20", "P101"] });
    expect(out.route).toEqual([{ from: "UNIT20", to: "P101", basis: "confirmed flow", flow: "UNIT20 feeds P101", stream: "crude charge" }]);
    expect((await trace({ start_tag: "V-300", end_tag: "E-204" })).found).toBe(false);
    expect((await trace({ start_tag: "X-999", end_tag: "E-204" })).found).toBe(false);
    const edges = await flowsToLineEdges(ORG, { from: (t: string) => makeChain("admin", t) } as never);
    expect(edges.edges).toEqual([
      { lineId: "f-0000000", from: "UNIT20", to: "P101", basis: "confirmed_flow", label: "crude charge" },
    ]);
    expect(edges.skipped).toBe(6);
    expect(edges.unitNodes).toEqual(["UNIT20"]);
    // Every registry and codebook read is the org's own.
    for (const t of ["process_flows", "assets", "codebook_entries"]) {
      for (const q of queriesOf(t)) expect(callArgs(q, "eq")).toContainEqual(["org_id", ORG]);
    }
  });

  it("the neighbourhood is scoped by traceNeighbourhood over confirmed flows: what it feeds, what feeds it", async () => {
    seedBase({
      knowledge_page_entities: [ent("k-a", 4, "equipment", "T-150"), ent("k-a", 4, "equipment", "V-150")],
      process_flows: [
        flow(["unit", "20"], ["asset", A_P101], "confirmed"),
        flow(["asset", A_P101], ["asset", A_T150], "confirmed"),
        flow(["asset", A_T150], ["asset", A_E204], "confirmed"),
        flow(["asset", A_E204], ["unit", "30"], "proposed"),
      ],
    });
    const out = await trace({ start_tag: "T-150", hops: 2 });
    // `connected` is equipment: it never walks a unit-ended flow unless the
    // trace starts at that unit.
    expect(out.connected).toEqual([{ tag: "E204", hops: 1 }, { tag: "P101", hops: 1 }, { tag: "V150", hops: 1 }]);
    expect(out.confirmed_flows).toMatchObject({
      feeds: [{ tag: "E204", hops: 1 }],
      fed_by: [{ tag: "P101", hops: 1 }, { tag: "UNIT20", hops: 2 }],
    });
    expect(String((out.confirmed_flows as { note: string }).note)).toMatch(/CONFIRMED process flows only/);
    expect(String((out.confirmed_flows as { note: string }).note)).toMatch(/never passes through a unit/);
    // Started at the unit, the walk goes out from it.
    const fromUnit = await trace({ start_tag: "Unit 20", hops: 2 });
    expect(fromUnit.connected).toEqual([{ tag: "P101", hops: 1 }, { tag: "T150", hops: 2 }]);
    expect(fromUnit.confirmed_flows).toMatchObject({ feeds: [{ tag: "P101", hops: 1 }, { tag: "T150", hops: 2 }], fed_by: [] });
  });

  it("a route may start or end at a unit, never pass through one; a directional list stops at a unit", async () => {
    seedBase({
      process_flows: [
        flow(["asset", A_T150], ["unit", "20"], "confirmed"),
        flow(["unit", "20"], ["asset", A_P101], "confirmed"),
        flow(["unit", "20"], ["asset", A_E204], "confirmed"),
        flow(["unit", "20"], ["unit", "30"], "confirmed"),
      ],
    });
    // Siblings fed by the same unit are not "between" each other.
    const siblings = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(siblings).toMatchObject({ found: false, path: [], drawings: [] });
    expect(siblings).not.toHaveProperty("route");
    // Nor is what feeds the unit upstream of P-101 "through" it.
    expect((await trace({ start_tag: "T-150", end_tag: "P-101" })).found).toBe(false);
    // From the unit itself, or to it, the route is the flow.
    const fromUnit = await trace({ start_tag: "Unit 20", end_tag: "E-204" });
    expect(fromUnit).toMatchObject({ found: true, path: ["UNIT20", "E204"] });
    expect(fromUnit.route).toEqual([{ from: "UNIT20", to: "E204", basis: "confirmed flow", flow: "UNIT20 feeds E204" }]);
    expect((await trace({ start_tag: "T-150", end_tag: "Unit 20" })).path).toEqual(["T150", "UNIT20"]);
    expect((await trace({ start_tag: "Unit 20", end_tag: "Unit 30" })).path).toEqual(["UNIT20", "UNIT30"]);
    // Directional: P-101 is fed by unit 20, and the list stops there — T-150
    // feeds the unit, not (as far as the map says) P-101.
    const near = await trace({ start_tag: "P-101", hops: 3 });
    expect(near.connected).toEqual([]);
    expect(near.confirmed_flows).toMatchObject({ feeds: [], fed_by: [{ tag: "UNIT20", hops: 1 }] });
    const upT = await trace({ start_tag: "T-150", hops: 3 });
    expect(upT.confirmed_flows).toMatchObject({ feeds: [{ tag: "UNIT20", hops: 1 }], fed_by: [] });
  });
});

describe("SURF-7 / IEDGE-2 — the hidden-sheet filter binds the flow edges", () => {
  it("a confirmed flow read off a sheet the caller cannot open is not walked; once readable it is; a hand-drawn flow always is", async () => {
    seedBase({
      process_flows: [
        flow(["asset", A_P101], ["asset", A_E204], "confirmed", { origin: "ai", source_document_id: "k-b", source_page: 2 }),
        flow(["asset", A_T150], ["asset", A_E204], "confirmed"),
        flow(["asset", A_P101], ["asset", A_T150], "confirmed", { origin: "ai", source_document_id: "k-c" }),
      ],
    });
    // Viewer: k-b mirrors d-hidden — the direct flow is not walked; the
    // route goes through the readable PFD's flow and the hand-drawn one.
    const viewer = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(viewer.path).toEqual(["P101", "T150", "E204"]);
    expect(viewer.drawings).toEqual(["k-c"]);
    expect(JSON.stringify(viewer)).not.toContain("k-b");
    // The drawing becomes readable: the direct confirmed flow is walked.
    db.readable.add("d-hidden");
    const allowed = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(allowed.path).toEqual(["P101", "E204"]);
    expect(allowed.drawings).toEqual(["k-b"]);
  });

  it("the mirror hop failing closed hides every flow read off a sheet, never the hand-drawn map", async () => {
    seedBase({
      process_flows: [
        flow(["asset", A_P101], ["asset", A_E204], "confirmed", { origin: "ai", source_document_id: "k-c" }),
        flow(["asset", A_T150], ["asset", A_E204], "confirmed"),
      ],
    });
    db.errors.knowledge_documents = { code: "57014", message: "statement timeout" };
    expect((await trace({ start_tag: "P-101", end_tag: "E-204" })).found).toBe(false);
    expect((await trace({ start_tag: "T-150", end_tag: "E-204" })).found).toBe(true);
  });
});

describe("ING-10 residual — the tag index is paged, never one capped read that looks whole", () => {
  /** `n` filler rows (sheet identities: no equipment, so no edges) on
   *  documents that sort before `k-z`, 1,000 to a document. */
  const filler = (n: number) => Array.from({ length: n }, (_, i) =>
    ent(`k-f-${String(Math.floor(i / 1000)).padStart(4, "0")}`, (i % 1000) + 1, "self", `SELF-${i}`));

  it("rows past 20,000 are read: a pair on the sheet that sorts last is traced (the base commit's .limit(20000) never saw it)", async () => {
    seedBase({
      knowledge_page_entities: [...filler(20_500), ent("k-z", 1, "equipment", "P-101"), ent("k-z", 1, "equipment", "E-204")],
    });
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(out).toMatchObject({ found: true, path: ["P101", "E204"], drawings: ["k-z"] });
    expect(out).not.toHaveProperty("graph_partial");
    expect(Math.max(...db.tagPageStarts)).toBeGreaterThanOrEqual(20_000);
    // Stable order: by document, page and tag (the prefix of the
    // (document_id, page, tag) index), then id; the kinds named (ING-5).
    const [first, second] = tagPages();
    expect(callArgs(first, "order")).toEqual([
      ["document_id", { ascending: true }], ["page", { ascending: true }],
      ["tag", { ascending: true }], ["id", { ascending: true }],
    ]);
    expect(callArgs(first, "in")[0][0]).toBe("kind");
    // Paged by key on that whole order (fix pass 3), never by offset: the
    // first page has no cursor; the next asks for the rows after the last
    // one read (k-f-0000 page 1000, SELF999, e-0000999).
    expect(first.calls.map(([m]) => m)).not.toContain("range");
    expect(callArgs(first, "or")).toEqual([]);
    expect(callArgs(second, "gte")).toEqual([["document_id", "k-f-0000"]]);
    expect(callArgs(second, "or")).toEqual([[
      'document_id.gt."k-f-0000",and(document_id.eq."k-f-0000",page.gt.1000),'
      + 'and(document_id.eq."k-f-0000",page.eq.1000,tag.gt."SELF999"),'
      + 'and(document_id.eq."k-f-0000",page.eq.1000,tag.eq."SELF999",id.gt."e-0000999")',
    ]]);
    expect(callArgs(second, "limit")).toEqual([[1_000]]);
  }, 60_000);

  it("a short page is not the last: a project max-rows below the page size still reads every row", async () => {
    seedBase({ knowledge_page_entities: sheetSeed() });
    db.maxRows = 2;
    await expectToday();
  });

  /** A sheet `k-g` whose first two rows (P-101 and E-204, together on page
   *  1) are the rows at `at` and `at + 1`, and whose other rows run on past
   *  `at + 2` — the sheet a stop at `at + 2` rows cuts. */
  const cutSheet = (at: number) => [
    ent("k-a", 1, "equipment", "P-101"), ent("k-a", 1, "equipment", "T-150"),
    ...filler(at - 2),
    ent("k-g", 1, "equipment", "P-101"), ent("k-g", 1, "equipment", "E-204"),
    ...Array.from({ length: 600 }, (_, i) => ent("k-g", 2 + i, "self", `SELF-G-${i}`)),
    ent("k-z", 1, "equipment", "T-150"), ent("k-z", 1, "equipment", "E-204"),
  ];

  it(`past ${LINE_GRAPH_ROW_CEILING.toLocaleString("en-US")} rows the cut sheet is dropped whole — its rows inside the ceiling too — and the trace says it is PARTIAL`, async () => {
    // P-101 and E-204 share k-g page 1, both rows inside the ceiling; the
    // ceiling cuts k-g's later rows.
    seedBase({ knowledge_page_entities: cutSheet(LINE_GRAPH_ROW_CEILING - 2) });
    const inside = await trace({ start_tag: "P-101", end_tag: "T-150" });
    expect(inside.found).toBe(true);
    expect(String(inside.graph_partial)).toMatch(/^PARTIAL: the drawing tag index holds more rows than one trace reads \(50,000\)/);
    // A half-read sheet is never walked: the pair on k-g is not a route.
    const cut = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(cut).toMatchObject({ found: false, reason: "E-204 doesn't appear on any traced line." });
    expect(String(cut.graph_partial)).toMatch(/is NOT proof the equipment is unconnected/);
  }, 60_000);

  it(`the read is bounded in time: no page starts past ${LINE_GRAPH_READ_BUDGET_MS / 1000} s, the sheet it was reading is dropped whole, and the trace says PARTIAL`, async () => {
    // Each page costs 1.5 s: pages start at 0, 1.5 … 9 s; the eighth (at
    // 10.5 s) never does. 7,000 rows read; k-g straddles row 7,000.
    db.pageCostMs = 1_500;
    seedBase({ knowledge_page_entities: cutSheet(6_998) });
    const cut = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(tagPages()).toHaveLength(7);
    expect(cut).toMatchObject({ found: false, reason: "E-204 doesn't appear on any traced line." });
    expect(String(cut.graph_partial)).toMatch(/^PARTIAL: reading the drawing tag index took longer than one trace may spend on it \(10 s\)/);
    expect(String(cut.graph_partial)).toMatch(/is NOT proof the equipment is unconnected/);
    expect(cut).not.toHaveProperty("graph_unavailable");
    expect((await trace({ start_tag: "P-101", end_tag: "T-150" })).found).toBe(true);
    // Fast pages: the whole index is read, nothing partial.
    db.pageCostMs = 0;
    const whole = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(whole).toMatchObject({ found: true, path: ["P101", "E204"], drawings: ["k-g"] });
    expect(whole).not.toHaveProperty("graph_partial");
  }, 60_000);
});

describe("ING-10 residual (fix pass 2) — a read that is whole is never called partial on time", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) =>
    ent(`k-f-${String(Math.floor(i / 1000)).padStart(4, "0")}`, (i % 1000) + 1, "self", `SELF-${i}`));

  it("the last data page ends past the budget: the closing page is still asked for, and the whole read is walked", async () => {
    // 6 s a page: page 0 (full) ends at 6 s, page 1 (short: the rest) at
    // 12 s. The page that closes the read starts past 10 s, after a short one.
    db.pageCostMs = 6_000;
    seedBase({ knowledge_page_entities: [...filler(1_000), ent("k-z", 1, "equipment", "P-101"), ent("k-z", 1, "equipment", "E-204")] });
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(out).toMatchObject({ found: true, path: ["P101", "E204"], drawings: ["k-z"] });
    expect(out).not.toHaveProperty("graph_partial");
    expect(db.tagPageStarts).toEqual([0, 1_000, 1_002]);
  });

  it("…once only: with a max-rows below the window every page is short, and the read still stops one page past the budget, PARTIAL", async () => {
    // 500 rows a response, 4 s a page: pages start at 0, 4, 8 s; the page at
    // 12 s follows a short one and is asked for; the next is not.
    db.pageCostMs = 4_000;
    db.maxRows = 500;
    seedBase({ knowledge_page_entities: [ent("k-a", 1, "equipment", "P-101"), ent("k-a", 1, "equipment", "T-150"), ...filler(3_000)] });
    const out = await trace({ start_tag: "P-101", end_tag: "T-150" });
    expect(tagPages()).toHaveLength(4);
    expect(out.found).toBe(true);
    expect(String(out.graph_partial)).toMatch(/^PARTIAL: reading the drawing tag index took longer than one trace may spend on it \(10 s\)/);
  });
});

describe("ING-10 residual — a tag-index read that fails is said, never passed off as \"doesn't appear\"", () => {
  const timeout = { code: "57014", message: "canceling statement due to statement timeout" };
  const filler = (n: number) => Array.from({ length: n }, (_, i) =>
    ent(`k-f-${String(Math.floor(i / 1000)).padStart(4, "0")}`, (i % 1000) + 1, "self", `SELF-${i}`));

  it("a page that fails after earlier pages read is a stop (fix pass 4): the sheets read are walked, the one it cut is dropped, and graph_partial names the failure", async () => {
    // The reviewer's scenario: P-101 and E-204 share k-a page 1, then 1,500
    // filler rows; the second page fails. The base read one page (k-a sorts
    // first) and found the pair.
    seedBase({ knowledge_page_entities: [ent("k-a", 1, "equipment", "P-101"), ent("k-a", 1, "equipment", "E-204"), ...filler(1_500)] });
    db.pageErrors.knowledge_page_entities = { from: 1_000, error: timeout };
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(tagPages()).toHaveLength(2);
    const { graph_partial: note, ...rest } = out;
    expect(rest).toEqual({
      found: true, path: ["P101", "E204"], drawings: ["k-a"], crosses_sheets: false, components: [],
      reason: undefined, basis: SHEET_BASIS,
      same_sheet: [{ sheet: "PID-100 SHT 1", page: 1 }], note: GOLDEN_SAME_SHEET.note,
    });
    expect(String(note)).toBe(
      "PARTIAL: a page of the drawing tag index could not be read (canceling statement due to statement timeout), "
      + "so some sheets were not walked. A route not found, or a tag that \"doesn't appear\", is NOT proof "
      + "the equipment is unconnected — say the trace is partial.",
    );
    expect(out).not.toHaveProperty("graph_unavailable");
  });

  it("…the sheet the failed page cut is not walked, the flows still answer, and the answer says PARTIAL, never 'unavailable'", async () => {
    // T-150 and E-204 share k-f-0000 page 1, whose rows run on past the first
    // page; a confirmed flow P-101 → T-150. The index fails on its second page.
    seedBase({
      knowledge_page_entities: [
        ent("k-a", 1, "equipment", "P-101"), ent("k-a", 1, "equipment", "V-9"),
        ent("k-f-0000", 1, "equipment", "T-150"), ent("k-f-0000", 1, "equipment", "E-204"), ...filler(1_500),
      ],
      process_flows: [flow(["asset", A_P101], ["asset", A_T150], "confirmed")],
    });
    db.pageErrors.knowledge_page_entities = { from: 1_000, error: timeout };
    const out = await trace({ start_tag: "T-150", end_tag: "E-204" });
    expect(out).toMatchObject({ found: false, reason: "E-204 doesn't appear on any traced line." });
    expect(String(out.graph_partial)).toMatch(/^PARTIAL: a page of the drawing tag index could not be read \(canceling statement due to statement timeout\)/);
    expect(out).not.toHaveProperty("graph_unavailable");
    // k-a, read whole before the failure, is walked; the flows still answer.
    expect((await trace({ start_tag: "P-101", end_tag: "V-9" })).found).toBe(true);
    expect((await trace({ start_tag: "P-101", end_tag: "T-150" })).route)
      .toEqual([{ from: "P101", to: "T150", basis: "confirmed flow", flow: "P101 feeds T150" }]);
  });

  it("with no flows: today's answer plus the one sentence — path and neighbourhood", async () => {
    seedBase({ knowledge_page_entities: sheetSeed() });
    db.pageErrors.knowledge_page_entities = { from: 0, error: timeout };
    const path = await trace({ start_tag: "P-101", end_tag: "E-204" });
    const { graph_unavailable: note, ...rest } = path;
    expect(rest).toEqual({
      found: false, path: [], drawings: [], crosses_sheets: false, components: [],
      reason: "P-101 doesn't appear on any traced line.", basis: SHEET_BASIS,
    });
    expect(String(note)).toMatch(/^The drawing tag index could not be read \(canceling statement due to statement timeout\)/);
    const near = await trace({ start_tag: "T-150", hops: 1 });
    expect(near).toMatchObject({ start: "T-150", connected: [], basis: SHEET_BASIS });
    expect(String(near.graph_unavailable)).toMatch(/is NOT proof — say the trace could not be checked/);
    // The index read working again: no note.
    db.pageErrors = {};
    expect(await trace({ start_tag: "P-101", end_tag: "E-204" })).not.toHaveProperty("graph_unavailable");
  });
});

describe("I-21 fix pass 4 — one graph a run; the graph's readability checks run on the trace's clock", () => {
  const tool = () => toolByName("trace_pid_lines")!;

  it("traces on one run's context read the tag index and the flows once; a new run reads again", async () => {
    seedBase({ knowledge_page_entities: sheetSeed(), process_flows: [flow(["asset", A_P101], ["asset", A_K500], "confirmed")] });
    db.tables.assets.push(...moreAssets());
    const ctx = ctxFor(["Viewer"]);
    const first = (await tool().run({ start_tag: "P-101", end_tag: "E-204" }, ctx)).data;
    expect(first).toEqual(GOLDEN_PATH);
    // sheetSeed: one page of rows, then the empty page that closes the read.
    expect(tagPages()).toHaveLength(2);
    const flowReads = queriesOf("process_flows").length;
    expect(flowReads).toBeGreaterThan(0);
    const near = (await tool().run({ start_tag: "T-150", hops: 1 }, ctx)).data;
    const again = (await tool().run({ start_tag: "P-101", end_tag: "E-204" }, ctx)).data;
    expect(tagPages()).toHaveLength(2);
    expect(queriesOf("process_flows")).toHaveLength(flowReads);
    expect(near).toEqual(GOLDEN_NEAR);
    expect(again).toEqual(first);
    // Another run (another context) reads the index again.
    await tool().run({ start_tag: "P-101", end_tag: "E-204" }, ctxFor(["Viewer"]));
    expect(tagPages()).toHaveLength(4);
  });

  it("a load that throws is not kept: the next trace on the same context reads again", async () => {
    seedBase({ knowledge_page_entities: sheetSeed() });
    const ctx = ctxFor(["Viewer"]);
    db.failQuery = (table, calls) => {
      if (table === "knowledge_page_entities" && calls.some(([m]) => m === "order")) throw new Error("socket hang up");
      return null;
    };
    await expect(tool().run({ start_tag: "P-101", end_tag: "E-204" }, ctx)).rejects.toThrow("socket hang up");
    db.failQuery = null;
    expect((await tool().run({ start_tag: "P-101", end_tag: "E-204" }, ctx)).data).toEqual(GOLDEN_PATH);
  });

  it(`no mirror lookup starts ${LINE_GRAPH_CHECK_BUDGET_MS / 1000} s past the reads: a sheet not checked by then is not walked, and the answer says PARTIAL`, async () => {
    // 450 sheets, so the mirror lookup is three chunks of 200. The reads cost
    // nothing; each lookup costs 3 s: they start at 0 and 3 s; the third (at
    // 6 s) never does, so k-z, in it, is not walked. k-a, in the first, is.
    const many = Array.from({ length: 448 }, (_, i) => ent(`k-m-${String(i).padStart(4, "0")}`, 1, "self", `M-${i}`));
    const rows = () => [
      ent("k-a", 1, "equipment", "P-101"), ent("k-a", 1, "equipment", "T-150"),
      ...many,
      ent("k-z", 1, "equipment", "T-150"), ent("k-z", 1, "equipment", "E-204"),
    ];
    seedBase({ knowledge_page_entities: rows() });
    db.costMs.knowledge_documents = 3_000;
    const near = await trace({ start_tag: "T-150", hops: 1 });
    // Neighbourhood mode makes no lookup of its own: these are the graph's.
    expect(queriesOf("knowledge_documents")).toHaveLength(2);
    expect(callArgs(queriesOf("knowledge_documents")[1], "in")[0][1]).toHaveLength(200);
    expect(near).toMatchObject({ start: "T-150", connected: [{ tag: "P101", hops: 1 }], basis: SHEET_BASIS });
    expect(String(near.graph_partial)).toBe(
      "PARTIAL: checking which of the drawings you may open took longer than one trace may spend on it (5 s), "
      + "so some sheets were not walked. A route not found, or a tag that \"doesn't appear\", is NOT proof "
      + "the equipment is unconnected — say the trace is partial.",
    );
    expect(near).not.toHaveProperty("graph_unavailable");
    // Quick lookups: every sheet is walked, nothing partial.
    seedBase({ knowledge_page_entities: rows() });
    db.costMs = {};
    const whole = await trace({ start_tag: "T-150", hops: 1 });
    expect(whole).toEqual({ start: "T-150", connected: [{ tag: "E204", hops: 1 }, { tag: "P101", hops: 1 }], basis: SHEET_BASIS });
  });

  it("…and a confirmed flow whose source the org check could not reach in time is not walked (fails closed), said the same way", async () => {
    // A flow read off k-a (the org's own upload). The mirror lookup starts
    // at 0 and ends at 6 s; the org check would start after it, past 5 s.
    const flows = () => [flow(["asset", A_P101], ["asset", A_E204], "confirmed", { origin: "ai", source_document_id: "k-a" })];
    seedBase({ process_flows: flows() });
    db.costMs.knowledge_documents = 6_000;
    const late = await trace({ start_tag: "P-101", end_tag: "E-204" });
    expect(late).toMatchObject({ found: false, reason: "P-101 doesn't appear on any traced line." });
    expect(String(late.graph_partial)).toMatch(/^PARTIAL: checking which of the drawings you may open took longer than one trace may spend on it \(5 s\)/);
    // The org's own check: by org and id, never started.
    expect(queriesOf("knowledge_documents").filter((q) => callArgs(q, "eq").some(([c]) => c === "org_id"))).toHaveLength(0);
    seedBase({ process_flows: flows() });
    db.costMs = {};
    expect(await trace({ start_tag: "P-101", end_tag: "E-204" })).toMatchObject({ found: true, path: ["P101", "E204"], drawings: ["k-a"] });
  });

  it("…and a mirror whose readability the trace has no time left to ask is not walked either", async () => {
    // P-101 and E-204 on k-c, a mirror the Viewer may read. The one mirror
    // lookup ends at 6 s; the readability call would start after it.
    const sheets = () => [ent("k-c", 1, "equipment", "P-101"), ent("k-c", 1, "equipment", "E-204")];
    seedBase({ knowledge_page_entities: sheets() });
    db.costMs.knowledge_documents = 6_000;
    const late = await trace({ start_tag: "P-101", hops: 1 });
    expect(late).toMatchObject({ start: "P-101", connected: [] });
    expect(String(late.graph_partial)).toMatch(/^PARTIAL: checking which of the drawings you may open took longer/);
    seedBase({ knowledge_page_entities: sheets() });
    db.costMs = {};
    expect(await trace({ start_tag: "P-101", hops: 1 })).toEqual({ start: "P-101", connected: [{ tag: "E204", hops: 1 }], basis: SHEET_BASIS });
  });
});

describe("flowsToLineEdges — confirmed rows only, paged, every end resolved", () => {
  const admin = { from: (t: string) => makeChain("admin", t) } as never;

  it("each edge is a LineEdge naming its basis: lineId the flow, drawingId its source sheet, tag-normalised ends, the stream", async () => {
    seedBase({
      process_flows: [
        flow(["asset", A_P101], ["asset", A_E204], "confirmed", { origin: "ai", source_document_id: "k-c", label: "  overhead vapour " }),
        flow(["asset", A_E204], ["unit", "30"], "confirmed"),
        flow(["asset", A_T150], ["asset", A_E204], "proposed"),
        flow(["asset", A_T150], ["asset", A_P101], "dismissed"),
      ],
    });
    const out = await flowsToLineEdges(ORG, admin);
    expect(out).toEqual({
      edges: [
        { lineId: "f-0000000", from: "P101", to: "E204", drawingId: "k-c", basis: "confirmed_flow", label: "overhead vapour" },
        { lineId: "f-0000001", from: "E204", to: "UNIT30", basis: "confirmed_flow" },
      ],
      state: "ok", truncated: false, skipped: 0, unitNodes: ["UNIT30"],
    });
  });

  it("reads with the browser client by default (RLS), the service role only when the server passes it", async () => {
    seedBase({ process_flows: [flow(["unit", "20"], ["unit", "30"], "confirmed")] });
    await flowsToLineEdges(ORG);
    expect(queriesOf("process_flows").map((q) => q.client)).toEqual(["browser", "browser"]);
    db.queries = [];
    await flowsToLineEdges(ORG, admin);
    expect(queriesOf("process_flows").every((q) => q.client === "admin")).toBe(true);
  });

  it("pages by key past one response, and a short page is not taken as the last", async () => {
    const rows = Array.from({ length: FLOW_EDGE_PAGE * 2 + 37 }, () => flow(["unit", "20"], ["unit", "30"], "confirmed"));
    seedBase({ process_flows: rows });
    db.maxRows = 300;
    const out = await flowsToLineEdges(ORG, admin);
    expect(out.edges).toHaveLength(rows.length);
    expect(out.truncated).toBe(false);
    const gts = queriesOf("process_flows").flatMap((q) => callArgs(q, "gt"));
    expect(gts.length).toBeGreaterThan(2);
    expect(gts.every(([col]) => col === "id")).toBe(true);
  });

  it(`past ${FLOW_EDGE_CEILING.toLocaleString("en-US")} confirmed flows the read stops and says so; the trace says so too`, async () => {
    seedBase({ process_flows: Array.from({ length: FLOW_EDGE_CEILING + 5 }, () => flow(["unit", "20"], ["unit", "30"], "confirmed")) });
    const out = await flowsToLineEdges(ORG, admin);
    expect(out.edges).toHaveLength(FLOW_EDGE_CEILING);
    expect(out.truncated).toBe(true);
    const t = await trace({ start_tag: "Unit 20", end_tag: "Unit 30" });
    expect(t.found).toBe(true);
    expect(String(t.confirmed_flows_partial)).toMatch(/More than 20,000 confirmed process flows exist/);
  }, 60_000);

  it("a read that fails (not a missing table) uses no flow, and the trace says the flows could not be read — never 'none'", async () => {
    seedBase({ knowledge_page_entities: sheetSeed(), process_flows: [flow(["asset", A_P101], ["asset", A_E204], "confirmed")] });
    db.errors.process_flows = { code: "57014", message: "canceling statement due to statement timeout" };
    expect(await flowsToLineEdges(ORG, admin)).toEqual({
      edges: [], state: "error", error: "canceling statement due to statement timeout", truncated: false, skipped: 0, unitNodes: [],
    });
    const out = await trace({ start_tag: "P-101", end_tag: "E-204" });
    // Today's answer, plus one sentence that names the failure.
    const { confirmed_flows_unavailable: note, ...rest } = out;
    expect(rest).toEqual(GOLDEN_PATH);
    expect(String(note)).toMatch(/could not be read \(canceling statement due to statement timeout\)/);
    expect(String(note)).toMatch(/NOT the same as the plant having no confirmed flows/);
  });
});

describe("DEC-80 item 2 — nothing flow-derived drives a hold or an MOC", () => {
  const ROOT = join(__dirname, "..", "..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name === "__tests__") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(name)) out.push(full.slice(ROOT.length + 1));
    }
    return out;
  };
  const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

  it("flowsToLineEdges has one consumer: the orchestrator's read-only line trace", () => {
    const users = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]
      // A call, a definition or an import — a comment naming it is not a use.
      .filter((f) => /flowsToLineEdges\(|\{[^}]*\bflowsToLineEdges\b[^}]*\}\s*from/.test(src(f)));
    expect(users.sort()).toEqual(["lib/orchestrator/tools.ts", "lib/processFlows.ts"]);
    const tools = src("lib/orchestrator/tools.ts");
    const body = tools.slice(tools.indexOf("async function loadLineGraph(ctx: ToolContext)"));
    expect(body.slice(0, body.indexOf("\n}"))).toMatch(/flowsToLineEdges\(ctx\.orgId, supabaseAdmin, \{ deadline: startedAt \+ LINE_GRAPH_READ_BUDGET_MS \}\)/);
    expect(tools.match(/flowsToLineEdges\(/g)).toHaveLength(1);
    // loadLineGraph is called once, by the per-run memo (fix pass 4), which
    // the trace tool alone calls; and the trace tool writes nothing.
    expect(tools.match(/loadLineGraph\(ctx\)/g)).toHaveLength(1);
    const memo = tools.slice(tools.indexOf("function lineGraphFor(ctx: ToolContext)"));
    expect(memo.slice(0, memo.indexOf("\n}"))).toContain("loadLineGraph(ctx)");
    expect(tools.match(/lineGraphFor\(ctx\)/g)).toHaveLength(1);
    const traceBody = tools.slice(tools.indexOf("const tracePidLines"));
    expect(traceBody.slice(0, traceBody.indexOf("\n};"))).toContain("await lineGraphFor(ctx)");
    const traceTool = TOOLS.find((t) => t.name === "trace_pid_lines")!;
    expect(traceTool.writes).toBeFalsy();
    for (const t of TOOLS.filter((x) => x.writes)) {
      const def = tools.slice(tools.indexOf(`name: "${t.name}"`));
      expect(def.slice(0, def.indexOf("\n};")), t.name).not.toMatch(/loadLineGraph|flowsToLineEdges|tracePath|traceNeighbourhood/);
    }
  });

  it("the hidden-sheet filter and the caller-scoped graph are kept (sweepRoundC's pins)", () => {
    const tools = src("lib/orchestrator/tools.ts");
    const body = tools.slice(tools.indexOf("async function loadLineGraph(ctx: ToolContext)"));
    expect(body.slice(0, body.indexOf("\n}"))).toMatch(/if \(hidden\.has\(row\.document_id\)\) continue;/);
    expect(tools).not.toMatch(/loadLineGraph\(ctx\.orgId\)/);
    expect(tools).not.toMatch(/\.limit\(20000\)/);
  });
});

describe("lib/pidTrace — the basis rides on the step; a directional neighbourhood", () => {
  const EDGES: LineEdge[] = [
    { lineId: "f1", from: "A", to: "B", basis: "confirmed_flow" },
    { lineId: "f2", from: "B", to: "C", basis: "confirmed_flow" },
    { lineId: "p1", from: "C", to: "D", drawingId: "k1", basis: "same_sheet" },
    { lineId: "L-1", from: "X", to: "Y" },
  ];

  it("a step carries its edge's basis; an edge that names none gives a step exactly as before", () => {
    expect(tracePath(EDGES, "A", "D").steps.map((s) => s.basis)).toEqual(["confirmed_flow", "confirmed_flow", "same_sheet"]);
    expect(tracePath(EDGES, "X", "Y").steps).toEqual([{ lineId: "L-1", from: "X", to: "Y", drawingId: undefined, offPage: false, components: [] }]);
  });

  it("downstream follows each edge its stored way, upstream against it; omitted, the walk is undirected as before", () => {
    const flows = EDGES.filter((e) => e.basis === "confirmed_flow");
    expect(traceNeighbourhood(flows, "B", 2, "downstream")).toEqual([{ tag: "C", hops: 1 }]);
    expect(traceNeighbourhood(flows, "B", 2, "upstream")).toEqual([{ tag: "A", hops: 1 }]);
    expect(traceNeighbourhood(flows, "A", 2, "downstream")).toEqual([{ tag: "B", hops: 1 }, { tag: "C", hops: 2 }]);
    expect(traceNeighbourhood(flows, "A", 2, "upstream")).toEqual([]);
    expect(traceNeighbourhood(EDGES, "B", 2)).toEqual(traceNeighbourhood(EDGES, "B", 2, undefined));
    expect(traceNeighbourhood(EDGES, "B", 2)).toEqual([{ tag: "A", hops: 1 }, { tag: "C", hops: 1 }, { tag: "D", hops: 2 }]);
  });

  it("fix pass 2, on random graphs: a route with no flow step is the route the sheets alone give, and a neighbourhood with no tag through a flow is the sheets' own", () => {
    // What lets trace_pid_lines answer as before whenever it rests on no
    // flow: flows ahead of the sheet edges never change a sheet-only route.
    let seed = 20261007;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
    let routes = 0;
    for (let t = 0; t < 4000; t++) {
      const n = 3 + rnd(12);
      const node = () => `N${rnd(n)}`;
      const sheets: LineEdge[] = Array.from({ length: rnd(n * 2) }, (_, k) => ({ lineId: `p${k}`, from: node(), to: node(), basis: "same_sheet" as const }))
        .filter((e) => e.from !== e.to);
      const flows: LineEdge[] = Array.from({ length: rnd(8) }, (_, k) => ({ lineId: `f${k}`, from: node(), to: node(), basis: "confirmed_flow" as const }))
        .filter((e) => e.from !== e.to);
      const [a, b] = [node(), node()];
      const r = tracePath([...flows, ...sheets], a, b);
      if (r.found && !r.steps.some((st) => st.basis === "confirmed_flow")) {
        routes += 1;
        expect(r).toEqual(tracePath(sheets, a, b));
      }
      const hops = 1 + rnd(3);
      const near = traceNeighbourhood([...flows, ...sheets], a, hops);
      const bySheet = traceNeighbourhood(sheets, a, hops);
      const at = new Map(bySheet.map((x) => [x.tag, x.hops]));
      if (near.every((x) => (at.get(x.tag) ?? Infinity) <= x.hops)) expect(near).toEqual(bySheet);
    }
    expect(routes).toBeGreaterThan(500);
  });

  it("a terminal node is reached and never passed through, unless the walk starts there", () => {
    const hub: LineEdge[] = [
      { lineId: "f1", from: "S", to: "U", basis: "confirmed_flow" },
      { lineId: "f2", from: "U", to: "A", basis: "confirmed_flow" },
      { lineId: "f3", from: "U", to: "B", basis: "confirmed_flow" },
      { lineId: "f4", from: "A", to: "C", basis: "confirmed_flow" },
    ];
    const units = new Set(["U"]);
    expect(traceNeighbourhood(hub, "A", 3, "upstream", units)).toEqual([{ tag: "U", hops: 1 }]);
    expect(traceNeighbourhood(hub, "S", 3, "downstream", units)).toEqual([{ tag: "U", hops: 1 }]);
    expect(traceNeighbourhood(hub, "A", 3, undefined, units)).toEqual([{ tag: "C", hops: 1 }, { tag: "U", hops: 1 }]);
    expect(traceNeighbourhood(hub, "U", 2, "downstream", units))
      .toEqual([{ tag: "A", hops: 1 }, { tag: "B", hops: 1 }, { tag: "C", hops: 2 }]);
    // Omitted, nothing is terminal: exactly as before.
    expect(traceNeighbourhood(hub, "A", 3, "upstream")).toEqual([{ tag: "U", hops: 1 }, { tag: "S", hops: 2 }]);
  });
});
