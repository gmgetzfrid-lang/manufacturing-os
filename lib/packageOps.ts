// lib/packageOps.ts - what the app does with a work order package in the
// browser: put its PDF together (cover, contents, the forms, drawings at
// their current revision, photos, the signed copies in the blanks' places),
// print it, and file it to the project's network folder.
//
// Filing writes the finished PDF straight into the folder when the browser
// can (Chrome and Edge: the folder is picked once per computer and
// remembered), else it downloads for the person to save there. The app
// then keeps only the path, and the working copies are deleted.

import { PDFDocument } from "pdf-lib";
import { supabase } from "@/lib/supabase";
import { getSignedUrlForPath, deleteFile } from "@/lib/storage";
import { applyStampToPdfDoc } from "@/lib/stamping";
import { publicOrigin } from "@/lib/publicOrigin";
import { assemblePackage, suggestFileName, type PackPart, type KitTemplates } from "@/lib/packagePdf";
import { workingPaths, type PackageKit, type PkgItem, type WoPackage } from "@/lib/woPackagesCore";

type Mime = PackPart["mime"];
const mimeOf = (m?: string | null, path?: string): Mime =>
  m === "image/jpeg" || /\.jpe?g$/i.test(path ?? "") ? "image/jpeg" : m === "image/png" || /\.png$/i.test(path ?? "") ? "image/png" : "application/pdf";

async function authToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Sign in again.");
  return session.access_token;
}

/** A stored file's bytes. */
export async function fetchStored(path: string): Promise<Uint8Array> {
  const url = /^(https?:|blob:)/.test(path) ? path : await getSignedUrlForPath(path, 600);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`A file couldn't be fetched (HTTP ${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

/** A library drawing at its CURRENT revision, stamped for the field (the
 *  verify QR and "check the current revision" footer, like a doc pack). */
export async function currentDrawing(documentId: string, who: { email?: string | null }): Promise<{ bytes: Uint8Array; versionId: string | null; rev: string | null; label: string }> {
  const { data: d } = await supabase.from("documents").select("id, document_number, title, name, current_version_id").eq("id", documentId).maybeSingle();
  const doc = d as { id: string; document_number: string | null; title: string | null; name: string | null; current_version_id: string | null } | null;
  if (!doc?.current_version_id) throw new Error("That drawing has no current file.");
  const { data: v } = await supabase.from("document_versions").select("id, file_url, revision_label").eq("id", doc.current_version_id).maybeSingle();
  const ver = v as { id: string; file_url: string | null; revision_label: string | null } | null;
  if (!ver?.file_url) throw new Error("That drawing has no current file.");
  const raw = await fetchStored(ver.file_url);
  const label = doc.document_number || doc.title || doc.name || "Drawing";
  try {
    const single = await PDFDocument.load(raw, { ignoreEncryption: true });
    await applyStampToPdfDoc(single, {
      sourceBytes: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
      userLabel: who.email?.split("@")[0] ?? undefined,
      email: who.email ?? undefined,
      timestamp: new Date(),
      watermarkText: "UNCONTROLLED - WORK PACKAGE",
      footerNotice: `${label} Rev ${ver.revision_label ?? "?"} at time of print - verify the current revision before use.`,
      verifyUrl: publicOrigin() ? `${publicOrigin()}/verify/${doc.id}?v=${ver.id}` : undefined,
    });
    return { bytes: await single.save(), versionId: ver.id, rev: ver.revision_label, label };
  } catch {
    // Not a PDF the stamper can open (an image drawing): as it is.
    return { bytes: raw, versionId: ver.id, rev: ver.revision_label, label };
  }
}

/** The QR codes for packages' covers (the project's printed-packages link). */
export async function packageCodes(projectId: string, keys: string[]): Promise<Record<string, string>> {
  const res = await fetch("/api/package-returns/codes", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await authToken()}` },
    body: JSON.stringify({ projectId, keys }),
  });
  const b = (await res.json().catch(() => null)) as { codes?: Record<string, string>; error?: string } | null;
  if (!res.ok || !b?.codes) throw new Error(b?.error || "The packages' QR codes couldn't be made.");
  return b.codes;
}
export const packageUrl = (code: string) => `${publicOrigin() || (typeof window !== "undefined" ? window.location.origin : "")}/r/${code}`;

export interface BuildInput {
  orgId: string;
  projectId: string;
  projectName: string;
  workspace: string;
  logoUrl?: string | null;
  pkg: WoPackage;
  kit: PackageKit;
  tz?: string;
  who: { email?: string | null };
  /** Print the cover's QR (the package's own page). */
  withQr?: boolean;
  /** Use the signed copies in place of the blank forms (filing). */
  signed?: boolean;
  onStep?: (words: string) => void;
}
export interface Built {
  pdf: Uint8Array;
  pages: number;
  fileName: string;
  /** Drawings printed at a newer revision than the package had: the package
   *  is updated to them. */
  drawings: Array<{ id: string; versionId: string | null; rev: string | null }>;
  /** Items that couldn't be added, in words. */
  problems: string[];
}

/** The package's PDF, in its order. */
export async function buildPackagePdf(input: BuildInput): Promise<Built> {
  const { pkg, kit } = input;
  const say = input.onStep ?? (() => undefined);
  const problems: string[] = [];
  const drawings: Built["drawings"] = [];
  const parts: PackPart[] = [];
  const formFile = new Map(kit.forms.map((f) => [f.id, f]));
  let n = 0;
  for (const it of pkg.items) {
    n++;
    say(`Adding ${it.title} (${n} of ${pkg.items.length})`);
    try {
      if (it.kind === "form") {
        if (input.signed && it.signed) {
          parts.push({ id: it.id, title: it.title, kind: "form", signed: true, bytes: await fetchStored(it.signed.path), mime: mimeOf(it.signed.mime, it.signed.path) });
          continue;
        }
        const f = it.formId ? formFile.get(it.formId) : undefined;
        if (!f) { problems.push(`${it.title}: the blank is no longer in the kit`); continue; }
        parts.push({ id: it.id, title: it.title, kind: "form", bytes: await fetchStored(f.path), mime: "application/pdf", qr: `pkgform:${pkg.key}:${it.id}` });
      } else if (it.kind === "drawing" && it.documentId) {
        const d = await currentDrawing(it.documentId, input.who);
        if (d.versionId !== (it.versionId ?? null)) drawings.push({ id: it.id, versionId: d.versionId, rev: d.rev });
        parts.push({ id: it.id, title: `${d.label}${d.rev ? ` rev ${d.rev}` : ""}`, kind: "drawing", bytes: d.bytes, mime: "application/pdf" });
      } else {
        const path = it.signed?.path ?? it.path;
        if (!path) { problems.push(`${it.title}: no file`); continue; }
        parts.push({ id: it.id, title: it.title, kind: it.kind === "photo" ? "photo" : "file", bytes: await fetchStored(path), mime: mimeOf(it.signed?.mime ?? it.mime, path) });
      }
    } catch (e) {
      problems.push(`${it.title}: ${(e as Error).message}`);
    }
  }

  say("Putting the cover and contents together");
  const templates: KitTemplates = {};
  if (kit.cover) templates.cover = { bytes: await fetchStored(kit.cover.path), fields: kit.cover.fields };
  if (kit.toc) templates.toc = { bytes: await fetchStored(kit.toc.path), region: kit.toc.region };
  let logo: { bytes: Uint8Array; mime: "image/png" | "image/jpeg" } | null = null;
  if (input.logoUrl && !kit.cover) {
    try {
      const res = await fetch(input.logoUrl);
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && /png|jpe?g/.test(type)) logo = { bytes: new Uint8Array(await res.arrayBuffer()), mime: /png/.test(type) ? "image/png" : "image/jpeg" };
    } catch { /* the workspace name instead */ }
  }
  let landingUrl: string | null = null;
  if (input.withQr) {
    try { landingUrl = packageUrl((await packageCodes(input.projectId, [pkg.key]))[pkg.key]); }
    catch (e) { problems.push(`The cover's QR: ${(e as Error).message}`); }
  }
  const meta = {
    workspace: input.workspace, project: input.projectName, wos: pkg.wos, equipment: pkg.equipment, description: pkg.description,
    printedAt: new Date(), timeZone: input.tz, logo, landingUrl,
    status: input.signed ? "Filed" : pkg.status === "draft" ? "Draft" : pkg.status === "approved" ? "Approved" : "Issued",
  };
  const out = await assemblePackage(meta, parts, templates);
  return { pdf: out.pdf, pages: out.pages, fileName: suggestFileName(meta), drawings, problems };
}

/** Pages a stored file has (for the list), or 1 when it can't be read. */
export async function pagesOf(bytes: Uint8Array, mime: string): Promise<number> {
  if (mime !== "application/pdf") return 1;
  try { return (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount(); } catch { return 1; }
}

/** Open a PDF in a new tab (preview and print). */
export function openPdf(pdf: Uint8Array) {
  const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: "application/pdf" }));
  // (Not "noopener": with it the browser always answers null, and every
  // preview would download too.) A blocked pop-up downloads instead.
  const w = window.open(url, "_blank");
  if (w) { try { w.opener = null; } catch { /* other origin */ } } else download(pdf, "package.pdf");
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}
export function download(pdf: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ── The network folder (File System Access, where the browser has it) ──

type Perm = "granted" | "denied" | "prompt";
interface DirHandle {
  name: string;
  queryPermission?: (o: { mode: "readwrite" }) => Promise<Perm>;
  requestPermission?: (o: { mode: "readwrite" }) => Promise<Perm>;
  getFileHandle: (name: string, o: { create: boolean }) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>;
}
type PickerWindow = Window & { showDirectoryPicker?: (o?: { id?: string; mode?: "readwrite" }) => Promise<DirHandle> };

/** Whether this browser can write straight into a folder. */
export const canWriteToFolder = () => typeof window !== "undefined" && typeof (window as PickerWindow).showDirectoryPicker === "function";

const IDB = "mfgos-folders";
function idb(): Promise<IDBDatabase> {
  return new Promise((ok, no) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("handles");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((ok) => { const q = db.transaction("handles").objectStore("handles").get(key); q.onsuccess = () => ok(q.result as T | undefined); q.onerror = () => ok(undefined); });
}
async function idbSet(key: string, val: unknown): Promise<void> {
  const db = await idb();
  await new Promise<void>((ok) => { const t = db.transaction("handles", "readwrite"); t.objectStore("handles").put(val, key); t.oncomplete = () => ok(); t.onerror = () => ok(); });
}

/** The project's folder on this computer, with permission to write: the
 *  one picked before, or picked now (call from the click itself). Null when
 *  the browser can't, or the person cancels. */
export async function projectFolder(projectId: string, opts: { pickNew?: boolean } = {}): Promise<DirHandle | null> {
  if (!canWriteToFolder()) return null;
  const key = `packages:${projectId}`;
  let dir = opts.pickNew ? undefined : await idbGet<DirHandle>(key).catch(() => undefined);
  if (dir) {
    const p = (await dir.queryPermission?.({ mode: "readwrite" })) ?? "granted";
    if (p === "granted" || (await dir.requestPermission?.({ mode: "readwrite" })) === "granted") return dir;
  }
  try {
    dir = await (window as PickerWindow).showDirectoryPicker!({ id: "wo-packages", mode: "readwrite" });
  } catch { return null; }
  await idbSet(key, dir).catch(() => undefined);
  return dir;
}
export async function rememberedFolderName(projectId: string): Promise<string | null> {
  if (!canWriteToFolder()) return null;
  return (await idbGet<DirHandle>(`packages:${projectId}`).catch(() => undefined))?.name ?? null;
}

/** Write the PDF into the folder. */
export async function writeToFolder(dir: DirHandle, fileName: string, pdf: Uint8Array): Promise<void> {
  const fh = await dir.getFileHandle(fileName, { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([pdf as BlobPart], { type: "application/pdf" }));
  await w.close();
}

/** Delete a filed package's working copies (photos, files, signed scans).
 *  Kit forms and library drawings are never touched. */
export async function deleteWorkingCopies(pkg: WoPackage): Promise<{ deleted: number; failed: number }> {
  let deleted = 0, failed = 0;
  for (const p of workingPaths(pkg)) {
    try { await deleteFile(p); deleted++; } catch { failed++; }
  }
  return { deleted, failed };
}

/** The items after a print or a filing: drawings now at the revision printed. */
export function withDrawings(items: PkgItem[], drawings: Built["drawings"]): PkgItem[] {
  if (!drawings.length) return items;
  const by = new Map(drawings.map((d) => [d.id, d]));
  return items.map((i) => { const d = by.get(i.id); return d ? { ...i, versionId: d.versionId, rev: d.rev } : i; });
}
