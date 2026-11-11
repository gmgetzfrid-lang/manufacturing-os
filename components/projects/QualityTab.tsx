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
//
// Nothing is final by accident: a completed checklist reopens and one added
// by mistake can be removed (Undo right after), a satisfied item can be
// taken back, an accepted or waived turnover item reopens, and a punch item
// can be edited, reopened, or voided (with a confirm and an Undo).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ClipboardCheck, FileText, Loader2, Sparkles, Search, X, Plus, Check,
  ChevronDown, ChevronRight, AlertTriangle, ShieldCheck, PackageCheck,
  ListChecks, Ban, Wand2, Pencil, RotateCcw, Paperclip, Trash2, UploadCloud,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { listParties, type Actor, type CostParty } from "@/lib/costs";
import {
  type Checklist, type ChecklistItem, type ChecklistKind, CHECKLIST_KIND_LABEL,
  listChecklists, listChecklistItems, createChecklist, applyAssessment,
  updateChecklistItem, setChecklistStatus, runAutoEvidence, computeChecklistProgress,
} from "@/lib/checklists";
import {
  type TurnoverItem, type PunchItem, TURNOVER_STATUS_LABEL,
  listTurnoverItems, seedTurnoverItems, addTurnoverItem, reviewTurnoverItem,
  listPunchItems, addPunchItem, setPunchStatus, computeTurnoverProgress,
  reopenTurnoverItem, updateTurnoverItem, attachTurnoverDocument, updatePunchItem,
} from "@/lib/turnover";
import type { SegmentedItem } from "@/lib/checklistEngine";
import { appConfirm, appPrompt } from "@/components/providers/DialogProvider";
import { uploadProjectFile } from "@/lib/projectUpload";
import ProjectFilePlace, { useProjectFileHome } from "@/components/projects/ProjectFilePlace";
import UndoToastHost from "@/components/projects/UndoToastHost";
import { useUndoableActions } from "@/components/projects/useUndoableActions";

type Announce = (message: string, undo: () => void | Promise<void>) => void;

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

export default function QualityTab({ orgId, projectId, canManage, canEditPunch, uid, userEmail, jobKind, onDataChanged }: {
  orgId: string; projectId: string; canManage: boolean;
  /** May write the punch list (owner, co-owner, editor, or an org role that
   *  works schedules). Unset: the same as canManage. */
  canEditPunch?: boolean;
  uid: string; userEmail?: string | null;
  jobKind: string | null;
  /** Fires after each data reload so the page's coach/health re-gathers. */
  onDataChanged?: () => void;
}) {
  const actor: Actor = useMemo(() => ({ uid, email: userEmail ?? null }), [uid, userEmail]);
  const [err, setErr] = useState<string | null>(null);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [turnover, setTurnover] = useState<TurnoverItem[]>([]);
  const [punch, setPunch] = useState<PunchItem[]>([]);
  // The project's companies (a punch item's contractor, who owes a turnover
  // item) and its people (who's on a punch item).
  const [parties, setParties] = useState<CostParty[]>([]);
  const [people, setPeople] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // Undo, right after a removal (a checklist, a voided punch item).
  const { toasts, announce, dismiss, runUndo } = useUndoableActions();

  const refresh = useCallback(async () => {
    try {
      const [cl, to, pu, pa, { data: mem }] = await Promise.all([
        listChecklists(orgId, projectId),
        listTurnoverItems(orgId, projectId),
        listPunchItems(orgId, projectId),
        listParties(orgId, projectId).catch(() => [] as CostParty[]),
        supabase.from("project_members").select("user_name, user_email").eq("project_id", projectId),
      ]);
      setChecklists(cl); setTurnover(to); setPunch(pu); setParties(pa);
      setPeople([...new Set(((mem ?? []) as Array<{ user_name: string | null; user_email: string | null }>)
        .map((m) => (m.user_name && !m.user_name.includes("@") ? m.user_name : m.user_email?.split("@")[0] ?? ""))
        .filter(Boolean))]);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setLoading(false); }
    onDataChanged?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        checklists={checklists} onChanged={() => void refresh()} setErr={setErr} announce={announce} />
      <TurnoverSection orgId={orgId} projectId={projectId} canManage={canManage} actor={actor}
        items={turnover} jobKind={jobKind} parties={parties} onChanged={() => void refresh()} setErr={setErr} />
      <PunchSection orgId={orgId} projectId={projectId} canManage={canEditPunch ?? canManage} actor={actor}
        items={punch} parties={parties} people={people} onChanged={() => void refresh()} setErr={setErr} announce={announce} />
      <UndoToastHost toasts={toasts} onUndo={(t) => void runUndo(t)} onDismiss={dismiss} />
    </div>
  );
}

const quietBtn = "inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50";
const fieldCls = "h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs";

// ── Checklists ───────────────────────────────────────────────────────────

function ChecklistsSection({ orgId, projectId, canManage, actor, checklists, onChanged, setErr, announce }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  checklists: Checklist[]; onChanged: () => void; setErr: (m: string | null) => void;
  announce: Announce;
}) {
  const [showNew, setShowNew] = useState(false);
  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <ClipboardCheck className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Checklists - PSSR, MI, QA/QC</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">The system reads them, works out what applies, and tracks the gaps.</span>
        {canManage && (
          <button onClick={() => setShowNew((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] transition-colors">
            <Plus className="w-3 h-3" /> New checklist
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
            Click New checklist and upload your PSSR or QA/QC checklist (PDF) right there - the AI
            splits it into items, judges what applies to this job, and finds the evidence you already have.
          </div>
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {checklists.filter((c) => c.status !== "void").map((c) => (
            <ChecklistCard key={c.id} orgId={orgId} projectId={projectId} checklist={c}
              canManage={canManage} actor={actor} onChanged={onChanged} setErr={setErr} announce={announce} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A new checklist: upload the file right here (it goes into the project's
 *  documents) or find one already in document control; the AI reads it
 *  into items; you check them and save. */
export function NewChecklistFlow({ orgId, projectId, projectName, actor, onDone, onCancel, setErr, kindDefault = "pssr", part }: {
  orgId: string; projectId: string; projectName?: string; actor: Actor;
  onDone: () => void; onCancel: () => void; setErr: (m: string | null) => void;
  kindDefault?: ChecklistKind;
  /** The phase it is for, when there is one: it goes in the file's number. */
  part?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; label: string }>>([]);
  const [doc, setDoc] = useState<{ id: string; label: string } | null>(null);
  const [kind, setKind] = useState<ChecklistKind>(kindDefault);
  // Upload: where the project's files go. Asked the first time, never
  // guessed: nothing uploads until a library and folder are picked.
  const { home, setHome } = useProjectFileHome(orgId, projectId);
  const [uploading, setUploading] = useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const upload = async (file: File | null | undefined) => {
    if (!file) return;
    if (!home?.place) { setErr("Pick where this project's files go first."); return; }
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { setErr("Upload the checklist as a PDF (in Word or Excel: File › Save As › PDF)."); return; }
    setUploading(true); setErr(null);
    try {
      const d = await uploadProjectFile({ orgId, projectId, projectName: projectName ?? home?.name ?? "Project", file, prefix: kind === "pssr" ? "PSSR" : kind === "mi" ? "MI" : kind === "qaqc" ? "QAQC" : "CHECKLIST",
        title: file.name.replace(/\.pdf$/i, ""), part, actorUserId: actor.uid, actorEmail: actor.email });
      const picked = { id: d.documentId, label: d.label };
      setDoc(picked);
      await read(picked);
    } catch (e) { setErr((e as Error).message); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const [reading, setReading] = useState(false);
  const [proposed, setProposed] = useState<SegmentedItem[] | null>(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || doc) { setResults([]); return; }
    // Commas and brackets would break the search filter.
    const safe = q.replace(/[,()%*\\]/g, " ").trim();
    if (safe.length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from("documents").select("id, document_number, title, name")
        .eq("org_id", orgId)
        .or(`document_number.ilike.%${safe}%,title.ilike.%${safe}%,name.ilike.%${safe}%`)
        .limit(8);
      setResults((((data ?? []) as Array<Record<string, unknown>>)).map((d) => ({
        id: String(d.id), label: String(d.document_number || d.title || d.name || "Document"),
      })));
    }, 250);
    return () => clearTimeout(t);
  }, [query, orgId, doc]);

  const read = async (which: { id: string; label: string } | null = doc) => {
    if (!which) return;
    setReading(true); setErr(null);
    try {
      const res = await fetch("/api/projects/checklist", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ orgId, projectId, action: "segment", documentId: which.id }),
      });
      const body = (await res.json().catch(() => null)) as { items?: SegmentedItem[]; sourceLabel?: string; error?: string } | null;
      if (!res.ok || !body?.items) throw new Error(body?.error || `HTTP ${res.status}`);
      setProposed(body.items);
      setTitle(body.sourceLabel ?? which.label);
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
    <div className="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-accent-soft)]/30 space-y-2"
      onDragOver={(e) => { if (!proposed && !doc) e.preventDefault(); }}
      onDrop={(e) => { if (proposed || doc) return; e.preventDefault(); void upload(e.dataTransfer.files?.[0]); }}>
      {!proposed ? (
        <>
          {!doc && (
            <div className="rounded-xl border-2 border-dashed border-[var(--color-accent)]/50 bg-[var(--color-surface)] p-3 flex items-center gap-3 flex-wrap">
              <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading || reading || !home?.place}
                className="h-9 inline-flex items-center gap-1.5 px-3.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[12.5px] font-black disabled:opacity-50">
                {uploading || reading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />} {uploading ? "Uploading…" : reading ? "Reading it…" : `Upload the ${kind === "pssr" ? "PSSR" : "checklist"} (PDF)`}
              </button>
              <span className="text-[12px] text-[var(--color-text-muted)] flex-1 min-w-48">Or drop it here. It&apos;s filed where you pick below, then read into items for you to check.</span>
              <div className="basis-full">
                <ProjectFilePlace orgId={orgId} projectId={projectId} uid={actor.uid} canManage home={home} onChange={setHome} what={kind === "pssr" ? "the PSSR" : "the checklist"} />
              </div>
            </div>
          )}
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
                  placeholder="Or find one already in document control (number or title)…"
                  className="w-full h-8 pl-8 pr-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-xs" />
              </span>
            )}
            <select value={kind} onChange={(e) => setKind(e.target.value as ChecklistKind)}
              className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
              {(Object.keys(CHECKLIST_KIND_LABEL) as ChecklistKind[]).map((k) => (
                <option key={k} value={k}>{CHECKLIST_KIND_LABEL[k]}</option>
              ))}
            </select>
            <button onClick={() => void read()} disabled={!doc || reading || uploading}
              className="h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors"
              title="AI reads the printed pages and splits them into checkable items - you review before anything saves.">
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
            <span className="text-[11px] text-[var(--color-text-muted)]">{proposed.length} items read - remove any that aren&apos;t real items, then save.</span>
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

function ChecklistCard({ orgId, projectId, checklist, canManage, actor, onChanged, setErr, announce }: {
  orgId: string; projectId: string; checklist: Checklist;
  canManage: boolean; actor: Actor;
  onChanged: () => void; setErr: (m: string | null) => void;
  announce: Announce;
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
        setErr("Evidence sweep: nothing new to prove or demand - items are either done, human-decided, or not evidence-shaped.");
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

  // Complete wasn't the end after all: open it again.
  const reopen = async () => {
    setBusy("reopen");
    const res = await setChecklistStatus({ orgId, projectId, checklist, status: "open", actor });
    setBusy(null);
    if (!res.ok) { setErr(res.error ?? "Couldn't reopen."); return; }
    onChanged();
  };

  // The wrong document, or a duplicate: off the list (kept on the record
  // as void), with Undo right after.
  const remove = async () => {
    if (!(await appConfirm({
      title: `Remove "${checklist.title}"?`,
      message: "It leaves the Quality tab and the close-out gates. It's kept on the record (void), and you can undo right after.",
      confirmLabel: "Remove", tone: "danger",
    }))) return;
    const was = checklist.status;
    setBusy("remove");
    const res = await setChecklistStatus({ orgId, projectId, checklist, status: "void", actor });
    setBusy(null);
    if (!res.ok) { setErr(res.error ?? "Couldn't remove it."); return; }
    onChanged();
    announce(`Removed "${checklist.title}".`, async () => {
      const back = await setChecklistStatus({ orgId, projectId, checklist, status: was, actor });
      if (!back.ok) throw new Error(back.error ?? "couldn't put it back");
      onChanged();
    });
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
                title="Deterministic - no AI. Greens items the platform can PROVE (accepted turnover, documents on file), citation attached; flags the rest needs-evidence.">
                {busy === "sweep" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ListChecks className="w-3 h-3" />} Check evidence we already hold
              </button>
              <button onClick={() => void remove()} disabled={busy != null} title="Added by mistake? Take it off the list - kept on the record, Undo right after"
                className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold text-[var(--color-text-muted)] hover:text-rose-600 hover:bg-rose-500/10 disabled:opacity-50 transition-colors">
                {busy === "remove" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} Remove
              </button>
              <button onClick={() => void complete()} disabled={busy != null}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-[11px] font-black hover:bg-emerald-700 disabled:opacity-50 transition-colors">
                {busy === "complete" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />} Mark complete
              </button>
            </div>
          )}
          {canManage && checklist.status === "complete" && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-[var(--color-text-muted)]">Complete - its items are locked. Reopen it to change one.</span>
              <button onClick={() => void remove()} disabled={busy != null}
                className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold text-[var(--color-text-muted)] hover:text-rose-600 hover:bg-rose-500/10 disabled:opacity-50 transition-colors">
                {busy === "remove" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} Remove
              </button>
              <button onClick={() => void reopen()} disabled={busy != null}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">
                {busy === "reopen" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Reopen
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
      const v = await appPrompt({ title: promptNote, message: "Your note marks this item human-decided - automation keeps its hands off from then on.", placeholder: "Why?" });
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
            {!na && item.status === "satisfied" && (
              // One tap back to open. It stays human-decided, so the
              // evidence sweep won't green it again on its own.
              <button onClick={() => void override({ status: "open", manualNote: "Satisfied taken back - not done yet" }, null)}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]" title="Not satisfied after all - back to open">
                <RotateCcw className="w-3 h-3" /> Undo satisfied
              </button>
            )}
            {!na && (
              <button onClick={() => void override({ applicability: "na", status: "na" }, "Mark not applicable")}
                className="px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]" title="Not applicable to this job - your reason goes on the record">N/A</button>
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
    satisfied: { c: "bg-emerald-500", t: "Satisfied - evidence attached" },
    needs_evidence: { c: "bg-amber-500", t: "Needs evidence - the system holds no proof yet" },
    open: { c: "bg-[var(--color-text-faint)]", t: "Open - not assessed against evidence" },
    na: { c: "bg-[var(--color-border-strong)]", t: "Not applicable to this job" },
  };
  const m = map[status] ?? map.open;
  return <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${m.c}`} title={m.t} />;
}

// ── Turnover package ─────────────────────────────────────────────────────

function TurnoverSection({ orgId, projectId, canManage, actor, items, jobKind, parties, onChanged, setErr }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  items: TurnoverItem[]; jobKind: string | null; parties: CostParty[];
  onChanged: () => void; setErr: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  const progress = useMemo(() => computeTurnoverProgress(items), [items]);
  // A row being edited, and one whose document is being picked.
  const [editing, setEditing] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
  // The attached documents' names and where they open.
  const [docs, setDocs] = useState<Map<string, { label: string; href: string }>>(new Map());
  const docKey = useMemo(() => [...new Set(items.map((i) => i.documentId).filter((x): x is string => !!x))].sort().join(","), [items]);
  useEffect(() => {
    if (!docKey) return;
    let live = true;
    void supabase.from("documents").select("id, document_number, title, name, library_id").in("id", docKey.split(","))
      .then(({ data }) => {
        if (!live) return;
        setDocs(new Map((((data ?? []) as Array<Record<string, unknown>>)).map((d) => [String(d.id), {
          label: String(d.document_number || d.title || d.name || "Document"),
          href: `/documents/${String(d.library_id ?? "")}?doc=${String(d.id)}`,
        }])));
      });
    return () => { live = false; };
  }, [docKey]);
  const partyName = useMemo(() => new Map(parties.map((p) => [p.id, p.name])), [parties]);

  // Accepted or waived by mistake: back into the review.
  const reopen = async (item: TurnoverItem) => {
    if (!(await appConfirm({
      title: `Reopen "${item.name}"?`,
      message: `It goes back to ${item.status === "waived" && !item.documentId ? "not received" : "awaiting review"}. The ${item.status} decision stays in its note and on the record.`,
      confirmLabel: "Reopen",
    }))) return;
    setBusy(item.id);
    const res = await reopenTurnoverItem({ item, actor });
    setBusy(null);
    if (!res.ok) setErr(res.error ?? "Couldn't reopen."); else onChanged();
  };

  const attach = async (item: TurnoverItem, doc: { id: string; label: string } | null) => {
    setBusy(item.id);
    const res = await attachTurnoverDocument({ item, documentId: doc?.id ?? null, documentLabel: doc?.label ?? null, actor });
    setBusy(null);
    if (!res.ok) { setErr(res.error ?? "Couldn't attach it."); return; }
    setAttaching(null);
    onChanged();
  };

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
        <span className="text-sm font-bold text-[var(--color-text)]">Turnover package - QA/QC sign-off</span>
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
          Nothing required yet. Seed the standard contents for this job size, or add items by hand -
          then track what the contractor has actually delivered and whether QA/QC accepted it.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {items.map((it) => editing === it.id ? (
            <li key={it.id} className="px-4 py-2.5">
              <TurnoverEditor item={it} parties={parties} actor={actor} setErr={setErr}
                onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />
            </li>
          ) : (
            <li key={it.id} className="px-4 py-2.5 text-xs">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-[var(--color-text)]">{it.name}</span>
                {!it.required && <span className="text-[9px] font-bold text-[var(--color-text-faint)]">optional</span>}
                <TurnoverChip status={it.status} />
                {it.partyId && partyName.get(it.partyId) && <span className="text-[10px] text-[var(--color-text-muted)]">{partyName.get(it.partyId)}</span>}
                {it.documentId && (
                  docs.get(it.documentId)
                    ? <Link href={docs.get(it.documentId)!.href} className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-accent)] hover:underline"><Paperclip className="w-3 h-3" /> {docs.get(it.documentId)!.label}</Link>
                    : <span className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"><Paperclip className="w-3 h-3" /> document attached</span>
                )}
                {canManage && busy !== it.id && (
                  <span className="ml-auto flex items-center gap-1 flex-wrap">
                    {(it.status === "accepted" || it.status === "waived") && (
                      <button onClick={() => void reopen(it)} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]" title="Back into the review - the decision stays on the record">
                        <RotateCcw className="w-3 h-3" /> Reopen
                      </button>
                    )}
                    <button onClick={() => setAttaching(attaching === it.id ? null : it.id)} className={quietBtn} title="The document the contractor submitted for this">
                      <Paperclip className="w-3 h-3" /> {it.documentId ? "Change document" : "Attach document"}
                    </button>
                    <button onClick={() => setEditing(it.id)} className={quietBtn} title="Change the name, what it means, required or not, who owes it">
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
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
              {attaching === it.id && canManage && (
                <DocPicker orgId={orgId} busy={busy === it.id}
                  onPick={(d) => void attach(it, d)}
                  onClear={it.documentId ? () => void attach(it, null) : undefined}
                  onCancel={() => setAttaching(null)} />
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="px-4 py-2.5 border-t border-[var(--color-border)] flex items-center gap-2">
          <input value={addName} onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && addName.trim()) { void (async () => { const r = await addTurnoverItem({ orgId, projectId, name: addName, actor }); if (!r.ok) setErr(r.error ?? null); else { setAddName(""); onChanged(); } })(); } }}
            placeholder="Add a required item - e.g. Torque records"
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

/** One turnover row, changed in place. */
function TurnoverEditor({ item, parties, actor, setErr, onCancel, onSaved }: {
  item: TurnoverItem; parties: CostParty[]; actor: Actor;
  setErr: (m: string | null) => void; onCancel: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description ?? "");
  const [required, setRequired] = useState(item.required);
  const [partyId, setPartyId] = useState(item.partyId ?? "");
  const [saving, setSaving] = useState(false);
  const pick = parties.filter((p) => p.status !== "inactive" || p.id === item.partyId);
  const save = async () => {
    setSaving(true);
    const res = await updateTurnoverItem({ item, patch: { name, description, required, partyId: partyId || null }, actor });
    setSaving(false);
    if (!res.ok) { setErr(res.error ?? "Couldn't save."); return; }
    onSaved();
  };
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" autoFocus className={`${fieldCls} flex-1 min-w-48 font-bold`} />
        {pick.length > 0 && (
          <select value={partyId} onChange={(e) => setPartyId(e.target.value)} aria-label="Who owes it" className={fieldCls}>
            <option value="">Any contractor</option>
            {pick.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <label className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-text)]">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="w-4 h-4" /> Required
        </label>
      </div>
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it is, in plain words" aria-label="What it is" className={`${fieldCls} w-full`} />
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="px-2 py-1.5 text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
        <button onClick={() => void save()} disabled={saving}
          className="h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save
        </button>
      </div>
    </div>
  );
}

/** Find a document in document control by number or title. */
function DocPicker({ orgId, busy, onPick, onClear, onCancel }: {
  orgId: string; busy: boolean;
  onPick: (d: { id: string; label: string }) => void;
  onClear?: () => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; label: string }>>([]);
  useEffect(() => {
    // Characters that are grammar in a PostgREST filter can't come from typing.
    const q = query.trim().replace(/[,().\\%]/g, " ").replace(/\s+/g, " ").trim();
    if (q.length < 2) return;
    let live = true;
    const t = setTimeout(async () => {
      const { data } = await supabase.from("documents").select("id, document_number, title, name")
        .eq("org_id", orgId)
        .or(`document_number.ilike.%${q}%,title.ilike.%${q}%,name.ilike.%${q}%`)
        .limit(8);
      if (live) setResults((((data ?? []) as Array<Record<string, unknown>>)).map((d) => ({
        id: String(d.id), label: String(d.document_number || d.title || d.name || "Document"),
      })));
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [query, orgId]);
  const shown = query.trim().length >= 2 ? results : [];
  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="relative flex-1 min-w-56">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-faint)]" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus placeholder="Find the submitted document (by number or title)…"
            className="w-full h-8 pl-8 pr-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-xs" />
        </span>
        {onClear && <button onClick={onClear} disabled={busy} className={quietBtn}>Take it off</button>}
        <button onClick={onCancel} className={quietBtn}>Cancel</button>
      </div>
      {shown.length > 0 && (
        <ul className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] overflow-hidden">
          {shown.map((d) => (
            <li key={d.id}>
              <button onClick={() => onPick(d)} disabled={busy} className="w-full px-3 py-2 text-left text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2 disabled:opacity-50">
                <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> {d.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="text-[10px] text-[var(--color-text-faint)]">From document control. A submission through the contractor&apos;s link lands there once it&apos;s approved under Intake.</div>
    </div>
  );
}

// ── Punch list ───────────────────────────────────────────────────────────

function PunchSection({ orgId, projectId, canManage, actor, items, parties, people, onChanged, setErr, announce }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  items: PunchItem[]; parties: CostParty[]; people: string[];
  onChanged: () => void; setErr: (m: string | null) => void;
  announce: Announce;
}) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [location, setLocation] = useState("");
  const [partyId, setPartyId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // The item being edited in place.
  const [editing, setEditing] = useState<string | null>(null);
  const open = items.filter((i) => i.status === "open");
  const closed = items.filter((i) => i.status !== "open");
  // Captured once at mount — render stays pure.
  const [now] = useState(() => Date.now());
  const partyName = useMemo(() => new Map(parties.map((p) => [p.id, p.name])), [parties]);
  // Companies taken off the job aren't offered for new items.
  const pickParties = parties.filter((p) => p.status !== "inactive");

  const add = async () => {
    if (!title.trim()) return;
    setBusy("add");
    const res = await addPunchItem({ orgId, projectId, title, dueDate: due || null, location: location || null, partyId: partyId || null, actor });
    setBusy(null);
    if (!res.ok) { setErr(res.error ?? "Couldn't add."); return; }
    setTitle(""); setDue(""); setLocation(""); setPartyId(""); onChanged();
  };

  const setStatus = async (it: PunchItem, status: PunchItem["status"]) => {
    setBusy(it.id);
    const r = await setPunchStatus({ item: it, status, actor });
    setBusy(null);
    if (!r.ok) { setErr(r.error ?? null); return false; }
    onChanged();
    return true;
  };

  // Void: not a real snag. Asked first, and Undo right after.
  const voidItem = async (it: PunchItem) => {
    if (!(await appConfirm({
      title: "Void this punch item?",
      message: `"${it.title}" comes off the open list as not a real snag. It stays on the record, and you can reopen it.`,
      confirmLabel: "Void", tone: "danger",
    }))) return;
    if (await setStatus(it, "void")) {
      announce(`Voided "${it.title}".`, async () => {
        const r = await setPunchStatus({ item: { ...it, status: "void" }, status: "open", actor });
        if (!r.ok) throw new Error(r.error ?? "couldn't reopen it");
        onChanged();
      });
    }
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <ListChecks className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Punch list</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">The closeout snag list - visible until it&apos;s empty.</span>
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
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Where (optional)" aria-label="Where"
            className={`${fieldCls} w-36`} />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due"
            className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs [color-scheme:light] dark:[color-scheme:dark]" />
          {pickParties.length > 0 && (
            <select value={partyId} onChange={(e) => setPartyId(e.target.value)} aria-label="Contractor" className={fieldCls}>
              <option value="">Contractor…</option>
              {pickParties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
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
            if (editing === it.id) {
              return (
                <li key={it.id} className="px-4 py-2.5">
                  <PunchEditor item={it} parties={parties} people={people} actor={actor} setErr={setErr}
                    onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />
                </li>
              );
            }
            // Overdue starts AFTER the due day ends, in the viewer's timezone
            // — an item due today is due, not late.
            const overdue = it.status === "open" && it.dueDate && new Date(`${it.dueDate}T23:59:59`).getTime() < now;
            const where = [it.location, it.assignee ? `on it: ${it.assignee}` : null, it.partyId ? partyName.get(it.partyId) ?? null : null].filter(Boolean).join(" · ");
            return (
              <li key={it.id} className={`px-4 py-2 flex items-center gap-2 flex-wrap text-xs ${it.status !== "open" ? "opacity-55" : ""}`}>
                <span className={`w-2 h-2 rounded-full shrink-0 ${it.status === "done" ? "bg-emerald-500" : it.status === "void" ? "bg-[var(--color-border-strong)]" : overdue ? "bg-rose-500" : "bg-amber-500"}`} />
                <span className={`text-[var(--color-text)] ${it.status !== "open" ? "line-through" : ""}`}>{it.title}</span>
                {where && <span className="text-[10px] text-[var(--color-text-muted)]">{where}</span>}
                {it.dueDate && it.status === "open" && (
                  <span className={`text-[10px] font-bold ${overdue ? "text-rose-600 dark:text-rose-400" : "text-[var(--color-text-muted)]"}`}>
                    due {new Date(it.dueDate + "T00:00:00").toLocaleDateString()}{overdue ? " - overdue" : ""}
                  </span>
                )}
                {it.status === "void" && <span className="text-[9px] font-black uppercase text-[var(--color-text-faint)]">void</span>}
                {it.createdByName && <span className="text-[10px] text-[var(--color-text-faint)]">by {it.createdByName}</span>}
                {canManage && it.status === "open" && busy !== it.id && (
                  <span className="ml-auto flex items-center gap-1">
                    <button onClick={() => setEditing(it.id)} className={quietBtn} title="Change what it is, where, when it's due, who's on it">
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                    <button onClick={() => void setStatus(it, "done")}
                      className="px-2 py-1 rounded text-[10px] font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10">Done</button>
                    <button onClick={() => void voidItem(it)}
                      className="p-1.5 rounded text-[10px] font-bold text-[var(--color-text-faint)] hover:text-rose-600 hover:bg-rose-500/10" title="Void - not a real snag" aria-label="Void - not a real snag"><Ban className="w-3.5 h-3.5" /></button>
                  </span>
                )}
                {canManage && it.status !== "open" && busy !== it.id && (
                  <button onClick={() => void setStatus(it, "open")} className={`ml-auto ${quietBtn}`} title="Back on the open list">
                    <RotateCcw className="w-3 h-3" /> Reopen
                  </button>
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

/** One punch item, changed in place. */
function PunchEditor({ item, parties, people, actor, setErr, onCancel, onSaved }: {
  item: PunchItem; parties: CostParty[]; people: string[]; actor: Actor;
  setErr: (m: string | null) => void; onCancel: () => void; onSaved: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [location, setLocation] = useState(item.location ?? "");
  const [due, setDue] = useState(item.dueDate ?? "");
  const [assignee, setAssignee] = useState(item.assignee ?? "");
  const [partyId, setPartyId] = useState(item.partyId ?? "");
  const [saving, setSaving] = useState(false);
  const pick = parties.filter((p) => p.status !== "inactive" || p.id === item.partyId);
  const listId = `punch-people-${item.id}`;
  const save = async () => {
    setSaving(true);
    const res = await updatePunchItem({ item, patch: { title, location, dueDate: due || null, assignee, partyId: partyId || null }, actor });
    setSaving(false);
    if (!res.ok) { setErr(res.error ?? "Couldn't save."); return; }
    onSaved();
  };
  return (
    <div className="space-y-2 text-xs">
      <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="What it is" autoFocus className={`${fieldCls} w-full`} />
      <div className="flex items-center gap-2 flex-wrap">
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Where" aria-label="Where" className={`${fieldCls} flex-1 min-w-36`} />
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due" className={`${fieldCls} [color-scheme:light] dark:[color-scheme:dark]`} />
        <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="Who's on it" aria-label="Who's on it" list={listId} className={`${fieldCls} w-40`} />
        <datalist id={listId}>{people.map((p) => <option key={p} value={p} />)}</datalist>
        {pick.length > 0 && (
          <select value={partyId} onChange={(e) => setPartyId(e.target.value)} aria-label="Contractor" className={fieldCls}>
            <option value="">No contractor</option>
            {pick.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="px-2 py-1.5 text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
        <button onClick={() => void save()} disabled={saving}
          className="h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save
        </button>
      </div>
    </div>
  );
}
