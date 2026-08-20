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
import {
  Puzzle, Plus, X, Loader2, Eye, EyeOff, Trash2, ChevronDown,
  FlaskConical, CheckCircle2, AlertTriangle, Sparkles, Lock, Users,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  listLinkRules, seedBuiltinRules, createLinkRule, setLinkRuleEnabled,
  setLinkRuleVisibility, deleteLinkRule, testSkillPatterns,
  type LinkRule, type LinkRuleVisibility,
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

          <button type="button" onClick={() => setWizardOpen(true)}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border-2 border-dashed border-[var(--color-border-strong)] text-[11px] font-black text-[var(--color-text-muted)] hover:border-violet-400 hover:text-violet-700 transition-colors">
            <Plus className="w-3.5 h-3.5" /> New skill — teach the engine your numbering convention
          </button>
        </div>
      )}

      {wizardOpen && activeOrgId && uid && (
        <SkillWizard
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

/** Authoring, with proof: the pattern runs live against sample text pasted
 *  from a real document, so what the author sees match is exactly what the
 *  engine will match. */
function SkillWizard({ orgId, userId, userName, onClose, onCreated }: {
  orgId: string;
  userId: string;
  userName?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [patternsRaw, setPatternsRaw] = useState("");
  const [sample, setSample] = useState("");
  const [visibility, setVisibility] = useState<LinkRuleVisibility>("org");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patterns = useMemo(
    () => patternsRaw.split("\n").map((p) => p.trim()).filter(Boolean),
    [patternsRaw],
  );
  const test = useMemo(
    () => (patterns.length > 0 ? testSkillPatterns(patterns, sample) : { matches: [], errors: [] }),
    [patterns, sample],
  );

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await createLinkRule({ orgId, name, description, patterns, visibility, userId, userName });
      onCreated();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)]">
          <Sparkles className="w-4 h-4 text-violet-600" />
          <div className="flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">New connection skill</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              Describe an identifier your facility&apos;s documents use to reference each other. When the
              text of one document matches it and another document OWNS that number, they connect.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Work order references"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm" />
          </div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">What it finds (optional)</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Documents that call out a work order number connect to that work order's record."
              className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm" />
          </div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
              Patterns — one per line (regular expressions)
            </label>
            <textarea value={patternsRaw} onChange={(e) => setPatternsRaw(e.target.value)}
              placeholder={"\\bWO-\\d{5}\\b\n\\bPERMIT-\\d{4}\\b"}
              rows={3}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm font-mono" />
            {test.errors.length > 0 && (
              <div className="mt-1 text-[11px] text-rose-600">{test.errors[0]}</div>
            )}
          </div>

          {/* The proof: run it before you trust it. */}
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 p-3">
            <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">
              <FlaskConical className="w-3.5 h-3.5 text-violet-600" /> Try it on real text
            </div>
            <textarea value={sample} onChange={(e) => setSample(e.target.value)}
              placeholder="Paste a paragraph from one of your documents…"
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm" />
            {sample && patterns.length > 0 && (
              <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                {test.matches.length === 0 ? (
                  <span className="text-[11px] text-amber-700">No matches in this sample.</span>
                ) : test.matches.map((m) => (
                  <span key={m} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-100 dark:bg-emerald-950/50 text-[11px] font-mono font-bold text-emerald-800 dark:text-emerald-300">
                    <CheckCircle2 className="w-3 h-3" /> {m}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Sharing</label>
            <div className="mt-1 flex items-center gap-2">
              <button type="button" onClick={() => setVisibility("org")}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-[11px] font-black ${visibility === "org"
                  ? "border-violet-400 text-violet-700 bg-violet-50 dark:bg-violet-950/40"
                  : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`}>
                <Users className="w-3.5 h-3.5" /> Share org-wide
              </button>
              <button type="button" onClick={() => setVisibility("private")}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-[11px] font-black ${visibility === "private"
                  ? "border-violet-400 text-violet-700 bg-violet-50 dark:bg-violet-950/40"
                  : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`}>
                <Lock className="w-3.5 h-3.5" /> Just me
              </button>
            </div>
            <p className="mt-1 text-[10px] text-[var(--color-text-faint)]">
              Either way its findings only ever QUEUE for review — custom skills never apply links by themselves.
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-2.5 py-2 text-[11px] text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              Cancel
            </button>
            <button onClick={() => void save()}
              disabled={saving || !name.trim() || patterns.length === 0 || test.errors.length > 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-black text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Create skill
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
