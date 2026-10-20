// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P14 QUEUE READ AND STATUS-LABEL REMAINDERS —
// UI-7's remaining sites / GAP-108 acceptance 4 (the integrator's ruling
// under DEC-90: every notice, email and chip says ticketStatusLabel(status);
// a stored value stays only where something machine-reads it).
//
//   lib/ticketSla.ts slaNotice — the "Due soon" / "Overdue" bell and email
//     bodies name the stage in words, for every status; the rest of each
//     sentence is unchanged.
//   components/dashboard/widgets.tsx — the Drafting Requests widget's chips
//     read the shared labels (its own third label set is gone), keep their
//     badge classes, word an unknown value, and the single-status pipeline
//     segments read the same words as the chips.
//   app/(protected)/admin/analytics/page.tsx — a member's ticket-list chip.
//   (The workflow route's bell body, email and refusal text are driven
//   through the real handler in dfRoundG_P14_routeLabelsReasons.test.ts.)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { slaNotice, type SlaTicket } from "@/lib/ticketSla";
import { TICKET_STATUS_LABELS, ticketStatusLabel } from "@/lib/ticketStatusLabels";

const h = vi.hoisted(() => ({
  tickets: [] as Array<Record<string, unknown>>,
  analyticsTickets: [] as Array<Record<string, unknown>>,
  /** Every count read of the widget fails with this. */
  statusError: null as null | { message: string },
  /** A count read fails when this says so (its calls). */
  countFailWhen: null as null | ((calls: Array<{ m: string; a: unknown[] }>) => boolean),
  /** A count read answers no count (a proxy that drops Content-Range). */
  noCount: false,
  /** The widget's count reads, with their calls. */
  countReads: [] as Array<Array<{ m: string; a: unknown[] }>>,
}));

/** A HEAD count read as PostgREST answers it (drafting-flow ROUTE-14, the
 *  DF-P14 integrator fix pass): the filters applied (eq / not in / in), the
 *  exact count, no rows. */
function serveCount(calls: Array<{ m: string; a: unknown[] }>): Record<string, unknown> {
  h.countReads.push(calls);
  if (h.statusError) return { data: null, error: h.statusError, count: null };
  if (h.countFailWhen?.(calls)) return { data: null, error: { message: "canceling statement due to statement timeout" }, count: null };
  let rows = [...h.tickets];
  for (const c of calls) {
    if (c.m === "eq" && c.a[0] !== "org_id") rows = rows.filter((t) => t[String(c.a[0])] === c.a[1]);
    if (c.m === "not" && c.a[1] === "in") {
      const list = String(c.a[2]).replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
      rows = rows.filter((t) => !list.includes(String(t[String(c.a[0])])));
    }
    if (c.m === "in") rows = rows.filter((t) => (c.a[1] as unknown[]).includes(t[String(c.a[0])]));
  }
  return { data: null, error: null, count: h.noCount ? null : rows.length };
}

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const calls: Array<{ m: string; a: unknown[] }> = [];
    const hnd: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          const selCall = calls.find((c) => c.m === "select");
          const sel = String(selCall?.a[0] ?? "");
          const head = (selCall?.a[1] as { head?: boolean } | undefined)?.head === true;
          if (table === "tickets" && head) {
            const answer = serveCount(calls);
            return (resolve: (v: unknown) => void) => resolve(answer);
          }
          // Every other read: PostgREST honours .limit(n), so the stand-in
          // does too (the widget's recent-requests list asks for 30; 2,400
          // rows rendered as links made a big-count test slow enough to time
          // out on a loaded machine).
          const limit = calls.find((c) => c.m === "limit")?.a[0] as number | undefined;
          const all = table === "tickets" && sel.startsWith("id, ticket_id") ? h.tickets.filter((t) => t.status !== "CLOSED" && t.status !== "CANCELED") : [];
          const data = typeof limit === "number" ? all.slice(0, limit) : all;
          return (resolve: (v: unknown) => void) => resolve({ data, error: null, count: data.length });
        }
        return (...a: unknown[]) => { calls.push({ m: prop, a }); return new Proxy({}, hnd); };
      },
    };
    return new Proxy({}, hnd);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } };
});
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ activeOrgId: "o1", uid: "u1", activeRole: "Admin", roles: ["Admin"], hasAnyRole: () => true }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }), usePathname: () => "/" }));
const stub = vi.hoisted(() => () => null);
vi.mock("@/components/documents/NodeCover", () => ({ default: stub }));
vi.mock("@/components/documents/DocThumb", () => ({ default: stub }));
vi.mock("@/components/documents/DocHoverPreview", () => ({ default: stub }));
vi.mock("@/components/ui/UserAvatar", () => ({ default: stub }));
vi.mock("@/lib/inbox", () => ({ loadInbox: vi.fn() }));
vi.mock("@/lib/nudges", () => ({ computeNudges: vi.fn(() => []) }));
vi.mock("@/lib/markupRequests", () => ({ resolveMarkupRequest: vi.fn() }));
vi.mock("@/hooks/useTicketNotifications", () => ({ useTicketNotifications: () => ({ items: [], counts: {}, markRead: vi.fn(), markAllRead: vi.fn(), loading: false }) }));
vi.mock("@/components/cockpit/DailyBrief", () => ({ DailyBrief: stub }));
vi.mock("@/components/cockpit/QuickLaunch", () => ({ QuickLaunch: stub }));
vi.mock("@/components/cockpit/AttentionFeed", () => ({ AttentionFeed: stub }));
vi.mock("@/components/cockpit/CommandDeck", () => ({ CommandDeck: stub, roleFocus: () => null, exportInboxCsv: vi.fn(), formatAgo: () => "" }));
vi.mock("@/components/cockpit/MyDeskPanel", () => ({ default: stub }));
vi.mock("@/components/onboarding/SetupChecklist", () => ({ default: stub }));
vi.mock("@/components/navigation/ViewTabs", () => ({ default: stub, HOME_VIEWS: [] }));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { WIDGET_CATALOG } from "@/components/dashboard/widgets";
import AnalyticsPage from "@/app/(protected)/admin/analytics/page";
import InboxPage from "@/app/(protected)/inbox/page";
import { loadInbox } from "@/lib/inbox";
import type { DashboardWidget } from "@/lib/dashboard/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATUSES = Object.keys(TICKET_STATUS_LABELS);
const RAW = /\b(PENDING_ASSIGNMENT|PENDING_ENG_TEAM|DRAFTING|REVISION_REQ|PENDING_REVIEW|PENDING_FINAL_APPROVAL|PENDING_IFC|FINAL_DRAFT|CLOSED|CANCELED)\b/;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  h.tickets = []; h.analyticsTickets = []; h.statusError = null; h.countFailWhen = null; h.noCount = false; h.countReads = [];
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

// ─── the SLA clock's notices ──────────────────────────────────────────────────

describe("UI-7 — the SLA clock's 'Due soon' / 'Overdue' bodies name the stage in words", () => {
  const T0 = Date.parse("2026-10-01T00:00:00.000Z");
  const DAY = 86_400_000;
  const tk = (status: string): SlaTicket => ({
    id: "t1", orgId: "o1", ticketId: "REQ-1", title: "Pump iso", status: status as SlaTicket["status"], requestType: "ISO",
    requesterId: "req-1", assignedDrafterId: "d-1", assignedEngineerId: "e-1",
    createdAt: new Date(T0).toISOString(), targetCompletionAt: new Date(T0 + 4 * DAY).toISOString(),
  } as SlaTicket);
  it("every status, both stages: the shared label, never the stored value", () => {
    for (const status of STATUSES) {
      for (const [stage, now] of [["warn", T0 + 3 * DAY], ["breach", T0 + 5 * DAY]] as const) {
        const n = slaNotice(tk(status), stage, T0 + 4 * DAY, "UTC", now);
        expect(n.body, `${status} ${stage}`).toContain(`“${ticketStatusLabel(status)}”`);
        expect(n.body, `${status} ${stage}`).not.toMatch(RAW);
      }
    }
  });
  it("the sentences are otherwise exactly as before", () => {
    const target = T0 + 4 * DAY;
    expect(slaNotice(tk("DRAFTING"), "warn", target, "UTC", T0 + 3 * DAY).body)
      .toMatch(/^This request is due [^.]+ and has used 75% of its time\. It is waiting at the “Drafting” stage\.$/);
    expect(slaNotice(tk("DRAFTING"), "breach", target, "UTC", T0 + 5 * DAY).body)
      .toMatch(/and is still waiting at the “Drafting” stage\. Reassign it, or tell the requester when it will be done\.$/);
    expect(slaNotice(tk("PENDING_REVIEW"), "breach", target, "UTC", T0 + 5 * DAY).body)
      .toContain("is waiting at the “In review” stage, on the requester's review. Nothing needs reassigning: the requester's review moves it on.");
    expect(slaNotice(tk("FINAL_DRAFT"), "warn", target, "UTC", T0 + 3 * DAY).body)
      .toContain("It is waiting at the “Issued — awaiting acknowledgement” stage, on the requester's acknowledgement.");
    // the titles are unchanged
    expect(slaNotice(tk("DRAFTING"), "breach", target, "UTC", T0 + 5 * DAY).title).toBe("Overdue · REQ-1 Pump iso");
    expect(slaNotice(tk("DRAFTING"), "warn", target, "UTC", T0 + 3 * DAY).title).toBe("Due soon · REQ-1 Pump iso");
  });
});

// ─── the dashboard widget ─────────────────────────────────────────────────────

describe("UI-7 — the Drafting Requests widget reads the shared labels (no third label set)", () => {
  const renderWidget = async () => {
    const Body = WIDGET_CATALOG.draftingRequests.Body;
    await act(async () => { root.render(React.createElement(Body, { widget: { id: "w1", type: "draftingRequests" } as unknown as DashboardWidget })); });
    await flush();
  };
  const open = STATUSES.filter((s) => s !== "CLOSED" && s !== "CANCELED");
  it("each open request's chip says ticketStatusLabel(status), with its badge class kept", async () => {
    h.tickets = open.map((status, i) => ({ id: `t${i}`, ticket_id: `REQ-${i}`, title: `T ${status}`, status, created_at: "2026-10-01T00:00:00.000Z", requester_name: "Rita", assigned_drafter_name: null, updated_at: null }));
    await renderWidget();
    const chips = Array.from(host.querySelectorAll("a[href^='/requests/t'] span.font-bold.rounded.border"));
    expect(chips.map((c) => c.textContent)).toEqual(open.map((s) => TICKET_STATUS_LABELS[s as keyof typeof TICKET_STATUS_LABELS]));
    expect(host.textContent).not.toMatch(RAW);
    // the badge classes are the widget's own, as before
    const cls = (status: string) => chips[open.indexOf(status)].className;
    expect(cls("PENDING_ENG_TEAM")).toContain("bg-indigo-50");
    expect(cls("PENDING_ASSIGNMENT")).toContain("bg-purple-50");
    expect(cls("DRAFTING")).toContain("bg-blue-50");
    expect(cls("PENDING_IFC")).toContain("bg-teal-50");
    // the old words are gone
    for (const old of ["Eng review", "Unassigned", "Revisions", "Pending IFC", "Final draft", "Final appr."]) {
      expect(chips.map((c) => c.textContent)).not.toContain(old);
    }
  });
  it("a status this build does not know is worded, never shown raw; the pipeline's single-status parts read the chips' words", async () => {
    h.tickets = [
      { id: "t1", ticket_id: "REQ-1", title: "x", status: "ON_HOLD_FOR_VENDOR", created_at: "2026-10-01T00:00:00.000Z" },
      { id: "t2", ticket_id: "REQ-2", title: "y", status: "PENDING_ASSIGNMENT", created_at: "2026-10-01T00:00:00.000Z" },
      { id: "t3", ticket_id: "REQ-3", title: "z", status: "PENDING_ENG_TEAM", created_at: "2026-10-01T00:00:00.000Z" },
    ];
    await renderWidget();
    expect(host.textContent).toContain("On hold for vendor");
    expect(host.textContent).not.toContain("ON_HOLD_FOR_VENDOR");
    // the bar's legend: the two single-status parts present here say what their chips say
    expect(host.textContent).toContain("Awaiting drafter");
    expect(host.textContent).toContain("Engineering review");
  });
  // drafting-flow ROUTE-14 (DF-P14 integrator fix pass, DEC-90): the open
  // count and the pipeline bar are exact HEAD counts, whatever the number.
  const T = Date.parse("2026-10-13T10:00:00.000Z");
  /** n open requests: the first `drafting` DRAFTING, then PENDING_ASSIGNMENT,
   *  every 7th PENDING_REVIEW and every 11th REVISION_REQ; plus 50 closed. */
  const openRequests = (n: number, drafting = Math.floor(n / 2)) => [
    ...Array.from({ length: n }, (_, i) => ({
      id: `t${String(i).padStart(5, "0")}`, ticket_id: `REQ-${i}`, title: `T${i}`,
      status: i % 11 === 10 ? "REVISION_REQ" : i % 7 === 6 ? "PENDING_REVIEW" : i < drafting ? "DRAFTING" : "PENDING_ASSIGNMENT",
      created_at: "2026-10-01T00:00:00.000Z", last_modified: new Date(T - i * 60_000).toISOString(),
    })),
    ...Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, ticket_id: `REQ-C${i}`, title: `C${i}`, status: i % 2 ? "CLOSED" : "CANCELED", created_at: "2026-09-01T00:00:00.000Z" })),
  ];
  /** What the rows imply: the open count and each pipeline part. */
  const implied = () => {
    const open = h.tickets.filter((t) => t.status !== "CLOSED" && t.status !== "CANCELED");
    const n = (...st: string[]) => open.filter((t) => st.includes(String(t.status))).length;
    return {
      open: open.length,
      parts: [
        [ticketStatusLabel("PENDING_ENG_TEAM"), n("PENDING_ENG_TEAM")],
        [ticketStatusLabel("PENDING_ASSIGNMENT"), n("PENDING_ASSIGNMENT")],
        [ticketStatusLabel("DRAFTING"), n("DRAFTING")],
        ["In review or revision", n("PENDING_REVIEW", "REVISION_REQ")],
        ["Closing out", n("PENDING_IFC", "FINAL_DRAFT", "PENDING_FINAL_APPROVAL")],
      ] as Array<[string, number]>,
    };
  };
  const barLabel = () => host.querySelector("[role=img][aria-label]")?.getAttribute("aria-label") ?? null;
  for (const n of [1, 2000, 2400]) {
    it(`${n.toLocaleString("en-US")} open request${n === 1 ? "" : "s"}: the count and the pipeline bar are the numbers the rows imply (exact counts, never rows counted from a capped read)`, async () => {
      h.tickets = openRequests(n);
      await renderWidget();
      const want = implied();
      expect(want.open).toBe(n);
      expect(host.querySelector("[data-testid=drafting-open-count]")?.textContent).toBe(String(n));
      expect(barLabel()).toBe(want.parts.filter(([, c]) => c > 0).map(([l, c]) => `${l} ${c}`).join(", "));
      expect(host.querySelector("[data-testid=drafting-open-count-fault]")).toBeNull();
      expect(host.querySelector("[data-testid=drafting-pipeline-fault]")).toBeNull();
      // one count for the open requests and one per pipeline part — HEAD reads, no rows — whatever n is
      expect(h.countReads.length).toBe(6);
      for (const calls of h.countReads) {
        expect(calls).toEqual(expect.arrayContaining([{ m: "eq", a: ["org_id", "o1"] }, { m: "not", a: ["status", "in", '("CLOSED","CANCELED")'] }]));
        expect(calls.some((c) => c.m === "limit")).toBe(false);
      }
      // the recent list is as before: 30 rows at most
      expect(host.querySelectorAll("a[href^='/requests/t']").length).toBe(Math.min(n, 30));
    }, 30_000);
  }
  it("REGRESSION: a status outside the pipeline is counted in the open total as before, in no part of the bar", async () => {
    h.tickets = [
      { id: "t1", ticket_id: "REQ-1", title: "x", status: "ON_HOLD_FOR_VENDOR", created_at: "2026-10-01T00:00:00.000Z" },
      { id: "t2", ticket_id: "REQ-2", title: "y", status: "DRAFTING", created_at: "2026-10-01T00:00:00.000Z" },
    ];
    await renderWidget();
    expect(host.querySelector("[data-testid=drafting-open-count]")?.textContent).toBe("2");
    expect(barLabel()).toBe(`${ticketStatusLabel("DRAFTING")} 1`);
  });
  it("no open request: 0, no bar, 'No open requests' — as before", async () => {
    h.tickets = openRequests(0);
    await renderWidget();
    expect(host.querySelector("[data-testid=drafting-open-count]")?.textContent).toBe("0");
    expect(barLabel()).toBeNull();
    expect(host.textContent).toContain("No open requests.");
  });
  it("a failed count is SAID — never '0 open requests'", async () => {
    h.statusError = { message: "canceling statement due to statement timeout" };
    h.tickets = [{ id: "t1", ticket_id: "REQ-1", title: "x", status: "DRAFTING", created_at: "2026-10-01T00:00:00.000Z" }];
    await renderWidget();
    expect(host.querySelector("[data-testid=drafting-open-count]")?.textContent).toBe("—");
    expect(host.querySelector("[data-testid=drafting-open-count-fault]")?.textContent).toMatch(/could not be counted — canceling statement/);
    expect(barLabel()).toBeNull();
  });
  it("a count that comes back with no number is a fault, never a 0", async () => {
    h.noCount = true;
    h.tickets = openRequests(3);
    await renderWidget();
    expect(host.querySelector("[data-testid=drafting-open-count]")?.textContent).toBe("—");
    expect(host.querySelector("[data-testid=drafting-open-count-fault]")?.textContent).toMatch(/could not be counted — no count came back/);
  });
  it("one pipeline part's count fails: the total stands, the bar is left out and the reason said — never a short bar as whole", async () => {
    h.countFailWhen = (calls) => calls.some((c) => c.m === "in" && (c.a[1] as string[]).includes("DRAFTING"));
    h.tickets = openRequests(40);
    await renderWidget();
    expect(host.querySelector("[data-testid=drafting-open-count]")?.textContent).toBe("40");
    expect(barLabel()).toBeNull();
    expect(host.querySelector("[data-testid=drafting-pipeline-fault]")?.textContent).toMatch(/could not be counted — canceling statement/);
    expect(host.querySelector("[data-testid=drafting-open-count-fault]")).toBeNull();
  });
  it("source: the widget keeps no label words of its own for a status", () => {
    const src = readFileSync(join(process.cwd(), "components/dashboard/widgets.tsx"), "utf8");
    expect(src).not.toMatch(/label: "Eng review"|label: "Unassigned"|label: "Pending IFC"|label: "Final draft"|label: s \?\? "—"/);
    expect(src).toContain("ticketStatusLabel(");
  });
});

// ─── /admin/analytics ─────────────────────────────────────────────────────────

describe("UI-7 — /admin/analytics: a member's ticket-list chip says the shared label", () => {
  it("rendered: the drafter's tickets with revisions list their status in words", async () => {
    h.analyticsTickets = [
      { id: "a1", org_id: "o1", ticket_id: "REQ-1", title: "Iso one", status: "PENDING_IFC", assigned_drafter_id: "d-1", assigned_drafter_name: "Dan", requester_id: "r-1", requester_name: "Rita", revision_count: 2, created_at: "2026-09-01T00:00:00.000Z", last_modified: "2026-10-01T00:00:00.000Z", comments: [], history: [], attachments: [] },
      { id: "a2", org_id: "o1", ticket_id: "REQ-2", title: "Iso two", status: "FINAL_DRAFT", assigned_drafter_id: "d-1", assigned_drafter_name: "Dan", requester_id: "r-1", requester_name: "Rita", revision_count: 1, created_at: "2026-09-02T00:00:00.000Z", last_modified: "2026-10-02T00:00:00.000Z", comments: [], history: [], attachments: [] },
      { id: "a3", org_id: "o1", ticket_id: "REQ-3", title: "Iso three", status: "CLOSED", assigned_drafter_id: "d-1", assigned_drafter_name: "Dan", requester_id: "r-1", requester_name: "Rita", revision_count: 1, created_at: "2026-09-03T00:00:00.000Z", last_modified: "2026-10-03T00:00:00.000Z", comments: [], history: [], attachments: [] },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tickets: h.analyticsTickets, documents: [] }), { status: 200, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    await act(async () => { root.render(React.createElement(AnalyticsPage)); });
    await flush();
    const drafterRow = Array.from(host.querySelectorAll("tbody tr")).find((tr) => /Dan/.test(tr.textContent ?? ""));
    expect(drafterRow).toBeTruthy();
    await act(async () => { (drafterRow as HTMLElement).click(); });
    await flush();
    const list = Array.from(host.querySelectorAll("h3")).find((x) => /Tickets Requiring Attention/.test(x.textContent ?? ""))?.parentElement;
    expect(list).toBeTruthy();
    const text = list!.textContent ?? "";
    expect(text).toContain("Ready to issue (IFC)");
    expect(text).toContain("Issued — awaiting acknowledgement");
    expect(text).toContain("Closed");
    expect(text).not.toMatch(RAW);
  });
});

// ─── /inbox (review fix pass 2) ───────────────────────────────────────────────

describe("UI-7 — /inbox: the Assigned / Unread / Watching lists' chip says the shared label", () => {
  it("rendered: every request's chip is ticketStatusLabel(status); a missing status reads '—'", async () => {
    const tk = (id: string, status: string | undefined) => ({ id, ticketId: `REQ-${id}`, title: `Pump ${id}`, status, lastModified: "2026-10-01T00:00:00.000Z" });
    const empty = {
      ticketsAssigned: [tk("a1", "PENDING_REVIEW"), tk("a2", "FINAL_DRAFT")],
      ticketsUnread: [tk("u1", "PENDING_ASSIGNMENT")],
      ticketsWatching: [tk("w1", "PENDING_IFC"), tk("w2", undefined)],
      myCheckouts: [], myOpenHolds: [], markupRequestsToMe: [], milestonesUpcoming: [], milestonesOverdue: [],
      myStaleCheckouts: [], transmittalsAwaitingAck: [], acknowledgmentsPendingOnMe: [], reviewsPendingOnMe: [],
      accessRecertsDue: [], reviewCyclesDueOnMe: [], distributionAcksPendingOnMe: [], unreadNotificationCount: 0,
    };
    vi.mocked(loadInbox).mockResolvedValue(empty as unknown as Awaited<ReturnType<typeof loadInbox>>);
    await act(async () => { root.render(React.createElement(InboxPage)); });
    await flush();
    const chipOf = (id: string) => host.querySelector(`a[href='/requests/${id}']`)?.nextElementSibling?.textContent;
    expect(chipOf("a1")).toBe("In review");
    expect(chipOf("a2")).toBe("Issued — awaiting acknowledgement");
    expect(chipOf("u1")).toBe("Awaiting drafter");
    expect(chipOf("w1")).toBe("Ready to issue (IFC)");
    expect(chipOf("w2")).toBe("—");
    expect(host.textContent).not.toMatch(RAW);
  });
});
