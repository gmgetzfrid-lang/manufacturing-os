// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P14 — roles-and-permissions GAP-13 acceptance 1 /
// drafting-flow GAP-107 acceptance 1: the editor for the workspace's own
// reasons for ending a request, on Admin → Request forms (/admin/requests),
// AS RENDERED (the DF-P13 page harness). Same surface, same gate (the admin
// layout's `requests` surface → DRAFTING_CONFIG_EDITORS, DEC-107 item 1), same
// save (the one `drafting` row upsert, 20261209's write rule).
//   * grouped under the four ways Cancel Request can end a request;
//   * a new reason is given its id on save, from its words; a blank one is
//     dropped; a rename keeps the saved id; a removed one is gone;
//   * REGRESSION: a workspace that never configured reasons saves exactly the
//     row it saved before (no `outcomeReasons` key appears).

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
const button = (el: HTMLElement, label: RegExp) => [...el.querySelectorAll("button")].find((b) => label.test(b.textContent ?? "")) as HTMLButtonElement;
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(b: HTMLButtonElement) { await act(async () => { b.click(); }); await flush(); }


const editor = () => host!.querySelector('[data-testid="outcome-reasons-editor"]') as HTMLElement;
const group = (cat: string) => host!.querySelector(`[data-testid="outcome-reasons-${cat}"]`) as HTMLElement;
const saveBtn = () => [...host!.querySelectorAll("button")].find((b) => /Save Changes/.test(b.textContent ?? "")) as HTMLButtonElement;
const configWrites = () => h.writes.filter((w) => w.table === "org_configurations" && w.op === "upsert");

describe("GAP-13 / GAP-107 acceptance 1 — the reasons editor on Admin → Request forms (rendered)", () => {
  it("REGRESSION: with none configured the save writes exactly the row it wrote before — no reasons key", async () => {
    const before = JSON.parse(JSON.stringify(h.config));
    await render();
    expect(editor()).toBeTruthy();
    for (const cat of ["withdrawn", "duplicate", "handled_out_of_band", "rejected"]) {
      expect(group(cat).textContent).toMatch(/No reasons — offered as/);
    }
    expect(host!.querySelector('[data-testid="outcome-reasons-completed"]')).toBeNull();
    await click(saveBtn());
    expect(configWrites()).toHaveLength(1);
    expect(configWrites()[0].row).toEqual({ org_id: "o1", key: "drafting", data: before });
    expect("outcomeReasons" in (configWrites()[0].row!.data as Row)).toBe(false);
  });

  it("add under Rejected, type its words, save: the reason is written with an id from its words; a blank one is dropped", async () => {
    await render();
    await click(button(group("rejected"), /Add a reason/));
    await click(button(group("rejected"), /Add a reason/));
    const inputs = group("rejected").querySelectorAll("input");
    expect(inputs).toHaveLength(2);
    await type(inputs[0] as HTMLInputElement, "Not drafting work");
    await click(saveBtn());
    const data = configWrites()[0].row!.data as Row;
    expect(data.outcomeReasons).toEqual([{ id: "not_drafting_work", label: "Not drafting work", category: "rejected" }]);
    // the rest of the form is untouched
    expect(data.requestTypes).toEqual(h.config!.requestTypes);
    // the editor now shows what was saved (the blank row gone)
    expect(group("rejected").querySelectorAll("input")).toHaveLength(1);
  });

  it("saved reasons load into their groups; a rename keeps the id; a removed reason is gone", async () => {
    h.config = { ...h.config!, outcomeReasons: [
      { id: "vendor_did_it", label: "The vendor did it", category: "handled_out_of_band" },
      { id: "dup_ticket", label: "Filed twice", category: "duplicate" },
    ] };
    await render();
    const vendor = group("handled_out_of_band").querySelector("input") as HTMLInputElement;
    expect(vendor.value).toBe("The vendor did it");
    await type(vendor, "The vendor did it directly");
    await click(group("duplicate").querySelector("button[aria-label='Remove reason Filed twice']") as HTMLButtonElement);
    await click(saveBtn());
    expect((configWrites()[0].row!.data as Row).outcomeReasons).toEqual([
      { id: "vendor_did_it", label: "The vendor did it directly", category: "handled_out_of_band" },
    ]);
  });

  it("a refused save shows the database's words and who saves request forms (the existing gate, unchanged)", async () => {
    h.configUpsertError = { code: "42501", message: "new row violates row-level security policy" };
    await render();
    await click(button(group("withdrawn"), /Add a reason/));
    await type(group("withdrawn").querySelector("input") as HTMLInputElement, "Requester changed plans");
    await click(saveBtn());
    expect(JSON.stringify(h.alerts.at(-1))).toMatch(/row-level security[\s\S]*Admin, DocCtrl, DraftingSupervisor/);
  });
});
