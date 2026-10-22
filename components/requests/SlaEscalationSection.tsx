"use client";

// SlaEscalationSection — drafting-flow Round G, DF-P22: FRIC-1 done-when 2 /
// GAP-106, the escalation tier above the queue owners, on Admin → Request
// forms (the request-form editors set it: 20261209's write rule on the
// 'drafting' key).
//
// The workspace MAY name an escalation contact — one member, or everyone
// holding a role — and a period. A request whose SLA breach its queue owners
// have not cleared within that period is then told to the contact once per
// breach per period (lib/ticketSla.ts runSlaEscalationScan, the daily
// maintenance run). Escalation only tells: it never reassigns, never changes
// a status, never blocks anyone. Nothing named = exactly today's SLA clock.
//
// The value rides the page's settings and is written by the page's own Save
// (`slaEscalation` on the drafting configuration); a page that never touches
// this section saves exactly what it loaded.

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { ALL_ROLES } from "@/types/schema";
import {
  SLA_ESCALATION_DEFAULT_DAYS, SLA_ESCALATION_MAX_DAYS, parseSlaEscalation, type SlaEscalationConfig,
} from "@/lib/ticketSla";

interface MemberOption { uid: string; label: string }

export default function SlaEscalationSection({ orgId, value, onChange }: {
  orgId: string | null;
  value: unknown;
  onChange: (next: SlaEscalationConfig | undefined) => void;
}) {
  const parsed = parseSlaEscalation(value);
  const config = parsed.ok ? parsed.config : null;
  const [members, setMembers] = useState<MemberOption[]>([]);

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    (async () => {
      const { data } = await supabase.from("org_members").select("uid, display_name, email").eq("org_id", orgId).eq("status", "active");
      if (!alive) return;
      setMembers((((data as Array<{ uid: string; display_name?: string | null; email?: string | null }> | null) ?? []))
        .map((m) => ({ uid: m.uid, label: (m.display_name ?? "").trim() || (m.email ?? m.uid) }))
        .sort((a, b) => a.label.localeCompare(b.label)));
    })();
    return () => { alive = false; };
  }, [orgId]);

  const kind = config?.contact.kind ?? "none";
  const period = config?.periodDays ?? SLA_ESCALATION_DEFAULT_DAYS;
  const set = (next: SlaEscalationConfig | undefined) => onChange(next);

  return (
    <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm p-5 space-y-3" data-testid="sla-escalation">
      <div className="text-sm font-bold text-[var(--color-text)]">Escalation above the queue</div>
      <p className="text-xs text-[var(--color-text-muted)]">
        When a request is overdue, its queue owners are told. Name someone to hear about it if the queue has not cleared it within a period — they are told once per period while it stays overdue. Escalation only tells: nothing is reassigned or changed. Leave it off to keep today&apos;s behaviour.
      </p>
      {!parsed.ok && <p role="alert" className="text-xs text-amber-700">The stored escalation setting can&apos;t be used ({parsed.error}) — nobody is escalated to until it is set again here.</p>}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-[var(--color-text-muted)]">Escalate to</span>
          <select aria-label="Escalation contact kind" className="border border-[var(--color-border)] rounded px-2 py-1" value={kind}
            onChange={(e) => {
              const k = e.target.value;
              if (k === "none") set(undefined);
              else if (k === "member") set(members[0] ? { contact: { kind: "member", uid: members[0].uid }, periodDays: period } : undefined);
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
            {ALL_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
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
      <p className="text-[11px] text-[var(--color-text-faint)]">Saved with the rest of this page.</p>
    </div>
  );
}
