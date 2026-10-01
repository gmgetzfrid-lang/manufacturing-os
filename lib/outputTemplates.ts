// lib/outputTemplates.ts — client API for output templates.
//
// Uploads go straight to R2 (same path helper as everything else); only the
// resulting object key travels through the API, so a 40 MB template never
// rides inside a JSON body.

import { supabase } from "@/lib/supabase";
import { uploadToPath } from "@/lib/storage";
import { uniqueFilenames, type Placeholder } from "@/lib/outputTemplateText";
import { requestUnitCodeDecode } from "@/lib/unitCodeClient";

export type { Placeholder } from "@/lib/outputTemplateText";

export interface OutputTemplate {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  kind: "docx" | "xlsx";
  templateFileKey: string | null;
  templateFileName: string | null;
  exampleFiles: Array<{ key: string; name: string }>;
  exampleText: string | null;
  placeholders: Placeholder[];
  instructions: string | null;
  mode: "per_row" | "summary" | "both";
  columnMap: Record<string, string>;
  filenamePattern: string | null;
  createdAt: string;
}

export interface OutputGeneration {
  id: string;
  templateName: string | null;
  sourceName: string | null;
  documentCount: number;
  /** How many of them landed in document control (0 = download-only run). */
  filedCount: number;
  mode: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface DraftedDocument {
  values: Record<string, string>;
  filename: string;
  sourceRow?: number;
}

const mapTemplate = (r: Record<string, unknown>): OutputTemplate => ({
  id: r.id as string,
  orgId: r.org_id as string,
  name: r.name as string,
  description: (r.description as string | null) ?? null,
  kind: (r.kind as "docx" | "xlsx") ?? "docx",
  templateFileKey: (r.template_file_key as string | null) ?? null,
  templateFileName: (r.template_file_name as string | null) ?? null,
  exampleFiles: Array.isArray(r.example_files) ? r.example_files as Array<{ key: string; name: string }> : [],
  exampleText: (r.example_text as string | null) ?? null,
  placeholders: Array.isArray(r.placeholders) ? r.placeholders as Placeholder[] : [],
  instructions: (r.instructions as string | null) ?? null,
  mode: (r.mode as OutputTemplate["mode"]) ?? "per_row",
  columnMap: (r.column_map as Record<string, string>) ?? {},
  filenamePattern: (r.filename_pattern as string | null) ?? null,
  createdAt: r.created_at as string,
});

async function authToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not authenticated");
  return session.access_token;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const token = await authToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export async function listOutputTemplates(orgId: string): Promise<{
  templates: OutputTemplate[]; generations: OutputGeneration[]; canManage: boolean;
}> {
  const raw = await api<{
    templates: Array<Record<string, unknown>>;
    generations: Array<Record<string, unknown>>;
    canManage: boolean;
  }>(`/api/templates?orgId=${encodeURIComponent(orgId)}`);
  return {
    templates: raw.templates.map(mapTemplate),
    generations: raw.generations.map((g) => ({
      id: g.id as string,
      templateName: (g.template_name as string | null) ?? null,
      sourceName: (g.source_name as string | null) ?? null,
      documentCount: (g.document_count as number) ?? 0,
      filedCount: (g.filed_count as number) ?? 0,
      mode: (g.mode as string | null) ?? null,
      createdBy: (g.created_by_name as string | null) ?? null,
      createdAt: g.created_at as string,
    })),
    canManage: raw.canManage,
  };
}

/** Upload a template / example / data file to R2 and return its key. */
export async function uploadTemplateFile(
  orgId: string, file: File, folder: "templates" | "examples" | "data",
): Promise<{ key: string; name: string }> {
  const safe = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `orgs/${orgId}/output-${folder}/${Date.now()}-${safe}`;
  const res = await uploadToPath(file, path, { contentType: file.type || undefined });
  return { key: res.url || path, name: file.name };
}

export interface TemplateAnalysis {
  placeholders: Placeholder[];
  loops: string[];
  preview: string;
  hasTags: boolean;
}

export async function analyzeTemplateFile(
  orgId: string, fileKey: string, kind: "docx" | "xlsx",
): Promise<TemplateAnalysis> {
  return api("/api/templates", {
    method: "POST",
    body: JSON.stringify({ orgId, action: "analyze", fileKey, kind }),
  });
}

export async function saveOutputTemplate(input: {
  orgId: string; id?: string; name: string; description?: string;
  kind: "docx" | "xlsx";
  templateFileKey?: string | null; templateFileName?: string | null;
  exampleFiles?: Array<{ key: string; name: string }>;
  exampleText?: string | null;
  placeholders: Placeholder[];
  instructions?: string;
  mode: "per_row" | "summary" | "both";
  columnMap?: Record<string, string>;
  filenamePattern?: string;
}): Promise<OutputTemplate> {
  const out = await api<{ template: Record<string, unknown> }>("/api/templates", {
    method: "POST", body: JSON.stringify(input),
  });
  return mapTemplate(out.template);
}

export async function deleteOutputTemplate(orgId: string, id: string): Promise<void> {
  await api("/api/templates", { method: "DELETE", body: JSON.stringify({ orgId, id }) });
}

export interface DraftResult {
  documents?: DraftedDocument[];
  columnMap?: Record<string, string>;
  headers?: string[];
  sheetNames?: string[];
  rowCount?: number;
  nextOffset?: number | null;
  estCostUsd?: number;
  /** Set when the template needs data the sheet doesn't have. */
  needsMapping?: boolean;
  missing?: Placeholder[];
}

export async function draftDocuments(input: {
  orgId: string; templateId: string; sourceFileKey: string; sheet?: string;
  columnMap?: Record<string, string>; mode?: "per_row" | "summary"; rowOffset?: number;
}): Promise<DraftResult> {
  return api("/api/templates/generate", {
    method: "POST", body: JSON.stringify({ ...input, action: "draft" }),
  });
}

export interface FilingTarget {
  libraryId: string;
  collectionId?: string | null;
  /** Where the document NUMBER comes from — a fill point tag, else the
   *  filename without its extension. */
  numberTag?: string;
}

/** XEDGE-11: the server renders at most this many documents per call
 *  (MAX_ROWS_PER_CALL in app/api/templates/generate/route.ts); a reviewed
 *  batch of any size is sent in slices of this many. */
export const RENDER_CHUNK = 25;

type RenderDoc = { values: Record<string, string>; filename?: string };
type RenderedFile = { name: string; contentType: string; base64: string };

/** Split a batch into server-sized slices, in order. Pure. */
export function chunkDocuments<T>(documents: readonly T[], size: number = RENDER_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < documents.length; i += size) out.push(documents.slice(i, i + size));
  return out;
}

const ZIP_NAME_BAD = /[\\/:*?"<>|]+/g;

/** One filename per document, unique across the WHOLE batch, decided before
 *  the batch is sliced. The server de-duplicates per call, so a name that
 *  repeats (a template with no filename pattern names every row
 *  `<template>.docx`) would otherwise restart at "(2)" in every slice and the
 *  assembled zip / the filed document numbers would collide across slices.
 *  A document without a draft-supplied name gets an index-unique fallback.
 *  Pure. */
export function batchFilenames(
  documents: ReadonlyArray<{ filename?: string }>,
  templateName?: string,
  kind: "docx" | "xlsx" = "docx",
): string[] {
  const base = (templateName ?? "").replace(ZIP_NAME_BAD, "-").trim() || "document";
  return uniqueFilenames(documents.map((d, i) => d.filename?.trim() || `${base}-${i + 1}.${kind}`));
}

/** Render every slice of a batch as JSON (base64 files). Each slice is its
 *  own production record on the server; the ids come back in order. Every
 *  document is sent with an explicit, batch-unique filename. */
async function renderAllAsJson(input: {
  orgId: string; templateId: string; templateName?: string; templateKind?: "docx" | "xlsx";
  sourceName?: string; mode?: string;
  documents: RenderDoc[];
}): Promise<{ generationIds: string[]; files: RenderedFile[]; perGeneration: Array<{ generationId: string | null; count: number }> }> {
  const generationIds: string[] = [];
  const files: RenderedFile[] = [];
  const perGeneration: Array<{ generationId: string | null; count: number }> = [];
  const names = batchFilenames(input.documents, input.templateName, input.templateKind);
  const named = input.documents.map((d, i) => ({ values: d.values, filename: names[i] }));
  for (const slice of chunkDocuments(named)) {
    const out = await api<{ generationId: string | null; files: RenderedFile[] }>(
      "/api/templates/generate",
      {
        method: "POST",
        body: JSON.stringify({
          orgId: input.orgId, templateId: input.templateId, action: "render",
          documents: slice, sourceName: input.sourceName, mode: input.mode,
          returnJson: true,
        }),
      },
    );
    if (out.generationId) generationIds.push(out.generationId);
    perGeneration.push({ generationId: out.generationId, count: out.files.length });
    files.push(...out.files);
  }
  return { generationIds, files, perGeneration };
}

/** Render the reviewed documents and FILE each one into document control as
 *  a controlled document (rev 0), through the same path a manual upload
 *  takes — RLS, versioning, and audit all apply. Returns how many landed. */
export async function fileDocumentsToLibrary(input: {
  orgId: string; templateId: string; templateName: string; templateKind?: "docx" | "xlsx";
  sourceName?: string; mode?: string;
  documents: Array<{ values: Record<string, string>; filename?: string }>;
  target: FilingTarget;
  actorUserId: string; actorEmail?: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ filed: number; errors: string[]; unitCodeNote?: string }> {
  const { createDocumentWithFile } = await import("@/lib/revisions");
  const out = await renderAllAsJson(input);

  const errors: string[] = [];
  let filed = 0;
  // GAP-314 (P13 review fix): the filed documents' unit codes are decoded in
  // ONE batched call after the run, not one route call per document.
  const filedIds: string[] = [];
  // Filed counts are closed out per production record (one per slice):
  // expand the slice sizes into a per-file generation id.
  const generationOfFile: Array<string | null> = out.perGeneration.flatMap((g) => Array<string | null>(g.count).fill(g.generationId));
  const filedPerGeneration = new Map<string, number>();
  for (let i = 0; i < out.files.length; i++) {
    const f = out.files[i];
    const generationId = generationOfFile[i] ?? null;
    try {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      const file = new File([bytes], f.name, { type: f.contentType });
      const values = input.documents[i]?.values ?? {};
      const numberFromTag = input.target.numberTag ? (values[input.target.numberTag] ?? "").trim() : "";
      const documentNumber = numberFromTag || f.name.replace(/\.[^.]+$/, "");
      const created = await createDocumentWithFile({
        orgId: input.orgId,
        libraryId: input.target.libraryId,
        collectionId: input.target.collectionId ?? null,
        documentNumber,
        title: documentNumber,
        file,
        status: "Draft",
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
        decodeUnitCode: false,
      });
      if (created?.documentId) filedIds.push(created.documentId);
      filed++;
      if (generationId) filedPerGeneration.set(generationId, (filedPerGeneration.get(generationId) ?? 0) + 1);
    } catch (e) {
      errors.push(`${f.name}: ${(e as Error).message}`);
    }
    input.onProgress?.(i + 1, out.files.length);
  }
  const unitCode = await requestUnitCodeDecode(input.orgId, filedIds, "upload");
  if (unitCode.note) console.warn(`[fileDocumentsToLibrary] ${unitCode.note}`);

  // Close the loop on the production record: "12 generated, 12 filed" is the
  // line someone needs months later. Best-effort — the documents are already
  // safely in document control, so a failed bookkeeping call must not read
  // as a failed filing run.
  for (const generationId of out.generationIds) {
    await api("/api/templates/generate", {
      method: "POST",
      body: JSON.stringify({
        orgId: input.orgId, action: "filed",
        generationId, filedCount: filedPerGeneration.get(generationId) ?? 0,
      }),
    }).catch(() => undefined);
  }
  return unitCode.note ? { filed, errors, unitCodeNote: unitCode.note } : { filed, errors };
}

/** The download name from a Content-Disposition header: the UTF-8
 *  `filename*` when present (XEDGE-2), else the plain `filename`. */
export function downloadNameFromDisposition(disposition: string | null | undefined, fallback = "documents"): string {
  const d = disposition ?? "";
  const star = d.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* fall through */ } }
  const plain = d.match(/filename="?([^";]+)"?/);
  return plain?.[1]?.trim() || fallback;
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Assemble the rendered slices into ONE zip. JSZip silently REPLACES an
 *  entry of the same name, so the names are de-duplicated once more here —
 *  a zip of N documents always holds N entries. Returns the zip bytes and
 *  its download name. */
export async function assembleClientZip(
  files: ReadonlyArray<{ name: string; base64: string }>,
  templateName?: string,
): Promise<{ bytes: Uint8Array; name: string; entries: string[] }> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const names = uniqueFilenames(files.map((f) => f.name));
  files.forEach((f, i) => zip.file(names[i], Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))));
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const base = (templateName ?? "").replace(ZIP_NAME_BAD, "-").trim() || "documents";
  return { bytes, name: `${base} - ${files.length} documents.zip`, entries: names };
}

/** Render the reviewed documents and download the file (or zip). A batch
 *  within the server's per-call cap downloads exactly as before; a larger
 *  batch is rendered in slices and assembled into ONE zip client-side. */
export async function renderDocuments(input: {
  orgId: string; templateId: string; templateName?: string; templateKind?: "docx" | "xlsx";
  sourceName?: string; mode?: string;
  documents: Array<{ values: Record<string, string>; filename?: string }>;
}): Promise<void> {
  if (input.documents.length > RENDER_CHUNK) {
    const out = await renderAllAsJson(input);
    const zip = await assembleClientZip(out.files, input.templateName);
    triggerDownload(new Blob([zip.bytes as BlobPart], { type: "application/zip" }), zip.name);
    return;
  }
  const token = await authToken();
  const res = await fetch("/api/templates/generate", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...input, action: "render" }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  triggerDownload(blob, downloadNameFromDisposition(res.headers.get("content-disposition")));
}
