// @vitest-environment jsdom
//
// admin-and-org Round G, package P13 (integrator fix pass, DEC-90 ruling
// 2026-10-14) — ALOG-7 done-when 2's labelled form on the three remaining
// readers of an audit row's identity, RENDERED:
//   * lib/timeline.ts (auditRowToEvent) → components/documents/TimelineFeed.tsx
//     (HistoryDrawer's Timeline tab, the project page's feed);
//   * components/documents/DocControlQueue.tsx — "deletion requested by …";
//   * lib/projectSnapshot.ts → lib/projects.ts closeoutGateLines — the
//     closeout's "voided by …".
// Each carries actor_kind from the row (20261201) and shows
// lib/auditActions.ts auditActorNote beside the identity; a row with no
// actor_kind (written before that paste, or before it is pasted) says it is
// the writer's own word (amber where the reader draws it). No read names a
// column the database does not have yet: the timeline and the queue read
// `select("*")`; the snapshot names actor_kind and falls back to its old
// columns on 42703 / PGRST204.
// Regression: the identity, the summary and every non-audit event are drawn
// exactly as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  selects: [] as string[],
  missingColumns: [] as string[],
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const c: Record<string, unknown> = {};
    let action: string | null = null;
    let selected = "";
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          const missing = s.missingColumns.find((col) => selected.split(",").map((x) => x.trim()).includes(col));
          if (missing) return (res: (v: unknown) => void) => res({ data: null, error: { message: `column ${table}.${missing} does not exist`, code: "42703" } });
          const rows = (s.tables[table] ?? []).filter((r) => action === null || r.action === action);
          return (res: (v: unknown) => void) => res({ data: rows, error: null });
        }
        return (...args: unknown[]) => {
          if (prop === "select") { selected = String(args[0]); s.selects.push(`${table}:${selected}`); }
          if (prop === "eq" && args[0] === "action") action = String(args[1]);
          return new Proxy(c, h);
        };
      },
    };
    return new Proxy(c, h);
  };
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/lib/branches", () => ({
  listOpenBranchesForOrg: vi.fn(async () => []),
  resolveBranch: vi.fn(async () => undefined),
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: vi.fn(async () => undefined) }));
vi.mock("next/link", () => ({ default: (p: { href: string; children?: React.ReactNode }) => React.createElement("a", { href: p.href }, p.children) }));

import TimelineFeed from "@/components/documents/TimelineFeed";
import DocControlQueue from "@/components/documents/DocControlQueue";
import { mergeHoldHistory, type AuditRow, type TimelineEvent } from "@/lib/timeline";
import { closeoutGateLines } from "@/lib/projects";
import type { ProjectStateSnapshot } from "@/lib/projectHealth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MEMBER = "identity resolved by the database at write time";
const SERVER = "recorded by the server";
const SYSTEM = "system — no person";
const WRITER = "as sent by the writer (before identity was resolved by the database)";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  s.tables = {};
  s.selects = [];
  s.missingColumns = [];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const auditRow = (id: string, action: string, email: string | null, kind: string | null | undefined): AuditRow => ({
  id, action, resource_id: "d1", resource_type: "document", org_id: "org1", user_id: "u9",
  user_email: email, user_role: "Drafter", details: null, metadata: null, timestamp: "2026-10-14T08:00:00.000Z",
  ...(kind === undefined ? {} : { actor_kind: kind }),
});

describe("ALOG-7 (P13) — lib/timeline.ts → TimelineFeed", () => {
  it("an audit event carries its row's actor_kind; none on the row is null (the writer's word)", () => {
    const { auditEvents } = mergeHoldHistory([
      auditRow("a1", "CHECK_OUT", "ann@x.io", "member"),
      auditRow("a2", "FORCE_RELEASE", "ops@x.io", "server"),
      auditRow("a3", "VIEW", "bob@x.io", undefined),
      auditRow("a4", "DOWNLOAD", "cat@x.io", null),
    ], [], null);
    expect(auditEvents.map((e) => [e.id, e.userEmail, e.actorKind])).toEqual([
      ["audit:a1", "ann@x.io", "member"],
      ["audit:a2", "ops@x.io", "server"],
      ["audit:a3", "bob@x.io", null],
      ["audit:a4", "cat@x.io", null],
    ]);
  });

  it("the feed renders the note beside an audit row's identity, amber for the writer's word; version and activity rows carry none", async () => {
    const { auditEvents } = mergeHoldHistory([
      auditRow("a1", "CHECK_OUT", "ann@x.io", "member"),
      auditRow("a2", "FORCE_RELEASE", "ops@x.io", "server"),
      auditRow("a3", "REV_UP", "system:scheduled-export", "system"),
      auditRow("a4", "VIEW", "bob@x.io", undefined),
    ], [], null);
    const other: TimelineEvent[] = [
      { id: "version:v1", kind: "version", action: "VERSION_CREATED", resourceType: "document", resourceId: "d1", timestamp: "2026-10-13T08:00:00.000Z", userId: "u1", userName: "Dana Drafter", userEmail: null, summary: "Rev B created", details: null },
      { id: "activity:p1", kind: "project_activity", action: "comment", resourceType: "project", resourceId: "p1", timestamp: "2026-10-12T08:00:00.000Z", userId: "u2", userName: "Pat PM", userEmail: null, summary: "Kickoff held", details: null },
    ];
    await act(async () => { root.render(React.createElement(TimelineFeed, { events: [...auditEvents, ...other] })); });
    const t = host.textContent ?? "";
    // regression: identities and summaries as before
    for (const who of ["ann@x.io", "ops@x.io", "bob@x.io", "Dana Drafter", "Pat PM", "Rev B created", "Kickoff held"]) expect(t).toContain(who);
    expect(t).toContain(`(${MEMBER})`);
    expect(t).toContain(`(${SERVER})`);
    expect(t).toContain(`(${SYSTEM})`);
    expect(t.match(new RegExp(`\\(${WRITER.replace(/[()]/g, "\\$&")}\\)`, "g"))?.length).toBe(1);
    // the writer's word is amber; a resolved kind is not
    const notes = Array.from(host.querySelectorAll("span[title^='ALOG-7']"));
    expect(notes).toHaveLength(4);
    expect(notes.filter((n) => n.className.includes("text-amber-700")).map((n) => n.textContent)).toEqual([`(${WRITER})`]);
    // the non-audit rows' identity line carries no note
    const rowOf = (who: string) => Array.from(host.querySelectorAll("span")).find((n) => n.textContent === who)!.parentElement!;
    expect(rowOf("Dana Drafter").querySelector("span[title^='ALOG-7']")).toBeNull();
    expect(rowOf("Pat PM").querySelector("span[title^='ALOG-7']")).toBeNull();
  });

  it("a hold-record-removed event built from an audit row keeps that row's note", async () => {
    const r = { ...auditRow("a9", "HOLD_OPENED", "dc@x.io", undefined), details: { holdId: "gone", reason: "Vendor data" } };
    const { auditEvents } = mergeHoldHistory([r], [], new Set());
    expect(auditEvents[0].kind).toBe("hold");
    expect(auditEvents[0].actorKind).toBeNull();
    await act(async () => { root.render(React.createElement(TimelineFeed, { events: auditEvents })); });
    expect(host.textContent).toContain(`dc@x.io(${WRITER})`);
  });
});

describe("ALOG-7 (P13) — DocControlQueue's deletion requests", () => {
  const delReq = (id: string, doc: string, email: string | null, kind: string | null | undefined) => ({
    id, action: "DELETION_REQUESTED", resource_id: doc, resource_type: "document", org_id: "org1", user_id: "u9",
    user_email: email, user_role: "Drafter", details: { label: `DOC-${doc}`, reason: "duplicate" }, timestamp: "2026-10-10T08:00:00.000Z",
    ...(kind === undefined ? {} : { actor_kind: kind }),
  });

  it("each request names its requester with the note; a requester the row does not name stays 'the owner' with none", async () => {
    s.tables.audit_logs = [
      delReq("r1", "d1", "ann@x.io", "member"),
      delReq("r2", "d2", "ops@x.io", "server"),
      delReq("r3", "d3", "bob@x.io", undefined),
      delReq("r4", "d4", null, undefined),
    ];
    await act(async () => { root.render(React.createElement(DocControlQueue, { orgId: "org1", currentUser: { uid: "u1", email: "dc@x.io", role: "DocCtrl" } })); });
    await settle();
    const t = host.textContent ?? "";
    // the read never names a column that is not there yet
    expect(s.selects).toContain("audit_logs:*");
    expect(s.selects.some((x) => /^audit_logs:.*actor_kind/.test(x))).toBe(false);
    // regression: labels, reasons and the date line as before
    for (const l of ["DOC-d1", "DOC-d2", "DOC-d3", "DOC-d4", "duplicate", "Mark handled"]) expect(t).toContain(l);
    expect(t).toContain(`by ann@x.io(${MEMBER}) on `);
    expect(t).toContain(`by ops@x.io(${SERVER}) on `);
    expect(t).toContain(`by bob@x.io(${WRITER}) on `);
    expect(t).toContain("by the owner on ");
    const notes = Array.from(host.querySelectorAll("span[title^='ALOG-7']"));
    expect(notes).toHaveLength(3);
    expect(notes.filter((n) => n.className.includes("text-amber-700")).map((n) => n.textContent)).toEqual([`(${WRITER})`]);
  });
});

describe("ALOG-7 (P13) — the closeout's 'voided by' (lib/projectSnapshot.ts → lib/projects.ts)", () => {
  const snapshot = (over: Partial<ProjectStateSnapshot>): ProjectStateSnapshot => ({
    hasPurpose: true, hasGoals: true, hasSow: true, jobKind: null,
    budget: 0, committed: 0, spent: 0, cpi: null, accountCount: 0, accountsPinned: 0, partyCount: 0,
    quoteCount: 0, unawardedRfqGroups: 0, pendingCostDocs: 0, openChangeOrders: 0, approvedCoAmount: 0,
    milestoneCount: 0, overdueMilestones: 0, spi: null, hasBaseline: false,
    checklistCount: 0, checklistOpenItems: 0, checklistNeedsEvidence: 0, turnoverRequired: 0, turnoverAccepted: 0, punchOpen: 0,
    intakeLinkCount: 0, membersCount: 1, readFailures: [], notMigrated: [],
    ...over,
  });

  it("each 'voided by' says whose word it is; no voider on record and an unreadable read read as before", () => {
    const line = closeoutGateLines(snapshot({
      checklistsVoided: [
        { id: "c1", title: "PSSR", voidedBy: "dc@x.io", voidedByActorKind: "member" },
        { id: "c2", title: "MI", voidedBy: "ops@x.io", voidedByActorKind: "server" },
        { id: "c3", title: "QA", voidedBy: "own@x.io" },
        { id: "c4", title: "Old", voidedBy: null },
      ],
    })).find((l) => l.key === "checklistsVoided")!;
    expect(line).toEqual({
      key: "checklistsVoided", ok: false, openCount: 4,
      text: `4 checklists voided — PSSR (voided by dc@x.io · ${MEMBER}); MI (voided by ops@x.io · ${SERVER}); QA (voided by own@x.io · ${WRITER}); Old (who voided it is not on record)`,
    });
    expect(closeoutGateLines(snapshot({ checklistsVoided: [{ id: "c1", title: "PSSR", voidedBy: null, voidedByUnreadable: true }] }))
      .find((l) => l.key === "checklistsVoided")!.text).toBe("1 checklist voided — PSSR (who voided it could not be read)");
  });

  const seedVoids = () => {
    s.tables.projects = [{ id: "p1", purpose: "x", goals: ["g"], sow_document_id: "s1", job_kind: null }];
    s.tables.project_checklists = [
      { id: "c1", status: "void", title: "PSSR", completed_signature_id: null },
      { id: "c2", status: "void", title: "MI", completed_signature_id: null },
    ];
    s.tables.audit_logs = [
      { action: "CHECKLIST_STATUS", user_email: "dc@x.io", actor_kind: "member", details: { checklistId: "c1", status: "void" } },
      { action: "CHECKLIST_STATUS", user_email: "own@x.io", details: { checklistId: "c2", status: "void" } },
    ];
  };

  it("the snapshot reads the void's audit row with its actor_kind and carries it; a row with none leaves the entry as before", async () => {
    const { gatherProjectSnapshotUncached } = await import("@/lib/projectSnapshot");
    seedVoids();
    const snap = await gatherProjectSnapshotUncached("org1", "p1");
    expect(s.selects.filter((x) => x.startsWith("audit_logs:"))).toEqual(["audit_logs:user_email, actor_kind, details, timestamp"]);
    expect(snap.checklistsVoided).toEqual([
      { id: "c1", title: "PSSR", voidedBy: "dc@x.io", voidedByActorKind: "member" },
      { id: "c2", title: "MI", voidedBy: "own@x.io" },
    ]);
    expect(closeoutGateLines(snap).find((l) => l.key === "checklistsVoided")!.text)
      .toBe(`2 checklists voided — PSSR (voided by dc@x.io · ${MEMBER}); MI (voided by own@x.io · ${WRITER})`);
  });

  it("before 20261201 (no actor_kind column): the old read, who voided it still named — never 'could not be read' — as the writer's word", async () => {
    const { gatherProjectSnapshotUncached } = await import("@/lib/projectSnapshot");
    seedVoids();
    s.missingColumns = ["actor_kind"];
    s.tables.audit_logs = s.tables.audit_logs.map(({ actor_kind: _drop, ...r }) => r);
    const snap = await gatherProjectSnapshotUncached("org1", "p1");
    expect(s.selects.filter((x) => x.startsWith("audit_logs:"))).toEqual([
      "audit_logs:user_email, actor_kind, details, timestamp",
      "audit_logs:user_email, details, timestamp",
    ]);
    // exactly the entries the read produced before this package
    expect(snap.checklistsVoided).toEqual([
      { id: "c1", title: "PSSR", voidedBy: "dc@x.io" },
      { id: "c2", title: "MI", voidedBy: "own@x.io" },
    ]);
    expect(closeoutGateLines(snap).find((l) => l.key === "checklistsVoided")!.text)
      .toBe(`2 checklists voided — PSSR (voided by dc@x.io · ${WRITER}); MI (voided by own@x.io · ${WRITER})`);
  });
});
