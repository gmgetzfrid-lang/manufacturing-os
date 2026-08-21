"use client";

// QualityTab — PSSR / MI / QA-QC checklists, the turnover package, and the
// punch list. The promise on the wall: "the checklist tells the system
// what's needed; the system tells you what's missing."
//
//   Checklists: point at the checklist document → the AI segments it into
//   items (YOU review before anything saves) → the AI proposes what applies
//   to THIS job, grounded on the project's purpose/SOW/schedule (you apply)
//   → the deterministic evidence sweep greens items the platform can PROVE
//   (accepted turnover, MI complete, documents on file) with the citation
//   attached, and marks the rest needs_evidence — which feeds the coach.
//   A human override always wins and is never touched again.
//
//   Turnover: the quality-package contents this job requires, seeded by job
//   size, each tracked open → received → accepted/rejected/waived with the
//   reviewer's name on the record. Acceptance rates score the contractor.
//
//   Punch list: the closeout snag list, visible until it's empty.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardCheck, FileText, Loader2, Sparkles, Search, X, Plus, Check,
  ChevronDown, ChevronRight, AlertTriangle, ShieldCheck, PackageCheck,
  ListChecks, Ban, Wand2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Actor } from "@/lib/costs";
import {
  type Checklist, type ChecklistItem, type ChecklistKind, CHECKLIST_KIND_LABEL,
  listChecklists, listChecklistItems, createChecklist, applyAssessment,
  updateChecklistItem, setChecklistStatus, runAutoEvidence, computeChecklistProgress,
} from "@/lib/checklists";
import {
  type TurnoverItem, type PunchItem, TURNOVER_STATUS_LABEL,
  listTurnoverItems, seedTurnoverItems, addTurnoverItem, reviewTurnoverItem,
  listPunchItems, addPunchItem, setPunchStatus, computeTurnoverProgress,
} from "@/lib/turnover";
import type { SegmentedItem } from "@/lib/checklistEngine";
import { appConfirm, appPrompt } from "@/components/providers/DialogProvider";

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

export default function QualityTab({ orgId, projectId, canManage, uid, userEmail, jobKind }: {
  orgId: string; projectId: string; canManage: boolean;
  uid: string; userEmail?: string | null;
  jobKind: string | null;
}) {
  const actor: Actor = useMemo(() => ({ uid, email: userEmail ?? null }), [uid, userEmail]);
  const [err, setErr] = useState<string | null>(null);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [turnover, setTurnover] = useState<TurnoverItem[]>([]);
  const [punch, setPunch] = useState<PunchItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [cl, to, pu] = await Promise.all([
        listChecklists(orgId, projectId),
        listTurnoverItems(orgId, projectId),
        listPunchItems(orgId, projectId),
      ]);
      setChecklists(cl); setTurnover(to); setPunch(pu);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setLoading(false); }
  }, [orgId, projectId]);
  useEffect(() => { void refresh(); }, [refresh]);

  if (loading) return <div className="py-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>;

  return (
    <div className="space-y-4">
      {err && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/50 bg-rose-500/[0.08] px-3 py-2.5 text-xs font-bold text-rose-700 dark:text-rose-300">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {err}
          <button onClick={() => setErr(null)} className="ml-auto text-rose-400 hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      <ChecklistsSection orgId={orgId} projectId={projectId} canManage={canManage} actor={actor}
        checklists={checklists} onChanged={() => void refresh()} setErr={setErr} />
      <TurnoverSection orgId={orgId} projectId={projectId} canManage={canManage} actor={actor}
        items={turnover} jobKind={jobKind} onChanged={() => void refresh()} setErr={setErr} />
      <PunchSection orgId={orgId} projectId={projectId} canManage={canManage} actor={actor}
        items={punch} onChanged={() => void refresh()} setErr={setErr} />
    </div>
  );
}

// ── Checklists ───────────────────────────────────────────────────────────

function ChecklistsSection({ orgId, projectId, canManage, actor, checklists, onChanged, setErr }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  checklists: Checklist[]; onChanged: () => void; setErr: (m: string | null) => void;
}) {
  const [showNew, setShowNew] = useState(false);
  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <ClipboardCheck className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Checklists — PSSR, MI, QA/QC</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">The system reads them, works out what applies, and tracks the gaps.</span>
        {canManage && (
          <button onClick={() => setShowNew((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] transition-colors">
            <Plus className="w-3 h-3" /> New from document
          </button>
        )}
      </div>

      {showNew && canManage && (
        <NewChecklistFlow orgId={orgId} projectId={projectId} actor={actor}
          onDone={() => { setShowNew(false); onChanged(); }} onCancel={() => setShowNew(false)} setErr={setErr} />
      )}

      {checklists.filter((c) => c.status !== "void").length === 0 ? (
        <div className="px-4 py-8 text-center">
          <ClipboardCheck className="w-7 h-7 mx-auto text-[var(--color-text-faint)] mb-2" />
          <div className="text-sm font-bold text-[var(--color-text)]">No checklists yet</div>
          <div className="text-xs text-[var(--color-text-muted)] mt-1 max-w-lg mx-auto">
            Upload your PSSR or QA/QC checklist to document control, then point at it here — the AI
            splits it into items, judges what applies to this job, and finds the evidence you already have.
          </div>
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {checklists.filter((c) => c.status !== "void").map((c) => (
            <ChecklistCard key={c.id} orgId={orgId} projectId={projectId} checklist={c}
              canManage={canManage} actor={actor} onChanged={onChanged} setErr={setErr} />
          ))}
        </div>
      )}
    </div>
  );
}

function NewChecklistFlow({ orgId, projectId, actor, onDone, onCancel, setErr }: {
  orgId: string; projectId: string; actor: Actor;
  onDone: () => void; onCancel: () => void; setErr: (m: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; label: string }>>([]);
  const [doc, setDoc] = useState<{ id: string; label: string } | null>(null);
  const [kind, setKind] = useState<ChecklistKind>("pssr");
  const [reading, setReading] = useState(false);
  const [proposed, setProposed] = useState<SegmentedItem[] | null>(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || doc) { setResults([]); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from("documents").select("id, document_number, title, name")
        .eq("org_id", orgId)
        .or(`document_number.ilike.%${q}%,title.ilike.%${q}%,name.ilike.%${q}%`)
        .limit(8);
      setResults((((data ?? []) as Array<Record<string, unknown>>)).map((d) => ({
        id: String(d.id), label: String(d.document_number || d.title || d.name || "Document"),
      })));
    }, 250);
    return () => clearTimeout(t);
  }, [query, orgId, doc]);

  const read = async () => {
    if (!doc) return;
    setReading(true); setErr(null);
    try {
      const res = await fetch("/api/projects/checklist", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ orgId, projectId, action: "segment", documentId: doc.id }),
      });
      const body = (await res.json().catch(() => null)) as { items?: SegmentedItem[]; sourceLabel?: string; error?: string } | null;
      if (!res.ok || !body?.items) throw new Error(body?.error || `HTTP ${res.status}`);
      setProposed(body.items);
      setTitle(body.sourceLabel ?? doc.label);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setReading(false); }
  };

  const save = async () => {
    if (!proposed || !doc) return;
    setSaving(true); setErr(null);
    const res = await createChecklist({
      orgId, projectId, title: title || doc.label, kind,
      sourceDocumentId: doc.id,
      items: proposed.map((p, i) => ({ ...p, seq: i + 1 })),
      actor,
    });
    setSaving(false);
    if (!res.ok) { setErr(res.error ?? "Couldn't save."); return; }
    onDone();
  };

  return (
    <div className="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-accent-soft)]/30 space-y-2">
      {!proposed ? (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            {doc ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs font-bold text-[var(--color-text)]">
                <FileText className="w-3.5 h-3.5 text-[var(--color-accent)]" /> {doc.label}
                <button onClick={() => setDoc(null)} className="text-[var(--color-text-faint)] hover:text-rose-600"><X className="w-3 h-3" /></button>
              </span>
            ) : (
              <span className="relative flex-1 min-w-64">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-faint)]" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
                  placeholder="Find the checklist document (by number or title)…"
                  className="w-full h-8 pl-8 pr-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-xs" />
              </span>
            )}
            <select value={kind} onChange={(e) => setKind(e.target.value as ChecklistKind)}
              className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
              {(Object.keys(CHECKLIST_KIND_LABEL) as ChecklistKind[]).map((k) => (
                <option key={k} value={k}>{CHECKLIST_KIND_LABEL[k]}</option>
              ))}
            </select>
            <button onClick={() => void read()} disabled={!doc || reading}
              className="h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors"
              title="AI reads the printed pages and splits them into checkable items — you review before anything saves.">
              {reading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} Read it
            </button>
            <button onClick={onCancel} className="text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
          </div>
          {results.length > 0 && !doc && (
            <ul className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] overflow-hidden">
              {results.map((d) => (
                <li key={d.id}>
                  <button onClick={() => setDoc(d)} className="w-full px-3 py-1.5 text-left text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> {d.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <input value={title} onChange={(e) => setTitle(e.target.value)}
              className="h-8 flex-1 min-w-48 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs font-bold" />
            <span className="text-[11px] text-[var(--color-text-muted)]">{proposed.length} items read — remove any that aren&apos;t real items, then save.</span>
            <button onClick={() => void save()} disabled={saving || proposed.length === 0}
              className="h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save checklist
            </button>
            <button onClick={() => setProposed(null)} className="text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Back</button>
          </div>
          <ul className="max-h-72 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)]">
            {proposed.map((p, i) => (
              <li key={i} className="px-3 py-1.5 flex items-start gap-2 text-xs">
                {p.section && <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-faint)] mt-0.5">{p.section}</span>}
                <span className="flex-1 text-[var(--color-text)]">{p.text}</span>
                <button onClick={() => setProposed(proposed.filter((_, j) => j !== i))}
                  className="shrink-0 text-[var(--color-text-faint)] hover:text-rose-600"><X className="w-3 h-3" /></button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ChecklistCard({ orgId, projectId, checklist, canManage, actor, onChanged, setErr }: {
  orgId: string; projectId: string; checklist: Checklist;
  canManage: boolean; actor: Actor;
  onChanged: () => void; setErr: (m: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    setItems(await listChecklistItems(checklist.id));
  }, [checklist.id]);
  useEffect(() => { if (open && items == null) void loadItems(); }, [open, items, loadItems]);

  const progress = useMemo(() => (items ? computeChecklistProgress(items) : null), [items]);

  const assess = async () => {
    setBusy("assess"); setErr(null);
    try {
      const res = await fetch("/api/projects/checklist", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ orgId, projectId, action: "assess", checklistId: checklist.id }),
      });
      const body = (await res.json().catch(() => null)) as {
        proposals?: Array<{ itemId: string; applicability: "applies" | "na" | "unknown"; rationale: string }>;
        error?: string;
      } | null;
      if (!res.ok || !body?.proposals) throw new Error(body?.error || `HTTP ${res.status}`);
      const na = body.proposals.filter((p) => p.applicability === "na").length;
      if (!(await appConfirm({
        message: `The assessment proposes applicability for ${body.proposals.length} items (${na} look not-applicable to this job, with reasons attached). Apply it? Items you've decided by hand are never touched.`,
      }))) return;
      const applied = await applyAssessment({ orgId, projectId, checklistId: checklist.id, proposals: body.proposals, actor });
      setErr(null);
      await loadItems(); onChanged();
      if (applied.skippedHuman > 0) {
        setErr(`Applied ${applied.applied}; left ${applied.skippedHuman} alone because a human already decided them.`);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  const sweep = async () => {
    setBusy("sweep"); setErr(null);
    try {
      const res = await runAutoEvidence({ orgId, projectId, checklistId: checklist.id, actor });
      await loadItems(); onChanged();
      setErr(null);
      if (res.satisfied + res.needsEvidence === 0) {
        setErr("Evidence sweep: nothing new to prove or demand — items are either done, human-decided, or not evidence-shaped.");
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  const complete = async () => {
    setBusy("complete");
    const res = await setChecklistStatus({ orgId, projectId, checklist, status: "complete", actor });
    setBusy(null);
    if (!res.ok) { setErr(res.error ?? "Couldn't complete."); return; }
    onChanged();
  };

  // Group items by section for rendering.
  const sections = useMemo(() => {
    const by = new Map<string, ChecklistItem[]>();
    for (const it of items ?? []) {
      const key = it.section ?? "";
      by.set(key, [...(by.get(key) ?? []), it]);
    }
    return [...by.entries()];
  }, [items]);

  return (
    <div>
      <button onClick={() => setOpen((v) => !v)} className="w-full px-4 py-3 flex items-center gap-2 text-left hover:bg-[var(--color-surface-2)]/40 transition-colors">
        {open ? <ChevronDown className="w-4 h-4 text-[var(--color-text-faint)]" /> : <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)]" />}
        <span className="text-xs font-black text-[var(--color-text)]">{checklist.title}</span>
        <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{CHECKLIST_KIND_LABEL[checklist.kind]}</span>
        {checklist.status === "complete" && (
          <span className="inline-flex items-center gap-0.5 text-[9px] font-black uppercase text-emerald-700 dark:text-emerald-300"><ShieldCheck className="w-3 h-3" /> complete</span>
        )}
        {progress && checklist.status === "open" && (
          <span className="ml-auto text-[10px] font-bold tabular-nums text-[var(--color-text-muted)]">
            {progress.satisfied}/{progress.applicable} satisfied{progress.needsEvidence > 0 ? ` · ${progress.needsEvidence} need evidence` : ""}
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-2">
          {canManage && checklist.status === "open" && (
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => void assess()} disabled={busy != null}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors"
                title="AI judges which items apply to THIS job, grounded on the project's purpose, SOW, schedule, and documents. You review before it applies.">
                {busy === "assess" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />} Which items apply to this job?
              </button>
              <button onClick={() => void sweep()} disabled={busy != null}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors"
                title="Deterministic — no AI. Greens items the platform can PROVE (accepted turnover, documents on file), citation attached; flags the rest needs-evidence.">
                {busy === "sweep" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ListChecks className="w-3 h-3" />} Check evidence we already hold
              </button>
              <button onClick={() => void complete()} disabled={busy != null}
                className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-[11px] font-black hover:bg-emerald-700 disabled:opacity-50 transition-colors">
                {busy === "complete" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />} Mark complete
              </button>
            </div>
          )}

          {items == null ? (
            <div className="py-4 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-[var(--color-accent)]" /></div>
          ) : (
            <div className="rounded-xl border border-[var(--color-border)] overflow-hidden">
              {sections.map(([section, secItems]) => (
                <div key={section || "_"}>
                  {section && (
                    <div className="px-3 py-1.5 bg-[var(--color-surface-2)]/60 text-[9px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">
                      {section}
                    </div>
                  )}
                  <ul className="divide-y divide-[var(--color-border)]">
                    {secItems.map((it) => (
                      <ChecklistItemRow key={it.id} orgId={orgId} projectId={projectId} item={it}
                        canManage={canManage && checklist.status === "open"} actor={actor}
                        onChanged={() => { void loadItems(); onChanged(); }} setErr={setErr} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChecklistItemRow({ orgId, projectId, item, canManage, actor, onChanged, setErr }: {
  orgId: string; projectId: string; item: ChecklistItem;
  canManage: boolean; actor: Actor;
  onChanged: () => void; setErr: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const na = item.applicability === "na" || item.status === "na";

  const override = async (patch: Parameters<typeof updateChecklistItem>[0]["patch"], promptNote: string | null) => {
    let manualNote: string | null | undefined = undefined;
    if (promptNote) {
      const v = await appPrompt({ title: promptNote, message: "Your note marks this item human-decided — automation keeps its hands off from then on.", placeholder: "Why?" });
      if (v === null) return;
      manualNote = v.trim() || "decided by reviewer";
    }
    setBusy(true);
    const res = await updateChecklistItem({ orgId, projectId, item, patch: { ...patch, ...(manualNote !== undefined ? { manualNote } : {}) }, actor });
    setBusy(false);
    if (!res.ok) setErr(res.error ?? "Couldn't update."); else onChanged();
  };

  return (
    <li className={`px-3 py-2 text-xs ${na ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-2">
        <StatusDot status={na ? "na" : item.status} />
        <div className="min-w-0 flex-1">
          <div className="text-[var(--color-text)]">{item.text}</div>
          {item.aiRationale && (
            <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
              <span className="font-bold">Assessment:</span> {item.aiRationale}
            </div>
          )}
          {item.manualNote && (
            <div className="mt-0.5 text-[10px] font-bold text-[var(--color-accent)]">
              Human decision{item.updatedByName ? ` (${item.updatedByName})` : ""}: {item.manualNote}
            </div>
          )}
          {item.evidence.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {item.evidence.map((e, i) => (
                <span key={i} className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${e.source === "auto" ? "border-emerald-500/40 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300" : "border-sky-500/40 bg-sky-500/[0.07] text-sky-700 dark:text-sky-300"}`}
                  title={e.source === "auto" ? "Found by the evidence sweep" : "Attached by a person"}>
                  {e.label}
                </span>
              ))}
            </div>
          )}
        </div>
        {canManage && !busy && (
          <span className="shrink-0 flex items-center gap-1">
            {!na && item.status !== "satisfied" && (
              <button onClick={() => void override({ status: "satisfied" }, "Mark satisfied")}
                className="px-1.5 py-0.5 rounded text-[10px] font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10" title="Mark satisfied with your note on the record">✓ Satisfied</button>
            )}
            {!na && (
              <button onClick={() => void override({ applicability: "na", status: "na" }, "Mark not applicable")}
                className="px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]" title="Not applicable to this job — your reason goes on the record">N/A</button>
            )}
            {na && (
              <button onClick={() => void override({ applicability: "applies", status: "open" }, "Reopen this item")}
                className="px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">Reopen</button>
            )}
          </span>
        )}
        {busy && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-accent)] shrink-0" />}
      </div>
    </li>
  );
}

function StatusDot({ status }: { status: ChecklistItem["status"] }) {
  const map: Record<string, { c: string; t: string }> = {
    satisfied: { c: "bg-emerald-500", t: "Satisfied — evidence attached" },
    needs_evidence: { c: "bg-amber-500", t: "Needs evidence — the system holds no proof yet" },
    open: { c: "bg-[var(--color-text-faint)]", t: "Open — not assessed against evidence" },
    na: { c: "bg-[var(--color-border-strong)]", t: "Not applicable to this job" },
  };
  const m = map[status] ?? map.open;
  return <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${m.c}`} title={m.t} />;
}

// ── Turnover package ─────────────────────────────────────────────────────

function TurnoverSection({ orgId, projectId, canManage, actor, items, jobKind, onChanged, setErr }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  items: TurnoverItem[]; jobKind: string | null;
  onChanged: () => void; setErr: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  const progress = useMemo(() => computeTurnoverProgress(items), [items]);

  const seed = async () => {
    setBusy("seed");
    const res = await seedTurnoverItems({ orgId, projectId, jobKind, actor });
    setBusy(null);
    if (!res.ok) { setErr(res.error ?? "Couldn't seed."); return; }
    onChanged();
  };

  const review = async (item: TurnoverItem, status: TurnoverItem["status"]) => {
    let note: string | null = null;
    if (status === "rejected" || status === "waived") {
      note = await appPrompt({
        title: status === "rejected" ? `Reject "${item.name}"` : `Waive "${item.name}"`,
        message: status === "rejected"
          ? "Why is it not acceptable? The contractor sees this reason and it lands on their record."
          : "Why is this not required for this job? Waivers go on the record.",
        placeholder: "Reason",
      });
      if (note === null) return;
    }
    setBusy(item.id);
    const res = await reviewTurnoverItem({ item, status, note, actor });
    setBusy(null);
    if (!res.ok) setErr(res.error ?? "Couldn't update."); else onChanged();
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <PackageCheck className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Turnover package — QA/QC sign-off</span>
        {progress.required > 0 && (
          <span className="text-[10px] font-bold tabular-nums text-[var(--color-text-muted)]">
            {progress.accepted}/{progress.required} accepted{progress.received > 0 ? ` · ${progress.received} awaiting review` : ""}
          </span>
        )}
        {canManage && (
          <button onClick={() => void seed()} disabled={busy != null}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors"
            title={`Adds the required contents for a ${jobKind ?? "standard"} job (existing items are kept).`}>
            {busy === "seed" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Seed required contents
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
          Nothing required yet. Seed the standard contents for this job size, or add items by hand —
          then track what the contractor has actually delivered and whether QA/QC accepted it.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {items.map((it) => (
            <li key={it.id} className="px-4 py-2.5 text-xs">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-[var(--color-text)]">{it.name}</span>
                {!it.required && <span className="text-[9px] font-bold text-[var(--color-text-faint)]">optional</span>}
                <TurnoverChip status={it.status} />
                {canManage && busy !== it.id && (
                  <span className="ml-auto flex items-center gap-1">
                    {it.status === "open" && (
                      <button onClick={() => void review(it, "received")} className="px-1.5 py-0.5 rounded text-[10px] font-bold text-sky-700 dark:text-sky-300 hover:bg-sky-500/10">Received</button>
                    )}
                    {(it.status === "received" || it.status === "rejected") && (
                      <button onClick={() => void review(it, "accepted")} className="px-1.5 py-0.5 rounded text-[10px] font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10">Accept</button>
                    )}
                    {it.status === "received" && (
                      <button onClick={() => void review(it, "rejected")} className="px-1.5 py-0.5 rounded text-[10px] font-bold text-rose-700 dark:text-rose-300 hover:bg-rose-500/10">Reject</button>
                    )}
                    {(it.status === "open" || it.status === "received") && (
                      <button onClick={() => void review(it, "waived")} className="px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">Waive</button>
                    )}
                  </span>
                )}
                {busy === it.id && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-accent)] ml-auto" />}
              </div>
              <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                {[
                  it.description,
                  it.reviewedByName ? `${it.status} by ${it.reviewedByName}${it.reviewedAt ? ` on ${new Date(it.reviewedAt).toLocaleDateString()}` : ""}` : null,
                  it.reviewNote ? `“${it.reviewNote}”` : null,
                ].filter(Boolean).join(" · ")}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="px-4 py-2.5 border-t border-[var(--color-border)] flex items-center gap-2">
          <input value={addName} onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && addName.trim()) { void (async () => { const r = await addTurnoverItem({ orgId, projectId, name: addName, actor }); if (!r.ok) setErr(r.error ?? null); else { setAddName(""); onChanged(); } })(); } }}
            placeholder="Add a required item — e.g. Torque records"
            className="h-8 flex-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          <button onClick={() => { if (addName.trim()) void (async () => { const r = await addTurnoverItem({ orgId, projectId, name: addName, actor }); if (!r.ok) setErr(r.error ?? null); else { setAddName(""); onChanged(); } })(); }}
            className="h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)]">
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
      )}
    </div>
  );
}

function TurnoverChip({ status }: { status: TurnoverItem["status"] }) {
  const tone = status === "accepted" ? "border-emerald-500/40 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300"
    : status === "received" ? "border-sky-500/40 bg-sky-500/[0.07] text-sky-700 dark:text-sky-300"
    : status === "rejected" ? "border-rose-500/40 bg-rose-500/[0.07] text-rose-700 dark:text-rose-300"
    : status === "waived" ? "border-[var(--color-border)] text-[var(--color-text-faint)]"
    : "border-amber-500/40 bg-amber-500/[0.07] text-amber-700 dark:text-amber-300";
  return (
    <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${tone}`}>
      {TURNOVER_STATUS_LABEL[status]}
    </span>
  );
}

// ── Punch list ───────────────────────────────────────────────────────────

function PunchSection({ orgId, projectId, canManage, actor, items, onChanged, setErr }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  items: PunchItem[]; onChanged: () => void; setErr: (m: string | null) => void;
}) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const open = items.filter((i) => i.status === "open");
  const closed = items.filter((i) => i.status !== "open");
  // Captured once at mount — render stays pure.
  const [now] = useState(() => Date.now());

  const add = async () => {
    if (!title.trim()) return;
    setBusy("add");
    const res = await addPunchItem({ orgId, projectId, title, dueDate: due || null, actor });
    setBusy(null);
    if (!res.ok) { setErr(res.error ?? "Couldn't add."); return; }
    setTitle(""); setDue(""); onChanged();
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <ListChecks className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Punch list</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">The closeout snag list — visible until it&apos;s empty.</span>
        {open.length > 0 && (
          <span className="ml-auto text-[10px] font-black px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/40">{open.length} open</span>
        )}
      </div>

      {canManage && (
        <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            placeholder="e.g. Reinstall insulation at E-301 north nozzle"
            className="h-8 flex-1 min-w-56 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)}
            className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs [color-scheme:light] dark:[color-scheme:dark]" />
          <button onClick={() => void add()} disabled={busy === "add"}
            className="h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy === "add" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Add
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="px-4 py-5 text-center text-xs text-[var(--color-text-muted)]">Nothing on the punch list.</div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {[...open, ...closed].map((it) => {
            const overdue = it.status === "open" && it.dueDate && Date.parse(it.dueDate) < now;
            return (
              <li key={it.id} className={`px-4 py-2 flex items-center gap-2 text-xs ${it.status !== "open" ? "opacity-55" : ""}`}>
                <span className={`w-2 h-2 rounded-full shrink-0 ${it.status === "done" ? "bg-emerald-500" : it.status === "void" ? "bg-[var(--color-border-strong)]" : overdue ? "bg-rose-500" : "bg-amber-500"}`} />
                <span className={`text-[var(--color-text)] ${it.status !== "open" ? "line-through" : ""}`}>{it.title}</span>
                {it.dueDate && it.status === "open" && (
                  <span className={`text-[10px] font-bold ${overdue ? "text-rose-600 dark:text-rose-400" : "text-[var(--color-text-muted)]"}`}>
                    due {new Date(it.dueDate + "T00:00:00").toLocaleDateString()}{overdue ? " — overdue" : ""}
                  </span>
                )}
                {it.createdByName && <span className="text-[10px] text-[var(--color-text-faint)]">by {it.createdByName}</span>}
                {canManage && it.status === "open" && busy !== it.id && (
                  <span className="ml-auto flex items-center gap-1">
                    <button onClick={async () => { setBusy(it.id); const r = await setPunchStatus({ item: it, status: "done", actor }); setBusy(null); if (!r.ok) setErr(r.error ?? null); else onChanged(); }}
                      className="px-1.5 py-0.5 rounded text-[10px] font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10">Done</button>
                    <button onClick={async () => { setBusy(it.id); const r = await setPunchStatus({ item: it, status: "void", actor }); setBusy(null); if (!r.ok) setErr(r.error ?? null); else onChanged(); }}
                      className="px-1 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-faint)] hover:text-rose-600 hover:bg-rose-500/10" title="Void — not a real snag"><Ban className="w-3 h-3" /></button>
                  </span>
                )}
                {busy === it.id && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-accent)] ml-auto" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
