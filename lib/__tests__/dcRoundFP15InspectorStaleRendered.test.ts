// @vitest-environment jsdom
//
// document-control Round F wave 3 — P15 SURFACE REMAINDERS, third review fix:
// DIST-9 done-when 3, RENDERED. The inspector's stale-holder banner reads
// getDocumentRecall's `unavailable` — or a recall that throws — as a GAP
// ("Distribution record unavailable"), never as "nobody is working from a
// superseded copy". The earlier pins were regexes over InspectorPanel's
// source; this renders the real InspectorPanel (jsdom) with its children
// stubbed and lib/staleCopies.ts getDocumentRecall answering each way.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  recall: vi.fn(),
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
vi.mock("@/lib/staleCopies", () => ({ getDocumentRecall: (...a: unknown[]) => s.recall(...a) }));
vi.mock("@/lib/holds", () => ({ listActiveHoldsForDocument: vi.fn(async () => []) }));
vi.mock("@/lib/transmittals", () => ({ listTransmittalsForDocument: vi.fn(async () => []) }));
vi.mock("@/lib/branches", () => ({ listOpenBranchesForDocument: vi.fn(async () => []) }));
vi.mock("@/lib/ownership", () => ({ effectiveOwnerForDocument: vi.fn(async () => ({ userId: null })), requestDeletion: vi.fn() }));
vi.mock("@/lib/capabilityPolicy", () => ({ loadCapabilityPolicy: vi.fn(async () => ({})) }));
vi.mock("@/lib/checkoutAffordances", () => ({ holdAffordances: () => ({ canOpen: false, canRelease: false }) }));
vi.mock("@/lib/documentGuards", () => ({ isDocumentCheckedOut: () => false }));
vi.mock("@/lib/documentTags", () => ({ collectTagGroups: () => [] }));
vi.mock("@/lib/evidencePack", () => ({ openEvidencePack: vi.fn() }));
vi.mock("@/lib/audit", () => ({}));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: vi.fn(), appPrompt: vi.fn() }));
vi.mock("next/link", () => ({ default: (p: { children?: React.ReactNode }) => React.createElement("a", null, p.children) }));
// The panel's children are not under test.
vi.mock("@/components/viewers/SecureDocViewer", () => ({ default: () => null }));
vi.mock("@/components/documents/CheckoutStatusCell", () => ({ default: () => null, useForceReleaseAllowed: () => false }));
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
vi.mock("@/components/ui/CollapsibleSection", () => ({ default: () => null }));
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
  s.recall.mockReset();
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
const gap = () => host.querySelector('[data-testid="stale-holders-unknown"]');
const staleCount = () => /may be working from a superseded copy/.test(host.textContent ?? "");

describe("DIST-9 dw3 (rendered) — the inspector's stale-holder banner reads an unreadable record as a gap", () => {
  it("getDocumentRecall unavailable → 'Distribution record unavailable', never a silent zero", async () => {
    s.recall.mockResolvedValue({ holders: [], capped: false, unavailable: true });
    await render(doc("d1"));
    expect(s.recall).toHaveBeenCalledWith("d1", "d1-v3");
    expect(gap()?.textContent).toMatch(/^Distribution record unavailable — who holds a copy of this document could not be read, so whether anyone is working from a superseded copy is unknown\./);
    expect(staleCount()).toBe(false);
  });

  it("a recall that throws is unknown too", async () => {
    s.recall.mockRejectedValue(new Error("network down"));
    await render(doc("d1"));
    expect(gap()).not.toBeNull();
    expect(staleCount()).toBe(false);
  });

  it("REGRESSION: a readable record shows the count banner as before, and no gap", async () => {
    s.recall.mockResolvedValue({ holders: [{ hasCurrent: false }, { hasCurrent: true }, { hasCurrent: false }], capped: false, unavailable: false });
    await render(doc("d1"));
    expect(gap()).toBeNull();
    expect(host.textContent).toContain("2 people may be working from a superseded copy");
  });

  it("REGRESSION: a readable record with nobody stale renders neither banner", async () => {
    s.recall.mockResolvedValue({ holders: [{ hasCurrent: true }], capped: false, unavailable: false });
    await render(doc("d1"));
    expect(gap()).toBeNull();
    expect(staleCount()).toBe(false);
  });

  it("switching documents clears the previous document's gap (it is never shown against the next one)", async () => {
    s.recall.mockResolvedValueOnce({ holders: [], capped: false, unavailable: true });
    await render(doc("d1"));
    expect(gap()).not.toBeNull();
    let release: (v: unknown) => void = () => {};
    s.recall.mockReturnValueOnce(new Promise((r) => { release = r; }));
    await render(doc("d2"));
    expect(gap()).toBeNull(); // cleared synchronously, before d2's recall answers
    await act(async () => { release({ holders: [], capped: false, unavailable: false }); });
    expect(gap()).toBeNull();
  });
});
