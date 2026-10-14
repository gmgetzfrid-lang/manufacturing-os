// POST /api/tickets/copy
//   { ticketId, attachmentId, channel: "print" | "download",
//     acknowledged?: boolean, acceptUnstamped?: boolean }
//
// drafting-flow EVID-16 (DF-P12): a drafting-ticket file copy is STAMPED and
// RECORDED in the server request that issues its bytes. Until this route the
// ticket page fetched the file from a presigned URL, stamped it in the
// browser and only then recorded it from the same browser session — a
// modified client, or a direct fetch of the presigned URL, took the file with
// no distribution row and no audit row. Here, in one request:
//
//   1. the caller is an active member of the ticket's workspace who may read
//      the ticket (the Contractor-only read scope, lib/ticketReadScope.ts —
//      answered as "not found" otherwise); an archived stub has no file;
//   2. the file is THIS ticket's (one attachment with that id) and stored
//      under the ticket's own prefix (orgs/<org>/tickets/<number>/ — what
//      uploadTicketAttachment mints and the workflow route vets) or, for a
//      file the requester attached at creation whose re-key under that
//      prefix never ran (app/api/tickets/create/route.ts step 7: such files
//      "stay at their staged keys (the row names them there)"), at the
//      requester's own staged key (lib/ticketCreate.ts isStagedKeyOf for the
//      ticket's org and requester — the row naming it is workflow-owned); a
//      legacy absolute URL is refused (this route never fetches a URL a row
//      names);
//   3. the copy's plan is the page's own (lib/ticketDeliverableCopy.ts
//      ticketCopyPlan): the FILE's revision and id on the QR (PHYS-2,
//      SM-5 done-when 3), one control state for both marks (PHYS-9), the
//      footer that says what the server knows of the file against the ticket
//      NOW — read here, with 20261221's history trust index when it exists. A
//      file the plan would confirm first (superseded, withdrawn, a newer
//      revision in progress) answers 409 `confirm` with the question, and is
//      issued only on a retry carrying acknowledged: true;
//   4. the bytes come bucket → server and are stamped server-side
//      (applyStampToPdfDoc, the blind title-block-aware placement — SHR-8, as
//      /api/share/file stamps). A file that cannot be stamped answers 422
//      `unstampable` and is issued UNSTAMPED only on a retry carrying
//      acceptUnstamped: true (the page's "print the unstamped copy anyway?");
//   5. the distribution row (download_audits — the caller's own pull, naming
//      the ticket and the file since 20261223) and the audit row naming the
//      file (audit_logs DOWNLOAD on the ticket) are written BEFORE a byte
//      leaves (lib/ticketDeliverableCopy.ts recordTicketCopy, as the service
//      role). Either refused → 503 `unrecorded` and nothing is issued: a copy
//      does not leave unrecorded (DEC-44; /api/share/file's rule). Before
//      20261223 / 20261068 the row is written in the shape the table has.
//
// The verify QR's origin is the configured public origin, else the request's
// own origin when an outside reader can open its host (never a *.vercel.app
// deployment host or loopback — /api/share/file's rule); with neither the
// copy carries no QR and its footer no scan instruction (DEC-64 §2).
//
// The ticket page still prints and downloads through the browser path until
// its FileViewerModal is wired here (the page is owned by drafting-flow DF-P9
// in this round — EVID-16's Partial names the hunk).

import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { PDFDocument } from "pdf-lib";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { r2, R2_BUCKET } from "@/lib/r2";
import { isSafeStorageKey } from "@/lib/storageKey";
import { applyStampToPdfDoc } from "@/lib/stamping";
import { configuredPublicOrigin, isUnreachableRecipientHost } from "@/lib/publicOrigin";
import { ticketReadScope } from "@/lib/ticketReadScope";
import { ticketCopyPlan, recordTicketCopy, type TicketCopyChannel } from "@/lib/ticketDeliverableCopy";
import { TICKET_ATTACHMENT_ID_RE } from "@/lib/verifyTicketVerdict";
import { isStagedKeyOf } from "@/lib/ticketCreate";
import type { TicketAttachment } from "@/types/schema";

export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKET_COLUMNS = "id, org_id, ticket_id, status, deliverable_rev, history, revision_count, attachments, archived_at, requester_id, assigned_drafter_id, assigned_engineer_id, watchers";
const GUARD_COLUMN = "history_guarded_from";

interface Body {
  ticketId?: unknown;
  attachmentId?: unknown;
  channel?: unknown;
  acknowledged?: unknown;
  acceptUnstamped?: unknown;
}

type TicketRow = {
  id: string; org_id: string; ticket_id: string | null; status: string | null; deliverable_rev: string | null;
  history: unknown; revision_count: number | null; attachments: unknown; archived_at: string | null;
  requester_id: string | null; assigned_drafter_id: string | null; assigned_engineer_id: string | null; watchers: string[] | null;
  history_guarded_from?: number | null;
};

const json = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** The 20261221 column is absent (42703 / PGRST204 naming it): read as before. */
function isMissingGuardColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = error.message ?? "";
  return (error.code === "42703" || error.code === "PGRST204" || /does not exist|schema cache/i.test(msg)) && msg.includes(GUARD_COLUMN);
}

/** /api/share/file's origin rule (SHR-11, DEC-64 §1): configured, else the
 *  request's own when an outside reader can open its host, else "" (no QR). */
function verifyOrigin(req: NextRequest): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  let url: URL;
  try { url = new URL(req.nextUrl.origin); } catch { return ""; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  return isUnreachableRecipientHost(url.hostname) ? "" : url.origin;
}

const isPdfBytes = (b: Uint8Array) => b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d; // %PDF-

/** The audit writer recordTicketCopy is given: one checked insert as the service role. */
async function serverAudit(entry: {
  action: string; resourceId: string; resourceType: string; orgId?: string;
  userId: string; userEmail?: string; userRole?: string; details?: Record<string, unknown>;
}): Promise<{ ok: boolean; error: string | null }> {
  try {
    const { error } = await supabaseAdmin.from("audit_logs").insert({
      action: entry.action,
      resource_id: entry.resourceId,
      resource_type: entry.resourceType,
      org_id: entry.orgId ?? null,
      user_id: entry.userId,
      user_email: entry.userEmail ?? null,
      user_role: entry.userRole ?? null,
      details: entry.details ?? null,
    });
    return error ? { ok: false, error: error.message || "audit insert refused" } : { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !caller) return json({ error: "Unauthorized" }, 401);

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json({ error: "Invalid JSON body" }, 400); }
  const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
  const attachmentId = typeof body.attachmentId === "string" ? body.attachmentId : "";
  const channel = body.channel === "print" || body.channel === "download" ? (body.channel as TicketCopyChannel) : null;
  if (!UUID_RE.test(ticketId) || !TICKET_ATTACHMENT_ID_RE.test(attachmentId) || !channel) {
    return json({ error: "ticketId, attachmentId and channel (print | download) are required" }, 400);
  }

  // 1. The ticket, as the service role (RLS does not apply; the checks below do).
  const read = (withGuard: boolean) => supabaseAdmin
    .from("tickets")
    .select(withGuard ? `${TICKET_COLUMNS}, ${GUARD_COLUMN}` : TICKET_COLUMNS)
    .eq("id", ticketId)
    .maybeSingle();
  let { data: row, error: rowErr } = await read(true);
  if (rowErr && isMissingGuardColumn(rowErr)) ({ data: row, error: rowErr } = await read(false));
  if (rowErr) return json({ error: "The request could not be read right now — try again in a moment" }, 503);
  if (!row) return json({ error: "Request not found" }, 404);
  const t = row as unknown as TicketRow;

  const { data: member, error: memberErr } = await supabaseAdmin
    .from("org_members")
    .select("uid, role, roles, email")
    .eq("org_id", t.org_id)
    .eq("uid", caller.id)
    .eq("status", "active")
    .maybeSingle();
  if (memberErr) return json({ error: "Couldn't confirm your membership of this workspace — try again in a moment" }, 503);
  if (!member) return json({ error: "Request not found" }, 404);
  const scope = await ticketReadScope(supabaseAdmin, member, caller.id, {
    id: t.id, requesterId: t.requester_id, assignedDrafterId: t.assigned_drafter_id,
    assignedEngineerId: t.assigned_engineer_id, watchers: t.watchers,
  });
  if (scope === "unknown") return json({ error: "Couldn't confirm you can see this request — try again in a moment" }, 503);
  if (scope === "out") return json({ error: "Request not found" }, 404);
  if (t.archived_at) {
    return json({ error: "archived", message: "This request is archived: its files are in its archive. Restore it before taking a copy." }, 409);
  }

  // 2. The file: this ticket's, once, under the ticket's own prefix.
  const files = (Array.isArray(t.attachments) ? t.attachments : []) as TicketAttachment[];
  const named = files.filter((a) => a && a.id === attachmentId);
  if (named.length !== 1) return json({ error: "That file is not on this request" }, 404);
  const file = named[0];
  const key = typeof file.url === "string" ? file.url : "";
  if (/^https?:\/\//i.test(key)) {
    return json({ error: "legacy_file", message: "This file was recorded before files were stored by path, so the server cannot issue a copy of it. Ask Document Control to re-attach it." }, 409);
  }
  const prefix = `orgs/${t.org_id}/tickets/${t.ticket_id ?? ""}/`;
  const underTicket = key.startsWith(prefix) && key.length > prefix.length;
  // A creation-time file whose re-key never ran stays at the requester's staged key.
  const staged = !!t.requester_id && isStagedKeyOf(key, t.org_id, t.requester_id);
  if (!key || !t.ticket_id || !isSafeStorageKey(key) || !(underTicket || staged)) {
    return json({ error: "That file is not stored under this request" }, 409);
  }

  // 3. What the copy says — the page's plan, with the ticket as it stands now.
  const plan = ticketCopyPlan({
    file,
    ticketNumber: t.ticket_id,
    ticketRowId: t.id,
    origin: verifyOrigin(req),
    channel,
    live: {
      status: t.status, deliverableRev: t.deliverable_rev, history: t.history,
      revisionCount: t.revision_count, historyGuardedFrom: t.history_guarded_from ?? null,
    },
  });
  if (plan.confirmMessage && body.acknowledged !== true) {
    return json({ error: "confirm", message: plan.confirmMessage, standing: plan.standing }, 409);
  }

  // 4. The bytes, bucket → server, stamped here.
  let source: Uint8Array;
  try {
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const bytes = await obj.Body?.transformToByteArray();
    if (!bytes) throw new Error("empty object body");
    source = bytes;
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number }; message?: string };
    if (err?.name === "NoSuchKey" || err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
      return json({ error: "That file is not in storage" }, 404);
    }
    console.error(`[tickets/copy] could not read ${key} from storage:`, err?.message ?? e);
    return json({ error: "The file could not be read from storage right now — try again in a moment" }, 502);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + (file.type === "Draft" ? 72 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000));
  const email = caller.email ?? (member as { email?: string | null }).email ?? null;
  let out: Uint8Array = source;
  let stamped = false;
  let stampProblem: string | null = isPdfBytes(source) ? null : "the file is not a PDF";
  if (!stampProblem) {
    try {
      const pdfDoc = await PDFDocument.load(source);
      await applyStampToPdfDoc(pdfDoc, {
        userLabel: email?.split("@")[0] || caller.id,
        email: email ?? undefined,
        timestamp: now,
        expiresAt,
        controlState: plan.controlState,
        verifyUrl: plan.verifyUrl,
        footerNotice: plan.footerNotice,
      });
      out = await pdfDoc.save();
      stamped = true;
    } catch (e) {
      stampProblem = (e as Error)?.message || "the stamp could not be applied";
    }
  }
  if (!stamped && body.acceptUnstamped !== true) {
    return json({
      error: "unstampable",
      message: `The watermark / QR stamp could not be applied to this file (${stampProblem}). Take the UNSTAMPED copy anyway? It will be recorded as unstamped — treat it as uncontrolled and do not distribute it.`,
    }, 422);
  }

  // 5. The record, BEFORE a byte leaves. Refused → nothing is issued.
  const roles = (member as { role?: string | null }).role ?? null;
  const rec = await recordTicketCopy(supabaseAdmin, serverAudit, {
    orgId: t.org_id,
    userId: caller.id,
    userEmail: email,
    userRole: roles,
    ticketRowId: t.id,
    ticketNumber: t.ticket_id,
    file,
    channel,
    stamped,
    watermark: stamped ? plan.watermark : null,
    expiresAt,
  });
  if (!rec.recorded) {
    console.error(`[tickets/copy] the copy of ${attachmentId} on ${t.id} was NOT issued — its record was refused: ${rec.error}`);
    return json({ error: "unrecorded", message: `This copy was not issued: ${rec.error}. Try again in a moment, or tell Document Control.` }, 503);
  }

  const safe = (s: string) => s.replace(/[^\w.\-]+/g, "_");
  const base = safe(file.name || "ticket-file").replace(/\.pdf$/i, "");
  const filename = stamped ? `${base}${plan.rev ? `_Rev${safe(plan.rev)}` : ""}.pdf` : safe(file.name || "ticket-file");
  return new NextResponse(Buffer.from(out), {
    headers: {
      "Content-Type": stamped || isPdfBytes(source) ? "application/pdf" : "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Ticket-Copy-Stamped": stamped ? "1" : "0",
      "X-Ticket-Copy-Rev": plan.rev ?? "",
    },
  });
}
