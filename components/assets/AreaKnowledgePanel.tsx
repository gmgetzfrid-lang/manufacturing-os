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
  Loader2, Check, ChevronRight, X,
  FolderOpen, BookOpen, RefreshCw, Plus, Trash2, ExternalLink,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  createKnowledgeLibrary, addKnowledgeSources, syncKnowledgeSources,
  removeKnowledgeSource, browseKnowledgeContainers, type SourceBrowseResult,
} from "@/lib/knowledge";
import { listProcessFlows } from "@/lib/processFlows";
import { sheet, btnQuiet, btnRow, btnIcon, btnPrimary, link, label, fieldBox } from "@/components/admin/kit";
import { StatusTag } from "@/components/documents/StatusTag";
import { Note, Cells } from "@/components/knowledge/panelKit";

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
    <li className="flex flex-wrap sm:flex-nowrap items-start gap-x-3 gap-y-2 px-4 sm:px-5 py-3">
      <span aria-hidden className={`w-6 h-6 rounded-full grid place-items-center shrink-0 font-display text-[13px] font-semibold mt-0.5 ${
        state === "done" ? "bg-[var(--state-released)] text-white"
        : state === "review" ? "bg-[var(--state-held)] text-white"
        : "text-[var(--color-text-muted)] border-2 border-[var(--color-border-strong)]"
      }`}>
        {state === "done" ? <Check className="w-3.5 h-3.5" /> : state === "loading" ? <Loader2 className="w-3 h-3 animate-spin" /> : n}
      </span>
      <div className="flex-1 min-w-0 basis-[220px]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[15px] font-semibold text-[var(--color-text)]">{title}</span>
          {state === "done" && <span className="sr-only">(done)</span>}
          {state === "review" && <StatusTag tone="warn">Needs review</StatusTag>}
        </div>
        <div className="text-[14px] text-[var(--color-text-muted)] mt-0.5">{children}</div>
      </div>
      {action && <div className="shrink-0 max-sm:pl-9">{action}</div>}
    </li>
  );

  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 mb-2.5 min-h-8">
        <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)]">This area&apos;s knowledge</h2>
        <div className="flex-1" />
        {status?.boundLibrary && status.canManage && (
          <button type="button" onClick={() => void syncNow()} disabled={syncing} className={btnQuiet}>
            <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} /> Sync now
          </button>
        )}
      </div>

      <div className={`${sheet} overflow-hidden`}>
        {status?.boundLibrary && (
          <div className="border-b border-[var(--color-border)]">
            <Cells size="sm" cells={[
              { label: "Knowledge library", value: <Link href={`/knowledge/${status.boundLibrary.id}`} className="text-[var(--color-accent-text)] hover:underline underline-offset-2 break-words">{status.boundLibrary.name}</Link> },
              { label: "Readable", value: status.counts.ready.toLocaleString() },
              { label: "Indexing", value: status.counts.pending.toLocaleString() },
              { label: "Watched sources", value: status.sources.length.toLocaleString() },
            ]} />
          </div>
        )}

        {(error || note || countsFailed || (hasDrift && drift)) && (
          <div className="border-b border-[var(--color-border)] px-4 sm:px-5 py-3 space-y-2.5">
            {error && (
              <Note tone="bad" title="Couldn't load this area's knowledge.">
                {error} <button type="button" onClick={() => void loadStatus()} className={link}>Try again</button>
              </Note>
            )}
            {note && <Note tone={note.bad ? "bad" : "good"} title={note.text} />}
            {countsFailed && <Note tone="warn" title="Some links and markers weren't counted.">The numbers in step 3 may be low.</Note>}

            {/* Drift: doc control was reorganized after linking. Said HERE,
                on open, with the fix one click away; never a silent sync surprise. */}
            {hasDrift && drift && (
              <Note tone="warn" title="Document control changed since this area was linked">
                <ul className="mt-1 space-y-1.5">
                  {drift.deadSources.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="flex-1 min-w-0">Watched folder no longer exists: <span className="font-semibold text-[var(--color-text)]">{s.sourceName}</span></span>
                      {status?.canManage && (
                        <button type="button" onClick={() => void dropDeadSource(s.id)} disabled={syncing} className={btnRow}>
                          <Trash2 className="w-3.5 h-3.5" /> Remove link
                        </button>
                      )}
                    </li>
                  ))}
                  {drift.movedOutTotal > 0 && (
                    <li>
                      {drift.movedOutTotal} document{drift.movedOutTotal === 1 ? " was" : "s were"} moved out of the watched folders
                      {" "}({drift.movedOut.slice(0, 3).map((d) => d.name).join(", ")}{drift.movedOutTotal > 3 ? "…" : ""}).
                      {" "}The next sync drops {drift.movedOutTotal === 1 ? "it" : "them"}; link the new folder to keep {drift.movedOutTotal === 1 ? "it" : "them"}.
                    </li>
                  )}
                  {drift.newMatches.map((f) => (
                    <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="flex-1 min-w-0">
                        New folder looks like this area&apos;s: <span className="font-semibold text-[var(--color-text)]">{f.libraryName} / {f.pathNames.join(" / ")}</span>
                        <span className="tabular-nums"> ({f.docCount} doc{f.docCount === 1 ? "" : "s"})</span>
                      </span>
                      {status?.canManage && (
                        <button type="button" onClick={() => void linkNewMatch(f.id, f.name)} disabled={syncing} className={btnRow}>
                          <Plus className="w-3.5 h-3.5" /> Link
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </Note>
            )}
          </div>
        )}

        {/* The order of operations, live. */}
        <ol className="divide-y divide-[var(--color-border)]">
          <Step n={1} title="File this area's drawings in Documents"
            state={status === null ? "loading" : drawingsDone ? "done" : "todo"}
            action={<Link href="/documents" className={`${btnRow} no-underline`}>Open Documents <ExternalLink className="w-3.5 h-3.5" /></Link>}>
            Type-first folders work best: PFDs / {unit.label}, P&amp;IDs / {unit.label}, Plot Plans / {unit.label}.
          </Step>
          <Step n={2} title="Connect the area's knowledge"
            state={status === null ? "loading" : knowledgeDone ? "done" : needsReview ? "review" : "todo"}
            action={status?.canManage ? (
              <button type="button" onClick={() => setWizardOpen(true)} className={btnRow}>
                {status?.boundLibrary ? "Review links" : "Set up"} <ChevronRight className="w-3.5 h-3.5" />
              </button>
            ) : undefined}>
            {status?.boundLibrary
              ? <>Watching {status.sources.length} source{status.sources.length === 1 ? "" : "s"}. New files, revisions and removals track automatically.</>
              : <>One library per area, so asking about {unit.label} finds only its own drawings. Setup finds the folders for you.</>}
          </Step>
          <Step n={3} title="Deep read the drawings"
            state={status === null || flowCount === null ? "loading" : (flowCount > 0 ? "done" : "todo")}
            action={
              <button type="button" onClick={scrollToFlows} className={btnRow}>
                Read flows <ChevronRight className="w-3.5 h-3.5" />
              </button>
            }>
            <span className="inline-flex items-center gap-x-4 gap-y-0.5 flex-wrap">
              <span><span className="font-display font-semibold tabular-nums text-[var(--color-text)]">{flowCount ?? "…"}</span> process flow{flowCount === 1 ? "" : "s"}</span>
              <span><span className="font-display font-semibold tabular-nums text-[var(--color-text)]">{docLinkCount ?? "…"}</span> linked document{docLinkCount === 1 ? "" : "s"}</span>
              <span><span className="font-display font-semibold tabular-nums text-[var(--color-text)]">{plotMarkCount ?? "…"}</span> plot marker{plotMarkCount === 1 ? "" : "s"}</span>
              <Link href="/plot-plans" className={link}>Plot plans</Link>
            </span>
          </Step>
          <Step n={4} title="Link equipment files to assets"
            state={status === null || docLinkCount === null ? "loading" : docLinkCount > 0 ? "done" : "todo"}>
            Open an asset below and use Link document for its data sheets; drawings that print the tag link themselves.
          </Step>
        </ol>
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
        <div className="flex items-start gap-2 px-5 py-4 border-b border-[var(--color-border)] shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="font-display text-[19px] font-semibold text-[var(--color-text)]">
              {bound ? `Review ${unit.label}'s knowledge` : `Set up ${unit.label}'s knowledge`}
            </h2>
            <p className="text-[14px] text-[var(--color-text-muted)]">
              Pick the folders to watch. Folders matching &ldquo;{unit.label}&rdquo; or {unit.code} are checked for you.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={btnIcon}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5 min-h-0">
          {/* The area's library */}
          <div>
            <div className={label}>This area&apos;s knowledge library</div>
            <div className="rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
              {status.knowledgeLibraries.map((l) => (
                <label key={l.id} className="flex items-center gap-2.5 px-3 min-h-10 hover:bg-[var(--color-surface-2)] cursor-pointer">
                  <input type="radio" name="area-kl" checked={libChoice === l.id} onChange={() => setLibChoice(l.id)} className="accent-[var(--color-accent)]" />
                  <BookOpen className="w-4 h-4 text-[var(--color-text-muted)]" />
                  <span className="text-[15px] font-semibold text-[var(--color-text)] flex-1 min-w-0 truncate">{l.name}</span>
                  {bound?.id === l.id && <StatusTag tone="none">Current</StatusTag>}
                </label>
              ))}
              <label className="flex items-center gap-2.5 px-3 py-2 hover:bg-[var(--color-surface-2)] cursor-pointer">
                <input type="radio" name="area-kl" checked={libChoice === "__new"} onChange={() => setLibChoice("__new")} className="accent-[var(--color-accent)]" />
                <Plus className="w-4 h-4 text-[var(--color-text-muted)]" />
                <input value={newName} onChange={(e) => { setNewName(e.target.value); setLibChoice("__new"); }}
                  aria-label="New library name"
                  className={`flex-1 min-w-0 h-9 text-[14px] ${fieldBox}`}
                  placeholder={`${unit.label} Knowledge`} />
              </label>
            </div>
          </div>

          {/* Already watched (review mode) */}
          {status.sources.length > 0 && (
            <div>
              <div className={label}>Already watched</div>
              <ul className="rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                {status.sources.map((s) => (
                  <li key={s.id} className="flex items-center gap-2.5 px-3 min-h-10 text-[14px]">
                    <Check className="w-4 h-4 text-[var(--state-released)] shrink-0" />
                    <span className="flex-1 min-w-0 truncate font-semibold text-[var(--color-text)]">{s.name}</span>
                    <span className="text-[13px] text-[var(--color-text-muted)]">{s.type === "library" ? "Whole library" : "Folder"}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Folder picker, grouped by DC library, suggestions pre-checked */}
          <div>
            <div className={label}>Watch these folders</div>
            {browse === null ? (
              <div className="flex items-center gap-2 py-3 text-[14px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Loading folders…</div>
            ) : foldersByLib.length === 0 ? (
              <div className="text-[14px] text-[var(--color-text-muted)]">
                No document libraries yet. <Link href="/documents" className={link}>Make them in Documents</Link> first.
              </div>
            ) : (
              <div className="space-y-2.5">
                {foldersByLib.map(([libId, g]) => {
                  const libWatched = watchedIds.has(libId);
                  return (
                  <div key={libId}>
                    <label className={`flex items-center gap-2.5 min-h-9 text-[15px] font-semibold text-[var(--color-text)] cursor-pointer ${libWatched ? "opacity-50" : ""}`}>
                      <input type="checkbox" disabled={libWatched}
                        checked={libWatched || checked.has(`library:${libId}`)}
                        onChange={() => toggle(`library:${libId}`)} className="w-4 h-4 accent-[var(--color-accent)]" />
                      <FolderOpen className="w-4 h-4 text-[var(--color-text-muted)]" /> {g.libraryName}
                      <span className="text-[13px] font-normal text-[var(--color-text-muted)]">
                        {libWatched ? "Whole library, already watched" : "Whole library"}
                      </span>
                    </label>
                    <div className="ml-6 border-l border-[var(--color-border)] pl-3">
                      {g.folders.map((f) => {
                        // Watched by ID — folder renames must not resurrect a
                        // linked folder as "unwatched". A whole-library watch
                        // covers every folder inside it.
                        const watched = libWatched || watchedIds.has(f.id);
                        return (
                          <label key={f.id} className={`flex items-center gap-2.5 min-h-8 text-[14px] cursor-pointer ${watched ? "opacity-50" : ""}`}>
                            <input type="checkbox" disabled={watched}
                              checked={watched || checked.has(`folder:${f.id}`)}
                              onChange={() => toggle(`folder:${f.id}`)} className="w-4 h-4 accent-[var(--color-accent)]" />
                            <span className="truncate text-[var(--color-text)]" style={{ paddingLeft: Math.max(0, f.pathNames.length - 1) * 10 }}>
                              {f.name}
                            </span>
                            {suggestedIds.has(f.id) && !watched && (
                              <StatusTag tone="none">Suggested</StatusTag>
                            )}
                          </label>
                        );
                      })}
                      {g.folders.length === 0 && (
                        <div className="text-[13px] text-[var(--color-text-muted)] py-1">No folders. Link the whole library above.</div>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>

          {error && (
            <Note tone="bad" title="Couldn't connect the area.">{error}</Note>
          )}
        </div>

        <div className="px-5 py-4 border-t border-[var(--color-border)] shrink-0 flex flex-wrap items-center gap-2">
          <span className="flex-1 basis-[200px] text-[13px] text-[var(--color-text-muted)]">
            New files, revisions and deletions in watched folders sync automatically.
          </span>
          <button type="button" onClick={onClose} className={btnQuiet}>Cancel</button>
          <button type="button" onClick={() => void apply()}
            disabled={busy || (libChoice === "__new" && !newName.trim()) || (checked.size === 0 && !bound)}
            className={btnPrimary}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {bound ? "Apply changes" : "Connect this area"}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}
