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
import { isControlledIssueStatus, isRetiredStatus } from "@/lib/issueStatus";
import { formatRecordDate, orgTimeZone } from "@/lib/recordTime";

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
   *  caller recall exactly as before. (DIST-16 done-when 2, the P28
   *  integrator fix pass: the watchers' FYI is now on the record too — a
   *  `watchersOnly` DISTRIBUTION_RECALL row naming nobody, written once the
   *  FYI went, when no recall row was.) */
  recallCopyHolders?: boolean;
  /** DIST-16 done-when 2 (document-control P28, the integrator's fix pass at
   *  the merge, 2026-10-21, DEC-90): the status the door read just before
   *  its write, given by every door that leaves "already retired" to the
   *  document's RECORD (the archive, a status change, a split, a merge, a
   *  reversal's park, a disposal, the bulk doors — each calls this for every
   *  retirement it lands). A prior that was IN FORCE — a controlled issue,
   *  or one the read did not give (null; lib/issueStatus.ts
   *  isControlledIssueStatus counts both) — is never "already retired": the
   *  recall goes as it always has and the record is not read (a record that
   *  missed a return to force can never suppress a recall). Any other prior
   *  (Draft, In Review, Void, Superseded, Archived) is "already retired" only
   *  when the record shows a retirement notice since the document's last
   *  return to force (retirementNoticeStands): then nothing goes again — no
   *  second watchers' FYI, and no copy holder was owed one (that prior took
   *  away no controlled issue, DEC-90 R1). No notice on record (a
   *  retirement by a door that told nobody, before this deploy) → its
   *  watchers are told now. A record that cannot be read sends (a second FYI
   *  over none). Absent (supersede): the caller decided, as before. */
  retiredFrom?: string | null;
}): Promise<number> {
  try {
    if (input.retiredFrom !== undefined && !isControlledIssueStatus(input.retiredFrom)
      && (await retirementNoticeStands(input.documentId)) === true) {
      return 0;
    }
    let holders: string[] = [];
    let recorded = false;
    if (input.recallCopyHolders !== false) {
      // DELIV-17 (document-control P28): the read is CHECKED and retried
      // once (readRetirementHolders). A read that still fails is logged and
      // put on the document's record as a recall that could not be computed
      // (an unavailable DISTRIBUTION_RECALL row, nudgeStaleHolders' DIST-9
      // shape) — never the silent "nobody held a copy" it used to be.
      const read = await readRetirementHolders(input.documentId, input.actorUserId);
      if (read.error === null) holders = read.holders;
      else { await recordUncomputedRecall(input, read.error); recorded = true; }
    }
    // The copy holders' recall goes out FIRST, with its DIST-10 audit row
    // (review fix, N15): it is the safety notice, and it must not wait on
    // the watchers' FYI below — whose discover check, follower reads and
    // inserts can be slow or never finish (a closed tab, a stalled route).
    if (holders.length > 0) {
      // DIST-16 race (the P28 integrator fix pass, DEC-90): every door fires
      // this chain without awaiting it, so a restore can land before it
      // sends. The document's status is read just before the recall: back
      // IN FORCE already (a controlled issue, not a retired status — a read
      // that fails or gives nothing is not "in force", and the recall goes),
      // nothing is sent — no "your copy is dead paper" for a drawing in
      // force, no watchers' FYI that it is retired — and it is logged.
      const backBefore = await readBackInForce(input.documentId);
      if (backBefore) {
        console.warn(`[staleCopies] DIST-16: document ${input.documentId} was back in force (${backBefore}) before its retirement recall (${input.newStatus}) was sent, so none was sent`);
        return 0;
      }
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
      recorded = true;
      // DIST-16 race: a restore that landed while the recall was going out
      // read the record BEFORE the row above existed, so its withdrawal found
      // nothing to withdraw. The status is read again now that the row is
      // written: back in force, the recall just sent is withdrawn here
      // (withdrawRetirementRecall reads the row back — a restore whose own
      // withdrawal already ran left a withdrawal row, so nothing goes twice),
      // and no watchers' FYI follows.
      const backAfter = await readBackInForce(input.documentId);
      if (backAfter) {
        await withdrawRetirementRecall({
          orgId: input.orgId, documentId: input.documentId, libraryId: input.libraryId ?? null, docLabel: input.docLabel,
          restoredStatus: backAfter, door: "restored_during_recall", actorUserId: input.actorUserId, actorName: null,
        });
        return holders.length;
      }
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
      // DIST-16 done-when 2: a retirement that recalled nobody is on the
      // record too, once its watchers' FYI went — what a later door reads to
      // know they were told (retirementNoticeStands).
      if (!recorded) await recordWatchersOnlyRetirement(input);
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

/** DIST-16 done-when 2 (P28 integrator fix pass): a retirement whose
 *  watchers were told and whose copy holders were not recalled (none held a
 *  copy, or the retirement took away no controlled issue) — on the record as
 *  a DISTRIBUTION_RECALL row naming nobody, `watchersOnly: true` (the audit
 *  viewers label it a retirement notice). A refused row is logged; the next
 *  retirement door then tells the watchers again (a second FYI over none). */
async function recordWatchersOnlyRetirement(input: RetirementRecallInput, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    const res = await logRevisionEvent({
      orgId: input.orgId,
      documentId: input.documentId,
      versionId: "",
      userId: input.actorUserId,
      userEmail: input.actorName ?? "",
      userRole: "",
      type: "DISTRIBUTION_RECALL",
      details: { retirement: true, newStatus: input.newStatus, recipientCount: 0, recipients: [], watchersOnly: true, ...extra },
    });
    if (res && res.ok === false) console.error(`[staleCopies] DIST-16: the record that the watchers of document ${input.documentId} were told of its retirement was refused (${res.error})`);
  } catch (e) {
    console.error(`[staleCopies] DIST-16: the record that the watchers of document ${input.documentId} were told of its retirement was not written`, e);
  }
}

/** DIST-16 done-when 2 (P28 integrator fix pass): does a retirement notice
 *  stand on the document since its last return to force? Its
 *  DISTRIBUTION_RECALL rows newest first: a withdrawal row
 *  (`recallWithdrawn: true` — every restore that puts back in force a
 *  document with a retirement notice standing writes one, even when nobody
 *  was recalled) ends the read with no; a `retirement: true` row before it
 *  (a recall, an unavailable recall, a watchers-only notice) is yes. null
 *  when the record cannot be read — the caller then sends (fail-safe).
 *  Consulted only for a prior that was not in force (a forged row can at
 *  most withhold a watchers' FYI, never a copy-holder recall). */
async function retirementNoticeStands(documentId: string): Promise<boolean | null> {
  try {
    const { data, error } = await supabase
      .from("audit_logs")
      .select("details, timestamp")
      .eq("resource_type", "document")
      .eq("resource_id", documentId)
      .eq("action", "DISTRIBUTION_RECALL")
      .order("timestamp", { ascending: false })
      .limit(200);
    if (error) {
      console.warn(`[staleCopies] DIST-16: the recall record of document ${documentId} could not be read (${error.message}), so its retirement notice is sent`);
      return null;
    }
    for (const r of ((data as Array<{ details: Record<string, unknown> | null }> | null) ?? [])) {
      const d = r.details ?? {};
      if (d.recallWithdrawn === true) return false;
      if (d.retirement === true) return true;
    }
    return false;
  } catch (e) {
    console.warn(`[staleCopies] DIST-16: the recall record of document ${documentId} could not be read, so its retirement notice is sent`, e);
    return null;
  }
}

/** DIST-16 race (P28 integrator fix pass): the document's status when it is
 *  back IN FORCE — a non-blank controlled issue status that is not a
 *  retired one — else null. A read that fails, throws or finds no row is
 *  null: the recall is never withheld on a guess. */
async function readBackInForce(documentId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.from("documents").select("status").eq("id", documentId).maybeSingle();
    if (error) return null;
    const status = String(((data as { status?: string | null } | null)?.status) ?? "").trim();
    return status && isControlledIssueStatus(status) && !isRetiredStatus(status) ? status : null;
  } catch {
    return null;
  }
}

/** PROD-17 (document-control P28): the BULK retirement doors' recall — the
 *  library page's bulk archive and the bulk editor's Superseded / Archived.
 *  One call per apply, never awaited by the door (the caller fires it).
 *  Each door reads the selected rows' statuses ONCE, fresh, before its
 *  write (never the page's copy; a failed read leaves a row's prior
 *  unknown, which recalls — lib/revisions.ts recallsCopyHolders), passes
 *  every row it retired with `recallCopyHolders` — true only for a row that
 *  took away a controlled issue (DEC-90 R1) — and its prior as `retiredFrom`
 *  (DIST-16 done-when 2, the P28 integrator fix pass: a row whose prior was
 *  not in force is left out when the document's record shows a retirement
 *  notice since its last return to force, recallRetiredDocument's rule;
 *  before that pass the doors left out every Superseded / Archived prior
 *  themselves). Then, here:
 *    · each such document's copy holders are read (checked, retried once —
 *      DELIV-17; a read that fails is logged and recorded unavailable);
 *    · a document already back IN FORCE (a restore that landed first — the
 *      DIST-16 race, P28 integrator fix pass) is dropped: nothing is sent
 *      for it;
 *    · each HOLDER gets ONE doc_recalled for the whole apply, naming every
 *      document of it they hold a copy of — never one notice (and one
 *      preference-exempt safety_recall email) per row: a 150-row bulk
 *      archive used to be the burst P26's fix pass reverted;
 *    · each document gets its own DISTRIBUTION_RECALL row (DIST-10 — the
 *      record a later restore's withdrawal reads back, DIST-16); a document
 *      found back in force once its row is written has that recall
 *      withdrawn (withdrawRetirementRecall) and no FYI;
 *    · then the watchers: each follower of ONE retired document of a
 *      library gets that document's doc_retired FYI, word for word as
 *      recallRetiredDocument sends it; a follower of SEVERAL retired
 *      documents of one library gets ONE FYI naming them (P28 integrator fix
 *      pass, DEC-90 — grouped as the holders' recall is: on the library,
 *      `namesDocuments` so the dispatcher checks they may discover each one
 *      it names). Each document's copy holders are left out of its FYI (the
 *      bulk doors send no personal notice to a checkout holder or a package
 *      owner, so those stay in). A document that recalled nobody gets a
 *      watchers-only row once its FYI went (DIST-16 done-when 2).
 *  Returns how many people were recalled. */
export async function recallRetiredBatch(input: {
  orgId: string;
  newStatus: string;                 // "Superseded" | "Archived"
  actorUserId: string;
  actorName?: string | null;
  replacementNote?: string | null;
  docs: Array<{ documentId: string; libraryId?: string | null; docLabel: string; recallCopyHolders: boolean; retiredFrom?: string | null }>;
}): Promise<number> {
  try {
    const per = (d: (typeof input.docs)[number]): RetirementRecallInput => ({
      orgId: input.orgId, documentId: d.documentId, libraryId: d.libraryId ?? null, docLabel: d.docLabel || "A document",
      newStatus: input.newStatus, replacementNote: input.replacementNote ?? null,
      actorUserId: input.actorUserId, actorName: input.actorName ?? null,
      personallyToldElsewhere: { checkoutHolder: false, packageOwners: false },
      recallCopyHolders: d.recallCopyHolders,
    });
    const docs: typeof input.docs = [];
    for (const d of new Map(input.docs.map((x) => [x.documentId, x])).values()) {
      // DIST-16 done-when 2: "already retired" from the record, for a prior not in force.
      if (d.retiredFrom !== undefined && !isControlledIssueStatus(d.retiredFrom)
        && (await retirementNoticeStands(d.documentId)) === true) continue;
      docs.push(d);
    }
    const holdersOf = new Map<string, string[]>();
    const recordedIds = new Set<string>();
    const backInForce = new Set<string>();
    for (const d of docs) {
      if (!d.recallCopyHolders) continue;
      const read = await readRetirementHolders(d.documentId, input.actorUserId);
      if (read.error === null) {
        if (read.holders.length === 0) continue;
        // DIST-16 race: back in force before anything is sent — dropped.
        const back = await readBackInForce(d.documentId);
        if (back) {
          console.warn(`[staleCopies] DIST-16: document ${d.documentId} was back in force (${back}) before its retirement recall (${input.newStatus}) was sent, so none was sent`);
          backInForce.add(d.documentId);
          continue;
        }
        holdersOf.set(d.documentId, read.holders);
      } else {
        await recordUncomputedRecall(per(d), read.error);
        recordedIds.add(d.documentId);
      }
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
      if (holders.length === 0) continue;
      await recordRetirementRecall(per(d), holders, { batch: true });
      recordedIds.add(d.documentId);
      // DIST-16 race: a restore that landed while the recall went out read
      // the record before this row existed — the recall is withdrawn here.
      const back = await readBackInForce(d.documentId);
      if (back) {
        backInForce.add(d.documentId);
        await withdrawRetirementRecall({
          orgId: input.orgId, documentId: d.documentId, libraryId: d.libraryId ?? null, docLabel: d.docLabel || "A document",
          restoredStatus: back, door: "restored_during_recall", actorUserId: input.actorUserId, actorName: null,
        });
      }
    }
    // The watchers, after every recall and record (a document back in force
    // gets no FYI). A follower of several retired documents of one library
    // is moved out of each one's own FYI into ONE grouped FYI; the follow
    // list is read once, checked — unreadable, every document's own FYI goes
    // to all its watchers, as before (a second notice over none).
    const fyiDocs = docs.filter((d) => !backInForce.has(d.documentId));
    const toldElsewhereOf = new Map<string, string[]>();
    for (const doc of fyiDocs) {
      try { toldElsewhereOf.set(doc.documentId, await personallyToldOfRetirement(per(doc))); } catch { toldElsewhereOf.set(doc.documentId, []); }
    }
    const followerGroups = await groupRetirementFollowers(input.actorUserId, fyiDocs, (id) => [...(holdersOf.get(id) ?? []), ...(toldElsewhereOf.get(id) ?? [])]);
    for (const doc of fyiDocs) {
      const d = per(doc);
      const holders = holdersOf.get(d.documentId) ?? [];
      try {
        const toldElsewhere = toldElsewhereOf.get(d.documentId) ?? [];
        const grouped = followerGroups.movedOut.get(d.documentId) ?? [];
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
          audience: { followers: true, exclude: [...new Set([...holders, ...toldElsewhere, ...grouped])] },
          metadata: { retirement: true, followerNotice: true, newStatus: d.newStatus },
          emailOnlyWithBell: true,
        });
        if (!recordedIds.has(d.documentId)) await recordWatchersOnlyRetirement(d, { batch: true });
      } catch { /* the recalls above already went out */ }
    }
    for (const g of followerGroups.groups) {
      const named = g.docIds.map((id) => byId.get(id)!);
      const shown = named.slice(0, 10);
      const verb = input.newStatus.toLowerCase();
      try {
        await emit({
          orgId: input.orgId,
          category: "watched",
          kind: "doc_retired",
          title: `${named.length} documents you follow were retired (${input.newStatus})`,
          body: `${input.actorName || "Someone"} retired these documents (${verb}); there is no current revision of them to work from: ` +
            `${shown.map((d) => d.docLabel || "A document").join(", ")}${named.length > shown.length ? ` and ${named.length - shown.length} more` : ""}.` +
            (input.replacementNote ? ` ${input.replacementNote}` : ""),
          link: `/documents/${g.libraryId}`,
          resource: { type: "library", id: g.libraryId },
          actorUserId: input.actorUserId,
          actorName: input.actorName ?? undefined,
          audience: { involved: g.followers },
          metadata: { retirement: true, followerNotice: true, newStatus: input.newStatus, documentIds: g.docIds },
          emailOnlyWithBell: true,
          // NEDGE-22: a follower is told the names only while they may
          // discover every document named; else the notice without them.
          namesDocuments: {
            ids: shown.map((d) => d.documentId),
            unnamed: {
              title: `Documents you follow were retired (${input.newStatus})`,
              body: `${input.actorName || "Someone"} retired documents you follow (${verb}); there is no current revision of them to work from. Open the library to see the ones you have access to.`,
              link: `/documents/${g.libraryId}`,
            },
          },
        });
      } catch { /* the recalls above already went out */ }
    }
    return docsOfHolder.size;
  } catch (e) {
    console.error(`[staleCopies] DELIV-17: the bulk retirement recall (${input.newStatus}, ${input.docs.length} document(s)) failed part-way`, e);
    return 0;
  }
}

/** PROD-17 (P28 integrator fix pass, DEC-90): the bulk doors' watchers,
 *  grouped per follower — each retired document's followers (its
 *  `subscriptions` rows, read once, checked, in chunks), minus the actor and
 *  the people `excluded` names for it (its copy holders, anyone told
 *  personally). A follower of TWO or more of the documents in one library is
 *  one grouped notice's audience (`groups`: one per library and set of
 *  documents) and is moved out of each of those documents' own FYI
 *  (`movedOut`). A follower of one is left to that document's own FYI. A
 *  document with no library is never grouped. A read that fails groups
 *  nobody (every document's own FYI goes as before). */
async function groupRetirementFollowers(
  actorUserId: string,
  docs: Array<{ documentId: string; libraryId?: string | null }>,
  excluded: (documentId: string) => string[],
): Promise<{ groups: Array<{ libraryId: string; docIds: string[]; followers: string[] }>; movedOut: Map<string, string[]> }> {
  const none = { groups: [], movedOut: new Map<string, string[]>() };
  const ids = docs.filter((d) => !!d.libraryId).map((d) => d.documentId);
  if (ids.length < 2) return none;
  const followersOf = new Map<string, Set<string>>();
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await supabase
        .from("subscriptions")
        .select("user_id, resource_id")
        .eq("resource_type", "document")
        .in("resource_id", ids.slice(i, i + 100));
      if (error) {
        console.warn(`[staleCopies] PROD-17: the follow list of the retired documents could not be read (${error.message}) — each document's own FYI goes to all its watchers`);
        return none;
      }
      for (const r of ((data as Array<{ user_id: string | null; resource_id: string | null }> | null) ?? [])) {
        if (!r.user_id || !r.resource_id) continue;
        followersOf.set(r.resource_id, (followersOf.get(r.resource_id) ?? new Set()).add(r.user_id));
      }
    }
  } catch (e) {
    console.warn("[staleCopies] PROD-17: the follow list of the retired documents could not be read — each document's own FYI goes to all its watchers", e);
    return none;
  }
  const docsOf = new Map<string, { libraryId: string; uid: string; docIds: string[] }>();
  for (const d of docs) {
    if (!d.libraryId) continue;
    const skip = new Set([actorUserId, ...excluded(d.documentId)]);
    for (const u of followersOf.get(d.documentId) ?? []) {
      if (skip.has(u)) continue;
      const key = `${d.libraryId}\u0000${u}`;
      const e = docsOf.get(key) ?? { libraryId: d.libraryId, uid: u, docIds: [] };
      e.docIds.push(d.documentId);
      docsOf.set(key, e);
    }
  }
  const groups = new Map<string, { libraryId: string; docIds: string[]; followers: string[] }>();
  const movedOut = new Map<string, string[]>();
  for (const e of docsOf.values()) {
    if (e.docIds.length < 2) continue;
    const key = `${e.libraryId}\u0000${e.docIds.join("|")}`;
    const g = groups.get(key) ?? { libraryId: e.libraryId, docIds: e.docIds, followers: [] };
    g.followers.push(e.uid);
    groups.set(key, g);
    for (const id of e.docIds) movedOut.set(id, [...(movedOut.get(id) ?? []), e.uid]);
  }
  return { groups: [...groups.values()], movedOut };
}

/** DIST-16 (document-control P28): a document put back IN FORCE — an
 *  un-archive, a reversed split or merge restoring it, a status editor's
 *  write of an issue status over a prior that was not one (a put-back of a
 *  retired issue, or a document restored into Draft / In Review and issued
 *  later) — withdraws the retirement recall that stands on it. "Stands" is
 *  read from the document's own record: every DISTRIBUTION_RECALL row with
 *  `retirement: true` (and recipients) written after its last withdrawal row
 *  (`recallWithdrawn: true`) — the recall row is the only evidence a recall
 *  went (a bare retirement leaves none). The people those rows named (the
 *  actor aside) get ONE notice that the recall is withdrawn, naming the
 *  status the document is back in, the recall by its bell title and the
 *  recall's date in the workspace's zone (lib/recordTime.ts — the bell row
 *  the holder has shows that day, never a UTC day that can be the next one),
 *  and the withdrawal goes on the record (the next restore reads from it).
 *  Its kind is library_doc_revised — a declared, NON-compliance, deletable
 *  FYI (20261160 lists it, so it is written before and after 20261206's
 *  paste; the integrator's ruling under DEC-90 prefers an existing kind to a
 *  new notification_kinds() row) — on the recall category, so it reaches
 *  everyone the preference-exempt recall reached. Nothing goes when the
 *  document is not back in force (a restore into Draft or In Review: "do not
 *  work from your copy" still holds) or no recall stands. A record that
 *  cannot be read is logged and recorded, never guessed. Fired, never
 *  awaited, by every single-document restore door (a BULK put-back sends
 *  withdrawRetirementBatch once per apply instead); returns how many people
 *  were told. */
export async function withdrawRetirementRecall(input: {
  orgId: string;
  documentId: string;
  libraryId?: string | null;
  docLabel?: string | null;
  restoredStatus: string | null;
  /** "restored_during_recall" (P28 integrator fix pass): the retirement
   *  recall itself, finding the document back in force once its row was
   *  written (recallRetiredDocument / recallRetiredBatch — the DIST-16 race). */
  door: "unarchive" | "split_reversed" | "merge_reversed" | "put_back" | "restored_during_recall";
  actorUserId: string;
  actorName?: string | null;
}): Promise<number> {
  const restored = (input.restoredStatus ?? "").trim();
  if (!restored || !isControlledIssueStatus(restored)) return 0;
  try {
    const read = await readStandingRecall(input.documentId, input.actorUserId);
    if (!read.ok) {
      console.error(`[staleCopies] DIST-16: the recall record of document ${input.documentId} could not be read, so whether a retirement recall stands is unknown and no withdrawal was sent (${read.error})`);
      await recordWithdrawal(input, restored, [], null, { withdrawalUnavailable: true, readError: read.error });
      return 0;
    }
    if (read.people.length === 0) {
      // DIST-16 done-when 2 (P28 integrator fix pass): back in force with a
      // retirement notice standing but nobody to withdraw it from (a
      // watchers-only notice, an unavailable recall, a row not borne out) —
      // the return to force is still recorded (a withdrawal row naming
      // nobody, no notice), so the next retirement door reads it as not
      // already retired. Nothing is written when no notice stands.
      if (read.noticeSince) await recordWithdrawal(input, restored, [], null, { returnedToForce: true });
      return 0;
    }
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
    const timeZone = await orgTimeZone(supabase, input.orgId);
    await emit({
      ...singleWithdrawalNotice({
        orgId: input.orgId, documentId: input.documentId, libraryId, label: docLabel || "A document",
        restored, read, timeZone, door: input.door, actorName: input.actorName ?? null,
      }),
      actorUserId: input.actorUserId,
    });
    await recordWithdrawal(input, restored, read.people, read.recallAt);
    return read.people.length;
  } catch (e) {
    console.error(`[staleCopies] DIST-16: the recall withdrawal of document ${input.documentId} failed part-way`, e);
    return 0;
  }
}

type StandingRecall =
  /** noticeSince (P28 integrator fix pass): any `retirement: true` row since
   *  the last withdrawal — a retirement notice of any kind stands. */
  | { ok: true; people: string[]; recallAt: string | null; recalledAs: string | null; noticeSince: boolean }
  | { ok: false; error: string };

/** DIST-16: the retirement recall standing on a document — the people every
 *  DISTRIBUTION_RECALL row since its last withdrawal named (the actor
 *  aside), the newest recall's time and the status it recalled for.
 *
 *  P28 second fix pass: audit_logs is not a trusted source. Any active member
 *  may insert any action with any details on any document of the workspace
 *  (audit_logs_insert checks only the author and the workspace), and the
 *  withdrawal it drives is a preference-exempt recall-category notice and
 *  email under the restorer's name. So a recall row is believed only as far
 *  as the record a member cannot forge for someone else bears it out:
 *    · its recipients must ALL be people the document's download_audits
 *      names (a member inserts only their own pulls — 20261068's
 *      download_audits_insert_own — and a real retirement recall names only
 *      copy holders read from that table). A row naming anyone else is
 *      skipped whole and logged; the people taken are therefore always a
 *      subset of the document's pullers;
 *    · the status it recalled for is quoted only when it is a retired status
 *      (isRetiredStatus) — otherwise recalledAs is null and the notice names
 *      no status, so no free text from the row reaches a notice or an email.
 *  The holders read is checked: a failure answers ok: false (logged and
 *  recorded by the callers, never guessed). Residual (recorded on DIST-16):
 *  a forged `recallWithdrawn: true` row still ends the read — it can only
 *  suppress a withdrawal (the safe direction: holders keep "do not work from
 *  your copy" on a document that is in force again). */
async function readStandingRecall(documentId: string, actorUserId: string): Promise<StandingRecall> {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("details, timestamp")
    .eq("resource_type", "document")
    .eq("resource_id", documentId)
    .eq("action", "DISTRIBUTION_RECALL")
    .order("timestamp", { ascending: false })
    .limit(200);
  if (error) return { ok: false, error: error.message ?? "the recall record could not be read" };
  const rows = ((data as Array<{ details: Record<string, unknown> | null; timestamp: string | null }> | null) ?? []);
  const claimed: Array<{ at: string | null; recipients: string[]; newStatus: string | null }> = [];
  let noticeSince = false;
  for (const r of rows) {           // newest first
    const d = r.details ?? {};
    if (d.recallWithdrawn === true) break;
    if (d.retirement === true) noticeSince = true;
    if (d.retirement !== true || d.unavailable === true) continue;
    const recipients = Array.isArray(d.recipients) ? [...new Set((d.recipients as unknown[]).filter((u): u is string => typeof u === "string" && !!u))] : [];
    const newStatus = typeof d.newStatus === "string" && isRetiredStatus(d.newStatus) ? d.newStatus.trim() : null;
    if (recipients.length > 0) claimed.push({ at: r.timestamp ?? null, recipients, newStatus });
  }
  if (claimed.length === 0) return { ok: true, people: [], recallAt: null, recalledAs: null, noticeSince };
  const pullers = await readDocumentPullers(documentId, [...new Set(claimed.flatMap((c) => c.recipients))]);
  if (!pullers.ok) return { ok: false, error: pullers.error };
  const standing = claimed.filter((c) => {
    const borne = c.recipients.every((u) => pullers.users.has(u));
    if (!borne) console.warn(`[staleCopies] DIST-16: a DISTRIBUTION_RECALL row on document ${documentId} (${c.at ?? "undated"}) names people with no download of it on record — not a recall this system wrote; it is not withdrawn`);
    return borne;
  });
  const people = [...new Set(standing.flatMap((s) => s.recipients))].filter((u) => u !== actorUserId && pullers.users.has(u));
  return { ok: true, people, recallAt: standing[0]?.at ?? null, recalledAs: standing[0]?.newStatus ?? null, noticeSince };
}

/** DIST-16 (P28 second fix pass): which of `candidates` the document's
 *  download_audits names — read in chunks (a recall can name hundreds; one
 *  `.in()` that long is past the gateway's URL limit), each read checked. A
 *  failed chunk answers its error, never a partial set. A person whose rows
 *  were crowded out of a chunk's page counts as absent, which drops a row
 *  (never adds a person). */
const PULLER_CHUNK = 25;
async function readDocumentPullers(documentId: string, candidates: string[]): Promise<{ ok: true; users: Set<string> } | { ok: false; error: string }> {
  const users = new Set<string>();
  for (let i = 0; i < candidates.length; i += PULLER_CHUNK) {
    const chunk = candidates.slice(i, i + PULLER_CHUNK);
    try {
      const { data, error } = await supabase
        .from("download_audits")
        .select("user_id")
        .eq("document_id", documentId)
        .in("user_id", chunk)
        .limit(DOC_RECALL_ROW_CAP);
      if (error) return { ok: false, error: `the document's download record could not be read (${error.message || "refused"})` };
      for (const r of ((data as Array<{ user_id: string | null }> | null) ?? [])) if (r.user_id) users.add(r.user_id);
    } catch (e) {
      return { ok: false, error: `the document's download record could not be read (${(e as Error)?.message ?? String(e)})` };
    }
  }
  return { ok: true, users };
}

/** DIST-16: the one-document withdrawal notice — the single door's and a
 *  bulk put-back's for a holder recalled on one document, word for word
 *  (each caller's emit names its own actor, so the actor census reads it).
 *  The recall is named by the bell title the holder has ("<doc> is now
 *  <status> — your copy is dead paper") and by its day in the workspace's
 *  zone (formatRecordDate names the zone; UTC when none is set). */
function singleWithdrawalNotice(input: {
  orgId: string; documentId: string; libraryId: string | null; label: string; restored: string;
  read: { people: string[]; recallAt: string | null; recalledAs: string | null };
  timeZone: string | null; door: string; actorName: string | null;
}): Omit<Parameters<typeof emit>[0], "actorUserId"> {
  const { label, restored, read } = input;
  const when = read.recallAt ? formatRecordDate(read.recallAt, input.timeZone) : "an earlier date";
  const named = read.recalledAs ? ` ("${label} is now ${read.recalledAs} — your copy is dead paper")` : "";
  return {
    orgId: input.orgId,
    category: "recall",
    kind: "library_doc_revised",
    title: `${label} is back in force (${restored}) — the recall of ${when} is withdrawn`,
    body:
      `${input.actorName || "Someone"} put ${label} back in force as ${restored}. The notice of ${when}${named} telling you to stop work ` +
      `from your copy and destroy old prints is withdrawn: the document is current again. Before working from a copy, check it is the current revision.`,
    link: input.libraryId ? `/documents/${input.libraryId}?doc=${input.documentId}` : undefined,
    resource: { type: "document", id: input.documentId },
    actorName: input.actorName ?? undefined,
    audience: { involved: read.people },
    metadata: { recallWithdrawn: true, restoredStatus: restored, withdrawsRecallAt: read.recallAt, door: input.door },
  };
}

/** DIST-16 (document-control P28 fix pass): a BULK put-back's withdrawal —
 *  the bulk status editor writing an issue status over rows whose prior was
 *  not one (read once, fresh, before the apply; a failed read leaves a
 *  row's prior unknown, which is asked). One call per apply, fired, never
 *  awaited, instead of one withdrawRetirementRecall per row (each on the
 *  preference-exempt recall category — a 150-row put-back would have been
 *  150 notices and 150 safety_recall emails to one holder, the per-row
 *  burst recallRetiredBatch exists to avoid). Here:
 *    · each document's standing recall is read (a read that fails is
 *      logged and recorded as a withdrawal that could not be computed);
 *    · each person a standing recall named gets ONE notice for the whole
 *      apply naming every restored document they were recalled on — a
 *      person recalled on one document gets the single door's notice, word
 *      for word;
 *    · each document gets its own recallWithdrawn DISTRIBUTION_RECALL row
 *      naming the people its recall had named (where the next restore stops
 *      reading).
 *  Nothing goes for a document whose status is not an issue status or on
 *  which no recall stands. Returns how many people were told. */
export async function withdrawRetirementBatch(input: {
  orgId: string;
  door: "put_back";
  actorUserId: string;
  actorName?: string | null;
  docs: Array<{ documentId: string; libraryId?: string | null; docLabel: string; restoredStatus: string }>;
}): Promise<number> {
  try {
    const docs = [...new Map(input.docs
      .map((d) => ({ ...d, restoredStatus: (d.restoredStatus ?? "").trim() }))
      .filter((d) => !!d.restoredStatus && isControlledIssueStatus(d.restoredStatus))
      .map((d) => [d.documentId, d] as const)).values()];
    if (docs.length === 0) return 0;
    const standingOf = new Map<string, { people: string[]; recallAt: string | null; recalledAs: string | null }>();
    const returnedOnly: typeof docs = [];
    for (const d of docs) {
      let read: StandingRecall;
      try { read = await readStandingRecall(d.documentId, input.actorUserId); } catch (e) { read = { ok: false, error: (e as Error)?.message || String(e) }; }
      if (!read.ok) {
        console.error(`[staleCopies] DIST-16: the recall record of document ${d.documentId} could not be read, so whether a retirement recall stands is unknown and no withdrawal was sent for it (${read.error})`);
        await recordWithdrawal({ ...input, documentId: d.documentId }, d.restoredStatus, [], null, { withdrawalUnavailable: true, readError: read.error, batch: true });
        continue;
      }
      if (read.people.length > 0) standingOf.set(d.documentId, read);
      else if (read.noticeSince) returnedOnly.push(d);
    }
    // DIST-16 done-when 2 (P28 integrator fix pass): as the single door — a
    // notice standing with nobody to withdraw it from is closed by a
    // withdrawal row naming nobody (no notice).
    for (const d of returnedOnly) await recordWithdrawal({ ...input, documentId: d.documentId }, d.restoredStatus, [], null, { returnedToForce: true, batch: true });
    if (standingOf.size === 0) return 0;
    const docsOfPerson = new Map<string, string[]>();
    for (const d of docs) for (const u of standingOf.get(d.documentId)?.people ?? []) docsOfPerson.set(u, [...(docsOfPerson.get(u) ?? []), d.documentId]);
    const groups = new Map<string, { docIds: string[]; people: string[] }>();
    for (const [u, ids] of docsOfPerson) {
      const key = ids.join("|");
      const g = groups.get(key) ?? { docIds: ids, people: [] };
      g.people.push(u);
      groups.set(key, g);
    }
    const byId = new Map(docs.map((d) => [d.documentId, d]));
    const timeZone = await orgTimeZone(supabase, input.orgId);
    for (const g of groups.values()) {
      if (g.docIds.length === 1) {
        const d = byId.get(g.docIds[0])!;
        const st = standingOf.get(d.documentId)!;
        await emit({
          ...singleWithdrawalNotice({
            orgId: input.orgId, documentId: d.documentId, libraryId: d.libraryId ?? null, label: d.docLabel || "A document",
            restored: d.restoredStatus, read: { ...st, people: g.people }, timeZone, door: input.door,
            actorName: input.actorName ?? null,
          }),
          actorUserId: input.actorUserId,
        });
        continue;
      }
      const named = g.docIds.map((id) => byId.get(id)!);
      const libs = [...new Set(named.map((d) => d.libraryId ?? null))];
      const shown = named.slice(0, 10).map((d) => `${d.docLabel || "A document"} (${d.restoredStatus})`);
      await emit({
        orgId: input.orgId,
        category: "recall",
        kind: "library_doc_revised",
        title: `${named.length} documents you were recalled on are back in force — the recalls are withdrawn`,
        body:
          `${input.actorName || "Someone"} put these documents back in force: ` +
          `${shown.join(", ")}${named.length > shown.length ? ` and ${named.length - shown.length} more` : ""}. ` +
          `The notices telling you to stop work from your copies of them and destroy old prints are withdrawn: they are current again. ` +
          `Before working from a copy, check it is the current revision.`,
        link: libs.length === 1 && libs[0] ? `/documents/${libs[0]}` : undefined,
        resource: libs.length === 1 && libs[0] ? { type: "library", id: libs[0] } : { type: "document", id: named[0].documentId },
        actorUserId: input.actorUserId,
        actorName: input.actorName ?? undefined,
        audience: { involved: g.people },
        metadata: { recallWithdrawn: true, documentIds: g.docIds, door: input.door },
      });
    }
    for (const d of docs) {
      const st = standingOf.get(d.documentId);
      if (st) await recordWithdrawal({ ...input, documentId: d.documentId }, d.restoredStatus, st.people, st.recallAt, { batch: true });
    }
    return docsOfPerson.size;
  } catch (e) {
    console.error(`[staleCopies] DIST-16: the bulk recall withdrawal (${input.docs.length} document(s)) failed part-way`, e);
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
