// lib/intakeRateLimit.ts
//
// Throttling for the unauthenticated intake door (projects-tab SEC-8,
// projects-and-cost INTK-8). Serverless functions share no memory, so the
// window lives in a table — `intake_attempts` (20261105), the same shape as
// `signup_attempts` (app/api/auth/signup/route.ts:19-33, the house pattern):
//
//   * a durable per-token and per-IP window (the token is stored HASHED —
//     the attempt log never becomes a second copy of the credential);
//   * FAIL OPEN on a limiter error (GAP-401 acceptance 4): a transient
//     read failure must not lock every contractor out — the per-link cap
//     and the link's expiry still bound the damage;
//   * a 429 whose message the portal renders as-is;
//   * at most one "new submission" notice per link per window, so a burst
//     is one notice, not N (SEC-8 dw2) — each folded submission is counted
//     ('suppressed'), and the next notice says how many more arrived. A
//     notice that must not wait for the window (a revision published
//     without review, a submission that replaced one in review) still goes
//     out — but at most FORCED_NOTICES_PER_WINDOW notices of any kind per
//     link per window; beyond that it is folded too, counted BY KIND, and
//     the next notice names how many were published or replaced — and a
//     link that goes quiet after folding a publish or a replacement is
//     announced anyway: the maintenance cron's flushFoldedIntakeNotices
//     sends ONE digest per PROJECT (each such link's counts listed) to the
//     controllers and the owner, and marks each link 'digested' only once
//     the digest's notices landed;
//   * a per-link lifetime cap (submissions and bytes) read from the link
//     row (20261104), so one leaked token cannot grow storage without end.
//
// The cron's other intake step lives here too: nudgeReviewHealth tells each
// org's controller pool, once a day, about review rows no screen lists
// (INTK-4 / SAF-10 — the migration's two state counts, per org).
//
// Limits are configurable without a code change (SEC-8 dw3): the
// INTAKE_MAX_PER_TOKEN_HOUR / INTAKE_MAX_PER_IP_HOUR / INTAKE_NOTICE_WINDOW_MIN
// environment variables, and the per-link columns max_submissions /
// max_total_bytes.
//
// Server-only (node:crypto); the client is passed in.

import { createHash } from "node:crypto";
import { roleFilter } from "@/lib/roleHeld";

export interface IntakeLimits {
  perTokenPerHour: number;
  perIpPerHour: number;
  noticeWindowMinutes: number;
}

export const DEFAULT_INTAKE_LIMITS: IntakeLimits = { perTokenPerHour: 30, perIpPerHour: 60, noticeWindowMinutes: 15 };

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function intakeLimits(env: Record<string, string | undefined> = process.env): IntakeLimits {
  return {
    perTokenPerHour: positiveInt(env.INTAKE_MAX_PER_TOKEN_HOUR, DEFAULT_INTAKE_LIMITS.perTokenPerHour),
    perIpPerHour: positiveInt(env.INTAKE_MAX_PER_IP_HOUR, DEFAULT_INTAKE_LIMITS.perIpPerHour),
    noticeWindowMinutes: positiveInt(env.INTAKE_NOTICE_WINDOW_MIN, DEFAULT_INTAKE_LIMITS.noticeWindowMinutes),
  };
}

/** SHA-256 hex. The attempt log keys on the token's hash, never the token. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function clientIp(req: { headers: Headers }): string {
  const fwd = req.headers.get("x-forwarded-for");
  const first = fwd ? fwd.split(",")[0]?.trim() : "";
  return first || req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Any client with `.from()` (the route's service-role client). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AttemptClient = { from: (table: string) => any };

/** `attempt` counts toward the rate window; `notified` marks a team
 *  notice; `suppressed*` marks a submission whose notice was folded into
 *  the window's earlier one (never counted toward the rate window) — by
 *  kind: a submission for review, a revision published without review, a
 *  submission that replaced the link's earlier one in review. `digested`
 *  marks the maintenance cron's digest for the link: a BOUNDARY for the
 *  fold count (what it announced is never counted again) but not a notice
 *  in the window — noticesInWindow counts `notified` only, so the link's
 *  next submission after a digest is told at once, never folded behind it.
 *  INTK-15 (J11): `finalize` is a direct upload's finalize step — its own
 *  window, per token and per IP, with the same limits (a begin is the
 *  upload's `attempt`); `staged` is a begin's reservation of its declared
 *  bytes (lib/intakeStaging.ts — never a rate-window row). */
export const ATTEMPT_OUTCOME = {
  attempt: "attempt", notified: "notified", suppressed: "suppressed",
  suppressedPublished: "suppressed_published", suppressedDisplaced: "suppressed_displaced",
  digested: "digested", finalize: "finalize", staged: "staged",
} as const;

/** SEC-8 dw2: the most notices one link sends the team per window, forced
 *  ones included. An ordinary notice goes only when the window is empty; a
 *  forced one (published / displaced) while fewer than this many went. */
export const FORCED_NOTICES_PER_WINDOW = 3;

export type RateVerdict = { limited: false } | { limited: true; retryAfterSec: number; message: string };

const HOUR_MS = 3600_000;

async function countSince(client: AttemptClient, col: "token_hash" | "ip", value: string, sinceIso: string, outcome: string): Promise<number | null> {
  const { count, error } = await client.from("intake_attempts")
    .select("id", { count: "exact", head: true })
    .eq(col, value).eq("outcome", outcome)
    .gte("created_at", sinceIso);
  if (error) return null;
  return typeof count === "number" ? count : 0;
}

/** Over the per-token or per-IP hourly window? Fails OPEN on any error.
 *  `outcome` names the window (default `attempt`; a direct upload's
 *  finalize step has its own, `finalize`). */
export async function checkIntakeRate(client: AttemptClient, input: {
  tokenHash: string; ip: string; limits: IntakeLimits; now?: number; outcome?: string;
}): Promise<RateVerdict> {
  try {
    const since = new Date((input.now ?? Date.now()) - HOUR_MS).toISOString();
    const outcome = input.outcome ?? ATTEMPT_OUTCOME.attempt;
    const perToken = await countSince(client, "token_hash", input.tokenHash, since, outcome);
    if (perToken != null && perToken >= input.limits.perTokenPerHour) {
      return { limited: true, retryAfterSec: 3600, message: `Too many uploads on this link in the last hour (limit ${input.limits.perTokenPerHour}). Wait a while and try again — nothing from this attempt was stored.` };
    }
    // An unknown address is not everyone's address — never pool them.
    if (input.ip !== "unknown") {
      const perIp = await countSince(client, "ip", input.ip, since, outcome);
      if (perIp != null && perIp >= input.limits.perIpPerHour) {
        return { limited: true, retryAfterSec: 3600, message: `Too many uploads from your network in the last hour (limit ${input.limits.perIpPerHour}). Wait a while and try again — nothing from this attempt was stored.` };
      }
    }
    return { limited: false };
  } catch {
    return { limited: false }; // fail open — the house pattern
  }
}

/** Never fatal: a failed attempt write is logged. Answers whether the row
 *  landed — the door degrades open on false; the cron's digest marker
 *  counts it (a digest whose marker did not land is repeated next run). */
export async function recordIntakeAttempt(client: AttemptClient, input: {
  tokenHash: string; ip: string; outcome: string; linkId?: string | null; bytes?: number | null;
}): Promise<boolean> {
  try {
    const { error } = await client.from("intake_attempts").insert({
      token_hash: input.tokenHash, ip: input.ip, outcome: input.outcome,
      link_id: input.linkId ?? null, bytes: input.bytes ?? null,
    });
    if (error) {
      console.warn("[intakeRateLimit] attempt write failed (limiter degrades open):", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[intakeRateLimit] attempt write threw (limiter degrades open):", (e as Error).message);
    return false;
  }
}

/** How many team notices this link sent inside the window (any kind — the
 *  cron's `digested` marker is not one). An unreadable log answers 0 — a
 *  notice too many beats a submission nobody hears about. */
export async function noticesInWindow(client: AttemptClient, input: {
  tokenHash: string; windowMinutes: number; now?: number;
}): Promise<number> {
  try {
    const since = new Date((input.now ?? Date.now()) - input.windowMinutes * 60_000).toISOString();
    const { count, error } = await client.from("intake_attempts")
      .select("id", { count: "exact", head: true })
      .eq("token_hash", input.tokenHash).eq("outcome", ATTEMPT_OUTCOME.notified)
      .gte("created_at", since);
    if (error) return 0;
    return typeof count === "number" ? count : 0;
  } catch {
    return 0;
  }
}

/** Pure: does this notice go out, given how many the window already holds?
 *  An ordinary notice only into an empty window; a forced one (a revision
 *  published without review, a submission that replaced one in review)
 *  while the window holds fewer than FORCED_NOTICES_PER_WINDOW. */
export function noticeGoesOut(sentInWindow: number, forced: boolean): boolean {
  return forced ? sentInWindow < FORCED_NOTICES_PER_WINDOW : sentInWindow === 0;
}

export interface FoldedCounts {
  /** Every folded submission since the link's last notice. */
  total: number;
  /** …of which revisions published without review. */
  published: number;
  /** …of which submissions that replaced the link's earlier one in review. */
  displaced: number;
}

/** How many submissions on this link were folded into a notice window
 *  since the link's last notice or cron digest, by kind — the count the
 *  next notice carries, so a burst of N uploads is never reported as one.
 *  Looks back at most two days (the attempt log's retention). An
 *  unreadable log answers zeros (the door: a notice without the count
 *  beats no notice); the cron reads it with readFoldedSinceLastNotice,
 *  which throws. */
export async function foldedSinceLastNotice(client: AttemptClient, input: {
  tokenHash: string; now?: number;
}): Promise<FoldedCounts> {
  try {
    return await readFoldedSinceLastNotice(client, input);
  } catch {
    return { total: 0, published: 0, displaced: 0 };
  }
}

/** foldedSinceLastNotice, but an unreadable log THROWS — the cron's flush
 *  must tell "nothing to announce" from "could not read". */
export async function readFoldedSinceLastNotice(client: AttemptClient, input: {
  tokenHash: string; now?: number;
}): Promise<FoldedCounts> {
  const horizon = new Date((input.now ?? Date.now()) - 2 * 24 * HOUR_MS).toISOString();
  const { data: sent, error: sentErr } = await client.from("intake_attempts")
    .select("created_at")
    .eq("token_hash", input.tokenHash).in("outcome", [ATTEMPT_OUTCOME.notified, ATTEMPT_OUTCOME.digested])
    .gte("created_at", horizon);
  if (sentErr) throw new Error(`intake attempt log unreadable: ${sentErr.message}`);
  const last = (((sent ?? []) as Array<{ created_at: string }>)).map((r) => String(r.created_at)).sort().pop() ?? horizon;
  const countOf = async (outcome: string): Promise<number> => {
    const { count, error } = await client.from("intake_attempts")
      .select("id", { count: "exact", head: true })
      .eq("token_hash", input.tokenHash).eq("outcome", outcome)
      .gte("created_at", last);
    if (error || typeof count !== "number") throw new Error(`intake attempt log unreadable: ${error?.message ?? "no count"}`);
    return count;
  };
  const review = await countOf(ATTEMPT_OUTCOME.suppressed);
  const published = await countOf(ATTEMPT_OUTCOME.suppressedPublished);
  const displaced = await countOf(ATTEMPT_OUTCOME.suppressedDisplaced);
  return { total: review + published + displaced, published, displaced };
}

/** Pure: the sentence the next notice carries for what was folded. */
export function foldedNoticeSentence(f: FoldedCounts, tab: string): string {
  if (f.total <= 0) return "";
  const kinds: string[] = [];
  if (f.published > 0) kinds.push(`${f.published} published without review`);
  if (f.displaced > 0) kinds.push(`${f.displaced} replacing an earlier submission in review`);
  return `${f.total} more submission${f.total === 1 ? "" : "s"} arrived on this link since the last notice${kinds.length ? ` (${kinds.join(", ")})` : ""} — see the project's ${tab} tab.`;
}

/** One link's unannounced folds, as a digest lists them. */
export interface FoldedLink {
  linkId: string;
  company: string;
  folded: FoldedCounts;
}

/** One digest for a PROJECT whose links folded publishes / replacements no
 *  notice has announced (INTK-10 / SEC-8). One per project, never one per
 *  link: every digest's email is keyed on the project, and queueEmail drops
 *  a second email to the same person with the same event and resource
 *  within 60 seconds — a second link's digest would have reached no inbox. */
export interface FoldedDigest {
  orgId: string;
  projectId: string;
  /** Each link with unannounced folds, with its own counts. */
  links: FoldedLink[];
  /** The links' counts summed. */
  folded: FoldedCounts;
  /** The link's company, or "N contractor links". */
  actorName: string;
  /** The controller pool (Admin / DocCtrl, additive roles) and the project
   *  owner — the people accountable for a controlled revision. */
  involved: string[];
  title: string;
  body: string;
  link: string;
}

function foldedPhrase(f: FoldedCounts): { kinds: string; more: string } {
  const parts: string[] = [];
  if (f.published > 0) parts.push(`published ${f.published} revision${f.published === 1 ? "" : "s"} without review`);
  if (f.displaced > 0) parts.push(`replaced ${f.displaced} submission${f.displaced === 1 ? "" : "s"} that ${f.displaced === 1 ? "was" : "were"} awaiting review`);
  const others = f.total - f.published - f.displaced;
  return { kinds: parts.join(" and "), more: others > 0 ? `, and sent ${others} more for review` : "" };
}

/** Pure: one link's digest words. */
export function foldedDigestText(company: string, projectName: string | null, f: FoldedCounts): { title: string; body: string } {
  const { kinds, more } = foldedPhrase(f);
  return {
    title: `Intake: ${company} ${kinds} — not announced yet`,
    body: `${company}'s intake link${projectName ? ` on ${projectName}` : ""} ${kinds}${more} after the team's last notice from that link (the per-link notice cap folded them, and the link has sent nothing since). See the project's Intake tab and each document's revision history.`,
  };
}

/** Pure: a project's digest words — one link reads as foldedDigestText;
 *  several are listed, each with its own counts. */
export function foldedProjectDigestText(projectName: string | null, links: FoldedLink[]): { title: string; body: string } {
  if (links.length === 1) return foldedDigestText(links[0].company, projectName, links[0].folded);
  const { kinds } = foldedPhrase(sumFolded(links));
  const each = links.map((l) => { const p = foldedPhrase(l.folded); return `${l.company} ${p.kinds}${p.more}`; });
  return {
    title: `Intake: ${links.length} contractor links ${kinds} — not announced yet`,
    body: `${links.length} intake links${projectName ? ` on ${projectName}` : ""} sent submissions after the team's last notice from each link that no notice has announced (the per-link notice cap folded them, and each link has sent nothing since): ${each.join("; ")}. See the project's Intake tab and each document's revision history.`,
  };
}

function sumFolded(links: FoldedLink[]): FoldedCounts {
  return links.reduce((a, l) => ({
    total: a.total + l.folded.total, published: a.published + l.folded.published, displaced: a.displaced + l.folded.displaced,
  }), { total: 0, published: 0, displaced: 0 });
}

/** The bell kind a digest carries: a published revision outranks a
 *  replacement. */
export function foldedDigestKind(d: Pick<FoldedDigest, "folded">): "doc_superseded" | "review_requested" {
  return d.folded.published > 0 ? "doc_superseded" : "review_requested";
}

/** What a digest's notice records (bell and email alike). */
export function foldedDigestMetadata(d: FoldedDigest): Record<string, unknown> {
  return {
    intake: true, foldedDigest: true,
    published: d.folded.published, displaced: d.folded.displaced, total: d.folded.total,
    links: d.links.map((l) => ({ linkId: l.linkId, company: l.company, ...l.folded })),
  };
}

const MAX_CANDIDATE_PAGES = 1000;

/** Every hashed token (with its link) that has a folded publish or
 *  replacement in the attempt log's two days — read to the horizon, page by
 *  page (INTK-10 / SEC-8: a cap on the newest rows let two bursting tokens
 *  push a quiet link's older folds out of view until the prune removed
 *  them). Oldest first, so rows written meanwhile land after the pages
 *  already read; a page shorter than asked is not the end (the API may cap
 *  a page below it), an empty page is. Throws when the log cannot be read
 *  — or holds more than MAX_CANDIDATE_PAGES pages, rather than stopping
 *  short in silence. */
export async function foldedCandidateLinks(client: AttemptClient, input: {
  now?: number; pageSize?: number;
} = {}): Promise<Map<string, string | null>> {
  const horizon = new Date((input.now ?? Date.now()) - 2 * 24 * HOUR_MS).toISOString();
  const pageSize = input.pageSize ?? 1000;
  const linkOf = new Map<string, string | null>();
  let from = 0;
  for (let page = 0; ; page++) {
    if (page >= MAX_CANDIDATE_PAGES) throw new Error(`intake attempt log holds more than ${MAX_CANDIDATE_PAGES} pages of folded notices — not read to the end`);
    const { data, error } = await client.from("intake_attempts")
      .select("token_hash, link_id")
      .in("outcome", [ATTEMPT_OUTCOME.suppressedPublished, ATTEMPT_OUTCOME.suppressedDisplaced])
      .gte("created_at", horizon)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`intake attempt log unreadable: ${error.message}`);
    const rows = (data ?? []) as Array<{ token_hash: string; link_id: string | null }>;
    if (rows.length === 0) return linkOf;
    for (const r of rows) {
      if (!linkOf.get(String(r.token_hash))) linkOf.set(String(r.token_hash), r.link_id ?? null);
    }
    from += rows.length;
  }
}

/** What one run of the flush did. */
export interface FoldedFlush {
  /** Digests delivered — one per project. */
  digests: number;
  /** Links those digests announced. */
  announced: number;
  /** …of which the 'digested' marker did not land: the next run announces
   *  them AGAIN (a repeat, never a loss). */
  unrecorded: number;
  /** Links not announced — a read failed (the link's fold count included),
   *  the send threw or reported that nothing landed. No marker is written;
   *  the next run retries. */
  failed: number;
  /** Links that no longer exist (their project was deleted). */
  gone: number;
}

/** INTK-10 / SEC-8 — the folds no notice announced. A burst that ends on
 *  folded publishes (or replacements) is otherwise reported only by the
 *  link's NEXT notice; if the link goes quiet, the people accountable for
 *  those controlled revisions never hear of them. The maintenance cron calls
 *  this: every link with suppressed_published / suppressed_displaced rows
 *  newer than its last 'notified' or 'digested' row (within the attempt
 *  log's two days, read to the horizon — foldedCandidateLinks) is grouped
 *  by project, and ONE digest per project, listing each link's counts, goes
 *  to the controller pool and the project owner. `send` answers how many
 *  recipients the digest LANDED with (deliverFoldedDigest: the bell rows,
 *  inserted and checked); only then is each link marked 'digested', and a
 *  marker that does not land is counted (`unrecorded` — that link is
 *  announced again next run). A send that throws or lands nothing marks
 *  nothing (`failed`, retried next run); a link that no longer exists is
 *  counted `gone`. Throws when the attempt log cannot be read. */
export async function flushFoldedIntakeNotices(client: AttemptClient, input: {
  now?: number;
  send: (digest: FoldedDigest) => Promise<number>;
}): Promise<FoldedFlush> {
  const out: FoldedFlush = { digests: 0, announced: 0, unrecorded: 0, failed: 0, gone: 0 };
  const candidates = await foldedCandidateLinks(client, { now: input.now });
  type Group = { orgId: string; projectId: string; links: Array<FoldedLink & { tokenHash: string }> };
  const groups = new Map<string, Group>();
  for (const [tokenHash, linkId] of candidates) {
    let folded: FoldedCounts;
    try {
      folded = await readFoldedSinceLastNotice(client, { tokenHash, now: input.now });
    } catch {
      out.failed++; // unread is not "announced already" — the next run retries
      continue;
    }
    if (folded.published + folded.displaced === 0) continue; // announced already
    if (!linkId) { out.gone++; continue; }
    const { data: link, error: linkErr } = await client.from("project_intake_links")
      .select("id, org_id, project_id, company_name").eq("id", linkId).maybeSingle();
    if (linkErr) { out.failed++; continue; }
    if (!link) { out.gone++; continue; }
    const l = link as { org_id: string; project_id: string; company_name: string | null };
    const key = `${l.org_id}:${l.project_id}`;
    const g = groups.get(key) ?? { orgId: String(l.org_id), projectId: String(l.project_id), links: [] };
    g.links.push({ tokenHash, linkId, company: String(l.company_name ?? "A contractor"), folded });
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const { data: project, error: projErr } = await client.from("projects")
      .select("name, owner_user_id").eq("id", g.projectId).eq("org_id", g.orgId).maybeSingle();
    if (projErr) { out.failed += g.links.length; continue; }
    const { data: controllers, error: ctlErr } = await client.from("org_members")
      .select("uid").eq("org_id", g.orgId).eq("status", "active").or(roleFilter(["Admin", "DocCtrl"]));
    if (ctlErr) { out.failed += g.links.length; continue; }
    const p = (project ?? null) as { name: string | null; owner_user_id: string | null } | null;
    const involved = [...new Set([
      ...(((controllers ?? []) as Array<{ uid: string }>).map((c) => String(c.uid))),
      ...(p?.owner_user_id ? [String(p.owner_user_id)] : []),
    ])];
    const links: FoldedLink[] = g.links.map((l) => ({ linkId: l.linkId, company: l.company, folded: l.folded }));
    const text = foldedProjectDigestText(p?.name ?? null, links);
    let landed = 0;
    try {
      landed = await input.send({
        orgId: g.orgId, projectId: g.projectId, links, folded: sumFolded(links),
        actorName: links.length === 1 ? links[0].company : `${links.length} contractor links`,
        involved, title: text.title, body: text.body, link: `/projects/${g.projectId}`,
      });
    } catch {
      landed = 0;
    }
    if (!(landed > 0)) { out.failed += g.links.length; continue; } // no marker — the next run retries
    out.digests++;
    for (const l of g.links) {
      out.announced++;
      const marked = await recordIntakeAttempt(client, { tokenHash: l.tokenHash, ip: "maintenance-cron", outcome: ATTEMPT_OUTCOME.digested, linkId: l.linkId });
      if (!marked) out.unrecorded++;
    }
  }
  return out;
}

/** Any client with `.from()` whose inserts can be read back. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NoticeClient = { from: (table: string) => any };

/** INTK-10 / SEC-8 — the cron's delivery of one digest, which REPORTS.
 *  emit() cannot: notify() and queueEmail() log and swallow every failure.
 *  So the bell rows — the delivery the flush's marker relies on — are
 *  inserted here, on the service-role client, in ONE statement, and
 *  checked: the answer is how many landed (all or none; a refusal throws).
 *  The email leg (`email` — the cron passes emit() on the email channel)
 *  runs only after the bell rows landed and is best-effort: a failure is
 *  logged, never counted. */
export async function deliverFoldedDigest(client: NoticeClient, d: FoldedDigest, email?: (d: FoldedDigest) => Promise<void>): Promise<number> {
  if (d.involved.length === 0) return 0;
  const metadata = foldedDigestMetadata(d);
  const { data, error } = await client.from("notifications").insert(d.involved.map((uid) => ({
    org_id: d.orgId, user_id: uid, kind: foldedDigestKind(d),
    title: d.title, body: d.body, link: d.link,
    resource_type: "project", resource_id: d.projectId,
    actor_name: d.actorName, metadata,
  }))).select("id");
  if (error) throw new Error(`the digest's notices were refused: ${error.message}`);
  const landed = Array.isArray(data) ? data.length : 0;
  if (landed > 0 && email) {
    try { await email(d); } catch (e) { console.error("[intakeRateLimit] digest email leg failed (the bell rows landed):", (e as Error).message); }
  }
  return landed;
}

/** An RPC error that means only "this function does not exist yet" (the
 *  migration is not applied): PostgREST PGRST202, or Postgres 42883 when
 *  its message says a FUNCTION does not exist (42883 is also "operator
 *  does not exist" — a broken body, which must be reported). Never matched
 *  on the function's name alone — a permission error names the function
 *  too, and must be reported, not read as "not applied". */
export function isMissingFunction(err: { code?: string | null; message: string }): boolean {
  const code = String(err.code ?? "");
  if (code === "PGRST202") return true;
  if (code === "42883") return /function .* does not exist/i.test(err.message);
  return /Could not find the function/i.test(err.message);
}

/** One org's review rows that no screen lists (migration 20261105's
 *  intake_review_health_by_org(): the same two state predicates as
 *  orphaned_in_review_versions_count() and
 *  pending_on_retired_version_count()). `orgId` is null for rows neither
 *  the version nor its document names an org for — nobody to nudge. */
export interface ReviewHealthOrg {
  orgId: string | null;
  orphanedInReview: number;
  pendingOnRetired: number;
  /** One document to point the notice at. */
  exampleDocumentId: string | null;
}

/** The bell kind of the review-health nudge — a compliance kind, so the
 *  cron's daily compliance email (step 6b) carries it too. */
export const REVIEW_HEALTH_KIND = "review_overdue" as const;

/** Pure: the nudge's words. */
export function reviewHealthNudgeText(h: ReviewHealthOrg): { title: string; body: string } {
  const parts: string[] = [];
  if (h.pendingOnRetired > 0) parts.push(`${h.pendingOnRetired} document${h.pendingOnRetired === 1 ? "" : "s"} whose pending revision names a retired draft`);
  if (h.orphanedInReview > 0) parts.push(`${h.orphanedInReview} in-review version${h.orphanedInReview === 1 ? "" : "s"} no document points at`);
  const remedies: string[] = [];
  if (h.pendingOnRetired > 0) remedies.push("a document stuck on a retired draft stays 'in review' with nothing to review — re-open the draft (review_state 'in_review', superseded_at cleared) or clear the document's pending revision; the finder query is in the comment on pending_on_retired_version_count()");
  if (h.orphanedInReview > 0) remedies.push("an in-review version nothing points at must be marked 'superseded' or 'rejected', or its document re-pointed; the finder query is orphaned_in_review_versions_count()");
  return {
    title: `Review health: ${parts.join(" and ")}`,
    body: `No screen lists these, so Document Control resolves them by hand (migration 20261105): ${remedies.join("; ")}. This notice repeats daily until the counts reach 0.`,
  };
}

/** INTK-4 / SAF-10 — the review-health counts reach a person. For each
 *  org with a count above 0, ONE notice a day to its controller pool
 *  (`send` — the cron's emit() to the Admin / DocCtrl roles), deduped on a
 *  `review_overdue` notice for the org carrying metadata.reviewHealthDay
 *  (the escalateStaleCheckouts / HLD-14 shape). A dedupe read that fails
 *  does not stop the nudge (a repeat beats silence); a send that throws is
 *  counted `failed`; a row with no org is never sent (no pool to resolve)
 *  and is counted `orgless` for the cron to report. `nudged` counts sends
 *  made for an org — emit() itself reports no delivery. */
export async function nudgeReviewHealth(client: NoticeClient, input: {
  orgs: ReviewHealthOrg[];
  day: string;
  send: (h: ReviewHealthOrg & { orgId: string }, text: { title: string; body: string }, metadata: Record<string, unknown>) => Promise<void>;
}): Promise<{ nudged: number; skipped: number; failed: number; orgless: number }> {
  const out = { nudged: 0, skipped: 0, failed: 0, orgless: 0 };
  for (const row of input.orgs) {
    if (row.orphanedInReview + row.pendingOnRetired <= 0) continue;
    if (!row.orgId) { out.orgless++; continue; }
    const h = { ...row, orgId: row.orgId };
    const { data: existing, error } = await client.from("notifications")
      .select("id").eq("org_id", h.orgId).eq("kind", REVIEW_HEALTH_KIND)
      .contains("metadata", { reviewHealthDay: input.day }).limit(1);
    if (!error && ((existing as unknown[] | null) ?? []).length > 0) { out.skipped++; continue; }
    try {
      await input.send(h, reviewHealthNudgeText(h), {
        reviewHealth: true, reviewHealthDay: input.day,
        orphanedInReview: h.orphanedInReview, pendingOnRetired: h.pendingOnRetired,
      });
      out.nudged++;
    } catch {
      out.failed++;
    }
  }
  return out;
}

export interface LinkBudget {
  submissionCount: number;
  maxSubmissions: number;
  bytesReceived: number;
  maxTotalBytes: number;
}

/** The link's lifetime budget, read tolerantly: a database without the
 *  20261104 columns answers null (no cap enforced — the rate window and
 *  the link's expiry still apply). */
export async function readLinkBudget(client: AttemptClient, linkId: string): Promise<LinkBudget | null> {
  try {
    const { data, error } = await client.from("project_intake_links")
      .select("submission_count, max_submissions, bytes_received, max_total_bytes")
      .eq("id", linkId).maybeSingle();
    if (error || !data) return null;
    const r = data as Record<string, unknown>;
    if (r.max_submissions == null || r.max_total_bytes == null) return null;
    return {
      submissionCount: Number(r.submission_count ?? 0),
      maxSubmissions: Number(r.max_submissions),
      bytesReceived: Number(r.bytes_received ?? 0),
      maxTotalBytes: Number(r.max_total_bytes),
    };
  } catch {
    return null;
  }
}

/** Pure: the refusal for a link that has spent its budget, or null. */
export function linkBudgetRefusal(budget: LinkBudget | null, incomingBytes: number | null): string | null {
  if (!budget) return null;
  if (budget.submissionCount >= budget.maxSubmissions) {
    return `This link has reached its limit of ${budget.maxSubmissions} submissions — ask your project contact for a new link.`;
  }
  if (incomingBytes != null && budget.bytesReceived + incomingBytes > budget.maxTotalBytes) {
    return "This link has used its storage allowance — ask your project contact for a new link.";
  }
  return null;
}
