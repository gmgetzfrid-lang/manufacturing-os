"use client";

// components/documents/FolderMarks.tsx — say what a folder stands for.
//
// Inside a folder: "This folder is…" an operating area, an equipment type, or
// one piece of equipment. Everything filed under it inherits. Inside a
// library: set the whole library up level by level ("area / equipment /
// documents"), see exactly what each folder becomes, then apply.

import React, { useEffect, useState } from "react";
import { Factory, Layers, Cpu, X, Loader2, Wand2 } from "lucide-react";
import { estatePost } from "@/lib/estate/client";
import type { FolderMarkState, LevelMeaning, MarkKind, PlanRow } from "@/lib/estate/folderMarks";

type Info = { own: FolderMarkState; inherited: FolderMarkState; units: Array<{ code: string; label: string }>; types: string[]; suggestion: { kind: MarkKind; value: string; ref?: string } | null };

const chip = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold";

export function FolderMarkBar({ orgId, folderId, onChanged }: { orgId: string; folderId: string; onChanged?: () => void }) {
  const [info, setInfo] = useState<{ id: string; data: Info } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<MarkKind | null>(null);
  const [unit, setUnit] = useState("");
  const [text, setText] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    let live = true;
    estatePost<Info>("/api/estate/folder-mark", { orgId, action: "info", folderId })
      .then((d) => { if (live) { setInfo({ id: folderId, data: d }); setError(null); } })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [orgId, folderId]);

  const data = info?.id === folderId ? info.data : null;
  const send = async (mark: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      const r = await estatePost<{ state: FolderMarkState }>("/api/estate/folder-mark", { orgId, action: "mark", folderId, mark });
      setInfo((cur) => (cur && cur.id === folderId ? { id: folderId, data: { ...cur.data, own: { ...r.state, area: r.state.area ? { code: r.state.area.code, label: cur.data.units.find((u) => u.code === r.state.area!.code)?.label ?? r.state.area.code } : undefined } } } : cur));
      setEditing(null); setText(""); setName("");
      onChanged?.();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!data) return error ? <span className="text-[11px] text-red-700">{error}</span> : null;
  const own = data.own, inh = data.inherited;
  const inside = [inh.area?.label, inh.type, inh.equipment?.tag].filter(Boolean).join(" › ");
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] pointer-events-auto rounded-md bg-[var(--color-surface)]/95 border border-[var(--color-border)] px-2 py-1">
      <span className="font-bold">This folder is</span>
      {own.area && <span className={`${chip} border-purple-300 bg-purple-50 text-purple-800`}><Factory className="w-3 h-3" /> {own.area.label}<button title="Unmark" onClick={() => void send({ kind: "clear", which: "area" })}><X className="w-3 h-3" /></button></span>}
      {own.type && <span className={`${chip} border-sky-300 bg-sky-50 text-sky-800`}><Layers className="w-3 h-3" /> {own.type}<button title="Unmark" onClick={() => void send({ kind: "clear", which: "type" })}><X className="w-3 h-3" /></button></span>}
      {own.equipment && <span className={`${chip} border-emerald-300 bg-emerald-50 text-emerald-800`}><Cpu className="w-3 h-3" /> {own.equipment.tag}<button title="Unmark" onClick={() => void send({ kind: "clear", which: "equipment" })}><X className="w-3 h-3" /></button></span>}
      {!own.area && !own.type && !own.equipment && <span className="text-[var(--color-text-muted)]">not marked{inside ? ` · inside ${inside}` : ""}</span>}
      {!own.area && !own.type && !own.equipment && data.suggestion && !editing && (
        <button disabled={busy} onClick={() => void send(data.suggestion!.kind === "area" ? { kind: "area", unitCode: data.suggestion!.ref } : { kind: "equipment", tag: data.suggestion!.ref ?? data.suggestion!.value })}
          className={`${chip} border-violet-300 bg-violet-50 text-violet-800`}><Wand2 className="w-3 h-3" /> {data.suggestion.kind === "area" ? "Operating area" : "Equipment"}: {data.suggestion.value}?</button>
      )}
      {!editing && (
        <select value="" onChange={(e) => { const k = e.target.value as MarkKind; setEditing(k); setUnit(data.units[0]?.code ?? ""); }} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[11px]">
          <option value="">Mark as…</option>
          <option value="area">Operating area</option>
          <option value="type">Equipment type</option>
          <option value="equipment">One piece of equipment</option>
        </select>
      )}
      {editing === "area" && (
        data.units.length
          ? <><select value={unit} onChange={(e) => setUnit(e.target.value)} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[11px]">{data.units.map((u) => <option key={u.code} value={u.code}>{u.label} ({u.code})</option>)}</select>
            <button disabled={busy || !unit} onClick={() => void send({ kind: "area", unitCode: unit })} className="rounded bg-purple-600 text-white px-2 py-0.5 font-bold disabled:opacity-50">Mark</button></>
          : <span className="text-amber-700">No operating areas in the Site Codebook yet (Intelligence › Setup).</span>
      )}
      {editing === "type" && (
        <><input list="eqtypes" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Heaters" className="w-28 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[11px]" />
          <datalist id="eqtypes">{data.types.map((t) => <option key={t} value={t} />)}</datalist>
          <button disabled={busy || !text.trim()} onClick={() => void send({ kind: "type", label: text })} className="rounded bg-sky-600 text-white px-2 py-0.5 font-bold disabled:opacity-50">Mark</button></>
      )}
      {editing === "equipment" && (
        <><input value={text} onChange={(e) => setText(e.target.value)} placeholder="Tag, e.g. H-2" className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[11px] font-mono" />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className="w-32 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[11px]" />
          <button disabled={busy || !text.trim()} onClick={() => void send({ kind: "equipment", tag: text, name })} className="rounded bg-emerald-600 text-white px-2 py-0.5 font-bold disabled:opacity-50">Mark</button></>
      )}
      {editing && <button onClick={() => setEditing(null)} className="text-[var(--color-text-muted)] hover:underline">cancel</button>}
      {busy && <Loader2 className="w-3 h-3 animate-spin" />}
      {error && <span className="text-red-700">{error}</span>}
    </div>
  );
}

const MEANING: Record<LevelMeaning, string> = { area: "Operating area", type: "Equipment type", equipment: "Equipment", skip: "Nothing (documents)" };

/** Set a whole library up: what each level of folders means, previewed. */
export function LibrarySetup({ orgId, libraryId, libraryName, onDone, onClose }: { orgId: string; libraryId: string; libraryName: string; onDone?: () => void; onClose: () => void }) {
  const [levels, setLevels] = useState<LevelMeaning[]>(["area", "equipment", "skip"]);
  const [rows, setRows] = useState<PlanRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = async () => {
    setBusy("Looking at the folders…"); setError(null); setResult(null);
    try { setRows((await estatePost<{ rows: PlanRow[] }>("/api/estate/folder-mark", { orgId, action: "plan", libraryId, levels })).rows); }
    catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const apply = async () => {
    setError(null);
    const tot = { marked: 0, created: 0, skipped: 0 };
    try {
      for (let pass = 0; pass < 30; pass++) {
        setBusy(`Marking folders… ${tot.marked} so far`);
        const r = await estatePost<{ marked: number; created: number; skipped: number; more: boolean }>("/api/estate/folder-mark", { orgId, action: "apply", libraryId, levels });
        tot.marked = r.marked; tot.created += r.created; tot.skipped = r.skipped;
        if (!r.more) break;
      }
      setResult(`${tot.marked} folders marked · ${tot.created} new in the registry · ${tot.skipped} left as they were. Documents underneath now sit under their area and equipment on the map.`);
      onDone?.();
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const counts = rows ? { area: rows.filter((r) => r.kind === "area" && r.status !== "unmatched").length, type: rows.filter((r) => r.kind === "type").length, eq: rows.filter((r) => r.kind === "equipment" && r.status !== "unmatched").length, made: rows.filter((r) => r.status === "new").length, no: rows.filter((r) => r.status === "unmatched").length } : null;
  return (
    <div className="fixed inset-0 z-[300] bg-slate-900/50 flex items-center justify-center p-3" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
          <div>
            <div className="text-sm font-black">Set up {libraryName} as an equipment library</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">Say what each level of folders is. Everything filed underneath inherits it.</div>
          </div>
          <button onClick={onClose} className="p-1 opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-4 py-3 space-y-2 text-xs">
          {levels.map((l, i) => (
            <label key={i} className="flex items-center gap-2">
              <span className="w-28 text-[var(--color-text-muted)]">{i === 0 ? "Top folders" : `Level ${i + 1} folders`}</span>
              <select value={l} onChange={(e) => { const next = [...levels]; next[i] = e.target.value as LevelMeaning; setLevels(next); setRows(null); }} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-1">
                {(Object.keys(MEANING) as LevelMeaning[]).map((k) => <option key={k} value={k}>{MEANING[k]}</option>)}
              </select>
            </label>
          ))}
          <div className="text-[11px] text-[var(--color-text-muted)]">Example: Crude Unit / H-1 Crude Heater / (inspection reports, datasheets…) is Operating area, Equipment, Nothing.</div>
          <div className="flex gap-2">
            <button onClick={() => void preview()} disabled={!!busy} className="rounded-md border border-[var(--color-border)] px-3 py-1 font-bold disabled:opacity-50">Preview</button>
            {rows && <button onClick={() => void apply()} disabled={!!busy || !counts || counts.area + counts.type + counts.eq === 0} className="rounded-md bg-emerald-600 text-white px-3 py-1 font-bold disabled:opacity-50">Apply</button>}
            {busy && <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]"><Loader2 className="w-3 h-3 animate-spin" /> {busy}</span>}
          </div>
          {error && <div className="text-red-700">{error}</div>}
          {result && <div className="text-emerald-700">{result}</div>}
          {counts && <div className="font-semibold">{counts.area} operating areas · {counts.type} equipment types · {counts.eq} equipment ({counts.made} new to the registry){counts.no ? ` · ${counts.no} folders nothing matched` : ""}</div>}
        </div>
        {rows && (
          <div className="flex-1 overflow-auto border-t border-[var(--color-border)]">
            <table className="w-full text-[11px]">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.folderId} className="border-b border-[var(--color-border)]">
                    <td className="px-3 py-1 truncate max-w-[260px]" title={r.path}>{r.path}</td>
                    <td className="px-2 py-1 whitespace-nowrap text-[var(--color-text-muted)]">{MEANING[r.kind]}</td>
                    <td className="px-2 py-1">{r.value ?? <span className="text-amber-700">{r.note}</span>}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{r.status === "match" ? <span className="text-emerald-700">matches</span> : r.status === "new" ? <span className="text-sky-700">new</span> : <span className="text-amber-700">skipped</span>}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td className="px-3 py-3 text-[var(--color-text-muted)]">No folders at those levels.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
