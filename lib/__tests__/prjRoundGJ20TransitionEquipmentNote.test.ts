// @vitest-environment jsdom
//
// projects Round G — J20: projects-tab UX-17. TransitionInPanel says
// adoptDocument's `equipmentNote` (lib/transitionIn.ts: the matched
// equipment's links were not recorded, or a pair is still the equipment
// sweep's reading) — after a single adopt, and in its own line after a bulk
// adopt, never folded into the unkeyed count. A result without the note
// renders exactly as before (regression). Review fix pass: when the adopt took
// the last sheet(s) out of intake, the refresh finds the list empty — the
// equipment line stays on screen instead of unmounting with the panel.
//
// Rendered (jsdom); listTransitionCandidates / scanTransitionImpact /
// adoptDocument are mocked, the panel's pure helpers are the real ones.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  adopt: vi.fn(),
  candidates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => {
  const rows: Record<string, unknown[]> = {
    libraries: [{ id: "L1", name: "Controlled", uniqueness_keys: null }],
    collections: [],
  };
  const chain = (t: string): unknown => {
    const h: ProxyHandler<object> = {
      get(_x, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: rows[t] ?? [], error: null });
        return () => new Proxy({}, h);
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/lib/transitionIn", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/transitionIn")>();
  return {
    ...real,
    listTransitionCandidates: vi.fn(async () => s.candidates),
    scanTransitionImpact: vi.fn(async () => ({
      tags: ["FE-201"], matchedAssets: [{ id: "a1", tag: "FE-201" }],
      numberCollision: null, numberCollisions: [], overlapDocs: [], unverifiable: [], clean: true,
    })),
    adoptDocument: (...a: unknown[]) => s.adopt(...a),
  };
});
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeRole: "DocCtrl", roles: ["DocCtrl"], hasAnyRole: (rs: string[]) => rs.includes("DocCtrl") }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true) }));

import TransitionInPanel from "@/components/projects/TransitionInPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EQUIP = "The sheet was adopted, but FE-201 is still the equipment sweep's reading, not your link — Link it from the equipment registry so a later Dismiss of the reading cannot remove it.";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.adopt.mockReset();
  s.candidates = [
    { docId: "d1", label: "P-101", number: "P-101", title: null, rev: "A", status: "Draft", company: "Acme", submittedAt: null },
    { docId: "d2", label: "P-102", number: "P-102", title: null, rev: "A", status: "Draft", company: "Acme", submittedAt: null },
  ];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const tick = () => act(async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); });
const buttons = (label: string) => Array.from(host.querySelectorAll("button")).filter((x) => x.textContent?.trim().endsWith(label));
const click = (b: Element) => act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const status = () => Array.from(host.querySelectorAll('[role="status"]')).map((n) => n.textContent);
const equipLine = () => host.querySelector('[data-testid="transition-equipment-note"]');

async function mount() {
  await act(async () => {
    root.render(React.createElement(TransitionInPanel, { orgId: "o1", projectId: "p1", intakeCollectionId: "c1", canManage: true, uid: "u1", userEmail: "u1@x" }));
  });
  await tick();
  const select = host.querySelector("select") as HTMLSelectElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, "L1");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await tick();
}

async function adoptSingle(label: string) {
  const row = Array.from(host.querySelectorAll("li")).find((li) => li.textContent?.includes(label))!;
  await click(row.querySelector("button")!); // expand
  await tick();
  const adopt = Array.from(row.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Adopt")!;
  await click(adopt);
  await tick();
}

describe("projects-tab UX-17 (J20) — transition-in says when the adopted sheet's equipment links need attention", () => {
  it("a single adopt whose result carries equipmentNote shows it, after the adopt sentence, in its own line", async () => {
    s.adopt.mockResolvedValue({ ok: true, equipmentNote: EQUIP });
    await mount();
    await adoptSingle("P-101");
    expect(s.adopt).toHaveBeenCalledTimes(1);
    expect(status()).toEqual(["P-101 adopted into the controlled register.", EQUIP]);
    expect(equipLine()?.textContent).toBe(EQUIP);
  });

  it("a single adopt with a uniqueness note AND an equipment note says both, the note first as before", async () => {
    s.adopt.mockResolvedValue({ ok: true, note: "P-101 was adopted without a uniqueness key.", equipmentNote: EQUIP });
    await mount();
    await adoptSingle("P-101");
    expect(status()).toEqual(["P-101 was adopted without a uniqueness key.", EQUIP]);
  });

  it("regression: a single adopt without the note renders exactly as before (one status line, no equipment line)", async () => {
    s.adopt.mockResolvedValue({ ok: true });
    await mount();
    await adoptSingle("P-101");
    expect(status()).toEqual(["P-101 adopted into the controlled register."]);
    expect(equipLine()).toBeNull();
  });

  it("a bulk adopt names the sheets whose equipment links need attention, apart from the unkeyed list", async () => {
    s.adopt.mockImplementation(async (input: { docId: string }) => input.docId === "d1"
      ? { ok: true, equipmentNote: EQUIP }
      : { ok: true, note: "unkeyed" });
    await mount();
    await click(buttons("Adopt 2 clean")[0]);
    await tick();
    expect(s.adopt).toHaveBeenCalledTimes(2);
    const [first, second] = status();
    expect(first).toContain("Adopted 2 clean documents into the controlled register.");
    expect(first).toContain("1 adopted without a uniqueness key");
    expect(first).toContain(": P-102.");
    expect(first).not.toContain("P-101");
    expect(second).toBe("1 adopted sheet's equipment links need attention — they were not recorded, or are still the equipment sweep's reading rather than your link. Open each sheet's tags in the equipment registry and Link them: P-101.");
  });

  it("regression: a bulk adopt with no equipment note renders exactly as before", async () => {
    s.adopt.mockResolvedValue({ ok: true });
    await mount();
    await click(buttons("Adopt 2 clean")[0]);
    await tick();
    expect(status()).toEqual(["Adopted 2 clean documents into the controlled register. "]);
    expect(equipLine()).toBeNull();
  });

  it("review fix pass: a single adopt of the LAST sheet in intake keeps its equipment line on screen — the refresh finds intake empty, and the panel stays with the outcome alone", async () => {
    s.candidates = [s.candidates[0]];
    s.adopt.mockImplementation(async () => { s.candidates = []; return { ok: true, equipmentNote: EQUIP }; });
    await mount();
    await adoptSingle("P-101");
    expect(s.adopt).toHaveBeenCalledTimes(1);
    // the refresh ran: no sheet is listed and no adopt control is left
    expect(host.querySelectorAll("li")).toHaveLength(0);
    expect(host.querySelector("select")).toBeNull();
    expect(buttons("Adopt")).toEqual([]);
    expect(host.textContent).toContain("nothing left in intake");
    expect(status()).toEqual(["P-101 adopted into the controlled register.", EQUIP]);
    expect(equipLine()?.textContent).toBe(EQUIP);
    expect(equipLine()?.closest('[aria-live="polite"]')).not.toBeNull();
  });

  it("review fix pass: a bulk adopt that empties intake keeps the line naming the sheets whose equipment links need attention", async () => {
    s.adopt.mockImplementation(async (input: { docId: string }) => {
      s.candidates = s.candidates.filter((c) => c.docId !== input.docId);
      return input.docId === "d1" ? { ok: true, equipmentNote: EQUIP } : { ok: true, note: "unkeyed" };
    });
    await mount();
    await click(buttons("Adopt 2 clean")[0]);
    await tick();
    expect(s.adopt).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll("li")).toHaveLength(0);
    expect(host.textContent).toContain("nothing left in intake");
    const [first, second] = status();
    expect(first).toContain("Adopted 2 clean documents into the controlled register.");
    expect(first).toContain("1 adopted without a uniqueness key");
    expect(second).toBe("1 adopted sheet's equipment links need attention — they were not recorded, or are still the equipment sweep's reading rather than your link. Open each sheet's tags in the equipment registry and Link them: P-101.");
    expect(equipLine()?.textContent).toBe(second);
  });

  it("regression: the last sheet adopted WITHOUT an equipment note — the panel steps out of the way as before (nothing rendered), single and bulk", async () => {
    s.candidates = [s.candidates[0]];
    s.adopt.mockImplementation(async () => { s.candidates = []; return { ok: true }; });
    await mount();
    await adoptSingle("P-101");
    expect(s.adopt).toHaveBeenCalledTimes(1);
    expect(host.innerHTML).toBe("");
    act(() => root.unmount());
    root = createRoot(host);
    s.adopt.mockReset();
    s.candidates = [
      { docId: "d1", label: "P-101", number: "P-101", title: null, rev: "A", status: "Draft", company: "Acme", submittedAt: null },
      { docId: "d2", label: "P-102", number: "P-102", title: null, rev: "A", status: "Draft", company: "Acme", submittedAt: null },
    ];
    s.adopt.mockImplementation(async (input: { docId: string }) => { s.candidates = s.candidates.filter((c) => c.docId !== input.docId); return { ok: true, note: "unkeyed" }; });
    await mount();
    await click(buttons("Adopt 2 clean")[0]);
    await tick();
    expect(s.adopt).toHaveBeenCalledTimes(2);
    expect(host.innerHTML).toBe("");
  });

  it("regression: an intake with nothing in it renders nothing", async () => {
    s.candidates = [];
    await act(async () => {
      root.render(React.createElement(TransitionInPanel, { orgId: "o1", projectId: "p1", intakeCollectionId: "c1", canManage: true, uid: "u1", userEmail: "u1@x" }));
    });
    await tick();
    expect(host.innerHTML).toBe("");
  });

  it("the next action clears an earlier equipment line", async () => {
    s.adopt.mockResolvedValueOnce({ ok: true, equipmentNote: EQUIP }).mockResolvedValue({ ok: true });
    await mount();
    await adoptSingle("P-101");
    expect(equipLine()).not.toBeNull();
    await adoptSingle("P-102");
    expect(equipLine()).toBeNull();
  });
});
