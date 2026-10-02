// @vitest-environment jsdom
//
// projects Round G — projects-joint J12, review fix pass 7 (projects-tab SEC-21): the dashboard's
// Activity widget lists the org's newest audit rows and draws a 14-day count of them. 20261157's
// record_milestone_scope_on_delete writes MILESTONE_SCOPE_RECORDED beside the MILESTONE_DELETED row of
// every signed-in delete of a document's milestone — the database's stamp, not an event — so the widget
// showed one delete twice in its list and counted it twice. It now leaves the stamp out IN ITS QUERIES
// (lib/timeline.ts SCOPE_STAMPS_NOT_IN), before their row caps.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  spark: [] as number[][],
}));
const stub = vi.hoisted(() => () => null);

/** A filtering chain over `state.rows` (audit_logs): eq / gte / not-in / order / limit applied. */
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const preds: Array<(r: Record<string, unknown>) => boolean> = [];
    let limit = 1000;
    let desc: string | null = null;
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          let out = table === "audit_logs" ? state.rows.filter((r) => preds.every((p) => p(r))) : [];
          if (desc) { const col = desc; out = [...out].sort((a, b) => String(b[col]).localeCompare(String(a[col]))); }
          return (resolve: (v: unknown) => void) => resolve({ data: out.slice(0, limit), error: null, count: out.length });
        }
        return (...args: unknown[]) => {
          state.calls.push({ table, method: prop, args });
          const [col, a1, a2] = args as [string, unknown, unknown];
          if (prop === "eq") preds.push((r) => r[col] === a1);
          if (prop === "gte") preds.push((r) => String(r[col]) >= String(a1));
          if (prop === "not" && a1 === "in") {
            const list = String(a2).replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
            preds.push((r) => !list.includes(String(r[col])));
          }
          if (prop === "order" && (a1 as { ascending?: boolean } | undefined)?.ascending === false) desc = col;
          if (prop === "limit") limit = Number(col);
          return new Proxy({}, h);
        };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ activeOrgId: "o1", uid: "u1" }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock("@/components/documents/NodeCover", () => ({ default: stub }));
vi.mock("@/components/documents/DocThumb", () => ({ default: stub }));
vi.mock("@/components/documents/DocHoverPreview", () => ({ default: stub }));
vi.mock("@/lib/inbox", () => ({ loadInbox: vi.fn() }));
vi.mock("@/lib/nudges", () => ({ computeNudges: vi.fn(() => []) }));
vi.mock("@/lib/markupRequests", () => ({ resolveMarkupRequest: vi.fn() }));
vi.mock("@/hooks/useTicketNotifications", () => ({ useTicketNotifications: () => ({ items: [], counts: {}, markRead: vi.fn(), markAllRead: vi.fn(), loading: false }) }));
vi.mock("@/components/cockpit/DailyBrief", () => ({ DailyBrief: stub }));
vi.mock("@/components/cockpit/QuickLaunch", () => ({ QuickLaunch: stub }));
vi.mock("@/components/cockpit/AttentionFeed", () => ({ AttentionFeed: stub }));
vi.mock("@/components/cockpit/CommandDeck", () => ({ CommandDeck: stub, roleFocus: () => null, exportInboxCsv: vi.fn(), formatAgo: () => "" }));
vi.mock("@/components/dashboard/viz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/dashboard/viz")>()),
  Sparkline: ({ values }: { values: number[] }) => { state.spark.push(values); return null; },
}));

import { WIDGET_CATALOG } from "@/components/dashboard/widgets";
import type { DashboardWidget } from "@/lib/dashboard/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  state.rows = []; state.calls = []; state.spark = [];
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const row = (id: string, action: string, secondsAgo: number) => ({
  id, org_id: "o1", action, resource_type: "document", resource_id: "d1",
  timestamp: new Date(Date.now() - secondsAgo * 1000).toISOString(),
});
const renderActivity = async () => {
  const Body = WIDGET_CATALOG.activity.Body;
  await act(async () => { root.render(React.createElement(Body, { widget: { id: "w1", type: "activity" } as unknown as DashboardWidget })); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

describe("SEC-21 (J12 review fix 7) — the dashboard's Activity widget shows and counts one milestone delete once", () => {
  it("the list shows the delete once and the 14-day count counts it once", async () => {
    // one signed-in delete of a document's milestone: the database's stamp, then the lib's MILESTONE_DELETED
    state.rows = [row("a0", "MILESTONE_COMPLETED", 30), row("a1", "MILESTONE_SCOPE_RECORDED", 20), row("a2", "MILESTONE_DELETED", 19)];
    await renderActivity();
    const items = [...host.querySelectorAll("li")].map((li) => li.querySelector("span")?.textContent);
    expect(items).toEqual(["milestone deleted", "milestone completed"]);
    expect(state.spark.at(-1)?.at(-1)).toBe(2);
    expect(state.spark.at(-1)?.reduce((s, n) => s + n, 0)).toBe(2);
  });

  it("both reads leave the stamp out in the query, before their row caps", async () => {
    state.rows = [row("a2", "MILESTONE_DELETED", 19)];
    await renderActivity();
    const stampFilter = { table: "audit_logs", method: "not", args: ["action", "in", '("MILESTONE_SCOPE_RECORDED")'] };
    expect(state.calls.filter((c) => c.method === "not")).toEqual([stampFilter, stampFilter]);
    // each filter sits before its read's limit
    const order = state.calls.map((c) => c.method);
    const firstLimit = order.indexOf("limit");
    expect(order.indexOf("not")).toBeLessThan(firstLimit);
    expect(order.lastIndexOf("not")).toBeLessThan(order.lastIndexOf("limit"));
  });

  it("negative control: every other action, the delete's own row included, still lists and counts", async () => {
    state.rows = [row("b0", "DOC_UPLOADED", 40), row("b1", "MILESTONE_DELETED", 30), row("b2", "COST_DOC_AWARDED", 20)];
    await renderActivity();
    expect([...host.querySelectorAll("li")]).toHaveLength(3);
    expect(state.spark.at(-1)?.reduce((s, n) => s + n, 0)).toBe(3);
  });
});
