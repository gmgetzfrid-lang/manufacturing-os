// drafting-flow Round G, DF-P11 — the evidence halves:
//   * EVID-4: "Approved" is derived (the signed review roster, else the
//     publisher), and the typed box is the publisher's claim, never a stamp.
//   * EVID-10: the document evidence pack carries signatures, sign-offs,
//     acknowledgments, distribution confirmations, issued copies and the
//     originating request; the audit trail pages and says when truncated;
//     the footer says what the pack holds.
//   * EVID-11 done-when 1: the read-and-understood roster write is checked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  readError: {} as Record<string, { message: string } | undefined>,
  updates: [] as Array<{ table: string; patch: Row; filters: Array<[string, string, unknown]> }>,
  updateResult: null as null | { data: unknown; error: unknown },
}));
function table(name: string) {
  const filters: Array<[string, string, unknown]> = [];
  let op: { patch: Row } | null = null;
  let range: [number, number] | null = null;
  const match = (r: Row) => filters.every(([k, f, v]) =>
    f === "eq" ? r[k] === v : f === "in" ? (v as unknown[]).includes(r[k]) : f === "is" ? (r[k] ?? null) === v : f === "not" ? r[k] != null : true);
  const run = () => {
    if (op) {
      db.updates.push({ table: name, patch: op.patch, filters: [...filters] });
      if (db.updateResult) return db.updateResult;
      const hit = (db.tables[name] ?? []).filter(match);
      for (const r of hit) Object.assign(r, op.patch);
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    if (db.readError[name]) return { data: null, error: db.readError[name] };
    let hit = (db.tables[name] ?? []).filter(match);
    if (range) hit = hit.slice(range[0], range[1] + 1);
    return { data: hit, error: null };
  };
  const q: Record<string, unknown> = {
    select() { return q; },
    eq(k: string, v: unknown) { filters.push([k, "eq", v]); return q; },
    in(k: string, v: unknown[]) { filters.push([k, "in", v]); return q; },
    is(k: string, v: unknown) { filters.push([k, "is", v]); return q; },
    not(k: string) { filters.push([k, "not", null]); return q; },
    order() { return q; },
    range(a: number, b: number) { range = [a, b]; return q; },
    update(patch: Row) { op = { patch }; return q; },
    maybeSingle() { const out = run(); return Promise.resolve({ data: (out.data as Row[] | null)?.[0] ?? null, error: out.error }); },
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve().then(run).then(res, rej); },
  };
  return q;
}
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => table(t) } }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn(async () => ({ id: "sig-1" })) }));
vi.mock("@/lib/complianceNotify", () => ({ notifyCompliance: vi.fn(async () => true), loadScanRetryPlan: vi.fn() }));
vi.mock("@/lib/notify/dispatch", () => ({ pushAfterBellRows: vi.fn(), emit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/ownership", () => ({
  resolveEffectiveOwner: vi.fn(), effectiveOwnerForDocument: vi.fn(async () => ({ userId: null })),
  getOrgControllers: vi.fn(async () => []), teamSupervisorMap: vi.fn(),
}));

import {
  deriveVersionApproval, approvalLine, loadSignedRosters, listCurrentRevisionsWithoutSignedApproval, APPROVAL_CLAIM_LABEL,
  EMPTY_ROSTER, rosterStateFromRows, isBackfilledVersion, type RosterSigner, type RosterState,
} from "@/lib/versionApproval";
import { gatherEvidence, renderEvidenceHtml, EVIDENCE_SECTIONS } from "@/lib/evidencePack";
import { recordAcknowledgment } from "@/lib/acknowledgments";

beforeEach(() => { db.tables = {}; db.readError = {}; db.updates = []; db.updateResult = null; });

const SIGNER = { userId: "r1", name: "J. Okafor", role: "Engineer-3", signedAt: "2026-10-02T10:00:00Z", signatureId: "s1" };
/** A complete roster of the given signers (one signature-backed primary each). */
const complete = (signers: RosterSigner[]): RosterState => ({ signers, required: signers.length, satisfied: signers.length, complete: true });

// ═══════════════════════════════════════════════════════════════════════════
describe("EVID-4 — the approval is derived, the typed box is a claim", () => {
  const v = { createdBy: "pub", createdByName: "Pat Publisher", createdAt: "2026-10-01T00:00:00Z", releasedAt: "2026-10-01T01:00:00Z" };
  it("a signed review roster is the approval, at the last signature", () => {
    const a = deriveVersionApproval({ ...v, approvedByName: "J. Okafor, PE" }, complete([SIGNER, { ...SIGNER, userId: "r2", name: "B", signedAt: "2026-10-03T00:00:00Z" }]));
    expect(a.approval.basis).toBe("roster");
    expect(a.approval.basis === "roster" && a.approval.at).toBe("2026-10-03T00:00:00Z");
    expect(approvalLine(a)).toBe("Signed: J. Okafor (Engineer-3), B (Engineer-3)");
    expect(a.claim).toBe("J. Okafor, PE");
  });
  it("no signed roster row: the publisher's identity at release — and the typed name is only a claim", () => {
    const a = deriveVersionApproval({ ...v, approvedByName: "J. Okafor, PE" }, EMPTY_ROSTER);
    expect(a.approval).toEqual({ basis: "publisher", userId: "pub", name: "Pat Publisher", at: "2026-10-01T01:00:00Z" });
    expect(approvalLine(a)).toBe("Publisher: Pat Publisher (no review sign-off)");
    expect(approvalLine(a)).not.toContain("Okafor");
    expect(a.claim).toBe("J. Okafor, PE");
  });
  it("a roster that could not be read is 'not known', never 'publisher'", () => {
    const a = deriveVersionApproval(v, null);
    expect(a.approval.basis).toBe("unread");
    expect(approvalLine(a)).toMatch(/^Not known/);
  });
  it("fix pass: ONE signed slot of three is 'Partially signed — 1 of 3', never the approval stamp", () => {
    const rows = [
      { status: "signed", slot: "primary", activated: true, slot_group: "person:r1", signature_id: "s1", reviewer_user_id: "r1", reviewer_name: "A. Reviewer", reviewer_role: "Engineer-2", signed_at: "2026-10-02T00:00:00Z" },
      { status: "pending", slot: "primary", activated: true, slot_group: "person:r2", signature_id: null, reviewer_user_id: "r2" },
      { status: "pending", slot: "primary", activated: true, slot_group: "person:r3", signature_id: null, reviewer_user_id: "r3" },
    ];
    const st = rosterStateFromRows(rows);
    expect(st).toMatchObject({ required: 3, satisfied: 1, complete: false });
    const a = deriveVersionApproval(v, st);
    expect(a.approval.basis).toBe("partial");
    expect(approvalLine(a)).toBe("Partially signed — 1 of 3: A. Reviewer (Engineer-2)");
    // every slot signed (an activated alternate fills its slot): the stamp
    const all = rosterStateFromRows([
      rows[0],
      { ...rows[1], status: "signed", signature_id: "s2", reviewer_name: "B" },
      { ...rows[2], status: "void" },
      { status: "signed", slot: "alternate", activated: true, slot_group: "person:r3", signature_id: "s4", reviewer_user_id: "alt", reviewer_name: "C" },
    ]);
    expect(all).toMatchObject({ required: 3, satisfied: 3, complete: true });
    expect(deriveVersionApproval(v, all).approval.basis).toBe("roster");
    // a row born 'signed' with no bound signature fills nothing (RG-1)
    expect(rosterStateFromRows([{ ...rows[0], signature_id: null }])).toMatchObject({ required: 1, satisfied: 0, complete: false });
  });
  it("fix pass: a backfilled historical revision reads 'Backfilled by', at the historical release date — not 'Released by'", () => {
    const back = { createdBy: "dc", createdByName: "Dee Controller", createdAt: "2026-10-20T00:00:00Z", releasedAt: "2019-03-01T00:00:00Z",
      approvedByName: "J. Smith", fileUrl: "orgs/o1/libraries/l1/P-101__revB__backfill__1760918400000.pdf" };
    expect(isBackfilledVersion(back)).toBe(true);
    expect(isBackfilledVersion({ fileUrl: "orgs/o1/libraries/l1/P-101.pdf" })).toBe(false);
    const a = deriveVersionApproval(back, EMPTY_ROSTER);
    expect(a.approval).toEqual({ basis: "backfill", userId: "dc", name: "Dee Controller", at: "2019-03-01T00:00:00Z" });
    expect(approvalLine(a)).toBe("Backfilled by Dee Controller (historical revision; no review sign-off on record)");
    expect(approvalLine(a)).not.toMatch(/Publisher|Released/);
    expect(a.claim).toBe("J. Smith");
  });
  it("loadSignedRosters keys each version's roster (signed rows + per-slot completion over every row); a failed read is null", async () => {
    db.tables.document_review_signoffs = [
      { document_version_id: "v1", reviewer_user_id: "r1", reviewer_name: "J", status: "signed", signed_at: "t", signature_id: "s", slot: "primary", activated: true, slot_group: "person:r1" },
      { document_version_id: "v1", reviewer_user_id: "r2", reviewer_name: "K", status: "pending", slot: "primary", activated: true, slot_group: "person:r2" },
    ];
    const m = await loadSignedRosters(["v1", "v2"]);
    expect(m?.get("v1")?.signers.map((s) => s.userId)).toEqual(["r1"]);
    expect(m?.get("v1")).toMatchObject({ required: 2, satisfied: 1, complete: false });
    expect(m?.get("v2")).toEqual(EMPTY_ROSTER);
    db.readError.document_review_signoffs = { message: "down" };
    expect(await loadSignedRosters(["v1"])).toBeNull();
  });
  it("done-when 3: every current revision without a signed review sign-off is enumerable", async () => {
    db.tables.documents = [
      { id: "d1", org_id: "o1", document_number: "P-1", current_version_id: "v1", status: "Issued" },
      { id: "d2", org_id: "o1", document_number: "P-2", library_id: "L1", current_version_id: "v2", status: "Issued" },
      { id: "d3", org_id: "o1", document_number: "P-3", current_version_id: "v3", status: "Superseded" },
    ];
    db.tables.document_review_signoffs = [
      { document_version_id: "v1", reviewer_user_id: "r1", status: "signed", signature_id: "s1", slot: "primary", activated: true, slot_group: "person:r1" },
      // v2: one of two required slots signed — still in the gap
      { document_version_id: "v2", reviewer_user_id: "r2", status: "signed", signature_id: "s2", slot: "primary", activated: true, slot_group: "person:r2" },
      { document_version_id: "v2", reviewer_user_id: "r3", status: "pending", slot: "primary", activated: true, slot_group: "person:r3" },
    ];
    db.tables.document_versions = [
      { id: "v2", revision_label: "B", created_by: "pub", created_by_name: "Pat", approved_by_name: "typed" },
    ];
    const gap = await listCurrentRevisionsWithoutSignedApproval("o1");
    expect(gap).toEqual([{ documentId: "d2", documentNumber: "P-2", libraryId: "L1", versionId: "v2", revisionLabel: "B", publishedBy: "pub", publishedByName: "Pat", claim: "typed", satisfied: 1, required: 2 }]);
    db.readError.document_review_signoffs = { message: "down" };
    await expect(listCurrentRevisionsWithoutSignedApproval("o1")).rejects.toThrow(/could not be read/);
  });
  it("the gap query judges a roster exactly as the stamp does — loadSignedRosters' `complete` — and is wired into the Control Register (DF-P11 integrator fix pass)", () => {
    const src = readFileSync(join(process.cwd(), "lib/versionApproval.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function listCurrentRevisionsWithoutSignedApproval("));
    expect(fn).toContain("const rosters = await loadSignedRosters(versionIds);");
    expect(fn).toContain("!(rosters.get(id) ?? EMPTY_ROSTER).complete");
    expect(src).not.toContain("UNWIRED BY DESIGN");
    const panel = readFileSync(join(process.cwd(), "components/documents/UnsignedApprovalPanel.tsx"), "utf8");
    expect(panel).toContain("listCurrentRevisionsWithoutSignedApproval(orgId)");
    const register = readFileSync(join(process.cwd(), "app/(protected)/register/page.tsx"), "utf8");
    expect(register).toContain("<UnsignedApprovalPanel orgId={activeOrgId} refreshKey={refreshKey} />");
  });
  it("A5 (DF-P11 integrator fix pass): only approved_by_name is shown — approved_by / approved_at are written by no code path, and the comment says so", () => {
    const src = readFileSync(join(process.cwd(), "lib/versionApproval.ts"), "utf8");
    expect(src).not.toContain("and any stored approved_by /");
    expect(src).toContain("Only approved_by_name is shown");
  });
  it("source: the Version History stamp is earned by a signed roster only; the rev-up box is labelled the publisher's note", () => {
    const panel = readFileSync(join(process.cwd(), "components/documents/VersionHistoryPanel.tsx"), "utf8");
    expect(panel).not.toMatch(/label="Approved" name=\{v\.approvedByName\}/);
    expect(panel).toContain("deriveVersionApproval(");
    const modal = readFileSync(join(process.cwd(), "components/documents/RevUpModal.tsx"), "utf8");
    expect(modal).not.toMatch(/<Field label="Approved By">/);
    expect(modal).toContain("label={APPROVAL_CLAIM_LABEL}");
    expect(APPROVAL_CLAIM_LABEL).toBe("Approval reference (publisher's note)");
    // fix pass: the second door (backfill) labels its box the same way, and the panel renders partial / backfill
    const backfill = readFileSync(join(process.cwd(), "components/documents/BackfillVersionModal.tsx"), "utf8");
    expect(backfill).not.toMatch(/<Field label="Approved By">/);
    expect(backfill).toContain("<Field label={APPROVAL_CLAIM_LABEL}>");
    expect(panel).toContain('data-approval="partial"');
    expect(panel).toContain('data-approval="backfill"');
    expect(panel).toContain("rosters.get(v.id ?? \"\") ?? EMPTY_ROSTER");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("EVID-10 / EVID-4 — the document evidence pack", () => {
  const seed = () => {
    db.tables.documents = [{ id: "d1", document_number: "DWG-1042", title: "P&ID" }];
    db.tables.document_versions = [
      { id: "v1", record_id: "d1", revision_label: "3", created_by: "pub", created_by_name: "Pat", approved_by_name: "Typed Name", related_ticket_id: "t1" },
      { id: "v2", record_id: "d1", revision_label: "4", created_by: "pub", created_by_name: "Pat", approved_by_name: null },
    ];
    db.tables.document_holds = [];
    db.tables.audit_logs = [{ id: "a1", resource_type: "document", resource_id: "d1", action: "REVISION_PUBLISHED", timestamp: "t" }];
    db.tables.document_review_signoffs = [
      { id: "so1", document_id: "d1", document_version_id: "v2", reviewer_user_id: "r1", reviewer_name: "J. Okafor", reviewer_role: "Engineer-3", status: "signed", signed_at: "2026-10-02T00:00:00Z", signature_id: "s1", revision_label: "4A" },
    ];
    db.tables.e_signatures = [
      { id: "s1", resource_type: "document_version", resource_id: "v2", document_version_id: "v2", intent: "Approved", statement: "I approve", signer_name: "J. Okafor", signed_at: "2026-10-02T00:00:00Z" },
      { id: "s2", resource_type: "document", resource_id: "d1", intent: "Acknowledged", statement: "Read", signer_name: "Field Op", signed_at: "2026-10-03T00:00:00Z" },
    ];
    db.tables.document_acknowledgments = [{ id: "k1", document_id: "d1", assignee_name: "Field Op", status: "acknowledged", acknowledged_at: "2026-10-03T00:00:00Z" }];
    db.tables.distribution_acks = [{ id: "da1", document_id: "d1", recipient_email: "op@x", rev_label: "4", requested_at: "2026-10-02T00:00:00Z", acknowledged_at: null }];
    db.tables.download_audits = [{ id: "dl1", document_id: "d1", user_email: "op@x", created_at: "2026-10-02T00:00:00Z", source: "app" }];
    db.tables.tickets = [{ id: "t1", ticket_id: "REQ-7", title: "Add valve", status: "CLOSED", assigned_engineer_name: "E. Eng", engineer_approved_at: "2026-09-30T00:00:00Z",
      history: [{ action: "ENGINEER_APPROVED_FINAL", user: "E. Eng", role: "Engineer-3", date: "2026-09-30T00:00:00Z", details: "Final approved" }] }];
    db.tables.e_signatures.push({ id: "s3", resource_type: "ticket", resource_id: "t1", intent: "Approved", statement: "Request final approved", signer_name: "E. Eng", signed_at: "2026-09-30T00:00:00Z" });
  };

  it("gathers every record of people's acts — signatures by document AND by version, rosters, confirmations, copies, the request", async () => {
    seed();
    const d = await gatherEvidence("d1");
    expect(d.signatures?.map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
    expect(d.signoffs).toHaveLength(1);
    expect(d.acknowledgments).toHaveLength(1);
    expect(d.distributionAcks).toHaveLength(1);
    expect(d.downloads).toHaveLength(1);
    expect(d.tickets?.map((t) => t.ticket_id)).toEqual(["REQ-7"]);
    expect(d.unread).toEqual([]);
    const html = renderEvidenceHtml(d);
    expect(html).toContain("Originating request history (1)");
    expect(html).toContain("ENGINEER_APPROVED_FINAL");
    expect(html).toContain("Request final approved");
    for (const label of ["Electronic signatures (3)", "Review sign-offs (1)", "Read-and-understood acknowledgments (1)", "Distribution confirmations (1)", "Issued copies (1)", "Originating drafting requests (1)"]) {
      expect(html, label).toContain(label);
    }
    expect(html).toContain("NOT CONFIRMED");
    expect(html).toContain("REQ-7");
  });
  it("EVID-4: the Approved column is derived — a signed rev names its signer, an unsigned one its publisher; a typed name is the publisher's unverified note", async () => {
    seed();
    const html = renderEvidenceHtml(await gatherEvidence("d1"));
    expect(html).toContain("Signed: J. Okafor (Engineer-3)");
    expect(html).toContain("Publisher: Pat (no review sign-off)");
    expect(html).toContain("Approval reference (publisher&#39;s note) (unverified): “Typed Name”".replace("&#39;", "'"));
    expect(html).toMatch(/1 of 2 revision\(s\) have no complete signed review sign-off/);
    expect(html).not.toMatch(/assembled from the immutable audit trail/);
  });
  it("fix pass: a revision whose roster is only partly signed prints 'Partially signed — 1 of 2' and counts as unsigned in the footer", async () => {
    seed();
    const d = await gatherEvidence("d1");
    const signed = (d.signoffs ?? [])[0] as Record<string, unknown>;
    d.signoffs = [
      { ...signed, slot: "primary", activated: true, slot_group: "person:r1" },
      { ...signed, id: "so-2", reviewer_user_id: "r9", reviewer_name: "Second Reviewer", status: "pending", signature_id: null, signed_at: null, slot: "primary", activated: true, slot_group: "person:r9" },
    ];
    const html = renderEvidenceHtml(d);
    expect(html).toContain("Partially signed — 1 of 2: J. Okafor (Engineer-3)");
    expect(html).not.toContain("Signed: J. Okafor (Engineer-3)");
    expect(html).toMatch(/2 of 2 revision\(s\) have no complete signed review sign-off/);
  });
  it("a section whose read failed says so — never 'none recorded'; the Approved column says 'not known' when the roster failed", async () => {
    seed();
    db.readError.distribution_acks = { message: "down" };
    db.readError.document_review_signoffs = { message: "down" };
    const d = await gatherEvidence("d1");
    expect(d.unread).toEqual(expect.arrayContaining([EVIDENCE_SECTIONS.distributionAcks, EVIDENCE_SECTIONS.signoffs]));
    const html = renderEvidenceHtml(d);
    expect(html).toContain("The distribution confirmations could not be read");
    expect(html).not.toMatch(/Distribution confirmations \(0\)/);
    expect(html).toContain("Not known — the review sign-offs were not read");
    expect(html).not.toContain("Publisher: Pat");
  });
  it("DF-P11 integrator fix pass: a request the revisions name that the caller's RLS does not return is 'not visible to you' on BOTH request sections — never 'None recorded'", async () => {
    seed();
    db.tables.tickets = []; // the tickets RLS returns nothing for t1
    const d = await gatherEvidence("d1");
    expect(d.ticketsNotVisible).toBe(1);
    expect(d.unread).toEqual([]);
    const html = renderEvidenceHtml(d);
    const req = html.slice(html.indexOf("Originating drafting requests (0)"), html.indexOf("Originating request history"));
    const hist = html.slice(html.indexOf("Originating request history (0)"));
    expect(req).toContain("1 request the revisions name is not visible to you — not shown here; this does not mean there is none.");
    expect(req).not.toContain("None recorded.");
    expect(hist.slice(0, hist.indexOf("</div>") + 6)).toContain("The history of 1 request the revisions name is not visible to you");
    expect(hist.slice(0, 400)).not.toContain("None recorded.");
  });
  it("DF-P11 integrator fix pass: one of two requests visible — the visible one is listed, the other counted", async () => {
    seed();
    db.tables.document_versions[1].related_ticket_id = "t2"; // t2 not returned
    const d = await gatherEvidence("d1");
    expect(d.ticketsNotVisible).toBe(1);
    const html = renderEvidenceHtml(d);
    expect(html).toContain("Originating drafting requests (1)");
    expect(html).toContain("REQ-7");
    expect(html).toContain("1 request the revisions name is not visible to you");
    expect(html).toContain("The history of 1 request the revisions name is not visible to you");
  });
  it("REGRESSION: every named request visible → no note; a visible request with no history still says 'None recorded' on the history", async () => {
    seed();
    db.tables.tickets[0].history = [];
    const d = await gatherEvidence("d1");
    expect(d.ticketsNotVisible).toBe(0);
    const html = renderEvidenceHtml(d);
    expect(html).not.toContain("not visible to you");
    expect(html.slice(html.indexOf("Originating request history (0)"))).toMatch(/^Originating request history \(0\)<\/h2><div class="empty">None recorded\.<\/div>/);
  });
  it("the audit trail pages past 1,000 rows (it was a silent .limit(1000))", async () => {
    seed();
    db.tables.audit_logs = Array.from({ length: 1500 }, (_, i) => ({ id: `a${i}`, resource_type: "document", resource_id: "d1", action: "X", timestamp: "t" }));
    const d = await gatherEvidence("d1");
    expect(d.audit).toHaveLength(1500);
    expect(d.capped).toEqual([]);
  });
  it("a capped trail says 'Truncated at N'", () => {
    const html = renderEvidenceHtml({ doc: { document_number: "P" }, versions: [], holds: [], audit: [{ action: "X" }], capped: [EVIDENCE_SECTIONS.audit] });
    expect(html).toContain("Truncated at 1 entries");
  });
  it("REGRESSION: a caller with only the four legacy arrays renders as before, with an honest footer", () => {
    const html = renderEvidenceHtml({ doc: { document_number: "P-101" }, versions: [], holds: [], audit: [] });
    expect(html).toContain("Revision lineage (0)");
    expect(html).not.toContain("Electronic signatures");
    expect(html).toContain("This pack shows the revision records, holds and the document's audit trail");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("EVID-11 done-when 1 — recordAcknowledgment checks the roster write", () => {
  const input = {
    orgId: "o1", documentId: "d1", documentVersionId: "v1", rosterId: "k1",
    signerUserId: "u1", signerName: "Op", statement: "I have read it",
  };
  it("REGRESSION: the signer's own pending row is stamped and nothing is thrown", async () => {
    db.tables.document_acknowledgments = [{ id: "k1", document_id: "d1", document_version_id: "v1", assignee_user_id: "u1", status: "pending" }];
    await recordAcknowledgment(input);
    expect(db.tables.document_acknowledgments[0].status).toBe("acknowledged");
    expect(db.tables.document_acknowledgments[0].signature_id).toBe("sig-1");
    const u = db.updates[0];
    expect(u.filters).toEqual(expect.arrayContaining([["assignee_user_id", "eq", "u1"], ["status", "eq", "pending"], ["id", "eq", "k1"]]));
  });
  it("a roster row voided by a newer revision (zero rows) is a hard error to the signer", async () => {
    db.tables.document_acknowledgments = [{ id: "k1", document_id: "d1", document_version_id: "v1", assignee_user_id: "u1", status: "void" }];
    await expect(recordAcknowledgment(input)).rejects.toThrow(/no pending acknowledgment of yours to mark/);
  });
  it("someone else's roster id is refused (the rosterId branch is now pinned to the signer too)", async () => {
    db.tables.document_acknowledgments = [{ id: "k1", document_id: "d1", document_version_id: "v1", assignee_user_id: "someone-else", status: "pending" }];
    await expect(recordAcknowledgment(input)).rejects.toThrow(/no pending acknowledgment of yours/);
    expect(db.tables.document_acknowledgments[0].status).toBe("pending");
  });
  it("a refused write says so with the database's reason", async () => {
    db.updateResult = { data: null, error: { message: "permission denied" } };
    await expect(recordAcknowledgment(input)).rejects.toThrow(/could not be marked on the roster \(permission denied\)/);
  });
});
