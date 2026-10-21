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
import { logAuditAction, logRevisionEvent } from "@/lib/audit";
import { ticketVerdict, issueInForce, isIssuedTicketRev, type TicketVerdict } from "@/lib/verifyTicketVerdict";
import { isTerminalTicketStatus } from "@/lib/ticketShed";
import { isControlledIssueStatus } from "@/lib/issueStatus";

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
  /** PROD-17: which personal retirement notices the calling door sends, so
   *  the watchers' FYI leaves those people out (one notice per person per
   *  event). Both default to true — the supersede door
   *  (lib/revisions.ts supersedeDocument) tells the checkout holder
   *  (notifyHolderOfRetirement) and the open packages' owners
   *  (notifyPackagesOfRetirement). A door that tells neither passes false. */
  personallyToldElsewhere?: { checkoutHolder?: boolean; packageOwners?: boolean };
  /** PROD-17 (document-control P26 fix pass 4; the integrator's ruling
   *  under DEC-90, 2026-10-14): false when the retirement takes away no
   *  controlled issue — the document was never issued (its prior status is
   *  not one lib/issueStatus.ts isControlledIssueStatus counts: Draft, In
   *  Review, Void). No copy holder is read or recalled and no
   *  DISTRIBUTION_RECALL row is written: "destroy old prints" is false for
   *  a document that was never issued. The watchers' FYI below goes as it
   *  does for any retirement. Default true: supersede and every other
   *  caller recall exactly as before. */
  recallCopyHolders?: boolean;
}): Promise<number> {
  try {
    let holders: string[] = [];
    if (input.recallCopyHolders !== false) {
      // DELIV-17 (document-control P28): the read is CHECKED and retried
      // once (readRetirementHolders). A read that still fails is logged and
      // put on the document's record as a recall that could not be computed
      // (an unavailable DISTRIBUTION_RECALL row, nudgeStaleHolders' DIST-9
      // shape) — never the silent "nobody held a copy" it used to be.
      const read = await readRetirementHolders(input.documentId, input.actorUserId);
      if (read.error === null) holders = read.holders;
      else await recordUncomputedRecall(input, read.error);
    }
    // The copy holders' recall goes out FIRST, with its DIST-10 audit row
    // (review fix, N15): it is the safety notice, and it must not wait on
    // the watchers' FYI below — whose discover check, follower reads and
    // inserts can be slow or never finish (a closed tab, a stalled route).
    if (holders.length > 0) {
      await emit({
        orgId: input.orgId,
        category: "recall",
        // PROD-13 / TAX-13 (N9): a recall is its own kind, not a supersede notice.
        kind: "doc_recalled",
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
      await recordRetirementRecall(input, holders);
    }
    // PROD-17 (notifications N15): the document's WATCHERS are told it was
    // retired, in their own words ("your copy is dead paper" is false for a
    // watcher who holds none), minus everyone a personal notice about this
    // same retirement already reached: the copy holders the recall above
    // told, and (personallyToldElsewhere, both on by default — the
    // supersede door sends both) the checkout holder
    // (lib/revisions.ts notifyHolderOfRetirement) and the owners of open work
    // packages pinning it (lib/postPublish.ts notifyPackagesOfRetirement).
    // Its kind is doc_retired — an FYI, NOT a compliance kind (doc_recalled
    // is one): a watcher's notice must not ride the daily compliance digest,
    // be dismiss-only or be retried as an obligation. On the 'watched'
    // category, so the watcher's own email toggle governs its email (the
    // copy holders' recall above is the safety category). The dispatcher
    // drops a watcher who may not discover the document (NEDGE-6). Sent
    // whether or not anyone holds a copy, AFTER the recall and its audit
    // (every caller runs this whole function without awaiting it).
    // doc_retired is declared by 20261206, pasted BEFORE the deploy; if it
    // is late, 20261160's rail refuses the bell row, and emailOnlyWithBell
    // keeps the email from going without it (no notice the watcher cannot
    // find in the app).
    try {
      const toldElsewhere = await personallyToldOfRetirement(input);
      await emit({
        orgId: input.orgId,
        category: "watched",
        kind: "doc_retired",
        title: `${input.docLabel} was retired (${input.newStatus})`,
        body: `${input.actorName || "Someone"} retired ${input.docLabel} (${input.newStatus.toLowerCase()}); there is no current revision to work from.` +
          (input.replacementNote ? ` ${input.replacementNote}` : ""),
        link: input.libraryId ? `/documents/${input.libraryId}?doc=${input.documentId}` : undefined,
        resource: { type: "document", id: input.documentId },
        actorUserId: input.actorUserId,
        actorName: input.actorName ?? undefined,
        audience: { followers: true, exclude: [...new Set([...holders, ...toldElsewhere])] },
        metadata: { retirement: true, followerNotice: true, newStatus: input.newStatus },
        emailOnlyWithBell: true,
      });
    } catch { /* the recall above already went out */ }
    return holders.length;
  } catch (e) {
    // DELIV-17: a failure past the read is logged, never a silent 0.
    console.error(`[staleCopies] DELIV-17: the retirement recall of document ${input.documentId} (${input.newStatus}) failed part-way`, e);
    return 0;
  }
}

type RetirementRecallInput = Parameters<typeof recallRetiredDocument>[0];

/** DELIV-17 (document-control P28): the people who pulled any revision of
 *  the document in the recall window (DOC_RECALL_WINDOW_DAYS, at most
 *  DOC_RECALL_ROW_CAP rows), the actor left out. The read is checked — its
 *  `{ error }` and a throw both count — and retried ONCE (every caller runs
 *  the recall off the door's path, so the retry delays no door). A read that
 *  fails twice answers its error, never an empty list. */
async function readRetirementHolders(documentId: string, actorUserId: string): Promise<{ holders: string[]; error: null } | { holders: null; error: string }> {
  const since = new Date(Date.now() - DOC_RECALL_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await supabase
        .from("download_audits")
        .select("user_id")
        .eq("document_id", documentId)
        .gt("created_at", since)
        .limit(DOC_RECALL_ROW_CAP);
      if (!error) {
        return {
          holders: [...new Set(
            (((data as Array<{ user_id: string | null }> | null) ?? []))
              .map((r) => r.user_id)
              .filter((u): u is string => !!u && u !== actorUserId),
          )],
          error: null,
        };
      }
      lastError = error.message || "the read was refused";
    } catch (e) {
      lastError = (e as Error)?.message ?? String(e);
    }
    if (attempt === 0) {
      console.warn(`[staleCopies] DELIV-17: the copy holders of document ${documentId} could not be read for its retirement recall (${lastError}) — retrying once`);
    }
  }
  return { holders: null, error: lastError };
}

/** DELIV-17: a retirement recall whose copy holders could not be read is
 *  logged as an error and recorded on the document's audit trail as a
 *  recall that could not be computed — `unavailable: true`, nobody named
 *  (the shape nudgeStaleHolders writes for DIST-9) — so the record tells
 *  "nobody held a copy" (no row) from "the holders could not be read". The
 *  watchers' FYI still goes, excluding no copy holder:
 *  a second notice, never none. */
async function recordUncomputedRecall(input: RetirementRecallInput, readError: string): Promise<void> {
  console.error(`[staleCopies] DELIV-17: the retirement recall of document ${input.documentId} (${input.newStatus}) could not be computed — its copy holders could not be read (${readError}); nobody was recalled, and the document's record says so`);
  try {
    const res = await logRevisionEvent({
      orgId: input.orgId,
      documentId: input.documentId,
      versionId: "",
      userId: input.actorUserId,
      userEmail: input.actorName ?? "",
      userRole: "",
      type: "DISTRIBUTION_RECALL",
      details: { retirement: true, newStatus: input.newStatus, recipientCount: 0, recipients: [], unavailable: true, readError },
    });
    if (res && res.ok === false) console.error(`[staleCopies] DELIV-17: the record that the retirement recall of document ${input.documentId} could not be computed was refused too (${res.error})`);
  } catch (e) {
    console.error(`[staleCopies] DELIV-17: the record that the retirement recall of document ${input.documentId} could not be computed was not written`, e);
  }
}

/** DIST-10: the retirement recall's row on the document's audit trail (its
 *  recipients — what DIST-16's withdrawal reads back). A refused row is
 *  logged by lib/audit.ts and here, naming the recall (DIST-16's caveat: a
 *  recall whose row is missing gets no withdrawal). */
async function recordRetirementRecall(input: RetirementRecallInput, holders: string[], extra: Record<string, unknown> = {}): Promise<void> {
  try {
    const res = await logRevisionEvent({
      orgId: input.orgId,
      documentId: input.documentId,
      versionId: "",
      userId: input.actorUserId,
      userEmail: input.actorName ?? "",
      userRole: "",
      type: "DISTRIBUTION_RECALL",
      details: { retirement: true, newStatus: input.newStatus, recipientCount: holders.length, recipients: holders, ...extra },
    });
    if (res && res.ok === false) console.error(`[staleCopies] the retirement recall of document ${input.documentId} went out but its DISTRIBUTION_RECALL row was refused (${res.error})`);
  } catch { /* the recall itself already went out */ }
}

/** PROD-17 (document-control P28): the BULK retirement doors' recall — the
 *  library page's bulk archive and the bulk editor's Superseded / Archived.
 *  One call per apply, never awaited by the door (the caller fires it).
 *  Each door reads the selected rows' statuses ONCE, fresh, before its
 *  write (never the page's copy; a failed read leaves a row's prior
 *  unknown, which recalls — lib/revisions.ts recallsCopyHolders), leaves
 *  out the rows already Superseded or Archived (skipsRetirementRecall —
 *  their watchers were told when that retirement happened), and passes
 *  `recallCopyHolders` per row: true only for a row that took away a
 *  controlled issue (DEC-90 R1). Then, here:
 *    · each such document's copy holders are read (checked, retried once —
 *      DELIV-17; a read that fails is logged and recorded unavailable);
 *    · each HOLDER gets ONE doc_recalled for the whole apply, naming every
 *      document of it they hold a copy of — never one notice (and one
 *      preference-exempt safety_recall email) per row: a 150-row bulk
 *      archive used to be the burst P26's fix pass reverted;
 *    · each document gets its own DISTRIBUTION_RECALL row (DIST-10 — the
 *      record a later restore's withdrawal reads back, DIST-16);
 *    · then each document's watchers get its doc_retired FYI, minus that
 *      document's copy holders — the bulk doors send no personal notice to
 *      a checkout holder or a package owner, so those stay in.
 *  Returns how many people were recalled. */
export async function recallRetiredBatch(input: {
  orgId: string;
  newStatus: string;                 // "Superseded" | "Archived"
  actorUserId: string;
  actorName?: string | null;
  replacementNote?: string | null;
  docs: Array<{ documentId: string; libraryId?: string | null; docLabel: string; recallCopyHolders: boolean }>;
}): Promise<number> {
  try {
    const per = (d: (typeof input.docs)[number]): RetirementRecallInput => ({
      orgId: input.orgId, documentId: d.documentId, libraryId: d.libraryId ?? null, docLabel: d.docLabel || "A document",
      newStatus: input.newStatus, replacementNote: input.replacementNote ?? null,
      actorUserId: input.actorUserId, actorName: input.actorName ?? null,
      personallyToldElsewhere: { checkoutHolder: false, packageOwners: false },
      recallCopyHolders: d.recallCopyHolders,
    });
    const docs = [...new Map(input.docs.map((d) => [d.documentId, d])).values()];
    const holdersOf = new Map<string, string[]>();
    for (const d of docs) {
      if (!d.recallCopyHolders) continue;
      const read = await readRetirementHolders(d.documentId, input.actorUserId);
      if (read.error === null) holdersOf.set(d.documentId, read.holders);
      else await recordUncomputedRecall(per(d), read.error);
    }
    // One notice per holder for the whole apply: holders with the same set
    // of documents share one emit.
    const docsOfHolder = new Map<string, string[]>();
    for (const d of docs) for (const u of holdersOf.get(d.documentId) ?? []) docsOfHolder.set(u, [...(docsOfHolder.get(u) ?? []), d.documentId]);
    const groups = new Map<string, { docIds: string[]; holders: string[] }>();
    for (const [u, ids] of docsOfHolder) {
      const key = ids.join("|");
      const g = groups.get(key) ?? { docIds: ids, holders: [] };
      g.holders.push(u);
      groups.set(key, g);
    }
    const byId = new Map(docs.map((d) => [d.documentId, d]));
    for (const g of groups.values()) {
      if (g.docIds.length === 1) {
        // One document: recallRetiredDocument's own notice, word for word.
        const d = per(byId.get(g.docIds[0])!);
        await emit({
          orgId: input.orgId,
          category: "recall",
          kind: "doc_recalled",
          title: `${d.docLabel} is now ${d.newStatus} — your copy is dead paper`,
          body:
            `This document was retired (${d.newStatus.toLowerCase()}); there is no current revision to work from. ` +
            `Stop any work based on your copy and destroy old prints.` +
            (d.replacementNote ? ` ${d.replacementNote}` : ""),
          link: d.libraryId ? `/documents/${d.libraryId}?doc=${d.documentId}` : undefined,
          resource: { type: "document", id: d.documentId },
          actorUserId: input.actorUserId,
          actorName: input.actorName ?? undefined,
          audience: { involved: g.holders },
          metadata: { recall: true, retirement: true, newStatus: d.newStatus },
        });
        continue;
      }
      const named = g.docIds.map((id) => byId.get(id)!);
      const libs = [...new Set(named.map((d) => d.libraryId ?? null))];
      const shown = named.slice(0, 10).map((d) => d.docLabel || "A document");
      await emit({
        orgId: input.orgId,
        category: "recall",
        kind: "doc_recalled",
        title: `${named.length} documents you hold copies of are now ${input.newStatus} — your copies are dead paper`,
        body:
          `These documents were retired (${input.newStatus.toLowerCase()}); there is no current revision of them to work from: ` +
          `${shown.join(", ")}${named.length > shown.length ? ` and ${named.length - shown.length} more` : ""}. ` +
          `Stop any work based on your copies and destroy old prints.` +
          (input.replacementNote ? ` ${input.replacementNote}` : ""),
        link: libs.length === 1 && libs[0] ? `/documents/${libs[0]}` : undefined,
        resource: libs.length === 1 && libs[0] ? { type: "library", id: libs[0] } : { type: "document", id: named[0].documentId },
        actorUserId: input.actorUserId,
        actorName: input.actorName ?? undefined,
        audience: { involved: g.holders },
        metadata: { recall: true, retirement: true, newStatus: input.newStatus, documentIds: g.docIds },
      });
    }
    for (const d of docs) {
      const holders = holdersOf.get(d.documentId) ?? [];
      if (holders.length > 0) await recordRetirementRecall(per(d), holders, { batch: true });
    }
    // Each document's watchers, after every recall and record: the FYI
    // recallRetiredDocument sends, word for word, minus that document's copy
    // holders (the bulk doors tell no checkout holder or package owner).
    for (const doc of docs) {
      const d = per(doc);
      const holders = holdersOf.get(d.documentId) ?? [];
      try {
        const toldElsewhere = await personallyToldOfRetirement(d);
        await emit({
          orgId: input.orgId,
          category: "watched",
          kind: "doc_retired",
          title: `${d.docLabel} was retired (${d.newStatus})`,
          body: `${input.actorName || "Someone"} retired ${d.docLabel} (${d.newStatus.toLowerCase()}); there is no current revision to work from.` +
            (d.replacementNote ? ` ${d.replacementNote}` : ""),
          link: d.libraryId ? `/documents/${d.libraryId}?doc=${d.documentId}` : undefined,
          resource: { type: "document", id: d.documentId },
          actorUserId: input.actorUserId,
          actorName: input.actorName ?? undefined,
          audience: { followers: true, exclude: [...new Set([...holders, ...toldElsewhere])] },
          metadata: { retirement: true, followerNotice: true, newStatus: d.newStatus },
          emailOnlyWithBell: true,
        });
      } catch { /* the recalls above already went out */ }
    }
    return docsOfHolder.size;
  } catch (e) {
    console.error(`[staleCopies] DELIV-17: the bulk retirement recall (${input.newStatus}, ${input.docs.length} document(s)) failed part-way`, e);
    return 0;
  }
}

/** DIST-16 (document-control P28): a document put back IN FORCE — an
 *  un-archive, a reversed split or merge restoring it, a status editor's
 *  put-back of a retired issue — withdraws the retirement recall that
 *  stands on it. "Stands" is read from the document's own record: every
 *  DISTRIBUTION_RECALL row with `retirement: true` (and recipients) written
 *  after its last withdrawal row (`recallWithdrawn: true`) — the recall row
 *  is the only evidence a recall went (a bare retirement leaves none). The
 *  people those rows named (the actor aside) get ONE notice that the recall
 *  is withdrawn, naming the status the document is back in and the recall's
 *  date, and the withdrawal goes on the record (the next restore reads from
 *  it). Its kind is library_doc_revised — a declared, NON-compliance,
 *  deletable FYI (20261160 lists it, so it is written before and after
 *  20261206's paste; the integrator's ruling under DEC-90 prefers an
 *  existing kind to a new notification_kinds() row) — on the recall
 *  category, so it reaches everyone the preference-exempt recall reached.
 *  Nothing goes when the document is not back in force (a restore into
 *  Draft or In Review: "do not work from your copy" still holds) or no
 *  recall stands. A record that cannot be read is logged and recorded,
 *  never guessed. Fired, never awaited, by every restore door; returns how
 *  many people were told. */
export async function withdrawRetirementRecall(input: {
  orgId: string;
  documentId: string;
  libraryId?: string | null;
  docLabel?: string | null;
  restoredStatus: string | null;
  door: "unarchive" | "split_reversed" | "merge_reversed" | "put_back";
  actorUserId: string;
  actorName?: string | null;
}): Promise<number> {
  const restored = (input.restoredStatus ?? "").trim();
  if (!restored || !isControlledIssueStatus(restored)) return 0;
  try {
    const { data, error } = await supabase
      .from("audit_logs")
      .select("details, timestamp")
      .eq("resource_type", "document")
      .eq("resource_id", input.documentId)
      .eq("action", "DISTRIBUTION_RECALL")
      .order("timestamp", { ascending: false })
      .limit(200);
    if (error) {
      console.error(`[staleCopies] DIST-16: the recall record of document ${input.documentId} could not be read, so whether a retirement recall stands is unknown and no withdrawal was sent (${error.message})`);
      await recordWithdrawal(input, restored, [], null, { withdrawalUnavailable: true, readError: error.message });
      return 0;
    }
    const rows = ((data as Array<{ details: Record<string, unknown> | null; timestamp: string | null }> | null) ?? []);
    const standing: Array<{ at: string | null; recipients: string[] }> = [];
    for (const r of rows) {           // newest first
      const d = r.details ?? {};
      if (d.recallWithdrawn === true) break;
      if (d.retirement !== true || d.unavailable === true) continue;
      const recipients = Array.isArray(d.recipients) ? (d.recipients as unknown[]).filter((u): u is string => typeof u === "string" && !!u) : [];
      if (recipients.length > 0) standing.push({ at: r.timestamp ?? null, recipients });
    }
    const people = [...new Set(standing.flatMap((s) => s.recipients))].filter((u) => u !== input.actorUserId);
    if (people.length === 0) return 0;
    const recallAt = standing[0].at;
    const when = recallAt ? new Date(recallAt).toISOString().slice(0, 10) : "an earlier date";
    let docLabel = input.docLabel ?? null;
    let libraryId = input.libraryId ?? null;
    if (!docLabel || !libraryId) {
      try {
        const { data: row } = await supabase.from("documents").select("library_id, document_number, title, name").eq("id", input.documentId).maybeSingle();
        const doc = (row as { library_id?: string | null; document_number?: string | null; title?: string | null; name?: string | null } | null) ?? null;
        docLabel = docLabel || (doc ? (doc.document_number || doc.title || doc.name || null) : null);
        libraryId = libraryId ?? doc?.library_id ?? null;
      } catch { /* named generically below */ }
    }
    const label = docLabel || "A document";
    await emit({
      orgId: input.orgId,
      category: "recall",
      kind: "library_doc_revised",
      title: `${label} is back in force (${restored}) — the recall of ${when} is withdrawn`,
      body:
        `${input.actorName || "Someone"} put ${label} back in force as ${restored}. The notice of ${when} telling you to stop work ` +
        `from your copy and destroy old prints is withdrawn: the document is current again. Before working from a copy, check it is the current revision.`,
      link: libraryId ? `/documents/${libraryId}?doc=${input.documentId}` : undefined,
      resource: { type: "document", id: input.documentId },
      actorUserId: input.actorUserId,
      actorName: input.actorName ?? undefined,
      audience: { involved: people },
      metadata: { recallWithdrawn: true, restoredStatus: restored, withdrawsRecallAt: recallAt, door: input.door },
    });
    await recordWithdrawal(input, restored, people, recallAt);
    return people.length;
  } catch (e) {
    console.error(`[staleCopies] DIST-16: the recall withdrawal of document ${input.documentId} failed part-way`, e);
    return 0;
  }
}

/** DIST-16: the withdrawal on the document's audit trail — who was told the
 *  recall is withdrawn, the recall's date and the status it is back in. Its
 *  `recallWithdrawn: true` is where the next restore stops reading. A
 *  withdrawal that could not be computed is recorded without that flag. */
async function recordWithdrawal(
  input: { orgId: string; documentId: string; actorUserId: string; actorName?: string | null; door: string },
  restored: string, people: string[], recallAt: string | null, extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    const res = await logRevisionEvent({
      orgId: input.orgId,
      documentId: input.documentId,
      versionId: "",
      userId: input.actorUserId,
      userEmail: input.actorName ?? "",
      userRole: "",
      type: "DISTRIBUTION_RECALL",
      details: {
        ...(extra.withdrawalUnavailable ? {} : { recallWithdrawn: true }),
        retirement: false, restoredStatus: restored, door: input.door, withdrawsRecallAt: recallAt,
        recipientCount: people.length, recipients: people, ...extra,
      },
    });
    if (res && res.ok === false) console.error(`[staleCopies] DIST-16: the record of the recall withdrawal of document ${input.documentId} was refused (${res.error})`);
  } catch { /* the withdrawal itself already went out */ }
}

/** PROD-17: the people a personal notice about this retirement already
 *  reached, other than the copy holders — the document's checkout holder
 *  (the supersede leaves the checkout open, so documents.checked_out_by
 *  still names them) and the owners of OPEN work packages pinning it (the
 *  set notifyPackagesOfRetirement tells). The actor is never in it (both
 *  notices skip the actor; emit drops them anyway). Best-effort: a read that
 *  fails leaves that person in the watchers' audience — a second notice is
 *  better than none. */
async function personallyToldOfRetirement(input: {
  documentId: string;
  actorUserId: string;
  personallyToldElsewhere?: { checkoutHolder?: boolean; packageOwners?: boolean };
}): Promise<string[]> {
  const told = new Set<string>();
  const want = input.personallyToldElsewhere ?? {};
  if (want.checkoutHolder !== false) {
    try {
      const { data, error } = await supabase
        .from("documents")
        .select("checked_out_by")
        .eq("id", input.documentId)
        .maybeSingle();
      const holder = error ? null : (data as { checked_out_by?: string | null } | null)?.checked_out_by ?? null;
      if (holder) told.add(String(holder));
    } catch { /* left in the audience */ }
  }
  if (want.packageOwners !== false) {
    try {
      const { data: memberRows, error } = await supabase
        .from("work_package_documents")
        .select("package_id")
        .eq("document_id", input.documentId);
      const pkgIds = error ? [] : [...new Set(((memberRows as Array<{ package_id: string }> | null) ?? []).map((r) => r.package_id))];
      if (pkgIds.length > 0) {
        const { data: pkgs, error: pkgErr } = await supabase
          .from("work_packages")
          .select("owner_user_id")
          .in("id", pkgIds)
          .neq("status", "closed");
        if (!pkgErr) {
          for (const p of (pkgs as Array<{ owner_user_id: string | null }> | null) ?? []) {
            if (p.owner_user_id) told.add(String(p.owner_user_id));
          }
        }
      }
    } catch { /* left in the audience */ }
  }
  told.delete(input.actorUserId);
  return [...told];
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
  /** DIST-9 dw3: the record could not be READ (getDocumentRecall's flag).
   *  Nobody can be nudged from it — the audit row says the recall could not
   *  be evaluated, so the publish never passes as "nobody was stale". */
  unavailable?: boolean;
}): Promise<number> {
  if (input.unavailable) {
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
          recipientCount: 0,
          recipients: [],
          externalCopies: 0,
          unavailable: true,
        },
      });
    } catch { /* the gap is already on the panel */ }
    return 0;
  }
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
    // PROD-13 / TAX-13 (N9): a recall is its own kind, not a supersede notice.
    kind: "doc_recalled",
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

// ─── The ticket arm (public-surfaces PHYS-17, PHYS-8 done-when 3; DF-P12) ──
//
// A drafting-ticket copy is no register version: it has no document_id /
// version_id, so the arms above never see it. Since 20261223 its
// download_audits row names the ticket and the file (ticket_id,
// attachment_id — lib/ticketDeliverableCopy.ts recordTicketCopy, and the
// server stamping route app/api/tickets/copy). The copy's standing is the
// verify verdict of THAT file against the ticket now (lib/verifyTicketVerdict.ts
// ticketVerdict with the file's own revision and id — PHYS-2, SM-5): a copy
// whose scan would answer superseded, withdrawn or "review draft" is
// outdated; one that answers current is current. A review draft is outdated
// only once the ticket has moved past it: a copy of the draft UNDER REVIEW
// now (the ticket is live and its label is that draft's) is the copy its
// reviewers work from — neither outdated nor nudged. Same window, cap, gap
// rule and recall record as a document's.

/** The ticket as the recall reads it (the columns the verdict reads). */
export interface TicketForRecall {
  id: string;
  orgId: string;
  status: string | null;
  deliverableRev: string | null;
  history: unknown;
  revisionCount?: number | null;
  /** 20261221's trust index (absent before the paste). */
  historyGuardedFrom?: number | null;
  attachments: unknown;
}

export interface TicketCopy {
  attachmentId: string | null;
  /** The file's own revision (TicketAttachment.rev), when it is still listed. */
  rev: string | null;
  copiedAt: string;
  source: string | null;
  /** What a scan of this copy answers now. */
  verdict: TicketVerdict;
  /** A copy of the review draft under review right now (the live label is
   *  this file's revision): a "review draft" verdict that is not outdated. */
  underReview: boolean;
}

export interface TicketCopyHolder {
  userId: string;
  userEmail: string | null;
  lastCopiedAt: string;
  /** Every copy of this ticket's files the member took in the window, latest first. */
  copies: TicketCopy[];
  /** Holds a copy whose scan answers superseded or withdrawn, or a review
   *  draft the ticket has moved past (never the draft under review now). */
  outdated: boolean;
  /** Took a copy that scans current (the latest issue) — the document arm's
   *  "re-pulled the current revision". */
  hasCurrent: boolean;
}

export interface TicketCopyRecall {
  holders: TicketCopyHolder[];
  /** DIST-11: the row cap was hit — holders may be MISSING. */
  capped: boolean;
  /** DIST-9 dw3: the record could not be read by ticket (before 20261223, or
   *  a read failure) — a gap in the evidence, never "nobody holds a copy". */
  unavailable: boolean;
  /** The ticket's last issue as the verdict reads it (for the notice). */
  latestIssuedRev: string | null;
}

/** The standing of one copy: an outdated verdict is one the field must not work from. */
const OUTDATED_VERDICTS: ReadonlySet<TicketVerdict> = new Set<TicketVerdict>(["superseded", "withdrawn", "draft_copy"]);
/** Outdated: its scan answers superseded or withdrawn, or it is a review
 *  draft the ticket has moved past (never the draft under review now). */
const isOutdatedCopy = (c: Pick<TicketCopy, "verdict" | "underReview">): boolean => OUTDATED_VERDICTS.has(c.verdict) && !c.underReview;

/** The copy's own revision, read from the ticket's files by id. */
function fileRevOf(attachments: unknown, attachmentId: string | null): string | null {
  if (!attachmentId || !Array.isArray(attachments)) return null;
  const f = attachments.find((a) => (a as { id?: unknown } | null)?.id === attachmentId) as { rev?: unknown } | undefined;
  return typeof f?.rev === "string" && f.rev.trim() ? f.rev.trim().toUpperCase() : null;
}

/** Distribution recall for one ticket's deliverable: everyone who took a copy
 *  of its files in the window, each copy read as a scan of it would read now. */
export async function getTicketCopyRecall(
  ticket: TicketForRecall,
  client: { from: typeof supabase.from } = supabase,
): Promise<TicketCopyRecall> {
  const latestIssuedRev = issueInForce(ticket.history, ticket.revisionCount, ticket.deliverableRev, ticket.historyGuardedFrom)
    ?? (typeof ticket.deliverableRev === "string" && /^\d+$/.test(ticket.deliverableRev) ? ticket.deliverableRev : null);
  const unavailable: TicketCopyRecall = { holders: [], capped: false, unavailable: true, latestIssuedRev };
  try {
    const since = new Date(Date.now() - DOC_RECALL_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const { data, error } = await client
      .from("download_audits")
      .select("user_id, user_email, attachment_id, created_at, source")
      .eq("org_id", ticket.orgId)
      .eq("ticket_id", ticket.id)
      .gt("created_at", since)
      .order("created_at", { ascending: false })
      .limit(DOC_RECALL_ROW_CAP);
    // Before 20261223 there is no ticket_id to read by (the read fails on the
    // unknown column), and any other failure is a gap too — never an empty list.
    if (error) return unavailable;
    const rows = (data as unknown as Array<{ user_id: string | null; user_email: string | null; attachment_id: string | null; created_at: string; source: string | null }> | null) ?? [];
    const capped = rows.length >= DOC_RECALL_ROW_CAP;
    const row = {
      status: ticket.status, deliverable_rev: ticket.deliverableRev, history: ticket.history,
      revision_count: ticket.revisionCount ?? null, history_guarded_from: ticket.historyGuardedFrom ?? null,
      attachments: ticket.attachments,
    };
    // The review label being worked now: the live ticket's own letter label.
    const live = typeof ticket.deliverableRev === "string" ? ticket.deliverableRev.trim().toUpperCase() : "";
    const reviewLabel = !isTerminalTicketStatus(ticket.status) && live !== "" && !isIssuedTicketRev(live) ? live : null;
    const byUser = new Map<string, TicketCopyHolder>();
    for (const r of rows) {
      if (!r.user_id) continue; // a ticket copy is always a member's own pull
      const rev = fileRevOf(ticket.attachments, r.attachment_id);
      const verdict = ticketVerdict(row, rev ?? "", r.attachment_id ?? "").verdict;
      const underReview = verdict === "draft_copy" && reviewLabel !== null && rev === reviewLabel;
      const copy: TicketCopy = { attachmentId: r.attachment_id ?? null, rev, copiedAt: r.created_at, source: r.source ?? null, verdict, underReview };
      const h = byUser.get(r.user_id) ?? { userId: r.user_id, userEmail: r.user_email ?? null, lastCopiedAt: r.created_at, copies: [], outdated: false, hasCurrent: false };
      h.copies.push(copy);
      if (isOutdatedCopy(copy)) h.outdated = true;
      if (verdict === "current") h.hasCurrent = true;
      byUser.set(r.user_id, h);
    }
    // Outdated holders first, then by recency.
    const holders = [...byUser.values()].sort((a, b) =>
      Number(b.outdated && !b.hasCurrent) - Number(a.outdated && !a.hasCurrent) || Date.parse(b.lastCopiedAt) - Date.parse(a.lastCopiedAt));
    return { holders, capped, unavailable: false, latestIssuedRev };
  } catch {
    return unavailable;
  }
}

/** One-click recall nudge for a ticket deliverable: tell every member holding
 *  an outdated copy who has not since taken the current one (the document
 *  arm's rule), and put the recall on the ticket's audit trail (DIST-10's
 *  record — who was told, when, by whom). A recall that could not be
 *  evaluated (`unavailable`) is recorded as such and nudges nobody. */
export async function nudgeStaleTicketHolders(input: {
  orgId: string;
  ticketId: string;
  ticketNumber: string | null;
  latestIssuedRev: string | null;
  holders: TicketCopyHolder[];
  actorUserId: string;
  actorName?: string | null;
  source?: "manual" | "auto";
  unavailable?: boolean;
}): Promise<number> {
  const label = input.ticketNumber || "this drafting request";
  const record = async (recipients: TicketCopyHolder[], unavailable: boolean) => {
    const res = await logAuditAction({
      action: "DISTRIBUTION_RECALL",
      resourceType: "ticket",
      resourceId: input.ticketId,
      orgId: input.orgId,
      userId: input.actorUserId,
      userEmail: input.actorName ?? undefined,
      details: {
        source: input.source ?? "manual",
        ticketNumber: input.ticketNumber,
        latestIssuedRev: input.latestIssuedRev,
        recipientCount: recipients.length,
        recipients: recipients.map((h) => ({ userId: h.userId, email: h.userEmail, heldRevs: [...new Set(h.copies.filter(isOutdatedCopy).map((c) => c.rev))] })),
        ...(unavailable ? { unavailable: true } : {}),
      },
    });
    if (!res.ok) console.error(`[staleCopies] the ticket copy recall for ${label} went out but its audit row was refused: ${res.error}`);
  };
  if (input.unavailable) {
    await record([], true);
    return 0;
  }
  const reachable = input.holders.filter((h) => h.outdated && !h.hasCurrent && h.userId !== input.actorUserId);
  if (reachable.length === 0) return 0;
  await emit({
    orgId: input.orgId,
    category: "recall",
    kind: "doc_recalled",
    title: `Your copy of ${label}'s deliverable is out of date`,
    body: input.latestIssuedRev
      ? `The latest issue is Rev ${input.latestIssuedRev}. A copy you took is no longer current — get the current deliverable before doing any work from it, and destroy old prints.`
      : `A copy you took of this request's deliverable is not one to work from (the request was withdrawn, or it was a review draft). Stop any work based on it and destroy old prints.`,
    link: `/requests/${input.ticketId}`,
    resource: { type: "ticket", id: input.ticketId },
    actorUserId: input.actorUserId,
    actorName: input.actorName ?? undefined,
    audience: { involved: reachable.map((h) => h.userId) },
    metadata: { recall: true, ticketCopy: true },
  });
  await record(reachable, false);
  return reachable.length;
}
