// @vitest-environment jsdom
//
// projects Round G — J10b UI REMAINDERS: projects-tab PERF-4 and PERF-3.
//
// The Costs and Quality tabs called the page's onDataChanged from inside
// their own load (refresh), so every tab MOUNT re-keyed the coach (a second
// snapshot round with no write behind it) — and the only thing keeping that
// callback out of the load effect's dependencies (an unbounded load loop,
// since the page passes a fresh inline arrow on every render) was an
// eslint-disable comment. Now:
//   * the load effect never tells the page anything, and its dependency list
//     is honest (no suppression);
//   * every WRITE still tells the page — after the tab's re-read has landed
//     and after the shared snapshot round is invalidated, so the coach
//     re-gathers from a fresh round;
//   * a read retry re-reads but tells nobody;
//   * rendered as the page renders it (an inline callback that bumps the
//     page's state), the load runs once per mount and once per write — no
//     loop — and opening the tab under the coach costs ONE snapshot round.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const order = vi.hoisted(() => ({ log: [] as string[] }));
const reads = vi.hoisted(() => ({
  listAccounts: vi.fn(), listEntries: vi.fn(), listParties: vi.fn(),
  listCostDocs: vi.fn(), listLedgerOrphans: vi.fn(), listChangeOrders: vi.fn(),
  listChecklists: vi.fn(), loadSignoffAuthority: vi.fn(),
  listTurnoverItems: vi.fn(), listTurnoverReviewEvents: vi.fn(), listPunchItems: vi.fn(),
  assignTurnoverContractor: vi.fn(),
}));
const snap = vi.hoisted(() => ({ gather: vi.fn(), invalidate: vi.fn() }));

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
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn(), deleteFile: vi.fn() }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(), appPrompt: vi.fn() }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ member: { displayName: "Pat" }, activeRole: "Engineer", roles: ["Engineer"] }) }));
vi.mock("@/components/signatures/SignatureCeremony", () => ({ default: () => null }));
// The quotes panel stands in for every write on the Costs tab: its button
// fires the onChanged a real award / read / void fires.
vi.mock("@/components/projects/cost/QuotesPanel", async () => {
  const R = await import("react");
  return {
    default: ({ onChanged }: { onChanged: () => void }) =>
      R.createElement("button", { type: "button", "data-write": "quotes", onClick: onChanged }, "write"),
  };
});
vi.mock("@/components/projects/cost/ChangeOrdersPanel", async () => {
  const R = await import("react");
  return { default: () => R.createElement("div", { "data-panel": "change-orders" }) };
});
vi.mock("@/lib/costs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/costs")>();
  return { ...real, listAccounts: reads.listAccounts, listEntries: reads.listEntries, listParties: reads.listParties };
});
vi.mock("@/lib/costDocs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/costDocs")>();
  return { ...real, listCostDocs: reads.listCostDocs, listLedgerOrphans: reads.listLedgerOrphans };
});
vi.mock("@/lib/changeOrders", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/changeOrders")>();
  return { ...real, listChangeOrders: reads.listChangeOrders };
});
vi.mock("@/lib/checklists", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/checklists")>();
  return { ...real, listChecklists: reads.listChecklists, loadSignoffAuthority: reads.loadSignoffAuthority };
});
vi.mock("@/lib/turnover", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/turnover")>();
  return {
    ...real,
    listTurnoverItems: reads.listTurnoverItems, listTurnoverReviewEvents: reads.listTurnoverReviewEvents, listPunchItems: reads.listPunchItems,
    assignTurnoverContractor: reads.assignTurnoverContractor,
  };
});
vi.mock("@/lib/projectSnapshot", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/projectSnapshot")>();
  return { ...real, gatherProjectSnapshot: snap.gather, invalidateProjectSnapshot: snap.invalidate };
});
// The coach's engine is not under test: any snapshot renders a strip.
vi.mock("@/lib/projectHealth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/projectHealth")>();
  return { ...real, computeProjectHealth: () => ({ score: 80, trend: "steady", parts: [] }), buildCoachItems: () => [] };
});

import CostsTab from "@/components/projects/CostsTab";
import QualityTab from "@/components/projects/QualityTab";
import ProjectCoach from "@/components/projects/ProjectCoach";
import type { CostParty } from "@/lib/costs";
import type { TurnoverItem } from "@/lib/turnover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const GULF: CostParty = {
  id: "p-gulf", projectId: "p1", name: "Gulf Mechanical", kind: "contractor", trade: null, defaultRate: null, contractValue: null,
  contactName: null, contactEmail: null, status: "active", companyId: null,
};
const WELD: TurnoverItem = {
  id: "t3", orgId: "o1", projectId: "p1", partyId: null, name: "Weld map", description: null, required: true, status: "received", documentId: null,
  reviewedAt: null, reviewedByName: null, reviewNote: null, createdAt: null, createdBy: "someone-else",
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  order.log = [];
  for (const f of [...Object.values(reads), ...Object.values(snap)]) f.mockReset();
  reads.listAccounts.mockImplementation(async () => { order.log.push("costs-read"); return []; });
  reads.listEntries.mockResolvedValue([]);
  reads.listParties.mockResolvedValue([GULF]);
  reads.listCostDocs.mockResolvedValue([]);
  reads.listLedgerOrphans.mockResolvedValue({ available: false, docs: [], changeOrders: [] });
  reads.listChangeOrders.mockResolvedValue([]);
  reads.listChecklists.mockImplementation(async () => { order.log.push("quality-read"); return []; });
  reads.loadSignoffAuthority.mockResolvedValue({ maySign: true, otherSigners: 2, source: "database" });
  reads.listTurnoverItems.mockResolvedValue([WELD]);
  reads.listTurnoverReviewEvents.mockResolvedValue([]);
  reads.listPunchItems.mockResolvedValue([]);
  reads.assignTurnoverContractor.mockResolvedValue({ ok: true });
  snap.invalidate.mockImplementation(() => { order.log.push("invalidate"); });
  snap.gather.mockImplementation(async () => { order.log.push("gather"); return { readFailures: [], notMigrated: [] }; });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const count = (what: string) => order.log.filter((x) => x === what).length;

/** The page as it renders a tab: an INLINE onDataChanged (a new identity on
 *  every render) that bumps the page's own state, the coach keyed on it,
 *  and a page state the test can bump to force a re-render with nothing
 *  else changed. */
const pageCtl = { bump: () => undefined as void };
function Page({ tab, coach }: { tab: "costs" | "quality"; coach: boolean }) {
  const [coachKey, setCoachKey] = useState(0);
  const [, setNoise] = useState(0);
  useEffect(() => { pageCtl.bump = () => setNoise((n) => n + 1); }, []);
  return React.createElement("div", null,
    React.createElement("span", { "data-coach-key": coachKey }),
    coach ? React.createElement(ProjectCoach, { orgId: "o1", projectId: "p1", refreshKey: coachKey }) : null,
    tab === "costs"
      ? React.createElement(CostsTab, { orgId: "o1", projectId: "p1", canManage: true, uid: "u1", onDataChanged: () => { order.log.push("told"); setCoachKey((k) => k + 1); } })
      : React.createElement(QualityTab, { orgId: "o1", projectId: "p1", canManage: true, uid: "u1", jobKind: "small", onDataChanged: () => { order.log.push("told"); setCoachKey((k) => k + 1); } }),
  );
}
const coachKey = () => Number(host.querySelector("[data-coach-key]")!.getAttribute("data-coach-key"));
async function open(tab: "costs" | "quality", coach = false) {
  await act(async () => { root.render(React.createElement(Page, { tab, coach })); });
  await settle();
}

describe("PERF-4 — the Costs tab: the page is told after every write, never by the load", () => {
  it("mount re-reads once and tells the page nothing; a write re-reads, invalidates the snapshot round, THEN tells the page — once", async () => {
    await open("costs");
    expect(count("costs-read")).toBe(1);
    expect(count("told")).toBe(0);
    expect(coachKey()).toBe(0);

    await act(async () => { (host.querySelector("[data-write]") as HTMLButtonElement).click(); });
    await settle();
    expect(order.log).toEqual(["costs-read", "costs-read", "invalidate", "told"]);
    expect(snap.invalidate).toHaveBeenCalledWith("o1", "p1");
    expect(coachKey()).toBe(1);
  });

  it("no loop: the page's fresh inline callback on every render never re-fires the load", async () => {
    await open("costs");
    for (let i = 0; i < 5; i++) { await act(async () => { pageCtl.bump(); }); }
    await settle();
    expect(count("costs-read")).toBe(1);
    // a write: one more read, one tell — and the page's re-render (the coach
    // key bump, a new callback identity) starts no further read
    await act(async () => { (host.querySelector("[data-write]") as HTMLButtonElement).click(); });
    await settle();
    for (let i = 0; i < 5; i++) { await act(async () => { pageCtl.bump(); }); }
    await settle();
    expect(count("costs-read")).toBe(2);
    expect(count("told")).toBe(1);
  });

  it("a read retry ('Try again' after a failed first load) re-reads and tells the page nothing", async () => {
    reads.listAccounts.mockImplementationOnce(async () => { order.log.push("costs-read"); throw new Error("canceling statement due to statement timeout"); });
    await open("costs");
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Try again") as HTMLButtonElement;
    expect(retry).toBeTruthy();
    await act(async () => { retry.click(); });
    await settle();
    expect(count("costs-read")).toBe(2);
    expect(count("told")).toBe(0);
    expect(snap.invalidate).not.toHaveBeenCalled();
  });
});

describe("PERF-4 — the Quality tab: the page is told after every write, never by the load", () => {
  it("mount tells the page nothing; a write (Assign on an undecided item) re-reads, invalidates, then tells the page once; no loop", async () => {
    await open("quality");
    expect(count("quality-read")).toBe(1);
    expect(count("told")).toBe(0);
    for (let i = 0; i < 5; i++) { await act(async () => { pageCtl.bump(); }); }
    await settle();
    expect(count("quality-read")).toBe(1);

    const sel = host.querySelector('select[aria-label="Contractor who delivers Weld map"]') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, "p-gulf");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    const assign = [...sel.parentElement!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Assign") as HTMLButtonElement;
    await act(async () => { assign.click(); });
    await settle();
    expect(reads.assignTurnoverContractor).toHaveBeenCalledTimes(1);
    expect(order.log).toEqual(["quality-read", "quality-read", "invalidate", "told"]);
    for (let i = 0; i < 5; i++) { await act(async () => { pageCtl.bump(); }); }
    await settle();
    expect(count("quality-read")).toBe(2);
    expect(count("told")).toBe(1);
  });

  it("a section's Retry after a failed read re-reads and tells the page nothing", async () => {
    reads.listChecklists.mockImplementationOnce(async () => { order.log.push("quality-read"); throw new Error("Couldn't load the checklists: timeout"); });
    await open("quality");
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry") as HTMLButtonElement;
    expect(retry).toBeTruthy();
    await act(async () => { retry.click(); });
    await settle();
    expect(count("quality-read")).toBe(2);
    expect(count("told")).toBe(0);
  });
});

describe("PERF-3 — opening Costs or Quality under the coach gathers the snapshot ONCE", () => {
  for (const tab of ["costs", "quality"] as const) {
    it(`${tab}: one gather on open (the coach's own mount round — the tab's mount bumps nothing); a write costs one more, after the invalidation`, async () => {
      await open(tab, true);
      expect(count("gather")).toBe(1);
      expect(coachKey()).toBe(0);
      if (tab === "costs") {
        await act(async () => { (host.querySelector("[data-write]") as HTMLButtonElement).click(); });
      } else {
        const sel = host.querySelector('select[aria-label="Contractor who delivers Weld map"]') as HTMLSelectElement;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, "p-gulf");
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await settle();
        const assign = [...sel.parentElement!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Assign") as HTMLButtonElement;
        await act(async () => { assign.click(); });
      }
      await settle();
      expect(count("gather")).toBe(2);
      const log = order.log.filter((x) => x === "gather" || x === "invalidate" || x === "told");
      expect(log).toEqual(["gather", "invalidate", "told", "gather"]);
    });
  }
});

// Review (fix pass): the rendered tests above drive ONE Costs writer (the
// quotes panel stands in for all of them). This census pins the rest at the
// source: every writer prop the tab hands down is afterWrite (the re-read,
// the invalidation, the tell), and the only bare re-read left is the "Try
// again" read retry — so reverting, say, onMoneyMoved to a plain refresh
// fails here, not silently in the coach.
/** Every opening tag of a JSX element `<Name …>`, braces balanced. */
function jsxTags(s: string, name: string): string[] {
  const tags: string[] = [];
  const opener = new RegExp(`<${name}[\\s>]`, "g");
  for (let m = opener.exec(s); m; m = opener.exec(s)) {
    let depth = 0, i = m.index;
    for (; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}") depth--;
      else if (s[i] === ">" && depth === 0) break;
    }
    tags.push(s.slice(m.index, i + 1).replace(/\s+/g, " "));
  }
  return tags;
}

describe("PERF-4 — source: every Costs-tab writer is handed afterWrite; the only bare re-read is the read retry", () => {
  const s = src("components/projects/CostsTab.tsx");
  const WIRING: Array<[string, string[]]> = [
    ["QuotesPanel", ["onChanged={afterWrite}"]],
    ["ChangeOrdersPanel", ["onMoneyMoved={afterWrite}"]],
    ["LedgerHealth", ["onChanged={afterWrite}", "onCoRepaired={() => { setCoReload((n) => n + 1); afterWrite(); }}"]],
    ["AccountForm", ["onDone={() => { setShowNewAccount(false); afterWrite(); }}"]],
    ["AccountDetail", ["onChanged={afterWrite}"]],
    ["PartiesPanel", ["onChanged={afterWrite}"]],
    // inside AccountDetail: the entry form's write reaches AccountDetail's onChanged (= afterWrite above)
    ["EntryForm", ["onDone={onChanged}"]],
  ];
  for (const [name, props] of WIRING) {
    it(`<${name}> is rendered once and its writer prop${props.length > 1 ? "s reach" : " reaches"} afterWrite`, () => {
      const tags = jsxTags(s, name);
      expect(tags, name).toHaveLength(1);
      for (const p of props) expect(tags[0], `${name} ${p}`).toContain(` ${p}`);
    });
  }

  it("refresh() is called in exactly three places: the mount load, inside afterWrite, and the 'Try again' read retry", () => {
    const calls = [...s.matchAll(/\brefresh\(\)/g)].map((m) => s.slice(s.lastIndexOf("\n", m.index) + 1, s.indexOf("\n", m.index)).trim());
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe("useEffect(() => { void refresh(); }, [refresh]);");
    expect(calls[1]).toBe("void refresh().then(() => {");
    expect(calls[2]).toMatch(/^<button type="button" onClick=\{\(\) => void refresh\(\)\} [^>]*>Try again<\/button>$/);
    // and afterWrite is what every writer above names — no writer re-reads on its own
    expect((s.match(/afterWrite/g) ?? []).length).toBe(1 + 7);   // the declaration + the seven writer props
  });
});

describe("PERF-4 — source: no suppression left over either tab's load", () => {
  for (const f of ["components/projects/CostsTab.tsx", "components/projects/QualityTab.tsx"]) {
    it(`${f}: no react-hooks eslint-disable, onDataChanged only inside afterWrite`, () => {
      const s = src(f);
      expect(s).not.toMatch(/eslint-disable[^\n]*react-hooks/);
      const refresh = s.slice(s.indexOf("const refresh = useCallback("), s.indexOf("useEffect(() => { void refresh(); }, [refresh]);"));
      expect(refresh).not.toContain("onDataChanged");
      const after = s.slice(s.indexOf("const afterWrite = useCallback("), s.indexOf("}, [refresh, orgId, projectId, onDataChanged]);"));
      expect(after).toMatch(/void refresh\(\)\.then\(\(\) => \{\s*invalidateProjectSnapshot\(orgId, projectId\);\s*onDataChanged\?\.\(\);/);
      expect((s.match(/onDataChanged\?\.\(\)/g) ?? []).length).toBe(1);
    });
  }
});
