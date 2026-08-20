"use client";

// UnitOpsPanels — the pieces that turn the unit hub from a list into a
// wired room of the same house.
//
// CategorizeBanner: the bridge from the Site Codebook (where the org's
// imported numbering knowledge lives) to the registry's categories. When
// uncategorized equipment exists, one click decodes every tag through the
// codebook's prefixes, creates the matching categories, and assigns them —
// and anything the codebook can't decode is REPORTED with the fix (teach
// the codebook the prefix), never guessed.
//
// FlowPanel: the unit's process topology. Confirmed flows (drawn on the
// graph or accepted here), AI proposals awaiting a decision, and the
// "Read flows from a document" door — point at a PFD, the AI reads the
// printed pages and proposes connections only between entities that exist.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  Wand2, Loader2, AlertTriangle, ArrowRight, Check, X, Waypoints,
  ScanSearch, Trash2, FileText, Search, CheckCircle2, BookOpen,
  FolderOpen, RefreshCw,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Asset, AssetType } from "@/lib/assets";
import type { Codebook } from "@/lib/codebook";
import { planCategorization, applyCategorization, type CategorizationResult } from "@/lib/assetCategorize";
import { listProcessFlows, decideFlow, deleteFlow, type ProcessFlow } from "@/lib/processFlows";
import { syncKnowledgeSources, addKnowledgeSources } from "@/lib/knowledge";
import type { DcLibraryNode, DcFolderNode, DcDocRow, FlowsBrowseUploadGroup } from "@/lib/flowsBrowse";

// ─── Auto-categorize ───────────────────────────────────────────────────────

export function CategorizeBanner({ orgId, userId, assets, types, book, onDone }: {
  orgId: string;
  userId: string;
  assets: Asset[];
  types: AssetType[];
  book: Codebook;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CategorizationResult | null>(null);
  const plan = useMemo(() => planCategorization(assets, types, book), [assets, types, book]);
  const uncategorized = plan.assignments.length + plan.unmatched.length;
  if (uncategorized === 0 && plan.unitAssignments.length === 0 && !result) return null;

  const run = async () => {
    setBusy(true);
    try {
      setResult(await applyCategorization(orgId, userId, plan, types));
      onDone();
    } finally { setBusy(false); }
  };

  return (
    <div className="mb-4 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 px-3.5 py-3"
      style={{ animation: "rise 0.4s var(--ease-fluid) both" }}>
      {result ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-black text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="w-4 h-4" />
            {result.categorized} categorized{result.filedToUnits > 0 ? ` · ${result.filedToUnits} filed to their operating area from site codes` : ""}{result.createdTypes > 0 ? ` · ${result.createdTypes} new categor${result.createdTypes === 1 ? "y" : "ies"} created from your codebook` : ""}
            {result.failed > 0 ? ` · ${result.failed} failed` : ""}
          </div>
          {result.unmatched.length > 0 && (
            <div className="text-[11px] text-amber-800 dark:text-amber-300">
              No codebook prefix matched: <b className="font-mono">{result.unmatched.slice(0, 8).join(", ")}{result.unmatched.length > 8 ? "…" : ""}</b>.
              {" "}Teach the prefix in the <Link href="/admin/codebook" className="underline font-black">Site Codebook</Link> and run again — that fixes every future asset too.
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-[14rem]">
            <div className="text-xs font-black text-[var(--color-text)]">
              {uncategorized > 0
                ? `${uncategorized} piece${uncategorized === 1 ? "" : "s"} of equipment uncategorized`
                : `${plan.unitAssignments.length} piece${plan.unitAssignments.length === 1 ? "" : "s"} not filed to an operating area`}
              {uncategorized > 0 && plan.unitAssignments.length > 0 ? ` · ${plan.unitAssignments.length} unfiled to areas` : ""}
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              Your Site Codebook already knows the taxonomy — {plan.assignments.length > 0
                ? <>its prefixes decode {plan.assignments.length} of them{plan.typesToCreate.length > 0 ? `, creating ${plan.typesToCreate.slice(0, 4).join(", ")}${plan.typesToCreate.length > 4 ? "…" : ""}` : ""}.</>
                : <>but none of its prefixes match these tags. Add the prefixes in the <Link href="/admin/codebook" className="underline font-bold">Site Codebook</Link>.</>}
            </div>
          </div>
          {(plan.assignments.length > 0 || plan.unitAssignments.length > 0) && (
            <button onClick={() => void run()} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-60 shrink-0">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
              Auto-categorize from codebook
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Process flows ─────────────────────────────────────────────────────────

export function FlowPanel({ orgId, userId, userName, isAdmin, unitCode, unitAssets }: {
  orgId: string;
  userId: string;
  userName?: string;
  isAdmin: boolean;
  unitCode: string;
  unitAssets: Asset[];
}) {
  const [flows, setFlows] = useState<ProcessFlow[] | null | undefined>(undefined);
  const [tagById, setTagById] = useState<Map<string, string>>(new Map());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [readerOpen, setReaderOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await listProcessFlows(orgId);
      if (all === null) { setFlows(null); return; }
      const mine = new Set(unitAssets.map((a) => a.id));
      const relevant = all.filter((f) =>
        (f.from_kind === "asset" && mine.has(f.from_ref)) ||
        (f.to_kind === "asset" && mine.has(f.to_ref)) ||
        (f.from_kind === "unit" && f.from_ref === unitCode) ||
        (f.to_kind === "unit" && f.to_ref === unitCode));
      setFlows(relevant);
      // Resolve tags for endpoints outside this unit.
      const ids = new Set<string>();
      for (const f of relevant) {
        if (f.from_kind === "asset" && !mine.has(f.from_ref)) ids.add(f.from_ref);
        if (f.to_kind === "asset" && !mine.has(f.to_ref)) ids.add(f.to_ref);
      }
      const map = new Map(unitAssets.map((a) => [a.id, a.tag]));
      if (ids.size > 0) {
        const { data } = await supabase.from("assets").select("id, tag").in("id", [...ids]);
        for (const r of (data as Array<{ id: string; tag: string }>) ?? []) map.set(r.id, r.tag);
      }
      setTagById(map);
    } catch { setFlows([]); }
  }, [orgId, unitCode, unitAssets]);

  useEffect(() => { void refresh(); }, [refresh]);

  const endpointLabel = (kind: string, ref: string) =>
    kind === "unit" ? `Unit ${ref}` : (tagById.get(ref) ?? "…");

  const decide = async (f: ProcessFlow, accept: boolean) => {
    setBusyId(f.id);
    try { await decideFlow(f.id, accept, { userId, userName }); await refresh(); }
    finally { setBusyId(null); }
  };
  const remove = async (f: ProcessFlow) => {
    setBusyId(f.id);
    try { await deleteFlow(f.id); await refresh(); }
    finally { setBusyId(null); }
  };

  if (flows === undefined) return null;

  const proposed = (flows ?? []).filter((f) => f.status === "proposed");
  const confirmed = (flows ?? []).filter((f) => f.status === "confirmed");

  return (
    <div id="area-flow-panel" className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5"
      style={{ animation: "rise 0.4s var(--ease-fluid) both" }}>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <Waypoints className="w-4 h-4 text-cyan-600 shrink-0" />
        <span className="text-xs font-black text-[var(--color-text)]">Process flows</span>
        <span className="text-[10px] font-bold text-[var(--color-text-faint)]">
          {flows === null ? "" : `${confirmed.length} confirmed${proposed.length > 0 ? ` · ${proposed.length} proposed` : ""}`}
        </span>
        <span className="flex-1" />
        <Link href="/graph" className="text-[10px] font-black text-cyan-700 hover:text-cyan-600">
          Process lens →
        </Link>
        {isAdmin && flows !== null && (
          <button onClick={() => setReaderOpen(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-black text-white bg-cyan-700 hover:bg-cyan-600">
            <ScanSearch className="w-3.5 h-3.5" /> Read flows from a document
          </button>
        )}
      </div>

      {flows === null ? (
        <div className="text-[11px] text-[var(--color-text-muted)]">
          Process flows aren&apos;t installed yet — run the process-flows migration to map what feeds what.
        </div>
      ) : (
        <>
          {note && <div className="text-[11px] text-[var(--color-text-muted)] mb-2">{note}</div>}
          {proposed.length > 0 && (
            <div className="space-y-1 mb-2">
              <div className="text-[9px] font-black uppercase tracking-widest text-amber-700">Proposed — the AI read these; you decide</div>
              {proposed.map((f) => (
                <div key={f.id} className="flex items-center gap-2 rounded-lg border border-dashed border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 px-2.5 py-1.5">
                  <span className="text-[11px] font-black text-[var(--color-text)]">{endpointLabel(f.from_kind, f.from_ref)}</span>
                  <ArrowRight className="w-3 h-3 text-amber-600 shrink-0" />
                  <span className="text-[11px] font-black text-[var(--color-text)]">{endpointLabel(f.to_kind, f.to_ref)}</span>
                  {f.label && <span className="text-[10px] text-[var(--color-text-muted)] italic truncate">“{f.label}”</span>}
                  {f.evidence?.docName && (
                    <span className="text-[9px] text-[var(--color-text-faint)] truncate hidden sm:inline">
                      from {f.evidence.docName}{f.source_page ? ` p.${f.source_page}` : ""}
                    </span>
                  )}
                  <span className="flex-1" />
                  {isAdmin && (
                    <>
                      <button onClick={() => void decide(f, false)} disabled={busyId === f.id}
                        className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-rose-600" title="Not a real flow">
                        <X className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => void decide(f, true)} disabled={busyId === f.id}
                        className="p-1.5 rounded-lg text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/40" title="Confirm — draw it on the graph">
                        {busyId === f.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {confirmed.length === 0 && proposed.length === 0 ? (
            <div className="text-[11px] text-[var(--color-text-muted)]">
              Nothing mapped yet. Draw flows on the <Link href="/graph" className="underline font-bold">graph</Link> (Connect two equipment items — the first feeds the second){isAdmin ? ", or point the reader at a process flow diagram." : "."}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {confirmed.map((f) => (
                <span key={f.id} className="group inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-cyan-50 dark:bg-cyan-950/30 border border-cyan-200 dark:border-cyan-900 text-[11px] font-bold text-[var(--color-text)]">
                  {endpointLabel(f.from_kind, f.from_ref)}
                  <ArrowRight className="w-3 h-3 text-cyan-600" />
                  {endpointLabel(f.to_kind, f.to_ref)}
                  {f.label && <span className="text-[10px] text-[var(--color-text-muted)] italic">“{f.label}”</span>}
                  {isAdmin && (
                    <button onClick={() => void remove(f)} disabled={busyId === f.id}
                      className="opacity-0 group-hover:opacity-100 text-[var(--color-text-faint)] hover:text-rose-600 transition-opacity" title="Remove this flow">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {readerOpen && (
        <ReadFlowsModal orgId={orgId}
          onClose={() => setReaderOpen(false)}
          onDone={(msg) => { setReaderOpen(false); setNote(msg); void refresh(); }} />
      )}
    </div>
  );
}
/** Pick the PFD, run the reader. The picker mirrors DOCUMENT CONTROL's own
 *  tree — library → nested folders → every controlled document — because
 *  that's the map in the user's head. Every file shows its AI state: ready
 *  rows read flows; blocked rows say WHY (not linked, not synced, no PDF,
 *  superseded, held back) and offer the fix. A folder that exists on the
 *  Documents side can never be missing here. Portaled to <body> so no
 *  ancestor transform can clip the sheet. */
function ReadFlowsModal({ orgId, onClose, onDone }: {
  orgId: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [model, setModel] = useState<{
    tree: DcLibraryNode[];
    uploads: FlowsBrowseUploadGroup[];
    knowledgeLibraries: Array<{ id: string; name: string }>;
    canSync: boolean;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dcLibFilter, setDcLibFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [pagesRaw, setPagesRaw] = useState("");
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  // An unwatched container being linked: when several knowledge libraries
  // exist the user picks which one watches it; with exactly one, Link acts
  // immediately — no detours to other pages.
  const [linking, setLinking] = useState<{ type: "library" | "folder"; id: string; name: string } | null>(null);
  // Which container is mid-link — busy state stays ON that button.
  const [linkingKey, setLinkingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`/api/flows/browse?orgId=${encodeURIComponent(orgId)}`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ""}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Couldn't load the libraries.");
      setModel(json as NonNullable<typeof model>);
      setLoadError(null);
    } catch (e) { setLoadError((e as Error).message); }
     
  }, [orgId]);
  useEffect(() => { void load(); }, [load]);

  // "Not synced yet" has a one-click answer: reconcile EVERY knowledge
  // library with doc control right now instead of waiting for the cron.
  // Failures are COUNTED and reported — "already up to date" while every
  // library errored would be a green lie.
  const syncAll = async () => {
    if (!model || model.knowledgeLibraries.length === 0) return;
    setSyncing(true); setError(null); setSyncNote(null);
    let added = 0;
    const failures: string[] = [];
    for (const kl of model.knowledgeLibraries) {
      try {
        const r = await syncKnowledgeSources(orgId, kl.id);
        added += r.added;
        failures.push(...(r.errors ?? []).map((e) => `${kl.name}: ${e}`));
      } catch (e) {
        failures.push(`${kl.name}: ${(e as Error).message}`);
      }
    }
    await load();
    if (failures.length > 0) {
      setError(`Sync hit ${failures.length} problem${failures.length === 1 ? "" : "s"} — ${failures[0]}${failures.length > 1 ? " (and more)" : ""}`);
      if (added > 0) setSyncNote(`${added} document${added === 1 ? "" : "s"} still pulled in before the errors.`);
    } else {
      setSyncNote(added > 0
        ? `Synced — ${added} document${added === 1 ? "" : "s"} pulled in from document control.`
        : "Synced — already up to date with document control.");
    }
    setSyncing(false);
  };

  // Link an unwatched container to a knowledge library IN PLACE — the
  // sources API links and syncs in one call, so the folder's documents
  // appear as soon as the model reloads.
  const doLink = async (klId: string, target: { type: "library" | "folder"; id: string; name: string }) => {
    setLinkingKey(target.id); setError(null); setSyncNote(null);
    try {
      const res = await addKnowledgeSources(orgId, klId, [{ type: target.type, id: target.id }]);
      setLinking(null);
      await load();
      setSyncNote(`Linked “${target.name}” — ${res.added} document${res.added === 1 ? "" : "s"} pulled in. Indexing starts automatically.`);
    } catch (e) { setError((e as Error).message); }
    finally { setLinkingKey(null); }
  };
  const requestLink = (target: { type: "library" | "folder"; id: string; name: string }) => {
    if (!model?.canSync) return;
    if (model.knowledgeLibraries.length === 0) {
      setError("Create an AI knowledge library first (Knowledge tab) — then Link connects folders to it from right here.");
      return;
    }
    if (model.knowledgeLibraries.length === 1) {
      void doLink(model.knowledgeLibraries[0].id, target);
    } else {
      setLinking(target);
    }
  };

  // "1-4", "2,5,9", "3" → up to 6 page numbers. Empty = first pages.
  const parsePages = (raw: string): number[] => {
    const out = new Set<number>();
    for (const part of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const a = parseInt(range[1], 10), b = parseInt(range[2], 10);
        for (let n = Math.min(a, b); n <= Math.max(a, b) && out.size < 6; n++) if (n >= 1) out.add(n);
      } else {
        const n = parseInt(part, 10);
        if (Number.isInteger(n) && n >= 1 && out.size < 6) out.add(n);
      }
    }
    return [...out].sort((x, y) => x - y);
  };
  const pages = parsePages(pagesRaw);

  const run = async (kdocId: string) => {
    setRunningId(kdocId); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/flows/read", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token ?? ""}`,
        },
        body: JSON.stringify({ orgId, knowledgeDocumentId: kdocId, ...(pages.length > 0 ? { pages } : {}) }),
        signal: AbortSignal.timeout(115_000),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Reading failed.");
      onDone(json.proposed > 0
        ? `${json.proposed} flow${json.proposed === 1 ? "" : "s"} proposed from pages ${json.pagesRead.join(", ")} — review them above.`
        : (json.note ?? "No new flows found."));
    } catch (e) { setError((e as Error).message); }
    finally { setRunningId(null); }
  };

  // ── Search filter over the tree (folders fold away when emptied) ──────
  const q = query.trim().toLowerCase();
  const filterFolder = (f: DcFolderNode): DcFolderNode | null => {
    const docs = q ? f.docs.filter((d) => d.name.toLowerCase().includes(q)) : f.docs;
    const folders = f.folders.map(filterFolder).filter((x): x is DcFolderNode => x !== null);
    const totalDocs = docs.length + folders.reduce((s, n) => s + n.totalDocs, 0);
    if (totalDocs === 0) return null;
    return { ...f, docs, folders, totalDocs };
  };
  const viewTree = (model?.tree ?? [])
    .filter((l) => !dcLibFilter || l.id === dcLibFilter)
    .map((l) => {
      const docs = q ? l.docs.filter((d) => d.name.toLowerCase().includes(q)) : l.docs;
      const folders = l.folders.map(filterFolder).filter((x): x is DcFolderNode => x !== null);
      return { ...l, docs, folders, totalDocs: docs.length + folders.reduce((s, n) => s + n.totalDocs, 0) };
    })
    .filter((l) => l.totalDocs > 0);
  const viewUploads = dcLibFilter === "" || dcLibFilter === "__uploads"
    ? (model?.uploads ?? []).map((g) => ({
        ...g,
        docs: q ? g.docs.filter((d) => d.name.toLowerCase().includes(q)) : g.docs,
      })).filter((g) => g.docs.length > 0)
    : [];

  // ── One row per document, its AI state printed on it ──────────────────
  const STATE_META: Record<Exclude<DcDocRow["state"], "ready">, { label: string; hint: string }> = {
    indexing: { label: "Indexing…", hint: "Mirrored and being indexed — the Read button appears when it finishes (usually under a minute). Reopen or Sync to refresh." },
    pending_sync: { label: "Not synced yet", hint: "Watched by the AI — press Sync to mirror it now." },
    unwatched: { label: "Not linked to AI", hint: "No knowledge library watches this folder — press Link to connect it right here." },
    not_pdf: { label: "No PDF revision", hint: "The AI reads PDFs only — attach a PDF current revision." },
    not_current: { label: "Superseded / archived", hint: "Only current revisions are read." },
    no_file: { label: "No file yet", hint: "This document has no current file attached." },
    held_back: { label: "Held back from AI", hint: "A controller excluded this document from AI reading." },
  };
  const FALLBACK_META = { label: "Unavailable", hint: "This document can't be read right now." };
  const docRow = (d: DcDocRow, container?: { type: "library" | "folder"; id: string; name: string }) => {
    if (d.state === "ready" && d.kdocId) {
      const kid = d.kdocId;
      return (
        <button key={d.dcDocId} onClick={() => void run(kid)} disabled={runningId !== null}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border border-[var(--color-border)] hover:border-cyan-400 text-left disabled:opacity-50">
          <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="block text-xs font-bold text-[var(--color-text)] truncate">{d.name}</span>
            <span className="block text-[10px] text-[var(--color-text-faint)]">
              {d.pageCount ? `${d.pageCount} page${d.pageCount === 1 ? "" : "s"}` : "page count pending"}
            </span>
          </span>
          {runningId === kid
            ? <span className="inline-flex items-center gap-1 text-[10px] font-black text-cyan-700 shrink-0"><Loader2 className="w-3 h-3 animate-spin" /> Reading…</span>
            : <span className="text-[10px] font-black text-cyan-700 shrink-0">Read{pages.length > 0 ? ` p.${pages[0]}${pages.length > 1 ? "…" : ""}` : ""}</span>}
        </button>
      );
    }
    const meta = d.state === "ready"
      ? FALLBACK_META // ready without a kdocId — must not crash the modal
      : STATE_META[d.state] ?? FALLBACK_META;
    return (
      <div key={d.dcDocId} title={meta.hint}
        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border border-dashed border-[var(--color-border)] opacity-80">
        <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block text-xs font-bold text-[var(--color-text-muted)] truncate">{d.name}</span>
          <span className="block text-[10px] text-[var(--color-text-faint)] truncate">{meta.hint}</span>
        </span>
        {d.state === "indexing" ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-black text-cyan-700 shrink-0">
            <Loader2 className="w-3 h-3 animate-spin" /> Indexing…
          </span>
        ) : d.state === "pending_sync" && model?.canSync ? (
          <button type="button" onClick={() => void syncAll()} disabled={syncing}
            className="text-[10px] font-black px-2 py-1 rounded-md border border-cyan-300 text-cyan-700 hover:bg-cyan-50 dark:hover:bg-cyan-950/40 disabled:opacity-50 shrink-0">
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        ) : d.state === "unwatched" && model?.canSync && container ? (
          <button type="button" onClick={() => requestLink(container)} disabled={linkingKey !== null}
            title={`Connect “${container.name}” to an AI knowledge library`}
            className="text-[10px] font-black px-2 py-1 rounded-md border border-amber-300 text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/40 disabled:opacity-50 shrink-0">
            {linkingKey === container.id ? "Linking…" : "Link to AI"}
          </button>
        ) : (
          <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded shrink-0 ${
            d.state === "pending_sync"
              ? "bg-cyan-100 dark:bg-cyan-900/50 text-cyan-700 dark:text-cyan-300"
              : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"
          }`}>
            {meta.label}
          </span>
        )}
      </div>
    );
  };

  const renderFolder = (f: DcFolderNode, depth: number) => (
    <div key={f.id} className={depth > 0 ? "ml-3 pl-2 border-l border-[var(--color-border)]/60" : ""}>
      <div className="flex items-center gap-1.5 px-1 py-1 text-[11px] font-black text-[var(--color-text)]">
        <FolderOpen className={`w-3.5 h-3.5 shrink-0 ${f.watched ? "text-cyan-600" : "text-amber-500"}`} />
        {f.name}
        <span className="text-[10px] font-bold text-[var(--color-text-muted)]">· {f.totalDocs}</span>
        {!f.watched && (model?.canSync ? (
          <button type="button" disabled={linkingKey !== null}
            onClick={() => requestLink({ type: "folder", id: f.id, name: f.name })}
            className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900 disabled:opacity-50">
            {linkingKey === f.id ? "linking…" : "not linked to AI — link now"}
          </button>
        ) : (
          <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300">
            not linked to AI
          </span>
        ))}
      </div>
      {f.docs.length > 0 && (
        <div className="space-y-1 mb-1">
          {f.docs.map((d) => docRow(d, { type: "folder", id: f.id, name: f.name }))}
        </div>
      )}
      {f.folders.map((c) => renderFolder(c, depth + 1))}
    </div>
  );

  const sheet = (
    <div className="fixed inset-0 z-[700] flex items-start justify-center bg-black/50 pt-[6vh] p-4 overscroll-contain" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[86vh] flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] shrink-0">
          <ScanSearch className="w-4 h-4 text-cyan-600" />
          <div className="flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">Read flows from a document</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              Your document libraries and folders, exactly as filed. Every file shows its AI status —
              ready ones read flows, blocked ones say why.
            </div>
          </div>
          {model?.canSync && model.knowledgeLibraries.length > 0 && (
            <button type="button" onClick={() => void syncAll()} disabled={syncing}
              title="Reconcile all knowledge libraries with document control now"
              className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[10px] font-black text-[var(--color-text-muted)] hover:text-cyan-700 hover:border-cyan-400 disabled:opacity-50 shrink-0">
              <RefreshCw className={`w-3 h-3 ${syncing ? "animate-spin" : ""}`} /> Sync
            </button>
          )}
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 space-y-2 shrink-0 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2 flex-wrap">
            <select value={dcLibFilter} onChange={(e) => setDcLibFilter(e.target.value)}
              className="flex-1 min-w-[10rem] px-2.5 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm">
              <option value="">All document libraries</option>
              {(model?.tree ?? []).map((l) => (
                <option key={l.id} value={l.id}>{l.name} ({l.totalDocs})</option>
              ))}
              {(model?.uploads.length ?? 0) > 0 && (
                <option value="__uploads">Direct AI uploads</option>
              )}
            </select>
            <div className="relative flex-1 min-w-[10rem]">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
              <input value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name…"
                className="w-full pl-8 pr-3 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input value={pagesRaw} onChange={(e) => setPagesRaw(e.target.value)}
              placeholder="Pages (optional): 1-4 or 2,5,9 — up to 6 per read"
              className="flex-1 px-2.5 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-xs font-mono" />
            {pages.length > 0 && (
              <span className="text-[10px] font-black text-cyan-700 shrink-0">reads p. {pages.join(", ")}</span>
            )}
          </div>
          {/* Multiple AI libraries → the link needs a destination. One click
              picks it; the linking + sync happen right here. */}
          {linking && (
            <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/80 dark:bg-amber-950/30 px-2.5 py-2 text-[11px] text-amber-900 dark:text-amber-300">
              <div className="font-black mb-1">Link &ldquo;{linking.name}&rdquo; to which AI knowledge library?</div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {(model?.knowledgeLibraries ?? []).map((kl) => (
                  <button key={kl.id} type="button" disabled={linkingKey !== null}
                    onClick={() => void doLink(kl.id, linking)}
                    className="px-2.5 py-1 rounded-lg border border-amber-400 bg-white dark:bg-transparent text-[11px] font-black text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/50 disabled:opacity-50">
                    {linkingKey !== null ? "Linking…" : kl.name}
                  </button>
                ))}
                <button type="button" onClick={() => setLinking(null)} disabled={linkingKey !== null}
                  className="px-2 py-1 text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                  Cancel
                </button>
              </div>
            </div>
          )}
          {syncNote && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 px-2.5 py-2 text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
              {syncNote}
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-2.5 py-2 text-[11px] text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-4 min-h-0">
          {model === null && loadError === null ? (
            <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-text-faint)]" /></div>
          ) : loadError ? (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-2.5 py-2 text-[11px] text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {loadError}
            </div>
          ) : viewTree.length === 0 && viewUploads.length === 0 ? (
            <div className="text-center text-[11px] text-[var(--color-text-muted)] py-6">
              {q ? "No documents match that search." : "No documents yet — upload PDFs in Documents or a knowledge library."}
            </div>
          ) : (
            <>
              {viewTree.map((l) => (
                <div key={l.id}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <BookOpen className={`w-3.5 h-3.5 shrink-0 ${l.watched ? "text-cyan-600" : "text-amber-500"}`} />
                    <span className="text-xs font-black text-[var(--color-text)]">{l.name}</span>
                    <span className="text-[10px] font-bold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] rounded-full px-1.5">
                      {l.totalDocs} doc{l.totalDocs === 1 ? "" : "s"}
                    </span>
                    {!l.watched && (model?.canSync ? (
                      <button type="button" disabled={linkingKey !== null}
                        onClick={() => requestLink({ type: "library", id: l.id, name: l.name })}
                        title="Watch this whole library — every folder, now and in the future"
                        className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900 disabled:opacity-50">
                        {linkingKey === l.id ? "linking…" : "not linked to AI — link whole library"}
                      </button>
                    ) : (
                      <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300">
                        not linked to AI
                      </span>
                    ))}
                  </div>
                  {l.docs.length > 0 && (
                    <div className="space-y-1 mb-1">
                      {l.docs.map((d) => docRow(d, { type: "library", id: l.id, name: l.name }))}
                    </div>
                  )}
                  {l.folders.map((f) => renderFolder(f, 0))}
                </div>
              ))}
              {viewUploads.map((g) => (
                <div key={g.knowledgeLibraryId}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <BookOpen className="w-3.5 h-3.5 text-orange-600 shrink-0" />
                    <span className="text-xs font-black text-[var(--color-text)]">Uploaded directly · {g.knowledgeLibraryName}</span>
                  </div>
                  <div className="space-y-1">
                    {g.docs.map((d) => docRow({
                      dcDocId: `up-${d.kdocId}`, name: d.name, state: "ready",
                      kdocId: d.kdocId, pageCount: d.pageCount,
                    }))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* The PFD isn't anywhere yet? The door is one click away, not a maze. */}
        <div className="px-3 py-2.5 border-t border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] shrink-0">
          Don&apos;t see your PFD book at all? <Link href="/knowledge" className="font-black text-cyan-700 hover:text-cyan-600 underline">Upload it to a knowledge library</Link> or file it in Documents inside a linked folder.
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}
