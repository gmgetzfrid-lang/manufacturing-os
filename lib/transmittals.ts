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
// At the ISSUE transition the database (trg_transmittals_guard, 20261133)
// completes the snapshot itself — the pinned version (always the document's
// CURRENT revision), its file hash and size, the document's status and the
// revision's effective date as sent (TRX-3 / TRX-8 / TRX-12) — so the browser
// cannot author them.
//
// Who may do what (TRX-1 / TRX-2 / TRX-6, enforced at the database):
//   * every active member may DRAFT, and edit / delete their own drafts;
//   * issuing, voiding, revoking the portal link and recording a receipt on
//     the recipient's behalf are the transmit authority's — the
//     `transmittal.issue` capability, evaluated per item library (DEC-13);
//   * an issued transmittal is never deleted and its content never changes;
//   * the receipt is written once, by the recipient portal or the receipt
//     route (both server-side), never by a member session.
//
// The data layer is resilient: if the `transmittals` table hasn't been
// migrated yet, calls throw a friendly "run the migration" message instead of
// a raw Postgres error (same pattern as the resilient library fetch). Every
// mutation is CHECKED (TRX-7): a write that changed no row throws, and the
// audit row is written only for a confirmed change.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
import { openPrintWindow } from "@/lib/evidencePack";
import { configuredPublicOrigin } from "@/lib/publicOrigin";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { assertNotOnHold, type HoldGateClient } from "@/lib/holdGate";
import { isSafeStorageKey } from "@/lib/storageKey";
import { orgKeyPrefix } from "@/lib/shedKeyGuard";
import { loadCapabilityPolicyStrict, policyAllows, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { isControllerPrincipal } from "@/lib/permissions";
import { memberHoldsAny } from "@/lib/roleHeld";
import type { Role } from "@/types/schema";

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

/** TRX-1: the capability that decides who may issue, void, revoke the portal
 *  link of, and record a receipt on, a transmittal. */
export const TRANSMIT_CAPABILITY = "transmittal.issue" as const;

/** TRX-4: how long a portal link lives after issue. The database sets it on
 *  the issue transition (20261133); this constant is the UI's copy of it. */
export const PORTAL_LINK_DAYS = 90;

export interface TransmittalItem {
  documentId: string;
  number: string;
  title?: string | null;
  rev?: string | null;
  versionId?: string | null;
  /** As-sent snapshot, written by the database at issue (20261133). */
  fileHash?: string | null;
  /** Bytes of the file issued (document_versions.size at issue). */
  fileSize?: number | null;
  statusAsSent?: string | null;
  effectiveDate?: string | null;
}

/** TRX-13: what the server saw when the receipt was recorded. A portal
 *  receipt carries the recipient's request (IP / user agent / note); a
 *  receipt recorded on the register carries who recorded it. */
export interface TransmittalAckMeta {
  ip?: string | null;
  userAgent?: string | null;
  note?: string | null;
  recordedBy?: string | null;
  recordedByEmail?: string | null;
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
  acknowledgedVia?: "portal" | "manual" | null;
  acknowledgedMeta?: TransmittalAckMeta | null;
  /** Unguessable external-portal token (minted by the database on issue). */
  portalToken?: string | null;
  /** TRX-4: the portal link's own lifecycle — separate from the record's. */
  portalExpiresAt?: string | null;
  portalRevokedAt?: string | null;
  portalRevokedBy?: string | null;
  portalLastUsedAt?: string | null;
  /** null when the database predates 20261133 (no usage trail to read). */
  portalOpenCount?: number | null;
  portalDownloadCount?: number | null;
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

/** What the composer knows about one item's document before issue. */
export interface IssueFacts {
  status?: string | null;
  archivedAt?: string | null;
  currentVersionId?: string | null;
  /** The document's Rev field (documents.rev). */
  rev?: string | null;
  /** The revision label of the document's CURRENT file (the current
   *  version's revision_label). `undefined` = not read; the database still
   *  decides at issue. */
  currentRevisionLabel?: string | null;
  legalHold?: boolean | null;
  /** Active operational holds (reasons). `null` = the hold read FAILED. */
  holds?: string[] | null;
  /** False when the document row could not be read at all. */
  found?: boolean;
}

/** TRX-3 / HLD-1: why an item cannot go out on a transmittal, or null. The
 *  database applies the same rule at the issue transition (20261133); this
 *  is the composer's copy, so the button says why before a round-trip. An
 *  unreadable hold set BLOCKS (fail closed, the lib/holdGate.ts stance). A
 *  legal hold does not block — it asks for confirmation (legalHoldNotice).
 *
 *  Status truth: what goes out is the document's CURRENT revision. An item
 *  pinned to an older version (it was added before the document revved up)
 *  is refused with the revision that superseded it, and an item whose Rev
 *  does not match the current file's label is refused with the cause — the
 *  document's own Rev field drifted from its file (correct the document), or
 *  the item is stale (remove it and add it again). */
export function itemIssueBlocker(item: Pick<TransmittalItem, "number"> & Partial<Pick<TransmittalItem, "documentId" | "versionId" | "rev">>, facts: IssueFacts | undefined): string | null {
  const label = item.number || "This document";
  if (!facts || facts.found === false) return `${label} could not be read — it may have been deleted or you can't see it.`;
  if (facts.archivedAt || NOT_CURRENT_STATUSES.has(facts.status ?? "")) {
    const state = facts.archivedAt ? "archived" : String(facts.status).toLowerCase();
    return `${label} is withdrawn (${state}) and cannot be issued on a transmittal.`;
  }
  if (facts.holds === null) return `Couldn't confirm ${label} is free of holds — it is treated as held.`;
  if ((facts.holds?.length ?? 0) > 0) return `${label} is under an active hold (${facts.holds!.join(", ")}) — release it before issuing.`;
  if (!facts.currentVersionId) return `${label} has no published file to send.`;
  const current = typeof facts.currentRevisionLabel === "string" ? facts.currentRevisionLabel.trim() : null;
  if (item.versionId && item.versionId !== facts.currentVersionId) {
    return `${label} Rev ${item.rev?.trim() || "?"} has been superseded by Rev ${current || "a newer revision"} — remove ${label} and add it again to send the current revision.`;
  }
  const itemRev = item.rev?.trim() || null;
  if (current && itemRev && current !== itemRev) {
    const docRev = facts.rev?.trim() || null;
    if (docRev === itemRev) {
      return `${label}: the document's Rev field (${docRev}) does not match its current file (Rev ${current}) — correct the document's revision before issuing it.`;
    }
    return `${label} is listed at Rev ${itemRev}, but its current file is Rev ${current} — remove ${label} and add it again.`;
  }
  return null;
}

/** True when the transmittal can be issued: at least one document, a
 *  recipient, and — when the caller passes what it knows about each item —
 *  no item that is withdrawn, held, unreadable or without a file (TRX-3). */
export function isTransmittalIssuable(
  t: Pick<Transmittal, "items" | "recipientName" | "recipientCompany">,
  facts?: ReadonlyMap<string, IssueFacts>,
): boolean {
  const hasItems = (t.items?.length ?? 0) > 0;
  const hasRecipient = !!(t.recipientName?.trim() || t.recipientCompany?.trim());
  if (!hasItems || !hasRecipient) return false;
  if (!facts) return true;
  return t.items.every((it) => itemIssueBlocker(it, facts.get(it.documentId)) === null);
}

/** TRX-3 dw2: the confirmation a legal hold asks for (null when none). */
export function legalHoldNotice(items: TransmittalItem[], facts: ReadonlyMap<string, IssueFacts>): string | null {
  const held = items.filter((it) => facts.get(it.documentId)?.legalHold).map((it) => it.number);
  if (held.length === 0) return null;
  return `${held.join(", ")} ${held.length === 1 ? "is" : "are"} under a legal hold. Issuing sends a copy of preserved records to an outside party — confirm this distribution is cleared.`;
}

/** TRX-1 / DEC-13: may this principal transmit a set of items? Every item's
 *  LIBRARY is a resource the capability is evaluated against (a library rule
 *  replaces the base list for that library); an item whose library is unknown
 *  — and a transmittal with no items — is judged on the base list. The
 *  database runs the same rule (org_capability_allows_for per item). */
export function mayTransmit(
  policy: CapabilityPolicy | null | undefined,
  principal: { role?: string | null; roles?: string[] | null; uid?: string | null },
  libraryIds: ReadonlyArray<string | null | undefined>,
): boolean {
  const check = (libraryId?: string | null) =>
    policyAllows(policy, TRANSMIT_CAPABILITY, principal.role ?? null, principal.roles ?? null, principal.uid ?? null,
      libraryId ? { libraryId } : null);
  if (libraryIds.length === 0) return check(null);
  return libraryIds.every((lib) => check(lib ?? null));
}

/** TRX-7: the roles the RESTRICTIVE `transmittals_delete_guard` (20260818,
 *  unchanged) admits through `is_org_admin_or_manager` — its mirror here,
 *  the way `isControllerPrincipal` mirrors `is_org_controller`. */
export const DRAFT_DELETE_GUARD_ROLES: readonly string[] = ["Admin", "Manager"];

/** TRX-7: may this principal delete this draft? The database ANDs two
 *  policies: the permissive `transmittals_delete` (20261133 — a draft, by a
 *  controller or its active author) and the RESTRICTIVE
 *  `transmittals_delete_guard` (20260818 — an Admin / Manager, the author,
 *  or someone who can manage the draft's project). Together: the author;
 *  otherwise a controller who is ALSO an Admin / Manager or manages the
 *  draft's project (`managedProjectIds`: projects the principal owns or is
 *  an owner / collaborator on — can_manage_project's other arms). */
export function mayDeleteDraft(
  t: Pick<Transmittal, "status" | "createdBy" | "projectId">,
  principal: { role?: string | null; roles?: string[] | null; uid?: string | null },
  managedProjectIds: ReadonlySet<string> = new Set(),
): boolean {
  if (t.status !== "draft") return false;
  if (principal.uid && t.createdBy === principal.uid) return true;
  const member = { role: principal.role ?? null, roles: principal.roles ?? [] };
  if (!isControllerPrincipal({ role: (member.role ?? "Viewer") as Role, roles: member.roles as Role[] })) return false;
  return memberHoldsAny(member, DRAFT_DELETE_GUARD_ROLES) || (!!t.projectId && managedProjectIds.has(t.projectId));
}

/** TRX-4: the state of the portal LINK, independent of the record's status. */
export type PortalLinkState = "none" | "live" | "revoked" | "expired" | "voided";
export function portalLinkState(
  t: Pick<Transmittal, "status" | "portalToken" | "portalRevokedAt" | "portalExpiresAt">,
  now: number = Date.now(),
): PortalLinkState {
  if (!t.portalToken) return "none";
  if (t.status === "voided") return "voided";
  if (t.portalRevokedAt) return "revoked";
  if (t.portalExpiresAt && Date.parse(t.portalExpiresAt) <= now) return "expired";
  return "live";
}

/** TRX-4: the portal's refusal for a transmittals ROW (the route reads raw
 *  rows with the service role), checked before anything is served. Voided
 *  first (the record itself is withdrawn), then a revoked or an expired link
 *  — each a distinct 410, as /api/intake/resolve answers. A draft never
 *  carries a token; anything not issued / acknowledged is not served. */
export function portalRowRefusal(t: Record<string, unknown>, now: number = Date.now()): { status: number; error: "voided" | "notfound" | "revoked" | "expired" } | null {
  if (t.status === "voided") return { status: 410, error: "voided" };
  if (t.status !== "issued" && t.status !== "acknowledged") return { status: 404, error: "notfound" };
  if (t.portal_revoked_at) return { status: 410, error: "revoked" };
  const exp = t.portal_expires_at ? Date.parse(String(t.portal_expires_at)) : NaN;
  if (Number.isFinite(exp) && exp <= now) return { status: 410, error: "expired" };
  return null;
}

/** TRX-11 (the key half): a storage key that names ANOTHER workspace's
 *  prefix, or climbs out of its own, is never read by the portal — whatever
 *  row it came from. Keys with no `orgs/` prefix predate the convention and
 *  stay readable (their row is already org-scoped, EGR-1). */
export function portalKeyAllowed(key: string, orgId: string): boolean {
  if (!isSafeStorageKey(key)) return false;
  if (key.startsWith("orgs/") && !key.startsWith(orgKeyPrefix(orgId))) return false;
  return true;
}

/** TRX-8: the short hash prefix a paper record prints per document. */
export function hashPrefix(hash: string | null | undefined, n = 12): string | null {
  const h = (hash ?? "").trim();
  return h ? h.slice(0, n) : null;
}

/** TRX-8: the issued file's size as a paper record prints it ("2.4 MB"), or
 *  null when the snapshot carries none. */
export function fileSizeLabel(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

/** TRX-3: the as-sent state line for one item ("Issued · effective 2026-11-01
 *  (pending)"), or null when the snapshot carries neither. */
export function itemAsSentLabel(it: Pick<TransmittalItem, "statusAsSent" | "effectiveDate">, today: Date = new Date()): string | null {
  const parts: string[] = [];
  if (it.statusAsSent) parts.push(it.statusAsSent);
  if (it.effectiveDate) {
    const eff = it.effectiveDate.slice(0, 10);
    const pending = eff > today.toISOString().slice(0, 10);
    parts.push(`effective ${eff}${pending ? " (not yet in force)" : ""}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtDate = (v: unknown): string => {
  if (!v) return "—";
  try { return new Date(String(v)).toLocaleString(); } catch { return esc(v); }
};

/** TRX-13: the receipt line, with the evidence behind it. A portal receipt
 *  names what the server saw (time, source address, the recipient's note); a
 *  receipt recorded on the register names who recorded it. */
export function receiptEvidence(t: Pick<Transmittal, "acknowledgedByName" | "acknowledgedAt" | "acknowledgedVia" | "acknowledgedMeta">): string {
  const by = t.acknowledgedByName ? `by ${t.acknowledgedByName} ` : "";
  const head = `Receipt acknowledged ${by}on ${t.acknowledgedAt ? new Date(t.acknowledgedAt).toLocaleString() : "—"}`;
  const m = t.acknowledgedMeta ?? null;
  if (t.acknowledgedVia === "portal") {
    const bits = ["through the recipient portal"];
    if (m?.ip) bits.push(`from ${m.ip}`);
    const note = m?.note ? ` Their note: "${m.note}"` : "";
    return `${head} ${bits.join(" ")}.${note}`;
  }
  if (t.acknowledgedVia === "manual") {
    const who = m?.recordedByEmail || m?.recordedBy;
    const note = m?.note ? ` Note: "${m.note}"` : "";
    return `${head} — recorded on the register${who ? ` by ${who}` : ""}.${note}`;
  }
  return `${head}.`;
}

/**
 * Render the printable transmittal cover sheet (print-to-PDF). Pure — takes a
 * fully-formed Transmittal and returns a self-contained HTML document.
 */
export function renderTransmittalSheet(t: Transmittal, opts?: { portalUrl?: string | null; qrDataUrl?: string | null }): string {
  const showAsSent = (t.items ?? []).some((it) => it.statusAsSent || it.effectiveDate || it.fileHash || it.fileSize != null);
  const itemRows = (t.items ?? []).map((it, i) => `
    <tr>
      <td class="muted">${i + 1}</td>
      <td class="mono"><b>${esc(it.number)}</b></td>
      <td>${esc(it.title || "—")}</td>
      <td class="mono">${esc(it.rev || "—")}</td>${showAsSent ? `
      <td>${esc(itemAsSentLabel(it) || "—")}</td>
      <td class="mono">${esc(hashPrefix(it.fileHash) || "—")}${fileSizeLabel(it.fileSize) ? `<div class="muted">${esc(fileSizeLabel(it.fileSize))}</div>` : ""}</td>` : ""}
    </tr>`).join("");

  const meta = (label: string, value: string) =>
    `<tr><td class="lbl">${esc(label)}</td><td>${value}</td></tr>`;

  const ackLine = t.status === "acknowledged"
    ? `<div class="ack">${esc(receiptEvidence(t))}</div>`
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
        <thead><tr><th style="width:32px">#</th><th>Number</th><th>Title</th><th style="width:80px">Rev</th>${showAsSent ? '<th>Status as sent</th><th style="width:110px">SHA-256 · size</th>' : ""}</tr></thead>
        <tbody>${itemRows}</tbody>
      </table>`}

  ${t.notes ? `<h2>Notes</h2><div class="notes">${esc(t.notes)}</div>` : ""}

  ${ackLine}

  ${opts?.portalUrl ? `
  <div style="margin-top:24px;display:flex;gap:16px;align-items:center;border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px;background:#fafafa">
    ${opts.qrDataUrl ? `<img src="${opts.qrDataUrl}" alt="Portal QR" style="width:92px;height:92px" />` : ""}
    <div>
      <div style="font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#475569">Recipient portal — download &amp; acknowledge online</div>
      <div class="mono" style="font-size:10px;color:#334155;margin-top:4px;word-break:break-all">${esc(opts.portalUrl)}</div>
      <div style="font-size:10px;color:#94a3b8;margin-top:4px">Scan or open the link to download the transmitted files at their as-issued revisions and record receipt. The link is unique to this transmittal.${t.portalExpiresAt ? ` It stops working on ${esc(new Date(t.portalExpiresAt).toLocaleDateString())}.` : ""}</div>
    </div>
  </div>` : ""}

  <div class="footer">Transmittal ${esc(t.number)} · Generated ${new Date().toLocaleString()} · ManufacturingOS · This is the controlled record of the documents and revisions issued above.${showAsSent ? " Each SHA-256 prefix (and size) identifies the exact file issued." : ""}</div>
</body></html>`;
}

/**
 * Compose the recipient-facing issue email. Pure — subject/text/html from a
 * fully-formed Transmittal plus its portal URL. The portal link is the whole
 * point of the email: files download at their as-sent revisions and receipt
 * is recorded there, so no attachments.
 */
export function renderTransmittalEmail(t: Transmittal, portalUrl: string): { subject: string; text: string; html: string } {
  const docLinesText = (t.items ?? [])
    .map((it, i) => `  ${i + 1}. ${it.number}${it.rev ? ` (Rev ${it.rev})` : ""}${it.title ? ` — ${it.title}` : ""}`)
    .join("\n");
  const subject = `Transmittal ${t.number}${t.subject ? ` — ${t.subject}` : ""}${t.purpose ? ` (${t.purpose})` : ""}`;
  const greeting = t.recipientName?.trim() ? `Hello ${t.recipientName.trim()},` : "Hello,";
  const from = t.createdByName?.trim() || "Document control";

  const text = [
    greeting,
    "",
    `You have been issued transmittal ${t.number}${t.purpose ? ` — ${t.purpose}` : ""} covering ${t.items?.length ?? 0} document(s):`,
    "",
    docLinesText || "  (no documents listed)",
    "",
    t.notes?.trim() ? `Notes:\n${t.notes.trim()}\n` : "",
    "Download the documents at their as-issued revisions and acknowledge receipt here:",
    portalUrl,
    "",
    "The link is unique to this transmittal — please don't forward it.",
    "",
    `— ${from}`,
  ].filter((l) => l !== "").join("\n");

  const docRowsHtml = (t.items ?? []).map((it, i) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;color:#94a3b8">${i + 1}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-family:ui-monospace,Menlo,monospace"><b>${esc(it.number)}</b></td>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0">${esc(it.title || "—")}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-family:ui-monospace,Menlo,monospace">${esc(it.rev || "—")}</td>
    </tr>`).join("");

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;font-size:14px;max-width:640px">
  <div style="border-bottom:3px solid #ea580c;padding-bottom:10px;margin-bottom:16px">
    <div style="color:#ea580c;font-weight:800;font-size:12px;letter-spacing:.04em">TRANSMITTAL ${esc(t.number)}</div>
    <div style="font-size:18px;font-weight:800">${esc(t.subject || "Document Transmittal")}</div>
    ${t.purpose ? `<div style="display:inline-block;margin-top:6px;background:#fff7ed;border:1px solid #fed7aa;color:#c2410c;font-weight:800;font-size:11px;padding:3px 10px;border-radius:999px;text-transform:uppercase">${esc(t.purpose)}</div>` : ""}
  </div>
  <p>${esc(greeting)}</p>
  <p>You have been issued the following ${t.items?.length ?? 0} document(s):</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr>
      <th style="text-align:left;padding:6px 8px;background:#f8fafc;font-size:10px;text-transform:uppercase;color:#64748b">#</th>
      <th style="text-align:left;padding:6px 8px;background:#f8fafc;font-size:10px;text-transform:uppercase;color:#64748b">Number</th>
      <th style="text-align:left;padding:6px 8px;background:#f8fafc;font-size:10px;text-transform:uppercase;color:#64748b">Title</th>
      <th style="text-align:left;padding:6px 8px;background:#f8fafc;font-size:10px;text-transform:uppercase;color:#64748b">Rev</th>
    </tr></thead>
    <tbody>${docRowsHtml}</tbody>
  </table>
  ${t.notes?.trim() ? `<p style="background:#fafafa;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;color:#334155;white-space:pre-wrap">${esc(t.notes.trim())}</p>` : ""}
  <p style="margin:20px 0">
    <a href="${esc(portalUrl)}" style="background:#ea580c;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:8px;display:inline-block">Download &amp; acknowledge receipt</a>
  </p>
  <p style="color:#64748b;font-size:12px">Or open this link: <span style="font-family:ui-monospace,Menlo,monospace;word-break:break-all">${esc(portalUrl)}</span><br/>
  The link is unique to this transmittal — please don't forward it.</p>
  <p>— ${esc(from)}</p>
</div>`;

  return { subject, text, html };
}

/** TRX-10: what actually happened to the issue email — never inferred from
 *  the presence of a recipient address. */
export interface TransmittalEmailOutcome {
  sent: boolean;
  /** Why it was not sent (null when it was). */
  reason: string | null;
}

/**
 * Email the recipient their issued transmittal (portal link included). The
 * route queues it server-side and audits it. Failure to queue never fails the
 * issue itself — the transmittal IS issued; the email is delivery on top —
 * but the outcome says exactly what happened (TRX-10).
 */
export async function sendTransmittalEmail(t: Transmittal, _actor: TransmittalActor): Promise<TransmittalEmailOutcome> {
  // SURF-17: the email is queued SERVER-SIDE from the transmittal row
  // (/api/transmittal/send-email) — a browser can no longer address or author
  // external mail. The route decides who may send and audits it.
  const to = t.recipientEmail?.trim();
  if (!to) return { sent: false, reason: "no recipient email on the transmittal" };
  if (t.status === "voided") return { sent: false, reason: "the transmittal is voided" };
  if (!t.portalToken) return { sent: false, reason: "the transmittal has no portal link (the database predates 20260910)" };
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return { sent: false, reason: "not signed in" };
    const res = await fetch("/api/transmittal/send-email", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ transmittalId: t.id }),
    });
    const j = await res.json().catch(() => ({})) as { error?: string; sent?: boolean; reason?: string };
    if (!res.ok) {
      console.warn("[transmittals] email send refused:", j.error ?? res.status);
      return { sent: false, reason: j.error ?? `the email route answered ${res.status}` };
    }
    return j.sent === true ? { sent: true, reason: null } : { sent: false, reason: j.reason ?? "the email route did not queue it" };
  } catch (e) {
    console.warn("[transmittals] email send failed (the transmittal is still issued):", e);
    return { sent: false, reason: (e as Error)?.message || "the email could not be queued" };
  }
}

/** Render + open the cover sheet in a new window for print / save-as-PDF.
 *  Issued transmittals with a LIVE portal link get the link + QR embedded —
 *  the sheet and the electronic acknowledgment path are one artifact. A
 *  revoked, expired or voided link is never printed. */
export async function openTransmittalSheet(t: Transmittal): Promise<void> {
  let portalUrl: string | null = null;
  let qrDataUrl: string | null = null;
  if (t.portalToken && portalLinkState(t) === "live") {
    portalUrl = transmittalPortalUrl(t.portalToken);
    if (portalUrl) {
      try {
        const { toDataURL } = await import("qrcode");
        qrDataUrl = await toDataURL(portalUrl, { margin: 1, width: 184 });
      } catch { /* sheet still opens without the QR */ }
    }
  }
  openPrintWindow(renderTransmittalSheet(t, { portalUrl, qrDataUrl }));
}

// ─── Data layer (resilient to the table not being migrated yet) ─────────────

const MIGRATION_HINT =
  "Transmittals aren't set up yet — run supabase/migrations/20260717_transmittals.sql, then reload.";

function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42P01" || /relation .*transmittals.* does not exist/i.test(error.message ?? "");
}

function isMissingColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42703" || error.code === "PGRST204";
}

function toItem(it: Record<string, unknown>): TransmittalItem {
  const out: TransmittalItem = {
    documentId: String(it.documentId ?? it.document_id ?? ""),
    number: String(it.number ?? ""),
    title: (it.title as string) ?? null,
    rev: (it.rev as string) ?? null,
    versionId: (it.versionId as string) ?? (it.version_id as string) ?? null,
  };
  // The as-sent snapshot keys exist only on items issued after 20261133.
  if (typeof it.fileHash === "string" && it.fileHash) out.fileHash = it.fileHash;
  if (typeof it.fileSize === "number" && Number.isFinite(it.fileSize)) out.fileSize = it.fileSize;
  if (typeof it.statusAsSent === "string" && it.statusAsSent) out.statusAsSent = it.statusAsSent;
  if (typeof it.effectiveDate === "string" && it.effectiveDate) out.effectiveDate = it.effectiveDate;
  return out;
}

function toAckMeta(v: unknown): TransmittalAckMeta | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  const s = (k: string) => (typeof m[k] === "string" && m[k] ? (m[k] as string) : null);
  return { ip: s("ip"), userAgent: s("userAgent"), note: s("note"), recordedBy: s("recordedBy"), recordedByEmail: s("recordedByEmail") };
}

export function rowToTransmittal(r: Record<string, unknown>): Transmittal {
  const rawItems = r.items;
  const items: TransmittalItem[] = Array.isArray(rawItems)
    ? (rawItems as Array<Record<string, unknown>>).map(toItem)
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
    acknowledgedVia: (r.acknowledged_via as "portal" | "manual" | null) ?? null,
    acknowledgedMeta: toAckMeta(r.acknowledged_meta),
    portalToken: (r.portal_token as string) ?? null,
    portalExpiresAt: (r.portal_expires_at as string) ?? null,
    portalRevokedAt: (r.portal_revoked_at as string) ?? null,
    portalRevokedBy: (r.portal_revoked_by as string) ?? null,
    portalLastUsedAt: (r.portal_last_used_at as string) ?? null,
    portalOpenCount: r.portal_open_count === undefined || r.portal_open_count === null ? null : Number(r.portal_open_count) || 0,
    portalDownloadCount: r.portal_download_count === undefined || r.portal_download_count === null ? null : Number(r.portal_download_count) || 0,
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

/** TRX-14 / XEDGE-5: the external portal link, built on the deployment's
 *  CONFIGURED public origin (lib/publicOrigin.ts configuredPublicOrigin —
 *  NEXT_PUBLIC_SITE_URL, else Vercel's production domain; never the page's
 *  own host). Returns null when there is no configured origin — in a browser
 *  as on the server — so a caller refuses to email or print a hostless or
 *  preview-host link. The two runtimes build the same link only when
 *  NEXT_PUBLIC_SITE_URL is set or Vercel exposes the production domain to
 *  the browser; with exposure off the server can email a link this browser
 *  cannot build. */
export function transmittalPortalUrl(token: string): string | null {
  let origin = "";
  try { origin = configuredPublicOrigin(); } catch { origin = ""; }
  return origin ? `${origin}/transmittal/${token}` : null;
}

/** TRX-14 dw3: true when THIS runtime can name the public origin
 *  (NEXT_PUBLIC_SITE_URL, or Vercel's production domain). Without it this
 *  runtime builds no portal link, so the issue flow says so. */
export function portalOriginConfigured(): boolean {
  return !!configuredPublicOrigin();
}

/** Every transmittal that carries a given document — the "who did we send
 *  this to?" answer from the document's side. JSONB containment on items.
 *  TRX-9: a FAILED read throws (only a missing table answers "none"), so the
 *  Inspector can say the trail could not be read instead of showing nothing. */
export async function listTransmittalsForDocument(orgId: string, documentId: string): Promise<Transmittal[]> {
  const { data, error } = await supabase
    .from("transmittals")
    .select("*")
    .eq("org_id", orgId)
    .contains("items", JSON.stringify([{ documentId }]))
    .order("seq", { ascending: false })
    .limit(50);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(`Couldn't read the transmittal trail: ${error.message}`);
  }
  return (data ?? []).map((r) => rowToTransmittal(r as Record<string, unknown>));
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
}

/** Create a DRAFT. A transmittal is never born issued (TRX-1 — the INSERT
 *  policy admits drafts only); issue it with issueTransmittal. */
export async function createTransmittal(input: CreateTransmittalInput): Promise<Transmittal> {
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
        status: "draft",
        notes: input.notes?.trim() || null,
        items: input.items ?? [],
        created_by: input.actorUserId,
        created_by_name: input.actorName || null,
      })
      .select("*")
      .single();

    if (!error && data) {
      const t = rowToTransmittal(data as Record<string, unknown>);
      await logAuditAction({
        action: "TRANSMITTAL_CREATED",
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
  projectId?: string | null;
}

/** Edit a draft's fields. Throws when no draft row changed — it was issued
 *  meanwhile, or RLS refused the caller (TRX-7). */
export async function updateTransmittalDraft(id: string, patch: UpdateTransmittalDraftInput): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.subject !== undefined) row.subject = patch.subject?.trim() || null;
  if (patch.recipientName !== undefined) row.recipient_name = patch.recipientName?.trim() || null;
  if (patch.recipientCompany !== undefined) row.recipient_company = patch.recipientCompany?.trim() || null;
  if (patch.recipientEmail !== undefined) row.recipient_email = patch.recipientEmail?.trim() || null;
  if (patch.purpose !== undefined) row.purpose = patch.purpose || null;
  if (patch.notes !== undefined) row.notes = patch.notes?.trim() || null;
  if (patch.items !== undefined) row.items = patch.items;
  if (patch.projectId !== undefined) row.project_id = patch.projectId || null;
  const { data, error } = await supabase.from("transmittals").update(row).eq("id", id).eq("status", "draft").select("id");
  if (error) { if (isMissingTable(error)) throw new Error(MIGRATION_HINT); throw new Error(error.message); }
  if (!data || data.length === 0) {
    throw new Error("The draft was not saved — it is no longer a draft, or you can't edit it (its author, a Document Controller or a transmit authority can).");
  }
}

export interface TransmittalActor {
  orgId: string;
  actorUserId: string;
  actorName?: string;
  actorRole?: string;
}

/** TRX-3 / HLD-1: the app-side issue gate. Reads each item's document (and
 *  the revision label of its current file) and refuses a withdrawn,
 *  unreadable, file-less, superseded-pin or Rev-mismatched one, then asks
 *  the shared hold gate (lib/holdGate.ts — fail-closed) for every document.
 *  The database re-applies the rule at the issue transition (20261133);
 *  this copy names the document and the cause before the round-trip. */
export async function assertItemsIssuable(
  orgId: string,
  items: TransmittalItem[],
  client: HoldGateClient = supabase,
): Promise<void> {
  if (items.length === 0) throw new Error("Add at least one document before issuing.");
  const ids = [...new Set(items.map((i) => i.documentId).filter(Boolean))];
  const { data, error } = await client
    .from("documents")
    .select("id, status, archived_at, current_version_id, rev")
    .eq("org_id", orgId)
    .in("id", ids);
  if (error) throw new Error(`Couldn't check the documents before issuing: ${error.message}`);
  const docs = (data as Array<Record<string, unknown>> | null) ?? [];
  const byId = new Map(docs.map((d) => [String(d.id), d]));
  // The current files' labels: an unreadable label leaves the label checks to
  // the database (it refuses with the same cause at issue).
  const currentIds = [...new Set(docs.map((d) => d.current_version_id as string | null).filter((v): v is string => !!v))];
  const labelOf = new Map<string, string | null>();
  if (currentIds.length > 0) {
    const { data: vers, error: vErr } = await client
      .from("document_versions")
      .select("id, revision_label")
      .eq("org_id", orgId)
      .in("id", currentIds);
    if (!vErr) for (const v of (vers as Array<Record<string, unknown>> | null) ?? []) labelOf.set(String(v.id), (v.revision_label as string | null) ?? null);
  }
  for (const it of items) {
    const d = byId.get(it.documentId);
    const cur = d ? ((d.current_version_id as string) ?? null) : null;
    const blocker = itemIssueBlocker(it, d
      ? {
          found: true, status: (d.status as string) ?? null, archivedAt: (d.archived_at as string) ?? null,
          currentVersionId: cur, rev: (d.rev as string) ?? null,
          currentRevisionLabel: cur && labelOf.has(cur) ? labelOf.get(cur) : undefined,
          holds: [],
        }
      : { found: false });
    if (blocker) throw new Error(blocker);
  }
  for (const id of ids) await assertNotOnHold(id, { client, action: "issuing it on a transmittal" });
}

/** TRX-10: everything the issue flow needs to tell the person truthfully. */
export interface IssueOutcome {
  /** The row as the database left it — portal token, snapshot and all. */
  transmittal: Transmittal;
  email: TransmittalEmailOutcome;
  /** "missing" = issued without a recipient portal (pre-20260910 database). */
  portal: "ready" | "missing";
  /** A refused audit row leaves the issue standing; the caller says so. */
  auditError: string | null;
}

/** Move a draft → issued. The database authorizes it (transmit authority per
 *  item library), completes the item snapshot, stamps the issue time and
 *  mints the portal link; this returns the row it wrote (TRX-10) or throws
 *  when nothing was issued (TRX-7). */
export async function issueTransmittal(id: string, actor: TransmittalActor): Promise<IssueOutcome> {
  const draft = await getTransmittal(id);
  if (!draft) throw new Error("That transmittal no longer exists.");
  if (draft.status !== "draft") throw new Error(`${draft.number} is already ${draft.status}.`);
  await assertItemsIssuable(draft.orgId, draft.items);

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("transmittals")
    .update({ status: "issued", issued_at: now, updated_at: now })
    .eq("id", id)
    .eq("status", "draft")
    .select("*")
    .maybeSingle();
  if (error) { if (isMissingTable(error)) throw new Error(MIGRATION_HINT); throw new Error(error.message); }
  if (!data) {
    throw new Error(`${draft.number} was not issued — it is no longer a draft, or you do not hold transmit authority ("Issue transmittals") for every document on it.`);
  }
  const t = rowToTransmittal(data as Record<string, unknown>);
  const { error: auditError } = await logAuditAction({
    action: "TRANSMITTAL_ISSUED",
    resourceId: t.id,
    resourceType: "transmittal",
    orgId: actor.orgId,
    userId: actor.actorUserId,
    userEmail: actor.actorName,
    userRole: actor.actorRole,
    details: { number: t.number, purpose: t.purpose, recipient: t.recipientName || t.recipientCompany, documentCount: t.items.length },
  });
  const email = await sendTransmittalEmail(t, actor);
  return { transmittal: t, email, portal: t.portalToken ? "ready" : "missing", auditError };
}

/** Record recipient receipt on their behalf (issued → acknowledged) — e.g. a
 *  signed cover sheet came back. TRX-6: a member session never writes the
 *  receipt; the receipt route checks transmit authority and writes it with
 *  the service role, naming who recorded it. */
export async function acknowledgeTransmittal(id: string, acknowledgedByName: string, _actor: TransmittalActor, note?: string): Promise<{ acknowledgedAt: string | null }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not signed in");
  const res = await fetch("/api/transmittal/receipt", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ transmittalId: id, name: acknowledgedByName, note: note ?? null }),
  });
  const j = await res.json().catch(() => ({})) as { error?: string; acknowledgedAt?: string };
  if (!res.ok) throw new Error(j.error || `The receipt could not be recorded (${res.status}).`);
  return { acknowledgedAt: j.acknowledgedAt ?? null };
}

/** Void an issued transmittal (it was sent in error). Drafts are deleted, not
 *  voided (TRX-2). Throws when nothing was voided (TRX-7). */
export async function voidTransmittal(id: string, actor: TransmittalActor): Promise<{ auditError: string | null }> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("transmittals")
    .update({ status: "voided", updated_at: now })
    .eq("id", id)
    .in("status", ["issued", "acknowledged"])
    .select("id");
  if (error) { if (isMissingTable(error)) throw new Error(MIGRATION_HINT); throw new Error(error.message); }
  if (!data || data.length === 0) {
    throw new Error("The transmittal was not voided — only an issued transmittal can be voided, by a transmit authority.");
  }
  const { error: auditError } = await logAuditAction({
    action: "TRANSMITTAL_VOIDED",
    resourceId: id,
    resourceType: "transmittal",
    orgId: actor.orgId,
    userId: actor.actorUserId,
    userEmail: actor.actorName,
    userRole: actor.actorRole,
  });
  return { auditError };
}

/** TRX-4: cut off the portal link WITHOUT repudiating the record. The
 *  transmittal stays issued (or acknowledged); the link answers 410 revoked
 *  from now on. A revocation is durable — the database never clears it. */
export async function revokeTransmittalLink(id: string, actor: TransmittalActor): Promise<{ auditError: string | null }> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("transmittals")
    .update({ portal_revoked_at: now, updated_at: now })
    .eq("id", id)
    .in("status", ["issued", "acknowledged"])
    .is("portal_revoked_at", null)
    .select("id");
  if (error) {
    if (isMissingTable(error)) throw new Error(MIGRATION_HINT);
    if (isMissingColumn(error)) throw new Error("Revoking a portal link needs supabase/migrations/20261133_dc_roundF_transmittal_rails.sql applied.");
    throw new Error(error.message);
  }
  if (!data || data.length === 0) {
    throw new Error("The link was not revoked — it is already revoked, the transmittal is not issued, or you do not hold transmit authority.");
  }
  const { error: auditError } = await logAuditAction({
    action: "TRANSMITTAL_LINK_REVOKED",
    resourceId: id,
    resourceType: "transmittal",
    orgId: actor.orgId,
    userId: actor.actorUserId,
    userEmail: actor.actorName,
    userRole: actor.actorRole,
  });
  return { auditError };
}

/** Delete a draft (never an issued record — those are voided for audit).
 *  Throws when nothing was deleted (TRX-7). */
export async function deleteTransmittal(id: string): Promise<void> {
  const { data, error } = await supabase.from("transmittals").delete().eq("id", id).eq("status", "draft").select("id");
  if (error) { if (isMissingTable(error)) throw new Error(MIGRATION_HINT); throw new Error(error.message); }
  if (!data || data.length === 0) {
    throw new Error("The draft was not deleted — it is no longer a draft, or you can't delete it (its author can; otherwise a Document Controller who is also an Admin or Manager, or who manages the draft's project).");
  }
}

// ─── Server-side authority (route handlers) ─────────────────────────────────

export interface TransmitAuthority {
  allowed: boolean;
  member: { role: string | null; roles: string[]; email: string | null } | null;
  /** Why the decision could not be made (fail closed), when it couldn't. */
  error?: string;
}

/** TRX-1: the transmit-authority decision for a route handler, made with the
 *  route's (service-role) client: an ACTIVE member of the org, holding
 *  `transmittal.issue` for every item's library. The policy read is the
 *  strict one — a policy that cannot be read DENIES. */
export async function evaluateTransmitAuthority(
  client: Pick<typeof supabase, "from">,
  input: { orgId: string; uid: string; items: TransmittalItem[] },
): Promise<TransmitAuthority> {
  const { data: m, error: mErr } = await client
    .from("org_members").select("role, roles, email")
    .eq("org_id", input.orgId).eq("uid", input.uid).eq("status", "active").maybeSingle();
  if (mErr) return { allowed: false, member: null, error: `Couldn't read your membership: ${mErr.message}` };
  if (!m) return { allowed: false, member: null };
  const member = {
    role: ((m as Record<string, unknown>).role as string | null) ?? null,
    roles: (((m as Record<string, unknown>).roles as string[] | null) ?? []),
    email: ((m as Record<string, unknown>).email as string | null) ?? null,
  };
  const loaded = await loadCapabilityPolicyStrict(input.orgId, client);
  if (!loaded.ok) return { allowed: false, member, error: `Couldn't read the capability policy: ${loaded.error}` };
  const ids = [...new Set(input.items.map((i) => i.documentId).filter(Boolean))];
  let libs: Array<string | null> = [];
  if (ids.length > 0) {
    const { data: docs, error: dErr } = await client.from("documents").select("id, library_id").eq("org_id", input.orgId).in("id", ids);
    if (dErr) return { allowed: false, member, error: `Couldn't read the documents' libraries: ${dErr.message}` };
    const libOf = new Map(((docs as Array<Record<string, unknown>> | null) ?? []).map((d) => [String(d.id), (d.library_id as string | null) ?? null]));
    libs = ids.map((id) => libOf.get(id) ?? null);
  }
  return { allowed: mayTransmit(loaded.policy, { role: member.role, roles: member.roles, uid: input.uid }, libs), member };
}
