// /api/transmittal — the external side of a transmittal's portal link.
// Token possession is the whole credential (same contract as the project
// intake portal): the recipient has no account, sees ONLY this one
// transmittal, can download ONLY the files listed on it (at their as-sent
// revisions), and can acknowledge receipt once. Voided transmittals, and
// revoked or expired LINKS (TRX-4 — the link has its own lifecycle, so access
// is cut without repudiating the record), answer with their state; nothing
// else in the org is reachable.
//
//   GET  ?token=…                → the transmittal snapshot (no file URLs)
//   GET  ?token=…&file=<docId>   → the file's bytes, streamed and stamped HERE
//   POST { token, name, note? }  → recipient-side acknowledgment
//
// TRX-5 / EGR-8: the file is never a presigned bucket URL. The bytes are
// pulled bucket → server, verified against the hash the database recorded at
// issue (TRX-8), and — when they are a PDF — stamped UNCONTROLLED with the
// as-issued revision and transmittal number in the footer and a /verify QR
// bound to the exact version served (the /api/share/file treatment for the
// same audience). A file that cannot be stamped still goes out through this
// route, recorded as unstamped with the reason (DEC-61 §5) — a file that is
// not a PDF, a PDF over the stamping bound, or one pdf-lib cannot load or
// stamp (encrypted — owner-password / permission-restricted vendor PDFs
// included — or malformed).
//
// TRX-15 (document-control P8 FIELD): when a PDF leaves UNSTAMPED the issuer
// is TOLD — a bell and an email, once per transmittal and document — so an
// unmarked copy in an outside party's hands is never a silent one. The
// stricter rule, "a PDF goes out stamped or not at all" (422 "unstampable",
// on the issuer's trail as TRANSMITTAL_PORTAL_UNSTAMPABLE_REFUSED), is
// SEQUENCED behind the issue-time stampability check (TRX-16, P7 /
// lib/transmittals.ts): it binds only an item that check recorded as
// stampable at issue (`stampable: true` on the item), so a transmittal
// already issued and live is never refused at download for a file nobody
// checked when it was issued. Until TRX-16 lands no item carries the mark
// and §5 holds for every item; the rule change itself awaits the user's
// ratification of a §5 amendment (DEC-61 landed note).
//
// Size: the response is a STREAMED body handed out in 1 MiB chunks, never one
// buffered body — the platform caps a buffered function response at ~4.5 MB
// (app/api/admin/restore/begin/route.ts), and a multi-sheet drawing set is
// routinely larger. A file up to PORTAL_STAMP_MAX_BYTES is held once in
// memory, verified, stamped (a PDF) and streamed. A larger one is never held
// whole: for an item armed for refusal (above) its first bytes say whether
// it is a PDF (refused without reading the rest); anything else is hashed
// chunk by chunk, and only when the digest matches is a second read — pinned
// to the verified object by If-Match on its ETag, so the bytes cannot change
// between the check and the send — piped through to the recipient, unstamped
// and recorded so (`oversize` for a PDF, `not_pdf` otherwise).
//
// TRX-15: the portal page saves a file by navigating a hidden frame here with
// `&nav=1`, so the browser streams the attachment straight to disk and the
// page never holds it in memory; in that mode a refusal is plain text (it
// renders inside the frame, where the page reads it back).
//
// TRX-9: every portal pull is a download_audits row BEFORE the bytes leave —
// user_id NULL, transmittal_id set, the served version_id, source
// "transmittal_portal" (DEC-44 §1) — so stale-copy recall sees the external
// holder. A refused write refuses the download (503 unrecorded); a refusal
// that IS the unapplied 20261068 is retried once in the table's older shape,
// attributed to the issuer, exactly as /api/share/file degrades.

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { PDFDocument } from "pdf-lib";
import { applyStampToPdfDoc } from "@/lib/stamping";
import { publicOrigin } from "@/lib/publicOrigin";
import { portalKeyAllowed, portalRowRefusal } from "@/lib/transmittals";
import { effectiveStatusFor } from "@/lib/effectiveDate";
import { isPdfFile } from "@/lib/verifyVerdict";
import { notifyChecked, notifyWithReason } from "@/lib/inAppNotifications";

export const runtime = "nodejs";
// The download is streamed through the function, so the function lives while
// the recipient's connection drains it (the same budget the repo's other
// long transfers take).
export const maxDuration = 300;

/** Above this the portal does not stamp (and never holds the file whole):
 *  pdf-lib keeps the parsed document and writes a second copy, and a drawing
 *  set beyond this would spend the function's memory and time stamping
 *  instead of delivering. Stated bound (DEC-61 §5): a file above it is
 *  verified and piped through unstamped, recorded so — a PDF among them
 *  with the issuer told (TRX-15) — unless the item is armed for refusal
 *  (`refusesUnstampable`), when a PDF above it is refused. */
const PORTAL_STAMP_MAX_BYTES = 64 * 1024 * 1024;
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

const looksLikePdf = (b: Uint8Array) => b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

/** SHA-256 of an object body read chunk by chunk (constant memory), plus its
 *  first bytes (to tell a PDF from anything else). TRX-15: with `stopIfPdf`
 *  (an item armed for refusal) the read stops — and the body is released —
 *  as soon as the first bytes say PDF (`stoppedAtPdf`; the digest is then
 *  meaningless): such a PDF over the bound is refused, so the rest of it is
 *  never read. */
async function hashBody(body: unknown, opts?: { stopIfPdf?: boolean }): Promise<{ sha256: string; head: Uint8Array; stoppedAtPdf: boolean }> {
  const h = createHash("sha256");
  let head = new Uint8Array();
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    if (head.length < 4) {
      const take = chunk.subarray(0, 4 - head.length);
      const next = new Uint8Array(head.length + take.length);
      next.set(head);
      next.set(take, head.length);
      head = next;
      if (opts?.stopIfPdf && looksLikePdf(head)) {
        try { (body as { destroy?: () => void }).destroy?.(); } catch { /* already closed */ }
        return { sha256: "", head, stoppedAtPdf: true };
      }
    }
    h.update(chunk);
  }
  return { sha256: h.digest("hex"), head, stoppedAtPdf: false };
}

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

/** A GET refusal. TRX-15: in the portal page's frame-navigation mode
 *  (`&nav=1` on a file request) it is plain text — it renders inside a hidden
 *  frame, never a browser JSON viewer — and carries the status, so the page
 *  can read it back; otherwise the JSON answer every caller already reads. */
function portalRefusal(nav: boolean, body: Record<string, unknown>, status: number): NextResponse {
  if (!nav) return NextResponse.json(body, { status });
  return new NextResponse(JSON.stringify({ ...body, status }), {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function loadByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  const { data } = await supabaseAdmin
    .from("transmittals")
    .select("*")
    .eq("portal_token", token)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

type Item = {
  documentId?: string; number?: string; title?: string | null; rev?: string | null;
  versionId?: string | null; version_id?: string | null;
  fileHash?: string | null; fileSize?: number | null; statusAsSent?: string | null; effectiveDate?: string | null;
  /** TRX-16: the issue-time stampability check's verdict on this item's PDF
   *  (true = it loaded and stamped at issue). Absent on every item issued
   *  before that check exists. */
  stampable?: boolean | null;
};

/** TRX-15 / TRX-16: whether "a PDF goes out stamped or not at all" binds
 *  this item — only when the issue-time check recorded it stampable, so the
 *  issuer was told at issue, not by the recipient's refusal. Every other
 *  item keeps DEC-61 §5: a PDF that cannot be stamped goes out recorded as
 *  unstamped, with the reason, and the issuer is told. (`items` is
 *  browser-written on a draft, but a forged mark can only make the portal
 *  STRICTER for that item — refuse rather than release unmarked.) */
function refusesUnstampable(item: Item): boolean {
  return item.stampable === true;
}

type Resolved =
  | { ok: true; key: string; versionId: string; label: string | null; fileHash: string | null }
  | { ok: false; status: number; error: string };

/** Resolve an item's file: the exact version if pinned, else the version
 *  whose revision label matches the AS-SENT rev (never silently the newest —
 *  the portal must hand out what the transmittal says it carries).
 *
 *  Both lookups are scoped to the TRANSMITTAL's org (EGR-1). `items` is
 *  free-form JSONB written from the browser, so without this an issuer could
 *  name any document version in any tenant and the service-role portal would
 *  sign its bytes — the same forged-pointer hole lib/docFileServer.ts:26-28
 *  guards ("the pointer columns are member-writable, so a forged cross-org
 *  version id must never resolve"). A cross-org id now simply resolves no
 *  file. A pinned version must also be a version OF the item's document.
 *
 *  TRX-12: the label fallback (items issued before 20261133 pinned every
 *  item at issue) admits only PUBLISHED rows — not a branch, not an in-review
 *  or rejected submission — created at or before the transmittal was issued,
 *  and refuses rather than guesses when more than one row qualifies. */
async function fileKeyForItem(item: Item, orgId: string, issuedAt: string | null): Promise<Resolved> {
  const pinned = item.versionId ?? item.version_id ?? null;
  if (pinned) {
    const { data: v } = await supabaseAdmin
      .from("document_versions").select("file_url, revision_label, record_id, file_hash")
      .eq("id", pinned).eq("org_id", orgId).maybeSingle();
    if (v?.file_url && (!item.documentId || !v.record_id || String(v.record_id) === item.documentId)) {
      return { ok: true, key: String(v.file_url), versionId: pinned, label: (v.revision_label as string | null) ?? item.rev ?? null, fileHash: (v.file_hash as string | null) ?? null };
    }
    return { ok: false, status: 404, error: "The as-sent file for this document isn't available — contact the issuer." };
  }
  if (item.documentId && item.rev) {
    let q = supabaseAdmin
      .from("document_versions").select("id, file_url, file_hash, created_at, review_state, is_branch")
      .eq("record_id", item.documentId).eq("revision_label", item.rev).eq("org_id", orgId)
      .eq("is_branch", false);
    if (issuedAt) q = q.lte("created_at", issuedAt);
    const { data } = await q.order("created_at", { ascending: false }).limit(5);
    const rows = ((data as Array<Record<string, unknown>> | null) ?? [])
      .filter((r) => r.is_branch !== true && r.review_state !== "in_review" && r.review_state !== "rejected" && r.file_url);
    if (rows.length > 1) {
      return { ok: false, status: 409, error: `More than one stored file carries Rev ${item.rev} for this document, and this transmittal does not record which one was sent — contact the issuer for a re-issue.` };
    }
    if (rows.length === 1) return { ok: true, key: String(rows[0].file_url), versionId: String(rows[0].id), label: item.rev, fileHash: (rows[0].file_hash as string | null) ?? null };
  }
  return { ok: false, status: 404, error: "The as-sent file for this document isn't available — contact the issuer." };
}

/** A refused record write that is the unapplied 20261068 (no source /
 *  transmittal_id columns, user_id still NOT NULL) — the same test
 *  /api/share/file applies. Only this earns the one older-shape retry. */
function missingRecordColumn(e: { code?: string; message?: string }): boolean {
  const msg = e.message ?? "";
  return e.code === "PGRST204" || e.code === "42703" || /\b(transmittal_id|source)\b/.test(msg)
    || (e.code === "23502" && /\buser_id\b/.test(msg));
}

async function bumpUse(id: string, kind: "open" | "download"): Promise<void> {
  try {
    const { error } = await supabaseAdmin.rpc("bump_transmittal_portal_use", { p_id: id, p_kind: kind });
    if (error) console.warn("[transmittal portal] usage trail not bumped (20261133 applied?)", error.message);
  } catch (e) {
    console.warn("[transmittal portal] usage trail not bumped", (e as Error)?.message);
  }
}

/** TRX-15: every row a filtered read returns, paged past PostgREST's
 *  max-rows (each next window starts where the rows returned end, until an
 *  empty page), at most `maxPages` windows. A page that errors ends the read
 *  with the rows already in hand: every row is a fact. `complete` says
 *  whether the read reached its end (an empty page) — false after an error,
 *  a throw or the page cap, so the caller never reads "not seen" as "no". */
async function readPaged<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  maxPages = 10,
): Promise<{ rows: T[]; complete: boolean }> {
  const out: T[] = [];
  const size = 1000;
  try {
    for (let from = 0, n = 0; n < maxPages; n++) {
      const { data, error } = await page(from, from + size - 1);
      if (error) return { rows: out, complete: false };
      const rows = (data as T[] | null) ?? [];
      if (rows.length === 0) return { rows: out, complete: true };
      out.push(...rows);
      from += rows.length;
    }
  } catch { /* the rows in hand stand */ }
  return { rows: out, complete: false };
}

/** TRX-15: the documents of this transmittal a copy of which LEFT the portal
 *  without the UNCONTROLLED marking, with why when the trail says so. The
 *  page saves through a hidden frame and cannot read the response's
 *  X-Transmittal-Stamped header, so what only the download learns — a PDF
 *  the stamper refused (`stamp_failed`: a permission-restricted or damaged
 *  file), or one over the bound whose size was never recorded — is read back
 *  here once it has happened:
 *    · the distribution record (`download_audits.source =
 *      'transmittal_portal_unstamped'`, a CHECKED write made before the bytes
 *      leave) says THAT a copy left unmarked;
 *    · the issuer's trail (`TRANSMITTAL_PORTAL_DOWNLOAD`, `details.stamped`
 *      false) says WHY (`unstampedReason`) — and stands in for the record on a
 *      database without the 20261068 columns.
 *  Any copy counts, not only the latest pull: a later stamped pull does not
 *  recall an unmarked copy already in the recipient's hands. A read that
 *  fails (or is cut short) sets `readFailed`: a document it did not flag is
 *  then UNKNOWN (`releasedUnmarked: null` — the page's standing note covers
 *  it), never "nothing says so" (false). */
async function unmarkedCopiesOut(transmittalId: string): Promise<{
  copies: Map<string, "not_pdf" | "oversize" | "stamp_failed" | null>; readFailed: boolean;
}> {
  const out = new Map<string, "not_pdf" | "oversize" | "stamp_failed" | null>();
  const pulls = await readPaged<{ document_id?: string | null }>((from, to) => supabaseAdmin
    .from("download_audits").select("document_id")
    .eq("transmittal_id", transmittalId)
    .eq("source", "transmittal_portal_unstamped")
    .order("id", { ascending: true })
    .range(from, to));
  for (const p of pulls.rows) if (p.document_id) out.set(String(p.document_id), null);
  const trail = await readPaged<{ details?: Record<string, unknown> | null }>((from, to) => supabaseAdmin
    .from("audit_logs").select("details")
    .eq("action", "TRANSMITTAL_PORTAL_DOWNLOAD")
    .eq("resource_type", "transmittal").eq("resource_id", transmittalId)
    .eq("details->>stamped", "false")
    .order("id", { ascending: true })
    .range(from, to));
  for (const row of trail.rows) {
    const d = row.details ?? {};
    if (d.stamped !== false || typeof d.documentId !== "string") continue;
    const why = d.unstampedReason;
    const reason = why === "not_pdf" || why === "oversize" || why === "stamp_failed" ? why : null;
    out.set(d.documentId, reason ?? out.get(d.documentId) ?? null);
  }
  return { copies: out, readFailed: !pulls.complete || !trail.complete };
}

/** TRX-15: how long after the portal's last recorded use (an open or a
 *  download — `portal_last_used_at`, which every download bumps) the page's
 *  `&recheck=1` re-read is taken as that visit's own, not counted as an open.
 *  The page re-reads when a download settles and 45 s later; outside this
 *  window a recheck IS an open, so a client that always sends it cannot keep
 *  the issuer's open count at zero. */
const RECHECK_WINDOW_MS = 10 * 60 * 1000;

/** TRX-15: is this snapshot GET the page's post-download re-read? Only with
 *  `&recheck=1` AND within RECHECK_WINDOW_MS of the portal's last recorded
 *  use; a row without the 20261133 column, or a stamp that does not parse,
 *  counts the GET as an open. */
function isPortalRecheck(recheckParam: string | null, lastUsedAt: unknown, now: number = Date.now()): boolean {
  if (recheckParam !== "1" || typeof lastUsedAt !== "string") return false;
  const at = Date.parse(lastUsedAt);
  return Number.isFinite(at) && now - at >= 0 && now - at <= RECHECK_WINDOW_MS;
}

/** TRX-15: the bell kind of an unstampable-PDF notice (refused or released
 *  unmarked) — and what the once-per-(transmittal, document) dedupe reads. */
const UNSTAMPABLE_NOTICE_KIND = "transmittal_unstampable";

/** TRX-15: whether the issuer already HAS a notice of this (transmittal,
 *  document) — a bell row that was actually written, never merely a trail
 *  row (a notice whose insert failed must not silence every later one). An
 *  unreadable notification set answers "no" (a second notice beats
 *  silence). */
async function issuerAlreadyTold(transmittalId: string, documentId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("notifications").select("id")
      .eq("kind", UNSTAMPABLE_NOTICE_KIND)
      .eq("resource_type", "transmittal").eq("resource_id", transmittalId)
      .eq("metadata->>documentId", documentId)
      .limit(1);
    if (error) return false;
    return ((data as unknown[] | null) ?? []).length > 0;
  } catch {
    return false;
  }
}

/** TRX-15: the issuer is TOLD when a PDF could not be stamped for its
 *  recipient — a bell and an email, once per (transmittal, document):
 *    · `released` (DEC-61 §5, every item TRX-16 did not check at issue): it
 *      went out as issued WITHOUT the UNCONTROLLED marking, recorded so —
 *      an unmarked copy in an outside party's hands is never a silent one;
 *    · `refused` (an item the issue-time check marked stampable): the
 *      recipient does not have it, while the register reads it issued.
 *  The route's own issuer path (the receipt below writes the same two rows):
 *  lib/notify's emit() runs on the signed-in browser client and cannot be
 *  called from this service-role route. The likeliest cause is named — a PDF
 *  saved with security / permission restrictions (common for vendor and
 *  certified drawings), which pdf-lib will not load. Both inserts are
 *  CHECKED (a refusal is logged, never read as delivered); the queue is
 *  kicked on the configured public origin (`publicOrigin()`), never on an
 *  address the request names. Best-effort: it never blocks the download or
 *  the refusal, and never throws. */
async function tellIssuerUnstampable(
  t: Record<string, unknown>,
  item: Item,
  reason: "oversize" | "stamp_failed",
  outcome: "released" | "refused",
): Promise<void> {
  const issuer = (t.created_by as string | null) ?? null;
  if (!issuer || !item.documentId) return;
  try {
    if (await issuerAlreadyTold(String(t.id), item.documentId)) return;
    const orgId = t.org_id as string;
    const label = `${item.number || "a document"}${item.rev ? ` Rev ${item.rev}` : ""}`;
    const why = reason === "oversize"
      ? `it is larger than the portal can mark (${Math.round(PORTAL_STAMP_MAX_BYTES / (1024 * 1024))} MB)`
      : "it could not be marked UNCONTROLLED — most often a PDF saved with security or permission restrictions (common for vendor and certified drawings), otherwise a damaged file";
    const title = outcome === "released"
      ? `Transmittal ${String(t.number ?? "")}: ${label} went to the recipient WITHOUT the UNCONTROLLED marking`
      : `Transmittal ${String(t.number ?? "")}: ${label} was refused to the recipient`;
    const body = outcome === "released"
      ? `The recipient downloaded ${label} through the portal, but ${why}, so it left as issued — without the UNCONTROLLED ` +
        "marking, the as-issued footer or the verify QR — and the delivery is recorded as unstamped. Printed, it cannot be " +
        "told from a controlled copy: tell the recipient it is uncontrolled, or re-save it without restrictions (or split it) " +
        "and issue a new transmittal."
      : `The recipient tried to download ${label} through the portal and was refused: ${why}. ` +
        "It was checked as stampable when this transmittal was issued, and a PDF that passed that check leaves the portal " +
        "stamped or not at all, so they do not have it. Re-save it without restrictions (or split it), then issue a new " +
        "transmittal — this one still reads issued on the register.";
    // The typed insert (TAX-11), on the service-role client; a refusal is
    // logged by notifyChecked and said here, never read as delivered.
    const bell = await notifyWithReason({
      orgId, userId: issuer,
      kind: UNSTAMPABLE_NOTICE_KIND,
      title, body,
      link: "/transmittals",
      resourceType: "transmittal", resourceId: String(t.id),
      metadata: { documentId: item.documentId, reason, outcome },
    }, supabaseAdmin);
    if (!bell.ok) console.error("[transmittal portal] the issuer's bell notice of an unstamped PDF was refused", bell.error);
    const { data: member, error: memberErr } = await supabaseAdmin
      .from("org_members").select("email")
      .eq("org_id", orgId).eq("uid", issuer)
      .maybeSingle();
    if (memberErr) console.error("[transmittal portal] the issuer's email address could not be read for an unstamped-PDF notice", memberErr.message);
    const email = (member as { email?: string | null } | null)?.email ?? null;
    if (!email) return;
    const { error: mailErr } = await supabaseAdmin.from("email_notifications").insert({
      org_id: orgId,
      to_user_id: issuer,
      to_email: email,
      subject: title,
      body_text: body,
      resource_id: String(t.id),
      // Not a per-category toggle (an unmarked or refused delivery is never muted).
      event_type: outcome === "released" ? "transmittal_unstamped" : "transmittal_refused",
      status: "queued",
    });
    if (mailErr) {
      console.error("[transmittal portal] the issuer's email notice of an unstamped PDF could not be queued", mailErr.message);
      return;
    }
    const cronSecret = process.env.CRON_SECRET;
    const origin = publicOrigin();
    if (cronSecret && origin) {
      void fetch(`${origin}/api/notifications/send-queued`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cronSecret}` },
      }).catch(() => undefined);
    }
  } catch (e) {
    console.warn("[transmittal portal] the issuer could not be told of an unstamped PDF", (e as Error)?.message);
  }
}

export async function GET(req: NextRequest) {
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();
  const fileDoc = req.nextUrl.searchParams.get("file");
  const nav = !!fileDoc && req.nextUrl.searchParams.get("nav") === "1";
  const refuse = (body: Record<string, unknown>, status: number) => portalRefusal(nav, body, status);
  const t = await loadByToken(token);
  if (!t) return refuse({ error: "notfound" }, 404);
  const refusal = portalRowRefusal(t);
  if (refusal) return refuse({ error: refusal.error }, refusal.status);

  const items = (Array.isArray(t.items) ? t.items : []) as Item[];
  const orgId = t.org_id as string;

  if (fileDoc) {
    const item = items.find((i) => i.documentId === fileDoc);
    if (!item) return refuse({ error: "That document is not on this transmittal." }, 403);
    const file = await fileKeyForItem(item, orgId, (t.issued_at as string | null) ?? null);
    if (!file.ok) return refuse({ error: file.error }, file.status);
    if (!portalKeyAllowed(file.key, orgId)) {
      console.error("[transmittal portal] refused a storage key outside the transmittal's workspace", { transmittal: t.id, document: fileDoc });
      return refuse({ error: "The as-sent file for this document isn't available — contact the issuer." }, 404);
    }

    // TRX-15 / TRX-16: an item the issue-time check marked stampable leaves
    // stamped or not at all — a PDF the portal then cannot stamp is refused
    // with the reason, on the issuer's trail, nothing recorded as delivered,
    // and the issuer is told (once per transmittal and document). Every other
    // item keeps DEC-61 §5 (released unstamped, recorded, issuer told).
    const armed = refusesUnstampable(item);
    const refuseUnstampable = async (reason: "oversize" | "stamp_failed", detail: string | null) => {
      console.warn("[transmittal portal] a PDF that cannot be stamped was refused", { transmittal: t.id, document: fileDoc, reason, detail });
      const { error: trailErr } = await supabaseAdmin.from("audit_logs").insert({
        action: "TRANSMITTAL_PORTAL_UNSTAMPABLE_REFUSED",
        resource_type: "transmittal", resource_id: String(t.id),
        org_id: orgId, user_id: (t.created_by as string | null) ?? null,
        details: { number: t.number, documentId: fileDoc, versionId: file.versionId, reason, detail, maxStampBytes: PORTAL_STAMP_MAX_BYTES },
      });
      if (trailErr) console.error("[transmittal portal] the unstampable refusal could not be put on the issuer's trail", trailErr.message);
      await tellIssuerUnstampable(t, item, reason, "refused");
      return refuse({ error: "unstampable", reason }, 422);
    };

    // Pull the bytes server-side (no presigned URL leaves this route). A file
    // up to the stamping bound is held once in memory; a larger one is only
    // ever hashed chunk by chunk here, then re-read, pinned, for the send.
    let source: Uint8Array | null = null;
    let objectType: string | null = null;
    let etag: string | null = null;
    let servedSha256: string;
    let head: Uint8Array;
    let oversizePdf = false;
    try {
      const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: file.key }));
      objectType = (obj.ContentType as string | undefined) ?? null;
      const size = typeof obj.ContentLength === "number" ? obj.ContentLength : null;
      if (size !== null && size > PORTAL_STAMP_MAX_BYTES) {
        etag = (obj.ETag as string | undefined) ?? null;
        if (!obj.Body || !etag) throw new Error("large object without a body or an ETag");
        ({ sha256: servedSha256, head, stoppedAtPdf: oversizePdf } = await hashBody(obj.Body, { stopIfPdf: armed }));
      } else {
        const bytes = await obj.Body?.transformToByteArray();
        if (!bytes) throw new Error("empty object body");
        source = bytes;
        servedSha256 = createHash("sha256").update(source).digest("hex");
        head = source.subarray(0, 4);
      }
    } catch (e) {
      console.warn("[transmittal portal] file fetch failed", (e as Error).message);
      return refuse({ error: "The file couldn't be fetched right now — try again shortly." }, 502);
    }
    if (oversizePdf) return refuseUnstampable("oversize", null);

    // TRX-8: the bytes must be the bytes that were issued — the hash the
    // database wrote onto the item at issue, or (an item issued before
    // 20261133) the hash on the version row it resolved to.
    const recorded = (item.fileHash || file.fileHash || "").trim().toLowerCase();
    if (recorded && recorded !== servedSha256) {
      console.error("[transmittal portal] file hash mismatch — refused", { transmittal: t.id, document: fileDoc, version: file.versionId });
      await supabaseAdmin.from("audit_logs").insert({
        action: "TRANSMITTAL_PORTAL_INTEGRITY_REFUSED",
        resource_type: "transmittal", resource_id: String(t.id),
        org_id: orgId, user_id: (t.created_by as string | null) ?? null,
        details: { number: t.number, documentId: fileDoc, versionId: file.versionId, recordedSha256: recorded, servedSha256 },
      }).then(() => undefined, () => undefined);
      return refuse({ error: "This file no longer matches the one recorded when the transmittal was issued, so it was not released. Contact the issuer." }, 409);
    }

    // TRX-5 / EGR-8: stamp a PDF the way /api/share/file does for the same
    // audience — UNCONTROLLED, the as-issued rev + transmittal number, and a
    // /verify QR bound to the exact version served.
    const rev = item.rev ?? file.label ?? null;
    const label = item.number ?? "document";
    const origin = publicOrigin();
    const verifyUrl = origin ? `${origin}/verify/${fileDoc}?v=${file.versionId}` : undefined;
    const issuedOn = t.issued_at ? new Date(String(t.issued_at)).toISOString().slice(0, 10) : null;
    const isPdf = looksLikePdf(head);
    let outBytes: Uint8Array | null = source;
    let stamped = false;
    let unstampedReason: "not_pdf" | "oversize" | "stamp_failed" | null = !isPdf ? "not_pdf" : source ? null : "oversize";
    if (isPdf && !source && armed) return refuseUnstampable("oversize", null);
    if (isPdf && source) {
      try {
        const pdfDoc = await PDFDocument.load(source);
        await applyStampToPdfDoc(pdfDoc, {
          userLabel: `transmittal ${String(t.number ?? "")}`.trim(),
          timestamp: new Date(),
          watermarkText: "UNCONTROLLED — TRANSMITTAL COPY",
          footerNotice: `${label} Rev ${rev ?? "?"} as issued on transmittal ${String(t.number ?? "")}${issuedOn ? ` (${issuedOn})` : ""}. ${verifyUrl ? "Scan the QR to confirm it is still current." : "Confirm the current revision with the issuer before use."}`,
          verifyUrl,
        });
        outBytes = await pdfDoc.save();
        stamped = true;
      } catch (e) {
        if (armed) return refuseUnstampable("stamp_failed", (e as Error).message || null);
        // DEC-61 §5: released unstamped, recorded with the reason — and the
        // issuer told once the copy has left (below).
        unstampedReason = "stamp_failed";
        console.warn("[transmittal portal] stamping failed — delivering unstamped, recorded so (DEC-61 §5)", (e as Error).message);
      }
    }

    // A large file goes out as a second read of the SAME object: If-Match on
    // the ETag just verified, so a replaced object is refused (412) instead of
    // being sent under the verified digest. Opened BEFORE the record is
    // written, so a failure here records nothing.
    let piped: { stream: ReadableStream<Uint8Array>; release: () => void } | null = null;
    if (!outBytes) {
      try {
        const again = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: file.key, IfMatch: etag ?? undefined }));
        const body = again.Body as ({ transformToWebStream?: () => ReadableStream<Uint8Array>; destroy?: () => void } | undefined);
        const stream = body?.transformToWebStream?.();
        if (!stream) throw new Error("no streamable body");
        piped = { stream, release: () => { try { body?.destroy?.(); } catch { /* already closed */ } } };
      } catch (e) {
        console.warn("[transmittal portal] verified large file could not be re-read for the send", (e as Error).message);
        return refuse({ error: "The file couldn't be fetched right now — try again shortly." }, 502);
      }
    }

    // TRX-9: the distribution record, BEFORE the bytes leave.
    const base = {
      org_id: orgId,
      document_id: fileDoc,
      version_id: file.versionId,
      user_email: (t.recipient_email as string | null) ?? null,
      created_at: new Date().toISOString(),
      expires_at: (t.portal_expires_at as string | null) ?? null,
      watermark_policy_id: null,
    };
    let { error: recordError } = await supabaseAdmin.from("download_audits").insert({
      ...base,
      user_id: null,
      source: stamped ? "transmittal_portal" : "transmittal_portal_unstamped",
      transmittal_id: t.id,
    });
    if (recordError && missingRecordColumn(recordError) && t.created_by) {
      console.error("[transmittal portal] DEPLOY ORDER: download_audits lacks the 20261068 columns (transmittal_id / source) — apply 20261068; recording this pull in the pre-20261068 shape (attributed to the issuer)", {
        transmittal: t.id, document: fileDoc, version: file.versionId, message: recordError.message,
      });
      ({ error: recordError } = await supabaseAdmin.from("download_audits").insert({ ...base, user_id: t.created_by }));
    }
    if (recordError) {
      piped?.release();
      console.error("[transmittal portal] download_audits insert failed — portal download refused, nothing left the building", {
        transmittal: t.id, document: fileDoc, version: file.versionId, message: recordError.message,
      });
      return refuse({ error: "unrecorded" }, 503);
    }

    // The issuer's accountability trail (EGR-1 attribution), now with the
    // version served and its digest (TRX-8: the delivery records what left).
    await supabaseAdmin.from("audit_logs").insert({
      action: "TRANSMITTAL_PORTAL_DOWNLOAD",
      resource_type: "transmittal", resource_id: String(t.id),
      org_id: orgId, user_id: (t.created_by as string | null) ?? null,
      user_email: (t.recipient_email as string | null) ?? null,
      details: {
        number: t.number, documentId: fileDoc, docNumber: item.number, rev, versionId: file.versionId,
        issuedBy: t.created_by ?? null, stamped, unstampedReason, servedSha256, hashVerified: !!recorded,
      },
    }).then(() => undefined, () => undefined);
    await bumpUse(String(t.id), "download");
    // TRX-15: a PDF that left without the marking is never a silent one.
    if (unstampedReason === "oversize" || unstampedReason === "stamp_failed") {
      await tellIssuerUnstampable(t, item, unstampedReason, "released");
    }

    const safe = (s: string) => s.replace(/[^\w.\-]+/g, "_");
    const ext = stamped ? ".pdf" : (file.key.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "");
    const filename = `${safe(label)}_Rev${safe(rev ?? "0")}${ext}`;
    // A streamed body either way — never one buffered response.
    return new NextResponse(piped ? piped.stream : chunkedStream(outBytes ?? new Uint8Array()), {
      headers: {
        "Content-Type": stamped ? "application/pdf" : (objectType || "application/octet-stream"),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        // The recipient's page can say a file arrived without the stamp.
        "X-Transmittal-Stamped": stamped ? "1" : "0",
      },
    });
  }

  // The snapshot the portal renders — nothing beyond this transmittal.
  const { data: org } = await supabaseAdmin.from("orgs").select("name").eq("id", orgId).maybeSingle();
  // TRX-15: the page re-reads the snapshot after a download (`&recheck=1`)
  // to learn whether the copy left unmarked — that re-read is not an open,
  // but only within minutes of the portal's last recorded use
  // (`isPortalRecheck`); any other GET, flagged or not, is counted.
  if (!isPortalRecheck(req.nextUrl.searchParams.get("recheck"), t.portal_last_used_at)) await bumpUse(String(t.id), "open");
  // TRX-15: the page saves a file without reading the response, so it can no
  // longer see the X-Transmittal-Stamped header — it says up front which
  // pinned files leave without the UNCONTROLLED marking: a file that is not a
  // PDF, and a PDF over the stamping bound on an item not armed for refusal
  // (one read per 150 pins; null = unknown, and the page's standing note
  // covers it). The read is scoped to the transmittal's org exactly as the
  // download's own resolver is (`fileKeyForItem`): a version row outside it —
  // a legacy row with no org_id among them — is never served, so there is
  // nothing to flag. What only a download learns (a PDF the stamper refuses,
  // an oversize file with no recorded size) is read back from the record
  // once a copy has left (`unmarkedCopiesOut`).
  const pinnedIds = [...new Set(items.map((i) => i.versionId ?? i.version_id ?? null).filter((v): v is string => !!v))];
  const fileByVersion = new Map<string, { file_url: string | null; file_type: string | null; size: number | null }>();
  for (let i = 0; i < pinnedIds.length; i += 150) {
    const { data: fileRows, error: fileErr } = await supabaseAdmin
      .from("document_versions").select("id, file_url, file_type, size").in("id", pinnedIds.slice(i, i + 150)).eq("org_id", orgId);
    if (fileErr) continue; // this chunk's items stay unknown
    for (const v of (fileRows as Array<{ id: string; file_url: string | null; file_type?: string | null; size?: number | null }> | null) ?? []) {
      fileByVersion.set(String(v.id), { file_url: v.file_url ?? null, file_type: v.file_type ?? null, size: typeof v.size === "number" ? v.size : null });
    }
  }
  const { copies: copiesOut, readFailed: copiesUnread } = await unmarkedCopiesOut(String(t.id));
  const fromFile = (i: Item): "not_pdf" | "oversize" | null | undefined => {
    const f = fileByVersion.get(String(i.versionId ?? i.version_id ?? ""));
    if (!f?.file_url) return undefined; // unknown
    if (!isPdfFile(f.file_url, f.file_type)) return "not_pdf";
    const size = typeof i.fileSize === "number" ? i.fileSize : f.size;
    return !refusesUnstampable(i) && typeof size === "number" && size > PORTAL_STAMP_MAX_BYTES ? "oversize" : null;
  };
  // `releasedUnmarked`: true — it leaves (or a copy already left) WITHOUT the
  // marking; false — nothing says so; null — unknown (its file, or — when the
  // record / trail read failed — whether a copy already left unmarked).
  // `unmarkedReason`: why, when known (null with `true` = a copy left
  // unmarked, cause not on the trail).
  const unmarked = (i: Item): { releasedUnmarked: boolean | null; unmarkedReason: "not_pdf" | "oversize" | "stamp_failed" | null } => {
    const known = fromFile(i);
    if (i.documentId && copiesOut.has(i.documentId)) {
      const why = copiesOut.get(i.documentId) ?? null;
      return { releasedUnmarked: true, unmarkedReason: why ?? (known === "not_pdf" || known === "oversize" ? known : null) };
    }
    if (known === undefined) return { releasedUnmarked: null, unmarkedReason: null };
    if (known === null && copiesUnread) return { releasedUnmarked: null, unmarkedReason: null };
    return { releasedUnmarked: known !== null, unmarkedReason: known };
  };
  return NextResponse.json({
    number: t.number,
    subject: t.subject,
    purpose: t.purpose,
    status: t.status,
    notes: t.notes,
    orgName: (org?.name as string | null) ?? null,
    fromName: t.created_by_name,
    issuedAt: t.issued_at,
    acknowledgedAt: t.acknowledged_at,
    acknowledgedByName: t.acknowledged_by_name,
    recipientName: t.recipient_name,
    recipientCompany: t.recipient_company,
    portalExpiresAt: (t.portal_expires_at as string | null) ?? null,
    items: items.map((i) => {
      const flag = unmarked(i);
      return {
        documentId: i.documentId, number: i.number, title: i.title ?? null, rev: i.rev ?? null,
        // TRX-3 / TRX-8: what was sent, as the database recorded it at issue.
        statusAsSent: i.statusAsSent ?? null, effectiveDate: i.effectiveDate ?? null, fileHash: i.fileHash ?? null,
        // REV-9: "not yet in force" decided in the facility's calendar (the one
        // shared "today"), not in the recipient's browser or in UTC.
        notYetInForce: effectiveStatusFor(i.effectiveDate ?? null) === "pending",
        // TRX-15: not a PDF, a PDF over the stamping bound, or a copy the
        // record shows already left unmarked (a stamper refusal included —
        // DEC-61 §5) → released as issued, without the marking (null = unknown).
        releasedUnmarked: flag.releasedUnmarked,
        unmarkedReason: flag.unmarkedReason,
        fileSize: typeof i.fileSize === "number" ? i.fileSize : null,
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  let body: { token?: string; name?: string; note?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const token = String(body.token ?? "").trim();
  const name = String(body.name ?? "").trim().slice(0, 120);
  if (!name) return bad("Your name is required to acknowledge receipt.");

  const t = await loadByToken(token);
  if (!t) return NextResponse.json({ error: "notfound" }, { status: 404 });
  if (t.status === "voided") return bad("This transmittal was voided by the issuer.", 410);
  if (t.status === "acknowledged") {
    return NextResponse.json({ ok: true, already: true, acknowledgedByName: t.acknowledged_by_name, acknowledgedAt: t.acknowledged_at });
  }
  // TRX-4: a revoked or expired link cannot record a receipt either.
  const refusal = portalRowRefusal(t);
  if (refusal?.error === "revoked") return NextResponse.json({ error: "revoked" }, { status: 410 });
  if (refusal?.error === "expired") return NextResponse.json({ error: "expired" }, { status: 410 });
  if (t.status !== "issued") return bad("This transmittal isn't in an acknowledgeable state.", 409);

  const now = new Date().toISOString();
  const meta = {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent")?.slice(0, 200) ?? null,
    note: String(body.note ?? "").trim().slice(0, 500) || null,
  };
  const { data: updated, error } = await supabaseAdmin
    .from("transmittals")
    .update({
      status: "acknowledged",
      acknowledged_at: now,
      acknowledged_by_name: name,
      acknowledged_via: "portal",
      acknowledged_meta: meta,
      updated_at: now,
    })
    .eq("id", t.id as string)
    .eq("status", "issued")
    .select("id");
  if (error) return bad(`Couldn't record the acknowledgment: ${error.message}`, 500);
  if (!updated || updated.length === 0) return bad("This transmittal isn't in an acknowledgeable state.", 409);

  await supabaseAdmin.from("audit_logs").insert({
    action: "TRANSMITTAL_ACKNOWLEDGED",
    resource_type: "transmittal", resource_id: String(t.id),
    org_id: t.org_id, user_id: null, user_email: (t.recipient_email as string | null) ?? null,
    details: { number: t.number, acknowledgedBy: name, via: "portal", ...meta },
  }).then(() => undefined, () => undefined);

  // Tell the issuer their receipt landed — bell now, email via the queue.
  if (t.created_by) {
    // The typed insert (TAX-11), on the service-role client; best-effort, as before.
    await notifyChecked({
      orgId: String(t.org_id), userId: String(t.created_by),
      kind: "ack_complete",
      title: `Transmittal ${t.number} acknowledged`,
      body: `${name} confirmed receipt through the portal.`,
      link: "/transmittals",
      resourceType: "transmittal", resourceId: String(t.id),
      actorName: name,
    }, supabaseAdmin);

    const { data: issuer } = await supabaseAdmin
      .from("org_members").select("email")
      .eq("org_id", t.org_id as string).eq("uid", t.created_by as string)
      .maybeSingle();
    if (issuer?.email) {
      await supabaseAdmin.from("email_notifications").insert({
        org_id: t.org_id,
        to_user_id: t.created_by,
        to_email: issuer.email,
        subject: `Transmittal ${t.number} acknowledged by ${name}`,
        body_text: `${name} confirmed receipt of transmittal ${t.number}${t.subject ? ` (${t.subject})` : ""} through the recipient portal on ${new Date(now).toLocaleString()}.${meta.note ? `\n\nTheir note: ${meta.note}` : ""}`,
        resource_id: String(t.id),
        event_type: "watcher_activity",
        status: "queued",
      }).then(() => undefined, () => undefined);

      // The maintenance cron only drains daily — kick the sender now so the
      // issuer hears about the receipt in seconds. Best-effort.
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret) {
        void fetch(`${req.nextUrl.origin}/api/notifications/send-queued`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cronSecret}` },
        }).catch(() => undefined);
      }
    }
  }

  return NextResponse.json({ ok: true, acknowledgedAt: now });
}
