// @vitest-environment jsdom
//
// document-control Round G — P29 TRANSMITTAL READ, DIST-18 limb (a), the
// final review's item (1), RENDERED: the Inspector's transmittal trail and
// its distribution pill read the register's `withheld` word. For a document
// the viewer may not read the route answers only the transmittals they sent
// (shown whole) and says the rest is withheld — the panel says "not shown",
// never "none" / "never transmitted". REGRESSION: a trail served whole draws
// exactly as before (the rows, the "N issued" pill), and an empty trail
// served whole draws nothing, as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  trail: vi.fn(),
}));

// Every read the panel makes besides the recall: an empty, successful answer.
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
vi.mock("@/lib/transmittals", () => ({ listTransmittalsForDocument: (...a: unknown[]) => s.trail(...a) }));
vi.mock("@/lib/branches", () => ({ listOpenBranchesForDocument: vi.fn(async () => []) }));
vi.mock("@/lib/ownership", () => ({ effectiveOwnerForDocument: vi.fn(async () => ({ userId: null })), requestDeletion: vi.fn() }));
// P24 (AUTHZ-15): the panel reads loadCapabilityPolicyEntry and its fault marker.
vi.mock("@/lib/capabilityPolicy", () => ({ loadCapabilityPolicyEntry: vi.fn(async () => ({ policy: {}, version: null })) }));
// P24 integrator fix pass: the Inspector draws Force Release Lock from its own read (canForceReleaseCheckout), no longer useForceReleaseAllowed.
vi.mock("@/lib/checkoutAffordances", () => ({ holdAffordances: () => ({ canOpen: false, canRelease: false }), canForceReleaseCheckout: () => false, affordancePolicyFault: () => null }));
vi.mock("@/lib/documentGuards", () => ({ isDocumentCheckedOut: () => false }));
vi.mock("@/lib/documentTags", () => ({ collectTagGroups: () => [] }));
vi.mock("@/lib/evidencePack", () => ({ openEvidencePack: vi.fn() }));
vi.mock("@/lib/audit", () => ({}));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: vi.fn(), appPrompt: vi.fn() }));
vi.mock("next/link", () => ({ default: (p: { children?: React.ReactNode }) => React.createElement("a", null, p.children) }));
// The panel's children are not under test.
vi.mock("@/components/viewers/SecureDocViewer", () => ({ default: () => null }));
vi.mock("@/components/documents/CheckoutStatusCell", () => ({ default: () => null }));
vi.mock("@/components/documents/VersionHistoryPanel", () => ({ default: () => null }));
vi.mock("@/components/documents/HoldStrip", () => ({ default: () => null }));
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
// Only the distribution section is under test: its summary (the pill) and its body (the trail).
vi.mock("@/components/ui/CollapsibleSection", () => ({
  default: (p: { id?: string; summary?: React.ReactNode; children?: React.ReactNode }) =>
    p.id === "distribution"
      ? React.createElement("section", null, React.createElement("div", { "data-testid": "dist-summary" }, p.summary), p.children)
      : null,
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
  s.trail.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const doc = (id: string): DocumentRecord => ({
  id, orgId: "org1", libraryId: "lib1", documentNumber: id.toUpperCase(), title: `Doc ${id}`, name: `${id}.pdf`,
  rev: "C", status: "Issued", currentVersionId: `${id}-v3`,
} as unknown as DocumentRecord);

async function render(d: DocumentRecord) {
  const noop = () => {};
  await act(async () => {
    root.render(React.createElement(InspectorPanel, {
      selectedDoc: d, selectedVersion: null, activeRole: "DocCtrl", activeRoles: ["DocCtrl"], uid: "u1", userEmail: "dc@x.io",
      onClose: noop, onMetadata: noop, onHistory: noop, onMove: noop, onPermissions: noop, onDelete: noop,
      onCheckout: noop, onFullScreen: noop, orgId: "org1",
    }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const tr = (over: Record<string, unknown> = {}) => ({
  id: "t7", orgId: "org1", seq: 7, number: "TR-0007", status: "issued", purpose: "For Construction",
  recipientCompany: "BuildCo", issuedAt: "2026-10-01T00:00:00Z",
  items: [{ documentId: "d1", number: "D1", rev: "C" }], ...over,
});
const pill = () => host.querySelector('[data-testid="dist-summary"]')?.textContent ?? "";
const text = () => host.textContent ?? "";

describe("DIST-18 limb (a), final review (1) — a withheld trail renders 'not shown', never 'none'", () => {
  it("a refused non-sender (no rows, withheld): the trail says 'Transmitted on — not shown' and the pill 'transmittals not shown'", async () => {
    s.trail.mockResolvedValue({ transmittals: [], withheld: true });
    await render(doc("d1"));
    expect(s.trail).toHaveBeenCalledWith("org1", "d1");
    expect(text()).toContain("Transmitted on — not shown");
    expect(text()).toMatch(/its transmittal trail is not shown/);
    expect(text()).toContain('This is not "never transmitted".');
    expect(pill()).toBe("transmittals not shown");
    expect(host.querySelector('[data-testid="dist-summary"] span')?.getAttribute("title")).toMatch(/not shown/);
  });

  it("a refused sender: their own transmittals keep showing, with a line that the rest is not shown; the pill counts them and says others are not shown", async () => {
    s.trail.mockResolvedValue({ transmittals: [tr()], withheld: true });
    await render(doc("d1"));
    expect(text()).toContain("TR-0007");
    expect(text()).toContain("Rev C · For Construction · to BuildCo");
    expect(text()).toContain("Only the transmittals you sent are listed — the rest of this document's trail is not shown.");
    expect(pill()).toBe("1 issued by you · others not shown");
  });

  it("REGRESSION: a trail served whole draws exactly as before — the rows and 'N issued', no 'not shown'", async () => {
    s.trail.mockResolvedValue({ transmittals: [tr(), tr({ id: "t6", seq: 6, number: "TR-0006", status: "acknowledged" })], withheld: false });
    await render(doc("d1"));
    expect(text()).toContain("TR-0007");
    expect(text()).toContain("TR-0006");
    expect(text()).toContain("Transmitted on");
    expect(text()).not.toMatch(/not shown/);
    expect(pill()).toBe("2 issued");
  });

  it("REGRESSION: an empty trail served whole draws no trail and no pill, as before; a failed read still says 'couldn't check' and '? issued'", async () => {
    s.trail.mockResolvedValue({ transmittals: [], withheld: false });
    await render(doc("d1"));
    expect(text()).not.toMatch(/Transmitted on|not shown/);
    expect(pill()).toBe("");
    s.trail.mockReset();
    s.trail.mockRejectedValue(new Error("Couldn't read the transmittal trail: down"));
    await render(doc("d2"));
    expect(text()).toContain("Transmitted on — couldn't check");
    expect(pill()).toBe("? issued");
  });
});
