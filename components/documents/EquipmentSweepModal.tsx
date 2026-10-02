"use client";

import Link from "next/link";

// EquipmentSweepModal — the drawing→equipment bridge's review surface for a
// document library. One screen: map which tags-column receives equipment
// (optional — the registry and the document↔equipment relation are filled
// without one), sweep every drawing that has an indexed knowledge twin (in
// resumable pages), review the per-document proposals — pick tags, apply
// them or dismiss them; tags the Site Codebook does not know are held — and
// review the links the current revision no longer carries. Suggest-then-
// approve by default; an auto-apply toggle hands the loop to the machine
// once it is trusted. The coverage report opens from here (org-wide or per
// unit).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  X, Loader2, Sparkles, Check, RefreshCw, AlertTriangle, Boxes, Settings2, ScanSearch,
  GraduationCap, Ban, ListChecks,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { loadCodebook, EMPTY_CODEBOOK, type Codebook } from "@/lib/codebook";
import { Button } from "@/components/ui/Button";
import CoverageReport from "@/components/assets/CoverageReport";
import type { BridgeConfig, BridgeSuggestion, BridgeSheet } from "@/lib/equipmentBridgeServer";

interface SuggestionRow {
  document_id: string;
  documentLabel: string;
  suggested: Array<BridgeSuggestion & { unitCode?: string | null; unitSource?: string | null; unitRejected?: string | null }>;
  applied: string[];
  status: "pending" | "applied" | "dismissed";
}

interface RelationRow {
  document_id: string; tag_text: string | null; sheet_label: string | null;
  vanished_at?: string | null; superseded_at?: string | null; source_revision?: string | null; model?: string | null;
}

interface ColumnDef { key: string; label?: string; type?: string; isPill?: boolean }

type SweepCounts = Record<string, number>;

/** How a sheet reads (kept beside lib/equipmentBridgeServer sheetText so the
 *  client bundle never imports the server module): the address, or the page
 *  with that fact stated; an AI-transcribed title block is unconfirmed. */
function sheetText(s: Pick<BridgeSheet, "page" | "label" | "aiRead">): string {
  if (!s.label) return `page ${s.page} (no title block read)`;
  return s.aiRead ? `${s.label} (AI-read, unconfirmed)` : s.label;
}

/** The chip tooltip: the stored field and the tooltip agree on sheet vs page
 *  (BR-10). */
export function chipTitle(s: BridgeSuggestion): string {
  const where = (s.sheets && s.sheets.length > 0)
    ? s.sheets.map(sheetText).join("; ")
    : `page${s.pages.length === 1 ? "" : "s"} ${s.pages.join(", ")}`;
  return [
    s.code,
    where,
    s.model ? `read from an AI transcription (${s.model})` : null,
    s.held === "unknown_prefix" ? "the Site Codebook knows no equipment type for this prefix — teach it, or pick the tag to create it anyway" : null,
    s.dismissed ? "dismissed — pick it and apply to take it back" : null,
    s.assetStatus === "new" && !s.held ? "not in registry yet" : null,
  ].filter(Boolean).join(" · ");
}

export default function EquipmentSweepModal({ orgId, libraryId, libraryName, onClose, onApplied }: {
  orgId: string;
  libraryId: string;
  libraryName: string;
  onClose: () => void;
  /** Called after any apply so the page refetches documents (new chips). */
  onApplied: () => void;
}) {
  const [rows, setRows] = useState<SuggestionRow[]>([]);
  const [relations, setRelations] = useState<RelationRow[]>([]);
  const [relationNote, setRelationNote] = useState<string | null>(null);
  const [bridge, setBridge] = useState<BridgeConfig>({});
  const [columns, setColumns] = useState<ColumnDef[]>([]);
  const [book, setBook] = useState<Codebook>(EMPTY_CODEBOOK);
  const [linkedCount, setLinkedCount] = useState(0);
  const [unreadable, setUnreadable] = useState(0);
  const [uploadOrigin, setUploadOrigin] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sweeping, setSweeping] = useState(false);
  const [sweepProgress, setSweepProgress] = useState<{ counts: SweepCounts; cursor: string | null; done: boolean } | null>(null);
  const [applying, setApplying] = useState<string | null>(null); // doc id or "__all"
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});
  const [showCoverage, setShowCoverage] = useState(false);

  const authed = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return { Authorization: `Bearer ${session?.access_token ?? ""}` };
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const headers = await authed();
      const res = await fetch(`/api/equipment-bridge?orgId=${encodeURIComponent(orgId)}&libraryId=${encodeURIComponent(libraryId)}`, { headers });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRows((json.suggestions as SuggestionRow[]).sort((a, b) => a.documentLabel.localeCompare(b.documentLabel, undefined, { numeric: true })));
      setRelations((json.relations as RelationRow[]) ?? []);
      setRelationNote((json.relationNote as string | null) ?? null);
      setBridge((json.bridge as BridgeConfig) ?? {});
      setColumns((json.customColumns as ColumnDef[]) ?? []);
      setLinkedCount(new Set((json.linkedDocs as Array<{ documentId: string }>).map((l) => l.documentId)).size);
      setUnreadable(Number(json.unreadable ?? 0));
      setUploadOrigin(Number(json.uploadOrigin ?? 0));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [orgId, libraryId, authed]);

  useEffect(() => { void refresh(); void loadCodebook(orgId).then(setBook); }, [refresh, orgId]);

  // Columns eligible to receive tags: multi-value / pill-style ones.
  const tagColumns = useMemo(
    () => columns.filter((c) => c.type === "tags" || c.type === "multi" || c.isPill),
    [columns]);

  const unitLabel = useCallback((code: string | null | undefined) => {
    if (!code) return null;
    return book.units.find((u) => u.code === code)?.label ?? null;
  }, [book]);

  const saveSettings = async (patch: Partial<BridgeConfig>) => {
    const next = { ...bridge, ...patch };
    setBridge(next);
    try {
      const headers = { ...(await authed()), "Content-Type": "application/json" };
      const res = await fetch("/api/equipment-bridge", {
        method: "POST", headers,
        body: JSON.stringify({ action: "settings", orgId, libraryId, ...next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.bridge) setBridge(json.bridge as BridgeConfig);
      setSavedTick(true); setTimeout(() => setSavedTick(false), 1500);
    } catch (e) { setError((e as Error).message); }
  };

  /** BR-11: the sweep runs in bounded pages; each call returns where it
   *  stopped. A failed call keeps the cursor, so "Resume" continues from
   *  there instead of starting over. */
  const sweep = async (resume = false) => {
    setSweeping(true); setError(null); setNotice(null);
    let cursor: string | null = resume ? sweepProgress?.cursor ?? null : null;
    const counts: SweepCounts = resume && sweepProgress ? { ...sweepProgress.counts } : {};
    try {
      const headers = { ...(await authed()), "Content-Type": "application/json" };
      for (let guard = 0; guard < 500; guard++) {
        const res = await fetch("/api/equipment-bridge", {
          method: "POST", headers,
          body: JSON.stringify({ action: "sweep", orgId, libraryId, cursor }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        for (const [k, v] of Object.entries((json.counts ?? {}) as SweepCounts)) counts[k] = (counts[k] ?? 0) + Number(v);
        cursor = (json.nextCursor as string | null) ?? null;
        setSweepProgress({ counts: { ...counts }, cursor, done: !!json.done });
        if (json.done || !cursor) break;
      }
      await refresh();
    } catch (e) {
      setSweepProgress({ counts: { ...counts }, cursor, done: false });
      setError(`${(e as Error).message} — the sweep stopped part-way; Resume continues from where it stopped.`);
    } finally { setSweeping(false); }
  };

  const summarise = (results: Array<Record<string, unknown>>, unreadableSkipped: number): string | null => {
    const parts: string[] = [];
    const sum = (k: string) => results.reduce((n, r) => n + (Array.isArray(r[k]) ? (r[k] as unknown[]).length : 0), 0);
    const created = results.reduce((n, r) => n + Number(r.createdAssets ?? 0), 0);
    const written = results.reduce((n, r) => n + Number((r.relations as { written?: number } | undefined)?.written ?? 0), 0);
    if (created) parts.push(`${created} asset${created === 1 ? "" : "s"} discovered`);
    if (written) parts.push(`${written} link${written === 1 ? "" : "s"} to sheets recorded`);
    const held = sum("held");
    if (held) parts.push(`${held} held — the Site Codebook knows no type for the prefix (teach it, or pick the tag to create it)`);
    const degraded = sum("degraded");
    if (degraded) parts.push(`${degraded} created without unit, code and provenance — the database is missing the registry migration`);
    const notRecorded = results.map((r) => (r.relations as { notRecorded?: string | null } | undefined)?.notRecorded).find(Boolean);
    if (notRecorded) parts.push(String(notRecorded));
    const failedTags = sum("failed");
    if (failedTags) parts.push(`${failedTags} tag${failedTags === 1 ? "" : "s"} could not be created`);
    if (unreadableSkipped) parts.push(`${unreadableSkipped} document${unreadableSkipped === 1 ? "" : "s"} skipped — you cannot read them`);
    const notFound = results.filter((r) => r.skipped === "not_found").length;
    if (notFound) parts.push(`${notFound} document${notFound === 1 ? "" : "s"} not found in this workspace`);
    return parts.length ? parts.join(" · ") : null;
  };

  const apply = async (documentIds: string[], tags?: string[]) => {
    setApplying(documentIds.length === 1 ? documentIds[0] : "__all");
    setError(null); setNotice(null);
    try {
      const headers = { ...(await authed()), "Content-Type": "application/json" };
      const res = await fetch("/api/equipment-bridge", {
        method: "POST", headers,
        body: JSON.stringify({ action: "apply", orgId, documentIds, ...(tags ? { tags } : {}) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const results = (json.results as Array<Record<string, unknown>>) ?? [];
      const failed = results.filter((r) => r.error);
      if (failed.length > 0) setError(`${failed.length} document(s) failed — first: ${failed[0].error}`);
      setNotice(summarise(results, Number(json.unreadable ?? 0)));
      if (tags) setPicked((p) => ({ ...p, [documentIds[0]]: new Set() }));
      await refresh();
      onApplied();
    } catch (e) { setError((e as Error).message); }
    finally { setApplying(null); }
  };

  const post = async (payload: Record<string, unknown>) => {
    const headers = { ...(await authed()), "Content-Type": "application/json" };
    const res = await fetch("/api/equipment-bridge", { method: "POST", headers, body: JSON.stringify({ orgId, ...payload }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json as Record<string, unknown>;
  };

  const dismiss = async (documentId: string, tags: string[]) => {
    setApplying(documentId); setError(null); setNotice(null);
    try {
      const json = await post({ action: "dismiss", documentId, tags });
      setPicked((p) => ({ ...p, [documentId]: new Set() }));
      setNotice(`${(json.dismissed as string[] | undefined)?.length ?? 0} tag(s) dismissed — never applied again; a later revision that brings one back proposes it again.` +
        (json.remembered === false ? " (This database cannot remember dismissals across a re-sweep yet — migration 20261171.)" : "") +
        (Number(json.keptAsPersonsLink ?? 0) > 0 ? ` ${json.keptAsPersonsLink} link(s) stay, because the document's own equipment tags name them.` : ""));
      if (json.auditError) setError(String(json.auditError));
      await refresh();
      onApplied();
    } catch (e) { setError((e as Error).message); }
    finally { setApplying(null); }
  };

  const reviewVanished = async (documentId: string, tag: string, decision: "remove" | "keep") => {
    setApplying(documentId); setError(null);
    try {
      const json = await post({ action: "vanished", documentId, tags: [tag], decision });
      if (json.auditError) setError(String(json.auditError));
      else if (Number(json.keptAsPersonsLink ?? 0) > 0) setNotice("The drawing's link was removed; the link stays, because the document's own equipment tags name it.");
      await refresh();
      onApplied();
    } catch (e) { setError((e as Error).message); }
    finally { setApplying(null); }
  };

  const togglePick = (docId: string, tag: string) => setPicked((p) => {
    const set = new Set(p[docId] ?? []);
    if (set.has(tag)) set.delete(tag); else set.add(tag);
    return { ...p, [docId]: set };
  });

  const freshOf = (r: SuggestionRow) => r.suggested.filter((s) => !r.applied.includes(s.tag) && !s.dismissed && !s.held);
  const pendingRows = rows.filter((r) => freshOf(r).length > 0);
  const totalNewAssets = pendingRows.reduce((n, r) => n + freshOf(r).filter((s) => s.assetStatus === "new").length, 0);
  const relationsByDoc = useMemo(() => {
    const m = new Map<string, RelationRow[]>();
    for (const r of relations) (m.get(r.document_id) ?? m.set(r.document_id, []).get(r.document_id)!).push(r);
    return m;
  }, [relations]);
  const counts = sweepProgress?.counts;

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4 animate-in fade-in">
      <div className="w-full max-w-3xl bg-[var(--color-surface)] rounded-2xl shadow-2xl flex flex-col max-h-[90vh] animate-in zoom-in-95">
        <div className="px-5 py-3.5 border-b border-[var(--color-border)] flex items-center gap-2.5">
          <ScanSearch className="w-4 h-4 text-orange-600" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">Equipment sweep — {libraryName}</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              AI-extracted tags from indexed drawings → the registry, the sheets each one is on, and your equipment column. {linkedCount} document{linkedCount === 1 ? "" : "s"} linked to knowledge.
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--color-surface-2)]" aria-label="Close"><X className="w-4 h-4 text-[var(--color-text-muted)]" /></button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto">
          {/* Mapping + behavior — the library's bridge settings. */}
          <div className="rounded-xl border border-[var(--color-border)] p-3 space-y-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-black text-[var(--color-text)]">
              <Settings2 className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> Bridge settings
              {savedTick && <span className="text-emerald-600 inline-flex items-center gap-0.5"><Check className="w-3 h-3" /> saved</span>}
            </div>
            <div className="flex items-center gap-3 flex-wrap text-xs">
              <Link href="/admin/ai-instructions?scope=equipment"
                className="inline-flex items-center gap-1 text-[10px] font-bold text-violet-700 hover:underline"
                title="Standing rules for how the AI reads your drawings (tag placement, vendor quirks)">
                <GraduationCap className="w-3 h-3" /> Teach the AI
              </Link>
              <label className="inline-flex items-center gap-1.5">
                <span className="text-[var(--color-text-muted)] font-bold">Send tags to</span>
                <select value={bridge.targetColumnKey ?? ""} onChange={(e) => void saveSettings({ targetColumnKey: e.target.value || undefined })}
                  className="h-8 px-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] font-bold">
                  <option value="">— no column (registry and sheets only) —</option>
                  {tagColumns.map((c) => <option key={c.key} value={c.key}>{c.label ?? c.key}</option>)}
                </select>
              </label>
              {book.units.length > 0 && (
                <label className="inline-flex items-center gap-1.5">
                  <span className="text-[var(--color-text-muted)] font-bold">Default unit</span>
                  <select value={bridge.defaultUnitCode ?? ""} onChange={(e) => void saveSettings({ defaultUnitCode: e.target.value || undefined })}
                    className="h-8 px-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
                    <option value="">decode from the document number</option>
                    {book.units.map((u) => <option key={u.code} value={u.code}>{u.code} — {u.label}</option>)}
                  </select>
                </label>
              )}
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={bridge.createAssets !== false} onChange={(e) => void saveSettings({ createAssets: e.target.checked })} className="w-3.5 h-3.5 accent-[var(--color-accent)]" />
                <span className="font-bold text-[var(--color-text)]">Discover registry assets</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={bridge.autoApply === true} onChange={(e) => void saveSettings({ autoApply: e.target.checked })} className="w-3.5 h-3.5 accent-[var(--color-accent)]" />
                <span className="font-bold text-[var(--color-text)]">Auto-apply after indexing</span>
              </label>
            </div>
            {!bridge.targetColumnKey && (
              <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5" data-testid="no-column-signal">
                No equipment column is mapped. Applying still files each tag in the equipment registry and records which sheets carry it (the asset’s page, the graph and the impact scan see it) — tags go into a document column only once you pick one.
                {bridge.autoApply && !bridge.reviewedAt && " Auto-apply waits until someone has reviewed this library once (applied or dismissed a tag)."}
              </div>
            )}
            {unreadable > 0 && (
              <div className="text-[11px] text-[var(--color-text-muted)]">{unreadable} document{unreadable === 1 ? " is" : "s are"} hidden from you by its permissions — not listed, swept or applied.</div>
            )}
            {uploadOrigin > 0 && (
              <div className="text-[11px] text-[var(--color-text-muted)]" data-testid="upload-origin-signal">
                {uploadOrigin} indexed document{uploadOrigin === 1 ? " was" : "s were"} uploaded straight into a knowledge library — there is no controlled document for the Bridge to feed. Their tags are in the coverage report under “On a sheet, in no list”, where they can be discovered.
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
            </div>
          )}
          {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">{notice}</div>}
          {relationNote && <div className="text-[11px] text-amber-800">{relationNote}</div>}

          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="secondary" size="sm" onClick={() => void sweep(false)} disabled={sweeping}>
              {sweeping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {rows.length === 0 ? "Sweep the library" : "Re-sweep"}
            </Button>
            {!sweeping && sweepProgress && !sweepProgress.done && sweepProgress.cursor && (
              <Button variant="secondary" size="sm" onClick={() => void sweep(true)}>Resume sweep</Button>
            )}
            {pendingRows.length > 0 && (
              <Button size="sm" onClick={() => void apply(pendingRows.map((r) => r.document_id))} disabled={applying !== null}>
                {applying === "__all" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Apply all {pendingRows.length} document{pendingRows.length === 1 ? "" : "s"}
                {totalNewAssets > 0 && <span className="opacity-80">· {totalNewAssets} new asset{totalNewAssets === 1 ? "" : "s"}</span>}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => setShowCoverage((v) => !v)}>
              <ListChecks className="w-3.5 h-3.5" /> {showCoverage ? "Hide coverage" : "Coverage report"}
            </Button>
          </div>
          {counts && (
            <div className="text-[11px] text-[var(--color-text-muted)]" data-testid="sweep-progress">
              {sweeping ? "Sweeping… " : sweepProgress?.done ? "Swept. " : "Stopped part-way. "}
              {counts.computed ?? 0} computed · {counts.no_entities ?? 0} no tags found · {counts.twin_not_ready ?? 0} not indexed yet · {counts.twin_stale ?? 0} indexed copy behind the current revision · {counts.no_twin ?? 0} not in a knowledge library
              {(counts.unreadable ?? 0) > 0 && ` · ${counts.unreadable} not readable to you`}
              {(counts.failed ?? 0) > 0 && ` · ${counts.failed} failed`}
            </div>
          )}

          {showCoverage && <CoverageReport orgId={orgId} units={book.units.map((u) => ({ code: u.code, label: u.label }))} />}

          {loading ? (
            <div className="py-10 text-center text-xs text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Loading…</div>
          ) : rows.length === 0 ? (
            <div className="py-8 text-center text-xs text-[var(--color-text-muted)] italic">
              Nothing computed yet — hit “Sweep the library”. (Drawings must be indexed in a knowledge library linked to this one.)
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
              {rows.map((r) => {
                const fresh = freshOf(r);
                const done = r.status === "applied" && fresh.length === 0;
                const sel = picked[r.document_id] ?? new Set<string>();
                const first = r.suggested[0];
                const rel = relationsByDoc.get(r.document_id) ?? [];
                const vanished = rel.filter((x) => x.vanished_at);
                const superseded = rel.filter((x) => x.superseded_at && !x.vanished_at);
                return (
                  <div key={r.document_id} className="px-3 py-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs font-black text-[var(--color-text)] truncate">{r.documentLabel}</span>
                      <span className="text-[10px] text-[var(--color-text-muted)]">{r.suggested.length} tag{r.suggested.length === 1 ? "" : "s"}</span>
                      {/* CB-1: the decoded unit and its codebook label, or a warning. */}
                      {first?.unitCode && (
                        <span className="text-[10px] text-[var(--color-text-muted)]">unit {first.unitCode}{unitLabel(first.unitCode) ? ` — ${unitLabel(first.unitCode)}` : ""}{first.unitSource === "library_default" ? " (library default)" : ""}</span>
                      )}
                      {first?.unitRejected && (
                        <span className="text-[10px] font-bold text-amber-700">decodes to unit {first.unitRejected}, which the Site Codebook does not hold — filed to no unit</span>
                      )}
                      {done ? (
                        <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-black text-emerald-700"><Check className="w-3 h-3" /> applied</span>
                      ) : (
                        <span className="ml-auto inline-flex items-center gap-2">
                          {sel.size > 0 && (
                            <>
                              <button onClick={() => void apply([r.document_id], [...sel])} disabled={applying !== null}
                                className="text-[10px] font-black text-[var(--color-accent)] hover:underline disabled:opacity-40">Apply {sel.size} picked</button>
                              <button onClick={() => void dismiss(r.document_id, [...sel])} disabled={applying !== null}
                                className="inline-flex items-center gap-0.5 text-[10px] font-black text-rose-700 hover:underline disabled:opacity-40"><Ban className="w-3 h-3" />Dismiss {sel.size}</button>
                            </>
                          )}
                          {sel.size === 0 && fresh.length > 0 && (
                            <button onClick={() => void apply([r.document_id])} disabled={applying !== null}
                              className="inline-flex items-center gap-1 text-[10px] font-black text-[var(--color-accent)] hover:underline disabled:opacity-40">
                              {applying === r.document_id ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Apply {fresh.length}
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                    {r.suggested.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {r.suggested.map((s) => {
                          const isApplied = r.applied.includes(s.tag);
                          const isPicked = sel.has(s.tag);
                          return (
                            <button key={s.tag} type="button" onClick={() => togglePick(r.document_id, s.tag)}
                              aria-pressed={isPicked}
                              title={chipTitle(s)}
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-bold font-mono ${
                                isPicked ? "ring-2 ring-[var(--color-accent)] " : ""}${
                                s.dismissed
                                  ? "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-faint)] line-through"
                                  : isApplied
                                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                                    : s.held
                                      ? "border-amber-300 bg-amber-50 text-amber-800"
                                      : s.assetStatus === "new"
                                        ? "border-violet-200 bg-violet-50 text-violet-800"
                                        : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]"
                              }`}>
                              {s.assetStatus === "new" && !isApplied && !s.held && !s.dismissed && <Boxes className="w-2.5 h-2.5" />}
                              {s.tag}
                              {s.code && <span className="opacity-60">{s.code}</span>}
                              {s.held && <span className="font-sans">teach the codebook</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {/* GAP-309: what the current revision no longer carries — a delta for a person, never removed by itself. */}
                    {vanished.length > 0 && (
                      <div className="mt-1.5 space-y-1" data-testid="vanished-delta">
                        {vanished.map((v) => (
                          <div key={`${v.tag_text}`} className="text-[10px] text-amber-800 flex items-center gap-2 flex-wrap">
                            <span><span className="font-mono font-bold">{v.tag_text}</span> is no longer read on the current revision{v.sheet_label ? ` (was on ${v.sheet_label}` : " ("}{v.source_revision ? `, read from Rev ${v.source_revision})` : ")"}</span>
                            <button onClick={() => void reviewVanished(r.document_id, String(v.tag_text), "remove")} disabled={applying !== null} className="font-black text-rose-700 hover:underline">It left the sheet — remove the link</button>
                            <button onClick={() => void reviewVanished(r.document_id, String(v.tag_text), "keep")} disabled={applying !== null} className="font-black text-[var(--color-accent)] hover:underline">It is still there — keep</button>
                          </div>
                        ))}
                      </div>
                    )}
                    {superseded.length > 0 && (
                      <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                        {superseded.length} link{superseded.length === 1 ? " was" : "s were"} read from an earlier revision — the next sweep of the current revision refreshes {superseded.length === 1 ? "it" : "them"}.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <p className="text-[10px] text-[var(--color-text-faint)]">
            Click chips to pick them, then apply or dismiss just those. Violet chips aren&apos;t in the equipment registry yet — applying discovers them (unit + type from the Site Codebook, provenance recorded — <Link href="/admin/assets?discovered=1" className="underline">review discovered equipment</Link>). Amber chips name a prefix the Site Codebook does not know: they are never created by Apply all. Manual column entries are never removed; the bridge only adds.
          </p>
        </div>
      </div>
    </div>
  );
}
