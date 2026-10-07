import { NextRequest, NextResponse, after } from "next/server";
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { r2, R2_BUCKET } from "@/lib/r2";
import { callerScopedClient } from "@/lib/serverAuth";
import { runWithServerClient } from "@/lib/serverClientScope";
import { isSafeStorageKey } from "@/lib/storageKey";
import { publicOrigin } from "@/lib/publicOrigin";
import { checkedWrite } from "@/lib/checkedWrite";
import { formatTicketNumber, getTicketNumberConfig } from "@/lib/ticketNumber";
import { defaultSlaTargetDate } from "@/lib/notifications";
import { resolveTicketRecipients } from "@/lib/ticketRouting";
import { emit } from "@/lib/notify/dispatch";
import { escapeHtml } from "@/lib/ticketTransitions";
import { buildSourceDocumentRef, unitOfDocumentMetadata, type SourceDocumentRefRow } from "@/lib/sourceDocRef";
import {
  parseTicketCreateBody, unitOptionsFor, resolveUnit, requestTypeAllowed, missingRequiredCustomField,
  stampedRequesterRole, stampedRequesterName, openingHistory, creationNotice,
  isStagedKeyOf, finalAttachmentKey, attachmentSizeLabel,
  type CreatorMember, type TicketCreateInput,
} from "@/lib/ticketCreate";
import type { OrgDraftingSettings, TicketAttachment } from "@/types/schema";

// POST /api/tickets/create — the ONE way a drafting request is filed
// (drafting-flow Round G, DF-P2 CREATE).
//
// The request form, a document check-in and an intake collision all post the
// lib/ticketCreate.ts contract here. This route:
//   1. authenticates the caller (bearer token) and reads their ACTIVE
//      membership of the workspace (403 otherwise);
//   2. validates the contract against the workspace's own rules — the
//      configured request types, the required custom fields, the unit list
//      (FRIC-8 / FRIC-3 / DCW-7), the source documents (in this workspace),
//      the staged attachments (under the caller's own pending prefix, in
//      storage) — BEFORE anything is allocated or written;
//   3. for a check-in, resumes the ticket the same check-in episode already
//      filed for this requester instead of filing a second (LEAK-6);
//   4. allocates the request number only now (EDGE-13: a refused submit
//      never spends one), and releases it if the insert then fails and no
//      later number was handed out;
//   5. inserts the row under the service role, REPLICATING 20261038's
//      ticket_insert_integrity (which a service-role insert bypasses): the
//      requester is the caller, the requester_role one they hold (else their
//      headline), the email their membership's, the status PENDING_ASSIGNMENT,
//      nothing assigned, approved, closed or archived, the request type a
//      configured one — and the requester's name from the membership too
//      (AUTHZ-3);
//   6. re-keys each staged attachment under the ticket's own prefix;
//   7. fans the new-request notice out from HERE, awaited before the
//      response (EDGE-8): the bell rows through the typed sink and the
//      email rows preference-aware (lib/notify/dispatch emit(), run as the
//      service role, so the recipient's opt-out is read where it is visible —
//      EDGE-1, EDGE-12), both carrying metadata.action/status so the
//      workflow route's supersede and the badge's reconcile retire them once
//      the ticket moves on (ROUTE-11), from one door for all three creators
//      (ROUTE-4).
//
// DELETE /api/tickets/create — discards files a requester staged for a
// submit that never reached POST (an upload that failed part-way). Only keys
// under the caller's own pending prefix that no ticket names.

export const runtime = "nodejs";
export const maxDuration = 60;

/** A refusal before anything was allocated: staged files are deleted so a
 *  refused submit leaves nothing behind (EDGE-13). */
type Fail = { status: number; field?: string; error: string; code?: string };

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status });

function copySource(key: string): string {
  return `${R2_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function deleteObjects(keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    } catch (e) {
      console.warn(`[tickets/create] could not delete ${key} (the orphan sweep reclaims it):`, (e as Error)?.message ?? e);
    }
  }
}

async function authenticate(req: NextRequest): Promise<{ id: string; email: string | null; token: string } | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email ?? null, token };
}

/** The caller's ACTIVE membership of `orgId`; "error" when it cannot be read. */
async function activeMember(orgId: string, uid: string): Promise<CreatorMember | null | "error"> {
  const { data, error } = await supabaseAdmin
    .from("org_members")
    .select("role, roles, email, display_name")
    .eq("org_id", orgId)
    .eq("uid", uid)
    .eq("status", "active")
    .maybeSingle();
  if (error) return "error";
  if (!data) return null;
  const m = data as { role?: unknown; roles?: unknown; email?: unknown; display_name?: unknown };
  return {
    role: typeof m.role === "string" ? m.role : null,
    roles: Array.isArray(m.roles) ? (m.roles as unknown[]).filter((r): r is string => typeof r === "string") : null,
    email: typeof m.email === "string" ? m.email : null,
    display_name: typeof m.display_name === "string" ? m.display_name : null,
  };
}

interface SourceRow {
  id: string;
  document_number: string | null;
  title: string | null;
  name: string | null;
  rev: string | null;
  current_version_id: string | null;
  metadata: Record<string, unknown> | null;
  unit_code?: string | null;
}

/** The source documents, read in THIS workspace. documents.unit_code is
 *  intelligence 20261138's (pending paste): without it the read is retried
 *  without the column and the unit comes from the document's metadata. */
async function readSourceDocuments(orgId: string, ids: string[]): Promise<SourceRow[] | "error"> {
  if (ids.length === 0) return [];
  const base = "id, document_number, title, name, rev, current_version_id, metadata";
  const first = await supabaseAdmin.from("documents").select(`${base}, unit_code`).eq("org_id", orgId).in("id", ids);
  if (!first.error) return (first.data ?? []) as SourceRow[];
  const code = String((first.error as { code?: string }).code ?? "");
  const msg = String(first.error.message ?? "");
  if (!(code === "42703" || code === "PGRST204" || /unit_code/.test(msg))) return "error";
  const again = await supabaseAdmin.from("documents").select(base).eq("org_id", orgId).in("id", ids);
  return again.error ? "error" : ((again.data ?? []) as SourceRow[]);
}

/** HAND-7: the version a request is raised against. The version the
 *  producer names when it is a version of this document; else the
 *  document's current version, when the rev the requester saw is the
 *  current one (or they named none); else unknown — never a version the
 *  requester did not see. */
async function capturedVersion(doc: SourceRow, named: { versionId: string | null; rev: string | null }): Promise<string | null | "error"> {
  if (named.versionId) {
    if (named.versionId === doc.current_version_id) return named.versionId;
    const { data, error } = await supabaseAdmin
      .from("document_versions").select("id").eq("id", named.versionId).eq("record_id", doc.id).maybeSingle();
    if (error) return "error";
    if (data) return named.versionId;
  }
  const seen = named.rev?.trim().toLowerCase() || null;
  const current = doc.rev?.trim().toLowerCase() || null;
  if (!seen || seen === current) return doc.current_version_id ?? null;
  return null;
}

export async function POST(req: NextRequest) {
  const caller = await authenticate(req);
  if (!caller) return json(401, { error: "Unauthorized" });

  let raw: unknown;
  try { raw = await req.json(); } catch { return json(400, { error: "Invalid JSON body", field: "body" }); }
  const parsed = parseTicketCreateBody(raw);
  if (!parsed.ok) {
    await deleteObjects(stagedKeysIn(raw, caller.id));
    return json(400, { error: parsed.error, field: parsed.field });
  }
  const input = parsed.input;
  const stagedKeys = input.attachments.filter((a) => a.kind === "staged").map((a) => a.key);

  const outcome = await create(req, caller, input);
  if ("status" in outcome) {
    // Nothing was allocated or written: the staged files go too (EDGE-13).
    await deleteObjects(stagedKeys.filter((k) => isStagedKeyOf(k, input.orgId, caller.id)));
    return json(outcome.status, { error: outcome.error, ...(outcome.field ? { field: outcome.field } : {}), ...(outcome.code ? { code: outcome.code } : {}) });
  }
  return json(outcome.resumed ? 200 : 201, outcome);
}

/** Staged keys a refused body named, for cleanup — only the caller's own. */
function stagedKeysIn(raw: unknown, uid: string): string[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as { orgId?: unknown; attachments?: unknown };
  if (typeof r.orgId !== "string" || !Array.isArray(r.attachments)) return [];
  const orgId = r.orgId;
  return r.attachments
    .map((a) => (a && typeof a === "object" ? (a as { key?: unknown }).key : null))
    .filter((k): k is string => typeof k === "string" && isStagedKeyOf(k, orgId, uid));
}

type Created = {
  ok: true;
  id: string;
  ticketNumber: string;
  resumed: boolean;
  notified?: boolean;
  /** Staged attachments still under the pending prefix (their re-key failed;
   *  the row names them where they are, so nothing is lost). */
  unmovedAttachments?: number;
};

async function create(
  req: NextRequest,
  caller: { id: string; email: string | null; token: string },
  input: TicketCreateInput,
): Promise<Created | Fail> {
  const orgId = input.orgId;

  // 1. Membership — 20261038: only an active member files a request.
  const member = await activeMember(orgId, caller.id);
  if (member === "error") return { status: 503, error: "Couldn't confirm your membership of this workspace — try again in a moment." };
  if (!member) return { status: 403, error: "Only active members of this workspace can file requests." };

  // 2. The workspace's own rules.
  const { data: cfgRow, error: cfgErr } = await supabaseAdmin
    .from("org_configurations").select("data").eq("org_id", orgId).eq("key", "drafting").maybeSingle();
  if (cfgErr) return { status: 503, error: "Couldn't read this workspace's request settings — try again in a moment." };
  const cfg = ((cfgRow as { data?: unknown } | null)?.data ?? null) as OrgDraftingSettings | null;

  if (!requestTypeAllowed(input.requestType, cfg)) {
    return { status: 400, field: "requestType", error: `Request type "${input.requestType}" is not one this workspace offers.` };
  }
  // The custom categories are the request FORM's sections: the form is the
  // one door that shows them, so it is the one that must fill the required
  // ones. A check-in or an intake collision never could (refusing them here
  // would stop a hazard report on an admin's form setting).
  if (input.origin.kind === "portal") {
    const missing = missingRequiredCustomField(cfg, input.customCategories);
    if (missing) return { status: 400, field: missing.field, error: missing.error };
  }

  // The unit list the form offers: configured units, else the codebook's.
  let codebookUnits: Array<{ code: string; label: string | null }> = [];
  if (!((cfg?.units?.options?.length ?? 0) > 0)) {
    const { data: cb, error: cbErr } = await supabaseAdmin
      .from("codebook_entries").select("code, label").eq("org_id", orgId).eq("kind", "unit");
    // The codebook is optional (it may not exist yet): an unreadable one is
    // "no list", and the unit is taken as typed — as the form does.
    if (!cbErr) codebookUnits = ((cb ?? []) as Array<{ code: string; label: string | null }>).filter((u) => !!u.code);
  }
  const unitOptions = unitOptionsFor(cfg, codebookUnits);
  let unit = resolveUnit(input.unit, unitOptions);
  if (unit.kind === "unmatched" && input.origin.kind === "portal") {
    return { status: 400, field: "unit", error: `"${input.unit}" is not on this workspace's unit list — pick one, or "Unit unknown".` };
  }

  // Attachments: a staged file is the caller's own, under their pending
  // prefix, and is in storage; a Source reference names a key in this
  // workspace. Checked before a number is spent.
  const stagedSizes = new Map<string, number | null>();
  for (const a of input.attachments) {
    if (!isSafeStorageKey(a.key)) return { status: 400, field: "attachments", error: `"${a.name}" is not a valid file reference.` };
    if (a.kind === "staged") {
      if (!isStagedKeyOf(a.key, orgId, caller.id)) {
        return { status: 400, field: "attachments", error: `"${a.name}" was not staged by you for this workspace.` };
      }
      try {
        const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: a.key }));
        stagedSizes.set(a.key, typeof head.ContentLength === "number" ? head.ContentLength : null);
      } catch (e) {
        const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
          return { status: 400, field: "attachments", error: `"${a.name}" did not finish uploading — attach it again.` };
        }
        return { status: 503, error: "Couldn't check the attached files in storage — try again in a moment." };
      }
    } else if (!a.key.startsWith(`orgs/${orgId}/`)) {
      return { status: 400, field: "attachments", error: `"${a.name}" is not a file in this workspace.` };
    }
  }

  // Source documents: in THIS workspace (a foreign id is refused, never
  // stored — SM-14's input), each with the version it was raised against.
  const docs = await readSourceDocuments(orgId, input.sourceDocuments.map((d) => d.id));
  if (docs === "error") return { status: 503, error: "Couldn't read the source document — try again in a moment." };
  const byId = new Map(docs.map((d) => [d.id, d]));
  const refs: SourceDocumentRefRow[] = [];
  for (const s of input.sourceDocuments) {
    const doc = byId.get(s.id);
    if (!doc) return { status: 400, field: "sourceDocuments", error: "A linked source document is not in this workspace (it may have been removed)." };
    const versionId = await capturedVersion(doc, { versionId: s.versionId, rev: s.rev });
    if (versionId === "error") return { status: 503, error: "Couldn't read the source document's revisions — try again in a moment." };
    const ref = buildSourceDocumentRef({
      id: doc.id,
      documentNumber: s.documentNumber ?? doc.document_number,
      title: s.title ?? doc.title,
      rev: s.rev ?? doc.rev,
      versionId,
    });
    if (ref) refs.push(ref);
  }
  const primary = refs[0] ?? null;

  // FRIC-3 done-when 2: no unit given → the source document's own, when it
  // names one (its codebook unit, else its metadata), resolved against the
  // list like any other.
  if (unit.kind === "none" && primary) {
    const doc = byId.get(primary.id)!;
    const derived = (typeof doc.unit_code === "string" && doc.unit_code.trim()) || unitOfDocumentMetadata(doc.metadata);
    if (derived) unit = resolveUnit(derived, unitOptions);
  }

  // 3. LEAK-6: a check-in that already filed its ticket resumes it — keyed on
  //    the check-in episode, for this requester, while the ticket is open.
  if (input.origin.kind === "checkin" && input.origin.episodeId) {
    const { data: prior, error: priorErr } = await supabaseAdmin
      .from("tickets").select("id, ticket_id")
      .eq("org_id", orgId)
      .eq("requester_id", caller.id)
      .eq("metadata->checkin->>episodeId", input.origin.episodeId)
      .not("status", "in", '("CLOSED","CANCELED")')
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (priorErr) return { status: 503, error: "Couldn't check whether this check-in already filed its request — try again in a moment." };
    if (prior) {
      await deleteObjects(input.attachments.filter((a) => a.kind === "staged").map((a) => a.key));
      const p = prior as { id: string; ticket_id: string };
      return { ok: true, id: p.id, ticketNumber: p.ticket_id, resumed: true };
    }
  }

  // 4. The request number — allocated only now, as the caller (the counter
  //    function admits active members only, and reads auth.uid()).
  const caller_client = callerScopedClient(req);
  if ("error" in caller_client) return { status: caller_client.status, error: caller_client.error };
  const year = new Date().getFullYear();
  let numberCfg;
  try {
    numberCfg = await runWithServerClient(supabaseAdmin, () => getTicketNumberConfig(orgId));
  } catch {
    return { status: 503, error: "Couldn't read this workspace's request numbering — try again in a moment." };
  }
  const { data: seqRaw, error: seqErr } = await caller_client.rpc("next_ticket_number", { p_org: orgId, p_year: year });
  if (seqErr || seqRaw == null) {
    const msg = seqErr?.message ?? "";
    return {
      status: 503,
      error: /function|schema|does not exist/i.test(msg)
        ? "Ticket numbering isn't set up yet — apply migration 20260724_ticket_numbering.sql."
        : `Couldn't generate a request number: ${msg || "unknown error"}`,
    };
  }
  const seq = Number(seqRaw);
  const ticketNumber = formatTicketNumber(numberCfg, year, seq);

  // 5. The row — 20261038 ticket_insert_integrity, replicated.
  const now = new Date().toISOString();
  const email = member.email || caller.email;
  const requesterRole = stampedRequesterRole(input.requesterRole, member);
  const attachments: TicketAttachment[] = input.attachments.map((a) => ({
    id: crypto.randomUUID(),
    name: a.name,
    url: a.key,
    type: "Source",
    status: "submitted",
    size: a.kind === "staged" ? attachmentSizeLabel(stagedSizes.get(a.key)) : "—",
    uploadedBy: email || "Unknown",
    uploadedAt: now,
  }));
  const metadata: Record<string, unknown> = {};
  if (input.customCategories) metadata.custom_categories = input.customCategories;
  if (primary) metadata.source_document = primary;
  if (refs.length > 1) metadata.source_documents = refs;           // GAP-8
  if (unit.unit == null) metadata.unit_unknown = true;              // FRIC-3: the explicit answer
  else if (unit.kind === "unmatched") metadata.unit_unlisted = true; // DCW-7: kept as derived, not on the list
  if (input.origin.kind === "checkin") {
    const o = input.origin;
    metadata.checkin = { episodeId: o.episodeId, checkoutNumber: o.checkoutNumber, purpose: o.purpose, outcome: o.outcome };
    if (o.moc) metadata.moc = { status: o.moc.status, number: o.moc.status === "none" ? null : o.moc.number };
    if (o.minorCorrection) metadata.minor_correction = true;
    if (o.undocumentedChange) metadata.undocumented_change = true;
  } else if (input.origin.kind === "intake_collision") {
    const o = input.origin;
    metadata.intake_collision = {
      projectId: o.projectId,
      intakeLinkId: o.intakeLinkId,
      numberCollisionDocId: o.numberCollisionDocId,
      overlaps: o.overlaps,
      flaggedAt: now,
    };
  }

  const row: Record<string, unknown> = {
    org_id: orgId,
    ticket_id: ticketNumber,
    title: input.title,
    description: input.description,
    unit: unit.unit,
    request_type: input.requestType,
    priority: input.priority,
    status: "PENDING_ASSIGNMENT",
    requester_id: caller.id,
    requester_name: stampedRequesterName(member, caller.email),
    requester_email: email,
    requester_role: requesterRole,
    attachments,
    history: openingHistory({ origin: input.origin, email, role: member.role, now, primary }),
    comments: [],
    unread_by: [],
    // The requester follows their own request.
    watchers: [caller.id],
    target_completion_at: input.targetCompletionAt ?? defaultSlaTargetDate(input.requestType),
    created_at: now,
    last_modified: now,
  };
  if (Object.keys(metadata).length > 0) row.metadata = metadata;

  const { data: inserted, error: insErr } = await supabaseAdmin.from("tickets").insert(row).select("id").single();
  if (insErr || !inserted) {
    // EDGE-13: give the number back when nothing was handed out after it.
    const released = await checkedWrite(supabaseAdmin.from("ticket_number_counters")
      .update({ next_seq: seq - 1 })
      .eq("org_id", orgId).eq("year", year).eq("next_seq", seq)
      .select("org_id"));
    console.error(`[tickets/create] insert of ${ticketNumber} failed (${insErr?.message ?? "no row"}); number ${released.ok ? "released" : "not released (a later number was already handed out)"}`);
    return { status: 500, error: "The request could not be saved — nothing was filed. Try again." };
  }
  const ticketId = String((inserted as { id: string }).id);

  // 6. Re-key staged attachments under the ticket's own prefix.
  const stagedIds = new Set(attachments.filter((_, i) => input.attachments[i].kind === "staged").map((a) => a.id));
  const unmoved = await rekeyAttachments(orgId, ticketId, ticketNumber, attachments, stagedIds, now);

  // 7. The new-request notice, from here (EDGE-8), awaited.
  const notified = await announce({ req, orgId, ticketId, title: input.title, input, unit: unit.unit, callerId: caller.id, email });

  // Kick the email drain after the response (the daily cron is the fallback).
  const drainUrl = new URL("/api/notifications/send-queued", req.url);
  const drainToken = process.env.CRON_SECRET || caller.token;
  after(async () => {
    try {
      await fetch(drainUrl, { method: "POST", headers: { Authorization: `Bearer ${drainToken}` } });
    } catch { /* the cron drains it */ }
  });

  return { ok: true, id: ticketId, ticketNumber, resumed: false, notified, ...(unmoved > 0 ? { unmovedAttachments: unmoved } : {}) };
}

/** Copy each staged file under orgs/<org>/tickets/<number>/, point the row
 *  at the copies (compare-and-set on the row's last_modified, which it bumps
 *  so a concurrent writer that read the staged keys loses its own
 *  compare-and-set), then delete the staged originals. A file that cannot be
 *  moved keeps its staged key on the row — it is never left unreferenced.
 *  Returns how many stayed where they were staged. */
async function rekeyAttachments(
  orgId: string, ticketId: string, ticketNumber: string, attachments: TicketAttachment[],
  stagedIds: Set<string>, insertedAt: string,
): Promise<number> {
  const staged = attachments.filter((a) => stagedIds.has(a.id));
  const moves = new Map<string, string>();   // attachment id → final key
  for (const a of staged) {
    const to = finalAttachmentKey(orgId, ticketNumber, a.url);
    try {
      await r2.send(new CopyObjectCommand({ Bucket: R2_BUCKET, Key: to, CopySource: copySource(a.url) }));
      moves.set(a.id, to);
    } catch (e) {
      console.warn(`[tickets/create] could not move ${a.url} under ${ticketNumber} (kept where it was staged):`, (e as Error)?.message ?? e);
    }
  }
  if (moves.size === 0) return staged.length;

  const stagedKeyOf = new Map(staged.map((a) => [a.id, a.url]));
  let token = insertedAt;
  let current = attachments;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Only an entry that still names its staged key is pointed at the copy.
    const next = current.map((a) => (moves.has(a.id) && a.url === stagedKeyOf.get(a.id) ? { ...a, url: moves.get(a.id)! } : a));
    const w = await checkedWrite(supabaseAdmin.from("tickets")
      .update({ attachments: next, last_modified: new Date().toISOString() })
      .eq("id", ticketId).eq("last_modified", token)
      .select("id"));
    if (w.ok) {
      await deleteObjects([...moves.keys()].map((id) => stagedKeyOf.get(id)!));
      return staged.length - moves.size;
    }
    // Someone wrote the row in between: re-read it once and move the same
    // files on top of what they wrote.
    const { data: fresh, error } = await supabaseAdmin
      .from("tickets").select("attachments, last_modified").eq("id", ticketId).maybeSingle();
    if (error || !fresh) break;
    token = String((fresh as { last_modified: string }).last_modified);
    current = ((fresh as { attachments?: TicketAttachment[] | null }).attachments ?? []);
  }
  // The row still names the staged keys: drop the copies, keep the originals.
  await deleteObjects([...moves.values()]);
  return staged.length;
}

/** The new-request notice to the assignment queue: bell + preference-aware
 *  email through emit(), as the service role (lib/serverClientScope), with
 *  metadata.action / status (ROUTE-11). Returns whether it ran. */
async function announce(p: {
  req: NextRequest; orgId: string; ticketId: string; title: string; input: TicketCreateInput;
  unit: string | null; callerId: string; email: string | null;
}): Promise<boolean> {
  try {
    const recipients = await resolveTicketRecipients(p.orgId, "PENDING_ASSIGNMENT", p.callerId, supabaseAdmin);
    if (recipients.length === 0) return true;
    const notice = creationNotice(p.input.origin, p.title);
    const link = `/requests/${p.ticketId}`;
    // EDGE-9's convention: a link in an EMAIL is absolute — the configured
    // public origin, else the origin this request arrived on.
    const origin = (publicOrigin() || new URL(p.req.url).origin).replace(/\/+$/, "");
    const emailLink = `${origin}${link}`;
    await runWithServerClient(supabaseAdmin, () => emit({
      orgId: p.orgId,
      category: "assignment",
      kind: "request_pending_approval",
      title: notice.title,
      body: notice.body,
      link,
      resource: { type: "ticket", id: p.ticketId },
      actorUserId: p.callerId,
      actorName: p.email?.split("@")[0],
      audience: { involved: recipients.map((m) => m.uid) },
      email: {
        bodyText: `${notice.title}\n\n${notice.body}\n\n${emailLink}`,
        bodyHtml: `<p><b>${escapeHtml(notice.title)}</b></p><p>${escapeHtml(notice.body)}</p><p><a href="${escapeHtml(emailLink)}">Open the request</a></p>`,
      },
      metadata: {
        action: "created",
        status: "PENDING_ASSIGNMENT",
        request_type: p.input.requestType,
        priority: p.input.priority,
        unit: p.unit,
      },
    }));
    return true;
  } catch (e) {
    console.error(`[tickets/create] new-request notice for ${p.ticketId} failed (the request is filed):`, e);
    return false;
  }
}

export async function DELETE(req: NextRequest) {
  const caller = await authenticate(req);
  if (!caller) return json(401, { error: "Unauthorized" });
  let raw: unknown;
  try { raw = await req.json(); } catch { return json(400, { error: "Invalid JSON body" }); }
  const r = (raw ?? {}) as { orgId?: unknown; keys?: unknown };
  const orgId = typeof r.orgId === "string" ? r.orgId : "";
  const keys = Array.isArray(r.keys) ? r.keys.filter((k): k is string => typeof k === "string") : [];
  if (!orgId || keys.length === 0 || keys.length > 50) return json(400, { error: "orgId and up to 50 keys are required" });
  const own = keys.filter((k) => isSafeStorageKey(k) && isStagedKeyOf(k, orgId, caller.id));
  // A staged key a ticket already names (a re-key that did not complete) is
  // a record's file, not a leftover: never deleted here.
  const discard: string[] = [];
  for (const key of own) {
    const { data, error } = await supabaseAdmin
      .from("tickets").select("id").eq("org_id", orgId)
      .contains("attachments", JSON.stringify([{ url: key }])).limit(1);
    if (error) return json(503, { error: "Couldn't check the files against the requests — try again." });
    if (!data || (data as unknown[]).length === 0) discard.push(key);
  }
  await deleteObjects(discard);
  return json(200, { ok: true, deleted: discard.length, refused: keys.length - discard.length });
}
