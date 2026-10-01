// @vitest-environment jsdom
// projects Round G — J10 third review fix, MON-7 / COST-12 (the row
// assignment limb) and A11Y-8, on the RENDERED Quality tab.
//
// Naming the contractor of a turnover or punch item that is ALREADY decided
// attributes that decision to the contractor's Known Company at once, and
// the name is never moved afterwards. It used to be written the moment the
// row's select changed — a keyboard arrow on a closed select fires `change`
// — with no confirmation, and a rejected item could be attributed with no
// way to correct it. Now:
//   * an undecided item's pick is still its write (it can be changed);
//   * a decided item (accepted / waived turnover, closed / voided punch)
//     with no contractor shows a select plus "Assign": the pick writes
//     nothing, and Assign asks first — naming the item, the contractor and
//     its Known Company, and saying it is permanent;
//   * a rejected turnover item is not named at all (no reopen — a wrong
//     name could never be corrected); the library refuses it too;
//   * an item assigned to a contractor later set inactive still names it,
//     and an open row's select still shows it — only the add / seed pickers
//     leave inactive contractors out;
//   * every Quality-tab button that writes carries the decision-target floor.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const m = vi.hoisted(() => ({
  listParties: vi.fn(), getCompany: vi.fn(), appConfirm: vi.fn(), appPrompt: vi.fn(),
  listChecklists: vi.fn(), loadSignoffAuthority: vi.fn(),
  listTurnoverItems: vi.fn(), listTurnoverReviewEvents: vi.fn(), listPunchItems: vi.fn(),
  assignTurnoverContractor: vi.fn(), assignPunchContractor: vi.fn(),
}));

vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return () => new Proxy(chain, handler);
    },
  };
  return { supabase: { from: () => new Proxy(chain, handler), rpc: () => new Proxy(chain, handler), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn() }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ member: { displayName: "Pat Reviewer" } }) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: m.appConfirm, appPrompt: m.appPrompt }));
vi.mock("@/components/signatures/SignatureCeremony", () => ({ default: () => null }));
vi.mock("@/lib/costs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/costs")>();
  return { ...real, listParties: m.listParties };
});
vi.mock("@/lib/companies", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/companies")>();
  return { ...real, getCompany: m.getCompany };
});
vi.mock("@/lib/checklists", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/checklists")>();
  return { ...real, listChecklists: m.listChecklists, loadSignoffAuthority: m.loadSignoffAuthority };
});
vi.mock("@/lib/turnover", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/turnover")>();
  return {
    ...real,
    listTurnoverItems: m.listTurnoverItems, listTurnoverReviewEvents: m.listTurnoverReviewEvents, listPunchItems: m.listPunchItems,
    assignTurnoverContractor: m.assignTurnoverContractor, assignPunchContractor: m.assignPunchContractor,
  };
});

import QualityTab from "@/components/projects/QualityTab";
import type { CostParty } from "@/lib/costs";
import type { TurnoverItem, PunchItem } from "@/lib/turnover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const party = (id: string, name: string, companyId: string | null, status: CostParty["status"] = "active"): CostParty => ({
  id, projectId: "p1", name, kind: "contractor", trade: null, defaultRate: null, contractValue: null,
  contactName: null, contactEmail: null, status, companyId,
});
const turnover = (id: string, name: string, status: TurnoverItem["status"], partyId: string | null = null): TurnoverItem => ({
  id, orgId: "o1", projectId: "p1", partyId, name, description: null, required: true, status, documentId: null,
  reviewedAt: null, reviewedByName: null, reviewNote: null, createdAt: null, createdBy: "someone-else",
});
const punch = (id: string, title: string, status: PunchItem["status"], partyId: string | null = null): PunchItem => ({
  id, orgId: "o1", projectId: "p1", partyId, title, description: null, location: null, status, dueDate: null,
  closedAt: null, closedByName: null, closureNote: null, createdByName: null, createdAt: null,
});

const GULF = party("p-gulf", "Gulf Mechanical", "c1");
const DAY = party("p-day", "Day labour", null);
const OLD = party("p-old", "Old Crew", "c7", "inactive");
const ACCEPTED = turnover("t1", "Torque records", "accepted");
const REJECTED = turnover("t2", "Hydro test pack", "rejected");
const RECEIVED = turnover("t3", "Weld map", "received");
const ACCEPTED_OLD = turnover("t4", "MTRs", "accepted", "p-old");
const WAIVED = turnover("t5", "Vendor manuals", "waived");
const DONE = punch("u1", "Reinstall insulation", "done");
const OPEN_OLD = punch("u2", "Paint touch-up", "open", "p-old");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  for (const f of Object.values(m)) f.mockReset();
  m.listParties.mockResolvedValue([GULF, DAY, OLD]);
  m.getCompany.mockResolvedValue({ id: "c1", name: "Gulf Mechanical Inc." });
  m.listChecklists.mockResolvedValue([]);
  m.loadSignoffAuthority.mockResolvedValue({ maySign: true, otherSigners: 2, source: "database" });
  m.listTurnoverItems.mockResolvedValue([ACCEPTED, REJECTED, RECEIVED, ACCEPTED_OLD, WAIVED]);
  m.listTurnoverReviewEvents.mockResolvedValue([]);
  m.listPunchItems.mockResolvedValue([DONE, OPEN_OLD]);
  m.assignTurnoverContractor.mockResolvedValue({ ok: true });
  m.assignPunchContractor.mockResolvedValue({ ok: true });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function settle() { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function render() {
  await act(async () => {
    root.render(React.createElement(QualityTab, { orgId: "o1", projectId: "p1", canManage: true, uid: "u-me", userEmail: "me@plant.example", jobKind: "small" }));
  });
  await settle();
}
const select = (label: string) => host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement | null;
async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}
/** The "Assign" button beside a select. */
const assignNextTo = (sel: HTMLSelectElement) => [...sel.parentElement!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Assign") as HTMLButtonElement;

describe("MON-7 / COST-12 (J10 third fix) — a decided item's contractor is never written by the pick alone", () => {
  it("accepted turnover with no contractor: choosing writes nothing; Assign asks — naming the item, the contractor, its Known Company and that it is permanent — and writes only on yes", async () => {
    await render();
    const sel = select("Contractor who delivered Torque records")!;
    expect(sel).not.toBeNull();
    // the keystroke case: a change on the closed select
    await choose(sel, "p-gulf");
    expect(m.assignTurnoverContractor).not.toHaveBeenCalled();
    expect(m.appConfirm).not.toHaveBeenCalled();

    const assign = assignNextTo(sel);
    expect(assign.className).toContain("pointer-coarse:min-h-11");   // A11Y-8 floor
    m.appConfirm.mockResolvedValueOnce(false);
    await click(assign);
    expect(m.appConfirm).toHaveBeenCalledTimes(1);
    const ask = m.appConfirm.mock.calls[0][0] as { title: string; message: string; confirmLabel: string };
    expect(ask.title).toBe("Name Gulf Mechanical for “Torque records”?");
    expect(ask.message).toBe("“Torque records” is already accepted. It will count for the Known Company “Gulf Mechanical Inc.” — its acceptance counts toward that company's Quality score. The contractor can't be changed afterwards without reopening the signed acceptance and signing it again.");
    expect(m.getCompany).toHaveBeenCalledWith("c1");
    expect(m.assignTurnoverContractor).not.toHaveBeenCalled();   // declined: nothing written

    m.appConfirm.mockResolvedValueOnce(true);
    await click(assignNextTo(select("Contractor who delivered Torque records")!));
    expect(m.assignTurnoverContractor).toHaveBeenCalledTimes(1);
    expect(m.assignTurnoverContractor).toHaveBeenCalledWith(expect.objectContaining({ item: ACCEPTED, partyId: "p-gulf" }));
  });

  it("an unlinked contractor is said to count for nobody until linked; a waiver is said not to be scored; an unreadable company is still named by its link", async () => {
    await render();
    await choose(select("Contractor who delivered Torque records")!, "p-day");
    m.appConfirm.mockResolvedValueOnce(false);
    await click(assignNextTo(select("Contractor who delivered Torque records")!));
    expect((m.appConfirm.mock.calls[0][0] as { message: string }).message)
      .toContain("Day labour is not linked to a Known Company, so it counts for nobody until the contractor is linked on the Costs tab — then for that company.");

    m.getCompany.mockRejectedValueOnce(new Error("permission denied for table companies"));
    await choose(select("Contractor who delivered Vendor manuals")!, "p-gulf");
    m.appConfirm.mockResolvedValueOnce(false);
    await click(assignNextTo(select("Contractor who delivered Vendor manuals")!));
    const msg = (m.appConfirm.mock.calls[1][0] as { message: string }).message;
    expect(msg).toBe("“Vendor manuals” is already waived. It will count for the Known Company Gulf Mechanical is linked to — a waived item is not scored, but it is theirs on the record. The contractor can't be changed afterwards without reopening the signed waiver and signing it again.");
    expect(msg).not.toMatch(/permission denied|companies/);
    expect(m.assignTurnoverContractor).not.toHaveBeenCalled();
  });

  it("a REJECTED item offers no contractor control (no reopen — a wrong name could never be corrected) and says when it can be named", async () => {
    await render();
    expect(select("Contractor who delivered Hydro test pack")).toBeNull();
    expect(select("Contractor who delivers Hydro test pack")).toBeNull();
    const row = [...host.querySelectorAll("li")].find((li) => li.textContent?.includes("Hydro test pack"))!;
    expect(row.textContent).toContain("no contractor — name one once the resubmission is accepted");
  });

  it("an UNDECIDED item's pick is still its write (it can be changed while undecided)", async () => {
    await render();
    await choose(select("Contractor who delivers Weld map")!, "p-gulf");
    expect(m.appConfirm).not.toHaveBeenCalled();
    expect(m.assignTurnoverContractor).toHaveBeenCalledWith(expect.objectContaining({ item: RECEIVED, partyId: "p-gulf" }));
  });

  it("a closed punch item with no contractor: the pick writes nothing; Assign asks, says it is permanent, and writes on yes", async () => {
    await render();
    const sel = select("Contractor who was responsible for Reinstall insulation")!;
    await choose(sel, "p-gulf");
    expect(m.assignPunchContractor).not.toHaveBeenCalled();
    m.appConfirm.mockResolvedValueOnce(true);
    await click(assignNextTo(sel));
    expect((m.appConfirm.mock.calls[0][0] as { message: string }).message).toBe(
      "“Reinstall insulation” is already closed. It will count for the Known Company “Gulf Mechanical Inc.” — its close-out counts toward that company's Quality score. The contractor can't be changed afterwards.");
    expect(m.assignPunchContractor).toHaveBeenCalledWith(expect.objectContaining({ item: DONE, partyId: "p-gulf" }));
  });
});

describe("MON-7 (J10 third fix) — a contractor set inactive still names the items assigned to it", () => {
  it("a decided item names its inactive contractor; an open row's select shows it (marked) rather than 'No contractor'; the add and seed pickers leave it out", async () => {
    await render();
    const mtrs = [...host.querySelectorAll("li")].find((li) => li.textContent?.includes("MTRs"))!;
    expect(mtrs.textContent).toContain("· Old Crew (inactive)");

    const open = select("Contractor responsible for Paint touch-up")!;
    expect(open.value).toBe("p-old");
    expect(open.selectedOptions[0].textContent).toBe("Old Crew (inactive)");

    for (const label of ["Contractor who delivers it", "Contractor responsible", "Contractor who delivers the seeded items", "Contractor who delivered Torque records"]) {
      const opts = [...select(label)!.options].map((o) => o.textContent);
      expect(opts, label).toContain("Gulf Mechanical");
      expect(opts.join("|"), label).not.toContain("Old Crew");
    }
  });
});

describe("A11Y-8 (J10 third fix) — every Quality-tab button that writes carries the decision-target floor", () => {
  it("rendered: Seed required contents, both Add buttons and Assign are 24 px, 44 px on a coarse pointer", async () => {
    await render();
    const buttons = [...host.querySelectorAll("button")];
    const byText = (t: string) => buttons.filter((b) => b.textContent?.trim() === t);
    for (const b of [...byText("Seed required contents"), ...byText("Add"), ...byText("Assign")]) {
      expect(b.className, b.textContent ?? "").toContain("min-h-6");
      expect(b.className, b.textContent ?? "").toContain("pointer-coarse:min-h-11");
    }
    expect(byText("Add")).toHaveLength(2);
    expect(byText("Assign").length).toBeGreaterThanOrEqual(3);
  });

  it("source census (counted): every button whose click starts a write — read, save, seed, add, assess, sweep, review, waive, reopen, override, close, assign, apply, pick, skip — carries the floor", () => {
    const q = readFileSync(join(process.cwd(), "components/projects/QualityTab.tsx"), "utf8");
    /** Each `<button …>` opening tag, braces balanced. */
    const tags: string[] = [];
    for (let at = q.indexOf("<button"); at >= 0; at = q.indexOf("<button", at + 1)) {
      let depth = 0, i = at;
      for (; i < q.length; i++) {
        if (q[i] === "{") depth++;
        else if (q[i] === "}") depth--;
        else if (q[i] === ">" && depth === 0) break;
      }
      tags.push(q.slice(at, i + 1));
    }
    const WRITES = /onClick=\{(?:\(\) => (?:void )?(?:read|save|seed|addItem|add|assess|sweep|review|startWaive|reopen|override|close|setSigning|setAccepting|onPick)\(|onApply\b|onSkip\b|\(\) => \{ if \(chosen\) onAssign)/;
    const writers = tags.filter((t) => WRITES.test(t));
    const bare = writers.filter((t) => !t.includes("${DECISION_TARGET}"));
    expect(bare).toEqual([]);
    // counted, so a write button added without the floor fails here
    expect(writers.length).toBeGreaterThanOrEqual(24);
    for (const label of ["void read()", "void save()", "void seed()", "void addItem()", "void add()"]) {
      expect(writers.some((t) => t.includes(label)), label).toBe(true);
    }
  });
});
