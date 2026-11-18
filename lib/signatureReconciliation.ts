// lib/signatureReconciliation.ts — drafting-flow EVID-11 done-when 4 (F4
// SIGNATURE TRANSACTION, 2026-11-18): the reconciliation over e_signatures ↔
// the rosters ↔ the audit trail. Read-only SQL, one source: the database
// suite (lib/__tests__/rls/f4SignatureTransaction.test.ts) runs these
// statements as its helper, and 20261269's final SELECT carries their COUNTS
// (inventory rows, never a customer row) — a test pins that the migration
// holds each statement verbatim.
//
// An ORPHAN is a row whose partner the signing act should have written and
// did not:
//   * a signature with no trail — no ESIGNATURE_CAPTURED audit row naming it
//     (or, for a row minted before the route named the signature, the legacy
//     mirror: same resource, signer and intent, no signatureId), no
//     dead-lettered mirror still in the outbox and none recovered as an
//     AUDIT_DEAD_LETTER row (DEC-109);
//   * a roster row recorded as acknowledged / signed / satisfied whose
//     signature is missing or is not the signer's own for that row (the
//     database guards' own binding: org, signer, revision);
//   * a read-and-understood or review signature whose signer is on that
//     DOCUMENT's roster (any revision / any draft — a versionless signature
//     and one paired with a row on another revision included) but that no
//     roster row carries — EVID-11's failure scenario (the signature landed,
//     the roster stayed pending).
// NOT an orphan, by design: a free-standing signature on a record (the
// Formal approvals panel, the command palette) and a ticket signature
// presented as a credential to a server route (a declaration, a
// pre-authorization, a slot sign-off) — no roster row is written for those
// by the signing act; they are reconciled against the audit trail only.
// (A free-standing Acknowledged signature by someone who also holds a roster
// row on that document IS reported: the database cannot tell it from a
// failed roster write, so it is named for a person to judge.)
//
// Each statement selects (org_id, id) so a caller can scope it to one
// workspace, and joins only on equality keys (no OR inside a correlated
// subquery — the trail check is two NOT EXISTS, one per match, so the planner
// hashes or merges on them instead of comparing every signature with every
// mirror of its workspace). No apostrophe inside any literal (DEC-30).

export interface SignatureOrphanCheck {
  key: string;
  /** What an orphan of this kind means, as the inventory row says it. */
  label: string;
  /** SELECT org_id, id … — the orphans, read-only. */
  sql: string;
}

export const SIGNATURE_ORPHAN_CHECKS: readonly SignatureOrphanCheck[] = [
  {
    key: "signature_without_audit_trail",
    label: "e-signatures with no ESIGNATURE_CAPTURED trail (no audit row naming it, no dead letter kept or recovered)",
    sql: `SELECT s.org_id, s.id FROM e_signatures s
 WHERE NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.action = 'ESIGNATURE_CAPTURED' AND a.org_id = s.org_id
                      AND a.details ->> 'signatureId' = s.id::text)
   AND NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.action = 'ESIGNATURE_CAPTURED' AND a.org_id = s.org_id
                      AND NOT (a.details ? 'signatureId') AND lower(a.resource_id) = s.resource_id::text
                      AND a.user_id = s.signer_user_id AND a.details ->> 'intent' = s.intent)
   AND NOT EXISTS (SELECT 1 FROM audit_dead_letters d
                    WHERE d.action = 'ESIGNATURE_CAPTURED' AND d.org_id = s.org_id
                      AND d.entry -> 'row' -> 'details' ->> 'signatureId' = s.id::text)
   AND NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.action = 'AUDIT_DEAD_LETTER' AND a.org_id = s.org_id
                      AND a.details -> 'lost' -> 'details' ->> 'signatureId' = s.id::text)`,
  },
  {
    key: "acknowledged_roster_without_its_signature",
    label: "read-and-understood roster rows marked acknowledged whose signature is missing or not the assignee own for that revision",
    sql: `SELECT r.org_id, r.id FROM document_acknowledgments r
 WHERE r.status = 'acknowledged'
   AND NOT EXISTS (SELECT 1 FROM e_signatures s
                    WHERE s.id = r.signature_id AND s.org_id = r.org_id AND s.signer_user_id = r.assignee_user_id
                      AND (r.document_version_id IS NULL OR s.document_version_id IS NULL
                           OR s.document_version_id = r.document_version_id))`,
  },
  {
    key: "signed_review_row_without_its_signature",
    label: "review sign-off rows marked signed whose signature is missing or not the reviewer own for that draft",
    sql: `SELECT r.org_id, r.id FROM document_review_signoffs r
 WHERE r.status = 'signed'
   AND NOT EXISTS (SELECT 1 FROM e_signatures s
                    WHERE s.id = r.signature_id AND s.org_id = r.org_id AND s.signer_user_id = r.reviewer_user_id
                      AND s.document_version_id IS NOT DISTINCT FROM r.document_version_id)`,
  },
  {
    key: "satisfied_ticket_slot_without_its_signature",
    label: "ticket review slots satisfied by a signature that does not exist in the workspace",
    sql: `SELECT t.org_id, t.id FROM ticket_review_slots t
 WHERE t.status = 'satisfied' AND t.signature_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM e_signatures s WHERE s.id = t.signature_id AND s.org_id = t.org_id)`,
  },
  {
    key: "acknowledgment_signature_without_roster_row",
    label: "read-and-understood signatures whose signer is on that document roster (any revision) but that no roster row carries",
    sql: `SELECT s.org_id, s.id FROM e_signatures s
 WHERE s.intent = 'Acknowledged' AND s.resource_type = 'document'
   AND EXISTS (SELECT 1 FROM document_acknowledgments r
                WHERE r.document_id = s.resource_id AND r.assignee_user_id = s.signer_user_id)
   AND NOT EXISTS (SELECT 1 FROM document_acknowledgments r WHERE r.signature_id = s.id)`,
  },
  {
    key: "review_signature_without_signoff_row",
    label: "review signatures whose signer is on that document review roster (any draft) but that no sign-off row carries",
    sql: `SELECT s.org_id, s.id FROM e_signatures s
  JOIN document_versions v ON v.id = COALESCE(s.document_version_id, s.resource_id)
 WHERE s.intent = 'Reviewed' AND s.resource_type = 'document_version'
   AND EXISTS (SELECT 1 FROM document_review_signoffs r
                WHERE r.document_id = v.record_id AND r.reviewer_user_id = s.signer_user_id)
   AND NOT EXISTS (SELECT 1 FROM document_review_signoffs r WHERE r.signature_id = s.id)`,
  },
];

/** The count form 20261269's inventory uses for one check. */
export function orphanCountSql(c: SignatureOrphanCheck): string {
  return `(SELECT COUNT(*) FROM (${c.sql}) q)::text`;
}

/** One check scoped to a workspace (a test helper; the uuid is the caller's). */
export function orphanIdsSql(c: SignatureOrphanCheck, orgId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error("orphanIdsSql: orgId must be a uuid");
  return `SELECT q.id FROM (${c.sql}) q WHERE q.org_id = '${orgId}' ORDER BY q.id`;
}
