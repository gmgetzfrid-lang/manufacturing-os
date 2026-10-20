// @vitest-environment jsdom
//
// document-control Round F wave 3 — P24: drafting-flow AUTHZ-15, the
// Inspector's share, RENDERED. components/documents/InspectorPanel.tsx drew
// its hold controls (the place-a-first-hold section, the active-hold strip's
// Release) and Force Release Lock from a null policy on a failed read —
// `.catch(() => undefined)` — which evaluates the SHIPPED DEFAULTS
// (holds.open / holds.release: everyone; checkout.force_release: Admin,
// DocCtrl). Now (the integrator's ruling of 2026-10-13, DEC-89):
//   - `unreadable` (no last good entry) or a read that throws holds all
//     three back, says why in the ALERTS zone, and Try again re-reads;
//   - `stale` (the last good policy, served because the refresh failed) is
//     drawn as is, with no label.
// P24 integrator fix pass (re-review minor): Force Release Lock read a
// SECOND policy load (useForceReleaseAllowed) whose fault the notice never
// saw, so a fault in that read hid the button with nothing on screen. The
// panel now decides the button, the hold controls and the notice from ONE
// read. REGRESSION: a healthy read draws what it drew before, for every role.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  entry: null as unknown,
  /** when set, successive reads answer these in turn (then `entry`) */
  queue: [] as unknown[],
  entryCalls: 0,
  checkedOut: false,
  /** an active hold on the document: the ALERTS zone's strip (canEdit = holds.release) is drawn instead of the place-a-first-hold section */
  activeHold: false,
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
vi.mock("@/lib/holds", () => ({ listActiveHoldsForDocument: vi.fn(async () => (s.activeHold ? [{ id: "h1" }] : [])) }));
vi.mock("@/lib/transmittals", () => ({ listTransmittalsForDocument: vi.fn(async () => ({ transmittals: [], withheld: false })) }));
vi.mock("@/lib/branches", () => ({ listOpenBranchesForDocument: vi.fn(async () => []) }));
vi.mock("@/lib/ownership", () => ({ effectiveOwnerForDocument: vi.fn(async () => ({ userId: null })), requestDeletion: vi.fn() }));
vi.mock("@/lib/capabilityPolicy", async (orig) => ({
  ...(await orig<typeof import("@/lib/capabilityPolicy")>()),
  loadCapabilityPolicyEntry: vi.fn(async () => {
    s.entryCalls++;
    const e = s.queue.length > 0 ? s.queue.shift() : s.entry;
    if (e instanceof Error) throw e;
    return e;
  }),
}));
vi.mock("@/lib/documentGuards", () => ({ isDocumentCheckedOut: () => s.checkedOut }));
vi.mock("@/lib/documentTags", () => ({ collectTagGroups: () => [] }));
vi.mock("@/lib/evidencePack", () => ({ openEvidencePack: vi.fn() }));
vi.mock("@/lib/audit", () => ({}));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: vi.fn(), appPrompt: vi.fn() }));
vi.mock("next/link", () => ({ default: (p: { children?: React.ReactNode }) => React.createElement("a", null, p.children) }));
// The panel's children are not under test.
vi.mock("@/components/viewers/SecureDocViewer", () => ({ default: () => null }));
// The cell (its popover has its own read and notice, pinned in
// dcRoundFP24HoldCheckoutPolicyFault) is not under test here.
vi.mock("@/components/documents/CheckoutStatusCell", () => ({ default: () => null }));
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
// only the place-a-first-hold and checkout sections are under test
vi.mock("@/components/ui/CollapsibleSection", () => ({
  default: (p: { id?: string; children?: React.ReactNode }) => (p.id === "placehold" || p.id === "checkout" ? React.createElement("section", { "data-testid": p.id }, p.children) : null),
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
  s.queue = [];
  s.checkedOut = false;
  s.activeHold = false;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const doc = { id: "d1", orgId: "org1", libraryId: "lib1", documentNumber: "D1", title: "Doc d1", name: "d1.pdf", rev: "C", status: "Issued", currentVersionId: "d1-v3", checkedOutBy: "u-other", checkedOutByName: "Other" } as unknown as DocumentRecord;
async function render(role = "Drafter") {
  const noop = () => {};
  await act(async () => {
    root.render(React.createElement(InspectorPanel, {
      selectedDoc: doc, selectedVersion: null, activeRole: role, activeRoles: [role], uid: "u1", userEmail: "u1@x.io",
      onClose: noop, onMetadata: noop, onHistory: noop, onMove: noop, onPermissions: noop, onDelete: noop,
      onCheckout: noop, onFullScreen: noop, onForceUnlock: noop, orgId: "org1",
    }));
  });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function rerender(role: string) {
  act(() => root.unmount());
  root = createRoot(host);
  await render(role);
}
const fault = () => host.querySelector('[data-testid="inspector-policy-fault"]');
const placeHold = () => host.querySelector('[data-testid="placehold"]');
const stripCanEdit = () => host.querySelector('[data-testid="holdstrip"]')?.getAttribute("data-canedit");
const forceRelease = () => Array.from(host.querySelectorAll("button")).find((b) => /Force Release Lock/.test(b.textContent ?? ""));
const tryAgain = () => Array.from(host.querySelectorAll("button")).find((b) => /Try again/.test(b.textContent ?? ""));
const HEALTHY = { policy: {}, version: null };
const UNREADABLE = { policy: {}, version: null, unreadable: "connection refused" };
const NOTICE = "Permissions could not be read — placing or releasing a hold and force-releasing a checkout are not offered until they can be.";

describe("AUTHZ-15 (Inspector, rendered) — an unreadable policy holds the hold controls and Force Release Lock back and says why", () => {
  for (const [name, entry] of [
    ["unreadable (no last good entry)", UNREADABLE],
    ["a read that throws", new Error("network down")],
  ] as const) {
    it(`${name}: no place-a-first-hold section for a Drafter, no Force Release Lock for a DocCtrl (both admitted by the shipped defaults), and the alert names the fault`, async () => {
      s.entry = entry;
      await render();
      expect(fault()).not.toBeNull();
      expect(fault()!.getAttribute("role")).toBe("alert");
      expect(fault()!.textContent).toContain(NOTICE);
      expect(placeHold()).toBeNull();
      s.checkedOut = true;
      s.activeHold = true;
      await rerender("DocCtrl");
      expect(fault()).not.toBeNull();
      expect(forceRelease()).toBeUndefined();
      expect(stripCanEdit()).toBe("false"); // the active hold's Release is held back
    });
  }
  it("Try again re-reads the policy; once readable the section and Force Release Lock are back and the alert is gone", async () => {
    s.checkedOut = true;
    s.entry = UNREADABLE;
    await render("DocCtrl");
    expect(forceRelease()).toBeUndefined();
    const calls = s.entryCalls;
    s.entry = HEALTHY;
    await act(async () => { tryAgain()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(s.entryCalls).toBe(calls + 1);
    expect(fault()).toBeNull();
    expect(forceRelease()).toBeDefined();
  });
  it("re-review minor: ONE read decides Force Release Lock and the notice — the button is never hidden by a fault the notice did not see", async () => {
    s.checkedOut = true;
    // the old shape read twice; the second (the force-release hook's) faulting hid the button with no alert
    s.queue = [HEALTHY, UNREADABLE];
    await render("DocCtrl");
    expect(s.entryCalls).toBe(1);
    expect(fault()).toBeNull();
    expect(forceRelease()).toBeDefined();
    // and the other way round: a faulting read hides the button AND shows the notice
    s.queue = [UNREADABLE, HEALTHY];
    await rerender("DocCtrl");
    expect(s.entryCalls).toBe(2);
    expect(forceRelease()).toBeUndefined();
    expect(fault()).not.toBeNull();
  });
});

describe("AUTHZ-15 (Inspector) — a stale answer is the last good policy, drawn as is with no label (integrator's ruling, 2026-10-13)", () => {
  it("stale with the defaults: the Drafter's place-a-first-hold section and the DocCtrl's Force Release Lock are drawn, with no alert", async () => {
    s.entry = { policy: {}, version: "v1", stale: true, staleError: "timeout" };
    await render();
    expect(fault()).toBeNull();
    expect(placeHold()).not.toBeNull();
    s.checkedOut = true;
    s.activeHold = true;
    await rerender("DocCtrl");
    expect(fault()).toBeNull();
    expect(forceRelease()).toBeDefined();
    expect(stripCanEdit()).toBe("true");
  });
  it("stale with a narrowed copy: what the cached policy narrows stays hidden — the cache, not the defaults — still with no alert", async () => {
    s.entry = { policy: { caps: { "holds.open": ["DocCtrl"], "holds.release": ["DocCtrl"], "checkout.force_release": ["Admin"] } }, version: "v1", stale: true, staleError: "timeout" };
    await render();
    expect(fault()).toBeNull();
    expect(placeHold()).toBeNull();
    s.activeHold = true;
    await rerender("Drafter");
    expect(stripCanEdit()).toBe("false");
    s.checkedOut = true;
    await rerender("DocCtrl");
    expect(fault()).toBeNull();
    expect(forceRelease()).toBeUndefined();
    expect(stripCanEdit()).toBe("true"); // the cached copy admits DocCtrl to holds.release
  });
});

describe("AUTHZ-15 (Inspector) — REGRESSION: a healthy read draws exactly what it drew before, for every role", () => {
  it("defaults: a Drafter gets the place-a-first-hold section and an editable strip but no Force Release Lock; a DocCtrl and an Admin get Force Release Lock; no alert", async () => {
    s.checkedOut = true;
    s.entry = HEALTHY;
    await render("Drafter");
    expect(fault()).toBeNull();
    expect(placeHold()).not.toBeNull();
    expect(stripCanEdit()).toBe("true"); // the place-a-first-hold strip
    expect(forceRelease()).toBeUndefined();
    s.activeHold = true;
    for (const role of ["Drafter", "DocCtrl", "Admin"]) {
      await rerender(role);
      expect(fault()).toBeNull();
      expect(stripCanEdit()).toBe("true"); // the active hold's Release (holds.release: everyone by default)
      expect(forceRelease() !== undefined).toBe(role !== "Drafter");
    }
  });
  it("a narrowed policy hides what it narrows, with no alert; a widened one offers it", async () => {
    s.checkedOut = true;
    s.entry = { policy: { caps: { "holds.open": ["DocCtrl"], "checkout.force_release": ["Admin"] } }, version: "v1" };
    await render("Drafter");
    expect(fault()).toBeNull();
    expect(placeHold()).toBeNull();
    await rerender("DocCtrl");
    expect(forceRelease()).toBeUndefined();
    expect(fault()).toBeNull();
    s.entry = { policy: { caps: { "checkout.force_release": ["Drafter"] } }, version: "v2" };
    await rerender("Drafter");
    expect(forceRelease()).toBeDefined();
  });
  it("no-authority: a Viewer the policy does not admit sees no hold controls and no Force Release Lock, and no alert", async () => {
    s.checkedOut = true;
    s.entry = { policy: { caps: { "holds.open": ["DocCtrl"], "holds.release": ["DocCtrl"] } }, version: "v1" };
    await render("Viewer");
    expect(fault()).toBeNull();
    expect(placeHold()).toBeNull();
    expect(forceRelease()).toBeUndefined();
    s.activeHold = true;
    await rerender("Viewer");
    expect(stripCanEdit()).toBe("false");
    expect(fault()).toBeNull();
  });
  it("Force Release Lock is drawn only for a checked-out document", async () => {
    s.entry = HEALTHY;
    await render("DocCtrl");
    expect(forceRelease()).toBeUndefined();
  });
});
