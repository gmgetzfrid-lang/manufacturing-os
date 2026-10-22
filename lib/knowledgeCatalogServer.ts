// lib/knowledgeCatalogServer.ts — SERVER-ONLY. Builds and reads the library
// catalog (see lib/knowledgeCatalog.ts for what and why).
//
// Two jobs, both resumable and bounded per invocation like ingestion:
//   1. PROFILE every ready document that has none: one fast-tier call on its
//      first pages' text (plus, for PDFs with fillable fields, the field
//      names read straight from the file). Works on documents already
//      indexed — no re-index needed to build a catalog.
//   2. READ THE CATALOGS people marked ("Piping specs", "Valve data
//      sheets"): a marked document's sections, or a marked library's
//      documents, become entries — from the indexed text, no AI.
//
// Billing: the triggering user's own key, fast tier, metered as
// knowledgeCatalog — same model as vision indexing.

import type { SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFSignature } from "pdf-lib";
import { callAiModel, type AiProviderId } from "@/lib/ai/providerCall";
import type { AiUsage } from "@/lib/ai/pricing";
import { VISION_MODEL } from "@/lib/knowledgeVision";
import { fetchBytes } from "@/lib/r2Bytes";
import { questionWords, leadsFor } from "@/lib/searchLeads";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { findSections } from "@/lib/sectionTemplate";
import { sectionRecords, setRecords, type EntryRecord } from "@/lib/catalogBooks";
import {
  normalizeProfile, parseProfile, parseModelJson,
  type CatalogEntry, type CatalogMark, type DocProfile, type FieldKind,
} from "@/lib/knowledgeCatalog";

export interface CatalogConn {
  provider: AiProviderId;
  model: string;
  apiKey: string;
  onUsage: (u: AiUsage, model: string) => void;
}

interface DocRow {
  id: string;
  org_id: string;
  library_id: string;
  name: string;
  file_key: string | null;
  page_count: number | null;
  source_document_id?: string | null;
}

/** Fast tier first (cataloging is classification, not reasoning); the
 *  asker's own model if the fast tier is refused. */
async function callFast(conn: CatalogConn, input: { system: string; user: string; maxTokens: number; images?: Array<{ base64: string; mediaType: string }>; timeoutMs?: number }) {
  const fast = VISION_MODEL[conn.provider];
  const run = async (model: string) => {
    const out = await callAiModel({ provider: conn.provider, model, apiKey: conn.apiKey, ...input });
    conn.onUsage(out.usage, model);
    return out.text;
  };
  if (fast && fast !== conn.model) {
    try { return await run(fast); } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status !== 400 && status !== 404) throw e;
    }
  }
  return run(conn.model);
}

/** The PDF's own fillable fields — names are what a filled file needs. */
export async function readPdfFormFields(
  bytes: Uint8Array,
): Promise<Array<{ name: string; kind: FieldKind; options?: string[] }>> {
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const out: Array<{ name: string; kind: FieldKind; options?: string[] }> = [];
    for (const f of pdf.getForm().getFields()) {
      const name = f.getName();
      if (f instanceof PDFTextField) out.push({ name, kind: f.isMultiline() ? "long" : "text" });
      else if (f instanceof PDFCheckBox) out.push({ name, kind: "check" });
      else if (f instanceof PDFDropdown || f instanceof PDFOptionList) out.push({ name, kind: "choice", options: f.getOptions() });
      else if (f instanceof PDFRadioGroup) out.push({ name, kind: "choice", options: f.getOptions() });
      else if (f instanceof PDFSignature) out.push({ name, kind: "signature" });
    }
    return out;
  } catch {
    return [];
  }
}

const PROFILE_SYSTEM =
  "You catalog documents in an industrial facility's engineering library (refinery / petrochemical). " +
  "Reply with ONLY a JSON object, no prose:\n" +
  '{"type": "...", "designation": "...", "title": "...", "purpose": "...", "covers": ["..."], ' +
  '"references": ["..."], "form": {"purpose": "...", "fields": [{"name": "...", "label": "...", "kind": "...", "options": ["..."]}]}, ' +
  '"checklistFor": "..."}\n\n' +
  "type — exactly one of:\n" +
  "- standard: an engineering practice / standard / specification written as clauses (e.g. \"EP 5-2-1 Selection of Piping Components and Materials\")\n" +
  "- form: a blank form to fill in (deviation or waiver request, NCR, MOC, technical query, permit, test record)\n" +
  "- checklist: a checklist used while doing work (inspection, hydrotest, flange joint assembly, pre-startup)\n" +
  "- std_drawing: a standard or typical detail drawing\n" +
  "- pid: a P&ID, PFD, isometric or other plant drawing\n" +
  "- procedure: step-by-step work instructions\n" +
  "- datasheet: an equipment or instrument data sheet\n" +
  "- other\n" +
  "designation: the document number as printed (\"EP 5-2-1\", \"STD-205\"), or \"\" if none.\n" +
  "title: the document's title as printed. purpose: ONE sentence — what someone uses it for.\n" +
  "covers: up to 8 short topics it covers. references: designations of other documents and codes it cites " +
  "(\"ASME B31.3\", \"EP 10-2-1\", \"NACE MR0103\").\n" +
  "form — ONLY for type form or checklist: purpose is one of deviation, ncr, moc, tq, inspection, test, permit, other; " +
  "fields lists every blank the user fills, in printed order: name (short), label (as printed), kind (text, long, " +
  "date, check, choice, signature), options (for choice). If FILLABLE FIELD NAMES are given below, return exactly " +
  "one field per given name, using that exact name, with the label printed next to it.\n" +
  "checklistFor — ONLY for checklists: the job it is for (\"hydrostatic test of piping\").";

/** Profile one document and store it (replacing any earlier profile). */
export async function profileDocument(
  admin: SupabaseClient, conn: CatalogConn, doc: DocRow, libraryKind: string | null,
): Promise<DocProfile> {
  const { data: chunkRows } = await admin
    .from("knowledge_chunks").select("page, content")
    .eq("document_id", doc.id).lte("page", 4)
    .order("page", { ascending: true }).order("seq", { ascending: true })
    .limit(40);
  let text = "";
  for (const c of (chunkRows ?? []) as Array<{ page: number; content: string }>) {
    if (text.length > 7000) break;
    text += `\n[p.${c.page}] ${c.content}`;
  }
  let pdfFields: Awaited<ReturnType<typeof readPdfFormFields>> = [];
  if (doc.file_key && /\.pdf$/i.test(doc.file_key)) {
    try { pdfFields = await readPdfFormFields(new Uint8Array(await fetchBytes(doc.file_key))); } catch { /* no fields */ }
  }
  const out = await callFast(conn, {
    system: PROFILE_SYSTEM,
    user: [
      libraryKind && libraryKind !== "mixed" ? `(The library owner says this library holds: ${libraryKind}.)` : "",
      `FILE NAME: ${doc.name}`,
      doc.page_count ? `PAGES: ${doc.page_count}` : "",
      pdfFields.length > 0 ? `FILLABLE FIELD NAMES (${pdfFields.length}): ${pdfFields.map((f) => f.name).join(" | ").slice(0, 3000)}` : "",
      `TEXT OF THE FIRST PAGES:\n${text.trim() || "(no text layer)"}`,
    ].filter(Boolean).join("\n\n"),
    maxTokens: pdfFields.length > 30 ? 4000 : 2000,
    timeoutMs: 30_000,
  });
  const profile = normalizeProfile(parseModelJson(out), { name: doc.name, pdfFields });
  await writeProfile(admin, doc, profile);
  return profile;
}

async function writeProfile(admin: SupabaseClient, doc: DocRow, profile: DocProfile): Promise<void> {
  await admin.from("knowledge_page_entities").delete().eq("document_id", doc.id).eq("kind", "profile");
  await admin.from("knowledge_page_entities").insert({
    org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id, page: 1,
    kind: "profile", tag: profile.type, raw: JSON.stringify(profile),
  });
}

/** One bounded pass over a library: profile what's unprofiled. Resumable —
 *  call again until remaining is 0. */
export async function drainCatalog(admin: SupabaseClient, opts: {
  orgId: string; libraryId: string; conn: CatalogConn; deadlineMs: number; documentId?: string;
}): Promise<{ profiled: number; remaining: number; failed: number }> {
  const { data: lib } = await admin
    .from("knowledge_libraries").select("ai_features").eq("id", opts.libraryId).eq("org_id", opts.orgId).maybeSingle();
  const libraryKind = String(((lib?.ai_features ?? {}) as Record<string, unknown>).kind ?? "") || null;
  // Paged: a single read stops at 1,000 rows, and documents past it would
  // never be mapped.
  const { rows: docList } = await fetchAllRows<DocRow>((from, to) => {
    let q = admin
      .from("knowledge_documents").select("id, org_id, library_id, name, file_key, page_count")
      .eq("org_id", opts.orgId).eq("library_id", opts.libraryId).eq("status", "ready");
    if (opts.documentId) q = q.eq("id", opts.documentId);
    return q.order("id").range(from, to);
  });
  const profiles = await profilesFor(admin, docList.map((d) => d.id));

  let profiled = 0;
  let failed = 0;
  for (const d of docList) {
    if (Date.now() > opts.deadlineMs - 20_000) break;
    if (profiles.has(d.id)) continue;
    try {
      profiles.set(d.id, await profileDocument(admin, opts.conn, d, libraryKind));
      profiled++;
    } catch {
      failed++;
    }
  }
  const remaining = docList.filter((d) => !profiles.has(d.id)).length;
  return { profiled, remaining, failed };
}

/** Entries are stored under this kind (see lib/knowledgeCatalog.ts). */
export const ENTRY_KIND = "catalog_entry";

/** Which text reader produced a catalog's entries — bumped when it learns
 *  to read more, so marked catalogs are re-read (it costs nothing). */
export const CATALOG_METHOD = "text-v4";

const INSERT_BATCH = 300;

async function writeEntries(admin: SupabaseClient, rows: Array<{ org_id: string; library_id: string; document_id: string; page: number; tag: string; raw: string }>) {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    await admin.from("knowledge_page_entities").insert(rows.slice(i, i + INSERT_BATCH).map((r) => ({ ...r, kind: ENTRY_KIND })));
  }
}

/** Read a document a person marked as a catalog: find its sections from
 *  its own text (a code repeating in a header or in table headings), one
 *  entry per section. When no sections can be found, say so on the mark —
 *  never invent them. */
export async function readCatalogDocument(admin: SupabaseClient, doc: DocRow, mark: CatalogMark): Promise<CatalogMark> {
  // The first two chunks of every page: where a header, an opening line
  // and the first table headings are.
  const { rows } = await fetchAllRows<{ page: number; seq: number; content: string }>((from, to) => admin
    .from("knowledge_chunks").select("page, seq, content").eq("document_id", doc.id).lte("seq", 1)
    .order("page", { ascending: true }).order("seq", { ascending: true }).range(from, to), 20_000);
  const byPage = new Map<number, string[]>();
  for (const r of rows) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r.content]);
  const tops = [...byPage].map(([page, parts]) => ({ page, text: parts[0] ?? "" }));
  const full = [...byPage].map(([page, parts]) => ({ page, text: parts.join("\n") }));
  const found = findSections(tops) ?? findSections(full);
  await admin.from("knowledge_page_entities").delete().eq("document_id", doc.id).eq("kind", ENTRY_KIND);
  const readAt = new Date().toISOString();
  if (byPage.size === 0) {
    return { ...mark, entries: 0, fields: [], method: CATALOG_METHOD, readAt, problem: "This document has no indexed text yet — it is read once indexing finishes." };
  }
  if (!found || found.ranges.length < 2) {
    return { ...mark, entries: 0, fields: [], method: CATALOG_METHOD, readAt,
      problem: "Couldn't find where one entry ends and the next begins: no code repeats in its page headers, footers or table headings. If each entry is its own file, mark the library instead." };
  }
  const records = sectionRecords(found.ranges, byPage, mark.name);
  await writeEntries(admin, records.map((rec) => ({
    org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id, page: rec.page, tag: rec.code, raw: JSON.stringify(rec.record),
  })));
  const fields = [...new Set(records.flatMap((r) => Object.keys(r.record.attrs ?? {})))].slice(0, 12);
  return { ...mark, entries: records.length, fields, method: CATALOG_METHOD, readAt, problem: undefined };
}

/** Read a library a person marked as a catalog: each document is an entry,
 *  its fields read from its first page. */
export async function readCatalogLibrary(admin: SupabaseClient, opts: { orgId: string; libraryId: string; mark: CatalogMark }): Promise<CatalogMark> {
  const { rows: docs } = await fetchAllRows<DocRow>((from, to) => admin
    .from("knowledge_documents").select("id, org_id, library_id, name, file_key, page_count")
    .eq("org_id", opts.orgId).eq("library_id", opts.libraryId).eq("status", "ready").order("id").range(from, to));
  const text = new Map<string, string[]>();
  for (let i = 0; i < docs.length; i += 200) {
    const { data } = await admin.from("knowledge_chunks").select("document_id, seq, content")
      .in("document_id", docs.slice(i, i + 200).map((d) => d.id)).eq("page", 1).lte("seq", 1).order("seq").limit(1000);
    for (const r of (data ?? []) as Array<{ document_id: string; content: string }>) text.set(r.document_id, [...(text.get(r.document_id) ?? []), r.content]);
  }
  const withText = docs.filter((d) => text.has(d.id));
  const { fields, entries } = setRecords(withText.map((d) => ({ id: d.id, name: d.name, text: text.get(d.id)!.join(" ") })), opts.mark.name);
  for (let i = 0; i < docs.length; i += 200) {
    await admin.from("knowledge_page_entities").delete().in("document_id", docs.slice(i, i + 200).map((d) => d.id)).eq("kind", ENTRY_KIND);
  }
  const byId = new Map(docs.map((d) => [d.id, d]));
  await writeEntries(admin, entries.map((e) => ({
    org_id: opts.orgId, library_id: opts.libraryId, document_id: e.documentId, page: 1, tag: e.code, raw: JSON.stringify(e.record),
  })).filter((r) => byId.has(r.document_id)));
  return {
    ...opts.mark, entries: entries.length, fields: fields.slice(0, 12), method: CATALOG_METHOD, readAt: new Date().toISOString(),
    problem: docs.length === 0 ? "No indexed documents in this library yet." : undefined,
  };
}

const libraryMarkOf = (aiFeatures: unknown): CatalogMark | null => {
  const m = (aiFeatures as { catalog?: CatalogMark } | null)?.catalog;
  return m && typeof m.name === "string" && m.name ? m : null;
};

async function saveLibraryMark(admin: SupabaseClient, libraryId: string, mark: CatalogMark | null) {
  const { data } = await admin.from("knowledge_libraries").select("ai_features").eq("id", libraryId).maybeSingle();
  const features = { ...((data?.ai_features ?? {}) as Record<string, unknown>) };
  if (mark) features.catalog = mark; else delete features.catalog;
  await admin.from("knowledge_libraries").update({ ai_features: features }).eq("id", libraryId);
}

/** Mark (or re-read) a catalog: a document whose sections are entries, or
 *  a library whose documents are. Returns the mark with what was found. */
export async function markCatalog(admin: SupabaseClient, opts: {
  orgId: string; libraryId: string; documentId?: string; name: string; by: string;
}): Promise<CatalogMark> {
  const mark: CatalogMark = { name: opts.name.trim().slice(0, 60), markedBy: opts.by, markedAt: new Date().toISOString(), entries: 0 };
  if (opts.documentId) {
    const { data: doc } = await admin.from("knowledge_documents").select("id, org_id, library_id, name, file_key, page_count")
      .eq("id", opts.documentId).eq("org_id", opts.orgId).maybeSingle();
    if (!doc) throw new Error("Document not found");
    const d = doc as DocRow;
    const before = (await profilesFor(admin, [d.id])).get(d.id);
    const read = await readCatalogDocument(admin, d, mark);
    const profile: DocProfile = before
      ? { ...before, type: "catalog", catalog: read }
      : {
        v: 1, type: "catalog", designation: null, title: d.name.replace(/\.pdf$/i, ""),
        purpose: `${read.name} — one entry per section`, covers: [], references: [],
        profiledAt: new Date().toISOString(), catalog: read,
      };
    await writeProfile(admin, d, profile);
    return read;
  }
  const read = await readCatalogLibrary(admin, { orgId: opts.orgId, libraryId: opts.libraryId, mark });
  await saveLibraryMark(admin, opts.libraryId, read);
  return read;
}

/** Remove a mark and the entries read for it. */
export async function unmarkCatalog(admin: SupabaseClient, opts: { orgId: string; libraryId: string; documentId?: string }): Promise<void> {
  if (opts.documentId) {
    const { data: doc } = await admin.from("knowledge_documents").select("id, org_id, library_id, name, file_key, page_count")
      .eq("id", opts.documentId).eq("org_id", opts.orgId).maybeSingle();
    if (!doc) return;
    await admin.from("knowledge_page_entities").delete().eq("document_id", opts.documentId).eq("kind", ENTRY_KIND);
    const p = (await profilesFor(admin, [opts.documentId])).get(opts.documentId);
    if (p) {
      const { catalog: _gone, ...rest } = p;
      await writeProfile(admin, doc as DocRow, { ...rest, type: rest.designation ? "standard" : "other" });
    }
    return;
  }
  const { rows: docs } = await fetchAllRows<{ id: string }>((from, to) => admin
    .from("knowledge_documents").select("id").eq("org_id", opts.orgId).eq("library_id", opts.libraryId).order("id").range(from, to));
  for (let i = 0; i < docs.length; i += 200) {
    await admin.from("knowledge_page_entities").delete().in("document_id", docs.slice(i, i + 200).map((d) => d.id)).eq("kind", ENTRY_KIND);
  }
  await saveLibraryMark(admin, opts.libraryId, null);
}

/** Every catalog marked in a library and the libraries linked to it. */
export interface CatalogListing { name: string; scope: "document" | "library"; documentId?: string; documentName?: string; libraryId: string; libraryName: string; mark: CatalogMark }
export async function listCatalogs(admin: SupabaseClient, opts: { orgId: string; libraryId: string }): Promise<CatalogListing[]> {
  const { data: links } = await admin.from("knowledge_library_links").select("linked_library_id").eq("library_id", opts.libraryId);
  const libIds = [opts.libraryId, ...((links ?? []) as Array<{ linked_library_id: string }>).map((l) => l.linked_library_id)];
  const { data: libs } = await admin.from("knowledge_libraries").select("id, name, ai_features").in("id", libIds).eq("org_id", opts.orgId);
  const libRows = (libs ?? []) as Array<{ id: string; name: string; ai_features: unknown }>;
  const libName = new Map(libRows.map((l) => [l.id, l.name]));
  const out: CatalogListing[] = [];
  for (const l of libRows) {
    const m = libraryMarkOf(l.ai_features);
    if (m) out.push({ name: m.name, scope: "library", libraryId: l.id, libraryName: l.name, mark: m });
  }
  const { rows: profRows } = await fetchAllRows<{ document_id: string; library_id: string; raw: string | null }>((from, to) => admin
    .from("knowledge_page_entities").select("document_id, library_id, raw")
    .in("library_id", libIds).eq("kind", "profile").eq("tag", "catalog").order("id").range(from, to));
  const docIds = profRows.map((r) => r.document_id);
  const names = new Map<string, string>();
  for (let i = 0; i < docIds.length; i += 200) {
    const { data } = await admin.from("knowledge_documents").select("id, name").in("id", docIds.slice(i, i + 200)).neq("status", "retired");
    for (const d of (data ?? []) as Array<{ id: string; name: string }>) names.set(d.id, d.name);
  }
  for (const r of profRows) {
    const p = parseProfile(r.raw);
    if (!p?.catalog || !names.has(r.document_id)) continue;
    out.push({ name: p.catalog.name, scope: "document", documentId: r.document_id, documentName: names.get(r.document_id), libraryId: r.library_id, libraryName: libName.get(r.library_id) ?? "Library", mark: p.catalog });
  }
  return out;
}

/** Re-read every marked catalog whose reader changed, or that was marked
 *  before its text was indexed. Text only, no AI — the nightly job's. */
export async function refreshMarkedCatalogs(admin: SupabaseClient, opts: { deadlineMs: number }): Promise<{ read: number; entries: number }> {
  let read = 0, entries = 0;
  const { rows: libs } = await fetchAllRows<{ id: string; org_id: string; ai_features: unknown }>((from, to) => admin
    .from("knowledge_libraries").select("id, org_id, ai_features").order("id").range(from, to));
  for (const l of libs) {
    if (Date.now() > opts.deadlineMs) break;
    const m = libraryMarkOf(l.ai_features);
    if (!m) continue;
    const { count } = await admin.from("knowledge_documents").select("id", { count: "exact", head: true }).eq("library_id", l.id).eq("status", "ready");
    if (m.method === CATALOG_METHOD && (count ?? 0) === m.entries) continue;
    const r = await readCatalogLibrary(admin, { orgId: l.org_id, libraryId: l.id, mark: m });
    await saveLibraryMark(admin, l.id, r);
    read++; entries += r.entries;
  }
  const { rows: profRows } = await fetchAllRows<{ document_id: string; raw: string | null }>((from, to) => admin
    .from("knowledge_page_entities").select("document_id, raw").eq("kind", "profile").eq("tag", "catalog").order("id").range(from, to));
  for (const r of profRows) {
    if (Date.now() > opts.deadlineMs) break;
    const p = parseProfile(r.raw);
    if (!p?.catalog || (p.catalog.method === CATALOG_METHOD && p.catalog.entries > 0)) continue;
    const { data: doc } = await admin.from("knowledge_documents").select("id, org_id, library_id, name, file_key, page_count")
      .eq("id", r.document_id).eq("status", "ready").maybeSingle();
    if (!doc) continue;
    const mark = await readCatalogDocument(admin, doc as DocRow, p.catalog);
    await writeProfile(admin, doc as DocRow, { ...p, catalog: mark });
    read++; entries += mark.entries;
  }
  return { read, entries };
}

/** Profiles for a set of documents, keyed by document id. */
export async function profilesFor(admin: SupabaseClient, docIds: string[]): Promise<Map<string, DocProfile>> {
  const out = new Map<string, DocProfile>();
  for (let i = 0; i < docIds.length; i += 200) {
    const { data } = await admin
      .from("knowledge_page_entities").select("document_id, raw")
      .in("document_id", docIds.slice(i, i + 200)).eq("kind", "profile").limit(1000);
    for (const r of (data ?? []) as Array<{ document_id: string; raw: string | null }>) {
      const p = parseProfile(r.raw);
      if (p) out.set(r.document_id, p);
    }
  }
  return out;
}

/** The catalog the asker may see: every profiled document in the asked and
 *  linked libraries, plus forms, checklists and piping specs from the rest
 *  of the org (they often live in their own library). Outside the asked
 *  libraries only upload-origin documents count — controlled-document
 *  mirrors there haven't been ACL-checked for this asker, so they stay out. */
export async function loadCatalog(admin: SupabaseClient, opts: {
  orgId: string; libraryIds: string[]; excludedDocIds: Set<string>;
}): Promise<CatalogEntry[]> {
  try {
    // Paged: one read stops at 1,000 — the 1,001st mapped document would
    // vanish from what the assistant knows.
    const { rows: profRows } = await fetchAllRows<{ document_id: string; library_id: string; raw: string | null }>((from, to) => admin
      .from("knowledge_page_entities").select("document_id, library_id, raw")
      .eq("org_id", opts.orgId).eq("kind", "profile").order("id").range(from, to), 50_000);
    if (profRows.length === 0) return [];
    const inScope = new Set(opts.libraryIds);
    const docIds = [...new Set(profRows.map((r) => r.document_id))];
    const docs = new Map<string, DocRow>();
    for (let i = 0; i < docIds.length; i += 300) {
      const { data } = await admin
        .from("knowledge_documents").select("id, org_id, library_id, name, file_key, page_count, source_document_id")
        .in("id", docIds.slice(i, i + 300)).neq("status", "retired");
      for (const d of (data ?? []) as DocRow[]) docs.set(d.id, d);
    }
    const libIds = [...new Set([...docs.values()].map((d) => d.library_id))];
    const { data: libs } = await admin.from("knowledge_libraries").select("id, name").in("id", libIds);
    const libName = new Map(((libs ?? []) as Array<{ id: string; name: string }>).map((l) => [l.id, l.name]));
    const out: CatalogEntry[] = [];
    for (const r of profRows) {
      const d = docs.get(r.document_id);
      const p = parseProfile(r.raw);
      if (!d || !p || opts.excludedDocIds.has(d.id)) continue;
      const local = inScope.has(d.library_id);
      const sharedKind = p.type === "form" || p.type === "checklist" || p.type === "catalog";
      if (!local && !(sharedKind && !d.source_document_id)) continue;
      out.push({
        documentId: d.id, libraryId: d.library_id, libraryName: libName.get(d.library_id) ?? "Library",
        name: d.name, fileKey: d.file_key, profile: p,
      });
    }
    return out;
  } catch {
    return [];   // catalog is context, never a reason an ask fails
  }
}

/** How a class's printed service matched the question: on the asker's own
 *  words, or only through a related term (a lead, not proof). */
export interface ServiceMatch { literal: string[]; leads: string[] }

const CLASS_STOP = new Set(["what", "which", "spec", "specs", "class", "classes", "should", "use", "for", "the", "and", "with", "line", "lines", "stream", "service", "is", "a", "an", "of", "in", "to", "do", "we", "i", "my", "our", "rating", "lb"]);

/** Classes whose rating is exactly `rating` (150 is not 1500). The asker's
 *  own words decide the order; a class found only through a related term
 *  ("wet H2S" for "sour") is kept, after them, and marked as a lead — the
 *  answer must find a passage before treating the two as the same. */
export function rankByRatingAndService<T extends { raw: string | null }>(rows: T[], rating: string, question: string): Array<T & { matched: ServiceMatch }> {
  const words = questionWords(question, CLASS_STOP);
  const leads = leadsFor(words);
  const has = (hay: string, t: string) => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(hay);
  const exact = new RegExp(`(^|[^0-9])${rating}([^0-9]|$)`);
  const scored: Array<{ r: T & { matched: ServiceMatch }; score: number }> = [];
  for (const r of rows) {
    let rec: EntryRecord;
    try { rec = JSON.parse(r.raw ?? "") as EntryRecord; } catch { continue; }
    if (!rec?.rating || !exact.test(rec.rating)) continue;
    const hay = [rec.service, ...Object.values(rec.attrs ?? {}), ...(rec.notes ?? [])].join(" ").toLowerCase();
    const matched = { literal: words.filter((w) => has(hay, w)), leads: leads.filter((t) => has(hay, t)) };
    scored.push({ r: { ...r, matched }, score: matched.literal.length * 10 + matched.leads.length });
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.r);
}

/** Catalog entries named in the conversation, as trusted facts. Same
 *  visibility rule as the catalog. */
export async function loadEntries(admin: SupabaseClient, opts: {
  orgId: string; libraryIds: string[]; excludedDocIds: Set<string>; text: string;
  match: (text: string, codes: string[]) => string[];
  /** The pressure class the question is about ("150"): with no class code
   *  named, the classes OF that rating are looked up, best service first. */
  rating?: string | null;
  /** The question alone — classes are ranked on the asker's own words, not
   *  words an earlier answer used. */
  question?: string;
}): Promise<Array<EntryRecord & { documentId: string; documentName: string; page: number; matched?: ServiceMatch }>> {
  try {
    const { rows: tagRows } = await fetchAllRows<{ tag: string }>((from, to) => admin
      .from("knowledge_page_entities").select("tag")
      .eq("org_id", opts.orgId).eq("kind", ENTRY_KIND).order("id").range(from, to), 50_000);
    const codes = [...new Set(tagRows.map((r) => r.tag))];
    const wanted = opts.match(opts.text, codes);
    type Row = { document_id: string; library_id: string; page: number; tag: string; raw: string | null; matched?: ServiceMatch };
    let recs: Row[] = [];
    if (wanted.length > 0) {
      const { data: rows } = await admin
        .from("knowledge_page_entities").select("document_id, library_id, page, tag, raw")
        .eq("org_id", opts.orgId).eq("kind", ENTRY_KIND).in("tag", wanted).limit(200);
      recs = (rows ?? []) as Row[];
    } else if (opts.rating && codes.length > 0) {
      // "Which spec for 150 class sour gas": no code named — find the classes
      // rated for that class, and rank them by how well their service,
      // material and notes match the question's words.
      const { rows } = await fetchAllRows<Row>((from, to) => admin
        .from("knowledge_page_entities").select("document_id, library_id, page, tag, raw")
        .eq("org_id", opts.orgId).eq("kind", ENTRY_KIND).ilike("raw", `%${opts.rating}%`).order("id").range(from, to), 20_000);
      // Every class whose printed service carries the asker's words; then a
      // few found only through a related term, marked as leads; and when
      // nothing matches at all, a handful of the rating's classes so the
      // answer can say plainly that none names that service.
      const ranked = rankByRatingAndService(rows, opts.rating, opts.question ?? opts.text);
      const literal = ranked.filter((r) => r.matched.literal.length > 0);
      const leadOnly = ranked.filter((r) => r.matched.literal.length === 0 && r.matched.leads.length > 0);
      recs = literal.length + leadOnly.length > 0 ? [...literal.slice(0, 10), ...leadOnly.slice(0, 4)] : ranked.slice(0, 6);
    }
    if (recs.length === 0) return [];
    const { data: docRows } = await admin
      .from("knowledge_documents").select("id, name, library_id, source_document_id")
      .in("id", [...new Set(recs.map((r) => r.document_id))]).neq("status", "retired");
    const docs = new Map(((docRows ?? []) as Array<{ id: string; name: string; library_id: string; source_document_id: string | null }>).map((d) => [d.id, d]));
    const inScope = new Set(opts.libraryIds);
    const out: Array<EntryRecord & { documentId: string; documentName: string; page: number; matched?: ServiceMatch; order: number }> = [];
    for (const r of recs) {
      const d = docs.get(r.document_id);
      if (!d || opts.excludedDocIds.has(d.id)) continue;
      if (!inScope.has(d.library_id) && d.source_document_id) continue;
      try {
        const rec = JSON.parse(r.raw ?? "") as EntryRecord;
        if (rec?.code) out.push({ ...rec, documentId: d.id, documentName: d.name.replace(/\.pdf$/i, ""), page: r.page, matched: r.matched, order: out.length });
      } catch { /* skip a bad row */ }
    }
    // Best match first; a class split across pages keeps its pages together.
    const first = new Map<string, number>();
    for (const r of out) if (!first.has(r.code)) first.set(r.code, r.order);
    return out
      .sort((a, b) => first.get(a.code)! - first.get(b.code)! || a.page - b.page)
      .slice(0, 14)
      .map(({ order: _order, ...r }) => r);
  } catch {
    return [];
  }
}
