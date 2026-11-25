"use client";

// SheetSetup - one kit sheet set up, in one screen: what it is (a cover,
// the contents page, a form that comes back signed, or a reference sheet)
// and what the app writes on it. The app reads the labels printed on the
// sheet ("WO No.:", "Equipment:", "Date:") and suggests a fill for each;
// the owner keeps, changes or drops each one, and can put a fill anywhere
// else by picking it and clicking the page. A form can also be printed
// blank: nothing read, nothing filled, swapped once it's signed.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { field as fieldCls } from "@/components/admin/kit";
import { sayError } from "@/components/projects/sayError";
import { fetchStored } from "@/lib/packageOps";
import { PDFDocument } from "pdf-lib";
import { bomLayoutOf } from "@/lib/bomForm";
import { openSheet, type SheetDoc } from "@/lib/readSheet";
import { FILL_KEYS, FILL_WORDS, findLabels, findListArea, type FillKey, type FoundLabel } from "@/lib/formLabels";
import type { FieldPlacement, TocCols } from "@/lib/packagePdf";

export type SheetKind = "cover" | "toc" | "form" | "ref" | "bom";
export type Region = { x: number; y: number; w: number; h: number; cols?: TocCols };
export interface SheetResult { kind: SheetKind; title: string; fields: FieldPlacement[]; region: Region | null; bomRows?: number }

const KINDS: Array<{ k: SheetKind; title: string; what: string }> = [
  { k: "cover", title: "Cover sheet", what: "First page of every package" },
  { k: "toc", title: "Contents page", what: "What's in it, with page numbers" },
  { k: "form", title: "Form", what: "Filled in by hand; the signed copy is swapped in" },
  { k: "ref", title: "Reference sheet", what: "Printed with it; doesn't come back" },
  { k: "bom", title: "Bill of materials", what: "Its rows filled from the materials register" },
];

/** A first guess at what a sheet is, from its file name. */
export function guessKind(name: string): SheetKind {
  const n = name.toLowerCase();
  if (/cover/.test(n)) return "cover";
  if (/contents|\btoc\b|index/.test(n)) return "toc";
  if (/\bbom\b|bill of mat/.test(n)) return "bom";
  return "form";
}

type Label = FoundLabel & { use: FillKey | null };

export default function SheetSetup({
  path, name, isNew, kind: kind0, title: title0, fields: fields0, region: region0, queue, samples, onSave, onCancel,
}: {
  path: string; name: string;
  /** Just added: asks what it is. */
  isNew: boolean;
  kind: SheetKind | null;
  title?: string;
  /** Saved fills: undefined, never set up; [], printed blank. */
  fields?: FieldPlacement[];
  region?: Region | null;
  queue?: { at: number; of: number };
  /** Example values drawn on the page where each fill goes. */
  samples: Record<FillKey, string>;
  onSave: (r: SheetResult) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [doc, setDoc] = useState<SheetDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<SheetKind>(kind0 ?? guessKind(name));
  const [title, setTitle] = useState(title0 ?? name.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim());
  const [labels, setLabels] = useState<Label[]>([]);
  const [placed, setPlaced] = useState<FieldPlacement[]>([]);
  const [blank, setBlank] = useState(false);
  // A bill of materials: the rows and header the app finds on it (null: none it can fill).
  const [bomFound, setBomFound] = useState<{ rows: number; cols: string[]; header: string[] } | null | undefined>(undefined);
  useEffect(() => {
    if (kind !== "bom" || bomFound !== undefined) return;
    let on = true;
    void (async () => {
      try {
        const d = await PDFDocument.load(await fetchStored(path), { ignoreEncryption: true });
        const l = bomLayoutOf(d.getForm());
        const WORD: Record<string, string> = { no: "No.", qty: "QTY", size: "SIZE", desc: "DESCRIPTION", status: "STATUS", used: "USED" };
        const HEAD: Record<string, string> = { wo: "work order", equipment: "equipment", project: "project", date: "date", by: "prepared by" };
        if (on) setBomFound(l ? { rows: l.rows.length, cols: ["no", "qty", "size", "desc", "status", "used"].filter((c) => l.rows.some((r) => (r as Record<string, string | undefined>)[c])).map((c) => WORD[c]), header: Object.keys(l.header).map((k) => HEAD[k]) } : null);
      } catch { if (on) setBomFound(null); }
    })();
    return () => { on = false; };
  }, [kind, path, bomFound]);
  const [placing, setPlacing] = useState<FillKey | null>(null);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<{ w: number; h: number } | null>(null);
  const [corners, setCorners] = useState<Array<{ x: number; y: number }>>([]);
  const [region, setRegion] = useState<Region | null>(region0 ?? null);
  const [regionFound, setRegionFound] = useState(false);
  // The contents page's own column headings: the rows go under them.
  const [cols, setCols] = useState<TocCols | null>(region0?.cols ?? null);
  const [foundCols, setFoundCols] = useState<TocCols | null>(region0?.cols ?? null);
  const [saving, setSaving] = useState(false);
  // Reading a scan's words: progress 0..1 while it runs.
  const [ocr, setOcr] = useState<number | null>(null);
  const [ocrDone, setOcrDone] = useState(false);
  const [ocrFailed, setOcrFailed] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);

  // Open the sheet and read its labels once.
  useEffect(() => {
    let on = true;
    void (async () => {
      try {
        const d = await openSheet(await fetchStored(path));
        if (!on) return;
        // A scan has no words in it: read them off the picture (OCR),
        // the first three pages (a form's header is on its first).
        if (d.words === 0) {
          setOcr(0);
          try {
            const { ocrWords } = await import("@/lib/ocr");
            const n = Math.min(3, d.pages);
            for (let i = 0; i < n; i++) {
              const img = await d.image(i);
              d.text[i] = { ...d.text[i], bits: await ocrWords(img, d.text[i].width, d.text[i].height, (p) => { if (on) setOcr((i + p) / n); }) };
              if (!on) return;
            }
            d.words = d.text.reduce((k, t) => k + t.bits.length, 0);
            setOcrDone(true);
          } catch { setOcrFailed(true); }
          setOcr(null);
        }
        const found = findLabels(d.text);
        const saved = fields0 ?? null;
        const used = new Set<FieldPlacement>();
        const next: Label[] = found.map((f) => {
          if (!saved) return { ...f, use: f.on ? f.key : null };
          // Saved before: a fill sitting on this label keeps its choice.
          const s = saved.find((p) => !used.has(p) && (p.page ?? 0) === f.page && Math.abs(p.x - f.at.x) < 4 && Math.abs(p.y - f.at.y) < 4);
          if (s) used.add(s);
          return { ...f, use: s ? s.key : null };
        });
        setLabels(next);
        setPlaced(saved ? saved.filter((p) => !used.has(p)) : []);
        // A form set up as blank stays blank; a new one with nothing to fill starts blank.
        setBlank(saved ? saved.length === 0 && !isNew : !next.some((l) => l.use));
        if (!region0 && d.text[0]) {
          const a = findListArea(d.text[0]);
          if (a) { const { cols: c, ...area } = a; setRegion(area); setRegionFound(true); if (c) { setCols(c); setFoundCols(c); } }
        }
        setDoc(d);
      } catch (e) { if (on) setErr(sayError(e)); }
    })();
    return () => { on = false; };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps -- read once per sheet

  // Draw the page shown, to fit.
  useEffect(() => {
    if (!doc || !canvas.current) return;
    let on = true;
    const w = Math.max(240, (box.current?.clientWidth ?? 600) - 2);
    void doc.draw(page, canvas.current, Math.min(w, 760), Math.max(360, window.innerHeight * 0.68)).then((s) => { if (on) setView({ w: s.w, h: s.h }); }, (e) => { if (on) setErr(sayError(e)); });
    return () => { on = false; };
  }, [doc, page]);

  const fills: FieldPlacement[] = useMemo(() => [
    ...labels.filter((l) => l.use).map((l) => ({ key: l.use!, page: l.page, x: l.at.x, y: l.at.y, size: l.at.size, maxWidth: l.at.maxWidth, label: l.text })),
    ...placed,
  ], [labels, placed]);
  const fillsOn = kind !== "toc" && kind !== "bom" && !((kind === "form" || kind === "ref") && blank);

  const pointAt = (e: React.MouseEvent) => {
    if (!view || !canvas.current) return null;
    const r = canvas.current.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * view.w), y: Math.round(view.h - ((e.clientY - r.top) / r.height) * view.h) };
  };
  const click = (e: React.MouseEvent) => {
    const p = pointAt(e);
    if (!p || !view) return;
    if (kind === "toc") {
      setRegionFound(false);
      setCorners((c) => {
        const next = c.length >= 2 ? [p] : [...c, p];
        if (next.length === 2) setRegion({ x: Math.min(next[0].x, next[1].x), y: Math.min(next[0].y, next[1].y), w: Math.abs(next[1].x - next[0].x), h: Math.abs(next[1].y - next[0].y) });
        return next;
      });
      return;
    }
    if (!placing || !fillsOn) return;
    setPlaced((ps) => [...ps, { key: placing, page, x: p.x, y: p.y, size: placing === "wo" ? 12 : 10, maxWidth: Math.max(36, Math.round(view.w - p.x - 24)) }]);
    setPlacing(null);
  };
  // Picking up a fill on the page to put it somewhere else.
  const pickUp = (f: FieldPlacement) => {
    const li = labels.findIndex((l) => l.use === f.key && l.page === (f.page ?? 0) && l.at.x === f.x && l.at.y === f.y);
    if (li >= 0) setLabels((ls) => ls.map((l, i) => (i === li ? { ...l, use: null } : l)));
    else setPlaced((ps) => ps.filter((p) => p !== f));
    setPlacing(f.key);
  };

  const save = async () => {
    if (kind === "toc" && !region) { setErr("Mark where the list goes: click its top-left corner, then its bottom-right."); return; }
    if (kind === "bom" && !bomFound) { setErr("The app can't find rows to fill on it. A bill of materials needs to be a fillable PDF with a box in each cell."); return; }
    setSaving(true); setErr(null);
    try {
      const area = region ? { x: region.x, y: region.y, w: region.w, h: region.h, ...(cols ? { cols } : {}) } : null;
      await onSave({ kind, title: title.trim() || name, fields: fillsOn ? fills : [], region: kind === "toc" ? area : null, ...(kind === "bom" && bomFound ? { bomRows: bomFound.rows } : {}) });
    } catch (e) { setErr(sayError(e)); } finally { setSaving(false); }
  };

  const pct = (x: number, y: number) => (view ? { left: `${(x / view.w) * 100}%`, top: `${((view.h - y) / view.h) * 100}%` } : {});
  const scale = view && canvas.current ? canvas.current.clientWidth / view.w : 1;
  const kindsShown = isNew ? KINDS : kind === "form" || kind === "ref" || kind === "bom" ? KINDS.filter((k) => k.k === "form" || k.k === "ref" || k.k === "bom") : [];
  const onPage = (p?: number) => (p ?? 0) === page;
  const hint = kind === "toc"
    ? (corners.length === 1 ? "Now click the bottom-right corner of the list area." : region ? (regionFound ? "Found the list area under its headings. Click two corners to mark it differently." : "Click two corners to mark it again.") : "Click the top-left corner of the list area, then the bottom-right.")
    : placing ? `Click where ${FILL_WORDS[placing].toLowerCase()} goes.` : null;

  return (
    <Modal onClose={onCancel} size="2xl" dismissable={!saving} labelledBy="ss-title">
      <div className="px-5 sm:px-6 pt-4 pb-3 border-b border-[var(--color-border)] flex items-start gap-3 shrink-0">
        <div className="flex-1 min-w-0">
          <div className="text-caption font-medium uppercase tracking-[0.08em] text-[var(--color-text-muted)]">Package kit{queue && queue.of > 1 ? ` · sheet ${queue.at} of ${queue.of}` : ""}</div>
          <h2 id="ss-title" className="font-display text-section font-semibold text-[var(--color-text)] truncate">Set up {name}</h2>
        </div>
        <button type="button" onClick={onCancel} aria-label="Close" className="-mr-2 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
      </div>

      <div className="px-5 sm:px-6 py-4 overflow-y-auto custom-scrollbar flex-1 min-h-0 grid gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] content-start">
        {/* The choices: first on a phone, beside the page on a desktop. */}
        <div className="grid gap-5 content-start lg:order-2">
          {err && <ErrorNote title={err} />}
          {kindsShown.length > 0 && (
            <section className="grid gap-2">
              <h3 className="text-body font-semibold text-[var(--color-text)]">What is it?</h3>
              <div role="radiogroup" aria-label="What the sheet is" className="grid grid-cols-2 gap-2">
                {kindsShown.map((o) => (
                  <button key={o.k} type="button" role="radio" aria-checked={kind === o.k} onClick={() => { setKind(o.k); setPlacing(null); }}
                    className={`text-left rounded-lg border p-2.5 min-h-11 grid gap-0.5 ${kind === o.k ? "border-[var(--color-current)] ring-1 ring-[var(--color-current)] bg-[var(--color-surface-2)]" : "border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]"}`}>
                    <span className="flex items-center gap-1.5 text-body font-semibold text-[var(--color-text)]">{kind === o.k && <Check aria-hidden className="w-4 h-4 text-[var(--color-current)]" />}{o.title}</span>
                    <span className="text-caption text-[var(--color-text-muted)]">{o.what}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {(kind === "form" || kind === "ref" || kind === "bom") && (
            <div>
              <label htmlFor="ss-name" className="block text-body font-medium text-[var(--color-text)] mb-1.5">Name in the contents</label>
              <input id="ss-name" value={title} onChange={(e) => setTitle(e.target.value)} className={fieldCls} />
            </div>
          )}

          {kind === "bom" ? (
            <section className="grid gap-1.5">
              <h3 className="text-body font-semibold text-[var(--color-text)]">What the app fills in</h3>
              {bomFound === undefined ? <p role="status" className="text-body text-[var(--color-text-muted)]">Finding its rows…</p>
                : bomFound ? (
                  <p className="text-body text-[var(--color-text)]">{bomFound.rows} rows ({bomFound.cols.join(", ")}){bomFound.header.length ? `, and the ${bomFound.header.join(", ")}` : ""}. Each package gets the lines on its work orders from the materials register, filled in when it&apos;s printed, so it&apos;s always the register as it stands; more lines than rows add another copy. It goes in every package and comes back with the rest.</p>
                ) : <p className="text-body text-[var(--state-held-text)]">No rows the app can fill on it. It needs to be a fillable PDF with a box in each cell (the No., QTY, SIZE and DESCRIPTION of each line).</p>}
            </section>
          ) : kind === "toc" ? (
            <section className="grid gap-1.5">
              <h3 className="text-body font-semibold text-[var(--color-text)]">Where the list goes</h3>
              <p className="text-body text-[var(--color-text-muted)]">The app writes each item and the page it starts on there, and adds more copies of this page when the list is long.</p>
              <label className="flex items-start gap-2.5 min-h-11 px-2.5 py-2 rounded-lg border border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-surface-2)]">
                <input type="checkbox" checked={cols != null} onChange={(e) => setCols(e.target.checked ? (foundCols ?? {}) : null)} className="w-4 h-4 mt-0.5" />
                <span className="text-body text-[var(--color-text)]">It has its own column headings (Item, Description, Page)<span className="block text-caption text-[var(--color-text-muted)]">{cols ? (foundCols ? "The rows go under them, in its columns." : "The rows go under them; the app won't add its own.") : "The app adds a heading row: #, Item, Kind, Page."}</span></span>
              </label>
            </section>
          ) : (
            <section className="grid gap-2.5">
              <h3 className="text-body font-semibold text-[var(--color-text)]">What the app fills in</h3>
              {(kind === "form" || kind === "ref") && (
                <div role="radiogroup" aria-label="Fill it in or print it blank" className="grid gap-1.5">
                  {[{ v: false, t: "Fill in its labels" }, { v: true, t: "Nothing: print it blank, it's filled in by hand" }].map((o) => (
                    <label key={String(o.v)} className="flex items-center gap-2.5 min-h-11 px-2.5 rounded-lg border border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-surface-2)]">
                      <input type="radio" name="ss-blank" checked={blank === o.v} onChange={() => { setBlank(o.v); setPlacing(null); }} className="w-4 h-4" />
                      <span className="text-body text-[var(--color-text)]">{o.t}</span>
                    </label>
                  ))}
                </div>
              )}
              {fillsOn && (!doc ? <p role="status" className="text-body text-[var(--color-text-muted)]">{ocr != null ? `It's a scan: reading its words (OCR), ${Math.round(ocr * 100)}%…` : "Reading the sheet…"}</p> : <>
                <p className="text-body text-[var(--color-text-muted)]">
                  {ocrFailed ? "It's a scan and its words couldn't be read here. Pick a fill below, then click where it goes on the page."
                    : doc.words === 0 ? "No words could be read on it. Pick a fill below, then click where it goes on the page."
                    : labels.length ? `Found ${labels.length} label${labels.length === 1 ? "" : "s"} it can fill${ocrDone ? " (read off the scan, so check each)" : ""}. Keep, change or leave each one blank.`
                    : `No labels it knows (WO, equipment, date…) on it${ocrDone ? " (read off the scan)" : ""}. Pick a fill below, then click where it goes.`}
                </p>
                {(labels.length > 0 || placed.length > 0) && (
                  <ul className="grid gap-1.5">
                    {labels.map((l, i) => (
                      <li key={`l${i}`} className="grid gap-1">
                        <label htmlFor={`ss-l${i}`} className="text-caption text-[var(--color-text-muted)]">
                          “{l.text}”{doc.pages > 1 ? ` on page ${l.page + 1}` : ""}
                        </label>
                        <select id={`ss-l${i}`} value={l.use ?? ""} onFocus={() => setPage(l.page)}
                          onChange={(e) => { const v = (e.target.value || null) as FillKey | null; setLabels((ls) => ls.map((x, j) => (j === i ? { ...x, use: v } : x))); }}
                          className={fieldCls}>
                          <option value="">Leave it blank</option>
                          {FILL_KEYS.map((k) => <option key={k} value={k}>{FILL_WORDS[k]}</option>)}
                        </select>
                      </li>
                    ))}
                    {placed.map((p, i) => (
                      <li key={`p${i}`} className="flex items-center gap-2 min-h-11 px-2.5 rounded-lg bg-[var(--color-surface-2)]">
                        <span className="min-w-0 flex-1 text-body text-[var(--color-text)]">{FILL_WORDS[p.key]}<span className="text-caption text-[var(--color-text-muted)]"> · placed by you{doc.pages > 1 ? `, page ${(p.page ?? 0) + 1}` : ""}</span></span>
                        <Button variant="ghost" onClick={() => setPlaced((ps) => ps.filter((x) => x !== p))}>Remove</Button>
                      </li>
                    ))}
                  </ul>
                )}
                <div>
                  <label htmlFor="ss-add" className="block text-body font-medium text-[var(--color-text)] mb-1.5">Fill something else</label>
                  <select id="ss-add" value={placing ?? ""} onChange={(e) => setPlacing((e.target.value || null) as FillKey | null)} className={fieldCls}>
                    <option value="">Pick one, then click the page…</option>
                    {FILL_KEYS.map((k) => <option key={k} value={k}>{FILL_WORDS[k]}</option>)}
                  </select>
                </div>
              </>)}
            </section>
          )}
        </div>

        {/* The page, with what goes where. */}
        <div className="grid gap-2 content-start min-w-0 lg:order-1">
          <div className="flex items-center gap-2 min-h-9">
            <p role="status" className={`flex-1 min-w-0 text-body ${hint ? "text-[var(--color-text)] font-medium" : "text-[var(--color-text-muted)]"}`}>{hint ?? (fillsOn ? "Example values show where each fill prints. Click one to move it." : "")}</p>
            {doc && doc.pages > 1 && (
              <div className="shrink-0 flex items-center gap-1">
                <button type="button" aria-label="Page before" disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-2)] disabled:opacity-40"><ChevronLeft className="w-4 h-4" /></button>
                <span className="text-body tabular-nums text-[var(--color-text-muted)]">Page {page + 1} of {doc.pages}</span>
                <button type="button" aria-label="Next page" disabled={page >= doc.pages - 1} onClick={() => setPage((p) => p + 1)} className="w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-2)] disabled:opacity-40"><ChevronRight className="w-4 h-4" /></button>
              </div>
            )}
          </div>
          <div ref={box} className="rounded-lg bg-[var(--color-surface-2)] p-2 grid place-items-center min-h-60">
            <div className={`relative inline-block shadow-[var(--shadow-control)] bg-white ${kind === "toc" || (placing && fillsOn) ? "cursor-crosshair" : ""}`} onClick={click}>
              <canvas ref={canvas} className="block max-w-full h-auto" />
              {view && fillsOn && labels.filter((l) => onPage(l.page)).map((l, i) => (
                <span key={`b${i}`} aria-hidden className={`absolute rounded-sm pointer-events-none border ${l.use ? "border-[var(--color-current)]" : "border-dashed border-[var(--color-text-faint)]"}`}
                  style={{ ...pct(l.box.x - 1, l.box.y + l.box.h + 1), width: `${((l.box.w + 2) / view.w) * 100}%`, height: `${((l.box.h + 2) / view.h) * 100}%` }} />
              ))}
              {view && fillsOn && fills.filter((f) => onPage(f.page)).map((f, i) => (
                <button key={`f${i}`} type="button" title="Click to move it" onClick={(e) => { e.stopPropagation(); pickUp(f); }}
                  className="absolute -translate-y-[85%] px-0.5 rounded-sm whitespace-nowrap overflow-hidden text-ellipsis font-semibold text-[var(--color-current)] bg-[color-mix(in_srgb,var(--color-current)_10%,white)] hover:outline hover:outline-1 hover:outline-[var(--color-current)]"
                  style={{ ...pct(f.x, f.y), fontSize: `${Math.max(5, f.size * scale)}px`, lineHeight: 1.15, maxWidth: `${(((f.maxWidth ?? view.w - f.x - 24)) / view.w) * 100}%` }}>
                  {samples[f.key]}
                </button>
              ))}
              {view && kind === "toc" && region && (
                <span aria-hidden className="absolute border-2 border-[var(--color-current)] bg-[color-mix(in_srgb,var(--color-current)_10%,transparent)] pointer-events-none"
                  style={{ ...pct(region.x, region.y + region.h), width: `${(region.w / view.w) * 100}%`, height: `${(region.h / view.h) * 100}%` }} />
              )}
              {view && kind === "toc" && corners.length === 1 && <span aria-hidden className="absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full bg-[var(--color-current)] pointer-events-none" style={pct(corners[0].x, corners[0].y)} />}
            </div>
            {!doc && !err && <p role="status" className="text-body text-[var(--color-text-muted)]">{ocr != null ? `Reading the scan, ${Math.round(ocr * 100)}%…` : "Opening the sheet…"}</p>}
          </div>
        </div>
      </div>

      <div className="px-5 sm:px-6 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] rounded-b-xl flex flex-wrap items-center gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>{isNew ? "Don't add it" : "Cancel"}</Button>
        <span className="ml-auto" />
        <Button onClick={() => void save()} loading={saving} disabled={!doc}>
          {isNew ? (queue && queue.at < queue.of ? "Add it, next sheet" : "Add it to the kit") : "Save"}
        </Button>
      </div>
    </Modal>
  );
}
