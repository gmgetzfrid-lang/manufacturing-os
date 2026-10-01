// @vitest-environment jsdom
//
// projects Round G — J10b UI REMAINDERS:
//   REL-4   (the remaining lookups) every label lookup indexed by a ROW value
//           is total — an unmapped kind / status / reason renders as itself,
//           never a blank chip: the Quality tab's checklist kind and turnover
//           status, the registry's company kind and event kind, the bid tab's
//           status chip, the change-order donut's reason;
//   PERF-10 (the remaining rows) the Quality tab's six per-row dates and the
//           timeline feed's per-row time are formatted by ONE formatter each,
//           created once — the same text as toLocaleDateString() /
//           toLocaleString();
//   GAP-408 (acceptance 2) each controls-program milestone on the project
//           feed links to its record's tab, through one map held to the
//           event vocabulary.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({ rows: {} as Record<string, Array<Record<string, unknown>>> }));
const q = vi.hoisted(() => ({
  listChecklists: vi.fn(), loadSignoffAuthority: vi.fn(), listTurnoverItems: vi.fn(), listTurnoverReviewEvents: vi.fn(), listPunchItems: vi.fn(),
}));

// A filtering chain for lib/timeline (eq / in / not-in / order / limit /
// range), and an inert one for every other table read.
function chain(table: string) {
  const preds: Array<(r: Record<string, unknown>) => boolean> = [];
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: (state.rows[table] ?? []).filter((r) => preds.every((p) => p(r))), error: null });
      return (...args: unknown[]) => {
        const [col, a1, a2] = args as [string, unknown, unknown];
        if (prop === "eq") preds.push((r) => r[col] === a1);
        if (prop === "in") preds.push((r) => (a1 as unknown[]).includes(r[col]));
        if (prop === "not" && a1 === "in") {
          const list = String(a2).replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
          preds.push((r) => !list.includes(String(r[col])));
        }
        if (prop === "range" && Number(col) > 0) preds.push(() => false);
        if (prop === "maybeSingle") return Promise.resolve({ data: null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t), rpc: () => chain("rpc"), auth: { getSession: async () => ({ data: { session: null } }) } } }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn() }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ member: { displayName: "Pat" }, activeRole: "Engineer", roles: ["Engineer"] }) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(), appPrompt: vi.fn() }));
vi.mock("@/components/signatures/SignatureCeremony", () => ({ default: () => null }));
vi.mock("@/lib/costs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/costs")>();
  return { ...real, listParties: vi.fn(async () => []) };
});
vi.mock("@/lib/checklists", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/checklists")>();
  return { ...real, listChecklists: q.listChecklists, loadSignoffAuthority: q.loadSignoffAuthority };
});
vi.mock("@/lib/turnover", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/turnover")>();
  return { ...real, listTurnoverItems: q.listTurnoverItems, listTurnoverReviewEvents: q.listTurnoverReviewEvents, listPunchItems: q.listPunchItems };
});

import TimelineFeed from "@/components/documents/TimelineFeed";
import QualityTab from "@/components/projects/QualityTab";
import {
  getProjectTimeline, PROJECT_EVENT_VOCABULARY, PROJECT_EVENT_TAB, projectEventLink, type TimelineEvent,
} from "@/lib/timeline";
import type { Checklist } from "@/lib/checklists";
import type { TurnoverItem, PunchItem, TurnoverReviewEvent } from "@/lib/turnover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Count constructions of Intl.DateTimeFormat with a given option shape —
 *  the modules read the global at first use. */
function countFormatters(test: (opts: Intl.DateTimeFormatOptions | undefined) => boolean) {
  const Orig = Intl.DateTimeFormat;
  const box = { n: 0 };
  (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = function (this: unknown, locales?: string | string[], opts?: Intl.DateTimeFormatOptions) {
    if (test(opts)) box.n++;
    return new Orig(locales, opts);
  };
  return { box, restore: () => { (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = Orig; } };
}
const isDayOnly = (o?: Intl.DateTimeFormatOptions) => !!o && o.year === "numeric" && o.month === "numeric" && o.day === "numeric" && !o.hour;
const isDayTime = (o?: Intl.DateTimeFormatOptions) => !!o && o.year === "numeric" && o.hour === "numeric" && o.second === "numeric";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  state.rows = {};
  for (const f of Object.values(q)) f.mockReset();
  q.loadSignoffAuthority.mockResolvedValue({ maySign: true, otherSigners: 2, source: "database" });
  q.listChecklists.mockResolvedValue([]);
  q.listTurnoverItems.mockResolvedValue([]);
  q.listTurnoverReviewEvents.mockResolvedValue([]);
  q.listPunchItems.mockResolvedValue([]);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const ev = (i: number, over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: `audit:${i}`, kind: "audit", action: "DOWNLOAD", resourceType: "document", resourceId: "d1",
  timestamp: new Date(Date.UTC(2026, 8, 1 + (i % 28), 10, i % 60, 5)).toISOString(), userId: null, userName: "ann", userEmail: null,
  summary: `Row ${i}`, details: null, ...over,
});

describe("PERF-10 — the timeline feed formats every row's time with ONE formatter", () => {
  it("200 rows rendered twice construct ONE date-time formatter, and each row reads exactly as toLocaleString() did", async () => {
    const { box, restore } = countFormatters(isDayTime);
    const perRow = vi.spyOn(Date.prototype, "toLocaleString");
    try {
      const events = Array.from({ length: 200 }, (_, i) => ev(i));
      await act(async () => { root.render(React.createElement(TimelineFeed, { events })); });
      await act(async () => { root.render(React.createElement(TimelineFeed, { events: [...events] })); });
      // the first render in this file creates it; nothing formats per row
      expect(box.n).toBe(1);
      expect(perRow).not.toHaveBeenCalled();
      perRow.mockRestore();
      const first = host.querySelector(".space-y-3 > div span")!;
      expect(first.textContent).toBe(new Date(events[0].timestamp).toLocaleString());
      expect(host.textContent).not.toContain("Invalid Date");
    } finally { restore(); }
  });
  it("an unreadable timestamp still reads '—'", async () => {
    await act(async () => { root.render(React.createElement(TimelineFeed, { events: [ev(1, { timestamp: "not a date" })] })); });
    expect(host.querySelector(".space-y-3 > div span")!.textContent).toBe("—");
  });
});

const checklist = (over: Partial<Checklist>): Checklist => ({
  id: "cl1", orgId: "o1", projectId: "p1", kind: "pssr", title: "PSSR — Unit 300", sourceDocumentId: null, status: "open",
  completedBasis: null, createdAt: null, createdByName: null, createdBy: "someone", ...over,
} as Checklist);
const turnover = (over: Partial<TurnoverItem>): TurnoverItem => ({
  id: "t1", orgId: "o1", projectId: "p1", partyId: null, name: "NDE reports", description: null, required: true, status: "accepted", documentId: null,
  reviewedAt: "2026-09-12T10:00:00Z", reviewedByName: "Sam", reviewNote: null, createdAt: null, createdBy: "someone", ...over,
} as TurnoverItem);
const punch = (over: Partial<PunchItem>): PunchItem => ({
  id: "u1", orgId: "o1", projectId: "p1", partyId: null, title: "Paint touch-up", description: null, location: null, status: "open",
  dueDate: "2026-10-20", closedAt: null, closedByName: null, closureNote: null, createdByName: null, createdAt: null, ...over,
} as PunchItem);

describe("PERF-10 — the Quality tab's per-row dates share ONE formatter", () => {
  it("a signed-off checklist, reviewed turnover, its history and dated / closed punch items render through one day formatter, reading as toLocaleDateString()", async () => {
    q.listChecklists.mockResolvedValue([checklist({ status: "complete", completedByName: "Sam", completedAt: "2026-09-14T10:00:00Z" } as Partial<Checklist>)]);
    q.listTurnoverItems.mockResolvedValue(Array.from({ length: 12 }, (_, i) => turnover({ id: `t${i}`, name: `Item ${i}` })));
    q.listTurnoverReviewEvents.mockResolvedValue([{ id: "e1", itemId: "t0", fromStatus: "received", toStatus: "accepted", reviewerName: "Sam", createdAt: "2026-09-12T10:00:00Z", note: null } as unknown as TurnoverReviewEvent]);
    q.listPunchItems.mockResolvedValue([
      ...Array.from({ length: 10 }, (_, i) => punch({ id: `u${i}`, title: `Snag ${i}` })),
      punch({ id: "u99", title: "Closed snag", status: "done", closedAt: "2026-09-15T10:00:00Z", closedByName: "Lee", dueDate: null }),
    ]);
    const { box, restore } = countFormatters(isDayOnly);
    const perRow = vi.spyOn(Date.prototype, "toLocaleDateString");
    try {
      await act(async () => {
        root.render(React.createElement(QualityTab, { orgId: "o1", projectId: "p1", canManage: true, uid: "u1", jobKind: "small" }));
      });
      await settle();
      // the first Quality render in this file creates it; nothing formats per row
      expect(box.n).toBe(1);
      expect(perRow).not.toHaveBeenCalled();
      perRow.mockRestore();
      const text = host.textContent ?? "";
      expect(text).toContain(`signed off by Sam · ${new Date("2026-09-14T10:00:00Z").toLocaleDateString()}`);
      expect(text).toContain(`accepted by Sam on ${new Date("2026-09-12T10:00:00Z").toLocaleDateString()}`);
      expect(text).toContain(`due ${new Date("2026-10-20T00:00:00").toLocaleDateString()}`);
      expect(text).toContain(`done by Lee on ${new Date("2026-09-15T10:00:00Z").toLocaleDateString()}`);
    } finally { restore(); }
    const tab = src("components/projects/QualityTab.tsx");
    // no per-row toLocaleDateString() left in the tab (the formatter's own
    // invalid-date branch is the only call)
    expect(tab).not.toMatch(/new Date\([^)]*\)\.toLocaleDateString\(\)/);
    expect((tab.match(/toLocaleDateString\(\)/g) ?? []).length).toBe(2);   // the fallback + its doc comment
  });
});

describe("REL-4 — a row value outside the label map renders as itself, never a blank chip", () => {
  it("the Quality tab: an unmapped checklist kind and turnover status show their raw value", async () => {
    q.listChecklists.mockResolvedValue([checklist({ kind: "fat" as Checklist["kind"] })]);
    q.listTurnoverItems.mockResolvedValue([turnover({ status: "superseded" as TurnoverItem["status"] })]);
    await act(async () => {
      root.render(React.createElement(QualityTab, { orgId: "o1", projectId: "p1", canManage: true, uid: "u1", jobKind: "small" }));
    });
    await settle();
    const card = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("PSSR — Unit 300"))!;
    expect(card.textContent).toContain("fat");
    const chip = [...host.querySelectorAll("span")].find((s) => s.textContent === "superseded");
    expect(chip).toBeTruthy();
  });

  it("census: every lookup the remainder named — and the bid tab's status chip and the change-order donut — falls back to the value itself", () => {
    const pins: Array<[string, string]> = [
      ["components/projects/QualityTab.tsx", "{CHECKLIST_KIND_LABEL[checklist.kind] ?? checklist.kind}"],
      ["components/projects/QualityTab.tsx", "{TURNOVER_STATUS_LABEL[status] ?? status}"],
      ["app/(protected)/companies/page.tsx", "{COMPANY_KIND_LABEL[c.kind] ?? c.kind}"],
      ["app/(protected)/companies/[id]/page.tsx", "{COMPANY_KIND_LABEL[company.kind] ?? company.kind}"],
      ["app/(protected)/companies/[id]/page.tsx", "{EVENT_KIND_LABEL[e.kind] ?? e.kind}"],
      ["components/projects/cost/ChangeOrdersPanel.tsx", "label: CO_REASON_LABEL[r.reason] ?? r.reason"],
      ["components/projects/cost/QuotesPanel.tsx", "{costDocStatusLabel(status)}"],
    ];
    for (const [f, pin] of pins) expect(src(f), f).toContain(pin);
    // No row-indexed lookup without a fallback is left in these files (a
    // lookup over the map's own keys — `[k]`, `[r]` — is total by construction).
    for (const f of ["components/projects/QualityTab.tsx", "app/(protected)/companies/page.tsx", "app/(protected)/companies/[id]/page.tsx",
      "components/projects/cost/ChangeOrdersPanel.tsx", "components/projects/cost/QuotesPanel.tsx", "components/projects/CostsTab.tsx"]) {
      const bare = [...src(f).matchAll(/\b[A-Z_]+_LABEL\[([^\]]+)\](?!\s*\?\?)/g)].map((mm) => mm[0]).filter((x) => !/\[(k|r)\]$/.test(x));
      expect(bare, f).toEqual([]);
    }
  });
});

describe("GAP-408 — each controls milestone on the project feed links to its record", () => {
  const audit = (id: string, action: string, over: Record<string, unknown> = {}) => ({
    id, action, resource_type: "project", resource_id: "p1", org_id: "o1", user_id: "u1",
    user_email: "u1@x.io", user_role: null, details: {}, metadata: null, timestamp: `2026-09-${id.padStart(2, "0")}T10:00:00Z`, ...over,
  });

  it("an award, a change order, a checklist ruling, a turnover review, a punch close and a schedule miss each carry their tab; a document's event carries none", async () => {
    state.rows.project_activity = [];
    state.rows.project_documents = [{ id: "pd1", project_id: "p1", document_id: "d1" }];
    state.rows.cost_documents = [{ id: "q1", project_id: "p1" }];
    state.rows.audit_logs = [
      audit("2", "CHANGE_ORDER_APPROVED", { details: { coNumber: "CO-003", amount: 12500 } }),
      audit("3", "TURNOVER_REVIEWED", { details: { name: "NDE reports", status: "accepted" } }),
      audit("4", "CHECKLIST_STATUS", { details: { status: "complete", title: "PSSR — Unit 300" } }),
      audit("5", "PUNCH_STATUS", { details: { title: "Insulation", status: "done" } }),
      audit("6", "MILESTONE_MISSED", { details: { name: "Hydrotest" } }),
      audit("7", "COST_DOC_AWARDED", { resource_type: "cost", resource_id: "q1", details: { vendor: "Gulf Mechanical", total: 48000 } }),
      audit("8", "DOWNLOAD", { resource_type: "document", resource_id: "d1", details: { fileName: "P-101.pdf" } }),
    ];
    const events = await getProjectTimeline({ projectId: "p1" });
    const linkOf = (action: string) => events.find((e) => e.action === action)?.link ?? null;
    expect(linkOf("COST_DOC_AWARDED")).toEqual({ href: "/projects/p1?tab=costs", label: "Open in Costs" });
    expect(linkOf("CHANGE_ORDER_APPROVED")).toEqual({ href: "/projects/p1?tab=costs", label: "Open in Costs" });
    expect(linkOf("CHECKLIST_STATUS")).toEqual({ href: "/projects/p1?tab=quality", label: "Open in Quality" });
    expect(linkOf("TURNOVER_REVIEWED")).toEqual({ href: "/projects/p1?tab=quality", label: "Open in Quality" });
    expect(linkOf("PUNCH_STATUS")).toEqual({ href: "/projects/p1?tab=quality", label: "Open in Quality" });
    expect(linkOf("MILESTONE_MISSED")).toEqual({ href: "/projects/p1?tab=schedule", label: "Open in Schedule" });
    const download = events.find((e) => e.action === "DOWNLOAD");
    expect(download).toBeTruthy();
    expect(download!.link ?? null).toBeNull();
  });

  it("the tab map is held to the ONE vocabulary: every key is a milestone there, and every controls milestone has a tab", () => {
    for (const a of Object.keys(PROJECT_EVENT_TAB)) expect(PROJECT_EVENT_VOCABULARY[a], a).toBe("milestone");
    const controls = Object.entries(PROJECT_EVENT_VOCABULARY)
      .filter(([a, c]) => c === "milestone" && /^(COST_DOC|CHANGE_ORDER|CHECKLIST|TURNOVER|PUNCH)_/.test(a)).map(([a]) => a);
    expect(controls.length).toBeGreaterThanOrEqual(12);
    for (const a of controls) expect(PROJECT_EVENT_TAB[a], a).toBeDefined();
    expect(projectEventLink("PROJECT_LESSONS_SAVED", "p1")).toBeNull();
    expect(projectEventLink("COST_DOC_AWARDED", "")).toBeNull();
    expect(projectEventLink("CHANGE_ORDER_VOIDED", "p 1")!.href).toBe("/projects/p%201?tab=costs");
  });

  it("rendered: the feed shows the link on a linked row and nothing on the others", async () => {
    const events = [
      ev(1, { action: "CHANGE_ORDER_APPROVED", resourceType: "project", resourceId: "p1", summary: "Change order approved CO-003", link: projectEventLink("CHANGE_ORDER_APPROVED", "p1") }),
      ev(2, { summary: "Downloaded P-101.pdf" }),
    ];
    await act(async () => { root.render(React.createElement(TimelineFeed, { events, showScope: false })); });
    const anchors = [...host.querySelectorAll("a")];
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe("/projects/p1?tab=costs");
    expect(anchors[0].textContent).toBe("Open in Costs");
    expect(anchors[0].closest(".flex-1")!.textContent).toContain("Change order approved CO-003");
  });

  it("the project page follows a same-page ?tab= navigation (the link switches the tab)", () => {
    const page = src("app/(protected)/projects/[id]/page.tsx");
    expect(page).toContain('if (t === "intake" || t === "costs" || t === "quality" || t === "activity" || t === "schedule" || t === "members" || t === "documents") {\n      setTabState(t);');
  });
});
