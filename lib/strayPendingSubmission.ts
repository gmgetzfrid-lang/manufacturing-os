// lib/strayPendingSubmission.ts — document-control Round G, P37 DOOR B GUARD
// (DCK-18 (c); assigned by the integrator at the P35 merge, 2026-10-21,
// DEC-31; ruled under DEC-90: fail-safe, no regression).
//
// A document's pending draft can be a contractor-shaped submission
// ('external', in review, no member as its creator) that NO project's Intake
// tab lists: its intake link is a quote link, the link no longer exists, or it
// names none (20261252's inventory row 6 / query 3). The Intake tab's approve
// and Reject cannot reach it, and before this package nothing retired it
// except, as a side effect, a controller's rev-up, revert or archive of the
// document. This module gives Document Control a standalone, recorded retire
// of exactly that draft, through the existing lib/revisions.ts
// voidPendingDraft path (its open sign-offs voided, the draft stamped
// superseded, the pending pointer released — compare-and-set on the draft it
// read), shown where the document's pending draft is shown (the Inspector's
// review panel, components/documents/ReviewGateSection.tsx).
//
// The Intake tab's own rule decides "listed": components/projects/IntakePanel.tsx
// reads a project's links with purpose 'documents' (a database without the
// column: every link) and then the in-review revisions filed through them —
// so a submission whose link is a DOCUMENT link of the org is the tab's, and
// is never offered here (Reject it there). Anything this cannot read is not
// offered either (fail-safe: no "nobody lists it" claim from an unread row).

import { supabase } from "@/lib/supabase";
import { voidPendingDraft } from "@/lib/revisions";
import { logAuditAction } from "@/lib/audit";

/** Why no Intake tab lists the submission. */
export type StrayCause = "quote_link" | "link_gone" | "no_link";

export interface StraySubmission {
  versionId: string;
  revisionLabel: string | null;
  intakeLinkId: string | null;
  /** The link's purpose when it still exists (a quote link: 'quote'). */
  linkPurpose: string | null;
  cause: StrayCause;
}

export interface PendingVersionRow {
  id: string;
  record_id?: string | null;
  review_state?: string | null;
  provenance?: string | null;
  intake_link_id?: string | null;
  created_by?: string | null;
  revision_label?: string | null;
  superseded_at?: string | null;
}

export interface IntakeLinkRow {
  id: string;
  purpose?: string | null;
}

/** Pure: the pending row is a contractor-shaped submission (in review,
 *  'external', no member creator — NULL or the link's own id, as the door
 *  writes it — and not already retired). The same shape 20261252's inventory
 *  counts and door (b)'s intake limb reads. */
export function isDoorShapedSubmission(v: PendingVersionRow | null | undefined): boolean {
  if (!v) return false;
  if (v.review_state !== "in_review" || v.provenance !== "external") return false;
  if (v.superseded_at) return false;
  return v.created_by == null || (v.intake_link_id != null && v.created_by === v.intake_link_id);
}

/** Pure: whether a project's Intake tab lists a submission filed through this
 *  link — a link that exists with purpose 'documents' (or no purpose: a
 *  database before the column, where the tab reads every link). */
export function listedOnIntakeTab(link: IntakeLinkRow | null): boolean {
  return link != null && (link.purpose ?? "documents") === "documents";
}

/** Pure: the stray submission, or null when the row is not one (not
 *  door-shaped, or a project's Intake tab lists it). `link` is the row the
 *  link id names, or null when none was found (gone) — only ever call this
 *  with a link read that succeeded. */
export function strayFromRows(v: PendingVersionRow | null | undefined, link: IntakeLinkRow | null): StraySubmission | null {
  if (!v || !isDoorShapedSubmission(v)) return null;
  if (listedOnIntakeTab(link)) return null;
  const cause: StrayCause = !v.intake_link_id ? "no_link" : link == null ? "link_gone" : "quote_link";
  return {
    versionId: v.id,
    revisionLabel: v.revision_label ?? null,
    intakeLinkId: v.intake_link_id ?? null,
    linkPurpose: link?.purpose ?? null,
    cause,
  };
}

/** The sentence the Inspector shows for a stray submission. */
export function describeStray(s: StraySubmission): string {
  const label = s.revisionLabel ? `The pending submission ${s.revisionLabel}` : "The pending submission";
  const why = s.cause === "quote_link"
    ? "came through a quote link"
    : s.cause === "link_gone"
      ? "came through an intake link that no longer exists"
      : "names no intake link";
  return `${label} ${why}, so no project's Intake tab lists it — it can't be approved or rejected there.`;
}

export type StrayRead =
  | { kind: "stray"; stray: StraySubmission }
  | { kind: "none" }
  | { kind: "unknown"; reason: string };

/** Read the document's pending draft and decide whether it is a stray
 *  submission. `unknown` (a read failed) is never offered a retire. */
export async function readStraySubmission(documentId: string): Promise<StrayRead> {
  const { data: doc, error: docErr } = await supabase
    .from("documents").select("pending_version_id").eq("id", documentId).maybeSingle();
  if (docErr) return { kind: "unknown", reason: docErr.message };
  const pendingId = (doc as { pending_version_id?: string | null } | null)?.pending_version_id ?? null;
  if (!pendingId) return { kind: "none" };
  const { data: ver, error: verErr } = await supabase
    .from("document_versions")
    .select("id, record_id, review_state, provenance, intake_link_id, created_by, revision_label, superseded_at")
    .eq("id", pendingId).maybeSingle();
  if (verErr) return { kind: "unknown", reason: verErr.message };
  const v = (ver as PendingVersionRow | null) ?? null;
  if (!v || !isDoorShapedSubmission(v)) return { kind: "none" };
  let link: IntakeLinkRow | null = null;
  if (v.intake_link_id) {
    const { data: l, error: linkErr } = await supabase
      .from("project_intake_links").select("id, purpose").eq("id", v.intake_link_id).maybeSingle();
    if (linkErr) return { kind: "unknown", reason: linkErr.message };
    link = (l as IntakeLinkRow | null) ?? null;
  }
  const stray = strayFromRows(v, link);
  return stray ? { kind: "stray", stray } : { kind: "none" };
}

export type StrayRetireOutcome =
  | { ok: true; voidedVersionId: string; recordError: string | null }
  | { ok: false; reason: string };

/** Document Control's standalone retire of a stray pending submission:
 *  re-read (it must still be the stray submission the person was shown),
 *  then lib/revisions.ts voidPendingDraft bound to that draft (P37 fix pass:
 *  a draft filed after the re-read is refused before any write, never voided
 *  in its place), then the record (PENDING_SUBMISSION_RETIRED). Offered to
 *  Document Control only: the Inspector shows it only to a controller and
 *  `actorIsController` (the caller's own role check) refuses anyone else here,
 *  before anything is read. That is a UI gate, not a database one — the
 *  writes underneath are voidPendingDraft's, which the database admits for
 *  anyone with publish authority on the document (the same rights a rev-up
 *  voids a pending draft with); no new database authority is granted. A
 *  refused void writes nothing and says what it left (voidPendingDraft's own
 *  sentence); a record that cannot be written is returned, never swallowed.
 *
 *  P37 final fix pass (the integrator's ruling (3)): the retire is recorded
 *  TWICE — an intent row (PENDING_SUBMISSION_RETIRE_REQUESTED: who, the
 *  version shown, why) BEFORE voidPendingDraft, and the outcome row
 *  (PENDING_SUBMISSION_RETIRED) after it — so a retire interrupted between
 *  the two (a closed tab, a lost connection) still leaves who asked and why.
 *  An intent row that cannot be written stops the retire before the void
 *  (fail closed): nothing is changed and that is said. A void refused after
 *  the intent landed leaves the intent row alone (it says what was asked;
 *  the draft, still pending, says it did not happen). */
export async function retireStrayPendingSubmission(input: {
  orgId: string;
  documentId: string;
  expectedVersionId: string;
  reason: string;
  actorIsController: boolean;
  actorUserId: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
}): Promise<StrayRetireOutcome> {
  if (!input.actorIsController) {
    return { ok: false, reason: "Only Document Control can retire a pending submission no Intake tab lists." };
  }
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: "Give the reason for retiring the submission." };
  const now = await readStraySubmission(input.documentId);
  if (now.kind === "unknown") {
    return { ok: false, reason: `Couldn't confirm the pending submission is still the one shown (${now.reason}) — nothing was changed.` };
  }
  if (now.kind !== "stray" || now.stray.versionId !== input.expectedVersionId) {
    return { ok: false, reason: "The document's pending draft changed since it was shown (it was decided, replaced, or now appears on an Intake tab) — nothing was changed. Reload the document." };
  }
  // P37 final fix pass (ruling (3)): the intent first — who, the version shown and why — so an
  // interrupted retire still leaves its record; no intent row, no void (fail closed)
  const intent = await logAuditAction({
    action: "PENDING_SUBMISSION_RETIRE_REQUESTED",
    resourceId: input.documentId,
    resourceType: "document",
    orgId: input.orgId,
    userId: input.actorUserId ?? "",
    userEmail: input.actorEmail ?? undefined,
    userRole: input.actorRole ?? undefined,
    details: {
      versionId: input.expectedVersionId,
      revisionLabel: now.stray.revisionLabel,
      intakeLinkId: now.stray.intakeLinkId,
      linkPurpose: now.stray.linkPurpose,
      cause: now.stray.cause,
      reason,
      via: "void_pending_draft",
    },
  });
  if (!intent.ok) {
    return { ok: false, reason: `The retire could not be recorded before it ran (${intent.error ?? "the record was refused"}) — nothing was changed. Try again.` };
  }
  let voided: string | null;
  try {
    // P37 fix pass: the void is bound to the draft shown — a submission filed after the re-read
    // above is refused before any write, never voided in its place
    voided = await voidPendingDraft(input.documentId, input.expectedVersionId);
  } catch (e) {
    return { ok: false, reason: (e as Error).message || "The pending submission could not be retired." };
  }
  if (!voided) {
    return { ok: false, reason: "The document no longer had a pending draft when it was retired — nothing was changed. Reload the document." };
  }
  const { error: recordError } = await logAuditAction({
    action: "PENDING_SUBMISSION_RETIRED",
    resourceId: input.documentId,
    resourceType: "document",
    orgId: input.orgId,
    userId: input.actorUserId ?? "",
    userEmail: input.actorEmail ?? undefined,
    userRole: input.actorRole ?? undefined,
    details: {
      versionId: voided,
      shownVersionId: input.expectedVersionId,
      // a draft other than the one shown — only a submission filed in the instant between the
      // re-read and the void could be — is said on the record, never hidden
      sameAsShown: voided === input.expectedVersionId,
      revisionLabel: now.stray.revisionLabel,
      intakeLinkId: now.stray.intakeLinkId,
      linkPurpose: now.stray.linkPurpose,
      cause: now.stray.cause,
      reason,
      via: "void_pending_draft",
    },
  });
  if (voided !== input.expectedVersionId) {
    return { ok: false, reason: `A different pending draft (${voided}) was retired than the one shown — it was filed in the instant between; its record says so. Check the document's history.` };
  }
  return { ok: true, voidedVersionId: voided, recordError };
}
