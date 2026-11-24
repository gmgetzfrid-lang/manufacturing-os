"use client";

// SlideEditPanel - Edit mode beside the review slides. For the slide on
// show: its pictures (take one off, add an equipment photo, upload a new
// one that's filed with its equipment, or go back to the app's picks), and
// its words (tap a line on the slide; what a person wrote opens to change,
// in the review itself, so the report says the same). Numbers counted from
// the records can't be typed over.

import React, { useState } from "react";
import { Camera, Check, ImagePlus, Loader2, RotateCcw, Trash2, Upload, X, CircleAlert } from "lucide-react";
import SignedImg from "@/components/assets/SignedImg";
import { btnQuiet, btnRow } from "@/components/admin/kit";
import { normalizeTag } from "@/lib/assets";
import type { PhotoOption, SlidePicChoice } from "@/lib/slidePictures";
import { sayError } from "@/components/projects/sayError";

export interface SlideEdit {
  /** The slide's pictures now, whether a person chose them, how many it has room for, and why none when none. */
  picsOf: (key: string) => { pics: Array<SlidePicChoice & { url?: string }>; chosen: boolean; room: number; why: string | null };
  /** Every equipment photo the review's slides can use, best first per piece of equipment. */
  options: PhotoOption[];
  /** The equipment the slide names. */
  tagsOf: (key: string) => string[];
  /** Save the slide's pictures (null: back to the app's picks). */
  setPics: (key: string, pics: SlidePicChoice[] | null) => Promise<void>;
  /** Upload a photo, filed with that equipment when one is named. */
  upload: (file: File, tag: string | null) => Promise<SlidePicChoice>;
  /** The form to change what a finding says. */
  words: (rowKey: string, close: () => void) => React.ReactNode;
}

const thumb = "w-full aspect-[4/3] object-cover rounded-md bg-[var(--color-surface-2)]";

export default function SlideEditPanel({ edit, slideKey, slideNo, rowKey, rowKind, rowPicked, onClearRow, onDone }: {
  edit: SlideEdit; slideKey: string | null; slideNo: number;
  /** The line tapped on the slide: the finding it was written from, and what kind of line it is. */
  rowKey: string | null; rowKind: "finding" | "record" | "score" | "fixed"; rowPicked: boolean; onClearRow: () => void; onDone: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const here = slideKey ? edit.picsOf(slideKey) : { pics: [], chosen: false, room: 0, why: "This slide has no room for pictures." };
  const tags = slideKey ? edit.tagsOf(slideKey) : [];
  const [upTag, setUpTag] = useState<string>("");
  const onSlide = edit.options.filter((o) => tags.some((t) => normalizeTag(t) === normalizeTag(o.tag)));
  const others = edit.options.filter((o) => !onSlide.includes(o));
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what); setErr(null); setSaved(false);
    try { await f(); setSaved(true); } catch (e) { setErr(sayError(e)); } finally { setBusy(null); }
  };
  const plain = (p: SlidePicChoice & { url?: string }): SlidePicChoice => ({ path: p.path, caption: p.caption, ...(p.tag ? { tag: p.tag } : {}) });
  const add = (p: SlidePicChoice) => slideKey && run(`add:${p.path}`, async () => {
    const next = [...here.pics.map(plain).filter((x) => x.path !== p.path), plain(p)].slice(-here.room);
    await edit.setPics(slideKey, next);
    setPicking(false);
  });
  const remove = (path: string) => slideKey && run(`rm:${path}`, () => edit.setPics(slideKey, here.pics.filter((p) => p.path !== path).map(plain)));
  const reset = () => slideKey && run("reset", () => edit.setPics(slideKey, null));
  const upload = (f: File | undefined) => f && slideKey && run("upload", async () => {
    const pic = await edit.upload(f, upTag || null);
    await edit.setPics(slideKey, [...here.pics.map(plain), pic].slice(-here.room));
    setPicking(false);
  });
  const full = here.pics.length >= here.room;

  const grid = (list: PhotoOption[]) => (
    <div className="grid grid-cols-3 gap-2">
      {list.map((o) => (
        <button key={o.photoId} type="button" disabled={!!busy || here.pics.some((p) => p.path === o.path)} onClick={() => void add(o)}
          className="text-left rounded-lg p-1 ring-1 ring-[var(--color-border)] hover:ring-[var(--color-main)] disabled:opacity-40" title={o.caption}>
          <SignedImg path={o.path} alt="" className={thumb} />
          <span className="block mt-1 text-caption font-medium text-[var(--color-text)] truncate">{o.tag}</span>
        </button>
      ))}
    </div>
  );

  return (
    <aside className="h-full flex flex-col bg-[var(--color-surface)] text-[var(--color-text)] on-sheet" aria-label="Edit this slide" data-slide-edit>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)]">
        <h2 className="min-w-0 flex-1 text-reading font-medium">Edit slide {slideNo}</h2>
        {busy ? <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" /> : saved ? <span className="inline-flex items-center gap-1 text-body text-[var(--state-released-text)]"><Check className="w-4 h-4" /> Saved</span> : null}
        <button type="button" onClick={onDone} className={btnQuiet}>Done</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-6">
        {err && <p role="alert" className="text-body font-medium text-[var(--state-overdue-text)] flex items-start gap-1.5"><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-0.5" /><span>{err}</span></p>}

        <section>
          <h3 className="text-body font-medium text-[var(--color-heading)]">Pictures</h3>
          {here.room === 0 ? (
            <p className="mt-1.5 text-body text-[var(--color-text-muted)]">{here.why}</p>
          ) : (
            <>
              {here.pics.length === 0 && <p className="mt-1.5 text-body text-[var(--color-text-muted)]">{here.chosen ? "You took the pictures off this slide." : "No picture yet."}</p>}
              <ul className="mt-2 space-y-2">
                {here.pics.map((p) => (
                  <li key={p.path} className="flex items-center gap-3 rounded-lg ring-1 ring-[var(--color-border)] p-2">
                    <div className="w-20 shrink-0">{p.url ? (/* eslint-disable-next-line @next/next/no-img-element */ <img src={p.url} alt="" className={thumb} />) : <SignedImg path={p.path} alt="" className={thumb} />}</div>
                    <div className="min-w-0 flex-1">
                      <div className="text-body font-medium truncate">{p.caption || "Picture"}</div>
                      <div className="text-caption text-[var(--color-text-muted)]">{here.chosen ? "You picked it" : "The app picked it"}</div>
                    </div>
                    <button type="button" onClick={() => void remove(p.path)} disabled={!!busy} className={btnRow} aria-label={`Take ${p.caption || "this picture"} off the slide`}>
                      <Trash2 className="w-4 h-4" /> Remove
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                {!picking && <button type="button" onClick={() => setPicking(true)} disabled={!!busy || full} className={btnQuiet}><ImagePlus className="w-4 h-4" /> Add a picture</button>}
                {here.chosen && <button type="button" onClick={() => void reset()} disabled={!!busy} className={btnQuiet}><RotateCcw className="w-4 h-4" /> Use the app&apos;s picks</button>}
              </div>
              {full && !picking && <p className="mt-1.5 text-body text-[var(--color-text-muted)]">This slide holds {here.room === 1 ? "one picture" : `${here.room} pictures`}. Remove one to add another.</p>}
              {picking && (
                <div className="mt-3 rounded-lg ring-1 ring-[var(--color-border-strong)] p-3 space-y-3" data-pic-picker>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 text-body font-medium">Add a picture</span>
                    <button type="button" onClick={() => setPicking(false)} className="ui-hit p-1.5 rounded-md hover:bg-[var(--color-surface-2)]" aria-label="Close"><X className="w-4 h-4" /></button>
                  </div>
                  {onSlide.length > 0 && <div><div className="mb-1.5 text-caption font-medium text-[var(--color-text-muted)]">Equipment on this slide</div>{grid(onSlide)}</div>}
                  {others.length > 0 && <div><div className="mb-1.5 text-caption font-medium text-[var(--color-text-muted)]">Other equipment in this review</div>{grid(others)}</div>}
                  {!edit.options.length && <p className="text-body text-[var(--color-text-muted)]">No equipment in this review has photos yet. Upload one: it&apos;s kept with its equipment, so the next slides can use it too.</p>}
                  <div className="pt-2 border-t border-[var(--color-border)] space-y-2">
                    <label className="block">
                      <span className="block text-caption font-medium text-[var(--color-text-muted)] mb-1">Whose photo is it?</span>
                      <select value={upTag} onChange={(e) => setUpTag(e.target.value)} className="w-full h-10 pointer-coarse:h-11 px-2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-reading">
                        <option value="">Not one piece of equipment</option>
                        {tags.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </label>
                    <label className={`${btnQuiet} w-full cursor-pointer ${busy ? "pointer-events-none opacity-50" : ""}`}>
                      {busy === "upload" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} {busy === "upload" ? "Uploading" : "Upload a photo"}
                      <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
                    </label>
                    <label className={`${btnQuiet} w-full cursor-pointer sm:hidden ${busy ? "pointer-events-none opacity-50" : ""}`}>
                      <Camera className="w-4 h-4" /> Take a photo
                      <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
                    </label>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        <section>
          <h3 className="text-body font-medium text-[var(--color-heading)]">Words</h3>
          {!rowPicked ? (
            <p className="mt-1.5 text-body text-[var(--color-text-muted)]">Tap a line on the slide to change what it says.</p>
          ) : rowKind === "finding" && rowKey ? (
            <div className="mt-2" data-slide-words>{edit.words(rowKey, onClearRow)}</div>
          ) : (
            <div className="mt-1.5 space-y-2">
              <p className="text-body text-[var(--color-text-muted)]">{rowKind === "score" ? "The score is counted from the records, so it can't be typed over here. Targets, the budget and what a person enters on a line are set on the score in the review." : rowKind === "record" ? "This line is counted from the records, so it can't be typed over. Change the record and the slide follows." : "This line is the same in every review."}</p>
              <button type="button" onClick={onClearRow} className={btnRow}>Done</button>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
