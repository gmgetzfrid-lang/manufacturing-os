// @vitest-environment jsdom
//
// admin-and-org Round G, package P13 — ALOG-7 done-when 2's labelled form on
// the Inspector's recent activity (components/documents/InspectorPanel.tsx),
// RENDERED: each of the last three audit rows carries actor_kind from the row
// and says whose word its identity is (lib/auditActions.ts auditActorNote) —
// "identity resolved by the database at write time" (member), "recorded by
// the server", "system — no person", or, for a row written before 20261201,
// "as sent by the writer (before identity was resolved by the database)".
// Regression: the action and "by <name>" line are drawn as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  entry: null as unknown,
  queue: [] as unknown[],
  entryCalls: 0,
  checkedOut: false,
  activeHold: false,
  audits: [] as Array<Record<string, unknown>>,
  auditTables: [] as string[],
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (res: (v: unknown) => void) => {
            if (table === "audit_logs") s.auditTables.push(table);
            res({ data: table === "audit_logs" ? s.audits : [], error: null, count: 0 });
          };
        }
        return () => new Proxy(c, h);
      },
    };
    return new Proxy(c, h);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: null } }) } } };
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
// only the History & activity section (its recent audit rows) is under test
vi.mock("@/components/ui/CollapsibleSection", () => ({
  default: (p: { id?: string; children?: React.ReactNode }) => (p.id === "history" ? React.createElement("section", { "data-testid": p.id }, p.children) : null),
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
  s.audits = [];
  s.auditTables = [];
  s.entry = { policy: null, state: "fresh" };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const doc = { id: "d1", orgId: "org1", libraryId: "lib1", documentNumber: "D1", title: "Doc d1", name: "d1.pdf", rev: "C", status: "Issued", currentVersionId: "d1-v3" } as unknown as DocumentRecord;
async function render() {
  const noop = () => {};
  await act(async () => {
    root.render(React.createElement(InspectorPanel, {
      selectedDoc: doc, selectedVersion: null, activeRole: "Drafter", activeRoles: ["Drafter"], uid: "u1", userEmail: "u1@x.io",
      onClose: noop, onMetadata: noop, onHistory: noop, onMove: noop, onPermissions: noop, onDelete: noop,
      onCheckout: noop, onFullScreen: noop, onForceUnlock: noop, orgId: "org1",
    }));
  });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const row = (action: string, email: string, kind: string | null | undefined) => ({
  id: action, action, resource_id: "d1", resource_type: "document", org_id: "org1", user_id: "u9",
  user_email: email, user_role: "Drafter", details: null, timestamp: "2026-10-14T08:00:00.000Z",
  ...(kind === undefined ? {} : { actor_kind: kind }),
});
const section = () => host.querySelector('[data-testid="history"]')?.textContent ?? "";

describe("ALOG-7 (P13) — the Inspector's recent activity says whose word each identity is", () => {
  it("each row's note follows its own actor_kind (member / server / system)", async () => {
    s.audits = [row("CHECK_OUT", "ann@x.io", "member"), row("FORCE_RELEASE", "cron@x.io", "server"), row("REV_UP", "system:x", "system")];
    await render();
    expect(s.auditTables.length).toBeGreaterThan(0);
    const t = section();
    expect(t).toContain("CHECK OUT");
    expect(t).toContain("by ann");
    expect(t).toContain("identity resolved by the database at write time");
    expect(t).toContain("recorded by the server");
    expect(t).toContain("system — no person");
    expect(t).not.toContain("as sent by the writer");
  });

  it("a row written before 20261201 (no actor_kind column, or NULL) is labelled as the writer's word", async () => {
    s.audits = [row("VIEW", "bob@x.io", undefined), row("DOWNLOAD", "bob@x.io", null)];
    await render();
    const t = section();
    expect(t).toContain("by bob");
    expect(t.match(/as sent by the writer \(before identity was resolved by the database\)/g)?.length).toBe(2);
  });

  it("regression: no rows still reads \"No recent activity.\"", async () => {
    await render();
    expect(section()).toContain("No recent activity.");
  });
});
