"use client";

// ConnectionSkillsPanel: the org's rulebook for link discovery, on the
// review page where its output lands, as one ruled table.
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
import { Plus, Loader2, Trash2, Lock, Users, ArrowUpRight, Puzzle } from "lucide-react";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { Section, Problem, tbl, sheet, btnQuiet, btnIcon, link, Pill } from "@/components/admin/kit";
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

  if (rules === undefined) {
    return (
      <Section label="Connection skills" icon={Puzzle}>
        <div className={`${sheet} px-4 py-4 text-[14px] text-[var(--color-text-muted)] flex items-center gap-2`}><Loader2 className="w-4 h-4 animate-spin" /> Loading connection skills…</div>
      </Section>
    );
  }

  return (
    <Section
      icon={Puzzle}
      label={<span className="inline-flex items-center gap-2">Connection skills
        {rules && rules.length > 0 && <span className="inline-flex items-center gap-1 font-sans text-[14px] font-normal text-[var(--color-text-muted)]"><span className="ui-count is-solid">{enabledCount}</span> of {rules.length} on</span>}
        <span className="font-sans font-normal text-[14px] leading-snug"><HelpTooltip>
          The detectors Find connections runs: the built-ins, and ones you write for your own numbering (work orders, permit numbers, ISO sheets).
        </HelpTooltip></span>
      </span>}
      action={rules !== null ? (
        <div className="flex items-center gap-3">
          <Link href="/intelligence/skills" className={`${link} text-[14px] inline-flex items-center gap-1`}>Skill library <ArrowUpRight className="w-3.5 h-3.5" /></Link>
          <button type="button" onClick={() => setWizardOpen(true)} className={btnQuiet}><Plus className="w-4 h-4" /> New skill</button>
        </div>
      ) : undefined}
    >
      {error && <Problem className="mb-2.5" retry={() => void refresh()}>{error}</Problem>}
      {rules === null ? (
        <div className={`${sheet} px-4 py-4 flex flex-wrap items-center gap-x-3 gap-y-1`}>
          <Pill tone="warn">Not set up</Pill>
          <span className="text-[14px] text-[var(--color-text-muted)]">Run the connection-skills migration to write your own detectors.</span>
        </div>
      ) : rules.length === 0 ? (
        <div className={`${sheet} px-4 py-4 text-[14px] text-[var(--color-text-muted)]`}>No skills yet. New skill teaches the engine your numbering.</div>
      ) : (
        <div className={tbl.wrap}>
          <table className={tbl.table}>
            <thead className={`${tbl.thead} max-md:hidden`}>
              <tr>
                <th className={tbl.th}>Skill</th>
                <th className={tbl.th}>Kind</th>
                <th className={`${tbl.th} max-lg:hidden`}>Who sees it</th>
                <th className={tbl.th}>On</th>
                <th className={`${tbl.th} w-[1%]`}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className={tbl.tbody}>
              {rules.map((r) => {
                const mine = r.created_by === uid;
                const mayManage = canManageOrg || mine;
                const who = r.builtin_key ? "Built-in" : r.visibility === "org" ? "Everyone" : "Only you";
                const kind = KIND_LABELS[r.kind] ?? r.kind;
                return (
                  <tr key={r.id} className={`${tbl.tr} max-md:grid max-md:grid-cols-[1fr_auto_auto] max-md:items-start max-md:py-1.5`}>
                    <td className={`${tbl.td} max-md:py-1 align-top min-w-0`}>
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span aria-hidden className={`ui-icon-tile is-sm ${r.enabled ? "" : "!bg-[var(--color-surface-2)] !text-[var(--color-text-muted)]"}`}><Puzzle className="w-4 h-4" /></span>
                        <span className={`font-semibold ${r.enabled ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{r.name}</span>
                      </div>
                      {r.description && <div className="text-[14px] text-[var(--color-text-muted)] line-clamp-1 max-w-[70ch]" title={r.description}>{r.description}</div>}
                      {(r.config?.patterns?.length ?? 0) > 0 && (
                        <div className="flex items-center gap-1 flex-wrap mt-1">
                          {r.config.patterns!.slice(0, 4).map((p) => (
                            <code key={p} className="ui-tag !font-mono !text-[12.5px] !h-6">{p}</code>
                          ))}
                          {r.config.patterns!.length > 4 && <span className="ui-tag is-more !h-6" title={r.config.patterns!.slice(4).join("\n")}>+{r.config.patterns!.length - 4}</span>}
                        </div>
                      )}
                      <div className="md:hidden mt-0.5 text-[13px] text-[var(--color-text-muted)]">{kind}, {who.toLowerCase()}</div>
                    </td>
                    <td className={`${tbl.td} align-top max-md:hidden whitespace-nowrap`}><span className="ui-tag">{kind}</span></td>
                    <td className={`${tbl.td} align-top max-lg:hidden whitespace-nowrap`}>
                      {/* Who sees it; for your own skill the pill flips it. */}
                      {!r.builtin_key && mayManage ? (
                        <button type="button" onClick={() => void flipVisibility(r)} disabled={busyId === r.id}
                          title={r.visibility === "org" ? "Make private: only you see it; what it finds still waits for review" : "Share with everyone"}
                          className={`ui-pill ${r.visibility === "org" ? "" : "is-muted"} hover:ring-2 hover:ring-[color-mix(in_srgb,var(--color-main)_30%,transparent)] transition-shadow`}>
                          {r.visibility === "org" ? <Users className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}{who}
                        </button>
                      ) : (
                        <Pill tone={!r.builtin_key && r.visibility === "org" ? "brand" : "none"}>
                          {!r.builtin_key && (r.visibility === "org" ? <Users className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />)}{who}
                        </Pill>
                      )}
                    </td>
                    <td className={`${tbl.td} max-md:py-1 align-top`}>
                      {mayManage ? (
                        <button type="button" role="switch" aria-checked={r.enabled} onClick={() => void toggle(r)} disabled={busyId === r.id}
                          aria-label={`${r.name}: ${r.enabled ? "on" : "off"}`}
                          title={r.enabled ? "Turn off: the engine skips this skill" : "Turn on"}
                          className="inline-flex items-center gap-2 h-8 rounded-md disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]">
                          <span className={`relative inline-flex w-9 h-5 rounded-full transition-colors ${r.enabled ? "bg-[var(--color-main)]" : "bg-[var(--color-border-strong)]"}`}>
                            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-[var(--color-surface)] shadow grid place-items-center transition-transform ${r.enabled ? "translate-x-4" : ""}`}>
                              {busyId === r.id && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-text-muted)]" />}
                            </span>
                          </span>
                        </button>
                      ) : (
                        <span className="text-[14px] text-[var(--color-text-muted)]">{r.enabled ? "On" : "Off"}</span>
                      )}
                    </td>
                    <td className={`${tbl.td} max-md:py-1 max-md:pl-1 align-top`}>
                      {!r.builtin_key && mayManage && (
                        <div className="flex items-center justify-end gap-1">
                          <button type="button" onClick={() => void flipVisibility(r)} disabled={busyId === r.id}
                            aria-label={r.visibility === "org" ? `Make ${r.name} private` : `Share ${r.name} with everyone`}
                            title={r.visibility === "org" ? "Make private: only you see it; what it finds still waits for review" : "Share with everyone"}
                            className={btnIcon}>
                            {r.visibility === "org" ? <Lock className="w-4 h-4" /> : <Users className="w-4 h-4" />}
                          </button>
                          <button type="button" onClick={() => void remove(r)} disabled={busyId === r.id}
                            aria-label={`Delete ${r.name}`} title="Delete this skill" className={`${btnIcon} hover:!text-[var(--state-overdue)]`}>
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
    </Section>
  );
}
