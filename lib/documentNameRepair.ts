// lib/documentNameRepair.ts — SERVER-ONLY. Find and correct document
// numbers / revisions the faulty filename reader produced (see
// lib/documentNames.ts for exactly what counts as faulty).
//
// Safe by construction:
//   • each row is re-read and re-checked at fix time, and the update only
//     lands if the number is still the faulty one (nobody edited it since)
//   • the uniqueness key is recomputed from the library's own rule; a
//     corrected number that would clash with another document is NOT
//     forced — it's reported with the document it clashes with, so a person
//     decides (usually: two files are revisions of one document)
//   • the current version's revision label follows a corrected revision
//   • every change is written to the audit log with its before and after

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { planNameFix, type NameFix } from "@/lib/documentNames";
import { computeUniquenessKey } from "@/lib/uniqueness";
import { inSlices } from "@/lib/inSlices";

const COLS = "id, library_id, name, title, document_number, rev, original_name:metadata->>original_name";

/** Every faulty name among `docIds`, each marked with any clash its
 *  corrected number would cause (another document already has it, or
 *  another file in this list corrects to the same number). */
export async function findNameFixes(docIds: string[]): Promise<{ fixes: NameFix[]; error: string | null }> {
  const fixes: NameFix[] = [];
  const libraryOf = new Map<string, string>();
  let readError: string | null = null;
  const pages = await inSlices(docIds, 100, 6, async (slice) => {
    const { data, error } = await supabaseAdmin.from("documents").select(COLS).in("id", slice);
    if (error) readError = error.message;
    return (data ?? []) as unknown as Array<Parameters<typeof planNameFix>[0] & { library_id: string }>;
  });
  if (readError) return { fixes, error: readError };
  for (const row of pages.flat()) {
    const fix = planNameFix(row);
    if (fix) { fixes.push(fix); libraryOf.set(fix.id, row.library_id); }
  }
  // Two files correcting to one number: usually two revisions of one document.
  const firstByNumber = new Map<string, NameFix>();
  for (const f of fixes) {
    const k = `${libraryOf.get(f.id)}|${f.to.documentNumber.toLowerCase()}`;
    const first = firstByNumber.get(k);
    if (first) f.clash = `same number as ${first.fileName}`;
    else firstByNumber.set(k, f);
  }
  // Already used by a document that isn't being corrected.
  const fixing = new Set(fixes.map((f) => f.id));
  const wanted = Array.from(new Set(fixes.filter((f) => !f.clash).map((f) => f.to.documentNumber)));
  const taken = new Map<string, string>();
  const libs = Array.from(new Set(libraryOf.values()));
  // A failed lookup just means fewer clashes flagged ahead of time — the
  // update itself still refuses a real clash.
  const takenPages = await inSlices(wanted, 100, 6, async (slice) => {
    const { data } = await supabaseAdmin.from("documents").select("id, library_id, document_number, name")
      .in("library_id", libs).in("document_number", slice)
      .not("status", "in", "(Archived,Superseded)");
    return (data ?? []) as Array<{ id: string; library_id: string; document_number: string; name: string | null }>;
  });
  for (const r of takenPages.flat()) {
    if (!fixing.has(r.id)) taken.set(`${r.library_id}|${r.document_number.toLowerCase()}`, `${r.document_number}${r.name ? ` (${r.name})` : ""}`);
  }
  for (const f of fixes) {
    const t = taken.get(`${libraryOf.get(f.id)}|${f.to.documentNumber.toLowerCase()}`);
    if (!f.clash && t) f.clash = `already used by ${t}`;
  }
  return { fixes, error: null };
}

export interface NameRepairResult {
  fixed: number;
  /** Changed since the check, or no longer faulty — left alone. */
  skipped: number;
  /** The corrected number is already taken: needs a person. */
  conflicts: Array<{ id: string; fileName: string; wanted: string; current: string; clashesWith: string | null }>;
  failed: Array<{ fileName: string; id?: string; reason: string }>;
  /** Not reached before the time budget ran out — call again. */
  remaining: number;
}

export async function repairDocumentNames(orgId: string, docIds: string[], uid: string, deadline = Date.now() + 35_000): Promise<NameRepairResult> {
  const out: NameRepairResult = { fixed: 0, skipped: 0, conflicts: [], failed: [], remaining: 0 };
  const changes: Array<{ id: string; from: NameFix["from"]; to: NameFix["to"] }> = [];
  const keysByLibrary = new Map<string, string[] | null>();

  let readError: string | null = null;
  const rows = (await inSlices(docIds, 100, 6, async (slice) => {
    const { data, error } = await supabaseAdmin.from("documents")
      .select(`${COLS}, status, metadata, current_version_id`)
      .eq("org_id", orgId).in("id", slice);
    if (error) readError = error.message;
    return (data ?? []) as Array<Record<string, unknown>>;
  })).flat();
  if (readError) {
    // Whatever couldn't be read is left for the next round — never guessed at.
    out.remaining = docIds.length - rows.length;
    out.failed.push({ fileName: `${out.remaining} documents`, reason: "couldn't be read just now — press Correct again" });
  }

  const fixOne = async (row: Record<string, unknown>) => {
    const fix = planNameFix(row as unknown as Parameters<typeof planNameFix>[0]);
    if (!fix) { out.skipped++; return; }
    const libraryId = row.library_id as string;
    if (!keysByLibrary.has(libraryId)) {
      const { data } = await supabaseAdmin.from("libraries").select("uniqueness_keys").eq("id", libraryId).maybeSingle();
      keysByLibrary.set(libraryId, Array.isArray(data?.uniqueness_keys) ? (data!.uniqueness_keys as string[]) : null);
    }
    const uniquenessKey = computeUniquenessKey({
      documentNumber: fix.to.documentNumber, title: fix.to.title, rev: fix.to.rev,
      status: row.status as string, customFields: (row.metadata as Record<string, unknown>) ?? null,
    }, keysByLibrary.get(libraryId));

    const { data: updated, error } = await supabaseAdmin.from("documents").update({
      document_number: fix.to.documentNumber, title: fix.to.title, rev: fix.to.rev,
      uniqueness_key: uniquenessKey, updated_at: new Date().toISOString(), updated_by: uid,
    }).eq("id", fix.id).eq("document_number", fix.from.documentNumber).eq("rev", fix.from.rev).select("id");

    if (error) {
      if (error.code === "23505") {
        const { data: clash } = await supabaseAdmin.from("documents").select("document_number, title, name")
          .eq("library_id", libraryId).eq("uniqueness_key", uniquenessKey ?? "").neq("id", fix.id).limit(1).maybeSingle();
        out.conflicts.push({
          id: fix.id, fileName: fix.fileName, wanted: fix.to.documentNumber, current: fix.from.documentNumber,
          clashesWith: clash ? `${clash.document_number ?? ""}${clash.name ? ` (${clash.name})` : ""}` : null,
        });
      } else out.failed.push({ fileName: fix.fileName, id: fix.id, reason: error.message });
      return;
    }
    if (!updated?.length) { out.skipped++; return; }

    // The current version carries the revision label shown on the file.
    if (fix.to.rev !== fix.from.rev && row.current_version_id) {
      await supabaseAdmin.from("document_versions").update({ revision_label: fix.to.rev })
        .eq("id", row.current_version_id as string).eq("revision_label", fix.from.rev)
        .then(() => undefined, () => undefined);
    }
    out.fixed++;
    changes.push({ id: fix.id, from: fix.from, to: fix.to });
  };

  // A handful at a time: hundreds of single-row updates, without hammering.
  // Stops starting new rows at the deadline, so a request is never cut off
  // mid-way by the host; the caller simply asks again for the rest.
  for (let i = 0; i < rows.length; i += 8) {
    if (Date.now() > deadline) { out.remaining += rows.length - i; break; }
    await Promise.all(rows.slice(i, i + 8).map(fixOne));
  }

  // One entry per document, so each document's own history shows the
  // correction (before and after) — and it can be put back by hand.
  for (let i = 0; i < changes.length; i += 200) {
    await supabaseAdmin.from("audit_logs").insert(changes.slice(i, i + 200).map((c) => ({
      action: "DOCUMENT_NAME_CORRECTED", resource_type: "document", resource_id: c.id,
      org_id: orgId, user_id: uid,
      details: { reason: "Read from the file name by the corrected reader", from: c.from, to: c.to },
    }))).then(() => undefined, () => undefined);
  }
  return out;
}
