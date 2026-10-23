import { NextRequest, NextResponse, after } from "next/server";
import { HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { notifyBatchWithReason } from "@/lib/inAppNotifications";
import { WorkflowEngine, ticketResource, decisiveGrants, currentRoster, slotSignPlan, engineeringGateRequired, ISSUING_APPROVALS, ISSUE_MARK_ACTIONS, ISSUE_AS_IS_APPROVALS, issueReadyFor } from "@/lib/workflow";
import { loadCapabilityPolicyStrict, policyAllows } from "@/lib/capabilityPolicy";
import { engineerPickCap, engineerPickRefusal } from "@/lib/ticketPage";
import { effectiveRoutingForTicket, routingForWorkClass, ROSTER_LEDGER_NOT_WRITTEN } from "@/lib/routingControl";
import {
  hashStoredFilesBounded, draftsToHashOnApproval, HASH_LIMITS, filesUnderReview, openRoster, applySignPlan, rosterCompletion, rosterBinding,
  signatureRefusal, writeRosterLedger, writeRosterReopen, isMissingRosterLedger, type FileHash, type SignatureRow,
} from "@/lib/ticketRoster";
import { loadPickerMembers } from "@/lib/ticketPickerMembers";
import { r2, R2_BUCKET } from "@/lib/r2";
import { isSafeStorageKey } from "@/lib/storageKey";
import { ticketFolder, underFolder, restoredFromNumber, restoreRenumberingConfirmed, renumberedRequestListsKey } from "@/lib/ticketFilePrefix";
import { publicOrigin } from "@/lib/publicOrigin";
import { plainMentions, wrapEmailBody } from "@/lib/emailRender";
import {
  computeTransition,
  classifyTransitionNotification,
  rowToTicket,
  escapeHtml,
  draftRevLabel,
  rosterPartialReleased,
  type TransitionInput,
} from "@/lib/ticketTransitions";
import type { Role, TicketAttachment, TicketHistoryEntry, TicketOutcome, TicketReviewRoster, TicketReviewSlot } from "@/types/schema";
import { TICKET_INTENT_TTL_MS } from "@/lib/intents";
import { parseSourceDocument, parseSourceDocuments } from "@/lib/sourceDocRef";
import { reviewClassOptions, resolveReviewClass, withMinorCorrectionClass, minorCorrectionClassOf, hasReviewModelColumns } from "@/lib/reviewModel";
import { unitOptionsFor, resolveUnit, unitListReadFailure } from "@/lib/ticketCreate";
import { heldRoles } from "@/lib/roleHeld";
import { noteDeliverableNotInRegister, noteDeliverableNotInLibrary, noteDeliverableNotInAnyRegister, deliverableStateOf, latestFinalAttachment } from "@/lib/ticketHandback";
import { resolveTicketRecipients, isRoutedStatus } from "@/lib/ticketRouting";
import { isTicketOutcome, outcomesFor, OUTCOME_LABEL } from "@/lib/ticketOutcome";
import { parseOutcomeReasons, checkOutcomeReason, checkBareOutcome, type OutcomeReason } from "@/lib/ticketOutcomeReasons";
import { ticketStatusLabel } from "@/lib/ticketStatusLabels";
import { planConsentWindow, CONSENT_REASON, issueAsIsMarkOf, isUnconfirmedConsentPlan } from "@/lib/consentWindow";
import { afterRosterOpened, recordNoticeEvents, recordNotEmailed, emailPreferenceOf } from "@/lib/consentWindowScan";
// GAP-109 mechanism 2 (drafting-flow DF-P22): standing pre-authorization.
import { preauthEligibleSlots } from "@/lib/ticketPreauthorization";
import { applyStandingPreauthorizations } from "@/lib/ticketPreauthorizationApply";
import { slaNoticeSurvivesTransition } from "@/lib/ticketSla";
import { examinationForAct, examinationAuditFields, type ExaminationOnAct } from "@/lib/assuranceExamination";
// GAP-102 acceptance 4 (drafting-flow DF-P24): the examination-scope issue gate.
import { issueScopeGate } from "@/lib/examinationScopeGate";
import { workflowEngineContext, rosterlessRoutedRefusal, draftingTypeFlags, DECLARATION_DECIDES } from "@/lib/workflowAuthority";
// GAP-116 (drafting-flow DF-P26): a notify-only hold that stops the request.
import { issueHoldStopGate, carryNotifyHoldMark } from "@/lib/requestHoldStop";
// GAP-102 acceptance 2 (drafting-flow DF-P26): the issue notice carries the examination data.
import { issueExaminationNote, issueExaminationMayExist } from "@/lib/issueNoticeExamination";
// GAP-115 / GAP-109 mechanism 3 (drafting-flow DF-P26): exception-only review.
import {
  rosterHasExceptionOnlySlot, exceptionRuleAtOpen, ruleSatisfiedSlots, exceptionsOnRecord, reopenRuleSatisfied, readWaiverOnRecord, readSourceMoved,
  ruleOpenNote, ruleReopenNote, EXCEPTION_RULE_ACTOR,
} from "@/lib/exceptionOnlyReview";
import { ticketReadScope } from "@/lib/ticketReadScope";
import { offerableLibraries, libraryLabelForTicket, libraryChoiceFromRow, LIBRARY_CHOICE_COLUMNS, UNNAMED_TARGET_LIBRARY } from "@/lib/ticketLibrary";
import { LIBRARY_RUNG_COLUMNS } from "@/lib/libraryAccess";
import type { Principal } from "@/lib/permissions";

// POST /api/tickets/workflow-action
//
// SERVER-SIDE workflow enforcement. The client sends only its inputs (action
// name + comment/picks/uploads); this route:
//   1. authenticates the caller (bearer token)
//   2. verifies active org membership and reads their role
//   3. validates the action against WorkflowEngine.getActions — the same
//      state machine the UI renders, now enforced where the client can't lie
//   4. recomputes the full update server-side (lib/ticketTransitions)
//   5. writes the audit row FIRST (EVID-12 / SM-7: a row that cannot be
//      written refuses the transition, nothing applied)
//   6. applies it compare-and-set on status (concurrent transitions -> 409,
//      recorded against the audit row as not applied)
//   7. fans out notifications + emails server-side, so neither can be
//      skipped by a closed tab or a tampered client.

interface Body {
  ticketId: string;
  actionType: string;
  comment?: string | null;
  preFilledComment?: string | null;
  category?: string | null;
  isReassigning?: boolean;
  assignment?: { id: string; name: string } | null;
  engineer?: { id: string; name: string; email: string } | null;
  redlineAttachment?: TicketAttachment | null;
  finalAttachment?: TicketAttachment | null;
  /** WF-9: the file an `attach_file` action adds. The bytes are already in
   *  storage (client upload); the ticket row's attachments + history write
   *  is what this route applies compare-and-set. */
  attachment?: TicketAttachment | null;
  /** LIFE-6 / DEC-25: how the closer addressed the hold(s) this ticket
   *  opened — release them now, or keep them with a stated reason. Absent
   *  when a close would leave one open, the close is refused (409 holds_open). */
  holdResolution?: { action: "release" | "keep"; reason?: string | null } | null;
  /** LEAK-9 / GAP-107 (DF-P3): how the request ended, for close_ticket /
   *  close_rfi / cancel_request — one of lib/ticketOutcome.ts's vocabulary. */
  outcome?: string | null;
  /** GAP-13 / GAP-107 acceptance 1 (DF-P14): one of the workspace's own
   *  reasons for ending a request (lib/ticketOutcomeReasons.ts — the drafting
   *  configuration's `outcomeReasons`), sent beside `outcome`, its category.
   *  Needed only where the workspace keeps reasons under that category (fix
   *  pass): a bare category with none of its own is accepted as before. */
  outcomeReason?: string | null;
  /** DCW-1 / GAP-105 (DF-P4): the library triage records with `assign` /
   *  `request_eng_review` at PENDING_ASSIGNMENT — a library of the ticket's
   *  org that the caller may discover (the picker's rule). Never required. */
  libraryId?: string | null;
  /** DCW-7 / FRIC-3 (DF-P4): the unit triage records with the same actions,
   *  resolved against the org's unit list (lib/ticketCreate.ts
   *  unitOptionsFor). Never required. */
  unit?: string | null;
  /** GAP-103 / EVID-12 (DF-P5): `sign_slot` — the e-signature the roster
   *  panel minted at /api/signatures/sign against this ticket, bound to the
   *  roster's content hash. */
  signatureId?: string | null;
  /** FRIC-5 (DF-P5): `submit_draft` — issue the draft as the final package
   *  when it is approved (the drafter's opt-in; default off). */
  issueReady?: boolean | null;
  /** FRIC-5 (DF-P5 fix pass 3): an approval of a draft the drafter marked
   *  issue-as-is carries the approver's confirmation (the page's confirm
   *  dialog); without it the route refuses (409), nothing written. */
  issueAsIsAcknowledged?: boolean | null;
  /** TIER-8 / EVID-12 (DF-P5 fix pass 3): `sign_slot` — check the sign-off is
   *  open to the caller and answer, writing nothing and needing no
   *  signature, so the panel asks for an e-signature only for a sign-off
   *  the route would take. */
  dryRun?: boolean | null;
  /** GAP-101 / TIER-4 (DF-P6): the work class / code class triage records
   *  with `assign`, `request_eng_review` or `flag_engineering` at
   *  PENDING_ASSIGNMENT — values of the workspace's own lists. Never
   *  required. */
  workClass?: string | null;
  codeClass?: string | null;
  /** HAND-7 done-when 3 (DF-P6): the approver acknowledged that the
   *  request's source has moved since it was raised. `false` = a client that
   *  knows about the move and did not acknowledge it (refused, 409);
   *  absent = a page that does not ask yet (applied, recorded as not
   *  acknowledged). */
  sourceDriftAcknowledged?: boolean | null;
  /** GAP-102 (DF-P20): what an assurance reviewer examined, with
   *  `sign_slot` (its dry run too) or `request_revision` — the files under
   *  review they examined (attachment ids / storage keys; absent = all) and
   *  their note (a revision request's falls back to its comment). Read only
   *  when the caller acts on an assurance slot (lib/assuranceExamination.ts);
   *  ignored otherwise. */
  examination?: { files?: string[] | null; note?: string | null } | null;
}

/** DCW-4 / HAND-3: the shape of a register row id (document_versions.id,
 *  documents.id). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GAP-8 (DF-P4 fix passes 3-4): the intent bridge's slice — one `.in()` read,
 *  one upsert and one delete per leg per slice. An `in` list travels in the
 *  URL: the create route's SOURCE_READ_CHUNK, inside the 6,000-char budget;
 *  a MAX_SOURCE_DOCUMENTS (200) ticket is two slices, any list is bounded. */
const INTENT_BRIDGE_CHUNK = 100;

/** EVID-12: the actions that approve a submitted draft — their audit row
 *  names the drafts the approval was given on. */
const APPROVING_ACTIONS: ReadonlySet<string> = new Set(["approve_draft_ifc", "engineer_approve_final", "approve_minor_correction", "override_engineer_final"]);

/** DF-P6 fix pass 4 (review, minor 3): DECLARATION_DECIDES — the actions a
 *  like-in-kind declaration decides — lives in lib/workflowAuthority.ts
 *  (DF-P24 merge-time fix pass: shared with the waiver authority). */

/** SM-12: a member's name as the app shows it — display name, else the
 *  local part of their email; null when the membership row carries neither. */
function memberName(m: { display_name?: unknown; email?: unknown } | null | undefined): string | null {
  const display = typeof m?.display_name === "string" ? m.display_name.trim() : "";
  if (display) return display;
  const email = typeof m?.email === "string" ? m.email.trim() : "";
  return email ? email.split("@")[0] : null;
}

/** SM-12: the label a drafter is shown under when neither the membership row
 *  nor the account names them. It is never the client's string. */
const UNNAMED_MEMBER = "Unnamed member";

/** SM-12: the local part of the account's sign-in email (service role), or
 *  null when the account cannot be read or carries no email. */
async function accountName(uid: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(uid);
    const email = !error && typeof data?.user?.email === "string" ? data.user.email.trim() : "";
    return email ? email.split("@")[0] : null;
  } catch {
    return null;
  }
}

/** EVID-12: what an audit row records of a file — enough to match the
 *  approval to the object in storage. `etag` is the storage entity tag the
 *  route read when it vetted the file (null for one already on the ticket);
 *  it is the store's tag, not a content hash this route computed. */
function fileIdentity(a: TicketAttachment, etag: string | null | undefined) {
  return { id: a.id ?? null, name: a.name ?? null, url: a.url ?? null, size: a.size ?? null, etag: etag ?? null };
}

/** EVID-12 (DF-P5): sha256 of stored ticket files, computed here from their
 *  bytes (lib/ticketRoster.ts hashStoredFilesBounded over R2) under ONE
 *  overall deadline and byte budget — a slow or hung storage read is
 *  abandoned (and aborted) when the clock runs out, never waited on. */
function hashStoredFiles(keys: string[], limits: { deadlineMs: number; byteBudget: number }): Promise<Map<string, FileHash>> {
  return hashStoredFilesBounded(keys, async (k, signal) => (await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: k }), { abortSignal: signal })) as never, limits);
}

/** EVID-12 (DF-P5): a file's identity with the content hash computed here. */
function hashedIdentity(a: TicketAttachment, etag: string | null | undefined, h: FileHash | undefined) {
  return { ...fileIdentity(a, etag), sha256: h?.ok ? h.sha256 : null, ...(h && !h.ok ? { sha256Unavailable: h.reason } : {}) };
}

/** EVID-12 / SM-7 (DF-P1): one audit row, written with the fixed id it
 *  carries, so a retry after a lost reply finds it there (23505, the primary
 *  key) instead of writing it twice. Retried once. null when the row is in
 *  the table; otherwise the error. */
async function insertAuditRowOnce(row: { id: string } & Record<string, unknown>): Promise<string | null> {
  const attempt = async (): Promise<string | null> => {
    try {
      const { error } = await supabaseAdmin.from("audit_logs").insert(row);
      if (!error || (error as { code?: string }).code === "23505") return null;
      return error.message || "insert refused";
    } catch (e) {
      return (e as Error)?.message ?? String(e);
    }
  };
  return (await attempt()) && (await attempt());
}

/** TIER-8 / EVID-12 (DF-P5 fix pass 3): a `sign_slot` refused AFTER the
 *  panel minted its e-signature leaves that signature attesting a review
 *  that satisfied nothing. The refusal is recorded beside it —
 *  TICKET_SIGN_SLOT_NOT_APPLIED naming the signature and the reason, with no
 *  attempt row (nothing was attempted: `details.attempt` is null, so the
 *  trail's attempt pairing leaves it alone) — so the orphan is explained.
 *  DF-P5 fix pass 4: only the CALLER'S OWN signature on THIS ticket in THIS
 *  org is recorded (read from e_signatures, or the row the route already
 *  read) — an id the client sent that is someone else's, another ticket's,
 *  another org's, or not a signature at all writes nothing, so no row can
 *  call another person's signature "not applied".
 *  Best-effort: a failed read or write is logged, never the caller's problem. */
async function recordRefusedSignOff(p: {
  signatureId: unknown; ticketId: string; orgId: string; caller: { id: string; email: string; role: string };
  status: number; reason: string; code?: string; rosterId?: string | null;
  /** the e_signatures row the route already read for this id, if any */
  signature?: SignatureRow | null;
}): Promise<void> {
  const sigId = typeof p.signatureId === "string" ? p.signatureId.trim() : "";
  if (!UUID_RE.test(sigId)) return;
  let sig = p.signature !== undefined && p.signature !== null && (p.signature as { id?: unknown }).id === sigId ? p.signature : null;
  if (!sig) {
    const { data, error } = await supabaseAdmin
      .from("e_signatures").select("id, org_id, resource_type, resource_id, signer_user_id")
      .eq("id", sigId).maybeSingle();
    if (error) {
      console.error(`[workflow-action] could not read signature ${sigId} for the refused sign-off on ticket ${p.ticketId}: ${error.message}`);
      return;
    }
    sig = data as SignatureRow | null;
  }
  const own = !!sig && sig.signer_user_id === p.caller.id && sig.resource_type === "ticket"
    && sig.resource_id === p.ticketId && sig.org_id === p.orgId;
  if (!own) return;
  const err = await insertAuditRowOnce({
    id: crypto.randomUUID(), action: "TICKET_SIGN_SLOT_NOT_APPLIED", resource_id: p.ticketId, resource_type: "ticket",
    org_id: p.orgId, user_id: p.caller.id, user_email: p.caller.email, user_role: p.caller.role,
    details: { attempt: null, signatureId: sigId, refusedBeforeApply: true, status: p.status, reason: p.reason, ...(p.code ? { code: p.code } : {}), rosterId: p.rosterId ?? null },
  });
  if (err) console.error(`[workflow-action] could not record the refused sign-off's signature ${sigId} on ticket ${p.ticketId}: ${err}`);
}

function formatBytes(n: number | undefined): string | undefined {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * AUTHZ-11 / SM-13: a file record a client asks this route to append to the
 * ticket. Refused unless its key lies under the ticket's own prefix
 * (`orgs/<org>/tickets/<ticket number>/`, what uploadTicketAttachment mints)
 * and is a plain key, the slot's type rule holds (an issued package is typed
 * Final; a redline is a Reference; an attached file one of the four types),
 * and the object is in storage — or already listed on the ticket. Who
 * uploaded it, when, its size (from storage when it answers), its status and
 * its id (SM-15: a server-minted UUID) are stamped here; the client's claims
 * about them are not kept.
 *
 * drafting-flow EDGE-19 (DF-P17, DEC-90): a request the restore brought back
 * under a fresh number keeps its files under its ORIGINAL number's folder
 * (never moved). A file this ticket already LISTS there is admitted when the
 * restore's own history line names that number and the restore's audit row
 * confirms it (lib/ticketFilePrefix.ts); nothing else under that folder is.
 * The other side: an unlisted key under this ticket's own folder that a
 * request renumbered away from this number lists is that request's file, not
 * this one's — refused. That check reads tickets once per UNLISTED
 * attachment on every request, renumbered or not; it refuses only when the
 * read SUCCEEDS and finds such a request. When the read fails (or is
 * truncated) the file gets today's answer — the storage HEAD below, exactly
 * as before — and `siblingUnchecked` is returned so the action's audit row
 * says the check did not run (DEC-90, the DF-P17 final fix pass: a
 * never-renumbered request's upload never fails or differs because of it).
 * A request with no restore line makes no audit read.
 */
async function vetTicketAttachment(
  a: TicketAttachment,
  ctx: {
    slot: "attachment" | "finalAttachment" | "redlineAttachment";
    orgId: string;
    ticketNumber: string;
    listed: TicketAttachment[];
    uploadedBy: string;
    /** EDGE-19 (DF-P17): the ticket's row id and history — the restore's
     *  renumbering line is read from it. */
    ticketRowId: string;
    history: unknown;
  },
): Promise<{ ok: true; attachment: TicketAttachment; etag: string | null; siblingUnchecked: boolean } | { ok: false; status: number; error: string }> {
  const url = typeof a?.url === "string" ? a.url : "";
  const name = typeof a?.name === "string" ? a.name.trim().slice(0, 255) : "";
  const prefix = ticketFolder(ctx.orgId, ctx.ticketNumber);
  const underOwn = underFolder(url, prefix);
  // EDGE-19: a LISTED file under the original number's folder of a request
  // the restore renumbered, the number confirmed by the restore's audit row.
  let underOriginal = false;
  if (url && name && ctx.ticketNumber && isSafeStorageKey(url) && !underOwn && ctx.listed.some((x) => x?.url === url)) {
    const from = restoredFromNumber({ ticketNumber: ctx.ticketNumber, history: ctx.history });
    if (from && underFolder(url, ticketFolder(ctx.orgId, from))) {
      const confirmed = await restoreRenumberingConfirmed(supabaseAdmin, { orgId: ctx.orgId, ticketRowId: ctx.ticketRowId, from, to: ctx.ticketNumber });
      if (confirmed === "unknown") return { ok: false, status: 503, error: "Couldn't confirm where this request's files are stored — try again in a moment" };
      underOriginal = confirmed;
    }
  }
  if (!url || !name || !ctx.ticketNumber || !isSafeStorageKey(url) || !(underOwn || underOriginal)) {
    return { ok: false, status: 400, error: "That file is not stored under this request — upload it to the request and try again" };
  }
  const type = String(a.type ?? "");
  if (ctx.slot === "finalAttachment" && type !== "Final") {
    return { ok: false, status: 400, error: "Issuing the final IFC package requires a file typed Final" };
  }
  if (ctx.slot === "redlineAttachment" && type !== "Reference") {
    return { ok: false, status: 400, error: "A redline is attached as a Reference file" };
  }
  if (!["Source", "Reference", "Draft", "Final"].includes(type)) {
    return { ok: false, status: 400, error: "Attaching a file requires its name, type and storage URL" };
  }
  const alreadyListed = ctx.listed.find((x) => x?.url === url) ?? null;
  let size: string | undefined = alreadyListed?.size ?? undefined;
  let etag: string | null = null;
  let siblingUnchecked = false;
  if (!alreadyListed) {
    // EDGE-19 done-when 3: the folder may also hold the files of a request
    // the restore renumbered away from this number — never this ticket's.
    // Refused only on a read that SUCCEEDS and finds one; a failed or
    // truncated read gives today's answer (the HEAD below) and is recorded.
    const elsewhere = await renumberedRequestListsKey(supabaseAdmin, { orgId: ctx.orgId, number: ctx.ticketNumber, key: url });
    if (elsewhere === "unknown") {
      siblingUnchecked = true;
      console.warn(`[workflow-action] the renumbered-request check for ${url} could not run; today's answer given and recorded on the audit row`);
    } else if (elsewhere) {
      return { ok: false, status: 400, error: "That file belongs to another request (one restored under a new number from this request's number) — upload it to this request and try again" };
    }
    try {
      const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: url }));
      size = formatBytes((head as { ContentLength?: number }).ContentLength) ?? size;
      etag = typeof (head as { ETag?: unknown }).ETag === "string" ? ((head as { ETag: string }).ETag).replace(/"/g, "") : null;
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
        return { ok: false, status: 400, error: "That file is not in storage — upload it again and retry" };
      }
      console.error(`[workflow-action] could not verify ${url} in storage:`, e);
      return { ok: false, status: 503, error: "The file could not be verified in storage right now — try again in a moment" };
    }
  }
  const status: TicketAttachment["status"] =
    ctx.slot === "attachment" ? (type === "Source" ? "submitted" : "staged") : "submitted";
  // SM-15 (DF-P15): the entry this route appends is a NEW attachment, so its
  // id is minted here, always — never the client's. A client id equal to a
  // file already on the ticket (the current Final's, say) made that id appear
  // twice, and every `?a=` print of the real file then scanned "cannot
  // confirm" and the server copy route refused it. Every attachment already
  // on the ticket keeps its id; nothing here rewrites one.
  const attachment = {
    ...a,
    id: crypto.randomUUID(),
    name,
    url,
    type,
    status,
    size: size ?? a.size,
    uploadedBy: alreadyListed?.uploadedBy ?? ctx.uploadedBy,
    uploadedAt: alreadyListed?.uploadedAt ?? new Date().toISOString(),
  } as TicketAttachment;
  return { ok: true, attachment, etag, siblingUnchecked };
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.ticketId || !body.actionType) {
    return NextResponse.json({ error: "ticketId and actionType are required" }, { status: 400 });
  }
  // DF-P23 (the DF-P20 follow-up (d), DEC-31): a comment that is not text is
  // the caller's error — 400, nothing read or written — never the 500 a
  // `body.comment?.trim()` TypeError gave. Absent and null keep today's
  // meaning (no comment).
  if (body.comment !== undefined && body.comment !== null && typeof body.comment !== "string") {
    return NextResponse.json({ error: "comment must be text" }, { status: 400 });
  }

  // Load the ticket (service role — RLS doesn't apply; we enforce explicitly).
  const { data: row, error: loadErr } = await supabaseAdmin
    .from("tickets")
    .select("*")
    .eq("id", body.ticketId)
    .maybeSingle();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  if ((row as { archived_at?: string | null }).archived_at) {
    return NextResponse.json(
      { error: "This ticket is archived; restore it from its archive before acting on it." },
      { status: 409 },
    );
  }
  const ticket = rowToTicket(row as Record<string, unknown>);

  // Active membership in the ticket's org + the caller's role.
  const { data: member } = await supabaseAdmin
    .from("org_members")
    .select("role, roles, email, display_name")
    .eq("org_id", ticket.orgId)
    .eq("uid", caller.id)
    .eq("status", "active")
    .maybeSingle();
  if (!member) {
    return NextResponse.json({ error: "Forbidden: not an active member of this workspace" }, { status: 403 });
  }
  // AUTHZ-13 (DEC-89): every action writes the ticket row, and the
  // transition adds its actor to `watchers` (lib/ticketTransitions.ts), which
  // is one of the Contractor-only read scope's legs. So a Contractor-only
  // member may act only on a ticket they can already read. Any other ticket
  // answers as an unreadable one does (404, naming neither its status nor the
  // actions on it), and nothing is written. This route runs as the service
  // role and cannot ask the database for auth.uid(); lib/ticketReadScope.ts
  // holds the same predicate as 20261166.
  const scope = await ticketReadScope(supabaseAdmin, member, caller.id, {
    id: body.ticketId, requesterId: ticket.requesterId, assignedDrafterId: ticket.assignedDrafterId,
    assignedEngineerId: ticket.assignedEngineerId, watchers: ticket.watchers,
  });
  if (scope === "unknown") {
    return NextResponse.json({ error: "Couldn't confirm you can see this request — try again in a moment" }, { status: 503 });
  }
  if (scope === "out") return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  const callerRole = (member.role as Role) ?? "Viewer";
  const callerEmail = (member.email as string | null) || caller.email || "Unknown";
  // WF-7: authority is evaluated against the FULL additive collection —
  // the headline alone SUBTRACTED authority from multi-role people.
  const callerRoles: Role[] = Array.isArray(member.roles) && (member.roles as Role[]).length > 0
    ? (member.roles as Role[])
    : [callerRole];

  // GAP-2/DEC-12: the independence predicates bind at >= 3 active members.
  // DF-P6 fix pass 2 (review, major 2): the count is CHECKED. It decides
  // who may approve (the producer-is-checker block) and whether an engineer
  // can be picked for the requester's override (lib/workflow.ts — fix pass
  // 4 no longer refuses that override by size, DEC-90 ruling (3)), so a
  // failed read never reads as "a small org": an issuing approval or an
  // override is refused (503, nothing written); any other action is
  // evaluated with separation of duties ACTIVE (fail closed) and its audit
  // row says the count was not checked.
  const { count: memberCountRead, error: memberCountErr } = await supabaseAdmin
    .from("org_members")
    .select("uid", { count: "exact", head: true })
    .eq("org_id", ticket.orgId)
    .eq("status", "active");
  const memberCountUnchecked = !!memberCountErr;
  if (memberCountUnchecked && ISSUING_APPROVALS.has(body.actionType)) {
    console.error(`[workflow-action] active member count unreadable for org ${ticket.orgId}: ${memberCountErr?.message ?? "unknown"}`);
    return NextResponse.json(
      { error: "This workspace's members could not be counted, so the approval was not applied (it decides who may approve or override). Try again in a moment.", code: "member_count_unreadable" },
      { status: 503 },
    );
  }
  const activeMemberCount = memberCountUnchecked ? Math.max(memberCountRead ?? 0, 3) : (memberCountRead ?? 0);
  const sodActive = activeMemberCount >= 3;

  // WF-15: close-without-review is a property of the CONFIGURED type.
  let closeWithoutReviewTypes: string[] = ["RFI"];
  let engineeringFirstTypes: string[] = [];
  // GAP-101 / TIER-4 (DF-P6): the same row carries the work / code class
  // lists (seeded empty). null when it could not be read.
  let draftingCfg: Record<string, unknown> | null = null;
  let draftingCfgRead = false;
  // GAP-115 (DF-P26 fix pass 4; DEC-90 ruling (1)): whether the
  // engineering-first types above are the workspace's own — the row read AND
  // its request types parsed. When not, "engineered" is unknown, and the
  // exception-only rule treats it as unchecked (limb 1 applies nothing; limb
  // 2 refuses a completing sign-off), as the consent close does
  // (lib/consentWindowScan.ts engineeredLaneNow). Nothing else reads it.
  let engineeringFirstKnown = false;
  // DF-P24 merge-time fix pass 2: the examination-scope gate's copy of the
  // row, taken BEFORE the request-type flags are computed — a malformed
  // `requestTypes` (which makes that reading throw) no longer hides the
  // workspace's examination-data requirements from the gate (the consent
  // close reads the row the same way). Every other reader keeps
  // `draftingCfg` exactly as before.
  let scopeDraftingCfg: Record<string, unknown> | null = null;
  try {
    const { data: cfgRow, error: cfgRowErr } = await supabaseAdmin
      .from("org_configurations")
      .select("data")
      .eq("org_id", ticket.orgId)
      .eq("key", "drafting")
      .maybeSingle();
    if (!cfgRowErr) draftingCfgRead = true;
    scopeDraftingCfg = (cfgRow?.data as Record<string, unknown> | null) ?? null;
    // DRAFT-2: "engineering first" is the same kind of type property.
    // (lib/workflowAuthority.ts draftingTypeFlags — shared with the waiver
    // authority, DF-P24 merge-time fix pass; it throws where this reading
    // always threw, so the defaults stand exactly as before.)
    ({ closeWithoutReviewTypes, engineeringFirstTypes } = draftingTypeFlags(cfgRow?.data));
    engineeringFirstKnown = draftingCfgRead;
    draftingCfg = (cfgRow?.data as Record<string, unknown> | null) ?? null;
  } catch { /* default stands */ }

  // THE enforcement: the action must be one the state machine offers this
  // caller at the ticket's current status — evaluated with the ORG'S OWN
  // capability policy, so admin-configured authority is enforced here, not
  // just drawn in the UI.
  // WF-10: the version stamp names, in the audit row, which policy this
  // decision was made under.
  // AUTHZ-7: the read is STRICT and fresh — a failed read is a refusal, never
  // the shipped defaults (which are the WIDE end of every capability an org
  // narrows). "Nothing stored" is still the defaults: that is the org's policy.
  const loadedPolicy = await loadCapabilityPolicyStrict(ticket.orgId, supabaseAdmin);
  if (!loadedPolicy.ok) {
    console.error(`[workflow-action] capability policy unreadable for org ${ticket.orgId}: ${loadedPolicy.error}`);
    return NextResponse.json(
      { error: "This workspace's permission policy could not be read, so the action was not applied. Try again in a moment.", code: "policy_unreadable" },
      { status: 503 },
    );
  }
  const capPolicy = loadedPolicy.policy;
  const policyVersion = loadedPolicy.version;
  // DEC-16 (the requester's current roles), DF-P6 fix passes (the
  // like-in-kind declaration's signature — a read that fails answers 503 for
  // every action the declaration decides; the requester's engineer pick) and
  // HAND-7 done-when 3 / DF-P18 (the source documents' drift, read for an
  // issuing approval or a sign-off only, BEFORE getActions so the actions
  // carry `requiresSourceDriftAck`): the engine's context — DF-P24
  // merge-time fix pass: built by ONE shared helper
  // (lib/workflowAuthority.ts workflowEngineContext, moved here verbatim:
  // the same reads in the same order) that /api/tickets/examination-scope's
  // waiver authority also uses, so the two always agree on who may issue.
  const builtCtx = await workflowEngineContext(supabaseAdmin, {
    ticket, ticketId: body.ticketId, callerId: caller.id, callerRole, callerRoles, capPolicy,
    activeMemberCount, sodActive, engineeringFirstTypes, closeWithoutReviewTypes,
    declarationDecides: DECLARATION_DECIDES.has(body.actionType),
    readSourceDrift: ISSUING_APPROVALS.has(body.actionType) || body.actionType === "sign_slot",
  });
  if (builtCtx.kind === "declaration_unreadable") {
    console.error(`[workflow-action] declaration signature unreadable for ticket ${body.ticketId}`);
    return NextResponse.json(
      { error: "This request's like-in-kind declaration could not be checked, so the action was not applied (the declaration decides whether an engineer must sign). Try again in a moment.", code: "declaration_unreadable" },
      { status: 503 },
    );
  }
  const { engineCtx, requesterRoles, declarationUnverified, driftLabels, sourceDriftUnchecked } = builtCtx;
  const allowed = WorkflowEngine.getActions(ticket, callerRole, caller.id, capPolicy, engineCtx);
  // TIER-7 (DF-P18): on a request of a work class the workspace flags
  // "minor correction", the minor-correction approval names its class (the
  // page applies the same note) — nothing else changes, and nothing at all
  // for any other request (DEC-90 ruling (3) for DF-P18: the same array).
  const offeredActions = withMinorCorrectionClass(allowed, draftingCfg, ticket.workClass);
  // DEC-13 stage 2: the resource this ticket presents to the policy — the
  // same fields getActions just evaluated with.
  const resource = ticketResource(ticket);
  const action = offeredActions.find((a) => a.action === body.actionType);
  if (!action) {
    const notAvailable = `Action "${body.actionType}" is not available to you at status “${ticketStatusLabel(ticket.status)}”`;
    // DF-P5 fix pass 3: a sign-off whose roster closed under it (another
    // reviewer completed it first) still names the signature it minted.
    if (body.actionType === "sign_slot" && body.dryRun !== true) {
      await recordRefusedSignOff({ signatureId: body.signatureId, ticketId: body.ticketId, orgId: ticket.orgId, caller: { id: caller.id, email: callerEmail, role: callerRole }, status: 403, reason: notAvailable });
    }
    return NextResponse.json({ error: notAvailable }, { status: 403 });
  }
  // A dry run is a sign-off's question only — never an action applied by a
  // client that believed it was asking.
  if (body.dryRun === true && action.action !== "sign_slot") {
    return NextResponse.json({ error: "Only a sign-off can be checked without applying it." }, { status: 400 });
  }
  // GAP-2: a separation-of-duties block is rendered disabled in the UI and
  // REFUSED here — the reason travels with it.
  if (action.disabledReason) {
    return NextResponse.json({ error: action.disabledReason }, { status: 403 });
  }
  // TIER-5 (DF-P5 fix pass 3): a ticket in a routed library that is in
  // review WITHOUT a roster — reopened (reopen_ticket goes straight back to
  // PENDING_REVIEW, and only a submission opens a roster), or already in
  // review when the table was declared — is never approved on the serial
  // path: that would issue without every slot the routing table names
  // (DEC-36: fail closed). Refused before anything is written; the way
  // forward is a revision, whose resubmission opens the roster. Read only
  // for these approvals on such a ticket; a read that fails is a 503.
  // (lib/workflowAuthority.ts rosterlessRoutedRefusal — shared with the
  // waiver authority, DF-P24 merge-time fix pass.)
  const routedRefusal = await rosterlessRoutedRefusal(supabaseAdmin, ticket, body.ticketId, action.action);
  if (routedRefusal) return NextResponse.json({ error: routedRefusal.error, code: routedRefusal.code }, { status: routedRefusal.status });
  // FRIC-5 (DF-P5 fix pass 3): an approval that would issue the draft AS-IS
  // (the drafter's mark) is taken only from an approver who confirmed it —
  // the mark may have been made after their page loaded, and the confirm is
  // the page's. Without the acknowledgement: 409, nothing written.
  if (ISSUE_AS_IS_APPROVALS.has(action.action) && issueReadyFor(ticket) && body.issueAsIsAcknowledged !== true) {
    return NextResponse.json({
      error: "The drafter marked this draft issue-as-is — approving it now issues the draft as the final package. Reload the request and confirm.",
      code: "issue_as_is_unconfirmed",
    }, { status: 409 });
  }
  // WF-16: WHY is this action permitted? When a personal grant is what admits
  // the caller (the state machine would not offer the action without it),
  // the audit row names the grant — role authority and delegation are
  // otherwise indistinguishable in the log. Identity relations ride along
  // as fact; grants are unscoped (WF-13 row 6), so no resource is named.
  const usedGrants = decisiveGrants(ticket, callerRole, caller.id, capPolicy, engineCtx, action.action);
  const identity = [
    ticket.requesterId === caller.id ? "requester" : null,
    ticket.assignedDrafterId === caller.id ? "drafter" : null,
    ticket.assignedEngineerId === caller.id ? "engineer" : null,
  ].filter((x): x is string => !!x);
  const authority = {
    // SM-3 (DF-P6, DEC-90 ruling (3)): a management override of the
    // engineering sign-off is named as one in the attempt row.
    // Fix pass 4 (review, major 2 — DEC-90 ruling (3)): the requester's own
    // override is named as one (identity carries "requester"; the comment,
    // required for it, is the why).
    ...(action.engineeringOverride ? { override: { of: "engineering_sign_off", reason: `The request requires engineering review and the actor holds no Engineer role and does not occupy the engineer's place.${ticket.requesterId === caller.id ? " The actor is the request's requester (a self-override, with the actor's comment)." : ""}` } } : {}),
    via: usedGrants.length > 0 ? "grant" : "role",
    ...(usedGrants.length > 0 ? { grants: usedGrants.map((g) => ({ cap: g.cap, expiresAt: g.expiresAt ?? null, grantedBy: g.grantedBy ?? null, grantedAt: g.grantedAt ?? null, note: g.note ?? null })) } : {}),
    ...(identity.length > 0 ? { identity } : {}),
    roles: callerRoles,
    policyVersion,
  };
  if (action.requiresComment && !body.comment?.trim()) {
    return NextResponse.json({ error: "This action requires a comment" }, { status: 400 });
  }
  if (action.requiresEngineerPick && !body.engineer?.id) {
    return NextResponse.json({ error: "This action requires picking an engineer" }, { status: 400 });
  }
  // WF-6: the file precondition is enforced HERE, not only in the browser —
  // a direct POST could previously mint a "Final package issued" ticket with
  // no deliverable at all.
  if (action.requiresFile && action.action === "submit_final" && !body.finalAttachment?.url) {
    return NextResponse.json({ error: "Issuing the final IFC package requires the deliverable file" }, { status: 400 });
  }
  // WF-22: a transition that requires an input is refused when it is missing —
  // an assignment-less "assign" used to no-op while still writing a success
  // audit row.
  if ((action.action === "assign" || action.action === "reassign_drafter") && !body.assignment?.id) {
    return NextResponse.json({ error: "Assigning requires picking a drafter" }, { status: 400 });
  }
  // WF-18: reassigning to the current drafter is a no-op that would still
  // write an audit row and a notification — refuse it.
  if (action.action === "reassign_drafter" && body.assignment?.id === ticket.assignedDrafterId) {
    return NextResponse.json({ error: "That drafter is already assigned to this request" }, { status: 400 });
  }
  // WF-9: attaching a file requires the file record — name, type and the
  // storage URL the client's upload returned.
  const ATTACHMENT_TYPES = ["Source", "Reference", "Draft", "Final"];
  if (action.action === "attach_file") {
    const a = body.attachment;
    if (!a?.url || !a.name || !ATTACHMENT_TYPES.includes(String(a.type))) {
      return NextResponse.json({ error: "Attaching a file requires its name, type and storage URL" }, { status: 400 });
    }
  }
  // AUTHZ-11 / SM-13: every file record this action appends is VETTED, not
  // trusted — its key lies under this ticket's own prefix (the one
  // uploadTicketAttachment mints: orgs/<org>/tickets/<ticket number>/), the
  // object is in storage (or already listed on the ticket), a Final is typed
  // Final, and who uploaded it, when, its size and status are stamped here.
  const vetted: { attachment?: TicketAttachment; finalAttachment?: TicketAttachment; redlineAttachment?: TicketAttachment } = {};
  const vettedEtags: Record<string, string | null> = {};
  // EDGE-19 (DF-P17 final fix pass): the renumbered-request check could not
  // run for a vetted file — recorded on this action's audit row.
  let renumberedSiblingUnchecked = false;
  const toVet: Array<["attachment" | "finalAttachment" | "redlineAttachment", TicketAttachment | null | undefined]> = [
    ["attachment", action.action === "attach_file" ? body.attachment : undefined],
    ["finalAttachment", action.action === "submit_final" ? body.finalAttachment : undefined],
    ["redlineAttachment", body.redlineAttachment],
  ];
  for (const [slot, a] of toVet) {
    if (!a) continue;
    const res = await vetTicketAttachment(a, {
      slot, orgId: ticket.orgId, ticketNumber: ticket.ticketId, listed: ticket.attachments ?? [],
      uploadedBy: callerEmail, ticketRowId: body.ticketId, history: ticket.history,
    });
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
    vetted[slot] = res.attachment;
    vettedEtags[slot] = res.etag;
    if (res.siblingUnchecked) renumberedSiblingUnchecked = true;
  }

  // Referenced people must be active members of the same org — and a picked
  // "engineer" must actually hold an engineer role (headline or additive).
  // SM-12: the drafter's name on the row is the member's own (display name,
  // else their email's local part) — read here, never the client's string.
  let assigneeName: string | null = null;
  for (const ref of [body.engineer?.id, body.assignment?.id].filter(Boolean) as string[]) {
    const { data: refMember } = await supabaseAdmin
      .from("org_members")
      .select("uid, role, roles, display_name, email")
      .eq("org_id", ticket.orgId)
      .eq("uid", ref)
      .eq("status", "active")
      .maybeSingle();
    if (!refMember) {
      return NextResponse.json({ error: "Referenced user is not an active member of this workspace" }, { status: 400 });
    }
    const held: string[] = Array.isArray(refMember.roles) && refMember.roles.length > 0
      ? (refMember.roles as string[])
      : [String(refMember.role ?? "")];
    if (ref === body.engineer?.id) {
      // An Engineer role, and — when the org scoped the reviewing
      // capability to THIS ticket's type (DEC-13, DRAFT-1 / GAP-1) — that
      // rule. The assigned engineer acts by identity afterwards, so the pick
      // is where a type-scoped reviewer group is enforced. ROUTE-8 (DF-P5):
      // ONE rule, lib/ticketPage.ts engineerPickRefusal — the engineer
      // picker offers exactly the members it accepts.
      const pickRefused = engineerPickRefusal(held, capPolicy, engineerPickCap(body.actionType), ref, resource, ticket.requestType);
      if (pickRefused) return NextResponse.json({ error: pickRefused }, { status: 400 });
      // WF-14 (+DEC-12, +DEC-37): the reviewer slot is INDEPENDENT of the
      // deliverable's producer and its beneficiary. In orgs of 3+ the picked
      // engineer may not be the requester, the assigned drafter, or the
      // caller — otherwise "two-stage engineering sign-off" can be one
      // person wearing every hat on the same ticket. Below 3 members the
      // single-person loop stays legal (DEC-12).
      if (sodActive) {
        if (ref === ticket.requesterId) {
          return NextResponse.json({ error: "Needs a second person: the requester can't be the engineer who reviews their own request (orgs of 3+)." }, { status: 403 });
        }
        if (ref === ticket.assignedDrafterId) {
          return NextResponse.json({ error: "Needs a second person: the drafter can't be the engineer who reviews their own deliverable (orgs of 3+)." }, { status: 403 });
        }
        if (ref === caller.id) {
          return NextResponse.json({ error: "Needs a second person: you can't pick yourself as the reviewing engineer (orgs of 3+)." }, { status: 403 });
        }
      }
    }
    if (ref === body.assignment?.id) {
      // WF-14 done-when 3: the assignee must actually hold drafting
      // authority under the org's policy — membership alone was the only
      // check before.
      const mayDraft = policyAllows(capPolicy, "ticket.draft_work",
        (held[0] ?? "Viewer") as Role, held as Role[], ref, resource);
      if (!mayDraft) {
        return NextResponse.json({ error: "The selected drafter does not hold drafting authority (ticket.draft_work)" }, { status: 400 });
      }
      // SM-12: never the client's string. A membership row with neither a
      // display name nor an email falls back to the account's sign-in email
      // (its local part), else a neutral label.
      assigneeName = memberName(refMember as { display_name?: unknown; email?: unknown }) ?? (await accountName(ref)) ?? UNNAMED_MEMBER;
      // GAP-2/DEC-12: the assigned drafter may not be the requester (3+).
      if (sodActive && ref === ticket.requesterId) {
        return NextResponse.json({ error: "Needs a second person: the requester can't draft their own request (orgs of 3+)." }, { status: 403 });
      }
    }
  }

  // AUTHZ-14: the gated requester's note to the engineer is what the engineer
  // signs off against — required here, not only by the picker dialog's
  // default (the engine action carries no requiresComment flag). Checked
  // after the engineer pick's own validation, before anything is written.
  if (action.action === "request_final_engineer_approval" && !body.comment?.trim()) {
    return NextResponse.json({ error: "Sending for engineer final approval requires a note for the engineer" }, { status: 400 });
  }

  // LEAK-9 / GAP-107 (DF-P3): how the request ended — typed, beside the free
  // text the comment carries. A named outcome must be one this action can
  // record (a cancel is never "completed"), refused with nothing written
  // otherwise. An action that requires one (cancel_request) and arrives
  // without it still applies — the request page does not send the category
  // yet (DF-P9 owns the page), and a cancel that works today must keep
  // working — but records NO outcome (never a guessed "withdrawn", which the
  // leak rate would count) and the audit row says the category was not named
  // (`outcomeDefaulted`).
  const endsWith = outcomesFor(action.action);
  let outcome: TicketOutcome | null = null;
  let outcomeDefaulted = false;
  if (body.outcome !== undefined && body.outcome !== null && body.outcome !== "") {
    if (!endsWith || !isTicketOutcome(body.outcome) || !endsWith.includes(body.outcome)) {
      return NextResponse.json({
        error: endsWith
          ? `"${String(body.outcome).slice(0, 40)}" is not a way this action can end a request (one of: ${endsWith.join(", ")})`
          : "This action does not end the request, so it records no outcome",
        code: "outcome_invalid",
      }, { status: 400 });
    }
    outcome = body.outcome;
  } else if (action.requiresOutcome) {
    outcomeDefaulted = true;
  }
  // GAP-13 / GAP-107 acceptance 1 (DF-P14; the integrator's ruling under
  // DEC-90): the workspace's own reason, when one is named, must be one it
  // configured, under the category the request is ending with — refused with
  // nothing written otherwise; a list that cannot be read is a 503, never an
  // unchecked reason.
  // Fix pass (DEC-29 — "requires a reason" holds for any caller, never only
  // the dialog): with NO reason named, the picker's own rule binds the route
  // too (lib/ticketOutcomeReasons.ts checkBareOutcome) — a bare category the
  // workspace keeps reasons under, or a cancel naming no category while it
  // keeps reasons under any way a cancel can end, is refused (400
  // `outcome_reason_required`, nothing written). A category with no reasons
  // of its own, and every request of a workspace with no list, behave exactly
  // as before. If the list cannot be read for a request that names no reason,
  // the request is accepted as before (the dialog's own fallback offers the
  // bare categories when it cannot read them) and the audit row says the
  // reason went unchecked (`outcomeReasonUnchecked`).
  let outcomeReason: OutcomeReason | null = null;
  let outcomeReasonUnchecked = false;
  const reasonNamed = body.outcomeReason !== undefined && body.outcomeReason !== null && body.outcomeReason !== "";
  if (reasonNamed && (typeof body.outcomeReason !== "string" || !outcome)) {
    return NextResponse.json({
      error: "A reason is named together with how the request ends (its category)",
      code: "outcome_reason_invalid",
    }, { status: 400 });
  }
  if (reasonNamed || outcome || outcomeDefaulted) {
    const { data: reasonCfg, error: reasonCfgErr } = await supabaseAdmin
      .from("org_configurations").select("data").eq("org_id", ticket.orgId).eq("key", "drafting").maybeSingle();
    if (reasonCfgErr) {
      if (reasonNamed) {
        return NextResponse.json({ error: "Couldn't read this workspace's reasons for ending a request — try again in a moment." }, { status: 503 });
      }
      outcomeReasonUnchecked = true;
    } else {
      const reasons = parseOutcomeReasons((reasonCfg as { data?: unknown } | null)?.data);
      if (reasonNamed) {
        const checked = checkOutcomeReason(String(body.outcomeReason), outcome!, reasons);
        if (!checked.ok) return NextResponse.json({ error: checked.error, code: "outcome_reason_invalid" }, { status: 400 });
        outcomeReason = checked.reason;
      } else {
        const bare = checkBareOutcome(outcome, endsWith ?? [], reasons);
        if (!bare.ok) return NextResponse.json({ error: bare.error, code: "outcome_reason_required" }, { status: 400 });
      }
    }
  }

  // DCW-1 / GAP-105 and DCW-7 / FRIC-3 (DF-P4): triage may record the
  // request's library and its unit — with the assignment or the engineering
  // flag, from the assignment queue, never elsewhere — on the same
  // compare-and-set write. Neither is ever required (99-fix-sequencing
  // Phase 2 item 1: "Do not make it required at intake"; DEC-101 item 1).
  const triageAction = ticket.status === "PENDING_ASSIGNMENT"
    && (action.action === "assign" || action.action === "request_eng_review");
  // DF-P4 second fix pass: the library the ticket ALREADY has, sent back
  // unchanged (the picker initialised from the ticket re-sends it), is no
  // change — never re-checked against the caller, whose discover rights on
  // it are beside the point (a requester's discover grant may have set it,
  // GAP-105 / DCW-5). computeTransition treats it as a no-op too.
  const libraryUnchanged = typeof body.libraryId === "string"
    && !!ticket.libraryId && body.libraryId.trim().toLowerCase() === ticket.libraryId.toLowerCase();
  const wantsLibrary = typeof body.libraryId === "string" && body.libraryId.trim() !== "" && !libraryUnchanged;
  const wantsUnit = typeof body.unit === "string" && body.unit.trim() !== "";
  let triage: TransitionInput["triage"] = null;
  let libraryNotStored = false;
  if ((wantsLibrary || wantsUnit) && !triageAction) {
    return NextResponse.json({ error: "A library or a unit is recorded at triage — when assigning, or flagging for engineering review, from the assignment queue." }, { status: 400 });
  }
  if (wantsLibrary) {
    const libraryId = String(body.libraryId).trim();
    if (!UUID_RE.test(libraryId)) return NextResponse.json({ error: "That library is not one of this workspace's" }, { status: 400 });
    if (!("library_id" in (row as Record<string, unknown>))) {
      // 20261208 not pasted yet: the column is not there. The action applies
      // as today, without a library, and the answer says so.
      libraryNotStored = true;
    } else {
      // DF-P4 fix pass: the SAME rule the picker offers by
      // (lib/ticketLibrary.ts offerableLibraries → canDiscover), run here on
      // the caller's principal built on the server — membership roles (the
      // full additive collection) and team ids read as the service role — so
      // a library the assigner cannot discover is refused exactly as one of
      // another workspace is (same answer: its existence is not confirmed),
      // whatever the client sends. A read that fails is a 503, never a guess.
      // DACL-13 R1 (I-31 merge, DEC-90): the library is read with the rung's
      // columns and decided — offered and labelled — by its EFFECTIVE ACL
      // (lib/ticketLibrary libraryChoiceFromRow → lib/libraryAccess), so
      // this check answers the same before and after migration 20261228.
      const [{ data: lib, error: libErr }, { data: teamRows, error: teamErr }] = await Promise.all([
        supabaseAdmin.from("libraries").select(LIBRARY_CHOICE_COLUMNS)
          .eq("id", libraryId).eq("org_id", ticket.orgId).maybeSingle(),
        supabaseAdmin.from("team_members").select("team_id").eq("uid", caller.id),
      ]);
      if (libErr || teamErr) return NextResponse.json({ error: "Couldn't check that library right now — try again in a moment." }, { status: 503 });
      const libRow = lib ? libraryChoiceFromRow(lib as unknown as Record<string, unknown>) : null;
      const heldByCaller = heldRoles(member as { role?: unknown; roles?: unknown }) as Role[];
      const principal: Principal | null = heldByCaller.length === 0 ? null : {
        uid: caller.id,
        role: heldByCaller[0],
        roles: heldByCaller,
        orgId: ticket.orgId,
        teamIds: ((teamRows ?? []) as Array<{ team_id?: unknown }>).map((t) => String(t.team_id ?? "")).filter(Boolean),
        isActiveMember: true,
      };
      const offered = libRow ? offerableLibraries([libRow], principal) : [];
      if (!libRow || offered.length === 0) return NextResponse.json({ error: "That library is not one of this workspace's" }, { status: 400 });
      // The history line names a library only when every reader of the
      // ticket may know it (libraryLabelForTicket): a hidden / private one,
      // or one whose ACL carries any rule, is "the target library".
      triage = { ...(triage ?? {}), library: { id: String(libRow.id), name: libraryLabelForTicket(libRow) } };
    }
  }
  if (wantsUnit) {
    // The SAME list the request form offers and the create route checks:
    // the saved units, else the Site Codebook's, else none (free text, as
    // the form keeps it — DEC-101 item 1). A list that is there but cannot
    // be read is a 503, never an unchecked unit.
    const { data: unitCfg, error: unitCfgErr } = await supabaseAdmin
      .from("org_configurations").select("data").eq("org_id", ticket.orgId).eq("key", "drafting").maybeSingle();
    if (unitCfgErr) return NextResponse.json({ error: "Couldn't read this workspace's unit list — try again in a moment." }, { status: 503 });
    const cfgUnits = ((unitCfg as { data?: unknown } | null)?.data ?? null) as Parameters<typeof unitOptionsFor>[0];
    let codebookUnits: Array<{ code: string; label: string | null }> = [];
    if (!((cfgUnits?.units?.options?.length ?? 0) > 0)) {
      const { data: cb, error: cbErr } = await supabaseAdmin
        .from("codebook_entries").select("code, label").eq("org_id", ticket.orgId).eq("kind", "unit");
      const failure = unitListReadFailure(cbErr);
      if (failure === "unreadable") return NextResponse.json({ error: "Couldn't read this workspace's unit list — try again in a moment." }, { status: 503 });
      if (failure === "none") codebookUnits = ((cb ?? []) as Array<{ code: string; label: string | null }>).filter((u) => !!u.code);
    }
    const resolved = resolveUnit(String(body.unit).slice(0, 120), unitOptionsFor(cfgUnits, codebookUnits));
    if (resolved.kind === "unmatched") {
      return NextResponse.json({ error: `"${String(body.unit).trim().slice(0, 60)}" is not on this workspace's unit list`, field: "unit" }, { status: 400 });
    }
    if (resolved.unit) triage = { ...(triage ?? {}), unit: resolved.unit };
  }

  // ── GAP-101 / TIER-4 (DF-P6): the work class and the code class ────────
  // Recorded by triage (the assignment queue: assign, request_eng_review or
  // flag_engineering at PENDING_ASSIGNMENT) from the workspace's own lists —
  // never free text (DEC-35), never required (99-fix-sequencing "Do not":
  // no work class required at intake). A value not on the list is refused
  // with nothing written; a list that could not be read is a 503, never an
  // unchecked class. Before 20261250 is pasted the columns are not there:
  // the action applies as today and the answer says the class was not
  // recorded.
  const reviewModelColumns = hasReviewModelColumns(ticket);
  const wantsWorkClass = typeof body.workClass === "string" && body.workClass.trim() !== "";
  const wantsCodeClass = typeof body.codeClass === "string" && body.codeClass.trim() !== "";
  let reviewClass: TransitionInput["reviewClass"] = null;
  let reviewClassNotStored = false;
  if (wantsWorkClass || wantsCodeClass) {
    const classTriage = ticket.status === "PENDING_ASSIGNMENT"
      && (action.action === "assign" || action.action === "request_eng_review" || action.action === "flag_engineering");
    if (!classTriage) {
      return NextResponse.json({ error: "A work class or a code class is recorded at triage — when assigning, or flagging for engineering, from the assignment queue." }, { status: 400 });
    }
    if (!reviewModelColumns) {
      reviewClassNotStored = true;
    } else {
      if (!draftingCfgRead) return NextResponse.json({ error: "Couldn't read this workspace's work and code classes — try again in a moment." }, { status: 503 });
      const wc = resolveReviewClass(body.workClass, reviewClassOptions(draftingCfg, "workClasses"));
      const cc = resolveReviewClass(body.codeClass, reviewClassOptions(draftingCfg, "codeClasses"));
      if (wc.kind === "unknown") return NextResponse.json({ error: `"${String(body.workClass).trim().slice(0, 60)}" is not one of this workspace's work classes`, field: "workClass" }, { status: 400 });
      if (cc.kind === "unknown") return NextResponse.json({ error: `"${String(body.codeClass).trim().slice(0, 60)}" is not one of this workspace's code classes`, field: "codeClass" }, { status: 400 });
      reviewClass = { workClass: wc.kind === "ok" ? wc.option : null, codeClass: cc.kind === "ok" ? cc.option : null };
    }
  }

  // ── HAND-7 done-when 3 (DF-P6; bound by DF-P18): an approval over a moved source
  // DEC-90 ruling (2) for DF-P18: the acknowledgement is required only when
  // the action carries `requiresSourceDriftAck` (the labels computed above,
  // before getActions): without `sourceDriftAcknowledged: true` it is refused
  // (409 source_drift_unacknowledged), nothing written; with it, it applies
  // and the history line and the audit row record the move and the
  // acknowledgement. A refused roster sign-off names the e-signature the
  // panel minted (DF-P5's rule; a dry run has none).
  //
  // A documents read that FAILED (twice — above) — DF-P18 fix pass 2 (review,
  // major), held to the text of DEC-90 ruling (2): it refuses (503
  // source_drift_unchecked) ONLY an action the client's own engine flagged,
  // i.e. a post carrying `sourceDriftAcknowledged: true` (the client saw a
  // move the route can now neither confirm nor record). Every other issuing
  // approval or sign-off applies exactly as on the base, and its audit row
  // records `sourceDriftUnchecked: true`; a dry-run sign-off is never refused
  // by a failed read (on the base it read nothing).
  let sourceDrift: { labels: string[]; acknowledged: boolean | null } | null = null;
  if (ISSUING_APPROVALS.has(action.action) || action.action === "sign_slot") {
    const recordsSignature = action.action === "sign_slot" && body.dryRun !== true;
    if (sourceDriftUnchecked && body.dryRun !== true && body.sourceDriftAcknowledged === true) {
      const uncheckedError = "The source documents this request was raised against could not be checked for a newer revision, so the move you acknowledged could not be confirmed and the approval was not applied. Try again in a moment.";
      if (recordsSignature) {
        await recordRefusedSignOff({ signatureId: body.signatureId, ticketId: body.ticketId, orgId: ticket.orgId, caller: { id: caller.id, email: callerEmail, role: callerRole }, status: 503, reason: uncheckedError, code: "source_drift_unchecked", rosterId: currentRoster(ticket)?.id ?? null });
      }
      return NextResponse.json({ error: uncheckedError, code: "source_drift_unchecked" }, { status: 503 });
    }
    if (action.requiresSourceDriftAck && driftLabels.length > 0) {
      if (body.sourceDriftAcknowledged !== true) {
        // DF-P18 fix pass (review, blocker): the route is the source of
        // truth for the move — it read the documents as the service role,
        // which an approver under a document ACL cannot. The 409 carries the
        // labels (`moved`), so the page and the roster panel ask from them
        // and resend once with the acknowledgement, whatever the browser's
        // own (RLS-limited) read found.
        const driftError = `The source revision has moved since this request was raised (${driftLabels.join("; ")}). Approving needs your acknowledgement.`;
        // DF-P6 fix pass (review, minor 12): a refused roster sign-off
        // names the signature it minted (DF-P5's rule).
        if (recordsSignature) {
          await recordRefusedSignOff({ signatureId: body.signatureId, ticketId: body.ticketId, orgId: ticket.orgId, caller: { id: caller.id, email: callerEmail, role: callerRole }, status: 409, reason: driftError, code: "source_drift_unacknowledged", rosterId: currentRoster(ticket)?.id ?? null });
        }
        return NextResponse.json({ error: driftError, code: "source_drift_unacknowledged", moved: driftLabels }, { status: 409 });
      }
      sourceDrift = { labels: driftLabels, acknowledged: true };
    }
  }

  // ── GAP-102 acceptance 4 (DF-P24): the examination-scope issue gate ──────
  // An issuing approval, or a roster sign-off that would complete the review
  // (computed here as the sign-off block below computes it), on a request a
  // configured requirement applies to (its work class and/or its library —
  // lib/examinationScope.ts) reads the request's examination data and refuses
  // (409 examination_scope_missing, nothing written) when a value the
  // requirement names is missing — only for a request filed at or after the
  // requirement's `since` and not covered by a recorded waiver. A request
  // filed before it issues with what is missing said (`examinationScopeWarning`).
  // A workspace that configures nothing reads nothing and records nothing
  // here; a configuration that could not be read is no configuration (today's
  // path — DEC-90 ruling (6) for DF-P24) except that the issuing row then
  // says `examinationScope: { configUnchecked: true }` (the route cannot
  // tell whether that workspace configured anything), as is a database
  // without 20261266. The row unreadable refuses (503) only where a
  // requirement BINDS the request (lib/examinationScope.ts scopeGateOutcome)
  // — a request filed before every requirement issues, the row saying it was
  // unchecked. Second fix pass: the whole decision is one call
  // (lib/examinationScopeGate.ts issueScopeGate), so the regression sweep
  // can run the route without it.
  let examinationScopeAudit: Record<string, unknown> | null = null;
  let examinationScopeWarningText: string | null = null;
  const scopeDecision = await issueScopeGate({
    action: action.action, ticket, draftingCfg: scopeDraftingCfg, draftingCfgRead, callerId: caller.id, sodActive,
    readRow: () => supabaseAdmin.from("ticket_examination_scopes").select("field_values, waiver").eq("ticket_id", body.ticketId).maybeSingle(),
  });
  if (scopeDecision.kind === "config_unchecked") examinationScopeAudit = { configUnchecked: true };
  if (scopeDecision.kind === "unreadable") {
    console.error(`[workflow-action] examination data unreadable for ticket ${body.ticketId}: ${scopeDecision.error}`);
    const unreadable = "This request's examination data could not be checked, so the approval was not applied. Try again in a moment.";
    if (action.action === "sign_slot" && body.dryRun !== true) {
      await recordRefusedSignOff({ signatureId: body.signatureId, ticketId: body.ticketId, orgId: ticket.orgId, caller: { id: caller.id, email: callerEmail, role: callerRole }, status: 503, reason: unreadable, code: "examination_scope_unreadable", rosterId: currentRoster(ticket)?.id ?? null });
    }
    return NextResponse.json({ error: unreadable, code: "examination_scope_unreadable" }, { status: 503 });
  }
  if (scopeDecision.kind === "blocked") {
    if (action.action === "sign_slot" && body.dryRun !== true) {
      await recordRefusedSignOff({ signatureId: body.signatureId, ticketId: body.ticketId, orgId: ticket.orgId, caller: { id: caller.id, email: callerEmail, role: callerRole }, status: 409, reason: scopeDecision.refusal, code: "examination_scope_missing", rosterId: currentRoster(ticket)?.id ?? null });
    }
    return NextResponse.json({ error: scopeDecision.refusal, code: "examination_scope_missing", missing: scopeDecision.blocking.map((b) => ({ field: b.key, label: b.label })) }, { status: 409 });
  }
  if (scopeDecision.kind === "pass") {
    examinationScopeAudit = scopeDecision.audit;
    examinationScopeWarningText = scopeDecision.warning;
  }

  // ── GAP-116 (DF-P26; DEC-90 ruling (2) for DF-P26): a hold that stops the request
  // An issuing approval, or a roster sign-off that would complete the review
  // (its dry run too), is refused (409 request_on_hold, nothing written)
  // while an OPEN hold on the request's source document carries THIS
  // request's examination record and was placed by one of the people of the
  // notify-only slot the record names (DF-P25's hold — lib/requestHoldStop.ts).
  // Releasing the hold lets it proceed. Read only where such a record could
  // exist (a source document, and a roster on record with an opted-in
  // notify-only slot); every other request reads nothing here. A read that
  // fails where a record could exist is a 503 (try again) — never a pass.
  const holdStop = await issueHoldStopGate(supabaseAdmin, { action: action.action, ticket, ticketId: body.ticketId, callerId: caller.id, sodActive });
  if (holdStop.kind === "unreadable") {
    console.error(`[workflow-action] holds on the source document unreadable for ticket ${body.ticketId}: ${holdStop.error}`);
    const unreadable = "The holds on this request's source document could not be checked, so the approval was not applied. Try again in a moment.";
    if (action.action === "sign_slot" && body.dryRun !== true) {
      await recordRefusedSignOff({ signatureId: body.signatureId, ticketId: body.ticketId, orgId: ticket.orgId, caller: { id: caller.id, email: callerEmail, role: callerRole }, status: 503, reason: unreadable, code: "request_hold_unreadable", rosterId: currentRoster(ticket)?.id ?? null });
    }
    return NextResponse.json({ error: unreadable, code: "request_hold_unreadable" }, { status: 503 });
  }
  if (holdStop.kind === "stopped") {
    if (action.action === "sign_slot" && body.dryRun !== true) {
      await recordRefusedSignOff({ signatureId: body.signatureId, ticketId: body.ticketId, orgId: ticket.orgId, caller: { id: caller.id, email: callerEmail, role: callerRole }, status: 409, reason: holdStop.refusal, code: "request_on_hold", rosterId: currentRoster(ticket)?.id ?? null });
    }
    return NextResponse.json({ error: holdStop.refusal, code: "request_on_hold", holds: holdStop.holds.map((h) => ({ id: h.id, reason: h.reason, slot: h.slotLabel })) }, { status: 409 });
  }

  // ── GAP-103 / GAP-112 (DF-P5 ROSTER) ───────────────────────────────────
  // A draft entering PENDING_REVIEW in a library that declares a routing
  // table opens a PARALLEL roster (lib/ticketRoster.ts): every slot's
  // occupants resolved now, every sign-off bound to the sha256 of the files
  // under review. An unconfigured ticket (no library, no table anywhere on its
  // chain, or the 20261241 column not pasted) takes today's path with no
  // read beyond the chain. The routing is DECLARED, never guessed, and fails
  // CLOSED: a chain that cannot be read, a table that cannot be used, a slot
  // nobody can fill, or files that cannot be hashed refuse the submission
  // with the reason — nothing written. All of it is read before the audit
  // row, the first write.
  const openRosterNow = currentRoster(ticket);
  let rosterOpen: TicketReviewRoster | null = null;
  let rosterSign: TransitionInput["rosterSign"] = null;
  // GAP-102 (DF-P20): what the assurance reviewer examined, recorded on the
  // event of each assurance slot this sign-off or veto acts on (null: none).
  let examination: ExaminationOnAct | null = null;
  let rosterWarning: string | null = null;
  // DF-P23 (the DF-P20 follow-up (b), DEC-31): the roster ledger was not
  // written after the transition landed — returned as its own response flag
  // (`rosterLedgerNotWritten`), so a hold or library warning that takes the
  // one `warning` slot cannot hide it from the roster panel.
  let rosterLedgerNotWritten = false;
  // GAP-109 / GAP-113 (DF-P7): what this submission's consent slot does, said
  // in the response (never in rosterWarning, which the audit row carries).
  let consentWarning: string | null = null;
  let consentMembers: Array<Record<string, unknown>> = [];
  // GAP-109 mechanism 2 (DF-P22): the engineered-lane answer this submission's
  // roster was opened under — a standing pre-authorization never acts on
  // engineered work (nor while the declaration could not be checked).
  let rosterEngineered = true;
  // GAP-115 (DF-P26): what the exception-only rule did on this act — the
  // audit row's `exceptionReview` (null: nothing — every roster without an
  // exception-only slot), the labels it satisfied at open (history), and a
  // re-open of the slots it had satisfied (history, ledger, response).
  let exceptionReview: Record<string, unknown> | null = null;
  let exceptionRuleOpenLabels: string[] = [];
  let exceptionReopen: { slots: TicketReviewSlot[]; labels: string[]; exceptions: string[] } | null = null;
  // Only a SUBMISSION opens a roster. reopen_ticket takes today's path into
  // PENDING_REVIEW (DF-P5 fix pass): a reopened request may have no readable
  // Draft at all, and its previous Draft is the already-issued bytes — the
  // next submit_draft opens the roster on the new files. Until then the
  // serial approvals are refused on a routed ticket (TIER-5, fix pass 3,
  // above): the way forward is a revision and a resubmission.
  const entersReview = ticket.status !== "PENDING_REVIEW" && action.action === "submit_draft";
  if (entersReview && ticket.libraryId) {
    const refuse = (status: number, code: string, error: string) => NextResponse.json({ error, code }, { status });
    let sourceDocument: { id: string; collectionId: string | null; libraryId: string | null } | null = null;
    const src = parseSourceDocument(ticket.metadata);
    if (src?.id && UUID_RE.test(src.id)) {
      const { data: d, error: dErr } = await supabaseAdmin
        .from("documents").select("id, collection_id, library_id").eq("id", src.id).eq("org_id", ticket.orgId).maybeSingle();
      if (dErr) return refuse(503, "routing_unreadable", "This request's review routing could not be read, so the draft was not submitted. Try again in a moment.");
      const dr = d as { id?: string; collection_id?: string | null; library_id?: string | null } | null;
      if (dr?.id) sourceDocument = { id: dr.id, collectionId: dr.collection_id ?? null, libraryId: dr.library_id ?? null };
    }
    let routing: Awaited<ReturnType<typeof effectiveRoutingForTicket>>;
    try {
      // The chain reads through the shared client, bound to the service role
      // for this request only (loaded here, as the copy recall loads it).
      const { runWithServerClient } = await import("@/lib/serverClientScope");
      routing = await runWithServerClient(supabaseAdmin, () => effectiveRoutingForTicket({ libraryId: ticket.libraryId, sourceDocument }));
    } catch (e) {
      console.error(`[workflow-action] routing unreadable for ticket ${body.ticketId}:`, (e as Error)?.message ?? e);
      return refuse(503, "routing_unreadable", "This request's review routing could not be read, so the draft was not submitted. Try again in a moment.");
    }
    if (routing.state === "invalid") {
      return refuse(409, "routing_invalid", `The review routing set on this request's ${routing.level} can't be used (${routing.error}), so the draft was not submitted. Ask a document controller to correct it.`);
    }
    if (routing.state === "configured") {
      // A GET, never a HEAD (DF-P5 fix pass 2): PostgREST answers a missing
      // table (PGRST205) with a 404 whose body a HEAD response cannot carry,
      // and postgrest-js maps a body-less 404 to success — the probe would
      // read "pasted" and the roster would open with no ledger to write to.
      const { error: ledgerErr } = await supabaseAdmin.from("ticket_review_slots").select("id").eq("ticket_id", body.ticketId).limit(1);
      if (ledgerErr && isMissingRosterLedger(ledgerErr)) {
        // 20261241 pasted, 20261242 not yet: today's path, said.
        rosterWarning = "This request's library routes its reviews, but the review roster is not in the database yet (update 20261242 is not applied) — it was submitted for review the usual way.";
      } else if (ledgerErr) {
        return refuse(503, "routing_unreadable", "The review roster could not be checked, so the draft was not submitted. Try again in a moment.");
      } else {
        const cycle = action.action === "submit_draft" ? draftRevLabel(ticket.revisionCount, (ticket.draftIteration ?? 0) + 1) : null;
        const projected = action.action === "submit_draft"
          ? (ticket.attachments ?? []).map((a) => (a.status === "staged" && a.type === "Draft" ? { ...a, status: "submitted" as const, rev: cycle } : a))
          : (ticket.attachments ?? []);
        const files = filesUnderReview(projected, cycle);
        if (files.length === 0) return refuse(409, "routing_no_files", "There is no draft to review on this request, so no review could open.");
        // DF-P5 fix pass 2: a package too large or too slow to fingerprint
        // in one request is NOT refused (re-uploading it could never help):
        // those files are bound by identity and named on every sign-off
        // (lib/ticketRoster.ts rosterBinding). Only a storage outage (try
        // again) or a file that is not in storage (replace it) refuses.
        const rosterHashes = await hashStoredFiles(files.map((f) => f.url ?? "").filter(Boolean), { deadlineMs: HASH_LIMITS.rosterDeadlineMs, byteBudget: HASH_LIMITS.rosterByteBudget });
        const binding = rosterBinding(files, rosterHashes);
        if (!binding.ok) {
          return binding.transient
            ? refuse(503, "content_unhashable", "The files under review could not be read from storage to bind the sign-offs to them, so the draft was not submitted. Try again in a moment.")
            : refuse(409, "content_unhashable", `"${binding.file}" cannot be put under review (${binding.reason}) — remove it from the request and attach the file again, then submit.`);
        }
        const hashed = binding.files;
        const members = await loadPickerMembers(ticket.orgId, supabaseAdmin);
        if (!members.ok) return refuse(503, "routing_unreadable", "This workspace's members could not be read to open the review, so the draft was not submitted. Try again in a moment.");
        // DEC-13 stage 3 / DEC-16 / DEC-36 (DF-P5 fix pass 2): a routing
        // table adds reviewers; it never drops the org-wide engineering gate.
        // The gate is the state machine's own (the snapshot OR the
        // requester's current collection, under the org's
        // ticket.engineer_gate_exempt list), or an engineering-first type;
        // when it applies and the table carries no blocking engineering slot,
        // openRoster appends the seed's (lib/ticketRoster.ts withEngineeringGate).
        // DF-P6 (TIER-1 / GAP-111): the gate is the WORK's — the
        // declaration and the binding flag — with the role-based seed for a
        // request the column cannot speak for (engineeringGateRequired).
        const engineeringGate = {
          required: engineeringGateRequired(ticket, requesterRoles, capPolicy)
            || engineeringFirstTypes.includes(ticket.requestType),
          assignedEngineerId: ticket.assignedEngineerId ?? null,
        };
        const opened = openRoster({
          // GAP-102 / TIER-3 (DF-P6): a notify-only slot limited to other
          // work classes is left out for this request (never a sign-off).
          id: crypto.randomUUID(), control: routingForWorkClass(routing.control, ticket.workClass), level: routing.level, cycle, files: hashed,
          ctx: { members: members.rows, policy: capPolicy, resource, requesterId: ticket.requesterId },
          openedBy: caller.id, now: new Date().toISOString(), engineeringGate,
        });
        if (!opened.ok) return refuse(409, opened.code, opened.error);
        // GAP-116 (DF-P26 fix pass 2): a hold placed with its record in an
        // earlier round keeps stopping the request after the routing drops
        // the notify-only opt-in — the new roster carries that an earlier one
        // could hold such a record (lib/requestHoldStop.ts). Never set where
        // no earlier roster carried such a slot: the roster is then today's.
        rosterOpen = carryNotifyHoldMark(opened.roster, ticket);
        rosterEngineered = engineeringGate.required || declarationUnverified !== null;
        // GAP-109 / DEC-90 rulings for DF-P7: a consent slot runs a window
        // only where lib/consentWindow.ts planConsentWindow allows it — never
        // on engineered work (the same gate the roster just applied), never
        // as the engineering sign-off, never with nobody to ask. The plan
        // rides the roster (one decision for the history, the window and
        // the cron's retry). Before 20261255 the row has no window columns:
        // the roster is exactly today's, the slot waits for a sign-off, and
        // the response says so. DEC-12 / DEC-37 (fix pass): the people
        // asked are never the drafter, nor a party the slot is independent
        // of — nobody else left is a block, escalated.
        const consentColumns = Object.prototype.hasOwnProperty.call(row, "consent_window_opened_at");
        // DEC-90 ruling (3) (DF-P7 final fix pass): a declaration whose
        // e-signature could not be read ('unchecked') proves nothing, so no
        // window is planned — the slot waits as an ordinary sign-off, said.
        // ('missing' already made this engineered work above.)
        const consentPlan = planConsentWindow(opened.roster, {
          engineeringRequired: engineeringGate.required, columns: consentColumns,
          drafterId: ticket.assignedDrafterId ?? null, requesterId: ticket.requesterId ?? null,
          declarationUnchecked: declarationUnverified === "unchecked",
        });
        // DEC-90 rulings (4) and (5) (DF-P7 merge-time fix pass): an
        // unconfirmed consent slot is checked before the "columns missing"
        // branch — no plan on the roster, no note, no warning blaming the
        // paste: the review is today's, byte for byte.
        if (isUnconfirmedConsentPlan(consentPlan)) { /* today's review, unchanged */ }
        // (DF-P26 fix pass 3: built on the roster as it now stands, so the
        // earlier-round hold mark carried above is kept.)
        else if (consentPlan && consentColumns) rosterOpen = { ...rosterOpen, consentPlan };
        else if (consentPlan) consentWarning = `${consentPlan.label ? `"${consentPlan.label}"` : "The consent slot"} waits for a sign-off: ${CONSENT_REASON.notPasted}.`;
        consentMembers = members.rows;
        // GAP-115 (DF-P26; DEC-90 ruling (1)) limb 1: an exception-only slot
        // is satisfied by a recorded system act naming the rule — only when
        // the request is not engineered work, no exception is on record (the
        // source unmoved, no examination-data waiver), the review still waits
        // on a live sign-off someone other than the drafter may give, and
        // 20261268 is in place (lib/exceptionOnlyReview.ts). Otherwise the
        // slot waits for its sign-off, as today. Read only for a roster that
        // carries such a slot.
        if (rosterOpen && rosterHasExceptionOnlySlot(rosterOpen, ticket)) {
          // (DF-P26 fix pass 4: request types that could not be read leave
          // "engineered" unknown — nothing applied, reason "unchecked".)
          const eo = await exceptionRuleAtOpen(supabaseAdmin, { roster: rosterOpen, ticket, ticketId: body.ticketId, sodActive, engineered: rosterEngineered, engineeredUnchecked: !engineeringFirstKnown, now: Date.now() });
          rosterOpen = eo.roster;
          if (eo.applied) {
            exceptionRuleOpenLabels = eo.labels;
            exceptionReview = { satisfiedByRule: eo.kinds, rule: "exception_only" };
          } else {
            exceptionReview = { ruleNotApplied: eo.reason, slots: eo.kinds };
          }
        }
      }
    }
  }
  // GAP-115 (DF-P26): a serial issuing approval is never offered on a
  // request under a roster (the roster's sign-off is its only issuing act),
  // so this never meets one — but should one ever arrive on a roster with a
  // slot the exception-only rule satisfied, it is refused, nothing written:
  // only a sign-off (which checks for exceptions first) may complete it.
  if (ISSUING_APPROVALS.has(action.action) && ruleSatisfiedSlots(openRosterNow).length > 0) {
    return NextResponse.json({ error: "This request is under a review roster, and one of its sign-offs was satisfied by the exception-only rule — it issues only through the roster's sign-offs.", code: "exception_review_roster" }, { status: 409 });
  }
  if (action.action === "sign_slot") {
    // DEC-37: one sign-off satisfies every slot the caller can fill; the
    // plan is the engine's own (lib/workflow.ts slotSignPlan), recomputed
    // here. EVID-12: it carries an e-signature minted by
    // /api/signatures/sign against THIS ticket, by the caller, bound to the
    // roster's content hash, given after the roster opened, used once.
    // TIER-8 / EVID-12 (DF-P5 fix pass 3): the panel asks first (dryRun,
    // below — nothing written, no signature needed), so a signature is
    // minted only for a sign-off the route would take; a refusal that still
    // arrives with one (a race, a stale page) is recorded beside it
    // (recordRefusedSignOff).
    const sigId = typeof body.signatureId === "string" ? body.signatureId.trim() : "";
    const refuseSign = async (status: number, error: string, code?: string, signature?: SignatureRow | null) => {
      if (body.dryRun !== true) {
        await recordRefusedSignOff({ signatureId: sigId, ticketId: body.ticketId, orgId: ticket.orgId, caller: { id: caller.id, email: callerEmail, role: callerRole }, status, reason: error, code, rosterId: openRosterNow?.id ?? null, signature });
      }
      return NextResponse.json({ error, ...(code ? { code } : {}) }, { status });
    };
    if (!openRosterNow) return refuseSign(409, "This request has no review open.");
    const plan = slotSignPlan(openRosterNow, ticket, caller.id, sodActive, Date.now());
    if (plan.fillable.length === 0) return refuseSign(403, plan.blocked[0]?.reason ?? "There is no sign-off open to you on this request.");
    // GAP-102 (DF-P20): a sign-off on an assurance slot carries what was
    // examined (default: every file under review, no note), checked before
    // the dry run answers so a signature is never minted for a record that
    // would be refused. Any other sign-off is exactly as before.
    const exam = examinationForAct(openRosterNow, ticket, plan.fillable, body.examination, { act: "sign_off" });
    if (!exam.ok) return refuseSign(400, exam.error, "examination_invalid");
    examination = exam.value;
    // GAP-115 (DF-P26; DEC-90 ruling (1)) limb 2: on a roster with a slot
    // the exception-only rule satisfied, an exception on record NOW — the
    // source moved, an override sign-off (this one included), a waiver, a
    // declaration that is not on record or could not be checked, the request
    // become engineered work — re-opens that slot for its reviewer in this
    // same compare-and-set: the sign-off is recorded, the request does not
    // issue. What cannot be checked (the waiver row, the source documents —
    // ALL of them, read by readSourceMoved as limb 1 and the consent close
    // read them, more than one read takes being "unchecked", never the first
    // page only — or the like-in-kind declaration's signature) is a retry,
    // never a pass and never an exception (DF-P26 review fix: a failed read
    // is not a fact on record). Read only for such a roster.
    // Merge-time fix pass (DEC-90 rulings (1) and (4)): judged on the roster
    // AFTER this sign-off — a sign-off that upgrades every slot the rule
    // satisfied leaves nothing to re-open, so it reads nothing and is never
    // refused for an unreadable read (before, the reads and the 503 keyed on
    // the roster before it).
    let reopenWith: string[] | null = null;
    let reopenLabels: string[] = [];
    const preview = ruleSatisfiedSlots(openRosterNow).length > 0
      ? applySignPlan(openRosterNow, plan, { uid: caller.id, name: null }, "exception-review-preview", new Date().toISOString())
      : null;
    if (preview && ruleSatisfiedSlots(preview).length > 0) {
      const waiver = await readWaiverOnRecord(supabaseAdmin, body.ticketId);
      const moved = await readSourceMoved(supabaseAdmin, ticket);
      // (DF-P26 fix pass 4: the workspace's request types unread leave
      // "engineered" unknown — the same retry, never "not engineered".)
      if (!waiver.ok || !moved.ok || declarationUnverified === "unchecked" || !engineeringFirstKnown) {
        const why = !waiver.ok ? waiver.error : !moved.ok ? `the source documents could not be read (${moved.error})` : declarationUnverified === "unchecked" ? "the like-in-kind declaration's signature could not be read" : "the workspace's request types could not be read, so whether this request is engineered work is unknown";
        // DF-P26 fix pass 3 (DEC-90 rulings (1) and (4)): the deliberate
        // refusal is for an ISSUING act only. A sign-off that leaves the
        // review open cannot issue, so an unreadable read never refuses it:
        // it is taken, nothing is re-opened by it, and the sign-off that
        // completes the review (or the consent close) checks again.
        if (rosterCompletion(preview, { sodActive, drafterId: ticket.assignedDrafterId }).complete) {
          console.error(`[workflow-action] exception-only review unchecked for ticket ${body.ticketId}: ${why}`);
          return refuseSign(503, "Whether an exception is on record for this review (a moved source, a recorded waiver, the like-in-kind declaration's signature or whether the request is engineered work) could not be checked, so the sign-off was not taken. Try again in a moment.", "exception_review_unchecked");
        }
        console.warn(`[workflow-action] exception-only review unchecked for ticket ${body.ticketId} on a sign-off that does not complete the review (taken; the completing act checks again): ${why}`);
      } else {
        const engineeredNow = engineeringGateRequired(ticket, requesterRoles, capPolicy) || engineeringFirstTypes.includes(ticket.requestType);
        const found = exceptionsOnRecord({ driftLabels: moved.labels, roster: preview, waiver: waiver.waiver, declarationUnverified, engineered: engineeredNow });
        // (DF-P26 review fix: a sign-off that upgrades the last slot the rule
        // satisfied leaves nothing to re-open.)
        reopenLabels = ruleSatisfiedSlots(preview).map((x) => x.label || x.kind);
        if (found.length > 0 && reopenLabels.length > 0) reopenWith = found.map((e) => e.text);
      }
    }
    if (body.dryRun === true) {
      return NextResponse.json({ ok: true, dryRun: true, slots: plan.fillable.map((f) => f.slot.label || f.slot.kind), contentHash: openRosterNow.contentHash, ...(reopenWith ? { exceptionReopens: reopenLabels, exceptionReopenReasons: reopenWith } : {}) });
    }
    if (!UUID_RE.test(sigId)) return NextResponse.json({ error: "A sign-off needs your e-signature.", code: "signature_required" }, { status: 400 });
    const { data: sig, error: sigErr } = await supabaseAdmin
      .from("e_signatures").select("id, org_id, resource_type, resource_id, signer_user_id, content_hash, intent, signed_at")
      .eq("id", sigId).maybeSingle();
    if (sigErr) return NextResponse.json({ error: "Your signature could not be checked — try again in a moment." }, { status: 503 });
    const refusal = signatureRefusal(sig as SignatureRow | null, { orgId: ticket.orgId, ticketId: body.ticketId, signerId: caller.id, roster: openRosterNow });
    if (refusal) return refuseSign(403, refusal, "signature_invalid", sig as SignatureRow | null);
    const signedNow = new Date().toISOString();
    let signed = applySignPlan(openRosterNow, plan, { uid: caller.id, name: memberName(member as { display_name?: unknown; email?: unknown }) }, sigId, signedNow);
    if (reopenWith) {
      const ruled = ruleSatisfiedSlots(signed);
      signed = reopenRuleSatisfied(signed, reopenWith, signedNow);
      exceptionReopen = { slots: signed.slots.filter((x) => ruled.some((r) => r.kind === x.kind)), labels: ruled.map((r) => r.label || r.kind), exceptions: reopenWith };
      exceptionReview = { reopened: ruled.map((r) => r.kind), exceptions: reopenWith };
    }
    rosterSign = { roster: signed, complete: rosterCompletion(signed, { sodActive, drafterId: ticket.assignedDrafterId }).complete, labels: plan.fillable.map((f) => f.slot.label || f.slot.kind) };
  }
  // GAP-102 (DF-P20): a veto by an assurance slot's occupant records what
  // they examined on that slot's "voided" event (lib/assuranceExamination.ts).
  if (action.action === "request_revision" && openRosterNow) {
    const occ = slotSignPlan(openRosterNow, ticket, caller.id, sodActive, Date.now());
    const exam = examinationForAct(openRosterNow, ticket, [...occ.fillable, ...occ.blocked], body.examination, { act: "veto", comment: body.comment ?? null });
    if (!exam.ok) return NextResponse.json({ error: exam.error, code: "examination_invalid" }, { status: 400 });
    examination = exam.value;
  }
  // EVID-12 (DF-P5): the approved drafts and the issued Final are hashed
  // from their bytes (sha256) for the audit trail — on TODAY'S path, AFTER
  // the response (DF-P5 fix pass 2: an approval or a submit_final in an
  // unconfigured workspace does not wait on storage at all). The approval's
  // own row names the files exactly as before and points at the follow-up
  // row (TICKET_<ACTION>_FILES_HASHED) that carries the hashes; bounded
  // (only the Drafts of the revision being approved, at most
  // HASH_LIMITS.legacyMaxFiles, one deadline and byte budget). A routed
  // review's files were hashed when its roster opened (its binding).
  const hashKeys: string[] = [];
  if (APPROVING_ACTIONS.has(action.action)) {
    for (const a of draftsToHashOnApproval(ticket.attachments ?? [], ticket.deliverableRev)) if (a.url) hashKeys.push(a.url);
  }
  if (vetted.finalAttachment?.url) hashKeys.unshift(vetted.finalAttachment.url);
  const filesHashedAction = `TICKET_${action.action.toUpperCase()}_FILES_HASHED`;

  const input: TransitionInput = {
    actionType: action.action,
    actionLabel: action.label,
    variant: action.variant,
    comment: body.comment ?? undefined,
    preFilledComment: body.preFilledComment ?? undefined,
    category: body.category ?? undefined,
    isReassigning: body.isReassigning,
    assignment: body.assignment ? { id: body.assignment.id, name: assigneeName ?? UNNAMED_MEMBER } : undefined,
    engineer: body.engineer ?? undefined,
    redlineAttachment: vetted.redlineAttachment,
    finalAttachment: vetted.finalAttachment,
    attachment: vetted.attachment,
    outcome: outcome ?? undefined,
    triage,
    issueReady: action.action === "submit_draft" && body.issueReady === true,
    rosterOpen,
    rosterSign,
    // SM-3 (DF-P6): the engine marked this action an override of the
    // engineering sign-off for THIS caller on THIS ticket.
    engineeringOverride: action.engineeringOverride === true,
    // Fix pass 4 (review, minor 5): a management issue of a request that
    // does not require engineering — no stamp, no override marker.
    withoutEngineerSignOff: action.withoutEngineerSignOff === true,
    reviewClass,
    reviewModelColumns,
    // DF-P6 fix pass 2 (minor 7): the engineering-first type's mandatory loop
    // (the engine's engineeringFirstPending — before it, the type cannot be
    // assigned) on a request still waiting for it.
    engineeringFirstLoop: action.action === "request_eng_review" && engineeringFirstTypes.includes(ticket.requestType)
      && !ticket.engineerReviewRequestedAt && !ticket.assignedEngineerId,
    sourceDrift,
    // GAP-109 (DF-P7): the engine offered the objection to one of the
    // people the running window asked.
    consentObjection: action.action === "object_consent_window",
    actor: { uid: caller.id, email: callerEmail, role: callerRole },
  };
  const { updates, newStatus, recipients: transitionRecipients, newComment, historyEntry: transitionHistoryEntry } = computeTransition(ticket, input);
  // GAP-115 (DF-P26): the rule's recorded system act is named on the
  // request's history — on the roster-opened line when it satisfied a slot,
  // on this act's line when an exception re-opened one. (No other line moves.)
  if (exceptionRuleOpenLabels.length > 0 && Array.isArray(updates.history)) {
    const hist = updates.history as TicketHistoryEntry[];
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i]?.action === "Review roster opened") { hist[i].details = `${hist[i].details ? `${hist[i].details} · ` : ""}${ruleOpenNote(exceptionRuleOpenLabels)}`; break; }
    }
  }
  if (exceptionReopen && transitionHistoryEntry) {
    const note = ruleReopenNote(exceptionReopen.labels, exceptionReopen.exceptions);
    transitionHistoryEntry.details = transitionHistoryEntry.details ? `${transitionHistoryEntry.details} [${note}]` : note;
  }
  // FRIC-5 / EVID-12 (DF-P5 fix pass 2): the Finals an issue-as-is approval
  // recorded, for the audit row — on a roster with the sha256 the roster
  // bound the Draft (same bytes) to; on today's path the Draft's hash is in
  // the TICKET_<ACTION>_FILES_HASHED follow-up row.
  const issuedAsIs = ((updates.attachments as TicketAttachment[] | undefined) ?? [])
    .filter((a) => a.type === "Final" && !!a.issuedFromDraftId && !(ticket.attachments ?? []).some((b) => b.id === a.id))
    .map((a) => {
      const bound = rosterSign?.roster.files.find((f) => f.id === a.issuedFromDraftId);
      const base = { id: a.id ?? null, name: a.name ?? null, url: a.url ?? null, rev: a.rev ?? null, issuedFromDraftId: a.issuedFromDraftId };
      return bound ? { ...base, sha256: bound.sha256, ...(bound.sha256 ? {} : { sha256Unavailable: bound.unhashed ?? "not hashed" }) } : base;
    });
  // SM-12: self-assignment names the caller from their membership too
  // (computeTransition would derive it from the email's local part).
  if (action.action === "self_assign" && updates.assigned_drafter_id === caller.id) {
    updates.assigned_drafter_name = memberName(member as { display_name?: unknown; email?: unknown }) ?? callerEmail.split("@")[0];
  }
  // GAP-13 / GAP-107 (DF-P14): the configured reason rides beside the
  // category, on the same compare-and-set write — `metadata.outcome_reason`
  // (the words as they read now, so a later edit of the list never rewrites a
  // closed request; merged just before the write, below, so the close's
  // deliverable note cannot drop it) — and the history line names it.
  if (outcomeReason && "outcome" in updates) {
    const hist = updates.history as TicketHistoryEntry[] | undefined;
    const line = hist?.[hist.length - 1];
    if (line) line.details = `${line.details ? `${line.details} ` : ""}[How it ended: ${OUTCOME_LABEL[outcomeReason.category]} — ${outcomeReason.label}]`;
  }
  // SM-16 (DF-P15): a reopen means the request has not ended, so the reason
  // it ended for goes with its outcome — `metadata.outcome_reason` is removed
  // on the same compare-and-set write that nulls `tickets.outcome`
  // (computeTransition), and the reopen's history line keeps what it was.
  // Without this the old reason rode along to however the request ended next.
  if (action.action === "reopen_ticket") {
    const meta = ((updates.metadata as Record<string, unknown> | undefined) ?? ticket.metadata ?? {}) as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(meta, "outcome_reason")) {
      const old = meta.outcome_reason as { label?: unknown; category?: unknown } | null | undefined;
      const rest = { ...meta };
      delete rest.outcome_reason;
      updates.metadata = rest;
      const oldLabel = typeof old?.label === "string" && old.label.trim() ? old.label.trim() : null;
      if (oldLabel) {
        const cat = isTicketOutcome(old?.category) ? `${OUTCOME_LABEL[old.category]} — ` : "";
        const hist = updates.history as TicketHistoryEntry[] | undefined;
        const line = hist?.[hist.length - 1];
        if (line) line.details = `${line.details ? `${line.details} ` : ""}[The reason it had ended, cleared by the reopen: ${cat}${oldLabel}]`;
      }
    }
  }
  let recipients = transitionRecipients;

  // WF-19 / LEAK-1 (DF-P3): a ticket ENTERING a routed status tells that
  // status's pool — the assignment queue (the DraftingSupervisor pool, falling
  // back to Admins), the IFC issue (the same pool + the originating engineer),
  // and a revision nobody drafts — exactly as the routing policy resolves
  // them at creation (lib/ticketRouting.ts). The default fan-out only knew
  // requester + drafter, so every re-entry landed in the queue silently. The
  // pool joins `unread_by` too (the unread badge and the follow list read
  // that column) and rides the same in-app + email path as every other
  // recipient.
  const drafterAfter = ("assigned_drafter_id" in updates ? updates.assigned_drafter_id : ticket.assignedDrafterId) as string | null | undefined;
  const engineerAfter = ("assigned_engineer_id" in updates ? updates.assigned_engineer_id : ticket.assignedEngineerId) as string | null | undefined;
  if (newStatus !== ticket.status && isRoutedStatus(newStatus, { assignedDrafterId: drafterAfter })) {
    try {
      const pool = (await resolveTicketRecipients(ticket.orgId, newStatus, caller.id, supabaseAdmin, { assignedDrafterId: drafterAfter, assignedEngineerId: engineerAfter }))
        .map((m) => m.uid);
      if (pool.length > 0) {
        const unread = new Set<string>([...((updates.unread_by as string[] | undefined) ?? []), ...pool]);
        unread.delete(caller.id);
        updates.unread_by = Array.from(unread);
        recipients = Array.from(new Set([...recipients, ...pool])).filter((u) => u !== caller.id);
      }
    } catch (e) {
      console.warn("[workflow-action] assignment-queue routing failed (non-blocking)", e);
    }
  }

  // DCW-4 / HAND-3 (DF-P1): a close believes a recorded "published"
  // deliverable only when the register backs it: a version of the source
  // document, in this org, carrying this ticket as its provenance (the proof
  // /api/tickets/handback checks before it records one). The register is read
  // HERE, before anything is written (the hold release below is the first
  // write). The read must SUCCEED: a row means backed, and a successful read
  // with no row means unbacked. A failed read (a timeout, a dropped
  // connection) proves nothing, so it is a 503 with nothing written. It never
  // rewrites a real publication as "not in the register". An id that is not a
  // UUID cannot name a register row: unbacked, with no read (and no
  // invalid-input error that would block every close).
  let unbackedPublish = false;
  if (newStatus === "CLOSED") {
    const closeSrc = parseSourceDocument(ticket.metadata);
    const recordedState = deliverableStateOf(ticket.metadata);
    if (closeSrc?.id && recordedState?.state === "published") {
      if (!UUID_RE.test(String(recordedState.version_id)) || !UUID_RE.test(closeSrc.id)) {
        unbackedPublish = true;
      } else {
        const { data: backing, error: backingErr } = await supabaseAdmin
          .from("document_versions").select("id")
          .eq("id", recordedState.version_id).eq("org_id", ticket.orgId)
          .eq("record_id", closeSrc.id).eq("related_ticket_id", body.ticketId)
          .maybeSingle();
        if (backingErr) {
          console.error(`[workflow-action] register read failed while closing ticket ${body.ticketId}: ${backingErr.message}`);
          return NextResponse.json(
            { error: "The document register could not be read to confirm this request's published deliverable, so the request was not closed. Try again in a moment.", code: "register_unreadable" },
            { status: 503 },
          );
        }
        unbackedPublish = !backing;
      }
    } else if (!closeSrc?.id && ticket.libraryId && recordedState?.state === "published") {
      // DCW-4 (DF-P15): a library-only request now records a publication too
      // ("Publish as a new document in <library>", /api/tickets/handback) —
      // and the close believes it on the same terms: a version in this org,
      // of the document the record names, carrying this ticket as its
      // provenance — and (DF-P15 fix, on review) of a document that is in
      // the request's library, in its org, as /api/tickets/handback requires
      // before it records one. Same read rules as above (a failed read is a
      // 503 with nothing written; a non-UUID id is unbacked with no read).
      const recordedDoc = String(recordedState.document_id ?? "");
      if (!UUID_RE.test(String(recordedState.version_id)) || !UUID_RE.test(recordedDoc)) {
        unbackedPublish = true;
      } else {
        const registerUnreadable = (message: string) => {
          console.error(`[workflow-action] register read failed while closing ticket ${body.ticketId}: ${message}`);
          return NextResponse.json(
            { error: "The document register could not be read to confirm this request's published deliverable, so the request was not closed. Try again in a moment.", code: "register_unreadable" },
            { status: 503 },
          );
        };
        const { data: backing, error: backingErr } = await supabaseAdmin
          .from("document_versions").select("id")
          .eq("id", recordedState.version_id).eq("org_id", ticket.orgId)
          .eq("record_id", recordedDoc).eq("related_ticket_id", body.ticketId)
          .maybeSingle();
        if (backingErr) return registerUnreadable(backingErr.message);
        if (!backing) {
          unbackedPublish = true;
        } else {
          const { data: backingDoc, error: backingDocErr } = await supabaseAdmin
            .from("documents").select("id, library_id")
            .eq("id", recordedDoc).eq("org_id", ticket.orgId)
            .maybeSingle();
          if (backingDocErr) return registerUnreadable(backingDocErr.message);
          unbackedPublish = !backingDoc || (backingDoc as { library_id?: string | null }).library_id !== ticket.libraryId;
        }
      }
    } else if (!closeSrc?.id && !ticket.libraryId && recordedState?.state === "published") {
      // DCW-4 remainder (ruled by the integrator at the DF-P15 merge,
      // 2026-10-20, DEC-90): a request with NEITHER a source document NOR a
      // library records a publication into a library its publisher chose
      // (/api/tickets/handback, which checked the publisher's authority
      // there). The close believes it on the same terms as the library-only
      // branch above: a version in this org, of the recorded document,
      // carrying this ticket — and the recorded publication's document must
      // still exist in the register, in this org, in a library (the one the
      // record names, when it names one). Same read rules (a failed read is a
      // 503 with nothing written; a non-UUID id is unbacked with no read).
      const recordedDoc = String(recordedState.document_id ?? "");
      const recordedLib = (recordedState as { library_id?: unknown }).library_id;
      if (!UUID_RE.test(String(recordedState.version_id)) || !UUID_RE.test(recordedDoc)) {
        unbackedPublish = true;
      } else {
        const registerUnreadable = (message: string) => {
          console.error(`[workflow-action] register read failed while closing ticket ${body.ticketId}: ${message}`);
          return NextResponse.json(
            { error: "The document register could not be read to confirm this request's published deliverable, so the request was not closed. Try again in a moment.", code: "register_unreadable" },
            { status: 503 },
          );
        };
        const { data: backing, error: backingErr } = await supabaseAdmin
          .from("document_versions").select("id")
          .eq("id", recordedState.version_id).eq("org_id", ticket.orgId)
          .eq("record_id", recordedDoc).eq("related_ticket_id", body.ticketId)
          .maybeSingle();
        if (backingErr) return registerUnreadable(backingErr.message);
        if (!backing) {
          unbackedPublish = true;
        } else {
          const { data: backingDoc, error: backingDocErr } = await supabaseAdmin
            .from("documents").select("id, library_id")
            .eq("id", recordedDoc).eq("org_id", ticket.orgId)
            .maybeSingle();
          if (backingDocErr) return registerUnreadable(backingDocErr.message);
          const docLib = (backingDoc as { library_id?: string | null } | null)?.library_id ?? null;
          unbackedPublish = !backingDoc || !docLib || (typeof recordedLib === "string" && docLib !== recordedLib);
        }
      }
    }
  }

  // LIFE-6 / DEC-25: a ticket cannot close silently over a hold it opened.
  // The closer releases it now, or records why it stays — never auto-release.
  // WF-17: the gate keys on the TERMINAL TRANSITION, not the action name —
  // `cancel_request` (DEC-14) ends the ticket exactly as a close does, so it
  // meets the same 409 holds_open and the same release-or-keep resolution.
  // EVID-12 / SM-7 (DF-P1): the hold read and its 409 come first; the release
  // or keep WRITES wait until the transition itself has landed (after the
  // compare-and-set, below), so a close that loses its race touches no hold.
  const TERMINAL_STATUSES: readonly string[] = ["CLOSED", "CANCELED"];
  let holdPlan: {
    holds: Array<{ id: string; document_id: string; reason: string; notes: string | null }>;
    resolution: NonNullable<Body["holdResolution"]>;
    reason: string;
  } | null = null;
  if (TERMINAL_STATUSES.includes(String(newStatus))) {
    const { data: openHolds, error: holdsErr } = await supabaseAdmin
      .from("document_holds")
      .select("id, document_id, reason, notes")
      .eq("origin_ticket_id", body.ticketId)
      .is("released_at", null);
    if (holdsErr && !/origin_ticket_id/.test(holdsErr.message)) {
      return NextResponse.json({ error: `Couldn't check this ticket's holds: ${holdsErr.message}` }, { status: 500 });
    }
    const holds = (openHolds ?? []) as Array<{ id: string; document_id: string; reason: string; notes: string | null }>;
    if (holds.length > 0) {
      const resolution = body.holdResolution ?? null;
      const reason = (resolution?.reason ?? "").trim();
      if (!resolution || (resolution.action === "keep" && !reason)) {
        return NextResponse.json({
          error: "This request opened a hold that is still active. Release it, or record why it stays, before closing.",
          code: "holds_open",
          holds: holds.map((h) => ({ id: h.id, documentId: h.document_id, reason: h.reason })),
        }, { status: 409 });
      }
      holdPlan = { holds, resolution, reason };
    }
  }

  // Audit — server-written, cannot be skipped by the client.
  // EVID-12 / SM-7 (DF-P1, the fleet plan's default): the row is written
  // BEFORE anything is applied — before the ticket's compare-and-set, the
  // first write (the hold release waits for the compare-and-set to land). A
  // transition whose audit row cannot be written is
  // refused: a 500 with nothing applied, so a retry is safe. It is never
  // "ok" with a missing row. The row carries a fixed id: a retry after a lost
  // reply finds it there (23505) instead of writing it twice. If the
  // transition then does not land (a lost compare-and-set, a refused write),
  // a TICKET_<ACTION>_NOT_APPLIED row names this row's id, so the trail never
  // shows a transition that did not happen as one that did. audit_logs stays
  // append-only: no row is ever updated. The details name what was decided
  // on: the deliverable revision, and the identity of every file the action
  // carried or approved.
  const auditRowId = crypto.randomUUID();
  // SM-7 (DF-P8): the transition's own history line names this audit row
  // (`attempt`), written in the same compare-and-set as the status — so the
  // ticket itself proves whether the attempt landed. The maintenance drain
  // (lib/ticketAuditDrain.ts) reads it to write the TICKET_<ACTION>_NOT_APPLIED
  // row this route could only log when that row failed twice; the attempt row
  // says it is checkable (`historyAttempt`). Nothing else in the update moves.
  let historyAttempt = false;
  if (Array.isArray(updates.history) && transitionHistoryEntry) {
    const hist = updates.history as Array<Record<string, unknown>>;
    const at = hist.lastIndexOf(transitionHistoryEntry as unknown as Record<string, unknown>);
    if (at >= 0) {
      hist[at] = { ...hist[at], attempt: auditRowId };
      historyAttempt = true;
    }
  }
  const auditRow = {
    id: auditRowId,
    action: `TICKET_${action.action.toUpperCase()}`,
    resource_id: body.ticketId,
    resource_type: "ticket",
    org_id: ticket.orgId,
    user_id: caller.id,
    user_email: callerEmail,
    user_role: callerRole,
    details: {
      from: ticket.status, to: newStatus, label: action.label, authority,
      deliverable_rev: (updates.deliverable_rev as string | null | undefined) ?? ticket.deliverableRev ?? null,
      // WF-9 / WF-18: the audit row names WHAT was attached or WHO now drafts.
      ...(vetted.attachment
        ? { attachment: { ...fileIdentity(vetted.attachment, vettedEtags.attachment), type: vetted.attachment.type } }
        : {}),
      ...(vetted.finalAttachment ? { finalAttachment: fileIdentity(vetted.finalAttachment, vettedEtags.finalAttachment) } : {}),
      ...(vetted.redlineAttachment ? { redlineAttachment: fileIdentity(vetted.redlineAttachment, vettedEtags.redlineAttachment) } : {}),
      ...(APPROVING_ACTIONS.has(action.action)
        ? { approvedDrafts: (ticket.attachments ?? []).filter((a) => a?.type === "Draft" && a.status === "submitted").map((a) => fileIdentity(a, null)) }
        : {}),
      ...(hashKeys.length > 0 ? { filesHashedIn: filesHashedAction } : {}),
      // EVID-12 (DF-P5 fix pass 2): the sign-off that COMPLETES a roster is
      // the approval — its row names what was approved (the files the
      // roster bound every sign-off to, with their sha256 or the reason one
      // could not be taken) exactly as a serial approval's row does.
      ...(rosterSign?.complete
        ? { approvedDrafts: rosterSign.roster.files.map((f) => ({ id: f.id, name: f.name, url: f.url, sha256: f.sha256, ...(f.sha256 ? {} : { sha256Unavailable: f.unhashed ?? "not hashed" }) })) }
        : {}),
      // FRIC-5 (fix pass 2): an approval that issued the draft as-is names
      // the Final(s) it recorded — the same bytes as the approved Draft
      // (issuedFromDraftId), with that Draft's sha256 when one was taken.
      ...(issuedAsIs.length > 0 ? { issuedAsIsFinals: issuedAsIs } : {}),
      // GAP-103 (DF-P5): the roster this transition opened, signed or closed
      // — its id, the content hash every sign-off is bound to, and each
      // slot touched (DEC-37: every slot satisfied, and by whom).
      ...(rosterOpen
        ? { reviewRoster: { id: rosterOpen.id, event: "opened", level: rosterOpen.level, contentHash: rosterOpen.contentHash, files: rosterOpen.files, ...(rosterOpen.engineeringGateAdded ? { engineeringGateAdded: true } : {}), slots: rosterOpen.slots.map((x) => ({ kind: x.kind, label: x.label, mode: x.mode, occupants: x.primaries.length, fallback: x.fallback })) } }
        : rosterSign
          ? { reviewRoster: { id: rosterSign.roster.id, event: "signed", contentHash: rosterSign.roster.contentHash, signatureId: body.signatureId ?? null, complete: rosterSign.complete, slots: rosterSign.roster.slots.filter((x) => x.signatureId === body.signatureId).map((x) => ({ kind: x.kind, label: x.label, via: x.via ?? null })), ...examinationAuditFields(examination) } }
          : openRosterNow && newStatus !== "PENDING_REVIEW"
            ? { reviewRoster: { id: openRosterNow.id, event: "closed", reason: action.action, ...examinationAuditFields(examination) } }
            : {}),
      ...(rosterWarning ? { reviewRosterNotOpened: rosterWarning } : {}),
      // DF-P6: the review model's facts this decision was made on — the
      // engineering requirement (null before 20261250), a declared minor
      // correction (TIER-7), the classes triage set, a moved source.
      ...(ISSUING_APPROVALS.has(action.action) || action.action === "flag_engineering" || action.action === "request_eng_review"
        ? { engineeringRequired: reviewModelColumns ? ticket.engineeringRequired === true : null, likeInKindDeclared: !!ticket.likeInKindDeclaredAt, reviewModelFiled: typeof ticket.reviewModelFiled === "boolean" ? ticket.reviewModelFiled : null }
        : {}),
      ...(action.action === "approve_minor_correction" ? { declaredClass: "minor_correction" } : {}),
      // TIER-7 (DF-P18): the workspace's minor-correction class the request
      // is of, when it is one (no key otherwise — today's row).
      ...(action.action === "approve_minor_correction" && minorCorrectionClassOf(draftingCfg, ticket.workClass)
        ? { minorCorrectionClass: minorCorrectionClassOf(draftingCfg, ticket.workClass)!.value }
        : {}),
      ...(reviewClass ? { reviewClass: { workClass: reviewClass.workClass?.value ?? null, codeClass: reviewClass.codeClass?.value ?? null } } : {}),
      ...(sourceDrift ? { sourceDrift: { moved: sourceDrift.labels, acknowledged: sourceDrift.acknowledged === true } } : {}),
      // DF-P18 fix pass 2 (review, major): an approval applied over a source
      // that could not be read says so (the base's key, restored).
      // (Only an issuing approval or a sign-off ever reads the documents.)
      ...(sourceDriftUnchecked ? { sourceDriftUnchecked: true } : {}),
      // GAP-102 acceptance 4 (DF-P24): the examination data an issue was
      // checked against (only where a requirement applies — no key otherwise).
      ...(examinationScopeAudit ? { examinationScope: examinationScopeAudit } : {}),
      // GAP-115 (DF-P26): what the exception-only rule did (only on a roster
      // with an exception-only slot — no key otherwise).
      ...(exceptionReview ? { exceptionReview } : {}),
      // DF-P6 fix pass (minor 11): a declaration whose e-signature is not on
      // record (or could not be read) was evaluated as undeclared.
      ...(declarationUnverified ? { declarationUnverified } : {}),
      // Fix pass 2 (major 2): the active-member count could not be read —
      // this action was evaluated with separation of duties active.
      ...(memberCountUnchecked ? { memberCountUnchecked: true } : {}),
      // EDGE-19 (DF-P17 final fix pass): a vetted file's renumbered-request
      // check could not be read — the file got today's answer.
      ...(renumberedSiblingUnchecked ? { renumberedSiblingUnchecked: true } : {}),
      ...(action.action === "reassign_drafter" && body.assignment
        ? { from_drafter_id: ticket.assignedDrafterId ?? null, to_drafter_id: body.assignment.id, reason: body.comment ?? null }
        : {}),
      // LEAK-9 / GAP-107 (DF-P3): how the request is meant to have ended,
      // and whether the category was named. Written before the write lands:
      // `outcomeIntended`, never a claim that it was stored — when the column
      // is not there yet the write retries without it and a
      // TICKET_<ACTION>_OUTCOME_NOT_STORED row follows (below).
      ...(TERMINAL_STATUSES.includes(String(newStatus))
        ? { outcomeIntended: (updates.outcome as string | null | undefined) ?? null, ...(outcomeDefaulted ? { outcomeDefaulted: true } : {}), ...(outcomeReason ? { outcomeReason: { id: outcomeReason.id, label: outcomeReason.label } } : {}), ...(outcomeReasonUnchecked ? { outcomeReasonUnchecked: true } : {}) }
        : {}),
      // LEAK-1 done-when 3 (DF-P3): how many people this transition resolves
      // to, BEFORE the active-members filter fanOut applies — a transition
      // that resolves to nobody is visible in the trail; one whose people are
      // all inactive is logged by fanOut.
      recipientsResolved: recipients.length,
      // Written before the compare-and-set; a TICKET_<ACTION>_NOT_APPLIED row
      // naming this id follows when the transition did not land.
      recordedBeforeApply: true,
      ...(historyAttempt ? { historyAttempt: true } : {}),
    },
  };
  const auditErr = await insertAuditRowOnce(auditRow);
  if (auditErr) {
    console.error(`[workflow-action] AUDIT ROW NOT WRITTEN for ${auditRow.action} on ticket ${body.ticketId} (${ticket.status} → ${newStatus}) by ${caller.id}: ${auditErr} — the transition was refused, nothing applied`);
    return NextResponse.json({
      error: "The action was not applied: its audit record could not be written. Nothing changed — try again in a moment.",
      code: "audit_unwritable",
      applied: false,
    }, { status: 500 });
  }
  // The attempt row above stands for a transition that did not land: say so,
  // naming it. Retried once (fixed id, 23505 = landed); a failure is LOGGED
  // with both ids so the trail can be reconciled against the ticket's history.
  const recordNotApplied = async (reason: "conflict" | "write_failed", error?: string) => {
    const notApplied = {
      id: crypto.randomUUID(),
      action: `${auditRow.action}_NOT_APPLIED`,
      resource_id: body.ticketId,
      resource_type: "ticket",
      org_id: ticket.orgId,
      user_id: caller.id,
      user_email: callerEmail,
      user_role: callerRole,
      details: { attempt: auditRow.id, from: ticket.status, to: newStatus, reason, ...(error ? { error } : {}) },
    };
    const err = await insertAuditRowOnce(notApplied);
    if (err) {
      console.error(`[workflow-action] could not record that ${auditRow.action} (audit row ${auditRow.id}) on ticket ${body.ticketId} was NOT applied (${reason}) — reconcile from the ticket's history: ${err}`);
    }
  };

  // Compare-and-set on the status we validated against. If another reviewer
  // moved the ticket since, refuse to clobber their transition.
  // CAS on status AND last-modified: status alone let two no-status-change
  // actions (save_progress, comments) interleave and clobber each other's
  // whole-array attachments/comments/history writes.
  // LIFE-1 / GAP-6 (acceptance 5): closing a ticket that was raised against a
  // controlled document and produced no register revision leaves a VISIBLE,
  // QUERYABLE state on the ticket (`metadata.deliverable.state =
  // "not_in_register"`), a history line, and a note to the people told about
  // the close — never silence. It never publishes anything (DEC-22).
  let handbackNote: string | null = null;
  if (newStatus === "CLOSED") {
    // TIER-5 (DF-P5 fix pass 3): every note below is built on the metadata
    // the TRANSITION produced, never the stored row's — a close out of a
    // review closes its roster (lib/ticketTransitions.ts: closedAt, open
    // slots void), and rebuilding from the stored row put the open roster
    // back, so a reopen revived the previous cycle's sign-offs.
    const closeMeta = ((updates.metadata as Record<string, unknown> | undefined) ?? ticket.metadata ?? {}) as Record<string, unknown>;
    try {
      const src = parseSourceDocument(ticket.metadata);
      // DCW-4 / HAND-3 (DF-P1): `unbackedPublish` was decided above, before
      // any write. A "published" state the register does not back (a
      // hand-written state, a version id no register holds) closes as NOT in
      // the register, visibly, never as a green "published".
      const recorded = deliverableStateOf(ticket.metadata);
      if (src?.id && (recorded?.state !== "published" || unbackedPublish)) {
        const { data: docRow } = await supabaseAdmin
          .from("documents").select("rev, document_number").eq("id", src.id).eq("org_id", ticket.orgId).maybeSingle();
        const registerRev = ((docRow as { rev?: string | null } | null)?.rev ?? null);
        const docLabel = ((docRow as { document_number?: string | null } | null)?.document_number) || src.documentNumber || "the source document";
        const base = unbackedPublish ? { ...closeMeta, deliverable: undefined } : closeMeta;
        const merged = noteDeliverableNotInRegister(base, { documentId: src.id, registerRev });
        if (merged) {
          updates.metadata = merged;
          handbackNote = unbackedPublish
            ? `Closed without a register revision: the recorded publication could not be matched to a revision of ${docLabel} in the register, which remains at Rev ${registerRev ?? "—"}. The deliverable is treated as not published.`
            : `Closed without a register revision: ${docLabel} remains at Rev ${registerRev ?? "—"}. The deliverable was not published as a revision.`;
          const history = Array.isArray(updates.history) ? (updates.history as Array<Record<string, unknown>>) : [...(ticket.history ?? [])];
          updates.history = [...history, { action: "Closed — deliverable not in the register", user: callerEmail, role: callerRole, date: new Date().toISOString(), details: handbackNote, actorId: caller.id }];
        }
      } else if (!src?.id && ticket.libraryId && (recorded?.state !== "published" || unbackedPublish)) {
        // DCW-4 (DF-P4): a request with no source document but a target
        // library (GAP-105) that closes without its deliverable in that
        // library is said too — the register visibly knows it does not have
        // it. (Publishing it as a new document of the library is the
        // document-creation path's, not this route's: DEC-22.)
        // DF-P4 fix pass: the note is read by the requester and every
        // watcher, so a hidden / private library — or one whose ACL carries
        // any rule — is "the target library" (libraryLabelForTicket), never
        // its name.
        // intelligence DACL-10 remainder (DF-P15, the I-31 merge's
        // assignment): the label reads the library's EFFECTIVE ACL — the
        // rung's columns (LIBRARY_RUNG_COLUMNS) through libraryChoiceFromRow,
        // as the triage check above does (DACL-13 R1) — so its answer is the
        // same before and after 20261228 writes a legacy library's role lists
        // into its ACL: an open legacy library keeps its name, a restricted
        // one is "the target library" on both sides. A label only, never an
        // access decision.
        const { data: libRow } = await supabaseAdmin
          .from("libraries").select(`id, name, ${LIBRARY_RUNG_COLUMNS}`).eq("id", ticket.libraryId).eq("org_id", ticket.orgId).maybeSingle();
        const libLabel = libraryLabelForTicket(libRow ? libraryChoiceFromRow(libRow as unknown as Record<string, unknown>) : null);
        // DCW-4 (DF-P15): a "published" record the register does not back is
        // replaced, visibly, as for a request with a source document.
        const libBase = unbackedPublish ? { ...closeMeta, deliverable: undefined } : closeMeta;
        const merged = noteDeliverableNotInLibrary(libBase, { libraryId: ticket.libraryId });
        if (merged) {
          updates.metadata = merged;
          handbackNote = unbackedPublish
            ? `Closed without a register document: the recorded publication could not be matched to a document in ${libLabel}. The deliverable is treated as not published.`
            : `Closed without a register document: the deliverable was not published into ${libLabel}.`;
          const history = Array.isArray(updates.history) ? (updates.history as Array<Record<string, unknown>>) : [...(ticket.history ?? [])];
          updates.history = [...history, { action: "Closed — deliverable not in the register", user: callerEmail, role: callerRole, date: new Date().toISOString(), details: handbackNote, actorId: caller.id }];
        }
      } else if (!src?.id && !ticket.libraryId && recorded?.state === "published" && unbackedPublish) {
        // DCW-4 remainder (DEC-90 ruling at the DF-P15 merge): a library-less
        // request's recorded publication the register does not back is
        // replaced, visibly — the false "published" removed, and the library
        // the record named (if any) noted as not holding the deliverable. A
        // library-less request with nothing recorded closes exactly as before
        // (no metadata written).
        const recordedLib = (recorded as { library_id?: unknown }).library_id;
        const base: Record<string, unknown> = { ...closeMeta };
        delete base.deliverable;
        let label = "the register";
        if (typeof recordedLib === "string" && recordedLib) {
          const { data: libRow } = await supabaseAdmin
            .from("libraries").select(`id, name, ${LIBRARY_RUNG_COLUMNS}`).eq("id", recordedLib).eq("org_id", ticket.orgId).maybeSingle();
          const named = libraryLabelForTicket(libRow ? libraryChoiceFromRow(libRow as unknown as Record<string, unknown>) : null);
          label = named === UNNAMED_TARGET_LIBRARY ? "the library it named" : named;
        }
        updates.metadata = typeof recordedLib === "string" && recordedLib ? (noteDeliverableNotInLibrary(base, { libraryId: recordedLib }) ?? base) : base;
        handbackNote = `Closed without a register document: the recorded publication could not be matched to a document in ${label}. The deliverable is treated as not published.`;
        const history = Array.isArray(updates.history) ? (updates.history as Array<Record<string, unknown>>) : [...(ticket.history ?? [])];
        updates.history = [...history, { action: "Closed — deliverable not in the register", user: callerEmail, role: callerRole, date: new Date().toISOString(), details: handbackNote, actorId: caller.id }];
      } else if (!src?.id && !ticket.libraryId && recorded?.state !== "published" && latestFinalAttachment(ticket.attachments)) {
        // DCW-4 remainder (DF-P8; DEC-90 ruling (5) for DF-P8): a request with
        // neither a source document nor a library (DEC-107) that closes with
        // an issued (Final) deliverable never published records that the
        // register does not have it — the state (no document, no library),
        // the history line and the note, as DF-P4 did for a library-only
        // request. A library-less request with no Final closes exactly as
        // before (nothing written); the close itself is unchanged either way.
        const merged = noteDeliverableNotInAnyRegister(closeMeta);
        if (merged) {
          updates.metadata = merged;
          handbackNote = "Closed without a register document: the issued deliverable was not published into the register. This request names no library, so no register holds it — publish it as a new document to put it under control.";
          const history = Array.isArray(updates.history) ? (updates.history as Array<Record<string, unknown>>) : [...(ticket.history ?? [])];
          updates.history = [...history, { action: "Closed — deliverable not in the register", user: callerEmail, role: callerRole, date: new Date().toISOString(), details: handbackNote, actorId: caller.id }];
        }
      }
    } catch (e) {
      console.warn("[workflow-action] deliverable-state note failed (non-blocking)", e);
    }
  }
  // GAP-13 / GAP-107 (DF-P14 fix pass): the accepted reason is merged into
  // the metadata LAST — after the close's deliverable note, which replaces
  // `metadata` (built on the transition's since DF-P5 fix pass 3).
  if (outcomeReason && "outcome" in updates) {
    updates.metadata = {
      ...(((updates.metadata as Record<string, unknown> | undefined) ?? ticket.metadata ?? {}) as Record<string, unknown>),
      outcome_reason: { id: outcomeReason.id, label: outcomeReason.label, category: outcomeReason.category },
    };
  }
  const transitionNote = [body.comment ?? null, handbackNote].filter((x): x is string => !!x && x.trim().length > 0).join("\n\n") || null;
  // WF-9: attaching a file is thread ACTIVITY, not a workflow transition —
  // the ticket is in the same state waiting on the same person afterwards.
  // It must not retire the outstanding workflow alerts ("you were assigned")
  // or queue a status-change email; it leaves a comment-style bell row.
  // AUTHZ-11: the bell and email text names the VETTED record (name trimmed
  // and capped, type checked), never the client's claim about the file.
  const isActivity = action.action === "attach_file";
  const fanOutComment = isActivity
    ? (vetted.attachment ? `Added ${vetted.attachment.type} file: ${vetted.attachment.name}` : null)
    : transitionNote;

  let baseQuery = supabaseAdmin
    .from("tickets")
    .update(updates)
    .eq("id", body.ticketId)
    .eq("status", ticket.status);
  // EDGE-15: a row with no token compare-and-sets on the null itself — the
  // first writer stamps it and a concurrent second gets the 409 — instead of
  // dropping to a status-only check.
  baseQuery = ticket.lastModified
    ? baseQuery.eq("last_modified", String(ticket.lastModified))
    : baseQuery.is("last_modified", null);
  // GAP-109 (DF-P7): an objection lands only on a window still running — the
  // cron's close of the same window changes last_modified, and either way
  // these two keep the first act the only one.
  if (action.action === "object_consent_window") baseQuery = baseQuery.is("consent_window_expired_at", null).is("consent_window_objected_at", null);
  let { data: updated, error: updErr } = await baseQuery
    .select("id")
    .maybeSingle();
  // LEAK-9 (DF-P3): before 20261195 is pasted the `outcome` column is not
  // there — the write retries without it (today's path: that request's
  // outcome is not recorded) rather than refusing the close or the cancel.
  let outcomeNotStored = false;
  let intendedOutcome: string | null = null;
  if (updErr && (updErr.code === "PGRST204" || updErr.code === "42703") && "outcome" in updates && /outcome/.test(updErr.message ?? "")) {
    console.warn(`[workflow-action] tickets.outcome is not in the database yet (20261195 not pasted) — ${action.action} on ticket ${body.ticketId} is applied without it`);
    intendedOutcome = (updates.outcome as string | null | undefined) ?? null;
    delete updates.outcome;
    let noOutcome = supabaseAdmin
      .from("tickets")
      .update(updates)
      .eq("id", body.ticketId)
      .eq("status", ticket.status);
    noOutcome = ticket.lastModified
      ? noOutcome.eq("last_modified", String(ticket.lastModified))
      : noOutcome.is("last_modified", null);
    ({ data: updated, error: updErr } = await noOutcome
      .select("id")
      .maybeSingle());
    if (!updErr && updated) outcomeNotStored = true;
  }
  // Pre-migration tolerance: if the deliverable-rev columns (20260827) aren't
  // deployed yet, retry without them so the workflow itself never blocks on a
  // pending migration.
  if (updErr && (updErr.code === "PGRST204" || updErr.code === "42703") &&
      ("deliverable_rev" in updates || "draft_iteration" in updates)) {
    const { deliverable_rev: _dr, draft_iteration: _di, ...tolerant } = updates;
    void _dr; void _di;
    let tolerantQuery = supabaseAdmin
      .from("tickets")
      .update(tolerant)
      .eq("id", body.ticketId)
      .eq("status", ticket.status);
    tolerantQuery = ticket.lastModified
      ? tolerantQuery.eq("last_modified", String(ticket.lastModified))
      : tolerantQuery.is("last_modified", null);
    ({ data: updated, error: updErr } = await tolerantQuery
      .select("id")
      .maybeSingle());
  }
  if (updErr) {
    await recordNotApplied("write_failed", updErr.message);
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }
  if (!updated) {
    await recordNotApplied("conflict");
    return NextResponse.json(
      { error: "The ticket changed while you were acting — refresh and try again", conflict: true },
      { status: 409 },
    );
  }
  // LEAK-9 (DF-P3, DEC-29): the attempt row names the outcome the action
  // meant to record; when the write landed without the column (20261195 not
  // pasted yet) the trail says so, naming the attempt — never a recorded
  // outcome the row does not carry. A failure to say so is logged.
  if (outcomeNotStored) {
    const notStoredErr = await insertAuditRowOnce({
      id: crypto.randomUUID(),
      action: `${auditRow.action}_OUTCOME_NOT_STORED`,
      resource_id: body.ticketId,
      resource_type: "ticket",
      org_id: ticket.orgId,
      user_id: caller.id,
      user_email: callerEmail,
      user_role: callerRole,
      details: { attempt: auditRow.id, outcomeIntended: intendedOutcome, reason: "tickets.outcome is not in the database yet (20261195 not pasted)" },
    });
    if (notStoredErr) {
      console.error(`[workflow-action] ${auditRow.action} (audit row ${auditRow.id}) on ticket ${body.ticketId} was applied WITHOUT its outcome, and that could not be recorded: ${notStoredErr}`);
    }
  }

  // LIFE-6 / DEC-25: the closer's hold resolution, applied only now that the
  // ticket has actually closed or been canceled. EVID-12 / SM-7 (DF-P1): a
  // close or cancel that loses its compare-and-set (above) has released no
  // hold and written no hold row, so its TICKET_<ACTION>_NOT_APPLIED row is
  // the whole truth. A release that fails here cannot un-close the ticket.
  // The hold stays active, the conservative state: the document stays
  // blocked and can be released from its hold panel. The release is retried
  // once. A second failure is recorded as a TICKET_<ACTION>_HOLDS_NOT_RELEASED
  // row naming the attempt row and the holds, logged, and returned to the
  // caller as `warning` / `holdsNotReleased` with the 200 (the transition
  // stands). It is never silent.
  let holdOutcome: { warning: string; holdsNotReleased: string[] } | null = null;
  if (holdPlan) {
    const { holds, resolution, reason } = holdPlan;
    if (resolution.action === "release") {
      const nowIso = new Date().toISOString();
      // A throw is a failure like a refused update: the transition has landed,
      // so nothing here may turn it into a 500.
      const releaseHolds = async (): Promise<{ data: unknown[] | null; error: { message: string } | null }> => {
        try {
          const { data, error } = await supabaseAdmin
            .from("document_holds")
            .update({ released_at: nowIso, released_by: caller.id, released_by_name: callerEmail ?? null,
                      released_reason: reason || `Released on ${newStatus === "CANCELED" ? "cancellation" : "close"} of ticket ${ticket.ticketId ?? body.ticketId}` })
            .in("id", holds.map((h) => h.id)).is("released_at", null).select("id");
          return { data: (data as unknown[] | null) ?? null, error: error ? { message: error.message || "update refused" } : null };
        } catch (e) {
          return { data: null, error: { message: (e as Error)?.message ?? String(e) } };
        }
      };
      let { data: released, error: relErr } = await releaseHolds();
      if (relErr) ({ data: released, error: relErr } = await releaseHolds());
      if (relErr) {
        const holdIds = holds.map((h) => h.id);
        console.error(`[workflow-action] ${auditRow.action} (audit row ${auditRow.id}) on ticket ${body.ticketId} landed (${newStatus}) but its hold(s) ${holdIds.join(", ")} could not be released; they stay active: ${relErr.message}`);
        const followErr = await insertAuditRowOnce({
          id: crypto.randomUUID(),
          action: `${auditRow.action}_HOLDS_NOT_RELEASED`,
          resource_id: body.ticketId,
          resource_type: "ticket",
          org_id: ticket.orgId,
          user_id: caller.id,
          user_email: callerEmail,
          user_role: callerRole,
          details: { attempt: auditRow.id, to: newStatus, holdIds, error: relErr.message },
        });
        if (followErr) {
          console.error(`[workflow-action] could not record that the holds of ${auditRow.action} (audit row ${auditRow.id}) on ticket ${body.ticketId} were NOT released: ${followErr}`);
        }
        holdOutcome = {
          warning: `The request was ${newStatus === "CANCELED" ? "canceled" : "closed"}, but its hold could not be released, so the document is still blocked. Release the hold from the document.`,
          holdsNotReleased: holdIds,
        };
      } else {
        for (const h of holds) {
          await supabaseAdmin.from("audit_logs").insert({
            action: "HOLD_RELEASED", resource_type: "document", resource_id: h.document_id, org_id: ticket.orgId,
            user_id: caller.id, user_email: callerEmail ?? null,
            details: { holdId: h.id, reason: h.reason, releasedReason: reason || null, viaTicketClose: body.ticketId, released: (released ?? []).length },
          }).then(() => undefined, () => undefined);
        }
      }
    } else {
      for (const h of holds) {
        await supabaseAdmin.from("audit_logs").insert({
          action: "HOLD_KEPT_ON_CLOSE", resource_type: "document", resource_id: h.document_id, org_id: ticket.orgId,
          user_id: caller.id, user_email: callerEmail ?? null,
          details: { holdId: h.id, reason: h.reason, keptBecause: reason, ticketId: body.ticketId, ticketOutcome: newStatus },
        }).then(() => undefined, () => undefined);
      }
    }
  }

  // GAP-103 (DF-P5): the roster's ledger (20261242), written as the service
  // role now that the transition has landed — the slots a submission opened,
  // the slots a sign-off satisfied, or the open slots a revision / cancel /
  // close voided, one event row each. Checked and retried once; a failure
  // cannot undo the landed transition, so it is logged with both ids and
  // returned as `warning` (the ticket row and the audit row carry the
  // roster; the ledger can be reconciled from them).
  {
    const actorRef = { uid: caller.id, name: memberName(member as { display_name?: unknown; email?: unknown }) };
    let ledgerErr: string | null = null;
    if (rosterOpen) {
      ledgerErr = await writeRosterLedger(supabaseAdmin, { orgId: ticket.orgId, ticketId: body.ticketId, roster: rosterOpen, event: "opened", slots: rosterOpen.slots, actor: actorRef });
      // GAP-115 (DF-P26): the rule's satisfaction, its own event (via "rule").
      if (!ledgerErr && exceptionRuleOpenLabels.length > 0) {
        ledgerErr = await writeRosterLedger(supabaseAdmin, { orgId: ticket.orgId, ticketId: body.ticketId, roster: rosterOpen, event: "satisfied", slots: ruleSatisfiedSlots(rosterOpen), actor: { uid: null, name: EXCEPTION_RULE_ACTOR } });
      }
    } else if (rosterSign) {
      const touched = rosterSign.roster.slots.filter((x) => x.signatureId === body.signatureId && x.status === "satisfied");
      ledgerErr = await writeRosterLedger(supabaseAdmin, { orgId: ticket.orgId, ticketId: body.ticketId, roster: rosterSign.roster, event: "satisfied", slots: touched, actor: actorRef, examination });
      // GAP-115 (DF-P26): the re-open — each slot back to open, a "reopened" event.
      if (!ledgerErr && exceptionReopen) {
        ledgerErr = await writeRosterReopen(supabaseAdmin, { orgId: ticket.orgId, ticketId: body.ticketId, roster: rosterSign.roster, slots: exceptionReopen.slots, exceptions: exceptionReopen.exceptions, actor: { uid: null, name: EXCEPTION_RULE_ACTOR } });
      }
    } else if (openRosterNow && newStatus !== "PENDING_REVIEW") {
      const voided = openRosterNow.slots.filter((x) => x.status === "open").map((x) => ({ ...x, status: "void" as const }));
      if (voided.length > 0) {
        ledgerErr = await writeRosterLedger(supabaseAdmin, {
          orgId: ticket.orgId, ticketId: body.ticketId, roster: { ...openRosterNow, closedReason: action.action }, event: "voided", slots: voided, actor: actorRef, reason: action.action, examination,
        });
      }
    }
    if (ledgerErr) {
      // DF-P20 merge-time fix pass (GAP-102): the examination record lives
      // only on this audit row until the ledger is reconciled — the line
      // names it, so the reconciliation copies it into details.examination.
      console.error(`[workflow-action] ${auditRow.action} (audit row ${auditRow.id}) on ticket ${body.ticketId} landed, but the review roster ledger was not written — reconcile from tickets.metadata.review_roster${examination ? `; the examination record for slot(s) ${examination.kinds.join(", ")} is on audit row ${auditRow.id} details.reviewRoster.examination — copy it into each of those slots' event details.examination` : ""}: ${ledgerErr}`);
      rosterWarning = rosterWarning ?? ROSTER_LEDGER_NOT_WRITTEN;
      rosterLedgerNotWritten = true;
    }
  }

  // GAP-109 / GAP-113 (DF-P7): the roster this submission opened carries a
  // consent plan — open its window now that the review exists (DEC-38:
  // open_consent_window writes the notices and the clock in ONE
  // transaction, or nothing; a refusal leaves the slot waiting for a
  // sign-off, said, and the maintenance run retries it), or record the block
  // and tell the assignment queue (DEC-39: an empty set never advances).
  if (rosterOpen?.consentPlan && newStatus === "PENDING_REVIEW") {
    consentWarning = await afterRosterOpened(supabaseAdmin, {
      ticketId: body.ticketId, orgId: ticket.orgId, ticketLabel: `${ticket.ticketId || ""} ${ticket.title}`.trim(),
      roster: rosterOpen, members: consentMembers, policy: capPolicy, resource, requesterId: ticket.requesterId,
      actor: { uid: caller.id, name: memberName(member as { display_name?: unknown; email?: unknown }) },
      // The window's notices are emailed to whoever's preferences allow it
      // (DF-P7 fix pass 2), on the same public origin as the fan-out.
      origin: publicOrigin() || new URL(req.url).origin,
      // FRIC-5 (DF-P7 fix pass 3): the issue-as-is mark this submission left
      // on the draft is named in the notice — the close issues as-is only
      // on a mark the people asked were told of.
      issueAsIs: issueAsIsMarkOf({
        metadata: ((updates.metadata as Record<string, unknown> | undefined) ?? ticket.metadata ?? null),
        deliverableRev: ((updates.deliverable_rev as string | undefined) ?? ticket.deliverableRev ?? null),
      }),
    });
  }
  // GAP-109 mechanism 2 (drafting-flow DF-P22; DEC-90 ruling (2)): a slot
  // the workspace opted in to standing pre-authorization is satisfied by the
  // standing record of a person who would otherwise sign it — never on
  // engineered work, never the engineering or an assurance slot, never the
  // last open sign-off (lib/ticketPreauthorization.ts). Only when the roster
  // has such a slot is anything read; AFTER the response (next/server
  // after(), as the copy recall is — DEC-90 ruling (5): bookkeeping never
  // refuses or delays a person's act), keeping its own audit-first and
  // compare-and-set rails — a failure leaves the slot waiting for its
  // sign-off, logged.
  if (rosterOpen && newStatus === "PENDING_REVIEW" && preauthEligibleSlots(rosterOpen).length > 0) {
    const preauthInput = {
      ticketId: body.ticketId, orgId: ticket.orgId, roster: rosterOpen, engineered: rosterEngineered, members: consentMembers,
      ticketLabel: `${ticket.ticketId || ""} ${ticket.title}`.trim(),
    };
    try {
      after(async () => {
        const pa = await applyStandingPreauthorizations(supabaseAdmin, preauthInput);
        if (pa.note) console.error(`[workflow-action] ticket ${body.ticketId}: standing pre-authorization — ${pa.note}`);
      });
    } catch (e) {
      console.warn(`[workflow-action] the standing pre-authorization step for ticket ${body.ticketId} could not be scheduled (the slots wait for their sign-offs):`, e);
    }
  }
  // The objection's durable record (it survives any bell purge); the
  // ticket's own history and columns already carry it.
  if (action.action === "object_consent_window") {
    const w = currentRoster(ticket)?.consentWindow;
    const evErr = await recordNoticeEvents(supabaseAdmin, [{
      org_id: ticket.orgId, ticket_id: body.ticketId, roster_id: currentRoster(ticket)?.id ?? null, slot_kind: w?.slot ?? null,
      kind: "objected", recipient: caller.id, actor_id: caller.id, actor_name: callerEmail, details: { comment: body.comment ?? null, auditId: auditRow.id },
    }]);
    if (evErr && evErr !== "missing") console.error(`[workflow-action] the objection on ticket ${body.ticketId} landed (audit row ${auditRow.id}) but its notice event was not written — the history carries it: ${evErr}`);
  }

  // Mirror the action's comment into the ticket_comments table so the two comment
  // stores stay in sync — computeTransition only appends to the JSONB thread, and
  // until now workflow comments never reached the table. Best-effort: the JSONB is
  // what the UI renders, so a table hiccup must not fail the transition.
  // SM-7 done-when 2: best-effort is not silent — a failed mirror is retried
  // once and then LOGGED with the comment and ticket ids, so the table can be
  // reconciled from the JSONB thread.
  if (newComment) {
    const mirrorRow = {
      id: newComment.id as string,
      org_id: ticket.orgId,
      ticket_id: body.ticketId,
      author_uid: (newComment.authorUid as string) ?? caller.id,
      author_email: (newComment.user as string) ?? callerEmail,
      author_role: (newComment.role as string) ?? callerRole,
      body: (newComment.text as string) ?? "",
      type: (newComment.type as string) ?? "General",
      category: (newComment.category as string | null) ?? null,
      mentioned_uids: [],
      created_at: (newComment.date as string) ?? new Date().toISOString(),
    };
    const mirror = async (): Promise<string | null> => {
      try {
        const { error } = await supabaseAdmin.from("ticket_comments").insert(mirrorRow);
        if (!error || (error as { code?: string }).code === "23505") return null; // landed (a retry after a lost reply finds it there)
        return error.message || "insert refused";
      } catch (e) {
        return (e as Error)?.message ?? String(e);
      }
    };
    const mirrorErr = (await mirror()) && (await mirror());
    if (mirrorErr) {
      console.error(`[workflow-action] ticket_comments mirror failed for comment ${mirrorRow.id} on ticket ${body.ticketId} — reconcile from tickets.comments: ${mirrorErr}`);
    }
  }

  // Fan-out — also server-side, so it survives the client closing the tab.
  // Failures here never fail the action (the transition is already committed);
  // they're logged for the maintenance cron's visibility.
  // EDGE-9: links in an EMAIL resolve against the mail client, so they are
  // absolute — the configured public origin (lib/publicOrigin.ts, with its
  // server fallback to Vercel's production domain), else the origin this
  // request arrived on.
  const emailOrigin = publicOrigin() || new URL(req.url).origin;
  // GAP-102 acceptance 2 (DF-P26; DEC-90 ruling (3)): an act that ISSUES the
  // request (an issuing approval, or the sign-off that completes the review)
  // tells its people what was recorded about the examination — the scope
  // values, the assurance records, the notify-only holds — names and counts
  // only, one line on the existing notice (lib/issueNoticeExamination.ts).
  // Read only where such a record could exist (issueExaminationMayExist —
  // pure, no read), bounded in time; anything unread leaves the notice
  // exactly as today's. DF-P26 review fix (DEC-90 ruling (4) — bookkeeping
  // never delays a person's act): where such a record could exist, composing
  // the line AND sending the notice run AFTER the response (next/server
  // after(), as the pre-authorization step and the email drain do), so a slow
  // examination read never holds the person's answer. Where none could
  // exist (every unconfigured workspace) the notice is sent in the request,
  // exactly as before.
  const issueNoticeInput = { ticket, ticketId: body.ticketId, orgId: ticket.orgId, draftingCfg: draftingCfgRead ? scopeDraftingCfg : null, roster: rosterSign?.roster ?? null };
  const issuingAct = ISSUING_APPROVALS.has(action.action) || (action.action === "sign_slot" && rosterSign?.complete === true);
  const deferNotice = issuingAct && issueExaminationMayExist(issueNoticeInput);
  // Kick the email drain AFTER the response is sent (the daily cron is the
  // fallback, not the primary path — recipients should get email in seconds).
  // WF-19 done-when 3: CRON_SECRET ships blank, and a blank bearer is a
  // 401 at the drain — so in a default deployment every workflow email
  // waited for the daily cron. The caller's own session token is a
  // legitimate drain credential (SURF-5 scopes it to their orgs, which
  // include this ticket's), so it is the fallback.
  const drainUrl = new URL("/api/notifications/send-queued", req.url);
  const drainToken = process.env.CRON_SECRET || authHeader.slice(7);
  const kickDrain = async () => {
    try {
      await fetch(drainUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${drainToken}` },
      });
    } catch { /* cron fallback */ }
  };
  if (deferNotice) {
    try {
      after(async () => {
        try {
          const issueExamination = await issueExaminationNote(supabaseAdmin, issueNoticeInput);
          await fanOut({ ticket, ticketId: body.ticketId, action: { type: action.action, label: action.label }, newStatus: String(newStatus), recipients, actorUid: caller.id, actorEmail: callerEmail, activity: isActivity, rosterCompleted: action.action === "sign_slot" && rosterSign?.complete === true, rosterPartial: action.action === "sign_slot" && rosterSign?.complete === false, rosterReleased: action.action === "sign_slot" && rosterSign && !rosterSign.complete ? rosterPartialReleased(rosterSign.roster, ticket, caller.id) : [], examinationNote: issueExamination, comment: fanOutComment, emailOrigin });
          await kickDrain();
        } catch (e) {
          console.error("[workflow-action] fan-out failed (transition committed):", e);
        }
      });
    } catch (e) {
      console.error(`[workflow-action] the issue notice for ticket ${body.ticketId} could not be scheduled (transition committed):`, e);
    }
  } else {
    try {
      await fanOut({ ticket, ticketId: body.ticketId, action: { type: action.action, label: action.label }, newStatus: String(newStatus), recipients, actorUid: caller.id, actorEmail: callerEmail, activity: isActivity, rosterCompleted: action.action === "sign_slot" && rosterSign?.complete === true, rosterPartial: action.action === "sign_slot" && rosterSign?.complete === false, rosterReleased: action.action === "sign_slot" && rosterSign && !rosterSign.complete ? rosterPartialReleased(rosterSign.roster, ticket, caller.id) : [], comment: fanOutComment, emailOrigin });
      after(kickDrain);
    } catch (e) {
      console.error("[workflow-action] fan-out failed (transition committed):", e);
    }
  }

  // EVID-12 (DF-P5 fix pass 2): today's path hashes AFTER the response, and
  // records the hashes in a follow-up row naming the approval's row
  // (details.approval) — append-only, never an update of the approval's row.
  // Best effort: a failure is logged; the approval has landed regardless.
  if (hashKeys.length > 0) {
    const approvalRowId = auditRow.id;
    const approvedDrafts = APPROVING_ACTIONS.has(action.action)
      ? (ticket.attachments ?? []).filter((a) => a?.type === "Draft" && a.status === "submitted")
      : [];
    const finalAtt = vetted.finalAttachment;
    const finalEtag = vettedEtags.finalAttachment;
    const asIs = issuedAsIs;
    const rev = (updates.deliverable_rev as string | null | undefined) ?? ticket.deliverableRev ?? null;
    try {
      after(async () => {
        try {
          const fileHashes = await hashStoredFiles(hashKeys, { deadlineMs: HASH_LIMITS.legacyDeadlineMs, byteBudget: HASH_LIMITS.legacyByteBudget });
          const hashOf = (a: TicketAttachment): FileHash => (a.url ? fileHashes.get(a.url) : undefined)
            ?? { ok: false, transient: false, reason: APPROVING_ACTIONS.has(action.action) ? "not hashed (not the revision being approved)" : "not a storage key" };
          const err = await insertAuditRowOnce({
            id: crypto.randomUUID(),
            action: filesHashedAction,
            resource_id: body.ticketId,
            resource_type: "ticket",
            org_id: ticket.orgId,
            user_id: caller.id,
            user_email: callerEmail,
            user_role: callerRole,
            details: {
              approval: approvalRowId,
              deliverable_rev: rev,
              ...(finalAtt ? { finalAttachment: hashedIdentity(finalAtt, finalEtag, hashOf(finalAtt)) } : {}),
              ...(approvedDrafts.length > 0 ? { approvedDrafts: approvedDrafts.map((a) => hashedIdentity(a, null, hashOf(a))) } : {}),
              ...(asIs.length > 0 ? {
                issuedAsIsFinals: asIs.map((f) => {
                  const d = approvedDrafts.find((x) => x.id === f.issuedFromDraftId);
                  const h = d ? hashOf(d) : undefined;
                  return { ...f, sha256: h?.ok ? h.sha256 : null, ...(h && !h.ok ? { sha256Unavailable: h.reason } : {}) };
                }),
              } : {}),
            },
          });
          if (err) console.error(`[workflow-action] ${auditRow.action} (audit row ${approvalRowId}) landed, but its file hashes could not be recorded: ${err}`);
        } catch (e) {
          console.error(`[workflow-action] hashing the files of audit row ${approvalRowId} failed (the transition stands):`, (e as Error)?.message ?? e);
        }
      });
    } catch (e) {
      console.warn("[workflow-action] the file hashing was not scheduled (the transition stands):", (e as Error)?.message ?? e);
    }
  }

  // public-surfaces PHYS-18 (DF-P15): an issue supersedes the copies people
  // took of the earlier package. The ticket arm of the stale-copy recall
  // (lib/staleCopies.ts getTicketCopyRecall / nudgeStaleTicketHolders, DF-P12)
  // tells every member holding an outdated copy who has not since taken the
  // current one, and puts the recall on the ticket's audit trail
  // (`source: "auto"`, as a document's publish recalls). Best-effort and
  // AFTER the response: the issue has landed, and nothing here can fail it.
  if ((APPROVING_ACTIONS.has(action.action) || (action.action === "sign_slot" && rosterSign?.complete)) && typeof updates.deliverable_rev === "string" && updates.deliverable_rev) {
    const recallInput = {
      ticket: {
        id: body.ticketId,
        orgId: ticket.orgId,
        status: String(newStatus),
        deliverableRev: updates.deliverable_rev as string,
        history: (updates.history as unknown) ?? ticket.history,
        revisionCount: ((updates.revision_count as number | undefined) ?? ticket.revisionCount) ?? null,
        historyGuardedFrom: (row as { history_guarded_from?: number | null }).history_guarded_from ?? null,
        attachments: (updates.attachments as unknown) ?? ticket.attachments,
      },
      ticketNumber: ticket.ticketId ?? null,
      actorUserId: caller.id,
      actorName: callerEmail,
    };
    try {
      after(() => recallSupersededTicketCopies(recallInput));
    } catch (e) {
      console.warn(`[workflow-action] the copy recall for ticket ${body.ticketId} could not be scheduled (the issue stands):`, e);
    }
  }

  // Ticket ⇄ intent bridge: a ticket entering DRAFTING registers the drafter's
  // EDIT INTENT on the source document — visible on the coordination surfaces
  // and feeding overlap advisories, WITHOUT taking a lock (intent decays on
  // its own; no zombie-lock factory). Ticket closure — or cancellation, the
  // other terminal exit (WF-17) — clears it. Best-effort: never fails the
  // transition; no-op on pre-migration envs.
  // GAP-8 acceptance 2 (DF-P4): every sheet the request names —
  // parseSourceDocuments: the singular source_document first, then each
  // entry of metadata.source_documents — not only the primary. Every sheet is
  // read in the ticket's org (SM-14) and gets its own intent row; a
  // single-source ticket (every historical row) is a list of one.
  // BATCHED (DF-P4 fix pass 3): a book request carries up to
  // MAX_SOURCE_DOCUMENTS sheets, so the bridge never makes a round trip per
  // sheet — one read of every sheet, one upsert of every intent row, one
  // delete per retirement leg, each in INTENT_BRIDGE_CHUNK slices (two
  // slices at most for any ticket the create route can make). And it runs
  // AFTER the fan-out above: the drafter's notice never waits on it.
  try {
    const sheetIds = parseSourceDocuments(ticket.metadata).map((d) => d.id);
    const slices: string[][] = [];
    for (let i = 0; i < sheetIds.length; i += INTENT_BRIDGE_CHUNK) slices.push(sheetIds.slice(i, i + INTENT_BRIDGE_CHUNK));
    const drafterId =
      (updates.assigned_drafter_id as string | undefined) ?? ticket.assignedDrafterId;
    const drafterName =
      (updates.assigned_drafter_name as string | undefined) ?? ticket.assignedDrafterName;
    const isReassign = action.action === "reassign_drafter";
    // Statuses where the ticket's intents are cleared wholesale (below).
    const clearsAll = newStatus === "CLOSED" || newStatus === "CANCELED" || newStatus === "FINAL_DRAFT";
    // WF-18: a reassignment hands the ticket to a different drafter, so
    // the PREVIOUS drafter's ticket-sourced intent is retired now rather
    // than lingering on the coordination surfaces until its TTL — two
    // drafters were shown editing for one ticket. Reassignment never
    // moves the status, and it is offered at every live status with a
    // drafter (PENDING_REVIEW, PENDING_FINAL_APPROVAL and PENDING_IFC
    // included), so the retirement runs for all of them — not only the
    // two statuses that register an intent.
    if (isReassign && !clearsAll && ticket.assignedDrafterId && ticket.assignedDrafterId !== drafterId) {
      for (const ids of slices) {
        const retire = await supabaseAdmin
          .from("document_intents")
          .delete()
          .in("document_id", ids)
          .eq("ticket_id", body.ticketId)
          .eq("source", "ticket")
          .eq("user_id", ticket.assignedDrafterId);
        if (retire?.error) {
          console.warn(`[workflow-action] intent bridge: previous drafter's intents not retired for ticket ${body.ticketId} (non-blocking)`, retire.error.message);
        }
      }
    }
    // The new drafter is registered where the ticket is on a drafter's
    // bench: entering DRAFTING / REVISION_REQ (every assignment), and on
    // reassignment at PENDING_IFC (the package is being issued). A
    // reassignment while the draft is under review registers nothing —
    // the next return to REVISION_REQ does.
    const registersDrafter =
      newStatus === "DRAFTING" || newStatus === "REVISION_REQ" || (isReassign && newStatus === "PENDING_IFC");
    if (registersDrafter) {
      if (drafterId) {
        // SM-14: the source documents are read IN THE TICKET'S ORG (as the
        // CLOSED hand-back path reads them); a document id from another
        // workspace — or one that is gone — registers nothing.
        // Matched CASE-INSENSITIVELY (DF-P4 fix pass 4): a uuid column
        // matches an upper-case id in the `.in()` read but returns its
        // canonical lower-case text, so the map is keyed by the lower-cased
        // database id, looked up by the lower-cased named id, and the row's
        // document_id is the database's own id.
        const found = new Map<string, { id: string; current_version_id?: string | null; library_id?: string | null }>();
        for (const ids of slices) {
          const { data: docRows, error: docErr } = await supabaseAdmin
            .from("documents")
            .select("id, current_version_id, library_id")
            .in("id", ids)
            .eq("org_id", ticket.orgId);
          if (docErr) {
            console.warn(`[workflow-action] intent bridge: source documents unreadable for ticket ${body.ticketId} (non-blocking)`, docErr.message);
            continue;
          }
          for (const r of (docRows ?? []) as Array<{ id?: string; current_version_id?: string | null; library_id?: string | null }>) {
            if (r?.id) found.set(r.id.toLowerCase(), { ...r, id: r.id });
          }
        }
        const now = Date.now();
        // One row per database document: two spellings of one id (case)
        // would otherwise put one conflict key twice in one upsert.
        const matched = new Map<string, { id: string; current_version_id?: string | null; library_id?: string | null }>();
        for (const id of sheetIds) {
          const doc = found.get(id.toLowerCase());
          if (doc && !matched.has(doc.id)) matched.set(doc.id, doc);
        }
        const rows = [...matched.values()].map((doc) => ({
          org_id: ticket.orgId,
          document_id: doc.id,
          library_id: doc.library_id ?? null,
          user_id: drafterId,
          user_name: drafterName ?? null,
          kind: "edit",
          source: "ticket",
          base_version_id: doc.current_version_id ?? null,
          ticket_id: body.ticketId,
          refreshed_at: new Date(now).toISOString(),
          expires_at: new Date(now + TICKET_INTENT_TTL_MS).toISOString(),
        }));
        for (let i = 0; i < rows.length; i += INTENT_BRIDGE_CHUNK) {
          const upsert = await supabaseAdmin
            .from("document_intents")
            .upsert(rows.slice(i, i + INTENT_BRIDGE_CHUNK), { onConflict: "document_id,user_id,kind,source" });
          if (upsert?.error) {
            console.warn(`[workflow-action] intent bridge: drafter's intents not registered for ticket ${body.ticketId} (non-blocking)`, upsert.error.message);
          }
        }
      }
    } else if (clearsAll) {
      for (const ids of slices) {
        const clear = await supabaseAdmin
          .from("document_intents")
          .delete()
          .in("document_id", ids)
          .eq("ticket_id", body.ticketId)
          .eq("source", "ticket");
        if (clear?.error) {
          console.warn(`[workflow-action] intent bridge: intents not cleared for ticket ${body.ticketId} (non-blocking)`, clear.error.message);
        }
      }
    }
  } catch (e) {
    console.warn("[workflow-action] intent bridge failed (non-blocking)", e);
  }

  return NextResponse.json({
    ok: true, status: newStatus, ...(holdOutcome ?? {}),
    ...(libraryNotStored && !holdOutcome ? { warning: "The request moved on, but its library could not be recorded yet (database update 20261208 is not applied)." } : {}),
    ...(rosterWarning && !holdOutcome && !libraryNotStored ? { warning: rosterWarning } : {}),
    ...(reviewClassNotStored && !holdOutcome && !libraryNotStored && !rosterWarning ? { warning: "The request moved on, but its work or code class could not be recorded yet (database update 20261250 is not applied)." } : {}),
    ...(consentWarning ? { consentWarning } : {}),
    ...(rosterLedgerNotWritten ? { rosterLedgerNotWritten: true } : {}),
    ...(examinationScopeWarningText ? { examinationScopeWarning: examinationScopeWarningText } : {}),
    ...(consentWarning && !holdOutcome && !libraryNotStored && !rosterWarning && !reviewClassNotStored ? { warning: consentWarning } : {}),
    // GAP-115 (DF-P26): the sign-off was recorded, and an exception on record
    // re-opened a slot the exception-only rule had satisfied — the request
    // waits on it instead of issuing.
    ...(exceptionReopen ? { exceptionReopened: { slots: exceptionReopen.labels, exceptions: exceptionReopen.exceptions } } : {}),
    ...(exceptionReopen && !holdOutcome && !libraryNotStored && !rosterWarning && !reviewClassNotStored && !consentWarning ? { warning: ruleReopenNote(exceptionReopen.labels, exceptionReopen.exceptions) } : {}),
  });
}

/** PHYS-18 (DF-P15): the recall of superseded ticket copies at an issue —
 *  run after the response, bound to the service role for this request only
 *  (lib/serverClientScope.ts: lib/staleCopies writes its audit row and its
 *  notices through the shared client, which in a route is the anon key).
 *  Never throws: a failure is logged and the issue stands. A record that
 *  could not be read (before 20261223, or a failed read) is recorded as such
 *  and tells nobody (nudgeStaleTicketHolders' `unavailable` rule). */
async function recallSupersededTicketCopies(input: {
  ticket: { id: string; orgId: string; status: string; deliverableRev: string; history: unknown; revisionCount: number | null; historyGuardedFrom: number | null; attachments: unknown };
  ticketNumber: string | null;
  actorUserId: string;
  actorName: string;
}): Promise<number> {
  try {
    const [{ getTicketCopyRecall, nudgeStaleTicketHolders }, { runWithServerClient }] = await Promise.all([
      import("@/lib/staleCopies"), import("@/lib/serverClientScope"),
    ]);
    return await runWithServerClient(supabaseAdmin, async () => {
      const recall = await getTicketCopyRecall(input.ticket, supabaseAdmin as unknown as Parameters<typeof getTicketCopyRecall>[1]);
      if (!recall.unavailable && recall.holders.length === 0) return 0;
      return nudgeStaleTicketHolders({
        orgId: input.ticket.orgId,
        ticketId: input.ticket.id,
        ticketNumber: input.ticketNumber,
        latestIssuedRev: recall.latestIssuedRev,
        holders: recall.holders,
        actorUserId: input.actorUserId,
        actorName: input.actorName,
        source: "auto",
        unavailable: recall.unavailable,
      });
    });
  } catch (e) {
    console.warn(`[workflow-action] the copy recall for ticket ${input.ticket.id} failed (the issue stands):`, (e as Error)?.message ?? e);
    return 0;
  }
}

async function fanOut(params: {
  ticket: ReturnType<typeof rowToTicket>;
  ticketId: string;
  action: { type: string; label: string };
  newStatus: string;
  recipients: string[];
  actorUid: string;
  actorEmail: string;
  comment: string | null;
  /** WF-9: true for thread activity (a file attachment) — no alert
   *  supersede, no email, a comment-style bell row without metadata.action
   *  (so the badge hook's stale-alert reconciliation leaves it alone). */
  activity?: boolean;
  /** EDGE-9: the absolute origin email links are built on. */
  emailOrigin: string;
  /** DF-P5 fix pass 2: this sign-off completed the review roster (an
   *  approval: ticket_approved, not a generic status change). */
  rosterCompleted?: boolean;
  /** DF-P5 fix pass 3: a sign-off that left the roster OPEN — the ticket
   *  still waits on the other slots, so only the signer's own alerts are
   *  retired; everyone else's "review opened" alert stays live. */
  rosterPartial?: boolean;
  /** DF-P5 fix pass 4: on a partial sign-off, the co-occupants of a slot
   *  now satisfied (lib/ticketTransitions.ts rosterPartialReleased) — the
   *  ticket waits on them no more, so their action alerts are retired with
   *  the signer's. */
  rosterReleased?: string[];
  /** GAP-102 acceptance 2 (DF-P26): on an issuing act, the one line naming
   *  the request's recorded examination data (null: today's notice). */
  examinationNote?: string | null;
}) {
  const { ticket, ticketId, action, newStatus, recipients, actorUid, actorEmail, comment, activity, emailOrigin } = params;
  const examinationNote = params.examinationNote ?? null;
  // ROUTE-6 (DF-P3): thread activity with nobody to tell has nothing to do.
  // A TRANSITION always reaches the supersede step below, even when it tells
  // nobody (a Drafter picking up their own request): the queue's "needs a
  // drafter" alerts are stale the moment the ticket leaves the queue.
  if (activity && recipients.length === 0) return;
  if (!activity && recipients.length === 0) {
    // LEAK-1 done-when 3: visible, not silently dropped (the audit row
    // carries `recipientsResolved: 0` too).
    console.warn(`[workflow-action] ${action.type} on ticket ${ticketId} (now ${newStatus}) has nobody to tell`);
  }

  const ticketLabel = `${ticket.ticketId || ""} ${ticket.title}`.trim();
  // In-app rows navigate inside the app (relative); the email link leaves it.
  const link = `/requests/${ticketId}`;
  const emailLink = `${emailOrigin.replace(/\/+$/, "")}${link}`;
  const actorName = actorEmail.split("@")[0];

  // NEDGE-14 (notifications Round G, N6): only ACTIVE members of the ticket's
  // org hear about it — the predicate emit() applies centrally
  // (lib/notify/recipients.ts activeMembersOf), read here on the service role
  // together with the addresses. A read that fails keeps today's bell
  // audience (a transient error never silently drops a notice) and mails no
  // one (no address was read).
  const { data: members, error: membersErr } = await supabaseAdmin
    .from("org_members").select("uid, email").eq("org_id", ticket.orgId).eq("status", "active").in("uid", recipients);
  if (membersErr) console.warn("[workflow-action] active-membership read failed — recipients not filtered, no email sent", membersErr.message);
  const active = membersErr ? null : ((members as Array<{ uid: string; email: string | null }> | null) ?? []);
  const activeUids = new Set((active ?? []).map((m) => m.uid));
  const audience = active ? recipients.filter((uid) => activeUids.has(uid)) : recipients;
  if (!activity && recipients.length > 0 && audience.length === 0) {
    // LEAK-1 done-when 3: a transition whose people are all suspended or
    // removed tells nobody — as visible as one that resolved to nobody.
    console.warn(`[workflow-action] ${action.type} on ticket ${ticketId} (now ${newStatus}) has nobody to tell — the active-members filter removed all ${recipients.length} recipient(s)`);
  }

  if (activity) {
    if (audience.length === 0) return;
    // DELIV-7 dw3: a refused insert is logged, never silently dropped.
    // TAX-11 (N14): the typed sink, ONE statement on the service role.
    const { error: activityErr } = await notifyBatchWithReason(
      audience.map((uid) => ({
        orgId: ticket.orgId,
        userId: uid,
        kind: "ticket_comment" as const,
        title: `File added · ${ticketLabel}`,
        body: comment || "A file was added to this request",
        link,
        resourceType: "ticket",
        resourceId: ticketId,
        actorUserId: actorUid,
        actorName,
        metadata: { activity: action.type, status: newStatus },
      })),
      supabaseAdmin,
    );
    if (activityErr) console.error("[workflow-action] activity bell rows were not written (transition committed):", activityErr);
    return;
  }

  // UI-4 / FRIC-5 (DF-P5 fix pass 2): the drafter's issue-as-is mark or
  // withdrawal is not a status change. Its audience is the current reviewers
  // only (lib/ticketTransitions.ts issueMarkAudience) — told on the bell, so
  // the next approval is taken knowing what it does. No email, and the
  // reviewers' outstanding "please review" alerts are NOT superseded (the
  // ticket still waits on them).
  if (ISSUE_MARK_ACTIONS.has(action.type)) {
    if (audience.length === 0) return;
    const { error: markErr } = await notifyBatchWithReason(
      audience.map((uid) => ({
        orgId: ticket.orgId,
        userId: uid,
        kind: "ticket_status" as const,
        title: `${action.type === "mark_issue_ready" ? "Marked issue-ready" : "Issue-as-is withdrawn"} · ${ticketLabel}`,
        body: action.type === "mark_issue_ready"
          ? "Approving this draft issues it as the final package — no second upload."
          : "Approving this draft returns the request to the drafter to issue the final package, as usual.",
        link,
        resourceType: "ticket",
        resourceId: ticketId,
        actorUserId: actorUid,
        actorName,
        metadata: { activity: action.type, status: newStatus },
      })),
      supabaseAdmin,
    );
    if (markErr) console.error("[workflow-action] issue-as-is bell rows were not written (change committed):", markErr);
    return;
  }

  const cls = classifyTransitionNotification({ actionType: action.type, actionLabel: action.label, ticketLabel, rosterCompleted: params.rosterCompleted === true });

  // 0) Supersede earlier unread WORKFLOW alerts for this ticket. A workflow
  //    notification (one carrying metadata.action) says "the ticket is in state
  //    X, act on it". The moment it transitions, that's no longer true, so we
  //    retire the old rows for everyone — otherwise a stale "issue the IFC" /
  //    "needs assignment" alert lingers in the recipient's bell long after the
  //    work moved on. Comment/mention rows have no metadata.action and are
  //    intentionally left untouched. Best-effort: never block the transition.
  //    EVID-13: retiring an alert is MARKED (metadata.superseded_at / _by), and
  //    read_at is never touched — read_at means the recipient opened it, and
  //    is the only "did they see it" signal there is. The bell's unread list
  //    leaves superseded rows out (lib/inAppNotifications.ts).
  //    DF-P3 fix pass 3: the SLA clock's "Overdue" / "Due soon" rows
  //    (lib/ticketSla.ts — metadata.action sla_breach / sla_warning) say "this
  //    request is late", which an open-to-open transition (save progress, a
  //    reassignment) does not change; only an exit (CLOSED / CANCELED) clears
  //    it, so only an exit retires them.
  //    DF-P22: the escalation digest (metadata.action sla_escalation_digest)
  //    is filed under the first request it names but speaks for several, so
  //    no transition of this one request retires it, an exit included
  //    (lib/ticketSla.ts slaNoticeSurvivesTransition).
  //    DF-P5 fix pass 3 (TIER-5 / FRIC-2): a PARTIAL roster sign-off moves
  //    nothing for the reviewers still waited on — only the signer's own
  //    alerts are retired (their part is done); the others keep theirs.
  //    DF-P5 fix pass 4: so are the alerts of the co-occupants of a slot now
  //    satisfied (nothing waits on them), and — so sign-off notices do not
  //    pile up — an earlier partial sign-off's notice (metadata.action
  //    sign_slot) of anyone this sign-off tells again; their "review opened"
  //    alert stays live while the ticket waits on them.
  const exits = newStatus === "CLOSED" || newStatus === "CANCELED";
  const partialRetire = new Set<string>([actorUid, ...(params.rosterReleased ?? [])]);
  const partialRenotified = new Set<string>(audience.filter((u) => !partialRetire.has(u)));
  try {
    const supersededAt = new Date().toISOString();
    let staleQuery = supabaseAdmin.from("notifications")
      .select("id, user_id, metadata")
      .eq("resource_id", ticketId)
      .eq("org_id", ticket.orgId)
      .is("read_at", null)
      .not("metadata->>action", "is", null)
      .is("metadata->>superseded_at", null);
    if (params.rosterPartial === true) staleQuery = staleQuery.in("user_id", [...partialRetire, ...partialRenotified]);
    const { data: stale } = await staleQuery;
    for (const row of (stale ?? []) as Array<{ id: string; user_id?: string | null; metadata: Record<string, unknown> | null }>) {
      if (slaNoticeSurvivesTransition(String(row.metadata?.action ?? ""), exits)) continue;
      if (params.rosterPartial === true && !partialRetire.has(String(row.user_id ?? "")) && row.metadata?.action !== "sign_slot") continue;
      await supabaseAdmin.from("notifications")
        .update({ metadata: { ...(row.metadata ?? {}), superseded_at: supersededAt, superseded_by: action.type } })
        .eq("id", row.id)
        .is("read_at", null);
    }
  } catch (e) {
    console.warn("[workflow-action] superseding stale notifications failed:", e);
  }

  // 1) In-app bell rows — to the active audience only (NEDGE-14). The stale
  //    alerts above are retired whoever is left to tell.
  if (audience.length === 0) return;
  const { error: bellErr } = await notifyBatchWithReason(
    audience.map((uid) => ({
      orgId: ticket.orgId,
      userId: uid,
      kind: cls.inAppKind,
      title: cls.inAppTitle,
      body: examinationNote ? `${comment || `Status: ${ticketStatusLabel(newStatus)}`}\n\n${examinationNote}` : comment || `Status: ${ticketStatusLabel(newStatus)}`,
      link,
      resourceType: "ticket",
      resourceId: ticketId,
      actorUserId: actorUid,
      actorName,
      metadata: { action: action.type, status: newStatus },
    })),
    supabaseAdmin,
  );
  if (bellErr) console.error("[workflow-action] bell rows were not written (transition committed):", bellErr);

  // 2) Email queue — preference-aware (defaults all-on when no prefs row).
  const [{ data: prefs }, { data: orgRow }] = await Promise.all([
    supabaseAdmin.from("notification_preferences").select("*").in("user_id", recipients),
    supabaseAdmin.from("orgs").select("name").eq("id", ticket.orgId).maybeSingle(),
  ]);
  const orgName = ((orgRow as { name?: string | null } | null)?.name ?? null);
  const emailByUid = new Map<string, string>();
  (active ?? []).forEach((m) => {
    if (m.email) emailByUid.set(m.uid, m.email);
  });
  const prefByUid = new Map<string, Record<string, unknown>>();
  ((prefs as Array<Record<string, unknown>>) ?? []).forEach((p) => prefByUid.set(p.user_id as string, p));

  // EVID-9 (DF-P7 fix pass 2): ONE rule decides both whether a member is
  // emailed and, when not, the reason the not-emailed record names
  // (lib/consentWindowScan.ts emailPreferenceOf — pinned to
  // lib/notificationPrefs.ts emailAllowedByPrefs over every event type).
  const wantsEmail = (uid: string): boolean => emailPreferenceOf(prefByUid.get(uid), cls.eventType).wants;

  // NEDGE-10 dw2: a note's mention markup reaches the email as names; the
  // render layer adds the footer (lib/emailRender.ts — the drain then
  // attaches the one-click unsubscribe header).
  const note = comment ? plainMentions(comment) : null;
  const composedText = `${actorEmail} performed: ${action.label}\n\nStatus is now: ${ticketStatusLabel(newStatus)}\n${note ? `\nNote: ${note}\n` : ""}${examinationNote ? `\n${examinationNote}\n` : ""}\n${emailLink}`;
  const composedHtml = `
        <p><b>${escapeHtml(actorEmail)}</b> performed <b>${escapeHtml(action.label)}</b> on <a href="${escapeHtml(emailLink)}">${escapeHtml(ticketLabel)}</a>.</p>
        <p>Status: <b>${escapeHtml(ticketStatusLabel(newStatus))}</b></p>
        ${note ? `<blockquote style="border-left:3px solid #cbd5e1;padding-left:12px;color:#475569;white-space:pre-wrap">${escapeHtml(note)}</blockquote>` : ""}${examinationNote ? `
        <p>${escapeHtml(examinationNote)}</p>` : ""}
        <p><a href="${escapeHtml(emailLink)}">Open ticket</a></p>`;
  let body: { bodyText: string; bodyHtml: string } | null = null;
  try {
    body = wrapEmailBody({ text: composedText, html: composedHtml, orgName, origin: emailOrigin });
  } catch (e) {
    console.warn("[workflow-action] email not rendered (queued as composed):", (e as Error).message);
  }

  const emailRows = audience
    .filter((uid) => emailByUid.has(uid) && wantsEmail(uid))
    .map((uid) => ({
      org_id: ticket.orgId,
      to_user_id: uid,
      to_email: emailByUid.get(uid)!,
      subject: cls.emailSubject,
      body_text: body ? body.bodyText : composedText,
      body_html: body ? body.bodyHtml : composedHtml,
      resource_type: "ticket",
      resource_id: ticketId,
      event_type: cls.eventType,
      metadata: { action: action.type, status: newStatus, ...(body ? { rendered: true } : {}) },
      status: "queued",
    }));
  if (emailRows.length > 0) {
    const { error: mailErr } = await supabaseAdmin.from("email_notifications").insert(emailRows);
    if (mailErr) console.error("[workflow-action] emails were not queued (transition committed):", mailErr.message);
  }
  // EVID-9 (DF-P7, route limb): a person this transition did not email
  // because their OWN preference turned it off gets a durable "not emailed
  // by their choice" record (ticket_notice_events, 20261255) — not silence.
  // Not an email_notifications 'suppressed' row: the drain re-queues those
  // (app/api/notifications/send-queued/route.ts recovery), which would mail
  // the person who opted out. Best-effort: the transition has landed.
  {
    const optedOut = audience
      .map((uid) => ({ uid, reason: emailByUid.has(uid) ? emailPreferenceOf(prefByUid.get(uid), cls.eventType).reason : null }))
      .filter((o): o is { uid: string; reason: string } => o.reason !== null);
    const notEmailedErr = await recordNotEmailed(supabaseAdmin, { orgId: ticket.orgId, ticketId, action: action.type, eventType: cls.eventType, optedOut });
    if (notEmailedErr) console.error(`[workflow-action] the not-emailed record for ${optedOut.length} recipient(s) on ticket ${ticketId} was not written (transition committed): ${notEmailedErr}`);
  }

  // OS-14 (notifications N17): an assignment reaches the push channel —
  // after the bell and email legs, only when the bell insert landed (never
  // for a refused or rail-rejected row), and ONLY to the assignee: the
  // committed ticket's assigned_drafter_id, when that member is in the active
  // audience that got the ticket_assigned row. The watchers (and, on a
  // self_assign, the requester / engineer) share the bell row but were not
  // assigned, so they get no "assigned to you" push; a self_assign excludes
  // the actor from the audience, so it pushes nobody. A failed read pushes
  // nobody (fail-safe). The sender (lib/push/sendPush.ts) re-checks the bell
  // row, push_enabled, membership and the device, and never throws; it runs
  // after the response (next/server after()). N17 merge (DEC-90, the
  // integrator's ruling R1): the actor is the writer (`writerUid`), so
  // DEC-108's per-writer cap bounds a burst; the bell row and email stand.
  if (cls.inAppKind === "ticket_assigned" && !bellErr) {
    try {
      after(async () => {
        const { data: committed, error: assigneeErr } = await supabaseAdmin
          .from("tickets").select("assigned_drafter_id").eq("id", ticketId).eq("org_id", ticket.orgId).maybeSingle();
        if (assigneeErr) {
          console.warn("[workflow-action] the assignee was not read — the assignment push is skipped (bell and email unaffected):", assigneeErr.message);
          return;
        }
        const assigneeId = (committed as { assigned_drafter_id?: string | null } | null)?.assigned_drafter_id ?? null;
        const assignees = assigneeId ? audience.filter((uid) => uid === assigneeId) : [];
        if (assignees.length === 0) return;
        // loaded here, not at module scope: the sender (web-push, the service
        // role) is needed only once there is something to push
        const { sendPushSafe } = await import("@/lib/push/sendPush");
        await sendPushSafe({ orgId: ticket.orgId, kind: "ticket_assigned", resourceId: ticketId, recipients: assignees, writerUid: actorUid });
      });
    } catch (e) {
      console.warn("[workflow-action] the assignment push was not scheduled (transition, bell and email unaffected):", (e as Error)?.message ?? e);
    }
  }
}
