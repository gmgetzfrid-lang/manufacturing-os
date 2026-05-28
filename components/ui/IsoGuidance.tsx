"use client";

// IsoGuidance — small tooltip widget mapping ISO 9001 + ISO 19650
// touchpoints to plain-language explanations so a user clicking the
// (?) icon next to a control understands the standard it implements.
//
// 9001 = generic Quality Management (controlled documents, change
//        approvals, records of evidence, traceability).
// 19650 = Information Management for the built asset lifecycle —
//        approval/issue states, common data environment, naming
//        conventions, MOC.
//
// Each topic is short, written for an operator, not a consultant.
// Add new topics here as the product grows; the call sites only
// reference them by string id.

import React from "react";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { ShieldCheck } from "lucide-react";

export type IsoTopic =
  | "controlled_document"
  | "checkout_lock"
  | "revision_history"
  | "ifc_release"
  | "supersede"
  | "moc_reference"
  | "hold"
  | "engineer_approval"
  | "audit_log"
  | "checkout_purpose"
  | "drafting_request_intent";

interface Entry {
  title: string;
  body: React.ReactNode;
  refs: string[]; // e.g., ['ISO 9001 §7.5.3', 'ISO 19650-2 §5.6']
}

const ENTRIES: Record<IsoTopic, Entry> = {
  controlled_document: {
    title: "Controlled document",
    body: (
      <>
        A document under change control: every revision is captured, the latest
        approved version is the only one used downstream, and superseded copies are
        flagged. Anything in this library page (other than Drafts and Archived) is
        considered controlled.
      </>
    ),
    refs: ["ISO 9001 §7.5.3", "ISO 19650-2 §5.6"],
  },
  checkout_lock: {
    title: "Why checkout exists",
    body: (
      <>
        Checkout signals an active edit and creates a record of who&apos;s working
        on what. Two people can both checkout in <i>view</i> mode for review, but
        only one can hold an <i>edit</i> lock at a time. The purpose field is
        required so future audits can see <i>why</i> the document was being modified.
      </>
    ),
    refs: ["ISO 9001 §7.5.3.b", "ISO 19650-2 §5.5"],
  },
  revision_history: {
    title: "Revision history",
    body: (
      <>
        Every revision (Rev 0, 1, A, B…) is preserved with the file hash, the
        engineer + drafter + checker on the signoff chain, the change narrative,
        and the MOC reference. You can&apos;t overwrite history — only add to it.
      </>
    ),
    refs: ["ISO 9001 §7.5.3.c", "ISO 19650-2 §5.7"],
  },
  ifc_release: {
    title: "IFC (Issued for Construction)",
    body: (
      <>
        An IFC release is the formal handoff from engineering to the field. After
        an IFC, only authorised users may supersede the document. The pre-IFC
        review chain (drafter → engineer → manager) is mandatory for non-engineer
        requesters; engineers can self-approve.
      </>
    ),
    refs: ["ISO 19650-2 §5.6.6"],
  },
  supersede: {
    title: "Supersede vs replace",
    body: (
      <>
        Supersede means a new document <i>replaces</i> an older controlled one —
        the old version stays in the archive, but every downstream reference
        points at the new one. Use supersede when the doc number changes (split,
        merge, renumber). Use a new revision when the number stays the same.
      </>
    ),
    refs: ["ISO 9001 §7.5.3.d", "ISO 19650-2 §5.7.3"],
  },
  moc_reference: {
    title: "MOC reference",
    body: (
      <>
        Every controlled change must be traceable to a Management of Change record.
        Drop the MOC number here so the audit trail links the document update to
        the engineering safety review that authorised it.
      </>
    ),
    refs: ["ISO 9001 §6.3", "OSHA PSM 1910.119(l)"],
  },
  hold: {
    title: "Hold",
    body: (
      <>
        A hold blocks a controlled document from being acted on (no new revisions,
        no IFC release) while an open question is resolved — vendor data missing,
        engineering review pending, MOC not closed out, etc. Opening a hold is a
        public, audited event with a reason.
      </>
    ),
    refs: ["ISO 9001 §8.3.5"],
  },
  engineer_approval: {
    title: "Engineer sign-off",
    body: (
      <>
        Drawings have to be approved by a qualified engineer before IFC. The
        system enforces this: viewer-tier requesters submitting a draft go through
        a final engineer-approval step; engineers can approve their own drafts.
        Sign-off is recorded against the user&apos;s role at the moment of approval.
      </>
    ),
    refs: ["ISO 9001 §8.3.4", "ISO 19650-2 §5.6.5"],
  },
  audit_log: {
    title: "Audit log",
    body: (
      <>
        Every meaningful action — open, view, download, checkout, checkin,
        approve, supersede, archive — is captured in the audit log with who,
        when, and the resource it touched. The log is append-only.
      </>
    ),
    refs: ["ISO 9001 §7.5.3.f"],
  },
  checkout_purpose: {
    title: "Why purpose is required",
    body: (
      <>
        Capturing why a document is checked out lets the team see scope at a
        glance, avoids parallel edits stepping on each other, and gives auditors
        the &quot;why&quot; behind every change after the fact.
      </>
    ),
    refs: ["ISO 9001 §7.5.3.b"],
  },
  drafting_request_intent: {
    title: "Drafting request — captured intent",
    body: (
      <>
        The drafting request is the controlled-document equivalent of a work
        order. It binds a unit / area / priority to the work, records the
        requester role + history of every workflow step, and ends in either an
        IFC release or a documented close-out reason.
      </>
    ),
    refs: ["ISO 9001 §8.5.1", "ISO 19650-2 §5.5"],
  },
};

interface Props {
  topic: IsoTopic;
  placement?: "top" | "bottom" | "left" | "right";
  size?: "sm" | "md";
}

export default function IsoGuidance({ topic, placement, size }: Props) {
  const entry = ENTRIES[topic];
  if (!entry) return null;
  return (
    <HelpTooltip placement={placement} size={size}>
      <div>
        <div className="flex items-center gap-1.5 mb-1.5">
          <ShieldCheck className="w-3 h-3 text-emerald-400" />
          <span className="text-[10px] font-black text-emerald-300 uppercase tracking-widest">ISO Guidance</span>
        </div>
        <div className="text-[11px] font-bold mb-1">{entry.title}</div>
        <div className="text-[11px] text-slate-200 leading-relaxed">{entry.body}</div>
        <div className="mt-2 pt-2 border-t border-slate-700/60 text-[10px] text-slate-400">
          {entry.refs.join(" · ")}
        </div>
      </div>
    </HelpTooltip>
  );
}
