// lib/drawingAuditLog.ts — turning a drawing audit into a RECORD.
//
// The audit itself already exists and is careful (lib/drawingText.ts). What
// was missing is memory. Without it every question about a drawing set is
// answered by re-reading the whole set, and nobody can say "we checked that
// sheet at Rev C and it was clean" — which is the only form the answer is
// useful in. An audit you can't cite is an opinion.
//
// The verdict rules are pure and live here, so what gets written to the
// permanent record is unit-tested rather than emergent from a route handler.
//
// One deliberate omission: a reference pointing into a unit you were never
// given is NOT a finding. The audit already separates those, and treating
// them as defects manufactures alarm about drawings that are probably
// perfect. Only what's actionable becomes a verdict.

export type AuditStatus = "passed" | "broken_connectors" | "flagged" | "skipped";

/** One sheet as the auditor sees it. `name` must be the same string the
 *  findings refer to it by — the audit reports by display name. */
export interface AuditSheet {
  documentId: string;
  controlledDocumentId?: string | null;
  name: string;
  /** Declared drawing number where the title block gave one, else the name.
   *  This is the audit's key, so it has to be the sheet's real identity. */
  sheetNumber: string;
  /** "" when the revision isn't known — recorded honestly rather than
   *  guessed, because a verdict filed under the wrong revision is worse
   *  than no verdict at all. */
  revision: string;
  /** False when nothing was extracted from it: a scan, or not yet indexed.
   *  Those are SKIPPED, never passed — silence is not a clean bill. */
  indexed: boolean;
}

/** What the reference audit found, by sheet display name. */
export interface AuditFindings {
  /** Off-page connectors that name no destination drawing at all. */
  connectorsWithNoTarget: Array<{ sheet: string; box: string }>;
  /** Connector leaves a sheet; the named sheet has no matching box. */
  unreturnedConnectors: Array<{ from: string; to: string; box: string }>;
  /** Referenced sheets from a loaded series that aren't in the set. */
  missingInSeries: Array<{ ref: string; referencedBy: string[] }>;
  /** Both sheets loaded, target never references back. */
  oneWay: Array<{ from: string; to: string }>;
}

export interface SheetVerdict {
  documentId: string;
  controlledDocumentId: string | null;
  sheetNumber: string;
  revision: string;
  status: AuditStatus;
  details: {
    brokenConnectors: string[];
    missingReferences: string[];
    oneWay: string[];
  };
}

/**
 * A verdict per sheet.
 *
 * Severity is ordered, not summed: a sheet with a connector going nowhere is
 * `broken_connectors` even if it also has missing references, because that's
 * the finding somebody has to act on first.
 */
export function verdictsForSheets(
  sheets: readonly AuditSheet[],
  findings: AuditFindings,
): SheetVerdict[] {
  const broken = new Map<string, string[]>();
  const missing = new Map<string, string[]>();
  const oneWay = new Map<string, string[]>();

  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key) ?? [];
    if (!list.includes(value)) list.push(value);
    map.set(key, list);
  };

  for (const c of findings.connectorsWithNoTarget) {
    push(broken, c.sheet, `Connector ${c.box} names no destination drawing`);
  }
  for (const c of findings.unreturnedConnectors) {
    push(broken, c.from, `Connector ${c.box} continues to ${c.to}, which has no matching box`);
  }
  for (const m of findings.missingInSeries) {
    // A missing sheet is a finding against every sheet that pointed at it —
    // that's who has to chase it.
    for (const by of m.referencedBy) push(missing, by, `References ${m.ref}, which isn't in the set`);
  }
  for (const o of findings.oneWay) {
    push(oneWay, o.from, `References ${o.to}, which never references back`);
  }

  return sheets.map((s) => {
    const b = broken.get(s.name) ?? [];
    const m = missing.get(s.name) ?? [];
    const w = oneWay.get(s.name) ?? [];
    const status: AuditStatus = !s.indexed
      ? "skipped"
      : b.length > 0 ? "broken_connectors"
      : (m.length > 0 || w.length > 0) ? "flagged"
      : "passed";
    return {
      documentId: s.documentId,
      controlledDocumentId: s.controlledDocumentId ?? null,
      sheetNumber: s.sheetNumber,
      revision: s.revision,
      status,
      details: { brokenConnectors: b, missingReferences: m, oneWay: w },
    };
  });
}

/**
 * Which sheets actually need auditing.
 *
 * The whole point of the record: a sheet already audited at the revision in
 * front of you is done. A sheet audited at a DIFFERENT revision is not — it
 * has been redrawn since, and the old verdict says nothing about the new
 * drawing. `skipped` never counts as done, because it means we couldn't read
 * the sheet, not that we cleared it.
 */
export function sheetsNeedingAudit(
  sheets: readonly AuditSheet[],
  priorAudits: ReadonlyArray<{ sheet_number: string; revision_code: string; status: string }>,
): AuditSheet[] {
  const done = new Set(
    priorAudits
      .filter((a) => a.status !== "skipped")
      .map((a) => `${a.sheet_number}@${a.revision_code}`),
  );
  return sheets.filter((s) => !done.has(`${s.sheetNumber}@${s.revision}`));
}

/** Rows ready for upsert into drawing_audit_logs. */
export function verdictRows(orgId: string, verdicts: readonly SheetVerdict[], byUserId: string) {
  return verdicts.map((v) => ({
    org_id: orgId,
    document_id: v.controlledDocumentId,
    sheet_number: v.sheetNumber,
    revision_code: v.revision,
    status: v.status,
    audit_details: { ...v.details, by: byUserId, knowledgeDocumentId: v.documentId },
  }));
}
