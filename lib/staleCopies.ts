// lib/staleCopies.ts
//
// STALE-COPY RECALL — the intent layer's biggest unclaimed dividend.
//
// Every download is already recorded with the exact version it delivered
// (download_audits). Joining that against documents.current_version_id
// answers two questions nobody could ask before:
//
//   * personal:  "which of MY downloaded copies are now out of date?"
//   * per-doc:   "who is still holding an outdated copy of THIS drawing,
//                 and who has already re-pulled the current one?"
//
// Read-only + one explicit nudge action. All best-effort: environments
// where download_audits is sparse simply show less.

import { supabase } from "@/lib/supabase";
import { notifyMany } from "@/lib/inAppNotifications";

/** How far back a download is considered "a copy someone may still hold". */
const RECALL_WINDOW_DAYS = 60;

export interface StaleCopy {
  documentId: string;
  libraryId: string | null;
  docLabel: string;
  downloadedRev: string | null;
  downloadedAt: string;
  currentRev: string | null;
}

/** The current user's outdated copies: latest download per document where
 *  the delivered version is no longer current. */
export async function listMyStaleCopies(
  userId: string,
  orgId: string,
): Promise<StaleCopy[]> {
  try {
    const since = new Date(Date.now() - RECALL_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const { data } = await supabase
      .from("download_audits")
      .select("document_id, version_id, created_at")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .gt("created_at", since)
      .not("version_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(300);
    const rows = (data as Array<{ document_id: string; version_id: string; created_at: string }>) ?? [];
    if (rows.length === 0) return [];

    // Latest download per document.
    const latest = new Map<string, { versionId: string; at: string }>();
    for (const r of rows) {
      if (!latest.has(r.document_id)) latest.set(r.document_id, { versionId: r.version_id, at: r.created_at });
    }

    const { data: docs } = await supabase
      .from("documents")
      .select("id, document_number, title, name, rev, library_id, current_version_id, status")
      .in("id", [...latest.keys()]);

    const { data: verRows } = await supabase
      .from("document_versions")
      .select("id, superseded_at")
      .in("id", [...latest.values()].map((v) => v.versionId));
    const supersededAtByVersion = new Map(
      (((verRows as Array<{ id: string; superseded_at: string | null }>) ?? []))
        .filter((v) => v.superseded_at)
        .map((v) => [v.id, v.superseded_at as string]),
    );

    const out: StaleCopy[] = [];
    for (const d of (docs as Array<Record<string, unknown>>) ?? []) {
      const mine = latest.get(String(d.id));
      if (!mine) continue;
      if (d.status === "Archived" || d.status === "Superseded" || d.status === "Void") continue;
      const current = (d.current_version_id as string | null) ?? null;
      if (!current || current === mine.versionId) continue; // still current — fine
      // Skip DELIBERATE historical pulls: if the downloaded rev was already
      // superseded BEFORE the download happened (e.g. from Version History),
      // the user knew it was old — flagging it is pure noise.
      const supAt = supersededAtByVersion.get(mine.versionId);
      if (supAt && supAt < mine.at) continue;

      // Label of the rev they downloaded (best-effort).
      out.push({
        documentId: String(d.id),
        libraryId: (d.library_id as string | null) ?? null,
        docLabel: String(d.document_number || d.title || d.name || "Document"),
        downloadedRev: null, // filled below in one batch
        downloadedAt: mine.at,
        currentRev: (d.rev as string | null) ?? null,
      });
    }
    if (out.length === 0) return [];

    // Resolve downloaded-rev labels in one query.
    const versionIds = [...new Set(out.map((o) => latest.get(o.documentId)!.versionId))];
    const { data: versions } = await supabase
      .from("document_versions")
      .select("id, revision_label")
      .in("id", versionIds);
    const labelByVersion = new Map(
      ((versions as Array<{ id: string; revision_label: string }>) ?? []).map((v) => [v.id, v.revision_label]),
    );
    for (const o of out) {
      o.downloadedRev = labelByVersion.get(latest.get(o.documentId)!.versionId) ?? null;
    }
    return out.sort((a, b) => Date.parse(b.downloadedAt) - Date.parse(a.downloadedAt));
  } catch {
    return [];
  }
}

export interface RecallHolder {
  userId: string;
  userEmail: string | null;
  lastDownloadedRev: string | null;
  lastDownloadedAt: string;
  hasCurrent: boolean;
}

/** Distribution recall for one document: everyone who pulled a copy in the
 *  window, split into "has the current rev" vs "holding an outdated one". */
export async function getDocumentRecall(
  documentId: string,
  currentVersionId: string | null,
): Promise<RecallHolder[]> {
  if (!currentVersionId) return [];
  try {
    const since = new Date(Date.now() - RECALL_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const { data } = await supabase
      .from("download_audits")
      .select("user_id, user_email, version_id, created_at")
      .eq("document_id", documentId)
      .gt("created_at", since)
      .not("version_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(400);
    const rows = (data as Array<{ user_id: string; user_email: string | null; version_id: string; created_at: string }>) ?? [];
    if (rows.length === 0) return [];

    const byUser = new Map<string, RecallHolder & { latestVersionId: string }>();
    for (const r of rows) {
      const existing = byUser.get(r.user_id);
      if (!existing) {
        byUser.set(r.user_id, {
          userId: r.user_id,
          userEmail: r.user_email,
          latestVersionId: r.version_id,
          lastDownloadedRev: null,
          lastDownloadedAt: r.created_at,
          hasCurrent: r.version_id === currentVersionId,
        });
      } else if (!existing.hasCurrent && r.version_id === currentVersionId) {
        // Any pull of the current version counts, even if they later
        // re-downloaded an old one from history for comparison.
        existing.hasCurrent = true;
      }
    }

    const holders = [...byUser.values()];
    const versionIds = [...new Set(holders.map((h) => h.latestVersionId))];
    const { data: versions } = await supabase
      .from("document_versions")
      .select("id, revision_label")
      .in("id", versionIds);
    const labelByVersion = new Map(
      ((versions as Array<{ id: string; revision_label: string }>) ?? []).map((v) => [v.id, v.revision_label]),
    );
    for (const h of holders) h.lastDownloadedRev = labelByVersion.get(h.latestVersionId) ?? null;

    // Outdated holders first, then by recency.
    return holders
      .map(({ latestVersionId: _ignored, ...h }) => h)
      .sort((a, b) => Number(a.hasCurrent) - Number(b.hasCurrent) || Date.parse(b.lastDownloadedAt) - Date.parse(a.lastDownloadedAt));
  } catch {
    return [];
  }
}

/** One-click recall nudge: tell everyone holding an outdated copy. */
export async function nudgeStaleHolders(input: {
  orgId: string;
  documentId: string;
  libraryId?: string | null;
  docLabel: string;
  currentRev: string | null;
  holders: RecallHolder[];
  actorUserId: string;
  actorName?: string | null;
}): Promise<number> {
  const outdated = input.holders.filter((h) => !h.hasCurrent);
  if (outdated.length === 0) return 0;
  await notifyMany({
    orgId: input.orgId,
    userIds: outdated.map((h) => h.userId),
    actorUserId: input.actorUserId,
    actorName: input.actorName ?? undefined,
    kind: "doc_superseded",
    title: `Your copy of ${input.docLabel} is out of date`,
    body: `The current revision is Rev ${input.currentRev ?? "?"}. You downloaded an older one — re-download before doing any work from it, and destroy old prints.`,
    link: input.libraryId ? `/documents/${input.libraryId}?doc=${input.documentId}` : undefined,
    resourceType: "document",
    resourceId: input.documentId,
    metadata: { recall: true },
  });
  return outdated.length;
}
