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
import { emit } from "@/lib/notify/dispatch";
import { logRevisionEvent } from "@/lib/audit";

/** How far back a download is considered "a copy someone may still hold".
 *  PERSONAL list: 60 days — beyond that, self-service noise outweighs value.
 *  PER-DOCUMENT recall: 365 days — the controller deciding who to recall
 *  must see the print that has lived in a field binder for months; a
 *  61-day-old print is exactly the one most likely to be stale (DIST-11). */
const RECALL_WINDOW_DAYS = 60;
const DOC_RECALL_WINDOW_DAYS = 365;
const DOC_RECALL_ROW_CAP = 1000;

export interface StaleCopy {
  documentId: string;
  libraryId: string | null;
  docLabel: string;
  downloadedRev: string | null;
  downloadedAt: string;
  currentRev: string | null;
  /** Set when the DOCUMENT itself is retired (Superseded/Void/Archived) —
   *  the most urgent case: there is no current revision to re-download,
   *  every copy is dead paper (DIST-1). */
  retiredStatus: string | null;
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
      // DIST-1: a RETIRED document is the case this feature exists for — it
      // used to be filtered out here, which silenced exactly the holders of
      // the most dangerous copies in circulation. Every copy of a retired
      // doc is stale (even the final revision: there is nothing current to
      // hold), so the "still current" and deliberate-historical-pull skips
      // below apply only to living documents.
      const retired =
        d.status === "Archived" || d.status === "Superseded" || d.status === "Void";
      if (!retired) {
        const current = (d.current_version_id as string | null) ?? null;
        if (!current || current === mine.versionId) continue; // still current — fine
        // Skip DELIBERATE historical pulls: if the downloaded rev was already
        // superseded BEFORE the download happened (e.g. from Version History),
        // the user knew it was old — flagging it is pure noise.
        const supAt = supersededAtByVersion.get(mine.versionId);
        if (supAt && supAt < mine.at) continue;
      }

      // Label of the rev they downloaded (best-effort).
      out.push({
        documentId: String(d.id),
        libraryId: (d.library_id as string | null) ?? null,
        docLabel: String(d.document_number || d.title || d.name || "Document"),
        downloadedRev: null, // filled below in one batch
        downloadedAt: mine.at,
        currentRev: (d.rev as string | null) ?? null,
        retiredStatus: retired ? String(d.status) : null,
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
    // Retired-document copies first — dead paper beats stale paper.
    return out.sort((a, b) =>
      Number(!!b.retiredStatus) - Number(!!a.retiredStatus) ||
      Date.parse(b.downloadedAt) - Date.parse(a.downloadedAt));
  } catch {
    return [];
  }
}

export interface RecallHolder {
  /** The member's uid — or, for an EXTERNAL copy, a stable key naming the
   *  channel it left through (`share:<share_id>` / `transmittal:<transmittal_id>`). */
  userId: string;
  userEmail: string | null;
  lastDownloadedRev: string | null;
  lastDownloadedAt: string;
  hasCurrent: boolean;
  /** DIST-9 / DIST-7 / TRX-9: the copy went out through a share link or the
   *  transmittal portal — there is no member account to nudge; the recall
   *  has to go back through that channel. */
  external?: boolean;
  /** download_audits.source, when the row recorded one. */
  source?: string | null;
}

export interface DocumentRecall {
  holders: RecallHolder[];
  /** DIST-11: the row cap was hit — holders may be MISSING. */
  capped: boolean;
  /** DIST-9 dw3: the record could not be READ. An empty list here is a gap
   *  in the evidence, not "nobody holds a copy" — render it as a gap. */
  unavailable: boolean;
}

/** The row shape getDocumentRecall reads. `source` / `share_id` /
 *  `transmittal_id` arrive with migration 20261068; a pre-migration database
 *  answers the legacy column list instead (see the fallback below). */
type RecallRow = {
  user_id: string | null;
  user_email: string | null;
  version_id: string;
  created_at: string;
  source?: string | null;
  share_id?: string | null;
  transmittal_id?: string | null;
};
const RECALL_COLUMNS = "user_id, user_email, version_id, created_at, source, share_id, transmittal_id";
const RECALL_COLUMNS_LEGACY = "user_id, user_email, version_id, created_at";

/** PostgREST's answer when a selected column does not exist yet (the
 *  20261068 columns on a database that has not applied it). Anything else is
 *  a real read failure and is reported as a gap, never as an empty list. */
function isUnknownColumnError(error: { code?: unknown; message?: unknown } | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  const message = String(error.message ?? "");
  return code === "42703" || code === "PGRST204" || /does not exist|schema cache/i.test(message);
}

/** The holder key for one row: the member, or the external channel. */
function holderKeyOf(r: RecallRow): string | null {
  if (r.user_id) return r.user_id;
  if (r.share_id) return `share:${r.share_id}`;
  if (r.transmittal_id) return `transmittal:${r.transmittal_id}`;
  return null;
}

/** Distribution recall for one document: everyone who pulled a copy in the
 *  window, split into "has the current rev" vs "holding an outdated one".
 *  `capped` is the DIST-11 honesty flag: when the row cap was hit, holders
 *  may be MISSING and the UI must say so instead of asserting completeness.
 *  `unavailable` is the DIST-9 one: the record could not be read at all. */
export async function getDocumentRecall(
  documentId: string,
  currentVersionId: string | null,
): Promise<DocumentRecall> {
  if (!currentVersionId) return { holders: [], capped: false, unavailable: false };
  const unavailable: DocumentRecall = { holders: [], capped: false, unavailable: true };
  try {
    const since = new Date(Date.now() - DOC_RECALL_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const query = (columns: string) => supabase
      .from("download_audits")
      .select(columns)
      .eq("document_id", documentId)
      .gt("created_at", since)
      .not("version_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(DOC_RECALL_ROW_CAP);
    let { data, error } = await query(RECALL_COLUMNS);
    // Pre-20261068 database: the attribution columns are not there yet —
    // read the legacy shape (every row is a member's own pull).
    if (error && isUnknownColumnError(error)) ({ data, error } = await query(RECALL_COLUMNS_LEGACY));
    if (error) return unavailable;
    const rows = (data as unknown as RecallRow[] | null) ?? [];
    const capped = rows.length >= DOC_RECALL_ROW_CAP;
    if (rows.length === 0) return { holders: [], capped, unavailable: false };

    const byUser = new Map<string, RecallHolder & { latestVersionId: string }>();
    for (const r of rows) {
      const key = holderKeyOf(r);
      if (!key) continue; // unattributed — the 20261068 CHECK forbids it; never guess
      const existing = byUser.get(key);
      if (!existing) {
        byUser.set(key, {
          userId: key,
          userEmail: r.user_email ?? null,
          latestVersionId: r.version_id,
          lastDownloadedRev: null,
          lastDownloadedAt: r.created_at,
          hasCurrent: r.version_id === currentVersionId,
          external: !r.user_id,
          source: r.source ?? null,
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
    return {
      holders: holders
        .map(({ latestVersionId: _ignored, ...h }) => h)
        .sort((a, b) => Number(a.hasCurrent) - Number(b.hasCurrent) || Date.parse(b.lastDownloadedAt) - Date.parse(a.lastDownloadedAt)),
      capped,
      unavailable: false,
    };
  } catch {
    // DIST-9: a record that could not be read is a GAP, not an empty list.
    return unavailable;
  }
}

/** RETIREMENT recall (DIST-1): when a document is Superseded/Voided, EVERY
 *  copy in circulation is dead paper — including the final revision, so the
 *  hasCurrent split is meaningless. Tells everyone who pulled ANY version in
 *  the recall window. Best-effort; returns how many people were told. */
export async function recallRetiredDocument(input: {
  orgId: string;
  documentId: string;
  libraryId?: string | null;
  docLabel: string;
  newStatus: string;                 // "Superseded" | "Void" | "Archived"
  replacementNote?: string | null;   // e.g. "Replaced by P-101A, P-101B"
  actorUserId: string;
  actorName?: string | null;
}): Promise<number> {
  try {
    const since = new Date(Date.now() - DOC_RECALL_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const { data } = await supabase
      .from("download_audits")
      .select("user_id")
      .eq("document_id", input.documentId)
      .gt("created_at", since)
      .limit(DOC_RECALL_ROW_CAP);
    const holders = [...new Set(
      (((data as Array<{ user_id: string | null }> | null) ?? []))
        .map((r) => r.user_id)
        .filter((u): u is string => !!u && u !== input.actorUserId),
    )];
    if (holders.length === 0) return 0;
    await emit({
      orgId: input.orgId,
      category: "recall",
      kind: "doc_superseded",
      title: `${input.docLabel} is now ${input.newStatus} — your copy is dead paper`,
      body:
        `This document was retired (${input.newStatus.toLowerCase()}); there is no current revision to work from. ` +
        `Stop any work based on your copy and destroy old prints.` +
        (input.replacementNote ? ` ${input.replacementNote}` : ""),
      link: input.libraryId ? `/documents/${input.libraryId}?doc=${input.documentId}` : undefined,
      resource: { type: "document", id: input.documentId },
      actorUserId: input.actorUserId,
      actorName: input.actorName ?? undefined,
      audience: { involved: holders },
      metadata: { recall: true, retirement: true, newStatus: input.newStatus },
    });
    // DIST-10: the recall goes on the document's audit trail — an incident
    // investigation must be able to answer "when was it recalled, who was on
    // the list" from the record, not from cleared bell notifications.
    try {
      await logRevisionEvent({
        orgId: input.orgId,
        documentId: input.documentId,
        versionId: "",
        userId: input.actorUserId,
        userEmail: input.actorName ?? "",
        userRole: "",
        type: "DISTRIBUTION_RECALL",
        details: { retirement: true, newStatus: input.newStatus, recipientCount: holders.length, recipients: holders },
      });
    } catch { /* the recall itself already went out */ }
    return holders.length;
  } catch {
    return 0;
  }
}

/** One-click recall nudge: tell everyone holding an outdated copy. */
export async function nudgeStaleHolders(input: {
  orgId: string;
  documentId: string;
  libraryId?: string | null;
  docLabel: string;
  currentRev: string | null;
  /** The current version at recall time — recorded on the audit row. */
  currentVersionId?: string | null;
  holders: RecallHolder[];
  actorUserId: string;
  actorName?: string | null;
  /** Recorded on the audit row: a controller's click vs the publish fan-out. */
  source?: "manual" | "auto";
}): Promise<number> {
  const outdated = input.holders.filter((h) => !h.hasCurrent);
  // DIST-9 / DIST-7: an EXTERNAL copy (share link, transmittal portal) has no
  // member account behind it — nothing here can reach it. Members only; the
  // audit row records how many external copies were left out so the gap is
  // on the record, not silently dropped.
  const reachable = outdated.filter((h) => !h.external);
  const externalCopies = outdated.length - reachable.length;
  if (reachable.length === 0) return 0;
  await emit({
    orgId: input.orgId,
    category: "recall",
    kind: "doc_superseded",
    title: `Your copy of ${input.docLabel} is out of date`,
    body: `The current revision is Rev ${input.currentRev ?? "?"}. You downloaded an older one — re-download before doing any work from it, and destroy old prints.`,
    link: input.libraryId ? `/documents/${input.libraryId}?doc=${input.documentId}` : undefined,
    resource: { type: "document", id: input.documentId },
    actorUserId: input.actorUserId,
    actorName: input.actorName ?? undefined,
    audience: { involved: reachable.map((h) => h.userId) },
    metadata: { recall: true },
  });
  // DIST-10: durable record — actor, version, recipient list, timestamp.
  try {
    await logRevisionEvent({
      orgId: input.orgId,
      documentId: input.documentId,
      versionId: input.currentVersionId ?? "",
      userId: input.actorUserId,
      userEmail: input.actorName ?? "",
      userRole: "",
      type: "DISTRIBUTION_RECALL",
      details: {
        source: input.source ?? "manual",
        currentRev: input.currentRev,
        recipientCount: reachable.length,
        recipients: reachable.map((h) => ({ userId: h.userId, email: h.userEmail, heldRev: h.lastDownloadedRev })),
        externalCopies,
      },
    });
  } catch { /* the recall itself already went out */ }
  return reachable.length;
}
