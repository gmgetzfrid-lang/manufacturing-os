"use client";

// QualityTab — PSSR / MI / QA-QC checklists, the turnover package, and the
// punch list. The promise on the wall: "the checklist tells the system
// what's needed; the system tells you what's missing."
//
//   Checklists: point at the checklist document → the AI segments it into
//   items (YOU review before anything saves) → the AI proposes what applies
//   to THIS job, grounded on the project's purpose/SOW/schedule — and you
//   review the proposals ONE BY ONE before any of them is written; a
//   proposal that would N/A an item already satisfied is listed but never
//   applied by the assessment → the deterministic evidence sweep greens
//   items the platform can PROVE (accepted turnover on the same subject,
//   an MI checklist completed on human sign-off, Issued documents on file)
//   with the citation attached — and withdraws a green whose proof is gone
//   — and marks the rest needs_evidence, which feeds the coach.
//   A human override always wins and is never touched again. Every
//   decision needs a typed reason; a machine-verified item is labelled as
//   such, separately from a human decision, and a person can Verify it —
//   only a checklist whose every green carries a person is citable (QUAL-2).
//
//   Turnover: the quality-package contents this job requires, seeded by job
//   size, each tracked open → received → accepted/rejected/waived with the
//   reviewer's name and the reviewed document on the record; the history
//   is kept, a rejection is a nonconformance event, and an acceptance can
//   be reopened with a reason.
//
//   Punch list: the closeout snag list, visible until it's empty — each
//   closure records who closed it and what closed it; done and void differ.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardCheck, FileText, Loader2, Sparkles, Search, X, Plus, Check,
  ChevronDown, ChevronRight, AlertTriangle, ShieldCheck, PackageCheck,
  ListChecks, Ban, Wand2, Info, CheckCircle2, RotateCcw,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Actor } from "@/lib/costs";
import {
  type Checklist, type ChecklistItem, type ChecklistKind, type AssessmentProposal, CHECKLIST_KIND_LABEL,
  listChecklists, listChecklistItems, createChecklist, applyAssessment,
  updateChecklistItem, setChecklistStatus, runAutoEvidence, computeChecklistProgress,
} from "@/lib/checklists";
import {
  type TurnoverItem, type PunchItem, type TurnoverReviewEvent, TURNOVER_STATUS_LABEL,
  listTurnoverItems, listTurnoverReviewEvents, seedTurnoverItems, addTurnoverItem, reviewTurnoverItem, reopenTurnoverItem,
  listPunchItems, addPunchItem, setPunchStatus, computeTurnoverProgress,
} from "@/lib/turnover";
import { type SegmentedItem, isAutoOnlyGreen, isMachineActorName, REASON_MIN_LENGTH } from "@/lib/checklistEngine";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { appPrompt } from "@/components/providers/DialogProvider";

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

// ── Notices (UX-7 / UX-8): a tone per outcome, rendered beside the control ──

export type NoticeTone = "error" | "success" | "info";
export interface NoticeState { tone: NoticeTone; text: string }
type Notify = (n: NoticeState | null) => void;

const failure = (text: string): NoticeState => ({ tone: "error", text });
const success = (text: string): NoticeState => ({ tone: "success", text });
const info = (text: string): NoticeState => ({ tone: "info", text });

function Notice({ notice, onClose, action }: { notice: NoticeState | null; onClose: () => void; action?: React.ReactNode }) {
  if (!notice) return null;
  const tone = notice.tone === "error"
    ? "border-rose-500/50 bg-rose-500/[0.08] text-rose-700 dark:text-rose-300"
    : notice.tone === "success"
      ? "border-emerald-500/50 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300"
      : "border-sky-500/50 bg-sky-500/[0.08] text-sky-700 dark:text-sky-300";
  const Icon = notice.tone === "error" ? AlertTriangle : notice.tone === "success" ? CheckCircle2 : Info;
  return (
    <div role={notice.tone === "error" ? "alert" : "status"}
      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold ${tone}`}>
      <Icon className="w-4 h-4 shrink-0" /> <span className="min-w-0 flex-1">{notice.text}</span>
      {action}
      <button type="button" onClick={onClose} aria-label="Dismiss" className="opacity-70 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
    </div>
  );
}

/** Prompt for a reason that meets the record's bar — a blank cannot settle
 *  it (SAF-4); the server enforces the same bar. */
const promptReason = (title: string, message: string, placeholder = "Why? (at least 10 characters)") =>
  appPrompt({ title, message, placeholder, required: true, minLength: REASON_MIN_LENGTH });

export default function QualityTab({ orgId, projectId, canManage, uid, userEmail, jobKind, onDataChanged }: {
  orgId: string; projectId: string; canManage: boolean;
  uid: string; userEmail?: string | null;
  jobKind: string | null;
  /** Fires after each data reload so the page's coach/health re-gathers. */
  onDataChanged?: () => void;
}) {
  const actor: Actor = useMemo(() => ({ uid, email: userEmail ?? null }), [uid, userEmail]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [turnover, setTurnover] = useState<TurnoverItem[]>([]);
  const [events, setEvents] = useState<TurnoverReviewEvent[]>([]);
  const [punch, setPunch] = useState<PunchItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [cl, to, ev, pu] = await Promise.all([
        listChecklists(orgId, projectId),
        listTurnoverItems(orgId, projectId),
        listTurnoverReviewEvents(orgId, projectId),
        listPunchItems(orgId, projectId),
      ]);
      setChecklists(cl); setTurnover(to); setEvents(ev); setPunch(pu);
      setLoadError(null);
    } catch (e) {
      // UX-10: a denied policy or a missing migration is a failure to load,
      // never "No checklists yet".
      setLoadError((e as Error).message);
    } finally { setLoading(false); }
    onDataChanged?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId]);
  useEffect(() => { void refresh(); }, [refresh]);

  if (loading) return <div className="py-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>;

  return (
    <div className="space-y-4">
      {loadError && (
        <Notice notice={failure(`The quality program couldn't be loaded — ${loadError}`)} onClose={() => setLoadError(null)}
          action={<button type="button" onClick={() => void refresh()} className="underline">Retry</button>} />
      )}

      <ChecklistsSection orgId={orgId} projectId={projectId} canManage={canManage} actor={actor}
        checklists={checklists} onChanged={() => void refresh()} />
      <TurnoverSection orgId={orgId} projectId={projectId} canManage={canManage} actor={actor}
        items={turnover} events={events} jobKind={jobKind} onChanged={() => void refresh()} />
      <PunchSection orgId={orgId} projectId={projectId} canManage={canManage} actor={actor}
        items={punch} onChanged={() => void refresh()} />
    </div>
  );
}

// ── Checklists ───────────────────────────────────────────────────────────

function ChecklistsSection({ orgId, projectId, canManage, actor, checklists, onChanged }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  checklists: Checklist[]; onChanged: () => void;
}) {
  const [showNew, setShowNew] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
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

      {notice && <div className="px-4 pt-3"><Notice notice={notice} onClose={() => setNotice(null)} /></div>}

      {showNew && canManage && (
        <NewChecklistFlow orgId={orgId} projectId={projectId} actor={actor}
          onDone={() => { setShowNew(false); onChanged(); }} onCancel={() => setShowNew(false)} notify={setNotice} />
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
              canManage={canManage} actor={actor} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  );
}

function NewChecklistFlow({ orgId, projectId, actor, onDone, onCancel, notify }: {
  orgId: string; projectId: string; actor: Actor;
  onDone: () => void; onCancel: () => void; notify: Notify;
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
    setReading(true); notify(null);
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
      notify(failure((e as Error).message));
    } finally { setReading(false); }
  };

  const save = async () => {
    if (!proposed || !doc) return;
    setSaving(true); notify(null);
    const res = await createChecklist({
      orgId, projectId, title: title || doc.label, kind,
      sourceDocumentId: doc.id,
      items: proposed.map((p, i) => ({ ...p, seq: i + 1 })),
      actor,
    });
    setSaving(false);
    if (!res.ok) { notify(failure(res.error ?? "Couldn't save.")); return; }
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

/** A proposal as the assess route returns it — with the item's current state. */
type ReviewProposal = AssessmentProposal & {
  current: { text: string; section: string | null; status: string; hasEvidence: boolean; humanDecided: boolean; protectedFromDowngrade: boolean };
};

/** The cited document's current standing, for the evidence chip (SAF-1 / QUAL-1). */
type DocStanding = { status: string | null; rev: string | null; label: string };

function ChecklistCard({ orgId, projectId, checklist, canManage, actor, onChanged }: {
  orgId: string; projectId: string; checklist: Checklist;
  canManage: boolean; actor: Actor;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [docs, setDocs] = useState<Record<string, DocStanding>>({});
  /** The cited-document lookup answered (an error leaves chips without a standing). */
  const [docsChecked, setDocsChecked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [review, setReview] = useState<{ proposals: ReviewProposal[]; ticked: Set<string> } | null>(null);

  const loadItems = useCallback(async () => {
    try {
      const rows = await listChecklistItems(checklist.id);
      setItems(rows); setItemsError(null);
      // The cited documents' CURRENT status, so a Void/Superseded citation is visible.
      const ids = [...new Set(rows.flatMap((r) => r.evidence.map((e) => e.documentId).filter((x): x is string => Boolean(x))))];
      if (ids.length > 0) {
        // Through the caller's RLS: a document the viewer may not read (an
        // ACL-restricted one) comes back absent — the chip says so, never
        // "not found" (SEC-10 keeps the service-role read out of here).
        const { data, error } = await supabase.from("documents").select("id, status, rev, document_number, title, name").in("id", ids).limit(200);
        const map: Record<string, DocStanding> = {};
        for (const d of ((data ?? []) as Array<Record<string, unknown>>)) {
          map[String(d.id)] = {
            status: (d.status as string | null) ?? null, rev: (d.rev as string | null) ?? null,
            label: String(d.document_number || d.title || d.name || ""),
          };
        }
        setDocs(map); setDocsChecked(!error);
      } else {
        setDocs({}); setDocsChecked(true);
      }
    } catch (e) {
      setItems([]); setItemsError((e as Error).message);
    }
  }, [checklist.id]);
  useEffect(() => { if (open && items == null) void loadItems(); }, [open, items, loadItems]);

  const progress = useMemo(() => (items ? computeChecklistProgress(items) : null), [items]);
  const blocking = progress ? progress.applicable - progress.satisfied : 0;
  /** Greens the sweep set that no person has verified — each one makes the
   *  completion 'auto' (not citable) until a person verifies it (QUAL-2). */
  const autoGreens = useMemo(() => (items ?? []).filter(isAutoOnlyGreen).length, [items]);

  const assess = async () => {
    setBusy("assess"); setNotice(null);
    try {
      const res = await fetch("/api/projects/checklist", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ orgId, projectId, action: "assess", checklistId: checklist.id }),
      });
      const body = (await res.json().catch(() => null)) as { proposals?: ReviewProposal[]; error?: string } | null;
      if (!res.ok || !body?.proposals) throw new Error(body?.error || `HTTP ${res.status}`);
      // SAF-2 / GAP-404: every proposal is shown and starts UNTICKED — nothing
      // is applied that the reviewer has not seen and chosen.
      setReview({ proposals: body.proposals, ticked: new Set() });
    } catch (e) {
      setNotice(failure((e as Error).message));
    } finally { setBusy(null); }
  };

  const applyReview = async () => {
    if (!review) return;
    setBusy("apply"); setNotice(null);
    try {
      const out = await applyAssessment({
        orgId, projectId, checklistId: checklist.id,
        proposals: review.proposals.map(({ itemId, applicability, rationale }) => ({ itemId, applicability, rationale })),
        confirmedItemIds: [...review.ticked],
        actor,
      });
      await loadItems(); onChanged();
      if (out.error) { setNotice(failure(out.error)); return; }
      setReview(null);
      const parts = [`Applied ${out.applied}`];
      if (out.skippedHuman > 0) parts.push(`left ${out.skippedHuman} alone because a person already decided them`);
      if (out.skippedProtected > 0) parts.push(`did not change ${out.skippedProtected} already-satisfied item${out.skippedProtected === 1 ? "" : "s"} (use the item's own N/A with a reason)`);
      if (out.skippedUnconfirmed > 0) parts.push(`${out.skippedUnconfirmed} unticked`);
      setNotice(success(`${parts.join("; ")}.`));
    } catch (e) {
      setNotice(failure((e as Error).message));
    } finally { setBusy(null); }
  };

  const sweep = async () => {
    setBusy("sweep"); setNotice(null);
    try {
      const res = await runAutoEvidence({ orgId, projectId, checklistId: checklist.id, actor });
      await loadItems(); onChanged();
      if (res.error) { setNotice(failure(res.error)); return; }
      if (res.satisfied + res.needsEvidence + res.retracted === 0) {
        setNotice(info("Evidence sweep: nothing new to prove or demand — items are either done, human-decided, or not evidence-shaped."));
      } else {
        const parts = [];
        if (res.satisfied > 0) parts.push(`${res.satisfied} proven`);
        if (res.needsEvidence > 0) parts.push(`${res.needsEvidence} need evidence`);
        if (res.retracted > 0) parts.push(`${res.retracted} withdrawn — the cited document is no longer current`);
        setNotice(success(`Evidence sweep: ${parts.join(", ")}.`));
      }
    } catch (e) {
      setNotice(failure((e as Error).message));
    } finally { setBusy(null); }
  };

  const complete = async () => {
    setBusy("complete"); setNotice(null);
    const res = await setChecklistStatus({ orgId, projectId, checklist, status: "complete", actor });
    setBusy(null);
    if (!res.ok) { setNotice(failure(res.error ?? "Couldn't complete.")); return; }
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

  const completeBlocked = progress != null && (progress.total === 0 || blocking > 0);
  const completeTitle = progress == null ? "Loading items…"
    : progress.total === 0 ? "No items — nothing to verify, so this checklist cannot be completed."
    : blocking > 0 ? `${blocking} item${blocking === 1 ? " is" : "s are"} not satisfied yet — a checklist only completes when every applicable item is green or N/A.`
    : autoGreens > 0 ? `Every applicable item is green or N/A, but ${autoGreens} green${autoGreens === 1 ? " rests" : "s rest"} on the evidence sweep alone — completing now records this checklist as "auto", which no other checklist can cite. Verify ${autoGreens === 1 ? "it" : "them"} first to sign it off.`
    : "Every applicable item is green or N/A, and every green carries a person's decision.";

  return (
    <div>
      <button onClick={() => setOpen((v) => !v)} className="w-full px-4 py-3 flex items-center gap-2 text-left hover:bg-[var(--color-surface-2)]/40 transition-colors">
        {open ? <ChevronDown className="w-4 h-4 text-[var(--color-text-faint)]" /> : <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)]" />}
        <span className="text-xs font-black text-[var(--color-text)]">{checklist.title}</span>
        <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{CHECKLIST_KIND_LABEL[checklist.kind]}</span>
        {checklist.status === "complete" && (
          <span className="inline-flex items-center gap-0.5 text-[9px] font-black uppercase text-emerald-700 dark:text-emerald-300"
            title={checklist.completedBasis === "human" ? "Completed on human sign-off — every green item carries a person's decision" : checklist.completedBasis === "auto" ? "Completed while at least one green item rested on the evidence sweep alone — not citable as proof by another checklist" : "Completed"}>
            <ShieldCheck className="w-3 h-3" /> complete{checklist.completedBasis === "auto" ? " (auto)" : ""}
          </span>
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
                title="AI judges which items apply to THIS job, grounded on the project's purpose, SOW, schedule, and documents. You review each proposal before it applies.">
                {busy === "assess" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />} Which items apply to this job?
              </button>
              <button onClick={() => void sweep()} disabled={busy != null}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors"
                title="Deterministic — no AI. Greens items the platform can PROVE (accepted turnover on the same subject, Issued documents on file), citation attached; withdraws a green whose document is no longer current; flags the rest needs-evidence.">
                {busy === "sweep" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ListChecks className="w-3 h-3" />} Check evidence we already hold
              </button>
              <button onClick={() => void complete()} disabled={busy != null || completeBlocked}
                aria-disabled={completeBlocked || undefined}
                title={completeTitle}
                className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-[11px] font-black hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {busy === "complete" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />} Mark complete
              </button>
              {completeBlocked && progress && (
                <span className="basis-full text-[10px] text-[var(--color-text-muted)]">{completeTitle}</span>
              )}
              {!completeBlocked && progress && autoGreens > 0 && (
                <span className="basis-full text-[10px] font-bold text-amber-700 dark:text-amber-300">{completeTitle}</span>
              )}
            </div>
          )}

          <Notice notice={notice} onClose={() => setNotice(null)} />

          {review && (
            <AssessmentReview review={review} busy={busy === "apply"}
              onToggle={(id) => setReview((r) => {
                if (!r) return r;
                const ticked = new Set(r.ticked);
                if (ticked.has(id)) ticked.delete(id); else ticked.add(id);
                return { ...r, ticked };
              })}
              onTickAll={() => setReview((r) => r ? { ...r, ticked: new Set(r.proposals.filter((p) => !(p.applicability === "na" && p.current.protectedFromDowngrade) && !p.current.humanDecided).map((p) => p.itemId)) } : r)}
              onClear={() => setReview((r) => r ? { ...r, ticked: new Set() } : r)}
              onApply={() => void applyReview()} onCancel={() => setReview(null)} />
          )}

          {items == null ? (
            <div className="py-4 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-[var(--color-accent)]" /></div>
          ) : itemsError ? (
            <Notice notice={failure(`The items couldn't be loaded — ${itemsError}`)} onClose={() => setItemsError(null)}
              action={<button type="button" onClick={() => void loadItems()} className="underline">Retry</button>} />
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
                      <ChecklistItemRow key={it.id} orgId={orgId} projectId={projectId} item={it} docs={docs} docsChecked={docsChecked}
                        canManage={canManage && checklist.status === "open"} actor={actor}
                        onChanged={() => { void loadItems(); onChanged(); }} notify={setNotice} />
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

/** The per-item review of an AI assessment (SAF-2 / QUAL-5): every
 *  proposal listed with its rationale, each individually ticked, starting
 *  with nothing ticked. Proposals that would N/A an item already satisfied
 *  or evidence-bearing are shown but cannot be applied here. */
function AssessmentReview({ review, busy, onToggle, onTickAll, onClear, onApply, onCancel }: {
  review: { proposals: ReviewProposal[]; ticked: Set<string> };
  busy: boolean;
  onToggle: (id: string) => void; onTickAll: () => void; onClear: () => void;
  onApply: () => void; onCancel: () => void;
}) {
  const na = review.proposals.filter((p) => p.applicability === "na");
  const protectedNa = na.filter((p) => p.current.protectedFromDowngrade);
  return (
    <div className="rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)]/20 p-3 space-y-2">
      <div className="text-xs font-bold text-[var(--color-text)]">
        The assessment proposes applicability for {review.proposals.length} item{review.proposals.length === 1 ? "" : "s"}
        {na.length > 0 ? ` — ${na.length} look${na.length === 1 ? "s" : ""} not-applicable to this job` : ""}.
        Tick the ones you agree with; nothing is written until you apply.
      </div>
      {protectedNa.length > 0 && (
        <div className="flex items-start gap-1.5 text-[11px] font-bold text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{protectedNa.length} of the proposed N/As target{protectedNa.length === 1 ? "s" : ""} an item that is already satisfied or has evidence attached. The assessment will not change {protectedNa.length === 1 ? "it" : "them"} — if one really is not applicable, use its own N/A control and say why.</span>
        </div>
      )}
      <div className="flex items-center gap-2 text-[10px] font-bold">
        <button type="button" onClick={onTickAll} className="underline text-[var(--color-text-muted)]">Tick every applicable proposal</button>
        <button type="button" onClick={onClear} className="underline text-[var(--color-text-muted)]">Clear</button>
        <span className="ml-auto tabular-nums text-[var(--color-text-muted)]">{review.ticked.size} ticked</span>
      </div>
      <ul className="max-h-80 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)]">
        {review.proposals.map((p) => {
          const locked = (p.applicability === "na" && p.current.protectedFromDowngrade) || p.current.humanDecided;
          const why = p.current.humanDecided ? "A person already decided this item — the assessment never touches it."
            : p.applicability === "na" && p.current.protectedFromDowngrade ? (p.current.status === "satisfied" ? "Currently SATISFIED — the assessment will not downgrade it." : "Evidence is attached — the assessment will not downgrade it.")
            : undefined;
          return (
            <li key={p.itemId} className={`px-3 py-1.5 flex items-start gap-2 text-xs ${locked ? "opacity-70" : ""}`}>
              <input type="checkbox" className="mt-0.5" checked={review.ticked.has(p.itemId)} disabled={locked || busy}
                onChange={() => onToggle(p.itemId)} aria-label={`Apply: ${p.current.text}`} />
              <div className="min-w-0 flex-1">
                <div className="text-[var(--color-text)]">
                  {p.current.section && <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-faint)] mr-1">{p.current.section}</span>}
                  {p.current.text}
                </div>
                <div className="text-[10px] text-[var(--color-text-muted)]">
                  <span className={`font-black uppercase mr-1 ${p.applicability === "na" ? "text-amber-700 dark:text-amber-300" : ""}`}>{p.applicability === "na" ? "N/A" : p.applicability}</span>
                  {p.rationale || "(no rationale given)"}
                  <span className="ml-1 text-[var(--color-text-faint)]">· now {p.current.status.replace("_", " ")}{p.current.hasEvidence ? ", evidence attached" : ""}</span>
                </div>
                {why && <div className="text-[10px] font-bold text-amber-700 dark:text-amber-300">{why}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onApply} disabled={busy || review.ticked.size === 0}
          className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Apply {review.ticked.size} ticked
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
      </div>
    </div>
  );
}

function ChecklistItemRow({ orgId, projectId, item, docs, docsChecked, canManage, actor, onChanged, notify }: {
  orgId: string; projectId: string; item: ChecklistItem; docs: Record<string, DocStanding>; docsChecked: boolean;
  canManage: boolean; actor: Actor;
  onChanged: () => void; notify: Notify;
}) {
  const [busy, setBusy] = useState(false);
  const na = item.applicability === "na" || item.status === "na";
  const machine = item.status === "satisfied" && !item.manualNote && isMachineActorName(item.updatedByName);
  // A green no person has verified (the sweep's, or a legacy one): a person
  // can Verify it — the row gains their note, uid and name, the sweep's
  // citation chip stays, and the sweep keeps its hands off from then on.
  const unverifiedGreen = !na && isAutoOnlyGreen(item);

  const override = async (
    patch: Parameters<typeof updateChecklistItem>[0]["patch"], promptNote: string,
    message = "Your reason goes on the record and marks this item human-decided — automation keeps its hands off from then on.",
  ) => {
    // SAF-4: a decision needs a typed reason — the prompt cannot settle
    // blank, and no placeholder is ever written. The server checks it too.
    const v = await promptReason(promptNote, message);
    if (v === null) return;
    setBusy(true);
    const res = await updateChecklistItem({ orgId, projectId, item, patch: { ...patch, manualNote: v.trim() }, actor });
    setBusy(false);
    if (!res.ok) notify(failure(res.error ?? "Couldn't update.")); else { notify(null); onChanged(); }
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
          {machine && (
            <div className="mt-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300" title="Set by the deterministic evidence sweep from a document on file — no person has verified this line.">
              Machine-verified ({item.updatedByName}){item.updatedAt ? ` · ${new Date(item.updatedAt).toLocaleDateString()}` : ""} — not a human sign-off{canManage ? " · Verify to sign it off" : ""}
            </div>
          )}
          {item.evidence.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {item.evidence.map((e, i) => <EvidenceChip key={i} chip={e} doc={e.documentId ? docs[e.documentId] : undefined} checked={docsChecked} />)}
            </div>
          )}
        </div>
        {canManage && !busy && (
          <span className="shrink-0 flex items-center gap-1">
            {!na && item.status !== "satisfied" && (
              <button onClick={() => void override({ status: "satisfied" }, "Mark satisfied")}
                className="px-1.5 py-0.5 rounded text-[10px] font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10" title="Mark satisfied with your note on the record">✓ Satisfied</button>
            )}
            {unverifiedGreen && (
              <button onClick={() => void override({ status: "satisfied" }, "Verify this item",
                "Say what you checked. Your note goes on the record with your name and makes this green a human decision — the sweep's citation stays attached, and the sweep will not withdraw it from then on.")}
                className="px-1.5 py-0.5 rounded text-[10px] font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10"
                title="Confirm this machine green yourself — only a checklist whose every green carries a person can be cited as proof elsewhere">✓ Verify</button>
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

/** An evidence citation. A sweep chip is emerald and says so; a person's
 *  chip is sky. A chip that names a document shows that document's CURRENT
 *  status and revision — a citation to a Void or Superseded document turns
 *  rose so nobody reads it as proof (SAF-1 / QUAL-1). */
function EvidenceChip({ chip, doc, checked }: { chip: ChecklistItem["evidence"][number]; doc?: DocStanding; checked: boolean }) {
  const stale = doc ? (NOT_CURRENT_STATUSES.has(doc.status ?? "") || doc.status === "Draft") : false;
  // No row back from a lookup that ran: the viewer cannot read the cited
  // document (access-restricted for them, or removed) — the citation itself
  // is unchanged, so never call it "not found".
  const hidden = !doc && Boolean(chip.documentId) && checked;
  const tone = stale
    ? "border-rose-500/50 bg-rose-500/[0.08] text-rose-700 dark:text-rose-300"
    : chip.source === "auto"
      ? "border-emerald-500/40 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300"
      : "border-sky-500/40 bg-sky-500/[0.07] text-sky-700 dark:text-sky-300";
  const standing = doc ? ` · ${doc.status ?? "status unknown"}${doc.rev ? ` rev ${doc.rev}` : ""}` : hidden ? " · not visible to you" : "";
  const title = `${chip.source === "auto" ? "Found by the evidence sweep" : "Attached by a person"}${doc ? ` — the cited document is currently ${doc.status ?? "of unknown status"}${doc.rev ? `, rev ${doc.rev}` : ""}` : ""}${hidden ? " — you can't open the cited document (it is access-restricted for you, or it was removed); ask someone who can to check its status" : ""}${stale ? ". This citation no longer proves anything." : ""}`;
  return (
    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${tone}`} title={title}>
      {chip.label}{standing}
    </span>
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

/** A small document picker for "which document did you accept?" (QUAL-13). */
function DocPicker({ orgId, title, onPick, onSkip, onCancel }: {
  orgId: string; title: string;
  onPick: (doc: { id: string; label: string }) => void; onSkip: () => void; onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ q: string; rows: Array<{ id: string; label: string; status: string | null }> }>({ q: "", rows: [] });
  const q = query.trim();
  const results = q.length >= 2 && found.q === q ? found.rows : [];
  useEffect(() => {
    if (q.length < 2) return;
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from("documents").select("id, document_number, title, name, status")
        .eq("org_id", orgId)
        .or(`document_number.ilike.%${q}%,title.ilike.%${q}%,name.ilike.%${q}%`)
        .limit(8);
      setFound({ q, rows: (((data ?? []) as Array<Record<string, unknown>>)).map((d) => ({
        id: String(d.id), label: String(d.document_number || d.title || d.name || "Document"), status: (d.status as string | null) ?? null,
      })) });
    }, 250);
    return () => clearTimeout(t);
  }, [q, orgId]);
  return (
    <div className="mt-2 rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)]/20 p-2.5 space-y-1.5">
      <div className="text-[11px] font-bold text-[var(--color-text)]">{title}</div>
      <div className="text-[10px] text-[var(--color-text-muted)]">Name the document you reviewed so the acceptance points at a revision, not a memory.</div>
      <span className="relative block">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-faint)]" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
          placeholder="Find the document (by number or title)…"
          className="w-full h-8 pl-8 pr-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-xs" />
      </span>
      {results.length > 0 && (
        <ul className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] overflow-hidden">
          {results.map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => onPick(d)} className="w-full px-3 py-1.5 text-left text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2">
                <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> {d.label}
                {d.status && <span className="ml-auto text-[9px] font-bold uppercase text-[var(--color-text-faint)]">{d.status}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 text-[10px] font-bold">
        <button type="button" onClick={onSkip} className="underline text-[var(--color-text-muted)]">Accept without naming a document</button>
        <button type="button" onClick={onCancel} className="ml-auto text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
      </div>
    </div>
  );
}

function TurnoverSection({ orgId, projectId, canManage, actor, items, events, jobKind, onChanged }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  items: TurnoverItem[]; events: TurnoverReviewEvent[]; jobKind: string | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [accepting, setAccepting] = useState<TurnoverItem | null>(null);
  const [reviewedDocs, setReviewedDocs] = useState<Record<string, { label: string; status: string | null; rev: string | null; libraryId: string | null }>>({});
  const progress = useMemo(() => computeTurnoverProgress(items), [items]);
  const documentIds = useMemo(() => [...new Set(items.map((i) => i.documentId).filter((x): x is string => Boolean(x)))].sort().join(","), [items]);
  useEffect(() => {
    if (!documentIds) return;
    let cancelled = false;
    void (async () => {
      // The reviewed document's label and CURRENT standing (QUAL-13).
      const { data } = await supabase.from("documents").select("id, document_number, title, name, status, rev, library_id")
        .in("id", documentIds.split(",")).limit(300);
      if (cancelled) return;
      const map: Record<string, { label: string; status: string | null; rev: string | null; libraryId: string | null }> = {};
      for (const d of ((data ?? []) as Array<Record<string, unknown>>)) {
        map[String(d.id)] = {
          label: String(d.document_number || d.title || d.name || "Document"),
          status: (d.status as string | null) ?? null, rev: (d.rev as string | null) ?? null,
          libraryId: (d.library_id as string | null) ?? null,
        };
      }
      setReviewedDocs(map);
    })();
    return () => { cancelled = true; };
  }, [documentIds]);
  const eventsByItem = useMemo(() => {
    const by = new Map<string, TurnoverReviewEvent[]>();
    for (const e of events) by.set(e.itemId, [...(by.get(e.itemId) ?? []), e]);
    return by;
  }, [events]);

  const seed = async () => {
    setBusy("seed"); setNotice(null);
    const res = await seedTurnoverItems({ orgId, projectId, jobKind, actor });
    setBusy(null);
    if (!res.ok) { setNotice(failure(res.error ?? "Couldn't seed.")); return; }
    setNotice(res.added > 0 ? success(`Added ${res.added} required item${res.added === 1 ? "" : "s"}.`) : info("Every required item for this job size is already listed."));
    onChanged();
  };

  const finish = (res: { ok: boolean; error?: string }) => {
    setBusy(null);
    if (!res.ok) setNotice(failure(res.error ?? "Couldn't update.")); else { setNotice(null); onChanged(); }
  };

  const review = async (item: TurnoverItem, status: TurnoverItem["status"], documentId?: string | null) => {
    let note: string | null = null;
    if (status === "rejected" || status === "waived") {
      note = await promptReason(
        status === "rejected" ? `Reject "${item.name}"` : `Waive "${item.name}"`,
        status === "rejected"
          ? "Why is it not acceptable? The contractor sees this reason, it lands on their record, and it is kept as a nonconformance."
          : "Why is this not required for this job? Waivers go on the record — and a waived item is counted apart from an accepted one.",
        "Reason (at least 10 characters)",
      );
      if (note === null) return;
    }
    setBusy(item.id); setNotice(null);
    finish(await reviewTurnoverItem({ item, status, note, ...(documentId !== undefined ? { documentId } : {}), actor }));
  };

  const reopen = async (item: TurnoverItem) => {
    const reason = await promptReason(`Reopen "${item.name}"`,
      `This item is ${item.status}. Reopening sends it back for review; the ${item.status === "accepted" ? "acceptance" : "waiver"} stays in the history with your reason.`,
      "Why reopen? (at least 10 characters)");
    if (reason === null) return;
    setBusy(item.id); setNotice(null);
    finish(await reopenTurnoverItem({ item, reason, actor }));
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <PackageCheck className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Turnover package — QA/QC sign-off</span>
        {progress.required > 0 && (
          <span className="text-[10px] font-bold tabular-nums text-[var(--color-text-muted)]">
            {progress.accepted}/{progress.required} accepted{progress.waived > 0 ? ` · ${progress.waived} waived` : ""}{progress.received > 0 ? ` · ${progress.received} awaiting review` : ""}
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

      {notice && <div className="px-4 pt-3"><Notice notice={notice} onClose={() => setNotice(null)} /></div>}

      {items.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
          Nothing required yet. Seed the standard contents for this job size, or add items by hand —
          then track what the contractor has actually delivered and whether QA/QC accepted it.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {items.map((it) => {
            const history = eventsByItem.get(it.id) ?? [];
            return (
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
                        <button onClick={() => setAccepting(it)} className="px-1.5 py-0.5 rounded text-[10px] font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10">Accept</button>
                      )}
                      {it.status === "received" && (
                        <button onClick={() => void review(it, "rejected")} className="px-1.5 py-0.5 rounded text-[10px] font-bold text-rose-700 dark:text-rose-300 hover:bg-rose-500/10">Reject</button>
                      )}
                      {(it.status === "open" || it.status === "received") && (
                        <button onClick={() => void review(it, "waived")} className="px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">Waive</button>
                      )}
                      {(it.status === "accepted" || it.status === "waived") && (
                        <button onClick={() => void reopen(it)} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
                          title={`Reopen this ${it.status} item for review — the ${it.status === "accepted" ? "acceptance" : "waiver"} stays in the history.`}>
                          <RotateCcw className="w-3 h-3" /> Reopen
                        </button>
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
                  {it.documentId && (() => {
                    const d = reviewedDocs[it.documentId];
                    const text = d ? `${d.label}${d.status ? ` · ${d.status}` : ""}${d.rev ? ` rev ${d.rev}` : ""}` : "reviewed document";
                    const inner = <><FileText className="w-3 h-3" /> {text}</>;
                    return (
                      <>
                        {" · "}
                        {d?.libraryId ? (
                          <a href={`/documents/${d.libraryId}?doc=${it.documentId}`} className="underline inline-flex items-center gap-0.5" title="The document that was reviewed">{inner}</a>
                        ) : (
                          <span className="inline-flex items-center gap-0.5" title="The document that was reviewed">{inner}</span>
                        )}
                      </>
                    );
                  })()}
                </div>
                {history.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[10px] text-[var(--color-text-faint)]">
                    {history.map((e) => (
                      <li key={e.id}>
                        {e.kind === "nonconformance" ? <span className="font-black uppercase text-rose-600 dark:text-rose-400 mr-1">nonconformance</span>
                          : e.kind === "reopen" ? <span className="font-black uppercase mr-1">reopened</span> : null}
                        {e.fromStatus ? `${e.fromStatus} → ` : ""}{e.toStatus}{e.reviewerName ? ` by ${e.reviewerName}` : ""}{e.createdAt ? ` on ${new Date(e.createdAt).toLocaleDateString()}` : ""}{e.note ? ` — “${e.note}”` : ""}
                      </li>
                    ))}
                  </ul>
                )}
                {accepting?.id === it.id && (
                  <DocPicker orgId={orgId} title={`Accept "${it.name}" — which document did you review?`}
                    onPick={(d) => { setAccepting(null); void review(it, "accepted", d.id); }}
                    onSkip={() => { setAccepting(null); void review(it, "accepted"); }}
                    onCancel={() => setAccepting(null)} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canManage && (
        <div className="px-4 py-2.5 border-t border-[var(--color-border)] flex items-center gap-2">
          <input value={addName} onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && addName.trim()) { void (async () => { const r = await addTurnoverItem({ orgId, projectId, name: addName, actor }); if (!r.ok) setNotice(failure(r.error ?? "Couldn't add.")); else { setAddName(""); onChanged(); } })(); } }}
            placeholder="Add a required item — e.g. Torque records"
            className="h-8 flex-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          <button onClick={() => { if (addName.trim()) void (async () => { const r = await addTurnoverItem({ orgId, projectId, name: addName, actor }); if (!r.ok) setNotice(failure(r.error ?? "Couldn't add.")); else { setAddName(""); onChanged(); } })(); }}
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

function PunchSection({ orgId, projectId, canManage, actor, items, onChanged }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  items: PunchItem[]; onChanged: () => void;
}) {
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const open = items.filter((i) => i.status === "open");
  const closed = items.filter((i) => i.status !== "open");
  // Captured once at mount — render stays pure.
  const [now] = useState(() => Date.now());

  const add = async () => {
    if (!title.trim()) return;
    setBusy("add"); setNotice(null);
    const res = await addPunchItem({ orgId, projectId, title, dueDate: due || null, location: location || null, description: description || null, actor });
    setBusy(null);
    if (!res.ok) { setNotice(failure(res.error ?? "Couldn't add.")); return; }
    setTitle(""); setDue(""); setLocation(""); setDescription(""); onChanged();
  };

  const close = async (it: PunchItem, status: "done" | "void") => {
    // SAF-4: void needs a reason; done records what closed it.
    const note = status === "void"
      ? await promptReason(`Void "${it.title}"`, "Why is this not a real snag? The reason goes on the record.")
      : await appPrompt({ title: `Done — "${it.title}"`, message: "What was done, and who verified it? (optional — it goes on the closure record)", placeholder: "e.g. Insulation reinstalled, verified by J. Chen 9/14" });
    if (note === null) return;
    setBusy(it.id); setNotice(null);
    const r = await setPunchStatus({ item: it, status, note, actor });
    setBusy(null);
    if (!r.ok) setNotice(failure(r.error ?? "Couldn't update.")); else { setNotice(null); onChanged(); }
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

      {notice && <div className="px-4 pt-3"><Notice notice={notice} onClose={() => setNotice(null)} /></div>}

      {canManage && (
        <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            placeholder="e.g. Reinstall insulation at E-301 north nozzle"
            className="h-8 flex-1 min-w-56 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          <input value={location} onChange={(e) => setLocation(e.target.value)}
            placeholder="Location / tag (optional)" aria-label="Location or equipment tag"
            className="h-8 w-40 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          <input value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Details (optional)" aria-label="Description"
            className="h-8 w-48 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date"
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
            // Overdue starts AFTER the due day ends, in the viewer's timezone
            // — an item due today is due, not late.
            const overdue = it.status === "open" && it.dueDate && new Date(`${it.dueDate}T23:59:59`).getTime() < now;
            return (
              <li key={it.id} className={`px-4 py-2 text-xs ${it.status !== "open" ? "opacity-55" : ""}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${it.status === "done" ? "bg-emerald-500" : it.status === "void" ? "bg-[var(--color-border-strong)]" : overdue ? "bg-rose-500" : "bg-amber-500"}`} />
                  <span className={`text-[var(--color-text)] ${it.status !== "open" ? "line-through" : ""}`}>{it.title}</span>
                  {it.location && <span className="text-[10px] font-bold text-[var(--color-text-muted)]">@ {it.location}</span>}
                  {it.dueDate && it.status === "open" && (
                    <span className={`text-[10px] font-bold ${overdue ? "text-rose-600 dark:text-rose-400" : "text-[var(--color-text-muted)]"}`}>
                      due {new Date(it.dueDate + "T00:00:00").toLocaleDateString()}{overdue ? " — overdue" : ""}
                    </span>
                  )}
                  {it.createdByName && <span className="text-[10px] text-[var(--color-text-faint)]">by {it.createdByName}</span>}
                  {it.status !== "open" && (
                    <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${it.status === "done" ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : "border-rose-500/40 text-rose-700 dark:text-rose-300"}`}>
                      {it.status === "done" ? "done" : "voided"}{it.closedByName ? ` by ${it.closedByName}` : ""}{it.closedAt ? ` on ${new Date(it.closedAt).toLocaleDateString()}` : ""}
                    </span>
                  )}
                  {canManage && it.status === "open" && busy !== it.id && (
                    <span className="ml-auto flex items-center gap-1">
                      <button onClick={() => void close(it, "done")}
                        className="px-1.5 py-0.5 rounded text-[10px] font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10">Done</button>
                      <button onClick={() => void close(it, "void")}
                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-faint)] hover:text-rose-600 hover:bg-rose-500/10" title="Void — not a real snag (a reason is required)">
                        <Ban className="w-3 h-3" /> Void
                      </button>
                    </span>
                  )}
                  {busy === it.id && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-accent)] ml-auto" />}
                </div>
                {(it.description || it.closureNote) && (
                  <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                    {[it.description, it.closureNote ? `${it.status === "void" ? "voided" : "closed"}: “${it.closureNote}”` : null].filter(Boolean).join(" · ")}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
