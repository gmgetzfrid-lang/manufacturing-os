"use client";

// CoverageReport — GAP-308: how you know an import or a sweep was right.
// Four working lists (agree / in the list on no sheet / on a sheet in no
// list / disagree), per operating unit or org-wide, re-derived from the rows
// on every open (lib/bridgeCoverage.ts). "Partially imported" is a state the
// report holds honestly; each list is the to-do list for it. Tags read off a
// P&ID uploaded straight into a knowledge library (no controlled document)
// can be discovered from here (GAP-307's knowledge door) — created unit-less
// and reported, never guessed. Mounted org-wide from the equipment sweep and,
// scoped to the unit, from an operating unit's page (/admin/assets?unit=).

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw, Boxes, AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { CoverageReport as Report, CoverageWhere } from "@/lib/bridgeCoverage";
import { sheetMarkOf } from "@/lib/relationProvenance";

type Tab = "agree" | "listOnly" | "sheetOnly" | "disagree";

const TAB_LABEL: Record<Tab, string> = {
  agree: "Agree",
  listOnly: "In the list, on no sheet",
  sheetOnly: "On a sheet, in no list",
  disagree: "Disagree",
};

export function whereText(w: CoverageWhere): string {
  // GOV-9: a sheet address read off an AI transcription is a reading, not an
  // identity; GOV-16 (I-32 merge): nor is the sweep's address on a person's
  // (adopted) link — both marks from lib/relationProvenance.ts.
  const mark = w.sheet ? sheetMarkOf(w.aiRead ? "ai" : w.sheetUnconfirmed ? "sweep" : null) : null;
  const at = w.sheet ? (mark ? `${w.sheet} (${mark})` : w.sheet)
    : (w.pages.length > 0 ? `page${w.pages.length === 1 ? "" : "s"} ${w.pages.join(", ")}` : null);
  // GAP-307 acceptance 3: an upload's link recorded in its own relation (20261235).
  const door = w.door === "knowledge" ? (w.via === "relation" ? " (knowledge upload · linked)" : " (knowledge upload)")
    : w.via === "extracted" ? " (read, not applied)" : "";
  return `${w.name}${at ? ` · ${at}` : ""}${door}`;
}

function WhereLink({ w }: { w: CoverageWhere }) {
  if (w.documentId && w.libraryId) {
    return <Link href={`/documents/${w.libraryId}?doc=${w.documentId}`} className="hover:underline">{whereText(w)}</Link>;
  }
  return <span>{whereText(w)}</span>;
}

export default function CoverageReport({ orgId, units, initialUnitCode }: {
  orgId: string;
  units: Array<{ code: string; label: string }>;
  /** Opened from an operating unit's page: start scoped to that unit (the
   *  selector still widens it to org-wide). */
  initialUnitCode?: string | null;
}) {
  const [unitCode, setUnitCode] = useState<string>(initialUnitCode ?? "");
  const [report, setReport] = useState<Report | null>(null);
  const [tab, setTab] = useState<Tab>("sheetOnly");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, Set<string>>>({}); // knowledge doc → tags
  const [discoverNote, setDiscoverNote] = useState<string | null>(null);

  const headers = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return { Authorization: `Bearer ${session?.access_token ?? ""}`, "Content-Type": "application/json" };
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/equipment-bridge", {
        method: "POST", headers: await headers(),
        body: JSON.stringify({ action: "coverage", orgId, unitCode: unitCode || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setReport(json.report as Report);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [orgId, unitCode, headers]);

  useEffect(() => { void load(); }, [load]);

  const toggle = (kdoc: string, tag: string) => setPicked((p) => {
    const next = { ...p };
    const set = new Set(next[kdoc] ?? []);
    if (set.has(tag)) set.delete(tag); else set.add(tag);
    next[kdoc] = set;
    return next;
  });

  const discover = async () => {
    setDiscoverNote(null); setError(null);
    const entries = Object.entries(picked).filter(([, s]) => s.size > 0);
    if (entries.length === 0) return;
    let created = 0, existing = 0, untyped = 0, linked = 0;
    const failures: string[] = [];
    const relationNotes: string[] = [];
    const auditErrors: string[] = [];
    for (const [knowledgeDocumentId, set] of entries) {
      const res = await fetch("/api/equipment-bridge", {
        method: "POST", headers: await headers(),
        body: JSON.stringify({ action: "discover", orgId, knowledgeDocumentId, tags: [...set] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { failures.push(json.error ?? `HTTP ${res.status}`); continue; }
      created += (json.created ?? []).length;
      existing += (json.existing ?? []).length;
      untyped += (json.held ?? []).length;
      for (const f of json.failed ?? []) failures.push(`${f.tag}: ${f.reason}`);
      if (json.auditError) auditErrors.push(String(json.auditError));
      // GAP-307 acceptance 3: the upload's own links (20261235), or why not.
      linked += Number(json.relations?.written ?? 0);
      if (json.relations?.notRecorded) relationNotes.push(String(json.relations.notRecorded));
    }
    setPicked({});
    setDiscoverNote(
      `${created} discovered (filed to no unit — a knowledge upload has no drawing number to decode; file them on the Operating Areas page)` +
      (existing ? ` · ${existing} already in the registry` : "") +
      (untyped ? ` · ${untyped} with a prefix the Site Codebook does not know — teach it` : "") +
      (failures.length ? ` · ${failures.length} failed: ${failures.slice(0, 3).join("; ")}` : "") +
      (linked ? ` · ${linked} link${linked === 1 ? "" : "s"} to the upload's sheets recorded` : "") +
      (relationNotes.length ? ` · ${relationNotes[0]}` : ""),
    );
    await load();
    // The discovery landed but its audit row did not: said, never swallowed
    // (after the re-derive, which clears the error line).
    if (auditErrors.length > 0) setError(auditErrors[0]);
  };

  const pickedCount = Object.values(picked).reduce((n, s) => n + s.size, 0);
  const t = report?.totals;

  return (
    <div className="rounded-xl border border-[var(--color-border)] p-3 space-y-2.5" data-testid="coverage-report">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="font-black text-[var(--color-text)]">Coverage</span>
        <select value={unitCode} onChange={(e) => setUnitCode(e.target.value)} aria-label="Operating unit"
          className="h-8 px-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <option value="">Whole organisation</option>
          {units.map((u) => <option key={u.code} value={u.code}>{u.code} — {u.label}</option>)}
        </select>
        <button onClick={() => void load()} disabled={loading}
          className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-accent)] hover:underline disabled:opacity-40">
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Re-derive
        </button>
      </div>
      {error && <div className="text-[11px] text-red-800 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5 flex gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{error}</div>}
      {t && (
        <div className="text-[11px] text-[var(--color-text-muted)]">
          {t.assets} asset{t.assets === 1 ? "" : "s"}{report?.scope.unitCode ? ` in ${report.scope.unitCode}${report.scope.label ? ` — ${report.scope.label}` : ""}` : ""} ·
          {" "}{t.onSheet} on at least one sheet · {t.onNoSheet} on none · {t.sheetTagsWithoutAsset} sheet tag{t.sheetTagsWithoutAsset === 1 ? "" : "s"} matching no asset · {t.disagree} disagree
        </div>
      )}
      {report && report.notes.length > 0 && (
        <ul className="text-[10px] text-amber-800 list-disc pl-4">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      )}
      {report && (
        <>
          <div className="flex gap-1 flex-wrap" role="tablist">
            {(Object.keys(TAB_LABEL) as Tab[]).map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`px-2 py-1 rounded-md text-[10px] font-bold border ${tab === k ? "bg-[var(--color-accent)] text-white border-transparent" : "border-[var(--color-border)] text-[var(--color-text)]"}`}>
                {TAB_LABEL[k]} ({report[k].length})
              </button>
            ))}
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-[var(--color-border)] text-[11px]">
            {tab === "agree" && report.agree.map((a) => (
              <div key={a.assetId} className="py-1.5">
                <Link href={`/assets/${encodeURIComponent(a.tag)}`} className="font-mono font-bold hover:underline">{a.tag}</Link>
                <span className="text-[var(--color-text-muted)]"> · {a.where.map((w, i) => <React.Fragment key={i}>{i > 0 && "; "}<WhereLink w={w} /></React.Fragment>)}</span>
              </div>
            ))}
            {tab === "listOnly" && report.listOnly.map((a) => (
              <div key={a.assetId} className="py-1.5">
                <Link href={`/assets/${encodeURIComponent(a.tag)}`} className="font-mono font-bold hover:underline">{a.tag}</Link>
                <span className="text-[var(--color-text-muted)]"> · {a.unitCode ? `unit ${a.unitCode}` : "no unit"}{a.origin === "drawing" ? " · discovered from a drawing" : ""} · on no readable sheet</span>
              </div>
            ))}
            {tab === "sheetOnly" && report.sheetOnly.map((s) => (
              <div key={s.tag} className="py-1.5 space-y-0.5">
                <div className="font-mono font-bold flex items-center gap-1"><Boxes className="w-3 h-3 text-violet-600" />{s.tag}{s.unitHint && <span className="font-sans font-normal text-[var(--color-text-muted)]"> · drawing unit {s.unitHint}</span>}</div>
                {s.where.map((w, i) => (
                  <label key={i} className="flex items-center gap-1.5 pl-4 text-[var(--color-text-muted)]">
                    {w.door === "knowledge" && w.knowledgeDocumentId ? (
                      <input type="checkbox" checked={picked[w.knowledgeDocumentId]?.has(s.tag) ?? false}
                        onChange={() => toggle(w.knowledgeDocumentId!, s.tag)} className="w-3 h-3" aria-label={`Discover ${s.tag} from ${w.name}`} />
                    ) : <span className="w-3" />}
                    <WhereLink w={w} />
                    {w.door === "controlled" && <span className="text-[10px]"> — apply it from the equipment sweep</span>}
                  </label>
                ))}
              </div>
            ))}
            {tab === "disagree" && report.disagree.map((d) => (
              <div key={d.assetId} className="py-1.5">
                <Link href={`/assets/${encodeURIComponent(d.tag)}`} className="font-mono font-bold hover:underline">{d.tag}</Link>
                <span className="text-[var(--color-text-muted)]"> · filed to {d.assetUnit}; its drawing{d.drawingUnits.length === 1 ? " decodes" : "s decode"} to {d.drawingUnits.join(", ")} · {d.where.map((w, i) => <React.Fragment key={i}>{i > 0 && "; "}<WhereLink w={w} /></React.Fragment>)}</span>
              </div>
            ))}
            {report[tab].length === 0 && <div className="py-4 text-center italic text-[var(--color-text-faint)]">Nothing here.</div>}
          </div>
          {tab === "sheetOnly" && (
            <div className="flex items-center gap-2">
              <button onClick={() => void discover()} disabled={pickedCount === 0}
                className="px-2.5 py-1 rounded-lg text-[11px] font-bold text-white bg-[var(--color-accent)] disabled:opacity-40">
                Discover {pickedCount || ""} from knowledge uploads
              </button>
              <span className="text-[10px] text-[var(--color-text-faint)]">Created unit-less, origin “drawing”, with the sheet they came from — never guessed.</span>
            </div>
          )}
          {discoverNote && <div className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5">{discoverNote}</div>}
        </>
      )}
    </div>
  );
}
