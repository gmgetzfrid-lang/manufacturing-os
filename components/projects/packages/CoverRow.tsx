"use client";

// CoverRow - the cover sheet in the package's list: what it's printed on
// (the project's letterhead, the kit's own cover, or the logo cover) and up
// to two photos on it. One photo fills the space under the job; two sit side
// by side. A photo on the cover doesn't print again as a page of its own, so
// the package is shorter. Photos come from the package, the equipment's own
// photos in the registry, or a new upload.

import React, { useEffect, useRef, useState } from "react";
import { Check, FileStack, ImagePlus, Upload, X } from "lucide-react";
import SignedImg from "@/components/assets/SignedImg";
import { listAssetPhotos, type AssetPhoto } from "@/lib/assets";
import { uploadToPath } from "@/lib/storage";
import { COVER_PHOTOS, coverPhotos, newItemId, packageFilePath, type PackageKit, type PkgItem, type WoPackage } from "@/lib/woPackages";
import type { PackageAsset } from "@/lib/equipmentFiles";
import type { Letterhead } from "@/lib/letterhead";

const link = "min-h-9 pointer-coarse:min-h-11 inline-flex items-center gap-1.5 text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2";

export default function CoverRow({ orgId, projectId, pkgKey, items, kit, asset, letterhead, letterheadFrom, withQr, canEdit, change }: {
  orgId: string; projectId: string; pkgKey: string; items: PkgItem[]; kit: PackageKit;
  asset: PackageAsset | null | undefined;
  /** The project's letterhead (undefined while it's read). */
  letterhead: Letterhead | null | undefined;
  /** The project it was saved on, when it's the workspace's (this project has none of its own). */
  letterheadFrom?: string | null;
  withQr: boolean; canEdit: boolean;
  change: (words: string, fn: (p: WoPackage) => WoPackage) => Promise<void>;
}) {
  const on = coverPhotos(items);
  const full = on.length >= COVER_PHOTOS;
  const [picking, setPicking] = useState(false);
  const [theirs, setTheirs] = useState<AssetPhoto[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);
  // The equipment's own photos, once the picker opens.
  useEffect(() => {
    if (!picking || !asset || theirs) return;
    let live = true;
    void listAssetPhotos(asset.id).then((p) => { if (live) setTheirs(p.filter((x) => x.status !== "superseded" && /^image\/(jpeg|png)$/.test(x.content_type ?? "image/jpeg"))); }, () => { if (live) setTheirs([]); });
    return () => { live = false; };
  }, [picking, asset, theirs]);
  useEffect(() => { if (full) setPicking(false); }, [full]);

  const own = !kit.cover;
  const what = kit.cover
    ? `your kit's cover, with the work order filled in${withQr ? " and the package's QR" : ""}`
    : letterhead ? `on the ${letterheadFrom ? "company" : "project's"} letterhead, with the job${withQr ? ", the package's QR" : ""}${on.length ? ` and ${on.length === 1 ? "a photo" : "two photos"}` : ""}`
      : `made for it, with your logo${withQr ? " and the package's QR" : ""}${on.length ? ` and ${on.length === 1 ? "a photo" : "two photos"}` : ""}`;
  const pkgPhotos = items.filter((i) => i.kind === "photo" && !i.cover && i.path);

  const putOn = (it: PkgItem) => change("Putting it on the cover", (p) => ({ ...p, items: p.items.map((x) => (x.id === it.id ? { ...x, cover: true } : x)) }));
  const takeOff = (it: PkgItem) => change("Taking it off the cover", (p) => ({
    ...p,
    // A registry photo was only borrowed: it leaves the package. One of the package's own goes back to a page.
    items: it.shared ? p.items.filter((x) => x.id !== it.id) : p.items.map((x) => (x.id === it.id ? { ...x, cover: false } : x)),
  }));
  const borrow = (ph: AssetPhoto) => change("Putting it on the cover", (p) => ({
    ...p, items: [...p.items, { id: newItemId(), kind: "photo", title: ph.caption?.trim() || `${asset?.tag ?? "Equipment"} photo`, path: ph.file_url, mime: ph.content_type ?? "image/jpeg", pages: 1, cover: true, shared: true }],
  }));
  const upload = async (f: File | undefined) => {
    if (!f) return;
    const mime = f.type;
    if (!/^image\/(jpeg|png)$/.test(mime)) { setErr(`${f.name}: add a JPEG or PNG photo.`); return; }
    setErr(null); setBusy(true);
    try {
      const path = packageFilePath(orgId, projectId, pkgKey, mime === "image/png" ? "png" : "jpg");
      await uploadToPath(f, path, { contentType: mime });
      await change("Putting it on the cover", (p) => ({ ...p, items: [...p.items, { id: newItemId(), kind: "photo", title: f.name.replace(/\.[a-z0-9]+$/i, ""), path, mime, pages: 1, cover: true }] }));
    } catch (e) { setErr(e instanceof Error ? e.message : "The photo didn't upload."); }
    finally { setBusy(false); }
  };
  const borrowed = new Set(items.filter((i) => i.shared).map((i) => i.path));
  const Thumb = ({ path, alt }: { path: string; alt: string }) => (
    <SignedImg path={path} alt={alt} className="w-full h-full object-cover" placeholder={<span className="text-caption text-[var(--color-text-muted)]">Photo</span>} />
  );

  return (
    <li className="px-2.5 py-2 bg-[var(--color-surface-2)] grid gap-2">
      <div className="flex items-center gap-2.5 min-h-8">
        <span className="w-4 shrink-0 pointer-coarse:hidden" />
        <span className="w-6 shrink-0" />
        <FileStack aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />
        <span className="min-w-0 flex-1">
          <span className="block text-reading text-[var(--color-text)]">Cover sheet</span>
          <span className="block text-caption text-[var(--color-text-muted)]">Page 1 · {what}</span>
        </span>
      </div>

      {own && (on.length > 0 || canEdit) && (
        <div className="pl-[calc(1rem+1.5rem+1rem+1.875rem)] max-sm:pl-0 grid gap-2">
          {on.length > 0 && (
            <ul aria-label="Photos on the cover" className="flex flex-wrap gap-2">
              {on.map((it) => (
                <li key={it.id} className="w-36 grid gap-1">
                  <div className="relative h-24 rounded-md overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface)]">
                    {it.path && <Thumb path={it.path} alt={it.title} />}
                    {canEdit && (
                      <button type="button" onClick={() => void takeOff(it)} aria-label={`Take ${it.title} off the cover`}
                        className="absolute top-1 right-1 w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-md bg-[var(--color-surface)]/90 text-[var(--color-text)] hover:bg-[var(--color-surface)]">
                        <X aria-hidden className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  <span className="text-caption text-[var(--color-text-muted)] truncate" title={it.title}>{it.title}</span>
                </li>
              ))}
            </ul>
          )}
          {canEdit && !full && !picking && (
            <button type="button" onClick={() => setPicking(true)} className={`${link} justify-self-start`}>
              <ImagePlus aria-hidden className="w-4 h-4" />{on.length ? "Add a second photo" : "Add a photo to the cover"}
            </button>
          )}
          {canEdit && full && <p className="text-caption text-[var(--color-text-muted)]">Two photos fill the cover. Take one off to swap it.</p>}
          {picking && !full && (
            <div className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-3 grid gap-3">
              <p className="text-body text-[var(--color-text-muted)]">{on.length ? "A second photo sits beside the first." : "One photo fills the space under the job; a second sits beside it."} A photo on the cover isn&apos;t printed again as its own page.</p>
              {pkgPhotos.length > 0 && (
                <div className="grid gap-1.5">
                  <span className="text-body font-medium text-[var(--color-text)]">In this package</span>
                  <div className="flex flex-wrap gap-2">
                    {pkgPhotos.map((it) => (
                      <button key={it.id} type="button" onClick={() => void putOn(it)} className="w-28 grid gap-1 text-left rounded-md hover:bg-[var(--color-surface-2)] p-1" aria-label={`Put ${it.title} on the cover`}>
                        <span className="block h-20 rounded-md overflow-hidden border border-[var(--color-border)]"><Thumb path={it.path!} alt="" /></span>
                        <span className="text-caption text-[var(--color-text)] truncate">{it.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {asset && (
                <div className="grid gap-1.5">
                  <span className="text-body font-medium text-[var(--color-text)]">{asset.tag}&apos;s photos</span>
                  {theirs === null ? <span role="status" className="text-body text-[var(--color-text-muted)]">Looking…</span>
                    : !theirs.length ? <span className="text-body text-[var(--color-text-muted)]">None on file for {asset.tag} yet.</span>
                    : (
                      <div className="flex flex-wrap gap-2">
                        {theirs.slice(0, 12).map((ph) => {
                          const used = borrowed.has(ph.file_url);
                          return (
                            <button key={ph.id} type="button" disabled={used} onClick={() => void borrow(ph)} className="w-28 grid gap-1 text-left rounded-md hover:bg-[var(--color-surface-2)] p-1 disabled:opacity-60" aria-label={used ? `${ph.caption || "This photo"} is on the cover` : `Put ${ph.caption || "this photo"} on the cover`}>
                              <span className="relative block h-20 rounded-md overflow-hidden border border-[var(--color-border)]">
                                <Thumb path={ph.file_url} alt="" />
                                {used && <Check aria-hidden className="absolute top-1 right-1 w-4 h-4 text-[var(--state-released)]" />}
                              </span>
                              <span className="text-caption text-[var(--color-text)] truncate">{ph.caption || "Photo"}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => fileIn.current?.click()} disabled={busy} className={link}><Upload aria-hidden className="w-4 h-4" />{busy ? "Uploading…" : "Upload a photo"}</button>
                <button type="button" onClick={() => setPicking(false)} className="min-h-9 pointer-coarse:min-h-11 text-body text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Done</button>
              </div>
              {err && <p role="alert" className="text-body text-[var(--state-overdue-text)]">{err}</p>}
              <input ref={fileIn} type="file" accept="image/jpeg,image/png" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
            </div>
          )}
          {letterhead && letterheadFrom && <p className="text-caption text-[var(--color-text-muted)]">The letterhead saved on {letterheadFrom} ({letterhead.name}). Give this project its own in the schedule setup&apos;s Printed reports to use another.</p>}
          {letterhead === null && <p className="text-caption text-[var(--color-text-muted)]">No letterhead in this workspace yet: add it in a project&apos;s schedule setup, Printed reports, and every cover is printed on it.</p>}
        </div>
      )}
      {kit.cover && items.some((i) => i.cover) && <p className="pl-[calc(1rem+1.5rem+1rem+1.875rem)] max-sm:pl-0 text-caption text-[var(--color-text-muted)]">The kit has its own cover sheet, so photos print on their own pages.</p>}
    </li>
  );
}
