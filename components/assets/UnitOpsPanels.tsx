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
  ScanSearch, Trash2, FileText, Search, CheckCircle2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Asset, AssetType } from "@/lib/assets";
import type { Codebook } from "@/lib/codebook";
import { planCategorization, applyCategorization, type CategorizationResult } from "@/lib/assetCategorize";
import { listProcessFlows, decideFlow, deleteFlow, type ProcessFlow } from "@/lib/processFlows";

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
  if (uncategorized === 0 && !result) return null;

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
            {result.categorized} categorized{result.createdTypes > 0 ? ` · ${result.createdTypes} new categor${result.createdTypes === 1 ? "y" : "ies"} created from your codebook` : ""}
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
              {uncategorized} piece{uncategorized === 1 ? "" : "s"} of equipment uncategorized
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              Your Site Codebook already knows the taxonomy — {plan.assignments.length > 0
                ? <>its prefixes decode {plan.assignments.length} of them{plan.typesToCreate.length > 0 ? `, creating ${plan.typesToCreate.slice(0, 4).join(", ")}${plan.typesToCreate.length > 4 ? "…" : ""}` : ""}.</>
                : <>but none of its prefixes match these tags. Add the prefixes in the <Link href="/admin/codebook" className="underline font-bold">Site Codebook</Link>.</>}
            </div>
          </div>
          {plan.assignments.length > 0 && (
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
    <div className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5"
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

/** Pick the PFD, run the reader. Browse BY LIBRARY (a unit's PFD book lives
 *  in a specific knowledge library), target the exact sheets of a multi-page
 *  book, and if the drawing isn't indexed yet the door to upload it is one
 *  click away. Portaled to <body> so no ancestor transform can trap or clip
 *  the sheet. */
function ReadFlowsModal({ orgId, onClose, onDone }: {
  orgId: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [libraries, setLibraries] = useState<Array<{ id: string; name: string }>>([]);
  const [libraryId, setLibraryId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [pagesRaw, setPagesRaw] = useState("");
  const [docs, setDocs] = useState<Array<{ id: string; name: string; library_id: string; page_count: number | null }> | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.from("knowledge_libraries").select("id, name").eq("org_id", orgId).order("name")
      .then(({ data }) => { if (alive) setLibraries((data as Array<{ id: string; name: string }>) ?? []); });
    return () => { alive = false; };
  }, [orgId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      let q = supabase.from("knowledge_documents")
        .select("id, name, library_id, page_count").eq("org_id", orgId)
        .order("created_at", { ascending: false }).limit(50);
      if (libraryId) q = q.eq("library_id", libraryId);
      if (query.trim()) q = q.ilike("name", `%${query.trim()}%`);
      const { data } = await q;
      if (alive) setDocs((data as Array<{ id: string; name: string; library_id: string; page_count: number | null }>) ?? []);
    })();
    return () => { alive = false; };
  }, [orgId, libraryId, query]);

  const libName = useMemo(() => new Map(libraries.map((l) => [l.id, l.name])), [libraries]);

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

  const run = async (docId: string) => {
    setRunningId(docId); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/flows/read", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token ?? ""}`,
        },
        body: JSON.stringify({ orgId, knowledgeDocumentId: docId, ...(pages.length > 0 ? { pages } : {}) }),
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

  const sheet = (
    <div className="fixed inset-0 z-[700] flex items-start justify-center bg-black/50 pt-[6vh] p-4 overscroll-contain" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[86vh] flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] shrink-0">
          <ScanSearch className="w-4 h-4 text-cyan-600" />
          <div className="flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">Read flows from a document</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              Pick a PFD or block diagram from any knowledge library. The AI reads the printed pages
              and proposes flows — only between equipment and units that exist here.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 space-y-2 shrink-0 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2 flex-wrap">
            <select value={libraryId} onChange={(e) => setLibraryId(e.target.value)}
              className="flex-1 min-w-[10rem] px-2.5 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm">
              <option value="">All knowledge libraries</option>
              {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
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
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-2.5 py-2 text-[11px] text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1 min-h-0">
          {docs === null ? (
            <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-text-faint)]" /></div>
          ) : docs.length === 0 ? (
            <div className="text-center text-[11px] text-[var(--color-text-muted)] py-6 space-y-1">
              <div>No indexed documents match{libraryId ? " in this library" : ""}.</div>
            </div>
          ) : docs.map((d) => (
            <button key={d.id} onClick={() => void run(d.id)} disabled={runningId !== null}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border border-[var(--color-border)] hover:border-cyan-400 text-left disabled:opacity-50">
              <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-bold text-[var(--color-text)] truncate">{d.name}</span>
                <span className="block text-[10px] text-[var(--color-text-faint)] truncate">
                  {libName.get(d.library_id) ?? "Library"}{d.page_count ? ` · ${d.page_count} page${d.page_count === 1 ? "" : "s"}` : ""}
                </span>
              </span>
              {runningId === d.id
                ? <span className="inline-flex items-center gap-1 text-[10px] font-black text-cyan-700 shrink-0"><Loader2 className="w-3 h-3 animate-spin" /> Reading…</span>
                : <span className="text-[10px] font-black text-cyan-700 shrink-0">Read{pages.length > 0 ? ` p.${pages[0]}${pages.length > 1 ? "…" : ""}` : ""}</span>}
            </button>
          ))}
        </div>

        {/* The PFD isn't indexed yet? The door is one click away, not a maze. */}
        <div className="px-3 py-2.5 border-t border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] shrink-0">
          Don&apos;t see your PFD book? <Link href="/knowledge" className="font-black text-cyan-700 hover:text-cyan-600 underline">Upload it to a knowledge library</Link> first — once indexed it appears here.
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}
