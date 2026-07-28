"use client";

// CapabilityPolicyEditor — the "Actions" side of the permissions console.
// Content permissions govern WHO SEES WHAT; this governs WHO MAY DO WHAT:
// every drafting-request workflow transition, holds, force-release, and the
// metrics/admin surfaces. Checkbox grid per capability × role token.
//
// Rails: critical capabilities can never lose Admin (validateCapabilityPolicy
// rejects the save), identity rights (a ticket's own requester/drafter/
// assigned engineer) are not configurable by design, and every save writes a
// before/after audit row. Defaults reproduce historical behavior exactly, so
// an untouched policy changes nothing.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { SlidersHorizontal, Loader2, RotateCcw, Check, AlertTriangle } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { appConfirm } from "@/components/providers/DialogProvider";
import {
  CAPABILITY_DEFS, defaultCapabilityPolicy, loadCapabilityPolicy, saveCapabilityPolicy,
  validateCapabilityPolicy, __resetCapabilityPolicyCache,
  type CapabilityId,
} from "@/lib/capabilityPolicy";

const TOKENS = ["*", "Admin", "DocCtrl", "Manager", "Supervisor", "DraftingSupervisor", "Engineer", "Drafter", "Requester", "Viewer", "Contractor", "Auditor"];
const TOKEN_LABEL: Record<string, string> = { "*": "Everyone", DraftingSupervisor: "DraftingSup", Engineer: "Engineer (all tiers)" };

export default function CapabilityPolicyEditor({ canEdit }: { canEdit: boolean }) {
  const { activeOrgId, uid, userEmail } = useRole();
  const [policy, setPolicy] = useState<Record<CapabilityId, string[]> | null>(null);
  const [baseline, setBaseline] = useState<Record<CapabilityId, string[]> | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    const stored = await loadCapabilityPolicy(activeOrgId);
    const merged = { ...defaultCapabilityPolicy(), ...(stored.caps ?? {}) };
    setPolicy(merged);
    setBaseline(merged);
    setDirty(false);
  }, [activeOrgId]);
  useEffect(() => { void load(); }, [load]);

  const areas = useMemo(() => [...new Set(CAPABILITY_DEFS.map((d) => d.area))], []);

  const toggle = (cap: CapabilityId, token: string) => {
    if (!canEdit || !policy) return;
    setPolicy((p) => {
      if (!p) return p;
      const cur = p[cap] ?? [];
      const next = cur.includes(token) ? cur.filter((t) => t !== token) : [...cur, token];
      return { ...p, [cap]: next };
    });
    setDirty(true);
    setMsg(null);
  };

  const save = async () => {
    if (!activeOrgId || !uid || !policy) return;
    const err = validateCapabilityPolicy({ caps: policy });
    if (err) { setMsg({ tone: "err", text: err }); return; }
    // IMPACT PREVIEW — spell out exactly what changes before it takes effect.
    const changes: string[] = [];
    for (const d of CAPABILITY_DEFS) {
      const was = baseline?.[d.id] ?? d.defaultRoles;
      const now = policy[d.id] ?? [];
      const added = now.filter((t) => !was.includes(t));
      const removed = was.filter((t) => !now.includes(t));
      if (added.length || removed.length) {
        changes.push(`${d.label}: ${added.length ? `+${added.join(", +")}` : ""}${added.length && removed.length ? " · " : ""}${removed.length ? `−${removed.join(", −")}` : ""}`);
      }
    }
    if (changes.length > 0) {
      const ok = await appConfirm({
        message: `This changes who can act, effective immediately:\n\n${changes.slice(0, 8).join("\n")}${changes.length > 8 ? `\n…and ${changes.length - 8} more` : ""}\n\nApply?`,
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      // Preserve any per-person grants — this editor only owns the role grid.
      const stored = await loadCapabilityPolicy(activeOrgId);
      await saveCapabilityPolicy({ orgId: activeOrgId, policy: { caps: policy, grants: stored.grants ?? [] }, actorUserId: uid, actorEmail: userEmail });
      __resetCapabilityPolicyCache();
      setDirty(false);
      setMsg({ tone: "ok", text: "Saved — enforced server-side on the next action. Change audited with before/after." });
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally { setSaving(false); }
  };

  const resetDefaults = () => {
    setPolicy(defaultCapabilityPolicy());
    setDirty(true);
    setMsg(null);
  };

  if (!policy) return null;

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] mb-5 overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <SlidersHorizontal className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-base font-bold text-[var(--color-text)]">Action permissions</span>
        <span className="text-xs text-[var(--color-text-muted)]">who may perform each workflow action — enforced on the server, audited on save</span>
        {canEdit && (
          <div className="ml-auto flex items-center gap-2">
            <button onClick={resetDefaults} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              <RotateCcw className="w-3 h-3" /> Restore defaults
            </button>
            <button onClick={() => void save()} disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-40">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save policy
            </button>
          </div>
        )}
      </div>
      {msg && (
        <div className={`mx-4 mt-3 rounded-xl border p-2.5 text-xs flex items-start gap-2 ${msg.tone === "ok" ? "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-300" : "border-rose-500/30 bg-rose-500/[0.06] text-rose-700 dark:text-rose-300"}`}>
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {msg.text}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-[var(--color-surface-2)]">
              <th className="sticky left-0 bg-[var(--color-surface-2)] text-left font-black px-4 py-2 min-w-[230px]">Action</th>
              {TOKENS.map((t) => (
                <th key={t} className="px-2 py-2 font-black text-[var(--color-text-muted)] whitespace-nowrap">{TOKEN_LABEL[t] ?? t}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {areas.map((area) => (
              <React.Fragment key={area}>
                <tr><td colSpan={TOKENS.length + 1} className="sticky left-0 bg-[var(--color-surface)] px-4 pt-3 pb-1 text-[11px] font-black uppercase tracking-wider text-[var(--color-accent)]">{area}</td></tr>
                {CAPABILITY_DEFS.filter((d) => d.area === area).map((d) => (
                  <tr key={d.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]/50">
                    <td className="sticky left-0 bg-[var(--color-surface)] px-4 py-1.5">
                      <span className="font-medium text-[var(--color-text)]">{d.label}</span>
                      {d.critical && <span className="ml-1.5 text-[9px] font-black text-amber-600 dark:text-amber-400 cursor-help" title="Critical: Admin cannot be removed">CRITICAL</span>}
                      <div className="text-[10px] text-[var(--color-text-faint)]">{d.description}</div>
                    </td>
                    {TOKENS.map((t) => {
                      const on = (policy[d.id] ?? []).includes(t);
                      const locked = !canEdit || (d.critical && t === "Admin" && on);
                      return (
                        <td key={t} className="px-2 py-1.5 text-center">
                          <button
                            onClick={() => !locked && toggle(d.id, t)}
                            disabled={locked}
                            title={locked && on ? "Admin is locked on critical capabilities" : undefined}
                            className={`w-5 h-5 rounded border inline-flex items-center justify-center transition-colors ${on ? "bg-emerald-500 border-emerald-500 text-white" : "border-[var(--color-border-strong)] hover:border-[var(--color-accent-ring)]"} ${locked ? "opacity-70 cursor-not-allowed" : ""}`}
                          >
                            {on && <Check className="w-3 h-3" />}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-faint)]">
        Identity rights are never configurable: a ticket&apos;s requester, assigned drafter, and assigned engineer always keep their own-ticket actions. &ldquo;Engineer&rdquo; covers every Engineer-1…4 tier (tiers are labels, enforced identically).
      </div>
    </div>
  );
}
