import { NextRequest, NextResponse, after } from "next/server";
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { r2, R2_BUCKET } from "@/lib/r2";
import { callerScopedClient } from "@/lib/serverAuth";
import { runWithServerClient } from "@/lib/serverClientScope";
import { isSafeStorageKey } from "@/lib/storageKey";
import { publicOrigin } from "@/lib/publicOrigin";
import { checkedWrite, isMissingSchemaError } from "@/lib/checkedWrite";
import { declarationSignatureRefusal, isMissingReviewModelColumn, type DeclarationSignatureRow } from "@/lib/reviewModel";
import { formatTicketNumber, ticketNumberConfigFromRow } from "@/lib/ticketNumber";
import { boundedSlaDays, defaultSlaTargetDate, slaTargetDateInDays } from "@/lib/notifications";
import { missingLibraryColumn } from "@/lib/ticketLibrary";
import { resolveTicketRecipients } from "@/lib/ticketRouting";
import { emit } from "@/lib/notify/dispatch";
import { escapeHtml } from "@/lib/ticketTransitions";
import { memberHoldsAny } from "@/lib/roleHeld";
import { logAuditAction } from "@/lib/audit";
import { buildSourceDocumentRef, unitOfDocumentMetadata, type SourceDocumentRefRow } from "@/lib/sourceDocRef";
import {
  parseTicketCreateBody, unitOptionsFor, unitListReadFailure, resolveUnit, resolveDerivedUnit, requestTypeAllowed, missingRequiredCustomField,
  stampedRequesterRole, stampedRequesterName, openingHistory, creationNotice, insertFailureKind,
  isStagedKeyOf, finalAttachmentKey, attachmentSizeLabel, requestNumberYear, checkinNoteOf, psmAlertNotice,
  type CreatorMember, type TicketCreateInput, type TicketCreateAttachment, type TicketCreateOrigin, type CheckinMoc,
} from "@/lib/ticketCreate";
import type { PsmAlertOutcome } from "@/lib/ticketCreateClient";
import type { OrgDraftingSettings, TicketAttachment } from "@/types/schema";

// POST /api/tickets/create — the ONE way a drafting request is filed
// (drafting-flow Round G, DF-P2 CREATE).
//
// The request form, a document check-in and an intake collision all post the
// lib/ticketCreate.ts contract here. This route:
//   1. authenticates the caller (bearer token) and reads their ACTIVE
//      membership of the workspace (403 otherwise);
//   2. validates the contract against the workspace's own rules — the
//      configured request types, the required custom fields (the request
//      form's origin), the unit list (FRIC-8 / FRIC-3 / DCW-7: the one list
//      the form offers, lib/ticketCreate.ts unitOptionsFor — a list that is
//      there but could not be read fails CLOSED: the unit given is not
//      checked, the request files as "Unit unknown" with the unit given kept
//      on the record, metadata.unit_unchecked, and the answer says so), the
//      staged attachments (under the caller's own pending prefix, in
//      storage), the library references (under this workspace's prefix, an
//      http(s) URL, or a legacy non-org-prefixed key — which
//      storage/upload-url still admits — that a document version of this
//      workspace carries), and
//      the origin's own facts (a check-in names a checkout of the document by
//      this requester; a collision names an intake sheet in the project's
//      intake folder, and that project's intake link) — BEFORE anything is
//      allocated or written. Source documents are read AS THE CALLER, so the
//      document ACL (documents_acl_select) applies: one they cannot see is
//      treated exactly like one that is not in the workspace. A hand-off the
//      route cannot use (a source document since removed or not visible, a
//      library reference the workspace does not hold, sheets past
//      MAX_SOURCE_DOCUMENTS) is dropped with a warning, never a refusal;
//   3. for a check-in, resumes the ticket the same check-in episode already
//      filed for this requester instead of filing a second (LEAK-6) — and
//      sends that ticket's creation notice if it never went out (no
//      metadata.created_notice_at stamp: the first attempt ended between the
//      insert and the notice, or the notice failed) and its PSM escalation if
//      that never went out (no metadata.psm_escalated_at stamp);
//   4. allocates the request number only now (EDGE-13: a refused submit
//      never spends one), in the requester's calendar year when it is a year
//      in force somewhere right now (requestNumberYear), and gives it back
//      only when the insert definitely did not commit (lib/ticketCreate.ts
//      insertFailureKind) and no later number was handed out;
//   5. inserts the row under the service role, REPLICATING 20261038's
//      ticket_insert_integrity (which a service-role insert bypasses): the
//      requester is the caller, the requester_role one they hold (else their
//      headline), the email their membership's, the status PENDING_ASSIGNMENT,
//      nothing assigned, approved, closed or archived, the request type a
//      configured one — and the requester's name from the membership too
//      (AUTHZ-3);
//   6. fans the new-request notice out from HERE, awaited, right after the
//      insert (EDGE-8) — before any file is moved, so a slow copy can never
//      cost the queue its notice: the bell rows through the typed sink and
//      the email rows preference-aware (lib/notify/dispatch emit(), run as
//      the service role, so the recipient's opt-out is read where it is
//      visible — EDGE-1, EDGE-12), both carrying metadata.action/status so
//      the workflow route's supersede and the badge's reconcile retire them
//      once the ticket moves on (ROUTE-11), from one door for all three
//      creators (ROUTE-4) — stamped metadata.created_notice_at once sent, so
//      a retry that resumes this ticket sends it only if it never went out; a
//      notice that fails, or has nobody to go to, is ANSWERED (notified:
//      false, notifyReason), never swallowed into a 201 that looks told; then,
//      for a check-in that reports an undocumented
//      field change, the PSM escalation to the controllers (LIFE-7, safety
//      category), stamped metadata.psm_escalated_at once sent — so a retry
//      that resumes the ticket sends it only if it never went out;
//   7. answers, and AFTER the answer (next/server after()) re-keys each
//      staged attachment under the ticket's own prefix, a few at a time and
//      within the time this function has left; a file not moved stays on the
//      row at its staged key, which the row already names.
//
// DELETE /api/tickets/create — discards files a requester staged for a
// submit that never reached POST (an upload that failed part-way). Only keys
// under the caller's own pending prefix that no ticket names; the answer
// counts each key exactly once: deleted; kept (the caller's own, but a
// ticket names it); unchecked (the caller's own, but the reference check
// could not be made — the orphan sweep reclaims it); foreign (not the
// caller's own staged file — never touched).

export const runtime = "nodejs";
export const maxDuration = 60;

/** The re-key starts no copy after this long into the request, and abandons
 *  a copy still running at REKEY_ABORT_AT_MS — well inside maxDuration, so
 *  the function answers instead of being killed after the ticket exists. */
const REKEY_START_BY_MS = 35_000;
const REKEY_ABORT_AT_MS = 50_000;

/** A refusal or failure. `keepStaged`: the outcome is not known to be
 *  "nothing filed", so the staged files stay for the reference-based orphan
 *  sweep instead of being deleted under a row that may name them. */
type Fail = { status: number; field?: string; error: string; code?: string; keepStaged?: boolean };

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status });

const UNCONFIRMED = "Couldn't confirm the request was saved — check the queue before you submit it again.";

/** Who receives a PSM escalation: the workspace's controllers (Admin or
 *  DocCtrl, headline or additive — is_org_controller's set). */
const PSM_CONTROLLER_ROLES = ["Admin", "DocCtrl"] as const;

/** Source documents are read in chunks this size (a PostgREST `in` list
 *  travels in the URL). */
const SOURCE_READ_CHUNK = 100;

function copySource(key: string): string {
  return `${R2_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/** Run `fn` over `items`, at most `limit` at a time. */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function deleteObjects(keys: string[]): Promise<void> {
  await eachLimited(keys, 8, async (key) => {
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    } catch (e) {
      console.warn(`[tickets/create] could not delete ${key} (the orphan sweep reclaims it):`, (e as Error)?.message ?? e);
    }
  });
}

/** EDGE-13: delete staged keys that no ticket names — the one guard every
 *  discard of staged files goes through (a refusal, a parse failure, a
 *  resumed check-in, DELETE). A staged key a ticket's attachments name (a
 *  re-key that did not complete) is that record's file, never a leftover
 *  (`kept`); a key whose check cannot be made (`unchecked`) is left for the
 *  orphan sweep, which works by reference (lib/storageOrphans). */
async function discardUnreferencedStaged(orgId: string, keys: string[]): Promise<{ deleted: number; kept: number; unchecked: number }> {
  const discard: string[] = [];
  let kept = 0;
  let unchecked = 0;
  await eachLimited(keys, 8, async (key) => {
    const { data, error } = await supabaseAdmin
      .from("tickets").select("id").eq("org_id", orgId)
      .contains("attachments", JSON.stringify([{ url: key }])).limit(1);
    if (error) { unchecked++; return; }
    if (!data || (data as unknown[]).length === 0) discard.push(key);
    else kept++;
  });
  await deleteObjects(discard);
  return { deleted: discard.length, kept, unchecked };
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
  collection_id?: string | null;
  /** GAP-105 (DF-P4): the document's library — the root of the one
   *  container chain (lib/containerChain.ts, DEC-36); the ticket targets it. */
  library_id?: string | null;
  metadata: Record<string, unknown> | null;
  unit_code?: string | null;
}

/** The source documents, read in THIS workspace AS THE CALLER (`client` is
 *  callerScopedClient's): documents_acl_select / node_visible apply, so a
 *  document in a library the caller cannot open never lends its number,
 *  title, revision, version or unit to a ticket the whole workspace reads —
 *  it is simply not returned, exactly like one that is not here.
 *  documents.unit_code is intelligence 20261138's (pending paste): without it
 *  the read is retried without the column and the unit comes from the
 *  document's metadata. */
async function readSourceDocuments(client: SupabaseClient, orgId: string, ids: string[]): Promise<SourceRow[] | "error"> {
  const out: SourceRow[] = [];
  const base = "id, document_number, title, name, rev, current_version_id, collection_id, library_id, metadata";
  for (let i = 0; i < ids.length; i += SOURCE_READ_CHUNK) {
    const chunk = ids.slice(i, i + SOURCE_READ_CHUNK);
    const first = await client.from("documents").select(`${base}, unit_code`).eq("org_id", orgId).in("id", chunk);
    if (!first.error) { out.push(...((first.data ?? []) as SourceRow[])); continue; }
    const code = String((first.error as { code?: string }).code ?? "");
    const msg = String(first.error.message ?? "");
    if (!(code === "42703" || code === "PGRST204" || /unit_code/.test(msg))) return "error";
    const again = await client.from("documents").select(base).eq("org_id", orgId).in("id", chunk);
    if (again.error) return "error";
    out.push(...((again.data ?? []) as SourceRow[]));
  }
  return out;
}

/** A source document's own label — what the intake panel and the check-in
 *  panel show for it — from the row, never from the client. */
function documentLabel(doc: SourceRow): string {
  return String(doc.document_number || doc.title || doc.name || "Document");
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

/** A library hand-off the route can attach as a Source, kept as it came, as
 *  the form always did: an http(s) URL (a version whose file_url is a URL —
 *  the viewers resolve both); a key under THIS workspace's prefix; or a
 *  legacy key from before the orgs/ prefix (which storage/upload-url still
 *  admits) that the register carries — a document_versions row's file_url
 *  or source_file_key, looked up by exact equality as upload-url does — for
 *  a document in this workspace. Both reads are the CALLER's
 *  (document_versions_acl_select, documents_acl_select): no other
 *  workspace's register, and no document the caller cannot open, is ever
 *  read for it. A key under another workspace's prefix, or one the caller's
 *  register does not carry, is not usable. "error": the register could not
 *  be read. */
async function sourceReferenceUsable(key: string, orgId: string, callerClient: SupabaseClient): Promise<boolean | "error"> {
  if (/^https?:\/\//i.test(key)) {
    try { return /^https?:$/.test(new URL(key).protocol); } catch { return false; }
  }
  if (!isSafeStorageKey(key)) return false;
  if (key.startsWith(`orgs/${orgId}/`)) return true;
  if (/^orgs\//i.test(key)) return false;
  const docIds = new Set<string>();
  for (const col of ["file_url", "source_file_key"] as const) {
    const { data, error } = await callerClient.from("document_versions").select("record_id").eq(col, key).limit(20);
    if (error) return "error";
    for (const v of (data ?? []) as Array<{ record_id?: string | null }>) if (typeof v.record_id === "string") docIds.add(v.record_id);
  }
  if (docIds.size === 0) return false;
  const { data: docs, error } = await callerClient.from("documents").select("id").eq("org_id", orgId).in("id", [...docIds]).limit(1);
  if (error) return "error";
  return ((docs ?? []) as unknown[]).length > 0;
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const caller = await authenticate(req);
  if (!caller) return json(401, { error: "Unauthorized" });

  let raw: unknown;
  try { raw = await req.json(); } catch { return json(400, { error: "Invalid JSON body", field: "body" }); }
  const parsed = parseTicketCreateBody(raw);
  if (!parsed.ok) {
    const own = stagedKeysIn(raw, caller.id);
    if (own) await discardUnreferencedStaged(own.orgId, own.keys);
    return json(400, { error: parsed.error, field: parsed.field });
  }
  const input = parsed.input;
  const stagedKeys = input.attachments.filter((a) => a.kind === "staged").map((a) => a.key);

  const outcome = await create(req, caller, input, startedAt, parsed.warnings);
  if ("status" in outcome) {
    // Nothing was written (EDGE-13): the caller's staged files go too —
    // unless the outcome is not known (keepStaged), or a ticket names them.
    if (!outcome.keepStaged) {
      await discardUnreferencedStaged(input.orgId, stagedKeys.filter((k) => isStagedKeyOf(k, input.orgId, caller.id)));
    }
    return json(outcome.status, { error: outcome.error, ...(outcome.field ? { field: outcome.field } : {}), ...(outcome.code ? { code: outcome.code } : {}) });
  }
  return json(outcome.resumed ? 200 : 201, outcome);
}

/** Staged keys a refused body named, for cleanup — only the caller's own. */
function stagedKeysIn(raw: unknown, uid: string): { orgId: string; keys: string[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { orgId?: unknown; attachments?: unknown };
  if (typeof r.orgId !== "string" || !Array.isArray(r.attachments)) return null;
  const orgId = r.orgId;
  const keys = r.attachments
    .map((a) => (a && typeof a === "object" ? (a as { key?: unknown }).key : null))
    .filter((k): k is string => typeof k === "string" && isStagedKeyOf(k, orgId, uid));
  return keys.length > 0 ? { orgId, keys } : null;
}

type Created = {
  ok: true;
  id: string;
  ticketNumber: string;
  resumed: boolean;
  /** Whether the assignment queue was told (EDGE-8): false when the notice
   *  failed or had nobody to go to — `notifyReason` says which. A resumed
   *  ticket answers true when its notice had already gone out. */
  notified: boolean;
  notifyReason?: string;
  /** A check-in's PSM escalation, when this request sent (or tried to send)
   *  one — absent when there was none to send or it had already gone. */
  psmAlert?: PsmAlertOutcome;
  /** What the request was filed WITHOUT (an unusable hand-off), in words. */
  warnings?: string[];
};

async function create(
  req: NextRequest,
  caller: { id: string; email: string | null; token: string },
  input: TicketCreateInput,
  startedAt: number,
  parseWarnings: string[] = [],
): Promise<Created | Fail> {
  const orgId = input.orgId;
  const warnings: string[] = [...parseWarnings];

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
  // would stop a hazard report on an admin's form setting) — those origins
  // are checked against their own facts below instead.
  if (input.origin.kind === "portal") {
    const missing = missingRequiredCustomField(cfg, input.customCategories);
    if (missing) return { status: 400, field: missing.field, error: missing.error };
  }

  // The unit list — the SAME resolver the form calls (unitOptionsFor): the
  // saved units, else the codebook's, else none. A codebook that is not
  // there (20260928 not pasted) is "no list" — free text, as the form shows;
  // a codebook that IS there but could not be read is a list the unit cannot
  // be checked against (unitListUnreadable, applied once the unit is settled
  // below) — the form says the same when its own read fails
  // (unitListReadFailure classes both reads).
  let codebookUnits: Array<{ code: string; label: string | null }> = [];
  let unitListUnreadable = false;
  if (!((cfg?.units?.options?.length ?? 0) > 0)) {
    const { data: cb, error: cbErr } = await supabaseAdmin
      .from("codebook_entries").select("code, label").eq("org_id", orgId).eq("kind", "unit");
    const failure = unitListReadFailure(cbErr);
    if (failure === "unreadable") unitListUnreadable = true;
    else if (failure === "none") codebookUnits = ((cb ?? []) as Array<{ code: string; label: string | null }>).filter((u) => !!u.code);
  }
  const unitOptions = unitOptionsFor(cfg, codebookUnits);
  let unit = resolveUnit(input.unit, unitOptions);
  if (unit.kind === "unmatched" && input.origin.kind === "portal") {
    return { status: 400, field: "unit", error: `"${input.unit}" is not on this workspace's unit list — pick one, or "Unit unknown".` };
  }

  // The caller's own client: the library references and the source
  // documents are read with it (the document ACL applies), and the request
  // number is allocated with it.
  const caller_client = callerScopedClient(req);
  if ("error" in caller_client) return { status: caller_client.status, error: caller_client.error };

  // Attachments: a staged file is the caller's own, under their pending
  // prefix, and is in storage (checked a few at a time); a Source reference
  // names a file in this workspace (its prefix, or a legacy key the register
  // carries), or a URL — one that does neither is dropped with a warning (a
  // stale hand-off never blocks the request). Checked before a number is
  // spent.
  const kept: TicketCreateAttachment[] = [];
  const staged: TicketCreateAttachment[] = [];
  for (const a of input.attachments) {
    if (a.kind === "staged") {
      if (!isSafeStorageKey(a.key) || !isStagedKeyOf(a.key, orgId, caller.id)) {
        return { status: 400, field: "attachments", error: `"${a.name}" was not staged by you for this workspace.` };
      }
      staged.push(a);
      kept.push(a);
      continue;
    }
    const usable = await sourceReferenceUsable(a.key, orgId, caller_client);
    if (usable === "error") return { status: 503, error: `Couldn't check the attached library file "${a.name}" against the register — try again in a moment.` };
    if (usable) kept.push(a);
    else warnings.push(`"${a.name}" was not attached: it is not a file in this workspace.`);
  }
  const stagedSizes = new Map<string, number | null>();
  const missingFiles: string[] = [];
  let storageFault = false;
  await eachLimited(staged, 8, async (a) => {
    try {
      const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: a.key }));
      stagedSizes.set(a.key, typeof head.ContentLength === "number" ? head.ContentLength : null);
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) missingFiles.push(a.name);
      else storageFault = true;
    }
  });
  if (missingFiles.length > 0) {
    return { status: 400, field: "attachments", error: `"${missingFiles[0]}" did not finish uploading — attach it again.` };
  }
  if (storageFault) return { status: 503, error: "Couldn't check the attached files in storage — try again in a moment." };

  // Source documents: in THIS workspace and visible to the caller (a foreign
  // id is never stored — SM-14's input; a restricted one never lends its
  // fields), each with the version it was raised against. One that is not
  // here or not visible (removed since the hand-off, never ours, or in a
  // library the caller cannot open) is dropped with a warning; the request
  // is still filed.
  const docs = await readSourceDocuments(caller_client, orgId, input.sourceDocuments.map((d) => d.id));
  if (docs === "error") return { status: 503, error: "Couldn't read the source document — try again in a moment." };
  const byId = new Map(docs.map((d) => [d.id, d]));
  const refs: SourceDocumentRefRow[] = [];
  for (const s of input.sourceDocuments) {
    const doc = byId.get(s.id);
    if (!doc) {
      const label = s.documentNumber || s.title;
      warnings.push(`${label ? `The linked document ${label} is` : "A linked document is"} not in this workspace (it may have been removed) — the request was filed without that link.`);
      continue;
    }
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

  // The origin's own facts. Required custom fields and the unit-list refusal
  // bind the request form only; a caller who names another origin is held
  // to that origin's facts (what is checked, per origin: checkOrigin).
  const checked = await checkOrigin(input, orgId, caller.id, primary, byId, caller_client);
  if ("status" in checked) return checked;
  const origin = checked.origin;
  warnings.push(...checked.warnings);

  // FRIC-3 done-when 2: no unit given → the source document's own, when it
  // names one, resolved against the list like any other: its metadata unit
  // (what the check-in and the collision always wrote), then its codebook
  // unit_code — the first ON the list wins, else the first given, marked.
  if (unit.kind === "none" && primary) {
    const doc = byId.get(primary.id)!;
    unit = resolveDerivedUnit([unitOfDocumentMetadata(doc.metadata), typeof doc.unit_code === "string" ? doc.unit_code : null], unitOptions);
  }
  // DCW-7 / FRIC-3: the list exists but could not be read, so a unit — typed
  // or derived — cannot be checked against it. Fail closed, consistently with
  // the form's own answer: the request files as "Unit unknown" (triage
  // assigns it), the unit given stays on the record (metadata.unit_unchecked)
  // and the answer says so — never refused, never admitted unchecked.
  let unitUnchecked: string | null = null;
  if (unitListUnreadable && unit.unit != null) {
    unitUnchecked = unit.unit;
    unit = { kind: "none", unit: null };
    warnings.push(`The unit "${unitUnchecked}" could not be checked against this workspace's unit list — the request was filed as "Unit unknown" (triage assigns it); the unit given is on the record.`);
  }

  const reporter = stampedRequesterName(member, caller.email);
  const email = member.email || caller.email;

  // 3. LEAK-6: a check-in that already filed its ticket resumes it — keyed on
  //    the check-in episode, for this requester, while the ticket is open.
  //    EDGE-8: if that ticket's creation notice never went out (no
  //    created_notice_at stamp — the first attempt ended between the insert
  //    and the notice, or the notice failed) and the ticket is still waiting
  //    in the queue (PENDING_ASSIGNMENT), it is sent now, once.
  //    LIFE-7: if that ticket records an undocumented field change whose PSM
  //    escalation never went out (no psm_escalated_at stamp — the first
  //    attempt's answer said it failed, or the attempt ended before it was
  //    sent), it is sent now; a ticket already escalated is never escalated
  //    twice. Both follow the TICKET's record, as first filed.
  if (origin.kind === "checkin" && origin.episodeId) {
    const { data: prior, error: priorErr } = await supabaseAdmin
      .from("tickets").select("id, ticket_id, status, title, description, request_type, priority, unit, metadata, last_modified")
      .eq("org_id", orgId)
      .eq("requester_id", caller.id)
      .eq("metadata->checkin->>episodeId", origin.episodeId)
      .not("status", "in", '("CLOSED","CANCELED")')
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (priorErr) return { status: 503, error: "Couldn't check whether this check-in already filed its request — try again in a moment." };
    if (prior) {
      await discardUnreferencedStaged(orgId, staged.map((a) => a.key));
      const p = prior as {
        id: string; ticket_id: string; status?: string | null; title?: string | null; description?: string | null; request_type?: string | null;
        priority?: number | null; unit?: string | null; metadata?: Record<string, unknown> | null; last_modified?: string | null;
      };
      let known: RowKnown | null = p.last_modified ? { metadata: p.metadata ?? {}, lastModified: String(p.last_modified) } : null;
      let meta = p.metadata ?? {};
      // The notice asks the queue to pick the ticket up: one already off
      // PENDING_ASSIGNMENT was picked up, and a creation alert for it would
      // be stale (the badge's reconcile retires it, ROUTE-11) — none owed.
      let notice: Announced = { ok: true };
      if (!meta.created_notice_at && p.status === "PENDING_ASSIGNMENT") {
        notice = await announce({
          req, orgId, ticketId: p.id, title: String(p.title ?? ""), origin,
          requestType: String(p.request_type ?? ""), priority: Number(p.priority ?? 0),
          unit: typeof p.unit === "string" ? p.unit : null, callerId: caller.id, email,
        });
        if (notice.ok) {
          const stamped = await stampCreationNotice(p.id, p.ticket_id, known);
          if (stamped) { known = stamped; meta = stamped.metadata; }
        }
      }
      let psmAlert: PsmAlertOutcome | undefined;
      if (meta.undocumented_change === true && !meta.psm_escalated_at) {
        const m = (meta.moc && typeof meta.moc === "object" ? meta.moc : null) as { status?: unknown; number?: unknown } | null;
        const priorMoc: CheckinMoc | null = m
          ? { status: (m.status ?? null) as CheckinMoc["status"], number: typeof m.number === "string" ? m.number : null }
          : null;
        psmAlert = await escalatePsm({
          req, orgId, ticketId: p.id, callerId: caller.id, reporter, email,
          docLabel: primary ? documentLabel(byId.get(primary.id)!) : "Document",
          note: checkinNoteOf(String(p.description ?? ""), priorMoc),
          known,
        });
      }
      return {
        ok: true, id: p.id, ticketNumber: p.ticket_id, resumed: true,
        notified: notice.ok, ...(notice.ok ? {} : { notifyReason: notice.reason }),
        ...(psmAlert ? { psmAlert } : {}),
      };
    }
  }

  // GAP-110 / DEC-33 / DEC-34 (DF-P6): the like-in-kind declaration. Checked
  // BEFORE a request number is spent (EDGE-13): its e-signature was minted by
  // /api/signatures/sign, by this requester, in this workspace, for the id
  // this request is filed under (`ticketKey`), over the statement they
  // typed, recently — and that id is not already a request. Absent: no
  // declaration — the request is engineered work (engineering_required
  // defaults true at the database), whoever files it.
  const declaration = input.declaration ?? null;
  if (declaration) {
    const { data: sig, error: sigErr } = await supabaseAdmin
      .from("e_signatures").select("id, org_id, resource_type, resource_id, signer_user_id, statement, intent, signed_at")
      .eq("id", declaration.signatureId).maybeSingle();
    if (sigErr) return { status: 503, field: "declaration", error: "Couldn't check the like-in-kind declaration's signature — try again in a moment." };
    const refusal = declarationSignatureRefusal(sig as DeclarationSignatureRow | null, {
      orgId, ticketKey: declaration.ticketKey, requesterId: caller.id, statement: declaration.statement, now: Date.now(),
    });
    if (refusal) return { status: 400, field: "declaration", error: refusal };
    const { data: taken, error: takenErr } = await supabaseAdmin.from("tickets").select("id, ticket_id").eq("id", declaration.ticketKey).maybeSingle();
    if (takenErr) return { status: 503, error: "Couldn't confirm the request was not already filed — try again in a moment." };
    if (taken) {
      return { status: 409, field: "declaration", code: "declaration_used", error: `This declaration was already filed as ${String((taken as { ticket_id?: string }).ticket_id ?? "a request")} — check the queue before you submit it again.` };
    }
  }

  // 4. The request number — allocated only now, as the caller (the counter
  //    function admits active members only, and reads auth.uid()). Its
  //    format is read first, and CHECKED: a failed read never files a number
  //    without the workspace's prefix. The year is the requester's own
  //    (their clock) when it is a calendar year in force somewhere right
  //    now, else the server's UTC year — never another year's counter.
  const year = requestNumberYear(Date.now(), input.localYear);
  const { data: orgRow, error: orgErr } = await supabaseAdmin
    .from("orgs").select("ticket_prefix, ticket_record_code, ticket_number_pad").eq("id", orgId).maybeSingle();
  if (orgErr) {
    const code = String((orgErr as { code?: string }).code ?? "");
    return {
      status: 503,
      error: code === "42703"
        ? "Ticket numbering isn't set up yet — apply migration 20260724_ticket_numbering.sql."
        : "Couldn't read this workspace's request numbering — try again in a moment.",
    };
  }
  const numberCfg = ticketNumberConfigFromRow(orgRow as Record<string, unknown> | null);

  // EDGE-7 done-when 2 / ROUTE-9 done-when 4 (DF-P4): the request's due date
  // is the one the requester named, else the workspace's own window for the
  // type (sla_defaults — the window the SLA clock already reads for a ticket
  // with no target, lib/ticketSla.ts), else the built-in DEFAULT_SLA_DAYS. A
  // window that cannot be read falls back to the built-in default (a due
  // date is not authority; the failure is logged).
  let targetCompletionAt = input.targetCompletionAt;
  if (!targetCompletionAt) {
    const { data: slaRow, error: slaErr } = await supabaseAdmin
      .from("sla_defaults").select("default_days").eq("org_id", orgId).eq("request_type", input.requestType).maybeSingle();
    if (slaErr) console.warn(`[tickets/create] sla_defaults could not be read for ${orgId}/${input.requestType} (${slaErr.message}); the built-in window is used`);
    // DF-P4 fix pass: until 20261218 is pasted any active member can write
    // sla_defaults (EDGE-16), and after it a row stored before the paste may
    // still be outside the bound (its CHECK is then NOT VALID), so the window
    // is bounded here — a whole number of days, 1 to SLA_DEFAULT_DAYS_MAX —
    // and a value outside it (or a date that cannot be computed) is the
    // built-in window, never a refused request.
    const rawDays = (slaRow as { default_days?: unknown } | null)?.default_days;
    const days = slaErr ? null : boundedSlaDays(rawDays);
    if (!slaErr && days === null && rawDays !== undefined && rawDays !== null) {
      console.warn(`[tickets/create] sla_defaults.default_days for ${orgId}/${input.requestType} is out of bounds (${String(rawDays).slice(0, 40)}); the built-in window is used`);
    }
    let fromWindow: string | null = null;
    if (days !== null) {
      try { fromWindow = slaTargetDateInDays(days); } catch { fromWindow = null; }
    }
    targetCompletionAt = fromWindow ?? defaultSlaTargetDate(input.requestType);
  }

  // 5. The row — 20261038 ticket_insert_integrity, replicated.
  const now = new Date().toISOString();
  const requesterRole = stampedRequesterRole(input.requesterRole, member);
  const attachments: TicketAttachment[] = kept.map((a) => ({
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
  if (unitUnchecked) metadata.unit_unchecked = unitUnchecked;        // DCW-7: given, but the list could not be read
  // EDGE-8 (DF-P4): the queue's creation notice is owed — created_notice_at
  // (stamped once it is out) settles it; lib/ticketLibrary.ts
  // creationNoticeOwed reads the pair, so a ticket filed before this marker
  // existed is never mistaken for an unannounced one.
  metadata.created_notice_owed = true;
  if (origin.kind === "checkin") {
    const o = origin;
    metadata.checkin = { episodeId: o.episodeId, checkoutNumber: o.checkoutNumber, purpose: o.purpose, outcome: o.outcome };
    if (o.moc) metadata.moc = { status: o.moc.status, number: o.moc.status === "none" ? null : o.moc.number };
    if (o.minorCorrection) metadata.minor_correction = true;
    if (o.undocumentedChange) metadata.undocumented_change = true;
  } else if (origin.kind === "intake_collision") {
    const o = origin;
    metadata.intake_collision = {
      projectId: o.projectId,
      intakeLinkId: o.intakeLinkId,
      numberCollisionDocId: o.numberCollisionDocId,
      overlaps: o.overlaps,
      // Every overlap the scan reported is stored up to
      // MAX_COLLISION_OVERLAPS; past it, the full count and a flag say so.
      ...(o.overlapsTruncated ? { overlapsTotal: o.overlapsTotal, overlapsTruncated: true } : {}),
      flaggedAt: now,
    };
  }

  const row: Record<string, unknown> = {
    org_id: orgId,
    ticket_id: "",
    title: input.title,
    description: input.description,
    unit: unit.unit,
    request_type: input.requestType,
    priority: input.priority,
    status: "PENDING_ASSIGNMENT",
    requester_id: caller.id,
    requester_name: reporter,
    requester_email: email,
    requester_role: requesterRole,
    attachments,
    // The role the requester FILED under (the stamped one, as requester_role
    // says) — never their headline when they hold the one they chose.
    history: openingHistory({ origin, email, role: requesterRole, now, primary }),
    comments: [],
    unread_by: [],
    // The requester follows their own request.
    watchers: [caller.id],
    target_completion_at: targetCompletionAt,
    // ticket_insert_integrity (20261195) does not run for the service role:
    // this route never writes sla_breached_at, sla_breach_warned_at or
    // outcome — a request is born on the SLA clock and not ended (pinned by
    // lib/__tests__/dfRoundG_P4_library.test.ts).
    created_at: now,
    last_modified: now,
  };
  if (Object.keys(metadata).length > 0) row.metadata = metadata;
  // GAP-105 / DCW-1 (DF-P4): the library is the primary source document's —
  // derived, never asked for (99-fix-sequencing Phase 2 item 1). With no
  // source document it stays unset and triage sets it.
  const primaryLibrary = primary ? (byId.get(primary.id)?.library_id ?? null) : null;
  if (primaryLibrary) row.library_id = primaryLibrary;
  // GAP-110 / DEC-34 (DF-P6): a declared request is filed under the id its
  // signature names, with the declaration in columns the guard makes
  // immutable (20261250) and engineering_required false — the one thing
  // that lowers it, at creation, by the requester. With no declaration
  // nothing is written for it: the column's default (true) is the safe
  // answer.
  if (declaration) {
    row.id = declaration.ticketKey;
    row.like_in_kind_statement = declaration.statement;
    row.like_in_kind_declared_by = caller.id;
    row.like_in_kind_declared_at = now;
    row.like_in_kind_signature_id = declaration.signatureId;
    row.engineering_required = false;
    // GAP-110 acceptance 4: the declaration renders attributed in the
    // ticket's history too (the requester's own words, signed).
    (row.history as Array<Record<string, unknown>>).push({
      action: "Declared like-in-kind (signed)", user: email, role: requesterRole, date: now,
      details: declaration.statement,
    });
  }

  let ticketNumber = "";
  let ticketId = "";
  for (let attempt = 0; !ticketId; attempt++) {
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
    ticketNumber = formatTicketNumber(numberCfg, year, seq);
    row.ticket_id = ticketNumber;

    let { data: inserted, error: insErr } = await supabaseAdmin.from("tickets").insert(row).select("id").single();
    // GAP-105 (DF-P4): before 20261208 is pasted tickets.library_id is not
    // there (42703 / PGRST204) — Postgres refused the insert, nothing was
    // written, so the same number is retried without the library (today's
    // path: the ticket has no library).
    if (insErr && "library_id" in row && missingLibraryColumn(insErr)) {
      delete row.library_id;
      ({ data: inserted, error: insErr } = await supabaseAdmin.from("tickets").insert(row).select("id").single());
    }
    // GAP-110 (DF-P6): before 20261250 is pasted the declaration's columns
    // are not there (42703 / PGRST204) — nothing was written; the same
    // number is retried without them: the request goes the usual way (the
    // role-based gate decides, as today) and the answer says the declaration
    // was not recorded. The signature stays on record against the id.
    if (insErr && declaration && "engineering_required" in row && isMissingReviewModelColumn(insErr)) {
      delete row.like_in_kind_statement;
      delete row.like_in_kind_declared_by;
      delete row.like_in_kind_declared_at;
      delete row.like_in_kind_signature_id;
      delete row.engineering_required;
      row.history = (row.history as Array<Record<string, unknown>>).filter((h) => h.action !== "Declared like-in-kind (signed)");
      warnings.push("Your like-in-kind declaration is signed but could not be recorded on the request yet (database update 20261250 is not applied) — the request was filed the usual way.");
      ({ data: inserted, error: insErr } = await supabaseAdmin.from("tickets").insert(row).select("id").single());
      if (insErr && "library_id" in row && missingLibraryColumn(insErr)) {
        delete row.library_id;
        ({ data: inserted, error: insErr } = await supabaseAdmin.from("tickets").insert(row).select("id").single());
      }
    }
    if (!insErr && inserted) {
      ticketId = String((inserted as { id: string }).id);
      break;
    }
    const settled = await settleFailedInsert({ orgId, year, seq, ticketNumber, callerId: caller.id, now, err: insErr });
    if (settled.kind === "filed") {
      ticketId = settled.id;
      break;
    }
    // The number is on another row: never given back. File under a fresh
    // number — once; a second clash is a failure, nothing filed.
    if (settled.kind === "taken" && attempt === 0) continue;
    return settled.kind === "taken"
      ? { status: 500, error: "The request could not be saved — nothing was filed. Try again." }
      : settled.fail;
  }

  // GAP-312 / WIRE-7 criterion 1 (DF-P6): the equipment the request names —
  // ticket_equipment rows (20261251), each with its asset when the request
  // form resolved one AND it is an asset of this workspace; otherwise the
  // tag as typed, flagged unresolved (asset_id null). Advisory: a failure is
  // said, never a refusal (the request is filed).
  if ((input.equipment?.length ?? 0) > 0) {
    warnings.push(...(await recordEquipment(orgId, ticketId, caller.id, input.equipment ?? [])));
  }

  // 6. The new-request notice, from here (EDGE-8), awaited — before any file
  //    is moved, so a slow copy can never cost the queue its notice — and
  //    stamped metadata.created_notice_at once it is out, so a retry that
  //    resumes this ticket sends it only if this attempt did not. A notice
  //    that fails, or has nobody to go to, is answered (notified: false with
  //    the reason), never swallowed.
  const notice = await announce({
    req, orgId, ticketId, title: input.title, origin, requestType: input.requestType, priority: input.priority,
    unit: unit.unit, callerId: caller.id, email,
  });
  let known: RowKnown = { metadata, lastModified: now };
  if (notice.ok) {
    const stamped = await stampCreationNotice(ticketId, ticketNumber, known);
    if (stamped) known = stamped;
  }

  //    LIFE-7: a check-in reporting an undocumented field change escalates
  //    to the controllers from here too — durable (it does not depend on the
  //    browser getting this answer) and stamped once sent, so a retry that
  //    resumes this ticket never sends it twice.
  let psmAlert: PsmAlertOutcome | undefined;
  if (origin.kind === "checkin" && origin.undocumentedChange) {
    psmAlert = await escalatePsm({
      req, orgId, ticketId, callerId: caller.id, reporter, email,
      docLabel: primary ? documentLabel(byId.get(primary.id)!) : "Document",
      note: checkinNoteOf(input.description, origin.moc),
      known,
    });
  }

  // 7. Re-key staged attachments under the ticket's own prefix — AFTER the
  //    answer (the requester does not wait on the copies), within the time
  //    this function has left. The row already names the staged keys, so a
  //    move that never happens (or a function stopped part-way) leaves a
  //    correct row.
  const stagedIds = new Set(attachments.filter((_, i) => kept[i].kind === "staged").map((a) => a.id));
  if (stagedIds.size > 0) {
    after(async () => {
      try {
        const unmoved = await rekeyAttachments(orgId, ticketId, ticketNumber, attachments, stagedIds, {
          startBy: startedAt + REKEY_START_BY_MS,
          abortAt: startedAt + REKEY_ABORT_AT_MS,
        });
        if (unmoved > 0) console.warn(`[tickets/create] ${unmoved} attachment(s) of ${ticketNumber} stay at their staged keys (the row names them there)`);
      } catch (e) {
        console.error(`[tickets/create] re-key of ${ticketNumber} failed (the row names the staged keys):`, e);
      }
    });
  }

  // Kick the email drain after the response (the daily cron is the fallback).
  const drainUrl = new URL("/api/notifications/send-queued", req.url);
  const drainToken = process.env.CRON_SECRET || caller.token;
  after(async () => {
    try {
      await fetch(drainUrl, { method: "POST", headers: { Authorization: `Bearer ${drainToken}` } });
    } catch { /* the cron drains it */ }
  });

  return {
    ok: true, id: ticketId, ticketNumber, resumed: false,
    notified: notice.ok, ...(notice.ok ? {} : { notifyReason: notice.reason }),
    ...(psmAlert ? { psmAlert } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** GAP-312 (DF-P6): write the request's equipment rows. Returns warnings. */
async function recordEquipment(orgId: string, ticketId: string, uid: string, equipment: Array<{ tag: string; assetId: string | null }>): Promise<string[]> {
  const ids = [...new Set(equipment.map((e) => e.assetId).filter((x): x is string => !!x))];
  let known = new Set<string>();
  const out: string[] = [];
  if (ids.length > 0) {
    const { data: assets, error: assetErr } = await supabaseAdmin.from("assets").select("id").eq("org_id", orgId).in("id", ids);
    if (assetErr) out.push("The equipment could not be matched to this workspace's assets — the tags were kept as typed.");
    else known = new Set(((assets ?? []) as Array<{ id: string }>).map((a) => a.id));
  }
  const rows = equipment.map((e) => ({
    org_id: orgId, ticket_id: ticketId, tag: e.tag,
    asset_id: e.assetId && known.has(e.assetId) ? e.assetId : null,
    created_by: uid,
  }));
  const { error } = await supabaseAdmin.from("ticket_equipment").insert(rows);
  if (error) {
    out.push(isMissingSchemaError(error)
      ? "The equipment you named could not be recorded yet (database update 20261251 is not applied) — the request was filed without it."
      : "The equipment you named could not be recorded — the request was filed without it; add it in a comment.");
    return out;
  }
  const unresolved = rows.filter((r) => !r.asset_id).map((r) => r.tag);
  if (unresolved.length > 0) out.push(`Not found in the equipment registry, kept as typed: ${unresolved.join(", ")}.`);
  return out;
}

/** The origin's own facts (FRIC-8 / EDGE-13). Required custom fields and
 *  the unit-list refusal bind the request FORM; an origin that skips them is
 *  held to what binds it instead:
 *   checkin           — a checkout of the source document by THIS requester
 *                       (the episode, when it names one, is that document's,
 *                       in this workspace; the session is in that episode at
 *                       any status, or still active) and a document the
 *                       caller can see;
 *   intake_collision  — a project in this workspace; the source document is
 *                       an intake sheet in THAT project's intake folder,
 *                       visible to the caller; the intake link, when named,
 *                       is that project's; the document the number collides
 *                       with, when named, is one the caller can see in this
 *                       workspace (otherwise it is dropped with a warning,
 *                       never stored). The notice title is the sheet's own
 *                       label, read from the row — never the client's text.
 *                       The overlap list is the scan's description and is
 *                       stored as reported (not re-checked document by
 *                       document).
 *  Otherwise the request is refused (field "origin"): the origin carries the
 *  check-in's PSM flags, a collision notice, and skips the form's required
 *  fields, so it is never the caller's to choose freely. */
async function checkOrigin(
  input: TicketCreateInput, orgId: string, callerId: string, primary: SourceDocumentRefRow | null,
  byId: Map<string, SourceRow>, callerClient: SupabaseClient,
): Promise<Fail | { origin: TicketCreateOrigin; warnings: string[] }> {
  const o = input.origin;
  if (o.kind === "checkin") {
    if (!primary) {
      return { status: 400, field: "origin", error: "A check-in files its request against the document checked in — that document is not in this workspace." };
    }
    if (o.episodeId) {
      const { data: ep, error: epErr } = await supabaseAdmin
        .from("checkout_episodes").select("id")
        .eq("id", o.episodeId).eq("org_id", orgId).eq("document_id", primary.id).maybeSingle();
      if (epErr) return { status: 503, error: "Couldn't confirm the checkout this check-in closes — try again in a moment." };
      if (!ep) return { status: 400, field: "origin", error: "This check-in does not match a checkout of that document." };
    }
    // The requester's own session on the document: in this episode (any
    // status — a retry after a failed close), or still active (a legacy
    // checkout the episode model never tagged).
    const { data: sessions, error: sErr } = await supabaseAdmin
      .from("checkout_sessions").select("episode_id, status")
      .eq("document_id", primary.id).eq("user_id", callerId)
      .order("started_at", { ascending: false }).limit(20);
    if (sErr) return { status: 503, error: "Couldn't confirm the checkout this check-in closes — try again in a moment." };
    const own = (sessions ?? []) as Array<{ episode_id?: string | null; status?: string | null }>;
    const held = own.some((s) => (o.episodeId != null && s.episode_id === o.episodeId) || s.status === "active");
    if (!held) {
      // A legacy check-in (no episode to resume by) retried after its
      // checkout closed: the caller DID check the document out — say what
      // happened, not who may file. The ownership refusal is for a caller
      // with no checkout of the document at all, or one in someone else's
      // episode.
      if (o.episodeId == null && own.length > 0) {
        return {
          status: 400, field: "origin",
          error: "Your checkout of this document is already closed, so this check-in cannot file its request again. If the request was filed, it is in the queue; otherwise file it from the request form.",
        };
      }
      return { status: 400, field: "origin", error: "Only the person who checked this document out can file its check-in request." };
    }
    return { origin: o, warnings: [] };
  }
  if (o.kind === "intake_collision") {
    const { data: project, error: pErr } = await supabaseAdmin
      .from("projects").select("id, intake_collection_id").eq("id", o.projectId).eq("org_id", orgId).maybeSingle();
    if (pErr) return { status: 503, error: "Couldn't confirm the project this collision belongs to — try again in a moment." };
    if (!project) return { status: 400, field: "origin", error: "The project this collision was flagged in is not in this workspace." };
    const sheet = primary ? byId.get(primary.id) ?? null : null;
    const intakeFolder = (project as { intake_collection_id?: string | null }).intake_collection_id ?? null;
    if (!sheet || !intakeFolder || sheet.collection_id !== intakeFolder) {
      return { status: 400, field: "origin", error: "A collision files its request against an intake sheet of the project — that sheet is not in this project's intake folder." };
    }
    if (o.intakeLinkId) {
      const { data: link, error: lErr } = await supabaseAdmin
        .from("project_intake_links").select("id")
        .eq("id", o.intakeLinkId).eq("org_id", orgId).eq("project_id", o.projectId).maybeSingle();
      if (lErr) return { status: 503, error: "Couldn't confirm the intake link this sheet came through — try again in a moment." };
      if (!link) return { status: 400, field: "origin", error: "The intake link named is not one of this project's." };
    }
    const warnings: string[] = [];
    let numberCollisionDocId = o.numberCollisionDocId;
    if (numberCollisionDocId) {
      const { data: other, error: cErr } = await callerClient
        .from("documents").select("id").eq("id", numberCollisionDocId).eq("org_id", orgId).maybeSingle();
      if (cErr) return { status: 503, error: "Couldn't read the document this sheet's number collides with — try again in a moment." };
      if (!other) {
        numberCollisionDocId = null;
        warnings.push("The document this sheet's number collides with is not one you can see in this workspace — the request was filed without naming it.");
      }
    }
    return { origin: { ...o, numberCollisionDocId, sheetLabel: documentLabel(sheet) }, warnings };
  }
  return { origin: o, warnings: [] };
}

type Settled = { kind: "filed"; id: string } | { kind: "taken" } | { kind: "failed"; fail: Fail };

/** EDGE-13: a failed insert. The number goes back to the counter ONLY when
 *  the insert definitely did not commit (insertFailureKind "definite"), no
 *  row carries it, and no later number was issued. A write that MAY have
 *  committed (a dropped connection, a lost reply) is looked for: found, the
 *  request is filed and the route carries on; not found, the number is kept
 *  (the write may still land) and the staged files stay for the
 *  reference-based sweep. A number already on a row is "taken". */
async function settleFailedInsert(p: {
  orgId: string; year: number; seq: number; ticketNumber: string; callerId: string; now: string;
  err: { code?: string; message?: string } | null;
}): Promise<Settled> {
  const kind = insertFailureKind(p.err);
  const why = p.err?.message ?? "no row returned";
  if (kind === "duplicate") {
    console.error(`[tickets/create] ${p.ticketNumber} is already on a ticket (${why}); the number is kept and a fresh one is tried`);
    return { kind: "taken" };
  }
  const { data: rows, error: probeErr } = await supabaseAdmin
    .from("tickets").select("id, requester_id, created_at")
    .eq("org_id", p.orgId).eq("ticket_id", p.ticketNumber).limit(1);
  if (probeErr) {
    console.error(`[tickets/create] insert of ${p.ticketNumber} failed (${why}) and the row could not be looked for; the number is kept`);
    return { kind: "failed", fail: { status: 500, error: UNCONFIRMED, code: "insert_unconfirmed", keepStaged: true } };
  }
  const found = ((rows ?? []) as Array<{ id: string; requester_id?: string | null; created_at?: string | null }>)[0];
  if (found) {
    if (found.requester_id === p.callerId && Date.parse(String(found.created_at ?? "")) === Date.parse(p.now)) {
      console.warn(`[tickets/create] insert of ${p.ticketNumber} reported a failure (${why}) but the row is there; carrying on`);
      return { kind: "filed", id: String(found.id) };
    }
    return { kind: "taken" };
  }
  if (kind === "definite") {
    const released = await checkedWrite(supabaseAdmin.from("ticket_number_counters")
      .update({ next_seq: p.seq - 1 })
      .eq("org_id", p.orgId).eq("year", p.year).eq("next_seq", p.seq)
      .select("org_id"));
    console.error(`[tickets/create] insert of ${p.ticketNumber} failed (${why}); number ${released.ok ? "released" : "not released (a later number was already handed out)"}`);
    return { kind: "failed", fail: { status: 500, error: "The request could not be saved — nothing was filed. Try again." } };
  }
  console.error(`[tickets/create] insert of ${p.ticketNumber} failed ambiguously (${why}); no row yet — the number is kept`);
  return { kind: "failed", fail: { status: 500, error: UNCONFIRMED, code: "insert_unconfirmed", keepStaged: true } };
}

/** Copy each staged file under orgs/<org>/tickets/<number>/ (a few at a
 *  time; none started after `deadlines.startBy`, a running one abandoned at
 *  `deadlines.abortAt`), point the row at the copies (the row read FRESH
 *  first — the notice and PSM stamps, or another writer, have moved it on
 *  since the insert — then compare-and-set on its last_modified, which it
 *  bumps so a concurrent writer that read the staged keys loses its own
 *  compare-and-set), then delete the staged originals. A file that is not
 *  moved keeps its staged key on the row — it is never left unreferenced.
 *  Returns how many stayed where they were staged. */
async function rekeyAttachments(
  orgId: string, ticketId: string, ticketNumber: string, attachments: TicketAttachment[],
  stagedIds: Set<string>, deadlines: { startBy: number; abortAt: number },
): Promise<number> {
  const staged = attachments.filter((a) => stagedIds.has(a.id));
  if (staged.length === 0) return 0;
  const moves = new Map<string, string>();   // attachment id → final key
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(0, deadlines.abortAt - Date.now()));
  try {
    await eachLimited(staged, 4, async (a) => {
      if (ac.signal.aborted || Date.now() >= deadlines.startBy) return;   // stays where it was staged
      const to = finalAttachmentKey(orgId, ticketNumber, a.url);
      try {
        await r2.send(new CopyObjectCommand({ Bucket: R2_BUCKET, Key: to, CopySource: copySource(a.url) }), { abortSignal: ac.signal });
        moves.set(a.id, to);
      } catch (e) {
        console.warn(`[tickets/create] could not move ${a.url} under ${ticketNumber} (kept where it was staged):`, (e as Error)?.message ?? e);
      }
    });
  } finally {
    clearTimeout(timer);
  }
  if (moves.size === 0) return staged.length;

  const stagedKeyOf = new Map(staged.map((a) => [a.id, a.url]));
  for (let attempt = 0; attempt < 2; attempt++) {
    // The row as it is now (a second time when someone wrote it in between):
    // the same files are moved on top of whatever it holds.
    const { data: fresh, error } = await supabaseAdmin
      .from("tickets").select("attachments, last_modified").eq("id", ticketId).maybeSingle();
    if (error || !fresh) break;
    const token = String((fresh as { last_modified: string }).last_modified);
    const current = ((fresh as { attachments?: TicketAttachment[] | null }).attachments ?? []);
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
  }
  // The row still names the staged keys: drop the copies, keep the originals.
  await deleteObjects([...moves.values()]);
  return staged.length;
}

/** EDGE-9's convention: a link in an EMAIL is absolute — the configured
 *  public origin, else the origin this request arrived on. */
function emailLinkFor(req: NextRequest, link: string): string {
  return `${(publicOrigin() || new URL(req.url).origin).replace(/\/+$/, "")}${link}`;
}

/** What became of the creation notice: sent to the assignment pool, or not —
 *  with the reason the answer carries. */
type Announced = { ok: true } | { ok: false; reason: string };

/** The new-request notice to the assignment queue: bell + preference-aware
 *  email through emit(), as the service role (lib/serverClientScope), with
 *  metadata.action / status (ROUTE-11). Not ok when the pool is empty (no
 *  active Drafting Supervisor or Admin other than the requester could be
 *  found — nobody was told, and the answer must not say otherwise), when
 *  emit() throws, or when no creation bell row for the ticket is there
 *  afterwards (notify() logs and swallows a refused bell insert, so the
 *  route reads the queue's side back rather than trusting emit()'s silence);
 *  the caller stamps the ticket only when it is ok. */
async function announce(p: {
  req: NextRequest; orgId: string; ticketId: string; title: string; origin: TicketCreateOrigin;
  requestType: string; priority: number; unit: string | null; callerId: string; email: string | null;
}): Promise<Announced> {
  try {
    const recipients = await resolveTicketRecipients(p.orgId, "PENDING_ASSIGNMENT", p.callerId, supabaseAdmin);
    if (recipients.length === 0) {
      console.warn(`[tickets/create] new-request notice for ${p.ticketId}: nobody to notify (no active Drafting Supervisor or Admin other than the requester)`);
      return { ok: false, reason: "nobody to notify — no active Drafting Supervisor or Admin other than you was found" };
    }
    const notice = creationNotice(p.origin, p.title);
    const link = `/requests/${p.ticketId}`;
    const emailLink = emailLinkFor(p.req, link);
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
        request_type: p.requestType,
        priority: p.priority,
        unit: p.unit,
      },
    }));
    // The queue's side, read back: a creation bell row for this ticket in a
    // recipient's bell (this attempt's, or an earlier attempt's that was
    // never stamped — either way someone in the queue was told). Whoever
    // wrote such a row, it IS in a queue member's bell; the requester's own
    // bell never counts.
    const { data: rows, error: readErr } = await supabaseAdmin
      .from("notifications").select("id")
      .eq("org_id", p.orgId).eq("resource_type", "ticket").eq("resource_id", p.ticketId)
      .eq("metadata->>action", "created").in("user_id", recipients.map((m) => m.uid)).limit(1);
    if (readErr) {
      console.error(`[tickets/create] new-request notice for ${p.ticketId}: could not confirm the bell rows:`, readErr.message);
      return { ok: false, reason: "the notice could not be confirmed" };
    }
    if (((rows ?? []) as unknown[]).length === 0) {
      console.error(`[tickets/create] new-request notice for ${p.ticketId}: no bell row was written (the request is filed)`);
      return { ok: false, reason: "the notice could not be written" };
    }
    return { ok: true };
  } catch (e) {
    console.error(`[tickets/create] new-request notice for ${p.ticketId} failed (the request is filed):`, e);
    return { ok: false, reason: "the notice could not be written" };
  }
}

/** A ticket row as a writer last saw it: its metadata and the last_modified
 *  its next compare-and-set must match. */
type RowKnown = { metadata: Record<string, unknown> | null; lastModified: string };

/** Merge `patch` into a ticket's metadata — compare-and-set on
 *  last_modified (which it bumps, so a writer that read the old metadata
 *  loses its own compare-and-set instead of erasing the stamp). `known` is
 *  the row as the caller already holds it; a lost race re-reads once.
 *  Returns the row as written (the merged metadata and the new
 *  last_modified — what the next stamp must build on), or null when the
 *  stamp was not written. */
async function stampTicketMetadata(
  ticketId: string, patch: Record<string, unknown>, known: RowKnown | null,
): Promise<{ metadata: Record<string, unknown>; lastModified: string } | null> {
  let cur = known;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!cur) {
      const { data, error } = await supabaseAdmin.from("tickets").select("metadata, last_modified").eq("id", ticketId).maybeSingle();
      if (error || !data) return null;
      const row = data as { metadata?: Record<string, unknown> | null; last_modified?: string | null };
      cur = { metadata: row.metadata ?? null, lastModified: String(row.last_modified ?? "") };
    }
    const token = new Date().toISOString();
    const merged = { ...(cur.metadata ?? {}), ...patch };
    const w = await checkedWrite(supabaseAdmin.from("tickets")
      .update({ metadata: merged, last_modified: token })
      .eq("id", ticketId).eq("last_modified", cur.lastModified)
      .select("id"));
    if (w.ok) return { metadata: merged, lastModified: token };
    cur = null;
  }
  return null;
}

/** EDGE-8: stamp metadata.created_notice_at once the creation notice is out
 *  — the mark a resumed check-in reads, so the notice goes out once. A stamp
 *  that cannot be written means a later resume may send it once more: a
 *  second notice, never a lost one. */
async function stampCreationNotice(ticketId: string, ticketNumber: string, known: RowKnown | null): Promise<{ metadata: Record<string, unknown>; lastModified: string } | null> {
  const stamped = await stampTicketMetadata(ticketId, { created_notice_at: new Date().toISOString() }, known);
  if (!stamped) console.error(`[tickets/create] the creation notice of ${ticketNumber} was sent but not stamped; a resumed check-in may send it again`);
  return stamped;
}

/** LIFE-7: the PSM escalation for a check-in that reports an undocumented
 *  field change — sent by the route (DF-P2 review fix), not the browser, so
 *  it does not depend on the reporter's tab getting the answer. Bell AND
 *  email on the "safety" category (the one no preference toggle mutes) to
 *  the workspace's controllers other than the reporter, then
 *  metadata.psm_escalated_at is stamped: a check-in that resumes this
 *  ticket sends it only while that stamp is missing. With no controller to
 *  tell, the gap is audited (PSM_ALERT_UNROUTED) and the reporter's panel
 *  says so; nothing is stamped, so a later attempt routes it if a
 *  controller exists by then. A failure is "failed" (not stamped — the next
 *  attempt sends it). A stamp that cannot be written after a send means a
 *  later resume may send it once more: a second alert, never a lost one. */
async function escalatePsm(p: {
  req: NextRequest; orgId: string; ticketId: string; callerId: string; reporter: string; email: string | null;
  docLabel: string; note: string;
  known: RowKnown | null;
}): Promise<PsmAlertOutcome> {
  const notice = psmAlertNotice({ reporter: p.reporter, docLabel: p.docLabel, note: p.note });
  try {
    const { data, error } = await supabaseAdmin
      .from("org_members").select("uid, role, roles").eq("org_id", p.orgId).eq("status", "active");
    if (error) {
      console.error(`[tickets/create] PSM escalation for ${p.ticketId}: the controllers could not be read (${error.message}); not sent — the next attempt sends it`);
      return "failed";
    }
    const controllers = ((data ?? []) as Array<{ uid: string; role?: unknown; roles?: unknown }>)
      .filter((m) => m.uid && m.uid !== p.callerId && memberHoldsAny(m, PSM_CONTROLLER_ROLES))
      .map((m) => m.uid);
    if (controllers.length === 0) {
      // Nowhere to go: a record, and the reporter is told (psmAlert
      // "unrouted") — a hazard report must never look routed when it was not.
      await runWithServerClient(supabaseAdmin, () => logAuditAction({
        orgId: p.orgId, userId: p.callerId, userEmail: p.email || undefined,
        action: "PSM_ALERT_UNROUTED", resourceType: "ticket", resourceId: p.ticketId,
        details: { reason: "no_active_controllers", title: notice.title },
      }));
      return "unrouted";
    }
    const link = `/requests/${p.ticketId}`;
    const emailLink = emailLinkFor(p.req, link);
    await runWithServerClient(supabaseAdmin, () => emit({
      orgId: p.orgId, category: "safety", kind: "request_pending_approval",
      title: notice.title, body: notice.body, link,
      resource: { type: "ticket", id: p.ticketId },
      actorUserId: p.callerId, actorName: p.reporter,
      audience: { involved: controllers },
      email: {
        bodyText: `${notice.title}\n\n${notice.body}\n\n${emailLink}`,
        bodyHtml: `<p><b>${escapeHtml(notice.title)}</b></p><p>${escapeHtml(notice.body)}</p><p><a href="${escapeHtml(emailLink)}">Open the request</a></p>`,
      },
    }));
  } catch (e) {
    console.error(`[tickets/create] PSM escalation for ${p.ticketId} failed; not stamped — the next attempt sends it:`, e);
    return "failed";
  }
  const stamped = await stampTicketMetadata(p.ticketId, { psm_escalated_at: new Date().toISOString() }, p.known);
  if (!stamped) console.error(`[tickets/create] PSM escalation for ${p.ticketId} was sent but not stamped; a resumed check-in may send it again`);
  return "sent";
}

export async function DELETE(req: NextRequest) {
  const caller = await authenticate(req);
  if (!caller) return json(401, { error: "Unauthorized" });
  let raw: unknown;
  try { raw = await req.json(); } catch { return json(400, { error: "Invalid JSON body" }); }
  const r = (raw ?? {}) as { orgId?: unknown; keys?: unknown };
  const orgId = typeof r.orgId === "string" ? r.orgId : "";
  const keys = Array.isArray(r.keys) ? [...new Set(r.keys.filter((k): k is string => typeof k === "string"))] : [];
  if (!orgId || keys.length === 0 || keys.length > 50) return json(400, { error: "orgId and up to 50 keys are required" });
  const own = keys.filter((k) => isSafeStorageKey(k) && isStagedKeyOf(k, orgId, caller.id));
  // A staged key a ticket already names (a re-key that did not complete) is
  // a record's file, not a leftover: never deleted here (`kept`). A key that
  // is not the caller's own staged file is `foreign`; one whose reference
  // check could not be made is `unchecked` (the orphan sweep reclaims it).
  // Each key is counted once (a key named twice is one key).
  const done = await discardUnreferencedStaged(orgId, own);
  const counts = { deleted: done.deleted, kept: done.kept, unchecked: done.unchecked, foreign: keys.length - own.length };
  if (done.unchecked > 0) return json(503, { error: "Couldn't check the files against the requests — try again.", ...counts });
  return json(200, { ok: true, ...counts });
}
