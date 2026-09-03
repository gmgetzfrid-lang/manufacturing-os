"use client";

// RoleModelTree — the accurate "who can do what" org tree.
//
// Built from a code audit of every enforcement point (UI guards, API route
// guards, the workflow engine, RLS policies, and the publish-guard trigger).
// Three branches: BASE ROLES (org_members.role/roles[]), SITUATIONAL
// AUTHORITY (ownership inheritance, per-library publish grants, review
// signers — powers that don't come from the role field), and KNOWN GAPS
// (places the model is inconsistent today). Live holders are loaded from the
// database so the tree shows real people, not just theory.

import React, { useEffect, useState } from "react";
import { ChevronRight, Users, KeyRound, GitBranch, AlertTriangle, ShieldCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface Member { uid: string; name: string; role: string; roles: string[]; status: string }
interface Lib { id: string; name: string; ownerUserId: string | null; ownerName: string | null; ownerTeamId: string | null; publishGrants: string[] }
interface TeamRow { id: string; name: string; supervisorName: string | null }

const TIERS: Array<{ tier: string; blurb: string; roles: Array<{ role: string; summary: string; perms: Array<[string, string[]]> }> }> = [
  {
    tier: "Controllers",
    blurb: "Full document-control authority. Most checks in code are literally: role is Admin or DocCtrl.",
    roles: [
      { role: "Admin", summary: "Everything DocCtrl has, plus org ownership: billing, branding, restore, granting the Admin role.", perms: [
        ["Documents & publishing", ["Publish/revert any revision in any library (bypasses per-library grants)", "Force-publish past a checkout lock AND an active hold (the only role that passes holds)", "Force-unlock any checkout", "Delete documents/versions/folders (except legal-hold rows — blocked for everyone)", "Edit metadata, sets/binders, columns, review cycles, library config", "Open/edit every node's permission (ACL) drawer"]],
        ["Reviews & compliance", ["Manage review rosters, activate alternates, void sign-off rows", "Cannot skip an incomplete review roster — the completion gate applies even to Admin", "Retention/disposition, legal holds, access recerts, storage purge & archive shed"]],
        ["Requests (tickets)", ["Every management action: approve, assign, force-close, reopen", "Reassign the engineer at final approval (Admin only)"]],
        ["Administration", ["User management incl. granting Admin (only an Admin can make an Admin)", "Teams, request forms, permissions, operational scope, audit log", "Billing & Stripe (with Manager)", "Branding, workspace settings, restore-from-backup (Admin only)", "Data export (with Manager, DocCtrl)"]],
      ]},
      { role: "DocCtrl", summary: "Document control twin of Admin for documents; no billing/branding/restore, can't grant Admin.", perms: [
        ["Documents & publishing", ["Same as Admin: publish anywhere, force past locks and holds, force-unlock, delete, ACL drawer, metadata, library config"]],
        ["Reviews & compliance", ["Same as Admin: rosters, retention, legal holds, recerts, purge/shed"]],
        ["Requests (tickets)", ["Direct approval of own requests (skips engineer review)", "NOT a management role in the ticket engine — no assign/force-close"]],
        ["Administration", ["Permissions, settings, request forms, data export", "No user management (/admin/users is Admin/Manager-gated — the sidebar link DocCtrl sees is a known gap), no billing, no branding, no restore"]],
      ]},
    ],
  },
  {
    tier: "Management",
    blurb: "People-and-work managers. NOT controllers: they cannot publish documents or see the Admin sidebar section (Manager reaches /admin/users only by URL — a known gap).",
    roles: [
      { role: "Manager", summary: "Runs people and tickets, not documents.", perms: [
        ["Requests (tickets)", ["Approve/reject at every stage, assign drafters, force-close, reopen"]],
        ["Administration", ["User management (add/remove members, change roles — not Admin grants)", "Teams, billing, storage stats, data export, audit log, operational scope, hold release (/admin/holds)"]],
        ["Documents", ["No publish authority unless granted per-library or made an owner"]],
      ]},
      { role: "Supervisor", summary: "Ticket management without user administration.", perms: [
        ["Requests (tickets)", ["Approve/reject, assign drafters, force-close, reopen"]],
        ["Administration", ["Audit log, operational scope, hold release, equipment admin"]],
      ]},
      { role: "DraftingSupervisor", summary: "The drafting queue router.", perms: [
        ["Requests (tickets)", ["Assign drafters at PENDING_ASSIGNMENT (their one special power)", "Default routing target for new assignment/IFC work"]],
      ]},
    ],
  },
  {
    tier: "Engineering",
    blurb: "Engineer-1 through Engineer-4 are interchangeable in code — every check is 'role contains Engineer'. The number is a label, not a power level.",
    roles: [
      { role: "Engineer-1…4", summary: "Technical approval authority in the ticket workflow.", perms: [
        ["Requests (tickets)", ["Initial engineering approval / rejection", "Team review approval when assigned (or unassigned)", "Final engineering approval before IFC", "Own requests skip engineer review (self-approval)"]],
        ["Documents", ["Edit equipment/asset tags on documents", "Capture ticket signatures", "No publish authority unless granted or owner"]],
      ]},
    ],
  },
  {
    tier: "Execution & requesting",
    blurb: "The people the work flows through.",
    roles: [
      { role: "Drafter", summary: "Does the drafting work.", perms: [
        ["Requests (tickets)", ["Self-assign from the assignment queue", "Save progress, submit drafts, submit final IFC, close RFIs"]],
        ["Documents", ["Edit asset tags", "No publish authority unless granted or owner"]],
      ]},
      { role: "Requester", summary: "Originates and accepts work.", perms: [
        ["Requests (tickets)", ["Create requests", "Review the returned draft: approve toward IFC, request revision, close"]],
      ]},
      { role: "Accounting / Safety / HR / Maintenance / Operations", summary: "Request-only roles.", perms: [
        ["Requests (tickets)", ["Create requests; requester powers on their own tickets"]],
      ]},
    ],
  },
  {
    tier: "Limited access",
    blurb: "Read-mostly roles.",
    roles: [
      { role: "Viewer", summary: "Default when membership is missing. Reduced sidebar (Home, Documents, Requests, Scratchpad).", perms: [["Everywhere", ["Read/browse per library visibility; no workflow actions, no publishing"]]] },
      { role: "Contractor", summary: "Same reduced sidebar as Viewer, plus can create requests.", perms: [["Requests", ["Create requests"]]] },
      { role: "Auditor", summary: "Audit review: read-only, excluded from document editing, admitted to /admin/audit.", perms: [["Everywhere", ["Read-only; excluded from document editing", "/admin/audit access alongside Admin/Manager/Supervisor/DocCtrl"]]] },
    ],
  },
];

const SITUATIONAL: Array<{ title: string; body: string[] }> = [
  { title: "Effective owner (document → folder → library → owning team's supervisor)", body: [
    "The most specific owner_user_id wins: a document's owner, else its folder's, else its library's; if none, the library's owning TEAM makes that team's supervisor the effective owner.",
    "Powers: publish/revert on that document, manage its review roster, acks, retention & origin sections, request deletion. Granted by the ownership chain — the person's base role doesn't matter.",
  ]},
  { title: "Granted publisher (per-library permission drawer)", body: [
    "A library's ACL can grant 'publish' (or full 'admin') to specific users, teams, or roles. Grants are evaluated deny-first. Expiry dates are honored only where the raw rules are evaluated — the publish check (app and database) reads the acl_index snapshot, which carries no expiry, so an expired publish grant keeps working until that node's permissions are re-saved (see Known gaps).",
    "Powers: publish revisions in that one library, override another user's checkout lock (with a required reason — never a hold), and void stale review/ack rows during publish.",
  ]},
  { title: "Review signer (roster row)", body: [
    "Being on a draft's review roster grants exactly one power: signing your own row (e-signature bound to the draft's content hash).",
    "A completed roster never publishes itself: the last signature routes a \"Ready to publish\" notice to the document's owner and the controllers, and one of them publishes from the inspector under their own authority (OWN-11). Which reviewer signs last changes nothing.",
  ]},
  { title: "Ticket participant (identity, not role)", body: [
    "The assigned drafter, assigned engineer, and original requester get their workflow actions by IDENTITY — e.g. a Manager who filed a request acts as its requester regardless of role.",
  ]},
];

// Most of the original audit's gaps are now FIXED (decorative matrix
// removed; holds/force-release/analytics DB- or policy-gated; all 19 roles
// assignable; Auditor admitted to the audit log). What remains, honestly:
const GAPS: string[] = [
  "Additive extra roles (roles[]) are honored by the capability policy and the newer DB helpers, but the publish guard (app + database), most RLS predicates, and the admin-page gates still read only the headline (highest-ranked) role — e.g. a Manager holding a secondary DocCtrl role has no publish authority anywhere.",
  "Rule expiry dates are enforced by the raw-rule evaluator but not by the acl_index snapshot the publish path and the database read — an expired grant keeps authorizing until the node's permissions are re-saved.",
  "A deny-read rule on a 'normal'-visibility node is app-enforced; to make hiding database-hard, set the node private/hidden with explicit grants (the designed model).",
  "Manager can administer users but the Admin sidebar section is shown only to Admin/DocCtrl — reachable by URL. Conversely, DocCtrl sees the Users link and /admin/users denies them.",
  "Owners are notified when an access recertification is due, but only Admin/DocCtrl can open the recertification flow — the owner path is a known gap.",
];

function Fold({ label, count, children, tone }: { label: React.ReactNode; count?: number; children: React.ReactNode; tone?: "warn" }) {
  return (
    <details className="group/rm">
      <summary className={`cursor-pointer list-none flex items-center gap-2 px-1 py-1.5 text-sm font-bold select-none ${tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-[var(--color-text)]"} hover:text-[var(--color-accent)]`}>
        <ChevronRight className="w-4 h-4 transition-transform group-open/rm:rotate-90 shrink-0" />
        {label}
        {typeof count === "number" && <span className="text-xs font-black tabular-nums text-[var(--color-text-faint)]">{count}</span>}
      </summary>
      <div className="ml-5 pl-2 border-l border-[var(--color-border)] space-y-1.5 pb-2">{children}</div>
    </details>
  );
}

export default function RoleModelTree({ orgId }: { orgId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [libs, setLibs] = useState<Lib[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [m, l, t] = await Promise.all([
          supabase.from("org_members").select("uid, display_name, email, role, roles, status").eq("org_id", orgId).eq("status", "active"),
          supabase.from("libraries").select("id, name, owner_user_id, owner_name, owner_team_id, acl_index").eq("org_id", orgId),
          supabase.from("teams").select("id, name, supervisor_user_id").eq("org_id", orgId),
        ]);
        const rows = (m.data ?? []) as Array<Record<string, unknown>>;
        setMembers(rows.map((r) => ({
          uid: String(r.uid), name: String(r.display_name || r.email || r.uid),
          role: String(r.role ?? "Viewer"), roles: (r.roles as string[] | null) ?? [], status: String(r.status),
        })));
        const supName = new Map(rows.map((r) => [String(r.uid), String(r.display_name || r.email || "")]));
        setTeams((((t.data ?? []) as Array<Record<string, unknown>>)).map((r) => ({
          id: String(r.id), name: String(r.name),
          supervisorName: r.supervisor_user_id ? (supName.get(String(r.supervisor_user_id)) ?? "member") : null,
        })));
        const teamNameById = new Map((((t.data ?? []) as Array<Record<string, unknown>>)).map((r) => [String(r.id), String(r.name)]));
        setLibs((((l.data ?? []) as Array<Record<string, unknown>>)).map((r) => {
          const idx = (r.acl_index as { allow?: { users?: Record<string, string[]>; roles?: Record<string, string[]>; teams?: Record<string, string[]> } } | null) ?? null;
          const grants = [
            ...(idx?.allow?.users?.publish ?? []).map((u) => supName.get(u) ?? "user grant"),
            ...(idx?.allow?.users?.admin ?? []).map((u) => `${supName.get(u) ?? "user"} (admin)`),
            ...(idx?.allow?.roles?.publish ?? []).map((x) => `role: ${x}`),
            ...(idx?.allow?.roles?.admin ?? []).map((x) => `role: ${x} (admin)`),
            // Team grants are live authority (canPublishViaIndex + the DB
            // function both honor allow.teams) — listing users and roles but
            // not teams hid real publishers from the one place they're listed.
            ...(idx?.allow?.teams?.publish ?? []).map((x) => `team: ${teamNameById.get(x) ?? "team"}`),
            ...(idx?.allow?.teams?.admin ?? []).map((x) => `team: ${teamNameById.get(x) ?? "team"} (admin)`),
          ];
          const ownerUserId = (r.owner_user_id as string | null) ?? null;
          // Owner EXISTENCE comes from owner_user_id; owner_name is a
          // write-once snapshot that drifts (DEL-8). Resolve the display name
          // live from the membership rows loaded above.
          const ownerName = ownerUserId
            ? (supName.get(ownerUserId) || (r.owner_name as string | null) || "assigned member")
            : null;
          return { id: String(r.id), name: String(r.name), ownerUserId, ownerName, ownerTeamId: (r.owner_team_id as string | null) ?? null, publishGrants: grants };
        }));
      } catch { /* tree still renders the static model */ }
    })();
  }, [orgId]);

  const holdersOf = (role: string) => members.filter((m) => {
    if (role.startsWith("Engineer")) return m.role.includes("Engineer") || m.roles.some((x) => x.includes("Engineer"));
    if (role.includes("/")) return role.split(" / ").some((r) => m.role === r.trim() || m.roles.includes(r.trim()));
    return m.role === role || m.roles.includes(role);
  });
  const teamName = (id: string | null) => teams.find((t) => t.id === id) ?? null;

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-5">
      <div className="flex items-center gap-2 mb-1">
        <GitBranch className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-base font-bold text-[var(--color-text)]">Role model — who can do what</span>
      </div>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">
        Generated from a code audit of every enforcement point. Two kinds of authority exist: <b>base roles</b> (set in Users) and <b>situational authority</b> (ownership, per-library grants, review rosters) that applies regardless of role.
      </p>

      <Fold label={<span className="inline-flex items-center gap-1.5"><Users className="w-4 h-4 text-blue-600 dark:text-blue-400" /> Base roles</span>} count={members.length}>
        {TIERS.map((tier) => (
          <Fold key={tier.tier} label={tier.tier}>
            <p className="text-[11px] text-[var(--color-text-muted)] px-1">{tier.blurb}</p>
            {tier.roles.map((r) => {
              const holders = holdersOf(r.role);
              return (
                <Fold key={r.role} label={<span>{r.role} <span className="font-normal text-[var(--color-text-muted)]">— {r.summary}</span></span>} count={holders.length}>
                  <div className="flex flex-wrap gap-1 px-1">
                    {holders.length === 0 && <span className="text-[11px] italic text-[var(--color-text-faint)]">nobody holds this role</span>}
                    {holders.map((h) => (
                      <span key={h.uid} className="px-2 py-0.5 rounded-full bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[11px] font-bold text-[var(--color-text)]">
                        {h.name}{h.roles.length > 1 ? <span className="text-[var(--color-text-faint)] font-normal"> +{h.roles.length - 1} role{h.roles.length > 2 ? "s" : ""}</span> : null}
                      </span>
                    ))}
                  </div>
                  {r.perms.map(([group, items]) => (
                    <Fold key={group} label={<span className="text-xs font-bold text-[var(--color-text-muted)]">{group}</span>}>
                      <ul className="space-y-0.5 px-1">
                        {items.map((it, i) => (
                          <li key={i} className="text-[11px] text-[var(--color-text)] flex gap-1.5"><span className="text-[var(--color-text-faint)]">▸</span> {it}</li>
                        ))}
                      </ul>
                    </Fold>
                  ))}
                </Fold>
              );
            })}
          </Fold>
        ))}
      </Fold>

      <Fold label={<span className="inline-flex items-center gap-1.5"><KeyRound className="w-4 h-4 text-violet-600 dark:text-violet-400" /> Situational authority (beyond the role field)</span>}>
        {SITUATIONAL.map((s) => (
          <Fold key={s.title} label={<span className="text-sm">{s.title}</span>}>
            {s.body.map((b, i) => <p key={i} className="text-[11px] text-[var(--color-text)] px-1">{b}</p>)}
          </Fold>
        ))}
        <Fold label={<span className="text-sm">Live: library owners &amp; publish grants</span>} count={libs.length}>
          {libs.map((l) => {
            const team = teamName(l.ownerTeamId);
            return (
              <div key={l.id} className="text-[11px] text-[var(--color-text)] px-1">
                <b>{l.name}</b> — owner: {l.ownerUserId ? l.ownerName : (team ? `team ${team.name}${team.supervisorName ? ` (supervisor ${team.supervisorName})` : ""}` : <span className="italic text-[var(--color-text-faint)]">none → falls to Admin/DocCtrl</span>)}
                {l.publishGrants.length > 0 && <> · publish grants: {l.publishGrants.join(", ")}</>}
              </div>
            );
          })}
          {libs.length === 0 && <span className="text-[11px] italic text-[var(--color-text-faint)] px-1">no libraries</span>}
        </Fold>
      </Fold>

      <Fold tone="warn" label={<span className="inline-flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> Known gaps &amp; inconsistencies</span>} count={GAPS.length}>
        <ul className="space-y-1 px-1">
          {GAPS.map((g, i) => (
            <li key={i} className="text-[11px] text-[var(--color-text)] flex gap-1.5"><span className="text-amber-600 dark:text-amber-400">▸</span> {g}</li>
          ))}
        </ul>
        <p className="text-[11px] text-[var(--color-text-muted)] px-1 inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> These are candidates for the cleanup we&apos;ll plan next — documented here so the tree stays honest.</p>
      </Fold>
    </div>
  );
}
