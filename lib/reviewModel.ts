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
  | { kind: "required"; flagged: boolean }
  | { kind: "seed" };

/** Why the gate answered as it did — the ticket shows this instead of "your
 *  job title" (GAP-111 acceptance "the ticket shows WHY"). */
export function engineeringBasis(ticket: Pick<Ticket, "engineeringRequired" | "likeInKindDeclaredAt" | "likeInKindStatement" | "likeInKindDeclaredBy" | "engineerReviewRequestedAt">): EngineeringBasis {
  if (ticket.engineeringRequired === true) return { kind: "required", flagged: isDeclaredLikeInKind(ticket) || !!ticket.engineerReviewRequestedAt };
  if (ticket.engineeringRequired === false && isDeclaredLikeInKind(ticket)) {
    return { kind: "declared", by: ticket.likeInKindDeclaredBy ?? null, at: ticket.likeInKindDeclaredAt ? String(ticket.likeInKindDeclaredAt) : null };
  }
  return { kind: "seed" };
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

const REVIEW_MODEL_COLUMNS = ["engineering_required", "like_in_kind_statement", "like_in_kind_declared_by", "like_in_kind_declared_at", "like_in_kind_signature_id", "work_class", "code_class"];

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
