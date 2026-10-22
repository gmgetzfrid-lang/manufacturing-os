// drafting-flow GAP-101 acceptance 5 (Round G, DF-P19 second fix pass,
// review major 1): "a report can count, FOR ANY PERIOD, tickets by lane, and
// every declaration with its author and text". The analytics page's shared
// read is cut at PostgREST's max-rows, so the Review Lanes panel now reads
// its period WHOLE from /api/admin/analytics/review-lanes: created_at
// filtered on the server, paged past the row limit (readReviewLanePeriod).
//
// Pinned here: the period read (server-side bounds, paging under a max-rows
// smaller than the page, the 42703 column ladder, refusal on any other
// error, the hard cap said as incomplete), the route (the analytics gate
// first, calendar-date bounds, reads as the caller), and the panel / page
// wiring (counts come from the period read; while it reads no count shows;
// a failed read falls back to the page's load with its coverage notice).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  gate: { ok: true as boolean, status: 403, error: "denied" },
  gateCalls: [] as Array<[string, string]>,
  callerErr: null as null | { error: string; status: number },
  client: null as unknown,
}));

vi.mock("@/lib/adminGate", () => ({
  authorizeAdminSurface: vi.fn(async (_req: unknown, orgId: string, surface: string) => {
    state.gateCalls.push([orgId, surface]);
    return state.gate.ok ? { user: { id: "u1" } } : { error: state.gate.error, status: state.gate.status };
  }),
}));
vi.mock("@/lib/serverAuth", () => ({
  callerScopedClient: vi.fn(() => (state.callerErr ? state.callerErr : state.client)),
}));

import {
  readReviewLanePeriod, reviewLanePeriodNotice, laneTicketFromRow, nextUtcDate, summarizeReviewLanes,
  REVIEW_LANE_COLUMNS, REVIEW_LANE_BASE_COLUMNS, REVIEW_LANE_COLUMN_LADDER, REVIEW_LANE_PAGE, REVIEW_LANE_READ_CAP,
} from "@/lib/reviewLaneReport";
import { GET } from "@/app/api/admin/analytics/review-lanes/route";

const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
type Row = Record<string, unknown>;
type LaneClient = Parameters<typeof readReviewLanePeriod>[0];

/** An in-memory `tickets` table behind a PostgREST-shaped builder: eq / gte /
 *  lt / order / range, an exact count, and a server max-rows that cuts every
 *  page (as PostgREST does). `missing` columns raise 42703 when selected. */
function fakeClient(rows: Row[], opts: { maxRows?: number; missing?: string[]; failOn?: number } = {}) {
  const calls: Array<{ cols: string; count: boolean; filters: Array<[string, string, unknown]>; range: [number, number] | null; order: string[] }> = [];
  const client = {
    from(table: "tickets") {
      expect(table).toBe("tickets");
      return {
        select(cols: string, o?: { count: "exact" }) {
          const call = { cols, count: !!o?.count, filters: [] as Array<[string, string, unknown]>, range: null as [number, number] | null, order: [] as string[] };
          calls.push(call);
          const q = {
            eq(c: string, v: unknown) { call.filters.push(["eq", c, v]); return q; },
            gte(c: string, v: unknown) { call.filters.push(["gte", c, v]); return q; },
            lt(c: string, v: unknown) { call.filters.push(["lt", c, v]); return q; },
            order(c: string, x: { ascending: boolean }) { call.order.push(`${c}:${x.ascending ? "asc" : "desc"}`); return q; },
            range(a: number, b: number) { call.range = [a, b]; return q; },
            then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
              return Promise.resolve().then(() => {
                if (opts.failOn !== undefined && calls.length - 1 === opts.failOn) return { data: null, error: { message: "boom", code: "XX000" }, count: null };
                if (cols !== "*" && (opts.missing ?? []).some((m) => cols.split(", ").includes(m))) {
                  return { data: null, error: { message: `column tickets.${opts.missing![0]} does not exist`, code: "42703" }, count: null };
                }
                let out = rows.filter((r) => call.filters.every(([op, c, v]) => {
                  const x = String(r[c] ?? "");
                  if (op === "eq") return x === String(v);
                  if (op === "gte") return x >= String(v);
                  return x < String(v);
                }));
                out = [...out].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
                const total = out.length;
                const [a, b] = call.range ?? [0, out.length - 1];
                const want = b - a + 1;
                const page = out.slice(a, a + Math.min(want, opts.maxRows ?? Infinity));
                return { data: page, error: null, count: call.count ? total : null };
              }).then(res, rej);
            },
          };
          return q;
        },
      };
    },
  };
  return { client: client as unknown as LaneClient, calls };
}

const ORG = "o1";
const mk = (i: number, day: string, over: Row = {}): Row => ({
  id: `t${String(i).padStart(5, "0")}`, org_id: ORG, ticket_id: `REQ-${i}`, title: `R ${i}`, status: "DRAFTING",
  created_at: `${day}T${String(i % 24).padStart(2, "0")}:00:00.000Z`, requester_id: "u", requester_name: "U",
  engineering_required: i % 3 === 0, review_model_filed: true,
  like_in_kind_statement: i % 3 === 1 ? `same as ${i}` : null, like_in_kind_declared_by: i % 3 === 1 ? "u" : null,
  like_in_kind_declared_at: i % 3 === 1 ? `${day}T00:00:00.000Z` : null, like_in_kind_signature_id: null,
  work_class: null, code_class: null, ...over,
});

describe("readReviewLanePeriod — the period, whole, whatever the row limit", () => {
  it("3,000 requests and a max-rows of 1,000 (the reviewer's case): a period in 2025 is read in full, filtered on the server", async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 3000; i++) rows.push(mk(i, i < 1200 ? "2025-03-10" : "2026-09-01"));
    rows.push(mk(9001, "2025-02-28"), mk(9002, "2025-04-01"));         // just outside the period
    const { client, calls } = fakeClient(rows, { maxRows: 1000 });
    const out = await readReviewLanePeriod(client, ORG, { from: "2025-03-01", to: "2025-03-31" });
    expect(out.complete).toBe(true);
    expect(out.total).toBe(1200);
    expect(out.rows).toHaveLength(1200);
    expect(new Set(out.rows.map((r) => r.id)).size).toBe(1200);
    // the bounds are on the server: inclusive UTC dates, the day after `to` exclusive
    expect(calls[0].filters).toEqual([["eq", "org_id", ORG], ["gte", "created_at", "2025-03-01T00:00:00.000Z"], ["lt", "created_at", "2025-04-01T00:00:00.000Z"]]);
    expect(calls[0].order).toEqual(["created_at:asc", "id:asc"]);
    expect(calls[0].count).toBe(true);
    expect(calls.slice(1).every((c) => !c.count)).toBe(true);
    // lane counts and declarations cover the whole period
    const summary = summarizeReviewLanes(out.rows.map(laneTicketFromRow), { from: "2025-03-01", to: "2025-03-31" });
    expect(summary.total).toBe(1200);
    expect(summary.declarations).toHaveLength(400);
    expect(summary.lanes.engineered + summary.lanes.like_in_kind + summary.lanes.legacy_gate + summary.lanes.not_recorded).toBe(1200);
  });

  it("each page starts after the rows that came back — a max-rows smaller than the page loses nothing", async () => {
    const rows = Array.from({ length: 23 }, (_, i) => mk(i, "2026-01-05"));
    const { client, calls } = fakeClient(rows, { maxRows: 7 });
    const out = await readReviewLanePeriod(client, ORG, { from: null, to: null });
    expect(out).toMatchObject({ total: 23, complete: true });
    expect(out.rows.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(calls.map((c) => c.range)).toEqual([[0, REVIEW_LANE_PAGE - 1], [7, 7 + REVIEW_LANE_PAGE - 1], [14, 14 + REVIEW_LANE_PAGE - 1], [21, 21 + REVIEW_LANE_PAGE - 1]]);
    // an open period has no created_at bound
    expect(calls[0].filters).toEqual([["eq", "org_id", ORG]]);
  });

  it("no count back: it pages until an empty page", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => mk(i, "2026-01-05"));
    const { client } = fakeClient(rows, { maxRows: 2 });
    const noCount = { from: (t: "tickets") => { const s = client.from(t); return { select: (c: string) => s.select(c) }; } } as LaneClient;
    const out = await readReviewLanePeriod(noCount, ORG, { from: "2026-01-01", to: null });
    expect(out).toMatchObject({ total: null, complete: true });
    expect(out.rows).toHaveLength(5);
  });

  it("before 20261250 the review-model columns are missing: the read steps down the column ladder (42703), never failing", async () => {
    expect(REVIEW_LANE_COLUMN_LADDER).toEqual([REVIEW_LANE_COLUMNS, REVIEW_LANE_BASE_COLUMNS, "*"]);
    expect(REVIEW_LANE_COLUMNS).not.toMatch(/comments|history|attachments/);
    const rows = [mk(1, "2026-01-05")];
    const { client, calls } = fakeClient(rows, { missing: ["engineering_required"] });
    const out = await readReviewLanePeriod(client, ORG, { from: null, to: null });
    expect(out.rows).toHaveLength(1);
    expect(calls.map((c) => c.cols)).toEqual([REVIEW_LANE_COLUMNS, REVIEW_LANE_BASE_COLUMNS]);
  });

  it("any other error throws — never a silent partial count (also mid-way through the pages)", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => mk(i, "2026-01-05"));
    await expect(readReviewLanePeriod(fakeClient(rows, { failOn: 0 }).client, ORG, { from: null, to: null })).rejects.toThrow("boom");
    await expect(readReviewLanePeriod(fakeClient(rows, { maxRows: 2, failOn: 1 }).client, ORG, { from: null, to: null })).rejects.toThrow("boom");
  });

  it("past REVIEW_LANE_READ_CAP rows in one period the read stops and says it is incomplete", async () => {
    const rows = Array.from({ length: REVIEW_LANE_READ_CAP + 5 }, (_, i) => ({ id: `t${String(i).padStart(6, "0")}`, org_id: ORG, created_at: "2026-01-05T00:00:00.000Z" }));
    const out = await readReviewLanePeriod(fakeClient(rows).client, ORG, { from: null, to: null });
    expect(out).toMatchObject({ total: REVIEW_LANE_READ_CAP + 5, complete: false });
    expect(out.rows).toHaveLength(REVIEW_LANE_READ_CAP);
    expect(reviewLanePeriodNotice({ loaded: out.rows.length, total: out.total, complete: out.complete })).toBe(
      `Showing the first ${REVIEW_LANE_READ_CAP} of ${REVIEW_LANE_READ_CAP + 5} requests filed in this period — one read stops at ${REVIEW_LANE_READ_CAP}. Narrow the period for complete counts.`,
    );
    expect(reviewLanePeriodNotice({ loaded: 3, total: 3, complete: true })).toBeNull();
  });

  it("nextUtcDate and laneTicketFromRow", () => {
    expect(nextUtcDate("2025-12-31")).toBe("2026-01-01");
    expect(nextUtcDate("2024-02-28")).toBe("2024-02-29");
    const t = laneTicketFromRow(mk(1, "2026-01-05", { work_class: "w", code_class: "c" }));
    expect(t).toMatchObject({ id: "t00001", ticketId: "REQ-1", engineeringRequired: false, likeInKindStatement: "same as 1", likeInKindDeclaredBy: "u", workClass: "w", codeClass: "c" });
    // a row without the review-model columns: lane not recorded
    const bare = laneTicketFromRow({ id: "x", created_at: "2026-01-05T00:00:00.000Z" });
    expect(bare.engineeringRequired).toBeUndefined();
    expect(summarizeReviewLanes([bare], { from: null, to: null }).lanes.not_recorded).toBe(1);
  });
});

describe("GET /api/admin/analytics/review-lanes — the analytics gate, then the period as the caller", () => {
  const get = (qs: string) => GET(new NextRequest(`http://x/api/admin/analytics/review-lanes?${qs}`, { headers: { authorization: "Bearer t" } }));
  beforeEach(() => {
    state.gate = { ok: true, status: 403, error: "denied" };
    state.gateCalls = [];
    state.callerErr = null;
    state.client = fakeClient([mk(1, "2025-03-10"), mk(2, "2025-03-11"), mk(3, "2026-01-01")], { maxRows: 1 }).client;
  });

  it("the gate decides first (the analytics surface, fail closed): a refusal reads nothing", async () => {
    state.gate = { ok: false, status: 403, error: "Not allowed" };
    const res = await get("orgId=o1&from=2025-03-01");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Not allowed" });
    expect(state.gateCalls).toEqual([["o1", "analytics"]]);
  });

  it("bounds must be calendar dates, in order", async () => {
    expect((await get("orgId=o1&from=2025-13-40")).status).toBe(400);
    expect((await get("orgId=o1&to=yesterday")).status).toBe(400);
    const res = await get("orgId=o1&from=2025-04-01&to=2025-03-01");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("The period ends before it starts");
  });

  it("reads the whole period through the caller-scoped client (RLS applies) — never a service-role read", async () => {
    const res = await get("orgId=o1&from=2025-03-01&to=2025-03-31");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.complete).toBe(true);
    expect(body.tickets.map((r: Row) => r.id)).toEqual(["t00001", "t00002"]);
    const src = read("app/api/admin/analytics/review-lanes/route.ts");
    expect(src).toContain('await authorizeAdminSurface(req, orgId, "analytics");');
    expect(src).toContain("callerScopedClient(req)");
    expect(src).not.toMatch(/supabaseAdmin|serviceRole/);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });

  it("a caller-client refusal and a read failure are said (never an empty success)", async () => {
    state.callerErr = { error: "Not signed in", status: 401 };
    expect((await get("orgId=o1")).status).toBe(401);
    state.callerErr = null;
    state.client = fakeClient([mk(1, "2025-03-10")], { failOn: 0 }).client;
    const res = await get("orgId=o1");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
  });
});

describe("the panel and the page read the period whole", () => {
  it("the page hands the panel a loader for the review-lanes read, under the caller's bearer", () => {
    const page = read("app/(protected)/admin/analytics/page.tsx");
    expect(page).toContain("fetch(`/api/admin/analytics/review-lanes?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })");
    expect(page).toContain("<ReviewLaneReport tickets={tickets} ticketsTotal={ticketsTotal} loadPeriod={loadReviewLanePeriod}");
    expect(page).toContain("if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);");
  });
  it("the panel counts the period read; while reading no count shows; a failed read falls back to the page's load and says so", () => {
    const panel = read("components/requests/ReviewLaneReport.tsx");
    expect(panel).toContain("const source = (whole ? whole.rows : tickets) as readonly LaneTicket[];");
    expect(panel).toContain("{reading ? '…' : summary.lanes[l]}");
    expect(panel).toContain('data-testid="review-lanes-read-error"');
    expect(panel).toContain("? reviewLanePeriodNotice({ loaded: whole.rows.length, total: whole.total, complete: whole.complete })");
    expect(panel).toContain(": reviewLaneCoverageNotice(coverage);");
    expect(panel).toContain("disabled={reading}");
  });
});
