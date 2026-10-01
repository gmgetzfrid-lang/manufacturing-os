// lib/workPackages.ts
//
// WORK PACKAGES — self-watching job bundles.
//
// A package pins each member document's revision at assembly. Freshness is
// COMPUTED at read time (pin vs current_version_id) — no trigger state to
// drift. When a publish advances a doc that sits in open packages, the
// publish path calls notifyPackagesOfRevUp() so every package owner hears
// about it within seconds, not at the job site.
//
// Pre-migration tolerance: every helper degrades to empty/no-op if the
// 20260825 tables aren't applied yet.
//
// Document-control Round F (P8 FIELD): a member the reader cannot open is
// "unknown", never silently fresh, and its pin is never NULLed (PKG-7); a
// re-pin is recorded before it moves anything (DRLS-10); the print snapshot
// is a checked write that also records what the print LEFT OUT (VFY-18 /
// VFY-19).

import { supabase } from "@/lib/supabase";
import { emit } from "@/lib/notify/dispatch";
import { logAuditAction } from "@/lib/audit";
import { isPackLeftOutCode, type PackLeftOutCode } from "@/lib/packLeftOut";
import type { PackSheetRef, PackSkip } from "@/lib/docPack";

/** PKG-7: a member's freshness as the READER can know it. `unknown` = the
 *  document row is not readable by this person (RLS hides a private /
 *  hidden document; the read failed) — it is neither fresh nor drifted. */
export type WorkPackageDocFreshness = "fresh" | "drifted" | "unknown";

export interface WorkPackageDoc {
  id: string;
  documentId: string;
  docLabel: string;
  libraryId: string | null;
  pinnedVersionId: string | null;
  pinnedRevLabel: string | null;
  currentRev: string | null;
  /** TRUE when the document has advanced past the pinned revision. */
  drifted: boolean;
  /** PKG-7: false when this reader cannot read the member's document. */
  readable: boolean;
  freshness: WorkPackageDocFreshness;
}

export interface WorkPackage {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  status: "open" | "executing" | "closed";
  ownerUserId: string;
  ownerName: string | null;
  createdAt: string;
  docs: WorkPackageDoc[];
  staleCount: number;
  /** PKG-7: members whose freshness this reader cannot know — a package
   *  with any is never shown as plainly "Fresh". */
  unknownCount: number;
}

/** PKG-7: the label of a member the reader cannot open — named as what it
 *  is, never the bare "Document" that read like a rendering bug. */
export const RESTRICTED_MEMBER_LABEL = "Restricted document";

/** PKG-7: one member's freshness. Pure. */
export function memberFreshness(
  pinnedVersionId: string | null,
  doc: { current_version_id?: unknown } | null | undefined,
): WorkPackageDocFreshness {
  if (!doc) return "unknown";
  const current = (doc.current_version_id as string | null) ?? null;
  return !!pinnedVersionId && !!current && pinnedVersionId !== current ? "drifted" : "fresh";
}

let pkgSchemaMissing = false;
export function resetPackageSchemaFlag(): void { pkgSchemaMissing = false; }

function isMissingPkgSchema(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205" || e.code === "PGRST204" || e.code === "42703") return true;
  const msg = (e.message ?? "").toLowerCase();
  return msg.includes("work_package") &&
    (msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("could not find"));
}

/** Every non-closed package for the org, with per-doc freshness computed. */
export async function listWorkPackages(
  orgId: string,
  opts?: { includeClosed?: boolean },
): Promise<WorkPackage[]> {
  if (pkgSchemaMissing) return [];
  try {
    let q = supabase
      .from("work_packages")
      .select("*")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });
    if (!opts?.includeClosed) q = q.neq("status", "closed");
    const { data: pkgs, error } = await q;
    if (error) {
      if (isMissingPkgSchema(error)) { pkgSchemaMissing = true; return []; }
      throw new Error(error.message);
    }
    const pkgRows = (pkgs as Array<Record<string, unknown>>) ?? [];
    if (pkgRows.length === 0) return [];

    // PKG-12: a deterministic member order (joined first, then id) — the
    // order the package lists, prints and covers its sheets in.
    const { data: memberRows } = await supabase
      .from("work_package_documents")
      .select("*")
      .in("package_id", pkgRows.map((p) => String(p.id)))
      .order("added_at", { ascending: true })
      .order("id", { ascending: true });
    const members = (memberRows as Array<Record<string, unknown>>) ?? [];

    const docIds = [...new Set(members.map((m) => String(m.document_id)))];
    const docById = new Map<string, Record<string, unknown>>();
    if (docIds.length > 0) {
      // A failed read leaves every member UNKNOWN (PKG-7) — never "fresh".
      const { data: docs, error: docErr } = await supabase
        .from("documents")
        .select("id, document_number, title, name, rev, library_id, current_version_id")
        .in("id", docIds);
      if (!docErr) for (const d of (docs as Array<Record<string, unknown>>) ?? []) docById.set(String(d.id), d);
    }

    return pkgRows.map((p) => {
      const docs: WorkPackageDoc[] = members
        .filter((m) => String(m.package_id) === String(p.id))
        .map((m) => {
          const doc = docById.get(String(m.document_id));
          const pinned = (m.pinned_version_id as string | null) ?? null;
          const freshness = memberFreshness(pinned, doc);
          return {
            id: String(m.id),
            documentId: String(m.document_id),
            docLabel: doc ? String(doc.document_number || doc.title || doc.name || "Document") : RESTRICTED_MEMBER_LABEL,
            libraryId: (doc?.library_id as string | null) ?? null,
            pinnedVersionId: pinned,
            pinnedRevLabel: (m.pinned_rev_label as string | null) ?? null,
            currentRev: (doc?.rev as string | null) ?? null,
            drifted: freshness === "drifted",
            readable: !!doc,
            freshness,
          };
        });
      return {
        id: String(p.id),
        orgId: String(p.org_id),
        name: String(p.name),
        description: (p.description as string | null) ?? null,
        status: (p.status as WorkPackage["status"]) ?? "open",
        ownerUserId: String(p.owner_user_id),
        ownerName: (p.owner_name as string | null) ?? null,
        createdAt: String(p.created_at),
        docs,
        staleCount: docs.filter((d) => d.drifted).length,
        unknownCount: docs.filter((d) => d.freshness === "unknown").length,
      };
    });
  } catch {
    return [];
  }
}

/** Create a package, pinning each document's CURRENT revision. PKG-7: every
 *  chosen document must be readable — one the creator cannot read used to be
 *  dropped silently (the package was created without it); now nothing is
 *  created and the refusal says how many. */
export async function createWorkPackage(input: {
  orgId: string;
  name: string;
  description?: string;
  documentIds: string[];
  actorUserId: string;
  actorName: string;
}): Promise<string> {
  const requested = [...new Set(input.documentIds)];
  let docRows: Array<Record<string, unknown>> = [];
  if (requested.length > 0) {
    const { data: docs, error: docErr } = await supabase
      .from("documents")
      .select("id, rev, current_version_id")
      .in("id", requested);
    if (docErr) throw new Error(`Couldn't read the chosen documents (${docErr.message}) — the package was not created.`);
    docRows = (docs as Array<Record<string, unknown>>) ?? [];
    const found = new Set(docRows.map((d) => String(d.id)));
    const missing = requested.filter((id) => !found.has(id)).length;
    if (missing > 0) {
      throw new Error(
        `${missing} of the ${requested.length} chosen document${requested.length === 1 ? "" : "s"} could not be read with your access, ` +
        "so the package was not created — a package must pin every sheet it lists. Remove them, or ask Document Control to build it.",
      );
    }
  }

  const { data: pkg, error } = await supabase
    .from("work_packages")
    .insert({
      org_id: input.orgId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      owner_user_id: input.actorUserId,
      owner_name: input.actorName,
    })
    .select("id")
    .single();
  if (error || !pkg) {
    if (isMissingPkgSchema(error)) {
      pkgSchemaMissing = true;
      throw new Error("Work packages need the 20260825 migration applied first.");
    }
    throw new Error(error?.message || "Could not create the package");
  }

  const rows = docRows.map((d) => ({
    org_id: input.orgId,
    package_id: pkg.id as string,
    document_id: String(d.id),
    pinned_version_id: (d.current_version_id as string | null) ?? null,
    pinned_rev_label: (d.rev as string | null) ?? null,
    added_by: input.actorName,
  }));
  if (rows.length > 0) {
    const { error: memberErr } = await supabase.from("work_package_documents").insert(rows);
    if (memberErr) throw new Error(memberErr.message);
  }
  return pkg.id as string;
}

/** Add one document to an open package, pinned at its current revision.
 *  Returns "added" for a new member, or "already" if the document was already
 *  in the package — in which case the pin is LEFT WHERE IT IS. Silently
 *  re-pinning an existing member (the old upsert behaviour) would move the
 *  pin out from under any pack already printed and verified against it
 *  (PKG-2); moving a pin is `refreshWorkPackage`'s explicit job, not a
 *  side effect of clicking "Add" again. */
export async function addDocumentToPackage(input: {
  packageId: string; orgId: string;
  doc: { id: string; rev?: string | null; currentVersionId?: string | null };
  actorName?: string | null;
}): Promise<"added" | "already"> {
  const { data: existing, error: lookupErr } = await supabase
    .from("work_package_documents")
    .select("id")
    .eq("package_id", input.packageId)
    .eq("document_id", input.doc.id)
    .maybeSingle();
  if (lookupErr) throw new Error(lookupErr.message);
  if (existing) return "already";

  const { error } = await supabase.from("work_package_documents").insert({
    package_id: input.packageId,
    org_id: input.orgId,
    document_id: input.doc.id,
    pinned_version_id: input.doc.currentVersionId ?? null,
    pinned_rev_label: input.doc.rev ?? null,
    added_at: new Date().toISOString(),
    added_by: input.actorName ?? null,
  });
  // A concurrent add can still race us to the unique (package, document);
  // treat that as "already", not an error.
  if (error) {
    if ((error as { code?: string }).code === "23505") return "already";
    throw new Error(error.message);
  }
  return "added";
}

/** VFY-18: a print whose snapshot could not be written. Its cover QR could
 *  never be verified (a bare-package QR reads grey "can't confirm which
 *  printing" on every scan — DEC-65 §2), so the print STOPS: thrown from the
 *  cover step, before anything is downloaded and before any pin moves. */
export class PackagePrintNotRecordedError extends Error {
  readonly code = "print_not_recorded" as const;
  constructor(detail: string) {
    super(
      `The pack was NOT printed: its print record could not be written (${detail}), so its cover QR could never ` +
      "be verified in the field. Nothing was downloaded and no pins moved — try again; if it keeps failing, tell Document Control.",
    );
    this.name = "PackagePrintNotRecordedError";
  }
}

/** One sheet of a printed pack, as the snapshot records it. */
export interface PrintSnapshotSheet {
  documentId: string; versionId: string | null; revLabel: string | null; label: string;
}

/** VFY-19: one sheet the print LEFT OUT, as the snapshot records it — the
 *  code /api/verify-package publishes and the reason the printer was shown
 *  (kept for Document Control; never published). */
export interface PrintSnapshotLeftOut {
  documentId: string; label: string; code: PackLeftOutCode; reason: string; versionId?: string | null;
}

/** The `sheets` JSONB of a print snapshot. Every printed sheet carries
 *  `printed: true` and every left-out one `printed: false` with its code —
 *  so a snapshot recorded since VFY-19 is told apart from an older one (no
 *  `printed` key at all), whose verdict keeps the present-tense split. A
 *  print always holds at least one sheet, so the marker is always present.
 *  Pure. */
export function printSnapshotSheets(
  sheets: PrintSnapshotSheet[],
  leftOut: PrintSnapshotLeftOut[] = [],
): Array<Record<string, unknown>> {
  const printed = new Set(sheets.map((s) => s.documentId));
  const out: Array<Record<string, unknown>> = sheets.map((s) => ({ ...s, printed: true }));
  const seen = new Set<string>();
  for (const l of leftOut) {
    if (!l.documentId || printed.has(l.documentId) || seen.has(l.documentId)) continue;
    seen.add(l.documentId);
    out.push({
      documentId: l.documentId,
      versionId: l.versionId ?? null,
      revLabel: null,
      label: l.label,
      printed: false,
      leftOutCode: isPackLeftOutCode(l.code) ? l.code : null,
      leftOutReason: l.reason,
    });
  }
  return out;
}

/** Record an immutable PRINT SNAPSHOT of a package: the exact version of every
 *  sheet as printed (PKG-2), and every package sheet the print left out with
 *  its reason (VFY-19). The cover QR encodes the returned print id, and
 *  /api/verify-package compares these recorded versions against current — so
 *  a later pin refresh can never flip already-distributed paper back to green.
 *  VFY-18: a CHECKED write — a refused or failed insert throws
 *  PackagePrintNotRecordedError (it used to return null, and the pack shipped
 *  with a bare-package QR that could never read green while the page said
 *  success). The table has been live since 20261028. */
export async function recordPackagePrint(input: {
  orgId: string; packageId: string;
  printedBy?: string | null; printedByName?: string | null;
  sheets: PrintSnapshotSheet[];
  leftOut?: PrintSnapshotLeftOut[];
}): Promise<string> {
  let detail: string;
  try {
    const { data, error } = await supabase.from("work_package_prints").insert({
      org_id: input.orgId,
      package_id: input.packageId,
      printed_by: input.printedBy ?? null,
      printed_by_name: input.printedByName ?? null,
      sheets: printSnapshotSheets(input.sheets, input.leftOut),
    }).select("id").single();
    const id = (data?.id as string | undefined) ?? null;
    if (!error && id) return id;
    detail = error?.message || "the database returned no print id";
  } catch (e) {
    detail = (e as Error)?.message || String(e);
  }
  console.error("[work_package_prints] print snapshot NOT recorded — the print is stopped:", detail);
  throw new PackagePrintNotRecordedError(detail);
}

/** Re-pin members to their document's current revision ("refresh pack").
 *  `onlyDocumentIds` narrows the refresh to specific sheets — the print path
 *  uses it so pins move ONLY for documents actually in the printed PDF
 *  (PKG-6); omit it for the whole-pack "Refresh pins" button.
 *  PKG-7: a member whose document this person cannot read is NEVER written
 *  (it used to be re-pinned to NULL, destroying the pin) — the others move
 *  and the refresh then fails naming how many did not.
 *  DRLS-10: a re-pin RESOLVES a stale signal, it must not erase it — the
 *  members that had drifted (pinned → current) are written to the audit
 *  trail as WORK_PACKAGE_REPINNED BEFORE any pin moves; if that record
 *  cannot be written, nothing moves. */
export async function refreshWorkPackage(
  packageId: string,
  opts?: {
    onlyDocumentIds?: string[];
    /** Who is moving the pins, for the WORK_PACKAGE_REPINNED record (the
     *  signed-in user when omitted). */
    actor?: { userId: string; email?: string | null };
    /** What moved them: the "Refresh pins" button, or a print. */
    reason?: "refresh" | "print";
  },
): Promise<void> {
  const { data: members, error: memberErr } = await supabase
    .from("work_package_documents")
    .select("id, document_id, org_id, pinned_version_id, pinned_rev_label")
    .eq("package_id", packageId);
  if (memberErr) throw new Error(`Couldn't read the package's pins (${memberErr.message}) — nothing moved.`);
  let rows = (members as Array<{
    id: string; document_id: string; org_id?: string | null;
    pinned_version_id?: string | null; pinned_rev_label?: string | null;
  }>) ?? [];
  if (opts?.onlyDocumentIds) {
    const only = new Set(opts.onlyDocumentIds);
    rows = rows.filter((r) => only.has(r.document_id));
  }
  if (rows.length === 0) return;
  const { data: docs, error: docErr } = await supabase
    .from("documents")
    .select("id, rev, current_version_id")
    .in("id", rows.map((r) => r.document_id));
  if (docErr) throw new Error(`Couldn't read the package's documents (${docErr.message}) — nothing moved.`);
  const byId = new Map(((docs as Array<Record<string, unknown>>) ?? []).map((d) => [String(d.id), d]));
  const readable = rows.filter((r) => byId.has(r.document_id));
  const unreadable = rows.length - readable.length;

  // DRLS-10: the stale signal, on the record before it is resolved.
  const moved = readable
    .map((r) => {
      const d = byId.get(r.document_id)!;
      return {
        documentId: r.document_id,
        fromVersionId: r.pinned_version_id ?? null,
        fromRev: r.pinned_rev_label ?? null,
        toVersionId: (d.current_version_id as string | null) ?? null,
        toRev: (d.rev as string | null) ?? null,
      };
    })
    .filter((m) => m.fromVersionId !== m.toVersionId);
  if (moved.length > 0) {
    const actor = opts?.actor ?? await signedInActor();
    const { error: auditErr } = await logAuditAction({
      action: "WORK_PACKAGE_REPINNED",
      resourceType: "work_package",
      resourceId: packageId,
      orgId: (rows[0].org_id as string | null | undefined) ?? undefined,
      userId: actor.userId,
      userEmail: actor.email ?? undefined,
      details: { reason: opts?.reason ?? "refresh", staleCount: moved.length, moved },
    });
    if (auditErr) {
      throw new Error(
        `The re-pin could not be recorded (${auditErr}), so no pin moved — a package that had gone stale ` +
        "is only refreshed with a record that it had. Try again.",
      );
    }
  }

  // Check every write. A silent no-op here (e.g. an RLS miss) previously let
  // the UI announce "Package refreshed" while every pin stayed stale — the
  // exact lie a work package exists to prevent.
  const results = await Promise.all(readable.map((r) => {
    const d = byId.get(r.document_id)!;
    return supabase
      .from("work_package_documents")
      .update({
        pinned_version_id: (d.current_version_id as string | null) ?? null,
        pinned_rev_label: (d.rev as string | null) ?? null,
      })
      .eq("id", r.id)
      .select("id");
  }));
  const failed = results.filter((res) => res.error).length;
  const unmatched = results.filter((res) => !res.error && ((res.data as unknown[]) ?? []).length === 0).length;
  if (failed > 0 || unmatched > 0) {
    throw new Error(
      failed > 0
        ? `Refresh failed for ${failed} of ${rows.length} pins: ${results.find((r) => r.error)?.error?.message}`
        : `Refresh matched 0 rows for ${unmatched} of ${rows.length} pins — the pins did NOT move. Moving pins requires being the package's owner or Document Control (PKG-5); on an older database, apply migration 20260828 and retry.`,
    );
  }
  if (unreadable > 0) {
    throw new Error(
      `${unreadable} of ${rows.length} pins were NOT moved: you cannot open ${unreadable === 1 ? "that document" : "those documents"}, ` +
      "so their current revision is unknown to you (their pins are left exactly as they were). Ask Document Control to refresh them.",
    );
  }
}

/** The signed-in user, for a record written without an explicit actor. */
async function signedInActor(): Promise<{ userId: string; email?: string | null }> {
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user?.id) throw new Error("Not signed in — no pin moved.");
  return { userId: user.id, email: user.email ?? null };
}

/** DRLS-10 (app half): closing reports a refusal instead of a silent no-op —
 *  the write selects its row back, and zero rows is "not allowed", never
 *  "closed". (The database's work_packages UPDATE policy is still
 *  member-level; narrowing it to the owner and controllers is a migration.) */
export async function setWorkPackageStatus(
  packageId: string,
  status: WorkPackage["status"],
  actorName?: string,
): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (status === "closed") {
    patch.closed_at = new Date().toISOString();
    patch.closed_by = actorName ?? null;
  }
  const { data, error } = await supabase.from("work_packages").update(patch).eq("id", packageId).select("id");
  if (error) throw new Error(error.message);
  if (((data as unknown[] | null) ?? []).length === 0) {
    throw new Error("The package was not changed — only its owner or Document Control can close it.");
  }
}

/**
 * Called from the publish path: a new revision just landed on `documentId`.
 * Every OPEN/EXECUTING package containing it goes effectively stale — tell
 * each package owner now, not at the job site. Fire-and-forget.
 */
export async function notifyPackagesOfRevUp(input: {
  orgId: string;
  documentId: string;
  docLabel: string;
  newRev: string;
  actorUserId: string;
  actorName: string;
}): Promise<void> {
  if (pkgSchemaMissing) return;
  try {
    const { data: memberRows, error } = await supabase
      .from("work_package_documents")
      .select("package_id")
      .eq("document_id", input.documentId);
    if (error) {
      if (isMissingPkgSchema(error)) pkgSchemaMissing = true;
      return;
    }
    const pkgIds = [...new Set(((memberRows as Array<{ package_id: string }>) ?? []).map((r) => r.package_id))];
    if (pkgIds.length === 0) return;
    const { data: pkgs } = await supabase
      .from("work_packages")
      .select("id, name, owner_user_id")
      .in("id", pkgIds)
      .neq("status", "closed");
    for (const p of (pkgs as Array<{ id: string; name: string; owner_user_id: string }>) ?? []) {
      void emit({
        orgId: input.orgId,
        category: "watched",
        kind: "doc_superseded",
        title: `Work package "${p.name}" went stale`,
        body: `${input.docLabel} advanced to Rev ${input.newRev} — the package still pins the older revision. Review the change, then refresh the pack (or swap the print set) before execution.`,
        link: `/packages`,
        resource: { type: "document", id: input.documentId },
        actorUserId: input.actorUserId,
        actorName: input.actorName,
        audience: { involved: [p.owner_user_id] },
        metadata: { workPackageId: p.id },
      });
    }
  } catch { /* non-blocking */ }
}

/** PKG-12: each cover entry's page range in the finished pack — the cover's
 *  own pages come first, then every sheet in pack order. Pure. */
export function coverEntryLabels(
  sheets: Array<Pick<PackSheetRef, "label" | "pageCount">>,
  coverPages: number,
): string[] {
  let next = coverPages + 1;
  return sheets.map((s) => {
    const n = Math.max(1, s.pageCount || 1);
    const first = next;
    const last = next + n - 1;
    next = last + 1;
    // The page reference is kept clear of the cover's width fit, which
    // truncates a long label from its end.
    const label = s.label.length > 44 ? `${s.label.slice(0, 43)}…` : s.label;
    return `${label} · ${n === 1 ? `p. ${first}` : `pp. ${first}–${last}`}`;
  });
}

/** VFY-19: every sheet a print left out — the gate's refusals before the
 *  build and the builder's own — once per document, in the order found. */
export function mergeLeftOut(...lists: PackSkip[][]): PackSkip[] {
  const out: PackSkip[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const s of list) {
      const key = s.documentId ?? `label:${s.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}
