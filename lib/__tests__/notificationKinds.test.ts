// @vitest-environment jsdom
//
// notifications Round G, N2 KIND-REGISTRY — the kind → section / action /
// icon / group / compliance classification (lib/notificationKinds.ts
// KIND_META), pinned against what it replaced.
//
// REGRESSION FIRST. The TODAY tables are what the code did on b9cdfdc, read
// from the source before the registry changed anything (committed first,
// e595cf5). Every kind lands where it did and counts as it did, EXCEPT the
// departures listed below — each names the record that calls the old
// placement wrong (PROD-1 / TRAIL-2 / DELIV-3 / TAX-2 / OS-12 / RT-6, TRAIL-5,
// PROD-8 / OS-7 / NEDGE-13, PROD-10 / TAX-11) or the decision (DEC-81).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const fixture = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  tickets: [] as Array<Record<string, unknown>>,
  // one identity for the whole run: a fresh array per render would re-run
  // the hook's fetch effect on every render
  role: { roles: ["Viewer"], activeOrgId: "o1", uid: "u1", membershipState: "member" },
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): Record<string, unknown> => {
    const result = { data: table === "tickets" ? fixture.tickets : [], error: null, count: 0 };
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "in", "order", "limit", "is", "or", "gte"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: null, error: null });
    q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, ko);
    return q;
  };
  const channel = { on: () => channel, subscribe: () => channel };
  return {
    supabase: {
      from: (table: string) => chain(table),
      channel: () => channel,
      removeChannel: () => {},
    },
  };
});
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => fixture.role,
}));
vi.mock("@/lib/capabilityPolicy", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadCapabilityPolicy: async () => undefined,
}));
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
import {
  KIND_META, NOTIFICATION_KINDS, NOTIFICATION_SECTIONS, isNotificationKind, kindMeta,
} from "@/lib/notificationKinds";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

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

// ── THE DEPARTURES — every change from TODAY, each with its reason ───────────
// Kinds no longer declared: zero producers anywhere (PROD-8 / OS-7 / NEDGE-13).
const RETIRED = ["task_overdue_digest", "morning_digest", "task_nudge", "task_reminder"];
// Kinds now declared: they were WRITTEN on b9cdfdc by raw inserts outside any
// union (PROD-10 / TAX-11 for the storage three; the census below found the
// other two).
const ADDED = TODAY_OFF_UNION;
// Section: TODAY's 'other' becomes bell-only (null) — the same thing to a user
// (no rail row counted it; the header bell did) — except the kinds the records
// name as misfiled, which now badge a row.
const SECTION_DEPARTURES: Record<string, { to: "documents" | "projects"; why: string }> = Object.fromEntries([
  ...[
    "revision_published_over_checkout", "library_doc_added", "library_doc_revised", "review_due", "owner_assigned",
    "owner_behind", "deletion_requested", "ack_requested", "ack_complete", "ack_overdue", "ack_unsatisfiable",
    "review_requested", "review_signed", "review_invalidated", "review_complete", "review_overdue",
    "review_alternate_activated", "effective_now", "retention_eligible", "legal_hold_placed", "legal_hold_released",
    "access_recert_due",
  ].map((k) => [k, { to: "documents" as const, why: "document-scoped: TRAIL-2 dw1 / PROD-1 / DELIV-3 / TAX-2 / OS-12 / RT-6" }]),
  ["project_comment", { to: "projects" as const, why: "a comment on a project: TRAIL-2 dw1" }],
]);
// Bell-only by decision (DEC-81 §1): TODAY 'other', and kept off every
// rail row — the header bell owns them. A new bell-only kind must be added
// here deliberately.
const BELL_ONLY = [
  "orchestrator_message", "security_export", "member_revoked", "library_unowned",
  "storage_alert", "storage_platform_r2", "storage_platform_db", "ai_cap_changed", "transmittal_unstampable",
];
// actionRequired: exactly TODAY_ACTION — no departure (DEC-81 §2). The
// plan's default would add the PSM obligations, but an action row stays red,
// pulsing and in the Action count until it is read, and nothing marks a PSM
// row read when the obligation is met; they flip with the change that clears
// them on discharge. Pinned FYI here so the flip is deliberate.
const ACTION_ADDED: string[] = [];
const PSM_OBLIGATIONS_FYI_UNTIL_CLEARED = [
  "ack_requested", "review_requested", "review_invalidated", "ack_overdue", "review_overdue", "access_recert_due", "effective_now",
];
// icon / tone / group departures from the predecessors.
const ICON_DEPARTURES: Record<string, { icon: string; why: string }> = {
  storage_alert: { icon: "HardDrive", why: "the bell's new entry for the storage kinds (the plan names it)" },
  storage_platform_r2: { icon: "HardDrive", why: "the bell's new entry for the storage kinds" },
  storage_platform_db: { icon: "Database", why: "the bell's new entry for the storage kinds" },
  member_revoked: { icon: "Bell", why: "the feed's GitBranch came from 'rev' inside 'revoked' — a substring accident" },
};
const TONE_DEPARTURES: Record<string, string> = { member_revoked: "slate" };
const GROUP_DEPARTURES: Record<string, string> = { member_revoked: "other" };

/** What a kind's section must be now: TODAY, with the departures applied. */
const expectedSection = (k: string): string | null => {
  if (RETIRED.includes(k)) return null; // a legacy row: bell-only, as its unrendered bucket was
  if (SECTION_DEPARTURES[k]) return SECTION_DEPARTURES[k].to;
  const today = TODAY_SECTION[k] ?? "other";
  return today === "other" ? null : today;
};
const expectedAction = (k: string): boolean => TODAY_ACTION.has(k) || ACTION_ADDED.includes(k);

// ── THE PRODUCER CENSUS ──────────────────────────────────────────────────────
// Every object literal under app/ lib/ components/ hooks/ shaped like a
// notification payload (kind + title + orgId|org_id), with its kind
// evaluated. A raw `.from("notifications").insert(` payload bypasses the
// NotificationKind type, so its kind must evaluate to literals here — this
// is the type check the compiler cannot do for it.
type Payload = { file: string; line: number; raw: boolean; kinds: string[] | "typed" };
const NOT_NOTIFICATIONS: Record<string, string> = {
  "lib/checklists.ts": "a checklist row's own kind (ChecklistKind)",
  "components/projects/QualityTab.tsx": "a checklist's kind",
  "lib/inAppNotifications.ts": "the typed sink itself (input.kind: NotificationKind) and its row mapper",
};
// Non-literal kinds at raw sites, resolved by reading the type that bounds them.
const RAW_RESOLVED: Record<string, { kinds: string[]; proof: [string, string] }> = {
  "app/api/tickets/workflow-action/route.ts|cls.inAppKind": {
    kinds: ["ticket_assigned", "ticket_status"],
    proof: ["lib/ticketTransitions.ts", 'inAppKind: "ticket_assigned" | "ticket_status";'],
  },
};
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "__tests__" && !n.startsWith(".")) walk(p); }
      else if (/\.tsx?$/.test(n) && !n.endsWith(".d.ts")) out.push(p);
    }
  };
  for (const d of ["app", "lib", "components", "hooks"]) walk(join(ROOT, d));
  return out;
}
const parse = (abs: string) =>
  ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, abs.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const propName = (p: ts.ObjectLiteralElementLike, sf: ts.SourceFile) =>
  ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? p.name.getText(sf) : null;
const literalUnion = (t: ts.TypeNode | undefined): string[] | null => {
  if (!t) return null;
  const parts = ts.isUnionTypeNode(t) ? [...t.types] : [t];
  const lits = parts.map((x) => (ts.isLiteralTypeNode(x) && ts.isStringLiteral(x.literal) ? x.literal.text : null));
  return lits.every((x) => x !== null) ? (lits as string[]) : null;
};
/** Resolve a name: a const in this file, a parameter typed as literals, or an
 *  `@/` import's exported const / function return type. */
function resolveName(name: string, sf: ts.SourceFile, depth = 0): string[] | null {
  let found: string[] | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) found = evalKind(n.initializer, sf, depth + 1);
    else if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.name.text === name) found = literalUnion(n.type);
    else if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = literalUnion(n.type);
    n.forEachChild(visit);
  };
  visit(sf);
  if (found || depth > 3) return found;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith("@/")) continue;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named) || !named.elements.some((e) => e.name.text === name)) continue;
    const base = join(ROOT, st.moduleSpecifier.text.slice(2));
    for (const ext of [".ts", ".tsx"]) {
      try { return resolveName(name, parse(base + ext), depth + 1); } catch { /* next */ }
    }
  }
  return null;
}
function evalKind(e: ts.Expression, sf: ts.SourceFile, depth = 0): string[] | null {
  if (ts.isStringLiteralLike(e)) return [e.text];
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return evalKind(e.expression, sf, depth);
  if (ts.isConditionalExpression(e)) {
    const a = evalKind(e.whenTrue, sf, depth), b = evalKind(e.whenFalse, sf, depth);
    return a && b ? [...a, ...b] : null;
  }
  if (ts.isIdentifier(e)) return resolveName(e.text, sf, depth);
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return resolveName(e.expression.text, sf, depth);
  return null; // a template literal, a property read, … — not enumerable here
}
const isNotificationsInsert = (call: ts.CallExpression): boolean => {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "insert") return false;
  let cur: ts.Expression = call.expression.expression;
  for (;;) {
    if (ts.isCallExpression(cur)) {
      const c = cur.expression;
      if (ts.isPropertyAccessExpression(c) && c.name.text === "from" && cur.arguments[0] && ts.isStringLiteralLike(cur.arguments[0])) {
        return cur.arguments[0].text === "notifications";
      }
      cur = ts.isPropertyAccessExpression(c) ? c.expression : c;
    } else if (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
    else return false;
  }
};
/** A `.from("notifications")` call (any client, any quote style). */
const isNotificationsFrom = (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "from"
  && !!n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text === "notifications";
/** One raw `.from("notifications").insert(…)` CALL — counted for itself, not
 *  through the payloads it carries: an insert whose rows come from a
 *  parameter or another file creates no payload here, and must still count
 *  (and fail `covered`). */
type InsertCall = { file: string; line: number; covered: boolean; arg: string };
/** A notifications builder that leaves its chain (`const t = sb.from(
 *  "notifications")`, or passed as an argument): an insert through it would
 *  be invisible to the census, so none may exist. */
type EscapedBuilder = { file: string; line: number };
let censusCache: { payloads: Payload[]; inserts: InsertCall[]; escaped: EscapedBuilder[] } | null = null;
function scan() {
  if (censusCache) return censusCache;
  const out: Payload[] = [];
  const inserts: InsertCall[] = [];
  const escaped: EscapedBuilder[] = [];
  for (const abs of sourceFiles()) {
    const file = relative(ROOT, abs);
    if (NOT_NOTIFICATIONS[file]) continue;
    const text = readFileSync(abs, "utf8");
    if (!text.includes("kind") && !text.includes("notifications")) continue;
    const sf = parse(abs);
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
    // raw sites: each insert call, with the nodes its payloads may sit in —
    // its arguments, and the initializer of a variable an argument names
    const calls: Array<{ call: ts.CallExpression; nodes: Set<ts.Node>; vars: Set<string>; covered: boolean }> = [];
    const findRaw = (n: ts.Node) => {
      if (ts.isCallExpression(n) && isNotificationsInsert(n)) {
        const nodes = new Set<ts.Node>(), vars = new Set<string>();
        for (const a of n.arguments) { nodes.add(a); if (ts.isIdentifier(a)) vars.add(a.text); }
        calls.push({ call: n, nodes, vars, covered: false });
      }
      if (isNotificationsFrom(n) && !ts.isPropertyAccessExpression(n.parent)) escaped.push({ file, line: lineOf(n) });
      n.forEachChild(findRaw);
    };
    findRaw(sf);
    const markVars = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        for (const c of calls) if (c.vars.has(n.name.text)) c.nodes.add(n.initializer);
      }
      n.forEachChild(markVars);
    };
    markVars(sf);
    const within = (n: ts.Node, nodes: Set<ts.Node>) => { for (let c: ts.Node | undefined = n; c; c = c.parent) if (nodes.has(c)) return true; return false; };
    const visit = (n: ts.Node) => {
      if (ts.isObjectLiteralExpression(n)) {
        const names = new Set(n.properties.map((p) => propName(p, sf)));
        if (names.has("kind") && names.has("title") && (names.has("orgId") || names.has("org_id"))) {
          const kp = n.properties.find((p) => propName(p, sf) === "kind")!;
          const expr = ts.isShorthandPropertyAssignment(kp) ? kp.name : (kp as ts.PropertyAssignment).initializer;
          const owners = calls.filter((c) => within(n, c.nodes));
          const raw = owners.length > 0;
          let kinds: string[] | "typed" | null = evalKind(expr, sf);
          if (!kinds && raw) kinds = RAW_RESOLVED[`${file}|${expr.getText(sf)}`]?.kinds ?? null;
          if (!kinds && !raw) kinds = "typed"; // a typed sink (notify / notifyMany / emit): the compiler checks it
          // the insert this payload rides is covered: its kind was evaluated
          if (raw && kinds !== null) for (const c of owners) c.covered = true;
          out.push({ file, line: lineOf(n), raw, kinds: kinds ?? ["<unresolvable: " + expr.getText(sf) + ">"] });
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
    for (const c of calls) inserts.push({ file, line: lineOf(c.call), covered: c.covered, arg: c.call.arguments.map((a) => a.getText(sf).slice(0, 60)).join(", ") });
  }
  censusCache = { payloads: out, inserts, escaped };
  return censusCache;
}
const census = (): Payload[] => scan().payloads;
// The raw `.from("notifications").insert(` CALLS left outside notify(), by
// file — each in a file another package owns (DEC-31: a pointer, not an
// edit). A NEW raw insert call fails here, whatever its rows are: route it
// through notify() / notifyMany() / emit(). This is a ratchet on the eleven,
// not the ban NEDGE-13 dw3 asks for — that is met when they move to notify()
// with their owners (TAX-11). N5's notification_kinds allowlist backs the
// kind check up in the database.
const RAW_SITES: Record<string, number> = {
  "app/api/ai/usage/route.ts": 1,                 // ai_cap_changed — intelligence
  "app/api/cron/maintenance/route.ts": 1,         // checkout_released escalation — N6 / DC
  "app/api/tickets/comment/route.ts": 1,          // ticket_comment / ticket_mention — drafting-flow, N6
  "app/api/tickets/workflow-action/route.ts": 2,  // ticket_comment, ticket_assigned / ticket_status — drafting-flow, N6
  "app/api/transmittal/route.ts": 2,              // transmittal_unstampable, ack_complete — document-control, N9
  "lib/exportAlerts.ts": 1,                       // security_export — admin-and-org (moved here from app/api/data-export/run/route.ts by A&O P3; the service role)
  "lib/intakeRateLimit.ts": 1,                    // doc_superseded / review_requested digest — projects
  "lib/orchestrator/tools.ts": 1,                 // orchestrator_message — intelligence
  "lib/projects.ts": 1,                           // checkout_released auto-release — document-control, N9
};

// ── GAP-201 acceptance 1: an unclassified kind is a BUILD error ─────────────
/** Type-check the hook (and, through it, the registry) with one extra member
 *  appended to the union, in memory. */
function typeErrorsWithExtraKind(extra: string | null): string[] {
  const cfg = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
  const options = { ...parsed.options, noEmit: true };
  const target = join(ROOT, "lib/inAppNotifications.ts");
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang, onError, create) => {
    if (extra && f === target) {
      const text = readFileSync(target, "utf8").replace('| "transmittal_unstampable";', `| "transmittal_unstampable" | "${extra}";`);
      if (!text.includes(extra)) throw new Error("the probe kind was not appended — the union's last member moved");
      return ts.createSourceFile(f, text, lang);
    }
    return original(f, lang, onError, create);
  };
  const program = ts.createProgram({ rootNames: [join(ROOT, "hooks/useTicketNotifications.ts")], options, host });
  return ts.getPreEmitDiagnostics(program)
    .filter((d) => d.file && !d.file.fileName.includes("node_modules"))
    .map((d) => `${relative(ROOT, d.file!.fileName)}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

// ── the hook, rendered ───────────────────────────────────────────────────────
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
const row = (kind: string, i: number, resourceId = `doc-${i}`) => ({
  id: `n${i}`, orgId: "o1", userId: "u1", kind, title: `t ${kind}`, body: null, link: `/x/${i}`,
  resourceType: "document", resourceId, actorUserId: null, actorName: null, metadata: null,
  readAt: null, createdAt: `2026-10-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
});
const mount = async (rows: Array<Record<string, unknown>>, tickets: Array<Record<string, unknown>> = []) => {
  fixture.rows = rows;
  fixture.tickets = tickets;
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

describe("the union (PROD-8 / OS-7 / NEDGE-13 retired; PROD-10 / TAX-11 added)", () => {
  it("is TODAY's union, minus the four retired kinds, plus the five that were written outside it", () => {
    const today = Object.keys(TODAY_SECTION);
    expect(unionKinds().sort()).toEqual([...today.filter((k) => !RETIRED.includes(k)), ...ADDED].sort());
  });

  it("KIND_META classifies exactly the union — no kind missing, none extra", () => {
    expect(Object.keys(KIND_META).sort()).toEqual(unionKinds().sort());
    expect([...NOTIFICATION_KINDS].sort()).toEqual(unionKinds().sort());
  });

  it("a retired kind has no producer anywhere — app, lib, components, hooks, scripts, types, public, SQL", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "__tests__" && !n.startsWith(".")) walk(p); continue; }
        if (!/\.(tsx?|m?js|sql|json)$/.test(n)) continue;
        // comments are not producers (the union records why these left)
        const text = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/--[^\n]*/g, "");
        for (const k of RETIRED) if (text.includes(k)) hits.push(`${relative(ROOT, p)}: ${k}`);
      }
    };
    for (const d of ["app", "lib", "components", "hooks", "scripts", "types", "public", "supabase"]) {
      try { statSync(join(ROOT, d)); } catch { continue; }
      walk(join(ROOT, d));
    }
    expect(hits).toEqual([]);
  });

  it("a legacy row of a retired kind is bell-only and FYI — where its unrendered bucket left it", () => {
    for (const k of RETIRED) {
      expect(isNotificationKind(k), k).toBe(false);
      expect(kindMeta(k), k).toBeNull();
      expect(sectionForKind(k as never), k).toBeNull();
    }
  });

  it("GAP-201 acceptance 1: a kind added without a KIND_META entry fails the type check (never guard + satisfies)", () => {
    const clean = typeErrorsWithExtraKind(null);
    expect(clean).toEqual([]);
    const probe = typeErrorsWithExtraKind("zz_unclassified_probe");
    expect(probe.some((e) => e.startsWith("hooks/useTicketNotifications.ts") && /"zz_unclassified_probe"' is not assignable to type 'never'/.test(e)), probe.join("\n")).toBe(true);
    expect(probe.some((e) => e.startsWith("lib/notificationKinds.ts") && /does not satisfy the expected type 'Record<NotificationKind, KindMeta>'/.test(e)), probe.join("\n")).toBe(true);
  }, 120_000);
});

describe("sections — every kind where it was, except the kinds the records name", () => {
  it("sectionForKind and KIND_META agree with TODAY + the departures, kind by kind", () => {
    for (const k of unionKinds()) {
      expect(sectionForKind(k as never), k).toBe(expectedSection(k));
      expect(KIND_META[k as keyof typeof KIND_META].section, k).toBe(expectedSection(k));
    }
    expect(sectionForKind("ticket")).toBe("requests");
  });

  it("every kind that badged a row on b9cdfdc badges the same row now", () => {
    for (const [k, s] of Object.entries(TODAY_SECTION)) {
      if (s === "documents" || s === "projects" || s === "requests") expect(sectionForKind(k as never), k).toBe(s);
    }
  });

  it("the sections are exactly the rows the Sidebar badges — nothing is tallied and thrown away", () => {
    const sidebar = src("components/navigation/Sidebar.tsx");
    const badged = [...sidebar.matchAll(/badgeOf\(sectionCounts\.(\w+)\)/g)].map((m) => m[1]);
    expect([...new Set(badged)].sort()).toEqual([...NOTIFICATION_SECTIONS].sort());
    for (const k of unionKinds()) {
      const s = KIND_META[k as keyof typeof KIND_META].section;
      expect(s === null || (NOTIFICATION_SECTIONS as readonly string[]).includes(s), k).toBe(true);
    }
  });

  it("'other' is gone: the bell-only kinds are exactly the deliberate list", () => {
    const bellOnly = unionKinds().filter((k) => KIND_META[k as keyof typeof KIND_META].section === null);
    expect(bellOnly.sort()).toEqual([...BELL_ONLY].sort());
  });

  it("TAX-2 dw1: every compliance-digest kind badges the Documents row", () => {
    for (const k of TODAY_COMPLIANCE) expect(sectionForKind(k as never), k).toBe("documents");
  });
});

describe("action, compliance, icon, tone, group — the other classifiers, in one table", () => {
  it("actionRequired: exactly the conflict class, as before (DEC-81 §2)", () => {
    for (const k of unionKinds()) expect(KIND_META[k as keyof typeof KIND_META].actionRequired, k).toBe(expectedAction(k));
    expect(unionKinds().filter((k) => KIND_META[k as keyof typeof KIND_META].actionRequired).sort()).toEqual([...TODAY_ACTION].sort());
  });

  it("the PSM obligations stay FYI until their rows clear on discharge — a met obligation must not keep the rail red", () => {
    // ack_overdue / review_overdue are escalation copies to the owner and
    // controllers, pinned FYI here with the obligations. No registry rule
    // makes an escalation copy FYI: the conflict class's controller copies
    // (escalateStaleCheckouts' checkout_released, announceBranchOpened's
    // branch_open) are actions, and nothing clears them either — the TRAIL-9
    // class (N4), DEC-81 §2.
    for (const k of PSM_OBLIGATIONS_FYI_UNTIL_CLEARED) {
      expect(isNotificationKind(k), k).toBe(true);
      expect(KIND_META[k as keyof typeof KIND_META].actionRequired, k).toBe(false);
    }
    // nothing outside the hook's ticket reconcile marks these rows read: the
    // producers never write read_at (if one starts to, revisit DEC-81 §2)
    for (const f of ["lib/acknowledgments.ts", "lib/reviewControl.ts", "lib/effectiveDate.ts", "lib/accessRecert.ts"]) {
      expect(src(f), f).not.toMatch(/read_at/);
    }
  });

  it("compliance is the cron's COMPLIANCE_KINDS, unchanged", () => {
    expect(cronComplianceKinds()).toEqual(TODAY_COMPLIANCE);
    const flagged = unionKinds().filter((k) => KIND_META[k as keyof typeof KIND_META].compliance);
    expect(flagged.sort()).toEqual([...TODAY_COMPLIANCE].sort());
  });

  it("icon: every kind has one — the bell's where it had one, else the feed's, except the named departures", () => {
    for (const k of unionKinds()) {
      const want = ICON_DEPARTURES[k]?.icon ?? TODAY_BELL_ICON[k] ?? TODAY_FEED(k).icon;
      const got = KIND_META[k as keyof typeof KIND_META].icon;
      expect(got, k).toBeTruthy();
      expect(got, k).toBe(want);
    }
  });

  it("tone and group are what the feed's predicates produced, except the named departures", () => {
    for (const k of unionKinds()) {
      const m = KIND_META[k as keyof typeof KIND_META];
      expect(m.tone, k).toBe(TONE_DEPARTURES[k] ?? TODAY_FEED(k).tone);
      expect(m.group, k).toBe(GROUP_DEPARTURES[k] ?? TODAY_GROUP(k));
    }
  });

  it("the bell's icon map: the dead task_overdue_digest entry gone, the storage kinds added, and every entry agrees with KIND_META", () => {
    const want: Record<string, string> = { ...TODAY_BELL_ICON };
    delete want.task_overdue_digest;
    for (const k of ["storage_alert", "storage_platform_r2", "storage_platform_db"]) want[k] = ICON_DEPARTURES[k].icon;
    const bell = bellIconMap();
    expect(bell).toEqual(want);
    for (const [k, icon] of Object.entries(bell)) {
      if (k === "ticket") continue; // the ticket pseudo-kind is not a notification kind
      expect(isNotificationKind(k), k).toBe(true);
      expect(KIND_META[k as keyof typeof KIND_META].icon, k).toBe(icon);
    }
  });

  it("OS-7 dw3 as a ratchet: a kind outside the named gap list draws its KIND_META icon in the bell, never the fallback", () => {
    // The kinds the bell has no entry for today (they draw the fallback Bell
    // there; their feed icon is KIND_META's). N3 derives KIND_ICON from
    // KIND_META and empties this list; until then a NEW kind — the nudge's
    // (N12) included — must get a bell entry, or be added here on purpose.
    const BELL_ICON_GAPS = [
      "library_doc_added", "library_doc_revised", "review_due", "owner_assigned", "owner_behind", "deletion_requested",
      "ack_requested", "ack_complete", "ack_overdue", "ack_unsatisfiable", "review_requested", "review_signed",
      "review_invalidated", "review_complete", "review_overdue", "review_alternate_activated", "effective_now",
      "retention_eligible", "legal_hold_placed", "legal_hold_released", "access_recert_due", "security_export",
      "member_revoked", "library_unowned", "ai_cap_changed", "transmittal_unstampable",
    ];
    const bell = bellIconMap();
    const missing: string[] = [];
    for (const k of NOTIFICATION_KINDS) {
      if (BELL_ICON_GAPS.includes(k)) continue;
      if (bell[k] !== KIND_META[k].icon) missing.push(`${k}: bell ${bell[k] ?? "(fallback Bell)"} vs KIND_META ${KIND_META[k].icon}`);
    }
    expect(missing).toEqual([]);
    for (const k of BELL_ICON_GAPS) expect(isNotificationKind(k), k).toBe(true);
  });

  it("the feed's predicates are still the verbatim copies (N3 derives them from KIND_META next)", () => {
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
    expect(TODAY_FEED("member_revoked")).toEqual({ icon: "GitBranch", tone: "blue" });
    expect(TODAY_GROUP("checkout_message")).toBe("mentions");
  });

  it("the toast still warns for exactly checkout_conflict and hold_opened (N3 derives it)", () => {
    expect(src("components/providers/NotificationListener.tsx"))
      .toContain('const isError = row.kind === "checkout_conflict" || row.kind === "hold_opened";');
  });
});

describe("the hook — one row of every kind written on b9cdfdc", () => {
  const kinds = [...Object.keys(TODAY_SECTION), ...TODAY_OFF_UNION];

  it("every row still renders; each lands where TODAY + the departures say, with its action flag", async () => {
    const r = await mount(kinds.map((k, i) => row(k, i)));
    expect(r.items).toHaveLength(kinds.length);
    expect(r.count).toBe(kinds.length);
    for (const it of r.items) {
      expect(it.section, String(it.kind)).toBe(expectedSection(String(it.kind)));
      expect(it.actionRequired, String(it.kind)).toBe(expectedAction(String(it.kind)));
    }
  });

  it("the per-row badges: the rows that counted before count the same kinds, plus the named ones", async () => {
    const r = await mount(kinds.map((k, i) => row(k, i)));
    expect(Object.keys(r.sectionCounts).sort()).toEqual([...NOTIFICATION_SECTIONS].sort());
    const total = (s: string) => kinds.filter((k) => expectedSection(k) === s).length;
    const action = (s: string) => kinds.filter((k) => expectedSection(k) === s && expectedAction(k)).length;
    expect(r.sectionCounts).toEqual({
      requests: { total: total("requests"), actionRequired: action("requests") },
      documents: { total: total("documents"), actionRequired: action("documents") },
      projects: { total: total("projects"), actionRequired: action("projects") },
    });
    // TODAY: requests 5, documents 12, projects 2 — the same plus the named
    // moves; the four conflict rows are now red on Documents (TRAIL-5)
    expect(r.sectionCounts.requests).toEqual({ total: 5, actionRequired: 0 });
    expect(r.sectionCounts.documents).toEqual({ total: 12 + 22, actionRequired: 4 });
    expect(r.sectionCounts.projects).toEqual({ total: 2 + 1, actionRequired: 0 });
  });

  it("TAX-7 / TRAIL-13: counts are computed once — action + activity = all — and actionRequiredCount is counts.action", async () => {
    const r = await mount(kinds.map((k, i) => row(k, i)));
    expect(r.counts).toEqual({ all: kinds.length, action: 4, activity: kinds.length - 4, notifications: kinds.length });
    expect(r.actionRequiredCount).toBe(r.counts.action);
    expect(r.unreadCount).toBe(r.counts.activity);
    expect("totalNotifications" in r).toBe(false);
  });

  it("TRAIL-5: a checkout_conflict row turns the Documents badge red", async () => {
    const r = await mount([row("checkout_conflict", 1)]);
    expect(r.sectionCounts.documents).toEqual({ total: 1, actionRequired: 1 });
  });

  it("TRAIL-13: tickets and notifications are counted together — the Deck's Action stat equals the Center's Action tab", async () => {
    const ticket = {
      id: "t1", org_id: "o1", ticket_id: "DR-1", title: "Pump", status: "PENDING_ASSIGNMENT", requester_id: "u1",
      unread_by: ["u1"], created_at: "2026-10-01T00:00:00Z", last_modified: "2026-10-01T00:00:00Z",
    };
    const r = await mount([
      row("checkout_conflict", 1),
      row("library_doc_added", 2),
      row("ticket_comment", 3, "t1"), // about the ticket in the feed: folds into it, as before
    ], [ticket]);
    expect(r.items.map((i) => i.key).sort()).toEqual(["notif:n1", "notif:n2", "ticket:t1"]);
    const ticketItem = r.items.find((i) => i.key === "ticket:t1")!;
    expect(ticketItem.actionRequired).toBe(false); // an unread ticket the requester need not act on
    expect(r.counts).toEqual({ all: 3, action: 1, activity: 2, notifications: 2 });
    expect(r.actionRequiredCount).toBe(r.items.filter((i) => i.actionRequired).length);
    expect(r.sectionCounts.requests).toEqual({ total: 1, actionRequired: 0 });
    expect(r.sectionCounts.documents).toEqual({ total: 2, actionRequired: 1 });
  });
});

describe("the surfaces read the hook's counts (TAX-7)", () => {
  it("the filter key matches its label: 'activity', not 'unread'", () => {
    const feed = src("components/cockpit/AttentionFeed.tsx");
    expect(feed).toContain('export type AttnFilter = "all" | "action" | "activity";');
    expect(feed).toContain('{ key: "activity", label: "Activity", n: counts.activity },');
    expect(feed).toContain("counts: AttentionCounts;");
    expect(feed).not.toMatch(/key: "unread"|counts\.unread/);
  });

  it("'Mark all read' is offered whenever the feed holds a notification row — an action-only feed included, on any filter (the bell's rule)", async () => {
    const { AttentionFeed } = await import("@/components/cockpit/AttentionFeed");
    const markAllShown = (props: Parameters<typeof AttentionFeed>[0]) => {
      act(() => { root.render(React.createElement(AttentionFeed, props)); });
      return !!host.querySelector('button[title="Mark all notifications read"]');
    };
    const base = { filter: "all" as const, onFilter: () => {}, onMarkRead: () => {}, onMarkAll: () => {}, markingAll: false };
    // only action rows (on b9cdfdc's rule, counts.unread was 0 here and the
    // button was hidden while markAllRead would have cleared them)
    const actionOnly = await mount([row("checkout_conflict", 1), row("branch_open", 2)]);
    expect(actionOnly.counts).toEqual({ all: 2, action: 2, activity: 0, notifications: 2 });
    expect(markAllShown({ ...base, items: actionOnly.items, counts: actionOnly.counts })).toBe(true);
    // a filter showing none of them does not hide it: Mark all read clears them all
    expect(markAllShown({ ...base, filter: "activity", items: [], counts: actionOnly.counts })).toBe(true);
    // nothing it could clear (only an unread ticket — tickets.unread_by is not a notification row): not offered
    const ticket = {
      id: "t9", org_id: "o1", ticket_id: "DR-9", title: "Valve", status: "PENDING_ASSIGNMENT", requester_id: "u1",
      unread_by: ["u1"], created_at: "2026-10-01T00:00:00Z", last_modified: "2026-10-01T00:00:00Z",
    };
    const ticketOnly = await mount([], [ticket]);
    expect(ticketOnly.counts).toEqual({ all: 1, action: 0, activity: 1, notifications: 0 });
    expect(markAllShown({ ...base, items: ticketOnly.items, counts: ticketOnly.counts })).toBe(false);
    expect(src("components/cockpit/AttentionFeed.tsx")).toContain("{counts.notifications > 0 && (");
  });

  it("the Center, the cockpit and the widget take counts from the hook and recount nothing", () => {
    for (const f of ["components/notifications/NotificationCenter.tsx", "app/(protected)/inbox/page.tsx", "components/dashboard/widgets.tsx"]) {
      const s = src(f);
      expect(s, f).not.toMatch(/\.filter\(\(i\) => !?i\.actionRequired\)\.length/);
      expect(s, f).not.toMatch(/=== "unread"/);
      expect(s, f).toMatch(/counts(: attnCounts)?,[\s\S]*?\} = useTicketNotifications\(\)/);
    }
  });
});

describe("the producer census — every written kind is declared and classified", { timeout: 120_000 }, () => {
  it("every payload's kind resolves, and every resolved kind is a declared, classified kind", () => {
    const bad: string[] = [];
    for (const p of census()) {
      if (p.kinds === "typed") continue;
      for (const k of p.kinds) if (!isNotificationKind(k)) bad.push(`${p.file}:${p.line} ${k}${p.raw ? " (raw insert)" : ""}`);
    }
    expect(bad).toEqual([]);
  });

  it("no new raw notifications insert: the insert CALLS left are pinned, by file, each in a file another package owns", () => {
    const { inserts, escaped } = scan();
    const byFile: Record<string, number> = {};
    for (const c of inserts) byFile[c.file] = (byFile[c.file] ?? 0) + 1;
    expect(byFile).toEqual(RAW_SITES);
    expect(byFile["lib/storageAlerts.ts"]).toBeUndefined();
    expect(byFile["lib/storageUsage.ts"]).toBeUndefined();
    // every pinned call's rows are a payload the census evaluated — an
    // insert(rows) whose rows come from a parameter or another file fails here
    expect(inserts.filter((c) => !c.covered).map((c) => `${c.file}:${c.line} insert(${c.arg})`)).toEqual([]);
    // and no notifications builder leaves its chain, where an insert would hide
    expect(escaped.map((e) => `${e.file}:${e.line}`)).toEqual([]);
    for (const p of census()) if (p.raw) expect(p.kinds, `${p.file}:${p.line}`).not.toBe("typed");
    for (const { proof: [file, text] } of Object.values(RAW_RESOLVED)) expect(src(file), file).toContain(text);
  });

  it("the census counts an insert call whose rows it cannot see — the drift it exists to stop (probe)", () => {
    // the reviewer's case: rows built in another file and handed to a helper
    const probe = ts.createSourceFile("probe.ts", [
      "async function bell(db: any, rows: unknown[]) { await db.from('notifications').insert(rows); }",
      "const t = sb.from(\"notifications\"); void t;",
    ].join("\n"), ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    const builders: ts.CallExpression[] = [];
    const walk = (n: ts.Node) => {
      if (ts.isCallExpression(n) && isNotificationsInsert(n)) calls.push(n);
      if (isNotificationsFrom(n) && !ts.isPropertyAccessExpression(n.parent)) builders.push(n);
      n.forEachChild(walk);
    };
    walk(probe);
    expect(calls).toHaveLength(1);    // counted as a site: RAW_SITES would no longer match
    expect(ts.isIdentifier(calls[0].arguments[0]) && calls[0].arguments[0].text).toBe("rows"); // a parameter: no payload covers it
    expect(builders).toHaveLength(1); // the escaped builder is caught
  });

  it("the census sees through constants, parameters and branches (spot checks)", () => {
    const kindsAt = (file: string) => census().filter((p) => p.file === file).flatMap((p) => (p.kinds === "typed" ? [] : p.kinds));
    // PROD-8: the checkout thread now writes its own three kinds
    expect(new Set(kindsAt("lib/activityThread.ts"))).toEqual(new Set(["checkout_handoff", "markup_request", "checkout_message"]));
    // a typed parameter: notifyHold(kind: "legal_hold_placed" | "legal_hold_released")
    expect(kindsAt("lib/retention.ts")).toEqual(expect.arrayContaining(["legal_hold_placed", "legal_hold_released"]));
    // raw inserts, through a module constant and a literal
    expect(new Set(kindsAt("app/api/transmittal/route.ts"))).toEqual(new Set(["transmittal_unstampable", "ack_complete"]));
    expect(kindsAt("app/api/ai/usage/route.ts")).toEqual(["ai_cap_changed"]);
    // raw, through a function's literal return type and a variable the insert is given
    expect(new Set(kindsAt("lib/intakeRateLimit.ts"))).toEqual(new Set(["doc_superseded", "review_requested"]));
    expect(kindsAt("lib/projects.ts")).toEqual(expect.arrayContaining(["checkout_released"]));
    // the storage watchdogs: typed now (PROD-10)
    expect(kindsAt("lib/storageAlerts.ts")).toEqual(["storage_alert"]);
  });

  it("no declared kind without a producer (PROD-8): the census writes every one", () => {
    const written = new Set<string>();
    for (const p of census()) if (p.kinds !== "typed") p.kinds.forEach((k) => written.add(k));
    // storage_platform_*: written through the typed `alert.kind`, set from
    // the literals in storageUsage's hot[] list
    const usage = src("lib/storageUsage.ts");
    for (const k of ["storage_platform_r2", "storage_platform_db"]) if (usage.includes(`kind: "${k}",`)) written.add(k);
    expect(unionKinds().filter((k) => !written.has(k))).toEqual([]);
  });
});
