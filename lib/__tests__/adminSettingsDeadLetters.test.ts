// @vitest-environment jsdom
//
// notifications Round G — N6: DELIV-4 done-when 3 and 4 on the RENDERED
// /admin/settings page. The dead-letter count and the requeue destructure
// and surface their error; the requeue reads back the rows it changed; the
// green "No failed deliveries" renders only after a read that succeeded.
// (Done-when 1 and 2 — the SELECT / UPDATE policies — are 20261047's.)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Err = { message: string } | null;
const db = vi.hoisted(() => ({
  deadCounts: [] as Array<{ count: number | null; error: Err }>,
  requeue: { data: [] as unknown[], error: null as Err },
  updates: [] as Array<Record<string, unknown>>,
  kicks: 0,
}));

vi.mock("@/lib/supabase", () => {
  const q = (table: string) => {
    let isUpdate = false;
    const chain: Record<string, unknown> = {};
    const settle = () => {
      if (table === "email_notifications") {
        if (isUpdate) return db.requeue;
        return db.deadCounts.shift() ?? { count: 0, error: null };
      }
      return { data: null, error: null, count: 2 };
    };
    Object.assign(chain, {
      select: () => (isUpdate ? Promise.resolve(settle()) : chain),
      update: (row: Record<string, unknown>) => { isUpdate = true; db.updates.push(row); return chain; },
      eq: () => chain,
      gte: () => chain,
      single: async () => ({ data: { id: "o1", name: "Org", type: "x", subscription_status: "active" }, error: null }),
      then: (res: (v: unknown) => void) => res(settle()),
    });
    return chain;
  };
  return { supabase: { from: q, auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/lib/notifications", () => ({ kickEmailDrain: vi.fn(async () => { db.kicks += 1; return null; }) }));
vi.mock("@/lib/ticketNumber", () => ({
  formatTicketNumber: () => "DDRT-2026-0001",
  getTicketNumberConfig: async () => ({ prefix: "", recordCode: "DDRT", pad: 4 }),
  TICKET_NUMBER_DEFAULTS: { prefix: "", recordCode: "DDRT", pad: 4 },
}));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ activeRole: "Admin", activeOrgId: "o1", roles: ["Admin"] }) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));

import WorkspaceSettingsPage from "@/app/(protected)/admin/settings/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const savedFetch = globalThis.fetch;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  db.deadCounts = []; db.requeue = { data: [], error: null }; db.updates = []; db.kicks = 0;
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "n/a" }), { status: 500 })) as typeof fetch;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = savedFetch;
});

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const mount = async () => { await act(async () => { root.render(React.createElement(WorkspaceSettingsPage)); }); await flush(); };
const requeueButton = () => [...host.querySelectorAll("button")].find((b) => /Requeue/.test(b.textContent ?? "")) as HTMLButtonElement | undefined;

describe("DELIV-4 dw3 / dw4 — the dead-letter panel reports what it measured, never a default", () => {
  it("a count read that fails is shown as unknown — never the green 'No failed deliveries'", async () => {
    db.deadCounts = [{ count: null, error: { message: "permission denied for table email_notifications" } }];
    await mount();
    expect(host.textContent).not.toMatch(/No failed deliveries/);
    expect(host.textContent).toMatch(/Couldn.t read the failed-delivery count \(permission denied for table email_notifications\), so it is unknown — not zero\./);
    expect(requeueButton()).toBeUndefined();
  });

  it("REGRESSION: a successful read of 0 is the green all-clear, as before", async () => {
    db.deadCounts = [{ count: 0, error: null }];
    await mount();
    expect(host.textContent).toMatch(/No failed deliveries\./);
    expect(host.textContent).not.toMatch(/Couldn.t read/);
  });

  it("a requeue that changes no row (an account the UPDATE policy refuses) says so, and who can requeue", async () => {
    db.deadCounts = [{ count: 3, error: null }, { count: 3, error: null }];
    db.requeue = { data: [], error: null };
    await mount();
    expect(host.textContent).toMatch(/3 emails failed to send/);
    expect(host.textContent).toMatch(/Only an Admin or a Manager can requeue\./);
    await act(async () => { requeueButton()!.click(); });
    await flush();
    expect(db.updates).toEqual([{ status: "queued", attempt_count: 0 }]);
    expect(host.textContent).toMatch(/Nothing was requeued — the database let this account change none of these rows\. Only an Admin or a Manager can requeue failed email\./);
    expect(db.kicks).toBe(1); // the probe on load only — no drain kick for a requeue that changed nothing
  });

  it("a requeue reads back the rows it changed, reports the number, kicks the drain and re-reads the count", async () => {
    db.deadCounts = [{ count: 3, error: null }, { count: 0, error: null }];
    db.requeue = { data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null };
    await mount();
    await act(async () => { requeueButton()!.click(); });
    await flush();
    expect(host.textContent).toMatch(/Requeued 3 emails; they send on the next drain\./);
    expect(db.kicks).toBe(2);
    expect(host.textContent).toMatch(/No failed deliveries\./);
  });

  it("a requeue the database refuses with an error shows it", async () => {
    db.deadCounts = [{ count: 2, error: null }, { count: 2, error: null }];
    db.requeue = { data: null as unknown as unknown[], error: { message: "A queued message can be re-queued or cancelled, never rewritten." } };
    await mount();
    await act(async () => { requeueButton()!.click(); });
    await flush();
    expect(host.textContent).toMatch(/Nothing was requeued: A queued message can be re-queued or cancelled, never rewritten\./);
  });
});
