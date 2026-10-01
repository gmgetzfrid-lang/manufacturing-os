// @vitest-environment jsdom
//
// notifications Round G, N2 KIND-REGISTRY — the kind → section / action /
// icon / group / compliance classification, pinned.
//
// REGRESSION FIRST. The tables below are what the code did on b9cdfdc, read
// from the source, before the registry changed anything: every notification a
// user sees today lands in the same section with the same count unless a
// record names that kind as misfiled.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  // one identity for the whole run: a fresh array per render would re-run
  // the hook's fetch effect on every render
  role: { roles: ["Viewer"], activeOrgId: "o1", uid: "u1", membershipState: "member" },
}));

vi.mock("@/lib/supabase", () => {
  const result = { data: [], error: null, count: 0 };
  const chain = (): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "in", "order", "limit", "is", "or", "gte"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: null, error: null });
    q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, ko);
    return q;
  };
  const channel = { on: () => channel, subscribe: () => channel };
  return {
    supabase: {
      from: () => chain(),
      channel: () => channel,
      removeChannel: () => {},
    },
  };
});
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => fixture.role,
}));
vi.mock("@/lib/capabilityPolicy", () => ({ loadCapabilityPolicy: async () => undefined }));
vi.mock("@/lib/inAppNotifications", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listMyNotifications: async () => fixture.rows,
    markRead: async () => {},
    markAllRead: async () => {},
    markManyRead: async () => {},
  };
});

import { sectionForKind, useTicketNotifications } from "@/hooks/useTicketNotifications";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** The NotificationKind union, parsed from its declaration. */
const unionKinds = (): string[] => {
  // comments stripped first: a member's comment may itself hold a ';'
  const s = src("lib/inAppNotifications.ts").replace(/\/\/[^\n]*/g, "");
  const m = s.match(/export type NotificationKind =([\s\S]*?);/);
  if (!m) throw new Error("NotificationKind union not found");
  return [...m[1].matchAll(/\|\s*"([a-z_0-9]+)"/g)].map((x) => x[1]);
};

// ── TODAY (b9cdfdc) ──────────────────────────────────────────────────────────
// sectionForKind (hooks/useTicketNotifications.ts:73-105), every union member.
const TODAY_SECTION: Record<string, "requests" | "scratchpad" | "documents" | "projects" | "other"> = {
  ticket_comment: "requests", ticket_mention: "requests", ticket_status: "requests", ticket_assigned: "requests",
  request_pending_approval: "requests",
  task_nudge: "scratchpad", task_overdue_digest: "scratchpad", morning_digest: "scratchpad",
  doc_superseded: "documents", markup_request: "documents", checkout_conflict: "documents", checkout_handoff: "documents",
  checkout_message: "documents", checkout_released: "documents", overlap_advisory: "documents", branch_open: "documents",
  branch_resolved: "documents", provenance_flag: "documents", hold_opened: "documents", hold_released: "documents",
  project_member: "projects", project_status: "projects",
  // default: 'other' — tallied, rendered by no sidebar row
  revision_published_over_checkout: "other", library_doc_added: "other", library_doc_revised: "other",
  project_comment: "other", task_reminder: "other", review_due: "other", owner_assigned: "other", owner_behind: "other",
  deletion_requested: "other", ack_requested: "other", ack_complete: "other", ack_overdue: "other",
  ack_unsatisfiable: "other", review_requested: "other", review_signed: "other", review_invalidated: "other",
  review_complete: "other", review_overdue: "other", review_alternate_activated: "other", effective_now: "other",
  retention_eligible: "other", legal_hold_placed: "other", legal_hold_released: "other", access_recert_due: "other",
  orchestrator_message: "other", security_export: "other", member_revoked: "other", library_unowned: "other",
};
// Kinds WRITTEN today that are in no union (raw inserts): they fall to the
// same default.
const TODAY_OFF_UNION = ["storage_alert", "storage_platform_r2", "storage_platform_db", "ai_cap_changed", "transmittal_unstampable"];
// actionKinds (hooks/useTicketNotifications.ts:326).
const TODAY_ACTION = new Set(["checkout_conflict", "checkout_released", "overlap_advisory", "branch_open"]);
// KIND_ICON (components/notifications/NotificationBell.tsx:19-44) — every
// other kind draws the fallback Bell.
const TODAY_BELL_ICON: Record<string, string> = {
  ticket: "ClipboardList", ticket_comment: "MessageSquare", ticket_mention: "MessageSquare", ticket_status: "FileText",
  ticket_assigned: "UserPlus", checkout_conflict: "AlertOctagon", checkout_handoff: "Lock", checkout_message: "MessageSquare",
  revision_published_over_checkout: "GitBranch", project_member: "Briefcase", project_status: "Briefcase",
  project_comment: "Briefcase", hold_opened: "AlertOctagon", hold_released: "Check", markup_request: "FileSignature",
  doc_superseded: "GitBranch", checkout_released: "Lock", overlap_advisory: "AlertOctagon", branch_open: "GitBranch",
  branch_resolved: "Check", provenance_flag: "FileText", task_overdue_digest: "ListChecks",
  request_pending_approval: "MailPlus", orchestrator_message: "MessageSquare",
};
// attentionVisual's non-action arm (components/cockpit/AttentionFeed.tsx:37-50),
// copied verbatim — the predecessor a derived feed visual must reproduce.
function TODAY_FEED(kind: string): { icon: string; tone: string } {
  const k = String(kind).toLowerCase();
  if (k.includes("reminder")) return { icon: "Bell", tone: "amber" };
  if (k.includes("mention")) return { icon: "AtSign", tone: "violet" };
  if (k.includes("comment") || k.includes("message")) return { icon: "MessageSquare", tone: "blue" };
  if (k.includes("conflict")) return { icon: "AlertTriangle", tone: "amber" };
  if (k.includes("checkout") || k.includes("lock")) return { icon: "Lock", tone: "indigo" };
  if (k.includes("markup")) return { icon: "FileSignature", tone: "violet" };
  if (k.includes("hold")) return { icon: "AlertOctagon", tone: "rose" };
  if (k.includes("milestone")) return { icon: "Flag", tone: "emerald" };
  if (k.includes("rev") || k.includes("revision") || k.includes("version")) return { icon: "GitBranch", tone: "blue" };
  if (k.includes("transmittal")) return { icon: "Send", tone: "blue" };
  if (k.includes("approval") || k.includes("request") || k.includes("assign")) return { icon: "Briefcase", tone: "orange" };
  if (k.includes("equipment") || k.includes("asset")) return { icon: "Layers", tone: "amber" };
  return { icon: "Bell", tone: "slate" };
}
// KIND_GROUPS / groupOf (components/cockpit/AttentionFeed.tsx:63-74), verbatim.
function TODAY_GROUP(kind: string): string {
  const k = kind.toLowerCase();
  const groups: Array<[string, (k: string) => boolean]> = [
    ["mentions", (k) => k.includes("mention") || k.includes("comment") || k.includes("message")],
    ["documents", (k) => k.includes("rev") || k.includes("version") || k.includes("doc") || k.includes("review") || k.includes("ack") || k.includes("effective") || k.includes("retention") || k.includes("transmittal")],
    ["requests", (k) => k.includes("ticket") || k.includes("assign") || k.includes("approval") || k.includes("engineer") || k.includes("markup")],
    ["locks", (k) => k.includes("checkout") || k.includes("lock") || k.includes("hold") || k.includes("conflict")],
  ];
  for (const [key, match] of groups) if (match(k)) return key;
  return "other";
}
// COMPLIANCE_KINDS (app/api/cron/maintenance/route.ts:556-566) — the daily
// compliance digest's set.
const TODAY_COMPLIANCE = [
  "review_due", "owner_behind", "ack_requested", "ack_overdue", "ack_unsatisfiable", "retention_eligible",
  "access_recert_due", "effective_now", "review_requested", "review_overdue", "review_complete",
  "review_alternate_activated", "deletion_requested", "doc_superseded", "review_invalidated",
];
/** The bell's KIND_ICON, parsed from the component. */
const bellIconMap = (): Record<string, string> => {
  const s = src("components/notifications/NotificationBell.tsx");
  const m = s.match(/const KIND_ICON[^{]*\{([\s\S]*?)\n\};/);
  if (!m) throw new Error("KIND_ICON not found");
  return Object.fromEntries([...m[1].matchAll(/^\s+(\w+):\s*(\w+),/gm)].map((x) => [x[1], x[2]]));
};
/** The cron's COMPLIANCE_KINDS, parsed from the route. */
const cronComplianceKinds = (): string[] => {
  const s = src("app/api/cron/maintenance/route.ts").replace(/\/\/[^\n]*/g, "");
  const m = s.match(/const COMPLIANCE_KINDS = \[([\s\S]*?)\];/);
  if (!m) throw new Error("COMPLIANCE_KINDS not found");
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
};

let host: HTMLDivElement;
let root: Root;
// every committed render's hook value, recorded from an effect
const seen: Array<ReturnType<typeof useTicketNotifications>> = [];
function Probe() {
  const v = useTicketNotifications();
  React.useEffect(() => { seen.push(v); });
  return null;
}
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const row = (kind: string, i: number) => ({
  id: `n${i}`, orgId: "o1", userId: "u1", kind, title: `t ${kind}`, body: null, link: `/x/${i}`,
  resourceType: "document", resourceId: `doc-${i}`, actorUserId: null, actorName: null, metadata: null,
  readAt: null, createdAt: `2026-10-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
});
const mount = async (kinds: string[]) => {
  fixture.rows = kinds.map(row);
  await act(async () => { root.render(React.createElement(Probe)); });
  await flush();
  return seen[seen.length - 1];
};
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  seen.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("TODAY — the classification on b9cdfdc, pinned before the registry", () => {
  it("the union is the 50 kinds the map is pinned for", () => {
    expect(unionKinds().sort()).toEqual(Object.keys(TODAY_SECTION).sort());
  });

  it("sectionForKind: every union member resolves where it did", () => {
    for (const k of Object.keys(TODAY_SECTION)) {
      expect(sectionForKind(k as never), k).toBe(TODAY_SECTION[k]);
    }
    for (const k of TODAY_OFF_UNION) expect(sectionForKind(k as never), k).toBe("other");
  });

  it("the hook: one row of every written kind — per-section totals, action flags and counts", async () => {
    const kinds = [...Object.keys(TODAY_SECTION), ...TODAY_OFF_UNION];
    const r = await mount(kinds);
    expect(r.items).toHaveLength(kinds.length);
    for (const it of r.items) {
      expect(it.section, String(it.kind)).toBe(TODAY_SECTION[String(it.kind)] ?? "other");
      expect(it.actionRequired, String(it.kind)).toBe(TODAY_ACTION.has(String(it.kind)));
    }
    const tally = (s: string) => kinds.filter((k) => (TODAY_SECTION[k] ?? "other") === s).length;
    expect(r.sectionCounts).toEqual({
      requests: { total: tally("requests"), actionRequired: 0 },
      scratchpad: { total: tally("scratchpad"), actionRequired: 0 },
      documents: { total: tally("documents"), actionRequired: 0 },
      projects: { total: tally("projects"), actionRequired: 0 },
      other: { total: tally("other"), actionRequired: 0 },
    });
    expect(r.sectionCounts.documents.total).toBe(12);
    expect(r.sectionCounts.projects.total).toBe(2);
    expect(r.sectionCounts.requests.total).toBe(5);
    expect(r.count).toBe(kinds.length);
    // ticket-only counters: no tickets in the fixture
    expect(r.actionRequiredCount).toBe(0);
    expect(r.unreadCount).toBe(0);
  });
});

describe("TODAY — the other hand-maintained classifiers (TAX-5), pinned before the registry", () => {
  it("the bell's icon map is the table above", () => {
    expect(bellIconMap()).toEqual(TODAY_BELL_ICON);
  });
  it("the feed's visual and group predicates are the verbatim copies above", () => {
    const feed = src("components/cockpit/AttentionFeed.tsx");
    for (const line of [
      'if (k.includes("reminder")) return { Icon: Bell, tone: "amber" };',
      'if (k.includes("mention")) return { Icon: AtSign, tone: "violet" };',
      'if (k.includes("comment") || k.includes("message")) return { Icon: MessageSquare, tone: "blue" };',
      'if (k.includes("conflict")) return { Icon: AlertTriangle, tone: "amber" };',
      'if (k.includes("checkout") || k.includes("lock")) return { Icon: Lock, tone: "indigo" };',
      'if (k.includes("markup")) return { Icon: FileSignature, tone: "violet" };',
      'if (k.includes("hold")) return { Icon: AlertOctagon, tone: "rose" };',
      'if (k.includes("milestone")) return { Icon: Flag, tone: "emerald" };',
      'if (k.includes("rev") || k.includes("revision") || k.includes("version")) return { Icon: GitBranch, tone: "blue" };',
      'if (k.includes("transmittal")) return { Icon: Send, tone: "blue" };',
      'if (k.includes("approval") || k.includes("request") || k.includes("assign")) return { Icon: Briefcase, tone: "orange" };',
      'if (k.includes("equipment") || k.includes("asset")) return { Icon: Layers, tone: "amber" };',
      'return { Icon: Bell, tone: "slate" };',
      '{ key: "mentions", label: "Mentions & comments", match: (k) => k.includes("mention") || k.includes("comment") || k.includes("message") },',
      '{ key: "documents", label: "Documents & revisions", match: (k) => k.includes("rev") || k.includes("version") || k.includes("doc") || k.includes("review") || k.includes("ack") || k.includes("effective") || k.includes("retention") || k.includes("transmittal") },',
      '{ key: "requests", label: "Requests", match: (k) => k.includes("ticket") || k.includes("assign") || k.includes("approval") || k.includes("engineer") || k.includes("markup") },',
      '{ key: "locks", label: "Checkouts & holds", match: (k) => k.includes("checkout") || k.includes("lock") || k.includes("hold") || k.includes("conflict") },',
    ]) expect(feed, line).toContain(line);
    // two spot checks of the copies themselves (the substring accidents included)
    expect(TODAY_FEED("member_revoked")).toEqual({ icon: "GitBranch", tone: "blue" });
    expect(TODAY_GROUP("checkout_message")).toBe("mentions");
  });
  it("the cron's compliance set is the table above", () => {
    expect(cronComplianceKinds()).toEqual(TODAY_COMPLIANCE);
  });
  it("the toast warns for exactly checkout_conflict and hold_opened", () => {
    expect(src("components/providers/NotificationListener.tsx"))
      .toContain('const isError = row.kind === "checkout_conflict" || row.kind === "hold_opened";');
  });
});
