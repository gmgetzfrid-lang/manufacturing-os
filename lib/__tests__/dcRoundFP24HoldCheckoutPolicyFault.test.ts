// @vitest-environment jsdom
//
// document-control Round F wave 3 — P24: drafting-flow AUTHZ-15, the REST of
// document-control's surfaces (the integrator names P24 their owner, DEC-31),
// RENDERED. Each surface drew its controls from the shipped defaults during
// a policy-read fault (`loadCapabilityPolicy` → `{}` with no marker;
// `.catch(() => setPolicy({}))` / `.catch(() => undefined)` with a null
// policy that evaluates the defaults):
//   - components/documents/HoldStrip.tsx — Place hold / Release / Re-date;
//   - app/(protected)/admin/holds/page.tsx — Release / Re-date;
//   - components/documents/CheckoutStatusCell.tsx — Admin Force Release.
// (The Inspector is dcRoundFP24InspectorPolicyFault.)
// The integrator's ruling of 2026-10-13 (DEC-89; AUTHZ-15): `unreadable` (no
// last good entry) and a read that throws hold the controls back, and the
// surface says why with a Try again; `stale` (the last good policy, served
// because the refresh failed) is drawn as is, with no label. REGRESSION: a
// healthy read draws exactly what it drew before (the defaults for an
// unconfigured org; a narrowed policy hides what it narrows), for every role.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  entry: null as unknown,
  entryCalls: 0,
  holds: [] as Array<Record<string, unknown>>,
  roles: ["Drafter"] as string[],
  role: "Drafter",
}));

vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => {
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], error: null, count: 0 });
        return () => new Proxy(c, h);
      },
    };
    return new Proxy(c, h);
  };
  return {
    supabase: {
      from: () => chain(),
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel: () => undefined,
      auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null } }) },
    },
  };
});
vi.mock("@/lib/capabilityPolicy", async (orig) => ({
  ...(await orig<typeof import("@/lib/capabilityPolicy")>()),
  loadCapabilityPolicyEntry: vi.fn(async () => {
    s.entryCalls++;
    if (s.entry instanceof Error) throw s.entry;
    return s.entry;
  }),
}));
vi.mock("@/lib/holds", async (orig) => ({
  ...(await orig<typeof import("@/lib/holds")>()),
  listActiveHoldsForDocument: vi.fn(async () => s.holds),
  listActiveHoldsForOrg: vi.fn(async () => s.holds),
  getHoldMetrics: vi.fn(async () => ({ activeCount: s.holds.length, longestActiveDays: 0, avgClosedDurationDays: 0, openedLast7Days: 0, releasedLast7Days: 0, activeByReason: [] })),
}));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "org-a", activeRole: s.role, roles: s.roles, uid: "u-1", userEmail: "u1@a" }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: vi.fn(), appPrompt: vi.fn(async () => null), appConfirm: vi.fn(async () => false) }));
vi.mock("@/components/ui/HelpTooltip", () => ({ default: () => null }));
vi.mock("@/components/ui/IsoGuidance", () => ({ default: () => null }));
vi.mock("@/components/navigation/ViewTabs", () => ({ default: () => null, DOCUMENT_VIEWS: [] }));
vi.mock("next/link", () => ({ default: (p: { children?: React.ReactNode }) => React.createElement("a", null, p.children) }));

import HoldStrip from "@/components/documents/HoldStrip";
import HoldsPage from "@/app/(protected)/admin/holds/page";
import CheckoutStatusCell from "@/components/documents/CheckoutStatusCell";
import { affordancePolicyFault } from "@/lib/checkoutAffordances";
import type { DocumentRecord } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOLD = {
  id: "h1", orgId: "org-a", documentId: "d1", reason: "Client Review", notes: null, expectedReleaseAt: null,
  openedBy: "u-2", openedByName: "Someone", openedAt: "2026-10-01T00:00:00Z", releasedAt: null,
  heldRevLabel: "B", heldVersionId: "v1",
};
const NARROWED = { caps: { "holds.open": ["DocCtrl"], "holds.release": ["DocCtrl"], "checkout.force_release": ["Admin"] } };
// An org that stored holds.release '*' (the shipped default until drafting-flow
// HAND-2 / 20261239 narrowed it to Admin and DocCtrl) — the read-health cases
// below need a policy under which the Drafter is offered every control.
const WIDE = { caps: { "holds.release": ["*"] } };
const HEALTHY = { policy: WIDE, version: null };
const UNREADABLE = { policy: {}, version: null, unreadable: "connection refused" };
const STALE = { policy: WIDE, version: "v1", stale: true, staleError: "timeout" };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  s.entryCalls = 0;
  s.holds = [HOLD];
  s.role = "Drafter";
  s.roles = ["Drafter"];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(el: React.ReactElement) {
  await act(async () => { root.render(el); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
async function click(b: Element | undefined) {
  expect(b).toBeDefined();
  await act(async () => { b!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
const buttons = () => Array.from(host.querySelectorAll("button"));
const button = (text: RegExp) => buttons().find((b) => text.test(b.textContent ?? "") || text.test(b.getAttribute("title") ?? ""));
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe("affordancePolicyFault — which loadCapabilityPolicyEntry answers hold an affordance back", () => {
  it("unreadable is a fault (with the read error's words); stale (the last good policy) and a good read are not", () => {
    expect(affordancePolicyFault(UNREADABLE)).toBe("connection refused");
    expect(affordancePolicyFault(STALE)).toBeNull();
    expect(affordancePolicyFault({ stale: true })).toBeNull();
    expect(affordancePolicyFault({ policy: NARROWED, version: "v1", stale: true, staleError: "timeout" })).toBeNull();
    expect(affordancePolicyFault({ unreadable: "" })).toBe("the capability policy could not be read");
    expect(affordancePolicyFault(HEALTHY)).toBeNull();
    expect(affordancePolicyFault({ policy: NARROWED, version: "v9" })).toBeNull();
  });
});

describe("AUTHZ-15 — HoldStrip (rendered)", () => {
  const strip = (canEdit = true) => React.createElement(HoldStrip, { documentId: "d1", orgId: "org-a", userId: "u-1", userRole: s.role, canEdit });
  it("unreadable: no Place hold, no Release, no Re-date for a member the shipped defaults admit — and the strip says why", async () => {
    s.entry = UNREADABLE;
    await mount(strip());
    expect(host.textContent).toContain("Client Review"); // the hold itself still lists
    expect(byTestId("hold-policy-fault")).not.toBeNull();
    expect(byTestId("hold-policy-fault")!.getAttribute("role")).toBe("alert");
    expect(byTestId("hold-policy-fault")!.textContent).toContain("Permissions could not be read — placing, releasing and re-dating holds are not offered until they can be.");
    expect(button(/^\s*Release\s*$/)).toBeUndefined();
    expect(button(/Re-date/)).toBeUndefined();
    expect(host.textContent).not.toContain("Place hold");
  });
  it("a thrown read is the same fault; Try again re-reads and draws the controls once readable", async () => {
    s.entry = new Error("network down");
    await mount(strip());
    expect(byTestId("hold-policy-fault")).not.toBeNull();
    expect(button(/^\s*Release\s*$/)).toBeUndefined();
    expect(host.textContent).not.toContain("Place hold");
    const calls = s.entryCalls;
    s.entry = HEALTHY;
    await click(button(/Try again/));
    expect(s.entryCalls).toBe(calls + 1);
    expect(byTestId("hold-policy-fault")).toBeNull();
    expect(button(/^\s*Release\s*$/)).toBeDefined();
  });
  it("REGRESSION: a healthy read draws Place hold / Release / Re-date under a wide policy, and a narrowed policy hides them — no notice either way", async () => {
    s.entry = HEALTHY;
    await mount(strip());
    expect(byTestId("hold-policy-fault")).toBeNull();
    expect(button(/^\s*Release\s*$/)).toBeDefined();
    expect(button(/Re-date/)).toBeDefined();
    expect(host.textContent).toContain("Place hold");
    act(() => root.unmount());
    root = createRoot(host);
    s.entry = { policy: NARROWED, version: "v1" };
    await mount(strip());
    expect(byTestId("hold-policy-fault")).toBeNull();
    expect(button(/^\s*Release\s*$/)).toBeUndefined();
    expect(host.textContent).not.toContain("Place hold");
  });
  it("stale (the last good policy, refresh failed) is drawn as is with no notice: the wide policy's controls appear; a stale narrowed copy hides them", async () => {
    s.entry = STALE;
    await mount(strip());
    expect(byTestId("hold-policy-fault")).toBeNull();
    expect(button(/^\s*Release\s*$/)).toBeDefined();
    expect(button(/Re-date/)).toBeDefined();
    expect(host.textContent).toContain("Place hold");
    act(() => root.unmount());
    root = createRoot(host);
    s.entry = { ...STALE, policy: NARROWED };
    await mount(strip());
    expect(byTestId("hold-policy-fault")).toBeNull();
    expect(button(/^\s*Release\s*$/)).toBeUndefined();
    expect(host.textContent).not.toContain("Place hold");
  });
  it("REGRESSION: a DocCtrl under the narrowed policy (which admits DocCtrl) still gets every control, with no notice", async () => {
    s.role = "DocCtrl"; s.roles = ["DocCtrl"];
    s.entry = { policy: NARROWED, version: "v1" };
    await mount(strip());
    expect(byTestId("hold-policy-fault")).toBeNull();
    expect(button(/^\s*Release\s*$/)).toBeDefined();
    expect(host.textContent).toContain("Place hold");
  });
  it("HAND-2: under the shipped defaults a Drafter may place a hold but is offered no Release or Re-date; a DocCtrl is", async () => {
    s.entry = { policy: {}, version: null };
    await mount(strip());
    expect(byTestId("hold-policy-fault")).toBeNull();
    expect(host.textContent).toContain("Place hold");
    expect(button(/^\s*Release\s*$/)).toBeUndefined();
    expect(button(/Re-date/)).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    s.role = "DocCtrl"; s.roles = ["DocCtrl"];
    await mount(strip());
    expect(button(/^\s*Release\s*$/)).toBeDefined();
    expect(button(/Re-date/)).toBeDefined();
  });
  it("a read-only strip (canEdit false) offers nothing, so it explains nothing", async () => {
    s.entry = UNREADABLE;
    await mount(strip(false));
    expect(byTestId("hold-policy-fault")).toBeNull();
    expect(button(/^\s*Release\s*$/)).toBeUndefined();
  });
});

describe("AUTHZ-15 — /admin/holds (rendered)", () => {
  it("unreadable / thrown: no Release or Re-date on the queue, and the page says why", async () => {
    for (const e of [UNREADABLE, new Error("down")]) {
      s.entry = e;
      await mount(React.createElement(HoldsPage));
      expect(host.textContent).toContain("Client Review");
      expect(byTestId("holds-policy-fault")).not.toBeNull();
      expect(byTestId("holds-policy-fault")!.getAttribute("role")).toBe("alert");
      expect(byTestId("holds-policy-fault")!.textContent).toContain("releasing and re-dating holds are not offered until they can be");
      expect(button(/^\s*Release\s*$/)).toBeUndefined();
      expect(button(/Re-date/)).toBeUndefined();
      act(() => root.unmount());
      root = createRoot(host);
    }
  });
  it("Try again re-reads; REGRESSION: a healthy read draws Release / Re-date with no notice, a narrowed one hides them", async () => {
    s.entry = UNREADABLE;
    await mount(React.createElement(HoldsPage));
    s.entry = HEALTHY;
    await click(button(/Try again/));
    expect(byTestId("holds-policy-fault")).toBeNull();
    expect(button(/^\s*Release\s*$/)).toBeDefined();
    expect(button(/Re-date/)).toBeDefined();
    act(() => root.unmount());
    root = createRoot(host);
    s.entry = { policy: NARROWED, version: "v1" };
    await mount(React.createElement(HoldsPage));
    expect(byTestId("holds-policy-fault")).toBeNull();
    expect(button(/^\s*Release\s*$/)).toBeUndefined();
  });
});

describe("AUTHZ-15 — /admin/holds: stale and no-authority (rendered)", () => {
  it("stale (the last good policy) is drawn as is with no notice; a stale narrowed copy hides Release for a Drafter", async () => {
    s.entry = STALE;
    await mount(React.createElement(HoldsPage));
    expect(byTestId("holds-policy-fault")).toBeNull();
    expect(button(/^\s*Release\s*$/)).toBeDefined();
    expect(button(/Re-date/)).toBeDefined();
    act(() => root.unmount());
    root = createRoot(host);
    s.entry = { ...STALE, policy: NARROWED };
    await mount(React.createElement(HoldsPage));
    expect(byTestId("holds-policy-fault")).toBeNull();
    expect(button(/^\s*Release\s*$/)).toBeUndefined();
  });
  it("REGRESSION: under the narrowed policy a DocCtrl keeps Release / Re-date, with no notice", async () => {
    s.role = "DocCtrl"; s.roles = ["DocCtrl"];
    s.entry = { policy: NARROWED, version: "v1" };
    await mount(React.createElement(HoldsPage));
    expect(byTestId("holds-policy-fault")).toBeNull();
    expect(button(/^\s*Release\s*$/)).toBeDefined();
    expect(button(/Re-date/)).toBeDefined();
  });
});

describe("AUTHZ-15 — CheckoutStatusCell's force release (rendered)", () => {
  const doc = { id: "d1", orgId: "org-a", libraryId: "lib1", checkedOutBy: "u-other", checkedOutByName: "Other", activeCollaborators: ["Other"] } as unknown as DocumentRecord;
  const cell = () => React.createElement(CheckoutStatusCell, { docRecord: doc, currentUserId: "u-1", userRole: s.role, userRoles: s.roles, onCheckout: () => undefined });
  const openPopover = async () => {
    // the info button is the one with no text (an icon) beside the pill
    await click(buttons().find((b) => (b.textContent ?? "").trim() === ""));
  };
  it("unreadable: a DocCtrl (whom the shipped defaults admit) is not offered Admin Force Release, and the popover says why", async () => {
    s.role = "DocCtrl"; s.roles = ["DocCtrl"];
    s.entry = UNREADABLE;
    await mount(cell());
    await openPopover();
    expect(byTestId("checkout-policy-fault")).not.toBeNull();
    expect(byTestId("checkout-policy-fault")!.textContent).toContain("Permissions could not be read — force release is not offered until it can be.");
    expect(button(/Admin Force Release/)).toBeUndefined();
  });
  it("a thrown read is the same fault; Try again re-reads and, once readable, offers it", async () => {
    s.role = "DocCtrl"; s.roles = ["DocCtrl"];
    s.entry = new Error("down");
    await mount(cell());
    await openPopover();
    expect(byTestId("checkout-policy-fault")).not.toBeNull();
    expect(button(/Admin Force Release/)).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    s.entry = UNREADABLE;
    await mount(cell());
    await openPopover();
    s.entry = HEALTHY;
    await click(button(/Try again/));
    expect(byTestId("checkout-policy-fault")).toBeNull();
    expect(button(/Admin Force Release/)).toBeDefined();
  });
  it("stale (the last good policy) is evaluated as is with no notice: a DocCtrl is offered it under the defaults' copy, not under a stale narrowed copy", async () => {
    s.role = "DocCtrl"; s.roles = ["DocCtrl"];
    s.entry = STALE;
    await mount(cell());
    await openPopover();
    expect(byTestId("checkout-policy-fault")).toBeNull();
    expect(button(/Admin Force Release/)).toBeDefined();
    act(() => root.unmount());
    root = createRoot(host);
    s.entry = { ...STALE, policy: NARROWED };
    await mount(cell());
    await openPopover();
    expect(byTestId("checkout-policy-fault")).toBeNull();
    expect(button(/Admin Force Release/)).toBeUndefined();
  });
  it("REGRESSION: a healthy read offers a DocCtrl Admin Force Release with no notice; a narrowed policy or a Drafter is not offered it", async () => {
    s.role = "DocCtrl"; s.roles = ["DocCtrl"];
    s.entry = HEALTHY;
    await mount(cell());
    await openPopover();
    expect(byTestId("checkout-policy-fault")).toBeNull();
    expect(button(/Admin Force Release/)).toBeDefined();
    act(() => root.unmount());
    root = createRoot(host);
    s.entry = { policy: NARROWED, version: "v1" };
    await mount(cell());
    await openPopover();
    expect(button(/Admin Force Release/)).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    s.role = "Drafter"; s.roles = ["Drafter"];
    s.entry = HEALTHY;
    await mount(cell());
    await openPopover();
    expect(byTestId("checkout-policy-fault")).toBeNull();
    expect(button(/Admin Force Release/)).toBeUndefined();
  });
});
