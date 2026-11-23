"use client";

// EventOrganization: the roles this event requires and who fills each
// (lib/eventOrganization). It starts from the roles a turnaround is run
// with; change the list to your own, tick the ones that are required, and
// name a person for each. The post-event review reads it.

import { Card } from "@/components/ui/PageHero";
import React, { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";
import { defaultRoles, loadOrg, orgStanding, saveOrg, type OrgRole } from "@/lib/eventOrganization";
import { sayError } from "@/components/projects/sayError";
import { SkeletonRows } from "@/components/ui/Skeleton";

const field = "w-full h-9 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-[14px] text-[var(--color-text)] disabled:opacity-70";
const label = "text-[13px] font-semibold text-[var(--color-text-muted)]";
const btn = "inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap disabled:opacity-50";
const pri = "inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[14px] font-semibold hover:bg-[var(--color-accent-hover)] whitespace-nowrap disabled:opacity-50";

export default function EventOrganization({ projectId, canManage, actor, people }: {
  projectId: string; canManage: boolean; actor: { email: string | null };
  /** Names to pick from (the project's members); any name can be typed. */
  people: string[];
}) {
  const [roles, setRoles] = useState<OrgRole[] | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Saved: read as a list (role, who); Edit opens the table.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let live = true;
    loadOrg(projectId).then((r) => { if (live) { setRoles(r ?? defaultRoles()); setRecorded(r != null); setDirty(false); } }).catch((e) => { if (live) { setErr(sayError(e)); setRoles(defaultRoles()); } });
    return () => { live = false; };
  }, [projectId]);
  const st = useMemo(() => orgStanding(roles), [roles]);
  if (!roles) return <Card label="Event organization" pad={false}><SkeletonRows rows={6} cols={1} what="the event organization" sheet={false} /></Card>;

  const change = (id: string, patch: Partial<OrgRole>) => { setRoles((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r))); setDirty(true); };
  const add = () => { setRoles((rs) => [...(rs ?? []), { id: `r${Date.now()}`, role: "", does: "", person: "", required: true }]); setDirty(true); };
  const remove = (id: string) => { setRoles((rs) => (rs ?? []).filter((r) => r.id !== id)); setDirty(true); };
  const save = async () => {
    setBusy(true); setErr(null);
    try { const saved = await saveOrg(projectId, roles.filter((r) => r.role.trim()), { name: actor.email }); setRoles(saved); setRecorded(true); setDirty(false); setEditing(false); }
    catch (e) { setErr(sayError(e)); }
    finally { setBusy(false); }
  };
  const all = st.required > 0 && st.missing.length === 0;

  return (
    <Card as="section" pad={false} className="overflow-hidden" label="Event organization"
      action={<span className="inline-flex flex-wrap items-center justify-end gap-x-3 gap-y-1 min-w-0">
        <span className={`ui-pill ${!recorded ? "is-warn" : all ? "is-good" : "is-bad"}`} data-event-organization>
          {!recorded ? "Not recorded yet" : `${st.filled} of ${st.required} required roles named`}
        </span>
        {recorded && !editing && canManage && <button type="button" onClick={() => setEditing(true)} className={btn}>Edit roles</button>}
      </span>}>
      {err && <div role="alert" className="mx-4 sm:mx-5 mt-3 text-[14px] font-semibold text-[var(--state-overdue)]">{err}</div>}
      {recorded && !editing ? (
        // The roles this event requires and who fills each: a ruled table.
        <table className="w-full text-[15px]">
          <thead className="max-sm:hidden bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
            <tr className="border-b border-[var(--color-border)]">
              <th scope="col" className="font-semibold px-4 h-10 w-[28%]">Role</th>
              <th scope="col" className="font-semibold px-4 w-[22%]">Who</th>
              <th scope="col" className="font-semibold px-4">Responsible for</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {roles.map((r) => {
              const named = r.person.trim();
              return (
                <tr key={r.id} className="align-top max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:px-4 max-sm:py-2.5">
                  <th scope="row" className="sm:px-4 sm:py-2.5 text-left font-semibold text-[var(--color-text)] max-sm:flex-1">{r.role}</th>
                  <td className="sm:px-4 sm:py-2">
                    {named
                      ? <span className="inline-flex items-center gap-2 text-[var(--color-text)]"><span aria-hidden className="w-7 h-7 shrink-0 rounded-full grid place-items-center bg-[var(--color-surface-2)] border border-[var(--color-border)] font-display text-[11px] font-semibold text-[var(--color-text-muted)]">{named.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span>{named}</span>
                      : <span className={`ui-pill ${r.required ? "is-bad" : "is-muted"}`}>{r.required ? "Not named (required)" : "Not named"}</span>}
                  </td>
                  <td className="sm:px-4 sm:py-2.5 text-[14px] text-[var(--color-text-muted)] max-sm:basis-full">{r.does}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (<>
      <div className="hidden md:grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1fr)_76px_32px] gap-2 px-4 sm:px-5 pt-3">
        <span className={label}>Role</span><span className={label}>Responsible for</span><span className={label}>Who</span><span className={label}>Required</span><span />
      </div>
      <ul className="px-4 sm:px-5 py-2 space-y-2 max-md:divide-y max-md:divide-[var(--color-border)]">
        {roles.map((r) => (
          <li key={r.id} className="grid gap-2 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1fr)_76px_32px] md:items-center max-md:pt-2">
            <input aria-label="Role" disabled={!canManage} value={r.role} onChange={(e) => change(r.id, { role: e.target.value })} placeholder="Role" className={`${field} font-semibold`} />
            <input aria-label="Responsible for" disabled={!canManage} value={r.does} onChange={(e) => change(r.id, { does: e.target.value })} placeholder="What this role is responsible for" className={field} />
            <input aria-label={`Who fills ${r.role || "this role"}`} list="eo-people" disabled={!canManage} value={r.person} onChange={(e) => change(r.id, { person: e.target.value })} placeholder={r.required ? "Name (required)" : "Name"} className={`${field} ${r.required && !r.person.trim() ? "!border-[var(--state-overdue)]" : ""}`} />
            <label className="inline-flex items-center gap-1.5 text-[14px] text-[var(--color-text)]"><input type="checkbox" disabled={!canManage} checked={r.required} onChange={(e) => change(r.id, { required: e.target.checked })} className="w-4 h-4" /><span className="md:hidden">Required</span></label>
            {canManage ? <button type="button" aria-label={`Remove ${r.role || "role"}`} onClick={() => remove(r.id)} className="justify-self-start md:justify-self-center w-8 h-8 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--state-overdue)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button> : <span />}
          </li>
        ))}
      </ul>
      <datalist id="eo-people">{people.map((p) => <option key={p} value={p} />)}</datalist>
      <div className="px-4 sm:px-5 pb-4 flex items-center gap-2 flex-wrap">
        {canManage && <button type="button" onClick={add} className={btn}><Plus className="w-4 h-4" /> Add a role</button>}
        {canManage && <button type="button" disabled={busy || (!dirty && recorded)} onClick={() => void save()} className={pri}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {recorded ? "Save changes" : "Save as this event's organization"}</button>}
        {recorded && <button type="button" onClick={() => { setEditing(false); setDirty(false); void loadOrg(projectId).then((r) => { if (r) setRoles(r); }).catch((e) => setErr(sayError(e))); }} className={btn}>Cancel</button>}
        <span className="text-[13px] text-[var(--color-text-muted)]">{!recorded ? "This is the starting list. Nothing counts until you save it." : st.missing.length ? `Not named: ${st.missing.join(", ")}.` : "Every required role has a name."}</span>
      </div>
      </>)}
    </Card>
  );
}
