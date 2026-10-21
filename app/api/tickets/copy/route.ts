// POST /api/tickets/copy
//   { ticketId, attachmentId, channel: "print" | "download" | "view",
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
// drafting-flow EVID-16 done-when 2 (DF-P15): the ticket page's print,
// download and inline PDF preview now go through this route (its
// FileViewerModal, lib/ticketCopyRequest.ts). The preview is channel "view":
// the same doors, plan and server stamp, served inline, and recorded as a
// VIEW row on the ticket's audit trail naming the file (as the secure viewer
// records a document view) — not as a distribution copy, so the stale-copy
// recall does not count a viewer as a holder. A view that cannot be recorded
// is not served (503 `unrecorded`), as a copy is not. Its stamp reads as a
// download's (the bytes did reach the browser). A file the server cannot
// issue (a legacy absolute URL, a key outside the ticket's storage) keeps the
// page's browser path, which says so.
//
// Size (DF-P15 fix — the transmittal portal's TRX-5 rule): the response is a
// STREAMED body handed out in 1 MiB chunks, never one buffered body — the
// platform caps a buffered function response at ~4.5 MB
// (app/api/transmittal/route.ts, app/api/admin/restore/begin/route.ts), and a
// multi-sheet drawing PDF is routinely larger. A file up to
// COPY_STAMP_MAX_BYTES is held once in memory, stamped (a PDF) and streamed.
// A larger one is never held whole: its byte stream is OPENED (its first
// bytes read, which say whether it is a PDF) before anything is recorded, so
// a storage failure records nothing; it is then issued UNSTAMPED through the
// same 422 `unstampable` question as any file the stamp cannot take, and its
// record carries the reason (`unstampedReason`), as every unstamped copy's
// does. A non-PDF is served as application/octet-stream (never a stored
// content type). The 422 for an oversize PDF carries `reason: "oversize"`
// (DF-P15 fix, on review): the ticket page answers it by stamping the file in
// the tab and recording from the tab — what it did for such a file before
// DF-P15 — so a print or download of a large drawing keeps its marks there;
// the unstamped issue here stays for a caller that asks for it.
//
// A preview is a PDF preview (DF-P15 fix, on review): channel "view" is
// refused (400 `not_previewable`, nothing recorded, nothing issued) for a file
// that is not a PDF or is over the stamping bound — a file the server cannot
// stamp by construction. A view writes a VIEW audit row, never a distribution
// row, and the stale-copy recall reads distribution rows only, so a view must
// not be a way to take the raw bytes of a file the stamp cannot mark. The
// page previews only PDFs; for anything refused here it keeps its presigned
// inline frame, as before DF-P15.

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

export const runtime = "nodejs";
// The copy is streamed through the function, so the function lives while the
// browser drains it (the transmittal portal's budget for the same transfer).
export const maxDuration = 300;

/** Above this the server does not stamp (and never holds the file whole):
 *  pdf-lib keeps the parsed document and writes a second copy. The
 *  transmittal portal's bound (PORTAL_STAMP_MAX_BYTES). */
const COPY_STAMP_MAX_BYTES = 64 * 1024 * 1024;
/** The streamed body's chunk size. */
const STREAM_CHUNK_BYTES = 1024 * 1024;

/** A streamed body over bytes already in memory — handed out a chunk at a
 *  time, so the response is never one buffered body. */
function chunkedStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = Math.min(offset + STREAM_CHUNK_BYTES, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

/** Open a storage byte stream: read its first chunk (it says whether the
 *  file is a PDF) and hand back a stream that replays it, then the rest. */
async function openPeeked(stream: ReadableStream<Uint8Array>): Promise<{ head: Uint8Array; body: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const first = await reader.read();
  const head = first.done || !first.value ? new Uint8Array(0) : first.value;
  let replayed = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!replayed) {
        replayed = true;
        if (first.done) { controller.close(); return; }
        controller.enqueue(head);
        return;
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { head, body };
}

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
  // EVID-16 dw2 (DF-P15): "view" — the page's inline preview — is planned and
  // stamped as a download, served inline, and recorded as a VIEW (below).
  const view = body.channel === "view";
  const channel = body.channel === "print" || body.channel === "download" ? (body.channel as TicketCopyChannel) : view ? "download" : null;
  if (!UUID_RE.test(ticketId) || !TICKET_ATTACHMENT_ID_RE.test(attachmentId) || !channel) {
    return json({ error: "ticketId, attachmentId and channel (print | download | view) are required" }, 400);
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

  // 4. The bytes, bucket → server, stamped here. A file over the stamping
  // bound is never held whole: its stream is opened (first bytes read) here,
  // BEFORE the record, and piped through after it (see the header).
  let source: Uint8Array | null = null;
  let piped: ReadableStream<Uint8Array> | null = null;
  let head: Uint8Array;
  let size: number | null = null;
  try {
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    if (!obj.Body) throw new Error("empty object body");
    size = typeof obj.ContentLength === "number" ? obj.ContentLength : null;
    if (size !== null && size > COPY_STAMP_MAX_BYTES) {
      const body = obj.Body as { transformToWebStream?: () => ReadableStream<Uint8Array> };
      const stream = body.transformToWebStream?.();
      if (!stream) throw new Error("no streamable body");
      ({ head, body: piped } = await openPeeked(stream));
    } else {
      const bytes = await obj.Body.transformToByteArray();
      if (!bytes) throw new Error("empty object body");
      source = bytes;
      head = bytes;
    }
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
  const sourceIsPdf = isPdfBytes(head);
  if (view && (!sourceIsPdf || piped)) {
    // A preview is a stamped PDF preview (see the header): never the raw bytes
    // of a file the server cannot stamp by construction.
    await piped?.cancel().catch(() => {});
    return json({
      error: "not_previewable",
      message: !sourceIsPdf
        ? "the server previews only a PDF it can stamp, and this file is not a PDF"
        : `the server previews only a PDF it can stamp, and this file is over the ${COPY_STAMP_MAX_BYTES / (1024 * 1024)} MB it stamps`,
    }, 400);
  }
  let out: Uint8Array | null = source;
  let stamped = false;
  let stampProblem: string | null = !sourceIsPdf
    ? "the file is not a PDF"
    : piped
      ? `the file is ${Math.ceil((size ?? 0) / (1024 * 1024))} MB, over the ${COPY_STAMP_MAX_BYTES / (1024 * 1024)} MB the server stamps`
      : null;
  if (!stampProblem && source) {
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
    await piped?.cancel().catch(() => {});
    return json({
      error: "unstampable",
      // DF-P15 fix (review): an OVERSIZE PDF is marked apart from a stamp
      // that failed — the page's browser path stamps such a file in the tab
      // (as it did before DF-P15), so the page takes that path rather than
      // asking for the unstamped copy (lib/ticketCopyRequest.ts).
      ...(piped && sourceIsPdf ? { reason: "oversize" } : {}),
      message: `The watermark / QR stamp could not be applied to this file (${stampProblem}). Take the UNSTAMPED copy anyway? It will be recorded as unstamped — treat it as uncontrolled and do not distribute it.`,
    }, 422);
  }

  // 5. The record, BEFORE a byte leaves. Refused → nothing is issued.
  const roles = (member as { role?: string | null }).role ?? null;
  // An unstamped copy's record says why it left unstamped (an oversize file
  // included — the transmittal portal records the same reason).
  const unstampedReason = stamped ? null : stampProblem;
  const audit: typeof serverAudit = unstampedReason
    ? (entry) => serverAudit({ ...entry, details: { ...(entry.details ?? {}), unstampedReason } })
    : serverAudit;
  // EVID-16 dw2 (DF-P15): a preview is a VIEW of the file on the ticket's
  // audit trail — no distribution row (a viewer is not a copy holder).
  const rec = view
    ? await serverAudit({
        action: "VIEW",
        resourceId: t.id,
        resourceType: "ticket",
        orgId: t.org_id,
        userId: caller.id,
        userEmail: email ?? undefined,
        userRole: roles ?? undefined,
        details: {
          channel: "view",
          ticketNumber: t.ticket_id,
          attachmentId: file.id,
          attachmentType: file.type,
          fileName: file.name,
          rev: typeof file.rev === "string" ? file.rev : null,
          watermark: stamped ? plan.watermark : "UNSTAMPED (stamping failed)",
          ...(unstampedReason ? { unstampedReason } : {}),
        },
      }).then((a) => (a.ok ? { recorded: true, error: null } : { recorded: false, error: `the audit trail refused it (${a.error || "no reason given"})` }))
    : await recordTicketCopy(supabaseAdmin, audit, {
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
    await piped?.cancel().catch(() => {});
    console.error(`[tickets/copy] the copy of ${attachmentId} on ${t.id} was NOT issued — its record was refused: ${rec.error}`);
    return json({ error: "unrecorded", message: `${view ? "This preview was not served" : "This copy was not issued"}: ${rec.error}. Try again in a moment, or tell Document Control.` }, 503);
  }

  const safe = (s: string) => s.replace(/[^\w.\-]+/g, "_");
  const base = safe(file.name || "ticket-file").replace(/\.pdf$/i, "");
  const filename = stamped ? `${base}${plan.rev ? `_Rev${safe(plan.rev)}` : ""}.pdf` : safe(file.name || "ticket-file");
  // A streamed body either way — never one buffered response (see the header).
  return new NextResponse(piped ?? chunkedStream(out ?? new Uint8Array()), {
    headers: {
      "Content-Type": stamped || sourceIsPdf ? "application/pdf" : "application/octet-stream",
      "Content-Disposition": `${view ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Ticket-Copy-Stamped": stamped ? "1" : "0",
      "X-Ticket-Copy-Rev": plan.rev ?? "",
    },
  });
}
