// lib/checkinOutcomes.ts
//
// CHECK-IN OUTCOMES — the pure decision engine behind "how did it go?".
//
// Check-in never asks a question the system can already answer. Three facts
// are already known by the time someone checks in:
//
//   * WHY they had the document out (the mandatory checkout purpose),
//   * WHAT KIND of document it is (the declared doc_class — see lib/docClass),
//   * WHAT AUTHORITY they hold (per-library publish grant / effective owner).
//
// From those, this module derives the 2–4 outcome cards the check-in screen
// shows — never the full menu — plus the per-branch rules:
//
//   * every claim-creating branch requires a TYPED note (no canned text,
//     no get-out-of-jail-free cards — same bar as approve_minor_correction),
//   * a real change to a DRAWING-class document demands an MOC position
//     (OSHA 1910.119(l)): a completed MOC number, an in-progress one, or an
//     explicit "no MOC exists" — which is never blocked, because an
//     undocumented field change is precisely what DocCtrl must hear about,
//   * minor corrections are replacement-in-kind: no MOC, mirroring the
//     existing Minor/Correction review-gate exemption.
//
// Pure and unit-tested — same pattern as computeCheckInTransition and
// evaluatePublishGuard. All DB/UI wiring lives in CheckInPanel.

import type { DocClass } from "@/lib/docClass";

/** What the register records for a finished session. */
export type CheckInOutcome =
  | "all_clear"            // done; document right as it stands
  | "field_verified"       // positive walkdown attestation against current rev
  | "discrepancy"          // field differs from the document — as-built needed
  | "correction_requested" // typo/label-level fix requested (minor, no MOC)
  | "revision_requested"   // real change requested from drafting
  | "published"            // publisher released the update directly
  | "submitted_for_review" // publisher's update entered the review gate
  | "sent_to_owner"        // changes routed to the document's effective owner
  | "handoff"              // left mid-episode; work continues with the others
  | "auto_released";       // expiry sweep, never a human choice

/** What the UI does when the card is confirmed. */
export type CheckInAction =
  | "release"          // end my session, record the outcome
  | "attest_release"   // release + write the field-verification attestation
  | "draft_ticket"     // create a drafting request, then release
  | "open_publish"     // open RevUpModal (review gate auto-honored), then release
  | "notify_owner"     // durable notification to the effective owner, then release
  | "handoff_release"; // post handoff note to the thread, lock transfers

export type MocRequirement = "required" | "none";
export type MocStatus = "completed" | "in_progress" | "none";

export interface CheckInCard {
  id: string;
  outcome: CheckInOutcome;
  action: CheckInAction;
  label: string;
  hint: string;
  requiresNote: boolean;
  notePrompt?: string;
  moc: MocRequirement;
  /** Redline photos / marked-up PDFs attach to the created ticket. */
  allowUploads?: boolean;
  /** Offer the existing "Field Verification Needed" hold alongside the report. */
  allowHoldOffer?: boolean;
  ticketKind?: "asbuilt" | "revision" | "minor";
  tone: "positive" | "neutral" | "action" | "publish";
  /** Exactly one card per set is pre-selected — the most likely honest answer. */
  recommended?: boolean;
}

export interface CheckInContext {
  /** checkout_sessions.purpose as stored (free text; null on legacy rows). */
  purpose: string | null;
  /** Resolved document class; null = unclassified (behave like today). */
  docClass: DocClass | null;
  /** Per-library publish grant OR controller OR effective owner. */
  canPublishEff: boolean;
  /** Other active sessions remain on this episode. */
  othersRemain: boolean;
}

/** A real change to a declared drawing needs an MOC position. Corrections are
 *  replacement-in-kind; unclassified documents can't be held to a rule nobody
 *  declared for them. */
export function mocRequirementFor(
  docClass: DocClass | null,
  outcome: CheckInOutcome,
): MocRequirement {
  const realChange = outcome === "discrepancy" || outcome === "revision_requested";
  return docClass === "drawing" && realChange ? "required" : "none";
}

type PurposeGroup = "asbuilt" | "field" | "review" | "change" | "generic";

export function purposeGroup(purpose: string | null): PurposeGroup {
  switch (purpose) {
    case "As-Built Verification": return "asbuilt";
    case "Field Reference": return "field";
    case "Review / Approval": return "review";
    case "Revision / Update":
    case "Redline / Markup": return "change";
    default: return "generic"; // Other, Quick Hold, legacy no-purpose
  }
}

// ── Card builders (kept tiny so the derivation below reads as the spec) ─────

const attestCard = (recommended: boolean): CheckInCard => ({
  id: "field_verified",
  outcome: "field_verified",
  action: "attest_release",
  label: "Field matches — verified",
  hint: "Records your walkdown: field verified against the current revision, with your name and the date. This is the drawing's accuracy record.",
  requiresNote: false,
  moc: "none",
  tone: "positive",
  recommended,
});

const discrepancyCard = (docClass: DocClass | null): CheckInCard => ({
  id: "discrepancy",
  outcome: "discrepancy",
  action: "draft_ticket",
  label: "Field is different — report it",
  hint: "Opens a drafting request so the document gets brought up to reality. Attach redline photos or a marked-up copy below.",
  requiresNote: true,
  notePrompt: "What's different in the field?",
  moc: mocRequirementFor(docClass, "discrepancy"),
  allowUploads: true,
  allowHoldOffer: true,
  ticketKind: "asbuilt",
  tone: "action",
});

const allClearCard = (label: string, hint: string, recommended: boolean): CheckInCard => ({
  id: "all_clear",
  outcome: "all_clear",
  action: "release",
  label,
  hint,
  requiresNote: false,
  moc: "none",
  tone: "neutral",
  recommended,
});

const correctionCard = (canPublishEff: boolean): CheckInCard => ({
  id: "correction",
  outcome: "correction_requested",
  action: canPublishEff ? "open_publish" : "draft_ticket",
  label: "Minor correction (typo, label, note)",
  hint: canPublishEff
    ? "Replacement-in-kind — publish it as a Correction. No MOC needed; the review gate is waived for corrections."
    : "Replacement-in-kind — sends a minor-correction request to drafting. No MOC needed.",
  requiresNote: true,
  notePrompt: "What exactly needs correcting?",
  moc: "none",
  ticketKind: "minor",
  tone: "action",
});

const draftRevisionCard = (docClass: DocClass | null, recommended: boolean, redline: boolean): CheckInCard => ({
  id: "revision",
  outcome: "revision_requested",
  action: "draft_ticket",
  label: docClass === "drawing" ? "Send redlines to drafting" : "Send to drafting",
  hint: redline
    ? "Opens a drafting request with your markups attached — use Download w/ Markup in the viewer, then attach that file below."
    : "Opens a drafting request for the real change, with your notes and any files attached.",
  requiresNote: true,
  notePrompt: "What needs to change, and why?",
  moc: mocRequirementFor(docClass, "revision_requested"),
  allowUploads: true,
  ticketKind: "revision",
  tone: "action",
  recommended,
});

const publishCard = (docClass: DocClass | null, recommended: boolean): CheckInCard => ({
  id: "publish",
  outcome: "published", // becomes submitted_for_review when the gate takes it
  action: "open_publish",
  label: docClass === "drawing" ? "Publish the drafted revision" : "Publish my update now",
  hint: docClass === "drawing"
    ? "Opens the publish flow. A non-minor drawing revision requires its MOC number there — and your review gate applies as configured."
    : "Opens the publish flow and releases your checkout. If this library reviews before release, it becomes Submit for Review automatically.",
  requiresNote: false,
  moc: "none", // enforced inside RevUpModal, where changeType is known
  tone: "publish",
  recommended,
});

const sendToOwnerCard = (recommended: boolean): CheckInCard => ({
  id: "sent_to_owner",
  outcome: "sent_to_owner",
  action: "notify_owner",
  label: "Send my changes to the owner to review & release",
  hint: "You don't hold release authority here. Your notes go durably (in-app + email) to the document's effective owner — falling back to Document Control.",
  requiresNote: true,
  notePrompt: "Describe the change you're proposing.",
  moc: "none",
  tone: "action",
  recommended,
});

const handoffCard = (): CheckInCard => ({
  id: "handoff",
  outcome: "handoff",
  action: "handoff_release",
  label: "Hand off to the others",
  hint: "Others are still on this checkout. Your note posts to the thread and the lock passes to them.",
  requiresNote: true,
  notePrompt: "Where are you leaving this for them?",
  moc: "none",
  tone: "neutral",
});

// ── The derivation — one question, 2–4 cards, purpose-tuned ─────────────────

export function checkInCardsFor(ctx: CheckInContext): CheckInCard[] {
  const group = purposeGroup(ctx.purpose);
  const cards: CheckInCard[] = [];

  switch (group) {
    case "asbuilt":
      // The walkdown question IS the check-in.
      cards.push(attestCard(true), discrepancyCard(ctx.docClass));
      break;

    case "field":
      // Reference use: "done" is the likely truth; attestation stays a
      // deliberate act, never the default.
      cards.push(
        allClearCard("Done — no issues found", "Releases your checkout. Nothing else happens.", true),
        attestCard(false),
        discrepancyCard(ctx.docClass),
      );
      break;

    case "review":
      cards.push(
        allClearCard("Reviewed — good as is", "The document passed your review unchanged.", true),
        correctionCard(ctx.canPublishEff),
        draftRevisionCard(ctx.docClass, false, false),
      );
      break;

    case "change": {
      const redline = ctx.purpose === "Redline / Markup";
      if (ctx.docClass === "procedure" && !ctx.canPublishEff) {
        // Text document, no release authority: route to the owner.
        cards.push(
          sendToOwnerCard(true),
          allClearCard("No change needed after all", "Releases your checkout with nothing filed.", false),
        );
      } else {
        if (ctx.canPublishEff) cards.push(publishCard(ctx.docClass, true));
        cards.push(
          draftRevisionCard(ctx.docClass, !ctx.canPublishEff, redline),
          correctionCard(ctx.canPublishEff),
          allClearCard("No change needed after all", "Releases your checkout with nothing filed.", false),
        );
      }
      break;
    }

    case "generic":
      cards.push(
        allClearCard("Done — release", "Releases your checkout. Nothing else happens.", true),
        draftRevisionCard(ctx.docClass, false, false),
      );
      if (ctx.canPublishEff) cards.push(publishCard(ctx.docClass, false));
      break;
  }

  if (ctx.othersRemain) cards.push(handoffCard());
  return cards;
}

// ── Validation — everything stated up front, no click-punishment ────────────

export interface CheckInInput {
  note: string;
  mocStatus: MocStatus | null;
  mocNumber: string;
}

/** Null = good to go; otherwise the one plain sentence the button shows. */
export function validateCheckIn(card: CheckInCard, input: CheckInInput): string | null {
  if (card.requiresNote && input.note.trim().length < 5) {
    return card.notePrompt ?? "Add a brief note (5+ characters).";
  }
  if (card.moc === "required") {
    if (!input.mocStatus) return "State the MOC position — PSM requires it for drawing changes.";
    if (input.mocStatus !== "none" && input.mocNumber.trim().length < 3) {
      return "Enter the MOC number.";
    }
  }
  return null;
}
