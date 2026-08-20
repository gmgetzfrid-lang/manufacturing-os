"use client";

// ConnectionSkillsPanel — the org's rulebook for link discovery, on the
// review page where its output lands.
//
// Everything the engine detects is a skill listed here — the built-ins
// (drawing cross-references, shared equipment, answered-together) and any
// skill a member authors for their facility's own paperwork conventions
// ("WO-#####" work orders, permit numbers, ISO sheets…). Each skill can be
// switched off, shared org-wide, or kept private; authoring is a small
// wizard with a LIVE tester so a pattern proves itself on sample text
// before it ever runs.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Puzzle, Plus, Loader2, Eye, EyeOff, Trash2, ChevronDown,
  AlertTriangle, Lock, Users, ArrowUpRight,
} from "lucide-react";
import SkillStudio from "@/components/intelligence/SkillStudio";
import { useRole } from "@/components/providers/RoleContext";
import {
  listLinkRules, seedBuiltinRules, setLinkRuleEnabled,
  setLinkRuleVisibility, deleteLinkRule,
  type LinkRule,
} from "@/lib/linkRules";

const KIND_LABELS: Record<string, string> = {
  reference: "Cross-reference",
  shared_entity: "Shared equipment",
  co_citation: "Usage",
};

export default function ConnectionSkillsPanel() {
  const { activeOrgId, activeRole, uid, userEmail } = useRole();
  const canManageOrg = activeRole === "Admin" || activeRole === "DocCtrl";

  const [rules, setRules] = useState<LinkRule[] | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try { setRules(await listLinkRules(activeOrgId)); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [activeOrgId]);

  useEffect(() => {
    if (!activeOrgId || !uid) return;
    let alive = true;
    (async () => {
      await seedBuiltinRules(activeOrgId, uid);
      if (alive) await refresh();
    })();
    return () => { alive = false; };
  }, [activeOrgId, uid, refresh]);

  const toggle = async (r: LinkRule) => {
    setBusyId(r.id);
    try { await setLinkRuleEnabled(r.id, !r.enabled); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };

  const flipVisibility = async (r: LinkRule) => {
    setBusyId(r.id);
    try { await setLinkRuleVisibility(r.id, r.visibility === "org" ? "private" : "org"); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };

  const remove = async (r: LinkRule) => {
    setBusyId(r.id);
    try { await deleteLinkRule(r.id); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };

  const enabledCount = useMemo(() => (rules ?? []).filter((r) => r?.enabled).length, [rules]);

  if (rules === undefined) return null;

  return (
    <div className="mb-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 px-3.5 py-3 text-left">
        <Puzzle className="w-4 h-4 text-violet-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-black text-[var(--color-text)]">Connection skills</div>
          <div className="text-[11px] text-[var(--color-text-muted)]">
            {rules === null
              ? "Not installed yet — run the connection-skills migration to author your own detectors."
              : `${rules.length} skill${rules.length === 1 ? "" : "s"} · ${enabledCount} enabled. The detectors “Find connections” runs — including ones you write for your own numbering conventions.`}
          </div>
        </div>
        <ChevronDown className={`w-4 h-4 text-[var(--color-text-faint)] shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && rules !== null && (
        <div className="px-3.5 pb-3.5 space-y-1.5 border-t border-[var(--color-border)] pt-3">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-2.5 py-2 text-[11px] text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </div>
          )}

          {rules.map((r) => {
            const mine = r.created_by === uid;
            const mayManage = canManageOrg || mine;
            return (
              <div key={r.id} className={`rounded-lg border px-3 py-2.5 ${r.enabled
                ? "border-[var(--color-border)] bg-[var(--color-surface)]"
                : "border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)]/50 opacity-70"}`}>
                <div className="flex items-start gap-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-black text-[var(--color-text)]">{r.name}</span>
                      <span className="px-1.5 py-0.5 rounded-full bg-[var(--color-surface-2)] text-[9px] font-black uppercase tracking-wide text-[var(--color-text-muted)]">
                        {KIND_LABELS[r.kind] ?? r.kind}
                      </span>
                      {r.builtin_key ? (
                        <span className="text-[9px] font-black uppercase tracking-wide text-violet-600">Built-in</span>
                      ) : (
                        <span className="inline-flex items-center gap-0.5 text-[9px] font-black uppercase tracking-wide text-[var(--color-text-faint)]">
                          {r.visibility === "org" ? <Users className="w-2.5 h-2.5" /> : <Lock className="w-2.5 h-2.5" />}
                          {r.visibility === "org" ? "Org-wide" : "Private"}
                        </span>
                      )}
                    </div>
                    {r.description && (
                      <div className="text-[11px] text-[var(--color-text-muted)] leading-snug mt-0.5">{r.description}</div>
                    )}
                    {(r.config?.patterns?.length ?? 0) > 0 && (
                      <div className="flex items-center gap-1 flex-wrap mt-1">
                        {r.config.patterns!.slice(0, 4).map((p) => (
                          <code key={p} className="px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[10px] font-mono text-[var(--color-text)]">{p}</code>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {!r.builtin_key && mayManage && (
                      <>
                        <button type="button" onClick={() => void flipVisibility(r)} disabled={busyId === r.id}
                          title={r.visibility === "org" ? "Make private (only you see it; findings still queue for review)" : "Share org-wide"}
                          className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                          {r.visibility === "org" ? <Users className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                        </button>
                        <button type="button" onClick={() => void remove(r)} disabled={busyId === r.id}
                          title="Delete this skill"
                          className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                    {mayManage && (
                      <button type="button" onClick={() => void toggle(r)} disabled={busyId === r.id}
                        title={r.enabled ? "Disable — the engine skips this skill" : "Enable"}
                        className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-black border transition-colors ${r.enabled
                          ? "border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40"
                          : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`}>
                        {busyId === r.id ? <Loader2 className="w-3 h-3 animate-spin" />
                          : r.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                        {r.enabled ? "On" : "Off"}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => setWizardOpen(true)}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border-2 border-dashed border-[var(--color-border-strong)] text-[11px] font-black text-[var(--color-text-muted)] hover:border-violet-400 hover:text-violet-700 transition-colors">
              <Plus className="w-3.5 h-3.5" /> New skill — teach the engine your numbering convention
            </button>
            <Link href="/intelligence/skills"
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-[11px] font-black text-violet-700 border border-violet-300 dark:border-violet-800 hover:bg-violet-50 dark:hover:bg-violet-950/40">
              Skill library <ArrowUpRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      )}

      {wizardOpen && activeOrgId && uid && (
        <SkillStudio
          orgId={activeOrgId}
          userId={uid}
          userName={userEmail ?? undefined}
          onClose={() => setWizardOpen(false)}
          onCreated={() => { setWizardOpen(false); void refresh(); }}
        />
      )}
    </div>
  );
}
