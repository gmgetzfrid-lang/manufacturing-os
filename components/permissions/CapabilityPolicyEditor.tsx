"use client";

// CapabilityPolicyEditor — the "Actions" side of the permissions console.
// Content permissions govern WHO SEES WHAT; this governs WHO MAY DO WHAT:
// every drafting-request workflow transition, holds, force-release, and the
// metrics/admin surfaces. Checkbox grid per capability × role token, plus
// (DEC-13 stage 2) REQUEST-TYPE OVERRIDES: a rule scoped to one of the org's
// configured request types whose tokens REPLACE the base list for tickets
// of that type — "ASBUILT may only be approved by DocCtrl".
//
// Rails: critical capabilities can never lose Admin — on the base list OR on
// any override (validateCapabilityPolicy rejects the save, here for the
// message and again on the server — WF-11: the save is a POST to
// /api/admin/capability-policy, where a critical capability is Admin's to
// change); identity rights (a ticket's own requester/drafter/assigned
// engineer) are not configurable by design; every save writes a
// before/after audit row on the server. Defaults reproduce
// historical behavior exactly, so an untouched policy changes nothing. A
// capability with no override is stored in the legacy bare-list shape, so an
// org that never adds one stores byte-identical policy JSON.
//
// admin-and-org Round G, P9:
//   * ALOG-1 — the grid loads FRESH (this tab's cached copy is dropped first)
//     and a policy that could not be read is said, with Retry — never drawn
//     as the org's policy, and nothing can be saved over it.
//   * ALOG-12 — the save carries the version the grid was loaded at; the
//     route refuses a stale one (409 policy_changed). The editor then
//     re-reads: when only grants moved (the role grid it started from is
//     still the stored one) it saves again on the new version, otherwise it
//     shows the other admin's grid and says so.
//   * ALOG-9 — the token vocabulary is declared once (lib/roleCapabilities.ts
//     POLICY_TOKENS); a stored token with no column is NAMED on its row,
//     never hidden.
//   * QUAL-14 — PROJECT-SCOPED OVERRIDES: for a capability decided per
//     project (PROJECT_SCOPED_CAPS — quality.sign_off), a rule naming one
//     project, whose tokens REPLACE the row above for that project only.
//     Saved through the policy route (audited; refused until the database
//     reads projectId, 20261136), listed by project name, removable.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { SlidersHorizontal, Loader2, RotateCcw, Check, AlertTriangle, Plus, X } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { appConfirm } from "@/components/providers/DialogProvider";
import { supabase } from "@/lib/supabase";
import {
  CAPABILITY_DEFS, defaultCapabilityPolicy, loadCapabilityPolicyEntry, saveCapabilityPolicy,
  validateCapabilityPolicy, invalidateCapabilityPolicy, isRuleArray, ruleIsConditional, describeWhen,
  CapabilityPolicyChangeError, POLICY_CHANGED, PROJECT_SCOPED_CAPS,
  type CapabilityId, type CapabilityEntry, type CapabilityRule, type CapabilityPolicy,
} from "@/lib/capabilityPolicy";
import { loadRequestTypeOptions, type RequestTypeOption } from "@/lib/requestTypes";
import { DORMANT_ROLES, POLICY_TOKENS } from "@/lib/roleCapabilities";

/** Every token the grid and the override rows can set — declared once, in
 *  lib/roleCapabilities.ts (ALOG-9); re-exported for the existing callers. */
export { POLICY_TOKENS };
const TOKENS = POLICY_TOKENS;

/** ALOG-9 done-when 2: tokens a stored list holds that the grid has no column
 *  for (an "Engineer-2", a typo, a retired role). They stay live in the
 *  evaluator, so the row names them instead of hiding them. */
export function tokensOutsideGrid(tokens: readonly string[]): string[] {
  return tokens.filter((t) => !TOKENS.includes(t));
}
const TOKEN_LABEL: Record<string, string> = {
  "*": "Everyone", DraftingSupervisor: "DraftingSup", Engineer: "Engineer (all tiers)",
  ...Object.fromEntries(DORMANT_ROLES.map((r) => [r, `${r} (dept)`])),
};

/** One editable override row: a rule scoped to exactly one request type. */
interface Override { type: string; tokens: string[] }
/** QUAL-14: one editable project-scoped row: a rule naming exactly one project. */
interface ProjectOverride { projectId: string; tokens: string[] }
type Base = Record<CapabilityId, string[]>;
type Overrides = Partial<Record<CapabilityId, Override[]>>;
type ProjectOverrides = Partial<Record<CapabilityId, ProjectOverride[]>>;
/** Conditional rules this editor cannot render (unit / library / discipline
 *  or multi-key clauses) — preserved verbatim so a save never drops them. */
type Opaque = Partial<Record<CapabilityId, CapabilityRule[]>>;

/** Split a stored policy into what the grid edits, what the override panels
 *  edit (request-type rows; QUAL-14: project rows on a project-scoped
 *  capability), and what must ride along untouched. */
export function splitPolicyForEditor(stored: CapabilityPolicy): { base: Base; overrides: Overrides; opaque: Opaque; projectOverrides: ProjectOverrides } {
  const base = defaultCapabilityPolicy();
  const overrides: Overrides = {};
  const opaque: Opaque = {};
  const projectOverrides: ProjectOverrides = {};
  for (const def of CAPABILITY_DEFS) {
    const entry = stored.caps?.[def.id];
    if (entry === undefined) continue;
    if (!isRuleArray(entry)) { base[def.id] = entry as string[]; continue; }
    const unconditional = entry.find((r) => !ruleIsConditional(r));
    if (unconditional) base[def.id] = unconditional.tokens;
    for (const r of entry) {
      if (!ruleIsConditional(r)) continue;
      const keys = Object.keys(r.when ?? {}).filter((k) => ((r.when as Record<string, string[] | undefined>)[k]?.length ?? 0) > 0);
      if (keys.length === 1 && keys[0] === "requestType") {
        for (const type of r.when?.requestType ?? []) {
          (overrides[def.id] ??= []).push({ type, tokens: [...r.tokens] });
        }
      } else if (keys.length === 1 && keys[0] === "projectId" && PROJECT_SCOPED_CAPS.has(def.id)) {
        for (const projectId of r.when?.projectId ?? []) {
          (projectOverrides[def.id] ??= []).push({ projectId, tokens: [...r.tokens] });
        }
      } else {
        (opaque[def.id] ??= []).push(r);
      }
    }
  }
  return { base, overrides, opaque, projectOverrides };
}

/** Recombine for saving: a capability with no override keeps the bare-list
 *  shape (byte-compatible with what it stored before); one with overrides
 *  becomes a rule list — base first, then one rule per request-type row,
 *  then one rule per project row (QUAL-14), then any preserved rules. */
export function joinPolicyFromEditor(base: Base, overrides: Overrides, opaque: Opaque, projectOverrides: ProjectOverrides = {}): Partial<Record<CapabilityId, CapabilityEntry>> {
  const caps: Partial<Record<CapabilityId, CapabilityEntry>> = {};
  for (const def of CAPABILITY_DEFS) {
    const rows = overrides[def.id] ?? [];
    const projectRows = projectOverrides[def.id] ?? [];
    const keep = opaque[def.id] ?? [];
    if (rows.length === 0 && projectRows.length === 0 && keep.length === 0) { caps[def.id] = base[def.id] ?? []; continue; }
    caps[def.id] = [
      { tokens: base[def.id] ?? [] },
      ...rows.map((o) => ({ tokens: o.tokens, when: { requestType: [o.type] } })),
      ...projectRows.map((o) => ({ tokens: o.tokens, when: { projectId: [o.projectId] } })),
      ...keep,
    ];
  }
  return caps;
}

export default function CapabilityPolicyEditor({ canEdit }: { canEdit: boolean }) {
  const { activeOrgId, uid, userEmail } = useRole();
  const [policy, setPolicy] = useState<Base | null>(null);
  const [baseline, setBaseline] = useState<Base | null>(null);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [baselineOverrides, setBaselineOverrides] = useState<Overrides>({});
  const [opaque, setOpaque] = useState<Opaque>({});
  const [projectOverrides, setProjectOverrides] = useState<ProjectOverrides>({});
  const [baselineProjectOverrides, setBaselineProjectOverrides] = useState<ProjectOverrides>({});
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectsErr, setProjectsErr] = useState<string | null>(null);
  const [newProjectCap, setNewProjectCap] = useState<CapabilityId>("quality.sign_off");
  const [newProject, setNewProject] = useState("");
  // ALOG-12: the version the grid was loaded at, and the grid it started from.
  const [version, setVersion] = useState<string | null>(null);
  const [baselineCaps, setBaselineCaps] = useState<string>("");
  // ALOG-1: a policy that could not be read is said, never drawn as the org's.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requestTypes, setRequestTypes] = useState<RequestTypeOption[]>([]);
  const [newCap, setNewCap] = useState<CapabilityId>("ticket.direct_approve");
  const [newType, setNewType] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  /** A FRESH read: this tab's cached copy is dropped first, so the grid —
   *  and the version a save carries — is the stored row, not a minute-old
   *  copy (ALOG-12), and a failed read has no stale copy to hide behind. */
  const readFresh = useCallback(async () => {
    if (!activeOrgId) return null;
    invalidateCapabilityPolicy(activeOrgId);
    return loadCapabilityPolicyEntry(activeOrgId);
  }, [activeOrgId]);
  const apply = useCallback((stored: CapabilityPolicy, at: string | null) => {
    const split = splitPolicyForEditor(stored);
    setPolicy(split.base);
    setBaseline(split.base);
    setOverrides(split.overrides);
    setBaselineOverrides(split.overrides);
    setProjectOverrides(split.projectOverrides);
    setBaselineProjectOverrides(split.projectOverrides);
    setOpaque(split.opaque);
    setVersion(at);
    setBaselineCaps(JSON.stringify(joinPolicyFromEditor(split.base, split.overrides, split.opaque, split.projectOverrides)));
    setDirty(false);
  }, []);
  const load = useCallback(async () => {
    if (!activeOrgId) return;
    const [entry, types, proj] = await Promise.all([
      readFresh(),
      loadRequestTypeOptions(activeOrgId),
      supabase.from("projects").select("id, name").eq("org_id", activeOrgId).order("name"),
    ]);
    setRequestTypes(types);
    setProjectsErr(proj.error ? proj.error.message : null);
    setProjects((((proj.data ?? []) as Array<Record<string, unknown>>)).map((r) => ({ id: String(r.id), name: String(r.name ?? r.id) })));
    if (!entry) return;
    if (entry.unreadable) {
      setLoadError(entry.unreadable);
      setPolicy(null);
      return;
    }
    setLoadError(null);
    apply(entry.policy, entry.version);
  }, [activeOrgId, readFresh, apply]);
  useEffect(() => { void load(); }, [load]);

  const areas = useMemo(() => [...new Set(CAPABILITY_DEFS.map((d) => d.area))], []);
  const typeLabel = (v: string) => requestTypes.find((t) => t.value === v)?.label ?? v;
  const projectLabel = (id: string) => projects.find((p) => p.id === id)?.name ?? `project ${id.slice(0, 8)}… (not visible to you)`;
  const capLabel = (c: CapabilityId) => CAPABILITY_DEFS.find((d) => d.id === c)?.label ?? c;

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

  const toggleOverride = (cap: CapabilityId, idx: number, token: string) => {
    if (!canEdit) return;
    setOverrides((o) => {
      const rows = [...(o[cap] ?? [])];
      const row = rows[idx];
      if (!row) return o;
      const tokens = row.tokens.includes(token) ? row.tokens.filter((t) => t !== token) : [...row.tokens, token];
      rows[idx] = { ...row, tokens };
      return { ...o, [cap]: rows };
    });
    setDirty(true);
    setMsg(null);
  };

  const addOverride = () => {
    if (!canEdit || !newType || !policy) return;
    if ((overrides[newCap] ?? []).some((r) => r.type === newType)) {
      setMsg({ tone: "err", text: `${capLabel(newCap)} already has an override for ${typeLabel(newType)} — edit that row.` });
      return;
    }
    const def = CAPABILITY_DEFS.find((d) => d.id === newCap);
    // Start a critical capability's override from Admin so the rail holds.
    setOverrides((o) => ({ ...o, [newCap]: [...(o[newCap] ?? []), { type: newType, tokens: def?.critical ? ["Admin"] : [] }] }));
    setDirty(true);
    setMsg(null);
  };

  const removeOverride = (cap: CapabilityId, idx: number) => {
    if (!canEdit) return;
    setOverrides((o) => ({ ...o, [cap]: (o[cap] ?? []).filter((_, i) => i !== idx) }));
    setDirty(true);
    setMsg(null);
  };

  // QUAL-14: project-scoped rows (a capability decided per project only).
  const addProjectOverride = () => {
    if (!canEdit || !newProject || !policy) return;
    if ((projectOverrides[newProjectCap] ?? []).some((r) => r.projectId === newProject)) {
      setMsg({ tone: "err", text: `${capLabel(newProjectCap)} already has a rule for ${projectLabel(newProject)} — edit that row.` });
      return;
    }
    setProjectOverrides((o) => ({ ...o, [newProjectCap]: [...(o[newProjectCap] ?? []), { projectId: newProject, tokens: [] }] }));
    setDirty(true);
    setMsg(null);
  };
  const toggleProjectOverride = (cap: CapabilityId, idx: number, token: string) => {
    if (!canEdit) return;
    setProjectOverrides((o) => {
      const rows = [...(o[cap] ?? [])];
      const row = rows[idx];
      if (!row) return o;
      rows[idx] = { ...row, tokens: row.tokens.includes(token) ? row.tokens.filter((t) => t !== token) : [...row.tokens, token] };
      return { ...o, [cap]: rows };
    });
    setDirty(true);
    setMsg(null);
  };
  const removeProjectOverride = (cap: CapabilityId, idx: number) => {
    if (!canEdit) return;
    setProjectOverrides((o) => ({ ...o, [cap]: (o[cap] ?? []).filter((_, i) => i !== idx) }));
    setDirty(true);
    setMsg(null);
  };

  const save = async () => {
    if (!activeOrgId || !uid || !policy) return;
    const caps = joinPolicyFromEditor(policy, overrides, opaque, projectOverrides);
    const err = validateCapabilityPolicy({ caps });
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
      const wasRows = baselineOverrides[d.id] ?? [];
      const nowRows = overrides[d.id] ?? [];
      for (const r of nowRows) {
        const prev = wasRows.find((w) => w.type === r.type);
        if (!prev) changes.push(`${d.label} for ${typeLabel(r.type)}: ONLY ${r.tokens.join(", ") || "nobody"} (new override)`);
        else if (prev.tokens.join("|") !== r.tokens.join("|")) changes.push(`${d.label} for ${typeLabel(r.type)}: ONLY ${r.tokens.join(", ") || "nobody"} (was ${prev.tokens.join(", ") || "nobody"})`);
      }
      for (const w of wasRows) {
        if (!nowRows.some((r) => r.type === w.type)) changes.push(`${d.label} for ${typeLabel(w.type)}: override removed — base list applies again`);
      }
      const wasProj = baselineProjectOverrides[d.id] ?? [];
      const nowProj = projectOverrides[d.id] ?? [];
      for (const r of nowProj) {
        const prev = wasProj.find((w) => w.projectId === r.projectId);
        if (!prev) changes.push(`${d.label} on ${projectLabel(r.projectId)}: ${r.tokens.join(", ") || "nobody by role"} (new project rule)`);
        else if (prev.tokens.join("|") !== r.tokens.join("|")) changes.push(`${d.label} on ${projectLabel(r.projectId)}: ${r.tokens.join(", ") || "nobody by role"} (was ${prev.tokens.join(", ") || "nobody by role"})`);
      }
      for (const w of wasProj) {
        if (!nowProj.some((r) => r.projectId === w.projectId)) changes.push(`${d.label} on ${projectLabel(w.projectId)}: project rule removed — the row above applies again`);
      }
    }
    if (changes.length > 0) {
      const ok = await appConfirm({
        message: `This changes who can act, effective immediately:\n\n${changes.slice(0, 8).join("\n")}${changes.length > 8 ? `\n…and ${changes.length - 8} more` : ""}\n\nApply?`,
      });
      if (!ok) return;
    }
    setSaving(true);
    const commit = (written: string | null) => {
      setBaseline(policy);
      setBaselineOverrides(overrides);
      setBaselineProjectOverrides(projectOverrides);
      setVersion(written);
      setBaselineCaps(JSON.stringify(caps));
      setDirty(false);
      setMsg({ tone: "ok", text: "Saved — validated and audited on the server; enforced on the next action." });
    };
    try {
      // This editor only owns the role grid: the policy route preserves the
      // per-person grants, re-validates, requires Admin for a critical
      // capability and writes the before/after audit row (WF-11). ALOG-12:
      // it carries the version the grid was loaded at.
      const out = await saveCapabilityPolicy({ orgId: activeOrgId, policy: { caps }, actorUserId: uid, actorEmail: userEmail, version });
      invalidateCapabilityPolicy(activeOrgId);
      commit(out.version);
    } catch (e) {
      if (!(e instanceof CapabilityPolicyChangeError) || e.code !== POLICY_CHANGED) {
        setMsg({ tone: "err", text: (e as Error).message });
        return;
      }
      // ALOG-12: the stored row moved on since this grid loaded. Re-read it.
      const fresh = await readFresh();
      if (!fresh || fresh.unreadable) {
        setMsg({ tone: "err", text: `${e.message} The current policy could not be read${fresh?.unreadable ? ` (${fresh.unreadable})` : ""} — reload the page.` });
        return;
      }
      const s2 = splitPolicyForEditor(fresh.policy);
      const storedCaps = JSON.stringify(joinPolicyFromEditor(s2.base, s2.overrides, s2.opaque, s2.projectOverrides));
      if (storedCaps === baselineCaps) {
        // Only grants moved (a delegation, an expiry pruned): the grid this
        // edit started from is still the stored one — save it on the new version.
        try {
          const out = await saveCapabilityPolicy({ orgId: activeOrgId, policy: { caps }, actorUserId: uid, actorEmail: userEmail, version: fresh.version });
          invalidateCapabilityPolicy(activeOrgId);
          commit(out.version);
        } catch (e2) {
          setMsg({ tone: "err", text: (e2 as Error).message });
        }
        return;
      }
      // Someone else changed the grid: show theirs, never overwrite it.
      apply(fresh.policy, fresh.version);
      setMsg({ tone: "err", text: "Another admin changed the action permissions since you opened this page — the grid now shows their version and your change was NOT saved. Make your change again." });
    } finally { setSaving(false); }
  };

  const resetDefaults = () => {
    setPolicy(defaultCapabilityPolicy());
    setOverrides({});
    setProjectOverrides({});
    setOpaque({});
    setDirty(true);
    setMsg(null);
  };

  if (loadError) {
    return (
      <div role="alert" className="rounded-2xl border border-rose-500/30 bg-rose-500/[0.06] mb-5 px-4 py-3 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div className="flex-1">
          <div className="font-bold">Action permissions — this workspace&apos;s policy could not be read</div>
          <div className="mt-0.5">({loadError}) Nothing is shown here rather than the shipped defaults, and nothing can be saved over the stored policy until it loads.</div>
        </div>
        <button onClick={() => void load()} className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-rose-500/40 text-[11px] font-bold">
          <RotateCcw className="w-3 h-3" /> Retry
        </button>
      </div>
    );
  }
  if (!policy) return null;

  const overrideRows = CAPABILITY_DEFS.flatMap((d) => (overrides[d.id] ?? []).map((row, idx) => ({ def: d, row, idx })));
  const projectRows = CAPABILITY_DEFS.flatMap((d) => (projectOverrides[d.id] ?? []).map((row, idx) => ({ def: d, row, idx })));
  const projectScopedDefs = CAPABILITY_DEFS.filter((d) => PROJECT_SCOPED_CAPS.has(d.id));
  const opaqueCount = Object.values(opaque).reduce((n, rs) => n + (rs?.length ?? 0), 0);

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
                  // DEC-11 / WF-17: a dormant capability (no live status
                  // consults its base list) renders greyed with the reason —
                  // never as a live-looking control.
                  <tr key={d.id} title={d.dormant ? d.dormantNote : undefined} className={`border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]/50 ${d.dormant ? "opacity-50" : ""}`}>
                    <td className="sticky left-0 bg-[var(--color-surface)] px-4 py-1.5">
                      <span className="font-medium text-[var(--color-text)]">{d.label}</span>
                      {d.critical && <span className="ml-1.5 text-[9px] font-black text-amber-600 dark:text-amber-400 cursor-help" title="Critical: Admin cannot be removed">CRITICAL</span>}
                      {d.dormant && <span className="ml-1.5 text-[9px] font-black text-[var(--color-text-faint)] cursor-help" title={d.dormantNote}>DORMANT</span>}
                      {(overrides[d.id]?.length ?? 0) > 0 && <span className="ml-1.5 text-[9px] font-black text-sky-700 dark:text-sky-300 cursor-help" title="Request-type overrides below replace this row for tickets of those types">{overrides[d.id]?.length} OVERRIDE{(overrides[d.id]?.length ?? 0) > 1 ? "S" : ""}</span>}
                      {(projectOverrides[d.id]?.length ?? 0) > 0 && <span className="ml-1.5 text-[9px] font-black text-violet-700 dark:text-violet-300 cursor-help" title="Project rules below replace this row on those projects">{projectOverrides[d.id]?.length} PROJECT RULE{(projectOverrides[d.id]?.length ?? 0) > 1 ? "S" : ""}</span>}
                      <div className="text-[10px] text-[var(--color-text-faint)]">{d.description}</div>
                      {tokensOutsideGrid(policy[d.id] ?? []).length > 0 && (
                        <div className="text-[10px] font-bold text-amber-700 dark:text-amber-300" title="The evaluator still matches these stored tokens; the grid has no column for them. Unticking every column leaves them in place.">
                          Also stored, no column here: {tokensOutsideGrid(policy[d.id] ?? []).join(", ")} — still live
                        </div>
                      )}
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

      {/* DEC-13 stage 2 — request-type overrides */}
      <div className="px-4 py-3 border-t border-[var(--color-border)]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-black text-[var(--color-text)]">Request-type overrides</span>
          <span className="text-[10px] text-[var(--color-text-faint)]">for tickets of one request type, the override&apos;s list REPLACES the row above — &ldquo;ASBUILT may only be approved by DocCtrl&rdquo;. Enforced in the workflow route and honoured by the database evaluator.</span>
        </div>
        {canEdit && (
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <select value={newCap} onChange={(e) => setNewCap(e.target.value as CapabilityId)} className="h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[11px]">
              {CAPABILITY_DEFS.filter((d) => d.area === "Requests").map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
            <select value={newType} onChange={(e) => setNewType(e.target.value)} className="h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[11px] min-w-[160px]">
              <option value="">Request type…</option>
              {requestTypes.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <button onClick={addOverride} disabled={!newType} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-40">
              <Plus className="w-3 h-3" /> Add override
            </button>
            {requestTypes.length === 0 && <span className="text-[10px] text-[var(--color-text-faint)]">No request types are configured (Admin → Requests) — overrides key off that list.</span>}
          </div>
        )}
        {overrideRows.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {overrideRows.map(({ def, row, idx }) => (
              <li key={`${def.id}:${row.type}`} className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[11px] flex items-center gap-2 flex-wrap">
                <span className="font-bold text-[var(--color-text)]">{def.label}</span>
                <span className="text-[var(--color-text-faint)]">for</span>
                <span className="font-mono font-bold text-sky-700 dark:text-sky-300">{typeLabel(row.type)}</span>
                <span className="text-[var(--color-text-faint)]">→ only</span>
                <div className="flex items-center gap-1 flex-wrap">
                  {TOKENS.map((t) => {
                    const on = row.tokens.includes(t);
                    const locked = !canEdit || (def.critical && t === "Admin" && on);
                    return (
                      <button key={t} onClick={() => !locked && toggleOverride(def.id, idx, t)} disabled={locked}
                        title={locked && on ? "Admin is locked on critical capabilities" : undefined}
                        className={`px-1.5 py-0.5 rounded border text-[10px] ${on ? "bg-emerald-500 border-emerald-500 text-white" : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"} ${locked ? "opacity-70 cursor-not-allowed" : ""}`}>
                        {TOKEN_LABEL[t] ?? t}
                      </button>
                    );
                  })}
                </div>
                {row.tokens.length === 0 && <span className="text-[10px] font-bold text-rose-700 dark:text-rose-300">nobody by role — only personal grants and identity rights apply</span>}
                {tokensOutsideGrid(row.tokens).length > 0 && <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300">also stored: {tokensOutsideGrid(row.tokens).join(", ")} — still live</span>}
                {canEdit && (
                  <button onClick={() => removeOverride(def.id, idx)} className="ml-auto text-[var(--color-text-faint)] hover:text-rose-600" title="Remove this override (the base row applies again)">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-2 text-[11px] italic text-[var(--color-text-faint)]">No request-type overrides — every capability uses its row above for every ticket.</div>
        )}
        {/* QUAL-14 — project-scoped rules */}
        {projectScopedDefs.length > 0 && (
          <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-black text-[var(--color-text)]">Project-scoped rules</span>
              <span className="text-[10px] text-[var(--color-text-faint)]">for one project, the rule&apos;s list REPLACES the row above — &ldquo;on this project, Safety signs off its quality records&rdquo;. Admin, Document Control and the project&apos;s owner always can. Enforced by the database per project (needs migration 20261136; the save is refused until it is applied).</span>
            </div>
            {canEdit && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <select value={newProjectCap} onChange={(e) => setNewProjectCap(e.target.value as CapabilityId)} className="h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[11px]">
                  {projectScopedDefs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
                <select value={newProject} onChange={(e) => setNewProject(e.target.value)} className="h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[11px] min-w-[160px]">
                  <option value="">Project…</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button onClick={addProjectOverride} disabled={!newProject} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-40">
                  <Plus className="w-3 h-3" /> Add project rule
                </button>
                {projectsErr && <span className="text-[10px] font-bold text-rose-700 dark:text-rose-300">Projects could not be listed ({projectsErr}).</span>}
              </div>
            )}
            {projectRows.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {projectRows.map(({ def, row, idx }) => (
                  <li key={`${def.id}:${row.projectId}`} data-project-rule={row.projectId} className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[11px] flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-[var(--color-text)]">{def.label}</span>
                    <span className="text-[var(--color-text-faint)]">on</span>
                    <span className="font-bold text-violet-700 dark:text-violet-300">{projectLabel(row.projectId)}</span>
                    <span className="text-[var(--color-text-faint)]">→ only</span>
                    <div className="flex items-center gap-1 flex-wrap">
                      {TOKENS.map((t) => {
                        const on = row.tokens.includes(t);
                        return (
                          <button key={t} onClick={() => toggleProjectOverride(def.id, idx, t)} disabled={!canEdit}
                            className={`px-1.5 py-0.5 rounded border text-[10px] ${on ? "bg-emerald-500 border-emerald-500 text-white" : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"} ${!canEdit ? "opacity-70 cursor-not-allowed" : ""}`}>
                            {TOKEN_LABEL[t] ?? t}
                          </button>
                        );
                      })}
                    </div>
                    {row.tokens.length === 0 && <span className="text-[10px] font-bold text-rose-700 dark:text-rose-300">nobody by role — only the standing holders and personal grants</span>}
                    {tokensOutsideGrid(row.tokens).length > 0 && <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300">also stored: {tokensOutsideGrid(row.tokens).join(", ")} — still live</span>}
                    {canEdit && (
                      <button onClick={() => removeProjectOverride(def.id, idx)} className="ml-auto text-[var(--color-text-faint)] hover:text-rose-600" title="Remove this project rule (the row above applies again)">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-2 text-[11px] italic text-[var(--color-text-faint)]">No project-scoped rules — {projectScopedDefs.map((d) => d.label).join(", ")} uses its row above on every project.</div>
            )}
            <div className="mt-1 text-[10px] text-[var(--color-text-faint)]">A rule names roles, not people: everyone holding a ticked role who can see the project is granted there. A personal grant (View as… below) applies on every project — a person-scoped project grant is not available yet.</div>
          </div>
        )}
        {opaqueCount > 0 && (
          <div className="mt-2 text-[10px] text-[var(--color-text-faint)]">
            {opaqueCount} rule{opaqueCount > 1 ? "s" : ""} scoped by unit / library / discipline {opaqueCount > 1 ? "are" : "is"} stored on this policy and preserved on save (not editable here): {
              CAPABILITY_DEFS.flatMap((d) => (opaque[d.id] ?? []).map((r) => `${d.label} when ${describeWhen(r.when)} → ${r.tokens.join(", ") || "nobody"}`)).join("; ")
            }
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-faint)]">
        Identity rights are never configurable: a ticket&apos;s requester, assigned drafter, and assigned engineer always keep their own-ticket actions — except that a request-type override on &ldquo;Direct engineering approval&rdquo; binds the requester&apos;s own approval too (they send for engineer approval instead), and a reviewer picked for an overridden type must be inside that override. &ldquo;Engineer&rdquo; covers every Engineer-1…4 tier (tiers are labels, enforced identically).
      </div>
    </div>
  );
}
