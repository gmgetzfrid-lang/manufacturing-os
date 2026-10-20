// lib/knowledgeCatalogServer.ts — SERVER-ONLY. Builds and reads the library
// catalog (see lib/knowledgeCatalog.ts for what and why).
//
// Two jobs, both resumable and bounded per invocation like ingestion:
//   1. PROFILE every ready document that has none: one fast-tier call on its
//      first pages' text (plus, for PDFs with fillable fields, the field
//      names read straight from the file). Works on documents already
//      indexed — no re-index needed to build a catalog.
//   2. For piping specs, EXTRACT PIPE CLASSES page by page from the printed
//      page images (tables survive images; they rarely survive text layers),
//      a couple of pages per call, progress kept on the profile.
//
// Billing: the triggering user's own key, fast tier, metered as
// knowledgeCatalog — same model as vision indexing.

import type { SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFSignature } from "pdf-lib";
import { callAiModel, type AiProviderId } from "@/lib/ai/providerCall";
import type { AiUsage } from "@/lib/ai/pricing";
import { VISION_MODEL } from "@/lib/knowledgeVision";
import { fetchBytes } from "@/lib/r2Bytes";
import { renderPdfPages } from "@/lib/knowledgePageRender";
import {
  normalizeProfile, normalizePipeClasses, parseProfile, parseModelJson,
  type CatalogEntry, type DocProfile, type FieldKind, type PipeClassRecord,
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
  "- pipe_spec: a piping class / material specification — tables listing, per pipe class, the components, sizes and ASTM/API specs\n" +
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

const PIPE_SYSTEM =
  "You read pages of a piping material specification. Extract every PIPE CLASS whose component table appears " +
  "on these pages. Reply with ONLY JSON:\n" +
  '{"classes": [{"code": "...", "page": 0, "service": "...", "rating": "...", "material": "...", ' +
  '"corrosionAllowance": "...", "rows": [{"component": "...", "size": "...", "spec": "...", "details": "...", "notes": "..."}], "notes": ["..."]}]}\n' +
  "- code: the class designation exactly as printed (\"1S4\", \"A1A\", \"CS-150-01\"). page: the page number it is on.\n" +
  "- component: Pipe, Nipple, Elbow, Tee, Reducer, Cap, Flange, Blind, Gasket, Stud bolt, Nut, Valve-Gate, Valve-Ball, Branch…\n" +
  "- size: the size range as printed (\"1/2-1-1/2\", \"2-24\").\n" +
  "- spec: material specification and grade AS PRINTED, keeping product-form words — Seamless, Welded, ERW, EFW, " +
  "SMLS, WLD (\"ASTM A312 TP304 SMLS\", \"ASTM A106 Gr B\").\n" +
  "- details: schedule / wall, pressure class, end prep, facing (\"Sch 40S, BW\", \"Cl 150 RF WN\").\n" +
  "- notes: the row's note text or note numbers; class-level notes go in the class \"notes\" list, quoted.\n" +
  "Copy exactly; never infer a value that isn't printed. A class continued from an earlier page still gets its " +
  "rows here with its code. No class table on these pages → {\"classes\": []}.";

/** A page likely holds a pipe-class table: material specs and size/class words. */
const PIPE_PAGE_RE = /\b(A\s?\d{2,3}|B16\.\d+|API\s?(5L|6D|600|602)|SCH(EDULE)?|SMLS|SEAMLESS|CLASS\s*\d{3,4}|RATING)\b/i;

/** Extract the next pages' pipe classes. Returns pages processed this call. */
export async function extractPipeClassesStep(
  admin: SupabaseClient, conn: CatalogConn, doc: DocRow, profile: DocProfile, deadlineMs: number,
): Promise<number> {
  if (!doc.file_key) return 0;
  const state = profile.pipeSpec ?? { pagesDone: 0, pageCount: doc.page_count ?? 0, classes: 0, done: false };
  // Candidate pages from the indexed text: cheap, and skips cover pages,
  // revision logs and prose sections.
  const { data: rows } = await admin
    .from("knowledge_chunks").select("page, content")
    .eq("document_id", doc.id).gt("page", state.pagesDone)
    .order("page", { ascending: true }).limit(400);
  const pageHits = new Map<number, number>();
  for (const r of (rows ?? []) as Array<{ page: number; content: string }>) {
    const n = (r.content.match(new RegExp(PIPE_PAGE_RE.source, "gi")) ?? []).length;
    pageHits.set(r.page, (pageHits.get(r.page) ?? 0) + n);
  }
  const candidates = [...pageHits.entries()].filter(([, n]) => n >= 3).map(([p]) => p).sort((a, b) => a - b);
  let processed = 0;
  let bytes: Uint8Array | null = null;
  while (candidates.length > 0 && Date.now() < deadlineMs - 25_000) {
    const pages = candidates.splice(0, 2);
    if (!bytes) bytes = new Uint8Array(await fetchBytes(doc.file_key));
    const images = await renderPdfPages(bytes, pages, 2);
    if (images.length === 0) { state.pagesDone = pages[pages.length - 1]; continue; }
    const text = await callFast(conn, {
      system: PIPE_SYSTEM,
      user: `Pages attached in order: ${images.map((im, i) => `image ${i + 1} = page ${im.page}`).join(", ")}.`,
      images: images.map((im) => ({ base64: im.base64, mediaType: im.mediaType })),
      maxTokens: 6000,
      timeoutMs: Math.max(10_000, deadlineMs - Date.now() - 5_000),
    });
    const parsed = parseModelJson(text);
    const classes = normalizePipeClasses(parsed);
    const pageOf = (c: Record<string, unknown> | undefined) => {
      const p = Number(c?.page);
      return pages.includes(p) ? p : pages[0];
    };
    const rawList = Array.isArray(parsed?.classes) ? parsed!.classes as Array<Record<string, unknown>> : [];
    if (classes.length > 0) {
      // Re-runs of the same pages replace, never duplicate.
      await admin.from("knowledge_page_entities").delete()
        .eq("document_id", doc.id).eq("kind", "pipe_class").in("page", pages);
      await admin.from("knowledge_page_entities").insert(classes.map((c) => ({
        org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
        page: pageOf(rawList.find((r) => String(r.code ?? "").toUpperCase() === c.code)),
        kind: "pipe_class", tag: c.code, raw: JSON.stringify(c),
      })));
      state.classes += classes.length;
    }
    state.pagesDone = pages[pages.length - 1];
    processed += pages.length;
  }
  state.done = candidates.length === 0;
  profile.pipeSpec = state;
  await writeProfile(admin, doc, profile);
  return processed;
}

/** One bounded pass over a library: profile what's unprofiled, then advance
 *  pipe-class extraction. Resumable — call again until remaining is 0. */
export async function drainCatalog(admin: SupabaseClient, opts: {
  orgId: string; libraryId: string; conn: CatalogConn; deadlineMs: number; documentId?: string;
}): Promise<{ profiled: number; pipePages: number; remaining: number; failed: number }> {
  const { data: lib } = await admin
    .from("knowledge_libraries").select("ai_features").eq("id", opts.libraryId).eq("org_id", opts.orgId).maybeSingle();
  const libraryKind = String(((lib?.ai_features ?? {}) as Record<string, unknown>).kind ?? "") || null;
  let docQuery = admin
    .from("knowledge_documents").select("id, org_id, library_id, name, file_key, page_count")
    .eq("org_id", opts.orgId).eq("library_id", opts.libraryId).eq("status", "ready");
  if (opts.documentId) docQuery = docQuery.eq("id", opts.documentId);
  const { data: docs } = await docQuery.limit(2000);
  const docList = (docs ?? []) as DocRow[];
  const profiles = await profilesFor(admin, docList.map((d) => d.id));

  let profiled = 0;
  let pipePages = 0;
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
  for (const d of docList) {
    if (Date.now() > opts.deadlineMs - 25_000) break;
    const p = profiles.get(d.id);
    if (!p || p.type !== "pipe_spec" || p.pipeSpec?.done) continue;
    try { pipePages += await extractPipeClassesStep(admin, opts.conn, d, p, opts.deadlineMs); } catch { failed++; }
  }
  const remaining = docList.filter((d) => {
    const p = profiles.get(d.id);
    return !p || (p.type === "pipe_spec" && !p.pipeSpec?.done);
  }).length;
  return { profiled, pipePages, remaining, failed };
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
    const { data: rows } = await admin
      .from("knowledge_page_entities").select("document_id, library_id, raw")
      .eq("org_id", opts.orgId).eq("kind", "profile").limit(5000);
    const profRows = (rows ?? []) as Array<{ document_id: string; library_id: string; raw: string | null }>;
    if (profRows.length === 0) return [];
    const inScope = new Set(opts.libraryIds);
    const docIds = [...new Set(profRows.map((r) => r.document_id))];
    const docs = new Map<string, DocRow>();
    for (let i = 0; i < docIds.length; i += 300) {
      const { data } = await admin
        .from("knowledge_documents").select("id, org_id, library_id, name, file_key, page_count, source_document_id")
        .in("id", docIds.slice(i, i + 300));
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
      const sharedKind = p.type === "form" || p.type === "checklist" || p.type === "pipe_spec";
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

/** Pipe classes named in the conversation, as trusted facts. Same
 *  visibility rule as the catalog. */
export async function loadPipeClasses(admin: SupabaseClient, opts: {
  orgId: string; libraryIds: string[]; excludedDocIds: Set<string>; text: string;
  match: (text: string, codes: string[]) => string[];
}): Promise<Array<PipeClassRecord & { documentId: string; documentName: string; page: number }>> {
  try {
    const { data: tagRows } = await admin
      .from("knowledge_page_entities").select("tag")
      .eq("org_id", opts.orgId).eq("kind", "pipe_class").limit(5000);
    const codes = [...new Set(((tagRows ?? []) as Array<{ tag: string }>).map((r) => r.tag))];
    const wanted = opts.match(opts.text, codes);
    if (wanted.length === 0) return [];
    const { data: rows } = await admin
      .from("knowledge_page_entities").select("document_id, library_id, page, tag, raw")
      .eq("org_id", opts.orgId).eq("kind", "pipe_class").in("tag", wanted).limit(200);
    const recs = (rows ?? []) as Array<{ document_id: string; library_id: string; page: number; tag: string; raw: string | null }>;
    const { data: docRows } = await admin
      .from("knowledge_documents").select("id, name, library_id, source_document_id")
      .in("id", [...new Set(recs.map((r) => r.document_id))]);
    const docs = new Map(((docRows ?? []) as Array<{ id: string; name: string; library_id: string; source_document_id: string | null }>).map((d) => [d.id, d]));
    const inScope = new Set(opts.libraryIds);
    const out: Array<PipeClassRecord & { documentId: string; documentName: string; page: number }> = [];
    for (const r of recs) {
      const d = docs.get(r.document_id);
      if (!d || opts.excludedDocIds.has(d.id)) continue;
      if (!inScope.has(d.library_id) && d.source_document_id) continue;
      try {
        const rec = JSON.parse(r.raw ?? "") as PipeClassRecord;
        if (rec && Array.isArray(rec.rows)) out.push({ ...rec, documentId: d.id, documentName: d.name.replace(/\.pdf$/i, ""), page: r.page });
      } catch { /* skip a bad row */ }
    }
    // A class split across pages: keep its pages in order.
    return out.sort((a, b) => a.code.localeCompare(b.code) || a.page - b.page).slice(0, 12);
  } catch {
    return [];
  }
}
