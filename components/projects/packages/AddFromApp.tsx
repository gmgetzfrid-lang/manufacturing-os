"use client";

// AddFromApp - documents into a work package from what the app already
// knows. First what's on file for the package's equipment (tagged by a
// person or found on the sheets by the drawing reader), then the app's own
// search, the same one Documents and the top bar use: equipment by tag or
// number, document numbers and titles, tags read off drawings and words
// inside the pages, each saying why it matched. Files from the computer
// are dropped anywhere on the package.

import React, { useEffect, useRef, useState } from "react";
import { Loader2, Search, Wrench } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { field as fieldCls } from "@/components/admin/kit";
import { useFind } from "@/components/find/useFind";
import { assetWords, type PackageAsset } from "@/lib/equipmentFiles";
import { equipLabel, type FindDoc } from "@/lib/findEverywhere";

const docName = (d: FindDoc) => [d.number, d.title && d.title !== d.number ? d.title : ""].filter(Boolean).join(" ") || d.name || "Document";

export default function AddFromApp({ orgId, asset, assetMissing, onFile, inPkg, onAdd, onDone }: {
  orgId: string;
  /** The package's equipment in the registry (undefined while it loads). */
  asset: PackageAsset | null | undefined;
  /** Said when the registry doesn't have it ("2030.71"). */
  assetMissing: string | null;
  /** What's on file for it (null while it loads). */
  onFile: FindDoc[] | null;
  inPkg: Set<string>;
  onAdd: (docs: FindDoc[]) => Promise<void>;
  onDone: () => void;
}) {
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  // Opened under the package's list: brought into view.
  const box = useRef<HTMLElement>(null);
  useEffect(() => { box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, []);
  const f = useFind(orgId, q, asset?.unitCode ?? null);
  const add = async (docs: FindDoc[], id: string) => { setAdding(id); try { await onAdd(docs); } finally { setAdding(null); } };

  const searching = q.trim().length >= 2;
  const picked = f.pickedDocIds.map((id) => f.docs[id]).filter((d): d is FindDoc => !!d);
  const shownIds = new Set(picked.map((d) => d.id));
  const more = f.docOrder.filter((id) => !shownIds.has(id)).map((id) => f.docs[id]).filter((d): d is FindDoc => !!d);
  const results = [...picked, ...more].slice(0, 40);
  const notIn = (onFile ?? []).filter((d) => !inPkg.has(d.id));
  const why = (d: FindDoc) => {
    const tags = [...new Set([...(d.tags ?? []), ...(d.rels ?? []).map((r) => r.label)])];
    return [tags.length ? `Has ${tags.slice(0, 4).join(", ")}${tags.length > 4 ? ` and ${tags.length - 4} more` : ""}` : "", d.hit ? `Page ${d.hit.page}: ${d.hit.text}` : ""].filter(Boolean);
  };

  const Row = ({ d, sub }: { d: FindDoc; sub: string[] }) => {
    const has = inPkg.has(d.id);
    return (
      <li className="flex items-start gap-3 py-2 border-t border-[var(--color-border)] first:border-t-0">
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium text-[var(--color-text)] break-words">{docName(d)}{d.rev ? <span className="font-normal text-[var(--color-text-muted)]"> · rev {d.rev}</span> : null}</div>
          {(d.folderName || sub.length > 0) && (
            <div className="text-caption text-[var(--color-text-muted)] grid">
              {d.folderName && <span className="truncate">In {d.folderName}</span>}
              {sub.map((s) => <span key={s} className="line-clamp-2">{s}</span>)}
            </div>
          )}
        </div>
        <Button variant="secondary" disabled={has || !!adding} loading={adding === d.id} onClick={() => void add([d], d.id)}>{has ? "In it" : "Add"}</Button>
      </li>
    );
  };

  return (
    <section ref={box} aria-label="Add from the app" className="rounded-lg border border-[var(--color-border-strong)] p-3 grid gap-3">
      {/* What's on file for the package's equipment, up front. */}
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Wrench aria-hidden className="w-4 h-4 text-[var(--color-text-muted)]" />
          <span className="text-body font-semibold text-[var(--color-text)]">
            {asset === undefined ? "Finding its equipment…" : asset ? `On file for ${assetWords(asset)}` : "Its equipment"}
          </span>
          {notIn.length > 1 && <Button variant="secondary" className="ml-auto" loading={adding === "all"} disabled={!!adding} onClick={() => void add(notIn, "all")}>Add all {notIn.length}</Button>}
        </div>
        {asset === null && <p className="text-body text-[var(--color-text-muted)]">{assetMissing ? `${assetMissing} isn't in the equipment registry, so nothing is on file for it. Search below; an admin can add it to the registry.` : "This work is on a whole unit, not one piece of equipment. Search below."}</p>}
        {asset && onFile === null && <p role="status" className="text-body text-[var(--color-text-muted)] inline-flex items-center gap-1.5"><Loader2 aria-hidden className="w-4 h-4 animate-spin" />Looking for its drawings…</p>}
        {asset && onFile && !onFile.length && <p className="text-body text-[var(--color-text-muted)]">Nothing is on file for {asset.tag} yet. Drop its drawings on the package and the app offers to file them to {asset.tag} for good.</p>}
        {asset && onFile && onFile.length > 0 && (
          <ul className="max-h-64 overflow-y-auto custom-scrollbar">{onFile.map((d) => <Row key={d.id} d={d} sub={why(d)} />)}</ul>
        )}
      </div>

      {/* The app's own search. */}
      <div className="grid gap-1.5">
        <label htmlFor="afa-q" className="text-body font-semibold text-[var(--color-text)]">Search everything</label>
        <div className="relative">
          <Search aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)] pointer-events-none" />
          <input id="afa-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="A tag, a document number, words on a drawing" className={`${fieldCls} pl-9`} autoComplete="off" />
        </div>
        {searching && (
          <>
            {(f.exact.length > 1 || (f.quick?.equipment.length ?? 0) > 0) && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-caption text-[var(--color-text-muted)]">Equipment</span>
                {(f.quick?.equipment ?? []).slice(0, 8).map((e) => (
                  <button key={e.id} type="button" aria-pressed={f.picked?.id === e.id} onClick={() => f.pick(f.picked?.id === e.id ? null : e.id)} className="ui-chip">
                    {equipLabel(e)}<span className="tabular-nums text-[var(--color-text-muted)]">{e.docIds.length}</span>
                  </button>
                ))}
              </div>
            )}
            {f.loading && !results.length ? <p role="status" className="text-body text-[var(--color-text-muted)] inline-flex items-center gap-1.5"><Loader2 aria-hidden className="w-4 h-4 animate-spin" />Searching…</p>
              : f.failed ? <p className="text-body text-[var(--state-overdue-text)]">The search didn&apos;t go through. Try again.</p>
              : !results.length && !f.deepLoading ? <p className="text-body text-[var(--color-text-muted)]">Nothing in the app matches that.</p>
              : (
                <ul className="max-h-80 overflow-y-auto custom-scrollbar">
                  {results.map((d) => <Row key={d.id} d={d} sub={why(d)} />)}
                  {f.deepLoading && <li role="status" className="py-2 text-caption text-[var(--color-text-muted)] inline-flex items-center gap-1.5"><Loader2 aria-hidden className="w-3.5 h-3.5 animate-spin" />Looking inside the drawings…</li>}
                </ul>
              )}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onDone}>Done</Button>
        <span className="text-caption text-[var(--color-text-muted)]">Files on your computer: drop them anywhere on the package.</span>
      </div>
    </section>
  );
}
