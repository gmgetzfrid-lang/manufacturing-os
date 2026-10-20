"use client";

// LibraryMapPanel — what the assistant knows this library holds.
//
// Every document is profiled (type, designation, purpose); forms carry
// their fields, piping specs their extracted pipe classes. This panel shows
// that map, so "does it know we have a hydrotest checklist?" is answered by
// looking, and lets Admin / Document Control build or finish it. Small gaps
// (a few newly indexed documents) are mapped automatically on open; a big
// first mapping waits for a click, because it spends the mapper's AI budget.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Map as MapIcon, Loader2, FileText, ClipboardCheck, Table2, BookOpen, ChevronDown } from "lucide-react";
import { getLibraryCatalog, mapLibraryCatalog, type CatalogSummaryEntry } from "@/lib/knowledge";

const TYPE_LABEL: Record<string, string> = {
  standard: "Standards", pipe_spec: "Piping specs", form: "Forms", checklist: "Checklists",
  std_drawing: "Standard drawings", pid: "Drawings", procedure: "Procedures", datasheet: "Data sheets", other: "Other",
};
const PURPOSE_LABEL: Record<string, string> = {
  deviation: "Deviation / waiver", ncr: "Nonconformance", moc: "Management of change", tq: "Technical query",
  inspection: "Inspection", test: "Test record", permit: "Permit", other: "Form",
};
const AUTO_MAP_MAX = 10;

export default function LibraryMapPanel({ orgId, libraryId }: { orgId: string; libraryId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getLibraryCatalog>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<{ profiled: number; pipePages: number; remaining: number } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const autoTried = useRef(false);

  const load = useCallback(async () => {
    try { setData(await getLibraryCatalog(orgId, libraryId)); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [orgId, libraryId]);

  const runMap = useCallback(async () => {
    setMapping({ profiled: 0, pipePages: 0, remaining: data?.unmapped ?? 0 });
    setError(null);
    try { await mapLibraryCatalog(orgId, libraryId, (p) => setMapping(p)); }
    catch (e) { setError((e as Error).message); }
    finally { setMapping(null); void load(); }
  }, [orgId, libraryId, data?.unmapped, load]);

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
  const specs = entries.filter((e) => e.type === "pipe_spec");
  const classTotal = specs.reduce((n, e) => n + (e.pipeSpec?.classes ?? 0), 0);

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 mb-6">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="w-9 h-9 rounded-lg bg-violet-600 flex items-center justify-center shrink-0">
          <MapIcon className="w-4 h-4 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-black text-[var(--color-text)]">Library map</div>
          <div className="text-[11px] text-[var(--color-text-muted)]">
            What the assistant knows is here — so it can point you to the right form, checklist or spec without being asked.
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
          Mapping — {mapping.profiled} profiled{mapping.pipePages > 0 ? `, ${mapping.pipePages} spec pages read` : ""}
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
          {classTotal > 0 && (
            <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-900 text-violet-800 dark:text-violet-300">
              {classTotal} pipe classes read
            </span>
          )}
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
                    {e.type === "checklist" ? `Checklist${e.checklistFor ? ` — ${e.checklistFor}` : ""}` : PURPOSE_LABEL[e.form?.purpose ?? "other"]}
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

      {specs.length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">Piping specs</div>
          <ul className="space-y-1">
            {specs.map((e) => (
              <li key={e.documentId} className="flex items-center gap-2 text-xs text-[var(--color-text)]">
                <Table2 className="w-4 h-4 text-violet-600 shrink-0" />
                <span className="truncate flex-1">{e.title || e.name}</span>
                <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">
                  {e.pipeSpec?.classes ?? 0} classes{e.pipeSpec && !e.pipeSpec.done ? " · still reading" : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
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
                <span className="text-xs font-bold text-[var(--color-text)] truncate">{e.designation ? `${e.designation} — ` : ""}{e.title || e.name}</span>
              </div>
              {e.purpose && <div className="text-[11px] text-[var(--color-text-muted)] pl-[7.5rem] truncate">{e.purpose}</div>}
            </li>
          ))}
        </ul>
      )}

      {entries.length === 0 && !mapping && (
        <p className="mt-3 text-[12px] text-[var(--color-text-muted)]">
          {data?.canMap
            ? "Nothing mapped yet. Mapping reads each indexed document once (fast AI tier, your key) and records what it is — forms with their fields, piping specs with every pipe class."
            : "Nothing mapped yet — an Admin or Document Control member can map this library."}
        </p>
      )}
      {(data?.notReady ?? 0) > 0 && (
        <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
          {data!.notReady} document{data!.notReady === 1 ? " is" : "s are"} still indexing — mapped once indexing finishes.
        </p>
      )}
    </div>
  );
}
