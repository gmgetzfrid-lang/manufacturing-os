// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P24 — RENDERED: /admin/requests, how a
// requirement's `since` reaches the store (DEC-90 ruling (2): a request
// already in flight when an Admin configures a requirement is never newly
// blocked). Second fix pass: the DATABASE stamps it (20261266's trigger on
// org_configurations — pinned at runtime in
// lib/__tests__/rls/dfP24ExaminationScope.test.ts); the page never computes
// a time. Here the store stands in for that trigger:
//   * ONE save; the page sends no time of its own for a new requirement and
//     reads no clock; it reads the row back and shows the time the database
//     gave (never a value it sent — a stale or backdated one is not kept);
//   * before 20261266 nothing stamps the requirement: the alert says it
//     refuses nothing yet;
//   * regression: a save without a requirement is ONE upsert, no read-back,
//     no clock read.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Row = Record<string, unknown>;
const DB_STAMP = "2026-10-22T10:01:00Z";
const h = vi.hoisted(() => ({
  config: null as Row | null,
  writes: [] as Row[],
  readsAfterWrite: 0,
  alerts: [] as unknown[],
  fetches: [] as string[],
  migrated: true,
  browserNow: Date.parse("2026-10-22T09:20:00.000Z"),
}));

/** The stand-in for 20261266's trigger: an unchanged requirement keeps the
 *  stored time; any other gets the database's; the writer's is ignored. */
function stampLikeTheDatabase(next: Row, stored: Row | null): Row {
  const scope = next.examinationScope as { requirements?: Array<Row> } | undefined;
  if (!h.migrated || !scope || !Array.isArray(scope.requirements)) return next;
  const old = ((stored?.examinationScope as { requirements?: Array<Row> } | undefined)?.requirements ?? []);
  const id = (r: Row) => `${r.field}|${r.workClass ?? ""}|${r.libraryId ?? ""}`;
  return { ...next, examinationScope: { ...scope, requirements: scope.requirements.map((r) => ({ ...r, since: (old.find((o) => id(o) === id(r))?.since as string | undefined) ?? "2026-10-22T10:01:00Z" })) } };
}

vi.mock("@/lib/supabase", () => {
  const from = (table: string) => {
    let op = "select";
    let row: Row | undefined;
    const answer = (): Row => {
      if (table === "org_configurations") {
        if (op === "upsert") {
          h.writes.push(JSON.parse(JSON.stringify(row)));
          h.config = stampLikeTheDatabase((row as Row).data as Row, h.config);
          return { data: null, error: null };
        }
        if (h.writes.length > 0) h.readsAfterWrite += 1;
        return { data: h.config ? { data: h.config } : null, error: null };
      }
      return { data: [], error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b, limit: () => b, eq: () => b, not: () => b, is: () => b, lte: () => b, gt: () => b,
      upsert: (r: Row) => { op = "upsert"; row = r; return b; },
      delete: () => { op = "delete"; return b; },
      single: () => Promise.resolve(answer()),
      maybeSingle: () => Promise.resolve(answer()),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(answer()).then(res, rej),
    };
    return b;
  };
  return { supabase: { from } };
});
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "o1", uid: "u-a", activeRole: "Admin", roles: ["Admin"], hasAnyRole: () => true }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({
  appAlert: vi.fn(async (o: unknown) => { h.alerts.push(o); }),
  appConfirm: vi.fn(async () => true),
}));

import DraftingConfigPage from "@/app/(protected)/admin/requests/page";

const T1 = "2026-10-01T00:00:00.000Z";
const BASE = {
  requestTypes: { label: "Request Type", enabled: true, options: [{ label: "ISO", value: "ISO" }] },
  units: { label: "Unit / Area", enabled: true, options: [] },
  priorities: { label: "Priority", enabled: true, options: [] },
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const realFetch = globalThis.fetch;

beforeEach(() => {
  h.config = null; h.writes = []; h.readsAfterWrite = 0; h.alerts = []; h.fetches = []; h.migrated = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(h.browserNow));   // the browser's clock runs 40 minutes slow
  globalThis.fetch = vi.fn(async (input: unknown) => {
    h.fetches.push(String(input));
    return new Response("{}", { status: 200, headers: { date: "Thu, 22 Oct 2026 10:00:00 GMT" } });
  }) as typeof fetch;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount()); host?.remove(); root = null; host = null;
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.clearAllMocks();
});

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function render() { await act(async () => { root!.render(React.createElement(DraftingConfigPage)); }); await flush(); }
const button = (el: HTMLElement, label: RegExp) => [...el.querySelectorAll("button")].find((b) => label.test(b.textContent ?? "")) as HTMLButtonElement;
async function save() { await act(async () => { button(host!, /Save Changes/).click(); }); await flush(); }
const reqsOf = (w: Row) => ((w.data as Row).examinationScope as { requirements: Array<Row> }).requirements;

const sinceText = () => [...host!.querySelectorAll("span")].map((x) => x.textContent ?? "").filter((t) => /applies to requests filed/.test(t));

describe("/admin/requests — a requirement's since is the database's (rendered, second fix pass)", () => {
  it("a new requirement: ONE save carrying no time of the page's own, no clock read; the row read back shows the database's time", async () => {
    h.config = { ...BASE, examinationScope: { fields: [{ key: "exam", label: "Exam", options: [{ value: "a", label: "A" }] }], requirements: [{ field: "exam", workClass: "code" }] } };
    await render();
    expect(sinceText()).toEqual(["applies to requests filed after you save"]);
    await save();
    expect(h.writes).toHaveLength(1);
    expect(reqsOf(h.writes[0])[0]).not.toHaveProperty("since");
    expect(h.fetches).toEqual([]);
    expect(h.readsAfterWrite).toBe(1);
    expect(sinceText()).toEqual([`applies to requests filed from ${new Date(DB_STAMP).toLocaleString()}`]);
    expect(h.alerts).toEqual(["Configuration saved successfully."]);
  });

  it("whatever time the page holds is not what is kept: a stale or backdated since in the page is replaced by the stored one", async () => {
    // the page loaded a backdated value (a REST write, a restore …); the
    // database keeps its own stored time for the unchanged requirement
    h.config = { ...BASE, examinationScope: { fields: [{ key: "exam", label: "Exam", options: [{ value: "a", label: "A" }] }], requirements: [{ field: "exam", workClass: "code", since: "2020-01-01T00:00:00Z" }] } };
    await render();
    h.config = { ...h.config, examinationScope: { ...(h.config.examinationScope as Row), requirements: [{ field: "exam", workClass: "code", since: T1 }] } };
    await save();
    expect(h.writes).toHaveLength(1);
    expect(sinceText()).toEqual([`applies to requests filed from ${new Date(T1).toLocaleString()}`]);
  });

  it("before 20261266 nothing stamps a requirement: saved, and the alert says it refuses nothing yet", async () => {
    h.migrated = false;
    h.config = { ...BASE, examinationScope: { fields: [{ key: "exam", label: "Exam", options: [{ value: "a", label: "A" }] }], requirements: [{ field: "exam", workClass: "code" }] } };
    await render();
    await save();
    expect(h.writes).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ tone: "danger", message: expect.stringMatching(/20261266 is not applied\), so it refuses nothing/) });
  });

  it("regression: a save without a requirement is ONE upsert of the same object — no read-back, no clock read", async () => {
    for (const cfg of [BASE, { ...BASE, examinationScope: { fields: [{ key: "exam", label: "Exam", options: [{ value: "a", label: "A" }] }], requirements: [] } }]) {
      act(() => root?.unmount());
      root = createRoot(host!);
      h.writes = []; h.fetches = []; h.alerts = []; h.readsAfterWrite = 0;
      h.config = cfg;
      await render();
      await save();
      expect(h.writes).toHaveLength(1);
      expect(h.fetches).toEqual([]);
      expect(h.readsAfterWrite).toBe(0);
      expect(h.writes[0]).toMatchObject({ org_id: "o1", key: "drafting", data: cfg });
      expect(h.alerts).toEqual(["Configuration saved successfully."]);
    }
  });
});
