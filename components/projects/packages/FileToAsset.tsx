"use client";

// FileToAsset - files added to a work package, filed to its equipment for
// good: each becomes a controlled document in the workspace's place for
// equipment files (the unit's folder when there is one), tagged to the
// equipment, and the package item becomes that drawing (printed at its
// current revision from then on). Offered on its own when the equipment has
// nothing on file yet, so the system builds itself out while the work gets
// done; any file can be filed from its ⋯ menu. The place is asked once for
// the workspace (a library named for drawings or equipment is suggested).

import React, { useEffect, useState } from "react";
import { Check, Library } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { field as fieldCls } from "@/components/admin/kit";
import { sayError } from "@/components/projects/sayError";
import { deleteFile } from "@/lib/storage";
import { fetchStored } from "@/lib/packageOps";
import {
  assetWords, existingDoc, fileToAsset, folderFor, hasTree, listLibraries, loadEquipmentPlace, numberFromName, saveEquipmentPlace, suggestLibrary,
  type EquipmentFilesPlace, type LibraryLite, type PackageAsset,
} from "@/lib/equipmentFiles";
import type { PkgItem } from "@/lib/woPackages";

export interface Filed { itemId: string; documentId: string; libraryId: string; versionId: string | null; rev: string | null; title: string; deletePath?: string }

export default function FileToAsset({ orgId, projectId, asset, items, nothingOnFile, from, uid, actorEmail, onFiled, onCancel }: {
  orgId: string; projectId?: string; asset: PackageAsset;
  /** The package's files and photos to offer. */
  items: PkgItem[];
  /** The equipment has nothing on file: said up front. */
  nothingOnFile: boolean;
  /** What they're filed from ("WO 300939 package"). */
  from: string;
  uid: string | null; actorEmail?: string;
  onFiled: (done: Filed[], words: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [place, setPlace] = useState<EquipmentFilesPlace | null | undefined>(undefined);
  const [libs, setLibs] = useState<LibraryLite[]>([]);
  const [lib, setLib] = useState("");
  const [changing, setChanging] = useState(false);
  // No Equipment Files library yet: filed to a library picked for now.
  const [forNow, setForNow] = useState(false);
  const [where, setWhere] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, { on: boolean; number: string }>>(() =>
    Object.fromEntries(items.map((it) => [it.id, { on: it.kind === "file" || it.mime === "application/pdf", number: numberFromName(it.title) }])));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [taken, setTaken] = useState<Record<string, { id: string; libraryId: string; currentVersionId: string | null; rev: string | null }>>({});

  useEffect(() => {
    let on = true;
    void Promise.all([loadEquipmentPlace(orgId).catch(() => null), listLibraries(orgId).catch(() => [])]).then(([p, ls]) => {
      if (!on) return;
      setLibs(ls); setPlace(p);
      setLib(p?.libraryId ?? suggestLibrary(ls)?.id ?? ls[0]?.id ?? "");
    });
    return () => { on = false; };
  }, [orgId]);
  // Where they'd land, in words.
  const libId = !place || changing ? lib : place.libraryId;
  useEffect(() => {
    if (!libId) { setWhere(null); return; }
    let on = true;
    const p: EquipmentFilesPlace = place && !changing ? place : { libraryId: libId, collectionId: null };
    // Equipment new since the push gets its folder when it's filed: said, not made yet.
    if (hasTree(p) && !p.assets?.[asset.id]) { setWhere(`${p.libraryName ?? "Equipment Files"} › a new folder for ${asset.tag}`); return; }
    void folderFor(orgId, p, asset).then((w) => { if (on) setWhere(w.words); }, () => { if (on) setWhere(null); });
    return () => { on = false; };
  }, [orgId, libId, place, changing, asset]);

  const chosen = items.filter((it) => pick[it.id]?.on);
  const asking = place === null || changing;
  // Equipment Files isn't set up (and nobody picked a library for now): that comes first.
  const setUpFirst = place === null && !forNow;

  const go = async () => {
    if (!uid) { setErr("Sign in again to file documents."); return; }
    if (!libId) { setErr("Pick the library equipment files go in."); return; }
    setErr(null); setBusy("Filing");
    const p: EquipmentFilesPlace = asking ? { libraryId: libId, collectionId: null } : place!;
    try {
      if (asking) { await saveEquipmentPlace(orgId, p); setPlace(p); setChanging(false); }
      const done: Filed[] = [];
      const clash: typeof taken = {};
      let words = where ?? "";
      for (const [i, it] of chosen.entries()) {
        const number = (pick[it.id]?.number ?? "").trim();
        if (!number) { setErr(`Give ${it.title} a number.`); continue; }
        if (!it.path) continue;
        setBusy(`Filing ${i + 1} of ${chosen.length}`);
        const there = await existingDoc(orgId, number);
        if (there) { clash[it.id] = there; continue; }
        const bytes = await fetchStored(it.path);
        const file = new File([bytes as BlobPart], `${number}.${it.mime === "image/png" ? "png" : it.mime === "image/jpeg" ? "jpg" : "pdf"}`, { type: it.mime || "application/pdf" });
        const r = await fileToAsset({ orgId, place: p, asset, file, number, title: number, from, projectId, actorUserId: uid, actorEmail });
        words = r.words;
        done.push({ itemId: it.id, documentId: r.documentId, libraryId: r.libraryId, versionId: r.versionId, rev: "0", title: number, deletePath: it.path });
      }
      setTaken(clash);
      if (done.length) {
        await onFiled(done, words);
        for (const d of done) if (d.deletePath) void deleteFile(d.deletePath).catch(() => undefined);
      }
    } catch (e) { setErr(sayError(e)); } finally { setBusy(null); }
  };
  // A file whose number is already in document control: use that document.
  const takeExisting = async (it: PkgItem) => {
    const t = taken[it.id];
    if (!t) return;
    setBusy("Adding"); setErr(null);
    try {
      await onFiled([{ itemId: it.id, documentId: t.id, libraryId: t.libraryId, versionId: t.currentVersionId, rev: t.rev, title: pick[it.id]?.number || it.title, deletePath: it.path }], "");
      if (it.path) void deleteFile(it.path).catch(() => undefined);
      setTaken((x) => { const n = { ...x }; delete n[it.id]; return n; });
    } catch (e) { setErr(sayError(e)); } finally { setBusy(null); }
  };

  return (
    <section aria-label={`File to ${asset.tag}`} className="rounded-lg border border-[var(--color-border-strong)] p-3 grid gap-3">
      <div>
        <h3 className="text-body font-semibold text-[var(--color-text)]">{nothingOnFile ? `${asset.tag} has no drawings on file yet. File these to it for good?` : `File to ${assetWords(asset)} for good?`}</h3>
        <p className="text-body text-[var(--color-text-muted)]">They become controlled documents{where && !setUpFirst ? ` in ${where}` : ""}, tagged to {asset.tag}. Anyone looking at {asset.tag}, the library and the next package find them, at their current revision.</p>
      </div>

      {place === undefined ? <p role="status" className="text-body text-[var(--color-text-muted)]">Checking where equipment files go…</p>
        : setUpFirst ? (
          <div className="rounded-lg bg-[var(--color-surface-2)] p-3 grid gap-2">
            <p className="text-body text-[var(--color-text)]"><b>Equipment files don&apos;t have their library yet.</b> Make it once in Operating areas: a library laid out like your units, equipment types and equipment, so this lands in {asset.tag}&apos;s own folder and shows on {asset.tag}&apos;s page. Then come back and file it.</p>
            <div className="flex flex-wrap items-center gap-2">
              <a href="/admin/assets?equipmentFiles=1" className="inline-flex items-center min-h-10 pointer-coarse:min-h-11 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">Set it up in Operating areas</a>
              <button type="button" onClick={() => setForNow(true)} className="min-h-9 pointer-coarse:min-h-11 text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Or file it to a library for now</button>
            </div>
          </div>
        ) : asking ? (
          <div className="grid gap-1.5">
            <label htmlFor="fta-lib" className="text-body font-medium text-[var(--color-text)]">Where equipment files go <span className="font-normal text-[var(--color-text-muted)]">(set once for the workspace)</span></label>
            {libs.length ? (
              <select id="fta-lib" value={lib} onChange={(e) => setLib(e.target.value)} className={fieldCls}>
                {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            ) : <p className="text-body text-[var(--state-held-text)]">Document control has no library yet. An admin makes one (a &ldquo;Drawings&rdquo; library works), then files can go there.</p>}
            <p className="text-caption text-[var(--color-text-muted)]">Each file goes in its unit&apos;s folder when the library has one. The equipment registry lists them; it doesn&apos;t keep a second copy. The Equipment Files library (Operating areas) gives each piece of equipment its own folder.</p>
          </div>
        ) : (
          <p className="text-body text-[var(--color-text)] inline-flex flex-wrap items-center gap-x-2"><Library aria-hidden className="w-4 h-4 text-[var(--color-text-muted)]" />Goes to {where ?? "…"}
            <button type="button" onClick={() => setChanging(true)} className="min-h-9 pointer-coarse:min-h-11 text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Change</button></p>
        )}

      <ul className="grid gap-2">
        {items.map((it) => {
          const p = pick[it.id] ?? { on: false, number: it.title };
          const t = taken[it.id];
          return (
            <li key={it.id} className="grid gap-1.5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center gap-x-3">
              <label className="flex items-center gap-2 min-h-11 cursor-pointer">
                <input type="checkbox" checked={p.on} onChange={(e) => setPick((x) => ({ ...x, [it.id]: { ...p, on: e.target.checked } }))} className="w-4 h-4" />
                <span className="text-body text-[var(--color-text)]">{it.title}<span className="text-caption text-[var(--color-text-muted)]"> · {it.kind === "photo" ? "photo" : `${it.pages ?? 1} page${(it.pages ?? 1) === 1 ? "" : "s"}`}</span></span>
              </label>
              {p.on && (
                <label className="grid gap-0.5 text-caption text-[var(--color-text-muted)]">Document number
                  <input value={p.number} onChange={(e) => setPick((x) => ({ ...x, [it.id]: { ...p, number: e.target.value } }))} className={fieldCls} />
                </label>
              )}
              {t && (
                <p className="sm:col-span-2 text-body text-[var(--state-held-text)]">{p.number} is already in document control.{" "}
                  <button type="button" onClick={() => void takeExisting(it)} className="font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Use that one in the package</button> or give this a new number.</p>
              )}
            </li>
          );
        })}
      </ul>

      {err && <p className="text-body font-medium text-[var(--state-overdue-text)]">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => void go()} loading={!!busy} disabled={!chosen.length || !libId || place === undefined || setUpFirst}><Check className="w-4 h-4" /> {busy && busy !== "Filing" ? busy : `File ${chosen.length || ""} to ${asset.tag}`.replace("  ", " ")}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={!!busy}>Not now</Button>
      </div>
    </section>
  );
}
