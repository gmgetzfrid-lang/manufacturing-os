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
import { questionWords, leadsFor } from "@/lib/searchLeads";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { findRunningKey, findParenKeys } from "@/lib/sectionTemplate";
import { classMentions } from "@/lib/pressureClass";
import { inSlices } from "@/lib/inSlices";
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

/** Spec books whose sections can be found from their own text — a running
 *  header, or the code repeated in each table heading ("Fitting (AAAA1)")
 *  — are mapped class by class from the TEXT, with no AI: each class's
 *  code, pages, opening line (its service description) and rating (the
 *  class most written on its pages). Fast and free, so a 2,000-page book
 *  is mapped in one pass. Returns null when no sections can be found. */
async function extractPipeClassesFromText(
  admin: SupabaseClient, _conn: CatalogConn, doc: DocRow, profile: DocProfile, _deadlineMs: number,
): Promise<number | null> {
  // The first two chunks of every page: where a header, a service line and
  // the first table headings are.
  const { rows } = await fetchAllRows<{ page: number; seq: number; content: string }>((from, to) => admin
    .from("knowledge_chunks").select("page, seq, content").eq("document_id", doc.id).lte("seq", 1)
    .order("page", { ascending: true }).order("seq", { ascending: true }).range(from, to), 20_000);
  const byPage = new Map<number, string[]>();
  for (const r of rows) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r.content]);
  const tops = [...byPage].map(([page, parts]) => ({ page, text: parts[0] ?? "" }));
  const full = [...byPage].map(([page, parts]) => ({ page, text: parts.join("\n") }));
  const found = findRunningKey(tops) ?? findParenKeys(full);
  if (!found || found.ranges.length < 2) return null;

  const records = sectionRecords(found.ranges, byPage);
  await admin.from("knowledge_page_entities").delete().eq("document_id", doc.id).eq("kind", "pipe_class");
  for (let i = 0; i < records.length; i += 300) {
    await admin.from("knowledge_page_entities").insert(records.slice(i, i + 300).map((rec) => ({
      org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
      page: rec.page, kind: "pipe_class", tag: rec.code, raw: JSON.stringify(rec.record),
    })));
  }
  const pageCount = doc.page_count ?? full.length;
  profile.pipeSpec = { pagesDone: pageCount, pageCount, classes: records.length, done: true, method: "text-v2" };
  await writeProfile(admin, doc, profile);
  return pageCount;
}

/** One record per section: code, first page, opening line, dominant rating. */
export function sectionRecords(ranges: Array<{ key: string; first: number; last: number }>, byPage: Map<number, string[]>) {
  const seen = new Set<string>();
  const out: Array<{ code: string; page: number; record: PipeClassRecord }> = [];
  for (const r of ranges) {
    const code = r.key.toUpperCase().slice(0, 30);
    if (seen.has(`${code}:${r.first}`)) continue;
    seen.add(`${code}:${r.first}`);
    const firstText = (byPage.get(r.first) ?? [])[0] ?? "";
    // The opening line: the text before the first table heading, or the
    // first sentence — in most books, the class's service description.
    const opening = firstText.replace(/\s+/g, " ").trim()
      .split(/\s(?=[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)? \([A-Z0-9][A-Z0-9.-]{2,11}\))|(?<=[.;])\s/)[0]
      .slice(0, 240);
    let text = "";
    for (let p = r.first; p <= r.last; p++) text += " " + (byPage.get(p) ?? []).join(" ");
    const mentions = classMentions(text);
    out.push({
      code, page: r.first,
      record: {
        code,
        ...(opening ? { service: opening.replace(/^services?\s*:\s*/i, "") } : {}),
        ...(mentions[0] ? { rating: `Class ${mentions[0][0]}` } : {}),
        rows: [],
        notes: [
          `Pages ${r.first}–${r.last}`,
          ...(mentions.length ? [`Classes written on its pages: ${mentions.slice(0, 4).map(([n, k]) => `${n} ×${k}`).join(", ")}`] : []),
        ],
      },
    });
  }
  return out;
}

/** Extract the next pages' pipe classes. Returns pages processed this call. */
export async function extractPipeClassesStep(
  admin: SupabaseClient, conn: CatalogConn, doc: DocRow, profile: DocProfile, deadlineMs: number,
): Promise<number> {
  if (!doc.file_key) return 0;
  // Text first: a spec book with a running header is read class by class
  // from its text. Image reading is the fallback for books without one.
  const viaText = await extractPipeClassesFromText(admin, conn, doc, profile, deadlineMs);
  if (viaText !== null) return viaText;
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

/** Index the piping-spec books of a library — and only those — without
 *  mapping every document. A spec book is recognised by its CONTENT (pages
 *  dense with material specs, schedules, ratings), not its name, so any
 *  company's books are found however they're titled. Resumable. */
export async function drainPipeSpecs(admin: SupabaseClient, opts: {
  orgId: string; libraryId: string; conn: CatalogConn; deadlineMs: number;
}): Promise<{ pipePages: number; remaining: number; books: number; classes: number }> {
  const { rows: docList } = await fetchAllRows<DocRow>((from, to) => admin
    .from("knowledge_documents").select("id, org_id, library_id, name, file_key, page_count")
    .eq("org_id", opts.orgId).eq("library_id", opts.libraryId).eq("status", "ready")
    .gte("page_count", 10).order("id").range(from, to));
  const profiles = await profilesFor(admin, docList.map((d) => d.id));
  const books: DocRow[] = [];
  const unprofiled: DocRow[] = [];
  for (const d of docList) {
    const p = profiles.get(d.id);
    if (p?.type === "pipe_spec") books.push(d);
    // Unprofiled, or profiled as something else but book-sized: the text
    // decides. A spec book filed as a "standard" was never read before.
    else if ((!p && (d.page_count ?? 0) >= 30) || (p && (d.page_count ?? 0) >= 100)) unprofiled.push(d);
  }
  // Big, unprofiled documents: read the tops of their first pages and keep
  // the ones that read like a spec book.
  await inSlices(unprofiled, 1, 6, async ([d]) => {
    if (Date.now() > opts.deadlineMs - 30_000) return;
    const { data } = await admin.from("knowledge_chunks").select("content")
      .eq("document_id", d.id).eq("seq", 0).order("page", { ascending: true }).limit(40);
    const tops = ((data ?? []) as Array<{ content: string }>).map((r) => r.content);
    const dense = tops.filter((t) => (t.match(new RegExp(PIPE_PAGE_RE.source, "gi")) ?? []).length >= 3).length;
    const before = profiles.get(d.id);
    // A document already filed as something else becomes a spec book only
    // when its sections can be found from its text — never on word counts
    // alone (a materials standard is dense with ASTM numbers too).
    if (before && tops.length >= 10 && dense / tops.length >= 0.3) {
      const { data: head } = await admin.from("knowledge_chunks").select("page, seq, content")
        .eq("document_id", d.id).lte("seq", 1).lte("page", 80).order("page").order("seq").limit(200);
      const pages = new Map<number, string[]>();
      for (const r of (head ?? []) as Array<{ page: number; content: string }>) pages.set(r.page, [...(pages.get(r.page) ?? []), r.content]);
      const tp = [...pages].map(([page, parts]) => ({ page, text: parts[0] ?? "" }));
      const fp = [...pages].map(([page, parts]) => ({ page, text: parts.join("\n") }));
      if (!(findRunningKey(tp) ?? findParenKeys(fp))) return;
    }
    if (tops.length >= 10 && dense / tops.length >= 0.3) {
      const profile: DocProfile = before
        ? { ...before, type: "pipe_spec" }
        : {
          v: 1, type: "pipe_spec", designation: null, title: d.name.replace(/\.pdf$/i, ""),
          purpose: "Piping material specifications — one piping class per section",
          covers: [], references: [], profiledAt: new Date().toISOString(),
        };
      await writeProfile(admin, d, profile);
      profiles.set(d.id, profile);
      books.push(d);
    }
  });
  let pipePages = 0;
  for (const d of books) {
    if (Date.now() > opts.deadlineMs - 25_000) break;
    const p = profiles.get(d.id)!;
    // Done — unless an earlier reader finished with nothing recorded, or
    // read it before books were mapped from their text.
    if (p.pipeSpec?.done && p.pipeSpec.classes > 0) continue;
    if (p.pipeSpec?.done) p.pipeSpec = undefined;
    try { pipePages += await extractPipeClassesStep(admin, opts.conn, d, p, opts.deadlineMs); } catch { /* next call retries */ }
  }
  const remaining = books.filter((d) => !profiles.get(d.id)?.pipeSpec?.done).length;
  const classes = books.reduce((n, d) => n + (profiles.get(d.id)?.pipeSpec?.classes ?? 0), 0);
  return { pipePages, remaining, books: books.length, classes };
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

/** How a class's printed service matched the question: on the asker's own
 *  words, or only through a related term (a lead, not proof). */
export interface ServiceMatch { literal: string[]; leads: string[] }

const CLASS_STOP = new Set(["what", "which", "piping", "spec", "specs", "class", "classes", "should", "use", "for", "the", "and", "with", "line", "lines", "stream", "service", "pipe", "is", "a", "an", "of", "in", "to", "do", "we", "i", "my", "our", "rating", "lb"]);

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
    let rec: PipeClassRecord;
    try { rec = JSON.parse(r.raw ?? "") as PipeClassRecord; } catch { continue; }
    if (!rec?.rating || !exact.test(rec.rating)) continue;
    const hay = [rec.service, rec.material, ...(rec.notes ?? [])].join(" ").toLowerCase();
    const matched = { literal: words.filter((w) => has(hay, w)), leads: leads.filter((t) => has(hay, t)) };
    scored.push({ r: { ...r, matched }, score: matched.literal.length * 10 + matched.leads.length });
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.r);
}

/** Pipe classes named in the conversation, as trusted facts. Same
 *  visibility rule as the catalog. */
export async function loadPipeClasses(admin: SupabaseClient, opts: {
  orgId: string; libraryIds: string[]; excludedDocIds: Set<string>; text: string;
  match: (text: string, codes: string[]) => string[];
  /** The pressure class the question is about ("150"): with no class code
   *  named, the classes OF that rating are looked up, best service first. */
  rating?: string | null;
  /** The question alone — classes are ranked on the asker's own words, not
   *  words an earlier answer used. */
  question?: string;
}): Promise<Array<PipeClassRecord & { documentId: string; documentName: string; page: number; matched?: ServiceMatch }>> {
  try {
    const { rows: tagRows } = await fetchAllRows<{ tag: string }>((from, to) => admin
      .from("knowledge_page_entities").select("tag")
      .eq("org_id", opts.orgId).eq("kind", "pipe_class").order("id").range(from, to), 50_000);
    const codes = [...new Set(tagRows.map((r) => r.tag))];
    const wanted = opts.match(opts.text, codes);
    type Row = { document_id: string; library_id: string; page: number; tag: string; raw: string | null; matched?: ServiceMatch };
    let recs: Row[] = [];
    if (wanted.length > 0) {
      const { data: rows } = await admin
        .from("knowledge_page_entities").select("document_id, library_id, page, tag, raw")
        .eq("org_id", opts.orgId).eq("kind", "pipe_class").in("tag", wanted).limit(200);
      recs = (rows ?? []) as Row[];
    } else if (opts.rating && codes.length > 0) {
      // "Which spec for 150 class sour gas": no code named — find the classes
      // rated for that class, and rank them by how well their service,
      // material and notes match the question's words.
      const { rows } = await fetchAllRows<Row>((from, to) => admin
        .from("knowledge_page_entities").select("document_id, library_id, page, tag, raw")
        .eq("org_id", opts.orgId).eq("kind", "pipe_class").ilike("raw", `%${opts.rating}%`).order("id").range(from, to), 20_000);
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
    const out: Array<PipeClassRecord & { documentId: string; documentName: string; page: number; matched?: ServiceMatch; order: number }> = [];
    for (const r of recs) {
      const d = docs.get(r.document_id);
      if (!d || opts.excludedDocIds.has(d.id)) continue;
      if (!inScope.has(d.library_id) && d.source_document_id) continue;
      try {
        const rec = JSON.parse(r.raw ?? "") as PipeClassRecord;
        if (rec && Array.isArray(rec.rows)) out.push({ ...rec, documentId: d.id, documentName: d.name.replace(/\.pdf$/i, ""), page: r.page, matched: r.matched, order: out.length });
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
