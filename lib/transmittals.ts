// lib/transmittals.ts
//
// Transmittals — the formal, numbered record of ISSUING a set of documents
// (each at a specific revision) to a party for a stated purpose. The
// contractual "we sent you these drawings, at these revs, for construction,
// on this date" artifact every engineering doc-control shop lives on.
//
// A transmittal is a point-in-time SNAPSHOT: each item denormalizes the
// document number/title/rev as-sent, so the record stays truthful even after
// the documents rev forward (or get deleted). Items live in a JSONB column.
//
// The data layer is resilient: if the `transmittals` table hasn't been
// migrated yet, calls throw a friendly "run the migration" message instead of
// a raw Postgres error (same pattern as the resilient library fetch).

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
import { openPrintWindow } from "@/lib/evidencePack";

export type TransmittalStatus = "draft" | "issued" | "acknowledged" | "voided";

// Canonical issue purposes. "For Construction" / "For Approval" carry
// contractual weight; "For Information" / "For Record" do not.
export const TRANSMITTAL_PURPOSES = [
  "For Review",
  "For Approval",
  "For Construction",
  "For Information",
  "For Record",
] as const;
export type TransmittalPurpose = (typeof TRANSMITTAL_PURPOSES)[number];

export interface TransmittalItem {
  documentId: string;
  number: string;
  title?: string | null;
  rev?: string | null;
  versionId?: string | null;
}

export interface Transmittal {
  id: string;
  orgId: string;
  projectId?: string | null;
  seq: number;
  number: string;
  subject?: string | null;
  recipientName?: string | null;
  recipientCompany?: string | null;
  recipientEmail?: string | null;
  purpose?: string | null;
  status: TransmittalStatus;
  notes?: string | null;
  items: TransmittalItem[];
  createdBy?: string | null;
  createdByName?: string | null;
  issuedAt?: string | null;
  acknowledgedAt?: string | null;
  acknowledgedByName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

// ─── Pure helpers (unit-tested; no I/O) ─────────────────────────────────────

/** Format the per-org sequence into the human label, e.g. 1 → "TR-0001". */
export function formatTransmittalNumber(seq: number): string {
  const n = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 1;
  return `TR-${String(n).padStart(4, "0")}`;
}

/** A short, human status label + tone hint for chips. */
export function transmittalStatusMeta(s: TransmittalStatus): { label: string; tone: "slate" | "blue" | "emerald" | "rose" } {
  switch (s) {
    case "issued": return { label: "Issued", tone: "blue" };
    case "acknowledged": return { label: "Acknowledged", tone: "emerald" };
    case "voided": return { label: "Voided", tone: "rose" };
    default: return { label: "Draft", tone: "slate" };
  }
}

/** True when the transmittal carries no documents — can't be issued. */
export function isTransmittalIssuable(t: Pick<Transmittal, "items" | "recipientName" | "recipientCompany">): boolean {
  const hasItems = (t.items?.length ?? 0) > 0;
  const hasRecipient = !!(t.recipientName?.trim() || t.recipientCompany?.trim());
  return hasItems && hasRecipient;
}

const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtDate = (v: unknown): string => {
  if (!v) return "—";
  try { return new Date(String(v)).toLocaleString(); } catch { return esc(v); }
};

/**
 * Render the printable transmittal cover sheet (print-to-PDF). Pure — takes a
 * fully-formed Transmittal and returns a self-contained HTML document.
 */
export function renderTransmittalSheet(t: Transmittal): string {
  const itemRows = (t.items ?? []).map((it, i) => `
    <tr>
      <td class="muted">${i + 1}</td>
      <td class="mono"><b>${esc(it.number)}</b></td>
      <td>${esc(it.title || "—")}</td>
      <td class="mono">${esc(it.rev || "—")}</td>
    </tr>`).join("");

  const meta = (label: string, value: string) =>
    `<tr><td class="lbl">${esc(label)}</td><td>${value}</td></tr>`;

  const ackLine = t.status === "acknowledged"
    ? `<div class="ack">Receipt acknowledged ${t.acknowledgedByName ? `by ${esc(t.acknowledgedByName)} ` : ""}on ${fmtDate(t.acknowledgedAt)}.</div>`
    : `<div class="sign">
        <div class="sigbox"><div class="sigline"></div><div class="siglbl">Received by (print &amp; sign)</div></div>
        <div class="sigbox"><div class="sigline"></div><div class="siglbl">Date</div></div>
       </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Transmittal ${esc(t.number)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #0f172a; margin: 0; padding: 32px; font-size: 12px; }
  h1 { font-size: 22px; margin: 0; } .num { font-size: 14px; color: #ea580c; font-weight: 800; letter-spacing: .04em; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #475569; margin: 24px 0 8px; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; border-bottom: 3px solid #ea580c; padding-bottom: 12px; }
  .purpose { display: inline-block; margin-top: 6px; background: #fff7ed; border: 1px solid #fed7aa; color: #c2410c; font-weight: 800; font-size: 11px; padding: 4px 10px; border-radius: 999px; text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th { background: #f8fafc; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; }
  .meta td { border: 0; padding: 3px 8px; } .meta .lbl { color: #64748b; font-weight: 700; width: 130px; }
  .mono { font-family: ui-monospace, Menlo, monospace; } .muted { color: #94a3b8; }
  .grid { display: flex; gap: 40px; flex-wrap: wrap; } .grid > div { flex: 1; min-width: 220px; }
  .notes { background: #fafafa; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; color: #334155; white-space: pre-wrap; }
  .sign { display: flex; gap: 32px; margin-top: 28px; } .sigbox { flex: 1; } .sigline { border-bottom: 1px solid #94a3b8; height: 36px; } .siglbl { font-size: 10px; color: #64748b; margin-top: 4px; }
  .ack { margin-top: 24px; background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; font-weight: 700; padding: 10px 12px; border-radius: 8px; }
  .toolbar { position: sticky; top: 0; background: #fff; padding-bottom: 10px; } .btn { background: #ea580c; color: #fff; border: 0; padding: 8px 14px; border-radius: 8px; font-weight: 700; cursor: pointer; }
  .footer { margin-top: 28px; color: #94a3b8; font-size: 10px; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  @media print { .toolbar { display: none; } body { padding: 0; } }
</style></head><body>
  <div class="toolbar"><button class="btn" onclick="window.print()">Print / Save as PDF</button></div>
  <div class="head">
    <div>
      <div class="num">TRANSMITTAL ${esc(t.number)}</div>
      <h1>${esc(t.subject || "Document Transmittal")}</h1>
      ${t.purpose ? `<span class="purpose">${esc(t.purpose)}</span>` : ""}
    </div>
    <table class="meta" style="width:auto">
      ${meta("Status", esc(transmittalStatusMeta(t.status).label))}
      ${meta("Issued", fmtDate(t.issuedAt || t.createdAt))}
      ${meta("From", esc(t.createdByName || "—"))}
    </table>
  </div>

  <div class="grid">
    <div>
      <h2>To</h2>
      <table class="meta">
        ${meta("Name", esc(t.recipientName || "—"))}
        ${meta("Company", esc(t.recipientCompany || "—"))}
        ${meta("Email", esc(t.recipientEmail || "—"))}
      </table>
    </div>
    <div>
      <h2>Transmittal</h2>
      <table class="meta">
        ${meta("Number", esc(t.number))}
        ${meta("Purpose", esc(t.purpose || "—"))}
        ${meta("Documents", String(t.items?.length ?? 0))}
      </table>
    </div>
  </div>

  <h2>Documents transmitted (${t.items?.length ?? 0})</h2>
  ${(t.items?.length ?? 0) === 0
    ? '<div class="muted" style="font-style:italic;padding:8px 0">No documents on this transmittal.</div>'
    : `<table>
        <thead><tr><th style="width:32px">#</th><th>Number</th><th>Title</th><th style="width:80px">Rev</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>`}

  ${t.notes ? `<h2>Notes</h2><div class="notes">${esc(t.notes)}</div>` : ""}

  ${ackLine}

  <div class="footer">Transmittal ${esc(t.number)} · Generated ${new Date().toLocaleString()} · ManufacturingOS · This is the controlled record of the documents and revisions issued above.</div>
</body></html>`;
}

/** Render + open the cover sheet in a new window for print / save-as-PDF. */
export function openTransmittalSheet(t: Transmittal): void {
  openPrintWindow(renderTransmittalSheet(t));
}

// ─── Data layer (resilient to the table not being migrated yet) ─────────────

const MIGRATION_HINT =
  "Transmittals aren't set up yet — run supabase/migrations/20260717_transmittals.sql, then reload.";

function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42P01" || /relation .*transmittals.* does not exist/i.test(error.message ?? "");
}

export function rowToTransmittal(r: Record<string, unknown>): Transmittal {
  const rawItems = r.items;
  const items: TransmittalItem[] = Array.isArray(rawItems)
    ? (rawItems as Array<Record<string, unknown>>).map((it) => ({
        documentId: String(it.documentId ?? it.document_id ?? ""),
        number: String(it.number ?? ""),
        title: (it.title as string) ?? null,
        rev: (it.rev as string) ?? null,
        versionId: (it.versionId as string) ?? (it.version_id as string) ?? null,
      }))
    : [];
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    projectId: (r.project_id as string) ?? null,
    seq: Number(r.seq ?? 0),
    number: String(r.number ?? ""),
    subject: (r.subject as string) ?? null,
    recipientName: (r.recipient_name as string) ?? null,
    recipientCompany: (r.recipient_company as string) ?? null,
    recipientEmail: (r.recipient_email as string) ?? null,
    purpose: (r.purpose as string) ?? null,
    status: (r.status as TransmittalStatus) ?? "draft",
    notes: (r.notes as string) ?? null,
    items,
    createdBy: (r.created_by as string) ?? null,
    createdByName: (r.created_by_name as string) ?? null,
    issuedAt: (r.issued_at as string) ?? null,
    acknowledgedAt: (r.acknowledged_at as string) ?? null,
    acknowledgedByName: (r.acknowledged_by_name as string) ?? null,
    createdAt: (r.created_at as string) ?? null,
    updatedAt: (r.updated_at as string) ?? null,
  };
}

/** Next per-org sequence number (max existing + 1). */
async function nextTransmittalSeq(orgId: string): Promise<number> {
  const { data, error } = await supabase
    .from("transmittals")
    .select("seq")
    .eq("org_id", orgId)
    .order("seq", { ascending: false })
    .limit(1);
  if (error) { if (isMissingTable(error)) throw new Error(MIGRATION_HINT); throw new Error(error.message); }
  const top = (data?.[0]?.seq as number | undefined) ?? 0;
  return top + 1;
}

export interface CreateTransmittalInput {
  orgId: string;
  projectId?: string | null;
  subject?: string;
  recipientName?: string;
  recipientCompany?: string;
  recipientEmail?: string;
  purpose?: string;
  notes?: string;
  items: TransmittalItem[];
  actorUserId: string;
  actorName?: string;
  actorRole?: string;
  /** Create and immediately mark issued (skip the draft step). */
  issueNow?: boolean;
}

export async function createTransmittal(input: CreateTransmittalInput): Promise<Transmittal> {
  const issueNow = !!input.issueNow;
  const now = new Date().toISOString();

  // Race-tolerant insert: compute the next seq, insert; on a unique-number
  // collision (someone drafted at the same moment), bump and retry a few times.
  let lastErr: { code?: string; message?: string } | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const seq = await nextTransmittalSeq(input.orgId) + attempt;
    const number = formatTransmittalNumber(seq);
    const { data, error } = await supabase
      .from("transmittals")
      .insert({
        org_id: input.orgId,
        project_id: input.projectId || null,
        seq,
        number,
        subject: input.subject?.trim() || null,
        recipient_name: input.recipientName?.trim() || null,
        recipient_company: input.recipientCompany?.trim() || null,
        recipient_email: input.recipientEmail?.trim() || null,
        purpose: input.purpose || null,
        status: issueNow ? "issued" : "draft",
        notes: input.notes?.trim() || null,
        items: input.items ?? [],
        created_by: input.actorUserId,
        created_by_name: input.actorName || null,
        issued_at: issueNow ? now : null,
      })
      .select("*")
      .single();

    if (!error && data) {
      const t = rowToTransmittal(data as Record<string, unknown>);
      await logAuditAction({
        action: issueNow ? "TRANSMITTAL_ISSUED" : "TRANSMITTAL_CREATED",
        resourceId: t.id,
        resourceType: "transmittal",
        orgId: input.orgId,
        userId: input.actorUserId,
        userEmail: input.actorName,
        userRole: input.actorRole,
        details: { number: t.number, purpose: t.purpose, recipient: t.recipientName || t.recipientCompany, documentCount: t.items.length },
      });
      return t;
    }
    lastErr = error;
    if (isMissingTable(error)) throw new Error(MIGRATION_HINT);
    // 23505 = unique_violation on the org/number index → retry with a higher seq.
    if (error?.code !== "23505") break;
  }
  throw new Error(lastErr?.message || "Failed to create transmittal");
}

export async function listTransmittals(orgId: string): Promise<Transmittal[]> {
  const { data, error } = await supabase
    .from("transmittals")
    .select("*")
    .eq("org_id", orgId)
    .order("seq", { ascending: false })
    .limit(1000);
  if (error) { if (isMissingTable(error)) throw new Error(MIGRATION_HINT); throw new Error(error.message); }
  return (data ?? []).map((r) => rowToTransmittal(r as Record<string, unknown>));
}

export async function getTransmittal(id: string): Promise<Transmittal | null> {
  const { data, error } = await supabase.from("transmittals").select("*").eq("id", id).maybeSingle();
  if (error) { if (isMissingTable(error)) throw new Error(MIGRATION_HINT); throw new Error(error.message); }
  return data ? rowToTransmittal(data as Record<string, unknown>) : null;
}

export interface UpdateTransmittalDraftInput {
  subject?: string;
  recipientName?: string;
  recipientCompany?: string;
  recipientEmail?: string;
  purpose?: string;
  notes?: string;
  items?: TransmittalItem[];
}

/** Edit a draft's fields. Only meaningful while status === 'draft'. */
export async function updateTransmittalDraft(id: string, patch: UpdateTransmittalDraftInput): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.subject !== undefined) row.subject = patch.subject?.trim() || null;
  if (patch.recipientName !== undefined) row.recipient_name = patch.recipientName?.trim() || null;
  if (patch.recipientCompany !== undefined) row.recipient_company = patch.recipientCompany?.trim() || null;
  if (patch.recipientEmail !== undefined) row.recipient_email = patch.recipientEmail?.trim() || null;
  if (patch.purpose !== undefined) row.purpose = patch.purpose || null;
  if (patch.notes !== undefined) row.notes = patch.notes?.trim() || null;
  if (patch.items !== undefined) row.items = patch.items;
  const { error } = await supabase.from("transmittals").update(row).eq("id", id).eq("status", "draft");
  if (error) { if (isMissingTable(error)) throw new Error(MIGRATION_HINT); throw new Error(error.message); }
}

export interface TransmittalActor {
  orgId: string;
  actorUserId: string;
  actorName?: string;
  actorRole?: string;
}

/** Move a draft → issued and stamp the issue time. */
export async function issueTransmittal(id: string, actor: TransmittalActor): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("transmittals")
    .update({ status: "issued", issued_at: now, updated_at: now })
    .eq("id", id)
    .eq("status", "draft")
    .select("number, purpose, recipient_name, recipient_company, items")
    .maybeSingle();
  if (error) { if (isMissingTable(error)) throw new Error(MIGRATION_HINT); throw new Error(error.message); }
  await logAuditAction({
    action: "TRANSMITTAL_ISSUED",
    resourceId: id,
    resourceType: "transmittal",
    orgId: actor.orgId,
    userId: actor.actorUserId,
    userEmail: actor.actorName,
    userRole: actor.actorRole,
    details: data ? { number: data.number, purpose: data.purpose, recipient: data.recipient_name || data.recipient_company, documentCount: Array.isArray(data.items) ? data.items.length : 0 } : undefined,
  });
}

/** Record recipient receipt (issued → acknowledged). */
export async function acknowledgeTransmittal(id: string, acknowledgedByName: string, actor: TransmittalActor): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("transmittals")
    .update({ status: "acknowledged", acknowledged_at: now, acknowledged_by_name: acknowledgedByName.trim() || null, updated_at: now })
    .eq("id", id)
    .eq("status", "issued");
  if (error) { if (isMissingTable(error)) throw new Error(MIGRATION_HINT); throw new Error(error.message); }
  await logAuditAction({
    action: "TRANSMITTAL_ACKNOWLEDGED",
    resourceId: id,
    resourceType: "transmittal",
    orgId: actor.orgId,
    userId: actor.actorUserId,
    userEmail: actor.actorName,
    userRole: actor.actorRole,
    details: { acknowledgedBy: acknowledgedByName },
  });
}

/** Void an issued transmittal (it was sent in error). Drafts are deleted, not voided. */
export async function voidTransmittal(id: string, actor: TransmittalActor): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("transmittals")
    .update({ status: "voided", updated_at: now })
    .eq("id", id)
    .neq("status", "voided");
  if (error) { if (isMissingTable(error)) throw new Error(MIGRATION_HINT); throw new Error(error.message); }
  await logAuditAction({
    action: "TRANSMITTAL_VOIDED",
    resourceId: id,
    resourceType: "transmittal",
    orgId: actor.orgId,
    userId: actor.actorUserId,
    userEmail: actor.actorName,
    userRole: actor.actorRole,
  });
}

/** Delete a draft (never an issued record — those are voided for audit). */
export async function deleteTransmittal(id: string): Promise<void> {
  const { error } = await supabase.from("transmittals").delete().eq("id", id).eq("status", "draft");
  if (error) { if (isMissingTable(error)) throw new Error(MIGRATION_HINT); throw new Error(error.message); }
}
