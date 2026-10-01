"use client";

// ConnectionSkillsPanel — the ONE implementation of the Connection Skills
// list (HUB-8). The review page mounts it compact, where its output lands;
// the Skill Library mounts it as the Connection shelf. One list, one seeding
// entry, one set of controls — so the authority gates and the delete
// confirmation cannot diverge between the two surfaces again.
//
// Everything the engine detects is a skill listed here — the built-ins
// (drawing cross-references, shared equipment, answered-together) and any
// skill a member authors for their facility's own paperwork conventions
// ("WO-#####" work orders, permit numbers, ISO sheets…). Authority is
// DEC-55 (lib/skillAuthority): a member's skill is a private draft until a
// document controller shares it org-wide; built-ins belong to the org and
// only controllers switch them; the database enforces the same (20261125).
//
// SkillActions / SkillByline are exported so the Reasoning shelf renders the
// same controls from the same authority.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Puzzle, Plus, Loader2, Eye, EyeOff, Trash2, ChevronDown, AlertTriangle,
  Lock, Users, ArrowUpRight, Send, Undo2, Check, X, Sparkles,
  FileSearch, Boxes, MessageSquareQuote,
} from "lucide-react";
import SkillStudio from "@/components/intelligence/SkillStudio";
import { useRole } from "@/components/providers/RoleContext";
import { appConfirm } from "@/components/providers/DialogProvider";
import {
  listLinkRules, seedBuiltinRules, setLinkRuleEnabled, setLinkRuleVisibility,
  setLinkRuleShareRequest, deleteLinkRule, refusedSkillPatterns, type LinkRule,
} from "@/lib/linkRules";
import { isSkillController, skillControls, type SkillControls, type SkillRowLike } from "@/lib/skillAuthority";

const KIND_META: Record<string, { label: string; icon: typeof FileSearch; hue: string }> = {
  reference: { label: "Cross-reference", icon: FileSearch, hue: "from-sky-500 to-blue-600" },
  shared_entity: { label: "Shared equipment", icon: Boxes, hue: "from-emerald-500 to-teal-600" },
  co_citation: { label: "Usage", icon: MessageSquareQuote, hue: "from-violet-500 to-fuchsia-600" },
};

/** Which rows a viewer's list shows: org skills, their own, and — for a
 *  controller — the share requests waiting on them. A controller READS
 *  every skill (they govern the org's prompts), but a member's private
 *  draft is not listed on their shelf unless it was offered. The database
 *  applies the same filter to the read (skillShelfFilter); this keeps the
 *  shelf honest about anything else it is handed. */
export function listedSkills<T extends SkillRowLike>(rows: T[], uid: string | null): T[] {
  return rows.filter((r) => r.visibility === "org" || (uid !== null && r.created_by === uid) || !!r.share_requested);
}

export interface SkillOps {
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  setVisibility: (id: string, visibility: "org" | "private") => Promise<void>;
  setShareRequest: (id: string, requested: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

type ActionRow = SkillRowLike & { id: string; name: string; enabled: boolean };

/** Badges: built-in, org-wide / private, and a pending share request. */
export function SkillBadges({ row, kindLabel }: { row: ActionRow; kindLabel: string }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
      <span className="text-[9px] font-black uppercase tracking-wide text-[var(--color-text-muted)]">{kindLabel}</span>
      {row.builtin_key ? (
        <span className="text-[9px] font-black uppercase tracking-wide text-violet-600">Built-in</span>
      ) : (
        <span className="inline-flex items-center gap-0.5 text-[9px] font-black uppercase tracking-wide text-[var(--color-text-faint)]">
          {row.visibility === "org" ? <Users className="w-2.5 h-2.5" /> : <Lock className="w-2.5 h-2.5" />}
          {row.visibility === "org" ? "Org-wide" : "Private"}
        </span>
      )}
      {!row.builtin_key && row.visibility !== "org" && row.share_requested && (
        <span className="text-[9px] font-black uppercase tracking-wide text-amber-700">Share requested</span>
      )}
    </div>
  );
}

/** GOV-2: who wrote it and when it last changed, so an unexpected org-wide
 *  pack reads as an anomaly instead of one more switched-on skill. */
export function SkillByline({ row, uid }: {
  row: ActionRow & { created_by_name?: string | null; updated_at?: string | null; created_at?: string | null };
  uid: string | null;
}) {
  if (row.builtin_key) return <>Ships with the engine</>;
  const mine = uid !== null && row.created_by === uid;
  const when = row.updated_at ?? row.created_at ?? null;
  const date = when ? new Date(when).toLocaleDateString() : null;
  return <>by {mine ? "you" : (row.created_by_name ?? "a teammate")}{date ? ` · changed ${date}` : ""}</>;
}

/** Every control a skill card offers — the same buttons, the same gates, the
 *  same delete confirmation, wherever a skill is listed. */
export function SkillActions({ row, controls, ops, busy, run }: {
  row: ActionRow;
  controls: SkillControls;
  ops: SkillOps;
  busy: boolean;
  run: (id: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const icon = "w-3.5 h-3.5";
  const quiet = "p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50";
  const remove = async () => {
    const ok = await appConfirm({
      title: "Delete this skill?",
      message: `“${row.name}” stops running and its definition is gone. Anything it already produced stays — it carries its own evidence.`,
      confirmLabel: "Delete skill",
      tone: "danger",
    });
    if (!ok) return;
    await run(row.id, () => ops.remove(row.id));
  };
  const requested = !!row.share_requested;
  return (
    <div className="flex items-center gap-1 shrink-0">
      {controls.share && (
        <button type="button" disabled={busy} onClick={() => void run(row.id, () => ops.setVisibility(row.id, "org"))}
          title={requested ? "Approve — share it org-wide" : "Share org-wide"}
          className={requested
            ? "inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-black text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50"
            : quiet}>
          {requested ? <><Check className="w-3 h-3" /> Approve</> : <Users className={icon} />}
        </button>
      )}
      {controls.declineShare && (
        <button type="button" disabled={busy} onClick={() => void run(row.id, () => ops.setShareRequest(row.id, false))}
          title="Decline — it stays its author's private skill" className={quiet}>
          <X className={icon} />
        </button>
      )}
      {controls.unshare && (
        <button type="button" disabled={busy} onClick={() => void run(row.id, () => ops.setVisibility(row.id, "private"))}
          title="Make private" className={quiet}>
          <Lock className={icon} />
        </button>
      )}
      {controls.requestShare && (
        <button type="button" disabled={busy} onClick={() => void run(row.id, () => ops.setShareRequest(row.id, true))}
          title="Ask a document controller to share it org-wide" className={quiet}>
          <Send className={icon} />
        </button>
      )}
      {controls.withdrawRequest && (
        <button type="button" disabled={busy} onClick={() => void run(row.id, () => ops.setShareRequest(row.id, false))}
          title="Withdraw the share request" className={quiet}>
          <Undo2 className={icon} />
        </button>
      )}
      {controls.remove && (
        <button type="button" disabled={busy} onClick={() => void remove()}
          title="Delete this skill"
          className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50">
          <Trash2 className={icon} />
        </button>
      )}
      {controls.toggle && (
        <button type="button" disabled={busy} onClick={() => void run(row.id, () => ops.setEnabled(row.id, !row.enabled))}
          title={row.enabled ? "Disable — it stops running" : "Enable"}
          className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-black border transition-colors ${row.enabled
            ? "border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40"
            : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`}>
          {busy ? <Loader2 className="w-3 h-3 animate-spin" />
            : row.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          {row.enabled ? "On" : "Off"}
        </button>
      )}
    </div>
  );
}

const LINK_OPS: SkillOps = {
  setEnabled: setLinkRuleEnabled,
  setVisibility: setLinkRuleVisibility,
  setShareRequest: setLinkRuleShareRequest,
  remove: deleteLinkRule,
};

export default function ConnectionSkillsPanel({ mode = "compact", onRulesChange }: {
  /** compact = the review page's collapsible box; shelf = the Skill Library. */
  mode?: "compact" | "shelf";
  /** The shelf's parent counts skills in its pulse row. */
  onRulesChange?: (rules: LinkRule[] | null) => void;
}) {
  const { activeOrgId, roles, uid, userEmail } = useRole();
  // DEC-35 / DEC-55: the controller tier by the held collection — what
  // is_org_controller means — never a role list at the call site.
  const isController = isSkillController(roles);

  const [rules, setRules] = useState<LinkRule[] | null | undefined>(undefined);
  const [open, setOpen] = useState(mode === "shelf");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const next = await listLinkRules(activeOrgId, uid ?? null);
      loadedRef.current = true;
      setRules(next); onRulesChange?.(next); setError(null);
    } catch (e) {
      setError((e as Error).message);
      // HUB-8: a first read that fails is still an answer — the list renders
      // its error (and the Skill Library stops waiting on it) instead of
      // rendering nothing. A later failure keeps the list already shown.
      if (!loadedRef.current) {
        loadedRef.current = true;
        setRules([]); onRulesChange?.([]);
      }
    }
  }, [activeOrgId, uid, onRulesChange]);

  // HUB-2 / HUB-8: the one client seeding entry for Connection Skills, and
  // only for a controller — a built-in carries no author, so no member's
  // page load makes them its owner. The engine seeds on every run too.
  useEffect(() => {
    if (!activeOrgId || !uid) return;
    let alive = true;
    (async () => {
      if (isController) {
        const seeded = await seedBuiltinRules(activeOrgId);
        if (seeded.error && alive) setError(`Built-in skills could not be set up: ${seeded.error}`);
      }
      if (alive) await refresh();
    })();
    return () => { alive = false; };
  }, [activeOrgId, uid, isController, refresh]);

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    try { await fn(); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };

  const shown = useMemo(() => listedSkills(rules ?? [], uid ?? null), [rules, uid]);
  const enabledCount = shown.filter((r) => r.enabled).length;
  const requests = shown.filter((r) => !r.builtin_key && r.visibility !== "org" && r.share_requested && r.created_by !== uid).length;

  if (rules === undefined) return null;

  const errorBox = error && (
    <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-2.5 py-2 text-[11px] text-rose-700 dark:text-rose-300">
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
    </div>
  );

  const card = (r: LinkRule, i: number) => {
    const meta = KIND_META[r.kind] ?? KIND_META.reference;
    const KindIcon = meta.icon;
    const controls = skillControls(r, { uid: uid ?? null, isController });
    const patterns = r.config?.patterns ?? [];
    // LNK-6: what the engine will refuse of a custom skill's patterns (one
    // written before the bounded subset) — said on the card, as a switch-off is.
    const refused = r.builtin_key ? [] : refusedSkillPatterns(patterns);
    const compact = mode === "compact";
    return (
      <div key={r.id}
        style={compact ? undefined : { animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(i, 8) * 60}ms` }}
        className={compact
          ? `rounded-lg border px-3 py-2.5 ${r.enabled ? "border-[var(--color-border)] bg-[var(--color-surface)]" : "border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)]/50 opacity-70"}`
          : `rounded-2xl border overflow-hidden transition-all ${r.enabled
            ? "border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm hover:shadow-md"
            : "border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)]/40 opacity-75"}`}>
        {!compact && <div className={`h-1 bg-gradient-to-r ${meta.hue} ${r.enabled ? "" : "opacity-30"}`} />}
        <div className={compact ? "space-y-1" : "p-4 space-y-2"}>
          <div className="flex items-start gap-2.5">
            {!compact && (
              <span className={`shrink-0 w-9 h-9 rounded-xl bg-gradient-to-br ${meta.hue} text-white flex items-center justify-center shadow-sm ${r.enabled ? "" : "grayscale"}`}>
                <KindIcon className="w-[18px] h-[18px]" />
              </span>
            )}
            <div className="flex-1 min-w-0">
              <div className={`${compact ? "text-xs" : "text-sm"} font-black text-[var(--color-text)] leading-tight`}>{r.name}</div>
              <SkillBadges row={r} kindLabel={meta.label} />
            </div>
            <SkillActions row={r} controls={controls} ops={LINK_OPS} busy={busyId === r.id} run={run} />
          </div>
          {r.description && (
            <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{r.description}</p>
          )}
          {r.disabled_reason && !r.enabled && (
            <p className="text-[11px] text-amber-700 flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {r.disabled_reason}
            </p>
          )}
          {refused.length > 0 && (
            <p className="text-[11px] text-amber-700 flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              {refused.length === 1 ? "A pattern does not run" : `${refused.length} patterns do not run`} — {refused[0]}
            </p>
          )}
          {patterns.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {patterns.slice(0, 3).map((p) => (
                <code key={p} className="px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[10px] font-mono text-[var(--color-text)] max-w-full truncate">{p}</code>
              ))}
              {patterns.length > 3 && (
                <span className="text-[10px] text-[var(--color-text-faint)]">+{patterns.length - 3}</span>
              )}
            </div>
          )}
          <div className={`text-[10px] text-[var(--color-text-faint)] truncate ${compact ? "" : "pt-1 border-t border-[var(--color-border)]/60"}`}>
            <SkillByline row={r} uid={uid ?? null} />
          </div>
        </div>
      </div>
    );
  };

  const studio = wizardOpen && activeOrgId && uid && (
    <SkillStudio
      orgId={activeOrgId}
      userId={uid}
      userName={userEmail ?? undefined}
      kind="connection"
      onClose={() => setWizardOpen(false)}
      onCreated={() => { setWizardOpen(false); void refresh(); }}
    />
  );

  if (mode === "shelf") {
    if (rules === null) {
      return <div className="text-[11px] text-[var(--color-text-muted)]">Run the connection-skills migration to unlock this shelf.</div>;
    }
    return (
      <div className="space-y-3">
        {errorBox}
        <div className="grid md:grid-cols-2 gap-3">
          {shown.map(card)}
          {activeOrgId && uid && (
            <button type="button" onClick={() => setWizardOpen(true)}
              style={{ animation: "rise 0.45s var(--ease-fluid) both", animationDelay: `${Math.min(shown.length, 9) * 60}ms` }}
              className="rounded-2xl border-2 border-dashed border-[var(--color-border-strong)] hover:border-violet-400 min-h-[10rem] flex flex-col items-center justify-center gap-2 text-[var(--color-text-muted)] hover:text-violet-700 transition-colors p-4">
              <Sparkles className="w-6 h-6" />
              <span className="text-xs font-black">Build a skill</span>
              <span className="text-[10px] text-center max-w-[16rem]">Describe your facility&apos;s numbering convention — your AI drafts the detector, the tester proves it.</span>
            </button>
          )}
        </div>
        {studio}
      </div>
    );
  }

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
              : `${shown.length} skill${shown.length === 1 ? "" : "s"} · ${enabledCount} enabled${requests > 0 ? ` · ${requests} waiting to be shared` : ""}. The detectors “Find connections” runs — including ones written for your own numbering conventions.`}
          </div>
        </div>
        <ChevronDown className={`w-4 h-4 text-[var(--color-text-faint)] shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {errorBox && <div className="px-3.5 pb-3">{errorBox}</div>}
      {open && rules !== null && (
        <div className="px-3.5 pb-3.5 space-y-1.5 border-t border-[var(--color-border)] pt-3">
          {shown.map(card)}
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
      {studio}
    </div>
  );
}
