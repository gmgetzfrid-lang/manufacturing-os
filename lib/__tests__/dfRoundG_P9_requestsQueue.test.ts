// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P9 TICKET-PAGE — the request queue
// (app/(protected)/requests/page.tsx), AS RENDERED.
//
//   FRIC-9 / UI-6 (DEC-90 ruling)  the queue opens on "Needs me" for every
//                role; "All" is one click away; both counts are on screen.
//   AUTHZ-15     an unreadable policy holds back the needs-me lens, Archive
//                and Force Close, says why, and offers Try again; a stale
//                (last-good) policy is drawn as is.
//   PERS-3 / LEAK-4 / PERS-7   Mark urgent compare-and-sets on the row's
//                last_modified; a lost race or a refusal is said, the audit
//                row follows only a confirmed write and names the member.
//                Fix pass: a miss re-reads the row and retries once on its
//                fresh token, and re-reads the list — it never waits on a
//                realtime event that may not come.
//   RT-4         the tickets DELETE companion drops a row the list holds,
//                and only that.
//   EDGE-8       a request the queue was never told about carries a chip.
//   UI-7 / FRIC-3 readers   statuses and units in words.
//   REGRESSION   "All" lists every request the scope returned, as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Q = { table: string; calls: Array<{ m: string; a: unknown[] }>; update?: Record<string, unknown> };
const s = vi.hoisted(() => ({
  role: { activeRole: "DraftingSupervisor", roles: ["DraftingSupervisor"], activeOrgId: "org-1", uid: "s-1" } as Record<string, unknown>,
  tickets: [] as Array<Record<string, unknown>>,
  members: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ table: string; calls: Array<{ m: string; a: unknown[] }>; update?: Record<string, unknown> }>,
  /** The rows a tickets UPDATE … select('id') matches. */
  updateHit: [{ id: "t1" }] as unknown[] | null,
  /** Per-write answers, in order (falls back to updateHit when empty). */
  updateHits: [] as Array<unknown[]>,
  updateError: null as null | { message: string },
  /** The row a re-read (tickets … maybeSingle) returns after a miss. */
  freshRow: null as Record<string, unknown> | null,
  policyEntries: [] as Array<Record<string, unknown>>,
  policyReads: 0,
  channels: [] as Array<{ ons: Array<{ cfg: Record<string, unknown>; cb: (p: unknown) => void }> }>,
  alert: vi.fn(),
  confirm: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ ...s.role, hasAnyRole: (r: string[]) => r.some((x) => (s.role.roles as string[]).includes(x)) }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({
  appAlert: (...a: unknown[]) => s.alert(...a),
  appConfirm: (...a: unknown[]) => s.confirm(...a),
}));
vi.mock("@/components/ui/UserAvatar", () => ({ default: () => null }));
vi.mock("@/lib/audit", () => ({ logAuditAction: (...a: unknown[]) => s.audit(...a) }));
vi.mock("@/lib/capabilityPolicy", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadCapabilityPolicyEntry: async () => { s.policyReads++; return s.policyEntries.shift() ?? { policy: undefined, version: null }; },
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string) => {
    const q: Q = { table, calls: [] };
    s.queries.push(q);
    const api: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "in", "order", "is", "limit"]) {
      api[m] = (...a: unknown[]) => { q.calls.push({ m, a }); return api; };
    }
    api.update = (patch: Record<string, unknown>) => { q.update = patch; return api; };
    api.single = async () => ({ data: null, error: null });
    api.maybeSingle = async () => (table === "tickets" ? { data: s.freshRow, error: null } : { data: null, error: null });
    api.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      let result: unknown;
      if (table === "tickets" && q.update) result = s.updateError ? { data: null, error: s.updateError } : { data: s.updateHits.length > 0 ? s.updateHits.shift() : s.updateHit, error: null };
      else if (table === "tickets") result = { data: s.tickets, error: null };
      else if (table === "org_members" && q.calls.some((c) => c.m === "in")) {
        const ids = q.calls.find((c) => c.m === "in")!.a[1] as string[];
        result = { data: s.members.filter((m) => ids.includes(m.uid as string)), error: null };
      } else if (table === "org_members") result = { data: null, error: null, count: 4 };
      else result = { data: [], error: null };
      return Promise.resolve(result).then(ok, ko);
    };
    return api;
  };
  return {
    supabase: {
      from: (t: string) => chain(t),
      channel: () => {
        const c = { ons: [] as Array<{ cfg: Record<string, unknown>; cb: (p: unknown) => void }> };
        s.channels.push(c);
        const api: Record<string, unknown> = {
          on: (_e: string, cfg: Record<string, unknown>, cb: (p: unknown) => void) => { c.ons.push({ cfg, cb }); return api; },
          subscribe: () => api,
        };
        return api;
      },
      removeChannel: () => {},
      auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
    },
  };
});

import RequestsPage from "@/app/(protected)/requests/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LM1 = "2026-10-13T10:00:00.000Z";
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, org_id: "org-1", ticket_id: `KE-${id}`, title: `Title ${id}`, unit: "U-100", request_type: "ISO",
  status: "DRAFTING", requester_id: "r-1", requester_name: "Rita", assigned_drafter_id: "d-1", assigned_drafter_name: "Dan",
  attachments: [], comments: [], history: [], unread_by: [], created_at: "2026-10-01T00:00:00.000Z", last_modified: LM1, ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => {
  s.role = { activeRole: "DraftingSupervisor", roles: ["DraftingSupervisor"], activeOrgId: "org-1", uid: "s-1" };
  s.tickets = [
    row("t1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, assigned_drafter_name: null, metadata: { created_notice_owed: true } }),
    row("t2"),
    row("t3", { status: "REVISION_REQ", unit: null, metadata: { unit_unknown: true } }),
  ];
  s.members = [{ uid: "r-1", role: "Requester", roles: ["Requester"] }];
  s.queries = []; s.channels = [];
  s.updateHit = [{ id: "t1" }]; s.updateHits = []; s.updateError = null; s.freshRow = null;
  s.policyEntries = []; s.policyReads = 0;
  for (const f of [s.alert, s.confirm, s.audit]) f.mockReset();
  s.alert.mockResolvedValue(undefined);
  s.confirm.mockResolvedValue(true);
  s.audit.mockResolvedValue({ ok: true, error: null });
  try { localStorage.clear(); } catch { /* none */ }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const mount = async () => { await act(async () => { root!.render(React.createElement(RequestsPage)); }); await flush(); };
const q = <T extends HTMLElement>(sel: string) => host!.querySelector(sel) as T | null;
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const rowIds = () => Array.from(host!.querySelectorAll("tbody a[href^='/requests/']")).map((a) => a.getAttribute("href")).filter((h, i, all) => all.indexOf(h) === i);
const byText = (sel: string, text: RegExp) => Array.from(host!.querySelectorAll(sel)).find((e) => text.test(e.textContent ?? "")) ?? null;

describe("FRIC-9 / UI-6 — the queue opens on what needs me; all is one click away; both counts shown", () => {
  it("a drafting supervisor lands on Needs me (the assignment it owns), with the counts of both views", async () => {
    await mount();
    expect(q("[data-testid=view-needs-me]")?.getAttribute("aria-pressed")).toBe("true");
    expect(q("[data-testid=view-needs-me]")?.textContent).toMatch(/Needs me\s*1/);
    expect(q("[data-testid=view-all]")?.textContent).toMatch(/All\s*3/);
    expect(rowIds()).toEqual(["/requests/t1"]);
    expect(q("[data-testid=needs-me-summary]")?.textContent).toMatch(/1 request that need you, of 3/);
  });
  it("REGRESSION: one click on All lists every request the scope returned", async () => {
    await mount();
    await click(q("[data-testid=view-all]"));
    expect(q("[data-testid=view-all]")?.getAttribute("aria-pressed")).toBe("true");
    expect(rowIds().sort()).toEqual(["/requests/t1", "/requests/t2", "/requests/t3"]);
    expect(q("[data-testid=needs-me-summary]")).toBeNull();
  });
  it("nothing needs me → a plain empty state that offers all, never 'No matching tickets'", async () => {
    s.role = { activeRole: "Requester", roles: ["Requester"], activeOrgId: "org-1", uid: "r-1" };
    s.tickets = [row("t2", { requester_id: "r-1" })];
    await mount();
    expect(q("[data-testid=needs-me-empty]")?.textContent).toMatch(/Nothing needs you right now/);
    await click(byText("[data-testid=needs-me-empty] button", /Show all 1/));
    expect(rowIds()).toEqual(["/requests/t2"]);
  });
  it("a Drafter is no longer defaulted to 'My Tickets' — the pool request they can pick up needs them", async () => {
    s.role = { activeRole: "Drafter", roles: ["Drafter"], activeOrgId: "org-1", uid: "d-9" };
    s.tickets = [row("t1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })];
    await mount();
    const assignee = host!.querySelector("select") as HTMLSelectElement;
    expect(assignee.value).toBe("all");
    expect(rowIds()).toEqual(["/requests/t1"]);
  });
});

describe("UI-7 / FRIC-3 / EDGE-8 — a row in words", () => {
  it("statuses are labels, a unit-unknown request says so, and an unannounced request carries its chip", async () => {
    await mount();
    await click(q("[data-testid=view-all]"));
    const text = host!.textContent ?? "";
    expect(text).toContain("Awaiting drafter");
    expect(text).toContain("Revision requested");
    expect(text).not.toMatch(/PENDING_ASSIGNMENT|REVISION_REQ/);
    expect(text).toContain("Unit unknown — triage assigns");
    const chips = host!.querySelectorAll("[data-testid=chip-not-announced]");
    expect(chips.length).toBe(1);
    // the status filter offers the same words
    const statusSelect = Array.from(host!.querySelectorAll("select")).find((el) => el.textContent?.includes("Status: Any")) as HTMLSelectElement;
    expect(Array.from(statusSelect.options).map((o) => o.textContent)).toContain("Issued — awaiting acknowledgement");
  });
});

describe("UI-2 — the workflow map is reachable from the queue", () => {
  it("'How requests flow' opens the map, by click, with the status labels as its stages", async () => {
    await mount();
    const map = () => Array.from(host!.querySelectorAll("h2")).find((h) => /How a drafting request flows/.test(h.textContent ?? ""))?.closest("div.fixed, [class*='fixed']") ?? null;
    expect(map()).toBeNull();
    await click(byText("button", /How requests flow/));
    const m = map();
    expect(m).toBeTruthy();
    expect(m!.textContent).toMatch(/Ready to issue \(IFC\)/);
    expect(m!.textContent).toMatch(/Engineer sign-off/);
  });
});

describe("AUTHZ-15 — an unreadable policy is said, never guessed under the defaults", () => {
  it("the needs-me lens, Archive and Force Close are held back with the reason; Try again re-reads", async () => {
    s.policyEntries = [{ policy: {}, version: null, unreadable: "permission denied for org_configurations" }];
    s.role = { activeRole: "Admin", roles: ["Admin"], activeOrgId: "org-1", uid: "a-1" };
    await mount();
    const notice = q("[data-testid=requests-policy-fault]");
    expect(notice?.textContent).toMatch(/Permissions could not be read/);
    expect(notice?.textContent).toMatch(/permission denied/);
    expect(q("[data-testid=view-needs-me]")?.textContent).toMatch(/Needs me\s*—/);
    expect(q("[data-testid=needs-me-empty]")?.textContent).toMatch(/cannot be worked out right now/);
    // All still lists the requests; selecting one offers no Archive, and the row menu no Force Close
    await click(q("[data-testid=view-all]"));
    const box = host!.querySelector("tbody input[type=checkbox]") as HTMLInputElement;
    await click(box);
    expect(byText("button", /^\s*Archive\s*$/)).toBeNull();
    expect(byText("button", /Mark Urgent/)).toBeTruthy();
    const reads = s.policyReads;
    await click(byText("[data-testid=requests-policy-fault] button", /Try again/));
    expect(s.policyReads).toBe(reads + 1);
    expect(q("[data-testid=requests-policy-fault]")).toBeNull();
    expect(byText("button", /^\s*Archive\s*$/)).toBeTruthy();
  });
  it("REGRESSION: a stale (last-good) policy is drawn as is — no notice, the lens counts", async () => {
    s.policyEntries = [{ policy: {}, version: "v1", stale: true, staleError: "timeout" }];
    await mount();
    expect(q("[data-testid=requests-policy-fault]")).toBeNull();
    expect(q("[data-testid=view-needs-me]")?.textContent).toMatch(/Needs me\s*1/);
  });
});

describe("PERS-3 / LEAK-4 / PERS-7 — Mark urgent can no longer fail silently or race the workflow", () => {
  const select = async (id: string) => {
    await click(q("[data-testid=view-all]"));
    const link = host!.querySelector(`tbody a[href='/requests/${id}']`)!;
    const tr = link.closest("tr")!;
    await click(tr.querySelector("input[type=checkbox]"));
  };
  it("the write compare-and-sets on the row's last_modified; the audit row follows the confirmed write, naming the member", async () => {
    await mount();
    await select("t1");
    await click(byText("button", /Mark Urgent/));
    const upd = s.queries.find((x) => x.table === "tickets" && x.update);
    expect(upd?.update).toMatchObject({ priority: 1 });
    expect(upd?.calls).toEqual(expect.arrayContaining([
      { m: "eq", a: ["id", "t1"] },
      { m: "eq", a: ["org_id", "org-1"] },
      { m: "eq", a: ["last_modified", LM1] },
      { m: "select", a: ["id"] },
    ]));
    expect(s.audit).toHaveBeenCalledTimes(1);
    expect(s.audit.mock.calls[0][0]).toMatchObject({ action: "TICKET_BULK_URGENT", userId: "s-1", orgId: "org-1", details: { count: 1, ticketIds: ["t1"] } });
    expect(s.alert).not.toHaveBeenCalled();
  });
  it("a race lost twice (the row moves again under the retry) is said, writes no audit row, and keeps the request selected", async () => {
    s.updateHit = [];
    s.freshRow = { id: "t1", last_modified: "2026-10-13T11:00:00.000Z", priority: 3 };
    await mount();
    await select("t1");
    await click(byText("button", /Mark Urgent/));
    expect(s.queries.filter((x) => x.table === "tickets" && x.update).length).toBe(2); // the first try and ONE retry
    expect(s.audit).not.toHaveBeenCalled();
    expect(String(s.alert.mock.calls[0]?.[0]?.message)).toMatch(/1 of 1 were not marked urgent: it is being changed by someone else right now/);
    expect(String(s.alert.mock.calls[0]?.[0]?.message)).not.toMatch(/list is refreshing/);
    expect(host!.textContent).toMatch(/1 Selected/);
  });
  it("fix pass: a stale list with NO realtime event — the miss re-reads the row, retries on its fresh token, lands, and re-reads the list", async () => {
    const LM2 = "2026-10-13T11:00:00.000Z";
    s.updateHits = [[], [{ id: "t1" }]];
    s.freshRow = { id: "t1", last_modified: LM2, priority: 3 };
    await mount();
    await select("t1");
    const listReads = s.queries.filter((x) => x.table === "tickets" && !x.update && !x.calls.some((c) => c.m === "select" && c.a[0] === "id, last_modified, priority")).length;
    await click(byText("button", /Mark Urgent/));
    const writes = s.queries.filter((x) => x.table === "tickets" && x.update);
    expect(writes.length).toBe(2);
    expect(writes[0].calls).toEqual(expect.arrayContaining([{ m: "eq", a: ["last_modified", LM1] }]));
    expect(writes[1].calls).toEqual(expect.arrayContaining([{ m: "eq", a: ["last_modified", LM2] }, { m: "select", a: ["id"] }]));
    const reread = s.queries.find((x) => x.table === "tickets" && x.calls.some((c) => c.m === "select" && c.a[0] === "id, last_modified, priority"));
    expect(reread?.calls).toEqual(expect.arrayContaining([{ m: "eq", a: ["id", "t1"] }, { m: "eq", a: ["org_id", "org-1"] }]));
    // no channel callback ran — the list was re-read on the page's own initiative
    const listReadsAfter = s.queries.filter((x) => x.table === "tickets" && !x.update && !x.calls.some((c) => c.m === "select" && c.a[0] === "id, last_modified, priority")).length;
    expect(listReadsAfter).toBeGreaterThan(listReads);
    expect(s.audit).toHaveBeenCalledTimes(1);
    expect(s.audit.mock.calls[0][0]).toMatchObject({ action: "TICKET_BULK_URGENT", details: { count: 1, ticketIds: ["t1"] } });
    expect(s.alert).not.toHaveBeenCalled();
    expect(host!.textContent).not.toMatch(/1 Selected/);
  });
  it("fix pass: already urgent on the re-read is done — no second write, no audit row of a write we did not make, nothing to say", async () => {
    s.updateHit = [];
    s.freshRow = { id: "t1", last_modified: "2026-10-13T11:00:00.000Z", priority: 1 };
    await mount();
    await select("t1");
    await click(byText("button", /Mark Urgent/));
    expect(s.queries.filter((x) => x.table === "tickets" && x.update).length).toBe(1);
    expect(s.audit).not.toHaveBeenCalled();
    expect(s.alert).not.toHaveBeenCalled();
    expect(host!.textContent).not.toMatch(/1 Selected/);
  });
  it("fix pass: a row the re-read cannot find is said as gone, not as a race to retry", async () => {
    s.updateHit = [];
    s.freshRow = null;
    await mount();
    await select("t1");
    await click(byText("button", /Mark Urgent/));
    expect(String(s.alert.mock.calls[0]?.[0]?.message)).toMatch(/no longer in this workspace/);
    expect(s.audit).not.toHaveBeenCalled();
  });
  it("a refused write is said with the refusal; a refused audit row after a good write is said too", async () => {
    s.updateError = { message: "new row violates row-level security policy" };
    await mount();
    await select("t1");
    await click(byText("button", /Mark Urgent/));
    expect(String(s.alert.mock.calls[0]?.[0]?.message)).toMatch(/row-level security/);
    s.updateError = null;
    s.audit.mockResolvedValue({ ok: false, error: "audit refused" });
    s.alert.mockClear();
    await click(byText("button", /Mark Urgent/));
    expect(String(s.alert.mock.calls[0]?.[0]?.message)).toMatch(/marked urgent, but the record of it could not be written: audit refused/);
  });
  it("a row with no last_modified compares on NULL (its own leg), never skips the check", async () => {
    s.tickets = [row("t1", { status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, last_modified: null })];
    await mount();
    await select("t1");
    await click(byText("button", /Mark Urgent/));
    const upd = s.queries.find((x) => x.table === "tickets" && x.update);
    expect(upd?.calls).toEqual(expect.arrayContaining([{ m: "is", a: ["last_modified", null] }]));
  });
});

describe("RT-4 — the tickets DELETE companion", () => {
  it("is unfiltered, drops a row this list holds, and ignores another tenant's delete without a refetch", async () => {
    await mount();
    await click(q("[data-testid=view-all]"));
    const filtered = s.channels[0].ons.find((o) => o.cfg.table === "tickets" && o.cfg.filter);
    expect(filtered?.cfg.event).toBe("*");
    const companion = s.channels[0].ons.find((o) => o.cfg.table === "tickets" && o.cfg.event === "DELETE");
    expect(companion?.cfg.filter).toBeUndefined();
    const reads = s.queries.filter((x) => x.table === "tickets" && !x.update).length;
    await act(async () => { companion!.cb({ eventType: "DELETE", old: { id: "someone-elses" } }); });
    await flush();
    expect(rowIds().sort()).toEqual(["/requests/t1", "/requests/t2", "/requests/t3"]);
    await act(async () => { companion!.cb({ eventType: "DELETE", old: { id: "t2" } }); });
    await flush();
    expect(rowIds().sort()).toEqual(["/requests/t1", "/requests/t3"]);
    expect(s.queries.filter((x) => x.table === "tickets" && !x.update).length).toBe(reads);
  });
});

describe("FRIC-7 — the queue's markers are given the requesters' current roles", () => {
  it("a departed requester's review needs management on the queue, as on the page", async () => {
    s.role = { activeRole: "Manager", roles: ["Manager"], activeOrgId: "org-1", uid: "m-1" };
    s.tickets = [row("t5", { status: "PENDING_REVIEW", requester_id: "r-gone" }), row("t6", { status: "PENDING_REVIEW", requester_id: "r-1" })];
    await mount();
    expect(rowIds()).toEqual(["/requests/t5"]);
  });
});
