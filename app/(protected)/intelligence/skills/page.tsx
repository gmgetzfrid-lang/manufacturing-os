"use client";

// /intelligence/skills — the Skill Library.
//
// Connection Skills as a first-class library, the way an app store treats
// apps: browsable cards, not a settings list. Built-ins and org-authored
// skills sit side by side; each card shows what the skill finds, who wrote
// it, whether it's shared org-wide or private, and switches on and off in
// place. "Build a skill" opens the Studio, where the member's own model
// drafts the skill from a plain-English description and the live tester
// proves it before it ever runs.
//
// Authority model, visible on every card: controllers manage org skills,
// authors manage their own, and custom skills only ever QUEUE findings for
// review — the library can grow freely without anyone silently rewiring
// the graph.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Puzzle, Loader2, Eye, EyeOff, Trash2, AlertTriangle, Lock, Users,
  Sparkles, Waypoints, FileSearch, MessageSquareQuote, Boxes, ArrowUpRight,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";
import SkillStudio from "@/components/intelligence/SkillStudio";
import {
  listLinkRules, seedBuiltinRules, setLinkRuleEnabled, setLinkRuleVisibility,
  deleteLinkRule, type LinkRule,
} from "@/lib/linkRules";
import { appConfirm } from "@/components/providers/DialogProvider";

const KIND_META: Record<string, { label: string; icon: typeof FileSearch; hue: string }> = {
  reference: { label: "Cross-reference", icon: FileSearch, hue: "from-sky-500 to-blue-600" },
  shared_entity: { label: "Shared equipment", icon: Boxes, hue: "from-emerald-500 to-teal-600" },
  co_citation: { label: "Usage", icon: MessageSquareQuote, hue: "from-violet-500 to-fuchsia-600" },
};

export default function SkillLibraryPage() {
  const { activeOrgId, activeRole, uid, userEmail } = useRole();
  const canManageOrg = activeRole === "Admin" || activeRole === "DocCtrl";

  const [rules, setRules] = useState<LinkRule[] | null | undefined>(undefined);
  const [studioOpen, setStudioOpen] = useState(false);
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

  const stats = useMemo(() => {
    const all = rules ?? [];
    return {
      total: all.length,
      enabled: all.filter((r) => r.enabled).length,
      custom: all.filter((r) => !r.builtin_key).length,
      mine: all.filter((r) => !r.builtin_key && r.created_by === uid).length,
    };
  }, [rules, uid]);

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
    const ok = await appConfirm({
      title: "Delete this skill?",
      message: `“${r.name}” stops running and its definition is gone. Links it already found stay — they carry their own evidence.`,
      confirmLabel: "Delete skill",
      tone: "danger",
    });
    if (!ok) return;
    setBusyId(r.id);
    try { await deleteLinkRule(r.id); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };

  return (
    <PageShell>
      <ViewTabs title="Intelligence" tabs={INTELLIGENCE_VIEWS} />
      <PageHeaderBar
        icon={Puzzle}
        eyebrow="Connection skills"
        title="Skill library"
        subtitle="The detectors that grow your org graph — built-in and authored by your own people, for your own paperwork. Describe a skill in plain words and your AI drafts it; the live tester proves it before it runs."
        actions={activeOrgId && uid ? (
          <button onClick={() => setStudioOpen(true)}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-black text-white bg-violet-600 hover:bg-violet-500 shadow-lg shadow-violet-600/20">
            <Sparkles className="w-4 h-4" /> Build a skill
          </button>
        ) : undefined}
      />

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-950/40 p-3">
          <AlertTriangle className="w-4 h-4 text-rose-600 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-700 dark:text-rose-300">{error}</div>
        </div>
      )}

      {rules === undefined ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-faint)]" /></div>
      ) : rules === null ? (
        <div className="text-center py-16 space-y-2 max-w-md mx-auto">
          <Puzzle className="w-8 h-8 mx-auto text-[var(--color-text-faint)]" />
          <div className="text-sm font-bold text-[var(--color-text)]">The skill library isn&apos;t installed yet</div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Run the connection-skills migration on your database, then reload — the built-in
            detectors will seed themselves and this page becomes your library.
          </p>
        </div>
      ) : (
        <>
          {/* Pulse row */}
          <div className="mb-5 grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { n: stats.total, label: "skills" },
              { n: stats.enabled, label: "enabled" },
              { n: stats.custom, label: "org-authored" },
              { n: stats.mine, label: "yours" },
            ].map((s, i) => (
              <div key={s.label}
                style={{ animation: "rise 0.4s var(--ease-fluid) both", animationDelay: `${i * 60}ms` }}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5">
                <div className="text-xl font-black text-[var(--color-text)] tabular-nums">{s.n}</div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{s.label}</div>
              </div>
            ))}
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            {rules.map((r, i) => {
              const meta = KIND_META[r.kind] ?? KIND_META.reference;
              const KindIcon = meta.icon;
              const mine = r.created_by === uid;
              const mayManage = canManageOrg || mine;
              return (
                <div key={r.id}
                  style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(i, 8) * 60}ms` }}
                  className={`group relative rounded-2xl border overflow-hidden transition-all ${r.enabled
                    ? "border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm hover:shadow-md"
                    : "border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)]/40 opacity-75"}`}>
                  <div className={`h-1 bg-gradient-to-r ${meta.hue} ${r.enabled ? "" : "opacity-30"}`} />
                  <div className="p-4 space-y-2">
                    <div className="flex items-start gap-2.5">
                      <span className={`shrink-0 w-9 h-9 rounded-xl bg-gradient-to-br ${meta.hue} text-white flex items-center justify-center shadow-sm ${r.enabled ? "" : "grayscale"}`}>
                        <KindIcon className="w-[18px] h-[18px]" />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-black text-[var(--color-text)] leading-tight">{r.name}</div>
                        <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                          <span className="text-[9px] font-black uppercase tracking-wide text-[var(--color-text-muted)]">{meta.label}</span>
                          {r.builtin_key ? (
                            <span className="text-[9px] font-black uppercase tracking-wide text-violet-600">Built-in</span>
                          ) : (
                            <span className="inline-flex items-center gap-0.5 text-[9px] font-black uppercase tracking-wide text-[var(--color-text-faint)]">
                              {r.visibility === "org" ? <Users className="w-2.5 h-2.5" /> : <Lock className="w-2.5 h-2.5" />}
                              {r.visibility === "org" ? "Org-wide" : "Private"}
                            </span>
                          )}
                        </div>
                      </div>
                      {mayManage && (
                        <button type="button" onClick={() => void toggle(r)} disabled={busyId === r.id}
                          title={r.enabled ? "Disable — the engine skips this skill" : "Enable"}
                          className={`shrink-0 inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-black border transition-colors ${r.enabled
                            ? "border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40"
                            : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`}>
                          {busyId === r.id ? <Loader2 className="w-3 h-3 animate-spin" />
                            : r.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                          {r.enabled ? "On" : "Off"}
                        </button>
                      )}
                    </div>

                    {r.description && (
                      <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{r.description}</p>
                    )}

                    {(r.config?.patterns?.length ?? 0) > 0 && (
                      <div className="flex items-center gap-1 flex-wrap">
                        {r.config.patterns!.slice(0, 3).map((p) => (
                          <code key={p} className="px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[10px] font-mono text-[var(--color-text)] max-w-full truncate">{p}</code>
                        ))}
                        {(r.config.patterns!.length > 3) && (
                          <span className="text-[10px] text-[var(--color-text-faint)]">+{r.config.patterns!.length - 3}</span>
                        )}
                      </div>
                    )}

                    <div className="flex items-center gap-1.5 pt-1 border-t border-[var(--color-border)]/60">
                      <span className="text-[10px] text-[var(--color-text-faint)] flex-1 truncate">
                        {r.builtin_key ? "Ships with the engine" : `by ${mine ? "you" : (r.created_by_name ?? "a teammate")}`}
                      </span>
                      {!r.builtin_key && mayManage && (
                        <>
                          <button type="button" onClick={() => void flipVisibility(r)} disabled={busyId === r.id}
                            title={r.visibility === "org" ? "Make private" : "Share org-wide"}
                            className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                            {r.visibility === "org" ? <Lock className="w-3.5 h-3.5" /> : <Users className="w-3.5 h-3.5" />}
                          </button>
                          <button type="button" onClick={() => void remove(r)} disabled={busyId === r.id}
                            title="Delete this skill"
                            className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* The invitation card — the library wants to grow. */}
            {activeOrgId && uid && (
              <button type="button" onClick={() => setStudioOpen(true)}
                style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(rules.length, 9) * 60}ms` }}
                className="rounded-2xl border-2 border-dashed border-[var(--color-border-strong)] hover:border-violet-400 min-h-[10rem] flex flex-col items-center justify-center gap-2 text-[var(--color-text-muted)] hover:text-violet-700 transition-colors p-4">
                <Sparkles className="w-6 h-6" />
                <span className="text-xs font-black">Build a skill</span>
                <span className="text-[10px] text-center max-w-[16rem]">
                  Describe your facility&apos;s numbering convention in plain words — your AI drafts the
                  detector, the tester proves it.
                </span>
              </button>
            )}
          </div>

          <div className="mt-6 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
            <Waypoints className="w-3.5 h-3.5 text-violet-600 shrink-0" />
            Skills run when “Find connections” runs.
            <Link href="/admin/proposed-links" className="inline-flex items-center gap-0.5 font-black text-violet-700 hover:text-violet-600">
              Review what they found <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
        </>
      )}

      {studioOpen && activeOrgId && uid && (
        <SkillStudio
          orgId={activeOrgId}
          userId={uid}
          userName={userEmail ?? undefined}
          onClose={() => setStudioOpen(false)}
          onCreated={() => { setStudioOpen(false); void refresh(); }}
        />
      )}
    </PageShell>
  );
}
