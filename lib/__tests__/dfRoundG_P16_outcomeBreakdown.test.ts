// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P16 QUEUE HISTORY AND OUTCOME BREAKDOWN —
// roles-and-permissions GAP-13 acceptance 2, per-reason half: /admin/analytics
// "How Requests Ended" (components/requests/RequestOutcomes.tsx) breaks each
// outcome down by the workspace's own reasons (DF-P14's list, recorded on each
// accepted end as metadata.outcome_reason {id, label, category}).
//
// The integrator's ruling under DEC-90 (fail-safe, no regression): under each
// outcome, a count per configured reason (by metadata.outcome_reason.id, named
// as currently configured, falling back to the stored words for a removed
// reason) plus "No reason recorded"; the outcome-level numbers unchanged; a
// workspace with no reasons sees exactly today's panel.
//
//   reasonBreakdown — the counts, the names, the sums, the worlds (no list,
//   a renamed reason, a removed reason, a list that cannot be read, a reason
//   recorded on a request whose outcome column was not written).
//   RequestOutcomes — AS RENDERED: byte-identical without reasons; the
//   breakdown under each outcome with them; the outcome tiles unchanged.
//   app/(protected)/admin/analytics/page.tsx — AS RENDERED: reads the
//   workspace's list from the 'drafting' configuration row and shows it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import RequestOutcomes, { reasonBreakdown, type ReasonRow } from "@/components/requests/RequestOutcomes";
import { summarizeOutcomes } from "@/lib/ticketOutcome";
import type { OutcomeReason } from "@/lib/ticketOutcomeReasons";

const h = vi.hoisted(() => ({
  config: { data: null as unknown, error: null as null | { message: string } },
  configReads: 0,
  tickets: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const api: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"]) api[m] = () => api;
    api.maybeSingle = async () => {
      if (table === "org_configurations") { h.configReads++; return h.config; }
      return { data: null, error: null };
    };
    api.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
    return api;
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } };
});
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ activeOrgId: "o1", uid: "u1", activeRole: "Admin", roles: ["Admin"], hasAnyRole: () => true }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }), usePathname: () => "/" }));
vi.mock("@/components/ui/UserAvatar", () => ({ default: () => null }));

import AnalyticsPage from "@/app/(protected)/admin/analytics/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REASONS: OutcomeReason[] = [
  { id: "not_drafting_work", label: "Not drafting work", category: "rejected" },
  { id: "vendor_scope", label: "Vendor scope", category: "rejected" },
  { id: "requester_left", label: "Requester left the site", category: "withdrawn" },
];
const reasonMeta = (id: string, label: string, category: string) => ({ outcome_reason: { id, label, category } });
const n = (k: number, r: ReasonRow): ReasonRow[] => Array.from({ length: k }, () => ({ ...r }));

/** A workspace that keeps reasons: 3 + 1 rejected with reasons, 2 rejected
 *  with none (before the list), 1 rejected with a reason since removed, 2
 *  withdrawn (one with a reason), 4 completed, 1 force close with nothing,
 *  and 2 open requests (never counted). */
const ROWS: ReasonRow[] = [
  ...n(3, { status: "CANCELED", outcome: "rejected", metadata: reasonMeta("not_drafting_work", "Not drafting work", "rejected") }),
  { status: "CANCELED", outcome: "rejected", metadata: reasonMeta("vendor_scope", "Vendor scope", "rejected") },
  ...n(2, { status: "CANCELED", outcome: "rejected", metadata: null }),
  { status: "CANCELED", outcome: "rejected", metadata: reasonMeta("old_budget", "Out of budget this year", "rejected") },
  { status: "CANCELED", outcome: "withdrawn", metadata: reasonMeta("requester_left", "Requester left the site", "withdrawn") },
  { status: "CANCELED", outcome: "withdrawn", metadata: {} },
  ...n(4, { status: "CLOSED", outcome: "completed", metadata: { deliverable: "x" } }),
  { status: "CLOSED", outcome: null, metadata: null },
  { status: "DRAFTING", outcome: null, metadata: reasonMeta("not_drafting_work", "Not drafting work", "rejected") },
  { status: "PENDING_REVIEW", outcome: null, metadata: null },
];

const line = (b: ReturnType<typeof reasonBreakdown>, outcome: string, id: string | null) =>
  b?.groups.find((g) => g.outcome === outcome)?.lines.find((l) => l.reasonId === id);

describe("GAP-13 acceptance 2 — reasonBreakdown", () => {
  it("under each outcome with reasons: a count per configured reason, removed ones in their stored words, and 'No reason recorded' — adding up to the outcome's number", () => {
    const b = reasonBreakdown(ROWS, REASONS)!;
    const summary = summarizeOutcomes(ROWS.map((r) => ({ status: r.status, outcome: r.outcome, requestType: "ISO" })));
    expect(b.listUnread).toBe(false);
    expect(b.groups.map((g) => g.outcome)).toEqual(["withdrawn", "rejected"]); // only outcomes with a reason configured or recorded
    const rejected = b.groups.find((g) => g.outcome === "rejected")!;
    expect(rejected.lines.map((l) => [l.label, l.count, l.removed])).toEqual([
      ["Not drafting work", 3, false],
      ["Vendor scope", 1, false],
      ["Out of budget this year", 1, true],
      ["No reason recorded", 2, false],
    ]);
    // the outcome-level number is the summary's, and the lines add up to it
    for (const g of b.groups) {
      expect(g.total).toBe(summary.byOutcome[g.outcome]);
      expect(g.lines.reduce((s, l) => s + l.count, 0)).toBe(g.total);
    }
    expect(line(b, "withdrawn", "requester_left")?.count).toBe(1);
    expect(line(b, "withdrawn", null)?.count).toBe(1);
  });

  it("a configured reason nothing ended with is listed with 0; a renamed reason reads its CURRENT words (the id is the key)", () => {
    const renamed: OutcomeReason[] = [{ ...REASONS[0], label: "Not drafting work (send to engineering)" }, REASONS[1]];
    const b = reasonBreakdown([{ status: "CANCELED", outcome: "rejected", metadata: reasonMeta("not_drafting_work", "Not drafting work", "rejected") }], renamed)!;
    expect(line(b, "rejected", "not_drafting_work")).toMatchObject({ label: "Not drafting work (send to engineering)", count: 1, removed: false });
    expect(line(b, "rejected", "vendor_scope")).toMatchObject({ label: "Vendor scope", count: 0 });
    expect(line(b, "rejected", null)?.count).toBe(0);
  });

  it("REGRESSION: no reasons configured and none recorded → null (the panel exactly as before)", () => {
    expect(reasonBreakdown(ROWS.map((r) => ({ ...r, metadata: null })), [])).toBeNull();
    expect(reasonBreakdown([], [])).toBeNull();
  });

  it("a list since emptied: the reasons recorded are still counted, in their stored words, marked removed (never hidden)", () => {
    const b = reasonBreakdown(ROWS, [])!;
    expect(line(b, "rejected", "not_drafting_work")).toMatchObject({ label: "Not drafting work", count: 3, removed: true });
  });

  it("the list cannot be read: every reason is named in its stored words, not called removed, and the breakdown says why", () => {
    const b = reasonBreakdown(ROWS, [], true)!;
    expect(b.listUnread).toBe(true);
    expect(line(b, "rejected", "old_budget")).toMatchObject({ label: "Out of budget this year", removed: false });
  });

  it("a reason on a request whose outcome column was not written (before 20261195's paste) is counted under 'Not recorded', with the outcome it was recorded as", () => {
    const b = reasonBreakdown([
      { status: "CANCELED", outcome: undefined, metadata: reasonMeta("not_drafting_work", "Not drafting work", "rejected") },
      { status: "CANCELED", outcome: undefined, metadata: null },
    ], REASONS)!;
    const g = b.groups.find((x) => x.outcome === "unrecorded")!;
    expect(g.total).toBe(2);
    expect(g.lines).toEqual([
      { reasonId: "not_drafting_work", label: "Not drafting work", count: 1, removed: false, recordedAs: "Rejected" },
      { reasonId: null, label: "No reason recorded", count: 1, removed: false },
    ]);
  });

  it("junk in metadata.outcome_reason never counts as a reason (no id → 'No reason recorded')", () => {
    const b = reasonBreakdown([
      { status: "CANCELED", outcome: "rejected", metadata: { outcome_reason: "Not drafting work" } },
      { status: "CANCELED", outcome: "rejected", metadata: { outcome_reason: { label: "x" } } },
      { status: "CANCELED", outcome: "rejected", metadata: { outcome_reason: { id: "  ", label: "x" } } },
    ], REASONS)!;
    expect(line(b, "rejected", null)?.count).toBe(3);
  });
});

describe("GAP-13 acceptance 2 — the panel as rendered", () => {
  const html = (reasons: ReturnType<typeof reasonBreakdown> | undefined) =>
    renderToStaticMarkup(React.createElement(RequestOutcomes, { summary: summarizeOutcomes(ROWS.map((r) => ({ status: r.status, outcome: r.outcome, requestType: "ISO" }))), ...(reasons !== undefined ? { reasons } : {}) }));
  const doc = (s: string) => new DOMParser().parseFromString(`<!doctype html><body>${s}</body>`, "text/html");

  it("REGRESSION: a workspace with no reasons sees exactly today's panel — byte for byte", () => {
    const today = html(undefined);
    expect(html(null)).toBe(today);
    expect(html(reasonBreakdown(ROWS.map((r) => ({ ...r, metadata: null })), []))).toBe(today);
    expect(today).not.toContain("outcome-reasons");
  });

  it("with reasons: the breakdown under each outcome, and the outcome tiles exactly as before", () => {
    const withReasons = html(reasonBreakdown(ROWS, REASONS));
    const d = doc(withReasons);
    const t = (id: string) => d.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, " ").trim();
    expect(t("outcome-reasons-rejected")).toMatch(/^Rejected \(7\)/);
    expect(t("outcome-reason-rejected-not_drafting_work-count")).toBe("3");
    expect(t("outcome-reason-rejected-vendor_scope-count")).toBe("1");
    expect(t("outcome-reason-rejected-old_budget")).toBe("Out of budget this year (no longer in the list)1");
    expect(t("outcome-reason-rejected-none")).toBe("No reason recorded2");
    expect(t("outcome-reason-withdrawn-requester_left-count")).toBe("1");
    expect(d.querySelector('[data-testid="outcome-reasons-completed"]')).toBeNull(); // no reasons there: counted whole above
    // everything outside the breakdown is today's markup
    const strip = (s: string) => s.replace(/<div data-testid="outcome-reasons"[\s\S]*?<p class="mt-2 text-xs[^"]*" data-testid="outcome-reasons-note">[\s\S]*?<\/p><\/div>/, "");
    expect(strip(withReasons)).toBe(html(undefined));
  });

  it("a list that cannot be read is said under the breakdown", () => {
    const d = doc(html(reasonBreakdown(ROWS, [], true)));
    expect(d.querySelector('[data-testid="outcome-reasons-note"]')?.textContent).toMatch(/reason list could not be read/);
  });
});

// ─── /admin/analytics, rendered ───────────────────────────────────────────────

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  h.config = { data: null, error: null };
  h.configReads = 0;
  h.tickets = [];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tickets: h.tickets, documents: [] }), { status: 200, headers: { "Content-Type": "application/json" } })));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const ticket = (id: string, over: Record<string, unknown>) => ({
  id, org_id: "o1", ticket_id: `REQ-${id}`, title: `T ${id}`, request_type: "ISO", status: "CANCELED", requester_id: "r1",
  requester_name: "Rita", assigned_drafter_id: null, created_at: "2026-09-01T00:00:00.000Z", last_modified: "2026-09-02T00:00:00.000Z",
  history: [], comments: [], attachments: [], ...over,
});

describe("GAP-13 acceptance 2 — /admin/analytics reads the workspace's list and shows the breakdown", () => {
  it("with reasons configured: 'Rejected' broken down by them, named as configured now", async () => {
    h.config = { data: { data: { outcomeReasons: [{ id: "not_drafting_work", label: "Not drafting work — renamed", category: "rejected" }, { id: "vendor_scope", label: "Vendor scope", category: "rejected" }] } }, error: null };
    h.tickets = [
      ticket("a", { outcome: "rejected", metadata: reasonMeta("not_drafting_work", "Not drafting work", "rejected") }),
      ticket("b", { outcome: "rejected", metadata: reasonMeta("not_drafting_work", "Not drafting work", "rejected") }),
      ticket("c", { outcome: "rejected", metadata: null }),
      ticket("d", { status: "CLOSED", outcome: "completed", metadata: null }),
    ];
    await act(async () => { root.render(React.createElement(AnalyticsPage)); });
    await flush();
    expect(h.configReads).toBe(1);
    const t = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, " ").trim();
    expect(t("outcome-reasons-rejected")).toMatch(/^Rejected \(3\)/);
    expect(t("outcome-reason-rejected-not_drafting_work")).toBe("Not drafting work — renamed2");
    expect(t("outcome-reason-rejected-vendor_scope-count")).toBe("0");
    expect(t("outcome-reason-rejected-none-count")).toBe("1");
  });

  it("REGRESSION: a workspace with no reasons (no configuration row) sees today's panel — no breakdown", async () => {
    h.tickets = [ticket("a", { outcome: "rejected", metadata: null }), ticket("d", { status: "CLOSED", outcome: "completed", metadata: null })];
    await act(async () => { root.render(React.createElement(AnalyticsPage)); });
    await flush();
    expect(host.textContent).toContain("How Requests Ended");
    expect(host.querySelector('[data-testid="outcome-reasons"]')).toBeNull();
  });

  it("the configuration cannot be read: the recorded reasons are still shown, in their stored words, and the panel says the list could not be read", async () => {
    h.config = { data: null, error: { message: "permission denied for table org_configurations" } };
    h.tickets = [ticket("a", { outcome: "rejected", metadata: reasonMeta("vendor_scope", "Vendor scope", "rejected") })];
    await act(async () => { root.render(React.createElement(AnalyticsPage)); });
    await flush();
    const t = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, " ").trim();
    expect(t("outcome-reason-rejected-vendor_scope")).toBe("Vendor scope1");
    expect(t("outcome-reasons-note")).toMatch(/reason list could not be read/);
  });
});
