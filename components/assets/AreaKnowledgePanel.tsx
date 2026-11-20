"use client";

// AreaKnowledgePanel — one operating area's knowledge, owned from its own
// page. Three jobs in one card:
//
//   1. ORDER OF OPERATIONS, live: file drawings → connect the area's
//      knowledge → deep read (flows / equipment / plot) → link equipment
//      files. Each step shows real state and launches its tool — the user
//      never has to remember the sequence.
//   2. THE SETUP WIZARD: creates (or picks) this unit's knowledge library
//      and links its folders across the type-first doc-control libraries
//      (PFDs/<unit>, P&IDs/<unit>, Plot Plans/<unit>…) — with the unit's
//      folders AUTO-SUGGESTED by name/code and pre-checked. One confirm:
//      library created, sources linked, first sync run, area bound.
//   3. DRIFT REVIEW: when doc control is reorganized after linking (folder
//      deleted, docs moved out, a new unit-named folder appears), the card
//      says so ON OPEN — before the next sync silently acts on it.
//
// Revisions, deletions, and new files inside watched folders need none of
// this: the source sync handles them automatically.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  BrainCircuit, Loader2, AlertTriangle, Check, ChevronRight, X, Sparkles,
  FolderOpen, BookOpen, RefreshCw, Plus, Trash2, FileText, ExternalLink,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  createKnowledgeLibrary, addKnowledgeSources, syncKnowledgeSources,
  removeKnowledgeSource, browseKnowledgeContainers, type SourceBrowseResult,
} from "@/lib/knowledge";
import { listProcessFlows } from "@/lib/processFlows";

/** Bind the area server-side — the same controller bar as every other
 *  knowledge mutation, and a denied write is a loud error, never a silent
 *  zero-row update. */
async function bindAreaLibrary(orgId: string, unitCode: string, knowledgeLibraryId: string | null): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch("/api/area/knowledge-status", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token ?? ""}`,
    },
    body: JSON.stringify({ orgId, unitCode, knowledgeLibraryId }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
}

interface AreaStatus {
  unit: { code: string; label: string };
  boundLibrary: { id: string; name: string } | null;
  knowledgeLibraries: Array<{ id: string; name: string }>;
  sources: Array<{ id: string; type: "library" | "folder"; sourceId: string; name: string }>;
  counts: { ready: number; pending: number };
  drift: {
    deadSources: Array<{ id: string; sourceName: string }>;
    movedOut: Array<{ kdocId: string; name: string }>;
    movedOutTotal: number;
    newMatches: Array<{ id: string; name: string; libraryName: string; pathNames: string[]; docCount: number }>;
  };
  suggestions: Array<{ id: string; name: string; libraryName: string; pathNames: string[]; docCount: number }>;
  canManage: boolean;
}

export function AreaKnowledgePanel({ orgId, userId, userName, unit, unitAssetIds }: {
  orgId: string;
  userId: string;
  userName: string;
  unit: { code: string; label: string };
  unitAssetIds: string[];
}) {
  const [status, setStatus] = useState<AreaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [note, setNoteState] = useState<{ text: string; bad: boolean } | null>(null);
  const setNote = (text: string | null, bad = false) => setNoteState(text ? { text, bad } : null);
  const [countsFailed, setCountsFailed] = useState(false);

  // Client-side deep-read signals — RLS lets any member count them.
  const [flowCount, setFlowCount] = useState<number | null>(null);
  const [docLinkCount, setDocLinkCount] = useState<number | null>(null);
  const [plotMarkCount, setPlotMarkCount] = useState<number | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `/api/area/knowledge-status?orgId=${encodeURIComponent(orgId)}&unitCode=${encodeURIComponent(unit.code)}`,
        { headers: { Authorization: `Bearer ${session?.access_token ?? ""}` } },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Couldn't load the area's knowledge status.");
      setStatus(json as AreaStatus);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [orgId, unit.code]);
  useEffect(() => { void loadStatus(); }, [loadStatus]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setCountsFailed(false);
      const assetSet = new Set(unitAssetIds);
      const flows = await listProcessFlows(orgId);
      if (alive && flows) {
        setFlowCount(flows.filter((f) =>
          f.status === "confirmed" && (
            (f.from_kind === "unit" && f.from_ref === unit.code) ||
            (f.to_kind === "unit" && f.to_ref === unit.code) ||
            (f.from_kind === "asset" && assetSet.has(f.from_ref)) ||
            (f.to_kind === "asset" && assetSet.has(f.to_ref))
          )).length);
      } else if (alive) setFlowCount(0);
      if (unitAssetIds.length > 0) {
        // Chunked over EVERY asset (no 1,000-asset display cap), and each
        // chunk's links are paged — a checklist that says "12 documents
        // linked" must mean 12, not "12 among the slice we looked at".
        const docIds = new Set<string>();
        for (let i = 0; i < unitAssetIds.length; i += 200) {
          const chunk = unitAssetIds.slice(i, i + 200);
          for (let from = 0; ; from += 1000) {
            const { data: links, error: le } = await supabase.from("document_assets")
              .select("document_id").in("asset_id", chunk)
              .order("document_id").range(from, from + 999);
            if (le) throw new Error(le.message);
            for (const l of links ?? []) docIds.add(l.document_id as string);
            if (!links || links.length < 1000 || from >= 20000) break;
          }
        }
        if (alive) setDocLinkCount(docIds.size);
      } else if (alive) setDocLinkCount(0);
      // Every plot plan, paged — the old .limit(50) undercounted markers on
      // sites with more than 50 plans.
      let marks = 0;
      for (let from = 0; ; from += 100) {
        const { data: plots, error: pe } = await supabase.from("plot_plans")
          .select("markers").eq("org_id", orgId)
          .order("id").range(from, from + 99);
        if (pe) throw new Error(pe.message);
        for (const p of plots ?? []) {
          for (const mk of ((p.markers as Array<{ assetId?: string }> | null) ?? [])) {
            if (mk.assetId && assetSet.has(mk.assetId)) marks++;
          }
        }
        if (!plots || plots.length < 100 || from >= 2000) break;
      }
      if (alive) setPlotMarkCount(marks);
    })().catch(() => { if (alive) { setCountsFailed(true); setFlowCount((c) => c ?? 0); setDocLinkCount((c) => c ?? 0); setPlotMarkCount((c) => c ?? 0); } });
    return () => { alive = false; };
  }, [orgId, unit.code, unitAssetIds]);

  const syncNow = async () => {
    if (!status?.boundLibrary) return;
    setSyncing(true); setNote(null);
    try {
      const r = await syncKnowledgeSources(orgId, status.boundLibrary.id);
      await loadStatus();
      setNote(r.added > 0
        ? `Synced: ${r.added} new document${r.added === 1 ? "" : "s"} pulled in.`
        : "Synced: up to date.");
    } catch (e) { setNote(`Sync didn't finish: ${(e as Error).message}`, true); }
    finally { setSyncing(false); }
  };

  const linkNewMatch = async (folderId: string, name: string) => {
    if (!status?.boundLibrary) return;
    setSyncing(true); setNote(null);
    try {
      const r = await addKnowledgeSources(orgId, status.boundLibrary.id, [{ type: "folder", id: folderId }]);
      await loadStatus();
      setNote(`Linked “${name}”: ${r.added} document${r.added === 1 ? "" : "s"} pulled in.`);
    } catch (e) { setNote(`Couldn't link “${name}”: ${(e as Error).message}`, true); }
    finally { setSyncing(false); }
  };

  const dropDeadSource = async (sourceId: string) => {
    setSyncing(true); setNote(null);
    try {
      await removeKnowledgeSource(orgId, sourceId);
      await loadStatus();
      setNote("Removed the link to the deleted folder.");
    } catch (e) { setNote(`Couldn't remove the link: ${(e as Error).message}`, true); }
    finally { setSyncing(false); }
  };

  const drift = status?.drift;
  const hasDrift = !!drift && (drift.deadSources.length > 0 || drift.movedOutTotal > 0 || drift.newMatches.length > 0);
  // Only LOSS conditions force "needs review" — a new matching folder is an
  // invitation, not a defect, and must not hold step 2 hostage forever.
  const needsReview = !!drift && (drift.deadSources.length > 0 || drift.movedOutTotal > 0);
  const knowledgeDone = !!status?.boundLibrary && status.sources.length > 0 && !needsReview;
  const drawingsDone = status
    ? (status.boundLibrary
        ? status.counts.ready + status.counts.pending > 0
        : status.suggestions.some((s) => s.docCount > 0))
    : false;

  const scrollToFlows = () => {
    document.getElementById("area-flow-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const Step = ({ n, title, state, children, action }: {
    n: number; title: string;
    state: "done" | "review" | "todo" | "loading";
    children: React.ReactNode;
    action?: React.ReactNode;
  }) => (
    <div className="flex items-start gap-3 py-2.5">
      <span className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[11px] font-semibold mt-0.5 ${
        state === "done" ? "bg-emerald-500 text-white"
        : state === "review" ? "bg-amber-400 text-amber-950"
        : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border border-[var(--color-border-strong)]"
      }`}>
        {state === "done" ? <Check className="w-3.5 h-3.5" /> : state === "loading" ? <Loader2 className="w-3 h-3 animate-spin" /> : n}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-semibold text-[var(--color-text)]">{title}</span>
          {state === "review" && (
            <span className="text-[13px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300">
              needs review
            </span>
          )}
        </div>
        <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5">{children}</div>
      </div>
      {action && <div className="shrink-0 mt-0.5">{action}</div>}
    </div>
  );

  return (
    <section className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-4 sm:p-5"
      style={{ animation: "rise 0.4s var(--ease-fluid) both" }}>
      <div className="flex items-center gap-2.5 mb-1">
        <span className="w-8 h-8 rounded-[10px] bg-[var(--color-surface-2)] flex items-center justify-center shrink-0">
          <BrainCircuit className="w-4 h-4 text-[var(--color-text-muted)]" />
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-[13px] font-semibold text-[var(--color-text-muted)]">This area&apos;s knowledge</h2>
          <div className="text-[13px] text-[var(--color-text-muted)]">
            {status?.boundLibrary ? (
              <>
                Backed by <Link href={`/knowledge/${status.boundLibrary.id}`} className="text-[var(--color-accent-text)] dark:text-[var(--color-text)] hover:underline">{status.boundLibrary.name}</Link>
                {" · "}{status.counts.ready} readable{status.counts.pending > 0 ? ` · ${status.counts.pending} indexing` : ""}
                {" · "}{status.sources.length} watched source{status.sources.length === 1 ? "" : "s"}
              </>
            ) : "Four steps to set up this area. Each one shows where it stands."}
          </div>
        </div>
        {status?.boundLibrary && status.canManage && (
          <button type="button" onClick={() => void syncNow()} disabled={syncing}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[13px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)] disabled:opacity-50 shrink-0">
            <RefreshCw className={`w-3 h-3 ${syncing ? "animate-spin" : ""}`} /> Sync
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-1 flex items-start gap-2 border-l-2 border-rose-500 pl-2.5 text-[13px] text-rose-700 dark:text-rose-300">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Couldn&apos;t load this area&apos;s knowledge: {error} <button type="button" onClick={() => void loadStatus()} className="font-bold underline">Try again</button></span>
        </p>
      )}
      {note && (
        <p role={note.bad ? "alert" : "status"} className={`mt-1 border-l-2 pl-2.5 text-[13px] font-bold ${note.bad ? "border-rose-500 text-rose-700 dark:text-rose-300" : "border-emerald-500 text-emerald-700 dark:text-emerald-300"}`}>
          {note.text}
        </p>
      )}
      {countsFailed && (
        <p className="mt-1 border-l-2 border-amber-500 pl-2.5 text-[13px] text-amber-800 dark:text-amber-300">
          Couldn&apos;t count every link and marker, so the numbers in step 3 may be low.
        </p>
      )}

      {/* Drift — doc control was reorganized after linking. Said HERE, on
          open, with the fix one click away — never a silent sync surprise. */}
      {hasDrift && drift && (
        <div className="mt-2 border-l-2 border-amber-500 pl-3 py-0.5 space-y-1.5 text-[13px] text-amber-900 dark:text-amber-300">
          <div className="font-semibold flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" /> Document control changed since this area was linked
          </div>
          {drift.deadSources.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate">Watched folder no longer exists: <b>{s.sourceName}</b></span>
              {status?.canManage && (
                <button type="button" onClick={() => void dropDeadSource(s.id)} disabled={syncing}
                  className="inline-flex items-center gap-1 text-[13px] font-semibold px-2 py-0.5 rounded-md border border-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/50 disabled:opacity-50">
                  <Trash2 className="w-3 h-3" /> Remove link
                </button>
              )}
            </div>
          ))}
          {drift.movedOutTotal > 0 && (
            <div>
              {drift.movedOutTotal} document{drift.movedOutTotal === 1 ? " was" : "s were"} moved out of the
              watched folders ({drift.movedOut.slice(0, 3).map((d) => d.name).join(", ")}
              {drift.movedOutTotal > 3 ? "…" : ""}). The next sync will drop {drift.movedOutTotal === 1 ? "it" : "them"} from
              this area&apos;s knowledge. Link {drift.movedOutTotal === 1 ? "its" : "their"} new folder below to keep {drift.movedOutTotal === 1 ? "it" : "them"}.
            </div>
          )}
          {drift.newMatches.map((f) => (
            <div key={f.id} className="flex items-center gap-2">
              <FolderOpen className="w-3 h-3 shrink-0" />
              <span className="flex-1 min-w-0 truncate">
                New folder looks like this area&apos;s: <b>{f.libraryName} / {f.pathNames.join(" / ")}</b> · {f.docCount} doc{f.docCount === 1 ? "" : "s"}
              </span>
              {status?.canManage && (
                <button type="button" onClick={() => void linkNewMatch(f.id, f.name)} disabled={syncing}
                  className="inline-flex items-center gap-1 text-[13px] font-semibold px-2 py-0.5 rounded-md border border-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/50 disabled:opacity-50">
                  <Plus className="w-3 h-3" /> Link
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* The order of operations, live. */}
      <div className="mt-1 divide-y divide-[var(--color-border)]/50">
        <Step n={1} title="File this area's drawings in Documents"
          state={status === null ? "loading" : drawingsDone ? "done" : "todo"}>
          Type-first folders work best: <b>PFDs / {unit.label}</b>, <b>P&amp;IDs / {unit.label}</b>, <b>Plot Plans / {unit.label}</b>.
          {" "}<Link href="/documents" className="font-bold text-[var(--color-text)] underline underline-offset-2">Open Documents <ExternalLink className="w-2.5 h-2.5 inline" /></Link>
        </Step>
        <Step n={2} title="Connect the area's knowledge"
          state={status === null ? "loading" : knowledgeDone ? "done" : needsReview ? "review" : "todo"}
          action={status?.canManage ? (
            <button type="button" onClick={() => setWizardOpen(true)}
              className="inline-flex items-center gap-1 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] text-[13px] font-bold">
              {status?.boundLibrary ? "Review links" : "Set up"} <ChevronRight className="w-3 h-3" />
            </button>
          ) : undefined}>
          {status?.boundLibrary
            ? <>Watching {status.sources.length} source{status.sources.length === 1 ? "" : "s"}. New files, revisions, and removals inside them track automatically.</>
            : <>One library per area, so asking about {unit.label} only finds its own drawings. Setup finds this area&apos;s folders for you.</>}
        </Step>
        <Step n={3} title="Deep read the drawings"
          state={status === null || flowCount === null ? "loading" : (flowCount > 0 ? "done" : "todo")}
          action={
            <button type="button" onClick={scrollToFlows}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[13px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]">
              Read flows <ChevronRight className="w-3 h-3" />
            </button>
          }>
          <span className="inline-flex items-center gap-2 flex-wrap">
            <span><b>{flowCount ?? "…"}</b> process flow{flowCount === 1 ? "" : "s"}</span>
            <span>· <b>{docLinkCount ?? "…"}</b> linked document{docLinkCount === 1 ? "" : "s"}</span>
            <span>· <b>{plotMarkCount ?? "…"}</b> plot marker{plotMarkCount === 1 ? "" : "s"}</span>
            <Link href="/plot-plans" className="text-[var(--color-accent-text)] dark:text-[var(--color-text)] hover:underline">Plot plans <ExternalLink className="w-2.5 h-2.5 inline" /></Link>
          </span>
        </Step>
        <Step n={4} title="Link equipment files to assets"
          state={status === null || docLinkCount === null ? "loading" : docLinkCount > 0 ? "done" : "todo"}>
          Open any asset below → <b>+ Link document</b> attaches its data sheets and files; drawings that print the tag link themselves.
        </Step>
      </div>

      {wizardOpen && status && (
        <AreaKnowledgeWizard
          orgId={orgId} userId={userId} userName={userName} unit={unit}
          status={status}
          onClose={() => setWizardOpen(false)}
          // No page-wide refresh here: it would UNMOUNT this panel and eat
          // the success message before anyone reads it — nothing about the
          // assets changed anyway.
          onDone={(msg) => { setWizardOpen(false); setNote(msg); void loadStatus(); }}
        />
      )}
    </section>
  );
}

// ─── The wizard ────────────────────────────────────────────────────────────

function AreaKnowledgeWizard({ orgId, userId, userName, unit, status, onClose, onDone }: {
  orgId: string;
  userId: string;
  userName: string;
  unit: { code: string; label: string };
  status: AreaStatus;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const bound = status.boundLibrary;
  // Library choice: the bound one, an existing one, or create-new.
  const [libChoice, setLibChoice] = useState<string>(bound?.id ?? "__new");
  const [newName, setNewName] = useState(`${unit.label} Knowledge`);
  const [browse, setBrowse] = useState<SourceBrowseResult | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set()); // "folder:<id>" | "library:<id>"
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestedIds = useMemo(
    () => new Set([...status.suggestions, ...status.drift.newMatches].map((s) => s.id)),
    [status.suggestions, status.drift.newMatches],
  );
  // Watched containers by ID (names are stale snapshots the moment a folder
  // renames) — and only when the picker is aimed at the library those
  // sources belong to. Switching to a different/new library must leave
  // every folder selectable.
  const watchedIds = useMemo(
    () => (bound && libChoice === bound.id ? new Set(status.sources.map((s) => s.sourceId)) : new Set<string>()),
    [bound, libChoice, status.sources],
  );

  // Moving the area to a DIFFERENT library must not silently abandon the
  // folders it watches today: carry them into the selection so the new
  // library starts with the same coverage unless the user unchecks them.
  useEffect(() => {
    if (!bound || libChoice === bound.id) return;
    setChecked((prev) => {
      const next = new Set(prev);
      for (const s of status.sources) {
        next.add(s.type === "folder" ? `folder:${s.sourceId}` : `library:${s.sourceId}`);
      }
      return next;
    });
  }, [libChoice, bound, status.sources]);

  useEffect(() => {
    let alive = true;
    browseKnowledgeContainers(orgId)
      .then((b) => {
        if (!alive) return;
        setBrowse(b);
        // Pre-check every folder that looks like this unit's.
        setChecked(new Set(
          b.folders.filter((f) => suggestedIds.has(f.id)).map((f) => `folder:${f.id}`),
        ));
      })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [orgId, suggestedIds]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const toggle = (key: string) => setChecked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // A library created by a failed attempt is REMEMBERED — retrying must
  // reuse it, never mint "<Unit> — Knowledge" twice.
  const createdRef = useRef<{ id: string; name: string } | null>(null);

  const apply = async () => {
    setBusy(true); setError(null);
    try {
      // 1. The area's library — picked, created, or reused from a retry.
      let klId = libChoice;
      let klName = status.knowledgeLibraries.find((l) => l.id === libChoice)?.name ?? "";
      if (libChoice === "__new") {
        if (createdRef.current) {
          klId = createdRef.current.id; klName = createdRef.current.name;
        } else {
          const name = newName.trim() || `${unit.label} Knowledge`;
          const kl = await createKnowledgeLibrary({
            orgId, name,
            description: `Everything the AI may read about ${unit.label} (unit ${unit.code}).`,
            userId, userName,
          });
          createdRef.current = { id: kl.id, name };
          klId = kl.id; klName = name;
        }
      }
      // 2. Bind FIRST — if linking fails halfway, the area still owns its
      // library and the review flow can finish the job; nothing orphans.
      await bindAreaLibrary(orgId, unit.code, klId);
      // 3. Link the picked containers (the API links AND syncs) — batched,
      // because the server caps each call at 25 sources.
      const add = [...checked]
        .map((key) => {
          const [type, id] = key.split(":");
          return { type: type as "library" | "folder", id };
        })
        // A container the bound library already watches must not be
        // re-submitted (the pre-check can include suggested folders that
        // are already sources).
        .filter((x) => !watchedIds.has(x.id));
      let added = 0;
      let linked = 0;
      for (let i = 0; i < add.length; i += 25) {
        const r = await addKnowledgeSources(orgId, klId, add.slice(i, i + 25));
        added += r.added; linked += r.linked;
      }
      onDone(`${unit.label} is connected to “${klName}”: ${linked} source${linked === 1 ? "" : "s"} watched, ${added} document${added === 1 ? "" : "s"} pulled in. Indexing runs automatically.`);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  // EVERY readable DC library gets a row — a library whose documents sit at
  // its root (no folders) must still be linkable as a whole.
  const foldersByLib = useMemo(() => {
    const m = new Map<string, { libraryName: string; folders: SourceBrowseResult["folders"] }>();
    for (const l of browse?.libraries ?? []) {
      m.set(l.id, { libraryName: l.name, folders: [] });
    }
    for (const f of browse?.folders ?? []) {
      const g = m.get(f.libraryId) ?? { libraryName: f.libraryName, folders: [] };
      g.folders.push(f);
      m.set(f.libraryId, g);
    }
    return [...m.entries()].sort((a, b) => a[1].libraryName.localeCompare(b[1].libraryName));
  }, [browse]);

  const sheet = (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-[700] flex items-start justify-center bg-[var(--color-ink)]/60 pt-[6vh] p-4 overscroll-contain" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[86vh] flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] shrink-0">
          <Sparkles className="w-4 h-4 text-[var(--color-text-muted)]" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-[var(--color-text)]">
              {bound ? `Review ${unit.label}'s knowledge` : `Set up ${unit.label}'s knowledge`}
            </div>
            <div className="text-[13px] text-[var(--color-text-muted)]">
              Pick the folders the AI should watch for this area. Folders matching
              &ldquo;{unit.label}&rdquo; or code {unit.code} are pre-checked.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
          {/* The area's library */}
          <div>
            <div className="text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">
              This area&apos;s knowledge library
            </div>
            <div className="space-y-1">
              {status.knowledgeLibraries.map((l) => (
                <label key={l.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-border)] cursor-pointer">
                  <input type="radio" name="area-kl" checked={libChoice === l.id} onChange={() => setLibChoice(l.id)} />
                  <BookOpen className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                  <span className="text-[13px] font-bold text-[var(--color-text)]">{l.name}</span>
                  {bound?.id === l.id && (
                    <span className="text-[13px] font-semibold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] dark:bg-[var(--color-surface-2)] text-[var(--color-text)] dark:text-[var(--color-text)]">current</span>
                  )}
                </label>
              ))}
              <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-border)] cursor-pointer">
                <input type="radio" name="area-kl" checked={libChoice === "__new"} onChange={() => setLibChoice("__new")} />
                <Plus className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                <input value={newName} onChange={(e) => { setNewName(e.target.value); setLibChoice("__new"); }}
                  className="flex-1 px-2 py-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] text-[13px] font-bold"
                  placeholder={`${unit.label} Knowledge`} />
              </label>
            </div>
          </div>

          {/* Already watched (review mode) */}
          {status.sources.length > 0 && (
            <div>
              <div className="text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">
                Already watched
              </div>
              <div className="space-y-1">
                {status.sources.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)]">
                    <Check className="w-3 h-3 text-emerald-600 shrink-0" />
                    <span className="flex-1 min-w-0 truncate font-bold">{s.name}</span>
                    <span className="text-[13px] font-semibold">{s.type}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Folder picker, grouped by DC library, suggestions pre-checked */}
          <div>
            <div className="text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">
              Watch these document-control folders
            </div>
            {browse === null ? (
              <div className="flex justify-center items-center gap-2 py-4 text-[11px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Loading folders…</div>
            ) : foldersByLib.length === 0 ? (
              <div className="text-[13px] text-[var(--color-text-muted)]">
                No document libraries yet. <Link href="/documents" className="font-bold underline">create them in Documents</Link> first.
              </div>
            ) : (
              <div className="space-y-2.5">
                {foldersByLib.map(([libId, g]) => {
                  const libWatched = watchedIds.has(libId);
                  return (
                  <div key={libId}>
                    <label className={`flex items-center gap-2 text-[13px] font-semibold text-[var(--color-text)] cursor-pointer ${libWatched ? "opacity-50" : ""}`}>
                      <input type="checkbox" disabled={libWatched}
                        checked={libWatched || checked.has(`library:${libId}`)}
                        onChange={() => toggle(`library:${libId}`)} />
                      <FolderOpen className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> {g.libraryName}
                      <span className="text-[13px] font-bold text-[var(--color-text-faint)] normal-case">
                        {libWatched ? "(whole library, already watched)" : "(whole library)"}
                      </span>
                    </label>
                    <div className="ml-5 mt-1 space-y-0.5">
                      {g.folders.map((f) => {
                        // Watched by ID — folder renames must not resurrect a
                        // linked folder as "unwatched". A whole-library watch
                        // covers every folder inside it.
                        const watched = libWatched || watchedIds.has(f.id);
                        return (
                          <label key={f.id} className={`flex items-center gap-2 text-[13px] cursor-pointer ${watched ? "opacity-50" : ""}`}>
                            <input type="checkbox" disabled={watched}
                              checked={watched || checked.has(`folder:${f.id}`)}
                              onChange={() => toggle(`folder:${f.id}`)} />
                            <span className="truncate text-[var(--color-text)]" style={{ paddingLeft: Math.max(0, f.pathNames.length - 1) * 10 }}>
                              {f.name}
                            </span>
                            {suggestedIds.has(f.id) && !watched && (
                              <span className="text-[13px] font-semibold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] dark:bg-[var(--color-surface-2)] text-[var(--color-text)] dark:text-[var(--color-text)]">
                                suggested
                              </span>
                            )}
                          </label>
                        );
                      })}
                      {g.folders.length === 0 && (
                        <div className="text-[13px] text-[var(--color-text-faint)]">No folders. Link the whole library above.</div>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="flex items-start gap-2 border-l-2 border-rose-500 pl-2.5 text-[13px] text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </p>
          )}
        </div>

        <div className="px-4 py-3 border-t border-[var(--color-border)] shrink-0 flex items-center gap-2">
          <span className="flex-1 text-[13px] text-[var(--color-text-muted)]">
            <FileText className="w-3 h-3 inline mr-1" />
            New files, revisions, and deletions inside watched folders sync automatically.
          </span>
          <button onClick={onClose} className="px-3 py-2 rounded-lg text-[13px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
          <button onClick={() => void apply()}
            disabled={busy || (libChoice === "__new" && !newName.trim()) || (checked.size === 0 && !bound)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 shadow">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            {bound ? "Apply changes" : "Connect this area"}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}
