"use client";

// CodebookLearn - "your own numbers already say this." The site's drawing
// numbers and equipment IDs follow its convention before the codebook is
// told it. This reads what is on file (lib/codebookLearn), says what the
// numbers show with the count behind each line, and a person accepts it
// with one tap. Nothing is saved until they do, and everything it saves is
// editable in the tabs below.

import React, { useEffect, useState } from "react";
import { Check, Lightbulb, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { saveConfig, upsertEntry, type Codebook } from "@/lib/codebook";
import { learnDrawingNumbers, learnTagLetters, type LearnedNumbering, type LearnedPrefixes } from "@/lib/codebookLearn";

interface Found { numbering: Array<{ library: string; learned: LearnedNumbering }>; letters: LearnedPrefixes[] }

async function readSite(orgId: string, book: Codebook): Promise<Found> {
  const [libs, cols, docs, assets] = await Promise.all([
    supabase.from("libraries").select("id, name").eq("org_id", orgId),
    fetchAllRows<{ id: string; parent_id: string | null; name: string | null; deleted_at?: string | null }>((from, to) => supabase.from("collections").select("*").eq("org_id", orgId).order("id").range(from, to)),
    fetchAllRows<{ document_number: string | null; library_id: string; collection_id: string | null }>((from, to) => supabase.from("documents").select("document_number, library_id, collection_id").eq("org_id", orgId).order("id").range(from, to)),
    fetchAllRows<{ tag: string; code: string | null }>((from, to) => supabase.from("assets").select("tag, code").eq("org_id", orgId).order("id").range(from, to)),
  ]);
  const byId = new Map(cols.rows.map((c) => [c.id, c]));
  const top = (id: string | null): string | null => {
    let cur = id ? byId.get(id) : undefined, last: typeof cur = undefined;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); last = cur; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined; }
    return last?.name ?? null;
  };
  const numbering: Found["numbering"] = [];
  for (const l of ((libs.data ?? []) as Array<{ id: string; name: string | null }>)) {
    const mine = docs.rows.filter((d) => d.library_id === l.id).map((d) => ({ number: d.document_number ?? "", topFolder: top(d.collection_id) }));
    const learned = learnDrawingNumbers(mine, book);
    if (learned) numbering.push({ library: l.name ?? "Library", learned });
  }
  return { numbering, letters: learnTagLetters(assets.rows, book) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export default function CodebookLearn({ orgId, uid, book, canWrite, onChanged, onError }: {
  orgId: string; uid: string; book: Codebook; canWrite: boolean; onChanged: () => void; onError: (m: string | null) => void;
}) {
  const [found, setFound] = useState<Found | null>(null);
  const [busy, setBusy] = useState<"numbering" | "letters" | null>(null);
  useEffect(() => {
    let live = true;
    void readSite(orgId, book).then((f) => { if (live) setFound(f); }).catch(() => { if (live) setFound({ numbering: [], letters: [] }); });
    return () => { live = false; };
  }, [orgId, book]);

  if (!found) return null;
  // The library whose numbers fit best speaks for the site.
  const best = [...found.numbering].sort((a, b) => b.learned.fit - a.learned.fit)[0] ?? null;
  const newTypes = best ? best.learned.types.filter((t) => t.label && !t.known) : [];
  const numberingNew = !!best && (!same(book.drawingNumber?.segments ?? null, best.learned.segments) || newTypes.length > 0);
  if (!numberingNew && found.letters.length === 0) return null;

  const acceptNumbering = async () => {
    if (!best) return;
    setBusy("numbering"); onError(null);
    try {
      await saveConfig(orgId, { drawingNumber: { segments: best.learned.segments } }, uid);
      for (const [i, t] of newTypes.entries()) await upsertEntry(orgId, { kind: "drawing_type", code: t.code, label: t.label!, meta: {}, sort: book.drawingTypes.length + i, origin: "manual" }, uid);
      onChanged();
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(null); }
  };
  const acceptLetters = async () => {
    setBusy("letters"); onError(null);
    try {
      for (const r of found.letters) {
        const entry = book.equipmentTypes.find((t) => t.code === r.typeCode);
        if (!entry) continue;
        const prefixes = Array.from(new Set([...(entry.meta.tagPrefixes ?? []).map((p) => p.toUpperCase()), ...r.letters.map((l) => l.letter)]));
        await upsertEntry(orgId, { ...entry, meta: { ...entry.meta, tagPrefixes: prefixes } }, uid);
      }
      onChanged();
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(null); }
  };

  const card = "rounded-2xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-4";
  const btn = "inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[12.5px] font-black disabled:opacity-50";
  return (
    <div className="mb-4 space-y-3" data-codebook-learn>
      {numberingNew && best && (
        <div className={card}>
          <div className="flex items-start gap-2 flex-wrap">
            <Lightbulb className="w-4 h-4 mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" />
            <div className="min-w-0 flex-1 basis-64 text-[12.5px] text-[var(--color-text)]">
              <div className="font-black">Your drawing numbers already follow a pattern</div>
              <p className="mt-1 text-[var(--color-text-muted)]">
                <b className="text-[var(--color-text)]">{best.learned.fit} of {best.learned.total}</b> numbers in {best.library} read as: unit ({best.learned.segments[0].digits} digits), drawing type (2 digits), a size letter, then the drawing&rsquo;s number.
              </p>
              <ul className="mt-2 space-y-0.5">
                {best.learned.examples.map((x) => (
                  <li key={x.number} className="break-words"><b className="font-mono">{x.number}</b>: {x.unitLabel} ({x.unit}), type {x.type}, size {x.size}, number {x.serial}</li>
                ))}
              </ul>
              <ul className="mt-2 space-y-0.5">
                {best.learned.types.map((t) => (
                  <li key={t.code}>Type <b className="font-mono">{t.code}</b>: {t.count} drawing{t.count === 1 ? "" : "s"}{t.folder ? `, ${t.inFolder === t.count ? "all" : `${t.inFolder}`} under ${t.folder}` : ""}{t.known ? `. Already named ${t.known}.` : t.label ? <>. Named <b>{t.label}</b>.</> : ". Filed in more than one place: name it in the Drawings tab."}</li>
                ))}
              </ul>
              {best.learned.misses.length > 0 && <p className="mt-2 text-[var(--color-text-muted)]">Did not fit: <span className="font-mono break-all">{best.learned.misses.join(", ")}</span></p>}
              <p className="mt-2 text-[var(--color-text-muted)]">With this saved, a drawing links to its unit by its number, and its type is known.</p>
            </div>
            {canWrite && <button type="button" onClick={() => void acceptNumbering()} disabled={busy !== null} className={btn}>{busy === "numbering" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Use this</button>}
          </div>
        </div>
      )}
      {found.letters.length > 0 && (
        <div className={card}>
          <div className="flex items-start gap-2 flex-wrap">
            <Lightbulb className="w-4 h-4 mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" />
            <div className="min-w-0 flex-1 basis-64 text-[12.5px] text-[var(--color-text)]">
              <div className="font-black">Tag letters, from your equipment list</div>
              <p className="mt-1 text-[var(--color-text-muted)]">Each ID says the type (5530.29 is type 30) and each tag says the letter (E-22). A letter is listed only when it belongs to one type.</p>
              <ul className="mt-2 space-y-0.5">
                {found.letters.map((r) => (
                  <li key={r.typeCode}><b>{r.typeLabel}</b> ({r.typeCode}): {r.letters.map((l) => `${l.letter} (${l.count})`).join(", ")}{r.have.length ? ` · has ${r.have.join(", ")}` : ""}</li>
                ))}
              </ul>
            </div>
            {canWrite && <button type="button" onClick={() => void acceptLetters()} disabled={busy !== null} className={btn}>{busy === "letters" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Use these</button>}
          </div>
        </div>
      )}
    </div>
  );
}
