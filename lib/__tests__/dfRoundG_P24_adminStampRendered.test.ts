// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P24 fix pass — RENDERED: /admin/requests, how a
// requirement's `since` is stamped (DEC-90 ruling (2): a request already in
// flight when an Admin configures a requirement is never newly blocked).
//   * the requirement is first saved UNSTAMPED (it binds nothing), then the
//     server's clock is read (the Date header of /api/version, rounded up to
//     the next second) and a second save stamps it — never the browser's
//     clock, never earlier than the first save's commit;
//   * a requirement stored while its field had no choices keeps refusing
//     nothing; the save that gives the field choices re-stamps it (its old
//     `since` is never revived);
//   * the server's clock unreadable: the requirement stays unstamped (binds
//     nothing yet) and the alert says so;
//   * regression: a save with nothing to stamp is ONE upsert, no clock read.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  config: null as Row | null,
  writes: [] as Row[],
  alerts: [] as unknown[],
  fetches: [] as string[],
  dateHeader: "Thu, 22 Oct 2026 10:00:00 GMT" as string | null,
  browserNow: Date.parse("2026-10-22T09:20:00.000Z"),
}));

vi.mock("@/lib/supabase", () => {
  const from = (table: string) => {
    let op = "select";
    let row: Row | undefined;
    const answer = (): Row => {
      if (table === "org_configurations") {
        if (op === "upsert") { h.writes.push(JSON.parse(JSON.stringify(row))); return { data: null, error: null }; }
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
  h.config = null; h.writes = []; h.alerts = []; h.fetches = []; h.dateHeader = "Thu, 22 Oct 2026 10:00:00 GMT";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(h.browserNow));   // the browser's clock runs 40 minutes slow
  globalThis.fetch = vi.fn(async (input: unknown) => {
    h.fetches.push(String(input));
    return new Response("{}", { status: 200, headers: h.dateHeader ? { date: h.dateHeader } : {} });
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

describe("/admin/requests — a requirement's since is the server's time after its save committed (rendered)", () => {
  it("a new requirement: saved unstamped first, then stamped with the server's Date (rounded up) — never the browser's slow clock", async () => {
    h.config = { ...BASE, examinationScope: { fields: [{ key: "exam", label: "Exam", options: [{ value: "a", label: "A" }] }], requirements: [{ field: "exam", workClass: "code" }] } };
    await render();
    await save();
    expect(h.writes).toHaveLength(2);
    expect(reqsOf(h.writes[0])[0]).not.toHaveProperty("since");
    expect(h.fetches).toEqual(["/api/version"]);
    expect(reqsOf(h.writes[1])[0].since).toBe("2026-10-22T10:00:01.000Z");
    expect(String(reqsOf(h.writes[1])[0].since) > new Date(h.browserNow).toISOString()).toBe(true);
    expect(h.alerts).toEqual(["Configuration saved successfully."]);
  });

  it("a requirement stored while its field had no choices: the save that adds the choices re-stamps it (its old since is not revived)", async () => {
    h.config = { ...BASE, examinationScope: { fields: [{ key: "exam", label: "Exam", options: [] }], requirements: [{ field: "exam", workClass: "code", since: T1 }] } };
    await render();
    const ta = host!.querySelector('textarea[aria-label="Choices, one per line"]') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "a | A");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { ta.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    await flush();
    await save();
    expect(h.writes).toHaveLength(2);
    expect(reqsOf(h.writes[0])[0]).not.toHaveProperty("since");
    expect(reqsOf(h.writes[1])[0].since).toBe("2026-10-22T10:00:01.000Z");
    // A second save (nothing changed) keeps that stamp: one write, no clock read.
    h.writes = []; h.fetches = [];
    await save();
    expect(h.writes).toHaveLength(1);
    expect(h.fetches).toEqual([]);
    expect(reqsOf(h.writes[0])[0].since).toBe("2026-10-22T10:00:01.000Z");
  });

  it("the server's clock unreadable: the requirement stays unstamped (binds nothing yet) and the alert says so", async () => {
    h.dateHeader = null;
    h.config = { ...BASE, examinationScope: { fields: [{ key: "exam", label: "Exam", options: [{ value: "a", label: "A" }] }], requirements: [{ field: "exam", workClass: "code" }] } };
    await render();
    await save();
    expect(h.writes).toHaveLength(1);
    expect(reqsOf(h.writes[0])[0]).not.toHaveProperty("since");
    expect(h.alerts[0]).toMatchObject({ tone: "danger", message: expect.stringMatching(/refuses nothing yet/) });
  });

  it("regression: a save with nothing to stamp (no requirement, or every one stamped on a fillable field) is ONE upsert and reads no clock", async () => {
    for (const cfg of [BASE, { ...BASE, examinationScope: { fields: [{ key: "exam", label: "Exam", options: [{ value: "a", label: "A" }] }], requirements: [{ field: "exam", workClass: "code", since: T1 }] } }]) {
      act(() => root?.unmount());
      root = createRoot(host!);
      h.writes = []; h.fetches = []; h.alerts = [];
      h.config = cfg;
      await render();
      await save();
      expect(h.writes).toHaveLength(1);
      expect(h.fetches).toEqual([]);
      expect(h.writes[0]).toMatchObject({ org_id: "o1", key: "drafting", data: cfg });
      expect(h.alerts).toEqual(["Configuration saved successfully."]);
    }
  });
});
