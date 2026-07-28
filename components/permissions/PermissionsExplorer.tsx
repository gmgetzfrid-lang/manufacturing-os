"use client";

// PermissionsExplorer — the IT-department view of the ENTIRE app.
// One matrix: every capability in the product (rows, grouped by area) ×
// every role (columns). ✓ = can do · ◐ = conditional (hover the cell for
// why) · — = cannot. Filter by area, role, or free text. Derived from a
// code audit of every enforcement point; ⚠ rows mark known gaps where the
// UI and the server disagree today.

import React, { useMemo, useState } from "react";
import { Search, ShieldCheck } from "lucide-react";

// Column order for the mark strings below.
const ROLES = ["Admin", "DocCtrl", "Manager", "Supervisor", "DraftingSup", "Engineer 1-4", "Drafter", "Requester", "Staff*", "Contractor", "Auditor", "Viewer"];
const STAFF_NOTE = "*Staff = Accounting, Safety, HR, Maintenance, Operations (request-only roles)";

// m: 12 chars in ROLES order — y (yes), c (conditional), - (no).
interface Row { area: string; cap: string; m: string; cond?: string; warn?: string }

const ROWS: Row[] = [
  // ── Documents & files ──
  { area: "Documents", cap: "Browse & read documents", m: "yyyyyyyyyyyy", cond: "Subject to each library/folder's visibility & ACL" },
  { area: "Documents", cap: "Upload files / create folders", m: "yycccccccc-c", cond: "Per-library ACL grant" },
  { area: "Documents", cap: "Download / print (stamped when uncontrolled)", m: "yyyyyyyyyyyy", cond: "A hard read-&-understood gate can block until signed" },
  { area: "Documents", cap: "Edit document metadata", m: "yy----------" },
  { area: "Documents", cap: "Edit equipment / asset tags", m: "yyyy-yy-----" },
  { area: "Documents", cap: "Manage sets & binders", m: "yy----------" },
  { area: "Documents", cap: "Delete documents / versions", m: "yy----------", cond: "Legal-hold rows are undeletable for everyone" },
  { area: "Documents", cap: "Request deletion (owner path)", m: "--cccccccccc", cond: "If effective owner of the document" },
  // ── Publishing & revisions ──
  { area: "Publishing", cap: "Publish / rev-up a revision", m: "yycccccc-c--", cond: "If effective owner OR per-library publish grant" },
  { area: "Publishing", cap: "Publish over someone's checkout (reason required)", m: "yycccccc-c--", cond: "Same authority as publishing; never passes a hold" },
  { area: "Publishing", cap: "Force past an active hold", m: "yy----------" },
  { area: "Publishing", cap: "Force-unlock a checkout", m: "yy----------", warn: "UI-gate only today — no server enforcement" },
  { area: "Publishing", cap: "Revert to a prior revision", m: "yy----------" },
  { area: "Publishing", cap: "Check out / check in documents", m: "yyyyyyyyyyyy" },
  { area: "Publishing", cap: "Open / release holds", m: "yyyyyyyyyyyy", warn: "No role gate today — flagged for cleanup" },
  { area: "Publishing", cap: "Place / release legal hold", m: "yycccccccccc", cond: "If effective owner" },
  // ── Reviews & compliance ──
  { area: "Reviews", cap: "Configure review policies & rosters", m: "yycccccccccc", cond: "If effective owner" },
  { area: "Reviews", cap: "Sign a review (e-signature)", m: "cccccccccccc", cond: "Only your own roster row" },
  { area: "Reviews", cap: "Auto-publish as last review signer", m: "yycccccc----", cond: "Signer must also hold publish authority" },
  { area: "Reviews", cap: "Acknowledge read-&-understood", m: "cccccccccccc", cond: "Only your own assignment row" },
  { area: "Reviews", cap: "Retention, disposition & purge", m: "yy----------" },
  { area: "Reviews", cap: "Access recertification reviews", m: "yycccccccccc", cond: "If library owner" },
  // ── Drafting requests ──
  { area: "Requests", cap: "Create a drafting request", m: "yyyyyyyyyy--" },
  { area: "Requests", cap: "Initial engineering approval / reject", m: "y-yy-y------" },
  { area: "Requests", cap: "Assign a drafter", m: "y-yyy-------" },
  { area: "Requests", cap: "Self-assign drafting work", m: "------y-----" },
  { area: "Requests", cap: "Do drafting work (save, submit, IFC)", m: "------c-----", cond: "Assigned drafter (or Drafter role when unassigned)" },
  { area: "Requests", cap: "Review the returned draft (accept / send back)", m: "cccccccycccc", cond: "The requester of that ticket, whatever their role" },
  { area: "Requests", cap: "Final engineer approval", m: "y-yy-c------", cond: "Assigned engineer" },
  { area: "Requests", cap: "Force-close / reopen tickets", m: "y-yy--------" },
  { area: "Requests", cap: "Reassign engineer at final approval", m: "y-----------" },
  // ── Packages & distribution ──
  { area: "Packages", cap: "Create / edit / refresh work packages", m: "yyyyyyyyyyyy", warn: "No role differentiation today" },
  { area: "Packages", cap: "Request distribution confirmations", m: "yyyyyyyyyyyy" },
  { area: "Packages", cap: "Confirm “I have this revision”", m: "cccccccccccc", cond: "Only your own confirmation row" },
  // ── Projects & equipment ──
  { area: "Projects", cap: "Create / manage projects & schedules", m: "yycccccccccc", cond: "Project owner or member" },
  { area: "Projects", cap: "Equipment / asset admin pages", m: "y-yy--------" },
  // ── Metrics & analytics ──
  { area: "Metrics", cap: "Analytics dashboards (/admin/analytics)", m: "yyyyyyyyyyyy", warn: "No role guard today — any member via URL" },
  { area: "Metrics", cap: "Audit log", m: "y-yy-------y", warn: "Auditor role is NOT admitted today (gap); Viewer column here = no" },
  { area: "Metrics", cap: "Storage stats", m: "yyy---------" },
  // ── Administration ──
  { area: "Admin", cap: "User management (invite, roles)", m: "y-y---------", cond: "Only an Admin can grant the Admin role" },
  { area: "Admin", cap: "Teams & team supervisors", m: "y-y---------" },
  { area: "Admin", cap: "Library creation & config", m: "yy----------" },
  { area: "Admin", cap: "Per-library permission (ACL) drawer", m: "yy----------" },
  { area: "Admin", cap: "Request-form & routing config", m: "yy----------" },
  { area: "Admin", cap: "Operational scope", m: "y-yy--------" },
  { area: "Admin", cap: "Release stale checkouts (/admin/holds)", m: "y-yy--------" },
  { area: "Admin", cap: "Data export & backups", m: "yyy---------" },
  { area: "Admin", cap: "Storage purge & archive shed", m: "yy----------" },
  { area: "Admin", cap: "Restore from backup", m: "y-----------" },
  { area: "Admin", cap: "Billing & subscription", m: "y-y---------" },
  { area: "Admin", cap: "Branding & workspace settings", m: "yy----------", cond: "Branding itself is Admin-only" },
];

const AREAS = [...new Set(ROWS.map((r) => r.area))];

export default function PermissionsExplorer() {
  const [q, setQ] = useState("");
  const [area, setArea] = useState("all");
  const [role, setRole] = useState(-1);

  const rows = useMemo(() => {
    const filtered = ROWS.filter((r) => {
      if (area !== "all" && r.area !== area) return false;
      if (role >= 0 && r.m[role] === "-") return false;
      if (q && !`${r.area} ${r.cap} ${r.cond ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
    let last = "";
    return filtered.map((r) => { const first = r.area !== last; last = r.area; return { ...r, first }; });
  }, [q, area, role]);

  const cell = (r: Row, i: number) => {
    const v = r.m[i];
    if (v === "y") return <span className="text-emerald-600 dark:text-emerald-400 font-black">✓</span>;
    if (v === "c") return <span className="text-amber-600 dark:text-amber-400 font-black cursor-help" title={r.cond ?? "Conditional"}>◐</span>;
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
            {AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select value={role} onChange={(e) => setRole(Number(e.target.value))} className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
            <option value={-1}>All roles</option>
            {ROLES.map((r, i) => <option key={r} value={i}>Can: {r}</option>)}
          </select>
        </div>
      </div>
      <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-[var(--color-surface-2)]">
              <th className="sticky left-0 bg-[var(--color-surface-2)] text-left font-black px-3 py-2 min-w-[240px]">Capability</th>
              {ROLES.map((r, i) => (
                <th key={r} className={`px-2 py-2 font-black whitespace-nowrap ${role === i ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)]"}`}>{r}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              return (
                <React.Fragment key={`${r.area}:${r.cap}`}>
                  {r.first && (
                    <tr><td colSpan={ROLES.length + 1} className="sticky left-0 bg-[var(--color-surface)] px-3 pt-3 pb-1 text-[11px] font-black uppercase tracking-wider text-[var(--color-accent)]">{r.area}</td></tr>
                  )}
                  <tr className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]/50">
                    <td className="sticky left-0 bg-[var(--color-surface)] px-3 py-1.5 font-medium text-[var(--color-text)]">
                      {r.cap}
                      {r.warn && <span className="ml-1.5 cursor-help text-amber-600 dark:text-amber-400" title={r.warn}>⚠</span>}
                    </td>
                    {ROLES.map((_, i) => <td key={i} className={`px-2 py-1.5 text-center ${role === i ? "bg-[var(--color-accent-soft)]/40" : ""}`}>{cell(r, i)}</td>)}
                  </tr>
                </React.Fragment>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={ROLES.length + 1} className="px-3 py-6 text-center italic text-[var(--color-text-muted)]">No capabilities match.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-faint)]">{STAFF_NOTE} · Beyond roles, ownership (document → folder → library → owning team&apos;s supervisor) and per-library grants add ◐ authority — see hover notes.</div>
    </div>
  );
}
