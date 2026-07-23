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

import { supabase } from "@/lib/supabase";
import { notifyMany } from "@/lib/inAppNotifications";

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

    const { data: memberRows } = await supabase
      .from("work_package_documents")
      .select("*")
      .in("package_id", pkgRows.map((p) => String(p.id)));
    const members = (memberRows as Array<Record<string, unknown>>) ?? [];

    const docIds = [...new Set(members.map((m) => String(m.document_id)))];
    const docById = new Map<string, Record<string, unknown>>();
    if (docIds.length > 0) {
      const { data: docs } = await supabase
        .from("documents")
        .select("id, document_number, title, name, rev, library_id, current_version_id")
        .in("id", docIds);
      for (const d of (docs as Array<Record<string, unknown>>) ?? []) docById.set(String(d.id), d);
    }

    return pkgRows.map((p) => {
      const docs: WorkPackageDoc[] = members
        .filter((m) => String(m.package_id) === String(p.id))
        .map((m) => {
          const doc = docById.get(String(m.document_id));
          const pinned = (m.pinned_version_id as string | null) ?? null;
          const current = (doc?.current_version_id as string | null) ?? null;
          return {
            id: String(m.id),
            documentId: String(m.document_id),
            docLabel: String(doc?.document_number || doc?.title || doc?.name || "Document"),
            libraryId: (doc?.library_id as string | null) ?? null,
            pinnedVersionId: pinned,
            pinnedRevLabel: (m.pinned_rev_label as string | null) ?? null,
            currentRev: (doc?.rev as string | null) ?? null,
            drifted: !!pinned && !!current && pinned !== current,
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
      };
    });
  } catch {
    return [];
  }
}

/** Create a package, pinning each document's CURRENT revision. */
export async function createWorkPackage(input: {
  orgId: string;
  name: string;
  description?: string;
  documentIds: string[];
  actorUserId: string;
  actorName: string;
}): Promise<string> {
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

  const { data: docs } = await supabase
    .from("documents")
    .select("id, rev, current_version_id")
    .in("id", input.documentIds);
  const rows = ((docs as Array<Record<string, unknown>>) ?? []).map((d) => ({
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

/** Re-pin every member to the document's current revision ("refresh pack"). */
export async function refreshWorkPackage(packageId: string): Promise<void> {
  const { data: members } = await supabase
    .from("work_package_documents")
    .select("id, document_id")
    .eq("package_id", packageId);
  const rows = (members as Array<{ id: string; document_id: string }>) ?? [];
  if (rows.length === 0) return;
  const { data: docs } = await supabase
    .from("documents")
    .select("id, rev, current_version_id")
    .in("id", rows.map((r) => r.document_id));
  const byId = new Map(((docs as Array<Record<string, unknown>>) ?? []).map((d) => [String(d.id), d]));
  await Promise.all(rows.map((r) => {
    const d = byId.get(r.document_id);
    return supabase
      .from("work_package_documents")
      .update({
        pinned_version_id: (d?.current_version_id as string | null) ?? null,
        pinned_rev_label: (d?.rev as string | null) ?? null,
      })
      .eq("id", r.id);
  }));
}

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
  const { error } = await supabase.from("work_packages").update(patch).eq("id", packageId);
  if (error) throw new Error(error.message);
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
      void notifyMany({
        orgId: input.orgId,
        userIds: [p.owner_user_id],
        actorUserId: input.actorUserId,
        actorName: input.actorName,
        kind: "doc_superseded",
        title: `Work package "${p.name}" went stale`,
        body: `${input.docLabel} advanced to Rev ${input.newRev} — the package still pins the older revision. Review the change, then refresh the pack (or swap the print set) before execution.`,
        link: `/packages`,
        resourceType: "document",
        resourceId: input.documentId,
        metadata: { workPackageId: p.id },
      });
    }
  } catch { /* non-blocking */ }
}
