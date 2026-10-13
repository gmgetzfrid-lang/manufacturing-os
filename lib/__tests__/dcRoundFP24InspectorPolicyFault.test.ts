// @vitest-environment jsdom
//
// document-control Round F wave 3 — P24 review fix: drafting-flow AUTHZ-15,
// the Inspector's share, RENDERED. components/documents/InspectorPanel.tsx
// drew its hold controls (the place-a-first-hold section, the active-hold
// strip's Release) from a null policy on a failed read — `.catch(() =>
// undefined)` — which evaluates the SHIPPED DEFAULTS (holds.open /
// holds.release: everyone). Now a read that cannot give the org's policy —
// `unreadable`, `stale` (the cached copy, refresh failed: the integrator's
// rule for P24, "an affordance drawn from a cache during a database fault
// must fail closed") or a throw — holds them back, says why in the ALERTS
// zone, and Try again re-reads (its own read and the Force Release hook's).
// REGRESSION: a healthy read draws what it drew before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  entry: null as unknown,
  entryCalls: 0,
  forceArgs: [] as unknown[][],
  forceFault: false,
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
  return { supabase: { from: () => chain(), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/lib/staleCopies", () => ({ getDocumentRecall: vi.fn(async () => ({ holders: [], capped: false, unavailable: false })) }));
vi.mock("@/lib/holds", () => ({ listActiveHoldsForDocument: vi.fn(async () => []) }));
vi.mock("@/lib/transmittals", () => ({ listTransmittalsForDocument: vi.fn(async () => []) }));
vi.mock("@/lib/branches", () => ({ listOpenBranchesForDocument: vi.fn(async () => []) }));
vi.mock("@/lib/ownership", () => ({ effectiveOwnerForDocument: vi.fn(async () => ({ userId: null })), requestDeletion: vi.fn() }));
vi.mock("@/lib/capabilityPolicy", async (orig) => ({
  ...(await orig<typeof import("@/lib/capabilityPolicy")>()),
  loadCapabilityPolicyEntry: vi.fn(async () => {
    s.entryCalls++;
    if (s.entry instanceof Error) throw s.entry;
    return s.entry;
  }),
}));
vi.mock("@/lib/documentGuards", () => ({ isDocumentCheckedOut: () => false }));
vi.mock("@/lib/documentTags", () => ({ collectTagGroups: () => [] }));
vi.mock("@/lib/evidencePack", () => ({ openEvidencePack: vi.fn() }));
vi.mock("@/lib/audit", () => ({}));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: vi.fn(), appPrompt: vi.fn() }));
vi.mock("next/link", () => ({ default: (p: { children?: React.ReactNode }) => React.createElement("a", null, p.children) }));
// The panel's children are not under test.
vi.mock("@/components/viewers/SecureDocViewer", () => ({ default: () => null }));
vi.mock("@/components/documents/CheckoutStatusCell", () => ({
  default: () => null,
  // records each call's retry key; answers as the real hook would on a healthy read for a DocCtrl
  useForceReleaseAllowed: (...a: unknown[]) => { s.forceArgs.push(a); return !s.forceFault; },
}));
vi.mock("@/components/documents/VersionHistoryPanel", () => ({ default: () => null }));
vi.mock("@/components/documents/HoldStrip", () => ({
  default: (p: { canEdit?: boolean }) => React.createElement("div", { "data-testid": "holdstrip", "data-canedit": String(!!p.canEdit) }),
}));
vi.mock("@/components/ui/WatchButton", () => ({ default: () => null }));
vi.mock("@/components/notes/QuickNoteComposer", () => ({ default: () => null }));
vi.mock("@/components/ui/PresenceIndicator", () => ({ default: () => null }));
vi.mock("@/components/documents/ShareLinkModal", () => ({ default: () => null }));
vi.mock("@/components/documents/lifecycle/ModifyDocumentRouter", () => ({ default: () => null }));
vi.mock("@/components/documents/ImpactPanel", () => ({ default: () => null }));
vi.mock("@/components/documents/RelatedPanel", () => ({ default: () => null }));
vi.mock("@/components/documents/AiBoundaryChip", () => ({ default: () => null }));
vi.mock("@/components/documents/DistributionRecall", () => ({ default: () => null }));
vi.mock("@/components/documents/DistributionAcks", () => ({ default: () => null }));
vi.mock("@/components/ui/HelpTooltip", () => ({ default: () => null }));
vi.mock("@/components/assets/EquipmentTagsStrip", () => ({ default: () => null }));
vi.mock("@/components/documents/ReviewSection", () => ({ default: () => null }));
vi.mock("@/components/documents/AckSection", () => ({ default: () => null }));
vi.mock("@/components/documents/ReviewGateSection", () => ({ default: () => null }));
vi.mock("@/components/documents/RetentionSection", () => ({ default: () => null }));
vi.mock("@/components/documents/OriginSection", () => ({ default: () => null }));
vi.mock("@/components/documents/EffectivePill", () => ({ default: () => null }));
vi.mock("@/components/documents/ReviewPill", () => ({ default: () => null }));
vi.mock("@/components/documents/RetentionPill", () => ({ default: () => null }));
vi.mock("@/components/documents/OriginBadge", () => ({ default: () => null }));
// only the place-a-first-hold section is under test
vi.mock("@/components/ui/CollapsibleSection", () => ({
  default: (p: { id?: string; children?: React.ReactNode }) => (p.id === "placehold" ? React.createElement("section", { "data-testid": "placehold" }, p.children) : null),
}));
vi.mock("@/components/documents/DocClassControl", () => ({ default: () => null }));
vi.mock("@/components/documents/AddToPackageButton", () => ({ default: () => null }));
vi.mock("@/components/documents/CheckoutHistoryPanel", () => ({ default: () => null }));
vi.mock("@/components/documents/MarkupsSection", () => ({ default: () => null }));
vi.mock("@/components/documents/CompareRevisionsModal", () => ({ default: () => null }));

import InspectorPanel from "@/components/documents/InspectorPanel";
import type { DocumentRecord } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  s.entryCalls = 0;
  s.forceArgs = [];
  s.forceFault = false;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const doc = { id: "d1", orgId: "org1", libraryId: "lib1", documentNumber: "D1", title: "Doc d1", name: "d1.pdf", rev: "C", status: "Issued", currentVersionId: "d1-v3" } as unknown as DocumentRecord;
async function render(role = "Drafter") {
  const noop = () => {};
  await act(async () => {
    root.render(React.createElement(InspectorPanel, {
      selectedDoc: doc, selectedVersion: null, activeRole: role, activeRoles: [role], uid: "u1", userEmail: "u1@x.io",
      onClose: noop, onMetadata: noop, onHistory: noop, onMove: noop, onPermissions: noop, onDelete: noop,
      onCheckout: noop, onFullScreen: noop, orgId: "org1",
    }));
  });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const fault = () => host.querySelector('[data-testid="inspector-policy-fault"]');
const placeHold = () => host.querySelector('[data-testid="placehold"]');
const tryAgain = () => Array.from(host.querySelectorAll("button")).find((b) => /Try again/.test(b.textContent ?? ""));

describe("AUTHZ-15 (Inspector, rendered) — a policy that cannot be read holds the hold controls back and says why", () => {
  for (const [name, entry] of [
    ["unreadable (no last good entry)", { policy: {}, version: null, unreadable: "connection refused" }],
    ["stale (the cached copy, refresh failed)", { policy: {}, version: "v1", stale: true, staleError: "timeout" }],
    ["a read that throws", new Error("network down")],
  ] as const) {
    it(`${name}: no place-a-first-hold section for a Drafter the shipped defaults admit, and the alert names the fault`, async () => {
      s.entry = entry;
      await render();
      expect(fault()).not.toBeNull();
      expect(fault()!.getAttribute("role")).toBe("alert");
      expect(fault()!.textContent).toContain("Permissions could not be read — placing or releasing a hold and force-releasing a checkout are not offered until they can be.");
      expect(placeHold()).toBeNull();
    });
  }
  it("Try again re-reads the policy AND re-keys the Force Release hook; once readable the section is back and the alert gone", async () => {
    s.entry = { policy: {}, version: null, unreadable: "connection refused" };
    await render();
    const calls = s.entryCalls;
    const lastKey = () => s.forceArgs[s.forceArgs.length - 1][4];
    expect(lastKey()).toBe(0);
    s.entry = { policy: {}, version: null };
    await act(async () => { tryAgain()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(s.entryCalls).toBe(calls + 1);
    expect(lastKey()).toBe(1);
    expect(fault()).toBeNull();
    expect(placeHold()).not.toBeNull();
  });
  it("REGRESSION: a healthy read draws the place-a-first-hold section under the defaults, with no alert; a narrowed policy hides it, still with no alert", async () => {
    s.entry = { policy: {}, version: null };
    await render();
    expect(fault()).toBeNull();
    expect(placeHold()).not.toBeNull();
    expect(host.querySelector('[data-testid="holdstrip"]')?.getAttribute("data-canedit")).toBe("true");
    act(() => root.unmount());
    root = createRoot(host);
    s.entry = { policy: { caps: { "holds.open": ["DocCtrl"] } }, version: "v1" };
    await render();
    expect(fault()).toBeNull();
    expect(placeHold()).toBeNull();
  });
});
