// lib/evidencePack.ts
//
// One-click compliance evidence pack. Assembles a document's full
// chain-of-custody — revision lineage (with the engineering sign-off chain,
// MOC refs, file hashes), every hold (with durations), and the raw audit
// trail — into a clean, print-to-PDF report. This is the "your exit story is
// one click" promise made concrete for auditors (ISO-9001 / PSM evidence).

import { supabase } from "@/lib/supabase";
import { normalizeEvidence, isMachineActorName } from "@/lib/checklistEngine";
import { auditActorNote, AUDIT_TRAIL_UNSEEN_NOTE_PACK } from "@/lib/auditActions";
import type { Transmittal } from "@/lib/transmittals";
import { deriveVersionApproval, approvalLine, APPROVAL_CLAIM_LABEL, type RosterSigner } from "@/lib/versionApproval";

/** admin-and-org ALOG-7: whose word an audit row's identity is (actor_kind,
 *  stamped by 20261201's trigger; a row without it is the writer's word). */
const actorNote = (a: Record<string, unknown>): string => ` <span class="muted">· ${esc(auditActorNote(a.actor_kind))}</span>`;

interface EvidenceData {
  doc: Record<string, unknown> | null;
  versions: Array<Record<string, unknown>>;
  holds: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
  // drafting-flow EVID-10 (DF-P11): the records of people's acts on this
  // document, each its own section. Absent = not gathered (a caller that
  // renders only the four legacy sections); a section whose read failed is
  // named in `unread` and printed as "could not be read" — never as "none".
  /** e_signatures on the document or any of its versions. */
  signatures?: Array<Record<string, unknown>>;
  /** document_review_signoffs (the review roster, every status). */
  signoffs?: Array<Record<string, unknown>>;
  /** document_acknowledgments (the read-and-understood roster). */
  acknowledgments?: Array<Record<string, unknown>>;
  /** distribution_acks (who was asked to confirm receipt, and who did). */
  distributionAcks?: Array<Record<string, unknown>>;
  /** download_audits (who was issued a copy). */
  downloads?: Array<Record<string, unknown>>;
  /** The drafting requests the revisions name (related_ticket_id). */
  tickets?: Array<Record<string, unknown>>;
  /** Labels of the sections whose read failed. */
  unread?: string[];
  /** Labels of the sections that stopped at PACK_ROW_CEILING rows. */
  capped?: string[];
}

/** The pack's section labels — one spelling for the read, the notice and the tests. */
export const EVIDENCE_SECTIONS = {
  signatures: "electronic signatures",
  signoffs: "review sign-offs",
  acknowledgments: "read-and-understood acknowledgments",
  distributionAcks: "distribution confirmations",
  downloads: "issued copies",
  tickets: "originating drafting requests",
  ticketHistory: "originating request history",
  audit: "audit trail",
} as const;

export async function gatherEvidence(documentId: string, orgId?: string): Promise<EvidenceData> {
  const docQ = supabase.from("documents").select("*").eq("id", documentId).maybeSingle();
  let versionsQ = supabase.from("document_versions").select("*").eq("record_id", documentId).order("created_at", { ascending: true });
  if (orgId) versionsQ = versionsQ.eq("org_id", orgId);
  const holdsQ = supabase.from("document_holds").select("*").eq("document_id", documentId).order("opened_at", { ascending: true });
  const unread: string[] = [];
  const capped: string[] = [];
  const note = (label: string, r: { failed: boolean; capped: boolean }) => {
    if (r.failed) unread.push(label); else if (r.capped) capped.push(label);
  };
  // EVID-10: the audit trail pages past PostgREST's 1,000-row answer (it was
  // a silent .limit(1000)); a trail longer than PACK_ROW_CEILING says so.
  const byDoc = (table: string, order: string) => readEveryRow((f, t) => supabase.from(table).select("*")
    .eq("document_id", documentId).order(order, { ascending: true }).order("id", { ascending: true }).range(f, t));
  const [doc, versions, holds, audit, signoffs, acknowledgments, distributionAcks, downloads, docSigs] = await Promise.all([
    docQ, versionsQ, holdsQ,
    readEveryRow((f, t) => supabase.from("audit_logs").select("*").eq("resource_type", "document").eq("resource_id", documentId)
      .order("timestamp", { ascending: true }).order("id", { ascending: true }).range(f, t)),
    byDoc("document_review_signoffs", "assigned_at"),
    byDoc("document_acknowledgments", "assigned_at"),
    byDoc("distribution_acks", "requested_at"),
    byDoc("download_audits", "created_at"),
    readEveryRow((f, t) => supabase.from("e_signatures").select("*").eq("resource_type", "document").eq("resource_id", documentId)
      .order("signed_at", { ascending: true }).order("id", { ascending: true }).range(f, t)),
  ]);
  const versionRows = (versions.data as Array<Record<string, unknown>>) ?? [];
  note(EVIDENCE_SECTIONS.audit, audit);
  note(EVIDENCE_SECTIONS.signoffs, signoffs);
  note(EVIDENCE_SECTIONS.acknowledgments, acknowledgments);
  note(EVIDENCE_SECTIONS.distributionAcks, distributionAcks);
  note(EVIDENCE_SECTIONS.downloads, downloads);

  // Signatures bound to a version (the review gate's sign-offs are recorded
  // against resource_type 'document_version') as well as to the document.
  const signatures = new Map<string, Record<string, unknown>>();
  let sigFailed = docSigs.failed;
  let sigCapped = docSigs.capped;
  for (const r of docSigs.rows) signatures.set(String(r.id), r);
  const versionIds = versionRows.map((v) => String(v.id)).filter(Boolean);
  for (let i = 0; i < versionIds.length && !sigFailed; i += 100) {
    const part = versionIds.slice(i, i + 100);
    const r = await readEveryRow((f, t) => supabase.from("e_signatures").select("*").in("document_version_id", part)
      .order("signed_at", { ascending: true }).order("id", { ascending: true }).range(f, t));
    if (r.failed) sigFailed = true;
    if (r.capped) sigCapped = true;
    for (const row of r.rows) signatures.set(String(row.id), row);
  }
  note(EVIDENCE_SECTIONS.signatures, { failed: sigFailed, capped: sigCapped });

  // The drafting requests the revisions came from (EVID-10 done-when 2).
  const ticketIds = [...new Set(versionRows.map((v) => v.related_ticket_id).filter((x): x is string => typeof x === "string" && !!x))];
  let tickets: Array<Record<string, unknown>> = [];
  if (ticketIds.length) {
    const { data, error } = await supabase.from("tickets")
      .select("id, ticket_id, title, status, requester_name, assigned_drafter_name, assigned_engineer_name, engineer_review_requested_at, engineer_approved_at, closed_at, history")
      .in("id", ticketIds);
    if (error) unread.push(EVIDENCE_SECTIONS.tickets, EVIDENCE_SECTIONS.ticketHistory);
    else tickets = (data as Array<Record<string, unknown>>) ?? [];
    // …and any signature bound to the request itself.
    if (!sigFailed) {
      const r = await readEveryRow((f, t) => supabase.from("e_signatures").select("*").eq("resource_type", "ticket").in("resource_id", ticketIds)
        .order("signed_at", { ascending: true }).order("id", { ascending: true }).range(f, t));
      if (r.failed) { sigFailed = true; if (!unread.includes(EVIDENCE_SECTIONS.signatures)) unread.push(EVIDENCE_SECTIONS.signatures); }
      for (const row of r.rows) signatures.set(String(row.id), row);
    }
  }

  return {
    doc: (doc.data as Record<string, unknown>) ?? null,
    versions: versionRows,
    holds: (holds.data as Array<Record<string, unknown>>) ?? [],
    audit: audit.failed ? [] : audit.rows,
    signatures: sigFailed ? [] : [...signatures.values()].sort((a, b) => String(a.signed_at ?? "").localeCompare(String(b.signed_at ?? ""))),
    signoffs: signoffs.failed ? [] : signoffs.rows,
    acknowledgments: acknowledgments.failed ? [] : acknowledgments.rows,
    distributionAcks: distributionAcks.failed ? [] : distributionAcks.rows,
    downloads: downloads.failed ? [] : downloads.rows,
    tickets,
    unread,
    capped,
  };
}

const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const date = (v: unknown): string => {
  if (!v) return "—";
  try { return new Date(String(v)).toLocaleString(); } catch { return esc(v); }
};
const dur = (a: unknown, b: unknown): string => {
  if (!a || !b) return "—";
  const ms = new Date(String(b)).getTime() - new Date(String(a)).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
};

export function renderEvidenceHtml(data: EvidenceData): string {
  const d = data.doc ?? {};
  const number = esc(d.document_number || d.title || d.name || "Document");
  const rows = (arr: string[]) => arr.join("");

  // EVID-4 (DF-P11): "Approved" is DERIVED — the version's signed review
  // sign-offs, or (none) its publisher; a typed approval name is printed as
  // the publisher's note, never in the Approved column. Signoffs not
  // gathered (a legacy caller) or unreadable → "not known".
  const signoffsKnown = data.signoffs !== undefined && !(data.unread ?? []).includes(EVIDENCE_SECTIONS.signoffs);
  const signedFor = (versionId: unknown): RosterSigner[] | null => {
    if (!signoffsKnown) return null;
    return (data.signoffs ?? [])
      .filter((r) => r.status === "signed" && String(r.document_version_id ?? "") === String(versionId ?? ""))
      .map((r) => ({
        userId: String(r.reviewer_user_id ?? ""), name: (r.reviewer_name as string | null) ?? null,
        role: (r.reviewer_role as string | null) ?? null, signedAt: (r.signed_at as string | null) ?? null,
        signatureId: (r.signature_id as string | null) ?? null,
      }));
  };
  const approvals = data.versions.map((v) => deriveVersionApproval({
    createdBy: v.created_by as string | null, createdByName: v.created_by_name as string | null,
    createdAt: v.created_at, releasedAt: v.released_at, approvedByName: v.approved_by_name as string | null,
  }, signedFor(v.id), signoffsKnown ? undefined : "the review sign-offs were not read"));
  const unsignedCount = approvals.filter((a) => a.approval.basis !== "roster").length;

  const versionRows = data.versions.map((v, i) => `
    <tr>
      <td><b>${esc(v.revision_label)}</b></td>
      <td>${esc(v.issue_type || "—")}</td>
      <td>${esc(v.change_type || "—")}</td>
      <td>${date(v.released_at || v.created_at)}</td>
      <td>${esc(v.drawn_by_name || "—")}</td>
      <td>${esc(v.checked_by_name || "—")}</td>
      <td class="${approvals[i].approval.basis === "roster" ? "signed" : "unsigned"}">${esc(approvalLine(approvals[i]))}${approvals[i].claim ? `<div class="muted">${esc(APPROVAL_CLAIM_LABEL)} (unverified): “${esc(approvals[i].claim)}”</div>` : ""}</td>
      <td>${esc(v.moc_reference || "—")}</td>
      <td class="mono">${esc(v.file_hash ? String(v.file_hash).slice(0, 16) + "…" : "—")}</td>
    </tr>
    <tr class="narr"><td colspan="9"><span class="lbl">Change narrative:</span> ${esc(v.change_log || "—")}${v.superseded_at ? ` <span class="sup">· superseded ${date(v.superseded_at)}</span>` : ""}</td></tr>
  `);

  const holdRows = data.holds.map((h) => `
    <tr>
      <td><b>${esc(h.reason)}</b></td>
      <td>${esc(h.notes || "—")}</td>
      <td>${date(h.opened_at)} <span class="muted">by ${esc(h.opened_by_name || "—")}</span></td>
      <td>${h.released_at ? `${date(h.released_at)} <span class="muted">by ${esc(h.released_by_name || "—")}</span>` : '<span class="open">OPEN</span>'}</td>
      <td>${dur(h.opened_at, h.released_at)}</td>
    </tr>`);

  const unread = new Set(data.unread ?? []);
  const capped = new Set(data.capped ?? []);
  /** One section of people's acts: absent = not gathered (omitted), a failed
   *  read is said, a capped read says how far it got. */
  const actSection = (label: string, rows: Array<Record<string, unknown>> | undefined, head: string[], cells: (r: Record<string, unknown>) => string[]): string => {
    if (rows === undefined) return "";
    const title = label.charAt(0).toUpperCase() + label.slice(1);
    if (unread.has(label)) return `<h2>${esc(title)}</h2><div class="unread">The ${esc(label)} could not be read — this pack does not show them, and it does not mean there are none.</div>`;
    const cap = capped.has(label) ? `<div class="unread">Truncated at ${rows.length} rows — more exist and are not shown.</div>` : "";
    return `<h2>${esc(title)} (${rows.length})</h2>${cap}${rows.length === 0 ? `<div class="empty">None recorded.</div>` : `<table>
    <thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`}`;
  };
  const sections = [
    actSection(EVIDENCE_SECTIONS.signatures, data.signatures, ["Signed", "Signer", "Intent", "Statement", "Bound to"], (r) => [
      date(r.signed_at), `${esc(r.signer_name || "—")}${r.signer_role ? ` <span class="muted">(${esc(r.signer_role)})</span>` : ""}`,
      `<b>${esc(r.intent || "—")}</b>`, esc(r.statement || "—"),
      `<span class="mono small">${esc(r.document_version_id ? `version ${String(r.document_version_id).slice(0, 8)}` : `${r.resource_type ?? ""}`)}${r.content_hash ? ` · ${esc(String(r.content_hash).slice(0, 12))}…` : ""}</span>`,
    ]),
    actSection(EVIDENCE_SECTIONS.signoffs, data.signoffs, ["Rev", "Reviewer", "Slot", "Status", "Signed", "Signature"], (r) => [
      esc(r.revision_label || "—"), `${esc(r.reviewer_name || "—")}${r.reviewer_role ? ` <span class="muted">(${esc(r.reviewer_role)})</span>` : ""}`,
      esc(r.slot || "—"), `<b>${esc(r.status || "—")}</b>`, date(r.signed_at), r.signature_id ? "✓ bound" : "—",
    ]),
    actSection(EVIDENCE_SECTIONS.acknowledgments, data.acknowledgments, ["Rev", "Assignee", "Status", "Acknowledged", "Waived"], (r) => [
      esc(r.revision_label || "—"), `${esc(r.assignee_name || "—")}${r.assignee_role ? ` <span class="muted">(${esc(r.assignee_role)})</span>` : ""}`,
      `<b>${esc(r.status || "—")}</b>`, date(r.acknowledged_at), r.waived_reason ? esc(r.waived_reason) : "—",
    ]),
    actSection(EVIDENCE_SECTIONS.distributionAcks, data.distributionAcks, ["Rev", "Recipient", "Requested", "Confirmed"], (r) => [
      esc(r.rev_label || "—"), esc(r.recipient_email || r.recipient_user_id || "—"),
      `${date(r.requested_at)}${r.requested_by_name ? ` <span class="muted">by ${esc(r.requested_by_name)}</span>` : ""}`,
      r.acknowledged_at ? date(r.acknowledged_at) : '<span class="open">NOT CONFIRMED</span>',
    ]),
    actSection(EVIDENCE_SECTIONS.downloads, data.downloads, ["Issued", "To", "Version", "Source"], (r) => [
      date(r.created_at), esc(r.user_email || r.user_id || "—"),
      `<span class="mono small">${esc(r.version_id ? String(r.version_id).slice(0, 8) : "—")}</span>`, esc(r.source || "—"),
    ]),
    actSection(EVIDENCE_SECTIONS.tickets, data.tickets, ["Request", "Status", "Requested by", "Drafter", "Engineer approval"], (r) => [
      `<b>${esc(r.ticket_id || "—")}</b> ${esc(r.title || "")}`, esc(r.status || "—"), esc(r.requester_name || "—"),
      esc(r.assigned_drafter_name || "—"),
      r.engineer_approved_at ? `${date(r.engineer_approved_at)} <span class="muted">by ${esc(r.assigned_engineer_name || "—")}</span>` : "—",
    ]),
    // EVID-10 done-when 2: the request's approval history, as its own trail.
    actSection(EVIDENCE_SECTIONS.ticketHistory, data.tickets === undefined ? undefined : data.tickets.flatMap((t) =>
      (Array.isArray(t.history) ? (t.history as Array<Record<string, unknown>>) : []).map((h) => ({ ...h, ticket_id: t.ticket_id }))),
    ["Request", "When", "Action", "By", "Details"], (h) => [
      esc(h.ticket_id || "—"), date(h.date), `<b>${esc(h.action || "—")}</b>`,
      `${esc(h.user || "—")}${h.role ? ` <span class="muted">(${esc(h.role)})</span>` : ""}`, esc(h.details || ""),
    ]),
  ].join("\n");
  const gathered = data.signatures !== undefined;

  const auditRows = data.audit.map((a) => `
    <tr>
      <td>${date(a.timestamp)}</td>
      <td><b>${esc(a.action)}</b></td>
      <td>${esc(a.user_email || a.user_id || "—")}${a.user_role ? ` <span class="muted">(${esc(a.user_role)})</span>` : ""}${actorNote(a)}</td>
      <td class="mono small">${esc(a.details ? JSON.stringify(a.details) : "")}</td>
    </tr>`);

  return `<!doctype html><html><head><meta charset="utf-8"><title>Evidence Pack — ${number}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #0f172a; margin: 0; padding: 32px; font-size: 12px; }
  h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #475569; margin: 28px 0 8px; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; }
  .sub { color: #64748b; margin-bottom: 4px; } .meta { display: flex; gap: 18px; flex-wrap: wrap; color: #334155; margin-top: 8px; }
  .meta b { color: #0f172a; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; } th, td { text-align: left; padding: 5px 7px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th { background: #f8fafc; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; }
  .mono { font-family: ui-monospace, Menlo, monospace; } .small { font-size: 10px; color: #64748b; word-break: break-all; }
  .narr td { background: #fafafa; color: #334155; font-size: 11px; border-bottom: 2px solid #e2e8f0; } .lbl { color: #64748b; font-weight: 700; }
  .muted { color: #94a3b8; } .open { color: #b91c1c; font-weight: 700; } .sup { color: #b45309; } .empty { color: #94a3b8; font-style: italic; padding: 8px 0; }
  .toolbar { position: sticky; top: 0; background: #fff; padding-bottom: 10px; } .btn { background: #ea580c; color: #fff; border: 0; padding: 8px 14px; border-radius: 8px; font-weight: 700; cursor: pointer; }
  .footer { margin-top: 28px; color: #94a3b8; font-size: 10px; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  .unseen { font-size: 10px; margin-bottom: 4px; }
  .unread { color: #b45309; font-weight: 700; padding: 6px 0; } .unsigned { color: #92400e; } .signed { color: #166534; }
  @media print { .toolbar { display: none; } body { padding: 0; } }
</style></head><body>
  <div class="toolbar"><button class="btn" onclick="window.print()">Print / Save as PDF</button></div>
  <h1>Compliance Evidence Pack</h1>
  <div class="sub">${number}${d.title && d.title !== d.document_number ? ` — ${esc(d.title)}` : ""}</div>
  <div class="meta">
    <span><b>Current rev:</b> ${esc(d.rev || "—")}</span>
    <span><b>Status:</b> ${esc(d.status || "—")}</span>
    <span><b>Created:</b> ${date(d.created_at)}</span>
    <span><b>By:</b> ${esc(d.created_by_name || "—")}</span>
  </div>

  <h2>Revision lineage (${data.versions.length})</h2>
  ${data.versions.length === 0 ? '<div class="empty">No versions recorded.</div>' : `<table>
    <thead><tr><th>Rev</th><th>Issue</th><th>Change</th><th>Released</th><th>Drawn</th><th>Checked</th><th>Approved</th><th>MOC</th><th>SHA-256</th></tr></thead>
    <tbody>${rows(versionRows)}</tbody></table>`}

  <h2>Holds (${data.holds.length})</h2>
  ${data.holds.length === 0 ? '<div class="empty">No holds recorded.</div>' : `<table>
    <thead><tr><th>Reason</th><th>Notes</th><th>Opened</th><th>Released</th><th>Duration</th></tr></thead>
    <tbody>${rows(holdRows)}</tbody></table>`}

  ${sections}

  <h2>Audit trail (${data.audit.length})</h2>
  <div class="muted unseen">${esc(AUDIT_TRAIL_UNSEEN_NOTE_PACK)}</div>
  ${unread.has(EVIDENCE_SECTIONS.audit) ? `<div class="unread">The audit trail could not be read — the entries below are not the trail.</div>` : ""}
  ${capped.has(EVIDENCE_SECTIONS.audit) ? `<div class="unread">Truncated at ${data.audit.length} entries — later entries exist and are not shown.</div>` : ""}
  ${data.audit.length === 0 ? '<div class="empty">No audit entries.</div>' : `<table>
    <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Details</th></tr></thead>
    <tbody>${rows(auditRows)}</tbody></table>`}

  <div class="footer">Generated ${new Date().toLocaleString()} · ManufacturingOS · ${number}. ${gathered
    ? "This pack shows the revision records, holds, electronic signatures, review sign-offs, read-and-understood acknowledgments, distribution confirmations, issued copies, the originating drafting requests and the document's audit trail as they read when it was generated."
    : "This pack shows the revision records, holds and the document's audit trail as they read when it was generated."}
    It does not include notifications, views, or audit entries recorded against other resources. ${data.versions.length
    ? `${unsignedCount} of ${data.versions.length} revision(s) have no signed review sign-off: their Approved entry names the publisher (or says it is not known), and a typed approval name is printed as the publisher's unverified note.`
    : ""}</div>
</body></html>`;
}

/** Gather + open the evidence pack in a new window for print/save-as-PDF. */
export async function openEvidencePack(documentId: string, orgId?: string): Promise<void> {
  const data = await gatherEvidence(documentId, orgId);
  openPrintWindow(renderEvidenceHtml(data));
}

// ─── Project-level evidence pack ───────────────────────────────────────────

interface ProjectEvidence {
  project: Record<string, unknown> | null;
  members: Array<Record<string, unknown>>;
  milestones: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
  transmittals: Array<Record<string, unknown>>;
  /** DIST-18 (limb a): the transmittals read failed — said, never printed
   *  as "none" (absent = read). */
  transmittalsUnread?: boolean;
  /** QUAL-10: the quality program's record (absent = not gathered). */
  quality?: ProjectQualityEvidence;
}

// ─── QUAL-10: the quality program in the project pack ──────────────────────
// Every checklist with every item (status, applicability, the evidence
// citations, who decided it — a person, or the automated sweep / AI
// assessment, marked as such), the turnover package (status, reviewer, date,
// note) and the punch list (closure, who, when, why). A read that fails is
// said to have failed — never printed as "none". Every read pages past
// PostgREST's 1,000-row answer (a short page is the end), so the pack holds
// every row; a read that reaches PACK_ROW_CEILING stops and the pack SAYS
// how far it got — never a silently shortened list printed as complete.

export interface ProjectQualityEvidence {
  checklists: Array<Record<string, unknown> & { items: Array<Record<string, unknown>> }>;
  turnover: Array<Record<string, unknown>>;
  punch: Array<Record<string, unknown>>;
  /** Which of "checklists" / "checklist items" / "turnover items" / "punch
   *  items" could not be read. */
  unread: string[];
  /** Which of the same reads stopped at PACK_ROW_CEILING rows (more exist
   *  and were not read). */
  capped: string[];
}

/** PostgREST's default answer size: a page this long may have more after it. */
const PACK_PAGE = 1000;
/** The most rows one quality read gathers into a pack; a read that reaches
 *  it stops and the pack says "the first N" (projects Round G J12). */
export const PACK_ROW_CEILING = 20_000;

type RowsAnswer = PromiseLike<{ data: unknown; error: unknown }>;
/** Every row a query matches, in PACK_PAGE pages until a short one — or up
 *  to PACK_ROW_CEILING, then `capped`. A failed page is `failed`. */
async function readEveryRow(page: (from: number, to: number) => RowsAnswer): Promise<{ rows: Array<Record<string, unknown>>; failed: boolean; capped: boolean }> {
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; from < PACK_ROW_CEILING; from += PACK_PAGE) {
    const { data, error } = await page(from, Math.min(from + PACK_PAGE, PACK_ROW_CEILING) - 1);
    if (error) return { rows, failed: true, capped: false };
    const got = (data ?? []) as Array<Record<string, unknown>>;
    rows.push(...got);
    if (got.length < PACK_PAGE) return { rows, failed: false, capped: false };
  }
  return { rows, failed: false, capped: true };
}

export async function gatherProjectQualityEvidence(projectId: string): Promise<ProjectQualityEvidence> {
  const unread: string[] = [];
  const capped: string[] = [];
  const note = (label: string, r: { failed: boolean; capped: boolean }) => {
    if (r.failed) unread.push(label); else if (r.capped) capped.push(label);
  };
  // Ordered by a unique key last, so the pages never skip or repeat a row.
  const [cl, to, pu] = await Promise.all([
    readEveryRow((f, t) => supabase.from("project_checklists").select("*").eq("project_id", projectId)
      .order("created_at", { ascending: true }).order("id", { ascending: true }).range(f, t)),
    readEveryRow((f, t) => supabase.from("turnover_items").select("*").eq("project_id", projectId)
      .order("created_at", { ascending: true }).order("id", { ascending: true }).range(f, t)),
    readEveryRow((f, t) => supabase.from("punch_items").select("*").eq("project_id", projectId)
      .order("created_at", { ascending: true }).order("id", { ascending: true }).range(f, t)),
  ]);
  note("checklists", cl);
  note("turnover items", to);
  note("punch items", pu);
  const lists = cl.failed ? [] : cl.rows;
  const items: Array<Record<string, unknown>> = [];
  const ids = lists.map((c) => String(c.id));
  // Items in chunks of 100 checklists (a bounded filter), each chunk read in
  // full — checklist by checklist, then by seq — so a ceiling, if reached,
  // cuts whole later checklists, never the tail of every list.
  let itemsCapped = false;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = await readEveryRow((f, t) => supabase.from("checklist_items").select("*").in("checklist_id", chunk)
      .order("checklist_id", { ascending: true }).order("seq", { ascending: true }).order("id", { ascending: true }).range(f, t));
    if (r.failed) { unread.push("checklist items"); break; }
    items.push(...r.rows);
    if (r.capped) { itemsCapped = true; break; }
  }
  if (itemsCapped) capped.push("checklist items");
  const byList = new Map<string, Array<Record<string, unknown>>>();
  for (const it of items) {
    const k = String(it.checklist_id);
    const cur = byList.get(k);
    if (cur) cur.push(it); else byList.set(k, [it]);
  }
  return {
    checklists: lists.map((c) => ({ ...c, items: byList.get(String(c.id)) ?? [] })),
    turnover: to.failed ? [] : to.rows,
    punch: pu.failed ? [] : pu.rows,
    unread,
    capped,
  };
}

/** A person decided the item but the row kept no name (a legacy or restored
 *  row): the pack is handed to an auditor, so it says so in words — never an
 *  opaque user id. */
export const DECIDER_NAME_NOT_RECORDED = "a person (name not recorded)";

/** Who decided a checklist item, as the pack prints it: the automated sweep
 *  and the AI assessment are named as automated (updated_by NULL + their
 *  sentinel name, DEC-35); anyone else is the person named on the row. */
export function checklistItemDecider(it: Record<string, unknown>): { who: string; automated: boolean } {
  const name = ((it.updated_by_name as string | null) ?? "").trim() || null;
  if (!it.updated_by && isMachineActorName(name)) return { who: `${name} (automated)`, automated: true };
  return { who: name || (it.updated_by ? DECIDER_NAME_NOT_RECORDED : "—"), automated: false };
}

function renderQualitySections(q: ProjectQualityEvidence): string {
  const unread = new Set(q.unread);
  const capped = new Set(q.capped);
  const couldNot = (what: string) => `<div class="empty">Could not read the ${what} — this section is left out, not empty.</div>`;
  const firstN = (what: string) => capped.has(what)
    ? `<div class="empty">Only the first ${PACK_ROW_CEILING.toLocaleString("en-US")} ${what} were read — the rest are left out of this pack, not absent from the record.</div>`
    : "";
  const itemsCut = capped.has("checklist items");
  const checklistBlocks = q.checklists.map((c) => {
    const itemRows = c.items.map((it) => {
      const chips = normalizeEvidence(it.evidence);
      const decider = checklistItemDecider(it);
      // A green the automated sweep gave rests on its citations; a person's
      // rests on their reason. The pack marks the machine's in words, not
      // colour alone.
      const autoGreen = it.status === "satisfied" && decider.automated;
      const cites = chips.map((ch) => `${esc(ch.label)}${ch.source === "auto" ? ' <span class="auto">[automated citation]</span>' : ""}${ch.documentId ? ` <span class="small">doc ${esc(String(ch.documentId).slice(0, 8))}</span>` : ""}`).join("<br>");
      return `<tr class="${autoGreen ? "autorow" : ""}">
        <td>${esc(it.seq)}</td>
        <td>${it.section ? `<span class="small">${esc(it.section)}</span><br>` : ""}${esc(it.text)}</td>
        <td><b>${esc(String(it.status ?? "—").replace("_", " "))}</b>${autoGreen ? ' <span class="auto">[automated]</span>' : ""}</td>
        <td>${esc(it.applicability || "—")}</td>
        <td class="small">${cites || "—"}</td>
        <td>${esc(decider.who)}${it.updated_at ? `<br><span class="small">${date(it.updated_at)}</span>` : ""}${it.manual_note ? `<br><span class="small">Reason: ${esc(it.manual_note)}</span>` : ""}</td>
      </tr>`;
    }).join("");
    const done = c.status === "complete"
      ? ` · completed ${date(c.completed_at)}${c.completed_by_name ? ` by ${esc(c.completed_by_name)}` : ""}${c.completed_basis ? ` (basis: ${esc(c.completed_basis)})` : ""}`
      : "";
    return `<h3>${esc(c.title || "Checklist")} <span class="small">${esc(String(c.kind ?? "").toUpperCase())} · ${esc(c.status || "—")}${done}</span></h3>
      ${c.items.length === 0 ? (itemsCut ? '<div class="empty">Items not read — the item read stopped at its limit; left out, not absent.</div>' : '<div class="empty">No items.</div>') : `<table><thead><tr><th>#</th><th>Item</th><th>Status</th><th>Applies</th><th>Evidence</th><th>Decided by</th></tr></thead><tbody>${itemRows}</tbody></table>`}`;
  }).join("");
  const turnoverRows = q.turnover.map((t) => `<tr><td>${esc(t.name)}${t.required === false ? ' <span class="small">(optional)</span>' : ""}</td><td><b>${esc(t.status || "—")}</b></td><td>${esc(t.reviewed_by_name || "—")}</td><td>${date(t.reviewed_at)}</td><td>${esc(t.review_note || "—")}</td></tr>`).join("");
  const punchRows = q.punch.map((p) => `<tr><td>${esc(p.title)}${p.location ? ` <span class="small">${esc(p.location)}</span>` : ""}</td><td><b>${esc(p.status || "—")}</b></td><td>${date(p.closed_at)}</td><td>${esc(p.closed_by_name || "—")}</td><td>${esc(p.closure_note || "—")}</td></tr>`).join("");
  return `
  <h2>Checklists — PSSR / MI / QA-QC (${q.checklists.length}${capped.has("checklists") ? "+" : ""})</h2>
  ${unread.has("checklists") ? couldNot("checklists") : unread.has("checklist items") ? couldNot("checklist items") : q.checklists.length === 0 ? '<div class="empty">No checklists.</div>' : `${firstN("checklists")}${firstN("checklist items")}<div class="small">Rows marked [automated] were set green by the evidence sweep from the citation shown; every other decision names the person who made it and their reason.</div>${checklistBlocks}`}

  <h2>Turnover package (${q.turnover.length}${capped.has("turnover items") ? "+" : ""})</h2>
  ${unread.has("turnover items") ? couldNot("turnover items") : q.turnover.length === 0 ? '<div class="empty">No turnover items.</div>' : `${firstN("turnover items")}<table><thead><tr><th>Item</th><th>Status</th><th>Reviewer</th><th>Reviewed</th><th>Note</th></tr></thead><tbody>${turnoverRows}</tbody></table>`}

  <h2>Punch list (${q.punch.length}${capped.has("punch items") ? "+" : ""})</h2>
  ${unread.has("punch items") ? couldNot("punch items") : q.punch.length === 0 ? '<div class="empty">No punch items.</div>' : `${firstN("punch items")}<table><thead><tr><th>Item</th><th>Status</th><th>Closed</th><th>Closed by</th><th>Closure note</th></tr></thead><tbody>${punchRows}</tbody></table>`}
`;
}

/** QUAL-10: what the project pack covers and what it does not — printed in
 *  its footer. */
export const PROJECT_PACK_COVERAGE =
  "Assembled from the project record, team, schedule, transmittals, the quality program (every checklist with its items, the turnover package and the punch list) and the project's audit trail (its first 1,000 rows). " +
  "Not included: the documents themselves and their revision history (each document's own evidence pack), the cost ledger (the project report), and audit rows recorded against other records.";

/** The footer as THIS pack was read: the coverage, plus any quality read
 *  that failed or stopped at its limit — the footer never claims a
 *  completeness the reads did not reach. */
export function projectPackCoverage(q: ProjectQualityEvidence): string {
  const parts = [PROJECT_PACK_COVERAGE];
  if (q.unread.length > 0) parts.push(`Not read this time: ${q.unread.join(", ")} — left out above, never printed as empty.`);
  if (q.capped.length > 0) parts.push(`Read only to the first ${PACK_ROW_CEILING.toLocaleString("en-US")} rows: ${q.capped.join(", ")} — the rest are left out above, not absent from the record.`);
  return parts.join(" ");
}

/** DIST-18 (limb a): a transmittal as the register served it, in the row
 *  shape the pack prints — an item the viewer may not read is
 *  "Restricted document" with no revision, status or hash, and a receipt
 *  note withheld from them is absent. */
export function transmittalEvidenceRow(t: Transmittal): Record<string, unknown> {
  return {
    id: t.id, number: t.number, status: t.status, purpose: t.purpose ?? null,
    recipient_name: t.recipientName ?? null, recipient_company: t.recipientCompany ?? null,
    issued_at: t.issuedAt ?? null, acknowledged_at: t.acknowledgedAt ?? null,
    acknowledged_by_name: t.acknowledgedByName ?? null, acknowledged_via: t.acknowledgedVia ?? null,
    acknowledged_meta: t.acknowledgedMeta ?? null, items: t.items ?? [],
  };
}

export async function gatherProjectEvidence(projectId: string): Promise<ProjectEvidence> {
  // One read of the project (a query builder runs again each time it is awaited).
  const projectQ = Promise.resolve(supabase.from("projects").select("*").eq("id", projectId).maybeSingle());
  // Formal issues to outside parties — contractual receipts belong in the
  // pack. DIST-18 (limb a): read through the transmittal register route for
  // the project's workspace (lib/transmittals listTransmittalsForProject), so
  // each row is what the register shows this viewer — never a browser
  // SELECT carrying every item and the portal token. A read that fails is
  // said in the pack, never printed as "none".
  const transmittalsQ = projectQ.then(async (p) => {
    const orgId = ((p.data as Record<string, unknown> | null)?.org_id as string | undefined) ?? null;
    if (!orgId) return { rows: [] as Array<Record<string, unknown>>, unread: true };
    try {
      const { listTransmittalsForProject } = await import("@/lib/transmittals");
      return { rows: (await listTransmittalsForProject(orgId, projectId)).map(transmittalEvidenceRow), unread: false };
    } catch (e) {
      console.warn("[evidencePack] the project's transmittals could not be read", (e as Error)?.message);
      return { rows: [] as Array<Record<string, unknown>>, unread: true };
    }
  });
  const [project, members, milestones, audit, transmittals] = await Promise.all([
    projectQ,
    supabase.from("project_members").select("*").eq("project_id", projectId).order("joined_at", { ascending: true }),
    supabase.from("milestones").select("*").eq("project_id", projectId).order("planned_at", { ascending: true }).limit(2000),
    supabase.from("audit_logs").select("*").eq("resource_type", "project").eq("resource_id", projectId).order("timestamp", { ascending: true }).limit(1000),
    transmittalsQ,
  ]);
  return {
    project: (project.data as Record<string, unknown>) ?? null,
    members: (members.data as Array<Record<string, unknown>>) ?? [],
    milestones: (milestones.data as Array<Record<string, unknown>>) ?? [],
    audit: (audit.data as Array<Record<string, unknown>>) ?? [],
    transmittals: transmittals.rows,
    ...(transmittals.unread ? { transmittalsUnread: true } : {}),
    quality: await gatherProjectQualityEvidence(projectId),
  };
}

export function renderProjectEvidenceHtml(data: ProjectEvidence): string {
  const p = data.project ?? {};
  const name = esc(p.name || "Project");
  const join = (a: string[]) => a.join("");

  const memberRows = data.members.map((m) => `
    <tr><td><b>${esc(m.user_name || m.user_email || m.user_id)}</b></td><td>${esc(m.role)}</td><td>${esc(m.responsibility || "—")}</td><td>${date(m.joined_at)}</td></tr>`);

  const msRows = data.milestones.map((m) => {
    const deps = Array.isArray(m.depends_on) ? (m.depends_on as unknown[]).length : 0;
    return `<tr>
      <td style="padding-left:${(Number(m.outline_level || 1) - 1) * 14 + 7}px">${m.is_summary ? "<b>" : ""}${esc(m.name)}${m.is_summary ? "</b>" : ""}</td>
      <td>${date(m.planned_start_at || m.planned_at)}</td>
      <td>${date(m.planned_at)}</td>
      <td>${esc(m.status || "—")}</td>
      <td>${esc(m.responsible_user_name || m.responsible_party || "—")}</td>
      <td>${deps > 0 ? `${deps} pred.` : "—"}</td>
    </tr>`;
  });

  const trRows = data.transmittals.map((t) => {
    const items = Array.isArray(t.items) ? (t.items as Array<Record<string, unknown>>) : [];
    // TRX-8 / TRX-3: each document as sent — its revision, its status at
    // issue, a short prefix of the issued file's SHA-256 and its size, so the
    // paper record identifies the exact bytes.
    const docList = items.map((i) => {
      const hash = typeof i.fileHash === "string" && i.fileHash ? ` #${esc(i.fileHash.slice(0, 12))}` : "";
      const size = typeof i.fileSize === "number" && Number.isFinite(i.fileSize) && i.fileSize >= 0
        ? ` ${i.fileSize < 1048576 ? `${Math.max(1, Math.round(i.fileSize / 1024))} KB` : `${(i.fileSize / 1048576).toFixed(1)} MB`}`
        : "";
      const state = typeof i.statusAsSent === "string" && i.statusAsSent ? ` (${esc(i.statusAsSent)})` : "";
      return `${esc(i.number)}${i.rev ? ` R${esc(i.rev)}` : ""}${state}${hash}${size}`;
    }).join(", ");
    // TRX-13: the receipt with its evidence — what the server saw on a portal
    // receipt (source address, the recipient's note), who recorded a manual one.
    const meta = (t.acknowledged_meta && typeof t.acknowledged_meta === "object" ? t.acknowledged_meta : {}) as Record<string, unknown>;
    const evidence = t.acknowledged_via === "portal"
      ? ` (portal${meta.ip ? ` · from ${esc(meta.ip)}` : ""}${meta.note ? ` · note: “${esc(meta.note)}”` : ""})`
      : t.acknowledged_via === "manual"
        ? ` (recorded internally${meta.recordedByEmail ? ` by ${esc(meta.recordedByEmail)}` : ""}${meta.note ? ` · note: “${esc(meta.note)}”` : ""})`
        : "";
    const ack = t.status === "acknowledged"
      ? `${esc(t.acknowledged_by_name || "—")} · ${date(t.acknowledged_at)}${evidence}`
      : esc(t.status || "—");
    return `<tr><td class="mono"><b>${esc(t.number)}</b></td><td>${esc(t.recipient_company || t.recipient_name || "—")}</td><td>${esc(t.purpose || "—")}</td><td>${date(t.issued_at)}</td><td>${ack}</td><td class="small">${docList || "—"}</td></tr>`;
  });

  const auditRows = data.audit.map((a) => `
    <tr><td>${date(a.timestamp)}</td><td><b>${esc(a.action)}</b></td><td>${esc(a.user_email || a.user_id || "—")}${actorNote(a)}</td><td class="mono small">${esc(a.details ? JSON.stringify(a.details) : "")}</td></tr>`);

  return `<!doctype html><html><head><meta charset="utf-8"><title>Project Evidence Pack — ${name}</title>
<style>
  * { box-sizing: border-box; } body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #0f172a; margin: 0; padding: 32px; font-size: 12px; }
  h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #475569; margin: 28px 0 8px; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; }
  .sub { color: #64748b; } .meta { display: flex; gap: 18px; flex-wrap: wrap; color: #334155; margin-top: 8px; } .meta b { color: #0f172a; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; } th, td { text-align: left; padding: 5px 7px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th { background: #f8fafc; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; }
  .mono { font-family: ui-monospace, Menlo, monospace; } .small { font-size: 10px; color: #64748b; word-break: break-all; } .empty { color: #94a3b8; font-style: italic; padding: 8px 0; }
  .toolbar { position: sticky; top: 0; background: #fff; padding-bottom: 10px; } .btn { background: #ea580c; color: #fff; border: 0; padding: 8px 14px; border-radius: 8px; font-weight: 700; cursor: pointer; }
  .footer { margin-top: 28px; color: #94a3b8; font-size: 10px; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  h3 { font-size: 12px; margin: 14px 0 4px; } .auto { font-size: 10px; font-weight: 700; letter-spacing: .04em; color: #475569; } tr.autorow td { background: #f1f5f9; font-style: italic; }
  @media print { .toolbar { display: none; } body { padding: 0; } }
</style></head><body>
  <div class="toolbar"><button class="btn" onclick="window.print()">Print / Save as PDF</button></div>
  <h1>Project Evidence Pack</h1>
  <div class="sub">${name}</div>
  <div class="meta">
    <span><b>Status:</b> ${esc(p.status || "—")}</span>
    <span><b>Owner:</b> ${esc(p.owner_user_name || "—")}</span>
    <span><b>Started:</b> ${date(p.started_at)}</span>
    <span><b>Target:</b> ${date(p.target_completion_date)}</span>
  </div>

  <h2>Team & responsibilities (${data.members.length})</h2>
  ${data.members.length === 0 ? '<div class="empty">No members.</div>' : `<table><thead><tr><th>Member</th><th>Role</th><th>Responsibility</th><th>Joined</th></tr></thead><tbody>${join(memberRows)}</tbody></table>`}

  <h2>Schedule (${data.milestones.length})</h2>
  ${data.milestones.length === 0 ? '<div class="empty">No schedule tasks.</div>' : `<table><thead><tr><th>Task</th><th>Start</th><th>Finish</th><th>Status</th><th>Responsible</th><th>Deps</th></tr></thead><tbody>${join(msRows)}</tbody></table>`}

  <h2>Transmittals — formal document issues (${data.transmittals.length})</h2>
  ${data.transmittalsUnread ? '<div class="empty">The transmittals could not be read — left out, not absent.</div>' : data.transmittals.length === 0 ? '<div class="empty">No transmittals tied to this project.</div>' : `<table><thead><tr><th>Number</th><th>To</th><th>Purpose</th><th>Issued</th><th>Receipt</th><th>Documents</th></tr></thead><tbody>${join(trRows)}</tbody></table>`}
${data.quality ? renderQualitySections(data.quality) : ""}
  <h2>Audit trail (${data.audit.length})</h2>
  ${data.audit.length === 0 ? '<div class="empty">No audit entries.</div>' : `<table><thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Details</th></tr></thead><tbody>${join(auditRows)}</tbody></table>`}

  <div class="footer">Generated ${new Date().toLocaleString()} · ManufacturingOS · ${data.quality ? esc(projectPackCoverage(data.quality)) : "Assembled from the project record, team, schedule, and immutable audit trail."}</div>
</body></html>`;
}

export async function openProjectEvidencePack(projectId: string): Promise<void> {
  const data = await gatherProjectEvidence(projectId);
  openPrintWindow(renderProjectEvidenceHtml(data));
}

export function openPrintWindow(html: string): void {
  const w = window.open("", "_blank");
  if (!w) throw new Error("Pop-up blocked — allow pop-ups to open the evidence pack.");
  w.document.open();
  w.document.write(html);
  w.document.close();
}
