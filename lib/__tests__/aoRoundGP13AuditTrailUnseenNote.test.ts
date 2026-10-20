// @vitest-environment jsdom
//
// admin-and-org Round G, package P13 (integrator fix pass, re-review minor 3):
// after 20261219 (ALOG-16) the database leaves node-level authority rows —
// permission, ownership and recertification changes on a library, folder or
// document — out of a reader's audit trail unless they hold the Audit log
// permission or may manage that node. A reader that presents a document's
// trail as its whole history says so in ONE neutral line, with no count:
//   * components/documents/TimelineFeed.tsx (HistoryDrawer's Timeline tab and
//     the project page's feed — both built from audit rows);
//   * components/documents/HistoryDrawer.tsx's Audit Log tab;
//   * lib/evidencePack.ts's document evidence pack (printed for others).
// Regression: the rows, the headings and the empty states are drawn as before.

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
vi.mock("@/components/documents/RevisionChainStrip", () => ({ default: () => null }));
vi.mock("@/components/documents/lifecycle/ReverseConfirmModal", () => ({ default: () => null }));
vi.mock("@/components/ui/HelpTooltip", () => ({ default: () => null }));
vi.mock("next/link", () => ({ default: (p: { href: string; children?: React.ReactNode }) => React.createElement("a", { href: p.href }, p.children) }));

import TimelineFeed from "@/components/documents/TimelineFeed";
import HistoryDrawer from "@/components/documents/HistoryDrawer";
import { renderEvidenceHtml } from "@/lib/evidencePack";
import { AUDIT_TRAIL_UNSEEN_NOTE, AUDIT_TRAIL_UNSEEN_NOTE_PACK } from "@/lib/auditActions";
import type { TimelineEvent } from "@/lib/timeline";
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
const notes = () => Array.from(host.querySelectorAll("[data-testid='audit-trail-unseen-note']")).map((n) => n.textContent);

describe("P13 minor 3 — the line itself", () => {
  it("is neutral and carries no count; it names what the database leaves out and who reads it", () => {
    for (const line of [AUDIT_TRAIL_UNSEEN_NOTE, AUDIT_TRAIL_UNSEEN_NOTE_PACK]) {
      expect(line).not.toMatch(/\d/);
      expect(line).toMatch(/may not see are not listed/);
      expect(line).toMatch(/permission, ownership and recertification changes on a library, folder or document/);
      expect(line).toMatch(/Audit log permission and to those who may manage it\.$/);
    }
    expect(AUDIT_TRAIL_UNSEEN_NOTE).toMatch(/^Entries you may not see/);
    expect(AUDIT_TRAIL_UNSEEN_NOTE_PACK).toMatch(/^Entries the person who generated this pack may not see/);
  });
});

describe("P13 minor 3 — TimelineFeed", () => {
  const ev: TimelineEvent = { id: "audit:a1", kind: "audit", action: "CHECK_OUT", resourceType: "document", resourceId: "d1", timestamp: "2026-10-14T08:00:00.000Z", userId: "u9", userName: null, userEmail: "ann@x.io", actorKind: "member", summary: "Checked out", details: null };

  it("a feed with rows says it once, above the rows; the rows are drawn as before", async () => {
    await act(async () => { root.render(React.createElement(TimelineFeed, { events: [ev] })); });
    expect(notes()).toEqual([AUDIT_TRAIL_UNSEEN_NOTE]);
    expect(host.textContent).toContain("Checked out");
    expect(host.textContent).toContain("ann@x.io");
    // the first row's first span is still its time (PERF-10's pin reads it there)
    expect(host.querySelector(".space-y-3 > div span")!.textContent).toBe(new Date(ev.timestamp).toLocaleString());
  });

  it("an empty feed keeps its empty message and says it once", async () => {
    await act(async () => { root.render(React.createElement(TimelineFeed, { events: [], emptyMessage: "No history yet for this document." })); });
    expect(notes()).toEqual([AUDIT_TRAIL_UNSEEN_NOTE]);
    expect(host.textContent).toContain("No history yet for this document.");
  });
});

describe("P13 minor 3 — HistoryDrawer", () => {
  const doc = { id: "d1", orgId: "org1", libraryId: "lib1", documentNumber: "D1", title: "Doc d1" } as unknown as DocumentRecord;
  const open = async () => {
    await act(async () => { root.render(React.createElement(HistoryDrawer, { isOpen: true, onClose: () => {}, docRecord: doc })); });
    await settle();
  };
  const clickTab = async (re: RegExp) => {
    const tab = Array.from(host.querySelectorAll("button")).find((b) => re.test(b.textContent ?? ""));
    expect(tab).toBeTruthy();
    await act(async () => { tab!.click(); });
    await settle();
  };

  it("the Timeline tab (the feed) and the Audit Log tab each say it once; Revision History and Checkout Log do not", async () => {
    s.audits = [{ id: "a1", action: "CHECK_OUT", resource_id: "d1", resource_type: "document", org_id: "org1", user_id: "u9", user_email: "ann@x.io", user_role: "Drafter", actor_kind: "member", details: null, timestamp: "2026-10-14T08:00:00.000Z" }];
    await open();
    expect(notes()).toEqual([AUDIT_TRAIL_UNSEEN_NOTE]); // the Timeline tab opens first
    await clickTab(/^Audit Log$/i);
    expect(notes()).toEqual([AUDIT_TRAIL_UNSEEN_NOTE]);
    expect(host.textContent).toContain("ann@x.io"); // regression: the rows as before
    await clickTab(/^Revision History$/i);
    expect(notes()).toEqual([]);
    await clickTab(/^Checkout Log$/i);
    expect(notes()).toEqual([]);
  });

  it("an empty Audit Log tab keeps 'No audit logs found.' and says it once", async () => {
    await open();
    await clickTab(/^Audit Log$/i);
    expect(host.textContent).toContain("No audit logs found.");
    expect(notes()).toEqual([AUDIT_TRAIL_UNSEEN_NOTE]);
  });
});

describe("P13 minor 3 — the document evidence pack", () => {
  it("prints the pack's form once under 'Audit trail (N)', with or without rows; the heading and rows as before", () => {
    const audit = [{ action: "VIEW", user_email: "ann@x.io", user_role: "Drafter", actor_kind: "member", details: null, timestamp: "2026-10-01T00:00:00Z" }];
    const html = renderEvidenceHtml({ doc: { document_number: "P-101" }, versions: [], holds: [], audit });
    expect(html.split(AUDIT_TRAIL_UNSEEN_NOTE_PACK)).toHaveLength(2);
    expect(html).toMatch(/<h2>Audit trail \(1\)<\/h2>\s*<div class="muted unseen">Entries the person who generated this pack may not see/);
    expect(html).toContain("ann@x.io");
    const empty = renderEvidenceHtml({ doc: { document_number: "P-101" }, versions: [], holds: [], audit: [] });
    expect(empty.split(AUDIT_TRAIL_UNSEEN_NOTE_PACK)).toHaveLength(2);
    expect(empty).toContain('<div class="empty">No audit entries.</div>');
  });
});
