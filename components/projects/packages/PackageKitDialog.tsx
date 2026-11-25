"use client";

// PackageKitDialog - the workspace's package kit, set up once for every
// project: the sheets every work order package is printed with. Every
// sheet comes in the same way: pick it (a PDF, or a photo of a page), say
// what it is (a cover, the contents page, a form that comes back signed,
// or a reference sheet), and the app reads the labels on it, off a scan
// too, and suggests what to fill in; the owner keeps, changes or drops
// each fill, or prints the sheet blank (SheetSetup). With no cover or
// contents page of its own, the app draws clean ones with the logo. Forms
// say which equipment gets them ("Exchanger", "Vessel"; none: every one).

import React, { useMemo, useRef, useState } from "react";
import { Check, FileStack, FileText, Plus, Trash2, X } from "lucide-react";
import { PDFDocument } from "pdf-lib";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { appConfirm } from "@/components/providers/DialogProvider";
import { sayError } from "@/components/projects/sayError";
import SheetSetup, { type SheetResult } from "@/components/projects/packages/SheetSetup";
import { uploadToPath, deleteFile } from "@/lib/storage";
import { EQUIPMENT_WORDS, kitPath, updateKit, type KitForm, type PackageKit } from "@/lib/woPackages";
import { FILL_WORDS, type FillKey } from "@/lib/formLabels";
import type { FieldPlacement } from "@/lib/packagePdf";

type Added = { path: string; name: string; pages: number; size: number };

/** A sheet as a PDF: a PDF as it is; a photo of a page as a one-page PDF
 *  the size of a letter page (it prints and fills like any other). */
async function asPdf(file: File): Promise<{ bytes: Uint8Array; pages: number; name: string }> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const isPng = file.type === "image/png" || /\.png$/i.test(file.name);
  const isJpg = file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name);
  if (isPng || isJpg) {
    const doc = await PDFDocument.create();
    const img = isPng ? await doc.embedPng(raw) : await doc.embedJpg(raw);
    const land = img.width > img.height;
    const [W, H] = land ? [792, 612] : [612, 792];
    const s = Math.min((W - 36) / img.width, (H - 36) / img.height);
    doc.addPage([W, H]).drawImage(img, { x: (W - img.width * s) / 2, y: (H - img.height * s) / 2, width: img.width * s, height: img.height * s });
    return { bytes: await doc.save(), pages: 1, name: file.name.replace(/\.(png|jpe?g)$/i, ".pdf") };
  }
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(raw, { ignoreEncryption: true }); } catch { throw new Error(`${file.name} isn't a PDF or a photo that can be read.`); }
  return { bytes: raw, pages: doc.getPageCount(), name: file.name };
}

/** What a sheet's fills come to, in words. */
function fillsSay(fields: FieldPlacement[] | undefined): string {
  if (fields === undefined) return "Prints blank until it's set up";
  if (!fields.length) return "Prints blank, filled in by hand";
  const keys = [...new Set(fields.map((f) => f.key))] as FillKey[];
  return `Fills in ${keys.map((k) => FILL_WORDS[k].toLowerCase()).join(", ")}`;
}

const guessFor = (title: string) => EQUIPMENT_WORDS.filter((w) => new RegExp(`\\b${w.replace(/ /g, "\\s*")}`, "i").test(title));

export default function PackageKitDialog({ orgId, kit, actorEmail, workspace, projectName, onClose, onSaved }: {
  orgId: string; kit: PackageKit; actorEmail?: string; workspace?: string; projectName?: string;
  onClose: () => void; onSaved: (k: PackageKit) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Sheets just added, set up one after another.
  const [queue, setQueue] = useState<Added[]>([]);
  const [queueOf, setQueueOf] = useState(0);
  const [editing, setEditing] = useState<null | { what: "cover" } | { what: "toc" } | { what: "form"; id: string }>(null);
  const sheetIn = useRef<HTMLInputElement>(null);

  const samples: Record<FillKey, string> = useMemo(() => ({
    wo: "400101, 400102", equipment: "E-101 Overhead Exchanger", description: "Pull bundle, hydroblast and inspect",
    project: projectName || "Crude Unit Turnaround", status: "Issued", workspace: workspace || "Your company",
    date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    by: actorEmail ?? "you@company.com",
  }), [projectName, workspace, actorEmail]);

  const save = async (words: string, fn: (k: PackageKit) => PackageKit) => {
    setBusy(words); setError(null);
    try { onSaved(await updateKit(orgId, actorEmail, fn)); } catch (e) { setError(sayError(e)); } finally { setBusy(null); }
  };

  const addSheets = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy("Adding"); setError(null);
    const added: Added[] = [];
    try {
      for (const f of Array.from(files)) {
        const pdf = await asPdf(f);
        const path = kitPath(orgId, "pdf");
        await uploadToPath(new Blob([pdf.bytes as BlobPart], { type: "application/pdf" }), path, { contentType: "application/pdf" });
        added.push({ path, name: pdf.name, pages: pdf.pages, size: pdf.bytes.byteLength });
      }
    } catch (e) { setError(sayError(e)); } finally { setBusy(null); }
    if (added.length) { setQueue(added); setQueueOf(added.length); }
  };
  const nextSheet = () => setQueue((q) => q.slice(1));

  // A sheet just added: where it goes in the kit.
  const placeNew = async (s: Added, r: SheetResult) => {
    if (r.kind === "cover" || r.kind === "toc") {
      const cur = r.kind === "cover" ? kit.cover : kit.toc;
      if (cur && !(await appConfirm({
        title: `Replace your ${r.kind === "cover" ? "cover sheet" : "contents page"}?`,
        message: `${s.name} takes the place of ${cur.name}. Packages already printed keep theirs.`,
        confirmLabel: r.kind === "cover" ? "Replace the cover" : "Replace the contents page",
      }))) return;
      let old: string | undefined;
      onSaved(await updateKit(orgId, actorEmail, (k) => {
        old = (r.kind === "cover" ? k.cover : k.toc)?.path;
        return r.kind === "cover"
          ? { ...k, cover: { path: s.path, name: s.name, pages: s.pages, size: s.size, fields: r.fields } }
          : { ...k, toc: { path: s.path, name: s.name, pages: s.pages, size: s.size, ...(r.region ? { region: r.region } : {}) } };
      }));
      if (old && old !== s.path) void deleteFile(old).catch(() => undefined);
    } else {
      const form: KitForm = { id: `f_${Math.random().toString(36).slice(2, 9)}`, title: r.title, path: s.path, name: s.name, pages: s.pages, size: s.size, for: guessFor(r.title), fields: r.fields, ...(r.kind === "ref" ? { returns: false } : {}) };
      onSaved(await updateKit(orgId, actorEmail, (k) => ({ ...k, forms: [...k.forms, form] })));
    }
    nextSheet();
  };
  const skipNew = (s: Added) => { void deleteFile(s.path).catch(() => undefined); nextSheet(); };

  const backToApps = async (what: "cover" | "toc") => {
    const cur = what === "cover" ? kit.cover : kit.toc;
    if (!cur) return;
    if (!(await appConfirm({
      title: `Use the app's ${what === "cover" ? "cover sheet" : "contents page"}?`,
      message: `${cur.name} comes out of the kit. Packages already printed keep theirs.`,
      confirmLabel: what === "cover" ? "Use the app's cover" : "Use the app's contents page",
    }))) return;
    await save("Saving", (k) => (what === "cover" ? { ...k, cover: null } : { ...k, toc: null }));
    void deleteFile(cur.path).catch(() => undefined);
  };
  const removeForm = async (f: KitForm) => {
    if (!(await appConfirm({ title: `Take ${f.title} out of the kit?`, message: "Packages already printed keep their copy. New packages won't get it.", confirmLabel: "Take it out", tone: "danger" }))) return;
    await save("Taking it out", (k) => ({ ...k, forms: k.forms.filter((x) => x.id !== f.id) }));
  };

  const current = queue[0];
  const editForm = editing?.what === "form" ? kit.forms.find((f) => f.id === editing.id) : undefined;

  return (
    <Modal onClose={onClose} size="lg" dismissable={!busy && !current && !editing} labelledBy="pk-title">
      <div className="px-5 sm:px-6 pt-4 pb-3 border-b border-[var(--color-border)] flex items-start gap-3 shrink-0">
        <div className="flex-1 min-w-0">
          <h2 id="pk-title" className="font-display text-section font-semibold text-[var(--color-text)]">Package kit</h2>
          <p className="mt-0.5 text-body text-[var(--color-text-muted)]">The sheets every work order package is printed with, for every project.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
      </div>

      <div className="px-5 sm:px-6 py-4 grid gap-5 overflow-y-auto custom-scrollbar flex-1 min-h-0 content-start">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="min-w-0 flex-1 basis-60 text-body text-[var(--color-text-muted)]">Add any sheet (a PDF, or a photo of one), say what it is, and the app reads its labels to fill in the work order, equipment, date and more. Or print it blank.</p>
          <Button onClick={() => sheetIn.current?.click()} loading={busy === "Adding"} disabled={!!busy}><Plus className="w-4 h-4" /> Add sheets</Button>
        </div>
        {error && <ErrorNote title={error} />}
        {busy && busy !== "Adding" && <p role="status" className="text-body text-[var(--color-text-muted)]">{busy}…</p>}

        <section className="grid gap-2">
          <h3 className="text-body font-semibold text-[var(--color-text)]">Cover and contents</h3>
          <KitRow icon={FileStack} title="Cover sheet"
            what={kit.cover ? `${kit.cover.name} · ${fillsSay(kit.cover.fields)}` : "The app's: your logo, the work orders, equipment, description, project and the package's QR code. Add your own as a sheet."}
            actions={kit.cover && <>
              <Button variant="secondary" onClick={() => setEditing({ what: "cover" })} disabled={!!busy}>Set up</Button>
              <Button variant="ghost" onClick={() => void backToApps("cover")} disabled={!!busy}>Use the app&apos;s</Button>
            </>} />
          <KitRow icon={FileText} title="Contents page"
            what={kit.toc ? `${kit.toc.name} · ${kit.toc.region ? "list area marked" : "list area not marked yet"}` : "The app's: each item and the page it starts on. Add your own as a sheet."}
            actions={kit.toc && <>
              <Button variant="secondary" onClick={() => setEditing({ what: "toc" })} disabled={!!busy}>Set up</Button>
              <Button variant="ghost" onClick={() => void backToApps("toc")} disabled={!!busy}>Use the app&apos;s</Button>
            </>} />
        </section>

        <section className="grid gap-2">
          <h3 className="text-body font-semibold text-[var(--color-text)]">Forms and reference sheets <span className="font-normal text-[var(--color-text-muted)] tabular-nums">{kit.forms.length || ""}</span></h3>
          <ul className="grid gap-2">
            {kit.forms.map((f) => <FormRow key={f.id} f={f} disabled={!!busy}
              onSetUp={() => setEditing({ what: "form", id: f.id })}
              onFor={(w) => void save("Saving", (k) => ({ ...k, forms: k.forms.map((x) => (x.id === f.id ? { ...x, for: w } : x)) }))}
              onRemove={() => void removeForm(f)} />)}
            {!kit.forms.length && <li className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-3 py-4 text-body text-[var(--color-text-muted)]">None yet. Add the blanks you print with every package: flange log, hydro test sheet, closure forms.</li>}
          </ul>
        </section>
      </div>

      <input ref={sheetIn} type="file" accept="application/pdf,image/jpeg,image/png" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void addSheets(e.target.files); e.target.value = ""; }} />

      {current && (
        <SheetSetup key={current.path} path={current.path} name={current.name} isNew kind={null} samples={samples}
          queue={{ at: queueOf - queue.length + 1, of: queueOf }}
          onSave={(r) => placeNew(current, r)} onCancel={() => skipNew(current)} />
      )}
      {!current && editing?.what === "cover" && kit.cover && (
        <SheetSetup path={kit.cover.path} name={kit.cover.name} isNew={false} kind="cover" fields={kit.cover.fields} samples={samples} onCancel={() => setEditing(null)}
          onSave={async (r) => { onSaved(await updateKit(orgId, actorEmail, (k) => (k.cover ? { ...k, cover: { ...k.cover, fields: r.fields } } : k))); setEditing(null); }} />
      )}
      {!current && editing?.what === "toc" && kit.toc && (
        <SheetSetup path={kit.toc.path} name={kit.toc.name} isNew={false} kind="toc" region={kit.toc.region ?? null} samples={samples} onCancel={() => setEditing(null)}
          onSave={async (r) => { onSaved(await updateKit(orgId, actorEmail, (k) => (k.toc && r.region ? { ...k, toc: { ...k.toc, region: r.region } } : k))); setEditing(null); }} />
      )}
      {!current && editForm && (
        <SheetSetup path={editForm.path} name={editForm.name} isNew={false} kind={editForm.returns === false ? "ref" : "form"} title={editForm.title} fields={editForm.fields} samples={samples} onCancel={() => setEditing(null)}
          onSave={async (r) => {
            onSaved(await updateKit(orgId, actorEmail, (k) => ({ ...k, forms: k.forms.map((x) => {
              if (x.id !== editForm.id) return x;
              const rest: KitForm = { ...x, title: r.title, fields: r.fields };
              delete rest.returns;
              return r.kind === "ref" ? { ...rest, returns: false } : rest;
            }) })));
            setEditing(null);
          }} />
      )}
    </Modal>
  );
}

function KitRow({ icon: Icon, title, what, actions }: { icon: React.ComponentType<{ className?: string }>; title: string; what: string; actions?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] p-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <Icon aria-hidden className="w-5 h-5 text-[var(--color-text-muted)] shrink-0" />
      <div className="min-w-0 flex-1 basis-48">
        <div className="text-body font-semibold text-[var(--color-text)]">{title}</div>
        <div className="text-caption text-[var(--color-text-muted)] break-words">{what}</div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  );
}

function FormRow({ f, disabled, onSetUp, onFor, onRemove }: { f: KitForm; disabled: boolean; onSetUp: () => void; onFor: (w: string[]) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const words = [...new Set([...EQUIPMENT_WORDS, ...f.for])];
  const on = new Set(f.for.map((w) => w.toLowerCase()));
  const toggle = (w: string) => onFor(on.has(w.toLowerCase()) ? f.for.filter((x) => x.toLowerCase() !== w.toLowerCase()) : [...f.for, w]);
  return (
    <li className="rounded-lg border border-[var(--color-border)] p-3 grid gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <div className="text-body font-semibold text-[var(--color-text)] break-words">{f.title}</div>
          <div className="text-caption text-[var(--color-text-muted)]">
            {f.returns === false ? "Reference sheet, doesn't come back" : "Form, comes back signed"} · {f.pages} page{f.pages === 1 ? "" : "s"} · {fillsSay(f.fields)}
          </div>
        </div>
        <Button variant="secondary" onClick={onSetUp} disabled={disabled}>Set up</Button>
        <button type="button" onClick={onRemove} disabled={disabled} aria-label={`Take ${f.title} out of the kit`} className="shrink-0 w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--state-overdue-text)] hover:bg-[var(--color-surface-2)]"><Trash2 className="w-4 h-4" /></button>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="text-body text-[var(--color-text)]"><span className="text-[var(--color-text-muted)]">For </span>{f.for.length ? f.for.join(", ") : "every package"}</span>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={disabled} className="inline-flex items-center min-h-9 pointer-coarse:min-h-11 text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">{open ? "Done" : "Change"}</button>
      </div>
      {open && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`${f.title} is for`}>
          {words.map((w) => (
            <button key={w} type="button" aria-pressed={on.has(w.toLowerCase())} onClick={() => toggle(w)} disabled={disabled} className="ui-chip">
              {on.has(w.toLowerCase()) && <Check aria-hidden className="w-3.5 h-3.5" />}{w}
            </button>
          ))}
          <form onSubmit={(e) => { e.preventDefault(); const w = custom.trim(); if (w && !on.has(w.toLowerCase())) onFor([...f.for, w]); setCustom(""); }} className="inline-flex">
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Other…" aria-label="Other equipment word" className="h-8 pointer-coarse:h-11 w-28 px-2 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body pointer-coarse:text-reading" />
          </form>
          <span className="text-caption text-[var(--color-text-muted)]">None picked: every package.</span>
        </div>
      )}
    </li>
  );
}
