"use client";

// PackageKitDialog - the workspace's package kit, set up once for every
// project: the cover sheet and contents page (optional: the app draws clean
// ones with your logo), and the blank quality forms, each saying which
// equipment gets it ("Exchanger", "Vessel"; none: every package).
//
// A cover with fill-in fields is filled by their names (WO, equipment,
// description, project, date). A cover without them: click where each goes
// on the page. A contents page: click the top-left, then the bottom-right
// of where the list goes.

import React, { useEffect, useRef, useState } from "react";
import { Check, FileStack, FileText, Plus, Trash2, Upload, X } from "lucide-react";
import { PDFDocument } from "pdf-lib";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { field as fieldCls } from "@/components/admin/kit";
import { appConfirm } from "@/components/providers/DialogProvider";
import { sayError } from "@/components/projects/sayError";
import { uploadToPath, deleteFile } from "@/lib/storage";
import { fetchStored } from "@/lib/packageOps";
import { EQUIPMENT_WORDS, kitPath, updateKit, type KitForm, type PackageKit } from "@/lib/woPackages";
import type { FieldPlacement } from "@/lib/packagePdf";

const FIELD_WORDS: Record<FieldPlacement["key"], string> = { wo: "WO number", equipment: "Equipment", description: "Description", project: "Project", date: "Date", status: "Status" };
const FIELD_SIZE: Record<FieldPlacement["key"], number> = { wo: 16, equipment: 13, description: 11, project: 11, date: 11, status: 11 };

async function readPdf(file: File): Promise<{ bytes: Uint8Array; pages: number; fields: string[] }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(bytes, { ignoreEncryption: true }); } catch { throw new Error(`${file.name} isn't a PDF that can be read.`); }
  let fields: string[] = [];
  try { fields = doc.getForm().getFields().map((f) => f.getName()); } catch { /* no form */ }
  return { bytes, pages: doc.getPageCount(), fields };
}

export default function PackageKitDialog({ orgId, kit, actorEmail, onClose, onSaved }: {
  orgId: string; kit: PackageKit; actorEmail?: string; onClose: () => void; onSaved: (k: PackageKit) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState<null | "cover" | "toc">(null);
  const coverIn = useRef<HTMLInputElement>(null);
  const tocIn = useRef<HTMLInputElement>(null);
  const formsIn = useRef<HTMLInputElement>(null);

  const save = async (words: string, fn: (k: PackageKit) => PackageKit) => {
    setBusy(words); setError(null);
    try { onSaved(await updateKit(orgId, actorEmail, fn)); } catch (e) { setError(sayError(e)); } finally { setBusy(null); }
  };

  const putCover = async (file: File | undefined) => {
    if (!file) return;
    setBusy("Adding the cover"); setError(null);
    try {
      const r = await readPdf(file);
      const path = kitPath(orgId, "pdf");
      await uploadToPath(file, path, { contentType: "application/pdf" });
      const old = kit.cover?.path;
      onSaved(await updateKit(orgId, actorEmail, (k) => ({ ...k, cover: { path, name: file.name, pages: r.pages, size: file.size } })));
      if (old) void deleteFile(old).catch(() => undefined);
      // No fill-in fields: say where each goes.
      if (!r.fields.length) setPlacing("cover");
    } catch (e) { setError(sayError(e)); } finally { setBusy(null); }
  };
  const putToc = async (file: File | undefined) => {
    if (!file) return;
    setBusy("Adding the contents page"); setError(null);
    try {
      const r = await readPdf(file);
      const path = kitPath(orgId, "pdf");
      await uploadToPath(file, path, { contentType: "application/pdf" });
      const old = kit.toc?.path;
      onSaved(await updateKit(orgId, actorEmail, (k) => ({ ...k, toc: { path, name: file.name, pages: r.pages, size: file.size } })));
      if (old) void deleteFile(old).catch(() => undefined);
      setPlacing("toc");
    } catch (e) { setError(sayError(e)); } finally { setBusy(null); }
  };
  const addForms = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy("Adding the forms"); setError(null);
    try {
      const added: KitForm[] = [];
      for (const f of Array.from(files)) {
        const r = await readPdf(f);
        const path = kitPath(orgId, "pdf");
        await uploadToPath(f, path, { contentType: "application/pdf" });
        const title = f.name.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim();
        // A form's name often says its equipment ("Exchanger closure").
        const guess = EQUIPMENT_WORDS.filter((w) => new RegExp(`\\b${w.replace(/ /g, "\\s*")}`, "i").test(title));
        added.push({ id: `f_${Math.random().toString(36).slice(2, 9)}`, title, path, name: f.name, pages: r.pages, size: f.size, for: guess });
      }
      onSaved(await updateKit(orgId, actorEmail, (k) => ({ ...k, forms: [...k.forms, ...added] })));
    } catch (e) { setError(sayError(e)); } finally { setBusy(null); }
  };
  const removeForm = async (f: KitForm) => {
    if (!(await appConfirm({ title: `Take ${f.title} out of the kit?`, message: "Packages already printed keep their copy. New packages won't get it.", confirmLabel: "Take it out", tone: "danger" }))) return;
    await save("Taking it out", (k) => ({ ...k, forms: k.forms.filter((x) => x.id !== f.id) }));
  };

  return (
    <Modal onClose={onClose} size="lg" dismissable={!busy && !placing} labelledBy="pk-title">
        <div className="px-5 sm:px-6 pt-4 pb-3 border-b border-[var(--color-border)] flex items-start gap-3 shrink-0">
          <div className="flex-1 min-w-0">
            <h2 id="pk-title" className="font-display text-section font-semibold text-[var(--color-text)]">Package kit</h2>
            <p className="mt-0.5 text-body text-[var(--color-text-muted)]">Set up once, used by every project&apos;s work order packages.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-5 sm:px-6 py-4 grid gap-5 overflow-y-auto custom-scrollbar flex-1 min-h-0 content-start">
          {error && <ErrorNote title={error} />}
          {busy && <p role="status" className="text-body text-[var(--color-text-muted)]">{busy}…</p>}

          {/* Cover and contents. */}
          <section className="grid gap-2">
            <h3 className="text-reading font-semibold text-[var(--color-text)]">Cover sheet and contents page</h3>
            <KitRow icon={FileStack} title="Cover sheet"
              what={kit.cover ? `${kit.cover.name}${kit.cover.fields?.length ? `, ${kit.cover.fields.length} fields placed` : ""}` : "The app's: your logo, the WO, equipment, description, project and the package's QR"}
              actions={<>
                {kit.cover && <Button variant="ghost" onClick={() => setPlacing("cover")} disabled={!!busy}>Place fields</Button>}
                <Button variant="secondary" onClick={() => coverIn.current?.click()} disabled={!!busy}><Upload className="w-4 h-4" /> {kit.cover ? "Replace" : "Use your own"}</Button>
                {kit.cover && <Button variant="ghost" onClick={() => void save("Back to the app's cover", (k) => ({ ...k, cover: null }))} disabled={!!busy}>Use the app&apos;s</Button>}
              </>} />
            <KitRow icon={FileText} title="Contents page"
              what={kit.toc ? `${kit.toc.name}${kit.toc.region ? ", list area marked" : ""}` : "The app's: each item and the page it starts on"}
              actions={<>
                {kit.toc && <Button variant="ghost" onClick={() => setPlacing("toc")} disabled={!!busy}>Mark the list area</Button>}
                <Button variant="secondary" onClick={() => tocIn.current?.click()} disabled={!!busy}><Upload className="w-4 h-4" /> {kit.toc ? "Replace" : "Use your own"}</Button>
                {kit.toc && <Button variant="ghost" onClick={() => void save("Back to the app's contents", (k) => ({ ...k, toc: null }))} disabled={!!busy}>Use the app&apos;s</Button>}
              </>} />
          </section>

          {/* Forms. */}
          <section className="grid gap-2">
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-reading font-semibold text-[var(--color-text)]">Forms <span className="text-body font-normal text-[var(--color-text-muted)] tabular-nums">{kit.forms.length}</span></h3>
              <Button onClick={() => formsIn.current?.click()} disabled={!!busy}><Plus className="w-4 h-4" /> Add forms</Button>
            </div>
            <p className="text-body text-[var(--color-text-muted)]">Blank PDFs: flange log, hydro test sheet, closure forms. Say which equipment each is for, and every package gets the right ones. None picked: every package.</p>
            <ul className="grid gap-2">
              {kit.forms.map((f) => <FormRow key={f.id} f={f} disabled={!!busy}
                onRename={(t) => void save("Renaming", (k) => ({ ...k, forms: k.forms.map((x) => (x.id === f.id ? { ...x, title: t } : x)) }))}
                onFor={(w) => void save("Saving", (k) => ({ ...k, forms: k.forms.map((x) => (x.id === f.id ? { ...x, for: w } : x)) }))}
                onRemove={() => void removeForm(f)} />)}
              {!kit.forms.length && <li className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-3 py-4 text-body text-[var(--color-text-muted)]">No forms yet. Add the blanks you print with every package.</li>}
            </ul>
          </section>
        </div>

        <input ref={coverIn} type="file" accept="application/pdf" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void putCover(e.target.files?.[0]); e.target.value = ""; }} />
        <input ref={tocIn} type="file" accept="application/pdf" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void putToc(e.target.files?.[0]); e.target.value = ""; }} />
        <input ref={formsIn} type="file" accept="application/pdf" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void addForms(e.target.files); e.target.value = ""; }} />

        {placing === "cover" && kit.cover && (
          <Placer path={kit.cover.path} mode="fields" initial={kit.cover.fields ?? []} onCancel={() => setPlacing(null)}
            onSave={(fields) => { setPlacing(null); void save("Saving the cover's fields", (k) => (k.cover ? { ...k, cover: { ...k.cover, fields: fields as FieldPlacement[] } } : k)); }} />
        )}
        {placing === "toc" && kit.toc && (
          <Placer path={kit.toc.path} mode="region" initial={kit.toc.region ?? null} onCancel={() => setPlacing(null)}
            onSave={(region) => { setPlacing(null); void save("Saving the list area", (k) => (k.toc ? { ...k, toc: { ...k.toc, region: region as { x: number; y: number; w: number; h: number } } } : k)); }} />
        )}
    </Modal>
  );
}

function KitRow({ icon: Icon, title, what, actions }: { icon: React.ComponentType<{ className?: string }>; title: string; what: string; actions: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] p-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <Icon aria-hidden className="w-5 h-5 text-[var(--color-text-muted)] shrink-0" />
      <div className="min-w-0 flex-1 basis-48">
        <div className="text-body font-semibold text-[var(--color-text)]">{title}</div>
        <div className="text-caption text-[var(--color-text-muted)] break-words">{what}</div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{actions}</div>
    </div>
  );
}

function FormRow({ f, disabled, onRename, onFor, onRemove }: { f: KitForm; disabled: boolean; onRename: (t: string) => void; onFor: (w: string[]) => void; onRemove: () => void }) {
  const [title, setTitle] = useState(f.title);
  const [custom, setCustom] = useState("");
  const words = [...new Set([...EQUIPMENT_WORDS, ...f.for])];
  const on = new Set(f.for.map((w) => w.toLowerCase()));
  const toggle = (w: string) => onFor(on.has(w.toLowerCase()) ? f.for.filter((x) => x.toLowerCase() !== w.toLowerCase()) : [...f.for, w]);
  return (
    <li className="rounded-lg border border-[var(--color-border)] p-3 grid gap-2">
      <div className="flex items-center gap-2">
        <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => { const t = title.trim(); if (t && t !== f.title) onRename(t); else setTitle(f.title); }}
          aria-label="Form name" className={`${fieldCls} flex-1 min-w-0`} disabled={disabled} />
        <span className="shrink-0 text-caption text-[var(--color-text-muted)] tabular-nums">{f.pages} page{f.pages === 1 ? "" : "s"}</span>
        <button type="button" onClick={onRemove} disabled={disabled} aria-label={`Take ${f.title} out of the kit`} className="shrink-0 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--state-overdue-text)] hover:bg-[var(--color-surface-2)]"><Trash2 className="w-4 h-4" /></button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`${f.title} is for`}>
        <span className="text-caption text-[var(--color-text-muted)] mr-1">For</span>
        {words.map((w) => (
          <button key={w} type="button" aria-pressed={on.has(w.toLowerCase())} onClick={() => toggle(w)} disabled={disabled} className="ui-chip">
            {on.has(w.toLowerCase()) && <Check aria-hidden className="w-3.5 h-3.5" />}{w}
          </button>
        ))}
        <form onSubmit={(e) => { e.preventDefault(); const w = custom.trim(); if (w && !on.has(w.toLowerCase())) onFor([...f.for, w]); setCustom(""); }} className="inline-flex">
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Other…" aria-label="Other equipment word" className="h-8 pointer-coarse:h-11 w-28 px-2 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body pointer-coarse:text-reading" />
        </form>
        {!f.for.length && <span className="text-caption text-[var(--color-text-muted)]">Every package</span>}
      </div>
    </li>
  );
}

/** Page 1 of a kit PDF, drawn, for clicking where things go. Positions are
 *  kept in PDF points (bottom-left origin), so they print where clicked. */
function Placer({ path, mode, initial, onSave, onCancel }: {
  path: string; mode: "fields" | "region";
  initial: FieldPlacement[] | { x: number; y: number; w: number; h: number } | null;
  onSave: (v: FieldPlacement[] | { x: number; y: number; w: number; h: number }) => void; onCancel: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number; scale: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldPlacement[]>(Array.isArray(initial) ? initial : []);
  const [field, setField] = useState<FieldPlacement["key"]>("wo");
  const [corners, setCorners] = useState<Array<{ x: number; y: number }>>(() => {
    const r = !Array.isArray(initial) && initial ? initial : null;
    return r ? [{ x: r.x, y: r.y + r.h }, { x: r.x + r.w, y: r.y }] : [];
  });

  useEffect(() => {
    let on = true;
    void (async () => {
      try {
        const bytes = await fetchStored(path);
        const { pdfjs } = await import("react-pdf");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const { PDFJS_VERBOSITY } = await import("@/lib/pdfjsConfig");
        const doc = await pdfjs.getDocument({ data: bytes, verbosity: PDFJS_VERBOSITY }).promise;
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(560 / base.width, (window.innerHeight * 0.62) / base.height, 1.6);
        const vp = page.getViewport({ scale });
        const c = canvas.current;
        if (!c || !on) return;
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        await page.render({ canvas: c, canvasContext: c.getContext("2d")!, viewport: vp }).promise;
        if (on) setSize({ w: base.width, h: base.height, scale });
      } catch (e) { if (on) setErr(sayError(e)); }
    })();
    return () => { on = false; };
  }, [path]);

  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!size) return;
    const r = e.currentTarget.getBoundingClientRect();
    const k = r.width / (size.w * size.scale);
    const x = (e.clientX - r.left) / k / size.scale;
    const y = size.h - (e.clientY - r.top) / k / size.scale;
    if (mode === "fields") {
      setFields((fs) => [...fs.filter((f) => f.key !== field), { key: field, x: Math.round(x), y: Math.round(y), size: FIELD_SIZE[field], maxWidth: Math.round(size.w - x - 24) }]);
      const keys = Object.keys(FIELD_WORDS) as FieldPlacement["key"][];
      const next = keys.find((k2) => k2 !== field && !fields.some((f) => f.key === k2));
      if (next) setField(next);
    } else {
      setCorners((c) => (c.length >= 2 ? [{ x, y }] : [...c, { x, y }]));
    }
  };
  const pct = (x: number, y: number) => size ? { left: `${(x / size.w) * 100}%`, top: `${((size.h - y) / size.h) * 100}%` } : {};
  const region = corners.length === 2 ? { x: Math.round(Math.min(corners[0].x, corners[1].x)), y: Math.round(Math.min(corners[0].y, corners[1].y)), w: Math.round(Math.abs(corners[1].x - corners[0].x)), h: Math.round(Math.abs(corners[1].y - corners[0].y)) } : null;

  return (
    <Modal onClose={onCancel} size="xl" label={mode === "fields" ? "Place the cover's fields" : "Mark the list area"}>
        <div className="px-5 pt-4 pb-3 border-b border-[var(--color-border)] shrink-0">
          <h3 className="font-display text-section font-semibold text-[var(--color-text)]">{mode === "fields" ? "Where each goes on the cover" : "Where the list goes"}</h3>
          <p className="text-body text-[var(--color-text-muted)]">{mode === "fields" ? "Pick one, then click on the page where its text starts." : "Click the top-left corner of the list area, then the bottom-right."}</p>
          {mode === "fields" && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(Object.keys(FIELD_WORDS) as FieldPlacement["key"][]).map((k) => (
                <button key={k} type="button" aria-pressed={field === k} onClick={() => setField(k)} className="ui-chip">
                  {fields.some((f) => f.key === k) && <Check aria-hidden className="w-3.5 h-3.5" />}{FIELD_WORDS[k]}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-4 grid place-items-center bg-[var(--color-surface-2)]">
          {err ? <ErrorNote title={err} /> : (
            <div className="relative inline-block shadow-[var(--shadow-control)]">
              <canvas ref={canvas} onClick={click} className="block max-w-full h-auto cursor-crosshair bg-white" />
              {size && mode === "fields" && fields.map((f) => (
                <span key={f.key} className="absolute -translate-y-full px-1 rounded bg-[var(--color-current)] text-white text-caption font-semibold whitespace-nowrap pointer-events-none" style={pct(f.x, f.y + f.size)}>{FIELD_WORDS[f.key]}</span>
              ))}
              {size && mode === "region" && region && (
                <span className="absolute border-2 border-[var(--color-current)] bg-[color-mix(in_srgb,var(--color-current)_12%,transparent)] pointer-events-none"
                  style={{ ...pct(region.x, region.y + region.h), width: `${(region.w / size.w) * 100}%`, height: `${(region.h / size.h) * 100}%` }} />
              )}
              {size && mode === "region" && corners.length === 1 && <span className="absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full bg-[var(--color-current)] pointer-events-none" style={pct(corners[0].x, corners[0].y)} />}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[var(--color-border)] flex items-center gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <span className="ml-auto" />
          <Button onClick={() => (mode === "fields" ? onSave(fields) : region && onSave(region))} disabled={mode === "fields" ? !fields.some((f) => f.key === "wo") : !region}>
            <Check className="w-4 h-4" /> Save
          </Button>
        </div>
    </Modal>
  );
}
