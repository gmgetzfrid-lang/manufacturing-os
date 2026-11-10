"use client";

import Link from "next/link";

// EquipmentSweepModal - equipment read off a library's drawings, checked
// and added. Each sheet's tags with the ID printed beside them, the service
// name, the unit and type the ID says (site codebook), lined up with the
// registry BY ID (lib/equipmentSweep). A person ticks, fixes a type or
// types a missing ID, and adds; only admins add equipment. Auto-add, when
// on, only takes rows whose ID is printed plainly on the sheet.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { X, Loader2, Check, RefreshCw, AlertTriangle, ScanSearch, GraduationCap, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { loadCodebook, EMPTY_CODEBOOK, type Codebook } from "@/lib/codebook";
import { decodeId, looksLikeId, type SweepRow, type RowChoice } from "@/lib/equipmentSweep";
import { pendingDrawings, readDrawing, newRunId } from "@/lib/drawingCensusClient";
import type { BridgeConfig } from "@/lib/equipmentBridgeServer";

interface DocInfo { number: string | null; title: string | null; rev: string | null; sheet: string | null; sheetTotal: number | null }
interface SuggestionRow {
  document_id: string;
  documentLabel: string;
  doc?: DocInfo | null;
  suggested: Array<Partial<SweepRow> & { tag: string; code: string | null; pages: number[]; assetId: string | null; assetStatus: "existing" | "new" }>;
  applied: string[];
  status: "pending" | "applied" | "dismissed";
}
interface ColumnDef { key: string; label?: string; type?: string; isPill?: boolean }

type Kind = "linked" | "listed" | "new" | "needs" | "check" | "update";
const KIND: Record<Kind, { word: string; cls: string }> = {
  linked: { word: "Linked", cls: "text-emerald-700 dark:text-emerald-400" },
  listed: { word: "Already listed", cls: "text-emerald-700 dark:text-emerald-400" },
  new: { word: "New", cls: "text-violet-700 dark:text-violet-300" },
  needs: { word: "Needs an ID", cls: "text-amber-700 dark:text-amber-400" },
  check: { word: "Check this", cls: "text-rose-700 dark:text-rose-400" },
  update: { word: "Replace the ID", cls: "text-amber-700 dark:text-amber-400" },
};
const keyOf = (docId: string, tag: string) => `${docId}|${tag}`;
const sheetNo = (s: string | null | undefined) => (s && /^\d+$/.test(s) ? s.padStart(2, "0") : s ?? null);

export default function EquipmentSweepModal({ orgId, libraryId, libraryName, folderId = null, folderName = null, onClose, onApplied }: {
  orgId: string;
  libraryId: string;
  libraryName: string;
  /** Opened inside a folder: that folder's drawings only, and its unit. */
  folderId?: string | null;
  folderName?: string | null;
  onClose: () => void;
  /** Called after any apply so the page refetches documents (new chips). */
  onApplied: () => void;
}) {
  const [rows, setRows] = useState<SuggestionRow[]>([]);
  const [bridge, setBridge] = useState<BridgeConfig>({});
  const [columns, setColumns] = useState<ColumnDef[]>([]);
  const [book, setBook] = useState<Codebook>(EMPTY_CODEBOOK);
  const [canAdd, setCanAdd] = useState(false);
  const [folderUnit, setFolderUnit] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  // Overwrite the registry with what the sheets say: IDs that clash (often
  // guessed from the tag before) and service names.
  const [overwriteAll, setOverwriteAll] = useState(false);
  const [notAdded, setNotAdded] = useState<Array<{ tag: string; why: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [sweeping, setSweeping] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [filter, setFilter] = useState<"all" | "needs" | "ready" | "listed">("all");
  // A person's ticks and fixes, by drawing and tag.
  const [choice, setChoice] = useState<Record<string, RowChoice & { on?: boolean }>>({});
  // Sheets here the drawing reader hasn't read yet: a sheet drawn in
  // AutoCAD keeps its tags as linework, so its text gives only the title
  // block, and its equipment is found only once it's read.
  const [sheetCount, setSheetCount] = useState(0);
  const [unread, setUnread] = useState<Array<{ knowledgeDocumentId: string; name: string; pages: number[] }>>([]);
  const [reading, setReading] = useState<{ done: number; total: number; current: string | null } | null>(null);
  const stopRead = React.useRef(false);

  const authed = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return { Authorization: `Bearer ${session?.access_token ?? ""}` };
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const headers = await authed();
      const res = await fetch(`/api/equipment-bridge?orgId=${encodeURIComponent(orgId)}&libraryId=${encodeURIComponent(libraryId)}${folderId ? `&folderId=${encodeURIComponent(folderId)}` : ""}`, { headers });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const list = (json.suggestions as SuggestionRow[]).filter((r) => r.suggested.length > 0);
      // By drawing, then sheet: 5502-D 2000 sheet 01 before 5502-D 2000-2.
      const order = (r: SuggestionRow) => {
        const n = r.doc?.number ?? r.documentLabel;
        const sh = sheetNo(r.doc?.sheet);
        return `${sh ? n.replace(/-\d{1,3}$/, "") : n}|${(sh ?? "").padStart(4, "0")}`;
      };
      setRows(list.sort((a, b) => order(a).localeCompare(order(b), undefined, { numeric: true })));
      setBridge((json.bridge as BridgeConfig) ?? {});
      setColumns((json.customColumns as ColumnDef[]) ?? []);
      setCanAdd(!!json.canAdd);
      setFolderUnit((json.folder as { unitCode?: string | null } | null)?.unitCode ?? null);
      setSheetCount(Number(json.sheets ?? 0));
      const here = new Set(((json.linkedDocs ?? []) as Array<{ knowledgeDocumentId?: string }>).map((d) => d.knowledgeDocumentId).filter(Boolean));
      void pendingDrawings(orgId, [libraryId])
        .then((p) => setUnread(p.pending.filter((d) => here.has(d.knowledgeDocumentId))))
        .catch(() => setUnread([]));
      return list;
    } catch (e) { setError((e as Error).message); return null; }
    finally { setLoading(false); }
  }, [orgId, libraryId, folderId, authed]);

  const sweep = useCallback(async (keepChoices = false) => {
    setSweeping(true); setError(null); setNotice(null);
    try {
      const headers = { ...(await authed()), "Content-Type": "application/json" };
      const res = await fetch("/api/equipment-bridge", { method: "POST", headers, body: JSON.stringify({ action: "sweep", orgId, libraryId, folderId }) });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      if (!keepChoices) setChoice({});
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setSweeping(false); }
  }, [authed, orgId, libraryId, folderId, refresh]);

  // Read the sheets the drawing reader hasn't, one by one, then line up
  // what they say. Billed to the person's AI key, under its monthly cap.
  const readUnread = async () => {
    const todo = [...unread];
    if (!todo.length) return;
    const pages = todo.reduce((n, d) => n + d.pages.length, 0);
    if (!window.confirm(`Read ${pages} sheet${pages === 1 ? "" : "s"} with your AI model?\n\nEach sheet is read zoomed in, region by region, for its equipment tags and IDs. Billed to your key under your monthly cap. You can stop at any time and undo the run afterwards.`)) return;
    stopRead.current = false; setError(null); setNotice(null);
    const runId = newRunId();
    const runLabel = `Read ${todo.length} drawing${todo.length === 1 ? "" : "s"} with AI${folderName ? ` (${folderName})` : ""}`;
    let done = 0, failed = 0, lastError: string | null = null;
    setReading({ done: 0, total: todo.length, current: todo[0].name });
    for (const d of todo) {
      if (stopRead.current) break;
      setReading({ done, total: todo.length, current: d.name });
      try { await readDrawing(orgId, { knowledgeDocumentId: d.knowledgeDocumentId }, undefined, { runId, runLabel }, d.pages); }
      catch (e) {
        failed++; lastError = (e as Error).message;
        // No key, out of budget: every next sheet would fail the same way.
        if (/budget|key|agreement|cap/i.test(lastError)) break;
      }
      done++;
    }
    setReading(null);
    if (lastError) setError(`${failed} sheet${failed === 1 ? "" : "s"} not read: ${lastError}`);
    else setNotice(`Read ${done} sheet${done === 1 ? "" : "s"}${stopRead.current ? " (stopped)" : ""}. Undo it from Documents › Graph › Connect everything › Undo a run.`);
    await sweep(true);
  };

  // The folder's unit, set by a person; then the sheets are read again.
  const setUnit = async (unitCode: string) => {
    if (!folderId || !unitCode) return;
    setError(null);
    try {
      const headers = { ...(await authed()), "Content-Type": "application/json" };
      const res = await fetch("/api/equipment-bridge", { method: "POST", headers, body: JSON.stringify({ action: "folderUnit", orgId, folderId, unitCode }) });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setFolderUnit(unitCode);
      await sweep();
    } catch (e) { setError((e as Error).message); }
  };
  // A wrong link off a sheet (a title-block number, another unit's equipment).
  const unlink = async (documentId: string, tag: string) => {
    setUnlinking(keyOf(documentId, tag)); setError(null);
    try {
      const headers = { ...(await authed()), "Content-Type": "application/json" };
      const res = await fetch("/api/equipment-bridge", { method: "POST", headers, body: JSON.stringify({ action: "unlink", orgId, documentId, tags: [tag] }) });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      await refresh();
      onApplied();
    } catch (e) { setError((e as Error).message); }
    finally { setUnlinking(null); }
  };

  // Every open reads the sheets again against today's registry, so what an
  // earlier read got wrong (a guessed ID, another unit's link, a title-block
  // number) sets itself right. The last read shows meanwhile.
  useEffect(() => {
    let live = true;
    void loadCodebook(orgId).then((b) => { if (live) setBook(b); });
    void refresh().then(() => { if (live) void sweep(true); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once on open
  }, []);

  const tagColumns = useMemo(() => columns.filter((c) => c.type === "tags" || c.type === "multi" || c.isPill), [columns]);
  const saveSettings = async (patch: Partial<BridgeConfig>, thenRead = false) => {
    const next = { ...bridge, ...patch };
    setBridge(next);
    try {
      const headers = { ...(await authed()), "Content-Type": "application/json" };
      const res = await fetch("/api/equipment-bridge", { method: "POST", headers, body: JSON.stringify({ action: "settings", orgId, libraryId, ...next }) });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      if (thenRead) await sweep();
    } catch (e) { setError((e as Error).message); }
  };

  const unitName = useCallback((code: string | null | undefined) => {
    if (!code) return null;
    const u = book.units.find((x) => x.code === code);
    return u ? u.label.replace(/\s*\(.*\)\s*$/, "") : `Unit ${code}`;
  }, [book]);
  const typeOptions = useMemo(() => [...book.equipmentTypes].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })), [book]);

  // Each row as it stands with a person's fixes applied.
  const view = useMemo(() => rows.map((r) => ({
    r,
    items: r.suggested.map((s) => {
      const k = keyOf(r.document_id, s.tag);
      const c = choice[k] ?? {};
      const typed = c.code?.trim() ? c.code.trim().toUpperCase() : null;
      const dec = typed ? decodeId(typed, book) : null;
      const code = typed ?? s.code;
      const typeCode = c.typeCode ?? (typed && dec?.typeCode) ?? s.typeCode ?? null;
      const typeLabel = typeOptions.find((t) => t.code === typeCode)?.label ?? s.typeLabel ?? null;
      const unitCode = (typed && dec?.unitCode) || s.unitCode || null;
      const applied = r.applied.includes(s.tag);
      const replace = !applied && !typed && !!s.clash && !!s.code && (c.overwrite ?? overwriteAll);
      const kind: Kind = applied ? (s.assetId ? "linked" : "check") : replace ? "update" : s.problem && !typed ? "check" : s.assetId && !typed ? "listed" : code ? "new" : "needs";
      const typedBad = !!c.code?.trim() && !looksLikeId(c.code);
      const actionable = !applied && kind !== "needs" && kind !== "check" && !typedBad && (kind === "listed" || canAdd);
      const overwrite = kind === "update" || (kind === "listed" && overwriteAll);
      const problem = applied && !s.assetId ? "Linked earlier, but nothing in the registry has this sheet's ID, or this name in its unit. Unlink it if it isn't equipment on this sheet." : s.problem ?? null;
      const on = actionable && (c.on ?? (kind === "listed" || kind === "update" || (kind === "new" && (s.codeFrom === "sheet" || !!typed))));
      return { s, k, c, code, typeCode, typeLabel, unitCode, kind, actionable, on, typed, typedBad, dec, applied, problem, overwrite };
    }),
  })), [rows, choice, book, typeOptions, canAdd, overwriteAll]);

  const all = view.flatMap((v) => v.items);
  const count = (k: Kind) => all.filter((x) => x.kind === k).length;
  const picked = all.filter((x) => x.on);
  const toAdd = picked.filter((x) => x.kind === "new").length;
  // An ID only worked out from the tag, put right from the sheet, is a replace.
  const toLink = picked.filter((x) => x.kind === "listed" && !x.s.fixCode).length;
  const toReplace = picked.filter((x) => x.kind === "update" || (x.kind === "listed" && !!x.s.fixCode)).length;
  const clashes = all.filter((x) => !x.applied && x.s.clash && x.s.code && !x.typed).length;
  const shown = (x: (typeof all)[number]) => filter === "all" || (filter === "needs" ? x.kind === "needs" || x.kind === "check" : filter === "ready" ? x.kind === "new" && !!x.code : x.kind === "listed" || x.kind === "linked");

  // The summary: by unit, its equipment by type.
  const byUnit = useMemo(() => {
    const m = new Map<string, { sheets: Set<string>; types: Map<string, number>; n: number }>();
    for (const v of view) for (const x of v.items) {
      const u = x.unitCode ?? "?";
      const g = m.get(u) ?? { sheets: new Set<string>(), types: new Map<string, number>(), n: 0 };
      g.sheets.add(v.r.document_id); g.n++;
      const t = (x.typeLabel ?? "type not known").toLowerCase();
      g.types.set(t, (g.types.get(t) ?? 0) + 1);
      m.set(u, g);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [view]);

  const set = (k: string, patch: Partial<RowChoice & { on?: boolean }>) => setChoice((cur) => ({ ...cur, [k]: { ...(cur[k] ?? {}), ...patch } }));

  const apply = async () => {
    setApplying(true); setError(null); setNotice(null); setNotAdded([]);
    try {
      const perDoc: Record<string, { tags: string[]; choices: Record<string, RowChoice> }> = {};
      for (const v of view) for (const x of v.items) {
        if (!x.on) continue;
        const d = perDoc[v.r.document_id] ?? { tags: [], choices: {} };
        d.tags.push(x.s.tag);
        const ch: RowChoice = {};
        if (x.typed) ch.code = x.typed;
        if (x.c.typeCode) ch.typeCode = x.c.typeCode;
        if (x.overwrite) ch.overwrite = true;
        if (Object.keys(ch).length) d.choices[x.s.tag] = ch;
        perDoc[v.r.document_id] = d;
      }
      const documentIds = Object.keys(perDoc);
      if (!documentIds.length) return;
      const headers = { ...(await authed()), "Content-Type": "application/json" };
      const res = await fetch("/api/equipment-bridge", { method: "POST", headers, body: JSON.stringify({ action: "apply", orgId, documentIds, perDoc }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const results = json.results as Array<{ appliedTags?: string[]; createdAssets?: number; updatedAssets?: number; failed?: Array<{ tag: string; why: string }>; error?: string }>;
      const failed = results.filter((r) => r.error);
      const added = results.reduce((n, r) => n + (r.createdAssets ?? 0), 0);
      setNotAdded(results.flatMap((r) => r.failed ?? []));
      const linked = results.reduce((n, r) => n + (r.appliedTags?.length ?? 0), 0);
      setNotice(`${added} added to the registry, ${linked} linked to their sheets.${failed.length ? ` ${failed.length} sheet${failed.length === 1 ? "" : "s"} failed: ${failed[0].error}` : ""}`);
      setChoice({});
      await refresh();
      onApplied();
    } catch (e) { setError((e as Error).message); }
    finally { setApplying(false); }
  };

  const chip = (id: typeof filter, label: string, n: number) => (
    <button key={id} type="button" onClick={() => setFilter(id)}
      className={`rounded-full border px-2.5 py-1 text-[12px] font-bold ${filter === id ? "bg-[var(--color-accent)] border-[var(--color-accent)] text-[var(--color-accent-fg)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
      {label} {n}
    </button>
  );
  const field = "h-8 px-2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12.5px] text-[var(--color-text)]";

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-2 sm:p-4">
      <div className="w-full max-w-4xl bg-[var(--color-surface)] rounded-2xl shadow-2xl flex flex-col max-h-[94vh]">
        <div className="px-4 sm:px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-2.5">
          <ScanSearch className="w-4 h-4 text-orange-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">Equipment from drawings - {folderName ?? libraryName}</div>
            <div className="text-[11.5px] text-[var(--color-text-muted)]">Read off each sheet: the tag, the ID printed beside it, what it is. Matched by the ID; you check it, then it&apos;s added.</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4 text-[var(--color-text-muted)]" /></button>
        </div>

        <div className="p-3 sm:p-5 space-y-3 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void sweep()} disabled={sweeping}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] text-[12.5px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
              {sweeping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} {sweeping ? "Reading the sheets…" : "Read again"}
            </button>
            <button type="button" onClick={() => setShowSettings((v) => !v)} className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              {showSettings ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} Settings
            </button>
          </div>

          {folderId ? (
            <label className="flex flex-wrap items-center gap-2 text-[12.5px]">
              <span className="font-bold text-[var(--color-text)]">Unit for this folder</span>
              <select value={folderUnit ?? ""} onChange={(e) => void setUnit(e.target.value)} className={field} aria-label="Unit for this folder">
                <option value="" disabled>Pick the unit</option>
                {book.units.map((u) => <option key={u.code} value={u.code}>{u.code} - {u.label}</option>)}
              </select>
              <span className="text-[11.5px] text-[var(--color-text-muted)]">{folderUnit ? "Sheets here that print no IDs are this unit. A printed ID always says its own (5530.26 is unit 55)." : "Not set: sheets here that print no IDs have no unit until you pick one."}</span>
            </label>
          ) : (
            <div className="text-[12px] text-[var(--color-text-muted)]">This is every folder in the library. Open it from a unit&apos;s folder to check one unit at a time.</div>
          )}

          {showSettings && (
            <div className="rounded-xl border border-[var(--color-border)] p-3 space-y-2.5 text-[12.5px]">
              <label className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-[var(--color-text-muted)]">Also write tags into the column</span>
                <select value={bridge.targetColumnKey ?? ""} onChange={(e) => void saveSettings({ targetColumnKey: e.target.value || undefined })} className={field}>
                  <option value="">None</option>
                  {tagColumns.map((c) => <option key={c.key} value={c.key}>{c.label ?? c.key}</option>)}
                </select>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="checkbox" checked={bridge.autoApply === true} onChange={(e) => void saveSettings({ autoApply: e.target.checked })} className="mt-0.5 w-4 h-4 accent-[var(--color-accent)]" />
                <span><b className="text-[var(--color-text)]">Add on its own after each drawing is read</b>
                  <span className="block text-[11.5px] text-[var(--color-text-muted)]">Only equipment whose ID is printed on the sheet and reads as a unit and type in the site codebook. Everything else waits here for you.</span></span>
              </label>
              <Link href="/admin/ai-instructions?scope=equipment" className="inline-flex items-center gap-1 text-[11.5px] font-bold text-violet-700 dark:text-violet-300 hover:underline">
                <GraduationCap className="w-3.5 h-3.5" /> Teach the AI how your drawings print tags and IDs
              </Link>
            </div>
          )}

          {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-950/30 dark:border-rose-800 p-3 text-[12.5px] text-rose-800 dark:text-rose-200 flex items-start gap-2"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}</div>}
          {notAdded.length > 0 && (() => {
            // One reason for many (the usual: one name across all units), said once.
            const by = new Map<string, string[]>();
            for (const f of notAdded) by.set(f.why, [...(by.get(f.why) ?? []), f.tag]);
            return (
              <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3 text-[12.5px] text-amber-900 dark:text-amber-200 space-y-1">
                <b>{notAdded.length} not added</b>
                {[...by.entries()].map(([why, tags]) => <div key={why}><span className="font-mono font-bold">{tags.join(", ")}</span>: {why}</div>)}
              </div>
            );
          })()}
          {(unread.length > 0 || reading) && (
            <div role="status" className="rounded-xl border border-violet-300 dark:border-violet-700 bg-violet-50 dark:bg-violet-950/30 px-3 py-2.5 text-[12.5px] text-violet-900 dark:text-violet-200 space-y-2">
              {reading ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span><b>Reading sheet {Math.min(reading.done + 1, reading.total)} of {reading.total}</b>{reading.current ? `: ${reading.current}` : ""}. Keep this open.</span>
                  <button type="button" onClick={() => { stopRead.current = true; }} className="ml-auto rounded-lg border border-violet-400 px-2.5 py-1 font-bold hover:bg-violet-100 dark:hover:bg-violet-900/40 cursor-pointer">Stop</button>
                </div>
              ) : (
                <>
                  <p><b>{unread.length} of {sheetCount || unread.length} sheets here haven&apos;t been read with AI yet.</b> Only their text was read, and on drawings from AutoCAD the tags are drawn as lines, so the text holds little more than the title block. Their equipment shows up here once they&apos;re read.</p>
                  <button type="button" onClick={() => void readUnread()} disabled={sweeping || applying}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-violet-700 hover:bg-violet-800 text-white px-3 py-1.5 font-bold disabled:opacity-50 cursor-pointer">
                    <ScanSearch className="w-4 h-4" /> Read {unread.length} sheet{unread.length === 1 ? "" : "s"} with AI
                  </button>
                </>
              )}
            </div>
          )}
          {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800 p-3 text-[12.5px] text-emerald-800 dark:text-emerald-200 flex items-start gap-2"><Check className="w-4 h-4 shrink-0 mt-0.5" /> {notice}</div>}

          {loading ? (
            <div className="py-10 text-center text-[12.5px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Loading…</div>
          ) : rows.length === 0 ? (
            <div className="py-8 text-center text-[12.5px] text-[var(--color-text-muted)]">
              {sweeping ? "Reading the sheets…" : "No equipment read off these drawings yet. Read again once the drawings are indexed."}
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-[var(--color-border)] px-3 py-2.5 space-y-1">
                {byUnit.map(([u, g]) => (
                  <div key={u} className="text-[12.5px] leading-snug">
                    <b className="text-[var(--color-text)]">{u === "?" ? "Unit not known" : `${unitName(u)} (${u})`}: {g.n} on {g.sheets.size} sheet{g.sheets.size === 1 ? "" : "s"}</b>
                    <span className="text-[var(--color-text-muted)]"> · {[...g.types.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${n === 1 ? t.replace(/^(\w+?)s\b/, "$1") : t}`).join(" · ")}</span>
                  </div>
                ))}
                <div className="text-[12px]">
                  <span className={KIND.listed.cls}>{count("listed") + count("linked")} already listed</span> · <span className={KIND.new.cls}>{count("new")} new with the ID read off the sheet</span>
                  {count("needs") > 0 && <> · <span className={KIND.needs.cls}>{count("needs")} need an ID</span></>}
                  {count("check") > 0 && <> · <span className={KIND.check.cls}>{count("check")} to check</span></>}
                </div>
              </div>

              {canAdd && (
                <label className="flex items-start gap-2 text-[12.5px] cursor-pointer">
                  <input type="checkbox" checked={overwriteAll} onChange={(e) => { setOverwriteAll(e.target.checked); setChoice((cur) => Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, { ...v, overwrite: undefined }]))); }} className="mt-0.5 w-4 h-4 accent-[var(--color-accent)]" />
                  <span><b className="text-[var(--color-text)]">Overwrite the registry with what the sheets say</b>
                    <span className="block text-[11.5px] text-[var(--color-text-muted)]">Where this unit already has the name with another ID, the sheet&apos;s ID goes on it instead of adding a second one; listed equipment takes the sheet&apos;s service name.{clashes ? ` ${clashes} ID${clashes === 1 ? "" : "s"} differ here.` : ""}</span></span>
                </label>
              )}
              <div className="flex flex-wrap gap-1.5">
                {chip("all", "All", all.length)}
                {chip("needs", "Needs you", count("needs") + count("check"))}
                {chip("ready", "Ready to add", count("new"))}
                {chip("listed", "Already listed", count("listed") + count("linked"))}
              </div>

              <div className="space-y-2.5">
                {view.map(({ r, items }) => {
                  const list = items.filter(shown);
                  if (!list.length) return null;
                  const d = r.doc;
                  const sh = sheetNo(d?.sheet);
                  return (
                    <div key={r.document_id} className="rounded-xl border border-[var(--color-border)] overflow-hidden">
                      <div className="px-3 py-1.5 bg-[var(--color-surface-2)] border-b border-[var(--color-border)] flex flex-wrap items-baseline gap-x-2">
                        <b className="text-[12.5px] text-[var(--color-text)]">{sh ? `Sheet ${sh}${d?.sheetTotal ? ` of ${d.sheetTotal}` : ""}` : r.documentLabel}</b>
                        <span className="text-[11.5px] text-[var(--color-text-muted)]">{[d?.number ?? (sh ? r.documentLabel : null), d?.rev ? `Rev ${d.rev}` : null].filter(Boolean).join(" · ")}</span>
                        <Link href={`/documents/${libraryId}?doc=${r.document_id}`} target="_blank" className="ml-auto inline-flex items-center gap-1 text-[12px] font-bold text-[var(--color-accent)] hover:underline">Open sheet <ExternalLink className="w-3 h-3" /></Link>
                      </div>
                      <ul className="divide-y divide-[var(--color-border)]">
                        {list.map((x) => (
                          <li key={x.k} className="px-3 py-2 grid grid-cols-[20px_minmax(0,1fr)] sm:grid-cols-[20px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,0.9fr)] gap-x-3 gap-y-1 items-start text-[12.5px]">
                            {x.applied ? <span aria-hidden /> : (
                              <input type="checkbox" checked={x.on} disabled={!x.actionable} onChange={(e) => set(x.k, { on: e.target.checked })}
                                aria-label={`${x.kind === "listed" ? "Link" : "Add"} ${x.s.tag}`} title={x.actionable ? undefined : x.kind === "needs" ? "Enter its ID first" : x.kind === "new" ? "Only admins add equipment" : "Check this one first"}
                                className="mt-0.5 w-4 h-4 accent-[var(--color-accent)] disabled:opacity-30" />
                            )}
                            <div className="min-w-0">
                              <div className="font-mono font-black text-[13px] text-[var(--color-text)]">{x.s.tag}</div>
                              {x.s.name && <div className="text-[11.5px] text-[var(--color-text-muted)] break-words">{x.s.name}</div>}
                            </div>
                            <div className="col-start-2 sm:col-start-auto min-w-0">
                              {x.kind === "linked" || x.kind === "listed" || (x.applied && x.kind === "check") ? (
                                <div className="text-[var(--color-text)]">{x.typeLabel ?? <span className="text-[var(--color-text-muted)]">-</span>}</div>
                              ) : x.s.typeFrom === "id" && !x.c.typeCode ? (
                                <><div className="text-[var(--color-text)]">{x.typeLabel}</div><div className="text-[11px] text-[var(--color-text-muted)]">from the ID</div></>
                              ) : (
                                <>
                                  <select value={x.typeCode ?? ""} onChange={(e) => set(x.k, { typeCode: e.target.value || null })} aria-label={`${x.s.tag} type`} className={`${field} max-w-full`}>
                                    <option value="">Type?</option>
                                    {typeOptions.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                                  </select>
                                  {x.s.typeFrom === "letter" && !x.c.typeCode && <div className="text-[11px] text-[var(--color-text-muted)]">from the letter {x.s.tag.split("-")[0]}</div>}
                                </>
                              )}
                            </div>
                            <div className="col-start-2 sm:col-start-auto min-w-0">
                              {x.s.code && !x.typed ? (
                                <>
                                  <div className="font-mono font-bold text-[var(--color-text)]">{x.s.code}</div>
                                  <div className="text-[11px] text-[var(--color-text-muted)]">{x.s.codeFrom === "sheet" ? `printed on the sheet${x.s.pages.length > 1 ? ` (pages ${x.s.pages.join(", ")})` : ""}` : "from the registry"}{x.unitCode ? ` · ${unitName(x.unitCode)}` : ""}</div>
                                </>
                              ) : x.applied ? <span className="text-[var(--color-text-muted)]">-</span> : (
                                <>
                                  <input value={x.c.code ?? ""} onChange={(e) => set(x.k, { code: e.target.value, on: true })} placeholder="ID not printed - enter it" aria-label={`${x.s.tag} ID`}
                                    className={`${field} w-full font-mono ${x.typedBad ? "border-rose-400" : "border-dashed border-amber-400"}`} />
                                  <div className={`text-[11px] ${x.typedBad ? "text-rose-700 dark:text-rose-400" : "text-[var(--color-text-muted)]"}`}>
                                    {x.typedBad ? "Write it as the plant does: 5530.26" : x.dec ? `${unitName(x.dec.unitCode)}${x.dec.typeLabel ? ` · ${x.dec.typeLabel}` : ""}` : x.typed ? "Not a unit in the site codebook" : ""}
                                  </div>
                                </>
                              )}
                            </div>
                            <div className="col-start-2 sm:col-start-auto min-w-0">
                              <div className={`font-bold ${KIND[x.kind].cls}`}>{KIND[x.kind].word}{x.kind === "linked" || x.kind === "listed" ? " ✓" : ""}</div>
                              {x.s.listedAs && <div className="text-[11px] text-[var(--color-text-muted)]">listed as {x.s.listedAs}</div>}
                              {x.s.match === "name" && !x.s.fixCode && <div className="text-[11px] text-[var(--color-text-muted)]">matched by name in {unitName(x.unitCode)}{x.s.codeFrom === "sheet" ? "; its ID gets filled in" : ""}</div>}
                              {x.s.fixCode && !x.applied && <div className="text-[11px] text-amber-800 dark:text-amber-300">Its ID {x.s.fixCode} was worked out from the tag; the sheet&apos;s {x.s.code} replaces it</div>}
                              {x.kind === "new" && x.s.clash && <div className="text-[11px] text-[var(--color-text-muted)]">{unitName(x.unitCode) ?? "This unit"} also has a {x.s.tag} as {x.s.clash.code}: a different ID, so this one is added as its own</div>}
                              {x.kind === "check" && x.problem && <div className="text-[11px] text-rose-700 dark:text-rose-400">{x.problem}</div>}
                              {x.kind === "update" && x.s.clash && <div className="text-[11px] text-amber-800 dark:text-amber-300">{x.s.clash.code} becomes {x.s.code}{x.s.name ? `, named ${x.s.name}` : ""}</div>}
                              {canAdd && !x.applied && x.s.clash && x.s.code && !x.typed && (
                                <label className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] font-bold text-[var(--color-text)] cursor-pointer">
                                  <input type="checkbox" checked={x.kind === "update"} onChange={(e) => set(x.k, { overwrite: e.target.checked, on: e.target.checked })} className="w-3.5 h-3.5 accent-[var(--color-accent)]" />
                                  It&apos;s that one: change its ID to {x.s.code}
                                </label>
                              )}
                              {x.applied && (
                                <button type="button" onClick={() => void unlink(r.document_id, x.s.tag)} disabled={unlinking === x.k}
                                  className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] font-bold text-[var(--color-text-muted)] hover:text-rose-700 hover:underline disabled:opacity-50">
                                  {unlinking === x.k && <Loader2 className="w-3 h-3 animate-spin" />} Unlink from this sheet
                                </button>
                              )}
                              {x.kind === "new" && !canAdd && <div className="text-[11px] text-[var(--color-text-muted)]">Only admins add equipment</div>}
                              {(x.s.otherUnits ?? []).map((o) => (
                                <div key={`${o.unitCode}${o.code}`} className="text-[11px] text-amber-700 dark:text-amber-400">{unitName(o.unitCode) ?? "Another unit"} has its own {x.s.tag}{o.code ? ` (${o.code})` : ""}: a different piece of equipment, not linked</div>
                              ))}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {rows.length > 0 && (
          <div className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)] flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void apply()} disabled={applying || picked.length === 0}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[13px] font-bold disabled:opacity-50">
              {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {[toAdd ? `Add ${toAdd}` : null, toReplace ? `replace ${toReplace} ID${toReplace === 1 ? "" : "s"}` : null, toLink ? `link ${toLink}` : null].filter(Boolean).join(", ").replace(/^./, (ch) => ch.toUpperCase()) || "Nothing ticked"}
            </button>
            <span className="text-[11.5px] text-[var(--color-text-muted)]">Ticked rows only. Each is linked to the sheets it&apos;s on.{canAdd ? "" : " Only admins add new equipment; you can link what's already listed."}</span>
          </div>
        )}
      </div>
    </div>
  );
}
