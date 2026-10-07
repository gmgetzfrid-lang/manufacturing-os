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
//     project's existence and status, the declared Content-Length, the
//     link's lifetime budget — BEFORE the body is read (INTK-8 / SEC-8 /
//     SEC-6 / PM-2). The multipart body is parsed only for a live link.
//     The one exception is the direct door's small JSON step body (INTK-15,
//     below): at most 16 KB, read through a capped reader whatever its
//     Content-Length says (or does not say), right after the link lookup —
//     because a finalize must CLAIM its staged object before it can answer
//     a revoked or expired link, a closed project or a spent budget (and
//     delete the object on that answer).
//   * The bytes decide the type (lib/fileSniff.ts): an allowlist per branch,
//     the stored ContentType is the sniffed one, never the uploader's claim
//     (SEC-1 / SEC-6 / INTK-11).
//   * The project must still exist and be open (PM-2 / PM-1's route limb) —
//     checked from the link, before the body.
//   * Authorship is a fact fixed at creation — documents.authored_by_link_id
//     (20261104) — never the version chain this route appends to (INTK-1 /
//     SEC-3 / SEC-12); from 20261141 the database holds it fixed (a
//     signed-in session can neither stamp nor clear it — INTK-16's
//     trg_documents_authorship_fixed). A document the link was ASSIGNED
//     always goes through review; so does one that has never had an
//     approved revision.
//   * Every document read is scoped to the link's org (INTK-9 / SEC-11).
//   * The trusted promote goes THROUGH publish_revision (the hold gate, the
//     checkout lock, the expected-base check and the drawing-class MOC gate
//     run in the database, acting as the link's creator), then the shared
//     post-publish pipeline runs under the service role (INTK-2 / SAF-5 /
//     SEC-4 / SEC-14). A refused promote DEMOTES the upload to review — the
//     file is still wanted; only the instant publish is withheld (OWN-4).
//   * A submission that displaces the link's own pending one resolves it —
//     retired 'superseded' BEFORE the replacement is inserted (restored if
//     the replacement fails), an audit row, a notice (INTK-4 / SAF-10).
//   * Notices go through emit() (followers, intent holders, preferences,
//     dedupe) — one per link per window; a published revision or a replaced
//     submission does not wait for the window, but a window holds at most
//     three notices; folded ones are counted, by kind (INTK-10 / SEC-8 dw2).
//   * A new document's uniqueness key is written only when the door can fill
//     the library's whole tuple (INTK-5) — a sheet set's shared number is
//     not a duplicate.
//   * A retried upload of the same bytes returns the original record —
//     only a LIVE one: the document still points at it, nothing withdrew
//     it, and it is the record THIS request would have made (the same
//     document, or a new document still in its first review). The same
//     bytes live on another document are refused with a sentence, never
//     answered with that document's ids (REL-8 / INTK-13). Every failure
//     the portal sees is a plain sentence plus a reference id — the
//     database message stays in the server log.
//   * A quote is filed against the project party the link's company names
//     (COST-12's intake limb); a document the door creates is referenced
//     from the project (project_documents, DEC-40 — by reference, never a
//     copy).
//
// Header: x-intake-token (or query ?token=). Fields: file, and either docId
// (new revision of an own/assigned document), ticketId (redlines for a
// collision ticket that names this link), or title [+ number] (brand-new
// document). Optional revLabel, changeNote.
//
// INTK-15 — the direct door (the portal's path): the bytes never travel
// through this function's request body, so the 100 MB limit is the
// storage's, not the platform's body cap. Staging: lib/intakeStaging.ts.
//   POST ?step=begin    {fileName, size, contentType}  — every credential,
//        project and budget check above, the rate window counted (the
//        upload's attempt); the declared size is held to the link's budget
//        COUNTING the bytes it has staged and not had claimed (its expired
//        reservations swept first), and RESERVED; answers a presigned PUT
//        (10 minutes, its Content-Length SIGNED to the declared size) for a
//        fresh key under the link's own prefix of the one staging root,
//        intake-staging/<org>/<project>/<link>/<uuid>.
//   (the portal PUTs the bytes straight to storage)
//   POST ?step=finalize {uploadKey, fileName, contentType, fields} — its own
//        rate window (per token and per IP, the same limits); once the link
//        is read, the key must be the link's own staged key and its
//        reservation is CLAIMED for this token (one DELETE … RETURNING: of
//        concurrent finalizes exactly one proceeds, the others are refused
//        before a byte is read). From the claim on, this request OWNS the
//        staged object and deletes it when it ends, whatever it answers — a
//        revoked or expired link, a closed project, a spent budget, a
//        missing object, a refused type, a filed upload. Then the stored
//        size (HEAD, with its ETag) is held to the limit and the budget; a
//        RANGED read of the first bytes is sniffed (lib/fileSniff.ts) before
//        the rest is read; both reads are pinned to the HEAD's ETag
//        (If-Match — a re-PUT meanwhile is refused) and the full read's head
//        must be the sniffed head — and from there the request is exactly
//        the multipart one: the same hash, idempotency, collision scan,
//        storage under the sniffed type, review / publish contract,
//        post-publish pipeline, notices and audit.
// A begin never finalized (a closed tab, an abandoned upload) keeps its
// reservation counting until the link's next begin or the maintenance cron
// sweeps the object and then the row (STAGING_TTL_MS). The multipart POST
// above stays — a portal tab opened before this change, and the portal's
// fallback when storage refuses or cannot be reached; a fallback names its
// begin in the x-intake-begun header, which is claimed once and not counted
// again.
//
// J16 (GAP-401) — the door's constrained identity. Every CONTENT write the
// door makes, on both paths (multipart and finalize) — a new document, a
// submission, its pending pointer, the trusted promote, a quote, a redline —
// goes first through a door function (20261184): SECURITY DEFINER and the
// service role's only, it resolves the link from its token HASH in the
// database (live, its project open — a revocation is effective mid-request
// too), refuses a write outside the link's project / library / documents,
// and binds the door's identity for that one write (auth.uid() = the link;
// for the promote, the link's creator) so every guard a member's write meets
// judges the door's write too. While the function is not there (20261184 not
// pasted: PGRST202, or 42883 naming an intake_door_ function at the start of
// its message — decided by the CODE, never by a message alone) the write is
// the service-role write below it, unchanged. Any OTHER answer — a guard, the
// link's scope, a dead link — is answered and never followed by the
// service-role write. The door's housekeeping of its own rows (retiring a
// displaced submission, withdrawing a lost race, restoring, discarding, the
// intake folder, the project reference) stays service-role (projects-tab
// SEC-22).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";
import { memberHoldsAny, roleFilter } from "@/lib/roleHeld";
import { runWithServerClient } from "@/lib/serverClientScope";
import { readActiveHolds, decideHoldGate } from "@/lib/holdGate";
import { matchCompanyByName } from "@/lib/bidTab";
import { validateIntakeFile, type IntakeBranch } from "@/lib/fileSniff";
import {
  INTAKE_TOKEN_RE, intakeTokenFromRequest, CLOSED_PROJECT_STATUSES,
  LINK_GONE_MESSAGE, LINK_INVALID_MESSAGE, PROJECT_CLOSED_MESSAGE, INTAKE_NOTE_MAX, validateIntakeText,
  completeUniquenessKey, INTAKE_SUPPLIED_KEY_PARTS, readIntakeLinkByToken, INTAKE_BEGUN_HEADER,
} from "@/lib/intakeLinks";
import {
  intakeLimits, sha256Hex, clientIp, checkIntakeRate, recordIntakeAttempt,
  noticesInWindow, noticeGoesOut, foldedSinceLastNotice, foldedNoticeSentence, readLinkBudget, linkBudgetRefusal, ATTEMPT_OUTCOME,
} from "@/lib/intakeRateLimit";
import { stagingPrefix, stagedIdUnder, begunIdOf, reserveStaged, claimStaged, sweepAndReserved } from "@/lib/intakeStaging";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
/** Multipart framing around the file (boundaries, the other fields). */
const MULTIPART_SLACK = 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A retry of the same bytes inside this window returns the original. */
const IDEMPOTENCY_WINDOW_MS = 24 * 3600 * 1000;
/** INTK-15: how long a direct upload's presigned PUT lives. */
const DIRECT_PUT_SECONDS = 600;
/** INTK-15: a JSON step body (begin / finalize) is small — refused unread above this. */
const DIRECT_BODY_MAX = 16 * 1024;
/** INTK-15: the form fields a finalize may carry (the multipart names). */
const DIRECT_FIELDS: readonly string[] = ["docId", "ticketId", "title", "number", "revLabel", "changeNote"];

type PgError = { message?: string; code?: string; details?: string | null } | null | undefined;

/** A database that has not received a column yet (a migration applied by
 *  hand, later than the deploy). */
function missingColumn(e: PgError, col: string): boolean {
  const msg = `${e?.message ?? ""} ${e?.details ?? ""}`;
  return !!e && msg.includes(col) && (/^(42703|PGRST204)$/.test(String(e.code ?? "")) || /does not exist|could not find/i.test(msg));
}

// ── The shared client, bound to the service role for the pipeline ──────────
// lib/postPublish.ts, lib/notify/dispatch.ts and lib/intents.ts are written
// against the shared `supabase` client (a browser session in the app). This
// route has no session, so they run with the shared client resolving to the
// service role — REQUEST-SCOPED (lib/serverClientScope.ts, AsyncLocalStorage):
// only the async context of `fn` sees it. Another request served by the
// same instance meanwhile (grouped routes, in-instance concurrency) keeps
// its own client — the binding never leaks past this upload (DEC-56).
// Nothing else in this route uses the shared client.
function asServiceRole<T>(fn: () => Promise<T>): Promise<T> {
  return runWithServerClient(supabaseAdmin, fn);
}

// ── J16 (GAP-401): the door's constrained identity (20261184) ──────────────
/** Per request: once a door function answers "not there", every later write
 *  in the request takes today's path — one migration creates them all. */
interface DoorState { absent: boolean }
type DoorError = { message?: string; code?: string; details?: string | null; hint?: string | null };
type DoorAnswer<T> = { kind: "absent" } | { kind: "ok"; data: T } | { kind: "error"; error: DoorError };

/** The migration is not pasted: PostgREST cannot find the door function
 *  (PGRST202), or the database answers 42883 for an intake_door_ function
 *  it does not have ("function public.intake_door_…(…) does not exist") —
 *  or intake_door_append_redline's own 42883 while append_ticket_redline
 *  (20261166) is not pasted, which names itself first.
 *  Decided by the CODE: a guard's refusal (23514, P0001, …) is never
 *  "absent", whatever its message says — a guard message can carry text the
 *  contractor chose (a document number), and "absent" sends the request
 *  down the service-role path the guards exempt. A 42883's message is
 *  matched only at its START, where Postgres (or the redline door) puts the
 *  function's name. */
function doorFunctionAbsent(e: DoorError): boolean {
  const code = String(e.code ?? "");
  if (code === "PGRST202") return true;
  if (code !== "42883") return false;
  const msg = String(e.message ?? "");
  return /^function (public\.)?intake_door_[a-z_]+\(/.test(msg) || msg.startsWith("intake_door_append_redline:");
}

/** One door call. Skipped once this request has seen the migration absent. */
async function viaDoor<T>(state: DoorState, call: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<DoorAnswer<T>> {
  if (state.absent) return { kind: "absent" };
  const { data, error } = await call();
  if (!error) return { kind: "ok", data: data as T };
  const e = error as DoorError;
  if (doorFunctionAbsent(e)) {
    state.absent = true;
    return { kind: "absent" };
  }
  return { kind: "error", error: e };
}

/** What the portal hears when a door function refuses: the link went dead
 *  mid-request (28000 — its HINT says how; the same answers as the checks
 *  before the body), or a write outside the link's scope (42501). Anything
 *  else is the caller's to answer as the write's own failure. */
type DoorScope = { message: string; status: number; code?: string };
function doorAnswer(e: DoorError, scope: DoorScope): { message: string; status: number; code: string } | null {
  const code = String(e.code ?? "");
  if (code === "28000") {
    switch (String(e.hint ?? "")) {
      case "revoked": return { message: "This link has been revoked.", status: 410, code: "revoked" };
      case "expired": return { message: "This link has expired.", status: 410, code: "expired" };
      case "link_gone": return { message: LINK_GONE_MESSAGE, status: 410, code: "link_gone" };
      case "project_closed": return { message: PROJECT_CLOSED_MESSAGE, status: 410, code: "project_closed" };
      default: return { message: LINK_INVALID_MESSAGE, status: 404, code: "notfound" };
    }
  }
  if (code === "42501") {
    if (String(e.hint ?? "") === "not_configured") {
      return { message: "This link isn't fully configured yet — ask your contact to set the intake library.", status: 409, code: "not_configured" };
    }
    return { message: scope.message, status: scope.status, code: scope.code ?? "door_scope" };
  }
  return null;
}

const DOOR_SCOPE_DOCUMENTS: DoorScope = { message: "This link may only submit revisions to its own or assigned documents.", status: 403 };
/** A NEW document the door would not file: the folder the route filed into
 *  is not (or no longer) the project's intake folder inside its intake
 *  library — a configuration answer, never the revision sentence. (A quote
 *  link never reaches the document branch.) */
const DOOR_SCOPE_NEW_DOCUMENT: DoorScope = { message: "This link isn't fully configured yet — ask your contact to check the project's intake library and folder.", status: 409, code: "not_configured" };

/** INTK-13: the portal gets a plain sentence and a reference id; any
 *  database detail goes to the server log under the same id. */
function refuser(ref: string) {
  return (msg: string, status: number, detail?: string, extra?: Record<string, unknown>) => {
    if (detail) console.error(`[intake/upload] ref=${ref} ${detail}`);
    return NextResponse.json({ error: msg, ref, ...(extra ?? {}) }, { status });
  };
}

/** J16: a door function's refusal as the portal's answer (doorAnswer), or
 *  null when it is not one of those — the caller answers it as the write's
 *  own failure, and never retries the write as the service role. */
function doorRefused(e: DoorError, fail: ReturnType<typeof refuser>, scope: DoorScope): NextResponse | null {
  const a = doorAnswer(e, scope);
  return a ? fail(a.message, a.status, `door refused: ${e.code ?? ""} ${e.message ?? ""}`, { code: a.code }) : null;
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

/** INTK-15: the step a JSON request is (?step=begin | finalize), or null
 *  for the multipart door. */
function directStep(req: NextRequest): "begin" | "finalize" | null {
  const s = req.nextUrl.searchParams.get("step");
  return s === "begin" || s === "finalize" ? s : null;
}

/** INTK-15: a staged object's stored size and ETag, or null when it is not there. */
async function stagedHead(key: string): Promise<{ size: number; etag: string | null } | null | { error: string }> {
  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key })) as { ContentLength?: number; ETag?: string };
    return typeof head.ContentLength === "number"
      ? { size: head.ContentLength, etag: typeof head.ETag === "string" && head.ETag ? head.ETag : null }
      : { error: "staged object has no length" };
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (e as Error).name === "NotFound" || (e as Error).name === "NoSuchKey") return null;
    return { error: `staged object head: ${(e as Error).message}` };
  }
}

/** INTK-15: the staged object is no longer the one this request checked (a
 *  re-PUT on the still-valid URL, or a full read whose head is not the
 *  sniffed one). */
class StagedChangedError extends Error {
  constructor(detail: string) { super(detail); this.name = "StagedChangedError"; }
}

/** INTK-15: read a staged object — a byte range (the sniff's head) or all of
 *  it — pinned to the ETag its HEAD answered (If-Match): a re-PUT between
 *  the reads is a 412, never different bytes. */
async function readStaged(key: string, etag: string | null, range?: string): Promise<Uint8Array> {
  let out: { Body?: { transformToByteArray?: () => Promise<Uint8Array> } };
  try {
    out = await r2.send(new GetObjectCommand({
      Bucket: R2_BUCKET, Key: key, ...(range ? { Range: range } : {}), ...(etag ? { IfMatch: etag } : {}),
    })) as typeof out;
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 412 || (e as Error).name === "PreconditionFailed") throw new StagedChangedError(`staged object changed after its HEAD (${range ?? "whole"})`);
    throw e;
  }
  if (!out.Body?.transformToByteArray) throw new Error("staged object has no body");
  return out.Body.transformToByteArray();
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

/** Best-effort removal of an object this request stored and then did not
 *  use (a retry answered with the original, a refused insert, a staged
 *  upload). Answers whether it is gone. */
async function deleteObject(ref: string, key: string): Promise<boolean> {
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (e) {
    console.error(`[intake/upload] ref=${ref} unused object ${key} could not be removed: ${(e as Error).message}`);
    return false;
  }
}

/** Who authored this document: documents.authored_by_link_id (20261104),
 *  stamped only when the route CREATES a document. On a database without
 *  the column, the document's FIRST version (a fact fixed at creation —
 *  never the chain this route keeps appending to). An unreadable answer is
 *  an ERROR (the caller answers 503, "try again") — never read as "not
 *  authored", which would tell a contractor they may not revise their own
 *  drawing. */
async function linkAuthorOf(docId: string, orgId: string): Promise<{ author: string | null } | { error: string }> {
  const { data, error } = await supabaseAdmin
    .from("documents").select("authored_by_link_id").eq("id", docId).eq("org_id", orgId).maybeSingle();
  if (!error) return { author: ((data as { authored_by_link_id?: string | null } | null)?.authored_by_link_id as string | null) ?? null };
  if (!missingColumn(error, "authored_by_link_id")) return { error: `authorship read: ${error.message}` };
  const { data: first, error: firstErr } = await supabaseAdmin
    .from("document_versions").select("intake_link_id")
    .eq("record_id", docId).eq("org_id", orgId)
    .order("created_at", { ascending: true }).order("id", { ascending: true }).limit(1);
  if (firstErr) return { error: `first-version read: ${firstErr.message}` };
  return { author: ((first as Array<{ intake_link_id: string | null }> | null)?.[0]?.intake_link_id as string | null) ?? null };
}

/** REL-8: is an earlier submission of the same bytes from this link the
 *  ORIGINAL of this request — or something else that merely shares its
 *  bytes? `original` only when it is still live (the document points at
 *  it) and it is the record this request would have made: a revision of
 *  the same document, or — for a new-document upload — a new document
 *  still in its first review. A live in-review row that is NOT the
 *  original (another document, or a row nothing points at) `blocks`: the
 *  in-flight index would refuse the insert, and answering with its ids
 *  would name someone else's record. A published hit that is no longer
 *  current is neither. */
type PriorVerdict = "original" | "blocks" | "ignore";
async function classifyPrior(hit: { id: string; record_id: string; review_state: string | null; released_at: string | null },
  ctx: { orgId: string; docId: string | null }): Promise<PriorVerdict | { error: string }> {
  const { data: doc, error } = await supabaseAdmin
    .from("documents").select("id, pending_version_id, current_version_id")
    .eq("id", hit.record_id).eq("org_id", ctx.orgId).maybeSingle();
  if (error) return { error: `prior submission read: ${error.message}` };
  const d = (doc ?? null) as { pending_version_id?: string | null; current_version_id?: string | null } | null;
  if (hit.review_state === "in_review") {
    if (!d) return "blocks";
    const pointed = String(d.pending_version_id ?? "") === hit.id;
    if (ctx.docId) return hit.record_id === ctx.docId && pointed ? "original" : "blocks";
    // A new-document upload: the original is a document still in its first
    // review (never approved), whose pointer names the hit — or is not set
    // yet, when the original is itself mid-write.
    return !d.current_version_id && (pointed || d.pending_version_id == null) ? "original" : "blocks";
  }
  if (hit.review_state == null && hit.released_at != null) {
    return ctx.docId && hit.record_id === ctx.docId && d && String(d.current_version_id ?? "") === hit.id ? "original" : "ignore";
  }
  return "ignore";
}

const SAME_FILE_ELSEWHERE = "This same file is already awaiting review through this link on another submission — send the file meant for this one, or wait until that submission is decided.";

/** INTK-13 dw3: one intake folder per project, whatever the concurrency.
 *  The folder is created, then CLAIMED with a compare-and-set on the
 *  project's still-empty pointer; the loser deletes its own folder and uses
 *  the winner's. Every write is checked.
 *  J16 (GAP-401): the pointer the project row carries is used only when it
 *  names a folder OF the project's intake library in the link's org — the
 *  column is owner-writable and no database rail ties it to the library,
 *  and the door (intake_door_create_document, 20261184) files only into
 *  such a folder. Any other value (a folder of another library or org, or
 *  one that is gone) is treated as unset: a folder is made in the intake
 *  library and claimed with a compare-and-set on that stale value, so the
 *  contractor's drawing is filed before and after the paste alike, never
 *  into a folder outside the library. */
async function ensureIntakeFolder(input: {
  orgId: string; projectId: string; projectName: string; libraryId: string; current: string | null;
}): Promise<{ id: string } | { error: string }> {
  let stale: string | null = null;
  if (input.current) {
    const { data: cur, error: curErr } = await supabaseAdmin
      .from("collections").select("id")
      .eq("id", input.current).eq("org_id", input.orgId).eq("library_id", input.libraryId)
      .maybeSingle();
    if (curErr) return { error: `intake folder read: ${curErr.message}` };
    if (cur) return { id: input.current };
    stale = input.current;
    console.error(`[intake/upload] project ${input.projectId}: intake folder ${stale} is not a folder of the project's intake library ${input.libraryId} in its org — a folder is made there and the pointer moved to it`);
  }
  const { data: col, error: colErr } = await supabaseAdmin
    .from("collections")
    .insert({ org_id: input.orgId, library_id: input.libraryId, name: `Intake — ${input.projectName}` })
    .select("id").single();
  if (colErr || !col) return { error: `intake folder insert: ${colErr?.message ?? "no row"}` };
  const colId = String((col as { id: string }).id);
  const claim = supabaseAdmin
    .from("projects").update({ intake_collection_id: colId })
    .eq("id", input.projectId);
  const { data: claimed, error: claimErr } = await (stale
    ? claim.eq("intake_collection_id", stale)
    : claim.is("intake_collection_id", null)
  ).select("id");
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
  | { kind: "published"; versionId: string; stamped: boolean }
  | { kind: "demote"; reason: string; detail?: string }
  | { kind: "refuse"; status: number; message: string; detail?: string; code?: string };

/** SAF-5 / INTK-2 / SEC-4: the trusted promote is the SAME contract every
 *  internal publish uses — publish_revision, acting as the link's creator
 *  (the person who sanctioned auto-publish). It locks the document row,
 *  refuses a held document, a foreign checkout, a moved base and a
 *  duplicate label, and applies the drawing-class MOC gate — in the
 *  database, not in this route.
 *  J16 (GAP-401): through the door first (intake_door_promote, 20261184) —
 *  the creator and the link come from the link row the token hash names, and
 *  the creator is BOUND as the session, so the publish guard and the
 *  register / hold-label rails judge the documents write (on the service
 *  role they returned early); the new version's provenance is stamped in the
 *  same transaction (`stamped`). A guard's refusal demotes like any other; a
 *  link that went dead mid-request is refused. Before 20261184 is pasted,
 *  the service-role call below, unchanged. */
async function publishThroughContract(input: {
  documentId: string; expectedBase: string | null; creator: string; company: string;
  revLabel: string; key: string; contentType: string; size: number; changeNote: string | null; fileHash: string;
  door: { state: DoorState; tokenHash: string };
}): Promise<PublishOutcome> {
  const version = {
    revision_label: input.revLabel,
    file_url: input.key,
    file_type: input.contentType,
    size: input.size,
    change_log: input.changeNote ?? `Submitted by ${input.company} via project intake`,
    created_by_name: input.company,
    provenance: "external",
    file_hash: input.fileHash,
  };
  let data: unknown = null;
  let error: PgError = null;
  let stamped = false;
  const promoted = await viaDoor<Record<string, unknown>>(input.door.state, () => supabaseAdmin.rpc("intake_door_promote", {
    p_token_hash: input.door.tokenHash,
    p_doc: input.documentId,
    p_expected_base: input.expectedBase,
    p_version: version,
    p_actor_name: `${input.company} (intake)`,
  }));
  if (promoted.kind === "ok") {
    data = promoted.data;
    stamped = (promoted.data as { intake_link_stamped?: unknown } | null)?.intake_link_stamped === true;
  } else if (promoted.kind === "error") {
    const e = promoted.error;
    if (String(e.code ?? "") === "28000") {
      const a = doorAnswer(e, DOOR_SCOPE_DOCUMENTS);
      if (a) return { kind: "refuse", status: a.status, message: a.message, code: a.code, detail: `intake_door_promote: ${e.message ?? ""}` };
    }
    // 42501: the link's scope as the database reads it now (no longer
    // trusted, no creator, the document assigned meanwhile) — the upload
    // goes to review, where the submission's own door decides.
    if (String(e.code ?? "") === "42501") {
      return { kind: "demote", reason: "automatic publication could not be completed", detail: `intake_door_promote: ${e.message ?? ""}` };
    }
    error = e;
  } else {
    ({ data, error } = await supabaseAdmin.rpc("publish_revision", {
      p_doc: input.documentId,
      p_expected_base: input.expectedBase,
      p_op_class: "content",
      p_version: version,
      p_actor: input.creator,
      p_actor_name: `${input.company} (intake)`,
    }));
  }
  if (error) {
    if (/MOC reference/i.test(error.message ?? "")) {
      return { kind: "demote", reason: "a drawing-class revision needs a management-of-change (MOC) reference — the project team adds it when they review it" };
    }
    if (/not an active member/i.test(error.message ?? "")) {
      return { kind: "demote", reason: "the link's creator is no longer an active member" };
    }
    // J16: the publish guard's refusals, now that it judges the promote as
    // the creator — the same sentences the route's own gates give.
    if (/authority to publish|Only a publisher on this library/i.test(error.message ?? "")) {
      return { kind: "demote", reason: "the link's creator no longer holds publish authority on this library", detail: `publish guard: ${error.message}` };
    }
    if (/requires reviewer sign-off|outstanding review sign-offs/i.test(error.message ?? "")) {
      return { kind: "demote", reason: "this library requires reviewer sign-off", detail: `publish guard: ${error.message}` };
    }
    if (/active hold/i.test(error.message ?? "")) {
      return { kind: "demote", reason: "the document has an active hold", detail: `publish guard: ${error.message}` };
    }
    return { kind: "demote", reason: "automatic publication could not be completed", detail: `publish_revision: ${error.message}` };
  }
  const res = (data ?? {}) as { status?: string; version?: { id?: string } | null };
  switch (res.status) {
    case "published":
      if (res.version?.id) return { kind: "published", versionId: String(res.version.id), stamped };
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

/** INTK-4 / SAF-10: the submission a new one displaces is RESOLVED —
 *  'superseded' + superseded_at — BEFORE its replacement is inserted, so
 *  the replacement may carry the same revision label (the active-label
 *  index counts only rows with superseded_at NULL) and a failed retire
 *  refuses the upload instead of leaving an orphan behind. Compare-and-set
 *  on a still-undecided row: a draft a reviewer decided meanwhile is not
 *  touched ("decided"). Checked, retried once. Pre-20261105 databases (the
 *  review_state CHECK does not know 'superseded' yet) keep the older
 *  retire-by-superseded_at shape. */
async function retireDisplacedFirst(input: { displacedId: string; nowIso: string }): Promise<"retired" | "decided" | { error: string }> {
  const attempt = async () => {
    let r = await supabaseAdmin.from("document_versions")
      .update({ review_state: "superseded", superseded_at: input.nowIso })
      .eq("id", input.displacedId).eq("review_state", "in_review").is("superseded_at", null)
      .select("id");
    if (r.error && String(r.error.code ?? "") === "23514") {
      r = await supabaseAdmin.from("document_versions")
        .update({ superseded_at: input.nowIso })
        .eq("id", input.displacedId).eq("review_state", "in_review").is("superseded_at", null)
        .select("id");
    }
    return r;
  };
  let r = await attempt();
  if (r.error) r = await attempt();
  if (r.error) return { error: `displaced submission retire: ${r.error.message}` };
  return ((r.data as unknown[] | null)?.length ?? 0) > 0 ? "retired" : "decided";
}

/** Undo retireDisplacedFirst when the replacement did not land (its insert
 *  or its pointer write failed): the stamp this request wrote is cleared —
 *  whatever a reviewer did meanwhile (an approval that promoted the draft
 *  keeps its 'approved') — and the state goes back to 'in_review' only if
 *  it is still 'superseded'. Checked, retried once; a restore that cannot
 *  land is recorded as INTAKE_DISPLACE_UNRESOLVED (the maintenance cron's
 *  review-health line surfaces it) — the document's pending revision then
 *  names a draft the door retired, and a controller must resolve it. */
async function restoreDisplaced(ref: string, input: {
  orgId: string; documentId: string; displacedId: string; nowIso: string; projectId: string; contactEmail: string | null;
}): Promise<void> {
  const attempt = async () => {
    const a = await supabaseAdmin.from("document_versions")
      .update({ superseded_at: null }).eq("id", input.displacedId).eq("superseded_at", input.nowIso);
    if (a.error) return a.error;
    const b = await supabaseAdmin.from("document_versions")
      .update({ review_state: "in_review" }).eq("id", input.displacedId).eq("review_state", "superseded");
    return b.error;
  };
  let err = await attempt();
  if (err) err = await attempt();
  if (!err) return;
  console.error(`[intake/upload] ref=${ref} displaced submission ${input.displacedId} could not be restored: ${err.message}`);
  await audit(ref, {
    action: "INTAKE_DISPLACE_UNRESOLVED",
    resource_type: "document", resource_id: input.documentId,
    org_id: input.orgId, user_id: null, user_email: input.contactEmail,
    details: { displacedVersionId: input.displacedId, projectId: input.projectId, error: err.message },
  });
}

/** What a request carries, however it arrived: the multipart body, or a
 *  finalize naming a staged object (INTK-15). `head` is read before
 *  anything else is (the sniff); `bytes` only once the sniff passed. */
interface DoorUpload {
  name: string;
  size: number;
  type: string;
  field: (k: string) => string | null;
  head: () => Promise<Uint8Array>;
  bytes: () => Promise<Uint8Array>;
}

export async function POST(req: NextRequest) {
  const ref = crypto.randomUUID().slice(0, 8);
  // INTK-15: the staged object this request OWNS — a finalize's, once it
  // claimed the reservation; a multipart fallback's, once it claimed its
  // begin — is removed when the request ends, whatever it answered: filed
  // under its own key, refused, or a retry answered with the original. The
  // one exception: a fallback whose begin was claimed but whose link could
  // not then be read has no prefix to name, so its object is left to the
  // maintenance cron's staging sweep (STAGING_TTL_MS).
  const staged: { key: string | null } = { key: null };
  try {
    return await door(req, ref, staged);
  } finally {
    if (staged.key) await deleteObject(ref, staged.key);
  }
}

/** INTK-15: a JSON step's body is small — refused unread when its declared
 *  length is over DIRECT_BODY_MAX, and read through a reader capped at it
 *  whatever the request declares: a chunked body (no Content-Length) or one
 *  longer than it declared is refused at the cap, never buffered whole. It is
 *  read before the revocation / expiry / project / budget checks (the route
 *  header says why), so the cap is what bounds a refused link's request. */
async function readStepBody(req: NextRequest, declaredLength: number, fail: ReturnType<typeof refuser>): Promise<Record<string, unknown> | NextResponse> {
  if (Number.isFinite(declaredLength) && declaredLength > DIRECT_BODY_MAX) return fail("Expected a small JSON request.", 413);
  const text = await readCapped(req, DIRECT_BODY_MAX);
  if (text === null) return fail("Expected a small JSON request.", 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return fail("Expected a JSON request.", 400); }
  if (!body || typeof body !== "object") return fail("Expected a JSON request.", 400);
  return body as Record<string, unknown>;
}

/** The request body as text, or null once it passes `max` bytes (the read
 *  stops there and the stream is cancelled). */
async function readCapped(req: NextRequest, max: number): Promise<string | null> {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch { return ""; }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk.value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

async function door(req: NextRequest, ref: string, staged: { key: string | null }): Promise<NextResponse> {
  const fail = refuser(ref);
  // INTK-15: a direct-upload step, or null for the multipart door.
  const step = directStep(req);

  // ── 1. The credential, before any body is read ─────────────────────────
  const token = intakeTokenFromRequest(req);
  if (!INTAKE_TOKEN_RE.test(token)) {
    return fail("This upload link is not valid — reopen the portal from the link you were sent.", 400);
  }
  const tokenHash = sha256Hex(token);
  const ip = clientIp(req);
  const limits = intakeLimits();
  // J16: the door functions' availability, learned on this request's first call.
  const doorState: DoorState = { absent: false };
  // INTK-15: a multipart POST that is the portal's fallback for a direct
  // upload names its begin — which already counted this upload's attempt.
  // Its reservation is claimed for THIS token (once: a second POST naming
  // it, or a begin someone else made, is counted as usual).
  const begunId = step === null ? begunIdOf(req.headers.get(INTAKE_BEGUN_HEADER)) : null;
  let begun = false;
  if (begunId) {
    const claim = await claimStaged(supabaseAdmin, { id: begunId, tokenHash });
    if ("error" in claim) console.error(`[intake/upload] ref=${ref} begun claim: ${claim.error}`);
    begun = "claimed" in claim && claim.claimed;
  }
  // The rate window: a begin and a multipart POST are the upload's attempt;
  // a finalize is counted in its own window (per token, per IP, the same
  // limits) — never unthrottled.
  if (!begun) {
    const outcome = step === "finalize" ? ATTEMPT_OUTCOME.finalize : ATTEMPT_OUTCOME.attempt;
    const rate = await checkIntakeRate(supabaseAdmin, { tokenHash, ip, limits, outcome });
    if (rate.limited) {
      return NextResponse.json({ error: rate.message, ref, code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });
    }
    await recordIntakeAttempt(supabaseAdmin, { tokenHash, ip, outcome });
  }

  // SEC-19: looked up by the token's SHA-256 (the hash the rate window
  // already keys on) — the table keeps no usable token (20261141).
  const { data: link, error: linkErr } = await readIntakeLinkByToken(supabaseAdmin, {
    token, tokenHash,
    columns: "id, org_id, project_id, company_name, contact_email, allow_auto_supersede, expires_at, revoked_at, assigned_doc_ids, created_by",
  });
  if (linkErr) return fail("This link could not be checked right now — try again shortly.", 503, `link read: ${linkErr.message}`);
  if (!link) return fail(LINK_INVALID_MESSAGE, 404, undefined, { code: "notfound" });

  const linkId = String(link.id);
  const orgId = String(link.org_id);
  const projectId = String(link.project_id);
  const company = String(link.company_name);
  const contactEmail = (link.contact_email as string | null) ?? null;
  const declaredLength = Number(req.headers.get("content-length") ?? NaN);

  // ── INTK-15: the staged object, claimed BEFORE any other answer ───────
  // From here on every answer — a revoked or expired link, a closed
  // project, a spent budget — deletes the staged object this request owns.
  const prefix = stagingPrefix(orgId, projectId, linkId);
  if (begun && begunId) staged.key = `${prefix}${begunId}`;
  let stepBody: Record<string, unknown> | null = null;
  if (step) {
    const parsed = await readStepBody(req, declaredLength, fail);
    if (parsed instanceof NextResponse) return parsed;
    stepBody = parsed;
  }
  if (step === "finalize" && stepBody) {
    const uploadKey = String(stepBody.uploadKey ?? "");
    const stagedId = stagedIdUnder(uploadKey, prefix);
    if (!stagedId) {
      return fail("That upload does not belong to this link — send the file again.", 400, `finalize key outside the link's staging prefix: ${uploadKey.slice(0, 200)}`);
    }
    const claim = await claimStaged(supabaseAdmin, { id: stagedId, tokenHash });
    if ("error" in claim) return fail("The upload could not be checked right now — send the file again shortly.", 503, `staged claim: ${claim.error}`);
    if (!claim.claimed) {
      // Another request owns it (a concurrent or earlier finalize), or it
      // waited past STAGING_TTL_MS — never read here, never deleted here.
      return fail("This upload was already received, or it waited too long to be finished — send the file again.", 409, undefined, { code: "upload_claimed" });
    }
    staged.key = uploadKey;   // this request owns it now: deleted when it ends
  }

  if (link.revoked_at) return fail("This link has been revoked.", 410, undefined, { code: "revoked" });
  if (link.expires_at && Date.parse(link.expires_at as string) < Date.now()) return fail("This link has expired.", 410, undefined, { code: "expired" });

  // ── The project must exist and be open (PM-2 / PM-1) — read from the
  //    link alone, so it is answered BEFORE the body is received, on every
  //    branch. ────────────────────────────────────────────────────────────
  const { data: project, error: projErr } = await supabaseAdmin
    .from("projects").select("id, name, status, owner_user_id, intake_library_id, intake_collection_id")
    .eq("id", projectId).eq("org_id", orgId).maybeSingle();
  if (projErr) return fail("This link could not be checked right now — try again shortly.", 503, `project read: ${projErr.message}`);
  if (!project) return fail(LINK_GONE_MESSAGE, 410, undefined, { code: "link_gone" });
  if (CLOSED_PROJECT_STATUSES.has(String(project.status ?? ""))) return fail(PROJECT_CLOSED_MESSAGE, 410, undefined, { code: "project_closed" });
  const ownerUid = (project.owner_user_id as string | null) ?? null;

  // ── 2. Size and the link's lifetime budget, before the body ───────────
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES + MULTIPART_SLACK) {
    return fail("File exceeds the 100 MB limit.", 413);
  }
  const budget = await readLinkBudget(supabaseAdmin, linkId);
  const spent = linkBudgetRefusal(budget, null);
  if (spent) return fail(spent, 429, undefined, { code: "link_budget" });

  // ── 3. Only now: the body ──────────────────────────────────────────────
  let file: DoorUpload;
  if (step === "begin" && stepBody) {
    const size = Number(stepBody.size);
    if (!Number.isInteger(size) || size <= 0) return fail("A file is required.", 400);
    if (size > MAX_BYTES) return fail("File exceeds the 100 MB limit.", 413);
    // INTK-8 on the direct path: the bytes this link has staged and not had
    // claimed count with what it has filed (its expired reservations are
    // swept first) — a link never stages past its budget by not finalizing.
    const reserved = await sweepAndReserved(supabaseAdmin, { linkId, prefix, removeObject: (key) => deleteObject(ref, key) });
    if ("error" in reserved) {
      return fail("The upload could not be prepared — try again shortly.", 503, `staged reservations: ${reserved.error}`, { code: "direct_unavailable" });
    }
    const overBudgetAtBegin = linkBudgetRefusal(budget ? { ...budget, bytesReceived: budget.bytesReceived + reserved.reservedBytes } : null, size);
    if (overBudgetAtBegin) return fail(overBudgetAtBegin, 429, undefined, { code: "link_budget" });
    // A FRESH key under the link's own staging prefix, its declared size
    // RESERVED before any URL exists; the PUT's Content-Length is signed, so
    // the stored size is the declared one.
    const stagedId = crypto.randomUUID();
    const uploadKey = `${prefix}${stagedId}`;
    if (!(await reserveStaged(supabaseAdmin, { id: stagedId, tokenHash, ip, linkId, bytes: size }))) {
      return fail("The upload could not be prepared — try again shortly.", 503, "staged reservation not recorded", { code: "direct_unavailable" });
    }
    let uploadUrl: string;
    try {
      uploadUrl = await getSignedUrl(r2, new PutObjectCommand({
        Bucket: R2_BUCKET, Key: uploadKey, ContentLength: size, ContentType: "application/octet-stream",
      }), { expiresIn: 600, signableHeaders: new Set(["content-length", "content-type"]) });   // DIRECT_PUT_SECONDS (a literal: the lifetime census)
    } catch (e) {
      // The reservation stands: the portal's multipart fallback names it
      // (x-intake-begun) and the door does not count the attempt twice.
      return fail("The upload could not be prepared — try again shortly.", 503, `presign: ${(e as Error).message}`, { code: "direct_unavailable", uploadKey });
    }
    return NextResponse.json(
      { ok: true, step: "begin", uploadKey, uploadUrl, contentType: "application/octet-stream", expiresIn: DIRECT_PUT_SECONDS },
      { headers: { "Cache-Control": "no-store" } },
    );
  } else if (step === "finalize" && stepBody && staged.key) {
    const uploadKey = staged.key;
    const stored = await stagedHead(uploadKey);
    if (stored !== null && "error" in stored) return fail("The upload could not be checked right now — send the file again shortly.", 503, stored.error);
    if (stored === null) return fail("The uploaded file could not be found — it may have expired. Send the file again.", 404, undefined, { code: "upload_missing" });
    if (stored.size === 0) return fail("A file is required.", 400);
    if (stored.size > MAX_BYTES) return fail("File exceeds the 100 MB limit.", 413);
    const fields = (stepBody.fields && typeof stepBody.fields === "object" ? stepBody.fields : {}) as Record<string, unknown>;
    file = {
      name: String(stepBody.fileName ?? "").slice(0, 255) || "file",
      size: stored.size,
      type: typeof stepBody.contentType === "string" ? stepBody.contentType.slice(0, 200) : "",
      field: (k) => (DIRECT_FIELDS.includes(k) && typeof fields[k] === "string" ? (fields[k] as string) : null),
      // The sniff reads the STORED bytes' head — a ranged read, before the
      // rest of the object is read at all; both reads are the object the
      // HEAD measured (If-Match on its ETag).
      head: () => readStaged(uploadKey, stored.etag, "bytes=0-63"),
      bytes: () => readStaged(uploadKey, stored.etag),
    };
  } else {
    let form: FormData;
    try { form = await req.formData(); } catch { return fail("Expected multipart form data", 400); }
    const part = form.get("file");
    if (!(part instanceof File) || part.size === 0) return fail("A file is required.", 400);
    if (part.size > MAX_BYTES) return fail("File exceeds the 100 MB limit.", 413);
    let whole: Uint8Array | null = null;
    const all = async () => (whole ??= new Uint8Array(await part.arrayBuffer()));
    file = {
      name: part.name, size: part.size, type: part.type,
      field: (k) => { const v = form.get(k); return v == null ? null : String(v); },
      head: async () => (await all()).subarray(0, 64),
      bytes: all,
    };
  }
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

  const docId = String(file.field("docId") ?? "").trim() || null;
  const ticketId = String(file.field("ticketId") ?? "").trim() || null;
  const branch: IntakeBranch = purpose === "quote" ? "quote" : ticketId ? "redline" : "document";

  // ── 5. What the bytes are (never what the upload claims) ──────────────
  const CHANGED = "The uploaded file changed while it was being checked — send it again.";
  let head: Uint8Array;
  try { head = await file.head(); } catch (e) {
    if (e instanceof StagedChangedError) return fail(CHANGED, 409, e.message, { code: "upload_changed" });
    return fail("The uploaded file could not be read — try again shortly.", 503, `head read: ${(e as Error).message}`);
  }
  const verdict = validateIntakeFile({ branch, fileName: file.name, declaredType: file.type, head: head.subarray(0, 64) });
  if (!verdict.ok) return fail(verdict.message, 415, undefined, { code: "file_type" });
  let bytes: Uint8Array;
  try { bytes = await file.bytes(); } catch (e) {
    if (e instanceof StagedChangedError) return fail(CHANGED, 409, e.message, { code: "upload_changed" });
    return fail("The uploaded file could not be read — try again shortly.", 503, `body read: ${(e as Error).message}`);
  }
  if (bytes.byteLength !== file.size) return fail(CHANGED, 409, `size ${bytes.byteLength} differs from ${file.size}`, { code: "upload_changed" });
  // INTK-15: the bytes filed are the bytes sniffed — the full read's head
  // must be the head the verdict was given (whatever storage did with the
  // If-Match).
  const sniffed = head.subarray(0, 64);
  if (sniffed.some((b, i) => bytes[i] !== b)) return fail(CHANGED, 409, "the full read's head differs from the sniffed head", { code: "upload_changed" });
  const contentType = verdict.contentType;
  const fileHash = sha256Hex(bytes);
  const session = await appSessionOf(req);
  const nowIso = new Date().toISOString();
  const since = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS).toISOString();
  const noteRaw = String(file.field("changeNote") ?? "").trim();
  if (noteRaw.length > INTAKE_NOTE_MAX) return fail(`The note is limited to ${INTAKE_NOTE_MAX} characters.`, 400);
  const changeNote = noteRaw || null;

  /** One notice to the project team per link per window (SEC-8 dw2) — a
   *  burst of uploads is one notice, not N. A folded submission is COUNTED
   *  (by kind), and the next notice on the link says how many more arrived
   *  since the last one. `force` for a notice that should not wait for the
   *  window — a controlled revision published without review, a pending
   *  review that was displaced — still bounded: at most
   *  FORCED_NOTICES_PER_WINDOW notices per link per window, so a burst from
   *  a trusted (or leaked) token is never one notice per upload. A folded
   *  publish or replacement the link never announces itself (it went quiet)
   *  gets the maintenance cron's digest (flushFoldedIntakeNotices). */
  const notifyTeam = async (n: {
    kind: "review_requested" | "doc_superseded"; title: string; body: string; link: string;
    resource: { type: "document" | "project"; id: string }; followers: boolean; extraInvolved?: string[];
    metadata: Record<string, unknown>; force?: "published" | "displaced";
  }) => {
    const sent = await noticesInWindow(supabaseAdmin, { tokenHash, windowMinutes: limits.noticeWindowMinutes });
    if (!noticeGoesOut(sent, !!n.force)) {
      const outcome = n.force === "published" ? ATTEMPT_OUTCOME.suppressedPublished
        : n.force === "displaced" ? ATTEMPT_OUTCOME.suppressedDisplaced
        : ATTEMPT_OUTCOME.suppressed;
      await recordIntakeAttempt(supabaseAdmin, { tokenHash, ip, outcome, linkId });
      return;
    }
    const folded = await foldedSinceLastNotice(supabaseAdmin, { tokenHash });
    const where = n.link.includes("tab=costs") ? "Costs" : "Intake";
    const body = folded.total > 0 ? `${n.body} ${foldedNoticeSentence(folded, where)}` : n.body;
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
          title: n.title, body, link: n.link,
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
    // COST-12 (intake limb): the quote is filed against the project party
    // the link's company names — an exact (case-insensitive) name first,
    // else the one party it normalises to (lib/bidTab.ts, the registry's
    // own rule); none or several binds nothing and the Costs tab links it by
    // hand. An unreadable party list files the quote unlinked — the quote
    // itself is never refused for it.
    let partyId: string | null = null;
    {
      const { data: parties, error: partyErr } = await supabaseAdmin
        .from("project_parties").select("id, name").eq("project_id", projectId).eq("org_id", orgId);
      if (partyErr) console.error(`[intake/upload] ref=${ref} project parties unreadable: ${partyErr.message}`);
      else {
        const named = ((parties ?? []) as Array<{ id: string; name: string | null }>)
          .filter((p): p is { id: string; name: string } => typeof p.name === "string" && p.name.trim() !== "");
        partyId = matchCompanyByName(company, named)?.id ?? null;
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
      party_id: partyId,
      status: "draft",
      created_by: null,
      file_hash: fileHash,
    };
    // J16 (GAP-401): filed through the door's identity (20261184) — the
    // link's org, project, company and RFQ group are the database's, the
    // party must be the project's, and the project record rail judges the
    // write. Before the paste, the service-role insert, unchanged.
    let qdoc: unknown = null;
    let qErr: PgError = null;
    const filed = await viaDoor<string>(doorState, () => supabaseAdmin.rpc("intake_door_file_quote", {
      p_token_hash: tokenHash,
      p_quote: { file_url: key, file_name: file.name, mime_type: contentType, party_id: partyId, file_hash: fileHash },
    }));
    if (filed.kind === "ok") {
      if (filed.data) qdoc = { id: filed.data };
      else qErr = { message: "intake_door_file_quote answered no id" };
    } else if (filed.kind === "error") {
      const refused = doorRefused(filed.error, fail, { message: "This link can't file that quote — reopen the portal from the link you were sent.", status: 403 });
      if (refused) { await deleteObject(ref, key); return refused; }
      qErr = filed.error;
    } else {
      ({ data: qdoc, error: qErr } = await supabaseAdmin.from("cost_documents").insert(quoteRow).select("id").single());
      if (qErr && missingColumn(qErr, "file_hash")) {
        delete quoteRow.file_hash;
        ({ data: qdoc, error: qErr } = await supabaseAdmin.from("cost_documents").insert(quoteRow).select("id").single());
      }
    }
    if (qErr && String(qErr.code ?? "") === "23505") {
      // A concurrent retry won the idempotency index — answer with its row.
      const { data: winner } = await supabaseAdmin.from("cost_documents").select("id")
        .eq("intake_link_id", linkId).eq("file_hash", fileHash).eq("status", "draft").limit(1);
      const winnerId = (((winner ?? []) as Array<{ id: string }>)[0]?.id) ?? null;
      if (winnerId) {
        await deleteObject(ref, key);
        return NextResponse.json({ ok: true, quoteId: String(winnerId), status: "quote_received", duplicate: true, message: "This quote was already received — nothing new was stored." });
      }
    }
    if (qErr || !qdoc) {
      await deleteObject(ref, key);
      return fail("Couldn't record the quote — try again shortly.", 500, `cost_documents insert: ${qErr?.message ?? "no row"}`);
    }
    const quoteId = String((qdoc as { id: string }).id);

    await notifyTeam({
      kind: "review_requested",
      title: `Quote received: ${company}${rfqGroup ? ` — ${rfqGroup}` : ""}`,
      body: `${company} submitted a quote through their intake link.${changeNote ? ` Note: ${changeNote}` : ""} Run the AI read from the project's Costs tab to tabulate it.`,
      link: `/projects/${projectId}?tab=costs`,
      resource: { type: "project", id: projectId }, followers: true,
      metadata: { quote: true, rfqGroup, quoteId, partyId },
    });
    await audit(ref, {
      action: "INTAKE_QUOTE_SUBMISSION",
      resource_type: "cost", resource_id: quoteId,
      org_id: orgId, user_id: null, user_email: contactEmail,
      details: { company, projectId, rfqGroup, partyId, fileName: safeName, size: file.size, contentType, note: changeNote, appSession: session },
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
          .select("id, ticket_id, title, attachments, history, metadata, assigned_drafter_id, requester_id, last_modified, archived_at")
          .eq("id", ticketId).eq("org_id", orgId)
          .eq("metadata->intake_collision->>intakeLinkId", linkId)
          .maybeSingle()
      : { data: null, error: null };
    if (tErr) return fail("This redline request could not be checked right now — try again shortly.", 503, `ticket read: ${tErr.message}`);
    const meta = ((ticket?.metadata ?? {}) as { intake_collision?: { intakeLinkId?: string | null } });
    if (!ticket || String(meta.intake_collision?.intakeLinkId ?? "") !== linkId) {
      return fail("No redline request on this link matches that ticket.", 404);
    }
    // SM-9 (DF-P1): an archived ticket takes no redline on either path (the
    // append function refuses one; the compare-and-set fallback below does
    // too), and the sender is told why — before anything is stored.
    const ARCHIVED_REDLINE = "This request is archived, so it can't take a redline. Ask the requester to restore it, then send the redline again.";
    if ((ticket as { archived_at?: string | null }).archived_at) {
      return fail(ARCHIVED_REDLINE, 409);
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
    // SM-9 (drafting-flow DF-P1): the redline is an APPEND, never a whole-
    // array replace — append_ticket_redline (20261166) adds the attachment and
    // the history entry with `||` in one UPDATE, so a workflow transition that
    // landed after this route read the row is never overwritten. Before that
    // migration is pasted (the function is absent) the write falls back to a
    // compare-and-set on the last_modified it read, as the workflow and
    // comment routes do: a lost race re-reads and retries once; a second loss
    // refuses (nothing attached, the stored object removed).
    const historyEntry = {
      action: "Redline markups received via intake portal",
      user: company, date: nowIso,
      details: changeNote || safeName,
    };
    let attached = false;
    // J16 (GAP-401): through the door first (20261184), which checks in the
    // database that this ticket of the link's org names the link and the file
    // is under the link's project, then makes the ticket rails' one append —
    // binding no identity: the rails keep a ticket's attachments a
    // service-only write. Before the paste (or before 20261166, which the
    // door answers 42883 for) the call below, unchanged.
    let appended: unknown = null;
    let appendErr: PgError = null;
    const doorAppend = await viaDoor<boolean>(doorState, () => supabaseAdmin.rpc("intake_door_append_redline", {
      p_token_hash: tokenHash, p_ticket: ticketId, p_attachment: attachment, p_history: historyEntry,
    }));
    if (doorAppend.kind === "ok") appended = doorAppend.data;
    else if (doorAppend.kind === "error") {
      const refused = doorRefused(doorAppend.error, fail, { message: "No redline request on this link matches that ticket.", status: 404 });
      if (refused) { await deleteObject(ref, key); return refused; }
      appendErr = doorAppend.error;
    } else {
      ({ data: appended, error: appendErr } = await supabaseAdmin.rpc("append_ticket_redline", {
        p_ticket_id: ticketId, p_org_id: orgId, p_attachment: attachment, p_history: historyEntry,
      }));
    }
    const appendAbsent = !!appendErr && (
      (appendErr as { code?: string }).code === "PGRST202" ||
      /could not find the function|does not exist in the schema cache/i.test(appendErr.message ?? ""));
    if (appendErr && !appendAbsent) {
      await deleteObject(ref, key);
      return fail("Couldn't attach the redline — try again shortly.", 500, `ticket append: ${appendErr.message}`);
    }
    if (!appendErr) {
      if (appended !== true) {
        await deleteObject(ref, key);
        // The append refuses a ticket that is gone or archived. It was neither
        // when read above, so ask which happened in between.
        const { data: now } = await supabaseAdmin.from("tickets")
          .select("archived_at").eq("id", ticketId).eq("org_id", orgId).maybeSingle();
        if ((now as { archived_at?: string | null } | null)?.archived_at) {
          return fail(ARCHIVED_REDLINE, 409, "ticket append: the ticket was archived after it was read");
        }
        return fail("No redline request on this link matches that ticket.", 404, "ticket append: the ticket took no append (gone)");
      }
      attached = true;
    }
    let current = ticket as { attachments?: unknown; history?: unknown; last_modified?: string | null; archived_at?: string | null };
    for (let attempt = 0; attempt < 2 && !attached; attempt++) {
      let cas = supabaseAdmin.from("tickets").update({
        attachments: [...((current.attachments as unknown[] | null) ?? []), attachment],
        history: [...((current.history as unknown[] | null) ?? []), historyEntry],
        last_modified: nowIso,
      }).eq("id", ticketId).eq("org_id", orgId).is("archived_at", null);
      cas = current.last_modified ? cas.eq("last_modified", current.last_modified) : cas.is("last_modified", null);
      const { data: casRows, error: updErr } = await cas.select("id");
      if (updErr) {
        await deleteObject(ref, key);
        return fail("Couldn't attach the redline — try again shortly.", 500, `ticket update: ${updErr.message}`);
      }
      if (((casRows as unknown[] | null) ?? []).length > 0) { attached = true; break; }
      const { data: fresh, error: reErr } = await supabaseAdmin.from("tickets")
        .select("attachments, history, last_modified, archived_at").eq("id", ticketId).eq("org_id", orgId).maybeSingle();
      if (reErr || !fresh) break;
      current = fresh as typeof current;
      if (current.archived_at) {
        await deleteObject(ref, key);
        return fail(ARCHIVED_REDLINE, 409, "ticket update: the ticket was archived after it was read");
      }
    }
    if (!attached) {
      await deleteObject(ref, key);
      return fail("The request was being updated at the same moment — send the redline again.", 409, "ticket update: compare-and-set lost twice");
    }

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
  const title = String(file.field("title") ?? "").trim() || null;
  const number = String(file.field("number") ?? "").trim() || null;
  const revLabel = String(file.field("revLabel") ?? "").trim() || (docId ? "" : "A");
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
    // assigned document is never the link's own, whatever its history. An
    // authorship read that FAILS is "try again", never "not yours".
    if (d && !isAssigned) {
      const authorship = await linkAuthorOf(docId, orgId);
      if ("error" in authorship) return fail("This link's documents could not be checked right now — try again shortly.", 503, authorship.error);
      ownDoc = authorship.author === linkId;
    }
    if (!isAssigned && !ownDoc) return fail("This link may only submit revisions to its own or assigned documents.", 403);
    if (!d) return fail("Document not found.", 404);
    targetDoc = d as Record<string, unknown>;
  }

  // ── REL-8: a retry of the same bytes returns the original record ──────
  // Only a LIVE earlier submission counts (superseded_at NULL: a withdrawn
  // or displaced row is not "already received"), and only the record THIS
  // request would have made (classifyPrior). The same bytes live on
  // another submission are refused here, before storage — the in-flight
  // index would refuse the insert anyway, and the answer must never carry
  // another document's ids.
  {
    const { data: prior, error: priorErr } = await supabaseAdmin
      .from("document_versions").select("id, record_id, review_state, released_at, created_at")
      .eq("intake_link_id", linkId).eq("file_hash", fileHash).is("superseded_at", null).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(5);
    if (!priorErr) {
      let blocked = false;
      for (const raw of ((prior ?? []) as Array<Record<string, unknown>>)) {
        const hit = { id: String(raw.id), record_id: String(raw.record_id), review_state: (raw.review_state as string | null) ?? null, released_at: (raw.released_at as string | null) ?? null };
        const verdict = await classifyPrior(hit, { orgId, docId });
        if (typeof verdict === "object") return fail("This link's documents could not be checked right now — try again shortly.", 503, verdict.error);
        if (verdict === "original") {
          return NextResponse.json({
            ok: true, documentId: hit.record_id, versionId: hit.id, duplicate: true,
            status: hit.review_state === "in_review" ? "in_review" : "published",
            message: "This file was already received — nothing new was stored.",
          });
        }
        if (verdict === "blocks") blocked = true;
      }
      if (blocked) return fail(SAME_FILE_ELSEWHERE, 409, undefined, { code: "same_file_in_review" });
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
    // INTK-1 dw3: a rejected submission is never re-published by
    // resubmitting it without a person deciding. After a rejection, every
    // submission on this document is reviewed until the team approves one
    // (a rejected submission made against the CURRENT revision still
    // stands); the rejected bytes themselves are reviewed however long ago
    // they were refused; and the newest own submission being rejected
    // withholds too. The "throwaway second submission" route to the same
    // end is closed below (a pending own submission withholds).
    const { data: ownRows, error: ownErr } = await supabaseAdmin
      .from("document_versions").select("id, review_state, file_hash, supersedes_version_id")
      .eq("record_id", docId).eq("intake_link_id", linkId)
      .order("created_at", { ascending: false }).limit(200);
    const own = ((ownRows ?? []) as Array<{ id: string; review_state: string | null; file_hash: string | null; supersedes_version_id: string | null }>);
    const current = String(targetDoc.current_version_id ?? "");
    if (ownErr) { autoNow = false; autoWithheld = "the document's submission history could not be verified"; }
    else if (own[0]?.review_state === "rejected") {
      autoNow = false; autoWithheld = "your previous submission for this document was not accepted — the next one is reviewed";
    } else if (own.some((v) => v.review_state === "rejected" && v.file_hash === fileHash)) {
      autoNow = false; autoWithheld = "this file was not accepted when it was submitted before — it is reviewed again";
    } else if (own.some((v) => v.review_state === "rejected" && String(v.supersedes_version_id ?? "") === current)) {
      autoNow = false; autoWithheld = "a submission against the current revision was not accepted — later ones are reviewed until the project team approves one";
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
    // 5. INTK-1 dw3: while the link's own earlier submission is still
    //    awaiting review, nothing publishes — the new upload replaces it IN
    //    REVIEW. Otherwise a rejected file could be re-published by sending
    //    one throwaway submission (it goes to review) and then the rejected
    //    bytes again (which would displace it and publish).
    if (autoNow && priorPending) {
      autoNow = false; autoWithheld = "your previous submission for this document is still awaiting review";
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
    // unique index sees an intake-born number from the moment it exists —
    // but ONLY when the door can fill every part of the library's tuple.
    // The door collects a number and a title; a tuple naming anything else
    // (["documentNumber","sheet"]: sheets 1..N share a number) gets NULL,
    // the column's opt-out, and no pre-check — a partial key would refuse
    // sheet 2 as a duplicate of sheet 1.
    uniquenessKey = completeUniquenessKey(
      { documentNumber: number, title, rev: null, status: "Draft", customFields: {} },
      ((lib as { uniqueness_keys?: string[] | null }).uniqueness_keys ?? null),
      INTAKE_SUPPLIED_KEY_PARTS,
    ).key;
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
  /** The document THIS request created (a new-document upload), so every
   *  later refusal — and a retry answered with its original — removes it
   *  with the stored object instead of leaving an empty document in the
   *  intake folder (a transition-in candidate with no version). */
  let createdDocId: string | null = null;
  const discard = async () => {
    if (createdDocId) {
      const { error: dropErr } = await supabaseAdmin.from("documents").delete().eq("id", createdDocId).eq("org_id", orgId);
      if (dropErr) console.error(`[intake/upload] ref=${ref} unused document ${createdDocId} could not be removed: ${dropErr.message}`);
      createdDocId = null;
    }
    await deleteObject(ref, key);
  };
  /** REL-8 at the database: the in-flight index refused the insert — the
   *  same bytes are already live on this link. The original (classifyPrior)
   *  answers as the retry it is; anything else is refused with a sentence.
   *  Either way what this request stored is removed. */
  const answerInflight = async (detail: string) => {
    const { data: winners, error: wErr } = await supabaseAdmin.from("document_versions")
      .select("id, record_id, review_state, released_at")
      .eq("intake_link_id", linkId).eq("file_hash", fileHash).eq("review_state", "in_review").is("superseded_at", null)
      .limit(5);
    await discard();
    if (wErr) return fail("This link's documents could not be checked right now — try again shortly.", 503, `${detail}; in-flight read: ${wErr.message}`);
    for (const raw of ((winners ?? []) as Array<Record<string, unknown>>)) {
      const w = { id: String(raw.id), record_id: String(raw.record_id), review_state: "in_review", released_at: null };
      const verdict = await classifyPrior(w, { orgId, docId });
      if (typeof verdict === "object") return fail("This link's documents could not be checked right now — try again shortly.", 503, `${detail}; ${verdict.error}`);
      if (verdict === "original") {
        return NextResponse.json({ ok: true, documentId: w.record_id, versionId: w.id, duplicate: true, status: "in_review", message: "This file was already received — nothing new was stored." });
      }
    }
    return fail(SAME_FILE_ELSEWHERE, 409, detail, { code: "same_file_in_review" });
  };
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
    // J16 (GAP-401): created through the door's identity (20261184) — into
    // the project's intake library and folder only, authored by this link
    // (INTK-16's rail admits the door for its OWN link), every insert rail
    // judging it. Before the paste, the service-role insert, unchanged.
    let doc: unknown = null;
    let docErr: PgError = null;
    const created = await viaDoor<string>(doorState, () => supabaseAdmin.rpc("intake_door_create_document", { p_token_hash: tokenHash, p_doc: docRow }));
    if (created.kind === "ok") {
      if (created.data) doc = { id: created.data };
      else docErr = { message: "intake_door_create_document answered no id" };
    } else if (created.kind === "error") {
      const refused = doorRefused(created.error, fail, DOOR_SCOPE_NEW_DOCUMENT);
      if (refused) { await deleteObject(ref, key); return refused; }
      docErr = created.error;
    } else {
      ({ data: doc, error: docErr } = await supabaseAdmin.from("documents").insert(docRow).select("id").single());
      if (docErr && missingColumn(docErr, "authored_by_link_id")) {
        // Pre-20261104: authorship falls back to the first version's link.
        delete docRow.authored_by_link_id;
        ({ data: doc, error: docErr } = await supabaseAdmin.from("documents").insert(docRow).select("id").single());
      }
    }
    if (docErr && String(docErr.code ?? "") === "23505") {
      // A numbered new document whose retry raced its original: the first
      // request holds the number, so this one is the same bytes in flight
      // — answer with the original, never "number already in use".
      const { data: twin } = await supabaseAdmin.from("document_versions")
        .select("id").eq("intake_link_id", linkId).eq("file_hash", fileHash).eq("review_state", "in_review").is("superseded_at", null).limit(1);
      if (((twin ?? []) as unknown[]).length > 0) return answerInflight(`documents insert: ${docErr.message}`);
      await deleteObject(ref, key);
      return fail("That drawing number is already in use in this project's library — to revise that drawing use the revision form, otherwise check the number.", 409, `documents insert: ${docErr.message}`, { code: "number_in_use" });
    }
    if (docErr || !doc) {
      await deleteObject(ref, key);
      return fail("Couldn't create the document — try again shortly.", 500, `documents insert: ${docErr?.message ?? "no row"}`);
    }
    documentId = String((doc as { id: string }).id);
    createdDocId = documentId;
  }
  const theDocId = String(documentId);

  // ── Publish (trusted, eligible) or queue for review ───────────────────
  let versionId: string | null = null;
  let published = false;
  /** J16: the door's promote stamped the provenance in its own transaction. */
  let provenanceStamped = false;
  if (autoNow && targetDoc) {
    const outcome = await publishThroughContract({
      documentId: theDocId,
      expectedBase: (targetDoc.current_version_id as string | null) ?? null,
      creator: String(link.created_by),
      company, revLabel, key, contentType, size: file.size, changeNote, fileHash,
      door: { state: doorState, tokenHash },
    });
    if (outcome.kind === "refuse") {
      await discard();
      return fail(outcome.message, outcome.status, outcome.detail, outcome.code ? { code: outcome.code } : undefined);
    }
    if (outcome.kind === "demote") {
      autoWithheld = outcome.reason;
      if (outcome.detail) console.error(`[intake/upload] ref=${ref} ${outcome.detail}`);
    } else {
      versionId = outcome.versionId;
      published = true;
      provenanceStamped = outcome.stamped;
    }
  }

  /** A lost pointer race (or a refused pointer write): the new version is
   *  RESOLVED — 'superseded' + superseded_at, like a displaced one (the
   *  pre-20261105 CHECK keeps the superseded_at-only shape) — so it never
   *  sits 'in_review' with nothing pointing at it, never reads as "already
   *  received" to the contractor's resend, and never holds the in-flight
   *  index against it. `then` runs after the new version is resolved — a
   *  displaced draft is restored only once the replacement no longer holds
   *  its revision label. */
  const withdraw = async (msg: string, detail?: string, then?: () => Promise<void>, status = 409, extra?: Record<string, unknown>) => {
    if (versionId) {
      let { error: wErr } = await supabaseAdmin.from("document_versions")
        .update({ review_state: "superseded", superseded_at: nowIso }).eq("id", versionId);
      if (wErr && String(wErr.code ?? "") === "23514") {
        ({ error: wErr } = await supabaseAdmin.from("document_versions").update({ superseded_at: nowIso }).eq("id", versionId));
      }
      if (wErr) console.error(`[intake/upload] ref=${ref} withdrawn submission ${versionId} not resolved: ${wErr.message}`);
    }
    if (then) await then();
    if (createdDocId) await discard();
    return fail(msg, status, detail, extra);
  };

  if (published && versionId) {
    // publish_revision's INSERT carries no intake_link_id: stamp the
    // provenance so the portal register and the review queue see it (the
    // door's promote already did, in the publish's own transaction — J16).
    if (!provenanceStamped) {
      const { error: stampErr } = await supabaseAdmin.from("document_versions").update({ intake_link_id: linkId }).eq("id", versionId);
      if (stampErr) console.error(`[intake/upload] ref=${ref} provenance stamp failed on ${versionId}: ${stampErr.message}`);
    }
    // No pending submission is displaced here: a trusted link with its own
    // submission still awaiting review never auto-publishes (INTK-1 dw3) —
    // that upload replaces it IN REVIEW, below.
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
          // LNK-11 (I-08): the proposal sweep runs in-process on the service
          // role; without it the sweep would take the browser path
          // (/api/links/invalidate with a session) and not run here.
          serviceClient: supabaseAdmin,
        });
      });
    } catch (e) {
      console.error(`[intake/upload] ref=${ref} post-publish pipeline failed: ${(e as Error).message}`);
    }
  } else {
    // INTK-4: the link's own pending draft (a trusted replace, checked above)
    // is retired BEFORE the replacement exists — see retireDisplacedFirst.
    let displacedRetired = false;
    if (priorPending) {
      const retired = await retireDisplacedFirst({ displacedId: priorPending, nowIso });
      if (typeof retired === "object") {
        await discard();
        return fail("Your earlier submission could not be replaced right now — try again shortly.", 503, retired.error);
      }
      if (retired === "decided") {
        await discard();
        return fail("Your previous submission for this document was just decided — reload the portal and submit again.", 409);
      }
      displacedRetired = true;
    }
    const undoDisplace = async () => {
      if (!displacedRetired || !priorPending) return;
      displacedRetired = false;
      await restoreDisplaced(ref, { orgId, documentId: theDocId, displacedId: priorPending, nowIso, projectId, contactEmail });
    };
    // J16 (GAP-401): the submission, as the door's identity (20261184) — a
    // version only of a document this link authored or was assigned, its
    // file under the link's project; the function takes org, link,
    // provenance, review state and release from the link, never from this
    // row. Before the paste, the service-role insert of the same row.
    const versionRow = {
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
    };
    let ver: unknown = null;
    let verErr: PgError = null;
    const submitted = await viaDoor<string>(doorState, () => supabaseAdmin.rpc("intake_door_submit_version", { p_token_hash: tokenHash, p_version: versionRow }));
    if (submitted.kind === "ok") {
      if (submitted.data) ver = { id: submitted.data };
      else verErr = { message: "intake_door_submit_version answered no id" };
    } else if (submitted.kind === "error") {
      const refused = doorRefused(submitted.error, fail, DOOR_SCOPE_DOCUMENTS);
      if (refused) {
        await undoDisplace();
        await discard();
        return refused;
      }
      verErr = submitted.error;
    } else {
      ({ data: ver, error: verErr } = await supabaseAdmin
        .from("document_versions")
        .insert(versionRow)
        .select("id").single());
    }
    if (verErr && String(verErr.code ?? "") === "23505") {
      await undoDisplace();
      const msg = `${verErr.message ?? ""} ${verErr.details ?? ""}`;
      // REL-8: the same bytes are already live on this link — the original
      // (a concurrent retry that won) answers; anything else is refused.
      if (/intake_inflight/.test(msg)) return answerInflight(`version insert: ${verErr.message}`);
      await discard();
      return fail(`Rev ${revLabel || "A"} already exists on this document — submit it with a new revision label.`, 409, `version insert: ${verErr.message}`);
    }
    if (verErr || !ver) {
      await undoDisplace();
      await discard();
      return fail("Couldn't record the submission — try again shortly.", 500, `version insert: ${verErr?.message ?? "no row"}`);
    }
    versionId = String((ver as { id: string }).id);

    // RG-10: the pointer write is COMPARE-AND-SET on the pending pointer
    // read above — from NULL, or (a trusted link replacing its own
    // roster-free draft, checked above) from exactly that draft. A pointer
    // that moved to anything else is a lost race: the new version retires.
    // J16 (GAP-401): through the door's identity (20261184) — only this
    // link's own in-review submission, and a replace only by a trusted link
    // of its own earlier one (INTK-4 dw3), the same compare-and-set. Before
    // the paste, the service-role write below, unchanged.
    let pointed: unknown[] | null = null;
    let pointErr: PgError = null;
    const repointed = await viaDoor<number>(doorState, () => supabaseAdmin.rpc("intake_door_point_pending", {
      p_token_hash: tokenHash, p_doc: theDocId, p_version: versionId, p_from: priorPending, p_at: nowIso,
    }));
    if (repointed.kind === "ok") pointed = Number(repointed.data ?? 0) > 0 ? [{ id: theDocId }] : [];
    else if (repointed.kind === "error") {
      const a = doorAnswer(repointed.error, DOOR_SCOPE_DOCUMENTS);
      if (a) return withdraw(a.message, `door refused: ${repointed.error.code ?? ""} ${repointed.error.message ?? ""}`, undoDisplace, a.status, { code: a.code });
      pointErr = repointed.error;
    } else {
      let point = supabaseAdmin.from("documents")
        .update({ pending_version_id: versionId, updated_at: nowIso })
        .eq("id", theDocId);
      point = priorPending ? point.eq("pending_version_id", priorPending) : point.is("pending_version_id", null);
      ({ data: pointed, error: pointErr } = await point.select("id"));
    }
    if (pointErr) return withdraw("Couldn't queue the submission for review — try again shortly.", `pending pointer write: ${pointErr.message}`, undoDisplace);
    if (!pointed || pointed.length === 0) {
      return withdraw("Another revision of this document just went into review — your submission was not taken. Try again once it is approved or rejected.", undefined, undoDisplace);
    }
    if (priorPending) {
      await audit(ref, {
        action: "INTAKE_SUBMISSION_DISPLACED",
        resource_type: "document", resource_id: theDocId,
        org_id: orgId, user_id: null, user_email: contactEmail,
        details: { displacedVersionId: priorPending, byVersionId: versionId, company, projectId },
      });
    }
  }

  // DEC-40: a document the door created is part of the project BY
  // REFERENCE (project_documents, the same row "attach to project" writes)
  // — the project's document list shows it with its live revision, never a
  // copy. Checked: a refused reference is logged, the submission stands.
  if (createdDocId) {
    const { error: refErr } = await supabaseAdmin.from("project_documents").upsert(
      { org_id: orgId, project_id: projectId, document_id: createdDocId, source: "manual", first_seen_at: nowIso, last_seen_at: nowIso },
      { onConflict: "project_id,document_id", ignoreDuplicates: true },
    );
    if (refErr) console.error(`[intake/upload] ref=${ref} project reference for ${createdDocId} not written: ${refErr.message}`);
  }

  // ── Notify the project team + audit ──
  const displacedNote = priorPending ? " It replaced their earlier submission, which was still awaiting review." : "";
  if (published) {
    await notifyTeam({
      kind: "doc_superseded",
      title: `Intake: ${label} published as Rev ${revLabel} by ${company}`,
      body: `${company} published a new revision through their trusted intake link. It is now current.`,
      link: `/projects/${projectId}`,
      resource: { type: "document", id: theDocId },
      // Followers and live intent holders heard it from the post-publish
      // pipeline's stale-copy signal already.
      followers: false,
      metadata: { versionId },
      // A controlled revision published without review does not wait for
      // the window (up to the per-window cap; beyond it, it is counted by
      // kind into the next notice — or the cron's digest if none follows).
      force: "published",
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
      force: priorPending ? "displaced" : undefined,
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
