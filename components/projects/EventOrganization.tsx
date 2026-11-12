"use client";

// EventOrganization - the roles this event requires and who fills each
// (lib/eventOrganization). It starts from the roles a turnaround is run
// with; change the list to your own, tick the ones that are required, and
// name a person for each. The post-event review reads it.

import React, { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";
import { defaultRoles, loadOrg, orgStanding, saveOrg, type OrgRole } from "@/lib/eventOrganization";

const field = "w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[13px] text-[var(--color-text)] disabled:opacity-70";
const label = "text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)]";
const btn = "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12.5px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap disabled:opacity-50";
const pri = "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[12.5px] font-black whitespace-nowrap disabled:opacity-50";

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
  useEffect(() => {
    let live = true;
    loadOrg(projectId).then((r) => { if (live) { setRoles(r ?? defaultRoles()); setRecorded(r != null); setDirty(false); } }).catch((e) => { if (live) { setErr((e as Error).message); setRoles(defaultRoles()); } });
    return () => { live = false; };
  }, [projectId]);
  const st = useMemo(() => orgStanding(roles), [roles]);
  if (!roles) return <div className="py-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>;

  const change = (id: string, patch: Partial<OrgRole>) => { setRoles((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r))); setDirty(true); };
  const add = () => { setRoles((rs) => [...(rs ?? []), { id: `r${Date.now()}`, role: "", does: "", person: "", required: true }]); setDirty(true); };
  const remove = (id: string) => { setRoles((rs) => (rs ?? []).filter((r) => r.id !== id)); setDirty(true); };
  const save = async () => {
    setBusy(true); setErr(null);
    try { const saved = await saveOrg(projectId, roles.filter((r) => r.role.trim()), { name: actor.email }); setRoles(saved); setRecorded(true); setDirty(false); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const all = st.required > 0 && st.missing.length === 0;

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden" data-event-organization>
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-start gap-x-3 gap-y-1 flex-wrap">
        <div className="min-w-0 flex-1 basis-64">
          <b className="block text-[14.5px] text-[var(--color-text)]">Event organization</b>
          <span className="text-[12.5px] text-[var(--color-text-muted)]">The roles this event requires and who fills each. Change the list to your own. The post-event review reads it.</span>
        </div>
        <span className={`text-[11.5px] font-black px-2 py-1 rounded-full whitespace-nowrap ${!recorded ? "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300" : all ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"}`}>
          {!recorded ? "Not recorded yet" : `${st.filled} of ${st.required} required roles named`}
        </span>
      </div>
      {err && <div role="alert" className="mx-4 mt-3 rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-[12.5px] font-semibold text-rose-800 dark:text-rose-300">{err}</div>}
      <div className="hidden md:grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1fr)_76px_32px] gap-2 px-4 pt-3">
        <span className={label}>Role</span><span className={label}>Responsible for</span><span className={label}>Who</span><span className={label}>Required</span><span />
      </div>
      <ul className="px-4 py-2 space-y-2">
        {roles.map((r) => (
          <li key={r.id} className="grid gap-2 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1fr)_76px_32px] md:items-center rounded-xl md:rounded-none border md:border-0 border-[var(--color-border)] p-2.5 md:p-0">
            <input aria-label="Role" disabled={!canManage} value={r.role} onChange={(e) => change(r.id, { role: e.target.value })} placeholder="Role" className={`${field} font-bold`} />
            <input aria-label="Responsible for" disabled={!canManage} value={r.does} onChange={(e) => change(r.id, { does: e.target.value })} placeholder="What this role is responsible for" className={field} />
            <input aria-label={`Who fills ${r.role || "this role"}`} list="eo-people" disabled={!canManage} value={r.person} onChange={(e) => change(r.id, { person: e.target.value })} placeholder={r.required ? "Name (required)" : "Name"} className={`${field} ${r.required && !r.person.trim() ? "border-rose-400" : ""}`} />
            <label className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--color-text)]"><input type="checkbox" disabled={!canManage} checked={r.required} onChange={(e) => change(r.id, { required: e.target.checked })} className="w-4 h-4" /><span className="md:hidden">Required</span></label>
            {canManage ? <button type="button" aria-label={`Remove ${r.role || "role"}`} onClick={() => remove(r.id)} className="justify-self-start md:justify-self-center text-[var(--color-text-muted)] hover:text-rose-600"><X className="w-4 h-4" /></button> : <span />}
          </li>
        ))}
      </ul>
      <datalist id="eo-people">{people.map((p) => <option key={p} value={p} />)}</datalist>
      <div className="px-4 pb-3.5 flex items-center gap-2 flex-wrap">
        {canManage && <button type="button" onClick={add} className={btn}><Plus className="w-4 h-4" /> Add a role</button>}
        {canManage && <button type="button" disabled={busy || (!dirty && recorded)} onClick={() => void save()} className={pri}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {recorded ? "Save changes" : "Save as this event's organization"}</button>}
        <span className="text-[12px] text-[var(--color-text-muted)]">{!recorded ? "This is the starting list. Nothing counts until you save it." : st.missing.length ? `Not named: ${st.missing.join(", ")}.` : "Every required role has a name."}</span>
      </div>
    </section>
  );
}
