// lib/uniqueness.ts
//
// Computes the document uniqueness key sent to the DB.
//
// The 20260619 migration replaced the hardcoded
// (library_id, document_number) unique index with
// (library_id, uniqueness_key). The key is composed in the app from
// the field tuple named in library.uniquenessKeys.
//
// Default: ["documentNumber"] — preserves the legacy behavior.
// Example: ["documentNumber","sheet"] — allows many sheets per number.
// Empty array: no uniqueness enforced (key returns null).

export interface DocFieldsForUniqueness {
  documentNumber?: string | null;
  title?: string | null;
  rev?: string | null;
  status?: string | null;
  customFields?: Record<string, unknown> | null;
}

export function computeUniquenessKey(
  doc: DocFieldsForUniqueness,
  uniquenessKeys: string[] | null | undefined,
): string | null {
  const keys = uniquenessKeys && uniquenessKeys.length > 0
    ? uniquenessKeys
    : ["documentNumber"];

  const parts = keys.map((k) => {
    let v: unknown;
    if (k === "documentNumber") v = doc.documentNumber;
    else if (k === "title") v = doc.title;
    else if (k === "rev") v = doc.rev;
    else if (k === "status") v = doc.status;
    else v = doc.customFields?.[k];
    return String(v ?? "").trim().toLowerCase();
  });

  if (parts.every((p) => !p)) return null;
  return parts.join("::");
}
