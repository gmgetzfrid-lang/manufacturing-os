"use client";

// EquipmentSweepModal — the drawing→equipment bridge's review surface for a
// document library. One screen: map which tags-column receives equipment,
// sweep every drawing that has an indexed knowledge twin, review the
// per-document proposals (new-to-registry tags flagged), apply per-row or
// all at once. Suggest-then-approve by default; an auto-apply toggle hands
// the whole loop to the machine once it's trusted.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  X, Loader2, Sparkles, Check, RefreshCw, AlertTriangle, Boxes, Settings2, ScanSearch,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { loadCodebook, EMPTY_CODEBOOK, type Codebook } from "@/lib/codebook";
import { Button } from "@/components/ui/Button";
import type { BridgeConfig, BridgeSuggestion } from "@/lib/equipmentBridgeServer";

interface SuggestionRow {
  document_id: string;
  documentLabel: string;
  suggested: Array<BridgeSuggestion & { unitCode?: string | null }>;
  applied: string[];
  status: "pending" | "applied" | "dismissed";
}

interface ColumnDef { key: string; label?: string; type?: string; isPill?: boolean }

export default function EquipmentSweepModal({ orgId, libraryId, libraryName, onClose, onApplied }: {
  orgId: string;
  libraryId: string;
  libraryName: string;
  onClose: () => void;
  /** Called after any apply so the page refetches documents (new chips). */
  onApplied: () => void;
}) {
  const [rows, setRows] = useState<SuggestionRow[]>([]);
  const [bridge, setBridge] = useState<BridgeConfig>({});
  const [columns, setColumns] = useState<ColumnDef[]>([]);
  const [book, setBook] = useState<Codebook>(EMPTY_CODEBOOK);
  const [linkedCount, setLinkedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sweeping, setSweeping] = useState(false);
  const [applying, setApplying] = useState<string | null>(null); // doc id or "__all"
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);

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
      setBridge((json.bridge as BridgeConfig) ?? {});
      setColumns((json.customColumns as ColumnDef[]) ?? []);
      setLinkedCount(new Set((json.linkedDocs as Array<{ documentId: string }>).map((l) => l.documentId)).size);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [orgId, libraryId, authed]);

  useEffect(() => { void refresh(); void loadCodebook(orgId).then(setBook); }, [refresh, orgId]);

  // Columns eligible to receive tags: multi-value / pill-style ones.
  const tagColumns = useMemo(
    () => columns.filter((c) => c.type === "tags" || c.type === "multi" || c.isPill),
    [columns]);

  const saveSettings = async (patch: Partial<BridgeConfig>) => {
    const next = { ...bridge, ...patch };
    setBridge(next);
    try {
      const headers = { ...(await authed()), "Content-Type": "application/json" };
      const res = await fetch("/api/equipment-bridge", {
        method: "POST", headers,
        body: JSON.stringify({ action: "settings", orgId, libraryId, ...next }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setSavedTick(true); setTimeout(() => setSavedTick(false), 1500);
    } catch (e) { setError((e as Error).message); }
  };

  const sweep = async () => {
    setSweeping(true); setError(null);
    try {
      const headers = { ...(await authed()), "Content-Type": "application/json" };
      const res = await fetch("/api/equipment-bridge", {
        method: "POST", headers,
        body: JSON.stringify({ action: "sweep", orgId, libraryId }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setSweeping(false); }
  };

  const apply = async (documentIds: string[]) => {
    setApplying(documentIds.length === 1 ? documentIds[0] : "__all");
    setError(null);
    try {
      const headers = { ...(await authed()), "Content-Type": "application/json" };
      const res = await fetch("/api/equipment-bridge", {
        method: "POST", headers,
        body: JSON.stringify({ action: "apply", orgId, documentIds }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const failed = (json.results as Array<{ error?: string }>).filter((r) => r.error);
      if (failed.length > 0) setError(`${failed.length} document(s) failed — first: ${failed[0].error}`);
      await refresh();
      onApplied();
    } catch (e) { setError((e as Error).message); }
    finally { setApplying(null); }
  };

  const pendingRows = rows.filter((r) => r.status === "pending" && r.suggested.some((s) => !r.applied.includes(s.tag)));
  const totalNewAssets = pendingRows.reduce((n, r) => n + r.suggested.filter((s) => s.assetStatus === "new").length, 0);

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4 animate-in fade-in">
      <div className="w-full max-w-3xl bg-[var(--color-surface)] rounded-2xl shadow-2xl flex flex-col max-h-[90vh] animate-in zoom-in-95">
        <div className="px-5 py-3.5 border-b border-[var(--color-border)] flex items-center gap-2.5">
          <ScanSearch className="w-4 h-4 text-orange-600" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">Equipment sweep — {libraryName}</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              AI-extracted tags from indexed drawings → your equipment column + the registry. {linkedCount} document{linkedCount === 1 ? "" : "s"} linked to knowledge.
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4 text-[var(--color-text-muted)]" /></button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto">
          {/* Mapping + behavior — the library's bridge settings. */}
          <div className="rounded-xl border border-[var(--color-border)] p-3 space-y-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-black text-[var(--color-text)]">
              <Settings2 className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> Bridge settings
              {savedTick && <span className="text-emerald-600 inline-flex items-center gap-0.5"><Check className="w-3 h-3" /> saved</span>}
            </div>
            <div className="flex items-center gap-3 flex-wrap text-xs">
              <label className="inline-flex items-center gap-1.5">
                <span className="text-[var(--color-text-muted)] font-bold">Send tags to</span>
                <select value={bridge.targetColumnKey ?? ""} onChange={(e) => void saveSettings({ targetColumnKey: e.target.value || undefined })}
                  className="h-8 px-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] font-bold">
                  <option value="">— pick a column —</option>
                  {tagColumns.map((c) => <option key={c.key} value={c.key}>{c.label ?? c.key}</option>)}
                </select>
              </label>
              {book.units.length > 0 && (
                <label className="inline-flex items-center gap-1.5">
                  <span className="text-[var(--color-text-muted)] font-bold">Default unit</span>
                  <select value={bridge.defaultUnitCode ?? ""} onChange={(e) => void saveSettings({ defaultUnitCode: e.target.value || undefined })}
                    className="h-8 px-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
                    <option value="">decode from drawing number</option>
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
              <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                Pick the column that should receive equipment tags (a “tags”-type custom column — e.g. the one you named Equipment). Nothing applies until this is set.
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void sweep()} disabled={sweeping}>
              {sweeping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {rows.length === 0 ? "Sweep the library" : "Re-sweep"}
            </Button>
            {pendingRows.length > 0 && bridge.targetColumnKey && (
              <Button size="sm" onClick={() => void apply(pendingRows.map((r) => r.document_id))} disabled={applying !== null}>
                {applying === "__all" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Apply all {pendingRows.length} document{pendingRows.length === 1 ? "" : "s"}
                {totalNewAssets > 0 && <span className="opacity-80">· {totalNewAssets} new asset{totalNewAssets === 1 ? "" : "s"}</span>}
              </Button>
            )}
          </div>

          {loading ? (
            <div className="py-10 text-center text-xs text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Loading…</div>
          ) : rows.length === 0 ? (
            <div className="py-8 text-center text-xs text-[var(--color-text-muted)] italic">
              Nothing computed yet — hit “Sweep the library”. (Drawings must be indexed in a knowledge library linked to this one.)
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
              {rows.map((r) => {
                const fresh = r.suggested.filter((s) => !r.applied.includes(s.tag));
                const done = r.status === "applied" && fresh.length === 0;
                return (
                  <div key={r.document_id} className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-black text-[var(--color-text)] truncate">{r.documentLabel}</span>
                      <span className="text-[10px] text-[var(--color-text-muted)]">{r.suggested.length} tag{r.suggested.length === 1 ? "" : "s"}</span>
                      {done ? (
                        <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-black text-emerald-700"><Check className="w-3 h-3" /> applied</span>
                      ) : fresh.length > 0 && bridge.targetColumnKey ? (
                        <button onClick={() => void apply([r.document_id])} disabled={applying !== null}
                          className="ml-auto inline-flex items-center gap-1 text-[10px] font-black text-[var(--color-accent)] hover:underline disabled:opacity-40">
                          {applying === r.document_id ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Apply {fresh.length}
                        </button>
                      ) : <span className="ml-auto" />}
                    </div>
                    {r.suggested.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {r.suggested.map((s) => {
                          const isApplied = r.applied.includes(s.tag);
                          return (
                            <span key={s.tag}
                              title={`${s.code ? `${s.code} · ` : ""}page${s.pages.length === 1 ? "" : "s"} ${s.pages.join(", ")}${s.assetStatus === "new" ? " · not in registry yet" : ""}`}
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-bold font-mono ${
                                isApplied
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                                  : s.assetStatus === "new"
                                    ? "border-violet-200 bg-violet-50 text-violet-800"
                                    : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]"
                              }`}>
                              {s.assetStatus === "new" && !isApplied && <Boxes className="w-2.5 h-2.5" />}
                              {s.tag}
                              {s.code && <span className="opacity-60">{s.code}</span>}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <p className="text-[10px] text-[var(--color-text-faint)]">
            Violet chips aren&apos;t in the equipment registry yet — applying discovers them (unit + type from the Site Codebook, provenance recorded). Manual column entries are never removed; the bridge only adds.
          </p>
        </div>
      </div>
    </div>
  );
}
