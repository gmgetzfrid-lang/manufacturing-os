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
//     sends ONE digest per such link to the controllers and the owner;
//   * a per-link lifetime cap (submissions and bytes) read from the link
//     row (20261104), so one leaked token cannot grow storage without end.
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
 *  submission that replaced the link's earlier one in review. */
export const ATTEMPT_OUTCOME = {
  attempt: "attempt", notified: "notified", suppressed: "suppressed",
  suppressedPublished: "suppressed_published", suppressedDisplaced: "suppressed_displaced",
} as const;

/** SEC-8 dw2: the most notices one link sends the team per window, forced
 *  ones included. An ordinary notice goes only when the window is empty; a
 *  forced one (published / displaced) while fewer than this many went. */
export const FORCED_NOTICES_PER_WINDOW = 3;

export type RateVerdict = { limited: false } | { limited: true; retryAfterSec: number; message: string };

const HOUR_MS = 3600_000;

async function countSince(client: AttemptClient, col: "token_hash" | "ip", value: string, sinceIso: string): Promise<number | null> {
  const { count, error } = await client.from("intake_attempts")
    .select("id", { count: "exact", head: true })
    .eq(col, value).eq("outcome", ATTEMPT_OUTCOME.attempt)
    .gte("created_at", sinceIso);
  if (error) return null;
  return typeof count === "number" ? count : 0;
}

/** Over the per-token or per-IP hourly window? Fails OPEN on any error. */
export async function checkIntakeRate(client: AttemptClient, input: {
  tokenHash: string; ip: string; limits: IntakeLimits; now?: number;
}): Promise<RateVerdict> {
  try {
    const since = new Date((input.now ?? Date.now()) - HOUR_MS).toISOString();
    const perToken = await countSince(client, "token_hash", input.tokenHash, since);
    if (perToken != null && perToken >= input.limits.perTokenPerHour) {
      return { limited: true, retryAfterSec: 3600, message: `Too many uploads on this link in the last hour (limit ${input.limits.perTokenPerHour}). Wait a while and try again — nothing from this attempt was stored.` };
    }
    // An unknown address is not everyone's address — never pool them.
    if (input.ip !== "unknown") {
      const perIp = await countSince(client, "ip", input.ip, since);
      if (perIp != null && perIp >= input.limits.perIpPerHour) {
        return { limited: true, retryAfterSec: 3600, message: `Too many uploads from your network in the last hour (limit ${input.limits.perIpPerHour}). Wait a while and try again — nothing from this attempt was stored.` };
      }
    }
    return { limited: false };
  } catch {
    return { limited: false }; // fail open — the house pattern
  }
}

/** Best-effort: a failed attempt write is logged, never fatal. */
export async function recordIntakeAttempt(client: AttemptClient, input: {
  tokenHash: string; ip: string; outcome: string; linkId?: string | null; bytes?: number | null;
}): Promise<void> {
  try {
    const { error } = await client.from("intake_attempts").insert({
      token_hash: input.tokenHash, ip: input.ip, outcome: input.outcome,
      link_id: input.linkId ?? null, bytes: input.bytes ?? null,
    });
    if (error) console.warn("[intakeRateLimit] attempt write failed (limiter degrades open):", error.message);
  } catch (e) {
    console.warn("[intakeRateLimit] attempt write threw (limiter degrades open):", (e as Error).message);
  }
}

/** How many team notices this link sent inside the window (any kind). An
 *  unreadable log answers 0 — a notice too many beats a submission nobody
 *  hears about. */
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
 *  since the link's last notice, by kind — the count the next notice
 *  carries, so a burst of N uploads is never reported as one. Looks back at
 *  most two days (the attempt log's retention). An unreadable log answers
 *  zeros. */
export async function foldedSinceLastNotice(client: AttemptClient, input: {
  tokenHash: string; now?: number;
}): Promise<FoldedCounts> {
  const none: FoldedCounts = { total: 0, published: 0, displaced: 0 };
  try {
    const horizon = new Date((input.now ?? Date.now()) - 2 * 24 * HOUR_MS).toISOString();
    const { data: sent, error: sentErr } = await client.from("intake_attempts")
      .select("created_at")
      .eq("token_hash", input.tokenHash).eq("outcome", ATTEMPT_OUTCOME.notified)
      .gte("created_at", horizon);
    if (sentErr) return none;
    const last = (((sent ?? []) as Array<{ created_at: string }>)).map((r) => String(r.created_at)).sort().pop() ?? horizon;
    const countOf = async (outcome: string): Promise<number> => {
      const { count, error } = await client.from("intake_attempts")
        .select("id", { count: "exact", head: true })
        .eq("token_hash", input.tokenHash).eq("outcome", outcome)
        .gte("created_at", last);
      return error || typeof count !== "number" ? 0 : count;
    };
    const review = await countOf(ATTEMPT_OUTCOME.suppressed);
    const published = await countOf(ATTEMPT_OUTCOME.suppressedPublished);
    const displaced = await countOf(ATTEMPT_OUTCOME.suppressedDisplaced);
    return { total: review + published + displaced, published, displaced };
  } catch {
    return none;
  }
}

/** Pure: the sentence the next notice carries for what was folded. */
export function foldedNoticeSentence(f: FoldedCounts, tab: string): string {
  if (f.total <= 0) return "";
  const kinds: string[] = [];
  if (f.published > 0) kinds.push(`${f.published} published without review`);
  if (f.displaced > 0) kinds.push(`${f.displaced} replacing an earlier submission in review`);
  return `${f.total} more submission${f.total === 1 ? "" : "s"} arrived on this link since the last notice${kinds.length ? ` (${kinds.join(", ")})` : ""} — see the project's ${tab} tab.`;
}

/** One digest for a link whose folded publishes / replacements no notice
 *  has announced (INTK-10 / SEC-8). */
export interface FoldedDigest {
  orgId: string;
  projectId: string;
  linkId: string;
  company: string;
  /** The controller pool (Admin / DocCtrl, additive roles) and the project
   *  owner — the people accountable for a controlled revision. */
  involved: string[];
  folded: FoldedCounts;
  title: string;
  body: string;
  link: string;
}

/** Pure: the digest's words. */
export function foldedDigestText(company: string, projectName: string | null, f: FoldedCounts): { title: string; body: string } {
  const parts: string[] = [];
  if (f.published > 0) parts.push(`published ${f.published} revision${f.published === 1 ? "" : "s"} without review`);
  if (f.displaced > 0) parts.push(`replaced ${f.displaced} submission${f.displaced === 1 ? "" : "s"} that ${f.displaced === 1 ? "was" : "were"} awaiting review`);
  const others = f.total - f.published - f.displaced;
  const more = others > 0 ? `, and sent ${others} more for review` : "";
  return {
    title: `Intake: ${company} ${parts.join(" and ")} — not announced yet`,
    body: `${company}'s intake link${projectName ? ` on ${projectName}` : ""} ${parts.join(" and ")}${more} after the team's last notice from that link (the per-link notice cap folded them, and the link has sent nothing since). See the project's Intake tab and each document's revision history.`,
  };
}

/** INTK-10 / SEC-8 — the folds no notice announced. A burst that ends on
 *  folded publishes (or replacements) is otherwise reported only by the
 *  link's NEXT notice; if the link goes quiet, the people accountable for
 *  those controlled revisions never hear of them. The maintenance cron calls
 *  this: for every link with suppressed_published / suppressed_displaced
 *  rows newer than its last 'notified' row (within the attempt log's two
 *  days), ONE digest goes to the controller pool and the project owner, and
 *  a 'notified' row is written — so the next notice on the link never
 *  counts them twice, and a digest is never repeated. A link whose send
 *  fails gets no 'notified' row (the next run retries); a link that no
 *  longer exists (its project was deleted) is counted as `gone`. Throws
 *  when the attempt log cannot be read. */
export async function flushFoldedIntakeNotices(client: AttemptClient, input: {
  now?: number;
  send: (digest: FoldedDigest) => Promise<void>;
}): Promise<{ digests: number; failed: number; gone: number }> {
  const out = { digests: 0, failed: 0, gone: 0 };
  const horizon = new Date((input.now ?? Date.now()) - 2 * 24 * HOUR_MS).toISOString();
  const { data: rows, error } = await client.from("intake_attempts")
    .select("token_hash, link_id, created_at")
    .in("outcome", [ATTEMPT_OUTCOME.suppressedPublished, ATTEMPT_OUTCOME.suppressedDisplaced])
    .gte("created_at", horizon)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw new Error(`intake attempt log unreadable: ${error.message}`);
  const linkOf = new Map<string, string | null>();
  for (const r of ((rows ?? []) as Array<{ token_hash: string; link_id: string | null }>)) {
    if (!linkOf.get(r.token_hash)) linkOf.set(r.token_hash, r.link_id ?? null);
  }
  for (const [tokenHash, linkId] of linkOf) {
    const folded = await foldedSinceLastNotice(client, { tokenHash, now: input.now });
    if (folded.published + folded.displaced === 0) continue; // announced already
    if (!linkId) { out.gone++; continue; }
    const { data: link, error: linkErr } = await client.from("project_intake_links")
      .select("id, org_id, project_id, company_name").eq("id", linkId).maybeSingle();
    if (linkErr) { out.failed++; continue; }
    if (!link) { out.gone++; continue; }
    const l = link as { org_id: string; project_id: string; company_name: string | null };
    const { data: project, error: projErr } = await client.from("projects")
      .select("name, owner_user_id").eq("id", l.project_id).eq("org_id", l.org_id).maybeSingle();
    if (projErr) { out.failed++; continue; }
    const { data: controllers, error: ctlErr } = await client.from("org_members")
      .select("uid").eq("org_id", l.org_id).eq("status", "active").or(roleFilter(["Admin", "DocCtrl"]));
    if (ctlErr) { out.failed++; continue; }
    const p = (project ?? null) as { name: string | null; owner_user_id: string | null } | null;
    const involved = [...new Set([
      ...(((controllers ?? []) as Array<{ uid: string }>).map((c) => String(c.uid))),
      ...(p?.owner_user_id ? [String(p.owner_user_id)] : []),
    ])];
    const company = String(l.company_name ?? "A contractor");
    const text = foldedDigestText(company, p?.name ?? null, folded);
    try {
      await input.send({
        orgId: String(l.org_id), projectId: String(l.project_id), linkId, company,
        involved, folded, title: text.title, body: text.body, link: `/projects/${l.project_id}`,
      });
    } catch {
      out.failed++;
      continue; // no 'notified' row — the next run retries
    }
    await recordIntakeAttempt(client, { tokenHash, ip: "maintenance-cron", outcome: ATTEMPT_OUTCOME.notified, linkId });
    out.digests++;
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
