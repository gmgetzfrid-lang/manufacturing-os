"use client";

// Printed reports — the company letterhead, in Schedule setup. Upload it
// as a Word file, a PDF or a picture; see page 1 and the pages after with
// the report's place marked; nudge the margins; print a test page.

import React, { useState } from "react";
import { FileUp, Loader2, Printer, Trash2 } from "lucide-react";
import { cleanLetterhead, layerHtml, letterheadDocument, type Letterhead } from "@/lib/letterhead";
import { saveLetterhead, useLetterhead } from "@/lib/letterheadStore";

const btn = "inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[12.5px] font-bold px-3.5 py-2 shadow-sm disabled:opacity-50";
const quiet = "inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] text-[12.5px] font-semibold text-[var(--color-text)] px-3 py-2 hover:bg-[var(--color-surface-2)] disabled:opacity-50";
const ACCEPT = ".docx,.pdf,.png,.jpg,.jpeg,.webp";

/** A page of the letterhead, shrunk to `width` px, with the report's place
 *  marked by sample lines. `which`: page 1, or the pages after it. */
export function LetterheadPreview({ lh, which, width = 220 }: { lh: Letterhead; which: "first" | "rest"; width?: number }) {
  const firstOnly = lh.pages === "first";
  const layer = which === "first" ? lh.first ?? lh.layer : firstOnly ? null : lh.layer;
  const scale = width / (lh.page.w * 96);
  const m = lh.margins;
  return (
    <figure className="m-0">
      <div className="relative bg-white shadow-md ring-1 ring-slate-300 overflow-hidden" style={{ width, height: width * (lh.page.h / lh.page.w) }}>
        <div className="absolute left-0 top-0 origin-top-left" style={{ width: `${lh.page.w}in`, height: `${lh.page.h}in`, transform: `scale(${scale})` }}>
          {/* Built from the checked letterhead: text escaped, pictures only pictures. */}
          {layer && <div className="absolute inset-0" dangerouslySetInnerHTML={{ __html: layerHtml(layer, lh.page) }} />}
          <div className="absolute border-2 border-dashed border-sky-500/70 bg-sky-50/40"
            style={{ left: `${m.left}in`, top: `${m.top}in`, right: `${m.right}in`, bottom: `${m.bottom}in` }}>
            <div className="p-[0.15in] space-y-[0.09in]">
              <div className="h-[0.16in] w-1/2 rounded bg-slate-700/70" />
              {Array.from({ length: 9 }).map((_, i) => <div key={i} className="h-[0.08in] rounded bg-slate-400/50" style={{ width: `${92 - (i % 3) * 14}%` }} />)}
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-1 text-[11px] text-[var(--color-text-muted)]">{which === "first" ? "Page 1" : "Pages after"}</figcaption>
    </figure>
  );
}

const SAMPLE = `<div style="font-family:Inter,Arial,sans-serif;font-size:10pt;color:#0f172a">
<div style="font-size:9pt;color:#64748b">Shift turnover</div>
<div style="font-size:15pt;font-weight:700;margin:2pt 0 10pt">Test page — the report prints here</div>
${Array.from({ length: 70 }, (_, i) => `<div style="padding:3pt 0;border-top:1px solid #e2e8f0">${i + 1}. A line of the report, inside the letterhead's margins.</div>`).join("")}
</div>`;

/** Print a page or two of sample text on the letterhead. */
export function printLetterheadTest(lh: Letterhead): boolean {
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.write(letterheadDocument(lh, "Letterhead test page", SAMPLE));
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 400);
  return true;
}

export function LetterheadStep({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { lh: saved, loaded } = useLetterhead(projectId);
  const [draft, setDraft] = useState<Letterhead | null>(null);
  const lh = draft ?? saved;
  const [busy, setBusy] = useState<"read" | "save" | "remove" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const read = async (f: File | undefined) => {
    if (!f) return;
    setBusy("read"); setErr(null); setMsg(null);
    try {
      const { readLetterheadFile } = await import("@/lib/letterheadBrowser");
      const got = cleanLetterhead(await readLetterheadFile(f));
      if (!got) throw new Error("That file couldn't be read as a letterhead.");
      setDraft(got);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };
  const save = async () => {
    if (!draft) return;
    setBusy("save"); setErr(null);
    try { await saveLetterhead(projectId, draft); setDraft(null); setMsg("Saved — printed reports on this project now come out on this letterhead."); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    if (!window.confirm("Remove the letterhead? Printed reports go back to plain paper.")) return;
    setBusy("remove"); setErr(null);
    try { await saveLetterhead(projectId, null); setDraft(null); setMsg("Removed — reports print on plain paper."); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };
  const margin = (k: keyof Letterhead["margins"], v: number) => {
    if (!lh || !Number.isFinite(v)) return;
    setDraft({ ...lh, margins: { ...lh.margins, [k]: Math.max(0, Math.min(k === "top" || k === "bottom" ? lh.page.h / 2 : lh.page.w / 3, Math.round(v * 100) / 100)) } });
  };
  const fileInput = (label: string, primary: boolean) => (
    <label className={`${primary ? btn : quiet} cursor-pointer ${busy || !canManage ? "pointer-events-none opacity-50" : ""}`}>
      {busy === "read" ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileUp className="w-4 h-4" />} {busy === "read" ? "Reading…" : label}
      <input type="file" accept={ACCEPT} className="sr-only" disabled={!!busy || !canManage}
        onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ""; }} />
    </label>
  );

  if (!loaded) return <div className="text-[12.5px] text-[var(--color-text-muted)] inline-flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Reading the saved letterhead…</div>;

  if (!lh) {
    return (
      <div className="space-y-2.5">
        <label
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); if (canManage) void read(e.dataTransfer.files?.[0]); }}
          className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center cursor-pointer ${over ? "border-[var(--color-accent)] bg-[var(--color-surface-2)]" : "border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]"} ${!canManage ? "pointer-events-none opacity-60" : ""}`}>
          {busy === "read" ? <Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-muted)]" /> : <FileUp className="w-6 h-6 text-[var(--color-text-muted)]" />}
          <span className="text-[13.5px] font-bold text-[var(--color-text)]">{busy === "read" ? "Reading the letterhead…" : "Upload your letterhead"}</span>
          <span className="text-[12px] text-[var(--color-text-muted)] max-w-md">Word (.docx) keeps its logo, address and margins. A PDF or a picture of the page works too — the report goes in its blank part.</span>
          <input type="file" accept={ACCEPT} className="sr-only" disabled={!!busy || !canManage}
            onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {!canManage && <div className="text-[12px] text-[var(--color-text-muted)]">Only the project owner or an admin can set the letterhead.</div>}
        {err && <div className="text-[12px] text-rose-700 dark:text-rose-300">{err}</div>}
        {msg && <div className="text-[12px] text-emerald-700 dark:text-emerald-400">{msg}</div>}
      </div>
    );
  }

  const hasRest = lh.pages !== "first";
  return (
    <div className="space-y-3">
      <div className="flex flex-col md:flex-row gap-4">
        <div className="flex gap-3 shrink-0">
          <LetterheadPreview lh={lh} which="first" width={hasRest ? 170 : 220} />
          {hasRest && <LetterheadPreview lh={lh} which="rest" width={170} />}
        </div>
        <div className="flex-1 min-w-0 space-y-3">
          <div className="text-[12.5px] text-[var(--color-text)]">
            <b className="break-words">{lh.name}</b>
            <span className="text-[var(--color-text-muted)]"> · {lh.kind === "docx" ? "Word" : lh.kind === "pdf" ? "PDF" : "picture"} · {lh.page.w}″ × {lh.page.h}″{draft ? " · not saved yet" : ""}</span>
          </div>
          <fieldset className="space-y-1.5" disabled={!canManage}>
            <legend className="text-[12px] font-semibold text-[var(--color-text)]">Where the report goes — inches in from each edge</legend>
            <div className="grid grid-cols-2 gap-2 max-w-xs">
              {(["top", "bottom", "left", "right"] as const).map((k) => (
                <label key={k} className="flex items-center justify-between gap-2 text-[12px] text-[var(--color-text-muted)] capitalize">
                  {k}
                  <input type="number" step={0.05} min={0} value={lh.margins[k]} onChange={(e) => margin(k, Number(e.target.value))}
                    className="h-8 w-20 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[13px] text-[var(--color-text)] tabular-nums" />
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-1" disabled={!canManage}>
            <legend className="text-[12px] font-semibold text-[var(--color-text)]">Print it on</legend>
            {([["all", lh.first ? "Every page (page 1 as in the file, the rest with its other header)" : "Every page"], ["first", "Page 1 only"]] as const).map(([v, label]) => (
              <label key={v} className="flex items-center gap-2 text-[12.5px] text-[var(--color-text)]">
                <input type="radio" name="lh-pages" checked={(lh.pages ?? "all") === v} onChange={() => setDraft({ ...lh, pages: v })} /> {label}
              </label>
            ))}
          </fieldset>
          {err && <div className="text-[12px] text-rose-700 dark:text-rose-300">{err}</div>}
          {msg && !draft && <div className="text-[12px] text-emerald-700 dark:text-emerald-400">{msg}</div>}
          <div className="flex flex-wrap gap-2">
            {canManage && draft && (
              <button type="button" onClick={() => void save()} disabled={!!busy} className={btn}>
                {busy === "save" && <Loader2 className="w-4 h-4 animate-spin" />} Save for the project
              </button>
            )}
            <button type="button" onClick={() => { if (!printLetterheadTest(lh)) setErr("Your browser blocked the print window — allow pop-ups for this site."); }} className={quiet}>
              <Printer className="w-4 h-4" /> Print a test page
            </button>
            {canManage && fileInput("Replace…", false)}
            {canManage && draft && saved && <button type="button" onClick={() => { setDraft(null); setErr(null); }} className={quiet}>Undo changes</button>}
            {canManage && saved && !draft && (
              <button type="button" onClick={() => void remove()} disabled={!!busy} className={`${quiet} text-rose-700 dark:text-rose-300`}>
                {busy === "remove" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Remove
              </button>
            )}
          </div>
          <p className="text-[11.5px] text-[var(--color-text-muted)]">The shift report&apos;s Print and Email / Print both use it. For the best result print at 100% (no &ldquo;fit to page&rdquo;), with headers and footers off.</p>
        </div>
      </div>
    </div>
  );
}
