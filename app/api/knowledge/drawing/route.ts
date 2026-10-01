// /api/knowledge/drawing — the deterministic answers layer for drawing
// libraries. Counting vessels or auditing off-page references is DATA work,
// not retrieval work — this route computes from knowledge_page_entities:
//
//   GET  ?orgId&libraryId&action=census   → equipment census by category,
//                                           drawing-ref audit (resolved vs
//                                           missing), suggestions
//   GET  ?orgId&libraryId&action=export   → the equipment register as CSV
//                                           (opens straight into Excel)
//   POST { orgId, libraryId, action:"record-audit" }
//                                         → recompute the audit and COMMIT a
//                                           verdict per sheet to
//                                           drawing_audit_logs, keyed by
//                                           (org, library, sheet, revision).
//                                           A sheet already recorded at the
//                                           revision in front of it (with
//                                           anything but `skipped`), from
//                                           the index it and its neighbours
//                                           hold now, is NOT
//                                           re-audited — the response lists
//                                           it as already recorded (DWG-13);
//                                           one whose revision is unknown
//                                           ("") always is. A verdict that
//                                           waits on a sheet not read whole
//                                           for now is provisional, and never
//                                           overwrites a settled one, under
//                                           any revision
//   POST { orgId, libraryId, action:"rebuild", cursor? }
//                                         → re-extract everything through
//                                           the ONE reset of a document's
//                                           derived index (resetKnowledgeIndex,
//                                           DEC-58): under each document's
//                                           ingest claim, the row is queued
//                                           with every counter zeroed, then
//                                           chunks, page entities and machine
//                                           mentions go; the page's
//                                           auto-indexer re-runs. A caller
//                                           that sends no cursor continues
//                                           from where its last call stopped
//                                           (kept on the library row)
//
// ACL: entities mirror controlled documents — results exclude every doc the
// CALLER can't read, same engine as the ask route. Fails closed.
//
// Every read here pages to exhaustion (DWG-11): PostgREST caps a response at
// its max-rows (1,000 by default) and returns the cut page WITHOUT an error,
// so a `.limit(50000)` read quietly dropped whole sheets from a census the
// panel calls exact. The census comes from a database roll-up (20261124's
// drawing_entity_rollup) where it exists, and from raw rows otherwise; past
// maxIndexRows() the read stops at a whole document and says so — the
// result is marked partial, and the audit refuses to record from it.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { TAG_ENTITY_KINDS } from "@/lib/knowledgeEntityKinds";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import { resetKnowledgeIndex } from "@/lib/knowledgeIngest";
import {
  buildEquipmentCensus, auditDrawingRefs, auditOpcBoxes, drawingRefTargets, equipmentRegisterCsv,
  parseUnitMap, parsePrefixMap, declaredSheetIdentity, sheetIdentities, sheetDrawingNumbers, rollUpEntities,
  DRAWING_MAX_LOWERCASE_RATIO, THIN_PAGE_MAX_CHARS, type EntityRollupRow,
} from "@/lib/drawingText";
import { loadCodebookAdmin, codebookToDecoderText } from "@/lib/codebookServer";
import {
  verdictsForSheets, verdictRows, sheetsNeedingAudit, seriesHeldBySet, seriesNotJudged,
  missingWithinHeldSeries, missingUnreadInScope, replaceDecision, storedProvisional, mergeVerdictsByKey, awaitingFiled,
  capWaitingOn, indexFingerprint, verdictBasis, digest, WAITING_NAMES_MAX,
  type AuditSheet, type SheetVerdict,
} from "@/lib/drawingAuditLog";

export const runtime = "nodejs";
export const maxDuration = 60;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function authUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  return error || !user ? null : user;
}

type DbError = { code?: string; message: string } | null;
type EntityRow = { document_id: string; page: number; kind: string; tag: string; raw?: string | null };
type DocRow = {
  id: string; name: string; source_document_id: string | null; status: string;
  source_version_id?: string | null; source_rev?: string | null;
  page_count?: number | null; pages_indexed?: number | null; vision_pages?: number | null;
  error?: string | null;
  /** 20261122 — absent on a database that has not applied it. */
  vision_failed_pages?: number[] | null; vision_retry_after?: string | null;
  vision_partial_accepted?: boolean | null;
};
type TextStats = { chunks: number; chars: number; lower: number; upper: number };

/** PostgREST returns at most this many rows per request (max-rows). */
const PAGE_ROWS = 1000;
/** A read stops here (at a whole document) and reports itself partial,
 *  rather than run past the invocation's deadline. Roll-up rows (one per
 *  sheet, kind and tag) on the aggregate path; raw rows on the fallback.
 *  KNOWLEDGE_INDEX_MAX_ROWS lowers or raises it for one deployment (a
 *  slower database, a larger plan's longer deadline). */
const MAX_INDEX_ROWS_DEFAULT = 100_000;
const maxIndexRows = (): number => {
  const n = Number(process.env.KNOWLEDGE_INDEX_MAX_ROWS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : MAX_INDEX_ROWS_DEFAULT;
};
/** Documents per IN() list. */
const DOC_SLICE = 50;

const isMissingColumn = (e: DbError) =>
  !!e && (e.code === "42703" || e.code === "PGRST204" || /column .* does not exist/i.test(e.message));
const isMissingTable = (e: DbError) =>
  !!e && (e.code === "42P01" || /relation .* does not exist/i.test(e.message));
const isMissingFunction = (e: DbError) =>
  !!e && (e.code === "PGRST202" || e.code === "42883" || /could not find the function|function .* does not exist/i.test(e.message));

type PageResult<T> = { data: T[] | null; error: DbError; count?: number | null };

/** Read one ordered query to exhaustion, window by window: an exact count on
 *  the first window, each next window starting where the rows actually
 *  returned end — complete whatever max-rows is set to. Stops at `cap`. */
async function readAllPages<T>(
  page: (from: number, to: number, withCount: boolean) => PromiseLike<PageResult<T>>,
  cap: number,
): Promise<{ rows: T[]; error: DbError; capped: boolean }> {
  const rows: T[] = [];
  let total: number | null = null;
  for (let from = 0; ;) {
    const res = await page(from, from + PAGE_ROWS - 1, total === null);
    if (res.error) return { rows: [], error: res.error, capped: false };
    if (total === null) total = typeof res.count === "number" ? res.count : Number.POSITIVE_INFINITY;
    const batch = res.data ?? [];
    rows.push(...batch);
    if (batch.length === 0 || rows.length >= total) return { rows, error: null, capped: false };
    if (rows.length >= cap) return { rows, error: null, capped: true };
    from += batch.length;
  }
}

/** The library's documents the caller may read (ACL fails closed). */
async function loadVisibleDocs(orgId: string, userId: string, libraryId: string): Promise<{
  docs: DocRow[]; error?: string;
}> {
  const principal = await loadPrincipal(orgId, userId);
  if (!principal) return { docs: [], error: "Not a member of this workspace" };

  const base = "id, name, source_document_id, source_version_id, source_rev, status, page_count, pages_indexed, vision_pages, error";
  const read = (cols: string) => readAllPages<DocRow>((from, to, withCount) => supabaseAdmin
    .from("knowledge_documents")
    .select(cols, withCount ? { count: "exact" } : undefined)
    .eq("library_id", libraryId).eq("org_id", orgId)
    .order("id", { ascending: true })
    .range(from, to) as unknown as PromiseLike<PageResult<DocRow>>, Number.POSITIVE_INFINITY);
  let res = await read(`${base}, vision_failed_pages, vision_retry_after, vision_partial_accepted`);
  // Before 20261122 the vision-retry columns do not exist yet.
  if (res.error && isMissingColumn(res.error)) res = await read(base);
  if (res.error) return { docs: [], error: res.error.message };
  let docs = res.rows;

  // ACL: drop mirrors of controlled docs the caller can't read (fail closed).
  const linked = docs.filter((d) => d.source_document_id);
  if (linked.length > 0) {
    try {
      const readable = await readableControlledDocIds(
        principal, [...new Set(linked.map((d) => d.source_document_id as string))],
      );
      docs = docs.filter((d) => !d.source_document_id || readable.has(d.source_document_id));
    } catch {
      docs = docs.filter((d) => !d.source_document_id);
    }
  }
  return { docs };
}

interface IndexRead {
  /** Per sheet, kind and tag: occurrences, first page, pages. */
  rollup: EntityRollupRow[];
  /** Connector rows, each with its evidence line. */
  opc: EntityRow[];
  /** True when a read stopped at MAX_INDEX_ROWS: the counts are partial. */
  truncated: boolean;
  /** Documents whose index was NOT read (at or past the stop). */
  unread: string[];
  /** Where the roll-up came from. */
  source: "aggregate" | "rows";
  error?: string;
}

/** The entity index for these documents, whole — or honestly partial. */
async function loadEntityIndex(docIds: string[]): Promise<IndexRead> {
  const out: IndexRead = { rollup: [], opc: [], truncated: false, unread: [], source: "aggregate" };
  let budget = maxIndexRows();
  const stopAt = (slice: string[], lastDoc: string | undefined, i: number) => {
    // The stop lands inside the document the last row belongs to: it is
    // dropped whole, never counted in part (DWG-11).
    const cut = lastDoc ? slice.indexOf(lastDoc) : 0;
    out.unread.push(...slice.slice(Math.max(cut, 0)), ...docIds.slice(i + DOC_SLICE));
    out.truncated = true;
  };

  for (let i = 0; i < docIds.length; i += DOC_SLICE) {
    const slice = docIds.slice(i, i + DOC_SLICE);
    let rolled: EntityRollupRow[] | null = null;
    let capped = false;

    if (out.source === "aggregate") {
      const res = await readAllPages<EntityRollupRow>((from, to, withCount) => supabaseAdmin
        .rpc("drawing_entity_rollup", { p_document_ids: slice }, withCount ? { count: "exact" } : undefined)
        .order("document_id", { ascending: true }).order("kind", { ascending: true }).order("tag", { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<EntityRollupRow>>, budget);
      if (res.error && isMissingFunction(res.error)) {
        out.source = "rows";                       // before 20261124: raw rows
      } else if (res.error) {
        return { ...out, error: isMissingTable(res.error) ? "migration-missing" : res.error.message };
      } else {
        rolled = res.rows.map((r) => ({
          ...r, occurrences: Number(r.occurrences), first_page: Number(r.first_page),
          pages: (r.pages ?? []).map(Number),
        }));
        capped = res.capped;
      }
    }
    if (out.source === "rows") {
      const res = await readAllPages<EntityRow>((from, to, withCount) => supabaseAdmin
        .from("knowledge_page_entities")
        .select("document_id, page, kind, tag", withCount ? { count: "exact" } : undefined)
        .in("document_id", slice)
        .in("kind", TAG_ENTITY_KINDS as unknown as string[])
        .order("document_id", { ascending: true }).order("page", { ascending: true })
        .order("kind", { ascending: true }).order("tag", { ascending: true }).order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<EntityRow>>, budget);
      if (res.error) return { ...out, error: isMissingTable(res.error) ? "migration-missing" : res.error.message };
      rolled = rollUpEntities(res.rows);
      capped = res.capped;
    }

    const opcRes = await readAllPages<EntityRow>((from, to, withCount) => supabaseAdmin
      .from("knowledge_page_entities")
      .select("document_id, page, kind, tag, raw", withCount ? { count: "exact" } : undefined)
      .in("document_id", slice)
      .eq("kind", "opc")
      .order("document_id", { ascending: true }).order("page", { ascending: true })
      .order("tag", { ascending: true }).order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<PageResult<EntityRow>>, maxIndexRows());
    if (opcRes.error) return { ...out, error: isMissingTable(opcRes.error) ? "migration-missing" : opcRes.error.message };
    if (opcRes.capped) {
      // Connector rows past the ceiling: this slice is not counted at all.
      stopAt(slice, slice[0], i);
      break;
    }

    const rows = rolled ?? [];
    if (capped) {
      const lastDoc = rows[rows.length - 1]?.document_id;
      const keep = new Set(slice.slice(0, Math.max(lastDoc ? slice.indexOf(lastDoc) : 0, 0)));
      out.rollup.push(...rows.filter((r) => keep.has(r.document_id)));
      out.opc.push(...opcRes.rows.filter((r) => keep.has(r.document_id)));
      stopAt(slice, lastDoc, i);
      break;
    }
    out.rollup.push(...rows);
    out.opc.push(...opcRes.rows);
    budget -= rows.length;
    if (budget <= 0 && i + DOC_SLICE < docIds.length) {
      out.unread.push(...docIds.slice(i + DOC_SLICE));
      out.truncated = true;
      break;
    }
  }
  return out;
}

type TextRead = {
  stats: Map<string, TextStats>;
  truncated: boolean;
  /** Documents whose text was NOT read whole (at or past the stop): their
   *  zero is "not counted", never "no text" (DWG-11). */
  unread: string[];
  /** False before 20261124: chunks were COUNTED, but their characters and
   *  letter case were not read (chars / lower / upper are 0, unknown). */
  charsKnown: boolean;
  error?: string;
};

/** Characters, chunks and letter case per document — the database's
 *  knowledge_doc_text_stats() (20261124). Before that function exists, the
 *  chunks are only COUNTED (their document id, never their content): every
 *  census GET used to ship the full text of every chunk in the library —
 *  about 100 MB for a 1,000-document standards library — to measure what
 *  the per-sheet readout shows. The count still says which sheets have no
 *  text; the characters and letter case wait for the migration. */
async function loadTextStats(docIds: string[]): Promise<TextRead> {
  const stats = new Map<string, TextStats>();
  let viaRows = false;
  let budget = maxIndexRows();
  for (let i = 0; i < docIds.length; i += DOC_SLICE) {
    const slice = docIds.slice(i, i + DOC_SLICE);
    if (!viaRows) {
      const { data, error } = await supabaseAdmin.rpc("knowledge_doc_text_stats", { p_document_ids: slice });
      if (error && isMissingFunction(error)) viaRows = true;
      else if (error) return { stats, truncated: false, unread: [], charsKnown: true, error: error.message };
      else {
        for (const r of (data ?? []) as Array<{ document_id: string; chunks: number; chars: number; lower_letters: number; upper_letters: number }>) {
          stats.set(r.document_id, {
            chunks: Number(r.chunks), chars: Number(r.chars),
            lower: Number(r.lower_letters), upper: Number(r.upper_letters),
          });
        }
        continue;
      }
    }
    const res = await readAllPages<{ document_id: string }>((from, to, withCount) => supabaseAdmin
      .from("knowledge_chunks")
      .select("document_id", withCount ? { count: "exact" } : undefined)
      .in("document_id", slice)
      .order("document_id", { ascending: true }).order("page", { ascending: true }).order("seq", { ascending: true })
      .range(from, to) as unknown as PromiseLike<PageResult<{ document_id: string }>>, budget);
    if (res.error) return { stats, truncated: false, unread: [], charsKnown: false, error: res.error.message };
    // A cut read stops inside the document its last row belongs to: that
    // document, and every one after it, is unread — dropped whole, never
    // counted in part.
    const lastDoc = res.capped ? res.rows[res.rows.length - 1]?.document_id : undefined;
    const cutAt = res.capped ? Math.max(lastDoc ? slice.indexOf(lastDoc) : 0, 0) : slice.length;
    const counted = new Set(slice.slice(0, cutAt));
    for (const c of res.rows) {
      if (!counted.has(c.document_id)) continue;
      const s = stats.get(c.document_id) ?? { chunks: 0, chars: 0, lower: 0, upper: 0 };
      s.chunks++;
      stats.set(c.document_id, s);
    }
    budget -= res.rows.length;
    if (res.capped) return { stats, truncated: true, unread: [...slice.slice(cutAt), ...docIds.slice(i + DOC_SLICE)], charsKnown: false };
    if (budget <= 0 && i + DOC_SLICE < docIds.length) {
      return { stats, truncated: true, unread: docIds.slice(i + DOC_SLICE), charsKnown: false };
    }
  }
  return { stats, truncated: false, unread: [], charsKnown: !viaRows };
}

/** A document still waiting on work it cannot do right now — a vision
 *  retry, or a failed batch's back-off (20261122, DEC-58). The engine keeps
 *  it 'indexing' (retrievable) with the reason on the row; the lens shows
 *  it as indexing too, never as a finished sheet. */
const isParked = (d: DocRow) =>
  !!d.vision_retry_after || (d.error != null && d.error !== "" && d.status !== "error");
const isReadyHere = (d: DocRow) => d.status === "ready" && !isParked(d);
/** Its main pass is through: every page was reached once (pages_indexed at
 *  page_count). Each batch commits the pages it queued for AI vision
 *  (vision_failed_pages) as it goes, so a document still mid-read can
 *  already list some — and its pages past pages_indexed are unread too. */
const mainPassThrough = (d: DocRow) =>
  Number(d.page_count ?? 0) > 0 && Number(d.pages_indexed ?? 0) >= Number(d.page_count ?? 0);

/** By document id: the documents whose index is NOT whole, each with why —
 *  pages AI vision never read (parked, an accepted partial index, a failed
 *  run), a document whose indexing failed, or one not finished indexing.
 *  What such a sheet holds may stand on a page nobody read, so its silence
 *  is never evidence: a box or a reference back not found on what was read
 *  of it is unchecked, never `unreturned` or one-way, and a sheet of its
 *  drawing not found is no gap (DWG-4 / DWG-13, review fix pass 4). A
 *  document still mid-read is "not finished indexing" even when a batch has
 *  queued a page for AI vision: every page past the ones reached is unread
 *  too (review fix pass 8 — fix pass 7 named only the queued page). */
function notReadWhole(docs: readonly DocRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of docs) {
    const failed = [...(d.vision_failed_pages ?? [])].sort((a, b) => a - b);
    if (d.status !== "error" && !isReadyHere(d) && !mainPassThrough(d)) {
      out.set(d.id, failed.length > 0 ? `not finished indexing, page(s) ${failed.join(", ")} queued for AI vision` : "not finished indexing");
    } else if (failed.length > 0) out.set(d.id, `page(s) ${failed.join(", ")} never read`);
    else if (d.status === "error") out.set(d.id, "its indexing failed");
    else if (!isReadyHere(d)) out.set(d.id, "not finished indexing");
  }
  return out;
}

/** A controller's accepted partial index: finished, with its unread pages
 *  listed — it never changes, so what it lacks is settled. */
const isAcceptedPartial = (d: DocRow) => !!d.vision_partial_accepted && d.status === "ready" && !isParked(d);

/** The documents not read whole only FOR NOW — parked on AI vision, failed,
 *  or still being indexed (every one notReadWhole names but an accepted
 *  partial index). A finding that waits on one is provisional: it never
 *  overwrites a settled verdict, and is judged again once the document is
 *  read whole (review fix pass 5 — fix pass 4 let a parked or failed
 *  neighbour raise a verified `passed` for good, and refused to record at
 *  all while any sheet was in flight). */
function forNowIncomplete(docs: readonly DocRow[], incomplete: ReadonlyMap<string, string>): Set<string> {
  return new Set(docs.filter((d) => incomplete.has(d.id) && !isAcceptedPartial(d)).map((d) => d.id));
}

/** Of those, the documents still being READ — parked on AI vision, or in
 *  flight — and so the ones a missing sheet they may hold waits on (review
 *  fix pass 6; which sheets each may hold is inFlightOf's, review fix pass
 *  7), the ones a gap waits on while it is not settled, and the ones that
 *  hold back a lower verdict under an unknown revision (review fix pass 8).
 *  A FAILED document is not among them: it is read again only when a
 *  person re-indexes it, so a sheet missing from the set never waits on it
 *  — it may hold one only by the settled rule (a sheet of its own drawing,
 *  of a series it declares two drawings of, or anything when its number was
 *  never read), and that finding is settled, an unchecked `flagged`. A
 *  finding about the failed document ITSELF (a box or a reference back not
 *  found on it, or a connector into a destination no document declares that
 *  it may be — its title block cleared by a rebuild — review fix pass 7)
 *  still waits on it, named with why. */
function stillBeingRead(docs: readonly DocRow[], forNow: ReadonlySet<string>): Set<string> {
  return new Set(docs.filter((d) => forNow.has(d.id) && d.status !== "error").map((d) => d.id));
}

/** Of those, the documents IN FLIGHT — the ones that may hold ANY sheet the
 *  set is missing (auditDrawingRefs / auditOpcBoxes `inProgress`): every
 *  document still being read but one PARKED with its unread pages known —
 *  its main pass through, parked (isParked: a vision retry, or a failed
 *  batch's back-off), and pages listed unread. So queued, stale (reset by a
 *  rebuild) and mid-read are in flight, a mid-read document whose batch has
 *  already queued a page for AI vision included (review fix pass 8 — fix
 *  pass 7 counted that one parked, and a sheet on a page it had yet to
 *  reach was filed a settled gap). A parked document may wait on AI vision
 *  until next month under a cap, and while it may hold anything every real
 *  gap in the library — in any series — waited on it all that time (review
 *  fix pass 7). A missing sheet it holds by the settled rule's positive
 *  clauses instead (its own drawing, a series it declares two drawings of —
 *  never one because its number was read neither from a title block nor
 *  from its filename, review fix pass 9); what it holds waits on it, and a
 *  gap it does not hold that way is filed and waits on it too — never
 *  settled while it is parked (review fix pass 8). A connector's
 *  destination it holds as auditOpcBoxes says (`reading`). */
function inFlightOf(docs: readonly DocRow[], beingRead: ReadonlySet<string>): Set<string> {
  return new Set(docs
    .filter((d) => beingRead.has(d.id) && !(mainPassThrough(d) && isParked(d) && (d.vision_failed_pages ?? []).length > 0))
    .map((d) => d.id));
}

/** Index maps the census, audit and readout share. */
function indexMaps(index: IndexRead) {
  const selfByDoc = new Map<string, string[]>();
  /** By document, by declared number: the pages it is declared on — the
   *  sheet a connector's box pairs on (review fix pass 5). */
  const selfPages = new Map<string, Map<string, number[]>>();
  const refsByDoc = new Map<string, string[]>();
  const equipment: EntityRollupRow[] = [];
  for (const r of index.rollup) {
    if (r.kind === "equipment") equipment.push(r);
    else if (r.kind === "self") {
      const list = selfByDoc.get(r.document_id) ?? [];
      if (!list.includes(r.tag)) list.push(r.tag);
      selfByDoc.set(r.document_id, list);
      const pages = selfPages.get(r.document_id) ?? new Map<string, number[]>();
      pages.set(r.tag, [...new Set([...(pages.get(r.tag) ?? []), ...(r.pages && r.pages.length > 0 ? r.pages : [r.first_page])])].sort((a, b) => a - b));
      selfPages.set(r.document_id, pages);
    } else if (r.kind === "ref") {
      // The audit counts every occurrence of a reference.
      const list = refsByDoc.get(r.document_id) ?? [];
      for (let k = 0; k < r.occurrences; k++) list.push(r.tag);
      refsByDoc.set(r.document_id, list);
    }
  }
  return { selfByDoc, selfPages, refsByDoc, equipment };
}

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  const libraryId = (req.nextUrl.searchParams.get("libraryId") ?? "").trim();
  const action = req.nextUrl.searchParams.get("action") ?? "census";
  if (!orgId || !libraryId) return bad("orgId and libraryId are required");
  const user = await authUser(req);
  if (!user) return bad("Unauthorized", 401);

  const { docs, error: docErr } = await loadVisibleDocs(orgId, user.id, libraryId);
  if (docErr) return bad(docErr, docErr === "Not a member of this workspace" ? 403 : 500);
  const index = docs.length > 0
    ? await loadEntityIndex(docs.map((d) => d.id))
    : { rollup: [], opc: [], truncated: false, unread: [], source: "aggregate" as const };
  if (index.error === "migration-missing") {
    return bad("Drawing intelligence needs migration 20260921 — run it in Supabase, then Rebuild index.", 424);
  }
  if (index.error) return bad(index.error, 500);

  const nameById = new Map(docs.map((d) => [d.id, d.name]));
  const { selfByDoc, selfPages, refsByDoc, equipment } = indexMaps(index);

  // Site decoder: the library's own AI-setup decoder, or (when it has none)
  // the org's Site Codebook — unit names AND tag-prefix meanings.
  const { data: libRow } = await supabaseAdmin
    .from("knowledge_libraries").select("ai_features").eq("id", libraryId).maybeSingle();
  const libDecoder = String(((libRow?.ai_features ?? {}) as Record<string, unknown>).decoder ?? "").trim();
  const decoder = libDecoder || codebookToDecoderText(await loadCodebookAdmin(supabaseAdmin, orgId));
  const unitMap = parseUnitMap(decoder);
  const prefixLabels = parsePrefixMap(decoder);

  // ── CSV register download ──────────────────────────────────────────────
  if (action === "export") {
    // A register that silently lacks sheets is worse than none.
    if (index.truncated) {
      return bad(
        `The equipment index is larger than one export can read whole (${index.unread.length} sheet(s) were not ` +
        "reached), so no partial register was produced. Split the library or ask your admin to apply migration 20261124.",
        409,
      );
    }
    const csv = equipmentRegisterCsv(equipment.map((e) => ({
      tag: e.tag, documentName: nameById.get(e.document_id) ?? "Sheet", page: e.first_page, count: e.occurrences,
    })), prefixLabels);
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="equipment-register.csv"`,
      },
    });
  }

  // ── Census + reference audit + suggestions ─────────────────────────────
  const census = buildEquipmentCensus(equipment.map((e) => ({ tag: e.tag, count: e.occurrences })), prefixLabels);
  // Sheets not read whole: their silence is not evidence — the SAME rule the
  // record applies (review fix pass 4).
  const incomplete = notReadWhole(docs);
  // …those in flight may hold any sheet the set is missing, and a sheet
  // that one still being read may hold is unchecked whatever the held
  // series — the SAME rules the record applies (review fix passes 6 and 7).
  const forNow = forNowIncomplete(docs, incomplete);
  const beingRead = stillBeingRead(docs, forNow);
  const inFlight = inFlightOf(docs, beingRead);
  const refAudit = auditDrawingRefs(
    docs.map((d) => ({ id: d.id, name: d.name })), refsByDoc, selfByDoc, unitMap, incomplete, inFlight, beingRead,
  );
  // A gap is judged only inside a series this library holds — the SAME rule
  // the record applies (DWG-6), so the lens never calls "a gap in the set"
  // what the record refuses to judge. The series not judged are named.
  // Real drawing numbers only — never a filename standing in for one: a
  // prose document is no series (review fix pass 9).
  const numbers = new Map(docs.map((d) => [d.id, sheetDrawingNumbers(d.name, selfByDoc.get(d.id) ?? [])]));
  const notJudged = seriesNotJudged(numbers);
  const held = seriesHeldBySet(numbers);
  // The referencing sheets are listed to six on screen; the record takes
  // every one (review fix pass 5), and the lens never ships the whole list —
  // nor every document that may hold a sheet (review fix pass 7), nor every
  // one a gap waits on (review fix pass 8: `pendingIn` names six).
  const audit = {
    ...refAudit,
    missingInSeries: missingWithinHeldSeries(refAudit.missingInSeries, held)
      .map(({ referencedByAll: _all, pendingIds: _pending, ...m }) => m),
    missingUnread: missingUnreadInScope(refAudit.missingUnread, held, beingRead)
      .map(({ referencedByAll: _all, ...m }) => ({ ...m, maybeInIds: m.maybeInIds.slice(0, WAITING_NAMES_MAX) })),
  };

  // ── OPC box pairing (best-effort) ──────────────────────────────────────
  // Paired on the SHEET a connector names — the page whose title block
  // declares it — never on another page's boxes (review fix pass 5); a
  // page whose title block and box numbers were both never read may be it
  // (review fix pass 6).
  const pageCounts = new Map(docs.map((d) => [d.id, Number(d.page_count ?? 0)]));
  const opc = auditOpcBoxes(index.opc, selfByDoc, nameById, incomplete, selfPages, { pageCounts, inProgress: inFlight, forNow, reading: beingRead });
  const {
    boxCount: opcBoxCount, unreturned: opcUnreturned, unknown: opcUnknown, noRef: opcNoRef,
  } = opc;
  const opcUnpaired = opc.unpaired.map((u) => (u.maybeInIds ? { ...u, maybeInIds: u.maybeInIds.slice(0, WAITING_NAMES_MAX) } : u));

  const text: TextRead = docs.length > 0
    ? await loadTextStats(docs.map((d) => d.id))
    : { stats: new Map<string, TextStats>(), truncated: false, unread: [], charsKnown: true };
  if (text.error) return bad(text.error, 500);
  const truncated = index.truncated || text.truncated;
  // Not counted: whatever either read could not reach (DWG-11). A sheet
  // whose text was not read is never "textless" and never "Nothing read".
  const unread = new Set([...index.unread, ...text.unread]);
  const textUnread = new Set(text.unread);
  const unreadNames = docs.filter((d) => unread.has(d.id)).map((d) => d.name);

  // Deterministic coach suggestions — "give me X and I can do more".
  const suggestions: string[] = [];
  const readyDocs = docs.filter(isReadyHere).length;
  const hasEntities = index.rollup.length > 0 || index.opc.length > 0;

  if (truncated) {
    suggestions.push(
      `This library's index holds more rows than one pass can read${unreadNames.length > 0
        ? ` — ${unreadNames.length} sheet(s) were not counted (${unreadNames.slice(0, 6).join(", ")}${unreadNames.length > 6 ? ", …" : ""})`
        : ""}. The census and audit below are PARTIAL; recording an audit is refused until the index can be read whole.` +
      (index.source === "rows" ? " Migration 20261124 lets the database do the counting — ask your admin to apply it." : ""),
    );
  }

  // Which ready docs produced ANY text at all? Zero-text docs are scans —
  // a completely different problem than "no tags matched".
  const textlessCount = docs.filter((d) =>
    isReadyHere(d) && !textUnread.has(d.id) && (text.stats.get(d.id)?.chunks ?? 0) === 0).length;

  if (textlessCount > 0) {
    suggestions.push(
      `${textlessCount} of ${readyDocs} document(s) have no machine-readable text — typical of scans ` +
      "and of AutoCAD exports that use SHX fonts (text plots as line-work). Hit \"Rebuild index\" with " +
      "your AI key saved: pages without text are READ BY AI VISION during indexing, which makes their " +
      "tags, connectors, and notes fully searchable. (Vision indexing bills to your key and counts " +
      "against your monthly cap.)",
    );
  }

  // ── Per-sheet readout: what each drawing actually produced ─────────────
  // Guessing why a library "isn't working" is miserable; this is the fact
  // table. Characters extracted, tags found, pages read by vision, per
  // sheet — the answer to "is this an SHX export?" is visible, not argued.
  const tagsByDoc = new Map<string, number>();
  const coveredByDoc = new Map<string, Set<number>>();
  const cover = (doc: string, pages: number[]) => {
    const set = coveredByDoc.get(doc) ?? new Set<number>();
    for (const p of pages) set.add(p);
    coveredByDoc.set(doc, set);
  };
  for (const r of index.rollup) {
    if (r.kind === "equipment") tagsByDoc.set(r.document_id, (tagsByDoc.get(r.document_id) ?? 0) + r.occurrences);
    cover(r.document_id, r.pages);
  }
  for (const o of index.opc) cover(o.document_id, [o.page]);
  const indexUnread = new Set(index.unread);

  const sheets = docs.map((d) => {
    const st = text.stats.get(d.id) ?? { chunks: 0, chars: 0, lower: 0, upper: 0 };
    const tags = tagsByDoc.get(d.id) ?? 0;
    const visionPages = Number(d.vision_pages ?? 0);
    const parked = isParked(d);
    const hasText = text.charsKnown ? st.chars > 0 : st.chunks > 0;
    const verdict =
      d.status === "error" ? "error"
      : d.status !== "ready" || parked ? "indexing"   // a parked sheet is still indexing
      : unread.has(d.id) ? "not-counted"     // past what a read could reach (DWG-11)
      : visionPages > 0 ? "vision"           // AI read it — SHX/scan handled
      : tags > 0 ? "text"                    // text layer carried the tags
      : hasText ? "text-no-tags"             // readable text, no tags found
      : "empty";                             // nothing at all came out
    // For text with no tags: a drawing we could not get tags out of, or
    // prose that never had any (DWG-7)? A title block, a drawing reference,
    // or capital lettering says drawing. Before 20261124 the letter case was
    // not read: without a title block or a reference, "unknown".
    const letters = st.lower + st.upper;
    const looksLike = verdict !== "text-no-tags" ? null
      : selfByDoc.has(d.id) || refsByDoc.has(d.id)
        || (letters > 0 && st.lower / letters <= DRAWING_MAX_LOWERCASE_RATIO) ? "drawing"
      : text.charsKnown ? "prose" : "unknown";
    const identity = declaredSheetIdentity(selfByDoc.get(d.id) ?? []);
    // An SHX export, by what it gave (DWG-7): thin text, nothing but its own
    // title block's number, no references to OTHER drawings. Only such a
    // sheet is worth the SHX advice — a legend, cover or index sheet of a
    // healthy text-layer set (references, no equipment) never is. Ingest
    // reads the title block's own number as a reference too (a TrueType
    // border item "025-PID-0104" is ref-shaped): that one is the sheet
    // itself, never a reference to another drawing (review fix pass 3).
    const pageCount = Math.max(1, Number(d.page_count ?? 0));
    const declaredBases = new Set((selfByDoc.get(d.id) ?? []).map((t) => t.replace(/-SH\d+$/, "")));
    const otherRefs = (refsByDoc.get(d.id) ?? []).filter((r) => !declaredBases.has(r.replace(/-SH\d+$/, "")));
    const shxLike = looksLike === "drawing" && text.charsKnown && otherRefs.length === 0
      && declaredBases.size <= pageCount && st.chars / pageCount <= THIN_PAGE_MAX_CHARS;
    // Pages the entity index has NOTHING for. On a drawing set this is the
    // fingerprint of an interrupted vision rebuild: the transcripts that DID
    // run produced tags, and the skipped pages produced silence — which then
    // surfaces far away as 'X-35 is not in the tag index' on a trace, with
    // no visible reason. Naming the exact pages turns that mystery into a
    // one-line instruction: rebuild, and let it finish.
    const covered = coveredByDoc.get(d.id) ?? new Set<number>();
    const gapPages: number[] = [];
    if (!indexUnread.has(d.id)) {
      for (let pg = 1; pg <= Number(d.page_count ?? 0); pg++) {
        if (!covered.has(pg)) gapPages.push(pg);
      }
    }
    const failedPages = [...(d.vision_failed_pages ?? [])].sort((a, b) => a - b);
    // A controller's accepted partial index is finished, with its unread
    // pages still listed — not waiting on anything.
    const accepted = isAcceptedPartial(d);
    return {
      id: d.id,
      name: d.name,
      status: d.status,
      pages: Number(d.page_count ?? 0),
      pagesIndexed: Number(d.pages_indexed ?? 0),
      gapPages: gapPages.slice(0, 24),
      // null: not measured (before 20261124, chunks are only counted).
      chars: text.charsKnown ? st.chars : null, tags, visionPages, verdict, looksLike, shxLike,
      // What the title block itself says this sheet is — the SAME number an
      // audit of this sheet is recorded under (DWG-10).
      declared: identity.base
        ? (identity.sheetsDeclared > 1 ? `${identity.base} (${identity.sheetsDeclared} sh)` : identity.base)
        : null,
      // Parked (ING-6 / DEC-58): which pages wait on AI vision, and why.
      waiting: d.status !== "error" && !accepted && (parked || failedPages.length > 0)
        ? { pages: failedPages, reason: d.error ?? null, retryAfter: d.vision_retry_after ?? null }
        : null,
      // Accepted with pages AI vision never read (an audited decision).
      acceptedUnread: accepted && failedPages.length > 0 ? failedPages : null,
      // Not counted: past the point a read could reach (DWG-11).
      notCounted: unread.has(d.id),
      error: d.error ?? null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const drawingNoTags = sheets.filter((s) => s.looksLike === "drawing");
  const proseNoTags = sheets.filter((s) => s.looksLike === "prose");
  const shxNoTags = sheets.filter((s) => s.shxLike);
  if (shxNoTags.length > 0) {
    // The cheaper remedy first: a thin page with no tags is USUALLY read by
    // AI vision page by page on a rebuild with a key saved — not always:
    // pageNeedsVision passes over a page whose text reads like sentences,
    // and an SHX title block's "DRAWING NO. … REV. … CHK'D." or its numbered
    // notes do. So the library-wide every-page switch, the one remedy for
    // such a sheet, is always named after it, conditionally and with its
    // billing said plainly (DEC-59 item 1; review fix pass 4 — fix pass 3
    // offered it only once another document had been vision-read, and an
    // all-SHX library never was).
    suggestions.push(
      `${shxNoTags.length} sheet(s) look like SHX exports — capital lettering, thin text, nothing but their own ` +
      "title block's number, and no equipment tags or references to other drawings in their text layer: their tags " +
      "are most likely line-work, invisible to text extraction. Hit \"Rebuild index\" with your AI key saved: a " +
      "page with almost no text and no tags is usually read by AI vision during indexing, page by page, and each " +
      "page read bills to your key (a page whose title block or notes read like sentences can be passed over). If " +
      "a rebuild with your key saved still leaves these sheets unread, the remaining switch is library-wide — " +
      "\"Text doesn't extract from these files — index every page as an image\" in Library AI setup, then " +
      "\"Rebuild index\", reads EVERY page of EVERY document in this library with AI vision and bills each page " +
      "to your key. Turn it on only if most of this library is like these sheets.",
    );
  }
  if (readyDocs > 0 && !hasEntities && proseNoTags.length > 0 && drawingNoTags.length === 0) {
    suggestions.push(
      `${proseNoTags.length} document(s) read as prose (sentences in mixed case) — no drawing tags are ` +
      "expected from those. If they ARE drawings, check how they were exported.",
    );
  }
  const waiting = sheets.filter((s) => s.waiting);
  if (waiting.length > 0) {
    suggestions.push(
      `${waiting.length} sheet(s) are still waiting on AI vision (${waiting.slice(0, 4).map((s) => s.name).join(", ")}` +
      `${waiting.length > 4 ? ", …" : ""}) — shown as indexing, not finished, until those pages are read. ` +
      "Each sheet's reason is in the table below.",
    );
  }
  const declaredCount = docs.filter((d) => selfByDoc.has(d.id)).length;
  if (readyDocs > 0 && declaredCount === 0 && hasEntities) {
    suggestions.push(
      "No sheet declared its own drawing number — I couldn't read a \"DRAWING NO\" field from any " +
      "title block, so the reference audit is falling back to filenames. If these sheets were " +
      "indexed before title-block reading existed, hit \"Rebuild index\"; if their borders use " +
      "line-work text, turn on \"Text doesn't extract from these files — index every page as an image\" first.",
    );
  }
  if (census.unknownPrefixes.length > 0) {
    suggestions.push(
      `I found tag prefixes I don't recognize: ${census.unknownPrefixes.slice(0, 8).join(", ")}. ` +
      "Tell me what they mean in Library AI setup → standing instructions (e.g. \"ZZ- means sample " +
      "station\") and answers will categorize them correctly.",
    );
  }
  if (audit.missingInSeries.length > 0) {
    // A gap a parked document may yet hold on a page it has not read is
    // shown as a gap, and said to be unsettled (review fix pass 8).
    const pending = audit.missingInSeries.find((m) => (m.pendingIn ?? []).length > 0)?.pendingIn ?? [];
    suggestions.push(
      `${audit.missingInSeries.length} sheet(s) from a series you DID load are referenced but absent ` +
      `(${audit.missingInSeries.slice(0, 6).map((m) => m.ref).join(", ")}). Those are gaps in the set — ` +
      "link the folders that hold them and cross-sheet questions stop dead-ending." +
      (pending.length > 0
        ? ` They are not settled yet: ${pending.slice(0, 4).join("; ")}${pending.length > 4 ? "; …" : ""} still has pages ` +
          "waiting on AI vision, and one of them may hold a sheet named — the record files these gaps and judges " +
          "them again once those pages are read."
        : ""),
    );
  }
  if (audit.outOfScope.length > 0) {
    const total = audit.outOfScope.reduce((a, o) => a + o.count, 0);
    suggestions.push(
      `${total} connector(s) point to other drawing series (${audit.outOfScope.slice(0, 6)
        .map((o) => `${o.series}${o.unitName ? ` — ${o.unitName}` : ""} ×${o.count}`).join(", ")}). ` +
      "That's normal — this set ends at its battery limits and those units weren't loaded. Nothing " +
      "is broken. To audit those connectors too, add the sheets in those series (highest count = " +
      "biggest payoff); I'll then audit whatever the widened set covers and tell you what the NEXT " +
      "ring of connectors needs.",
    );
  }
  if (audit.outOfScope.length > 0 && !unitMap) {
    suggestions.push(
      "Teach me your numbering scheme in Library AI setup → Drawing number decoder (e.g. \"first " +
      "two digits = unit: 20 = Crude Unit, 25 = Vacuum Unit\") and I'll name the UNITS these " +
      "connectors leave for, not just the numbers.",
    );
  }
  // Connector BOX pairing has input only from AI-vision transcripts: drawings
  // print a pennant, not the letters OPC. Say so rather than show a
  // reassuring zero (DWG-4) — as a fact, not a purchase order: a set with a
  // working text layer is audited through its references already, and must
  // never be told to pay for every page to be read as an image (DEC-59).
  const isDrawingSet = census.totalDistinct > 0 || audit.totalRefs > 0;
  const opcPairing: "ok" | "no-boxes" = opcBoxCount > 0 ? "ok" : "no-boxes";
  if (isDrawingSet && opcPairing === "no-boxes") {
    const visionRead = docs.filter((d) => isReadyHere(d) && Number(d.vision_pages ?? 0) > 0).length;
    suggestions.push(
      "Connector box pairing has no input here: box numbers are read only from AI-vision transcripts, and " +
      "none were read from this set (a text layer carries drawing numbers, not box numbers). Connectors are " +
      "still audited through their drawing references — one-way and missing sheets above." +
      (visionRead > 0
        ? ` ${visionRead} sheet(s) were read by AI vision before connector lines were transcribed; ` +
          "rebuilding re-reads them with box numbers (and bills those pages again)."
        : ""),
    );
  }
  if (opcUnreturned.length > 0) {
    suggestions.push(
      `${opcUnreturned.length} connector box number(s) don't reappear on their continuation sheet — ` +
      "the box number is how a connector pairs, so these are worth a manual look (listed below).",
    );
  }
  if (opcUnpaired.length > 0) {
    suggestions.push(
      `${opcUnpaired.length} connector box(es) could not be paired: the sheet each continues on has no box ` +
      "numbers read (a text layer, or a sheet read by AI vision before connector boxes were transcribed — in a " +
      "combined PDF, the page that is that sheet), or was not read whole and the box is not on what was read of " +
      "it, or no page of its drawing declares the sheet named, or no sheet declares it yet while a document that " +
      "may hold it is not read whole (still being read, or its indexing failed). They are NOT counted " +
      "as broken — check those boxes on the sheet (listed below).",
    );
  }
  // References whose check needs a sheet that was not read whole (review
  // fix pass 4): never one-way, never a gap — said, with the sheets.
  const uncheckedRefs = audit.oneWayUnread.length + audit.missingUnread.length;
  if (uncheckedRefs > 0) {
    const partly = docs.filter((d) => incomplete.has(d.id));
    suggestions.push(
      `${uncheckedRefs} reference(s) could not be checked: they need a sheet that was not read whole ` +
      `(${partly.slice(0, 4).map((d) => `${d.name} — ${incomplete.get(d.id)}`).join("; ")}${partly.length > 4 ? "; …" : ""}). ` +
      "They are NOT counted as one-way or missing; once that sheet is read whole they are judged.",
    );
  }
  if (opcNoRef.length > 0) {
    suggestions.push(
      `${opcNoRef.length} off-page connector(s) carry NO drawing number at all — broken by ` +
      "definition: nothing tells the reader where to continue. Listed below with sheet and page.",
    );
  }
  if (opcUnknown.length > 0) {
    suggestions.push(
      `${opcUnknown.length} connector(s) have a destination that could not be read — the stored line may ` +
      "have been cut before the drawing number, or what stands there isn't shaped like one. Check them on " +
      "the sheet; they are NOT counted as broken.",
    );
  }
  if (audit.oneWay.length > 0) {
    suggestions.push(
      `${audit.oneWay.length} connector(s) run one way between sheets that are BOTH loaded — ` +
      "sheet A points at sheet B and B never points back. Some continuation notes are legitimately " +
      "one-way, but this is where real drafting misses hide.",
    );
  }

  return NextResponse.json({
    sheetCount: docs.length,
    readyCount: readyDocs,
    textlessCount,
    census,
    audit,
    suggestions,
    sheets,
    opcBoxCount,
    opcPairing,
    opcUnreturned: opcUnreturned.slice(0, 25),
    opcUnpaired: opcUnpaired.slice(0, 25),
    opcNoRef: opcNoRef.slice(0, 25),
    opcUnknown: opcUnknown.slice(0, 25),
    // DWG-6: series the library holds no more than one number of — gaps in
    // them are not judged, here or on the record.
    seriesNotJudged: notJudged,
    // DWG-11: the counts are exact only when nothing was cut.
    truncated,
    notCounted: unreadNames,
    indexSource: index.source,
    // "counts": before 20261124 the chunks are counted, never read.
    textStats: text.charsKnown ? "measured" : "counts",
  });
}

/** One rebuild call stops starting new resets past this, so its answer
 *  (and the cursor to continue from) always comes back in time. */
const REBUILD_BUDGET_MS = 40_000;
/** Resets run this many documents at a time — each is its own claim. */
const REBUILD_CONCURRENCY = 6;
/** Where a cursorless caller's last call stopped, kept on the library row
 *  (knowledge_libraries.ai_features) — the library page's "Re-index all"
 *  cannot carry a cursor between presses (ING-12). */
const REBUILD_MARK_KEY = "rebuildCursor";
/** A press within this long of the last partial one continues it; later,
 *  the re-index starts again from the first document. */
const REBUILD_RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The cursor a cursorless caller's last partial call left, if it is still
 *  fresh. A read that fails starts from the first document: it never fails
 *  the rebuild, and never skips a document on a guess. */
async function readRebuildMark(orgId: string, libraryId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("knowledge_libraries").select("ai_features").eq("id", libraryId).eq("org_id", orgId).maybeSingle();
  if (error || !data) return null;
  const mark = ((data as { ai_features?: Record<string, unknown> | null }).ai_features ?? {})[REBUILD_MARK_KEY] as
    { cursor?: unknown; at?: unknown } | undefined;
  if (!mark || typeof mark.cursor !== "string" || typeof mark.at !== "string") return null;
  const at = Date.parse(mark.at);
  return Number.isFinite(at) && Date.now() - at <= REBUILD_RESUME_WINDOW_MS ? mark.cursor : null;
}

/** Keep (or clear, `cursor` null) where a cursorless caller stopped. The row
 *  is read again right before the write and only this one key changes, so a
 *  Library AI setup saved meanwhile is kept. Returns the failure, if any. */
async function writeRebuildMark(orgId: string, libraryId: string, cursor: string | null): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("knowledge_libraries").select("ai_features").eq("id", libraryId).eq("org_id", orgId).maybeSingle();
  if (error) return error.message;
  if (!data) return null;
  const features = { ...((data as { ai_features?: Record<string, unknown> | null }).ai_features ?? {}) };
  if (cursor === null) {
    if (!(REBUILD_MARK_KEY in features)) return null;
    delete features[REBUILD_MARK_KEY];
  } else {
    features[REBUILD_MARK_KEY] = { cursor, at: new Date().toISOString() };
  }
  const { error: writeError } = await supabaseAdmin
    .from("knowledge_libraries").update({ ai_features: features }).eq("id", libraryId).eq("org_id", orgId);
  return writeError ? writeError.message : null;
}

export async function POST(req: NextRequest) {
  let body: { orgId?: string; libraryId?: string; action?: string; cursor?: string | null };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const libraryId = String(body.libraryId ?? "").trim();
  if (!orgId || !libraryId) return bad("orgId and libraryId are required");
  const user = await authUser(req);
  if (!user) return bad("Unauthorized", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal?.isController) {
    return bad("Only Admin or Doc Control can rebuild the index or record an audit.", 403);
  }

  if (body.action === "record-audit") return recordAudit(orgId, libraryId, user.id);
  if (body.action !== "rebuild") return bad("Unknown action");
  // A caller that sends no `cursor` key at all cannot follow one (the
  // library page's "Re-index all", lib/knowledge.ts rebuildDrawingIndex —
  // I-02's, owed the cursor loop). The route keeps its place for it, so
  // each press continues where the last stopped; and it must never be able
  // to report a partial reset as done: see rebuild().
  return rebuild(orgId, libraryId, typeof body.cursor === "string" ? body.cursor : null, !("cursor" in body));
}

/**
 * Re-extract a library from scratch through the shared reset (DEC-58 / ING-1
 * / ING-8 / ING-12): each document is reset under its OWN ingest claim, its
 * row queued with every counter zeroed (vision_pages, empty pages, the
 * vision retry queue, the failed-batch count and its back-off), then its
 * chunks, page entities and machine mentions deleted — checked, step by
 * step. A document another driver is indexing right now is left alone and
 * reported (`busy`); rebuild again once it finishes. Documents are taken in
 * id order; a call that runs out of time answers `remaining` and the
 * `cursor` to continue from, so a continuation never resets (and re-bills)
 * a document twice.
 *
 * A caller that sends no cursor at all (the library page's "Re-index all")
 * is given one: the route keeps where its last partial call stopped on the
 * library row (REBUILD_MARK_KEY, for REBUILD_RESUME_WINDOW_MS) and the next
 * press continues from there, until a press reaches the last document and
 * clears it. Before this, every press restarted at the first document and a
 * library larger than one call could never finish.
 */
async function rebuild(orgId: string, libraryId: string, requested: string | null, cursorless = false) {
  const startedAt = Date.now();
  const resumedFrom = cursorless ? await readRebuildMark(orgId, libraryId) : null;
  const cursor = resumedFrom ?? requested;
  const res = await readAllPages<{ id: string; name: string }>((from, to, withCount) => supabaseAdmin
    .from("knowledge_documents").select("id, name", withCount ? { count: "exact" } : undefined)
    .eq("library_id", libraryId).eq("org_id", orgId)
    .order("id", { ascending: true })
    .range(from, to) as unknown as PromiseLike<PageResult<{ id: string; name: string }>>, Number.POSITIVE_INFINITY);
  if (res.error) return bad(res.error.message, 500);
  const all = res.rows.filter((d) => cursor === null || d.id > cursor);
  if (all.length === 0) {
    if (resumedFrom !== null) await writeRebuildMark(orgId, libraryId, null);
    return NextResponse.json({
      ok: true, docs: 0, busy: [], errors: [], remaining: 0, cursor: null, resumedFrom,
      ...(resumedFrom !== null
        ? { notice: "Continued from where the last press stopped: earlier presses had already queued every document, so nothing was left to reset." }
        : {}),
    });
  }

  const nameById = new Map(all.map((d) => [d.id, d.name]));
  const reset: string[] = [];
  const busy: string[] = [];
  const errors: string[] = [];
  let next = 0;
  while (next < all.length && Date.now() - startedAt < REBUILD_BUDGET_MS) {
    const chunk = all.slice(next, next + REBUILD_CONCURRENCY);
    const results = await Promise.all(chunk.map((d) => resetKnowledgeIndex([d.id]).catch((e: unknown) => ({
      reset: [] as string[], busy: [] as string[], errors: [`${d.id}: ${(e as Error).message}`],
    }))));
    for (const r of results) { reset.push(...r.reset); busy.push(...r.busy); errors.push(...r.errors); }
    next += chunk.length;
  }
  const remaining = all.length - next;
  const body = {
    ok: errors.length === 0 && busy.length === 0,
    docs: reset.length,
    busy: busy.map((id) => nameById.get(id) ?? id),
    errors: errors.map((e) => {
      const id = e.split(":")[0];
      return nameById.has(id) ? `${nameById.get(id)}${e.slice(id.length)}` : e;
    }),
    remaining,
    // Where to continue: after the last document this call took — or, when
    // the budget was spent before it took any, where the caller asked to
    // start.
    cursor: remaining > 0 ? (next > 0 ? all[next - 1].id : cursor) : null,
    // A cursorless caller continued from where its last call stopped.
    ...(cursorless ? { resumedFrom } : {}),
  };
  // A cursorless caller's place: kept while documents remain, cleared once
  // the last one has been taken.
  const markError = cursorless && (remaining > 0 || resumedFrom !== null)
    ? await writeRebuildMark(orgId, libraryId, remaining > 0 ? body.cursor : null)
    : null;
  // Nothing reset and something failed: a failure, said as one.
  if (reset.length === 0 && errors.length > 0) {
    return NextResponse.json({ ...body, error: `The rebuild failed: ${body.errors.slice(0, 3).join("; ")}` }, { status: 500 });
  }
  // A caller that cannot follow the cursor, or show busy documents and
  // per-document failures, must not be able to call this complete: it is
  // told what happened, as a refusal it will show (ING-12).
  if (cursorless && (remaining > 0 || body.busy.length > 0 || body.errors.length > 0)) {
    const parts = [resumedFrom !== null
      ? `${reset.length} of the ${all.length} document(s) the last press had not reached were queued for re-indexing`
      : `${reset.length} of ${all.length} document(s) were queued for re-indexing`];
    if (body.busy.length > 0) {
      parts.push(`${body.busy.length} were being indexed right then and were left alone (${body.busy.slice(0, 3).join(", ")}${body.busy.length > 3 ? ", …" : ""})`);
    }
    if (body.errors.length > 0) parts.push(`${body.errors.length} failed (${body.errors.slice(0, 2).join("; ")})`);
    if (remaining > 0) {
      parts.push(markError
        ? `${remaining} were not reached in time, and where this call stopped could not be saved (${markError}) — ` +
          "the next press starts again from the first document"
        : `${remaining} were not reached in time — the library is larger than one call can reset. Press the button ` +
          `again (within ${REBUILD_RESUME_WINDOW_MS / 3_600_000} hours) to continue from where this call stopped; ` +
          "no document is reset twice");
    }
    return NextResponse.json({
      ...body,
      partial: true,
      error: `Re-index is not complete: ${parts.join("; ")}.`,
    }, { status: 409 });
  }
  // A press that finished what an earlier one began says so: its count is
  // this press's, and the documents earlier presses queued were not reset
  // again — whatever was saved in Library AI setup between presses did not
  // reach them a second time.
  if (cursorless && resumedFrom !== null) {
    return NextResponse.json({
      ...body,
      notice: `Continued from where the last press stopped: ${reset.length} document(s) queued by this press; the ` +
        "documents earlier presses queued were not reset again.",
    });
  }
  return NextResponse.json(body);
}

/** Two revision labels the same? Case and surrounding space aside. */
const sameRev = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

/**
 * Commit this library's reference audit to the permanent record.
 *
 * The audit itself is recomputed rather than trusted from the client — a
 * verdict somebody can POST is a verdict nobody can rely on. Rows are keyed
 * (org, library, sheet number, revision) — 20261124 (DWG-6) — so the same
 * sheet audited in two libraries (two different sets) keeps two verdicts,
 * and a sheet that has since been revised gets its own row rather than
 * overwriting the history of the drawing it replaced.
 *
 *   * The revision filed is the one that was INDEXED (knowledge_documents
 *     .source_rev), never merely the current one (DWG-1): a mirror whose
 *     indexed version is not the controlled document's current version, or
 *     whose indexed label disagrees with it, is reported `skipped` with the
 *     reason and nothing is recorded for it.
 *   * A sheet already recorded at this revision, in this library, with
 *     anything but `skipped`, is not re-audited (DWG-13 — sheetsNeedingAudit)
 *     — provided the row COVERED it: every document filed under that number
 *     is on the row's `coverage`, with the basis its verdict would be
 *     computed from now (verdictBasis): its own index, the index of every
 *     sheet its connectors and references resolve to, and the set. A
 *     sibling sheet's verdict never stands for a sheet that was skipped or
 *     added since; a rebuild that changed a sheet's index re-audits it; so
 *     does a change in a sheet it points at, or in the set. A sheet whose
 *     revision is unknown ("") always is audited: "unrevised" cannot be
 *     established for it, and its row takes the latest settled verdict.
 *     Nor is a row written PROVISIONAL ever done: it is judged again on
 *     every record until a settled verdict replaces it — the document it
 *     waits on can stop waiting without being read (a controller accepts
 *     its partial index, or its indexing fails), and nothing in its basis
 *     need change then (review fix pass 9). The set's basis names, for each
 *     document not read whole, which kind it is — accepted, failed, in
 *     flight or parked — so a verdict computed while it was one is judged
 *     again once it is another.
 *   * A sheet that is not read whole (pages AI vision never read: parked,
 *     an accepted partial index, a failed run; a failed document; one still
 *     being indexed) is no evidence: a box, or a reference back, not found
 *     on what was read of it is unchecked — `unpaired`, never `unreturned`,
 *     never one-way — and a sheet that is not found is no gap when such a
 *     document may hold it (review fix pass 4): ANY sheet, while it is still
 *     being read (parked, in flight — review fix pass 6); otherwise a sheet
 *     of its own drawing, of a series it declares two drawings of, or any
 *     sheet when its number was never read. A box is paired on the SHEET its
 *     connector names (the page whose title block declares it), so a page
 *     whose box numbers were never read is never box-complete because
 *     another page's were (review fix pass 5), and a connector that names no
 *     sheet is never `unreturned` while a page of its destination declares
 *     no number and had no box numbers read; a connector whose destination
 *     no document declares, while a document still being read may hold it,
 *     is `unpaired` and waits on it (review fix pass 6) — and so is one a
 *     document whose re-index FAILED may hold (its title block cleared), and
 *     one naming a sheet no page of its drawing declares (review fix pass
 *     7) — unless another document not read whole for now may hold that
 *     sheet, when it waits on that one (review fix pass 8). Only a document
 *     in flight (queued, stale, mid-read) may hold ANY sheet; a parked one
 *     holds by the settled rule (review fix pass 7) — and a gap it does not
 *     hold that way, or a connector into the set's scope no document
 *     declares, still waits on it while it is parked (review fix pass 8).
 *     Broken stays exactly what the sheet itself shows.
 *   * A verdict with a finding that waits on a document not read whole only
 *     FOR NOW (parked, failed, still being indexed — not an accepted partial
 *     index) is provisional: it never overwrites a settled verdict for what
 *     is unsettled in it — the row and its coverage are left untouched and
 *     the sheet is reported under `waitingOn` — and the next computation may
 *     replace it down to what it settled (replaceDecision; review fix pass
 *     5). That holds under an unknown revision too, over a settled row
 *     (review fix pass 6) and over a provisional one (review fix pass 7). A
 *     missing sheet never waits on a FAILED document, which only a person's
 *     re-index changes; a finding about the failed document itself does
 *     (stillBeingRead). A document filed under the same key that is not
 *     read whole for now — a sibling sheet parked, or reset with its title
 *     block cleared — leaves the verdict provisional too: its findings are
 *     not in it yet (awaitingFiled, review fix pass 7). So nothing is
 *     refused while a sheet is being indexed: fix pass 4's 409 for the whole
 *     library is gone.
 *   * Under an unknown revision the latest settled verdict replaces the row
 *     — except while a document is still being read (in flight, or parked
 *     on AI vision), when one that would LOWER what the row settled waits:
 *     what that document has yet to declare can take a finding out of the
 *     set's scope (review fix pass 7 for a document in flight, 8 for a
 *     parked one).
 *   * A stored verdict under a known revision is never replaced by a less
 *     severe one (RANK — replaceDecision): what a row SETTLED is never
 *     lowered.
 *   * A gap ("isn't in the set") is judged only inside a series the library
 *     holds — two or more different numbers of it (seriesHeldBySet). A
 *     sheet in a series the library does not hold is recorded for what is
 *     its own (its connectors, its boxes), and references into that series
 *     are out of the set's scope. The series not judged are named on the
 *     record.
 *   * Pages AI vision never read (an accepted partial index) keep a sheet
 *     from passing; the finding says why they are unread.
 *   * A missing sheet is filed against EVERY sheet that references it, not
 *     only the six the lens lists (review fix pass 5).
 *   * A sheet that is not ready and declares no drawing number has no key
 *     yet: it is reported under notRecorded, never filed under its filename
 *     (review fix pass 4).
 *   * Nothing is recorded from a partial read of the index (DWG-11).
 *   * Before 20261124 (no library_id) the verdicts are still recorded, on
 *     the org-wide key that database has: prior rows read org-wide, the
 *     upsert on (org, sheet, revision) — the base's write path, with the
 *     RANK guard it lacked. A row another library filed (or one that never
 *     said which) is never lowered, whatever its revision; only this
 *     library's own unknown-revision row takes the latest verdict. The
 *     response says so (`legacyKey`).
 */
async function recordAudit(orgId: string, libraryId: string, userId: string) {
  const { docs, error: docErr } = await loadVisibleDocs(orgId, userId, libraryId);
  if (docErr) return bad(docErr, docErr === "Not a member of this workspace" ? 403 : 500);
  if (docs.length === 0) {
    return NextResponse.json({ recorded: 0, counts: {}, sheets: [], alreadyRecorded: [], notRecorded: [], keptStored: [], waitingOn: [] });
  }

  // A sheet being indexed right now (queued or mid-read) is not refused for
  // the whole library (review fix pass 5): it is not read whole, so what is
  // not found on it is unchecked, and a verdict that waits on it is
  // provisional — never overwriting a settled one (replaceDecision).
  const index = await loadEntityIndex(docs.map((d) => d.id));
  if (index.error === "migration-missing") {
    return bad("Drawing intelligence needs migration 20260921 — run it, then rebuild the index.", 424);
  }
  if (index.error) return bad(index.error, 500);
  if (index.truncated) {
    return bad(
      "This library's index holds more rows than one pass can read whole, so nothing was recorded — an audit " +
      "computed from part of the set would file gaps that are not there. Ask your admin to apply migration " +
      "20261124 (the database then does the counting), or split the library.",
      409,
    );
  }

  // The keyed record (20261124): this library's prior verdicts, with what
  // each covered. Before 20261124 there is no library_id: the org-wide key
  // that database has is read, and written, instead (legacyKey).
  type PriorRow = { sheet_number: string; revision_code: string; status: string; audit_details?: unknown };
  const readPrior = (scoped: boolean) => readAllPages<PriorRow>((from, to, withCount) => {
    let q = supabaseAdmin
      .from("drawing_audit_logs")
      .select(scoped ? "sheet_number, revision_code, status, audit_details, library_id" : "sheet_number, revision_code, status, audit_details",
        withCount ? { count: "exact" } : undefined)
      .eq("org_id", orgId);
    if (scoped) q = q.eq("library_id", libraryId);
    return q.order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<PageResult<PriorRow>>;
  }, Number.POSITIVE_INFINITY);
  let legacyKey = false;
  let prior = await readPrior(true);
  if (prior.error && isMissingColumn(prior.error)) {
    legacyKey = true;
    prior = await readPrior(false);
  }
  if (prior.error) {
    if (isMissingTable(prior.error)) {
      return bad("Audit memory needs migration 20260929 — run it in Supabase, then record the audit again.", 424);
    }
    return bad(prior.error.message, 500);
  }

  const nameById = new Map(docs.map((d) => [d.id, d.name]));
  const { selfByDoc, selfPages, refsByDoc } = indexMaps(index);
  // A sheet not read whole is no evidence of what it lacks (review fix pass
  // 4): what is not found on it is unchecked, never a defect of the sheet
  // that points at it.
  const incomplete = notReadWhole(docs);
  // The documents not read whole only for now (parked, failed, in flight),
  // and of those the ones still being read, which a missing sheet waits on
  // (review fix pass 6).
  const forNow = forNowIncomplete(docs, incomplete);
  const beingRead = stillBeingRead(docs, forNow);
  // …and of those, the ones in flight, which may hold ANY sheet (review fix
  // pass 7: a parked document holds by the settled rule; review fix pass 8:
  // a gap it does not hold that way waits on it, and so does a connector
  // into the set's scope no document declares).
  const inFlight = inFlightOf(docs, beingRead);
  const audit = auditDrawingRefs(docs.map((d) => ({ id: d.id, name: d.name })), refsByDoc, selfByDoc, null, incomplete, inFlight, beingRead);
  const pageCounts = new Map(docs.map((d) => [d.id, Number(d.page_count ?? 0)]));
  const opc = auditOpcBoxes(index.opc, selfByDoc, nameById, incomplete, selfPages, { pageCounts, inProgress: inFlight, forNow, reading: beingRead });
  // The documents an unchecked finding waits on, when they are not read
  // whole only for now: such a finding is provisional (review fix pass 5).
  // A finding about one named document waits on it while it is parked,
  // failed or in flight; a sheet the set is missing waits only on documents
  // still being read — never on a failed one, which a person must re-index
  // (one whose number was never read would otherwise suspend every gap in
  // the library; review fix pass 6). Each document's label is built once
  // (review fix pass 7: mid-rebuild every finding may name every document
  // in flight).
  const statusById = new Map(docs.map((d) => [d.id, d.status]));
  const labelById = new Map<string, string>();
  const labelOf = (id: string): string => {
    let label = labelById.get(id);
    if (label === undefined) {
      label = `${nameById.get(id) ?? "Sheet"} (${incomplete.get(id)}${statusById.get(id) === "error" ? " — re-index it" : ""})`;
      labelById.set(id, label);
    }
    return label;
  };
  const waitsOn = (ids: readonly (string | undefined)[], among: ReadonlySet<string> = forNow): string[] => [...new Set(ids)]
    .filter((id): id is string => !!id && among.has(id))
    .map(labelOf);
  /** A document filed under a verdict's key that is not read whole only for
   *  now: what the verdict waits on (awaitingFiled). */
  const pendingOf = (id: string): string | null => (forNow.has(id) ? labelOf(id) : null);

  // The set's scope (DWG-6): the series this library holds. A sheet in a
  // series it does not hold is still recorded; gaps in that series are not
  // judged.
  // Judged by real drawing numbers only — the SAME as the lens (review fix
  // pass 9: a prose document's filename made a series "PUMP" not judged).
  const identities = new Map(docs.map((d) => [d.id, sheetIdentities(d.name, selfByDoc.get(d.id) ?? [])]));
  const numbers = new Map(docs.map((d) => [d.id, sheetDrawingNumbers(d.name, selfByDoc.get(d.id) ?? [])]));
  const heldSeries = seriesHeldBySet(numbers);
  const notJudged = seriesNotJudged(numbers);

  // What each verdict is computed FROM (DWG-13): the document's own index;
  // the index of every document its connectors and references resolve to —
  // whether a box comes back, or a reference is returned, is read off THAT
  // sheet; and the set (every number the library's sheets answer to: what
  // is missing, which series are held). A verdict stands only while all
  // three are what it was computed from (verdictBasis).
  const rowsByDoc = new Map<string, EntityRollupRow[]>();
  for (const r of index.rollup) rowsByDoc.set(r.document_id, [...(rowsByDoc.get(r.document_id) ?? []), r]);
  const opcByDoc = new Map<string, EntityRow[]>();
  for (const o of index.opc) opcByDoc.set(o.document_id, [...(opcByDoc.get(o.document_id) ?? []), o]);
  const ownPrint = new Map(docs.map((d) => [d.id, indexFingerprint({
    rows: rowsByDoc.get(d.id) ?? [], opc: opcByDoc.get(d.id) ?? [], unreadPages: d.vision_failed_pages ?? [],
  })]));
  // The set as judged: every number its sheets answer to — and, while any
  // is not read whole, which (review fix pass 4): a sheet "not found in what
  // was read of the set" is re-judged once the document that may hold it is
  // read whole, whether or not that document's own numbers change.
  // …and which KIND of not read whole each is (review fix pass 9): an
  // accepted partial index, a failed document, one in flight, or one parked
  // all carry the same "page(s) N never read" when their unread pages are
  // listed, yet they wait — or hold a sheet — differently. Fix pass 8
  // digested the label alone, so a parked document accepted or failed left
  // every verdict that waited on it "already recorded" for good.
  const kindOf = (d: DocRow): string => isAcceptedPartial(d) ? "accepted"
    : d.status === "error" ? "failed"
    : inFlight.has(d.id) ? "inflight" : "parked";
  const partlyRead = docs.filter((d) => incomplete.has(d.id)).map((d) => `${d.id}:${incomplete.get(d.id)}:${kindOf(d)}`).sort();
  const setPrint = digest([...new Set([...identities.values()].flat())].sort().join("\n") +
    (partlyRead.length > 0 ? `\u0002${partlyRead.join("\n")}` : ""));
  const refTargets = drawingRefTargets(docs.map((d) => ({ id: d.id, name: d.name })), refsByDoc, selfByDoc);
  const fingerprints = new Map(docs.map((d) => {
    const near = new Set([...(refTargets.get(d.id) ?? []), ...(opc.targetsByDoc.get(d.id) ?? [])]);
    near.delete(d.id);
    return [d.id, verdictBasis(ownPrint.get(d.id) ?? "", [...near].map((n) => `${n}:${ownPrint.get(n) ?? ""}`), setPrint)];
  }));
  // The controlled documents the mirrors stand for: current version + rev.
  const mirrored = [...new Set(docs.map((d) => d.source_document_id).filter((id): id is string => !!id))];
  const ctrlById = new Map<string, { rev: string; current_version_id: string | null }>();
  for (let i = 0; i < mirrored.length; i += 100) {
    const { data: rows, error } = await supabaseAdmin
      .from("documents").select("id, rev, current_version_id").eq("org_id", orgId).in("id", mirrored.slice(i, i + 100));
    if (error) return bad(error.message, 500);
    for (const r of (rows ?? []) as Array<{ id: string; rev?: string | null; current_version_id?: string | null }>) {
      ctrlById.set(r.id, { rev: String(r.rev ?? ""), current_version_id: r.current_version_id ?? null });
    }
  }

  const withEntities = new Set([...index.rollup.map((r) => r.document_id), ...index.opc.map((o) => o.document_id)]);

  const notRecorded: Array<{ name: string; sheetNumber: string; revision: string; status: "skipped"; reason: string }> = [];
  const sheets: AuditSheet[] = [];
  for (const d of docs) {
    // The title block's declared number is the sheet's real identity — the
    // SAME number the lens shows (DWG-10); the filename is a fallback.
    const sheetNumber = declaredSheetIdentity(selfByDoc.get(d.id) ?? []).base ?? d.name;
    let revision = "";
    if (d.source_document_id) {
      const ctrl = ctrlById.get(d.source_document_id);
      if (!ctrl) {
        notRecorded.push({ name: d.name, sheetNumber, revision: d.source_rev ?? "", status: "skipped", reason: "its controlled document could not be read" });
        continue;
      }
      if (d.source_version_id && ctrl.current_version_id && d.source_version_id !== ctrl.current_version_id) {
        notRecorded.push({
          name: d.name, sheetNumber, revision: ctrl.rev, status: "skipped",
          reason: `the index was read from an earlier version (${d.source_rev || "unknown revision"}) than the controlled document's current one (${ctrl.rev || "unlabelled"}) — re-index it first`,
        });
        continue;
      }
      revision = (d.source_rev ?? "").trim() || ctrl.rev;
      if (d.source_rev && ctrl.rev && !sameRev(d.source_rev, ctrl.rev)) {
        notRecorded.push({
          name: d.name, sheetNumber, revision: d.source_rev, status: "skipped",
          reason: `the indexed revision (${d.source_rev}) disagrees with the controlled document's (${ctrl.rev})`,
        });
        continue;
      }
    }
    // A sheet that is not ready and declared no drawing number has no key
    // yet: filed under its filename, its `skipped` would be a row under a
    // number the sheet does not have — never re-recorded, never removed,
    // and not the number the lens will show once it is read (DWG-10). It is
    // reported instead (review fix pass 4).
    if (!isReadyHere(d) && !declaredSheetIdentity(selfByDoc.get(d.id) ?? []).base) {
      notRecorded.push({
        name: d.name, sheetNumber, revision, status: "skipped",
        reason: d.status === "error"
          ? "its indexing failed before its drawing number was read — re-index it"
          : "it is still waiting to finish indexing — its drawing number is not read yet",
      });
      continue;
    }
    sheets.push({
      documentId: d.id,
      controlledDocumentId: d.source_document_id,
      name: d.name,
      sheetNumber,
      revision,
      indexed: isReadyHere(d) && withEntities.has(d.id),
    });
  }

  // DWG-13: a sheet already recorded at this revision in this library (with
  // anything but `skipped`), from the index it holds now, is done — not
  // re-audited, not rewritten. A sheet whose revision is unknown never is.
  const coverageOf = (details: unknown): Record<string, string> | null => {
    const c = (details as { coverage?: unknown } | null)?.coverage;
    return c && typeof c === "object" && !Array.isArray(c) ? c as Record<string, string> : null;
  };
  // A provisional row is never done (review fix pass 9): it is judged again
  // on every record, and replaceDecision keeps that from lowering what it
  // settled.
  const priorRows = prior.rows.map((r) => ({
    ...r, coverage: coverageOf(r.audit_details), provisional: storedProvisional(r.audit_details),
  }));
  const needing = new Set(sheetsNeedingAudit(sheets, priorRows, fingerprints).map((s) => s.documentId));
  const alreadyRecorded = sheets.filter((s) => !needing.has(s.documentId)).map((s) => {
    const p = priorRows.find((r) => r.sheet_number === s.sheetNumber && r.revision_code === s.revision && r.status !== "skipped");
    return { name: s.name, sheetNumber: s.sheetNumber, revision: s.revision, status: p?.status ?? "recorded" };
  });

  const verdicts = verdictsForSheets(sheets.filter((s) => needing.has(s.documentId)), {
    connectorsWithNoTarget: opc.noRef.map((n) => ({ sheet: n.sheet, box: n.box })),
    unreturnedConnectors: opc.unreturned.map((u) => ({ from: u.from, to: u.to, box: u.box })),
    // Every referencing sheet — never the lens's six (review fix pass 5). A
    // gap waits on the documents parked on AI vision: one of their unread
    // pages may yet declare it (review fix pass 8).
    missingInSeries: missingWithinHeldSeries(audit.missingInSeries, heldSeries)
      .map((m) => ({ ref: m.ref, referencedBy: m.referencedByAll, waitsOn: waitsOn(m.pendingIds ?? [], beingRead) })),
    oneWay: audit.oneWay.map((o) => ({ from: o.from, to: o.to })),
    unreadableConnectors: opc.unknown.map((u) => ({ sheet: u.sheet, box: u.box })),
    // A box the pairing could not check on a target not read whole waits on
    // it while that is only for now; one whose destination no document
    // declares waits on the documents not read whole for now that may hold
    // it — in flight, parked, or failed with its title block cleared, which
    // the destination may be (review fix passes 6 and 7); one on a page
    // whose box numbers were never read does not.
    unpairedConnectors: opc.unpaired.map((u) => ({
      from: u.from, to: u.to, box: u.box, unread: u.unread, why: u.why,
      waitsOn: u.unread ? waitsOn([u.toId]) : u.maybeInIds ? waitsOn(u.maybeInIds) : [],
    })),
    // Checks that needed a sheet nobody read whole: unchecked, never one-way
    // and never a gap (review fix pass 4) — kept whatever the held series
    // while a document still being read may hold the sheet: it may be what
    // made the series held (review fix pass 7).
    oneWayUnread: audit.oneWayUnread.map((o) => ({ from: o.from, to: o.to, unread: o.unread, waitsOn: waitsOn([o.toId]) })),
    missingUnread: missingUnreadInScope(audit.missingUnread, heldSeries, beingRead)
      .map((m) => ({ ref: m.ref, referencedBy: m.referencedByAll, maybeIn: m.maybeIn, waitsOn: waitsOn(m.maybeInIds, beingRead) })),
    // The pages nobody read are not a clean bill — and the finding says
    // whose decision left them unread: only a controller's accepted partial
    // index is "accepted" (review fix pass 4).
    unreadPages: docs
      .filter((d) => (d.vision_failed_pages ?? []).length > 0)
      .map((d) => ({
        sheet: d.name,
        pages: [...(d.vision_failed_pages ?? [])].sort((a, b) => a - b),
        why: isAcceptedPartial(d) ? "partial index accepted"
          : d.status === "error" ? "its indexing failed"
          : "waiting on AI vision",
      })),
  });

  // Two sheets of one set can declare the same number; the unique index would
  // reject the batch outright. One row per key: the more severe verdict, with
  // every document it covers and the basis each was computed from
  // (mergeVerdictsByKey).
  // A `skipped` member that is not read whole only for now leaves the
  // merged verdict provisional: its findings are not in it yet (review fix
  // pass 7).
  const merged = mergeVerdictsByKey(verdicts, (id) => fingerprints.get(id) ?? "", pendingOf);
  // …and never replace what a stored verdict SETTLED with something less
  // severe (DWG-6) — except under an unknown revision, where the latest
  // settled verdict is the only one that can be about the drawing in front
  // of us, unless a document is still being read, in flight or parked
  // (review fix passes 7 and 8) — nor
  // a verdict with a provisional one for what is unsettled in it, whatever
  // the revision (review fix pass 5; review fix passes 6 and 7 for the
  // unknown revision). A document the stored row covered that is not read
  // whole for now, and that this verdict does not cover (a sibling sheet
  // under the same number, its title block cleared by a rebuild), leaves
  // the verdict provisional too (awaitingFiled, review fix pass 7). On the
  // org-wide key (before 20261124) a row may be ANOTHER library's verdict,
  // computed over another set: that exception is for this library's own
  // row, and a row filed by another library (or by a writer that never said
  // which) is never lowered, whatever its revision.
  const libraryOf = (details: unknown) => (details as { libraryId?: unknown } | null)?.libraryId;
  const keptStored: Array<{ sheetNumber: string; revision: string; stored: string; computed: string }> = [];
  const waitingOn: Array<{ sheetNumber: string; revision: string; stored: string; computed: string; waitingOn: string[] }> = [];
  const beingReadNames = [...beingRead].sort().map(labelOf);
  const deduped: SheetVerdict[] = [];
  for (const computed of merged) {
    const stored = priorRows.find((r) => r.sheet_number === computed.sheetNumber && r.revision_code === computed.revision);
    if (!stored) { deduped.push(computed); continue; }
    const v = awaitingFiled(computed, Object.keys(coverageOf(stored.audit_details) ?? {}), pendingOf);
    const foreign = legacyKey && libraryOf(stored.audit_details) !== libraryId;
    const decision = replaceDecision(
      { revision_code: stored.revision_code, status: stored.status, provisional: storedProvisional(stored.audit_details) },
      v, { neverLower: foreign, stillReading: beingRead.size > 0 },
    );
    if (decision === "keep") {
      keptStored.push({ sheetNumber: v.sheetNumber, revision: v.revision, stored: stored.status, computed: v.status });
    } else if (decision === "wait") {
      waitingOn.push({
        sheetNumber: v.sheetNumber, revision: v.revision, stored: stored.status, computed: v.status,
        // A settled computation waits only on the documents still being
        // read (in flight or parked).
        waitingOn: capWaitingOn(v.provisional?.waitingOn ?? beingReadNames),
      });
    } else deduped.push(v);
  }

  if (deduped.length > 0) {
    const scope = {
      libraryId,
      sheets: docs.map((d) => declaredSheetIdentity(selfByDoc.get(d.id) ?? []).base ?? d.name),
      seriesNotJudged: notJudged,
    };
    const rows = verdictRows(orgId, deduped, userId, scope);
    // Before 20261124: the org-wide key that database has, and no
    // library_id column (the library stays in audit_details).
    const { error: writeError } = legacyKey
      ? await supabaseAdmin
        .from("drawing_audit_logs")
        .upsert(rows.map(({ library_id: _library, ...row }) => row), { onConflict: "org_id,sheet_number,revision_code" })
      : await supabaseAdmin
        .from("drawing_audit_logs")
        .upsert(rows, { onConflict: "org_id,library_id,sheet_number,revision_code" });
    if (writeError) {
      return bad(
        isMissingTable(writeError)
          ? "Audit memory needs migration 20260929 — run it in Supabase, then record the audit again."
          : isMissingColumn(writeError) || /no unique or exclusion constraint/i.test(writeError.message)
            ? "Audit memory needs migration 20261124 (verdicts kept per library) — run it in Supabase, then record the audit again. Nothing was recorded."
            : writeError.message,
        isMissingTable(writeError) || isMissingColumn(writeError) || /no unique or exclusion constraint/i.test(writeError.message) ? 424 : 500,
      );
    }
  }

  const counts = deduped.reduce<Record<string, number>>((acc, v) => {
    acc[v.status] = (acc[v.status] ?? 0) + 1;
    return acc;
  }, {});
  return NextResponse.json({
    recorded: deduped.length,
    counts,
    sheets: deduped.map((v) => ({
      sheetNumber: v.sheetNumber, revision: v.revision, status: v.status,
      findings: [
        ...v.details.brokenConnectors, ...v.details.missingReferences, ...v.details.oneWay,
        ...v.details.unreadableConnectors, ...v.details.unpairedConnectors, ...v.details.uncheckedReferences,
        ...v.details.unreadPages,
      ],
      // Recorded provisional: what it waits on (named to six, the rest
      // counted — review fix pass 7), and what is settled.
      ...(v.provisional ? { waitingOn: capWaitingOn(v.provisional.waitingOn), settledStatus: v.provisional.settledStatus } : {}),
    })),
    // DWG-13: what was NOT re-audited, and why.
    alreadyRecorded,
    notRecorded,
    // Stored verdicts left as they are: one a computation would lower
    // (keptStored), and one a computation differs from only in what waits
    // on a sheet not read whole yet (waitingOn — judged again once it is).
    keptStored,
    waitingOn,
    // DWG-6: series the library holds no more than one number of — gaps in
    // them not judged.
    seriesNotJudged: notJudged,
    // Before 20261124: recorded on the org-wide key, one verdict per sheet
    // and revision across every library.
    ...(legacyKey ? {
      legacyKey: true,
      notice: "Recorded on the org-wide key: until migration 20261124 is applied, one verdict per sheet and revision is " +
        "kept across all libraries, and a verdict another library recorded is never lowered by this one. Apply it to " +
        "keep each library's verdict separately.",
    } : {}),
  });
}
