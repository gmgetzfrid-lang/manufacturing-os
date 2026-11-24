"use client";

// Printed reports — the company letterhead, in Schedule setup. Upload it
// as a Word file, a PDF or a picture; see page 1 and the pages after with
// the report's place marked; nudge the margins; print a test page.

import React, { useState } from "react";
import { FileUp, Loader2, Printer, Trash2 } from "lucide-react";
import { useOrgBranding } from "@/components/providers/OrgBrandingProvider";
import SlideTemplateSetup from "@/components/branding/SlideTemplateSetup";
import { saveSlidesChoice, useSlidesChoice } from "@/lib/slidesChoice";
import { cleanLetterhead, layerHtml, letterheadDocument, type Letterhead } from "@/lib/letterhead";
import { saveLetterhead, useLetterhead } from "@/lib/letterheadStore";
import { useFileDrag } from "@/hooks/useFileDrag";
import { tryUpload } from "@/lib/uploadRetry";
import FileThumb from "@/components/ui/FileThumb";
import { fileSize } from "@/components/projects/cost/FilePreview";
import { appConfirm } from "@/components/providers/DialogProvider";
import { sayError } from "@/components/projects/sayError";

const btn = "inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-caption font-medium px-3.5 py-2 shadow-sm disabled:opacity-50";
const quiet = "inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] text-caption font-medium text-[var(--color-text)] px-3 py-2 hover:bg-[var(--color-surface-2)] disabled:opacity-50";
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
          <div className="absolute border-2 border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-2)]"
            style={{ left: `${m.left}in`, top: `${m.top}in`, right: `${m.right}in`, bottom: `${m.bottom}in` }}>
            <div className="p-[0.15in] space-y-[0.09in]">
              <div className="h-[0.16in] w-1/2 rounded bg-slate-700/70" />
              {Array.from({ length: 9 }).map((_, i) => <div key={i} className="h-[0.08in] rounded bg-slate-400/50" style={{ width: `${92 - (i % 3) * 14}%` }} />)}
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-1 text-caption text-[var(--color-text-muted)]">{which === "first" ? "Page 1" : "Pages after"}</figcaption>
    </figure>
  );
}

const SAMPLE = `<div style="font-family:Inter,Arial,sans-serif;font-size:10pt;color:#0f172a">
<div style="font-size:9pt;color:#64748b">Shift turnover</div>
<div style="font-size:15pt;font-weight:700;margin:2pt 0 10pt">Test page: the report prints here</div>
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
  // The file being read, and one that couldn't be, kept for Try again.
  const [picked, setPicked] = useState<File | null>(null);
  const [failed, setFailed] = useState<File | null>(null);

  const read = async (f: File | undefined) => {
    if (!f) return;
    setBusy("read"); setErr(null); setMsg(null); setPicked(f); setFailed(null);
    try {
      const { readLetterheadFile } = await import("@/lib/letterheadBrowser");
      const got = cleanLetterhead(await readLetterheadFile(f));
      if (!got) throw new Error("That file couldn't be read as a letterhead.");
      setDraft(got);
    } catch (e) { setErr(sayError(e)); setFailed(f); }
    finally { setBusy(null); setPicked(null); }
  };
  const drag = useFileDrag((fs) => { void read(fs[0]); }, !!busy || !canManage);
  const save = async () => {
    if (!draft) return;
    setBusy("save"); setErr(null);
    const done = () => { setDraft(null); setErr(null); setMsg("Saved. Printed reports on this project now come out on this letterhead."); };
    try { await tryUpload(`Letterhead: ${draft.name}`, () => saveLetterhead(projectId, draft), { onRetried: done }); done(); }
    catch (e) { setErr(sayError(e)); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    if (!(await appConfirm({ message: "Remove the letterhead? Printed reports go back to plain paper.", tone: "danger", confirmLabel: "Remove" }))) return;
    setBusy("remove"); setErr(null);
    try { await saveLetterhead(projectId, null); setDraft(null); setMsg("Removed. Reports print on plain paper."); }
    catch (e) { setErr(sayError(e)); }
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

  if (!loaded) return <div className="text-caption text-[var(--color-text-muted)] inline-flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Reading the saved letterhead…</div>;

  if (!lh) {
    return (
      <div className="space-y-2.5">
        <label {...drag.bind}
          className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center cursor-pointer ${drag.over ? `border-[var(--color-main)] ${drag.ring}` : "border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]"} ${!canManage ? "pointer-events-none opacity-60" : ""}`}>
          {picked ? <FileThumb file={picked} size={44} /> : <FileUp className="w-6 h-6 text-[var(--color-text-muted)]" />}
          <span className="text-body font-medium text-[var(--color-text)]">
            {drag.over ? drag.say : picked ? <><Loader2 className="w-4 h-4 animate-spin inline mr-1" />Reading {picked.name} · {fileSize(picked.size)}</> : "Upload your letterhead"}
          </span>
          <span className="text-caption text-[var(--color-text-muted)] max-w-md">Word (.docx) keeps its logo, address and margins. A PDF or a picture of the page works too: the report goes in its blank part.</span>
          <input type="file" accept={ACCEPT} className="sr-only" disabled={!!busy || !canManage}
            onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {!canManage && <div className="text-caption text-[var(--color-text-muted)]">Only the project owner or an admin can set the letterhead.</div>}
        {err && (
          <div role="alert" className="flex items-center gap-2 flex-wrap border-l-2 border-[var(--state-overdue)] pl-2 text-caption text-[var(--state-overdue-text)]">
            {failed && <FileThumb file={failed} size={28} />}
            <span className="min-w-0 flex-1">{failed ? `${failed.name} · ${fileSize(failed.size)}: ` : ""}{err}</span>
            {failed && <button type="button" onClick={() => void read(failed)} className={quiet}>Try again</button>}
          </div>
        )}
        {msg && <div className="text-caption text-[var(--state-released-text)]">{msg}</div>}
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
          <div className="text-caption text-[var(--color-text)]">
            <b className="break-words">{lh.name}</b>
            <span className="text-[var(--color-text-muted)]"> · {lh.kind === "docx" ? "Word" : lh.kind === "pdf" ? "PDF" : "picture"} · {lh.page.w}″ × {lh.page.h}″{draft ? " · not saved yet" : ""}</span>
          </div>
          <fieldset className="space-y-1.5" disabled={!canManage}>
            <legend className="text-caption font-medium text-[var(--color-text)]">Where the report goes: inches in from each edge</legend>
            <div className="grid grid-cols-2 gap-2 max-w-xs">
              {(["top", "bottom", "left", "right"] as const).map((k) => (
                <label key={k} className="flex items-center justify-between gap-2 text-caption text-[var(--color-text-muted)] capitalize">
                  {k}
                  <input type="number" step={0.05} min={0} value={lh.margins[k]} onChange={(e) => margin(k, Number(e.target.value))}
                    className="h-8 pointer-coarse:h-11 w-20 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-body text-[var(--color-text)] tabular-nums" />
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-1" disabled={!canManage}>
            <legend className="text-caption font-medium text-[var(--color-text)]">Print it on</legend>
            {([["all", lh.first ? "Every page (page 1 as in the file, the rest with its other header)" : "Every page"], ["first", "Page 1 only"]] as const).map(([v, label]) => (
              <label key={v} className="flex items-center gap-2 text-caption text-[var(--color-text)]">
                <input type="radio" name="lh-pages" checked={(lh.pages ?? "all") === v} onChange={() => setDraft({ ...lh, pages: v })} /> {label}
              </label>
            ))}
          </fieldset>
          {err && (
            <div role="alert" className="flex items-center gap-2 flex-wrap border-l-2 border-[var(--state-overdue)] pl-2 text-caption text-[var(--state-overdue-text)]">
              {failed && <FileThumb file={failed} size={28} />}
              <span className="min-w-0 flex-1">{failed ? `${failed.name} · ${fileSize(failed.size)}: ` : ""}{err}</span>
              {failed && <button type="button" onClick={() => void read(failed)} className={quiet}>Try again</button>}
            </div>
          )}
          {picked && <div className="flex items-center gap-2 text-caption text-[var(--color-text-muted)]"><FileThumb file={picked} size={28} /> Reading {picked.name} · {fileSize(picked.size)}…</div>}
          {msg && !draft && <div className="text-caption text-[var(--state-released-text)]">{msg}</div>}
          <div className="flex flex-wrap gap-2">
            {canManage && draft && (
              <button type="button" onClick={() => void save()} disabled={!!busy} className={btn}>
                {busy === "save" && <Loader2 className="w-4 h-4 animate-spin" />} Save for the project
              </button>
            )}
            <button type="button" onClick={() => { if (!printLetterheadTest(lh)) setErr("Your browser blocked the print window. Allow pop-ups for this site."); }} className={quiet}>
              <Printer className="w-4 h-4" /> Print a test page
            </button>
            {canManage && fileInput("Replace…", false)}
            {canManage && draft && saved && <button type="button" onClick={() => { setDraft(null); setErr(null); }} className={quiet}>Undo changes</button>}
            {canManage && saved && !draft && (
              <button type="button" onClick={() => void remove()} disabled={!!busy} className={`${quiet} text-[var(--state-overdue-text)]`}>
                {busy === "remove" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Remove
              </button>
            )}
          </div>
          <p className="text-caption text-[var(--color-text-muted)]">The shift report&apos;s Print and Email / Print both use it. For the best result print at 100% (no &ldquo;fit to page&rdquo;), with headers and footers off.</p>
        </div>
      </div>
    </div>
  );
}

/** Under the letterhead: the project's slides. A switch for whether they go
 *  onto the company PowerPoint template, and the template itself (upload,
 *  replace, which layout each slide goes on, the slides drawn on it), right
 *  here. The template is the workspace's: every project can use it. */
export function SlidesStep({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { branding } = useOrgBranding();
  const t = branding?.slides;
  const { choice, loaded } = useSlidesChoice(projectId);
  const on = !!t && (choice ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = async (v: boolean) => {
    setBusy(true); setErr(null);
    try { await saveSlidesChoice(projectId, v); } catch (e) { setErr(sayError(e)); } finally { setBusy(false); }
  };
  return (
    <section id="slides" className="mt-6 pt-5 border-t border-[var(--color-border)] scroll-mt-20" data-slides-step>
      <div className="flex items-center gap-2.5 flex-wrap">
        <h3 className="min-w-0 flex-1 text-reading font-medium text-[var(--color-text)]">Slides</h3>
        {t && (
          <div role="radiogroup" aria-label="This project's slides" className="inline-flex rounded-md border border-[var(--color-border-strong)] overflow-hidden text-body font-medium">
            {([[true, "Company template"], [false, "Plain"]] as const).map(([v, label]) => (
              <button key={label} type="button" role="radio" aria-checked={on === v} disabled={!canManage || busy || !loaded} onClick={() => void set(v)}
                className={`h-9 px-3 ${on === v ? "bg-[var(--color-main)] text-white" : "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"} disabled:cursor-not-allowed`}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="mt-1.5 text-body text-[var(--color-text-muted)]">
        {!t ? "Upload the company's PowerPoint template. Every project can use it." : on ? "This project's slides go onto the company template." : "This project's slides use the workspace colors, without the template."}
        {t && !canManage ? " Only the project owner or an admin can change this." : ""}
      </p>
      {err && <p role="alert" className="mt-1.5 text-body font-medium text-[var(--state-overdue)]">{err}</p>}
      <div className="mt-3"><SlideTemplateSetup bare /></div>
    </section>
  );
}
