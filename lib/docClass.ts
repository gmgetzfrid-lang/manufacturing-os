// lib/docClass.ts
//
// DOCUMENT CLASS — the declared kind of a controlled document, and the single
// place the "which change process applies?" question gets answered.
//
// PSM (OSHA 1910.119) and ISO document control treat a P&ID and a procedure
// very differently: a drawing is CAD-controlled — field redlines are INPUT to
// a drafting cycle, and a non-minor change needs a Management of Change
// reference before it may publish. A procedure is text-controlled — its
// effective owner (or a granted publisher) releases revisions directly,
// through the review gate when one is configured.
//
// The class is DECLARED, never guessed: guessing from filenames would misroute
// safety-critical documents. Resolution mirrors review_control exactly —
// document -> collection -> library, most specific DEFINED level wins — so
// DocCtrl declares once per library ("this library is P&IDs") and everything
// inherits. `suggestDocClass` exists only to prefill the declaration UI from
// hard evidence (an attached CAD source file, a CAD file extension); a
// suggestion is never enforcement.
//
// Pre-migration tolerance: before 20261012 adds the doc_class columns, every
// resolver returns null ("unclassified") and the app behaves exactly as it
// did before this feature existed.

import { supabase } from "@/lib/supabase";

export type DocClass = "drawing" | "procedure";

/** True when the error means the 20261012 doc_class columns aren't applied. */
function isMissingDocClassSchema(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === "42703" || e.code === "PGRST204") return true;
  const msg = (e.message ?? "").toLowerCase();
  return msg.includes("doc_class") && (msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("could not find"));
}

// Once detected missing, stop querying for the session.
let docClassSchemaMissing = false;

/** Test hook / manual reset after the user applies the migration. */
export function resetDocClassSchemaFlag(): void {
  docClassSchemaMissing = false;
}

const isDocClass = (v: unknown): v is DocClass => v === "drawing" || v === "procedure";

/** Most specific DEFINED level wins — identical to resolveEffectiveReviewControl. */
export function resolveEffectiveDocClass(
  docClass?: string | null,
  folderClass?: string | null,
  libraryClass?: string | null,
): DocClass | null {
  for (const c of [docClass, folderClass, libraryClass]) {
    if (isDocClass(c)) return c;
  }
  return null;
}

/**
 * Resolve the class that applies to THIS document from the live DB chain.
 * Null = unclassified (or pre-migration env) — callers must degrade to
 * today's behavior, never assume a class.
 */
export async function effectiveDocClassForDocument(doc: {
  id?: string | null;
  collectionId?: string | null;
  libraryId?: string | null;
}): Promise<DocClass | null> {
  if (docClassSchemaMissing) return null;
  try {
    let docLevel: string | null = null;
    let folderLevel: string | null = null;
    let libLevel: string | null = null;
    if (doc.id) {
      const { data, error } = await supabase.from("documents").select("doc_class").eq("id", doc.id).maybeSingle();
      if (error) throw error;
      docLevel = (data as { doc_class?: string | null } | null)?.doc_class ?? null;
    }
    if (doc.collectionId) {
      const { data, error } = await supabase.from("collections").select("doc_class").eq("id", doc.collectionId).maybeSingle();
      if (error) throw error;
      folderLevel = (data as { doc_class?: string | null } | null)?.doc_class ?? null;
    }
    if (doc.libraryId) {
      const { data, error } = await supabase.from("libraries").select("doc_class").eq("id", doc.libraryId).maybeSingle();
      if (error) throw error;
      libLevel = (data as { doc_class?: string | null } | null)?.doc_class ?? null;
    }
    return resolveEffectiveDocClass(docLevel, folderLevel, libLevel);
  } catch (e) {
    if (isMissingDocClassSchema(e)) { docClassSchemaMissing = true; return null; }
    console.warn("[docClass] resolve failed", e);
    return null;
  }
}

const CAD_EXTENSIONS = new Set(["dwg", "dxf", "dgn", "rvt", "ipt", "iam", "sldprt", "sldasm", "step", "stp"]);

/**
 * Evidence-based SUGGESTION for the declaration UI — never enforcement.
 * A CAD source file in custody, or a CAD-native file type, suggests 'drawing';
 * office-document types suggest 'procedure'; anything else stays unsuggested.
 */
export function suggestDocClass(input: {
  fileType?: string | null;
  sourceFileName?: string | null;
}): DocClass | null {
  const ext = (name?: string | null) => (name ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (input.sourceFileName && CAD_EXTENSIONS.has(ext(input.sourceFileName))) return "drawing";
  const ft = (input.fileType ?? "").toLowerCase().replace(/^\./, "");
  if (CAD_EXTENSIONS.has(ft)) return "drawing";
  if (["doc", "docx", "odt", "rtf", "txt", "md"].includes(ft)) return "procedure";
  return null;
}

/**
 * Write a doc_class declaration at one level. Controller-gated at the call
 * sites (same trust model as setReviewControlPolicy). Pass null to clear the
 * level back to "inherit". Throws with a plain message pre-migration.
 */
export async function setDocClass(input: {
  level: "library" | "collection" | "document";
  id: string;
  docClass: DocClass | null;
}): Promise<void> {
  const table = input.level === "library" ? "libraries" : input.level === "collection" ? "collections" : "documents";
  const { error } = await supabase.from(table).update({ doc_class: input.docClass }).eq("id", input.id);
  if (error) {
    if (isMissingDocClassSchema(error)) {
      docClassSchemaMissing = true;
      throw new Error("Document classes need the 20261012 migration — run it in Supabase first.");
    }
    throw new Error(error.message);
  }
}
