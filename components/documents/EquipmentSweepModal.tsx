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

type Kind = "linked" | "listed" | "new" | "needs" | "check";
const KIND: Record<Kind, { word: string; cls: string }> = {
  linked: { word: "Linked", cls: "text-emerald-700 dark:text-emerald-400" },
  listed: { word: "Already listed", cls: "text-emerald-700 dark:text-emerald-400" },
  new: { word: "New", cls: "text-violet-700 dark:text-violet-300" },
  needs: { word: "Needs an ID", cls: "text-amber-700 dark:text-amber-400" },
  check: { word: "Check this", cls: "text-rose-700 dark:text-rose-400" },
};
const keyOf = (docId: string, tag: string) => `${docId}|${tag}`;
const sheetNo = (s: string | null | undefined) => (s && /^\d+$/.test(s) ? s.padStart(2, "0") : s ?? null);

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
  const [canAdd, setCanAdd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sweeping, setSweeping] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [filter, setFilter] = useState<"all" | "needs" | "ready" | "listed">("all");
  // A person's ticks and fixes, by drawing and tag.
  const [choice, setChoice] = useState<Record<string, RowChoice & { on?: boolean }>>({});

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
      return list;
    } catch (e) { setError((e as Error).message); return null; }
    finally { setLoading(false); }
  }, [orgId, libraryId, authed]);

  const sweep = useCallback(async () => {
    setSweeping(true); setError(null); setNotice(null);
    try {
      const headers = { ...(await authed()), "Content-Type": "application/json" };
      const res = await fetch("/api/equipment-bridge", { method: "POST", headers, body: JSON.stringify({ action: "sweep", orgId, libraryId }) });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setChoice({});
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setSweeping(false); }
  }, [authed, orgId, libraryId, refresh]);

  // Read with the old rules (no IDs kept): read again, once, on open.
  useEffect(() => {
    let live = true;
    void loadCodebook(orgId).then((b) => { if (live) setBook(b); });
    void refresh().then((list) => {
      if (live && list && list.some((r) => r.suggested.some((s) => s.codeFrom === undefined))) void sweep();
    });
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
      const kind: Kind = applied ? "linked" : s.problem && !typed ? "check" : s.assetId && !typed ? "listed" : code ? "new" : "needs";
      const typedBad = !!c.code?.trim() && !looksLikeId(c.code);
      const actionable = !applied && kind !== "needs" && kind !== "check" && !typedBad && (kind === "listed" || canAdd);
      const on = actionable && (c.on ?? (kind === "listed" || (kind === "new" && (s.codeFrom === "sheet" || !!typed))));
      return { s, k, c, code, typeCode, typeLabel, unitCode, kind, actionable, on, typed, typedBad, dec };
    }),
  })), [rows, choice, book, typeOptions, canAdd]);

  const all = view.flatMap((v) => v.items);
  const count = (k: Kind) => all.filter((x) => x.kind === k).length;
  const picked = all.filter((x) => x.on);
  const toAdd = picked.filter((x) => x.kind === "new").length;
  const toLink = picked.filter((x) => x.kind === "listed").length;
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
    setApplying(true); setError(null); setNotice(null);
    try {
      const perDoc: Record<string, { tags: string[]; choices: Record<string, RowChoice> }> = {};
      for (const v of view) for (const x of v.items) {
        if (!x.on) continue;
        const d = perDoc[v.r.document_id] ?? { tags: [], choices: {} };
        d.tags.push(x.s.tag);
        const ch: RowChoice = {};
        if (x.typed) ch.code = x.typed;
        if (x.c.typeCode) ch.typeCode = x.c.typeCode;
        if (Object.keys(ch).length) d.choices[x.s.tag] = ch;
        perDoc[v.r.document_id] = d;
      }
      const documentIds = Object.keys(perDoc);
      if (!documentIds.length) return;
      const headers = { ...(await authed()), "Content-Type": "application/json" };
      const res = await fetch("/api/equipment-bridge", { method: "POST", headers, body: JSON.stringify({ action: "apply", orgId, documentIds, perDoc }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const results = json.results as Array<{ appliedTags?: string[]; createdAssets?: number; error?: string }>;
      const failed = results.filter((r) => r.error);
      const added = results.reduce((n, r) => n + (r.createdAssets ?? 0), 0);
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
            <div className="text-sm font-black text-[var(--color-text)]">Equipment from drawings - {libraryName}</div>
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

          {showSettings && (
            <div className="rounded-xl border border-[var(--color-border)] p-3 space-y-2.5 text-[12.5px]">
              <label className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-[var(--color-text-muted)]">Unit for sheets that print no IDs</span>
                <select value={bridge.defaultUnitCode ?? ""} onChange={(e) => void saveSettings({ defaultUnitCode: e.target.value || undefined }, true)} className={field}>
                  <option value="">From the drawing number</option>
                  {book.units.map((u) => <option key={u.code} value={u.code}>{u.code} - {u.label}</option>)}
                </select>
                <span className="text-[11.5px] text-[var(--color-text-muted)]">A sheet that prints IDs says its own unit (5530.26 is unit 55).</span>
              </label>
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
                            <input type="checkbox" checked={x.on} disabled={!x.actionable} onChange={(e) => set(x.k, { on: e.target.checked })}
                              aria-label={`${x.kind === "listed" ? "Link" : "Add"} ${x.s.tag}`} className="mt-0.5 w-4 h-4 accent-[var(--color-accent)] disabled:opacity-30" />
                            <div className="min-w-0">
                              <div className="font-mono font-black text-[13px] text-[var(--color-text)]">{x.s.tag}</div>
                              {x.s.name && <div className="text-[11.5px] text-[var(--color-text-muted)] break-words">{x.s.name}</div>}
                            </div>
                            <div className="col-start-2 sm:col-start-auto min-w-0">
                              {x.s.typeFrom === "id" && !x.c.typeCode ? (
                                <><div className="text-[var(--color-text)]">{x.typeLabel}</div><div className="text-[11px] text-[var(--color-text-muted)]">from the ID</div></>
                              ) : (
                                <>
                                  <select value={x.typeCode ?? ""} disabled={x.kind === "linked" || x.kind === "listed"} onChange={(e) => set(x.k, { typeCode: e.target.value || null })} aria-label={`${x.s.tag} type`} className={`${field} max-w-full`}>
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
                              ) : x.kind === "linked" ? <span className="text-[var(--color-text-muted)]">-</span> : (
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
                              {x.s.match === "name" && <div className="text-[11px] text-[var(--color-text-muted)]">matched by name in {unitName(x.unitCode)}{x.s.codeFrom === "sheet" ? "; its ID gets filled in" : ""}</div>}
                              {x.kind === "check" && x.s.problem && <div className="text-[11px] text-rose-700 dark:text-rose-400">{x.s.problem}</div>}
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
              {toAdd > 0 && toLink > 0 ? `Add ${toAdd}, link ${toLink}` : toAdd > 0 ? `Add ${toAdd} to the registry` : toLink > 0 ? `Link ${toLink}` : "Nothing ticked"}
            </button>
            <span className="text-[11.5px] text-[var(--color-text-muted)]">Ticked rows only. Each is linked to the sheets it&apos;s on.{canAdd ? "" : " Only admins add new equipment; you can link what's already listed."}</span>
          </div>
        )}
      </div>
    </div>
  );
}
