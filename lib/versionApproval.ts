// lib/versionApproval.ts — who approved a revision, derived from the record
// (drafting-flow EVID-4, DF-P11; ruled by the integrator under DEC-90,
// 2026-10-20, ruling (4)).
//
// document_versions.approved_by / approved_at are written by no code path,
// and approved_by_name is a free-text box the PUBLISHER types in the rev-up
// modal. It used to be rendered as an approval stamp (Version History) and
// printed in the evidence pack's "Approved" column, indistinguishable from a
// real sign-off. The approval is now DERIVED, never typed:
//   * "roster" — the version's review roster is COMPLETE: every required
//     slot is filled by a signature-backed sign-off (document_review_signoffs
//     bound to this version by document_version_id; the e-signature ceremony
//     writes signature_id), judged per slot exactly as the publish guard
//     judges it (lib/reviewControl.ts evaluateSlotCompletion). The approval
//     time is the last signature.
//   * "partial" — some sign-offs are signed but the roster is NOT complete
//     (a publish after REVIEW_GATE_SKIPPED, or one of three reviewers
//     signed): "Partially signed — n of m", never the approval stamp, and
//     counted as unsigned in the evidence pack (DF-P11 fix pass).
//   * "publisher" — no signed roster row: the publisher's own identity
//     (created_by / created_by_name), at the release time. Releasing is the
//     act that person is accountable for; it is not a second person's check.
//   * "backfill" — a historical revision added after the fact through the
//     backfill door (lib/revisions.ts backfillVersion — its stored
//     file name carries `__backfill__`): created_by is the person who
//     RECORDED it, not who released it, so it reads "Backfilled by", at the
//     historical release date (DF-P11 fix pass).
//   * "unread" — the roster could not be read: said, never guessed.
// What the publisher typed (approved_by_name, and any stored approved_by /
// approved_at) is shown as before but labelled as the publisher's CLAIM —
// an approval reference, never a stamp.

import { supabase } from "@/lib/supabase";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { evaluateSlotCompletion, type SlotRow } from "@/lib/reviewControl";

export interface RosterSigner {
  userId: string;
  name: string | null;
  role: string | null;
  signedAt: string | null;
  /** e_signatures.id when the sign-off went through the signature ceremony. */
  signatureId: string | null;
}

/** A version's review roster: the signed sign-offs (for display) and its
 *  per-slot completion (evaluateSlotCompletion over every row, any status). */
export interface RosterState {
  signers: RosterSigner[];
  /** Required primary slots on the roster (0 = no roster was opened). */
  required: number;
  /** Of those, slots filled by a signature-backed sign-off. */
  satisfied: number;
  complete: boolean;
}

/** No roster rows at all. */
export const EMPTY_ROSTER: RosterState = Object.freeze({ signers: [], required: 0, satisfied: 0, complete: false }) as RosterState;

/** Pure: a roster's state from its rows (every status). */
export function rosterStateFromRows(rows: ReadonlyArray<{
  status?: unknown; slot?: unknown; activated?: unknown; slot_group?: unknown; signature_id?: unknown;
  reviewer_user_id?: unknown; reviewer_name?: unknown; reviewer_role?: unknown; signed_at?: unknown;
}>): RosterState {
  const slotRows: SlotRow[] = rows.map((r) => ({
    slot: r.slot === "alternate" ? "alternate" : "primary",
    activated: r.activated !== false,
    status: String(r.status ?? ""),
    signatureId: (r.signature_id as string | null | undefined) ?? null,
    slotGroup: (r.slot_group as string | null | undefined) ?? null,
  }));
  const { requiredPrimaries, satisfied, complete } = evaluateSlotCompletion(slotRows);
  const signers = rows.filter((r) => r.status === "signed").map((r) => ({
    userId: String(r.reviewer_user_id ?? ""), name: (r.reviewer_name as string | null | undefined) ?? null,
    role: (r.reviewer_role as string | null | undefined) ?? null, signedAt: (r.signed_at as string | null | undefined) ?? null,
    signatureId: (r.signature_id as string | null | undefined) ?? null,
  }));
  return { signers, required: requiredPrimaries, satisfied, complete };
}

export type ApprovalBasis =
  | { basis: "roster"; signers: RosterSigner[]; at: string | null }
  | { basis: "partial"; signers: RosterSigner[]; required: number; satisfied: number; at: string | null }
  | { basis: "publisher"; userId: string | null; name: string | null; at: string | null }
  | { basis: "backfill"; userId: string | null; name: string | null; at: string | null }
  | { basis: "unread"; reason: string };

export interface VersionApproval {
  approval: ApprovalBasis;
  /** The publisher's typed approval reference (approved_by_name), if any —
   *  rendered as their claim, never as an approval. */
  claim: string | null;
}

/** The fields of a version the derivation reads (camel or snake case). */
export interface VersionApprovalInput {
  createdBy?: string | null;
  createdByName?: string | null;
  createdAt?: unknown;
  releasedAt?: unknown;
  approvedByName?: string | null;
  /** The stored file key: a backfilled historical revision's carries
   *  `__backfill__` (lib/revisions.ts backfillVersion). */
  fileUrl?: string | null;
}

/** True when the version was added through the backfill door. */
export function isBackfilledVersion(v: { fileUrl?: string | null }): boolean {
  return typeof v.fileUrl === "string" && v.fileUrl.includes("__backfill__");
}

const iso = (v: unknown): string | null => {
  if (v == null || v === "") return null;
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  const t = v as { toDate?: () => Date };
  if (typeof t.toDate === "function") return t.toDate().toISOString();
  return String(v);
};

/** Pure: the approval of one version from its row and its roster.
 *  `roster === null` means the roster could not be read. */
export function deriveVersionApproval(
  v: VersionApprovalInput,
  roster: RosterState | null,
  unreadReason = "the review sign-offs could not be read",
): VersionApproval {
  const claim = typeof v.approvedByName === "string" && v.approvedByName.trim() ? v.approvedByName.trim() : null;
  if (roster === null) return { approval: { basis: "unread", reason: unreadReason }, claim };
  const signers = roster.signers;
  if (signers.length > 0) {
    const times = signers.map((s) => s.signedAt).filter((t): t is string => !!t).sort();
    const at = times.length ? times[times.length - 1] : null;
    if (roster.complete) return { approval: { basis: "roster", signers, at }, claim };
    return { approval: { basis: "partial", signers, required: roster.required, satisfied: roster.satisfied, at }, claim };
  }
  if (isBackfilledVersion(v)) {
    return {
      approval: { basis: "backfill", userId: v.createdBy ?? null, name: v.createdByName ?? null, at: iso(v.releasedAt) ?? iso(v.createdAt) },
      claim,
    };
  }
  return {
    approval: {
      basis: "publisher",
      userId: v.createdBy ?? null,
      name: v.createdByName ?? null,
      at: iso(v.releasedAt) ?? iso(v.createdAt),
    },
    claim,
  };
}

/** One line for a table cell / a stamp label. */
export function approvalLine(a: VersionApproval): string {
  const p = a.approval;
  if (p.basis === "unread") return `Not known — ${p.reason}`;
  const names = (signers: RosterSigner[]) => signers.map((s) => `${s.name || "a reviewer"}${s.role ? ` (${s.role})` : ""}`).join(", ");
  if (p.basis === "roster") return `Signed: ${names(p.signers)}`;
  if (p.basis === "partial") return `Partially signed — ${p.satisfied} of ${p.required}: ${names(p.signers)}`;
  if (p.basis === "backfill") return `Backfilled by ${p.name || "unknown"} (historical revision; no review sign-off on record)`;
  return `Publisher: ${p.name || "unknown"} (no review sign-off)`;
}

/** The claim's label — the same words everywhere it is shown. */
export const APPROVAL_CLAIM_LABEL = "Approval reference (publisher's note)";

type SignoffRow = {
  document_version_id: string | null;
  reviewer_user_id: string;
  reviewer_name: string | null;
  reviewer_role: string | null;
  signed_at: string | null;
  signature_id: string | null;
  status: string | null;
  slot: string | null;
  slot_group: string | null;
  activated: boolean | null;
};

const CHUNK = 100;

/** The review roster of each version, keyed by version id — its signed
 *  sign-offs and its per-slot completion over every row (a version with no
 *  rows maps to EMPTY_ROSTER). `null` when a read failed — the caller says
 *  "not known", never "no sign-off". */
export async function loadSignedRosters(versionIds: string[]): Promise<Map<string, RosterState> | null> {
  const ids = [...new Set(versionIds.filter(Boolean))];
  const rows = new Map<string, SignoffRow[]>(ids.map((id) => [id, []]));
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("document_review_signoffs")
      .select("document_version_id, reviewer_user_id, reviewer_name, reviewer_role, signed_at, signature_id, status, slot, slot_group, activated")
      .in("document_version_id", part);
    if (error) return null;
    for (const r of (data ?? []) as SignoffRow[]) {
      if (!r.document_version_id) continue;
      rows.get(r.document_version_id)?.push(r);
    }
  }
  return new Map([...rows].map(([id, rs]) => [id, rs.length ? rosterStateFromRows(rs) : EMPTY_ROSTER]));
}

export interface UnsignedCurrentRevision {
  documentId: string;
  documentNumber: string | null;
  versionId: string;
  revisionLabel: string | null;
  publishedBy: string | null;
  publishedByName: string | null;
  /** What the publisher typed, if anything (their claim). */
  claim: string | null;
  /** Signed slots / required slots (0 / 0 when no roster was opened). */
  satisfied: number;
  required: number;
}

const PAGE = 1000;

/** EVID-4 done-when 3: every CURRENT controlled revision in the workspace
 *  whose review roster is not COMPLETE (no sign-off, or only some of the
 *  required slots signed) — the size of the gap between
 *  "approved by a second person" and "released by its publisher". Reads
 *  page past PostgREST's 1,000-row answer; a failed read throws (the caller
 *  says the list is not known — never a short list printed as complete). */
export async function listCurrentRevisionsWithoutSignedApproval(orgId: string): Promise<UnsignedCurrentRevision[]> {
  const docs: Array<{ id: string; document_number: string | null; current_version_id: string | null; status: string | null }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("documents")
      .select("id, document_number, current_version_id, status")
      .eq("org_id", orgId)
      .not("current_version_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`The documents could not be read (${error.message}).`);
    const got = (data ?? []) as typeof docs;
    docs.push(...got);
    if (got.length < PAGE) break;
  }
  const live = docs.filter((d) => d.current_version_id && !NOT_CURRENT_STATUSES.has(String(d.status ?? "")));
  const versionIds = live.map((d) => d.current_version_id as string);
  const rosters = await loadSignedRosters(versionIds);
  if (!rosters) throw new Error("The review sign-offs could not be read.");
  const unsignedIds = versionIds.filter((id) => !(rosters.get(id) ?? EMPTY_ROSTER).complete);
  const versions = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < unsignedIds.length; i += CHUNK) {
    const { data, error } = await supabase
      .from("document_versions")
      .select("id, revision_label, created_by, created_by_name, approved_by_name")
      .in("id", unsignedIds.slice(i, i + CHUNK));
    if (error) throw new Error(`The revisions could not be read (${error.message}).`);
    for (const v of (data ?? []) as Array<Record<string, unknown>>) versions.set(String(v.id), v);
  }
  return live
    .filter((d) => unsignedIds.includes(d.current_version_id as string))
    .map((d) => {
      const v = versions.get(d.current_version_id as string) ?? {};
      const claim = typeof v.approved_by_name === "string" && v.approved_by_name.trim() ? v.approved_by_name.trim() : null;
      return {
        documentId: d.id,
        documentNumber: d.document_number ?? null,
        versionId: d.current_version_id as string,
        revisionLabel: (v.revision_label as string | null) ?? null,
        publishedBy: (v.created_by as string | null) ?? null,
        publishedByName: (v.created_by_name as string | null) ?? null,
        claim,
        satisfied: (rosters.get(d.current_version_id as string) ?? EMPTY_ROSTER).satisfied,
        required: (rosters.get(d.current_version_id as string) ?? EMPTY_ROSTER).required,
      };
    });
}
