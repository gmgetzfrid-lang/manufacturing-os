"use client";

// SlaEscalationSection — drafting-flow Round G, DF-P22: FRIC-1 done-when 2 /
// GAP-106, the escalation tier above the queue owners, on Admin → Request
// forms.
//
// The workspace MAY name an escalation contact — one member, or everyone
// holding a role — and a period. A request whose SLA breach its queue owners
// have not cleared within that period is then told to the contact once per
// breach per period (lib/ticketSla.ts runSlaEscalationScan, the daily
// maintenance run). Escalation only tells: it never reassigns, never changes
// a status, never blocks anyone. Nothing named = exactly today's SLA clock.
//
// DF-P22 fix pass: ONLY AN ADMIN changes it. The queue owners it sits above
// (DraftingSupervisor holders) edit the rest of this page, so the setting is
// not part of the page's Save: it has its own Save, through
// /api/admin/sla-escalation (Admin by the held collection; an audit row for
// every change; the previous contact is told). Everyone else the page admits
// sees what is set, read-only. A Contractor role or a Contractor-only member
// is never offered (they read only their own requests).

import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { ALL_ROLES } from "@/types/schema";
import { isContractorOnly } from "@/lib/ticketReadScope";
import {
  SLA_ESCALATION_DEFAULT_DAYS, SLA_ESCALATION_MAX_DAYS, SLA_ESCALATION_REFUSED_ROLES, type SlaEscalationConfig,
} from "@/lib/ticketSla";

interface MemberOption { uid: string; label: string }

/** The roles the editor offers (never a Contractor role). */
export const ESCALATION_ROLE_OPTIONS: readonly string[] = (ALL_ROLES as readonly string[]).filter((r) => !SLA_ESCALATION_REFUSED_ROLES.includes(r));

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` };
}

export default function SlaEscalationSection({ orgId }: { orgId: string | null }) {
  const [loaded, setLoaded] = useState<{ config: SlaEscalationConfig | null; error: string | null; canEdit: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SlaEscalationConfig | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async (alive: () => boolean) => {
    if (!orgId) return;
    try {
      const res = await fetch(`/api/admin/sla-escalation?orgId=${encodeURIComponent(orgId)}`, { headers: await authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!alive()) return;
      if (!res.ok) { setLoadError(typeof body?.error === "string" ? body.error : "The escalation setting could not be read."); return; }
      const next = { config: (body.config ?? null) as SlaEscalationConfig | null, error: (body.error ?? null) as string | null, canEdit: body.canEdit === true };
      setLoaded(next);
      setDraft(next.config);
      setLoadError(null);
    } catch (e) {
      if (alive()) setLoadError((e as Error)?.message ?? "The escalation setting could not be read.");
    }
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    void load(() => alive);
    (async () => {
      const { data } = await supabase.from("org_members").select("uid, display_name, email, role, roles").eq("org_id", orgId).eq("status", "active");
      if (!alive) return;
      setMembers((((data as Array<{ uid: string; display_name?: string | null; email?: string | null; role?: string | null; roles?: string[] | null }> | null) ?? []))
        .filter((m) => !isContractorOnly(m))
        .map((m) => ({ uid: m.uid, label: (m.display_name ?? "").trim() || (m.email ?? m.uid) }))
        .sort((a, b) => a.label.localeCompare(b.label)));
    })();
    return () => { alive = false; };
  }, [orgId, load]);

  const canEdit = loaded?.canEdit === true;
  const config = draft;
  const kind = config?.contact.kind ?? "none";
  const period = config?.periodDays ?? SLA_ESCALATION_DEFAULT_DAYS;
  const dirty = loaded !== null && JSON.stringify(loaded.config) !== JSON.stringify(draft);
  const set = (next: SlaEscalationConfig | null) => { setDraft(next); setMessage(null); };
  const nameOf = (uid: string) => members.find((m) => m.uid === uid)?.label ?? "a member who is no longer active";
  const describe = (c: SlaEscalationConfig | null) => !c ? "Nobody (off) — today's behaviour."
    : `${c.contact.kind === "member" ? nameOf(c.contact.uid) : `everyone holding ${c.contact.role}`}, after ${c.periodDays} day(s) overdue and not cleared.`;

  const save = async () => {
    if (!orgId) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/sla-escalation", { method: "PUT", headers: await authHeaders(), body: JSON.stringify({ orgId, config: draft }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage({ tone: "error", text: typeof body?.error === "string" ? body.error : "Not saved." }); return; }
      setLoaded((l) => (l ? { ...l, config: draft, error: null } : l));
      setMessage(typeof body?.warning === "string" ? { tone: "error", text: body.warning } : { tone: "ok", text: "Saved. The change is on the audit trail." });
    } catch (e) {
      setMessage({ tone: "error", text: `Not saved: ${(e as Error)?.message ?? "the request failed"}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm p-5 space-y-3" data-testid="sla-escalation">
      <div className="text-sm font-bold text-[var(--color-text)]">Escalation above the queue</div>
      <p className="text-xs text-[var(--color-text-muted)]">
        When a request is overdue, its queue owners are told. Name someone to hear about it if the queue has not cleared it within a period — they are told once per period while it stays overdue, in one notice per run. Escalation only tells: nothing is reassigned or changed. Leave it off to keep today&apos;s behaviour.
      </p>
      {loadError && <p role="alert" className="text-xs text-amber-700">{loadError}</p>}
      {loaded?.error && <p role="alert" className="text-xs text-amber-700">The stored escalation setting can&apos;t be used ({loaded.error}) — nobody is escalated to until an Admin sets it again here.</p>}
      {loaded && !canEdit && (
        <p className="text-xs text-[var(--color-text)]" data-testid="sla-escalation-readonly">
          <span className="font-bold">Escalates to:</span> {describe(loaded.config)}{" "}
          <span className="text-[var(--color-text-muted)]">Only an Admin can change this — the queue owners it sits above cannot switch it off or point it at themselves.</span>
        </p>
      )}
      {loaded && canEdit && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              <span className="text-[var(--color-text-muted)]">Escalate to</span>
              <select aria-label="Escalation contact kind" className="border border-[var(--color-border)] rounded px-2 py-1" value={kind}
                onChange={(e) => {
                  const k = e.target.value;
                  if (k === "none") set(null);
                  else if (k === "member") set(members[0] ? { contact: { kind: "member", uid: members[0].uid }, periodDays: period } : null);
                  else set({ contact: { kind: "role", role: "Admin" }, periodDays: period });
                }}>
                <option value="none">Nobody (off)</option>
                <option value="member">A member</option>
                <option value="role">Everyone holding a role</option>
              </select>
            </label>
            {config?.contact.kind === "member" && (
              <select aria-label="Escalation member" className="border border-[var(--color-border)] rounded px-2 py-1" value={config.contact.uid}
                onChange={(e) => set({ contact: { kind: "member", uid: e.target.value }, periodDays: period })}>
                {!members.some((m) => m.uid === (config.contact as { uid: string }).uid) && <option value={config.contact.uid}>A member who is no longer active</option>}
                {members.map((m) => <option key={m.uid} value={m.uid}>{m.label}</option>)}
              </select>
            )}
            {config?.contact.kind === "role" && (
              <select aria-label="Escalation role" className="border border-[var(--color-border)] rounded px-2 py-1" value={config.contact.role}
                onChange={(e) => set({ contact: { kind: "role", role: e.target.value }, periodDays: period })}>
                {ESCALATION_ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            )}
            {config && (
              <label className="flex items-center gap-1">
                <span className="text-[var(--color-text-muted)]">after</span>
                <input aria-label="Escalation period days" type="number" min={1} max={SLA_ESCALATION_MAX_DAYS} className="w-16 border border-[var(--color-border)] rounded px-2 py-1"
                  value={period}
                  onChange={(e) => {
                    const d = Math.round(Number(e.target.value));
                    if (Number.isInteger(d) && d >= 1 && d <= SLA_ESCALATION_MAX_DAYS) set({ contact: config.contact, periodDays: d });
                  }} />
                <span className="text-[var(--color-text-muted)]">day(s) overdue and not cleared (1–{SLA_ESCALATION_MAX_DAYS})</span>
              </label>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="px-3 py-1 text-xs font-bold rounded bg-[var(--color-accent)] text-white disabled:opacity-50" disabled={!dirty || saving} onClick={() => { void save(); }}>
              {saving ? "Saving…" : "Save escalation"}
            </button>
            <span className="text-[11px] text-[var(--color-text-faint)]">Saved on its own (not with the rest of this page). Only an Admin can change it; every change is on the audit trail.</span>
          </div>
        </>
      )}
      {message && <p role={message.tone === "error" ? "alert" : "status"} className={`text-xs ${message.tone === "error" ? "text-red-700" : "text-green-700"}`}>{message.text}</p>}
    </div>
  );
}
