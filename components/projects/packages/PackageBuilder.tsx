"use client";

// PackageBuilder - one work order package, from draft to filed.
//
// The cover and the contents page are made for it (from the kit's own, or
// the app's clean ones) and always lead. Then the items in the order they're
// printed: kit forms, library drawings (always printed at their current
// revision), photos and files. Drag to reorder (or Move up / Move down), add
// from the kit, the library, a file or a phone scan; the contents page
// renumbers itself when it's printed.
//
// One main button, by where it stands: Approve → Print for the field →
// File it. Printing puts the package's own QR on the cover: crews check the
// drawings are current, and send signed forms back by scanning them. A
// signed form takes its blank's place. Filing writes the finished PDF to
// the project's network folder and keeps only the path.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Camera, Check, ClipboardCopy, FileImage, FileStack, FileText, FolderOpen, GripVertical, Library, Link2,
  MoveDown, MoveUp, Pencil, Plus, Printer, Trash2, Upload, X, Eye,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import MoreMenu, { type MoreItem } from "@/components/ui/MoreMenu";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { field as fieldCls, label as labelCls } from "@/components/admin/kit";
import { appConfirm } from "@/components/providers/DialogProvider";
import { sayError } from "@/components/projects/sayError";
import DocScanner from "@/components/scan/DocScanner";
import AddFromApp from "@/components/projects/packages/AddFromApp";
import FileToAsset, { type Filed } from "@/components/projects/packages/FileToAsset";
import { assetDocs, findPackageAsset, type PackageAsset } from "@/lib/equipmentFiles";
import type { FindDoc } from "@/lib/findEverywhere";
import { contentsPages } from "@/lib/packagePdf";
import { supabase } from "@/lib/supabase";
import { uploadToPath } from "@/lib/storage";
import {
  draftPackage, joinPath, kitItem, moveItem, newItemId, packageFilePath, packageStage, sayPackagesChanged,
  updatePackage, updatePackages, type PackageKit, type PkgItem, type ProjectPackages, type WoPackage,
} from "@/lib/woPackages";
import {
  buildPackagePdf, canWriteToFolder, deleteWorkingCopies, download, drawingPages, openPdf, packageCodes, packageUrl,
  pagesOf, projectFolder, rememberedFolderName, withDrawings, writeToFolder,
} from "@/lib/packageOps";
import type { ScopeWO } from "@/lib/woIntake";

/** Quick names for scanned pages that aren't a kit form. */
const SCAN_NAMES = ["Inspection photos", "Torque record", "Hydro test chart", "Punch list", "Material certs", "Field sketch"];
const KIND_WORD: Record<PkgItem["kind"], string> = { form: "Kit form", drawing: "Drawing", photo: "Photo", file: "File" };
const STATUS: Record<WoPackage["status"], { word: string; dot: string }> = {
  draft: { word: "Draft", dot: "bg-[var(--color-text-faint)]" },
  approved: { word: "Approved", dot: "bg-[var(--state-locked)]" },
  issued: { word: "Printed for the field", dot: "bg-[var(--state-held)]" },
  filed: { word: "Filed", dot: "bg-[var(--state-released)]" },
};
const when = (iso: string, tz?: string) => new Date(iso).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function PackageBuilder({
  orgId, projectId, projectName, workspace, logoUrl, tz, uid, actorEmail, canManage, group, kit, all, onClose, onMarkScope, onOpenKit,
}: {
  orgId: string; projectId: string; projectName: string; workspace: string; logoUrl?: string | null; tz?: string;
  /** The signed-in person (filing a file to the equipment makes a controlled document). */
  uid?: string | null;
  actorEmail?: string; canManage: boolean;
  /** The equipment's work orders (they share one package). */
  group: ScopeWO[];
  kit: PackageKit;
  all: ProjectPackages;
  onClose: () => void;
  /** Mark the group's work orders built (drafted) or approved on the scope. */
  onMarkScope: (what: "drafted" | "approved") => Promise<void>;
  onOpenKit: () => void;
}) {
  const key = group[0].wo;
  const pkg = all.packages[key];
  const [busy, setBusy] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState<null | "forms" | "app">(null);
  // The package's equipment in the registry, and what's on file for it.
  const [asset, setAsset] = useState<PackageAsset | null | undefined>(undefined);
  const [onFile, setOnFile] = useState<FindDoc[] | null>(null);
  const [suggestOff, setSuggestOff] = useState(false);
  // Files offered for filing to the equipment for good ("auto": it has nothing on file).
  const [offer, setOffer] = useState<{ ids: string[]; auto: boolean } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [scan, setScan] = useState<null | { for: "add" } | { for: "signed"; id: string; title: string }>(null);
  // A scan back from "Scan pages" whose code didn't say which form it is: asked.
  const [scanned, setScanned] = useState<null | { pdf: Uint8Array; pages: number; other?: string }>(null);
  const [scanName, setScanName] = useState("");
  const [filing, setFiling] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const signedIn = useRef<HTMLInputElement>(null);
  const signedFor = useRef<string | null>(null);

  // A package that isn't there yet is drafted from the kit as it opens:
  // the forms its equipment gets, ready to check.
  const drafting = useRef(false);
  useEffect(() => {
    if (pkg || drafting.current || !canManage) return;
    drafting.current = true;
    void (async () => {
      try {
        await updatePackages(orgId, projectId, (p) => (p.packages[key] ? p : { ...p, packages: { ...p.packages, [key]: draftPackage(group, kit) } }));
        await onMarkScope("drafted");
        sayPackagesChanged(projectId);
      } catch (e) { setError(sayError(e)); }
    })();
  }, [pkg, canManage, orgId, projectId, key, group, kit, onMarkScope]);

  // The package's own page (its QR), once it has been printed.
  useEffect(() => {
    if (!pkg || (pkg.status !== "issued" && pkg.status !== "approved")) return;
    let on = true;
    packageCodes(projectId, [key]).then((c) => { if (on) setCode(c[key] ?? null); }, () => undefined);
    return () => { on = false; };
  }, [pkg, projectId, key]);

  const change = useCallback(async (words: string, fn: (p: WoPackage) => WoPackage) => {
    setBusy(words); setError(null); setNote(null);
    try { await updatePackage(orgId, projectId, key, fn); sayPackagesChanged(projectId); }
    catch (e) { setError(sayError(e)); }
    finally { setBusy(null); }
  }, [orgId, projectId, key]);

  // Each drawing's page count, read once, so every item's page number is
  // known before printing.
  const counting = useRef(new Set<string>());
  useEffect(() => {
    if (!pkg || !canManage) return;
    for (const it of pkg.items) {
      if (it.kind !== "drawing" || !it.documentId || it.pages != null || counting.current.has(it.id)) continue;
      counting.current.add(it.id);
      void drawingPages(it.documentId).then((n) => {
        if (!n) return;
        void updatePackage(orgId, projectId, key, (p) => ({ ...p, items: p.items.map((x) => (x.id === it.id && x.pages == null ? { ...x, pages: n } : x)) }))
          .then(() => sayPackagesChanged(projectId), () => undefined);
      });
    }
  }, [pkg, canManage, orgId, projectId, key]);

  // What the app already knows about the package's equipment.
  const loadOnFile = useCallback(async (a: PackageAsset) => {
    try { setOnFile(await assetDocs(orgId, a.id)); } catch { setOnFile([]); }
  }, [orgId]);
  useEffect(() => {
    let on = true;
    void findPackageAsset(orgId, group).then((a) => { if (!on) return; setAsset(a); if (a) void loadOnFile(a); }, () => { if (on) setAsset(null); });
    return () => { on = false; };
  }, [orgId, group, loadOnFile]);

  if (!pkg) {
    return (
      <Sheet onClose={onClose} title={group.some((x) => /^\d/.test(x.wo)) ? `WO ${group.map((x) => x.wo).join(", ")}` : group[0].what} sub="Drafting the package from the kit…">
        {error && <ErrorNote title={error} />}
      </Sheet>
    );
  }

  const st = packageStage(pkg);
  const filed = pkg.status === "filed";
  const items = pkg.items;
  // Forms that come back signed, the blank ones first.
  const returnable = items.filter((i) => i.kind === "form" && !i.ref).sort((a, b) => Number(!!a.signed) - Number(!!b.signed));
  const kitForms = kit.forms.filter((f) => !items.some((i) => i.formId === f.id));
  // The contents as it prints: the page each item starts on, renumbered
  // whenever the order changes (cover 1, then the contents page, then the
  // items). Unknown only while a drawing's pages are still being counted.
  const formPages = new Map(kit.forms.map((f) => [f.id, f.pages]));
  const tocN = contentsPages(items.length, kit.toc ? (kit.toc.region?.h ?? 550) : null, !!kit.toc?.region?.cols);
  const starts: Array<number | null> = [];
  {
    let at: number | null = 2 + tocN;
    for (const it of items) {
      starts.push(at);
      const n = it.kind === "form" && it.formId ? formPages.get(it.formId) : it.kind === "photo" ? 1 : it.pages;
      at = at != null && n ? at + n : null;
    }
  }

  // ── Adding ──
  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy("Adding files"); setError(null);
    try {
      const added: PkgItem[] = [];
      for (const f of Array.from(files)) {
        const mime = f.type || (/\.pdf$/i.test(f.name) ? "application/pdf" : "");
        if (!/^(application\/pdf|image\/(jpeg|png))$/.test(mime)) { setError(`${f.name}: add a PDF, JPEG or PNG.`); continue; }
        const ext = mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : "jpg";
        const path = packageFilePath(orgId, projectId, key, ext);
        await uploadToPath(f, path, { contentType: mime });
        const pages = await pagesOf(new Uint8Array(await f.arrayBuffer()), mime);
        added.push({ id: newItemId(), kind: mime.startsWith("image/") ? "photo" : "file", title: f.name.replace(/\.[a-z0-9]+$/i, ""), path, mime, pages });
      }
      if (added.length) await updatePackage(orgId, projectId, key, (p) => ({ ...p, items: [...p.items, ...added] }));
      sayPackagesChanged(projectId);
      offerFiling(added.map((a) => a.id));
    } catch (e) { setError(sayError(e)); }
    finally { setBusy(null); }
  };
  // Equipment with nothing on file: the files just added are offered to it for good.
  const offerFiling = (ids: string[]) => {
    if (!ids.length || !asset || !canManage) return;
    if (onFile && onFile.length === 0) setOffer((o) => ({ ids: [...new Set([...(o?.ids ?? []), ...ids])], auto: true }));
  };
  const putSigned = async (id: string, title: string, bytes: Uint8Array, mime: string, via: "app" | "scan") => {
    setBusy(`Adding the signed ${title}`); setError(null);
    try {
      const ext = mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : "jpg";
      const path = packageFilePath(orgId, projectId, key, ext);
      await uploadToPath(new Blob([bytes as BlobPart], { type: mime }), path, { contentType: mime });
      const pages = await pagesOf(bytes, mime);
      let old: string | undefined;
      await updatePackage(orgId, projectId, key, (p) => ({ ...p, items: p.items.map((i) => { if (i.id !== id) return i; old = i.signed?.path; return { ...i, signed: { path, pages, at: new Date().toISOString(), by: actorEmail ?? "", via, mime } }; }) }));
      // The earlier signed copy: replaced, so deleted.
      if (old) void import("@/lib/storage").then((m) => m.deleteFile(old!)).catch(() => undefined);
      sayPackagesChanged(projectId);
      setNote(`The signed ${title} is in, in place of the blank.`);
    } catch (e) { setError(sayError(e)); }
    finally { setBusy(null); }
  };

  // ── The main button, by where it stands ──
  const build = async (opts: { withQr: boolean; signed: boolean }) => buildPackagePdf({
    orgId, projectId, projectName, workspace, logoUrl, pkg, kit, tz, who: { email: actorEmail }, ...opts, onStep: setStep,
  });
  const preview = async () => {
    setBusy("Putting the package together"); setError(null);
    try {
      const b = await build({ withQr: pkg.status !== "draft", signed: true });
      openPdf(b.pdf);
      if (b.problems.length) setError(`Left out: ${b.problems.join("; ")}`);
    } catch (e) { setError(sayError(e)); }
    finally { setBusy(null); setStep(null); }
  };
  const approve = async () => {
    await change("Approving", (p) => ({ ...p, status: "approved", approvedAt: new Date().toISOString(), approvedBy: actorEmail }));
    await onMarkScope("approved").catch(() => undefined);
  };
  const print = async () => {
    setBusy("Putting the package together"); setError(null);
    try {
      const b = await build({ withQr: true, signed: false });
      openPdf(b.pdf);
      await updatePackage(orgId, projectId, key, (p) => ({ ...p, items: withDrawings(p.items, b.drawings), status: p.status === "filed" ? p.status : "issued", issuedAt: new Date().toISOString(), issuedBy: actorEmail }));
      sayPackagesChanged(projectId);
      if (b.drawings.length) setNote(`${b.drawings.length} drawing${b.drawings.length === 1 ? " was" : "s were"} printed at a newer revision than when ${b.drawings.length === 1 ? "it was" : "they were"} added.`);
      if (b.problems.length) setError(`Left out: ${b.problems.join("; ")}`);
    } catch (e) { setError(sayError(e)); }
    finally { setBusy(null); setStep(null); }
  };

  const remove = async (it: PkgItem) => {
    if (!(await appConfirm({ title: `Take ${it.title} out of the package?`, message: it.signed ? "Its signed copy goes with it." : undefined, confirmLabel: `Take it out`, tone: "danger" }))) return;
    await change("Taking it out", (p) => ({ ...p, items: p.items.filter((i) => i.id !== it.id) }));
    const gone = [it.kind === "photo" || it.kind === "file" ? it.path : undefined, it.signed?.path].filter(Boolean) as string[];
    for (const g of gone) void import("@/lib/storage").then((m) => m.deleteFile(g)).catch(() => undefined);
  };
  const move = (from: number, to: number) => change("Moving", (p) => ({ ...p, items: moveItem(p.items, from, to) }));
  // Scanned pages that aren't a signed form: added under the name given.
  const addScan = async (sc: { pdf: Uint8Array; pages: number }, title: string) => {
    setBusy("Adding the scan"); setError(null);
    try {
      const path = packageFilePath(orgId, projectId, key, "pdf");
      await uploadToPath(new Blob([sc.pdf as BlobPart], { type: "application/pdf" }), path, { contentType: "application/pdf" });
      const id = newItemId();
      await updatePackage(orgId, projectId, key, (p) => ({ ...p, items: [...p.items, { id, kind: "file", title, path, mime: "application/pdf", pages: sc.pages }] }));
      sayPackagesChanged(projectId);
      setScanned(null); setNote(`${title} added.`);
      offerFiling([id]);
    } catch (e) { setError(sayError(e)); } finally { setBusy(null); }
  };

  // Documents from the app: in the package as drawings, at their current revision.
  const addFromApp = async (docs: FindDoc[]) => {
    const want = docs.filter((d) => !items.some((i) => i.documentId === d.id));
    if (!want.length) return;
    setError(null);
    try {
      const { data } = await supabase.from("documents").select("id, current_version_id").in("id", want.map((d) => d.id));
      const ver = new Map(((data ?? []) as Array<{ id: string; current_version_id: string | null }>).map((r) => [r.id, r.current_version_id]));
      const name = (d: FindDoc) => [d.number, d.title && d.title !== d.number ? d.title : ""].filter(Boolean).join(" ") || d.name || "Document";
      await change(want.length === 1 ? "Adding the drawing" : `Adding ${want.length} drawings`, (p) => ({ ...p, items: [...p.items, ...want.filter((d) => !p.items.some((i) => i.documentId === d.id)).map((d) => ({ id: newItemId(), kind: "drawing" as const, title: name(d), documentId: d.id, libraryId: d.libraryId, versionId: ver.get(d.id) ?? null, rev: d.rev }))] }));
    } catch (e) { setError(sayError(e)); }
  };
  // Filed to the equipment: each item becomes that controlled drawing.
  const onFiled = async (done: Filed[], words: string) => {
    await updatePackage(orgId, projectId, key, (p) => ({ ...p, items: p.items.map((it) => {
      const d = done.find((x) => x.itemId === it.id);
      return d ? { id: it.id, kind: "drawing" as const, title: d.title, documentId: d.documentId, libraryId: d.libraryId, versionId: d.versionId, rev: d.rev, pages: it.pages } : it;
    }) }));
    sayPackagesChanged(projectId);
    setOffer((o) => (o ? { ...o, ids: o.ids.filter((id) => !done.some((d) => d.itemId === id)) } : o));
    if (words && asset) setNote(done.length === 1
      ? `${done[0].title} is filed to ${asset.tag} in ${words}, and in this package as a controlled drawing.`
      : `${done.length} files are filed to ${asset.tag} in ${words}, and in this package as controlled drawings.`);
    if (asset) void loadOnFile(asset);
  };

  const primary = filed ? null
    : pkg.status === "draft" ? { label: "Approve", icon: Check, run: approve }
    : pkg.status === "approved" ? { label: "Print for the field", icon: Printer, run: print }
    : { label: "File it", icon: FolderOpen, run: async () => setFiling(true) };
  const title = pkg.wos.length ? `WO ${pkg.wos.join(", ")}` : pkg.equipment;

  return (
    <Sheet onClose={onClose} dismissable={!busy} dropping={dropping} onDragState={setDropping} onFiles={canManage && !filed ? (fs) => void addFiles(fs) : undefined} title={title} sub={<>{pkg.wos.length ? `${pkg.equipment} · ` : ""}<span className="inline-flex items-center gap-1.5"><span aria-hidden className={`w-2 h-2 rounded-full ${STATUS[pkg.status].dot}`} />{STATUS[pkg.status].word}</span>{st.forms ? <span className="tabular-nums"> · {st.signed} of {st.forms} forms signed back</span> : null}</>}
      footer={!canManage ? null : (
        <>
          {!filed && <Button variant="secondary" onClick={() => void preview()} disabled={!!busy}><Eye className="w-4 h-4" /> Preview</Button>}
          {pkg.status === "issued" && <Button variant="secondary" onClick={() => void print()} disabled={!!busy}><Printer className="w-4 h-4" /> Print again</Button>}
          <span className="ml-auto flex items-center gap-2">
            {busy && <span role="status" className="text-body text-[var(--color-text-muted)]">{step ?? busy}…</span>}
            {primary && <Button onClick={() => void primary.run()} loading={!!busy && busy !== "Moving"} disabled={!!busy || (pkg.status === "draft" && !items.length)}><primary.icon className="w-4 h-4" /> {primary.label}</Button>}
          </span>
        </>
      )}>
      {error && <ErrorNote title={error} />}
      {note && <p role="status" className="text-body text-[var(--color-text)] flex items-start gap-1.5"><Check aria-hidden className="w-4 h-4 mt-0.5 shrink-0 text-[var(--state-released)]" />{note}</p>}

      {/* What's on file for its equipment and not in the package yet: asked up front. */}
      {canManage && !filed && asset && !suggestOff && adding !== "app" && (() => {
        const missing = (onFile ?? []).filter((d) => !items.some((i) => i.documentId === d.id));
        if (!missing.length) return null;
        return (
          <div className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 flex-1 basis-64 text-body text-[var(--color-text)]">
              <b>{missing.length} document{missing.length === 1 ? "" : "s"} on file for {asset.tag}</b> {missing.length === 1 ? "isn't" : "aren't"} in the package: {missing.slice(0, 3).map((d) => d.number || d.title).filter(Boolean).join(", ")}{missing.length > 3 ? ` and ${missing.length - 3} more` : ""}.
            </p>
            <Button variant="secondary" onClick={() => void addFromApp(missing)} disabled={!!busy}>{missing.length === 1 ? "Add it" : `Add all ${missing.length}`}</Button>
            <Button variant="ghost" onClick={() => setAdding("app")}>Pick</Button>
            <Button variant="ghost" onClick={() => setSuggestOff(true)}>Not now</Button>
          </div>
        );
      })()}

      {/* Files just added, offered to the equipment for good. */}
      {canManage && asset && offer && offer.ids.some((id) => items.some((i) => i.id === id && i.path)) && (
        <FileToAsset orgId={orgId} asset={asset} uid={uid ?? null} actorEmail={actorEmail}
          items={items.filter((i) => offer.ids.includes(i.id) && i.path && (i.kind === "file" || i.kind === "photo"))}
          nothingOnFile={offer.auto} from={`${title} package, ${projectName}`}
          onFiled={onFiled} onCancel={() => setOffer(null)} />
      )}

      {/* A scan to place: a signed form swapped in, or something new, named. */}
      {scanned && (
        <section aria-label="What you scanned" className="rounded-lg border border-[var(--color-border-strong)] p-3 grid gap-2.5">
          <p className="text-body font-semibold text-[var(--color-text)]">What did you scan? <span className="font-normal text-[var(--color-text-muted)]">{scanned.pages} page{scanned.pages === 1 ? "" : "s"}</span></p>
          {scanned.other && <p className="text-body text-[var(--state-overdue-text)]">Its code is for another package (WO {scanned.other}). If it belongs there, scan it in that package.</p>}
          {returnable.length > 0 && (
            <div className="grid gap-1.5">
              {returnable.map((f) => (
                <Button key={f.id} variant="secondary" className="justify-start text-left" disabled={!!busy}
                  onClick={() => { const sc = scanned; setScanned(null); void putSigned(f.id, f.title, sc.pdf, "application/pdf", "scan"); }}>
                  The signed {f.title}{f.signed ? " (replaces the one in)" : ""}
                </Button>
              ))}
            </div>
          )}
          <form onSubmit={(e) => { e.preventDefault(); const t = scanName.trim(); if (t) void addScan(scanned, t); }} className="grid gap-2">
            <label htmlFor="pb-scan-name" className="text-body font-medium text-[var(--color-text)]">{returnable.length ? "Or something new, named" : "Name it"}</label>
            <div className="flex flex-wrap gap-1.5">
              {SCAN_NAMES.map((n) => <button key={n} type="button" aria-pressed={scanName === n} onClick={() => setScanName(n)} className="ui-chip">{n}</button>)}
            </div>
            <div className="flex flex-wrap gap-2">
              <input id="pb-scan-name" value={scanName} onChange={(e) => setScanName(e.target.value)} placeholder="e.g. Torque record" className={`${fieldCls} flex-1 min-w-40`} />
              <Button type="submit" variant="secondary" disabled={!scanName.trim() || !!busy}>Add it</Button>
            </div>
          </form>
          <Button variant="ghost" className="justify-self-start" onClick={() => void (async () => { if (await appConfirm({ title: "Throw this scan away?", message: "It isn't saved anywhere yet.", confirmLabel: "Throw it away", tone: "danger" })) setScanned(null); })()}>Throw it away</Button>
        </section>
      )}

      {filed && pkg.filed && (
        <div className="rounded-lg border border-[var(--color-border)] p-3 grid gap-1">
          <div className="text-body font-semibold text-[var(--color-text)]">Filed {when(pkg.filed.at, tz)}{pkg.filed.by ? ` by ${pkg.filed.by}` : ""}</div>
          <div className="flex items-center gap-2 min-w-0">
            <code className="min-w-0 flex-1 truncate text-body text-[var(--color-text)]" title={pkg.filed.path}>{pkg.filed.path}</code>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(pkg.filed!.path)} className="shrink-0 inline-flex items-center gap-1 h-9 pointer-coarse:h-11 px-2 rounded-md text-body font-medium text-[var(--color-accent-text)] hover:bg-[var(--color-surface-2)]"><ClipboardCopy aria-hidden className="w-4 h-4" />Copy path</button>
          </div>
          <div className="text-caption text-[var(--color-text-muted)]">{pkg.filed.pages} pages. {pkg.purgedAt ? "The working copies were deleted; the PDF on the drive is the record." : ""}{pkg.filed.how === "download" ? " Saved as a download to put in that folder." : ""}</div>
        </div>
      )}

      {/* Returns: the package's own page (its QR on the cover). */}
      {(pkg.status === "issued" || pkg.status === "approved") && code && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body">
          <Link2 aria-hidden className="w-4 h-4 text-[var(--color-text-muted)]" />
          <span className="text-[var(--color-text-muted)]">{pkg.status === "issued" ? "Crews send signed forms back from the QR on the cover, or this page:" : "Once printed, crews send signed forms back from the QR on the cover, or this page:"}</span>
          <a href={packageUrl(code)} target="_blank" rel="noreferrer" className="font-medium text-[var(--color-accent-text)] hover:underline">Open the package page</a>
          <button type="button" onClick={() => void navigator.clipboard?.writeText(packageUrl(code))} className="min-h-9 pointer-coarse:min-h-11 font-medium text-[var(--color-accent-text)] hover:underline">Copy the link</button>
        </div>
      )}

      {/* The contents, in print order. */}
      <ol aria-label="What's in the package" className="rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
        <Fixed icon={FileStack} title="Cover sheet" meta={`Page 1 · ${kit.cover ? `your cover, with the work order filled in${pkg.status !== "draft" ? " and the package's QR" : ""}` : "made for it, with your logo and the package's QR"}`} />
        <Fixed icon={FileText} title="Contents" meta={`Page${tocN > 1 ? `s 2 to ${1 + tocN}` : " 2"} · every item below and the page it starts on`} />
        {items.map((it, i) => {
          const menu: MoreItem[] = [
            ...(i > 0 ? [{ icon: <MoveUp aria-hidden className="w-4 h-4" />, label: "Move up", onClick: () => move(i, i - 1) }] : []),
            ...(i < items.length - 1 ? [{ icon: <MoveDown aria-hidden className="w-4 h-4" />, label: "Move down", onClick: () => move(i, i + 1) }] : []),
            { icon: <Pencil aria-hidden className="w-4 h-4" />, label: "Rename", onClick: () => setRenaming(it.id) },
            ...(it.kind === "form" && !it.ref ? [
              { icon: <Camera aria-hidden className="w-4 h-4" />, label: it.signed ? "Rescan the signed copy" : "Scan the signed copy", line: true, onClick: () => setScan({ for: "signed", id: it.id, title: it.title }) },
              { icon: <Upload aria-hidden className="w-4 h-4" />, label: "Upload the signed copy", onClick: () => { signedFor.current = it.id; signedIn.current?.click(); } },
              ...(it.signed ? [{ icon: <X aria-hidden className="w-4 h-4" />, label: "Back to the blank", onClick: () => void change("Putting the blank back", (p) => ({ ...p, items: p.items.map((x) => (x.id === it.id ? { ...x, signed: undefined } : x)) })) }] : []),
            ] : []),
            ...(asset && it.path && (it.kind === "file" || it.kind === "photo") ? [{ icon: <Library aria-hidden className="w-4 h-4" />, label: `File to ${asset.tag} for good`, line: true, onClick: () => setOffer({ ids: [it.id], auto: false }) }] : []),
            { icon: <Trash2 aria-hidden className="w-4 h-4" />, label: "Take it out", tone: "bad" as const, line: true, onClick: () => void remove(it) },
          ];
          const Icon = it.kind === "drawing" ? FileText : it.kind === "photo" ? FileImage : FileStack;
          return (
            <li key={it.id}
              draggable={canManage && !filed}
              onDragStart={() => setDrag(i)} onDragEnd={() => { setDrag(null); setOver(null); }}
              onDragOver={(e) => { if (drag === null) return; e.preventDefault(); setOver(i); }}
              onDrop={(e) => { e.preventDefault(); if (drag !== null && drag !== i) void move(drag, i); setDrag(null); setOver(null); }}
              className={`flex items-center gap-2.5 px-2.5 py-2 min-h-14 bg-[var(--color-surface)] ${drag === i ? "opacity-50" : ""} ${over === i && drag !== null && drag !== i ? "shadow-[inset_0_2px_0_var(--color-current)]" : ""}`}>
              {canManage && !filed && <GripVertical aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-text-faint)] cursor-grab pointer-coarse:hidden" />}
              <span className="w-6 shrink-0 text-center text-caption tabular-nums text-[var(--color-text-muted)]">{i + 1}</span>
              <Icon aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />
              <span className="min-w-0 flex-1">
                {renaming === it.id ? (
                  <form onSubmit={(e) => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get("t") ?? "").trim(); setRenaming(null); if (v && v !== it.title) void change("Renaming", (p) => ({ ...p, items: p.items.map((x) => (x.id === it.id ? { ...x, title: v } : x)) })); }}>
                    <input name="t" defaultValue={it.title} autoFocus onBlur={(e) => e.currentTarget.form?.requestSubmit()} className={fieldCls} aria-label="Name" />
                  </form>
                ) : (
                  <span className="block text-reading text-[var(--color-text)] truncate" title={it.title}>{it.title}</span>
                )}
                <span className="block text-caption text-[var(--color-text-muted)]">
                  {it.ref ? "Reference sheet, doesn't come back" : KIND_WORD[it.kind]}{it.kind === "drawing" && it.rev ? `, rev ${it.rev} when added (prints at the current one)` : ""}{it.pages ? ` · ${it.pages} page${it.pages === 1 ? "" : "s"}` : ""}{starts[i] != null ? ` · starts on page ${starts[i]}` : it.kind === "drawing" ? " · counting its pages" : ""}
                </span>
              </span>
              {it.kind === "form" && !it.ref && (
                <span className="shrink-0 inline-flex items-center gap-1.5 text-caption text-[var(--color-text-muted)]">
                  <span aria-hidden className={`w-2 h-2 rounded-full ${it.signed ? "bg-[var(--state-released)]" : "bg-[var(--color-text-faint)]"}`} />
                  {it.signed ? `Signed, ${when(it.signed.at, tz)}` : "Blank"}
                </span>
              )}
              {canManage && !filed && <MoreMenu items={menu} label={`${it.title}: more`} iconOnly triggerClass="shrink-0 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]" />}
            </li>
          );
        })}
        {!items.length && <li className="px-3 py-3 text-body text-[var(--color-text-muted)]">Nothing in it yet. {kit.forms.length ? "Add forms, drawings or files." : "The kit has no forms yet: add them once and every package gets the right ones."}</li>}
      </ol>

      {canManage && !filed && (
        <div className="flex flex-wrap items-center gap-2">
          <MoreMenu label="Add" items={[
            { icon: <FileStack aria-hidden className="w-4 h-4" />, label: kitForms.length ? `Forms from the kit (${kitForms.length})` : "Forms from the kit", onClick: () => setAdding("forms") },
            { icon: <FileText aria-hidden className="w-4 h-4" />, label: asset ? `From the app: ${asset.tag}'s drawings, or search` : "From the app: search drawings and documents", onClick: () => setAdding("app") },
            { icon: <Upload aria-hidden className="w-4 h-4" />, label: "Files from this computer", onClick: () => fileIn.current?.click() },
            { icon: <Camera aria-hidden className="w-4 h-4" />, label: "Scan pages", onClick: () => setScan({ for: "add" }) },
          ]} trigger={<span className="inline-flex items-center gap-1.5"><Plus aria-hidden className="w-4 h-4" />Add</span>} />
          <button type="button" onClick={onOpenKit} className="min-h-10 pointer-coarse:min-h-11 px-2 text-body font-medium text-[var(--color-accent-text)] hover:underline">The kit</button>
          <span className="text-caption text-[var(--color-text-muted)] hidden sm:inline">Drag to reorder; the contents page follows. Drop files from your computer anywhere here.</span>
        </div>
      )}
      <input ref={fileIn} type="file" multiple accept="application/pdf,image/jpeg,image/png" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
      <input ref={signedIn} type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => {
        const f = e.target.files?.[0]; e.target.value = ""; const id = signedFor.current; signedFor.current = null;
        const it = items.find((x) => x.id === id);
        if (f && it) void f.arrayBuffer().then((b) => putSigned(it.id, it.title, new Uint8Array(b), f.type || "application/pdf", "app"));
      }} />

      {adding === "forms" && (
        <AddForms kit={kit} inPkg={new Set(items.map((i) => i.formId).filter(Boolean) as string[])} onCancel={() => setAdding(null)} onOpenKit={onOpenKit}
          onAdd={(ids) => { setAdding(null); void change("Adding forms", (p) => ({ ...p, items: [...p.items, ...kit.forms.filter((f) => ids.includes(f.id)).map((f) => kitItem(f))] })); }} />
      )}
      {adding === "app" && (
        <AddFromApp orgId={orgId} asset={asset} assetMissing={group.find((x) => x.equipment)?.equipment ?? null} onFile={onFile}
          inPkg={new Set(items.map((i) => i.documentId).filter(Boolean) as string[])} onAdd={addFromApp} onDone={() => setAdding(null)} />
      )}

      {filing && (
        <FileIt orgId={orgId} projectId={projectId} pkg={pkg} folder={all.folder ?? ""} actorEmail={actorEmail}
          build={() => build({ withQr: false, signed: true })} onStep={setStep}
          onCancel={() => setFiling(false)} onDone={(words) => { setFiling(false); setNote(words); sayPackagesChanged(projectId); }} />
      )}

      {scan && (
        <DocScanner open title={scan.for === "add" ? "Scan pages to add" : `Scan the signed ${scan.title}`} mode={scan.for === "add" ? "color" : "bw"}
          onClose={() => setScan(null)}
          onDone={(out) => {
            const s = scan; setScan(null);
            if (s.for === "signed") { void putSigned(s.id, s.title, out.pdf, "application/pdf", "scan"); return; }
            // The code printed on a blank says which form it is: a blank
            // one is swapped in at once; anything else is asked.
            const m = out.qr ? /^pkgform:(.+):(it_[a-z0-9]+)$/.exec(out.qr) : null;
            const form = m && m[1] === key ? returnable.find((f) => f.id === m[2]) : undefined;
            if (form && !form.signed) {
              void putSigned(form.id, form.title, out.pdf, "application/pdf", "scan").then(() => setNote(`Its code says it's the ${form.title}: the signed copy is in.`));
              return;
            }
            setScanName("");
            setScanned({ pdf: out.pdf, pages: out.pages, ...(m && m[1] !== key ? { other: m[1] } : {}) });
          }} />
      )}
    </Sheet>
  );
}

/** The package's dialog: the app's one dialog shell (drawn over the whole
 *  page, Escape closes the top dialog only). */
function Sheet({ title, sub, footer, onClose, dismissable = true, onFiles, dropping, onDragState, children }: {
  title: React.ReactNode; sub?: React.ReactNode; footer?: React.ReactNode; onClose: () => void; dismissable?: boolean;
  /** Files dropped from the computer anywhere on the package. */
  onFiles?: (files: FileList) => void; dropping?: boolean; onDragState?: (on: boolean) => void;
  children: React.ReactNode;
}) {
  // Only files from outside count (rows dragged to reorder don't).
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  return (
    <Modal onClose={onClose} size="xl" dismissable={dismissable} labelledBy="pb-title">
      <div className="px-5 sm:px-6 pt-4 pb-3 border-b border-[var(--color-border)] flex items-start gap-3 shrink-0">
        <div className="flex-1 min-w-0">
          <div className="text-caption font-medium uppercase tracking-[0.08em] text-[var(--color-text-muted)]">Work package</div>
          <h2 id="pb-title" className="font-display text-section font-semibold text-[var(--color-text)] truncate">{title}</h2>
          {sub && <p className="mt-0.5 text-body text-[var(--color-text-muted)]">{sub}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
      </div>
      <div className="relative px-5 sm:px-6 py-4 grid gap-4 overflow-y-auto custom-scrollbar flex-1 min-h-0 content-start"
        onDragOver={onFiles ? (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (!dropping) onDragState?.(true); } : undefined}
        onDragLeave={onFiles ? (e) => { if (e.currentTarget.contains(e.relatedTarget as Node | null)) return; onDragState?.(false); } : undefined}
        onDrop={onFiles ? (e) => { if (!hasFiles(e)) return; e.preventDefault(); onDragState?.(false); if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files); } : undefined}>
        {children}
        {dropping && (
          <div aria-hidden className="pointer-events-none absolute inset-2 rounded-lg border-2 border-dashed border-[var(--color-current)] bg-[color-mix(in_srgb,var(--color-current)_8%,var(--color-surface))] grid place-items-center">
            <span className="text-reading font-semibold text-[var(--color-text)]">Drop to add to the package</span>
          </div>
        )}
      </div>
      {footer && <div className="px-5 sm:px-6 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] rounded-b-xl flex flex-wrap items-center gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0">{footer}</div>}
    </Modal>
  );
}

function Fixed({ icon: Icon, title, meta }: { icon: React.ComponentType<{ className?: string }>; title: string; meta: string }) {
  return (
    <li className="flex items-center gap-2.5 px-2.5 py-2 min-h-12 bg-[var(--color-surface-2)]">
      <span className="w-4 shrink-0 pointer-coarse:hidden" />
      <span className="w-6 shrink-0" />
      <Icon aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />
      <span className="min-w-0 flex-1">
        <span className="block text-reading text-[var(--color-text)]">{title}</span>
        <span className="block text-caption text-[var(--color-text-muted)]">{meta}</span>
      </span>
    </li>
  );
}

function AddForms({ kit, inPkg, onAdd, onCancel, onOpenKit }: { kit: PackageKit; inPkg: Set<string>; onAdd: (ids: string[]) => void; onCancel: () => void; onOpenKit: () => void }) {
  const [pick, setPick] = useState<Set<string>>(new Set());
  if (!kit.forms.length) {
    return (
      <div className="rounded-lg border border-[var(--color-border-strong)] p-3 grid gap-2">
        <p className="text-body text-[var(--color-text)]">The kit has no forms yet. Upload them once (flange log, hydro test, closure forms) and every package gets the right ones for its equipment.</p>
        <div className="flex gap-2"><Button variant="secondary" onClick={onOpenKit}>Open the kit</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-[var(--color-border-strong)] p-3 grid gap-2">
      <div className="text-body font-semibold text-[var(--color-text)]">Forms from the kit</div>
      <ul className="grid gap-0.5">
        {kit.forms.map((f) => {
          const has = inPkg.has(f.id);
          return (
            <li key={f.id}>
              <label className={`flex items-center gap-2.5 min-h-11 px-1 rounded-md ${has ? "opacity-60" : "cursor-pointer hover:bg-[var(--color-surface-2)]"}`}>
                <input type="checkbox" disabled={has} checked={has || pick.has(f.id)} onChange={(e) => setPick((p) => { const n = new Set(p); if (e.target.checked) n.add(f.id); else n.delete(f.id); return n; })} className="w-4 h-4" />
                <span className="min-w-0 flex-1 text-body text-[var(--color-text)]">{f.title}</span>
                <span className="text-caption text-[var(--color-text-muted)]">{has ? "In it" : f.for.length ? f.for.join(", ") : "Every package"}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={!pick.size} onClick={() => onAdd([...pick])}>{pick.size ? `Add ${pick.size}` : "Add"}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/** Filing: the finished PDF into the project's network folder; the app
 *  keeps the path, and the working copies are deleted. */
function FileIt({ orgId, projectId, pkg, folder, actorEmail, build, onStep, onCancel, onDone }: {
  orgId: string; projectId: string; pkg: WoPackage; folder: string; actorEmail?: string;
  build: () => Promise<{ pdf: Uint8Array; pages: number; fileName: string; problems: string[] }>;
  onStep: (s: string | null) => void; onCancel: () => void; onDone: (words: string) => void;
}) {
  const st = packageStage(pkg);
  const [path, setPath] = useState(folder);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<{ fileName: string; pages: number; bytes: number } | null>(null);
  const direct = canWriteToFolder();
  useEffect(() => { void rememberedFolderName(projectId).then(setPicked); }, [projectId]);
  const fileName = useMemo(() => `${pkg.wos.length ? `WO ${pkg.wos.join(", ")}` : "Package"} - ${pkg.equipment}.pdf`.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").slice(0, 150), [pkg]);

  const record = async (how: "folder" | "download", pages: number, bytes: number, name: string) => {
    const at = new Date().toISOString();
    const full = joinPath(path, name);
    await updatePackages(orgId, projectId, (all) => ({ ...all, folder: path.trim() || all.folder, packages: { ...all.packages, [pkg.key]: { ...all.packages[pkg.key], status: "filed", filed: { path: full, at, by: actorEmail ?? "", pages, bytes, how }, updatedAt: at } } }));
    const { deleted, failed } = await deleteWorkingCopies(pkg);
    await updatePackages(orgId, projectId, (all) => ({ ...all, packages: { ...all.packages, [pkg.key]: { ...all.packages[pkg.key], purgedAt: failed ? undefined : new Date().toISOString() } } }));
    onDone(`Filed to ${full}.${deleted ? ` ${deleted} working cop${deleted === 1 ? "y" : "ies"} deleted.` : ""}${failed ? ` ${failed} couldn't be deleted; they're kept.` : ""}`);
  };

  const saveDirect = async (pickNew: boolean) => {
    if (!path.trim()) { setErr("Type the folder's path first, so the app can keep it."); return; }
    setErr(null);
    // The folder first, while the click still counts (the browser asks).
    const dir = await projectFolder(projectId, { pickNew });
    if (!dir) { setErr("No folder picked. Pick the folder, or download it instead."); return; }
    setPicked(dir.name);
    setBusy(true);
    try {
      const b = await build();
      onStep("Saving it in the folder");
      await writeToFolder(dir, fileName, b.pdf);
      await record("folder", b.pages, b.pdf.byteLength, fileName);
    } catch (e) { setErr(sayError(e)); }
    finally { setBusy(false); onStep(null); }
  };
  const saveDownload = async () => {
    if (!path.trim()) { setErr("Type the folder's path first, so the app can keep it."); return; }
    setErr(null); setBusy(true);
    try {
      const b = await build();
      download(b.pdf, fileName);
      setDownloaded({ fileName, pages: b.pages, bytes: b.pdf.byteLength });
    } catch (e) { setErr(sayError(e)); }
    finally { setBusy(false); onStep(null); }
  };

  return (
    <div className="rounded-lg border border-[var(--color-border-strong)] p-3 grid gap-3">
      <div>
        <div className="text-reading font-semibold text-[var(--color-text)]">File it to the network drive</div>
        <p className="text-body text-[var(--color-text-muted)]">The finished PDF ({st.signed} of {st.forms} forms signed{st.signed < st.forms ? "; blanks print where the rest are missing" : ""}). The app keeps only its path and deletes its working copies.</p>
      </div>
      <div>
        <label htmlFor="pb-folder" className={labelCls}>Network folder</label>
        <input id="pb-folder" value={path} onChange={(e) => setPath(e.target.value)} placeholder="e.g. \\kern-fs01\TAR\2027 Crude\Packages" className={fieldCls} spellCheck={false} />
        <p className="mt-1 text-caption text-[var(--color-text-muted)]">Saved as <code>{joinPath(path || "…", fileName)}</code></p>
      </div>
      {err && <ErrorNote title={err} />}
      {downloaded ? (
        <div className="grid gap-2">
          <p className="text-body text-[var(--color-text)]">It downloaded as <b>{downloaded.fileName}</b>. Move it into that folder, then confirm.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={async () => {
              if (!(await appConfirm({ title: "Delete the working copies?", message: `Only once ${downloaded.fileName} is in ${path}. The app then keeps just its path.`, confirmLabel: "It's in the folder: delete them", tone: "danger" }))) return;
              setBusy(true);
              try { await record("download", downloaded.pages, downloaded.bytes, downloaded.fileName); } catch (e) { setErr(sayError(e)); } finally { setBusy(false); }
            }} loading={busy}>It&apos;s in the folder</Button>
            <Button variant="ghost" onClick={onCancel} disabled={busy}>Not yet</Button>
          </div>
        </div>
      ) : direct ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void saveDirect(false)} loading={busy}><FolderOpen className="w-4 h-4" /> {picked ? `Save in "${picked}"` : "Pick the folder and save"}</Button>
          {picked && <Button variant="secondary" onClick={() => void saveDirect(true)} disabled={busy}>Pick another folder</Button>}
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <p className="basis-full text-caption text-[var(--color-text-muted)]">Pick the same folder as the path above (a mapped drive works). This computer remembers it.</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void saveDownload()} loading={busy}><FolderOpen className="w-4 h-4" /> Download it to save there</Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <p className="basis-full text-caption text-[var(--color-text-muted)]">This browser can&apos;t write into a folder directly (Chrome and Edge can).</p>
        </div>
      )}
    </div>
  );
}
