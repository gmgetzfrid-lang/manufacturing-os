// POST /api/intake/upload  (multipart)
//
// The external door's submit endpoint. Token-gated (no account); the server
// stores the file in R2, creates the document/version with provenance
// 'external' and the company stamped, routes it through review (pending
// revision) or — for a trusted link, on the link's OWN already-approved
// document — publishes it through the publish contract, and notifies the
// project team.
//
// The door as a boundary (projects Round G, J1 — GAP-401):
//   * The token travels in the `x-intake-token` header (or `?token=`) and is
//     checked — format, rate window, existence, revocation, expiry, the
//     link's lifetime budget, the declared Content-Length — BEFORE the body
//     is read (INTK-8 / SEC-8 / SEC-6). The multipart body is parsed only for
//     a live link.
//   * The bytes decide the type (lib/fileSniff.ts): an allowlist per branch,
//     the stored ContentType is the sniffed one, never the uploader's claim
//     (SEC-1 / SEC-6 / INTK-11).
//   * The project must still exist and be open (PM-2 / PM-1's route limb).
//   * Authorship is a fact fixed at creation — documents.authored_by_link_id
//     (20261104) — never the version chain this route appends to (INTK-1 /
//     SEC-3 / SEC-12). A document the link was ASSIGNED always goes through
//     review; so does one that has never had an approved revision.
//   * Every document read is scoped to the link's org (INTK-9 / SEC-11).
//   * The trusted promote goes THROUGH publish_revision (the hold gate, the
//     checkout lock, the expected-base check and the drawing-class MOC gate
//     run in the database, acting as the link's creator), then the shared
//     post-publish pipeline runs under the service role (INTK-2 / SAF-5 /
//     SEC-4 / SEC-14). A refused promote DEMOTES the upload to review — the
//     file is still wanted; only the instant publish is withheld (OWN-4).
//   * A submission that displaces the link's own pending one resolves it —
//     review_state 'superseded', an audit row, a notice (INTK-4 / SAF-10).
//   * Notices go through emit() (followers, intent holders, preferences,
//     dedupe) — one per link per window (INTK-10 / SEC-8 dw2).
//   * A retried upload of the same bytes returns the original record
//     (REL-8 / INTK-13); every failure the portal sees is a plain sentence
//     plus a reference id — the database message stays in the server log.
//
// Header: x-intake-token (or query ?token=). Fields: file, and either docId
// (new revision of an own/assigned document), ticketId (redlines for a
// collision ticket that names this link), or title [+ number] (brand-new
// document). Optional revLabel, changeNote.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { memberHoldsAny, roleFilter } from "@/lib/roleHeld";
import { __setServerSupabaseClient, __resetServerSupabaseClient } from "@/lib/supabase";
import { readActiveHolds, decideHoldGate } from "@/lib/holdGate";
import { computeUniquenessKey } from "@/lib/uniqueness";
import { validateIntakeFile, type IntakeBranch } from "@/lib/fileSniff";
import {
  INTAKE_TOKEN_RE, intakeTokenFromRequest, CLOSED_PROJECT_STATUSES,
  LINK_GONE_MESSAGE, PROJECT_CLOSED_MESSAGE, INTAKE_NOTE_MAX, validateIntakeText,
} from "@/lib/intakeLinks";
import {
  intakeLimits, sha256Hex, clientIp, checkIntakeRate, recordIntakeAttempt,
  noticeSentRecently, readLinkBudget, linkBudgetRefusal, ATTEMPT_OUTCOME,
} from "@/lib/intakeRateLimit";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
/** Multipart framing around the file (boundaries, the other fields). */
const MULTIPART_SLACK = 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A retry of the same bytes inside this window returns the original. */
const IDEMPOTENCY_WINDOW_MS = 24 * 3600 * 1000;

type PgError = { message?: string; code?: string; details?: string | null } | null | undefined;

/** A database that has not received a column yet (a migration applied by
 *  hand, later than the deploy). */
function missingColumn(e: PgError, col: string): boolean {
  const msg = `${e?.message ?? ""} ${e?.details ?? ""}`;
  return !!e && msg.includes(col) && (/^(42703|PGRST204)$/.test(String(e.code ?? "")) || /does not exist|could not find/i.test(msg));
}

// ── The shared client, bound to the service role for the pipeline ──────────
// lib/postPublish.ts and lib/notify/dispatch.ts are written against the
// shared `supabase` client (a browser session in the app). This route has
// no session, so it binds the shared client to the service role while they
// run — exactly as the maintenance cron does for the compliance scans — and
// always unbinds (reference-counted: two uploads on one warm instance never
// unbind each other's pipeline). Nothing else in this route uses the shared
// client.
let serviceClientHolds = 0;
async function asServiceRole<T>(fn: () => Promise<T>): Promise<T> {
  if (serviceClientHolds++ === 0) __setServerSupabaseClient(supabaseAdmin);
  try {
    return await fn();
  } finally {
    if (--serviceClientHolds === 0) __resetServerSupabaseClient();
  }
}

/** INTK-13: the portal gets a plain sentence and a reference id; any
 *  database detail goes to the server log under the same id. */
function refuser(ref: string) {
  return (msg: string, status: number, detail?: string, extra?: Record<string, unknown>) => {
    if (detail) console.error(`[intake/upload] ref=${ref} ${detail}`);
    return NextResponse.json({ error: msg, ref, ...(extra ?? {}) }, { status });
  };
}

/** SEC-16 dw2: a token used from a browser that is ALSO signed in to the
 *  app records that session — an insider driving the contractor's door is
 *  distinguishable from the contractor. */
async function appSessionOf(req: NextRequest): Promise<{ userId: string; email: string | null } | null> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(auth.slice(7));
    if (error || !data?.user) return null;
    return { userId: data.user.id, email: data.user.email ?? null };
  } catch {
    return null;
  }
}

async function audit(ref: string, row: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin.from("audit_logs").insert(row);
  if (error) console.error(`[intake/upload] ref=${ref} audit ${String(row.action)} failed: ${error.message}`);
}

async function bumpUse(ref: string, linkId: string, bytes: number): Promise<void> {
  const first = await supabaseAdmin.rpc("bump_intake_use", { p_link: linkId, p_bytes: bytes });
  if (!first?.error) return;
  // Pre-20261104 database: the one-argument form.
  const second = await supabaseAdmin.rpc("bump_intake_use", { p_link: linkId });
  if (second?.error) console.error(`[intake/upload] ref=${ref} usage counter failed: ${second.error.message}`);
}

function kickDrain(req: NextRequest): void {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return;
  void fetch(`${req.nextUrl.origin}/api/notifications/send-queued`, {
    method: "POST", headers: { Authorization: `Bearer ${cronSecret}` },
  }).catch(() => undefined);
}

async function putObject(key: string, bytes: Uint8Array, contentType: string): Promise<boolean> {
  try {
    await r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: bytes, ContentType: contentType }));
    return true;
  } catch (e) {
    console.error("[intake/upload] R2 put failed", e);
    return false;
  }
}

/** Who authored this document: documents.authored_by_link_id (20261104),
 *  stamped only when the route CREATES a document. On a database without
 *  the column, the document's FIRST version (a fact fixed at creation —
 *  never the chain this route keeps appending to). Unreadable → null:
 *  "not authored", the fail-safe answer (review). */
async function linkAuthorOf(docId: string, orgId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("documents").select("authored_by_link_id").eq("id", docId).eq("org_id", orgId).maybeSingle();
  if (!error) return ((data as { authored_by_link_id?: string | null } | null)?.authored_by_link_id as string | null) ?? null;
  if (!missingColumn(error, "authored_by_link_id")) return null;
  const { data: first, error: firstErr } = await supabaseAdmin
    .from("document_versions").select("intake_link_id")
    .eq("record_id", docId).eq("org_id", orgId)
    .order("created_at", { ascending: true }).order("id", { ascending: true }).limit(1);
  if (firstErr) return null;
  return ((first as Array<{ intake_link_id: string | null }> | null)?.[0]?.intake_link_id as string | null) ?? null;
}

/** INTK-13 dw3: one intake folder per project, whatever the concurrency.
 *  The folder is created, then CLAIMED with a compare-and-set on the
 *  project's still-empty pointer; the loser deletes its own folder and uses
 *  the winner's. Every write is checked. */
async function ensureIntakeFolder(input: {
  orgId: string; projectId: string; projectName: string; libraryId: string; current: string | null;
}): Promise<{ id: string } | { error: string }> {
  if (input.current) return { id: input.current };
  const { data: col, error: colErr } = await supabaseAdmin
    .from("collections")
    .insert({ org_id: input.orgId, library_id: input.libraryId, name: `Intake — ${input.projectName}` })
    .select("id").single();
  if (colErr || !col) return { error: `intake folder insert: ${colErr?.message ?? "no row"}` };
  const colId = String((col as { id: string }).id);
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from("projects").update({ intake_collection_id: colId })
    .eq("id", input.projectId).is("intake_collection_id", null)
    .select("id");
  if (claimErr) {
    await supabaseAdmin.from("collections").delete().eq("id", colId);
    return { error: `intake folder pointer write: ${claimErr.message}` };
  }
  if ((claimed as unknown[] | null)?.length) return { id: colId };
  // Another first submission claimed the pointer between our read and
  // write — drop the folder we made and file into theirs.
  const { error: dropErr } = await supabaseAdmin.from("collections").delete().eq("id", colId);
  if (dropErr) console.error(`[intake/upload] duplicate intake folder ${colId} could not be removed: ${dropErr.message}`);
  const { data: again, error: againErr } = await supabaseAdmin
    .from("projects").select("intake_collection_id").eq("id", input.projectId).maybeSingle();
  const winner = (again as { intake_collection_id?: string | null } | null)?.intake_collection_id ?? null;
  if (againErr || !winner) return { error: `intake folder re-read: ${againErr?.message ?? "pointer still empty"}` };
  return { id: String(winner) };
}

type PublishOutcome =
  | { kind: "published"; versionId: string }
  | { kind: "demote"; reason: string; detail?: string }
  | { kind: "refuse"; status: number; message: string; detail?: string };

/** SAF-5 / INTK-2 / SEC-4: the trusted promote is the SAME contract every
 *  internal publish uses — publish_revision, acting as the link's creator
 *  (the person who sanctioned auto-publish). It locks the document row,
 *  refuses a held document, a foreign checkout, a moved base and a
 *  duplicate label, and applies the drawing-class MOC gate — in the
 *  database, not in this route. */
async function publishThroughContract(input: {
  documentId: string; expectedBase: string | null; creator: string; company: string;
  revLabel: string; key: string; contentType: string; size: number; changeNote: string | null; fileHash: string;
}): Promise<PublishOutcome> {
  const { data, error } = await supabaseAdmin.rpc("publish_revision", {
    p_doc: input.documentId,
    p_expected_base: input.expectedBase,
    p_op_class: "content",
    p_version: {
      revision_label: input.revLabel,
      file_url: input.key,
      file_type: input.contentType,
      size: input.size,
      change_log: input.changeNote ?? `Submitted by ${input.company} via project intake`,
      created_by_name: input.company,
      provenance: "external",
      file_hash: input.fileHash,
    },
    p_actor: input.creator,
    p_actor_name: `${input.company} (intake)`,
  });
  if (error) {
    if (/MOC reference/i.test(error.message ?? "")) {
      return { kind: "demote", reason: "a drawing-class revision needs a management-of-change (MOC) reference — the project team adds it when they review it" };
    }
    if (/not an active member/i.test(error.message ?? "")) {
      return { kind: "demote", reason: "the link's creator is no longer an active member" };
    }
    return { kind: "demote", reason: "automatic publication could not be completed", detail: `publish_revision: ${error.message}` };
  }
  const res = (data ?? {}) as { status?: string; version?: { id?: string } | null };
  switch (res.status) {
    case "published":
      if (res.version?.id) return { kind: "published", versionId: String(res.version.id) };
      return { kind: "demote", reason: "automatic publication could not be completed", detail: "publish_revision returned no version" };
    case "on_hold":
      return { kind: "demote", reason: "the document has an active hold" };
    case "locked_by_other":
      return { kind: "demote", reason: "the document is checked out" };
    case "stale_base":
      return { kind: "refuse", status: 409, message: "The document changed while your submission was being recorded — please submit it again." };
    case "duplicate_label":
      return { kind: "refuse", status: 409, message: `Rev ${input.revLabel} already exists on this document — submit it with a new revision label.` };
    default:
      return { kind: "demote", reason: "automatic publication could not be completed", detail: `publish_revision status ${String(res.status)}` };
  }
}

/** INTK-4 / SAF-10: the submission a new one displaces is RESOLVED, not left
 *  'in_review' with nothing pointing at it. Pre-20261105 databases (the
 *  review_state CHECK does not know 'superseded' yet) keep the older
 *  retire-by-superseded_at shape. */
async function retireDisplaced(ref: string, input: {
  orgId: string; documentId: string; displacedId: string; byVersionId: string;
  company: string; projectId: string; nowIso: string; contactEmail: string | null;
}): Promise<void> {
  let { error } = await supabaseAdmin.from("document_versions")
    .update({ review_state: "superseded", superseded_at: input.nowIso })
    .eq("id", input.displacedId).eq("review_state", "in_review");
  if (error && String(error.code ?? "") === "23514") {
    ({ error } = await supabaseAdmin.from("document_versions")
      .update({ superseded_at: input.nowIso }).eq("id", input.displacedId).is("superseded_at", null));
  }
  if (error) console.error(`[intake/upload] ref=${ref} displaced submission ${input.displacedId} not resolved: ${error.message}`);
  await audit(ref, {
    action: "INTAKE_SUBMISSION_DISPLACED",
    resource_type: "document", resource_id: input.documentId,
    org_id: input.orgId, user_id: null, user_email: input.contactEmail,
    details: { displacedVersionId: input.displacedId, byVersionId: input.byVersionId, company: input.company, projectId: input.projectId },
  });
}

export async function POST(req: NextRequest) {
  const ref = crypto.randomUUID().slice(0, 8);
  const fail = refuser(ref);

  // ── 1. The credential, before any body is read ─────────────────────────
  const token = intakeTokenFromRequest(req);
  if (!INTAKE_TOKEN_RE.test(token)) {
    return fail("This upload link is not valid — reopen the portal from the link you were sent.", 400);
  }
  const tokenHash = sha256Hex(token);
  const ip = clientIp(req);
  const limits = intakeLimits();
  const rate = await checkIntakeRate(supabaseAdmin, { tokenHash, ip, limits });
  if (rate.limited) {
    return NextResponse.json({ error: rate.message, ref, code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });
  }
  await recordIntakeAttempt(supabaseAdmin, { tokenHash, ip, outcome: ATTEMPT_OUTCOME.attempt });

  const { data: link, error: linkErr } = await supabaseAdmin
    .from("project_intake_links")
    .select("id, org_id, project_id, company_name, contact_email, allow_auto_supersede, expires_at, revoked_at, assigned_doc_ids, created_by")
    .eq("token", token)
    .maybeSingle();
  if (linkErr) return fail("This link could not be checked right now — try again shortly.", 503, `link read: ${linkErr.message}`);
  if (!link) return fail("notfound", 404);
  if (link.revoked_at) return fail("This link has been revoked.", 410, undefined, { code: "revoked" });
  if (link.expires_at && Date.parse(link.expires_at as string) < Date.now()) return fail("This link has expired.", 410, undefined, { code: "expired" });

  const linkId = String(link.id);
  const orgId = String(link.org_id);
  const projectId = String(link.project_id);
  const company = String(link.company_name);
  const contactEmail = (link.contact_email as string | null) ?? null;

  // ── 2. Size and the link's lifetime budget, before the body ───────────
  const declaredLength = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES + MULTIPART_SLACK) {
    return fail("File exceeds the 100 MB limit.", 413);
  }
  const budget = await readLinkBudget(supabaseAdmin, linkId);
  const spent = linkBudgetRefusal(budget, null);
  if (spent) return fail(spent, 429, undefined, { code: "link_budget" });

  // ── 3. Only now: the body ──────────────────────────────────────────────
  let form: FormData;
  try { form = await req.formData(); } catch { return fail("Expected multipart form data", 400); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return fail("A file is required.", 400);
  if (file.size > MAX_BYTES) return fail("File exceeds the 100 MB limit.", 413);
  const overBudget = linkBudgetRefusal(budget, file.size);
  if (overBudget) return fail(overBudget, 429, undefined, { code: "link_budget" });

  // Link purpose, fetched tolerantly — the column arrives with 20261013 and
  // a pre-migration deployment must keep serving document links unchanged.
  let purpose = "documents";
  let rfqGroup: string | null = null;
  {
    const { data: p, error: pErr } = await supabaseAdmin
      .from("project_intake_links").select("purpose, rfq_group").eq("id", linkId).maybeSingle();
    if (!pErr && p) {
      purpose = String((p as { purpose?: string | null }).purpose ?? "documents");
      rfqGroup = ((p as { rfq_group?: string | null }).rfq_group ?? null);
    }
  }

  // ── 4. The project must exist and be open (PM-2 / PM-1) — before any
  //       byte is stored, on every branch. ─────────────────────────────────
  const { data: project, error: projErr } = await supabaseAdmin
    .from("projects").select("id, name, status, owner_user_id, intake_library_id, intake_collection_id")
    .eq("id", projectId).eq("org_id", orgId).maybeSingle();
  if (projErr) return fail("This link could not be checked right now — try again shortly.", 503, `project read: ${projErr.message}`);
  if (!project) return fail(LINK_GONE_MESSAGE, 410, undefined, { code: "link_gone" });
  if (CLOSED_PROJECT_STATUSES.has(String(project.status ?? ""))) return fail(PROJECT_CLOSED_MESSAGE, 410, undefined, { code: "project_closed" });
  const ownerUid = (project.owner_user_id as string | null) ?? null;

  const docId = String(form.get("docId") ?? "").trim() || null;
  const ticketId = String(form.get("ticketId") ?? "").trim() || null;
  const branch: IntakeBranch = purpose === "quote" ? "quote" : ticketId ? "redline" : "document";

  // ── 5. What the bytes are (never what the upload claims) ──────────────
  const bytes = new Uint8Array(await file.arrayBuffer());
  const verdict = validateIntakeFile({ branch, fileName: file.name, declaredType: file.type, head: bytes.subarray(0, 64) });
  if (!verdict.ok) return fail(verdict.message, 415, undefined, { code: "file_type" });
  const contentType = verdict.contentType;
  const fileHash = sha256Hex(bytes);
  const session = await appSessionOf(req);
  const nowIso = new Date().toISOString();
  const since = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS).toISOString();
  const noteRaw = String(form.get("changeNote") ?? "").trim();
  if (noteRaw.length > INTAKE_NOTE_MAX) return fail(`The note is limited to ${INTAKE_NOTE_MAX} characters.`, 400);
  const changeNote = noteRaw || null;

  /** One notice to the project team per link per window (SEC-8 dw2) — a
   *  burst of uploads is one notice, not N. `force` for a notice that must
   *  not be folded into a burst (a pending review was displaced). */
  const notifyTeam = async (n: {
    kind: "review_requested" | "doc_superseded"; title: string; body: string; link: string;
    resource: { type: "document" | "project"; id: string }; followers: boolean; extraInvolved?: string[];
    metadata: Record<string, unknown>; force?: boolean;
  }) => {
    if (!n.force && await noticeSentRecently(supabaseAdmin, { tokenHash, windowMinutes: limits.noticeWindowMinutes })) return;
    const { data: controllers, error: ctlErr } = await supabaseAdmin
      .from("org_members").select("uid").eq("org_id", orgId).eq("status", "active").or(roleFilter(["Admin", "DocCtrl"]));
    if (ctlErr) console.error(`[intake/upload] ref=${ref} controller pool read failed: ${ctlErr.message}`);
    const involved = [...new Set([
      ...(((controllers ?? []) as Array<{ uid: string }>).map((c) => String(c.uid))),
      ...(ownerUid ? [ownerUid] : []),
      ...(n.extraInvolved ?? []),
    ])];
    try {
      await asServiceRole(async () => {
        const { emit } = await import("@/lib/notify/dispatch");
        await emit({
          orgId, category: "watched", kind: n.kind,
          title: n.title, body: n.body, link: n.link,
          resource: n.resource, actorName: company,
          audience: { involved, followers: n.followers },
          metadata: { intake: true, ...n.metadata },
        });
      });
    } catch (e) {
      console.error(`[intake/upload] ref=${ref} notice failed: ${(e as Error).message}`);
    }
    await recordIntakeAttempt(supabaseAdmin, { tokenHash, ip, outcome: ATTEMPT_OUTCOME.notified, linkId });
    kickDrain(req);
  };

  // ── Quote branch: this link submits PRICES, not drawings. The file lands
  // as a cost_document (kind 'quote') for the project's bid tabulation —
  // it never touches document control. ──
  if (branch === "quote") {
    // REL-8: a retry of the same bytes while the quote is still a draft
    // returns the original (tolerant of a database without file_hash).
    {
      const { data: prior, error: priorErr } = await supabaseAdmin
        .from("cost_documents").select("id")
        .eq("intake_link_id", linkId).eq("file_hash", fileHash).eq("status", "draft").gte("created_at", since)
        .limit(1);
      const priorId = !priorErr ? (((prior ?? []) as Array<{ id: string }>)[0]?.id ?? null) : null;
      if (priorId) {
        return NextResponse.json({ ok: true, quoteId: String(priorId), status: "quote_received", duplicate: true, message: "This quote was already received — nothing new was stored." });
      }
    }
    const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "quote";
    const key = `orgs/${orgId}/project-costs/${projectId}/quote-${crypto.randomUUID()}-${safeName}`;
    if (!(await putObject(key, bytes, contentType))) return fail("File storage failed — try again.", 502);

    const quoteRow: Record<string, unknown> = {
      org_id: orgId, project_id: projectId,
      kind: "quote",
      file_url: key, file_name: file.name, mime_type: contentType,
      vendor_name: company,
      rfq_group: rfqGroup,
      intake_link_id: linkId,
      status: "draft",
      created_by: null,
      file_hash: fileHash,
    };
    let { data: qdoc, error: qErr } = await supabaseAdmin.from("cost_documents").insert(quoteRow).select("id").single();
    if (qErr && missingColumn(qErr, "file_hash")) {
      delete quoteRow.file_hash;
      ({ data: qdoc, error: qErr } = await supabaseAdmin.from("cost_documents").insert(quoteRow).select("id").single());
    }
    if (qErr && String(qErr.code ?? "") === "23505") {
      // A concurrent retry won the idempotency index — answer with its row.
      const { data: winner } = await supabaseAdmin.from("cost_documents").select("id")
        .eq("intake_link_id", linkId).eq("file_hash", fileHash).eq("status", "draft").limit(1);
      const winnerId = (((winner ?? []) as Array<{ id: string }>)[0]?.id) ?? null;
      if (winnerId) return NextResponse.json({ ok: true, quoteId: String(winnerId), status: "quote_received", duplicate: true, message: "This quote was already received — nothing new was stored." });
    }
    if (qErr || !qdoc) return fail("Couldn't record the quote — try again shortly.", 500, `cost_documents insert: ${qErr?.message ?? "no row"}`);
    const quoteId = String((qdoc as { id: string }).id);

    await notifyTeam({
      kind: "review_requested",
      title: `Quote received: ${company}${rfqGroup ? ` — ${rfqGroup}` : ""}`,
      body: `${company} submitted a quote through their intake link.${changeNote ? ` Note: ${changeNote}` : ""} Run the AI read from the project's Costs tab to tabulate it.`,
      link: `/projects/${projectId}?tab=costs`,
      resource: { type: "project", id: projectId }, followers: true,
      metadata: { quote: true, rfqGroup, quoteId },
    });
    await audit(ref, {
      action: "INTAKE_QUOTE_SUBMISSION",
      resource_type: "cost", resource_id: quoteId,
      org_id: orgId, user_id: null, user_email: contactEmail,
      details: { company, projectId, rfqGroup, fileName: safeName, size: file.size, contentType, note: changeNote, appSession: session },
    });
    await bumpUse(ref, linkId, file.size);

    return NextResponse.json({
      ok: true,
      quoteId,
      status: "quote_received",
      message: `Your quote is in — ${String(project.name ?? "the project")}'s team has been notified. You'll be contacted about the award decision.`,
    });
  }

  // ── Redline branch: markups for a collision ticket that references this
  // link. The file attaches to the ticket (REDLINE_ prefix — the drafter's
  // revision banner surfaces it), never touches any document. ──
  if (branch === "redline" && ticketId) {
    // INTK-13 dw2: ownership is part of the lookup — a ticket that does not
    // name this link and a ticket that does not exist answer the same.
    const { data: ticket, error: tErr } = UUID_RE.test(ticketId)
      ? await supabaseAdmin
          .from("tickets")
          .select("id, ticket_id, title, attachments, history, metadata, assigned_drafter_id, requester_id")
          .eq("id", ticketId).eq("org_id", orgId)
          .eq("metadata->intake_collision->>intakeLinkId", linkId)
          .maybeSingle()
      : { data: null, error: null };
    if (tErr) return fail("This redline request could not be checked right now — try again shortly.", 503, `ticket read: ${tErr.message}`);
    const meta = ((ticket?.metadata ?? {}) as { intake_collision?: { intakeLinkId?: string | null } });
    if (!ticket || String(meta.intake_collision?.intakeLinkId ?? "") !== linkId) {
      return fail("No redline request on this link matches that ticket.", 404);
    }

    const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "redline";
    const key = `orgs/${orgId}/project-intake/${projectId}/redlines/${crypto.randomUUID()}-${safeName}`;
    if (!(await putObject(key, bytes, contentType))) return fail("File storage failed — try again.", 502);

    const attachment = {
      id: crypto.randomUUID(),
      name: `REDLINE_${safeName}`,
      url: key,
      type: "Reference",
      status: "submitted",
      size: `${(file.size / (1024 * 1024)).toFixed(2)} MB`,
      uploadedBy: `${company} (intake)`,
      uploadedAt: nowIso,
    };
    const { error: updErr } = await supabaseAdmin.from("tickets").update({
      attachments: [...((ticket.attachments as unknown[] | null) ?? []), attachment],
      history: [...((ticket.history as unknown[] | null) ?? []), {
        action: "Redline markups received via intake portal",
        user: company, date: nowIso,
        details: changeNote || safeName,
      }],
      last_modified: nowIso,
    }).eq("id", ticketId);
    if (updErr) return fail("Couldn't attach the redline — try again shortly.", 500, `ticket update: ${updErr.message}`);

    const involved = [...new Set([
      ...(ticket.assigned_drafter_id ? [String(ticket.assigned_drafter_id)] : []),
      ...(ticket.requester_id ? [String(ticket.requester_id)] : []),
    ])];
    try {
      await asServiceRole(async () => {
        const { emit } = await import("@/lib/notify/dispatch");
        await emit({
          orgId, category: "watched", kind: "ticket_comment",
          title: `Redlines received: ${String(ticket.title ?? "collision ticket")}`,
          body: `${company} uploaded redline markups through their intake portal.${changeNote ? ` Note: ${changeNote}` : ""}`,
          link: `/requests/${ticketId}`,
          resource: { type: "ticket", id: ticketId }, actorName: company,
          audience: { involved, followers: true },
          metadata: { intake: true, redline: true },
        });
      });
    } catch (e) {
      console.error(`[intake/upload] ref=${ref} redline notice failed: ${(e as Error).message}`);
    }
    kickDrain(req);

    await audit(ref, {
      action: "INTAKE_REDLINE",
      resource_type: "ticket", resource_id: ticketId,
      org_id: orgId, user_id: null, user_email: contactEmail,
      details: { company, projectId, ticketNumber: ticket.ticket_id, fileName: safeName, size: file.size, contentType, note: changeNote, appSession: session },
    });
    await bumpUse(ref, linkId, file.size);

    return NextResponse.json({
      ok: true,
      ticketId,
      status: "redline_received",
      message: `Redlines attached to ${String(ticket.ticket_id ?? "the ticket")} — the drafting team has been notified.`,
    });
  }

  // ── Document branch ─────────────────────────────────────────────────────
  const title = String(form.get("title") ?? "").trim() || null;
  const number = String(form.get("number") ?? "").trim() || null;
  const revLabel = String(form.get("revLabel") ?? "").trim() || (docId ? "" : "A");
  if (!docId && !title) return fail("A title is required for a new document.", 400);
  if (docId && !revLabel) return fail("A revision label is required.", 400);
  const textErr = validateIntakeText({ title, number, revLabel });
  if (textErr) return fail(textErr, 400);
  if (docId && !UUID_RE.test(docId)) return fail("This link may only submit revisions to its own or assigned documents.", 403);

  const libraryId = (project.intake_library_id as string | null) ?? null;
  if (!libraryId) return fail("This link isn't fully configured yet — ask your contact to set the intake library.", 409);

  // ── Scope for revisions: the link's OWN document, or an ASSIGNED one ──
  const assigned = ((link.assigned_doc_ids as string[] | null) ?? []).map(String);
  const trusted = !!link.allow_auto_supersede;
  let targetDoc: Record<string, unknown> | null = null;
  let isAssigned = false;
  let ownDoc = false;
  if (docId) {
    isAssigned = assigned.includes(docId);
    // INTK-9 / SEC-11: every document read is the LINK'S org's.
    const { data: d, error: dErr } = await supabaseAdmin
      .from("documents")
      .select("id, org_id, document_number, title, name, rev, status, current_version_id, pending_version_id, library_id, collection_id, review_control, checked_out_by, legal_hold")
      .eq("id", docId).eq("org_id", orgId).maybeSingle();
    if (dErr) return fail("This link's documents could not be checked right now — try again shortly.", 503, `document read: ${dErr.message}`);
    // INTK-1 / SEC-3 / SEC-12: authorship is fixed at creation — and an
    // assigned document is never the link's own, whatever its history.
    ownDoc = !!d && !isAssigned && (await linkAuthorOf(docId, orgId)) === linkId;
    if (!isAssigned && !ownDoc) return fail("This link may only submit revisions to its own or assigned documents.", 403);
    if (!d) return fail("Document not found.", 404);
    targetDoc = d as Record<string, unknown>;
  }

  // ── REL-8: a retry of the same bytes returns the original record ──────
  {
    let q = supabaseAdmin
      .from("document_versions").select("id, record_id, review_state, released_at, created_at")
      .eq("intake_link_id", linkId).eq("file_hash", fileHash).gte("created_at", since);
    if (docId) q = q.eq("record_id", docId);
    const { data: prior, error: priorErr } = await q.order("created_at", { ascending: false }).limit(5);
    if (!priorErr) {
      const hit = (((prior ?? []) as Array<Record<string, unknown>>))
        .find((v) => v.review_state === "in_review" || (v.review_state == null && v.released_at != null));
      if (hit) {
        const inReview = hit.review_state === "in_review";
        return NextResponse.json({
          ok: true, documentId: String(hit.record_id), versionId: String(hit.id), duplicate: true,
          status: inReview ? "in_review" : "published",
          message: "This file was already received — nothing new was stored.",
        });
      }
    }
  }

  // ── The pending draft ─────────────────────────────────────────────────
  const priorPending = (targetDoc?.pending_version_id as string | null) ?? null;
  if (targetDoc && priorPending) {
    // RG-10: a pending draft that carries a reviewer roster is an ORG
    // review in progress (sign-offs pending or already given). Repointing
    // the pending pointer past it — even on a trusted, link-authored
    // document — would orphan those sign-offs on a draft nothing points
    // at. Refuse; the review must complete or be rejected first. An
    // unreadable roster refuses too (fail closed).
    const { data: rosterRows, error: rosterErr } = await supabaseAdmin
      .from("document_review_signoffs").select("id")
      .eq("document_version_id", priorPending).in("status", ["pending", "signed"]).limit(1);
    if (rosterErr) return fail("The document's review state could not be verified — try again.", 503, `roster read: ${rosterErr.message}`);
    if ((rosterRows?.length ?? 0) > 0) {
      return fail("A reviewer sign-off is in progress on this document — it must be completed or rejected before a new submission can be taken.", 409);
    }
    // Only a TRUSTED link may replace a pending submission, only on its own
    // document, and only a pending draft that is ITS OWN earlier
    // submission. Everyone this answer reaches is bound by it (INTK-4 dw3).
    let replaceable = trusted && ownDoc;
    if (replaceable) {
      const { data: pv, error: pvErr } = await supabaseAdmin
        .from("document_versions").select("intake_link_id").eq("id", priorPending).eq("org_id", orgId).maybeSingle();
      if (pvErr) return fail("The document's review state could not be verified — try again.", 503, `pending read: ${pvErr.message}`);
      replaceable = String((pv as { intake_link_id?: string | null } | null)?.intake_link_id ?? "") === linkId;
    }
    if (!replaceable) {
      return fail("Your previous submission for this document is still in review — it must be approved or rejected first.", 409);
    }
  }

  // ── Auto-publish eligibility (trusted link, OWN document, approved) ───
  // The INTK-1 authorship rule (recorded in audit-reports/DECISIONS.md):
  // link-authored = authored_by_link_id is this link AND not assigned AND
  // at least one human approval (current_version_id). Anything else goes
  // to review. Then every rail OWN-4 put here still
  // DEMOTES (never refuses) the upload: a hold, a checkout, the creator's
  // authority, the library's review policy (SEC-13).
  let autoNow = !!targetDoc && trusted && ownDoc && !!targetDoc.current_version_id;
  let autoWithheld: string | null = null;
  if (targetDoc && trusted && ownDoc && !targetDoc.current_version_id) {
    autoWithheld = "this document has never had an approved revision — its first revision is always reviewed";
  }
  if (autoNow && targetDoc && docId) {
    // A rejected submission is never re-published by resubmitting it: after
    // a rejection, the next submission on this document is reviewed.
    const { data: lastOwn, error: lastErr } = await supabaseAdmin
      .from("document_versions").select("review_state")
      .eq("record_id", docId).eq("intake_link_id", linkId)
      .order("created_at", { ascending: false }).limit(1);
    if (lastErr) { autoNow = false; autoWithheld = "the document's submission history could not be verified"; }
    else if ((((lastOwn ?? []) as Array<{ review_state: string | null }>)[0]?.review_state) === "rejected") {
      autoNow = false; autoWithheld = "your previous submission for this document was not accepted — the next one is reviewed";
    }
  }
  if (autoNow && targetDoc && docId) {
    // 1. A hold ALWAYS blocks a promote — HLD-1's shared gate, which fails
    //    closed: "the hold status could not be verified" demotes, never
    //    publishes.
    if (targetDoc.legal_hold) {
      autoNow = false; autoWithheld = "the document is under legal hold";
    } else {
      const holdDecision = decideHoldGate(await readActiveHolds(docId, supabaseAdmin));
      if (holdDecision.blocked) {
        autoNow = false;
        autoWithheld = holdDecision.unreadable ? "the hold status could not be verified" : "the document has an active hold";
      }
    }
    // 2. A live checkout blocks the instant promote (someone is mid-change).
    if (autoNow && targetDoc.checked_out_by) {
      autoNow = false; autoWithheld = "the document is checked out";
    }
    // 3. The trusted link acts under its CREATOR's authority, evaluated NOW:
    //    the person who sanctioned auto-publish must still hold publish
    //    authority (or be a controller) on this library at promote time.
    if (autoNow) {
      try {
        const creator = (link.created_by as string | null) ?? null;
        let creatorMay = false;
        if (creator) {
          const { data: m } = await supabaseAdmin
            .from("org_members").select("role, roles").eq("org_id", orgId).eq("uid", creator).eq("status", "active").maybeSingle();
          // ADD-1: authority by the role COLLECTION, never the headline alone.
          creatorMay = memberHoldsAny(m, ["Admin", "DocCtrl"]);
          if (!creatorMay) {
            const { data: can } = await supabaseAdmin
              .rpc("user_can_publish_on_library", { p_library: targetDoc.library_id, p_uid: creator, p_org: orgId });
            creatorMay = can === true;
          }
        }
        if (!creatorMay) {
          autoNow = false;
          autoWithheld = "the link's creator no longer holds publish authority on this library";
        }
      } catch {
        autoNow = false; autoWithheld = "publish authority could not be verified";
      }
    }
    // 4. SEC-13 / DEC-36: a library (or folder, or the document) whose
    //    review policy REQUIRES sign-off is never published by a link — the
    //    SQL twin of the app's container-chain resolver decides. Unreadable
    //    policy → review (fail closed).
    if (autoNow) {
      const { data: mode, error: modeErr } = await supabaseAdmin.rpc("review_control_mode_for", {
        p_doc_control: targetDoc.review_control ?? null,
        p_collection_id: targetDoc.collection_id ?? null,
        p_library_id: targetDoc.library_id,
      });
      if (modeErr) { autoNow = false; autoWithheld = "the library's review policy could not be verified"; }
      else if (mode === "require") { autoNow = false; autoWithheld = "this library requires reviewer sign-off"; }
    }
  }

  // ── A new document: the intake folder, and the number's uniqueness ────
  let collectionId: string | null = null;
  let uniquenessKey: string | null = null;
  if (!docId) {
    const { data: lib, error: libErr } = await supabaseAdmin
      .from("libraries").select("uniqueness_keys").eq("id", libraryId).eq("org_id", orgId).maybeSingle();
    if (libErr || !lib) return fail("This link isn't fully configured yet — ask your contact to check the intake library.", libErr ? 503 : 409, libErr ? `library read: ${libErr.message}` : undefined);
    // INTK-5: the same key every other creation path writes, so the partial
    // unique index sees an intake-born number from the moment it exists.
    uniquenessKey = computeUniquenessKey(
      { documentNumber: number, title, rev: null, status: "Draft", customFields: {} },
      ((lib as { uniqueness_keys?: string[] | null }).uniqueness_keys ?? null),
    );
    if (uniquenessKey) {
      const { data: clash, error: clashErr } = await supabaseAdmin
        .from("documents").select("id")
        .eq("library_id", libraryId).eq("uniqueness_key", uniquenessKey)
        .not("status", "in", "(Archived,Superseded)").limit(1);
      if (clashErr) return fail("The drawing number could not be checked right now — try again shortly.", 503, `uniqueness read: ${clashErr.message}`);
      if ((clash?.length ?? 0) > 0) {
        return fail("That drawing number is already in use in this project's library — to revise that drawing use the revision form, otherwise check the number.", 409, undefined, { code: "number_in_use" });
      }
    }
    const folder = await ensureIntakeFolder({
      orgId, projectId, projectName: String(project.name ?? "Project"), libraryId,
      current: (project.intake_collection_id as string | null) ?? null,
    });
    if ("error" in folder) return fail("Couldn't prepare the intake folder — try again shortly.", 500, folder.error);
    collectionId = folder.id;
  }

  // ── Store the bytes (after every refusal that needs none) ─────────────
  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "file";
  const key = `orgs/${orgId}/project-intake/${projectId}/${crypto.randomUUID()}-${safeName}`;
  if (!(await putObject(key, bytes, contentType))) return fail("File storage failed — try again.", 502);

  const label = targetDoc
    ? String(targetDoc.document_number || targetDoc.title || targetDoc.name || "Document")
    : (number || title || "Document");

  // ── Create document (new) ──
  let documentId = docId;
  if (!documentId) {
    const docRow: Record<string, unknown> = {
      org_id: orgId, library_id: libraryId, collection_id: collectionId,
      name: title, title, document_number: number,
      status: "Draft",
      created_by_name: `${company} (intake)`,
      updated_at: nowIso,
      uniqueness_key: uniquenessKey,
      // INTK-1: the one authorship fact, written once, here.
      authored_by_link_id: linkId,
    };
    let { data: doc, error: docErr } = await supabaseAdmin.from("documents").insert(docRow).select("id").single();
    if (docErr && missingColumn(docErr, "authored_by_link_id")) {
      // Pre-20261104: authorship falls back to the first version's link.
      delete docRow.authored_by_link_id;
      ({ data: doc, error: docErr } = await supabaseAdmin.from("documents").insert(docRow).select("id").single());
    }
    if (docErr && String(docErr.code ?? "") === "23505") {
      return fail("That drawing number is already in use in this project's library — to revise that drawing use the revision form, otherwise check the number.", 409, `documents insert: ${docErr.message}`, { code: "number_in_use" });
    }
    if (docErr || !doc) return fail("Couldn't create the document — try again shortly.", 500, `documents insert: ${docErr?.message ?? "no row"}`);
    documentId = String((doc as { id: string }).id);
  }
  const theDocId = String(documentId);

  // ── Publish (trusted, eligible) or queue for review ───────────────────
  let versionId: string | null = null;
  let published = false;
  if (autoNow && targetDoc) {
    const outcome = await publishThroughContract({
      documentId: theDocId,
      expectedBase: (targetDoc.current_version_id as string | null) ?? null,
      creator: String(link.created_by),
      company, revLabel, key, contentType, size: file.size, changeNote, fileHash,
    });
    if (outcome.kind === "refuse") return fail(outcome.message, outcome.status, outcome.detail);
    if (outcome.kind === "demote") {
      autoWithheld = outcome.reason;
      if (outcome.detail) console.error(`[intake/upload] ref=${ref} ${outcome.detail}`);
    } else {
      versionId = outcome.versionId;
      published = true;
    }
  }

  const withdraw = async (msg: string, detail?: string) => {
    if (versionId) {
      await supabaseAdmin.from("document_versions").update({ superseded_at: nowIso }).eq("id", versionId).then(() => undefined, () => undefined);
    }
    return fail(msg, 409, detail);
  };

  if (published && versionId) {
    // publish_revision's INSERT carries no intake_link_id: stamp the
    // provenance so the portal register and the review queue see it.
    const { error: stampErr } = await supabaseAdmin.from("document_versions").update({ intake_link_id: linkId }).eq("id", versionId);
    if (stampErr) console.error(`[intake/upload] ref=${ref} provenance stamp failed on ${versionId}: ${stampErr.message}`);
    if (priorPending) {
      // The link's own earlier (roster-free) submission is displaced by the
      // publish — clear the pointer only if it still names that draft.
      const { data: cleared, error: clearErr } = await supabaseAdmin.from("documents")
        .update({ pending_version_id: null, updated_at: nowIso })
        .eq("id", theDocId).eq("pending_version_id", priorPending).select("id");
      if (clearErr) console.error(`[intake/upload] ref=${ref} pending pointer clear failed: ${clearErr.message}`);
      if ((cleared as unknown[] | null)?.length) {
        await retireDisplaced(ref, { orgId, documentId: theDocId, displacedId: priorPending, byVersionId: versionId, company, projectId, nowIso, contactEmail });
      }
    }
    // INTK-2 / SAF-5: the same post-publish pipeline, with the same
    // arguments, as finalizeReviewedRevision — stale-copy signals, recall,
    // work-package drift, revision impact, stale proposals, the review
    // cycle, a fresh read-&-understood roster, retention. Settled under the
    // service role before the response.
    try {
      await asServiceRole(async () => {
        const { runPostPublishSideEffects } = await import("@/lib/postPublish");
        await runPostPublishSideEffects({
          orgId,
          documentId: theDocId,
          libraryId: String(targetDoc?.library_id ?? ""),
          docLabel: label,
          newRev: revLabel,
          actorUserId: String(link.created_by),
          actorName: `${company} (intake)`,
          actorEmail: contactEmail,
          settle: true,
        });
      });
    } catch (e) {
      console.error(`[intake/upload] ref=${ref} post-publish pipeline failed: ${(e as Error).message}`);
    }
  } else {
    const { data: ver, error: verErr } = await supabaseAdmin
      .from("document_versions")
      .insert({
        org_id: orgId, record_id: theDocId,
        revision_label: revLabel || "A",
        file_url: key, file_type: contentType, size: file.size,
        change_log: changeNote ?? `Submitted by ${company} via project intake`,
        created_by_name: company, created_at: nowIso,
        released_at: null,
        // OWN-4: an external upload is never "approved" by arriving — it is
        // in review until a person decides.
        review_state: "in_review",
        provenance: "external",
        intake_link_id: linkId,
        file_hash: fileHash,
        // REV-5: the base this submission was made against — finalize
        // refuses to promote a draft whose base is no longer current.
        supersedes_version_id: (targetDoc?.current_version_id as string | null) ?? null,
      })
      .select("id").single();
    if (verErr && String(verErr.code ?? "") === "23505") {
      const msg = `${verErr.message ?? ""} ${verErr.details ?? ""}`;
      if (/intake_inflight/.test(msg)) {
        // REL-8: a concurrent retry of the same bytes won — answer with it.
        const { data: winner } = await supabaseAdmin.from("document_versions").select("id, record_id")
          .eq("intake_link_id", linkId).eq("file_hash", fileHash).eq("review_state", "in_review").limit(1);
        const w = (((winner ?? []) as Array<{ id: string; record_id: string }>)[0]) ?? null;
        if (w) return NextResponse.json({ ok: true, documentId: String(w.record_id), versionId: String(w.id), duplicate: true, status: "in_review", message: "This file was already received — nothing new was stored." });
      }
      return fail(`Rev ${revLabel || "A"} already exists on this document — submit it with a new revision label.`, 409, `version insert: ${verErr.message}`);
    }
    if (verErr || !ver) return fail("Couldn't record the submission — try again shortly.", 500, `version insert: ${verErr?.message ?? "no row"}`);
    versionId = String((ver as { id: string }).id);

    // RG-10: the pointer write is COMPARE-AND-SET on the pending pointer
    // read above — from NULL, or (a trusted link replacing its own
    // roster-free draft, checked above) from exactly that draft. A pointer
    // that moved to anything else is a lost race: the new version retires.
    let point = supabaseAdmin.from("documents")
      .update({ pending_version_id: versionId, updated_at: nowIso })
      .eq("id", theDocId);
    point = priorPending ? point.eq("pending_version_id", priorPending) : point.is("pending_version_id", null);
    const { data: pointed, error: pointErr } = await point.select("id");
    if (pointErr) return withdraw("Couldn't queue the submission for review — try again shortly.", `pending pointer write: ${pointErr.message}`);
    if (!pointed || pointed.length === 0) return withdraw("Another revision of this document just went into review — your submission was not taken. Try again once it is approved or rejected.");
    if (priorPending) {
      await retireDisplaced(ref, { orgId, documentId: theDocId, displacedId: priorPending, byVersionId: versionId, company, projectId, nowIso, contactEmail });
    }
  }

  // ── Notify the project team + audit ──
  const displacedNote = priorPending ? " It replaced their earlier submission, which was still awaiting review." : "";
  if (published) {
    await notifyTeam({
      kind: "doc_superseded",
      title: `Intake: ${label} published as Rev ${revLabel} by ${company}`,
      body: `${company} published a new revision through their trusted intake link. It is now current.${displacedNote}`,
      link: `/projects/${projectId}`,
      resource: { type: "document", id: theDocId },
      // Followers and live intent holders heard it from the post-publish
      // pipeline's stale-copy signal already.
      followers: false,
      metadata: { versionId },
      force: !!priorPending,
    });
  } else {
    let intentHolders: string[] = [];
    if (docId) {
      try {
        intentHolders = await asServiceRole(async () => {
          const { listLiveIntents } = await import("@/lib/intents");
          return (await listLiveIntents(theDocId)).map((i) => i.userId);
        });
      } catch (e) {
        console.error(`[intake/upload] ref=${ref} intent holders unreadable: ${(e as Error).message}`);
      }
    }
    await notifyTeam({
      kind: "review_requested",
      title: `Intake submission awaiting review: ${label} (${company})`,
      body: `${company} submitted ${docId ? `Rev ${revLabel}` : "a new document"} on the project — review and approve it from the project's Intake tab.` +
        (autoWithheld ? ` (Auto-publish was withheld: ${autoWithheld}.)` : "") + displacedNote,
      link: `/projects/${projectId}`,
      resource: { type: "document", id: theDocId },
      followers: !!docId,
      extraInvolved: intentHolders,
      metadata: { versionId },
      force: !!priorPending,
    });
  }

  await audit(ref, {
    action: published ? "INTAKE_AUTO_SUPERSEDE" : "INTAKE_SUBMISSION",
    resource_type: "document", resource_id: theDocId,
    org_id: orgId, user_id: null, user_email: contactEmail,
    details: {
      company, projectId, versionId, revLabel: revLabel || "A", fileName: safeName, size: file.size, contentType,
      autoWithheld, displacedVersionId: priorPending, assigned: isAssigned, appSession: session,
    },
  });
  await bumpUse(ref, linkId, file.size);

  return NextResponse.json({
    ok: true,
    documentId: theDocId,
    versionId,
    status: published ? "published" : "in_review",
    message: published
      ? `Rev ${revLabel} of ${label} is now the current revision.`
      : `Submitted — ${label} is with the project team for review. You'll see it marked approved here once accepted.`,
    // The external party sees the demotion too — their "trusted" upload
    // landing in review instead of publishing is otherwise inexplicable.
    ...(autoWithheld ? { note: `Automatic publication was withheld (${autoWithheld}); the project team will review it.` } : {}),
  });
}
