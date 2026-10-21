// lib/reviewModel.ts
//
// drafting-flow Round G, DF-P6 REVIEW-MODEL — what makes engineering review
// required on a drafting request (DEC-33), the like-in-kind declaration that
// is the one thing that removes it (DEC-34), and the workspace's own work /
// code classes (GAP-101, TIER-4 — DEC-35: no facility vocabulary in code).
// Pure: the engine (lib/workflow.ts), the workflow route, the create route
// and the request page all read the same rules from here.
//
// THE GATE (TIER-1, the inversion fix). Engineering is required because of
// WHAT the work is, never because of WHO asked:
//   * `tickets.engineering_required` (20261250) — true unless the requester
//     declared, at intake and in their own name, that the work is
//     like-in-kind. A ratchet: the database refuses true → false for every
//     caller, the service role included; request_eng_review, the assigner's
//     flag and an engineering work / code class only ever raise it.
//   * A declared request (engineering_required false WITH a declaration) is
//     not engineered work: it reaches IFC through the assigner and the
//     requester with no engineer and no added wait (GAP-101 acceptance 2).
//   * THE SEED (DEC-35 pattern, DEC-90 ruling (2)): a request the column
//     cannot speak for keeps today's role-based gate
//     (engineerApprovalRequired — the DEC-13 stage 3 exempt list, the DEC-16
//     snapshot OR current test), evaluated live exactly as today:
//       - before 20261250 is pasted the column is not there (`undefined`);
//       - a row that predates the paste carries the legacy answer the paste
//         computed (true where the legacy gate required an engineer), and a
//         `false` with no declaration means "the legacy gate decides" — so
//         a requester demoted after filing is still routed to an engineer
//         (DEC-16), exactly as today. No in-flight request changes lane.
//   * WHO IT BINDS (DF-P6 fix pass 2, review issue 1): DEC-33's limbs that
//     bind the REQUESTER (the self-override block in orgs of 3+, the
//     requester's recorded override at PENDING_REVIEW, the engineer-pick
//     question) apply only to a request FILED under the review model —
//     `tickets.review_model_filed` (20261250: false on every row that
//     existed before the paste, true on every row filed after it,
//     immutable). A pre-paste row the backfill (or a later flag) set
//     engineering_required true is gated by the requirement, but its
//     requester keeps every path they have today (reviewModelBinds).
//
// DELIVERY, NOT DRAFTING. The requirement is a condition on the issue
// transitions (approve_draft_ifc, approve_minor_correction,
// engineer_approve_final and the roster's completing sign-off — submit_final
// is reached only through one of them); drafting is never blocked by it.

import type { OrgDraftingSettings, ReviewClassConfig, ReviewClassOption, Ticket } from "@/types/schema";

/** DEC-34: the declaration is a sentence the requester composes — never a
 *  checkbox, a picker or canned text. ~20 characters is the floor. */
export const LIKE_IN_KIND_MIN_CHARS = 20;
/** A generous ceiling: a statement, not an essay. */
export const LIKE_IN_KIND_MAX_CHARS = 2000;

/** The one line the request form shows beside the declaration (GAP-101 "Why
 *  this does not reintroduce UI-5"). */
export const DECLARATION_BLANK_NOTE = "Leave this blank and the request goes to engineering.";

/** The words the signature carries ahead of the requester's own sentence. */
export const DECLARATION_STATEMENT_PREFIX = "Like-in-kind declaration: ";

/** The signature intent the declaration ceremony records (the closed
 *  vocabulary of /api/signatures/sign). */
export const DECLARATION_SIGNATURE_INTENT = "Acknowledged" as const;

/** How long a declaration's signature stays usable for filing the request. */
export const DECLARATION_SIGNATURE_MAX_AGE_MS = 30 * 60 * 1000;

/** The text the requester types, checked as the server checks it. */
export function checkDeclarationStatement(raw: unknown): { ok: true; statement: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "The like-in-kind declaration must be a sentence you write." };
  const statement = raw.replace(/\s+/g, " ").trim();
  if (statement.length < LIKE_IN_KIND_MIN_CHARS) {
    return { ok: false, error: `Write the like-in-kind declaration in your own words — what is being replaced with what (at least ${LIKE_IN_KIND_MIN_CHARS} characters). ${DECLARATION_BLANK_NOTE}` };
  }
  if (statement.length > LIKE_IN_KIND_MAX_CHARS) {
    return { ok: false, error: `The like-in-kind declaration is longer than ${LIKE_IN_KIND_MAX_CHARS} characters — shorten it.` };
  }
  return { ok: true, statement };
}

/** The statement the declaration's e-signature carries. */
export function declarationSignatureStatement(statement: string): string {
  return `${DECLARATION_STATEMENT_PREFIX}${statement}`;
}

/** Does the ticket carry a like-in-kind declaration? */
export function isDeclaredLikeInKind(ticket: Pick<Ticket, "likeInKindDeclaredAt" | "likeInKindStatement">): boolean {
  return !!ticket.likeInKindDeclaredAt && typeof ticket.likeInKindStatement === "string" && ticket.likeInKindStatement.trim().length > 0;
}

/** DF-P6 fix pass 2 (review, issue 1): do DEC-33's REQUESTER-binding limbs
 *  apply to this ticket — filed under the review model (review_model_filed,
 *  20261250) AND the column says engineering is required? A pre-paste row
 *  (review_model_filed false, or the column not read) keeps today's
 *  requester paths whatever engineering_required says (DEC-90 ruling (2)). */
export function reviewModelBinds(ticket: Pick<Ticket, "reviewModelFiled" | "engineeringRequired">): boolean {
  return ticket.reviewModelFiled === true && ticket.engineeringRequired === true;
}

/** The column can speak for this ticket (20261250 pasted and read). */
export function hasReviewModelColumns(ticket: Pick<Ticket, "engineeringRequired">): boolean {
  return ticket.engineeringRequired === true || ticket.engineeringRequired === false;
}

/**
 * TIER-1 / DEC-33: is engineering review required before this request may
 * issue? `legacy` is today's role-based gate (engineerApprovalRequired),
 * evaluated only where the column cannot speak for the ticket (the SEED).
 */
export function ticketEngineeringRequired(
  ticket: Pick<Ticket, "engineeringRequired" | "likeInKindDeclaredAt" | "likeInKindStatement">,
  legacy: () => boolean,
): boolean {
  if (ticket.engineeringRequired === true) return true;
  if (ticket.engineeringRequired === false && isDeclaredLikeInKind(ticket)) return false;
  return legacy();
}

export type EngineeringBasis =
  | { kind: "declared"; by: string | null; at: string | null }
  | { kind: "required"; flagged: boolean; legacy: boolean }
  | { kind: "seed" };

/** Why the gate answered as it did — the ticket shows this instead of "your
 *  job title" (GAP-111 acceptance "the ticket shows WHY"). */
export function engineeringBasis(ticket: Pick<Ticket, "engineeringRequired" | "likeInKindDeclaredAt" | "likeInKindStatement" | "likeInKindDeclaredBy" | "engineerReviewRequestedAt" | "reviewModelFiled">): EngineeringBasis {
  // `legacy`: filed before the review model (fix pass 2, minor 5) — the
  // backfill's certain answer under the earlier rule, or a requirement
  // raised since; never "no declaration was made".
  if (ticket.engineeringRequired === true) return { kind: "required", flagged: isDeclaredLikeInKind(ticket) || !!ticket.engineerReviewRequestedAt, legacy: ticket.reviewModelFiled !== true && !isDeclaredLikeInKind(ticket) };
  if (ticket.engineeringRequired === false && isDeclaredLikeInKind(ticket)) {
    return { kind: "declared", by: ticket.likeInKindDeclaredBy ?? null, at: ticket.likeInKindDeclaredAt ? String(ticket.likeInKindDeclaredAt) : null };
  }
  return { kind: "seed" };
}

// ─── DF-P6 fix pass (review) ─────────────────────────────────────────────

/** The review-model fields of a `tickets` row (20261250, and the library —
 *  GAP-105), as the Ticket every mapper builds — so the route
 *  (lib/ticketTransitions.ts rowToTicket), the request page and, once they
 *  spread it (99-fix-sequencing "Hand-offs from DF-P6"), the requests list
 *  and lib/inbox.ts evaluate the engine on the same fields. A column the
 *  database does not have yet reads `undefined` for engineering_required
 *  (the seed decides) and null elsewhere. */
export function reviewModelFieldsFromRow(row: Record<string, unknown>): Pick<Ticket,
  "libraryId" | "engineeringRequired" | "reviewModelFiled" | "likeInKindStatement" | "likeInKindDeclaredBy" | "likeInKindDeclaredAt" | "likeInKindSignatureId" | "workClass" | "codeClass"> {
  return {
    libraryId: typeof row.library_id === "string" ? row.library_id : null,
    engineeringRequired: typeof row.engineering_required === "boolean" ? row.engineering_required : undefined,
    reviewModelFiled: typeof row.review_model_filed === "boolean" ? row.review_model_filed : undefined,
    likeInKindStatement: typeof row.like_in_kind_statement === "string" ? row.like_in_kind_statement : null,
    likeInKindDeclaredBy: typeof row.like_in_kind_declared_by === "string" ? row.like_in_kind_declared_by : null,
    likeInKindDeclaredAt: typeof row.like_in_kind_declared_at === "string" ? row.like_in_kind_declared_at : null,
    likeInKindSignatureId: typeof row.like_in_kind_signature_id === "string" ? row.like_in_kind_signature_id : null,
    workClass: typeof row.work_class === "string" ? row.work_class : null,
    codeClass: typeof row.code_class === "string" ? row.code_class : null,
  };
}

/** Issue 1 / 2: can anyone be picked as this request's reviewing engineer?
 *  `candidateUids` are the members the engineer pick accepts
 *  (lib/ticketPage.ts engineerCandidates); in orgs of 3+ the pick refuses
 *  the requester, the drafter and the picker (the workflow route), so they
 *  do not count. */
export function engineerPickAvailable(
  candidateUids: readonly string[],
  ticket: Pick<Ticket, "requesterId" | "assignedDrafterId">,
  pickerUid: string | null | undefined,
  sodActive: boolean,
): boolean {
  return candidateUids.some((u) => !sodActive || (u !== ticket.requesterId && u !== ticket.assignedDrafterId && u !== pickerUid));
}

/** The words the transition writes on an override's history line (SM-3). */
export const ENGINEERING_OVERRIDE_NOTE = "Management override — issued without the engineer's sign-off";

export interface EngineeringOverrideMark { by: string | null; at: string | null }

/** Issue 7: was this request issued by a management override of the
 *  engineering sign-off — and is that the latest word (no engineer signed
 *  after it)? Read from `metadata.engineering_override` (written by the
 *  transition since this fix pass), else from the override's history line
 *  (overrides recorded before the marker). null = no override stands. */
export function engineeringOverrideOf(ticket: Pick<Ticket, "metadata" | "history" | "engineerApprovedAt">): EngineeringOverrideMark | null {
  const meta = (ticket.metadata as Record<string, unknown> | undefined) ?? {};
  // Fix pass 2 (review, minor 6): a later issue that was not an override
  // clears the marker (null) — the override is no longer the latest word,
  // and the history line it left is not read again.
  if (Object.prototype.hasOwnProperty.call(meta, "engineering_override") && meta.engineering_override === null) return null;
  const raw = meta.engineering_override as { by?: unknown; at?: unknown } | undefined;
  let mark: EngineeringOverrideMark | null = null;
  if (raw && typeof raw === "object") {
    mark = { by: typeof raw.by === "string" ? raw.by : null, at: typeof raw.at === "string" ? raw.at : null };
  } else {
    const hist = Array.isArray(ticket.history) ? ticket.history : [];
    for (let i = hist.length - 1; i >= 0; i--) {
      const h = hist[i] as { details?: unknown; user?: unknown; date?: unknown };
      if (typeof h?.details === "string" && h.details.includes(ENGINEERING_OVERRIDE_NOTE)) {
        mark = { by: typeof h.user === "string" ? h.user : null, at: typeof h.date === "string" ? h.date : null };
        break;
      }
    }
  }
  if (!mark) return null;
  const signed = ticket.engineerApprovedAt ? Date.parse(String(ticket.engineerApprovedAt)) : NaN;
  const at = mark.at ? Date.parse(mark.at) : NaN;
  // An engineer's sign-off stamped after the override (a later cycle) is
  // the latest word.
  if (Number.isFinite(signed) && (!Number.isFinite(at) || signed >= at)) return null;
  return mark;
}

// ─── The workspace's own classes (GAP-101 / TIER-4, DEC-35) ──────────────

export type ReviewClassKey = "workClasses" | "codeClasses";

/** The configured options of one class list — seeded EMPTY: an absent or
 *  malformed list is no list (unclassified, the safe reading). */
export function reviewClassOptions(cfg: Partial<OrgDraftingSettings> | null | undefined, key: ReviewClassKey): ReviewClassOption[] {
  const list = (cfg as Record<string, unknown> | null | undefined)?.[key] as ReviewClassConfig | undefined;
  const raw = Array.isArray(list?.options) ? list!.options : [];
  const out: ReviewClassOption[] = [];
  const seen = new Set<string>();
  for (const o of raw) {
    if (!o || typeof o !== "object") continue;
    const value = typeof o.value === "string" ? o.value.trim() : "";
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : value;
    out.push({ value, label, ...(o.engineering === true ? { engineering: true } : {}) });
  }
  return out;
}

/** A class value sent by triage, checked against the workspace's list. */
export function resolveReviewClass(
  raw: unknown,
  options: readonly ReviewClassOption[],
): { kind: "none" } | { kind: "ok"; option: ReviewClassOption } | { kind: "unknown" } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return { kind: "none" };
  if (typeof raw !== "string") return { kind: "unknown" };
  const v = raw.trim();
  const option = options.find((o) => o.value === v);
  return option ? { kind: "ok", option } : { kind: "unknown" };
}

/** The label a class value reads as (the value itself when the list no
 *  longer names it — never a guess). */
export function reviewClassLabel(value: string | null | undefined, options: readonly ReviewClassOption[]): string | null {
  if (!value) return null;
  return options.find((o) => o.value === value)?.label ?? value;
}

// ─── Pre-migration tolerance (DEC-30) ────────────────────────────────────

const REVIEW_MODEL_COLUMNS = ["engineering_required", "review_model_filed", "like_in_kind_statement", "like_in_kind_declared_by", "like_in_kind_declared_at", "like_in_kind_signature_id", "work_class", "code_class"];

/** 42703 / PGRST204 naming one of 20261250's columns: the paste has not
 *  happened — today's path, said. Anything else is a real error. */
export function isMissingReviewModelColumn(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  if (code !== "42703" && code !== "PGRST204") return false;
  const msg = String(err.message ?? "");
  return REVIEW_MODEL_COLUMNS.some((c) => msg.includes(c));
}

// ─── The declaration's e-signature (DEC-34) ──────────────────────────────

export interface DeclarationSignatureRow {
  id?: string | null;
  org_id?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
  signer_user_id?: string | null;
  statement?: string | null;
  intent?: string | null;
  signed_at?: string | null;
}

/** Why a declaration's signature cannot stand for this request (null when
 *  it can): minted by /api/signatures/sign for THIS (not yet filed) ticket
 *  id, by the requester, in this workspace, over the statement they typed,
 *  recently. */
export function declarationSignatureRefusal(
  sig: DeclarationSignatureRow | null | undefined,
  ctx: { orgId: string; ticketKey: string; requesterId: string; statement: string; now: number },
): string | null {
  if (!sig) return "The like-in-kind declaration's signature was not found — sign the declaration again.";
  if (sig.org_id !== ctx.orgId) return "The like-in-kind declaration's signature belongs to another workspace.";
  if (sig.resource_type !== "ticket" || String(sig.resource_id ?? "").toLowerCase() !== ctx.ticketKey.toLowerCase()) {
    return "The like-in-kind declaration's signature was given for a different request — sign the declaration again.";
  }
  if (sig.signer_user_id !== ctx.requesterId) return "Only the requester can sign their like-in-kind declaration.";
  if (sig.intent !== DECLARATION_SIGNATURE_INTENT) return "The like-in-kind declaration's signature does not record a declaration.";
  if ((sig.statement ?? "") !== declarationSignatureStatement(ctx.statement)) {
    return "The like-in-kind declaration changed after it was signed — sign the declaration again.";
  }
  const at = Date.parse(String(sig.signed_at ?? ""));
  if (!Number.isFinite(at) || ctx.now - at > DECLARATION_SIGNATURE_MAX_AGE_MS || at - ctx.now > 5 * 60 * 1000) {
    return "The like-in-kind declaration's signature has expired — sign the declaration again.";
  }
  return null;
}

/** The outcome of checking a FILED request's declaration against its
 *  e-signature: on record for this request by its declarer ("verified"),
 *  absent or not matching ("missing"), or the read failed ("unchecked"). */
export type DeclarationCheck = "verified" | "missing" | "unchecked";

/** DF-P6 fix pass (minor 11) / fix pass 2 (minor 5): does a filed request's
 *  declaration stand on its e-signature? The workflow route (which treats a
 *  declaration that does not as undeclared) and the request page's card
 *  (which then does not say "not required") ask the same question. */
export function declarationSignatureStands(
  sig: Pick<DeclarationSignatureRow, "org_id" | "resource_type" | "resource_id" | "signer_user_id"> | null | undefined,
  ticket: { id: string; orgId: string; likeInKindDeclaredBy?: string | null },
): boolean {
  if (!sig) return false;
  if (sig.org_id !== ticket.orgId || sig.resource_type !== "ticket") return false;
  if (String(sig.resource_id ?? "").toLowerCase() !== ticket.id.toLowerCase()) return false;
  return !ticket.likeInKindDeclaredBy || sig.signer_user_id === ticket.likeInKindDeclaredBy;
}
