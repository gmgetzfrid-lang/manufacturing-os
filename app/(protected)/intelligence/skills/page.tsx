"use client";

// /intelligence/skills — the Skill Library.
//
// Two shelves, one library, the way an app store treats apps:
//
//   CONNECTION SKILLS — detectors the engine runs to grow the org graph
//   (pattern matchers over document text, shared equipment, co-citation).
//
//   REASONING SKILLS — instruction packs the AI carries when it ANSWERS:
//   Basis of Design, Change Impact Review, Troubleshooting Protocol, Plain
//   Language for the Field, Shift Handover, Technical Query Builder — plus
//   any discipline a member authors. Packs are self-gating (each names when
//   it applies), so they're simple on/off switches, not a mode picker.
//
// Both shelves share one authority (DEC-55, lib/skillAuthority): built-ins
// belong to the org and only document controllers switch them; any member
// authors PRIVATE skills and may ask for one to be shared; publishing
// org-wide is a controller act — an org-wide reasoning skill rides every
// colleague's answer prompt. The database enforces the same (20261125).
// "Build a skill" opens the Studio, where the member's own model drafts the
// skill from plain English. The Connection shelf is ConnectionSkillsPanel —
// the same list the review page shows (HUB-8).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Puzzle, Loader2, AlertTriangle, Sparkles, Waypoints, ArrowUpRight, BrainCircuit,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";
import SkillStudio from "@/components/intelligence/SkillStudio";
import ConnectionSkillsPanel, {
  SkillActions, SkillBadges, SkillByline, listedSkills, type SkillOps,
} from "@/components/intelligence/ConnectionSkillsPanel";
import type { LinkRule } from "@/lib/linkRules";
import {
  listAnswerSkills, seedBuiltinAnswerSkills, setAnswerSkillEnabled,
  setAnswerSkillVisibility, setAnswerSkillShareRequest, deleteAnswerSkill, type AnswerSkill,
} from "@/lib/answerSkills";
import { isSkillController, skillControls } from "@/lib/skillAuthority";

const REASONING_HUE = "from-amber-500 to-orange-600";

const ANSWER_OPS: SkillOps = {
  setEnabled: setAnswerSkillEnabled,
  setVisibility: setAnswerSkillVisibility,
  setShareRequest: setAnswerSkillShareRequest,
  remove: deleteAnswerSkill,
};

export default function SkillLibraryPage() {
  const { activeOrgId, roles, uid, userEmail } = useRole();
  // DEC-35 / DEC-55: the controller tier by the held collection — what
  // is_org_controller means — never a role list at the call site.
  const isController = isSkillController(roles);

  const [rules, setRules] = useState<LinkRule[] | null | undefined>(undefined);
  const [rskills, setRskills] = useState<AnswerSkill[] | null | undefined>(undefined);
  const [studioOpen, setStudioOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try { setRskills(await listAnswerSkills(activeOrgId)); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [activeOrgId]);

  // HUB-2: the one client seeding entry for Reasoning Skills, and only for a
  // controller — a built-in carries no author. The answer pipeline seeds on
  // the service role for everyone else.
  useEffect(() => {
    if (!activeOrgId || !uid) return;
    let alive = true;
    (async () => {
      if (isController) {
        const seeded = await seedBuiltinAnswerSkills(activeOrgId);
        if (seeded.error && alive) setError(`Built-in skills could not be set up: ${seeded.error}`);
      }
      if (alive) await refresh();
    })();
    return () => { alive = false; };
  }, [activeOrgId, uid, isController, refresh]);

  const shownReasoning = useMemo(() => listedSkills(rskills ?? [], uid ?? null), [rskills, uid]);
  const stats = useMemo(() => {
    const all = [...listedSkills(rules ?? [], uid ?? null), ...shownReasoning];
    return {
      total: all.length,
      enabled: all.filter((r) => r.enabled).length,
      custom: all.filter((r) => !r.builtin_key).length,
      mine: all.filter((r) => !r.builtin_key && r.created_by === uid).length,
    };
  }, [rules, shownReasoning, uid]);

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    try { await fn(); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };

  const loading = rules === undefined || rskills === undefined;
  const notInstalled = rules === null && rskills === null;

  const shelfHeading = (icon: React.ReactNode, title: string, blurb: string) => (
    <div className="flex items-start gap-2.5 mt-8 mb-3 first:mt-0">
      {icon}
      <div>
        <h2 className="text-sm font-black text-[var(--color-text)] tracking-tight">{title}</h2>
        <p className="text-[11px] text-[var(--color-text-muted)]">{blurb}</p>
      </div>
    </div>
  );

  return (
    <PageShell>
      <ViewTabs title="Intelligence" tabs={INTELLIGENCE_VIEWS} />
      <PageHeaderBar
        icon={Puzzle}
        eyebrow="Skills"
        title="Skill library"
        subtitle="Two shelves: Connection skills grow the org graph; Reasoning skills shape how the AI answers. Describe either in plain words and your AI drafts it."
      />

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-950/40 p-3">
          <AlertTriangle className="w-4 h-4 text-rose-600 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-700 dark:text-rose-300">{error}</div>
        </div>
      )}

      {notInstalled ? (
        <div className="text-center py-16 space-y-2 max-w-md mx-auto">
          <Puzzle className="w-8 h-8 mx-auto text-[var(--color-text-faint)]" />
          <div className="text-sm font-bold text-[var(--color-text)]">The skill library isn&apos;t installed yet</div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Run the connection-skills and reasoning-skills migrations on your database, then reload —
            the built-ins will seed themselves and this page becomes your library.
          </p>
        </div>
      ) : (
        <>
          {loading && (
            <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-faint)]" /></div>
          )}
          {!loading && (
            <>
              {/* Pulse row */}
              <div className="mb-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
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

              {/* ── Reasoning skills ─────────────────────────────────────────── */}
              {shelfHeading(
                <BrainCircuit className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />,
                "Reasoning skills",
                "Disciplines the AI carries when it answers. Each names when it applies — enabling several is safe. Org-wide skills are shared by a document controller.",
              )}
              {rskills === null ? (
                <div className="text-[11px] text-[var(--color-text-muted)]">Run the reasoning-skills migration to unlock this shelf.</div>
              ) : (
                <div className="grid md:grid-cols-2 gap-3">
                  {shownReasoning.map((r, i) => (
                    <div key={r.id}
                      style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(i, 8) * 60}ms` }}
                      className={`rounded-2xl border overflow-hidden transition-all ${r.enabled
                        ? "border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm hover:shadow-md"
                        : "border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)]/40 opacity-75"}`}>
                      <div className={`h-1 bg-gradient-to-r ${REASONING_HUE} ${r.enabled ? "" : "opacity-30"}`} />
                      <div className="p-4 space-y-2">
                        <div className="flex items-start gap-2.5">
                          <span className={`shrink-0 w-9 h-9 rounded-xl bg-gradient-to-br ${REASONING_HUE} text-white flex items-center justify-center shadow-sm ${r.enabled ? "" : "grayscale"}`}>
                            <BrainCircuit className="w-[18px] h-[18px]" />
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-black text-[var(--color-text)] leading-tight">{r.name}</div>
                            <SkillBadges row={r} kindLabel="Answer discipline" />
                          </div>
                          <SkillActions row={r} controls={skillControls(r, { uid: uid ?? null, isController })}
                            ops={ANSWER_OPS} busy={busyId === r.id} run={run} />
                        </div>
                        {r.description && (
                          <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{r.description}</p>
                        )}
                        {/* The pack itself, on demand — the description sells it,
                            the details prove it. */}
                        <details className="group">
                          <summary className="cursor-pointer text-[10px] font-black uppercase tracking-wider text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] list-none">
                            View the discipline ▸
                          </summary>
                          <pre className="mt-1.5 whitespace-pre-wrap text-[10px] leading-relaxed text-[var(--color-text-muted)] bg-[var(--color-surface-2)]/60 rounded-lg p-2.5 max-h-48 overflow-y-auto font-sans">{r.instructions}</pre>
                        </details>
                        <div className="pt-1 border-t border-[var(--color-border)]/60 text-[10px] text-[var(--color-text-faint)] truncate">
                          <SkillByline row={r} uid={uid ?? null} />
                        </div>
                      </div>
                    </div>
                  ))}
                  {activeOrgId && uid && (
                    <button type="button" onClick={() => setStudioOpen(true)}
                      style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(shownReasoning.length, 9) * 60}ms` }}
                      className="rounded-2xl border-2 border-dashed border-[var(--color-border-strong)] hover:border-violet-400 min-h-[10rem] flex flex-col items-center justify-center gap-2 text-[var(--color-text-muted)] hover:text-violet-700 transition-colors p-4">
                      <Sparkles className="w-6 h-6" />
                      <span className="text-xs font-black">Build a skill</span>
                      <span className="text-[10px] text-center max-w-[16rem]">Describe a discipline in plain words — “when someone asks X, always do Y”. Your AI drafts the pack.</span>
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Connection skills — the same list the review page shows ──── */}
          <div className={loading ? "hidden" : undefined}>
            {shelfHeading(
              <Waypoints className="w-5 h-5 text-violet-600 mt-0.5 shrink-0" />,
              "Connection skills",
              "Detectors the engine runs to grow the org graph. Findings queue for review — nothing custom applies itself. A private skill is a draft the engine runs once it is shared.",
            )}
            <ConnectionSkillsPanel mode="shelf" onRulesChange={setRules} />
          </div>

          {!loading && (
            <div className="mt-6 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <Waypoints className="w-3.5 h-3.5 text-violet-600 shrink-0" />
              Connection skills run with “Find connections”; reasoning skills ride every question.
              <Link href="/admin/proposed-links" className="inline-flex items-center gap-0.5 font-black text-violet-700 hover:text-violet-600">
                Review what the engine found <ArrowUpRight className="w-3 h-3" />
              </Link>
            </div>
          )}
        </>
      )}

      {studioOpen && activeOrgId && uid && (
        <SkillStudio
          orgId={activeOrgId}
          userId={uid}
          userName={userEmail ?? undefined}
          kind="reasoning"
          onClose={() => setStudioOpen(false)}
          onCreated={() => { setStudioOpen(false); void refresh(); }}
        />
      )}
    </PageShell>
  );
}
