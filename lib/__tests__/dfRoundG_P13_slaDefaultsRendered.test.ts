// @vitest-environment jsdom
//
// drafting-flow Round G — DF-P13, RENDERED: /admin/requests, the due-date
// windows (sla_defaults) editor — EDGE-7 done-when 2's editor, EDGE-16.
//   * one row per request type on the form, each with the built-in window as
//     its placeholder, the saved window as its value, a stored value outside
//     1–3650 flagged, and a stored window for a type no longer on the form
//     listed so it can be removed;
//   * validated to the create route's own bound before anything is sent;
//   * a save is ONE checked upsert; a refusal shows the database's own words
//     and who saves these windows; "Use built-in" is a checked delete;
//   * saving a window that would put open requests with no due date of their
//     own past due asks first (EDGE-7's residual), and nothing is written on No;
//     what the question says happens to them follows whether the SLA clock has
//     started (tickets.outcome, 20261195 — the clock's own gate);
//   * the rows follow the SAVED request form, never an unsaved edit of it;
//   * regression: the page's request-form save is exactly as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];
const h = vi.hoisted(() => ({
  config: null as Row | null,
  sla: [] as Array<{ id: string; org_id: string; request_type: string; default_days: number }>,
  slaLoadError: null as null | { code: string; message: string },
  slaUpsertError: null as null | { code: string; message: string },
  slaDeleteMatchesNothing: false,
  configUpsertError: null as null | { code: string; message: string },
  overdue: 0,
  dueSoon: 0,
  countError: null as null | { message: string },
  clockError: null as null | { code: string; message: string },
  clockProbes: [] as string[],
  writes: [] as Array<{ table: string; op: string; row?: Row; opts?: unknown; filters: Filter[]; selected: string | null }>,
  counts: [] as Filter[][],
  confirmAnswer: true,
  confirms: [] as Array<Record<string, unknown>>,
  alerts: [] as unknown[],
  seq: 0,
}));

vi.mock("@/lib/supabase", () => {
  const from = (table: string) => {
    let op = "select";
    let row: Row | undefined;
    let opts: unknown;
    let selected: string | null = null;
    let cols = "";
    let head = false;
    const filters: Filter[] = [];
    const answer = (): Row => {
      if (op === "select" && table === "tickets" && head) {
        h.counts.push([...filters]);
        if (h.countError) return { data: null, error: h.countError, count: null };
        return { data: null, error: null, count: filters.some((f) => f[0] === "gt") ? h.dueSoon : h.overdue };
      }
      if (op === "select" && table === "tickets") {
        // the SLA clock's gate: tickets.outcome exists once 20261195 is pasted
        h.clockProbes.push(cols);
        return h.clockError ? { data: null, error: h.clockError } : { data: [], error: null };
      }
      if (table === "org_configurations") {
        if (op === "upsert") { h.writes.push({ table, op, row, opts, filters, selected }); return { data: null, error: h.configUpsertError }; }
        return { data: h.config ? { data: h.config } : null, error: null };
      }
      if (table === "sla_defaults") {
        const org = filters.find((f) => f[1] === "org_id")?.[2];
        if (op === "select") {
          if (h.slaLoadError) return { data: null, error: h.slaLoadError };
          return { data: h.sla.filter((r) => r.org_id === org).map((r) => ({ id: r.id, request_type: r.request_type, default_days: r.default_days })), error: null };
        }
        h.writes.push({ table, op, row, opts, filters: [...filters], selected });
        if (op === "upsert") {
          if (h.slaUpsertError) return { data: null, error: h.slaUpsertError };
          const r = row as { org_id: string; request_type: string; default_days: number };
          const existing = h.sla.find((x) => x.org_id === r.org_id && x.request_type === r.request_type);
          if (existing) existing.default_days = r.default_days;
          else h.sla.push({ id: `s${++h.seq}`, org_id: r.org_id, request_type: r.request_type, default_days: r.default_days });
          const id = (existing ?? h.sla[h.sla.length - 1]).id;
          return { data: selected ? [{ id }] : null, error: null };
        }
        if (op === "delete") {
          if (h.slaDeleteMatchesNothing) return { data: [], error: null };
          const type = filters.find((f) => f[1] === "request_type")?.[2];
          const gone = h.sla.filter((x) => x.org_id === org && x.request_type === type);
          h.sla = h.sla.filter((x) => !gone.includes(x));
          return { data: selected ? gone.map((g) => ({ id: g.id })) : null, error: null };
        }
      }
      return { data: null, error: null };
    };
    const b: Record<string, unknown> = {
      select: (c: string, o?: { head?: boolean }) => { if (op === "select") { cols = c; head = !!o?.head; } else { selected = c; } return b; },
      limit: () => b,
      upsert: (r: Row, o: unknown) => { op = "upsert"; row = r; opts = o; return b; },
      delete: () => { op = "delete"; return b; },
      eq: (k: string, v: unknown) => { filters.push(["eq", k, v]); return b; },
      not: (k: string, o: string, v: unknown) => { filters.push(["not", k, `${o} ${String(v)}`]); return b; },
      is: (k: string, v: unknown) => { filters.push(["is", k, v]); return b; },
      lte: (k: string, v: unknown) => { filters.push(["lte", k, v]); return b; },
      gt: (k: string, v: unknown) => { filters.push(["gt", k, v]); return b; },
      single: () => Promise.resolve(answer()),
      maybeSingle: () => Promise.resolve(answer()),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(answer()).then(res, rej),
    };
    return b;
  };
  return { supabase: { from } };
});
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "o1", uid: "u-ds", activeRole: "DraftingSupervisor", roles: ["DraftingSupervisor"], hasAnyRole: () => true }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({
  appAlert: vi.fn(async (o: unknown) => { h.alerts.push(o); }),
  appConfirm: vi.fn(async (o: Record<string, unknown>) => { h.confirms.push(o); return h.confirmAnswer; }),
}));

import DraftingConfigPage from "@/app/(protected)/admin/requests/page";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  h.config = {
    requestTypes: { label: "Request Type", enabled: true, options: [
      { label: "ISO (Isometric)", value: "ISO" },
      { label: "RFI (Info Request)", value: "RFI", closeWithoutReview: true },
      { label: "MOC (Change Mgmt)", value: "MOC" },
      { label: "New Option", value: "" },
    ] },
    units: { label: "Unit / Area", enabled: true, options: [{ label: "Unit 100", value: "100" }] },
    priorities: { label: "Priority", enabled: true, options: [{ label: "1 - Urgent", value: 1 }] },
  };
  h.sla = [
    { id: "s-iso", org_id: "o1", request_type: "ISO", default_days: 3 },
    { id: "s-moc", org_id: "o1", request_type: "MOC", default_days: 0 },          // written before the CHECK
    { id: "s-old", org_id: "o1", request_type: "LEGACY", default_days: 5 },       // a type since removed from the form
    { id: "s-x", org_id: "o2", request_type: "RFI", default_days: 9 },            // another workspace's — never shown
  ];
  h.slaLoadError = null; h.slaUpsertError = null; h.slaDeleteMatchesNothing = false; h.configUpsertError = null;
  h.overdue = 0; h.dueSoon = 0; h.countError = null; h.clockError = null; h.clockProbes = [];
  h.writes = []; h.counts = []; h.confirmAnswer = true; h.confirms = []; h.alerts = []; h.seq = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.clearAllMocks(); });

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function render() { await act(async () => { root!.render(React.createElement(DraftingConfigPage)); }); await flush(); }
const section = () => host!.querySelector('[data-testid="sla-defaults"]') as HTMLElement;
const rowOf = (type: string) => section().querySelector(`[data-sla-type="${type}"]`) as HTMLElement;
const inputOf = (type: string) => rowOf(type).querySelector("input") as HTMLInputElement;
const button = (el: HTMLElement, label: RegExp) => [...el.querySelectorAll("button")].find((b) => label.test(b.textContent ?? "")) as HTMLButtonElement;
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(b: HTMLButtonElement) { await act(async () => { b.click(); }); await flush(); }
const slaWrites = () => h.writes.filter((w) => w.table === "sla_defaults");

describe("/admin/requests — the due-date windows editor (rendered)", () => {
  it("renders one row per request type on the form (blank values skipped), the saved window, the built-in placeholder, a flagged out-of-range value and a stored window for a removed type — this workspace's only", async () => {
    await render();
    expect(section()).toBeTruthy();
    expect(section().textContent).toContain("Due-date windows");
    expect(section().textContent).toContain("warns the person a request waits on at 75% of its window");
    const types = [...section().querySelectorAll("[data-sla-type]")].map((e) => e.getAttribute("data-sla-type"));
    expect(types).toEqual(["ISO", "RFI", "MOC", "LEGACY"]);
    expect(inputOf("ISO").value).toBe("3");
    expect(rowOf("ISO").textContent).toContain("Saved: 3 day(s) — the clock warns after 2 day(s).");
    expect(inputOf("RFI").value).toBe("");
    expect(inputOf("RFI").placeholder).toBe("Built-in: 3");
    expect(rowOf("RFI").textContent).toContain("Built-in window: 3 day(s).");
    expect(button(rowOf("RFI"), /Use built-in/)).toBeUndefined();
    expect(inputOf("MOC").value).toBe("");
    expect(rowOf("MOC").textContent).toContain("The stored window (0) is outside 1–3650 days: new requests use the built-in 7 day(s).");
    expect(rowOf("LEGACY").textContent).toContain("not on the request form");
    expect(button(rowOf("LEGACY"), /Use built-in/)).toBeTruthy();
    expect(inputOf("ISO").getAttribute("aria-label")).toBe("Due-date window in days for ISO (Isometric)");
  });

  it("a stored positive window outside the bound (pre-paste residue) also says the SLA clock still reads it (EDGE-17); a non-positive one, which the clock skips, does not", async () => {
    h.sla.find((r) => r.id === "s-moc")!.default_days = 5000;
    await render();
    expect(rowOf("MOC").textContent).toContain("The stored window (5000) is outside 1–3650 days: new requests use the built-in 7 day(s). The SLA clock does not apply this bound yet: until the window is corrected, it still reads the stored value for open MOC (Change Mgmt) requests with no due date of their own. Enter a window, or use the built-in one.");
    act(() => root?.unmount());
    root = createRoot(host!);
    h.sla.find((r) => r.id === "s-moc")!.default_days = 0;
    await render();
    expect(rowOf("MOC").textContent).toContain("The stored window (0) is outside 1–3650 days: new requests use the built-in 7 day(s). Enter a window, or use the built-in one.");
    expect(rowOf("MOC").textContent).not.toContain("still reads the stored value");
  });

  it("validation before anything is sent: 0, 3651, 1.5 and text are refused with the reason, and Save stays disabled", async () => {
    await render();
    const cases: Array<[string, RegExp]> = [["0", /Between 1 and 3650 days/], ["3651", /Between 1 and 3650 days/], ["1.5", /Whole days only/], ["two", /Whole days only/], ["", /Enter a number of days/]];
    for (const [v, msg] of cases) {
      await type(inputOf("RFI"), v);
      expect(rowOf("RFI").textContent, v).toMatch(msg);
      expect(inputOf("RFI").getAttribute("aria-invalid"), v).toBe("true");
      expect(button(rowOf("RFI"), /^Save$/).disabled, v).toBe(true);
    }
    expect(slaWrites()).toEqual([]);
    // the stored value retyped is no change
    await type(inputOf("ISO"), "3");
    expect(button(rowOf("ISO"), /^Save$/).disabled).toBe(true);
  });

  it("a valid window saves through ONE checked upsert (org, type, days; onConflict org_id,request_type; .select('id')) and the page says so", async () => {
    await render();
    await type(inputOf("RFI"), "5");
    expect(button(rowOf("RFI"), /^Save$/).disabled).toBe(false);
    await click(button(rowOf("RFI"), /^Save$/));
    expect(slaWrites()).toHaveLength(1);
    const w = slaWrites()[0];
    expect(w.op).toBe("upsert");
    expect(w.row).toMatchObject({ org_id: "o1", request_type: "RFI", default_days: 5 });
    expect(w.opts).toEqual({ onConflict: "org_id,request_type" });
    expect(w.selected).toBe("id");
    expect(h.confirms).toEqual([]);   // nothing would fall due: no question asked
    expect(rowOf("RFI").textContent).toContain("Saved: RFI (Info Request) requests filed without a requested date are due 5 day(s) after filing.");
    expect(rowOf("RFI").textContent).not.toContain("Saved: RFI (Info Request) requests are due");
    expect(inputOf("RFI").value).toBe("5");   // re-read from the database
    // the impact was counted with the clock's filters before the write
    expect(h.counts).toHaveLength(2);
    for (const c of h.counts) {
      expect(c).toEqual(expect.arrayContaining([["eq", "org_id", "o1"], ["eq", "request_type", "RFI"], ["not", "status", "in (CLOSED,CANCELED)"], ["is", "target_completion_at", null], ["is", "sla_breached_at", null], ["is", "archived_at", null]]));
    }
    expect(h.clockProbes).toEqual([]);   // nothing to ask: the clock is not read
  });

  it("a refused save shows the database's own words and who saves these windows (EDGE-16: the refusal is never a generic line)", async () => {
    h.slaUpsertError = { code: "42501", message: 'new row violates row-level security policy for table "sla_defaults"' };
    await render();
    await type(inputOf("ISO"), "1");
    await click(button(rowOf("ISO"), /^Save$/));
    const alert = [...rowOf("ISO").querySelectorAll('[role="alert"]')].map((e) => e.textContent).join(" ");
    expect(alert).toContain("Not saved: You don't have permission to do this — nothing was changed.");
    expect(alert).toContain('The database said: "new row violates row-level security policy for table "sla_defaults"" (42501).');
    expect(alert).toContain("Due-date windows are saved by Admin, DocCtrl, DraftingSupervisor.");
    expect(h.sla.find((r) => r.id === "s-iso")!.default_days).toBe(3);
  });

  it("EDGE-7's residual, the SLA clock started: a window that would put open requests with no due date of their own past due asks first — No writes nothing, Yes saves", async () => {
    h.overdue = 4; h.dueSoon = 2;
    h.confirmAnswer = false;
    await render();
    await type(inputOf("RFI"), "2");
    await click(button(rowOf("RFI"), /^Save$/));
    expect(h.confirms).toHaveLength(1);
    expect(h.clockProbes).toEqual(["outcome"]);
    expect(String(h.confirms[0].message)).toBe(
      '4 open RFI (Info Request) request(s) with no due date of their own were filed more than 2 day(s) ago: the next SLA run (the nightly maintenance job) records each as overdue and sends an "Overdue" notice to the person it waits on, the assignment queue and the requester. 2 more are past 1 day(s) and get a "Due soon" notice. Save anyway?',
    );
    expect(slaWrites()).toEqual([]);
    h.confirmAnswer = true;
    await click(button(rowOf("RFI"), /^Save$/));
    expect(slaWrites()).toHaveLength(1);
  });

  it("EDGE-7's residual, the SLA clock NOT started (20261195 unpasted, tickets.outcome missing): the question says nothing is sent now, and that the paste records them as overdue with one summary notice to the queue", async () => {
    h.overdue = 4; h.dueSoon = 2;
    h.clockError = { code: "42703", message: "column tickets.outcome does not exist" };
    h.confirmAnswer = false;
    await render();
    await type(inputOf("RFI"), "2");
    await click(button(rowOf("RFI"), /^Save$/));
    const msg = String(h.confirms[0].message);
    expect(msg).toBe(
      "4 open RFI (Info Request) request(s) with no due date of their own were filed more than 2 day(s) ago. The SLA clock has not started yet (migration 20261195 is not applied), so nothing is sent for them now: when 20261195 is applied, the ones then past this window are recorded as overdue without a notice of their own, and the workspace's assignment queue gets one summary notice naming how many. 2 more are past 1 day(s): once the clock has started, the SLA run sends each one still inside this window a \"Due soon\" notice. Save anyway?",
    );
    expect(msg).not.toContain("to the person it waits on");
    expect(slaWrites()).toEqual([]);
  });

  it("when the impact cannot be counted, the question says so (fail-safe) before anything is written — in both clock states", async () => {
    h.countError = { message: "statement timeout" };
    h.confirmAnswer = false;
    await render();
    await type(inputOf("RFI"), "2");
    await click(button(rowOf("RFI"), /^Save$/));
    expect(String(h.confirms[0].message)).toBe(
      'Whether this window puts open RFI (Info Request) requests with no due date of their own past due could not be checked (statement timeout). Any filed more than 2 day(s) ago get an "Overdue" notice at the next SLA run (the nightly maintenance job). Save anyway?',
    );
    h.clockError = { code: "PGRST204", message: "Could not find the 'outcome' column of 'tickets' in the schema cache" };
    await click(button(rowOf("RFI"), /^Save$/));
    expect(String(h.confirms[1].message)).toBe(
      "Whether this window puts open RFI (Info Request) requests with no due date of their own past due could not be checked (statement timeout). The SLA clock has not started yet (migration 20261195 is not applied), so nothing is sent for them now: when 20261195 is applied, any filed more than 2 day(s) before then are recorded as overdue without a notice of their own, and the workspace's assignment queue gets one summary notice naming how many. Save anyway?",
    );
    expect(slaWrites()).toEqual([]);
  });

  it("the rows follow the SAVED request form: a type added or renamed above and not yet saved gets no row (and a note says why) until Save Changes", async () => {
    await render();
    const valueInputs = () => [...host!.querySelectorAll('input[placeholder="Value (ID)"]')] as HTMLInputElement[];
    expect(valueInputs().map((i) => i.value)).toEqual(["ISO", "RFI", "MOC", ""]);
    expect(section().textContent).not.toContain("unsaved changes");
    await type(valueInputs()[3], "ISOX");     // a new type, unsaved
    await type(valueInputs()[0], "ISO2");     // a rename, unsaved
    const types = () => [...section().querySelectorAll("[data-sla-type]")].map((e) => e.getAttribute("data-sla-type"));
    expect(types()).toEqual(["ISO", "RFI", "MOC", "LEGACY"]);
    expect(inputOf("ISO").value).toBe("3");
    expect(rowOf("ISO").textContent).not.toContain("not on the request form");
    expect(section().textContent).toContain("The request types above have unsaved changes. These windows follow the saved request form: save it (Save Changes) to set a window for a new or renamed type.");
    expect(slaWrites()).toEqual([]);
    // saved: the rows follow, and the ISO window (keyed by the old value) is now a stored window off the form
    await click(button(host!, /Save Changes/));
    expect(types()).toEqual(["ISO2", "RFI", "MOC", "ISOX", "ISO", "LEGACY"]);
    expect(rowOf("ISO").textContent).toContain("not on the request form");
    expect(section().textContent).not.toContain("unsaved changes");
    // a refused form save leaves the rows on the last saved form
    h.configUpsertError = { code: "42501", message: "new row violates row-level security policy" };
    await type(valueInputs()[3], "ISOY");
    await click(button(host!, /Save Changes/));
    expect(types()).toEqual(["ISO2", "RFI", "MOC", "ISOX", "ISO", "LEGACY"]);
    expect(section().textContent).toContain("unsaved changes");
  });

  it("'Use built-in' asks, then removes the type's window with a checked delete; a delete that removed nothing is said as refused", async () => {
    await render();
    await click(button(rowOf("LEGACY"), /Use built-in/));
    expect(String(h.confirms[0].message)).toContain("New LEGACY requests will be due 14 day(s) after filing (the built-in window)");
    expect(slaWrites()).toHaveLength(1);
    expect(slaWrites()[0]).toMatchObject({ op: "delete", filters: [["eq", "org_id", "o1"], ["eq", "request_type", "LEGACY"]], selected: "id" });
    expect(rowRemoved("LEGACY")).toBe(true);

    h.slaDeleteMatchesNothing = true;
    await click(button(rowOf("ISO"), /Use built-in/));
    const alert = [...rowOf("ISO").querySelectorAll('[role="alert"]')].map((e) => e.textContent).join(" ");
    expect(alert).toContain("Not saved: Nothing was changed — you don't have permission to do this, or someone else changed it first.");
    expect(alert).toContain("Due-date windows are saved by Admin, DocCtrl, DraftingSupervisor.");
  });

  it("an unreadable table is an error, never an empty editor; a missing one names its migration", async () => {
    h.slaLoadError = { code: "57014", message: "statement timeout" };
    await render();
    expect(section().textContent).toContain("The due-date windows could not be read (statement timeout). Nothing is shown as saved.");
    expect(section().querySelectorAll("[data-sla-type]")).toHaveLength(0);
    h.slaLoadError = { code: "42P01", message: 'relation "sla_defaults" does not exist' };
    act(() => root?.unmount());
    root = createRoot(host!);
    await render();
    expect(section().textContent).toContain("Due-date windows need the sla_defaults table (migration 20260529_phase_b_notifications.sql)");
  });

  it("regression: the request-form save is exactly as before — one upsert of org_configurations 'drafting', the success alert, and the database's refusal text on failure", async () => {
    await render();
    const save = button(host!, /Save Changes/);
    await click(save);
    const cfg = h.writes.filter((w) => w.table === "org_configurations");
    expect(cfg).toHaveLength(1);
    expect(cfg[0].row).toMatchObject({ org_id: "o1", key: "drafting" });
    expect(cfg[0].opts).toEqual({ onConflict: "org_id,key" });
    expect(h.alerts).toEqual(["Configuration saved successfully."]);
    expect(slaWrites()).toEqual([]);   // the form save never writes a window
    h.configUpsertError = { code: "42501", message: 'new row violates row-level security policy for table "org_configurations"' };
    await click(save);
    expect(h.alerts[1]).toEqual({
      message: 'Not saved: the database refused the change (new row violates row-level security policy for table "org_configurations"). Request forms are saved by Admin, DocCtrl, DraftingSupervisor.',
      tone: "danger",
    });
  });
});

function rowRemoved(type: string): boolean {
  return section().querySelector(`[data-sla-type="${type}"]`) === null;
}
