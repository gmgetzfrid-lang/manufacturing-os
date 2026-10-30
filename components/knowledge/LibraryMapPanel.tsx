"use client";

// LibraryMapPanel — what the assistant knows this library holds.
//
// Every document is profiled (type, designation, purpose); forms carry
// their fields. This panel shows that map, so "does it know we have a
// hydrotest checklist?" is answered by looking, and lets Admin / Document
// Control build or finish it. Small gaps (a few newly indexed documents) are
// mapped automatically on open; a big first mapping waits for a click,
// because it spends the mapper's AI budget.
//
// CATALOGS are marked by people, not guessed: "this document is our Piping
// specs — each section an entry", or "every document in this library is
// one Valve data sheet". The app reads what was marked, from its text.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Map as MapIcon, Loader2, FileText, ClipboardCheck, Table2, BookOpen, ChevronDown, Plus, RefreshCw, X, AlertTriangle } from "lucide-react";
import { getLibraryCatalog, mapLibraryCatalog, markCatalog, unmarkCatalog, type CatalogSummaryEntry, type CatalogListingInfo } from "@/lib/knowledge";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";

const TYPE_LABEL: Record<string, string> = {
  standard: "Standards", catalog: "Catalogs", form: "Forms", checklist: "Checklists",
  std_drawing: "Standard drawings", pid: "Drawings", procedure: "Procedures", datasheet: "Data sheets", other: "Other",
};
const PURPOSE_LABEL: Record<string, string> = {
  deviation: "Deviation / waiver", ncr: "Nonconformance", moc: "Management of change", tq: "Technical query",
  inspection: "Inspection", test: "Test record", permit: "Permit", other: "Form",
};
const AUTO_MAP_MAX = 10;

export default function LibraryMapPanel({ orgId, libraryId, libraryName, docs }: {
  orgId: string; libraryId: string; libraryName: string;
  /** The library's documents, to pick the one that holds a catalog. */
  docs: Array<{ id: string; name: string; pageCount: number | null; status: string }>;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getLibraryCatalog>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<{ profiled: number; remaining: number } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const autoTried = useRef(false);

  const load = useCallback(async () => {
    try { setData(await getLibraryCatalog(orgId, libraryId)); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [orgId, libraryId]);

  const runMap = useCallback(async () => {
    setMapping({ profiled: 0, remaining: data?.unmapped ?? 0 });
    setError(null);
    try { await mapLibraryCatalog(orgId, libraryId, (p) => setMapping(p)); }
    catch (e) { setError((e as Error).message); }
    finally { setMapping(null); void load(); }
  }, [orgId, libraryId, data?.unmapped, load]);

  // Catalogs: marked by a person, read from the text.
  const [marking, setMarking] = useState(false);
  const [busyCatalog, setBusyCatalog] = useState<string | null>(null);
  const reread = useCallback(async (c: CatalogListingInfo) => {
    setBusyCatalog(c.documentId ?? c.libraryId);
    setError(null);
    try { await markCatalog(orgId, c.libraryId, c.name, c.documentId); }
    catch (e) { setError((e as Error).message); }
    finally { setBusyCatalog(null); void load(); }
  }, [orgId, load]);
  const unmark = useCallback(async (c: CatalogListingInfo) => {
    setBusyCatalog(c.documentId ?? c.libraryId);
    setError(null);
    try { await unmarkCatalog(orgId, c.libraryId, c.documentId); }
    catch (e) { setError((e as Error).message); }
    finally { setBusyCatalog(null); void load(); }
  }, [orgId, load]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!data || autoTried.current || mapping) return;
    if (data.canMap && data.unmapped > 0 && data.unmapped <= AUTO_MAP_MAX) {
      autoTried.current = true;
      void runMap();
    }
  }, [data, mapping, runMap]);

  if (!data && !error) return null;
  const entries = data?.entries ?? [];
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const forms = entries.filter((e) => e.type === "form" || e.type === "checklist");
  const catalogs = data?.catalogs ?? [];

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 mb-6">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="w-9 h-9 rounded-lg bg-violet-600 flex items-center justify-center shrink-0">
          <MapIcon className="w-4 h-4 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-black text-[var(--color-text)]">Library map</div>
          <div className="text-[11px] text-[var(--color-text-muted)]">
            What the assistant knows is here - so it can point you to the right form, checklist or spec without being asked.
          </div>
        </div>
        {data?.canMap && data.unmapped > 0 && !mapping && (
          <button type="button" onClick={() => void runMap()}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-violet-600 text-white text-xs font-black hover:bg-violet-700">
            <MapIcon className="w-4 h-4" /> Map {data.unmapped} document{data.unmapped === 1 ? "" : "s"}
          </button>
        )}
      </div>

      {mapping && (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-[var(--color-text)]" role="status">
          <Loader2 className="w-4 h-4 animate-spin text-violet-600" />
          Mapping - {mapping.profiled} profiled
          {mapping.remaining > 0 ? `, ${mapping.remaining} to go` : ""}. You can keep working; it continues while this page is open.
        </div>
      )}
      {error && <div className="mt-3 text-[12px] font-bold text-rose-700 dark:text-rose-400">{error}</div>}

      {entries.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type, n]) => (
            <span key={type} className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text)]">
              {n} {TYPE_LABEL[type] ?? type}
            </span>
          ))}
        </div>
      )}

      {forms.length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">Forms &amp; checklists the assistant can fill or point to</div>
          <ul className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] overflow-hidden">
            {forms.slice(0, showAll ? forms.length : 6).map((e) => (
              <li key={e.documentId} className="flex items-center gap-2.5 px-3.5 py-2">
                {e.type === "checklist" ? <ClipboardCheck className="w-4 h-4 text-violet-600 shrink-0" /> : <FileText className="w-4 h-4 text-violet-600 shrink-0" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-bold text-[var(--color-text)] truncate">{e.title || e.name}</span>
                  <span className="block text-[10px] text-[var(--color-text-muted)] truncate">
                    {e.type === "checklist" ? `Checklist${e.checklistFor ? ` - ${e.checklistFor}` : ""}` : PURPOSE_LABEL[e.form?.purpose ?? "other"]}
                    {e.form ? ` · ${e.form.fieldCount} fields` : ""}
                  </span>
                </span>
                {e.form && (
                  <span className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded ${e.form.fillable
                    ? "bg-emerald-100 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300"
                    : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>
                    {e.form.fillable ? "fillable PDF" : "flat PDF"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(catalogs.length > 0 || data?.canMap) && (
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Catalogs</div>
            {data?.canMap && (
              <button type="button" onClick={() => setMarking(true)}
                className="ml-auto inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-violet-300 dark:border-violet-800 text-violet-700 dark:text-violet-300 text-[11px] font-black hover:bg-violet-50 dark:hover:bg-violet-950/30">
                <Plus className="w-3.5 h-3.5" /> Mark a catalog
              </button>
            )}
          </div>
          {catalogs.length === 0 ? (
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Does this library hold a catalog - specs, data sheets, material classes, anything listed by code? Mark it, and
              questions like &ldquo;which one should I use for …&rdquo; are answered by filtering every entry, not by a lucky search.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] overflow-hidden">
              {catalogs.map((c) => {
                const busy = busyCatalog === (c.documentId ?? c.libraryId);
                const here = c.libraryId === libraryId;
                return (
                  <li key={`${c.libraryId}:${c.documentId ?? ""}`} className="px-3.5 py-2">
                    <div className="flex items-center gap-2">
                      <Table2 className="w-4 h-4 text-violet-600 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-bold text-[var(--color-text)] truncate">{c.name}</span>
                        <span className="block text-[10px] text-[var(--color-text-muted)] truncate">
                          {c.scope === "document" ? `${(c.documentName ?? "").replace(/\.pdf$/i, "")} - each section is an entry` : `every document in ${c.libraryName} is an entry`}
                          {!here ? ` · in ${c.libraryName}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] font-bold text-[var(--color-text)]">{c.mark.entries.toLocaleString()} entries</span>
                      {data?.canMap && here && (
                        <>
                          <button type="button" onClick={() => void reread(c)} disabled={busy} title="Read it again"
                            className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                          </button>
                          <button type="button" onClick={() => void unmark(c)} disabled={busy} title="Unmark - it stays in the library as an ordinary document"
                            className="p-1.5 rounded-lg hover:bg-rose-500/10 text-[var(--color-text-muted)] hover:text-rose-600">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                    {c.mark.problem && (
                      <div className="mt-1 flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-400"><AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />{c.mark.problem}</div>
                    )}
                    {!c.mark.problem && (c.mark.fields?.length ?? 0) > 0 && (
                      <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)] truncate">Fields read from it: {c.mark.fields!.join(" · ")}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {marking && (
        <MarkCatalogModal orgId={orgId} libraryId={libraryId} libraryName={libraryName} docs={docs}
          onClose={() => setMarking(false)} onDone={() => { setMarking(false); void load(); }} />
      )}

      {entries.length > 0 && (
        <button type="button" onClick={() => setShowAll((v) => !v)}
          className="mt-3 inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          <BookOpen className="w-3.5 h-3.5" /> {showAll ? "Hide" : "Show"} every mapped document ({entries.length})
          <ChevronDown className={`w-3 h-3 transition-transform ${showAll ? "rotate-180" : ""}`} />
        </button>
      )}
      {showAll && (
        <ul className="mt-2 max-h-80 overflow-y-auto divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]">
          {entries.map((e: CatalogSummaryEntry) => (
            <li key={e.documentId} className="px-3.5 py-2">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-violet-700 dark:text-violet-300 w-28 truncate">{TYPE_LABEL[e.type] ?? e.type}</span>
                <span className="text-xs font-bold text-[var(--color-text)] truncate">{e.designation ? `${e.designation} - ` : ""}{e.title || e.name}</span>
              </div>
              {e.purpose && <div className="text-[11px] text-[var(--color-text-muted)] pl-[7.5rem] truncate">{e.purpose}</div>}
            </li>
          ))}
        </ul>
      )}

      {entries.length === 0 && !mapping && (
        <p className="mt-3 text-[12px] text-[var(--color-text-muted)]">
          {data?.canMap
            ? "Nothing mapped yet. Mapping reads each indexed document once (fast AI tier, your key) and records what it is - forms with their fields, checklists with what they're for."
            : "Nothing mapped yet - an Admin or Document Control member can map this library."}
        </p>
      )}
      {(data?.notReady ?? 0) > 0 && (
        <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
          {data!.notReady} document{data!.notReady === 1 ? " is" : "s are"} still indexing - mapped once indexing finishes.
        </p>
      )}
    </div>
  );
}

/** Mark a catalog: what it's called, and where it is — one document whose
 *  sections are entries, or the whole library, one entry per document. */
function MarkCatalogModal({ orgId, libraryId, libraryName, docs, onClose, onDone }: {
  orgId: string; libraryId: string; libraryName: string;
  docs: Array<{ id: string; name: string; pageCount: number | null; status: string }>;
  onClose: () => void; onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"document" | "library">("document");
  const [query, setQuery] = useState("");
  const [docId, setDocId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ entries: number; problem?: string; fields?: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Biggest first: a catalog bound in one file is usually the largest there is.
  const ready = docs.filter((d) => d.status === "ready").sort((a, b) => (b.pageCount ?? 0) - (a.pageCount ?? 0));
  const shown = ready.filter((d) => !query || d.name.toLowerCase().includes(query.toLowerCase())).slice(0, 50);
  const can = name.trim().length > 0 && (scope === "library" || !!docId) && !busy;

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const mark = await markCatalog(orgId, libraryId, name.trim(), scope === "document" ? docId! : undefined);
      setResult(mark);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={busy ? () => undefined : (result ? onDone : onClose)} size="md" dismissable={!busy}>
      <ModalHeader icon={Table2} title="Mark a catalog" subtitle="Tell the assistant what this is - it reads it from the text, no AI cost." onClose={busy ? undefined : (result ? onDone : onClose)} />
      <ModalBody className="space-y-4">
        {result ? (
          result.entries > 0 ? (
            <div className="text-sm text-[var(--color-text)]">
              <b>{result.entries.toLocaleString()} entries</b> read from &ldquo;{name.trim()}&rdquo;.
              {(result.fields?.length ?? 0) > 0 && <div className="mt-1 text-[12px] text-[var(--color-text-muted)]">Fields found on them: {result.fields!.join(" · ")}</div>}
              <div className="mt-2 text-[12px] text-[var(--color-text-muted)]">Questions that name it, or ask which one to use, now filter every entry.</div>
            </div>
          ) : (
            <div className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{result.problem ?? "No entries were found."}</div>
          )
        ) : (
          <>
            <label className="block">
              <span className="block text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">What does your team call it?</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60}
                placeholder="e.g. Piping specs, Valve data sheets, Coating systems"
                className="w-full h-9 px-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-violet-400" />
            </label>
            <div>
              <span className="block text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Where is it?</span>
              <div className="space-y-1.5">
                <label className="flex items-start gap-2 text-[13px] text-[var(--color-text)] cursor-pointer">
                  <input type="radio" className="mt-1 accent-violet-600" checked={scope === "document"} onChange={() => setScope("document")} />
                  <span><b>One document holds all of it</b><span className="block text-[11px] text-[var(--color-text-muted)]">Each section is an entry - found by the code that repeats on its pages.</span></span>
                </label>
                <label className="flex items-start gap-2 text-[13px] text-[var(--color-text)] cursor-pointer">
                  <input type="radio" className="mt-1 accent-violet-600" checked={scope === "library"} onChange={() => setScope("library")} />
                  <span><b>Every document in {libraryName} is one entry</b><span className="block text-[11px] text-[var(--color-text-muted)]">A folder of separate sheets - {ready.length.toLocaleString()} indexed documents.</span></span>
                </label>
              </div>
            </div>
            {scope === "document" && (
              <div>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find the document…"
                  className="w-full h-8 px-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-violet-400" />
                <ul className="mt-1.5 max-h-56 overflow-y-auto rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                  {shown.map((d) => (
                    <li key={d.id}>
                      <button type="button" onClick={() => setDocId(d.id)}
                        className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs ${docId === d.id ? "bg-violet-50 dark:bg-violet-950/30 text-violet-800 dark:text-violet-200 font-bold" : "text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                        <FileText className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" />
                        <span className="truncate flex-1">{d.name}</span>
                        <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{d.pageCount ?? "?"} pages</span>
                      </button>
                    </li>
                  ))}
                  {shown.length === 0 && <li className="px-3 py-2 text-[11px] text-[var(--color-text-muted)]">No indexed document matches.</li>}
                </ul>
              </div>
            )}
            {error && <div className="text-[12px] font-bold text-rose-700 dark:text-rose-400">{error}</div>}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        {result ? (
          <button type="button" onClick={onDone} className="h-9 px-4 rounded-lg bg-violet-600 text-white text-xs font-black hover:bg-violet-700">Done</button>
        ) : (
          <>
            <button type="button" onClick={onClose} disabled={busy} className="h-9 px-3 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
            <button type="button" onClick={() => void save()} disabled={!can}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-violet-600 text-white text-xs font-black hover:bg-violet-700 disabled:opacity-40">
              {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Reading…</> : "Mark and read it"}
            </button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
