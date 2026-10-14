// @vitest-environment jsdom
//
// admin-and-org Round G, package P13 — ALOG-7 done-when 2's labelled form on
// the two remaining readers that showed a stored user_email / user_role with
// no note, RENDERED:
//   * components/documents/HistoryDrawer.tsx — the Audit Log tab;
//   * app/(protected)/activity/page.tsx — the people-facing feed.
// Each carries actor_kind from the row (20261201) and renders
// lib/auditActions.ts auditActorNote beside the identity; a row written before
// that paste (no column, or NULL) says it is the writer's word. Regression:
// the email / role / verb lines are drawn exactly as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({ audits: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void) => res({ data: table === "audit_logs" ? s.audits : [], error: null, count: 0 });
        return () => new Proxy(c, h);
      },
    };
    return new Proxy(c, h);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "org1", uid: "u1", userEmail: "u1@x.io", activeRole: "Drafter", hasAnyRole: () => false }),
}));
vi.mock("@/lib/timeline", async (orig) => ({
  ...(await orig<typeof import("@/lib/timeline")>()),
  getDocumentTimeline: vi.fn(async () => []),
}));
vi.mock("@/components/ui/CornerDock", () => ({ useOccupyRightRail: () => {} }));
vi.mock("@/components/viewers/SecureDocViewer", () => ({ default: () => null }));
vi.mock("@/components/documents/TimelineFeed", () => ({ default: () => null }));
vi.mock("@/components/documents/RevisionChainStrip", () => ({ default: () => null }));
vi.mock("@/components/documents/lifecycle/ReverseConfirmModal", () => ({ default: () => null }));
vi.mock("@/components/ui/HelpTooltip", () => ({ default: () => null }));
vi.mock("@/components/navigation/ViewTabs", () => ({ default: () => null, ACTIVITY_VIEWS: [] }));
vi.mock("@/components/documents/DocThumb", () => ({ default: () => null }));
vi.mock("@/components/documents/DocHoverPreview", () => ({ default: (p: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, p.children) }));
vi.mock("next/link", () => ({ default: (p: { href: string; children?: React.ReactNode }) => React.createElement("a", { href: p.href }, p.children) }));

import HistoryDrawer from "@/components/documents/HistoryDrawer";
import ActivityFeedPage from "@/app/(protected)/activity/page";
import type { DocumentRecord } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  s.audits = [];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const row = (id: string, action: string, email: string, role: string, kind: string | null | undefined) => ({
  id, action, resource_id: "d1", resource_type: "document", org_id: "org1", user_id: "u9",
  user_email: email, user_role: role, details: null, timestamp: "2026-10-14T08:00:00.000Z",
  ...(kind === undefined ? {} : { actor_kind: kind }),
});
const ROWS = () => [
  row("a1", "CHECK_OUT", "ann@x.io", "Drafter", "member"),
  row("a2", "FORCE_RELEASE", "ops@x.io", "DocCtrl", "server"),
  row("a3", "REV_UP", "system:scheduled-export", "system", "system"),
  row("a4", "VIEW", "bob@x.io", "Viewer", undefined),
  row("a5", "DOWNLOAD", "cat@x.io", "Engineer-2", null),
];

describe("ALOG-7 (P13) — HistoryDrawer's Audit Log tab", () => {
  const doc = { id: "d1", orgId: "org1", libraryId: "lib1", documentNumber: "D1", title: "Doc d1" } as unknown as DocumentRecord;
  async function openAuditTab() {
    await act(async () => { root.render(React.createElement(HistoryDrawer, { isOpen: true, onClose: () => {}, docRecord: doc })); });
    await settle();
    const tab = Array.from(host.querySelectorAll("button")).find((b) => /audit/i.test(b.textContent ?? ""));
    expect(tab).toBeTruthy();
    await act(async () => { tab!.click(); });
    await settle();
    return host.textContent ?? "";
  }

  it("each row says whose word its email and role are, from its own actor_kind; pre-20261201 rows are the writer's word", async () => {
    s.audits = ROWS();
    const t = await openAuditTab();
    // regression: identity and role drawn as before
    expect(t).toContain("ann@x.io");
    expect(t).toContain("(Drafter)");
    expect(t).toContain("ops@x.io");
    expect(t).toContain("(DocCtrl)");
    expect(t).toContain("identity resolved by the database at write time");
    expect(t).toContain("recorded by the server");
    expect(t).toContain("system — no person");
    expect(t.match(/as sent by the writer \(before identity was resolved by the database\)/g)?.length).toBe(2);
  });
});

describe("ALOG-7 (P13) — the /activity feed", () => {
  it("each event's actor carries the note beside the name; pre-20261201 rows are the writer's word", async () => {
    s.audits = ROWS();
    await act(async () => { root.render(React.createElement(ActivityFeedPage)); });
    await settle();
    const t = host.textContent ?? "";
    // regression: the name and verb as before
    expect(t).toContain("ann");
    expect(t).toContain("checked out");
    expect(t).toContain("force-released the lock on");
    expect(t).toContain("(identity resolved by the database at write time)");
    expect(t).toContain("(recorded by the server)");
    expect(t).toContain("(system — no person)");
    expect(t.match(/\(as sent by the writer \(before identity was resolved by the database\)\)/g)?.length).toBe(2);
  });
});
