// lib/ticketNewDocumentHandback.ts
//
// drafting-flow DCW-4 (DF-P15 fix, on review): the recovery for "Publish as a
// new document in <library>" when the document was CREATED but its hand-back
// was not recorded on the request (its first version could not be read back,
// or /api/tickets/handback refused — a 409 when the ticket changed in
// between, a 503, a dropped connection). The new document already exists, so
// the page must never offer to create a second one: it finds the version that
// already carries the ticket and records THAT (the hand-back route checks it
// again — this ticket's provenance, in this org, of a document in the
// request's library — before writing anything).
//
// findTicketNewDocumentVersion reads, through the caller's client (RLS
// applies — a version the caller cannot see is not offered), the versions in
// the ticket's workspace that carry the ticket as provenance
// (document_versions.related_ticket_id, written by createDocumentWithFile's
// relatedTicketId), then keeps the first one whose document is in the
// request's library. A failed read is "unknown", never "none": the page then
// neither re-offers creation nor claims nothing was created.
//
// DCW-4 remainder (ruled by the integrator at the DF-P15 merge, 2026-10-20,
// DEC-90): a request with neither a source document nor a library has no
// library of its own — its publisher chooses one. `libraryId` may then be the
// LIST of libraries the caller may put a first revision into (the page's
// choices): the first version carrying the ticket whose document is in any
// of them is found.

export type TicketNewDocumentVersion = {
  versionId: string;
  documentId: string;
  documentNumber: string | null;
  revisionLabel: string;
};

export type TicketNewDocumentLookup =
  | { kind: "found"; version: TicketNewDocumentVersion }
  | { kind: "none" }
  | { kind: "unknown"; error: string };

type QueryResult = PromiseLike<{ data: unknown; error: { message?: string } | null }>;
type Chain = { eq(c: string, v: unknown): Chain; in(c: string, v: unknown[]): Chain; order(c: string, o: { ascending: boolean }): Chain } & QueryResult;
/** A Supabase client (the caller's — RLS applies). */
export interface NewDocumentLookupClient {
  from(table: string): unknown;
}
const selectFrom = (db: NewDocumentLookupClient, table: string, columns: string): Chain =>
  (db.from(table) as { select(c: string): Chain }).select(columns);

/** The version the ticket's new document carries, if one exists (see the header). */
export async function findTicketNewDocumentVersion(
  db: NewDocumentLookupClient,
  input: { orgId: string; ticketRowId: string; libraryId: string | readonly string[]; documentId?: string | null },
): Promise<TicketNewDocumentLookup> {
  try {
    let q = selectFrom(db, "document_versions", "id, record_id, revision_label, created_at")
      .eq("org_id", input.orgId)
      .eq("related_ticket_id", input.ticketRowId);
    if (input.documentId) q = q.eq("record_id", input.documentId);
    const { data: versions, error: vErr } = await q.order("created_at", { ascending: true });
    if (vErr) return { kind: "unknown", error: vErr.message || "the register could not be read" };
    const rows = ((versions as Array<{ id?: string; record_id?: string; revision_label?: string | null }> | null) ?? [])
      .filter((v) => typeof v.id === "string" && typeof v.record_id === "string");
    if (rows.length === 0) return { kind: "none" };
    const docIds = Array.from(new Set(rows.map((v) => v.record_id as string)));
    const libraries = typeof input.libraryId === "string" ? [input.libraryId] : Array.from(input.libraryId);
    if (libraries.length === 0) return { kind: "none" };
    const docsQ = selectFrom(db, "documents", "id, document_number, library_id").eq("org_id", input.orgId);
    const { data: docs, error: dErr } = await (typeof input.libraryId === "string"
      ? docsQ.eq("library_id", input.libraryId)
      : docsQ.in("library_id", libraries)
    ).in("id", docIds);
    if (dErr) return { kind: "unknown", error: dErr.message || "the register could not be read" };
    const wanted = new Set(libraries);
    const inLibrary = new Map(((docs as Array<{ id?: string; document_number?: string | null; library_id?: string | null }> | null) ?? [])
      .filter((d) => typeof d.id === "string" && typeof d.library_id === "string" && wanted.has(d.library_id))
      .map((d) => [d.id as string, d.document_number ?? null]));
    const hit = rows.find((v) => inLibrary.has(v.record_id as string));
    if (!hit) return { kind: "none" };
    return {
      kind: "found",
      version: {
        versionId: hit.id as string,
        documentId: hit.record_id as string,
        documentNumber: inLibrary.get(hit.record_id as string) ?? null,
        revisionLabel: hit.revision_label || "0",
      },
    };
  } catch (e) {
    return { kind: "unknown", error: (e as Error)?.message || "the register could not be read" };
  }
}

/** What the page says when a new document exists but is not recorded on the
 *  request — never "create it again". */
export function newDocumentNotRecordedMessage(documentNumber: string, reason: string, canRetry: boolean): string {
  return canRetry
    ? `${documentNumber} is in the register, but it is not recorded on this request yet (${reason}). Use "Record ${documentNumber} on the request" (refresh first if the request changed), or tell Document Control. Do not create it again.`
    : `${documentNumber} is in the register, but it is not recorded on this request yet (${reason}). Refresh the page and use "Record the existing document", or tell Document Control. Do not create it again.`;
}
