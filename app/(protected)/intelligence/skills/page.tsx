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
// Both shelves share the model: built-ins seed themselves, any member
// authors, controllers manage org skills, authors manage their own,
// visibility is org-wide or private. "Build a skill" opens the Studio,
// where the member's own model drafts the skill from plain English.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Puzzle, Loader2, Eye, EyeOff, Trash2, AlertTriangle, Lock, Users,
  Sparkles, Waypoints, FileSearch, MessageSquareQuote, Boxes, ArrowUpRight,
  BrainCircuit,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";
import SkillStudio, { type StudioKind } from "@/components/intelligence/SkillStudio";
import {
  listLinkRules, seedBuiltinRules, setLinkRuleEnabled, setLinkRuleVisibility,
  deleteLinkRule, type LinkRule,
} from "@/lib/linkRules";
import {
  listAnswerSkills, seedBuiltinAnswerSkills, setAnswerSkillEnabled,
  setAnswerSkillVisibility, deleteAnswerSkill, type AnswerSkill,
} from "@/lib/answerSkills";
import { appConfirm } from "@/components/providers/DialogProvider";

const KIND_META: Record<string, { label: string; icon: typeof FileSearch }> = {
  reference: { label: "Cross-reference", icon: FileSearch },
  shared_entity: { label: "Shared equipment", icon: Boxes },
  co_citation: { label: "Usage", icon: MessageSquareQuote },
};

export default function SkillLibraryPage() {
  const { activeOrgId, activeRole, uid, userEmail } = useRole();
  const canManageOrg = activeRole === "Admin" || activeRole === "DocCtrl";

  const [rules, setRules] = useState<LinkRule[] | null | undefined>(undefined);
  const [rskills, setRskills] = useState<AnswerSkill[] | null | undefined>(undefined);
  const [studioKind, setStudioKind] = useState<StudioKind | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const [lr, as] = await Promise.all([listLinkRules(activeOrgId), listAnswerSkills(activeOrgId)]);
      setRules(lr); setRskills(as); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [activeOrgId]);

  useEffect(() => {
    if (!activeOrgId || !uid) return;
    let alive = true;
    (async () => {
      // Seeding the built-ins is background work; the list loads either way,
      // and a failed seed is said, not swallowed.
      try {
        await Promise.all([
          seedBuiltinRules(activeOrgId, uid),
          seedBuiltinAnswerSkills(activeOrgId, uid),
        ]);
      } catch (e) {
        if (alive) setError(`The built-in skills couldn't be added: ${(e as Error).message}`);
      }
      if (alive) await refresh();
    })();
    return () => { alive = false; };
  }, [activeOrgId, uid, refresh]);

  const stats = useMemo(() => {
    const all = [...(rules ?? []), ...(rskills ?? [])];
    return {
      total: all.length,
      enabled: all.filter((r) => r.enabled).length,
      custom: all.filter((r) => !r.builtin_key).length,
      mine: all.filter((r) => !r.builtin_key && r.created_by === uid).length,
    };
  }, [rules, rskills, uid]);

  const guard = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    try { await fn(); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };

  const removeConfirmed = async (id: string, name: string, fn: () => Promise<void>) => {
    const ok = await appConfirm({
      title: "Delete this skill?",
      message: `“${name}” stops running and its definition is gone. Anything it already produced stays - it carries its own evidence.`,
      confirmLabel: "Delete skill",
      tone: "danger",
    });
    if (!ok) return;
    await guard(id, fn);
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

  const badgeRow = (r: { builtin_key: string | null; visibility: string }, kindLabel: string) => (
    <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
      <span className="text-[11px] font-black uppercase tracking-wide text-[var(--color-text-muted)]">{kindLabel}</span>
      {r.builtin_key ? (
        <span className="text-[11px] font-black uppercase tracking-wide text-[var(--color-text)]">Built-in</span>
      ) : (
        <span className="inline-flex items-center gap-0.5 text-[11px] font-black uppercase tracking-wide text-[var(--color-text-faint)]">
          {r.visibility === "org" ? <Users className="w-2.5 h-2.5" /> : <Lock className="w-2.5 h-2.5" />}
          {r.visibility === "org" ? "Org-wide" : "Private"}
        </span>
      )}
    </div>
  );

  const cardControls = (opts: {
    id: string; name: string; builtin: boolean; mayManage: boolean; mine: boolean;
    enabled: boolean; visibility: string; authorName: string | null;
    onToggle: () => Promise<void>; onFlip: () => Promise<void>; onDelete: () => Promise<void>;
  }) => (
    <div className="flex items-center gap-1.5 pt-1 border-t border-[var(--color-border)]/60">
      <span className="text-[11px] text-[var(--color-text-faint)] flex-1 truncate">
        {opts.builtin ? "Ships with the engine" : `by ${opts.mine ? "you" : (opts.authorName ?? "a teammate")}`}
      </span>
      {!opts.builtin && opts.mayManage && (
        <>
          <button type="button" onClick={() => void guard(opts.id, opts.onFlip)} disabled={busyId === opts.id}
            title={opts.visibility === "org" ? "Make private" : "Share org-wide"}
            className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
            {opts.visibility === "org" ? <Lock className="w-3.5 h-3.5" /> : <Users className="w-3.5 h-3.5" />}
          </button>
          <button type="button" onClick={() => void removeConfirmed(opts.id, opts.name, opts.onDelete)} disabled={busyId === opts.id}
            title="Delete this skill"
            className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </>
      )}
    </div>
  );

  const toggleButton = (opts: { id: string; enabled: boolean; mayManage: boolean; onToggle: () => Promise<void> }) =>
    opts.mayManage ? (
      <button type="button" onClick={() => void guard(opts.id, opts.onToggle)} disabled={busyId === opts.id}
        title={opts.enabled ? "Turn off: it stops running" : "Turn on"}
        aria-pressed={opts.enabled}
        className={`shrink-0 inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-black border transition-colors ${opts.enabled
          ? "border-[var(--color-text)] text-[var(--color-surface)] bg-[var(--color-text)]"
          : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`}>
        {busyId === opts.id ? <Loader2 className="w-3 h-3 animate-spin" />
          : opts.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
        {opts.enabled ? "On" : "Off"}
      </button>
    ) : null;

  const buildCard = (kind: StudioKind, delayIndex: number, blurb: string) => (
    activeOrgId && uid ? (
      <button type="button" onClick={() => setStudioKind(kind)}
        style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(delayIndex, 9) * 60}ms` }}
        className="rounded-2xl border-2 border-dashed border-[var(--color-border-strong)] hover:border-[var(--color-border-strong)] min-h-[10rem] flex flex-col items-center justify-center gap-2 text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] transition-colors p-4">
        <Sparkles className="w-6 h-6" />
        <span className="text-xs font-black">Build a skill</span>
        <span className="text-[11px] text-center max-w-[16rem]">{blurb}</span>
      </button>
    ) : null
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
        <div role="alert" className="mb-4 flex items-start gap-2 border-l-2 border-rose-500 pl-3">
          <AlertTriangle className="w-4 h-4 text-rose-600 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-700 dark:text-rose-300">{error}</div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-[var(--color-text-muted)]"><Loader2 className="w-6 h-6 animate-spin" /> Loading the skill library…</div>
      ) : notInstalled ? (
        <div className="text-center py-16 space-y-2 max-w-md mx-auto">
          <Puzzle className="w-8 h-8 mx-auto text-[var(--color-text-faint)]" />
          <div className="text-sm font-bold text-[var(--color-text)]">The skill library isn&apos;t installed yet</div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Run the connection-skills and reasoning-skills migrations on your database, then reload.
            The built-ins add themselves.
          </p>
        </div>
      ) : (
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
                <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{s.label}</div>
              </div>
            ))}
          </div>

          {/* ── Reasoning skills ─────────────────────────────────────────── */}
          {shelfHeading(
            <BrainCircuit className="w-5 h-5 text-[var(--color-text-muted)] mt-0.5 shrink-0" />,
            "Reasoning skills",
            "Disciplines the AI carries when it answers. Each names when it applies - enabling several is safe.",
          )}
          {rskills === null ? (
            <div className="text-[11px] text-[var(--color-text-muted)]">Run the reasoning-skills migration to unlock this shelf.</div>
          ) : (
            <div className="grid md:grid-cols-2 gap-3">
              {rskills.map((r, i) => {
                const mine = r.created_by === uid;
                const mayManage = canManageOrg || mine;
                return (
                  <div key={r.id}
                    style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(i, 8) * 60}ms` }}
                    className={`rounded-2xl border overflow-hidden transition-all ${r.enabled
                      ? "border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm hover:shadow-md"
                      : "border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)]/40 opacity-75"}`}>
                    <div className={`h-1 bg-[var(--color-border)] ${r.enabled ? "" : "opacity-30"}`} />
                    <div className="p-4 space-y-2">
                      <div className="flex items-start gap-2.5">
                        <span className={`shrink-0 w-9 h-9 rounded-xl bg-[var(--color-surface-2)] text-[var(--color-text)] flex items-center justify-center shadow-sm ${r.enabled ? "" : "grayscale"}`}>
                          <BrainCircuit className="w-[18px] h-[18px]" />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-black text-[var(--color-text)] leading-tight">{r.name}</div>
                          {badgeRow(r, "Answer discipline")}
                        </div>
                        {toggleButton({ id: r.id, enabled: r.enabled, mayManage, onToggle: () => setAnswerSkillEnabled(r.id, !r.enabled) })}
                      </div>
                      {r.description && (
                        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{r.description}</p>
                      )}
                      {/* The pack itself, on demand — the description sells it,
                          the details prove it. */}
                      <details className="group">
                        <summary className="cursor-pointer text-[11px] font-black uppercase tracking-wider text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] list-none">
                          View the discipline ▸
                        </summary>
                        <pre className="mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--color-text-muted)] bg-[var(--color-surface-2)]/60 rounded-lg p-2.5 max-h-48 overflow-y-auto font-sans">{r.instructions}</pre>
                      </details>
                      {cardControls({
                        id: r.id, name: r.name, builtin: !!r.builtin_key, mayManage, mine,
                        enabled: r.enabled, visibility: r.visibility, authorName: r.created_by_name,
                        onToggle: () => setAnswerSkillEnabled(r.id, !r.enabled),
                        onFlip: () => setAnswerSkillVisibility(r.id, r.visibility === "org" ? "private" : "org"),
                        onDelete: () => deleteAnswerSkill(r.id),
                      })}
                    </div>
                  </div>
                );
              })}
              {buildCard("reasoning", rskills.length,
                "Describe a discipline in plain words - “when someone asks X, always do Y”. Your AI drafts the pack.")}
            </div>
          )}

          {/* ── Connection skills ────────────────────────────────────────── */}
          {shelfHeading(
            <Waypoints className="w-5 h-5 text-[var(--color-text-muted)] mt-0.5 shrink-0" />,
            "Connection skills",
            "Detectors the engine runs to grow the org graph. Findings queue for review - nothing custom applies itself.",
          )}
          {rules === null ? (
            <div className="text-[11px] text-[var(--color-text-muted)]">Run the connection-skills migration to unlock this shelf.</div>
          ) : (
            <div className="grid md:grid-cols-2 gap-3">
              {rules.map((r, i) => {
                const meta = KIND_META[r.kind] ?? KIND_META.reference;
                const KindIcon = meta.icon;
                const mine = r.created_by === uid;
                const mayManage = canManageOrg || mine;
                return (
                  <div key={r.id}
                    style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(i, 8) * 60}ms` }}
                    className={`rounded-2xl border overflow-hidden transition-all ${r.enabled
                      ? "border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm hover:shadow-md"
                      : "border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)]/40 opacity-75"}`}>
                    <div className={`h-1 bg-[var(--color-border)] ${r.enabled ? "" : "opacity-30"}`} />
                    <div className="p-4 space-y-2">
                      <div className="flex items-start gap-2.5">
                        <span className={`shrink-0 w-9 h-9 rounded-xl bg-[var(--color-surface-2)] text-[var(--color-text)] flex items-center justify-center shadow-sm ${r.enabled ? "" : "grayscale"}`}>
                          <KindIcon className="w-[18px] h-[18px]" />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-black text-[var(--color-text)] leading-tight">{r.name}</div>
                          {badgeRow(r, meta.label)}
                        </div>
                        {toggleButton({ id: r.id, enabled: r.enabled, mayManage, onToggle: () => setLinkRuleEnabled(r.id, !r.enabled) })}
                      </div>
                      {r.description && (
                        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{r.description}</p>
                      )}
                      {(r.config?.patterns?.length ?? 0) > 0 && (
                        <div className="flex items-center gap-1 flex-wrap">
                          {r.config.patterns!.slice(0, 3).map((p) => (
                            <code key={p} className="px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[11px] font-mono text-[var(--color-text)] max-w-full truncate">{p}</code>
                          ))}
                          {(r.config.patterns!.length > 3) && (
                            <span className="text-[11px] text-[var(--color-text-faint)]">+{r.config.patterns!.length - 3}</span>
                          )}
                        </div>
                      )}
                      {cardControls({
                        id: r.id, name: r.name, builtin: !!r.builtin_key, mayManage, mine,
                        enabled: r.enabled, visibility: r.visibility, authorName: r.created_by_name,
                        onToggle: () => setLinkRuleEnabled(r.id, !r.enabled),
                        onFlip: () => setLinkRuleVisibility(r.id, r.visibility === "org" ? "private" : "org"),
                        onDelete: () => deleteLinkRule(r.id),
                      })}
                    </div>
                  </div>
                );
              })}
              {buildCard("connection", rules.length,
                "Describe your facility's numbering convention - your AI drafts the detector, the tester proves it.")}
            </div>
          )}

          <div className="mt-6 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
            <Waypoints className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
            Connection skills run with “Find connections”; reasoning skills ride every question.
            <Link href="/admin/proposed-links" className="inline-flex items-center gap-0.5 font-black text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">
              Review what the engine found <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
        </>
      )}

      {studioKind && activeOrgId && uid && (
        <SkillStudio
          orgId={activeOrgId}
          userId={uid}
          userName={userEmail ?? undefined}
          kind={studioKind}
          onClose={() => setStudioKind(null)}
          onCreated={() => { setStudioKind(null); void refresh(); }}
        />
      )}
    </PageShell>
  );
}
