"use client";

// PermissionsExplorer: the IT-department view of the whole app.
// One matrix: every capability in the product (rows, grouped by area) ×
// every role (columns). ✓ = can do · ◐ = conditional (hover the cell for
// why) · — = cannot. Filter by area, role, or free text. Derived from a
// code audit of every enforcement point; ⚠ rows mark known gaps where the
// UI and the server disagree today.

import React, { useMemo, useState } from "react";
import { Search, Check, AlertTriangle } from "lucide-react";
import { bandInput, bandInputIcon, bandSelect } from "@/components/admin/band";

// Column order for the mark strings below.
const ROLES = ["Admin", "DocCtrl", "Manager", "Supervisor", "DraftingSup", "Engineer 1-4", "Drafter", "Requester", "Staff*", "Contractor", "Auditor", "Viewer"];
const STAFF_NOTE = "Staff* means Accounting, Safety, HR, Maintenance and Operations (request-only roles)";

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
  { area: "Publishing", cap: "Force-unlock a checkout", m: "yy----------", cond: "Database-enforced; delegable per person or role under Action permissions" },
  { area: "Publishing", cap: "Revert to a prior revision", m: "yy----------" },
  { area: "Publishing", cap: "Check out / check in documents", m: "yyyyyyyyyyyy" },
  { area: "Publishing", cap: "Open / release holds", m: "yyyyyyyyyyyy", cond: "Default: everyone. Admin-configurable under Action permissions; enforced at the database" },
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
  { area: "Metrics", cap: "Analytics dashboards (/admin/analytics)", m: "yyyy--------", cond: "Default: management + DocCtrl. Admin-configurable under Action permissions" },
  { area: "Metrics", cap: "Audit log", m: "yyyy------y-" },
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
    return filtered.map((r, i) => ({ ...r, first: i === 0 || filtered[i - 1].area !== r.area }));
  }, [q, area, role]);

  const cell = (r: Row, i: number) => {
    const v = r.m[i];
    if (v === "y") return <Check aria-label="Can" className="w-4 h-4 mx-auto text-[var(--color-text)]" strokeWidth={2.5} />;
    if (v === "c") return <span role="img" aria-label={`Sometimes: ${r.cond ?? "it depends"}`} title={r.cond ?? "It depends"} className="inline-block w-3 h-3 rounded-full border-2 border-[var(--color-text-muted)] [background:linear-gradient(90deg,var(--color-text-muted)_50%,transparent_50%)] cursor-help" />;
    return <span aria-label="Can't" className="text-[var(--color-text-faint)]">-</span>;
  };

  const ctl = `${bandSelect} !h-9 pointer-coarse:!h-11`;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className={bandInputIcon} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a permission" aria-label="Find a permission" className={`${bandInput} !h-9 pointer-coarse:!h-11`} />
        </div>
        <select value={area} aria-label="Area" onChange={(e) => setArea(e.target.value)} className={ctl}>
          <option value="all">All areas</option>
          {AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={role} aria-label="Role" onChange={(e) => setRole(Number(e.target.value))} className={ctl}>
          <option value={-1}>All roles</option>
          {ROLES.map((r, i) => <option key={r} value={i}>What {r} can do</option>)}
        </select>
        <span className="text-[13px] text-[var(--color-text-muted)] inline-flex items-center gap-3 sm:ml-auto">
          <span className="inline-flex items-center gap-1"><Check aria-hidden className="w-3.5 h-3.5" strokeWidth={2.5} /> Can</span>
          <span className="inline-flex items-center gap-1"><span aria-hidden className="inline-block w-3 h-3 rounded-full border-2 border-[var(--color-text-muted)] [background:linear-gradient(90deg,var(--color-text-muted)_50%,transparent_50%)]" /> Sometimes (point at it for why)</span>
          <span className="inline-flex items-center gap-1"><AlertTriangle aria-hidden className="w-3.5 h-3.5 text-[var(--state-held)]" /> Known gap</span>
        </span>
      </div>
      <div className="rounded-xl border border-[var(--color-border)] overflow-auto max-h-[70vh]">
        <table className="w-full text-[13px] border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-[var(--color-surface-2)]">
              <th className="sticky left-0 z-10 bg-[var(--color-surface-2)] text-left font-semibold text-[var(--color-text-muted)] px-3 h-10 min-w-[240px]">Permission</th>
              {ROLES.map((r, i) => (
                <th key={r} className={`px-2 h-10 font-semibold whitespace-nowrap ${role === i ? "text-[var(--color-text)] shadow-[inset_0_-2px_0_var(--color-current)]" : "text-[var(--color-text-muted)]"}`}>{r}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <React.Fragment key={`${r.area}:${r.cap}`}>
                {r.first && (
                  <tr><th scope="rowgroup" colSpan={ROLES.length + 1} className="sticky left-0 bg-[var(--color-surface)] text-left px-3 pt-4 pb-1.5 text-[15px] font-semibold text-[var(--color-text)]">{r.area}</th></tr>
                )}
                <tr className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                  <td className="sticky left-0 bg-[var(--color-surface)] px-3 py-2 text-[14px] text-[var(--color-text)]">
                    {r.cap}
                    {r.warn && <span className="ml-1.5 inline-flex align-[-2px] cursor-help" title={r.warn}><AlertTriangle aria-label={`Known gap: ${r.warn}`} className="w-3.5 h-3.5 text-[var(--state-held)]" /></span>}
                  </td>
                  {ROLES.map((_, i) => <td key={i} className={`px-2 py-2 text-center ${role === i ? "bg-[var(--color-surface-2)]" : ""}`}>{cell(r, i)}</td>)}
                </tr>
              </React.Fragment>
            ))}
            {rows.length === 0 && <tr><td colSpan={ROLES.length + 1} className="px-3 py-6 text-center text-[var(--color-text-muted)]">Nothing matches. Clear the search or pick all areas.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">{STAFF_NOTE}. Beyond roles, owning a document, folder or library (or supervising the team that owns it) and per-library grants add the &ldquo;sometimes&rdquo; cases.</p>
    </div>
  );
}
