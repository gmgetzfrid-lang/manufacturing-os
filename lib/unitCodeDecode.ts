// lib/unitCodeDecode.ts — SERVER-ONLY. The unit-identity decode's planner and
// writer, shared by every server path that writes documents.unit_code
// (intelligence GAP-305 / GAP-314; DEC-67).
//
// Extracted verbatim from POST /api/admin/unit-identity (the one-off
// backfill, I-13), which now imports it — its behaviour is unchanged: the
// keyset reader that pages until an EMPTY window (readAll), the Site
// Codebook's unit entries read whole (readCodebookUnits, loadDecodeBook), the
// guarded documents.unit_code writes (documentChunks — a write lands only
// while the document's number is still one the plan decoded) and the bounded
// waves that apply them (applyWrites). The rules themselves stay in
// lib/operationalGraph.ts planUnitIdentity (the codebook's own parser —
// never a guess).
//
// decodeDocumentUnitCodes (GAP-314, document-control P13) decodes a given set
// of documents right after they are created or renumbered, so the relation
// does not wait for someone to run the backfill: it RE-READS each document's
// stored number (never a number or code a caller sends), plans with the same
// planner, writes through the same guarded writes, and answers per document
// with the code or the reason there is none. intelligence I-11 reuses it for
// the Bridge at ingest.
//
// Writer: the service role. 20261138's trg_documents_unit_code_guard makes
// documents.unit_code decode-only — a person's write is refused, the service
// role passes — so this module must never reach a browser bundle (it imports
// lib/supabaseAdmin).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadCodebookAdmin } from "@/lib/codebookServer";
import { isMissingColumn, isMissingRelation } from "@/lib/orgGraph";
import type { Codebook, CodebookEntry } from "@/lib/codebook";
import { planUnitIdentity, type UnitIdentityDoc, type UnitMappingRow } from "@/lib/operationalGraph";

const PAGE = 1000;
export const WRITE_CHUNK = 200;
/** Document writes carry their numbers too, so fewer ids per request keep
 *  the request line bounded. */
const DOC_WRITE_CHUNK = 100;
/** Write chunks in flight at once. */
const WRITE_WAVE = 4;

export type PgErr = { code?: string; message: string };

/** The builder calls the reads and the guarded writes use. */
export interface Narrowable {
  eq(col: string, v: unknown): Narrowable;
  in(col: string, v: readonly unknown[]): Narrowable;
  is(col: string, v: null): Narrowable;
  gt(col: string, v: unknown): Narrowable;
  order(col: string, o?: { ascending?: boolean }): Narrowable;
  limit(n: number): PromiseLike<{ data: unknown; error: PgErr | null }>;
  select(cols: string): PromiseLike<{ data: unknown[] | null; error: PgErr | null }>;
}

/** Every row of an org's table, in keyset order (id ascending), in windows
 *  of at most PAGE. It stops only at an EMPTY window, never at a short one:
 *  PostgREST cuts a response at db-max-rows WITHOUT an error, and a project
 *  whose max-rows is set below PAGE returns short windows that are not the
 *  end — stopping there would plan the decode over a cut set and report it
 *  whole. The keyset (id > the last id read) makes the extra request safe. */
export async function readAll<T extends { id: string }>(
  table: string, select: string, orgId: string, narrow?: (q: Narrowable) => Narrowable,
): Promise<{ rows: T[]; error: PgErr | null }> {
  const rows: T[] = [];
  let last: string | null = null;
  for (;;) {
    let q = (supabaseAdmin.from(table).select(select) as unknown as Narrowable).eq("org_id", orgId);
    if (narrow) q = narrow(q);
    if (last !== null) q = q.gt("id", last);
    const { data, error } = await q.order("id", { ascending: true }).limit(PAGE);
    if (error) return { rows, error: error as PgErr };
    const batch = ((data ?? []) as unknown) as T[];
    if (batch.length === 0) return { rows, error: null };
    rows.push(...batch);
    last = String(batch[batch.length - 1].id);
  }
}

/** One UPDATE: the columns it writes, the rows, the condition the plan was
 *  made on, and (when the database decides the value) which returned rows
 *  landed as planned. */
export type Chunk = {
  patch: Record<string, unknown>; ids: string[]; guard: (q: Narrowable) => Narrowable;
  returning?: string; landed?: (row: Record<string, unknown>) => boolean;
};

export const slices = (ids: string[], n: number): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += n) out.push(ids.slice(i, i + n));
  return out;
};

/** A number PostgREST's in-list carries verbatim (postgrest-js quotes `,()`
 *  but not `"` or `\`; padding is not trusted). Any other number is matched
 *  one document at a time with eq. */
const inListable = (n: string) => n !== "" && n.trim() === n && !/["\\]/.test(n);

/** documents.unit_code writes. Every document planned for one value has a
 *  number that decodes to that value (or, for a clear, to nothing), so the
 *  write lands only while the document's number is still one of those. */
export function documentChunks(groups: Array<[string | null, string[]]>, numberOf: Map<string, string | null>): Chunk[] {
  const chunks: Chunk[] = [];
  for (const [value, ids] of groups) {
    const unnumbered: string[] = [], listed: string[] = [];
    for (const id of ids) {
      const n = numberOf.get(id) ?? null;
      if (n === null) unnumbered.push(id);
      else if (inListable(n)) listed.push(id);
      else chunks.push({ patch: { unit_code: value }, ids: [id], guard: (q) => q.eq("document_number", n) });
    }
    for (const part of slices(unnumbered, DOC_WRITE_CHUNK)) chunks.push({ patch: { unit_code: value }, ids: part, guard: (q) => q.is("document_number", null) });
    for (const part of slices(listed, DOC_WRITE_CHUNK)) {
      const numbers = [...new Set(part.map((id) => numberOf.get(id) as string))];
      chunks.push({ patch: { unit_code: value }, ids: part, guard: (q) => q.in("document_number", numbers) });
    }
  }
  return chunks;
}

/** Apply one table's chunks in bounded parallel waves. `written` landed as
 *  planned; `changed` no longer matched the plan's condition (changed or
 *  deleted since the read) and were left as they are, or the database placed
 *  them by a mapping that changed since the read; `refused` met an error. */
export async function applyWrites(
  table: "documents" | "assets", orgId: string, chunks: Chunk[],
): Promise<{ written: number; changed: number; refused: number; firstError: string | null }> {
  let written = 0, changed = 0, refused = 0;
  let firstError: string | null = null;
  for (let w = 0; w < chunks.length; w += WRITE_WAVE) {
    const wave = chunks.slice(w, w + WRITE_WAVE);
    const results = await Promise.all(wave.map(({ patch, ids, guard, returning }) => guard(
      (supabaseAdmin.from(table).update(patch) as unknown as Narrowable).eq("org_id", orgId).in("id", ids),
    ).select(returning ?? "id")));
    results.forEach(({ data, error }, i) => {
      const n = wave[i].ids.length;
      if (error) { refused += n; firstError ??= error.message; return; }
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      const landed = wave[i].landed ? rows.filter(wave[i].landed!).length : rows.length;
      written += landed;
      changed += n - landed;
    });
  }
  return { written, changed, refused, firstError };
}

/** The Site Codebook's unit entries, every one (keyset pages). null: the
 *  codebook tables are not there (pre-migration — no opinion). */
export async function readCodebookUnits(orgId: string): Promise<{ units: CodebookEntry[] | null; error: PgErr | null }> {
  const r = await readAll<{ id: string; code: string; label: string; meta: CodebookEntry["meta"] | null; sort: number | null; origin: string | null }>(
    "codebook_entries", "id, kind, code, label, meta, sort, origin", orgId, (q) => q.eq("kind", "unit"));
  if (r.error) return isMissingRelation(r.error) ? { units: null, error: null } : { units: null, error: r.error };
  const units = r.rows.map((e): CodebookEntry => ({
    id: String(e.id), kind: "unit", code: String(e.code), label: String(e.label),
    meta: e.meta ?? {}, sort: Number(e.sort ?? 0), origin: e.origin === "import" ? "import" : "manual",
  }));
  units.sort((a, b) => (a.sort - b.sort) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return { units, error: null };
}

/** The Site Codebook as the decode reads it: the book, with its unit list
 *  from a WHOLE read (readCodebookUnits) rather than the one request
 *  loadCodebookAdmin makes, which PostgREST cuts at max-rows. An error: the
 *  units could not be read, so nothing may be planned. */
export async function loadDecodeBook(orgId: string): Promise<{ book: Codebook; error: null } | { book: null; error: PgErr }> {
  const loaded = await loadCodebookAdmin(supabaseAdmin, orgId);
  // The book's unit list from a whole read, never from the one cut request.
  const cbUnits = await readCodebookUnits(orgId);
  if (cbUnits.error) return { book: null, error: cbUnits.error };
  return { book: cbUnits.units === null ? loaded : { ...loaded, units: cbUnits.units }, error: null };
}

/** At most this many documents per decodeDocumentUnitCodes call. */
export const DECODE_MAX_DOCUMENTS = 200;

/** One document's decode, as decodeDocumentUnitCodes answers it. */
export interface DocumentUnitDecode {
  documentId: string;
  /** documents.unit_code as it stands after the call (null: none). */
  unitCode: string | null;
  outcome:
    | "decoded"      // the number decodes to a unit the codebook holds; written
    | "unchanged"    // it already carried what the number decodes to (or nothing, and decodes to nothing)
    | "cleared"      // a stale code was cleared: the number no longer decodes to a held unit
    | "not_decoded"  // no code: the reason says why (no number, no match, no unit segment, an unknown unit)
    | "no_opinion"   // the codebook has no number format or no units: nothing is decided or written
    | "changed"      // the number changed between the read and the write: left as it is
    | "refused"      // the write was refused (the reason is the database's)
    | "not_found";   // no such document in the org
  /** Why there is no code (or why nothing was written). null when decoded. */
  reason: string | null;
}

/** Can this Site Codebook decode a number at all — a number format with
 *  segments, and units? Without both the planner has no opinion. */
function bookCanDecode(book: Codebook): boolean {
  return !!book.drawingNumber && book.drawingNumber.segments.length > 0 && book.units.length > 0;
}

/** The reason the planner gives for ONE document (its report, never a guess). */
function reasonFor(doc: UnitIdentityDoc, units: UnitMappingRow[], book: Codebook): { reason: string | null; noOpinion: boolean } {
  const plan = planUnitIdentity({ docs: [doc], assets: [], units, book, dryRun: true, seesRestricted: true });
  const d = plan.report.documents;
  if (!bookCanDecode(book)) return { reason: plan.report.notes[0] ?? "The Site Codebook cannot decode a number.", noOpinion: true };
  if (d.noNumber > 0) return { reason: "The document has no number to decode.", noOpinion: false };
  if (d.notDecoding.count > 0) return { reason: d.notDecoding.samples[0]?.reason ?? "The number does not match the Site Codebook's number format.", noOpinion: false };
  if (d.noUnitSegment > 0) return { reason: "The number decodes, but the Site Codebook's number format has no unit segment.", noOpinion: false };
  if (d.unknownUnit.count > 0) {
    return { reason: `The number decodes to unit ${d.unknownUnit.codes[0]?.code ?? "?"}, which the Site Codebook does not hold.`, noOpinion: false };
  }
  return { reason: null, noOpinion: false }; // decoded to a unit the codebook holds
}

/** GAP-314: decode these documents' stored numbers NOW (service role), with
 *  the backfill's planner and guarded writes. Re-reads each document by id
 *  IN `orgId` — a number or a code from the caller is never trusted. A
 *  document whose number changed between the read and the write is left as
 *  it is (`changed`); nothing is ever guessed. Throws only when the decode
 *  could not be planned at all (the codebook's units or the documents could
 *  not be read); `notApplied` when 20261138 is not pasted yet.
 *
 *  `noOpinion` (P13 third review fix): the org's Site Codebook cannot decode
 *  a number at all (no number format, or no units) — checked ONCE, before
 *  the units and the documents are read: nothing is read, decided or
 *  written, and `results` is empty (the caller records and reports
 *  nothing; an org without a codebook is not a follow-up). */
export async function decodeDocumentUnitCodes(input: { orgId: string; documentIds: string[] }): Promise<{ results: DocumentUnitDecode[]; notApplied: boolean; noOpinion?: boolean }> {
  const ids = [...new Set(input.documentIds.filter((x) => typeof x === "string" && x.length > 0))].slice(0, DECODE_MAX_DOCUMENTS);
  if (ids.length === 0) return { results: [], notApplied: false };
  const whole = await loadDecodeBook(input.orgId);
  if (whole.error) throw new Error(`The Site Codebook's units could not be read: ${whole.error.message}`);
  const book = whole.book;
  if (!bookCanDecode(book)) return { results: [], notApplied: false, noOpinion: true };
  const units = await readAll<UnitMappingRow>("units", "id, codebook_code", input.orgId, (q) => q.eq("archived", false));
  if (units.error) {
    if (isMissingColumn(units.error)) return { results: [], notApplied: true };
    throw new Error(`Operational units could not be read: ${units.error.message}`);
  }
  const { data, error } = await supabaseAdmin.from("documents")
    .select("id, document_number, unit_code, unit_id, visibility").eq("org_id", input.orgId).in("id", ids);
  if (error) {
    if (isMissingColumn(error)) return { results: [], notApplied: true };
    throw new Error(`The documents could not be read: ${error.message}`);
  }
  const docs = ((data ?? []) as unknown) as UnitIdentityDoc[];
  const byId = new Map(docs.map((d) => [d.id, d] as const));

  // One plan for the writes (the backfill's), one reason per document.
  const plan = planUnitIdentity({ docs, assets: [], units: units.rows, book, dryRun: false, seesRestricted: true });
  const numberOf = new Map(docs.map((d) => [d.id, d.document_number ?? null] as const));
  const writeOf = new Map<string, string | null>();
  for (const [value, wIds] of plan.docWrites) for (const id of wIds) writeOf.set(id, value);
  // Write each planned value group; read back which ids landed.
  const landed = new Set<string>();
  const refusedReason = new Map<string, string>();
  for (const [value, wIds] of plan.docWrites) {
    for (const chunk of documentChunks([[value, wIds]], numberOf)) {
      const r = await applyWrites("documents", input.orgId, [chunk]);
      if (r.refused > 0) for (const id of chunk.ids) refusedReason.set(id, r.firstError ?? "the write was refused");
      else if (r.written === chunk.ids.length) for (const id of chunk.ids) landed.add(id);
      else {
        // part of the chunk changed since the read: ask which rows hold the value now
        const { data: now } = await supabaseAdmin.from("documents")
          .select("id, unit_code").eq("org_id", input.orgId).in("id", chunk.ids);
        for (const row of ((now ?? []) as Array<{ id: string; unit_code: string | null }>)) {
          if ((row.unit_code ?? null) === value) landed.add(row.id);
        }
      }
    }
  }

  const results: DocumentUnitDecode[] = ids.map((id) => {
    const doc = byId.get(id);
    if (!doc) return { documentId: id, unitCode: null, outcome: "not_found", reason: "No such document in this organization." };
    const { reason, noOpinion } = reasonFor(doc, units.rows, book);
    const before = doc.unit_code ?? null;
    if (noOpinion) return { documentId: id, unitCode: before, outcome: "no_opinion", reason };
    if (!writeOf.has(id)) {
      return { documentId: id, unitCode: before, outcome: before !== null ? "unchanged" : (reason ? "not_decoded" : "unchanged"), reason };
    }
    if (refusedReason.has(id)) return { documentId: id, unitCode: before, outcome: "refused", reason: refusedReason.get(id)! };
    if (!landed.has(id)) {
      return { documentId: id, unitCode: before, outcome: "changed", reason: "The document's number changed while it was decoded — left as it is; it is decoded again after its next change or by the next unit-identity run." };
    }
    const value = writeOf.get(id) ?? null;
    if (value === null) return { documentId: id, unitCode: null, outcome: before !== null ? "cleared" : "not_decoded", reason };
    return { documentId: id, unitCode: value, outcome: "decoded", reason: null };
  });
  return { results, notApplied: false };
}
