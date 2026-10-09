"use client";

// PermissionsExplorer — the IT-department view of the ENTIRE app.
// One matrix: capabilities (rows, grouped by area) × roles (columns).
// ✓ = can do · ◐ = conditional (hover the cell for why) · — = cannot.
// Filter by area, role, or free text.
//
// ALOG-14 (admin-and-org Round G, P9): the panel used to be one hand-written
// 52-row string matrix that had drifted from the code in both directions. Its
// rows now come from three sources, each labelled on screen:
//   1. ACTION PERMISSIONS — one row per CAPABILITY_DEFS entry, evaluated with
//      policyAllows against THIS org's stored policy (the same evaluator the
//      workflow route and the database's org_capability_allows_for mirror),
//      plus the standing holders and identity rights the policy cannot
//      remove. A policy that could not be read is SAID, and the rows then
//      show the shipped defaults labelled as defaults (DEC-89 item 3).
//   2. ADMIN SURFACES — the /admin pages' action authority, read from the
//      admin-surface registry (lib/adminSurfaces.ts, pinned by tests to each
//      page's own constant).
//   3. A DOCUMENTATION SNAPSHOT — the rows that encode ACL, ownership and
//      per-library semantics no single evaluator exposes. They stay
//      hand-maintained and say so. ALOG-14 (fix pass 2): a row carries the
//      review date only when it was checked against the code that day
//      (`checked`, each pinned by a test); the rest are carried from the
//      earlier hand matrix and are marked NOT RE-CHECKED on screen.
// Columns are the role model (ALL_ROLES): the four Engineer tiers share one
// column (DEC-4) and the five dormant department labels share "Staff*"; a
// derived cell over a shared column is ✓ only when every role in it holds.

import React, { useEffect, useMemo, useState } from "react";
import { Search, ShieldCheck, AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import {
  CAPABILITY_DEFS, policyAllows, grantActive, isRuleArray, ruleIsConditional, describeWhen, loadCapabilityPolicyEntry,
  onCapabilityPolicyChanged,
  type CapabilityDef, type CapabilityId, type CapabilityPolicy, type CapabilityResource,
} from "@/lib/capabilityPolicy";
import { adminSurface } from "@/lib/adminSurfaces";
import { DORMANT_ROLES, ENGINEER_TIER_ROLES } from "@/lib/roleCapabilities";

/** ORG-14 (integrator fix pass): does the live database decide quality
 *  sign-off per project yet? `quality_signoff_status` exists only once
 *  20261136 is pasted; before that the four quality write policies are
 *  20261091's `is_org_controller OR user_owns_project`, which never read the
 *  capability — so a policy grant of quality.sign_off is NOT yet what the
 *  database decides. Asked once per mount with the nil uuid (a project
 *  nobody can see answers no row, no error). `false` = not live (42883 /
 *  PGRST202); `true` = live; `null` = not known (the probe failed for another
 *  reason — nothing is claimed either way). */
export const QUALITY_SIGNOFF_PROBE_PROJECT = "00000000-0000-0000-0000-000000000000";
export async function probeQualitySignOffDecided(): Promise<boolean | null> {
  try {
    const { error } = await supabase.rpc("quality_signoff_status", { p_project: QUALITY_SIGNOFF_PROBE_PROJECT });
    if (!error) return true;
    const code = error.code ?? "";
    if (code === "42883" || code === "PGRST202" || /could not find the function|function .* does not exist/i.test(error.message ?? "")) return false;
    return null;
  } catch { return null; }
}
/** What holds for quality.sign_off until 20261136 is pasted — said on the
 *  explorer row and in View-as, never a ✓ the database would not give. */
export const QUALITY_SIGNOFF_PRE_PASTE =
  "the database admits only Admin / Document Control and the project's owner until migration 20261136 is pasted — a policy grant of this capability is not read yet";

/** How a row is drawn beyond the policy: what the live database decides. */
export interface ExplorerContext {
  /** probeQualitySignOffDecided()'s answer; undefined / null = not known. */
  qualitySignOffDecided?: boolean | null;
}

/** The matrix's columns: every role in ALL_ROLES exactly once (pinned by test). */
export const EXPLORER_COLUMNS: ReadonlyArray<{ label: string; roles: readonly string[] }> = [
  { label: "Admin", roles: ["Admin"] },
  { label: "DocCtrl", roles: ["DocCtrl"] },
  { label: "Manager", roles: ["Manager"] },
  { label: "Supervisor", roles: ["Supervisor"] },
  { label: "DraftingSup", roles: ["DraftingSupervisor"] },
  { label: "Engineer 1-4", roles: ENGINEER_TIER_ROLES },
  { label: "Drafter", roles: ["Drafter"] },
  { label: "Requester", roles: ["Requester"] },
  { label: "Staff*", roles: DORMANT_ROLES },
  { label: "Contractor", roles: ["Contractor"] },
  { label: "Auditor", roles: ["Auditor"] },
  { label: "Viewer", roles: ["Viewer"] },
];
const STAFF_NOTE = `*Staff = ${DORMANT_ROLES.join(", ")} (dormant department labels)`;
/** When the snapshot rows marked `checked` were checked against the code. */
export const SNAPSHOT_REVIEWED = "2026-10-07";

export type CellMark = "y" | "c" | "-";
export interface Cell { v: CellMark; why?: string }
export type RowSource = "policy" | "surface" | "snapshot";
export interface ExplorerRow {
  key: string;
  source: RowSource;
  area: string;
  cap: string;
  cells: Cell[];
  note?: string;
  warn?: string;
  dormant?: boolean;
  /** Snapshot rows only: carried from the earlier hand matrix, NOT checked
   *  against the code on SNAPSHOT_REVIEWED (ALOG-14 fix pass 2). */
  unchecked?: boolean;
}

/** Authority the capability policy can NEITHER grant NOR remove, said beside
 *  the verdict (the description of each capability names the same right). */
export const STANDING: Partial<Record<CapabilityId, { controllers?: string; anyone?: string }>> = {
  "ticket.draft_work": { anyone: "The ticket's assigned drafter always can (identity)." },
  "ticket.requester_review": { anyone: "The ticket's own requester always can (identity)." },
  "ticket.eng_review": { anyone: "The assigned engineer always can (identity)." },
  "ticket.final_approve": { anyone: "The assigned engineer always can (identity)." },
  "ticket.reopen": { anyone: "The ticket's requester always can (identity)." },
  // QUAL-4 / ORG-14: the four quality write policies' is_org_controller clause
  // and the owner disjunct (quality_signer_eligible, 20261136).
  "quality.sign_off": {
    controllers: "Admin and Document Control always can — the database's controller clause, whatever this row says.",
    anyone: "A project's owner always can on that project; a rule scoped to a project grants it there only.",
  },
};

const CONTROLLER_ROLES = new Set(["Admin", "DocCtrl"]);

/** ALOG-14 (fix pass 2): authority the workflow engine COMPOSES onto a row.
 *  lib/workflow.ts getActions admits these other capabilities' holders at the
 *  row's own stage (the workflow route enforces exactly that), so a row that
 *  asked only its own capability told an auditor that Admins and Managers
 *  cannot approve drawings they can. `conditional` composition holds only on
 *  some tickets (said on the cell as ◐). Pinned against the engine, per role
 *  column, by aoRoundGP9PermissionsConsole.test.ts. */
export interface ComposedAuthority { cap: CapabilityId; why: string; conditional?: boolean }
const VIA_MANAGE = "via Management override (ticket.manage)";
export const COMPOSED: Partial<Record<CapabilityId, readonly ComposedAuthority[]>> = {
  // PENDING_ENG_TEAM: `allows('ticket.eng_review') || isManagement`.
  "ticket.eng_review": [{ cap: "ticket.manage", why: VIA_MANAGE }],
  // PENDING_REVIEW co-review and the FINAL_DRAFT close: `allows('ticket.direct_approve') || isManagement`.
  "ticket.direct_approve": [{ cap: "ticket.manage", why: VIA_MANAGE }],
  // PENDING_FINAL_APPROVAL: `allows('ticket.final_approve') || isManagement`.
  "ticket.final_approve": [{ cap: "ticket.manage", why: VIA_MANAGE }],
  // PENDING_REVIEW / FINAL_DRAFT: a co-reviewer acts on the requester's behalf.
  "ticket.requester_review": [
    { cap: "ticket.direct_approve", why: "co-review on the requester's behalf, via Direct engineering approval (ticket.direct_approve)" },
    { cap: "ticket.manage", why: `co-review on the requester's behalf, ${VIA_MANAGE}` },
  ],
  // CLOSED: `allows('ticket.reopen') || canActAsRequester` — and with no
  // requester on the ticket, a Requester-review holder acts as the requester.
  "ticket.reopen": [{ cap: "ticket.requester_review", conditional: true, why: "On a ticket with no requester: via Requester review (ticket.requester_review)" }],
};

/** One role's answer for a capability row, composed authority included —
 *  shared by the explorer's cells and the View-as list. */
export function composedAllows(
  policy: CapabilityPolicy, cap: CapabilityId, role: string | null, roles: readonly string[] | null,
  uid?: string | null, resource?: CapabilityResource | null,
): { ok: boolean; via: string | null; conditional: string | null } {
  if (policyAllows(policy, cap, role, roles ? [...roles] : null, uid, resource)) return { ok: true, via: null, conditional: null };
  let conditional: string | null = null;
  for (const c of COMPOSED[cap] ?? []) {
    if (!policyAllows(policy, c.cap, role, roles ? [...roles] : null, uid, resource)) continue;
    if (!c.conditional) return { ok: true, via: c.why, conditional: null };
    conditional ??= c.why;
  }
  return { ok: false, via: null, conditional };
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One capability row, from the stored policy, as the evaluator answers it. */
export function capabilityRow(def: CapabilityDef, policy: CapabilityPolicy, ctx: ExplorerContext = {}): ExplorerRow {
  const standing = STANDING[def.id];
  // ORG-14 (integrator fix pass): before 20261136 is pasted the database does
  // not read a quality.sign_off grant, so a column the POLICY grants is not
  // drawn ✓ — it is ◐ with what holds today. The controllers' ✓ stands.
  const prePaste = def.id === "quality.sign_off" && ctx.qualitySignOffDecided === false;
  const cells = EXPLORER_COLUMNS.map(({ roles }): Cell => {
    const answers = roles.map((r) => ({ r, ...composedAllows(policy, def.id, r, [r]) }));
    const held = answers.filter((a) => a.ok);
    const via = [...new Set(held.map((a) => a.via).filter((w): w is string => !!w))];
    const viaNote = via.length ? ` (${via.join("; ")})` : "";
    if (standing?.controllers && roles.every((r) => CONTROLLER_ROLES.has(r))) return { v: "y", why: standing.controllers };
    if (prePaste) {
      if (held.length > 0) return { v: "c", why: `Granted by the policy${held.length < roles.length ? ` to ${held.map((a) => a.r).join(", ")} only` : ""}, but ${QUALITY_SIGNOFF_PRE_PASTE}. ${standing?.anyone ?? ""}`.trim() };
      return { v: "c", why: `${standing?.anyone ?? ""} ${upperFirst(QUALITY_SIGNOFF_PRE_PASTE)}.`.trim() };
    }
    if (held.length === roles.length) return via.length ? { v: "y", why: upperFirst(via.join("; ")) } : { v: "y" };
    if (held.length > 0) return { v: "c", why: `Only ${held.map((a) => a.r).join(", ")} in this column${viaNote}` };
    const conditional = answers.find((a) => a.conditional)?.conditional ?? null;
    if (conditional) return { v: "c", why: standing?.anyone ? `${standing.anyone} ${conditional}.` : `${conditional}.` };
    if (standing?.anyone) return { v: "c", why: standing.anyone };
    return { v: "-" };
  });
  const entry = policy.caps?.[def.id];
  const scoped = isRuleArray(entry) ? entry.filter(ruleIsConditional) : [];
  const grants = (policy.grants ?? []).filter((g) => g.cap === def.id && grantActive(g)).length;
  const notes: string[] = [];
  if (prePaste) notes.push(`Not decided by the database yet: ${QUALITY_SIGNOFF_PRE_PASTE}`);
  if (scoped.length) notes.push(`${scoped.length} scoped rule${scoped.length > 1 ? "s" : ""} replace this row where they match (${scoped.map((r) => describeWhen(r.when)).join("; ")})`);
  if (grants) notes.push(`${grants} live personal grant${grants > 1 ? "s" : ""}`);
  return {
    key: `cap:${def.id}`, source: "policy", area: def.area, cap: def.label, cells,
    note: notes.length ? notes.join(" · ") : undefined,
    ...(prePaste ? { warn: `Migration 20261136 is not applied: ${QUALITY_SIGNOFF_PRE_PASTE}` } : {}),
    dormant: def.dormant,
  };
}

/** The admin surfaces whose action authority the registry states. `use`
 *  picks the registry field: the page's write authority when it declares
 *  one, otherwise who may open the page (the page is the action). `cond` is
 *  the database's narrowing the registry cannot spell, said on the row. */
export const SURFACE_ROWS: ReadonlyArray<{ area: string; cap: string; key: string; use: "writes" | "entry"; cond?: string }> = [
  // ALOG-14 (review fix): suspend / restore and role changes are the users
  // page's writes (Admin, Manager — revoke_member and the org_members UPDATE
  // policy, where only an Admin writes a row that holds Admin, 20260817);
  // REMOVING a member is Admin-only (revoke_member mode 'remove',
  // org_members_delete), so it is its own snapshot row below.
  { area: "Admin", cap: "Change member roles, suspend or restore members", key: "users", use: "writes",
    cond: "Only an Admin can grant the Admin role or suspend / restore an Admin; removing a member is Admin-only (its own row)" },
  // The teams page's `writes` (Admin, Document Control) is its supervisor and
  // library-ownership controls (snapshot rows below). Creating teams and
  // changing who is in them is the page's own audience — Admin or Manager,
  // which is also the database's rule (teams_admin_write /
  // team_members_admin_write, 20261046).
  { area: "Admin", cap: "Create teams & manage team membership", key: "teams", use: "entry",
    cond: "The teams write policy (20261046) admits Admin or Manager; a department's supervisor and library ownership are separate rows" },
  { area: "Admin", cap: "Library creation & config", key: "libraries", use: "entry" },
  { area: "Admin", cap: "Request-form & routing config", key: "requests", use: "entry" },
  { area: "Admin", cap: "Operational scope (edit)", key: "scope", use: "writes" },
  { area: "Admin", cap: "Equipment / asset admin pages (edit)", key: "assets", use: "writes" },
  { area: "Admin", cap: "Data export & backups", key: "data-export", use: "entry" },
  { area: "Admin", cap: "Storage purge & archive shed", key: "storage", use: "writes" },
  { area: "Metrics", cap: "Storage stats", key: "storage", use: "entry" },
  { area: "Admin", cap: "Restore from backup", key: "restore", use: "entry" },
  { area: "Admin", cap: "Billing & subscription (change plan)", key: "billing", use: "writes" },
  { area: "Admin", cap: "Branding", key: "branding", use: "entry" },
  { area: "Admin", cap: "Workspace settings", key: "settings", use: "entry" },
];

export function surfaceRow(spec: (typeof SURFACE_ROWS)[number]): ExplorerRow {
  const s = adminSurface(spec.key);
  const set = (spec.use === "writes" ? s?.writes : s?.entry) ?? null;
  const cells = EXPLORER_COLUMNS.map(({ roles }): Cell => {
    if (set === "*") return { v: "y", why: "Any active member" };
    const held = roles.filter((r) => (set ?? []).includes(r));
    if (held.length === roles.length) return { v: "y" };
    if (held.length > 0) return { v: "c", why: `Only ${held.join(", ")} in this column` };
    return { v: "-" };
  });
  return {
    key: `surface:${spec.key}:${spec.use}`, source: "surface", area: spec.area, cap: spec.cap, cells,
    note: `${s?.path ?? spec.key} — ${spec.use === "writes" ? "its actions" : "who may open it"}${spec.cond ? ` · ${spec.cond}` : ""}`,
  };
}

// m: 12 chars in EXPLORER_COLUMNS order — y (yes), c (conditional), - (no).
// checked: the row was checked against the code on SNAPSHOT_REVIEWED and a
// test pins it (aoRoundGP9PermissionsConsole.test.ts); absent = carried from
// the earlier hand matrix, shown as NOT RE-CHECKED.
interface SnapshotRow { area: string; cap: string; m: string; cond?: string; warn?: string; checked?: true }

/** DOCUMENTATION SNAPSHOT — hand-maintained. These encode ACL, ownership and
 *  per-library semantics no single evaluator exposes; every row a capability
 *  or the admin-surface registry can answer is derived above instead
 *  (ALOG-14). Only the rows marked `checked` carry SNAPSHOT_REVIEWED. */
export const SNAPSHOT_ROWS: SnapshotRow[] = [
  // ── Documents & files ──
  { area: "Documents", cap: "Browse & read documents", m: "yyyyyyyyyyyy", cond: "Subject to each library/folder's visibility & ACL" },
  { area: "Documents", cap: "Upload files / create folders", m: "yycccccccc-c", cond: "Per-library ACL grant" },
  { area: "Documents", cap: "Download / print (stamped when uncontrolled)", m: "yyyyyyyyyyyy", cond: "A hard read-&-understood gate can block until signed" },
  // ALOG-14 (fix pass 2): checked. The metadata editor's fields are the
  // controllers' (MetadataEditor canEdit, by the collection); the inline title
  // rename (details view) is offered to everyone; the database admits any
  // member's update unless an ACL deny binds them (documents_org_access,
  // schema.sql; documents_deny_write_guard, 20260901).
  { area: "Documents", cap: "Edit document metadata", m: "yycccccccccc", checked: true,
    cond: "Admin / Document Control edit every field (the metadata editor). Anyone else is offered only the inline title rename in the details view — an ACL Edit Metadata grant opens nothing more in the editor — and the database admits their update unless an ACL deny of write or Edit Metadata binds them",
    warn: "The editor's controller-only line is not the database's: documents_org_access admits any member's update (the OWN-2 / OWN-19 class)" },
  { area: "Documents", cap: "Edit equipment / asset tags", m: "yyyy-yy-----" },
  { area: "Documents", cap: "Manage sets & binders", m: "yy----------" },
  { area: "Documents", cap: "Delete documents / versions", m: "yy----------", cond: "Legal-hold rows are undeletable for everyone" },
  { area: "Documents", cap: "Request deletion (owner path)", m: "--cccccccccc", cond: "If effective owner of the document" },
  // ── Publishing & revisions ──
  { area: "Publishing", cap: "Publish / rev-up a revision", m: "yycccccc-c--", cond: "If effective owner OR per-library publish grant" },
  { area: "Publishing", cap: "Publish over someone's checkout (reason required)", m: "yycccccc-c--", cond: "Same authority as publishing; never passes a hold" },
  { area: "Publishing", cap: "Force past an active hold", m: "yy----------" },
  { area: "Publishing", cap: "Revert to a prior revision", m: "yy----------" },
  { area: "Publishing", cap: "Check out / check in documents", m: "yyyyyyyyyyyy" },
  { area: "Publishing", cap: "Place / release legal hold", m: "yycccccccccc", cond: "If effective owner" },
  // ── Reviews & compliance ──
  { area: "Reviews", cap: "Configure review policies & rosters", m: "yycccccccccc", cond: "If effective owner" },
  { area: "Reviews", cap: "Sign a review (e-signature)", m: "cccccccccccc", cond: "Only your own roster row" },
  { area: "Reviews", cap: "Auto-publish as last review signer", m: "yycccccc----", cond: "Signer must also hold publish authority" },
  { area: "Reviews", cap: "Acknowledge read-&-understood", m: "cccccccccccc", cond: "Only your own assignment row" },
  { area: "Reviews", cap: "Retention, disposition & purge", m: "yy----------" },
  // ALOG-14 row 6 / ALOG-2: the library page offers the flow to a controller
  // or the library's owner, and the database admits exactly them (20261077 §2
  // for the dates, 20261188 for the record).
  { area: "Reviews", cap: "Access recertification reviews", m: "yycccccccccc", cond: "If library owner", checked: true },
  // ── Drafting requests ──
  { area: "Requests", cap: "Create a drafting request", m: "yyyyyyyyyy--" },
  // ── Packages & distribution ──
  { area: "Packages", cap: "Create / edit / refresh work packages", m: "yyyyyyyyyyyy", warn: "No role differentiation today" },
  { area: "Packages", cap: "Request distribution confirmations", m: "yyyyyyyyyyyy" },
  { area: "Packages", cap: "Confirm “I have this revision”", m: "cccccccccccc", cond: "Only your own confirmation row" },
  // ── Projects ──
  { area: "Projects", cap: "Create / manage projects & schedules", m: "yycccccccccc", cond: "Project owner or member" },
  // ── Metrics ──
  // ALOG-14 row 1: the org-level authority trail is the "Audit log"
  // capability above (admin.audit_view, read by the database since 20261063);
  // document-level history stays readable by every member (admin-and-org
  // ALOG-5 is open on /activity).
  { area: "Metrics", cap: "Document-level activity history (/activity)", m: "yyyyyyyyyyyy", cond: "Every member reads document-level history; the org-level authority trail is the Audit log capability", warn: "ALOG-5: /activity has no role gate", checked: true },
  // ── Administration ──
  // ALOG-14 row 5: adding a member is the create-user route's rule (Admin or
  // Document Control by the collection; only an Admin grants Admin), and the
  // members page offers it to the same two — changing roles is the users
  // surface's writes (derived above).
  { area: "Admin", cap: "Add a member (invite)", m: "yy----------", cond: "Only an Admin can grant the Admin role", checked: true },
  // ALOG-14 (review fix): removal is revoke_member's 'remove' mode (newest
  // body 20261161) and org_members_delete (20261042) — Admin only.
  { area: "Admin", cap: "Remove a member from the workspace", m: "y-----------", cond: "Admin only — revoke_member refuses anyone else; no one removes themselves", checked: true },
  // ALOG-14 (review fix): the old single row said only Admin could reassign
  // library ownership. Split: the supervisor swap is the teams guard
  // (teams_guard_supervisor_change, 20261046: a controller) AND the teams
  // write policy (Admin or Manager) — so Admin alone, or a member holding
  // Document Control together with Manager. Library ownership is the library
  // guard (enforce_library_sensitive_columns, 20261077 §2): a controller, the
  // library's current owner, or a Manage Permissions grant on it — reached
  // from the library's review policy (setOwner) and from /admin/teams
  // (setLibraryOwnerTeam).
  { area: "Admin", cap: "Change a department's supervisor", m: "y-----------", cond: "Needs a controller (the supervisor guard) who may also write teams (Admin or Manager): Admin, or Document Control held together with Manager", checked: true },
  { area: "Admin", cap: "Reassign library ownership / owning team", m: "yycccccccccc", cond: "Admin / Document Control always; anyone else as the library's current owner, or with a Manage Permissions grant on it", checked: true },
  // ALOG-14 (fix pass 2): the drawer's delegation mode (PermissionDrawer
  // `delegationOnly`, DEL-1 / GAP-3) is offered on the library to its owner
  // and on a folder or document to its effective owner or a Manage
  // Permissions grant holder on its chain (the library page); the library
  // guard (20261077 §2) admits the same people on the library's ACL.
  { area: "Admin", cap: "Per-library permission (ACL) drawer", m: "yycccccccccc", checked: true,
    cond: "Admin / Document Control: any rule. Otherwise the drawer opens in delegation mode (DEL-1 / GAP-3) — allow rules only, never Admin or Manage Permissions, each with an expiry — for the library's owner, and on a folder or document for its effective owner or a Manage Permissions grant holder on its chain. The library guard (20261077 §2) admits the owner or a Manage Permissions grant holder; the delegation bounds are the drawer's" },
];

export function snapshotRow(r: SnapshotRow): ExplorerRow {
  return {
    key: `snapshot:${r.area}:${r.cap}`, source: "snapshot", area: r.area, cap: r.cap, warn: r.warn,
    ...(r.checked ? {} : { unchecked: true }),
    cells: EXPLORER_COLUMNS.map((_, i): Cell => {
      const v = (r.m[i] ?? "-") as CellMark;
      return v === "c" ? { v, why: r.cond ?? "Conditional" } : { v, why: v === "y" ? r.cond : undefined };
    }),
  };
}

export function explorerRows(policy: CapabilityPolicy, ctx: ExplorerContext = {}): ExplorerRow[] {
  return [
    ...CAPABILITY_DEFS.map((d) => capabilityRow(d, policy, ctx)),
    ...SURFACE_ROWS.map(surfaceRow),
    ...SNAPSHOT_ROWS.map(snapshotRow),
  ];
}

const SECTION_LABEL: Record<RowSource, string> = {
  policy: "Action permissions — this org's policy",
  surface: "Admin surfaces — the admin-surface registry",
  snapshot: `Documentation snapshot — hand-maintained; rows marked SNAPSHOT were checked against the code on ${SNAPSHOT_REVIEWED}, rows marked NOT RE-CHECKED were not`,
};
const SECTION_HINT: Record<RowSource, string> = {
  policy: "Evaluated live from the stored capability policy with the same evaluator the server uses. Personal grants and scoped rules are noted per row.",
  surface: "Read from lib/adminSurfaces.ts, which tests pin to each admin page's own rule.",
  snapshot: "Not derived: these rows describe ACL, ownership and per-library rules that no single evaluator answers. A NOT RE-CHECKED row is carried from the earlier hand-written matrix and may be wrong. Check the node's permissions for the truth on a given document.",
};

export default function PermissionsExplorer() {
  const { activeOrgId } = useRole();
  const [q, setQ] = useState("");
  const [area, setArea] = useState("all");
  const [role, setRole] = useState(-1);
  const [policy, setPolicy] = useState<CapabilityPolicy>({});
  const [policyState, setPolicyState] = useState<"loading" | "ok" | "stale" | "unreadable">("loading");
  const [policyError, setPolicyError] = useState<string | null>(null);
  // ALOG-14 (fix pass 2): a save in the policy editor (or a View-as grant)
  // on this page announces itself; the matrix re-reads instead of showing
  // the pre-save policy under "this org's policy".
  const [reread, setReread] = useState(0);
  useEffect(() => {
    if (!activeOrgId) return;
    return onCapabilityPolicyChanged(activeOrgId, () => setReread((n) => n + 1));
  }, [activeOrgId]);
  // ORG-14 (integrator fix pass): asked once on mount — the quality.sign_off
  // row must not show a ✓ the database would not give before 20261136.
  const [signoffDecided, setSignoffDecided] = useState<boolean | null>(null);
  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    void probeQualitySignOffDecided().then((v) => { if (alive) setSignoffDecided(v); });
    return () => { alive = false; };
  }, [activeOrgId]);

  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    void loadCapabilityPolicyEntry(activeOrgId).then((e) => {
      if (!alive) return;
      setPolicy(e.policy);
      setPolicyError(e.unreadable ?? e.staleError ?? null);
      setPolicyState(e.unreadable ? "unreadable" : e.stale ? "stale" : "ok");
    }).catch((err: unknown) => {
      if (!alive) return;
      setPolicy({});
      setPolicyError((err as Error)?.message || "the policy could not be read");
      setPolicyState("unreadable");
    });
    return () => { alive = false; };
  }, [activeOrgId, reread]);

  const all = useMemo(() => explorerRows(policy, { qualitySignOffDecided: signoffDecided }), [policy, signoffDecided]);
  const areas = useMemo(() => [...new Set(all.map((r) => r.area))], [all]);

  const rows = useMemo(() => {
    const filtered = all.filter((r) => {
      if (area !== "all" && r.area !== area) return false;
      if (role >= 0 && r.cells[role]?.v === "-") return false;
      if (q && !`${r.area} ${r.cap} ${r.note ?? ""} ${r.cells.map((c) => c.why ?? "").join(" ")}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
    return filtered.map((r, i) => ({
      ...r,
      firstOfSection: i === 0 || filtered[i - 1].source !== r.source,
      firstOfArea: i === 0 || filtered[i - 1].source !== r.source || filtered[i - 1].area !== r.area,
    }));
  }, [all, q, area, role]);

  const cell = (c: Cell) => {
    if (c.v === "y") return <span className="text-emerald-600 dark:text-emerald-400 font-black cursor-default" title={c.why}>✓</span>;
    if (c.v === "c") return <span className="text-amber-600 dark:text-amber-400 font-black cursor-help" title={c.why ?? "Conditional"}>◐</span>;
    return <span className="text-[var(--color-text-faint)]">—</span>;
  };

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] mb-5 overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <ShieldCheck className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-base font-bold text-[var(--color-text)]">App-wide permissions</span>
        <span className="text-xs text-[var(--color-text-muted)]">✓ can do · ◐ conditional (hover for why) · — cannot · ⚠ known gap</span>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter capabilities…" className="pl-7 pr-2 h-8 w-48 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)]/50 text-xs outline-none focus:border-[var(--color-accent-ring)]" />
          </div>
          <select value={area} onChange={(e) => setArea(e.target.value)} className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
            <option value="all">All areas</option>
            {areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select value={role} onChange={(e) => setRole(Number(e.target.value))} className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
            <option value={-1}>All roles</option>
            {EXPLORER_COLUMNS.map((c, i) => <option key={c.label} value={i}>Can: {c.label}</option>)}
          </select>
        </div>
      </div>
      {/* ALOG-1 / DEC-89 item 3: a policy that could not be read is said; the
          rows then show the SHIPPED DEFAULTS, labelled — never as the org's policy. */}
      {policyState === "unreadable" && (
        <div role="alert" className="mx-4 mt-3 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] p-2.5 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>This workspace&apos;s action-permission policy could not be read ({policyError}). The &ldquo;Action permissions&rdquo; rows below show the SHIPPED DEFAULTS, not this org&apos;s policy.</span>
        </div>
      )}
      {policyState === "stale" && (
        <div className="mx-4 mt-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-2.5 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Couldn&apos;t refresh the policy ({policyError}) — the &ldquo;Action permissions&rdquo; rows show it as last read.</span>
        </div>
      )}
      <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-[var(--color-surface-2)]">
              <th className="sticky left-0 bg-[var(--color-surface-2)] text-left font-black px-3 py-2 min-w-[240px]">Capability</th>
              {EXPLORER_COLUMNS.map((c, i) => (
                <th key={c.label} className={`px-2 py-2 font-black whitespace-nowrap ${role === i ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)]"}`}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <React.Fragment key={r.key}>
                {r.firstOfSection && (
                  <tr data-section={r.source}>
                    <td colSpan={EXPLORER_COLUMNS.length + 1} className="sticky left-0 bg-[var(--color-surface-2)]/60 px-3 pt-3 pb-1.5">
                      <div className="text-[11px] font-black text-[var(--color-text)]">
                        {SECTION_LABEL[r.source]}
                        {r.source === "policy" && policyState === "unreadable" && <span className="ml-1.5 text-rose-700 dark:text-rose-300">(shipped defaults — the org&apos;s policy could not be read)</span>}
                      </div>
                      <div className="text-[10px] text-[var(--color-text-faint)]">{SECTION_HINT[r.source]}</div>
                    </td>
                  </tr>
                )}
                {r.firstOfArea && (
                  <tr><td colSpan={EXPLORER_COLUMNS.length + 1} className="sticky left-0 bg-[var(--color-surface)] px-3 pt-2 pb-1 text-[11px] font-black uppercase tracking-wider text-[var(--color-accent)]">{r.area}</td></tr>
                )}
                <tr className={`border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]/50 ${r.dormant ? "opacity-50" : ""}`}>
                  <td className="sticky left-0 bg-[var(--color-surface)] px-3 py-1.5 font-medium text-[var(--color-text)]">
                    {r.cap}
                    {r.source === "snapshot" && !r.unchecked && <span className="ml-1.5 text-[9px] font-black text-[var(--color-text-faint)] cursor-help" title={`Hand-maintained documentation snapshot, checked against the code on ${SNAPSHOT_REVIEWED} — not derived from the code or the policy`}>SNAPSHOT</span>}
                    {r.source === "snapshot" && r.unchecked && <span data-unchecked="" className="ml-1.5 text-[9px] font-black text-amber-700 dark:text-amber-300 cursor-help" title={`Carried from the earlier hand-written matrix and NOT re-checked against the code in the ${SNAPSHOT_REVIEWED} review — check the node's permissions before relying on it`}>NOT RE-CHECKED</span>}
                    {r.dormant && <span className="ml-1.5 text-[9px] font-black text-[var(--color-text-faint)]">DORMANT</span>}
                    {r.warn && <span className="ml-1.5 cursor-help text-amber-600 dark:text-amber-400" title={r.warn}>⚠</span>}
                    {r.note && <div className="text-[10px] font-normal text-[var(--color-text-faint)]">{r.note}</div>}
                  </td>
                  {r.cells.map((c, i) => <td key={i} className={`px-2 py-1.5 text-center ${role === i ? "bg-[var(--color-accent-soft)]/40" : ""}`}>{cell(c)}</td>)}
                </tr>
              </React.Fragment>
            ))}
            {rows.length === 0 && <tr><td colSpan={EXPLORER_COLUMNS.length + 1} className="px-3 py-6 text-center italic text-[var(--color-text-muted)]">No capabilities match.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-faint)]">{STAFF_NOTE} · Engineer 1-4 share one column (the tiers carry identical authority) · Beyond roles, ownership (document → folder → library → owning team&apos;s supervisor) and per-library grants add ◐ authority — see hover notes.</div>
    </div>
  );
}
