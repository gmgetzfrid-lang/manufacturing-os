// lib/versionApproval.ts — who approved a revision, derived from the record
// (drafting-flow EVID-4, DF-P11; ruled by the integrator under DEC-90,
// 2026-10-20, ruling (4)).
//
// document_versions.approved_by / approved_at are written by no code path,
// and approved_by_name is a free-text box the PUBLISHER types in the rev-up
// modal. It used to be rendered as an approval stamp (Version History) and
// printed in the evidence pack's "Approved" column, indistinguishable from a
// real sign-off. The approval is now DERIVED, never typed:
//   * "roster" — the version's signed review sign-offs
//     (document_review_signoffs, status 'signed', bound to this version by
//     document_version_id; the e-signature ceremony writes signature_id).
//     The approval time is the last signature.
//   * "publisher" — no signed roster row: the publisher's own identity
//     (created_by / created_by_name), at the release time. Releasing is the
//     act that person is accountable for; it is not a second person's check.
//   * "unread" — the roster could not be read: said, never guessed.
// What the publisher typed (approved_by_name, and any stored approved_by /
// approved_at) is shown as before but labelled as the publisher's CLAIM —
// an approval reference, never a stamp.

import { supabase } from "@/lib/supabase";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";

export interface RosterSigner {
  userId: string;
  name: string | null;
  role: string | null;
  signedAt: string | null;
  /** e_signatures.id when the sign-off went through the signature ceremony. */
  signatureId: string | null;
}

export type ApprovalBasis =
  | { basis: "roster"; signers: RosterSigner[]; at: string | null }
  | { basis: "publisher"; userId: string | null; name: string | null; at: string | null }
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
}

const iso = (v: unknown): string | null => {
  if (v == null || v === "") return null;
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  const t = v as { toDate?: () => Date };
  if (typeof t.toDate === "function") return t.toDate().toISOString();
  return String(v);
};

/** Pure: the approval of one version from its row and its signed roster rows.
 *  `signers === null` means the roster could not be read. */
export function deriveVersionApproval(
  v: VersionApprovalInput,
  signers: RosterSigner[] | null,
  unreadReason = "the review sign-offs could not be read",
): VersionApproval {
  const claim = typeof v.approvedByName === "string" && v.approvedByName.trim() ? v.approvedByName.trim() : null;
  if (signers === null) return { approval: { basis: "unread", reason: unreadReason }, claim };
  if (signers.length > 0) {
    const times = signers.map((s) => s.signedAt).filter((t): t is string => !!t).sort();
    return { approval: { basis: "roster", signers, at: times.length ? times[times.length - 1] : null }, claim };
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
  if (p.basis === "roster") {
    return `Signed: ${p.signers.map((s) => `${s.name || "a reviewer"}${s.role ? ` (${s.role})` : ""}`).join(", ")}`;
  }
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
};

const CHUNK = 100;

/** The signed review sign-offs of each version, keyed by version id (a
 *  version with none maps to []). `null` when a read failed — the caller
 *  says "not known", never "no sign-off". */
export async function loadSignedRosters(versionIds: string[]): Promise<Map<string, RosterSigner[]> | null> {
  const ids = [...new Set(versionIds.filter(Boolean))];
  const out = new Map<string, RosterSigner[]>(ids.map((id) => [id, []]));
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("document_review_signoffs")
      .select("document_version_id, reviewer_user_id, reviewer_name, reviewer_role, signed_at, signature_id")
      .in("document_version_id", part)
      .eq("status", "signed");
    if (error) return null;
    for (const r of (data ?? []) as SignoffRow[]) {
      if (!r.document_version_id) continue;
      out.get(r.document_version_id)?.push({
        userId: r.reviewer_user_id, name: r.reviewer_name ?? null, role: r.reviewer_role ?? null,
        signedAt: r.signed_at ?? null, signatureId: r.signature_id ?? null,
      });
    }
  }
  return out;
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
}

const PAGE = 1000;

/** EVID-4 done-when 3: every CURRENT controlled revision in the workspace
 *  that has no signed review sign-off — the size of the gap between
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
  const unsignedIds = versionIds.filter((id) => (rosters.get(id) ?? []).length === 0);
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
      };
    });
}
