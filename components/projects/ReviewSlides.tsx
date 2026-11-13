"use client";

// ReviewSlides - the meeting slides on screen. The same slides the
// PowerPoint is written from (lib/reviewFiles deckSlides), so what is shown
// here and what downloads never disagree.
//
// On a computer each slide is drawn as the 16:9 slide, scaled to the
// window (Full screen to present). On a phone it reads as a page, with the
// tables as stacked rows. Left and right arrows, the buttons, or a swipe
// move between slides; Esc closes. A line with more behind it (the record,
// or how to set something up) opens it on a tap.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, Loader2, Maximize2, X } from "lucide-react";
import { noEmDash } from "@/lib/noEmDash";
import { TONE_HEX, tablePt, type SlideItem, type SlideMore, type SlidePane, type SlideSpec, type SlideTag } from "@/lib/reviewFiles";

// The slide in its own pixels: 13.33 x 7.5 in at 96 to the inch, so a point
// size here is the point size in the PowerPoint.
const W = 1280, H = 720;
const pt = (n: number) => `${(n * 4) / 3}px`;
const C = { bg: "#F6F4EF", ink: "#16202E", acc: "#B8430F", soft: "#4A5568", band: "#ECE8DF", foot: "#6B7280" };
const T = (v: string) => noEmDash(v);
type Open = (m: SlideMore) => void;
const Tag = ({ tag, size }: { tag: SlideTag; size: string }) => (
  <span style={{ display: "inline-block", fontSize: size, fontWeight: 700, lineHeight: 1.25, padding: "1px 8px", borderRadius: 99, color: `#${TONE_HEX[tag.tone].fg}`, background: `#${TONE_HEX[tag.tone].bg}`, whiteSpace: "nowrap" }}>{T(tag.text)}</span>
);
/** A cell of several lines, one under the other. */
const lines = (t: string) => { const xs = t.split("\n").filter(Boolean); return xs.length > 1 ? xs.map((x, i) => <div key={i} style={{ marginTop: i ? "0.4em" : 0 }}>{T(x)}</div>) : T(t); };
const itemOf = (it: SlideItem) => (typeof it === "string" ? { text: it, sub: false, bold: false } : { sub: false, bold: false, ...it });
/** A first cell of two lines: what it is in bold, the fact under it plain. */
const cell = (t: string, first: boolean) => {
  const [lead, ...more] = t.split("\n");
  return first && more.length ? <><b>{T(lead)}</b><br /><span style={{ fontWeight: 400 }}>{T(more.join(" "))}</span></> : T(t);
};

export default function ReviewSlides({ slides, name, onClose, onDownload, downloading, ready }: {
  slides: SlideSpec[]; name: string; onClose: () => void;
  onDownload: () => void; downloading: boolean;
  /** The file is made and the browser wants a tap to hand it over. */
  ready: { name: string; onSave: () => void } | null;
}) {
  const [at, setAt] = useState(0);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [full, setFull] = useState(false);
  const [more, setMore] = useState<SlideMore | null>(null);
  const moreRef = useRef<SlideMore | null>(null);
  useEffect(() => { moreRef.current = more; }, [more]);
  const shell = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const go = useCallback((d: number) => { setMore(null); setAt((i) => Math.max(0, Math.min(slides.length - 1, i + d))); }, [slides.length]);

  useEffect(() => {
    // Caught first, so nothing under the slides moves with the keys.
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (moreRef.current) { e.stopPropagation(); e.preventDefault(); setMore(null); return; } if (document.fullscreenElement) return; e.stopPropagation(); e.preventDefault(); onClose(); }
      else if (moreRef.current) return;
      else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.stopPropagation(); e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.stopPropagation(); e.preventDefault(); go(-1); }
    };
    const onFull = () => setFull(!!document.fullscreenElement);
    window.addEventListener("keydown", on, true);
    document.addEventListener("fullscreenchange", onFull);
    const was = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", on, true); document.removeEventListener("fullscreenchange", onFull); document.body.style.overflow = was; };
  }, [go, onClose]);
  useEffect(() => {
    const el = stage.current; if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const canFull = typeof document !== "undefined" && !!document.fullscreenEnabled;
  const toggleFull = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void shell.current?.requestFullscreen?.().catch(() => {}); };
  const spec = slides[Math.min(at, slides.length - 1)];
  if (!spec) return null;
  const wide = !!box && box.w >= 820;
  const pad = full ? 0 : 16;
  const scale = box ? Math.min((box.w - pad * 2) / W, (box.h - pad * 2) / H) : 1;
  const bar = "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-bold hover:bg-white/10 disabled:opacity-30 whitespace-nowrap";

  // On the page's own body, so nothing the review sits in can crop it.
  return createPortal(
    <div ref={shell} className="fixed inset-0 z-[400] bg-slate-950 text-white flex flex-col" role="dialog" aria-modal="true" aria-label={`${name}: slide ${at + 1} of ${slides.length}`} data-review-slides>
      {!full && (
        <div className="flex items-center gap-2 px-3 sm:px-5 py-2 border-b border-white/10">
          <span className="min-w-0 flex-1 truncate text-[13px] font-black uppercase tracking-widest text-white/70">{name}</span>
          <span className="text-[13px] font-bold text-white/60 tabular-nums whitespace-nowrap" data-slide-count>{at + 1} / {slides.length}</span>
          <button type="button" onClick={onDownload} disabled={downloading} className={bar}>{downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}<span className="hidden sm:inline">Download </span>PowerPoint</button>
          {canFull && wide && <button type="button" onClick={toggleFull} className={bar}><Maximize2 className="w-4 h-4" /> Full screen</button>}
          <button type="button" onClick={onClose} aria-label="Close" className="p-2 rounded-md hover:bg-white/10"><X className="w-5 h-5" /></button>
        </div>
      )}
      {ready && !full && (
        <div role="status" className="flex items-center gap-2 flex-wrap px-3 sm:px-5 py-2 bg-amber-400 text-slate-950 text-[13px] font-bold">
          <span className="min-w-0 flex-1">The file is ready.</span>
          <button type="button" onClick={ready.onSave} className="h-9 px-3 rounded-lg bg-slate-950 text-white font-black">Save file</button>
        </div>
      )}
      <div ref={stage} className="relative flex-1 min-h-0 overflow-hidden"
        onTouchStart={(e) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; }}
        onTouchEnd={(e) => { const s = touch.current, t = e.changedTouches[0]; touch.current = null; if (!s) return; const dx = t.clientX - s.x, dy = t.clientY - s.y; if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) go(dx < 0 ? 1 : -1); }}>
        {box && (wide ? (
          <div data-slide={at} onClick={full ? (e) => go(e.clientX > box.w / 2 ? 1 : -1) : undefined}
            style={{ position: "absolute", left: (box.w - W * scale) / 2, top: (box.h - H * scale) / 2, width: W, height: H, transform: `scale(${scale})`, transformOrigin: "top left", background: C.bg, color: C.ink, fontFamily: "Arial, Helvetica, sans-serif", overflow: "hidden", cursor: full ? "pointer" : undefined }}>
            <Canvas spec={spec} open={full ? undefined : setMore} />
          </div>
        ) : (
          <div key={at} data-slide={at} className="absolute inset-0 overflow-y-auto" style={{ background: C.bg, color: C.ink }}><Page spec={spec} open={setMore} /></div>
        ))}
      </div>
      {!full && (
        <div className="flex items-center justify-between gap-2 px-3 sm:px-5 py-2 border-t border-white/10">
          <button type="button" disabled={at === 0} onClick={() => go(-1)} className={bar}><ChevronLeft className="w-5 h-5" /> Back</button>
          <div className="flex gap-1.5 flex-wrap justify-center" aria-hidden>{slides.map((_, i) => <span key={i} className={`w-2 h-2 rounded-full ${i === at ? "bg-white" : "bg-white/25"}`} />)}</div>
          <button type="button" disabled={at >= slides.length - 1} onClick={() => go(1)} className={bar}>Next <ChevronRight className="w-5 h-5" /></button>
        </div>
      )}
      {more && (
        <div className="absolute inset-0 z-10 flex items-end sm:items-center justify-center bg-slate-950/70" onClick={(e) => { if (e.target === e.currentTarget) setMore(null); }} data-slide-more>
          <div className="w-full sm:max-w-2xl max-h-[86%] overflow-y-auto rounded-t-2xl sm:rounded-2xl px-5 py-5" style={{ background: C.bg, color: C.ink }}>
            <div className="flex items-start gap-3">
              <h3 className="min-w-0 flex-1 text-[18px] font-black leading-tight">{T(more.title)}</h3>
              <button type="button" onClick={() => setMore(null)} className="shrink-0 h-9 px-3 rounded-lg text-[13px] font-black" style={{ background: C.band }}>Close</button>
            </div>
            {more.sections.map((sec, i) => (
              <div key={i} className="mt-4">
                <div className="text-[11px] font-black uppercase tracking-widest" style={{ color: C.acc }}>{T(sec.title)}</div>
                {sec.numbered
                  ? <ol className="mt-1.5 list-decimal pl-5 space-y-1.5 text-[14.5px] leading-snug">{sec.lines.map((l, n) => <li key={n}>{T(l)}</li>)}</ol>
                  : sec.lines.length === 1 ? <p className="mt-1.5 text-[14.5px] leading-snug">{T(sec.lines[0])}</p>
                    : <ul className="mt-1.5 list-disc pl-5 space-y-1.5 text-[14.5px] leading-snug">{sec.lines.map((l, n) => <li key={n}>{T(l)}</li>)}</ul>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

// ─── The slide as drawn (a computer) ───────────────────────────────

function Canvas({ spec, open }: { spec: SlideSpec; open?: Open }) {
  const b = spec.body;
  if (b.k === "cover") {
    return (
      <div style={{ position: "absolute", inset: 0, padding: "144px 86px 0" }}>
        <div style={{ fontSize: pt(14), fontWeight: 700, color: C.acc, letterSpacing: 3, textTransform: "uppercase" }}>{T(spec.kicker)}</div>
        <div style={{ fontSize: pt(38), fontWeight: 700, lineHeight: 1.1, marginTop: 10 }}>{T(spec.title)}</div>
        <div style={{ fontSize: pt(18), color: C.soft, marginTop: 14 }}>{T(b.sub)}</div>
        <div style={{ fontSize: pt(15), marginTop: 44, lineHeight: 1.5 }}>{b.agenda.map((t, i) => <div key={i}>{i + 1}.&nbsp;&nbsp;{T(t)}</div>)}</div>
        <div style={{ position: "absolute", left: 86, bottom: 48, fontSize: pt(13), color: C.soft }}>{T(b.meta)}</div>
      </div>
    );
  }
  return (
    <div style={{ position: "absolute", inset: 0, padding: "32px 58px 0", display: "flex", flexDirection: "column" }}>
      <div style={{ fontSize: pt(11), fontWeight: 700, color: C.acc, letterSpacing: 2, textTransform: "uppercase" }}>{T(spec.kicker)}</div>
      <div style={{ fontSize: pt(spec.title.length > 70 ? 21 : 25), fontWeight: 700, lineHeight: 1.12, marginTop: 6, minHeight: b.k === "table" && spec.title.length <= 60 ? 40 : 74 }}>{T(spec.title)}</div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", marginTop: 10 }}>
        {b.k === "asks" ? (
          <div>
            {!b.items.length && <div style={{ fontSize: pt(20) }}>{T(spec.notes)}</div>}
            {b.items.map((it) => (
              <div key={it.n} style={{ display: "flex", gap: 22, marginBottom: b.items.length <= 4 ? 30 : 18 }}>
                <div style={{ flex: "0 0 40px", fontSize: pt(b.items.length <= 4 ? 26 : 22), fontWeight: 700, color: C.acc, lineHeight: 1 }}>{it.n}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: pt(b.items.length <= 4 ? 20 : 17), fontWeight: 700, lineHeight: 1.15 }}>{T(it.ask)}</div>
                  <div style={{ fontSize: pt(b.items.length <= 4 ? 15 : 13), color: C.soft, marginTop: 4, lineHeight: 1.2 }}>{T(it.because)}</div>
                </div>
              </div>
            ))}
          </div>
        ) : b.k === "table" ? <FitTable key={`${spec.kicker}|${spec.title}`} body={b} open={open} /> : (
          <div style={{ display: "flex", gap: 29, height: "100%" }}>
            <div style={{ flex: `0 0 calc(${(b.ratio ?? 0.5) * 100}% - 15px)`, minWidth: 0 }}><PaneView pane={b.left} /></div>
            {(b.right.title || b.right.items?.length || b.right.table) && <div style={{ flex: 1, minWidth: 0 }}><PaneView pane={b.right} /></div>}
          </div>
        )}
      </div>
      <div style={{ height: 60, fontSize: pt(10), color: C.foot, paddingTop: 8 }}>{b.foot ? T(b.foot) : null}</div>
    </div>
  );
}
function PaneTitle({ text }: { text: string }) {
  return <div style={{ fontSize: pt(11), fontWeight: 700, color: C.acc, letterSpacing: 1, textTransform: "uppercase" }}>{T(text)}</div>;
}
function PaneView({ pane }: { pane: SlidePane }) {
  const items = (pane.items ?? []).map(itemOf);
  const chars = items.reduce((n, it) => n + it.text.length, 0);
  const size = chars > 620 ? 12 : chars > 420 ? 13 : !pane.title ? 18 : 15;
  return (
    <div>
      {pane.title && <PaneTitle text={pane.title} />}
      {items.length > 0 && (
        <div style={{ marginTop: 10, fontSize: pt(size), lineHeight: 1.25 }}>
          {items.map((it, i) => (
            <div key={i} style={{ display: "flex", gap: 9, marginTop: it.bold && i ? 12 : 0, marginBottom: 7, paddingLeft: it.sub ? 22 : 0, fontWeight: it.bold ? 700 : 400 }}>
              {!it.bold && <span aria-hidden>•</span>}<span>{T(it.text)}</span>
            </div>
          ))}
        </div>
      )}
      {pane.table && (
        <div style={{ marginTop: items.length ? 16 : 10 }}>
          {pane.table.title && <div style={{ marginBottom: 7 }}><PaneTitle text={pane.table.title} /></div>}
          <SlideTable head={pane.table.head} rows={pane.table.rows} widths={pane.table.widths} size={11} />
        </div>
      )}
    </div>
  );
}
/** A slide's table, set in the largest type that fits the slide: it starts
 *  large and steps down until nothing is cut off. */
function FitTable({ body: b, open }: { body: Extract<SlideSpec["body"], { k: "table" }>; open?: Open }) {
  const box = useRef<HTMLDivElement>(null);
  const start = Math.min(16, tablePt(b.rows) + 3);
  // Sized on the page itself after each draw: the table's type steps down until the slide holds it all.
  useLayoutEffect(() => {
    const el = box.current, t = el?.querySelector("table");
    if (!el || !t) return;
    let fs = start; t.style.fontSize = pt(fs);
    while (el.scrollHeight > el.clientHeight + 1 && fs > 8) { fs -= 0.5; t.style.fontSize = pt(fs); }
  });
  return (
    <div ref={box} style={{ height: "100%", overflow: "hidden" }} data-slide-fit>
      {b.tally && b.tally.length > 0 && (
        <div style={{ display: "flex", gap: 34, alignItems: "baseline", marginBottom: 12 }} data-slide-tally>
          {b.tally.map((t) => <div key={t.label}><span style={{ fontSize: pt(24), fontWeight: 700, color: `#${TONE_HEX[t.tone].fg}` }}>{t.n}</span><span style={{ fontSize: pt(13), color: C.soft, marginLeft: 8 }}>{T(t.label)}</span></div>)}
        </div>
      )}
      <SlideTable head={b.head} rows={b.rows} widths={b.widths} tags={b.tags} more={b.more} open={open} size={start} />
    </div>
  );
}
function SlideTable({ head, rows, widths, size, tags, more, open }: { head: string[]; rows: string[][]; widths: number[]; size?: number; tags?: Array<SlideTag | null>; more?: Array<SlideMore | null>; open?: Open }) {
  const total = widths.reduce((a, c) => a + c, 0);
  const fs = size ?? tablePt(rows);
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", fontSize: pt(fs), lineHeight: 1.22 }}>
      <colgroup>{widths.map((w, i) => <col key={i} style={{ width: `${(w / total) * 100}%` }} />)}</colgroup>
      <thead><tr>{head.map((h) => <th key={h} style={{ background: C.ink, color: "#fff", textAlign: "left", padding: "0.4em 8px", fontWeight: 700, fontSize: "0.85em" }}>{T(h)}</th>)}</tr></thead>
      <tbody>{rows.map((r, ri) => {
        const m = open ? more?.[ri] ?? null : null;
        return (
          <tr key={ri} style={{ background: ri % 2 ? C.band : C.bg, cursor: m ? "pointer" : undefined }} onClick={m ? (e) => { e.stopPropagation(); open!(m); } : undefined} data-row-more={m ? "" : undefined}>
            {head.map((_, i) => (
              <td key={i} style={{ padding: "0.38em 8px", verticalAlign: "top", fontWeight: i === 0 ? 700 : 400, overflowWrap: "anywhere" }}>
                {i === 0 ? <>{cell(r[i] ?? "", true)}{tags?.[ri] && <div style={{ marginTop: 4 }}><Tag tag={tags[ri]!} size="0.78em" /></div>}</> : lines(r[i] ?? "")}
              </td>
            ))}
          </tr>
        );
      })}</tbody>
    </table>
  );
}

// ─── The slide as a page (a phone) ─────────────────────────────────

function Page({ spec, open }: { spec: SlideSpec; open?: Open }) {
  const b = spec.body;
  return (
    <div className="px-4 py-5">
      <div className="text-[11px] font-black uppercase tracking-widest" style={{ color: C.acc }}>{T(spec.kicker)}</div>
      <h2 className="mt-1 text-[21px] font-black leading-tight">{T(spec.title)}</h2>
      {b.k === "cover" && <>
        {b.sub && <p className="mt-2 text-[14px]" style={{ color: C.soft }}>{T(b.sub)}</p>}
        <ol className="mt-5 space-y-1.5 text-[15px]">{b.agenda.map((t, i) => <li key={i}>{i + 1}. {T(t)}</li>)}</ol>
        <p className="mt-6 text-[13px]" style={{ color: C.soft }}>{T(b.meta)}</p>
      </>}
      {b.k === "asks" && (
        <ol className="mt-4 space-y-4">
          {!b.items.length && <li className="text-[15px]">{T(spec.notes)}</li>}
          {b.items.map((it) => (
            <li key={it.n} className="flex gap-3">
              <span className="text-[22px] font-black leading-none" style={{ color: C.acc }}>{it.n}</span>
              <span className="min-w-0"><b className="block text-[17px] leading-snug">{T(it.ask)}</b><span className="block mt-0.5 text-[14px] leading-snug" style={{ color: C.soft }}>{T(it.because)}</span></span>
            </li>
          ))}
        </ol>
      )}
      {b.k === "table" && b.tally && b.tally.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1" data-slide-tally>{b.tally.map((t) => <span key={t.label} className="whitespace-nowrap"><b className="text-[20px]" style={{ color: `#${TONE_HEX[t.tone].fg}` }}>{t.n}</b> <span className="text-[13px]" style={{ color: C.soft }}>{T(t.label)}</span></span>)}</div>
      )}
      {b.k === "table" && <div className="mt-3"><Rows head={b.head} rows={b.rows} tags={b.tags} more={b.more} open={open} /></div>}
      {b.k === "split" && <div className="mt-3 space-y-5"><PanePage pane={b.left} /><PanePage pane={b.right} /></div>}
      {b.k !== "cover" && b.foot && <p className="mt-4 text-[12px]" style={{ color: C.foot }}>{T(b.foot)}</p>}
    </div>
  );
}
function PanePage({ pane }: { pane: SlidePane }) {
  const items = (pane.items ?? []).map(itemOf);
  const label = "text-[11px] font-black uppercase tracking-wider";
  return (
    <div>
      {pane.title && <div className={label} style={{ color: C.acc }}>{T(pane.title)}</div>}
      {items.length > 0 && (
        <div className="mt-1.5 text-[14.5px] leading-snug">
          {items.map((it, i) => <div key={i} className={`flex gap-2 mb-1.5 ${it.bold ? "font-black mt-3" : ""} ${it.sub ? "pl-4" : ""}`}>{!it.bold && <span aria-hidden>•</span>}<span>{T(it.text)}</span></div>)}
        </div>
      )}
      {pane.table && <div className="mt-3">{pane.table.title && <div className={`${label} mb-1.5`} style={{ color: C.acc }}>{T(pane.table.title)}</div>}<Rows head={pane.table.head} rows={pane.table.rows} /></div>}
    </div>
  );
}
/** A table as stacked rows: the first cell, then each of the rest by its heading. */
function Rows({ head, rows, tags, more, open }: { head: string[]; rows: string[][]; tags?: Array<SlideTag | null>; more?: Array<SlideMore | null>; open?: Open }) {
  return (
    <ul className="space-y-2">
      {rows.map((r, i) => {
        const m = open ? more?.[i] ?? null : null;
        return (
          <li key={i} className="rounded-xl px-3 py-2.5 text-[14px] leading-snug" style={{ background: i % 2 ? C.band : "#FFFDF9", border: "1px solid #DDD7CC", cursor: m ? "pointer" : undefined }} onClick={m ? () => open!(m) : undefined} data-row-more={m ? "" : undefined}>
            <div className="flex items-baseline gap-2 flex-wrap font-bold text-[15px]"><span className="min-w-0">{cell(r[0] ?? "", true)}</span>{tags?.[i] && <Tag tag={tags[i]!} size="11.5px" />}</div>
            {r.slice(1).map((c, n) => c && (
              <div key={n} className="mt-1.5">
                <div className="text-[10.5px] font-black uppercase tracking-wider" style={{ color: C.foot }}>{T(head[n + 1])}</div>
                <div>{lines(c)}</div>
              </div>
            ))}
            {m && <div className="mt-2 text-[12px] font-bold" style={{ color: C.acc }}>Tap for more</div>}
          </li>
        );
      })}
    </ul>
  );
}
