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
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";
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

  // A shelf is one card: its name, one line on what it does, then the
  // skills in a hairline grid (no boxes inside the box).
  const shelfHeading = (icon: React.ReactNode, title: string, blurb: string) => (
    <div className="px-4 sm:px-5 pt-4 pb-3">
      <h2 className="text-[13px] font-semibold text-[var(--color-text-muted)] inline-flex items-center gap-1.5">{icon}{title}</h2>
      <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">{blurb}</p>
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
      <span className="text-[12px] text-[var(--color-text-muted)] flex-1 truncate">
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
        className="min-h-[9rem] flex flex-col items-center justify-center gap-1.5 bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] transition-colors p-4">
        <Sparkles className="w-5 h-5" />
        <span className="text-[14px] font-bold text-[var(--color-accent-text)]">Build a skill</span>
        <span className="text-[13px] text-center max-w-[18rem]">{blurb}</span>
      </button>
    ) : null
  );

  return (
    <PageShell>
      <PageHero
        kicker="Intelligence · Skills"
        title={loading ? "Skill library" : notInstalled ? "The skill library isn't installed yet." : `${stats.total} ${stats.total === 1 ? "skill" : "skills"}, ${stats.enabled} on.`}
        sub={
          <>
            {!loading && !notInstalled && <>{stats.custom} written here, {stats.mine} by you. </>}
            Connection skills grow the org graph; reasoning skills shape how the AI answers. Describe either in plain words and your AI drafts it.
            {error && <span role="alert" className="block mt-1 text-rose-200 font-semibold"><AlertTriangle className="inline w-3.5 h-3.5 -mt-0.5 mr-1" />{error}</span>}
          </>
        }
      >
        <ViewTabs tabs={INTELLIGENCE_VIEWS} variant="dark" />
      </PageHero>

      <PageBody>
      {loading ? (
        <Card><p className="flex items-center justify-center gap-2 py-12 text-[14px] text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin" /> Loading the skill library…</p></Card>
      ) : notInstalled ? (
        <Card>
          <div className="text-center py-10 space-y-2 max-w-md mx-auto">
            <Puzzle className="w-6 h-6 mx-auto text-[var(--color-text-faint)]" />
            <p className="text-[14px] text-[var(--color-text-muted)]">
              Run the connection-skills and reasoning-skills migrations on your database, then reload.
              The built-ins add themselves.
            </p>
          </div>
        </Card>
      ) : (
        <>
          {/* ── Reasoning skills ─────────────────────────────────────────── */}
          <Card pad={false} className="overflow-hidden">
          {shelfHeading(
            <BrainCircuit className="w-3.5 h-3.5" />,
            "Reasoning skills",
            "Disciplines the AI carries when it answers. Each names when it applies, so enabling several is safe.",
          )}
          {rskills === null ? (
            <div className="px-4 sm:px-5 pb-4 text-[13px] text-[var(--color-text-muted)]">Run the reasoning-skills migration to unlock this shelf.</div>
          ) : (
            <div className="grid md:grid-cols-2 -mb-px border-t border-[var(--color-border)] [&>*]:border-b [&>*]:border-[var(--color-border)] md:[&>*:nth-child(odd)]:border-r">
              {rskills.map((r, i) => {
                const mine = r.created_by === uid;
                const mayManage = canManageOrg || mine;
                return (
                  <div key={r.id}
                    style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(i, 8) * 60}ms` }}
                    className={`bg-[var(--color-surface)] transition-opacity ${r.enabled ? "" : "opacity-70"}`}>
                    <div className="p-4 sm:px-5 space-y-2">
                      <div className="flex items-start gap-2.5">
                        <span className={`shrink-0 w-9 h-9 rounded-[10px] bg-[var(--color-surface-2)] text-[var(--color-text)] flex items-center justify-center ${r.enabled ? "" : "grayscale"}`}>
                          <BrainCircuit className="w-[18px] h-[18px]" />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-[14px] font-bold text-[var(--color-text)] leading-tight">{r.name}</div>
                          {badgeRow(r, "Answer discipline")}
                        </div>
                        {toggleButton({ id: r.id, enabled: r.enabled, mayManage, onToggle: () => setAnswerSkillEnabled(r.id, !r.enabled) })}
                      </div>
                      {r.description && (
                        <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">{r.description}</p>
                      )}
                      {/* The pack itself, on demand — the description sells it,
                          the details prove it. */}
                      <details className="group">
                        <summary className="cursor-pointer text-[13px] font-semibold text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] list-none">
                          View the discipline ▸
                        </summary>
                        <pre className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--color-text-muted)] bg-[var(--color-surface-2)]/60 rounded-lg p-2.5 max-h-48 overflow-y-auto font-sans">{r.instructions}</pre>
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
                "Describe a discipline in plain words: “when someone asks X, always do Y”. Your AI drafts the pack.")}
            </div>
          )}
          </Card>

          {/* ── Connection skills ────────────────────────────────────────── */}
          <Card pad={false} className="overflow-hidden">
          {shelfHeading(
            <Waypoints className="w-3.5 h-3.5" />,
            "Connection skills",
            "Detectors the engine runs to grow the org graph. Findings queue for review; nothing custom applies itself.",
          )}
          {rules === null ? (
            <div className="px-4 sm:px-5 pb-4 text-[13px] text-[var(--color-text-muted)]">Run the connection-skills migration to unlock this shelf.</div>
          ) : (
            <div className="grid md:grid-cols-2 -mb-px border-t border-[var(--color-border)] [&>*]:border-b [&>*]:border-[var(--color-border)] md:[&>*:nth-child(odd)]:border-r">
              {rules.map((r, i) => {
                const meta = KIND_META[r.kind] ?? KIND_META.reference;
                const KindIcon = meta.icon;
                const mine = r.created_by === uid;
                const mayManage = canManageOrg || mine;
                return (
                  <div key={r.id}
                    style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(i, 8) * 60}ms` }}
                    className={`bg-[var(--color-surface)] transition-opacity ${r.enabled ? "" : "opacity-70"}`}>
                    <div className="p-4 sm:px-5 space-y-2">
                      <div className="flex items-start gap-2.5">
                        <span className={`shrink-0 w-9 h-9 rounded-[10px] bg-[var(--color-surface-2)] text-[var(--color-text)] flex items-center justify-center ${r.enabled ? "" : "grayscale"}`}>
                          <KindIcon className="w-[18px] h-[18px]" />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-[14px] font-bold text-[var(--color-text)] leading-tight">{r.name}</div>
                          {badgeRow(r, meta.label)}
                        </div>
                        {toggleButton({ id: r.id, enabled: r.enabled, mayManage, onToggle: () => setLinkRuleEnabled(r.id, !r.enabled) })}
                      </div>
                      {r.description && (
                        <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">{r.description}</p>
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
                "Describe your facility's numbering convention: your AI drafts the detector, the tester proves it.")}
            </div>
          )}
          </Card>

          <div className="px-1 flex flex-wrap items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
            <Waypoints className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
            Connection skills run with “Find connections”; reasoning skills ride every question.
            <Link href="/admin/proposed-links" className="inline-flex items-center gap-0.5 font-bold text-[var(--color-accent-text)] hover:text-[var(--color-accent-hover)]">
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
      </PageBody>
    </PageShell>
  );
}
