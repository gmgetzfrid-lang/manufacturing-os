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
  Puzzle, Loader2, Trash2, AlertTriangle, Lock, Users,
  Sparkles, FileSearch, MessageSquareQuote, Boxes, ArrowUpRight,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroQuiet } from "@/components/ui/PageHero";
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

  // Who a skill belongs to, in words: built-in, or whose and how shared.
  const whose = (r: { builtin_key: string | null; visibility: string; created_by: string | null; created_by_name: string | null }) =>
    r.builtin_key ? "Built-in"
      : `${r.visibility === "org" ? "Org-wide" : "Private"}, by ${r.created_by === uid ? "you" : (r.created_by_name?.split("@")[0] ?? "a teammate")}`;

  // On or off: a real switch, in the brand color when on.
  const toggleButton = (opts: { id: string; name: string; enabled: boolean; mayManage: boolean; onToggle: () => Promise<void> }) =>
    opts.mayManage ? (
      <button type="button" role="switch" aria-checked={opts.enabled} onClick={() => void guard(opts.id, opts.onToggle)} disabled={busyId === opts.id}
        aria-label={`${opts.name}: ${opts.enabled ? "on" : "off"}`}
        title={opts.enabled ? "Turn off: it stops running" : "Turn on"}
        className="inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text)] disabled:opacity-50">
        <span className={`relative inline-flex w-9 h-5 rounded-full transition-colors ${opts.enabled ? "bg-[var(--color-main)]" : "bg-[var(--color-border-strong)]"}`}>
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-[var(--color-surface)] shadow transition-transform ${opts.enabled ? "translate-x-4" : ""}`} />
        </span>
        <span className="max-sm:sr-only w-6 text-left">{busyId === opts.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : opts.enabled ? "On" : "Off"}</span>
      </button>
    ) : (
      <span className={`ui-pill ${opts.enabled ? "is-good" : "is-muted"}`}>{opts.enabled ? "On" : "Off"}</span>
    );

  // Whose: built-in, or shared org-wide (brand) or private (grey).
  const whosePill = (r: { builtin_key: string | null; visibility: string; created_by: string | null; created_by_name: string | null }) => (
    <span className={`ui-pill ${!r.builtin_key && r.visibility === "org" ? "" : "is-muted"}`}>
      {!r.builtin_key && (r.visibility === "org" ? <Users className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />)}
      {whose(r)}
    </span>
  );

  // Share and delete, as icon buttons with a visible hover fill.
  const rowActions = (opts: {
    id: string; name: string; builtin: boolean; mayManage: boolean; visibility: string;
    onFlip: () => Promise<void>; onDelete: () => Promise<void>;
  }) => !opts.builtin && opts.mayManage ? (
    <div className="flex items-center justify-end gap-1">
      <button type="button" onClick={() => void guard(opts.id, opts.onFlip)} disabled={busyId === opts.id}
        title={opts.visibility === "org" ? "Make private" : "Share org-wide"} aria-label={opts.visibility === "org" ? `Make ${opts.name} private` : `Share ${opts.name} org-wide`}
        className="w-8 h-8 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
        {opts.visibility === "org" ? <Lock className="w-4 h-4" /> : <Users className="w-4 h-4" />}
      </button>
      <button type="button" onClick={() => void removeConfirmed(opts.id, opts.name, opts.onDelete)} disabled={busyId === opts.id}
        title="Delete this skill" aria-label={`Delete ${opts.name}`}
        className="w-8 h-8 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--state-overdue)] hover:bg-[var(--color-surface-2)]">
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  ) : null;

  const buildButton = (kind: StudioKind) => activeOrgId && uid ? (
    <button type="button" onClick={() => setStudioKind(kind)} className={heroQuiet}>
      <Sparkles className="w-4 h-4" /> Build a skill
    </button>
  ) : null;

  const head = (
    <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
      <tr>
        <th className="font-semibold px-4 h-10">Skill</th>
        <th className="font-semibold px-4 hidden md:table-cell">Kind</th>
        <th className="font-semibold px-4 hidden sm:table-cell">Whose</th>
        <th className="font-semibold px-2 sm:px-4 w-14 sm:w-24">On</th>
        <th className="px-1 sm:px-2 w-[72px] sm:w-20"><span className="sr-only">Actions</span></th>
      </tr>
    </thead>
  );

  return (
    <PageShell>
      <PageHero
        kicker="Intelligence · Skills"
        title={loading ? "Skill library" : notInstalled ? "The skill library isn't installed yet." : `${stats.enabled} of ${stats.total} ${stats.total === 1 ? "skill" : "skills"} on`}
        sub={
          <>
            Describe a skill in plain words and your AI drafts it.
            {error && <span role="alert" className="block mt-1 text-[var(--state-overdue)] font-semibold"><AlertTriangle className="inline w-3.5 h-3.5 -mt-0.5 mr-1" />{error}</span>}
          </>
        }
        facts={!loading && !notInstalled ? [
          { label: "Skills", value: stats.total },
          { label: "On", value: stats.enabled },
          { label: "Written here", value: stats.custom },
          { label: "By you", value: stats.mine },
        ] : undefined}
      >
        <ViewTabs tabs={INTELLIGENCE_VIEWS} variant="dark" />
      </PageHero>

      <PageBody>
      {loading ? (
        <Card><p className="flex items-center justify-center gap-2 py-12 text-[15px] text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin" /> Loading the skill library…</p></Card>
      ) : notInstalled ? (
        <Card>
          <div className="text-center py-10 space-y-2 max-w-md mx-auto">
            <span aria-hidden className="ui-icon-tile mx-auto !grid !w-12 !h-12"><Puzzle className="w-6 h-6" /></span>
            <p className="text-[15px] text-[var(--color-text-muted)]">
              Run the connection-skills and reasoning-skills migrations on your database, then reload.
              The built-ins add themselves.
            </p>
          </div>
        </Card>
      ) : (
        <>
          {/* ── Reasoning skills ─────────────────────────────────────────── */}
          <section>
            <div className="flex items-end gap-3 mb-2.5 min-h-9">
              <div className="min-w-0 flex-1">
                <h2 className="flex items-center gap-2.5 font-display text-[19px] leading-tight font-semibold text-[var(--color-text)]">
                  <span aria-hidden className="ui-icon-tile is-sm is-solid"><Sparkles className="w-4 h-4" /></span> Reasoning skills
                  {rskills && rskills.length > 0 && <span className="ui-count is-solid">{rskills.filter((x) => x.enabled).length} on</span>}
                </h2>
                <p className="text-[14px] text-[var(--color-text-muted)]">What the AI carries when it answers. Each names when it applies, so several can be on.</p>
              </div>
              {buildButton("reasoning")}
            </div>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
              {rskills === null ? (
                <p className="px-4 py-3 text-[15px] text-[var(--color-text-muted)]">Run the reasoning-skills migration to unlock this list.</p>
              ) : rskills.length === 0 ? (
                <p className="px-4 py-3 text-[15px] text-[var(--color-text-muted)]">No reasoning skills yet. Build one: &ldquo;when someone asks X, always do Y&rdquo;.</p>
              ) : (
                <table className="w-full text-[15px]">
                  {head}
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {rskills.map((r) => {
                      const mayManage = canManageOrg || r.created_by === uid;
                      return (
                        <tr key={r.id} className={`align-top ${r.enabled ? "" : "text-[var(--color-text-muted)]"}`}>
                          <td className="px-4 py-3 min-w-0">
                            <div className="flex items-start gap-2.5 min-w-0">
                            <span aria-hidden className={`ui-icon-tile is-sm mt-px ${r.enabled ? "" : "!bg-[var(--color-surface-2)] !text-[var(--color-text-muted)]"}`}><Sparkles className="w-4 h-4" /></span>
                            <div className="min-w-0 flex-1">
                            <div className={`font-semibold ${r.enabled ? "text-[var(--color-text)]" : ""}`}>{r.name}</div>
                            {r.description && <p className="mt-0.5 text-[14px] text-[var(--color-text-muted)] line-clamp-2 max-w-[80ch]">{r.description}</p>}
                            <div className="sm:hidden mt-1">{whosePill(r)}</div>
                            {/* The pack itself, on demand. */}
                            <details className="group mt-1">
                              <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden inline-flex text-[14px] text-[var(--color-accent-text)] hover:underline">
                                <span className="group-open:hidden">View the discipline</span><span className="hidden group-open:inline">Hide the discipline</span>
                              </summary>
                              <pre className="mt-1.5 whitespace-pre-wrap text-[14px] leading-relaxed text-[var(--color-text-muted)] border-l-2 border-[var(--color-border-strong)] pl-3 max-h-48 overflow-y-auto font-sans">{r.instructions}</pre>
                            </details>
                            </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 hidden md:table-cell whitespace-nowrap"><span className="ui-tag">Answer discipline</span></td>
                          <td className="px-4 py-3 hidden sm:table-cell">{whosePill(r)}</td>
                          <td className="px-2 sm:px-4 py-3">{toggleButton({ id: r.id, name: r.name, enabled: r.enabled, mayManage, onToggle: () => setAnswerSkillEnabled(r.id, !r.enabled) })}</td>
                          <td className="px-1 sm:px-2 py-2">{rowActions({
                            id: r.id, name: r.name, builtin: !!r.builtin_key, mayManage, visibility: r.visibility,
                            onFlip: () => setAnswerSkillVisibility(r.id, r.visibility === "org" ? "private" : "org"),
                            onDelete: () => deleteAnswerSkill(r.id),
                          })}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {/* ── Connection skills ────────────────────────────────────────── */}
          <section>
            <div className="flex items-end gap-3 mb-2.5 min-h-9">
              <div className="min-w-0 flex-1">
                <h2 className="flex items-center gap-2.5 font-display text-[19px] leading-tight font-semibold text-[var(--color-text)]">
                  <span aria-hidden className="ui-icon-tile is-sm is-solid"><Puzzle className="w-4 h-4" /></span> Connection skills
                  {rules && rules.length > 0 && <span className="ui-count is-solid">{rules.filter((x) => x.enabled).length} on</span>}
                </h2>
                <p className="text-[14px] text-[var(--color-text-muted)]">
                  Detectors that grow the org graph; they run with &ldquo;Find connections&rdquo; and findings wait for review.{" "}
                  <Link href="/admin/proposed-links" className="inline-flex items-center gap-0.5 text-[var(--color-accent-text)] hover:underline">
                    Review what they found <ArrowUpRight className="w-3.5 h-3.5" />
                  </Link>
                </p>
              </div>
              {buildButton("connection")}
            </div>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
              {rules === null ? (
                <p className="px-4 py-3 text-[15px] text-[var(--color-text-muted)]">Run the connection-skills migration to unlock this list.</p>
              ) : rules.length === 0 ? (
                <p className="px-4 py-3 text-[15px] text-[var(--color-text-muted)]">No connection skills yet. Describe your facility&apos;s numbering convention and your AI drafts the detector.</p>
              ) : (
                <table className="w-full text-[15px]">
                  {head}
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {rules.map((r) => {
                      const meta = KIND_META[r.kind] ?? KIND_META.reference;
                      const KindIcon = meta.icon;
                      const mayManage = canManageOrg || r.created_by === uid;
                      return (
                        <tr key={r.id} className={`align-top ${r.enabled ? "" : "text-[var(--color-text-muted)]"}`}>
                          <td className="px-4 py-3 min-w-0">
                            <div className="flex items-start gap-2.5 min-w-0">
                            <span aria-hidden className={`ui-icon-tile is-sm mt-px ${r.enabled ? "" : "!bg-[var(--color-surface-2)] !text-[var(--color-text-muted)]"}`}><KindIcon className="w-4 h-4" /></span>
                            <div className="min-w-0 flex-1">
                            <div className={`font-semibold ${r.enabled ? "text-[var(--color-text)]" : ""}`}>{r.name}</div>
                            {r.description && <p className="mt-0.5 text-[14px] text-[var(--color-text-muted)] line-clamp-2 max-w-[80ch]">{r.description}</p>}
                            <div className="sm:hidden mt-1 flex flex-wrap gap-1"><span className="ui-tag">{meta.label}</span>{whosePill(r)}</div>
                            {(r.config?.patterns?.length ?? 0) > 0 && (
                              <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                                {r.config.patterns!.slice(0, 3).map((pt) => (
                                  <code key={pt} className="ui-tag !font-mono !text-[12.5px] !h-6 max-w-full truncate">{pt}</code>
                                ))}
                                {(r.config.patterns!.length > 3) && (
                                  <span className="ui-tag is-more !h-6" title={r.config.patterns!.slice(3).join("\n")}>+{r.config.patterns!.length - 3}</span>
                                )}
                              </div>
                            )}
                            </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 hidden md:table-cell whitespace-nowrap">
                            <span className="ui-tag"><KindIcon className="w-3.5 h-3.5" /> {meta.label}</span>
                          </td>
                          <td className="px-4 py-3 hidden sm:table-cell">{whosePill(r)}</td>
                          <td className="px-2 sm:px-4 py-3">{toggleButton({ id: r.id, name: r.name, enabled: r.enabled, mayManage, onToggle: () => setLinkRuleEnabled(r.id, !r.enabled) })}</td>
                          <td className="px-1 sm:px-2 py-2">{rowActions({
                            id: r.id, name: r.name, builtin: !!r.builtin_key, mayManage, visibility: r.visibility,
                            onFlip: () => setLinkRuleVisibility(r.id, r.visibility === "org" ? "private" : "org"),
                            onDelete: () => deleteLinkRule(r.id),
                          })}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>
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
