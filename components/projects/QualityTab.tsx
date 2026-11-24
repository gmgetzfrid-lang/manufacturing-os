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
import { useFileDrag } from "@/hooks/useFileDrag";
import Link from "next/link";
import {
  FileText, Loader2, Sparkles, Search, X, Plus, Check, ChevronRight, ShieldCheck, ListChecks, Ban, Wand2, Pencil, RotateCcw, Paperclip, Trash2, UploadCloud,
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
  reopenTurnoverItem, updateTurnoverItem, attachTurnoverDocument, updatePunchItem, seedsForJobKind,
} from "@/lib/turnover";
import type { SegmentedItem } from "@/lib/checklistEngine";
import { appConfirm, appPrompt } from "@/components/providers/DialogProvider";
import { uploadProjectFile } from "@/lib/projectUpload";
import ProjectFilePlace, { useProjectFileHome } from "@/components/projects/ProjectFilePlace";
import UndoToastHost from "@/components/projects/UndoToastHost";
import { useUndoableActions } from "@/components/projects/useUndoableActions";
import FileThumb from "@/components/ui/FileThumb";
import { tryUpload } from "@/lib/uploadRetry";
import { fileSize } from "@/components/projects/cost/FilePreview";
import { turnoverSource, jobSizeWord } from "@/lib/requirementSource";
import { SourceHelp } from "@/components/projects/NeedParts";
import { InlineAddRow, type AddField } from "@/components/ui/InlineAddRow";
import HelpTooltip from "@/components/ui/HelpTooltip";
import MoreMenu from "@/components/ui/MoreMenu";
import { parseDay } from "@/lib/materials";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { sayError } from "@/components/projects/sayError";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonRows } from "@/components/ui/Skeleton";

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
      setErr(sayError(e));
    } finally { setLoading(false); }
    onDataChanged?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId]);
  useEffect(() => { void refresh(); }, [refresh]);

  if (loading) return <SkeletonRows rows={6} cols={2} what="checklists, turnover and punch list" />;
  // Where quality stands: one number (what's left to close), then where it
  // is, in one small line, before the three lists.
  const punchOpen = punch.filter((i) => i.status === "open").length;
  const tp = computeTurnoverProgress(turnover);
  const lists = checklists.filter((c) => c.status !== "void");
  const listsDone = lists.filter((c) => c.status === "complete").length;
  const left = punchOpen + (tp.required - tp.accepted) + (lists.length - listsDone);
  const anything = lists.length > 0 || turnover.length > 0 || punch.length > 0;
  const parts = [
    `Punch list ${punchOpen ? `${punchOpen} open` : "clear"}`,
    `Turnover ${tp.required ? `${tp.accepted} of ${tp.required} accepted${tp.received ? `, ${tp.received} awaiting review` : ""}` : "none required yet"}`,
    `Checklists ${lists.length ? `${listsDone} of ${lists.length} complete` : "none yet"}`,
  ];

  return (
    <div className="space-y-6">
      <div>
        <p className="text-reading text-[var(--color-text)]">
          {!anything ? "Nothing on quality yet."
            : left ? <><b className="font-display text-title leading-none font-bold tabular-nums">{left}</b> left to close</>
            : "Nothing left to close."}
        </p>
        {anything && <p className="mt-1 text-body text-[var(--color-text-muted)]">{parts.join(" · ")}</p>}
        {err && (
          <div className="mt-3 flex items-start gap-2">
            <ErrorNote compact className="flex-1" title={err} next="" />
            <button onClick={() => setErr(null)} aria-label="Dismiss" className="shrink-0 w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 -mt-1 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
          </div>
        )}
      </div>

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

const quietBtn = "inline-flex items-center gap-1 px-2 py-1 min-h-9 pointer-coarse:min-h-11 rounded text-body font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50";
// Fields: 16 px text, 40 px tall (44 on touch), the 3:1 edge.
const fieldCls = "h-10 pointer-coarse:h-11 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] px-3 text-reading text-[var(--color-text)] ";
const fieldLabel = "block text-caption font-medium text-[var(--color-text-muted)] mb-1";
// A row's next decision (outline), its other actions under More, and a fold.
const rowBtn = "ui-press inline-flex items-center h-9 pointer-coarse:h-11 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50";
const moreBtn = "ui-press inline-flex items-center justify-center w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]";
const foldBtn = "ui-press inline-flex items-center gap-1.5 min-h-8 pointer-coarse:min-h-11 px-2 -mx-2 rounded-md text-body font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]";
// Turnover rows: waiting on review first, then rejected, then not received; done ones last.
const TURNOVER_RANK: Record<TurnoverItem["status"], number> = { received: 0, rejected: 1, open: 2, accepted: 3, waived: 4 };
/** The project's company with this name, as typed or pasted (case aside). */
const companyNamed = (list: CostParty[], name: string) => { const n = name.trim().toLowerCase(); return list.find((p) => p.name.trim().toLowerCase() === n) ?? null; };

// ── Checklists ───────────────────────────────────────────────────────────

function ChecklistsSection({ orgId, projectId, canManage, actor, checklists, onChanged, setErr, announce }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  checklists: Checklist[]; onChanged: () => void; setErr: (m: string | null) => void;
  announce: Announce;
}) {
  const [showNew, setShowNew] = useState(false);
  // Open lists first; complete ones after them.
  const live = checklists.filter((c) => c.status !== "void").sort((a, b) => Number(a.status === "complete") - Number(b.status === "complete"));
  const none = live.length === 0;
  return (
    <section className="min-w-0">
      <div className="flex items-center gap-2 mb-2 min-h-8">
        <h2 className="min-w-0 font-display text-section leading-tight font-semibold text-[var(--color-text)]">Checklists: PSSR, MI, QA/QC</h2>
        <HelpTooltip><span className="font-normal">Upload your PSSR or QA/QC checklist (PDF) with New checklist. It&apos;s read into items you check off.</span></HelpTooltip>
        {canManage && (
          // Orange only while there's none yet and the form isn't open.
          <button onClick={() => setShowNew((v) => !v)} aria-expanded={showNew}
            className={`ml-auto shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-md text-body font-medium transition-colors ${none && !showNew ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]" : showNew ? "bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border-strong)]" : "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
            <Plus className="w-3 h-3" /> New checklist
          </button>
        )}
      </div>
      {/* No clipping here: the new-checklist flow has "?" popovers near its edge. */}
      <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)]">

      {showNew && canManage && (
        <NewChecklistFlow orgId={orgId} projectId={projectId} actor={actor}
          onDone={() => { setShowNew(false); onChanged(); }} onCancel={() => setShowNew(false)} setErr={setErr} />
      )}

      {none ? (
        !showNew && <p className="px-4 py-3 text-body text-[var(--color-text-muted)]">No checklists yet.</p>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {live.map((c) => (
            <ChecklistCard key={c.id} orgId={orgId} projectId={projectId} checklist={c}
              canManage={canManage} actor={actor} onChanged={onChanged} setErr={setErr} announce={announce} />
          ))}
        </div>
      )}
      </div>
    </section>
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
  const [uploading, setUploading] = useState<File | null>(null);
  // A file that didn't go through is kept, so Try again needs no re-picking.
  const [failed, setFailed] = useState<File | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const upload = async (file: File | null | undefined) => {
    if (!file) return;
    setFailed(null);
    if (!home?.place) { setErr("Pick where this project's files go first."); return; }
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { setErr("Upload the checklist as a PDF (in Word or Excel: File › Save As › PDF)."); return; }
    setUploading(file); setErr(null);
    // Once it's filed, Try again would file it twice: only before that.
    let filed = false;
    try {
      // Only the filing is retried: it either files the document or leaves nothing behind.
      const picked = await tryUpload(file.name, async () => {
        const d = await uploadProjectFile({ orgId, projectId, projectName: projectName ?? home?.name ?? "Project", file, prefix: kind === "pssr" ? "PSSR" : kind === "mi" ? "MI" : kind === "qaqc" ? "QAQC" : "CHECKLIST",
          title: file.name.replace(/\.pdf$/i, ""), part, actorUserId: actor.uid, actorEmail: actor.email });
        filed = true;
        return { id: d.documentId, label: d.label };
      }, { onRetried: (p) => { setFailed(null); setErr(null); setDoc(p); void read(p); } });
      setDoc(picked);
      setUploading(null);
      await read(picked);
    } catch (e) { setErr(sayError(e)); if (!filed) setFailed(file); }
    finally { setUploading(null); if (fileRef.current) fileRef.current.value = ""; }
  };
  const [reading, setReading] = useState(false);
  const [proposed, setProposed] = useState<SegmentedItem[] | null>(null);
  // The drop box lights up and says what letting go will do.
  const drag = useFileDrag((fs) => { void upload(fs[0]); }, !!proposed || !!doc || !!uploading || reading);
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
      setErr(sayError(e));
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
    <div className="px-4 py-3 border-b border-[var(--color-border)] space-y-2" {...drag.bind}>
      {!proposed ? (
        <>
          {!doc && (
            <div className={`rounded-xl border-2 border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-3 flex items-center gap-3 flex-wrap ${drag.ring}`}>
              <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={!!uploading || reading || !home?.place}
                className={`h-10 pointer-coarse:h-11 inline-flex items-center gap-1.5 px-3.5 rounded-lg text-body font-medium disabled:opacity-50 ${home?.place ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]" : "border border-[var(--color-border-strong)] text-[var(--color-text)]"}`}>
                {uploading || reading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />} {uploading ? "Uploading…" : reading ? "Reading it…" : `Upload the ${kind === "pssr" ? "PSSR" : "checklist"} (PDF)`}
              </button>
              {(uploading || failed) && (
                <span className="basis-full sm:basis-auto inline-flex items-center gap-2 min-w-0 text-caption">
                  <FileThumb file={(uploading ?? failed)!} size={32} />
                  <span className="min-w-0 truncate text-[var(--color-text)]">{(uploading ?? failed)!.name} <span className="text-[var(--color-text-muted)]">· {fileSize((uploading ?? failed)!.size)}{uploading ? " · uploading…" : " · didn't upload"}</span></span>
                  {failed && !uploading && (
                    <button type="button" onClick={() => void upload(failed)} className="shrink-0 h-8 pointer-coarse:h-11 inline-flex items-center gap-1.5 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-caption font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                      Try again
                    </button>
                  )}
                </span>
              )}
              <span className={`text-body flex-1 min-w-48 inline-flex items-center gap-1.5 ${drag.over ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{drag.over ? drag.say : <>Or drop it here. <HelpTooltip><span className="font-normal">It&apos;s filed where you pick below, then read into items for you to check.</span></HelpTooltip></>}</span>
              <div className="basis-full">
                <ProjectFilePlace orgId={orgId} projectId={projectId} uid={actor.uid} canManage home={home} onChange={setHome} what={kind === "pssr" ? "the PSSR" : "the checklist"} />
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            {doc ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-caption font-medium text-[var(--color-text)]">
                <FileText className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> {doc.label}
                <button onClick={() => setDoc(null)} aria-label={`Remove ${doc.label}`} className="ui-hit text-[var(--color-text-faint)] hover:text-[var(--state-overdue-text)]"><X className="w-3 h-3" /></button>
              </span>
            ) : (
              <span className="relative flex-1 min-w-64">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-faint)]" />
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus aria-label="Find a document in document control"
                  placeholder="Or find one already in document control (number or title)…"
                  className="w-full h-10 pointer-coarse:h-11 pl-8 pr-2 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] text-reading" />
              </span>
            )}
            <select value={kind} onChange={(e) => setKind(e.target.value as ChecklistKind)} aria-label="Kind of list"
              className="h-10 pointer-coarse:h-11 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] px-2 text-reading">
              {(Object.keys(CHECKLIST_KIND_LABEL) as ChecklistKind[]).map((k) => (
                <option key={k} value={k}>{CHECKLIST_KIND_LABEL[k]}</option>
              ))}
            </select>
            <button onClick={() => void read()} disabled={!doc || reading || !!uploading}
              className={`h-10 pointer-coarse:h-11 inline-flex items-center gap-1 px-3 rounded-lg text-body font-medium disabled:opacity-50 transition-colors ${doc ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]" : "border border-[var(--color-border-strong)] text-[var(--color-text)]"}`}
              title="Reads the pages into items you check before anything saves.">
              {reading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} {reading ? "Reading" : "Read it"}
            </button>
            <button onClick={onCancel} className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">Cancel</button>
          </div>
          {results.length > 0 && !doc && (
            <ul className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] overflow-hidden">
              {results.map((d) => (
                <li key={d.id}>
                  <button onClick={() => setDoc(d)} className="w-full px-3 py-1.5 text-left text-caption font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2">
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
            <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="List name"
              className="h-10 pointer-coarse:h-11 flex-1 min-w-48 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] px-3 text-reading font-medium" />
            <span className="text-body text-[var(--color-text-muted)]">Read {doc?.label ?? "it"}: found {proposed.length} item{proposed.length === 1 ? "" : "s"}. Remove any that aren&apos;t real items, then save.</span>
            <button onClick={() => void save()} disabled={saving || proposed.length === 0}
              className="h-10 pointer-coarse:h-11 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-body font-medium hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} {saving ? "Saving" : "Save checklist"}
            </button>
            <button onClick={() => setProposed(null)} className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">Back</button>
          </div>
          <ul className="max-h-72 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)]">
            {proposed.map((p, i) => (
              <li key={i} className="px-3 py-1.5 flex items-start gap-2 text-caption">
                {p.section && <span className="shrink-0 text-body font-medium text-[var(--color-text-faint)] mt-0.5">{p.section}</span>}
                <span className="flex-1 text-[var(--color-text)]">{p.text}</span>
                <button onClick={() => setProposed(proposed.filter((_, j) => j !== i))} aria-label={`Leave out: ${p.text}`}
                  className="ui-hit shrink-0 text-[var(--color-text-faint)] hover:text-[var(--state-overdue-text)]"><X className="w-3 h-3" /></button>
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
    try { setItems(await listChecklistItems(checklist.id)); }
    catch (e) { setErr(`Couldn't load the items: ${sayError(e)}`); setItems([]); }
  }, [checklist.id, setErr]);
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
        title: `Apply the assessment to ${body.proposals.length} items?`,
        message: `${na} look not applicable to this job, with reasons attached. Items you've decided by hand are never touched.`,
        confirmLabel: "Apply assessment",
      }))) return;
      const applied = await applyAssessment({ orgId, projectId, checklistId: checklist.id, proposals: body.proposals, actor });
      setErr(null);
      await loadItems(); onChanged();
      if (applied.skippedHuman > 0) {
        setErr(`Applied ${applied.applied}; left ${applied.skippedHuman} alone because a human already decided them.`);
      }
    } catch (e) {
      setErr(sayError(e));
    } finally { setBusy(null); }
  };

  const sweep = async () => {
    setBusy("sweep"); setErr(null);
    try {
      const res = await runAutoEvidence({ orgId, projectId, checklistId: checklist.id, actor });
      await loadItems(); onChanged();
      setErr(null);
      if (res.satisfied + res.needsEvidence === 0) {
        setErr("Evidence check: nothing new found. Items are done, decided by a person, or need evidence a person attaches.");
      }
    } catch (e) {
      setErr(sayError(e));
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
      confirmLabel: "Remove list", tone: "danger",
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
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full px-4 py-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-left hover:bg-[var(--color-surface-2)]/40 transition-colors">
        <ChevronRight className={`w-4 h-4 shrink-0 text-[var(--color-text-faint)] ui-chevron${(open) ? " rotate-90" : ""}`} />
        <span className="min-w-0 text-body font-medium text-[var(--color-text)]">{checklist.title}</span>
        <span className="text-caption text-[var(--color-text-muted)]">{CHECKLIST_KIND_LABEL[checklist.kind]}</span>
        {checklist.status === "complete" && (
          <span className="inline-flex items-center gap-0.5 text-caption font-medium text-[var(--state-released-text)]"><ShieldCheck className="w-3 h-3" /> Complete</span>
        )}
        {progress && checklist.status === "open" && (
          <span className="ml-auto text-caption font-medium tabular-nums text-[var(--color-text-muted)]">
            {progress.satisfied}/{progress.applicable} satisfied{progress.needsEvidence > 0 ? ` · ${progress.needsEvidence} need evidence` : ""}
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-2">
          {canManage && checklist.status === "open" && (
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => void assess()} disabled={busy != null}
                className="inline-flex items-center gap-1 px-2.5 py-1 pointer-coarse:min-h-11 rounded-lg border border-[var(--color-border-strong)] text-caption font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors"
                title="AI judges which items apply to THIS job, grounded on the project's purpose, SOW, schedule, and documents. You review before it applies.">
                {busy === "assess" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />} Which items apply to this job?
              </button>
              <button onClick={() => void sweep()} disabled={busy != null}
                className="inline-flex items-center gap-1 px-2.5 py-1 pointer-coarse:min-h-11 rounded-lg border border-[var(--color-border-strong)] text-caption font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors"
                title="No AI: marks items satisfied that the record proves (accepted turnover, documents on file), with where it found it; the rest need evidence.">
                {busy === "sweep" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ListChecks className="w-3 h-3" />} {busy === "sweep" ? "Checking evidence" : "Check evidence we already hold"}
              </button>
              <button onClick={() => void remove()} disabled={busy != null} title="Added by mistake? Take it off the list. It stays on the record, with Undo right after."
                className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 pointer-coarse:min-h-11 rounded-lg text-caption font-medium text-[var(--color-text-muted)] hover:text-[var(--state-overdue-text)] hover:bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)] disabled:opacity-50 transition-colors">
                {busy === "remove" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} {busy === "remove" ? "Removing" : "Remove"}
              </button>
              <button onClick={() => void complete()} disabled={busy != null}
                className="inline-flex items-center gap-1 px-2.5 py-1 pointer-coarse:min-h-11 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-caption font-medium hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors">
                {busy === "complete" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />} {busy === "complete" ? "Marking complete" : "Mark complete"}
              </button>
            </div>
          )}
          {canManage && checklist.status === "complete" && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-caption text-[var(--color-text-muted)]">Complete: its items are locked. Reopen it to change one.</span>
              <button onClick={() => void remove()} disabled={busy != null}
                className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 pointer-coarse:min-h-11 rounded-lg text-caption font-medium text-[var(--color-text-muted)] hover:text-[var(--state-overdue-text)] hover:bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)] disabled:opacity-50 transition-colors">
                {busy === "remove" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} {busy === "remove" ? "Removing" : "Remove"}
              </button>
              <button onClick={() => void reopen()} disabled={busy != null}
                className="inline-flex items-center gap-1 px-2.5 py-1 pointer-coarse:min-h-11 rounded-lg border border-[var(--color-border-strong)] text-caption font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">
                {busy === "reopen" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} {busy === "reopen" ? "Reopening" : "Reopen"}
              </button>
            </div>
          )}

          {items == null ? (
            <SkeletonRows rows={4} cols={1} what="the items" sheet={false} />
          ) : (
            <div className="rounded-xl border border-[var(--color-border)] overflow-hidden">
              {sections.map(([section, secItems]) => (
                <div key={section || "_"}>
                  {section && (
                    <div className="px-3 py-1.5 bg-[var(--color-surface-2)]/60 text-body font-medium text-[var(--color-text-muted)]">
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
      const v = await appPrompt({ title: promptNote, message: "Your note marks this item as decided by a person. Automatic checks leave it alone from then on.", placeholder: "Why?" });
      if (v === null) return;
      manualNote = v.trim() || "decided by reviewer";
    }
    setBusy(true);
    const res = await updateChecklistItem({ orgId, projectId, item, patch: { ...patch, ...(manualNote !== undefined ? { manualNote } : {}) }, actor });
    setBusy(false);
    if (!res.ok) setErr(res.error ?? "Couldn't update."); else onChanged();
  };

  return (
    <li className={`px-3 py-2 text-caption ${na ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-2">
        <StatusDot status={na ? "na" : item.status} />
        <div className="min-w-0 flex-1">
          <div className="text-[var(--color-text)]">{item.text}</div>
          {item.aiRationale && (
            <div className="mt-0.5 text-caption text-[var(--color-text-muted)]">
              <span className="font-medium">Assessment:</span> {item.aiRationale}
            </div>
          )}
          {item.manualNote && (
            <div className="mt-0.5 text-caption font-medium text-[var(--color-text)]">
              Human decision{item.updatedByName ? ` (${item.updatedByName})` : ""}: {item.manualNote}
            </div>
          )}
          {item.evidence.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {item.evidence.map((e, i) => (
                <span key={i} className={`text-caption font-medium px-1.5 py-0.5 rounded border ${e.source === "auto" ? "border-[var(--state-released)] bg-[var(--state-released)]/[0.07] text-[var(--state-released-text)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface-2)] text-[var(--color-text)]"}`}
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
                className="px-1.5 py-0.5 pointer-coarse:min-h-11 rounded text-caption font-medium text-[var(--state-released-text)] hover:bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)]" title="Mark satisfied with your note on the record">✓ Satisfied</button>
            )}
            {!na && item.status === "satisfied" && (
              // One tap back to open. It stays human-decided, so the
              // evidence sweep won't green it again on its own.
              <button onClick={() => void override({ status: "open", manualNote: "Satisfied taken back: not done yet" }, null)}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 pointer-coarse:min-h-11 rounded text-caption font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]" title="Not satisfied after all - back to open">
                <RotateCcw className="w-3 h-3" /> Undo satisfied
              </button>
            )}
            {!na && (
              <button onClick={() => void override({ applicability: "na", status: "na" }, "Mark not applicable")}
                className="px-1.5 py-0.5 pointer-coarse:min-h-11 rounded text-caption font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]" title="Not applicable to this job. Your reason goes on the record.">N/A</button>
            )}
            {na && (
              <button onClick={() => void override({ applicability: "applies", status: "open" }, "Reopen this item")}
                className="px-1.5 py-0.5 pointer-coarse:min-h-11 rounded text-caption font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">Reopen</button>
            )}
          </span>
        )}
        {busy && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-text-muted)] shrink-0" />}
      </div>
    </li>
  );
}

function StatusDot({ status }: { status: ChecklistItem["status"] }) {
  const map: Record<string, { c: string; t: string }> = {
    satisfied: { c: "bg-[var(--state-released)]", t: "Satisfied: evidence attached" },
    needs_evidence: { c: "bg-[var(--state-held)]", t: "Needs evidence: nothing on file proves it yet" },
    open: { c: "bg-[var(--color-text-faint)]", t: "Open: not checked against evidence yet" },
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
  // Accepted and waived documents fold away under the ones still owed.
  const [showSettled, setShowSettled] = useState(false);
  const progress = useMemo(() => computeTurnoverProgress(items), [items]);
  const tz = useScheduleTz();
  const usual = seedsForJobKind(jobKind).length;
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
      confirmLabel: "Reopen item",
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

  const sorted = [...items].sort((a, b) => TURNOVER_RANK[a.status] - TURNOVER_RANK[b.status] || Number(b.required) - Number(a.required));
  const owed = sorted.filter((i) => i.status !== "accepted" && i.status !== "waived");
  const settled = sorted.filter((i) => i.status === "accepted" || i.status === "waived");
  const companies = parties.filter((p) => p.status !== "inactive");

  // Add like a spreadsheet: the document, what it is, who owes it.
  const addOne = async (name: string, description: string, owes: string): Promise<string | undefined> => {
    const party = owes ? companyNamed(companies, owes) : null;
    if (owes && !party) return `No company named \u201c${owes}\u201d on this project. Pick one from the list, or leave it blank.`;
    const r = await addTurnoverItem({ orgId, projectId, name, description: description || null, partyId: party?.id ?? null, actor });
    return r.ok ? undefined : r.error ?? "It wasn't added. Try again.";
  };
  const addFields: AddField[] = [
    { key: "name", label: "Document", required: true, width: "w-full sm:min-w-0 md:flex-1" },
    { key: "description", label: "What it is", width: "w-full sm:min-w-0 md:w-56 md:shrink-0" },
    ...(companies.length ? [{ key: "owes", label: "Who owes it", list: companies.map((p) => p.name), width: "w-full sm:min-w-0 md:w-44 md:shrink-0" }] : []),
  ];
  const onAdd = async (v: Record<string, string>) => { const m = await addOne(v.name, v.description, v.owes ?? ""); if (!m) onChanged(); return m; };
  const onPasteRows = async (rows: string[][]) => {
    const named = rows.filter((r) => (r[0] ?? "").trim());
    let added = 0, miss: string | null = null;
    for (const [name = "", description = "", owes = ""] of named) {
      const m = await addOne(name.trim(), description.trim(), companies.length ? owes.trim() : "");
      if (m) miss = miss ?? `${name.trim()}: ${m}`; else added++;
    }
    onChanged();
    return added === rows.length ? undefined : `Added ${added} of ${rows.length}.${miss ? ` ${miss}` : rows.length > named.length ? " Rows with no document name were left out." : ""}`;
  };

  const row = (it: TurnoverItem) => {
    if (editing === it.id) return (
      <li key={it.id} className="px-4 py-3">
        <TurnoverEditor item={it} parties={parties} actor={actor} setErr={setErr}
          onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />
      </li>
    );
    const done = it.status === "accepted" || it.status === "waived";
    // The one decision that comes next stays in sight; the rest are under More.
    const next = it.status === "open" ? { label: "Received", status: "received" as const }
      : it.status === "received" || it.status === "rejected" ? { label: "Accept", status: "accepted" as const } : null;
    const more = [
      { icon: <Paperclip className="w-4 h-4" />, label: it.documentId ? "Change document" : "Attach document", onClick: () => setAttaching(attaching === it.id ? null : it.id) },
      { icon: <Pencil className="w-4 h-4" />, label: "Edit", onClick: () => setEditing(it.id) },
      ...(it.status === "received" ? [{ icon: <X className="w-4 h-4" />, label: "Reject", tone: "bad" as const, onClick: () => review(it, "rejected") }] : []),
      ...(it.status === "open" || it.status === "received" ? [{ icon: <Ban className="w-4 h-4" />, label: "Waive", onClick: () => review(it, "waived") }] : []),
      ...(done ? [{ icon: <RotateCcw className="w-4 h-4" />, label: "Reopen", onClick: () => reopen(it) }] : []),
    ];
    const meta = [
      it.partyId ? partyName.get(it.partyId) ?? null : null,
      it.description,
      it.reviewedByName ? `${it.status} by ${it.reviewedByName}${it.reviewedAt ? ` on ${new Date(it.reviewedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}` : null,
      it.reviewNote ? `\u201c${it.reviewNote}\u201d` : null,
    ].filter(Boolean).join(" · ");
    return (
      <li key={it.id} className="px-4 py-2.5 text-body">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap">
              <span className={`font-medium ${done ? "text-[var(--color-text-muted)]" : "text-[var(--color-text)]"}`}>{it.name}</span>
              {!it.required && <span className="text-caption text-[var(--color-text-muted)]">optional</span>}
              <TurnoverChip status={it.status} />
            </div>
            {(meta || it.documentId) && (
              <div className="mt-0.5 text-body text-[var(--color-text-muted)]">
                {it.documentId && (docs.get(it.documentId)
                  ? <Link href={docs.get(it.documentId)!.href} className="inline-flex items-center gap-1 font-medium text-[var(--color-accent-text)] hover:underline"><Paperclip className="w-3.5 h-3.5" /> {docs.get(it.documentId)!.label}</Link>
                  : <span className="inline-flex items-center gap-1"><Paperclip className="w-3.5 h-3.5" /> document attached</span>)}
                {it.documentId && meta ? " · " : null}{meta}
              </div>
            )}
          </div>
          {canManage && (busy === it.id
            ? <Loader2 className="w-4 h-4 mt-1 animate-spin text-[var(--color-text-muted)] shrink-0" />
            : <span className="shrink-0 flex items-center gap-1">
                {next && <button onClick={() => void review(it, next.status)} className={rowBtn}>{next.label}</button>}
                <MoreMenu iconOnly label={`More for ${it.name}`} items={more} triggerClass={moreBtn} />
              </span>)}
        </div>
        {attaching === it.id && canManage && (
          <DocPicker orgId={orgId} busy={busy === it.id}
            onPick={(d) => void attach(it, d)}
            onClear={it.documentId ? () => void attach(it, null) : undefined}
            onCancel={() => setAttaching(null)} />
        )}
      </li>
    );
  };

  return (
    <section className="min-w-0">
      <div className="flex items-center gap-2 mb-2 min-h-8 flex-wrap">
        <h2 className="font-display text-section leading-tight font-semibold text-[var(--color-text)]">Turnover package: QA/QC sign-off</h2>
        {/* Where this list came from (the app's default, or set for this project), behind the "?". */}
        <SourceHelp source={turnoverSource(items, null)} tz={tz}>The quality documents this job needs, each from not received to accepted, with the reviewer&rsquo;s name on the record.</SourceHelp>
        {progress.required > 0 && (
          <span className="text-body tabular-nums text-[var(--color-text-muted)]">
            {progress.accepted} of {progress.required} accepted{progress.received > 0 ? `, ${progress.received} awaiting review` : ""}
          </span>
        )}
        {canManage && (
          <button onClick={() => void seed()} disabled={busy != null}
            className="ml-auto inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors"
            title={`Adds the usual documents for a ${jobSizeWord(jobKind).toLowerCase()} (the ones already here are kept).`}>
            {busy === "seed" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Add the usual list ({usual} for a {jobSizeWord(jobKind).toLowerCase()})
          </button>
        )}
      </div>
      {/* No clipping here: the document picker has a "?" popover. */}
      <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)]">
        {canManage && (
          <div className="px-4 pt-3 border-b border-[var(--color-border)]">
            <InlineAddRow fields={addFields} onAdd={onAdd} onPasteRows={onPasteRows} what="document" />
          </div>
        )}
        {items.length === 0 ? (
          <p className="px-4 py-3 text-body text-[var(--color-text-muted)]">Nothing required yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {owed.map(row)}
            {settled.length > 0 && (
              <li className="px-4 py-1.5">
                <button onClick={() => setShowSettled((v) => !v)} aria-expanded={showSettled} className={foldBtn}>
                  <ChevronRight className={`w-4 h-4 transition-transform ${showSettled ? "rotate-90" : ""}`} />
                  {[settled.filter((i) => i.status === "accepted").length, settled.filter((i) => i.status === "waived").length].map((n, i) => n ? `${n} ${i ? "waived" : "accepted"}` : null).filter(Boolean).join(", ")}
                </button>
              </li>
            )}
            {showSettled && settled.map(row)}
          </ul>
        )}
      </div>
    </section>
  );
}

function TurnoverChip({ status }: { status: TurnoverItem["status"] }) {
  const tone = status === "accepted" ? "is-good" : status === "received" ? "" : status === "rejected" ? "is-bad" : status === "waived" ? "is-muted" : "is-warn";
  return <span className={`ui-pill ${tone}`}>{TURNOVER_STATUS_LABEL[status]}</span>;
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
    <div className="space-y-3 text-body">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <label className="block min-w-0"><span className={fieldLabel}>Document</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className={`${fieldCls} w-full font-medium`} /></label>
        {pick.length > 0 && (
          <label className="block min-w-0"><span className={fieldLabel}>Who owes it</span>
            <select value={partyId} onChange={(e) => setPartyId(e.target.value)} className={`${fieldCls} w-full`}>
              <option value="">Any contractor</option>
              {pick.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
        )}
      </div>
      <label className="block"><span className={fieldLabel}>What it is</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="In plain words" className={`${fieldCls} w-full`} /></label>
      <label className="inline-flex items-center gap-2 min-h-10 pointer-coarse:min-h-11 text-body font-medium text-[var(--color-text)]">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="w-4 h-4" /> Required for this job
      </label>
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">Cancel</button>
        <button onClick={() => void save()} disabled={saving}
          className="h-10 pointer-coarse:h-11 inline-flex items-center gap-1 px-3.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-body font-medium hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} {saving ? "Saving" : "Save"}
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
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus aria-label="Find the submitted document" placeholder="Find the submitted document (by number or title)…"
            className="w-full h-10 pointer-coarse:h-11 pl-8 pr-2 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] text-reading" />
        </span>
        {onClear && <button onClick={onClear} disabled={busy} className={quietBtn}>Take it off</button>}
        <button onClick={onCancel} className={quietBtn}>Cancel</button>
      </div>
      {shown.length > 0 && (
        <ul className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] overflow-hidden">
          {shown.map((d) => (
            <li key={d.id}>
              <button onClick={() => onPick(d)} disabled={busy} className="w-full px-3 py-2 text-left text-caption font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center gap-2 disabled:opacity-50">
                <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> {d.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="text-body text-[var(--color-text-muted)] inline-flex items-center gap-1.5">From document control. <HelpTooltip><span className="font-normal">A submission through the contractor&apos;s link lands there once it&apos;s approved under Intake.</span></HelpTooltip></div>
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
  const [busy, setBusy] = useState<string | null>(null);
  // The item being edited in place, and whether the closed ones are shown.
  const [editing, setEditing] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  // Captured once at mount — render stays pure.
  const [now] = useState(() => Date.now());
  const partyName = useMemo(() => new Map(parties.map((p) => [p.id, p.name])), [parties]);
  // Companies taken off the job aren't offered for new items.
  const pickParties = parties.filter((p) => p.status !== "inactive");
  // Overdue starts AFTER the due day ends, in the viewer's timezone — an
  // item due today is due, not late.
  const overdue = (it: PunchItem) => it.status === "open" && !!it.dueDate && new Date(`${it.dueDate}T23:59:59`).getTime() < now;
  // Late first, then by due date; done and void fold under them.
  const open = items.filter((i) => i.status === "open").sort((a, b) => Number(overdue(b)) - Number(overdue(a)) || (a.dueDate ?? "9").localeCompare(b.dueDate ?? "9"));
  const closed = items.filter((i) => i.status !== "open");

  // Add like a spreadsheet: what, where, due, contractor.
  const addOne = async (title: string, location: string, due: string, contractor: string): Promise<string | undefined> => {
    const dueDate = due ? parseDay(due, `${new Date().getFullYear()}-01-01`) : null;
    if (due && !dueDate) return `\u201c${due}\u201d isn't a date. Type the due date as month/day/year.`;
    const party = contractor ? companyNamed(pickParties, contractor) : null;
    if (contractor && !party) return `No company named \u201c${contractor}\u201d on this project. Pick one from the list, or leave it blank.`;
    const res = await addPunchItem({ orgId, projectId, title, dueDate, location: location || null, partyId: party?.id ?? null, actor });
    return res.ok ? undefined : res.error ?? "It wasn't added. Try again.";
  };
  const cols = [
    { key: "title", label: "Punch item", required: true, placeholder: "Reinstall insulation at E-301 north nozzle", width: "w-full sm:min-w-0 md:flex-1" },
    { key: "location", label: "Where", width: "w-full sm:min-w-0 md:w-36 md:shrink-0" },
    { key: "due", label: "Due", type: "date" as const, width: "w-full sm:min-w-0 md:w-40 md:shrink-0" },
    ...(pickParties.length ? [{ key: "contractor", label: "Contractor", list: pickParties.map((p) => p.name), width: "w-full sm:min-w-0 md:w-40 md:shrink-0" }] : []),
  ];
  const addFields: AddField[] = cols;
  const onAdd = async (v: Record<string, string>) => { const m = await addOne(v.title, v.location, v.due, v.contractor ?? ""); if (!m) onChanged(); return m; };
  const onPasteRows = async (rows: string[][]) => {
    const named = rows.filter((r) => (r[0] ?? "").trim());
    let added = 0, miss: string | null = null;
    for (const [title = "", location = "", due = "", contractor = ""] of named) {
      const m = await addOne(title.trim(), location.trim(), due.trim(), pickParties.length ? contractor.trim() : "");
      if (m) miss = miss ?? `${title.trim()}: ${m}`; else added++;
    }
    onChanged();
    return added === rows.length ? undefined : `Added ${added} of ${rows.length}.${miss ? ` ${miss}` : rows.length > named.length ? " Rows with nothing in the first column were left out." : ""}`;
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
      confirmLabel: "Void item", tone: "danger",
    }))) return;
    if (await setStatus(it, "void")) {
      announce(`Voided "${it.title}".`, async () => {
        const r = await setPunchStatus({ item: { ...it, status: "void" }, status: "open", actor });
        if (!r.ok) throw new Error(r.error ?? "couldn't reopen it");
        onChanged();
      });
    }
  };

  const row = (it: PunchItem) => {
    if (editing === it.id) return (
      <li key={it.id} className="px-4 py-3">
        <PunchEditor item={it} parties={parties} people={people} actor={actor} setErr={setErr}
          onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />
      </li>
    );
    const isOpen = it.status === "open";
    const late = overdue(it);
    const meta = [
      it.location,
      it.assignee ? `on it: ${it.assignee}` : null,
      it.partyId ? partyName.get(it.partyId) ?? null : null,
      it.createdByName ? `by ${it.createdByName}` : null,
    ].filter(Boolean).join(" · ");
    return (
      <li key={it.id} className="px-4 py-2.5 flex items-start gap-2 text-body">
        <span className={`ui-pill mt-0.5 ${it.status === "done" ? "is-good" : it.status === "void" ? "is-muted" : late ? "is-bad" : "is-warn"}`}>{it.status === "done" ? "Done" : it.status === "void" ? "Void" : late ? "Late" : "Open"}</span>
        <div className="min-w-0 flex-1">
          <div className={isOpen ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}>{it.title}</div>
          {(meta || (it.dueDate && isOpen)) && (
            <div className="text-body text-[var(--color-text-muted)]">
              {it.dueDate && isOpen && <span className={late ? "font-medium text-[var(--state-overdue-text)]" : ""}>due {new Date(it.dueDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}{late ? ", overdue" : ""}</span>}
              {it.dueDate && isOpen && meta ? " · " : null}{meta}
            </div>
          )}
        </div>
        {canManage && (busy === it.id
          ? <Loader2 className="w-4 h-4 mt-1 animate-spin text-[var(--color-text-muted)] shrink-0" />
          : isOpen
            ? <span className="shrink-0 flex items-center gap-1">
                <button onClick={() => void setStatus(it, "done")} className={rowBtn}>Done</button>
                <MoreMenu iconOnly label={`More for ${it.title}`} triggerClass={moreBtn} items={[
                  { icon: <Pencil className="w-4 h-4" />, label: "Edit", onClick: () => setEditing(it.id) },
                  { icon: <Ban className="w-4 h-4" />, label: "Void: not a real snag", tone: "bad", onClick: () => voidItem(it) },
                ]} />
              </span>
            : <button onClick={() => void setStatus(it, "open")} className={`shrink-0 ${quietBtn}`} title="Back on the open list">
                <RotateCcw className="w-3.5 h-3.5" /> Reopen
              </button>)}
      </li>
    );
  };

  return (
    <section className="min-w-0">
      <div className="flex items-center gap-2 mb-2 min-h-8">
        <h2 className="font-display text-section leading-tight font-semibold text-[var(--color-text)]">Punch list</h2>
        <span className="text-body tabular-nums text-[var(--color-text-muted)]">
          {open.length ? <><b className="font-semibold text-[var(--color-text)]">{open.length}</b> open{open.filter(overdue).length ? <>, <b className="font-semibold text-[var(--state-overdue-text)]">{open.filter(overdue).length}</b> overdue</> : null}</> : items.length ? "nothing open" : null}
        </span>
      </div>
      <div className="bg-[var(--color-surface)] rounded-lg overflow-hidden border border-[var(--color-border)]">
        {canManage && (
          <div className="px-4 pt-3 border-b border-[var(--color-border)]">
            <InlineAddRow fields={addFields} onAdd={onAdd} onPasteRows={onPasteRows} what="punch item" draftKey={`punch-add:${projectId}`} />
          </div>
        )}
        {items.length === 0 ? (
          <p className="px-4 py-3 text-body text-[var(--color-text-muted)]">Nothing on the punch list.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {open.map(row)}
            {closed.length > 0 && (
              <li className="px-4 py-1.5">
                <button onClick={() => setShowClosed((v) => !v)} aria-expanded={showClosed} className={foldBtn}>
                  <ChevronRight className={`w-4 h-4 transition-transform ${showClosed ? "rotate-90" : ""}`} />
                  {[closed.filter((i) => i.status === "done").length, closed.filter((i) => i.status === "void").length].map((n, i) => n ? `${n} ${i ? "void" : "done"}` : null).filter(Boolean).join(", ")}
                </button>
              </li>
            )}
            {showClosed && closed.map(row)}
          </ul>
        )}
      </div>
    </section>
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
    <div className="space-y-3 text-body">
      <label className="block"><span className={fieldLabel}>Punch item</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus className={`${fieldCls} w-full`} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block min-w-0"><span className={fieldLabel}>Where</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} className={`${fieldCls} w-full`} /></label>
        <label className="block min-w-0"><span className={fieldLabel}>Due</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`${fieldCls} w-full [color-scheme:light] dark:[color-scheme:dark]`} /></label>
        <label className="block min-w-0"><span className={fieldLabel}>Who&apos;s on it</span>
          <input value={assignee} onChange={(e) => setAssignee(e.target.value)} list={listId} className={`${fieldCls} w-full`} /></label>
        <datalist id={listId}>{people.map((p) => <option key={p} value={p} />)}</datalist>
        {pick.length > 0 && (
          <label className="block min-w-0"><span className={fieldLabel}>Contractor</span>
            <select value={partyId} onChange={(e) => setPartyId(e.target.value)} className={`${fieldCls} w-full`}>
              <option value="">No contractor</option>
              {pick.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">Cancel</button>
        <button onClick={() => void save()} disabled={saving}
          className="h-10 pointer-coarse:h-11 inline-flex items-center gap-1 px-3.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-body font-medium hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} {saving ? "Saving" : "Save"}
        </button>
      </div>
    </div>
  );
}
