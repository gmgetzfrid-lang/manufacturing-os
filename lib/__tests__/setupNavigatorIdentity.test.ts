// @vitest-environment jsdom
//
// intelligence Round G (I-09) — AREA-11 limb 3: the Facility Setup
// navigator's registry stage counts equipment whose site code names another
// unit than its filing (the count the Operating Areas identity review lists,
// planIdentityReview(...).filter(kind === "code_names_other_unit")), beside
// `unitless`. A count that cannot be read is said, never 0.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Codebook } from "@/lib/codebook";

const s = vi.hoisted(() => ({
  identities: [] as Array<Record<string, unknown>>,
  identitiesFail: false,
  book: null as unknown,
}));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ activeOrgId: "o1", uid: "u1" }) }));
vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => {
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ count: 1, error: null });
        return () => new Proxy({}, h);
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: () => chain() } };
});
vi.mock("@/lib/assets", () => ({
  listAssetIdentities: vi.fn(async () => { if (s.identitiesFail) throw new Error("down"); return s.identities; }),
}));
vi.mock("@/lib/codebook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/codebook")>()),
  loadCodebook: vi.fn(async () => s.book),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));

import SetupPage from "@/app/(protected)/setup/page";
import { EMPTY_CODEBOOK } from "@/lib/codebook";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A codebook where unit 25 + type 30 compose site codes "2530.nn" (the
// fixture lib/__tests__/assetCategorize.test.ts uses for AREA-11).
const book = (): Codebook => ({
  ...EMPTY_CODEBOOK,
  units: [
    { id: "u20", kind: "unit", code: "20", label: "Crude Unit", meta: {}, sort: 0, origin: "manual" },
    { id: "u25", kind: "unit", code: "25", label: "DHT", meta: {}, sort: 1, origin: "manual" },
  ],
  equipmentTypes: [
    { id: "t30", kind: "equipment_type", code: "30", label: "Exchangers", meta: { tagPrefixes: ["E"] }, sort: 0, origin: "manual" },
  ],
} as Codebook);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.identitiesFail = false;
  s.book = book();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const mount = async () => {
  await act(async () => { root.render(React.createElement(SetupPage)); });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
};

describe("AREA-11 — the navigator counts code ↔ filing contradictions", () => {
  it("E-22 filed under Crude (20) with code 2530.22 (DHT) is counted; an agreeing one is not", async () => {
    s.identities = [
      { id: "a1", tag: "E-22", unit_code: "20", code: "2530.22", type_id: null, origin: null, archived: false },
      { id: "a2", tag: "E-23", unit_code: "25", code: "2530.23", type_id: null, origin: null, archived: false },
    ];
    await mount();
    expect(host.textContent).toContain("1 site code names another unit than the filing — reconcile in Operating areas");
  });

  it("an unreadable registry says it could not check — never 'every site code agrees'", async () => {
    s.identitiesFail = true;
    await mount();
    expect(host.textContent).toContain("Site codes vs. filing could not be checked");
    expect(host.textContent).not.toContain("Every site code agrees");
  });
});
