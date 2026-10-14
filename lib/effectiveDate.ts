// lib/effectiveDate.ts
//
// Effective date — the date a controlled revision comes INTO FORCE, which may be
// later than its issue date (e.g. a procedure that takes effect after a training
// window). This is a date + badge + notification concept: the revision is still
// the current controlled version (which rev is served never changes here); it
// simply shows "Effective <date>" until the day arrives, then flips and the
// owner + acknowledgment assignees are told it's now in force.

import { supabase } from "@/lib/supabase";
// DELIV-16 / DELIV-7 dw1 (notifications N14): the bell notices here carry
// document-control obligations — notify(), retried and dead-lettered when
// it does not land (lib/complianceNotify.ts).
import { notifyCompliance as notify } from "@/lib/complianceNotify";
import { loadScanRetryPlan } from "@/lib/complianceNotify";
import { effectiveOwnerForDocument, getOrgControllers } from "@/lib/ownership";
import { readWorkspaceTimeZone, readWorkspaceTimeZoneWriter } from "@/lib/workspaceTimeZone";

export type EffectiveStatus = "none" | "pending" | "effective";

// ─── REV-9: ONE definition of "today" ─────────────────────────────────────
//
// The badge used to compare against the BROWSER's local midnight while the
// suppression watermark, the daily scan and /api/verify compared against
// UTC — so a publisher west of UTC choosing "tomorrow" in the evening had
// the announcement pre-suppressed (UTC was already "tomorrow") while the
// badge still read pending, and the day it flipped nobody was told.
//
// Every "is this date in force yet?" question now asks the same calendar:
// the FACILITY's, named by the deployment in NEXT_PUBLIC_FACILITY_TIME_ZONE
// (an IANA zone such as "America/Chicago"). An effective date is a plant
// calendar day — "the day after the training" — so neither the browser's
// zone nor UTC is right on its own: UTC flips a date early for every site
// west of it (a Houston publisher's 22 Aug is already "today" at 19:00 on
// 21 Aug), the browser's zone differs between a remote reviewer and the
// floor. Unset (or not a zone Intl knows), the calendar falls back to the
// LATEST calendar on Earth — UTC-12 — never UTC: a day begins there only
// after it has begun in every facility's calendar, so with no zone named a
// date is never shown, stamped or announced as in force EARLY anywhere; it
// is late, by the facility's offset plus twelve hours (Houston: the badge
// flips at 07:00 instead of midnight; a UTC+14 facility: 26 hours late). Late is the safe side of a
// procedure that must not be in force before the training. REV-9 stays open
// until every deployment names its zone (or an org / library zone setting
// lands, which changes effectiveDateTimeZone() and nothing else). Dates are
// compared as YYYY-MM-DD strings, never by parsing a bare datetime (which JS
// reads in the local zone).
//
// VFY-15 (admin-and-org Round G, P12 — DEC-63 §4 reversal 4): the org
// setting has landed. An Admin names the workspace's zone on /admin/settings
// (org_configurations key "timezone", lib/workspaceTimeZone.ts), and it is
// the calendar a document of that workspace is decided in, BEFORE the
// deployment variable: effectiveDateTimeZone(workspaceZone) prefers it, and
// workspaceEffectiveDateTimeZone(client, orgId) reads it for the document's
// org. No zone set, a stored value this runtime does not know, or a setting
// that cannot be read all fall back to the deployment variable — today's
// behaviour, never silently UTC — and then, as before, to UTC-12. Every
// caller passes the zone it resolved for the document's org: /api/verify,
// /api/verify-package, the transmittal portal, the badge (EffectivePill), the
// register, the suppression watermark (applyEffectiveDate) and the daily
// scan (scanEffectiveDates) — so the watermark and the scan still share one
// calendar per workspace (REV-9's rule, now per org).
//
// VFY-15 review fix (the 20261203 prerequisite): the stored zone decides
// effective dates only once the deployment says the key is an Admin's.
// Until 20261203 is pasted the 'timezone' key falls to the permissive org
// policy — ANY active member could write it straight through PostgREST,
// bypassing the settings page and its audit row, and so move every
// effective date of the workspace up to 26 hours early (Etc/GMT+12 →
// Pacific/Kiritimati) on the public verify verdict, the badge, the scan and
// the watermark. So the workspace zone is honoured only when
// NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE names that migration
// ("20261203"), set by the operator AFTER the paste; unset (or anything
// else), every effective date is decided exactly as before VFY-15 — the
// deployment variable, else UTC-12 — and the setting is not even read.
//
// VFY-15 re-review fix (DEC-90, fail safe): the switch alone does not make a
// row written BEFORE the paste trustworthy — a non-Admin's value from then
// would be honoured the moment the switch is set. The row has no writer
// column and 20261203 stamps no marker, so the stored zone decides only when
// the newest trustworthy WORKSPACE_TIMEZONE_CHANGED audit row (an Admin at
// read time, or actor_kind server / system) names exactly it
// (decideWorkspaceEffectiveZone → lib/workspaceTimeZone.ts
// readWorkspaceTimeZoneWriter). Otherwise the deployment's calendar decides
// and /admin/settings asks an Admin to re-confirm the zone (the save
// re-writes it as that Admin). A browser may not read the audit trail, so
// in the browser the decision is the server's (/api/workspace-effective-zone).

/** The calendar used when the deployment names no (valid) facility zone:
 *  UTC-12. IANA spells it "Etc/GMT+12" — the POSIX sign is inverted, so
 *  this is twelve hours BEHIND UTC, the last place any date begins. */
export const EFFECTIVE_DATE_FALLBACK_TIME_ZONE = "Etc/GMT+12";

let warnedZone: string | null = null;
let warnedUnset = false;

/** REV-9 (review fix 3): what the fallback costs, in the words every warning
 *  uses — the hours a date can be late are the facility's offset plus 12,
 *  so up to 26 for a UTC+14 site. */
const FALLBACK_COST = `${EFFECTIVE_DATE_FALLBACK_TIME_ZONE} (UTC-12: never early, but late by the facility's UTC offset plus 12 hours — up to 26 hours for a UTC+14 site)`;

/** REV-9 (review fix 3): is the facility zone named, and valid? For a health
 *  surface (an admin panel or deploy check can read it) — an unset zone is
 *  not an error the app can see otherwise. Pure: no warning is logged. */
export function facilityTimeZoneHealth(): { configured: boolean; valid: boolean; zone: string; message: string | null } {
  const raw = (process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE ?? "").trim();
  if (!raw) {
    return { configured: false, valid: false, zone: EFFECTIVE_DATE_FALLBACK_TIME_ZONE, message: `NEXT_PUBLIC_FACILITY_TIME_ZONE is not set — effective dates are decided in ${FALLBACK_COST}. Set the facility's IANA zone (document-control REV-9).` };
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: raw });
    return { configured: true, valid: true, zone: raw, message: null };
  } catch {
    return { configured: true, valid: false, zone: EFFECTIVE_DATE_FALLBACK_TIME_ZONE, message: `NEXT_PUBLIC_FACILITY_TIME_ZONE="${raw}" is not a time zone this runtime knows — effective dates are decided in ${FALLBACK_COST} until it is fixed.` };
  }
}

/** The calendar every effective-date decision is made in (REV-9): the
 *  deployment's facility zone, read at call time — the literal
 *  `process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE` reference is what Next
 *  inlines into the browser bundle, and the cron scan reads the same name
 *  on the server — else the latest calendar (UTC-12), which can only be
 *  late, never early. */
export function effectiveDateTimeZone(workspaceZone?: string | null): string {
  // VFY-15: the workspace's own zone (an Admin's setting, already read for
  // the document's org) wins when this runtime knows it.
  const ws = (workspaceZone ?? "").trim();
  if (ws) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: ws });
      return ws;
    } catch { /* not a zone this runtime knows: the deployment's calendar decides */ }
  }
  const raw = (process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE ?? "").trim();
  if (!raw) {
    // Review fix 3: an UNSET zone is said once per runtime too — silence
    // made "set it before deploying" depend on the operator noticing.
    if (!warnedUnset) {
      warnedUnset = true;
      console.error(`[effectiveDate] ${facilityTimeZoneHealth().message}`);
    }
    return EFFECTIVE_DATE_FALLBACK_TIME_ZONE;
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: raw });
    return raw;
  } catch {
    if (warnedZone !== raw) {
      warnedZone = raw;
      console.error(`[effectiveDate] ${facilityTimeZoneHealth().message}`);
    }
    return EFFECTIVE_DATE_FALLBACK_TIME_ZONE;
  }
}

/** The migration that makes the workspace time-zone key Admin-only — the
 *  value NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE must carry before a
 *  workspace's zone decides its effective dates (VFY-15 review fix). */
export const WORKSPACE_EFFECTIVE_ZONE_PREREQUISITE = "20261203";

/** VFY-15 review fix: may the workspace's stored zone decide effective
 *  dates? Only once the operator has recorded, in the deployment, that
 *  20261203 is live (before it any active member can write the key). The
 *  literal `process.env.NEXT_PUBLIC_…` reference is what Next inlines into
 *  the browser bundle, so the badge and the server agree. */
export function workspaceEffectiveZoneHonoured(): boolean {
  return (process.env.NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE ?? "").trim() === WORKSPACE_EFFECTIVE_ZONE_PREREQUISITE;
}

/** Minimal client surface the workspace-zone read needs (the browser client
 *  or a service client). */
type ZoneClient = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const warnedUnreadOrgs = new Set<string>();
function warnUnread(orgId: string, what: string, error: string): void {
  if (warnedUnreadOrgs.has(orgId)) return;
  warnedUnreadOrgs.add(orgId);
  console.error(`[effectiveDate] ${what} of ${orgId} could not be read (${error}) — effective dates are decided in the deployment's calendar (${effectiveDateTimeZone()}) until it can be.`);
}

/** What decides a workspace's effective dates, and whether its Admin should
 *  re-confirm the stored zone (VFY-15 re-review). `zone` is the calendar to
 *  decide in; `honoured` says the workspace's stored zone is that calendar;
 *  `reconfirm` says a valid zone is stored but no current Admin (or the
 *  server) is shown to have set it — the /admin/settings card asks an Admin
 *  to re-confirm it, and until then the deployment's calendar decides. */
export type WorkspaceZoneDecision = { zone: string; honoured: boolean; reconfirm: boolean; stored: string | null };

/** VFY-15: the decision, on a client that may read the workspace's audit
 *  trail (the service client — the server routes, the cron scan, and
 *  /api/workspace-effective-zone for the browser). Before the operator
 *  records 20261203 live (workspaceEffectiveZoneHonoured) nothing is read
 *  and the deployment's calendar decides, as before VFY-15. After it, the
 *  stored zone decides only when lib/workspaceTimeZone.ts
 *  readWorkspaceTimeZoneWriter shows its writer was an Admin (re-review
 *  fix, DEC-90: a row written before 20261203 by a non-Admin — the key was
 *  any member's until that paste — must not move every effective date up to
 *  26 hours early). No zone stored, a stored value this runtime does not
 *  know, a read that fails, or a writer not shown to be an Admin: the
 *  deployment variable, else UTC-12 — never UTC. Never rejects. */
export async function decideWorkspaceEffectiveZone(sb: ZoneClient, orgId: string | null | undefined): Promise<WorkspaceZoneDecision> {
  const deployment = (stored: string | null = null, reconfirm = false): WorkspaceZoneDecision =>
    ({ zone: effectiveDateTimeZone(), honoured: false, reconfirm, stored });
  // Review fix: before 20261203 the key is any member's to write, so it is
  // not read at all — the deployment's calendar decides, as before VFY-15.
  if (!orgId || !workspaceEffectiveZoneHonoured()) return deployment();
  const r = await readWorkspaceTimeZone(sb, orgId);
  if (!r.ok) { warnUnread(orgId, "the workspace time zone", r.error); return deployment(); }
  if (!r.timeZone || effectiveDateTimeZone(r.timeZone) !== r.timeZone) return deployment(r.stored);
  const writer = await readWorkspaceTimeZoneWriter(sb, orgId, r.stored ?? r.timeZone);
  if (!writer.ok) { warnUnread(orgId, "who set the workspace time zone", writer.error); return deployment(r.stored); }
  if (!writer.trusted) return deployment(r.stored, true);
  return { zone: r.timeZone, honoured: true, reconfirm: false, stored: r.stored };
}

/** The browser's route to the same decision: a browser session may not read
 *  the workspace's audit trail (audit_logs_admin_trail hides 'org' rows from
 *  everyone without admin.audit_view), so the server decides with the
 *  service client and every badge, register and watermark agrees with
 *  /api/verify and the scan. A failed call answers null. */
export const WORKSPACE_EFFECTIVE_ZONE_ROUTE = "/api/workspace-effective-zone";
export async function fetchWorkspaceZoneDecision(orgId: string): Promise<WorkspaceZoneDecision | null> {
  let token = "";
  try { token = (await supabase.auth.getSession()).data.session?.access_token ?? ""; } catch { /* the route refuses it; the caller falls back */ }
  try {
    const res = await fetch(`${WORKSPACE_EFFECTIVE_ZONE_ROUTE}?orgId=${encodeURIComponent(orgId)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<WorkspaceZoneDecision> | null;
    if (!body || typeof body.zone !== "string") return null;
    const honoured = body.honoured === true && effectiveDateTimeZone(body.zone) === body.zone;
    return {
      zone: honoured ? body.zone : effectiveDateTimeZone(),
      honoured,
      reconfirm: body.reconfirm === true,
      stored: typeof body.stored === "string" ? body.stored : null,
    };
  } catch {
    return null;
  }
}

const inBrowser = () => typeof window !== "undefined" && typeof document !== "undefined";

/** VFY-15: the calendar a document of `orgId` is decided in — the
 *  workspace's zone once workspaceEffectiveZoneHonoured() (20261203
 *  recorded live) AND its writer is shown to be an Admin
 *  (decideWorkspaceEffectiveZone), else the deployment variable, else
 *  UTC-12. On the server it decides through the client given (the service
 *  client); in the browser it asks /api/workspace-effective-zone. A
 *  decision that cannot be had is said once per workspace per runtime and
 *  falls back to the deployment variable — today's behaviour — never to
 *  UTC. Never rejects. */
export async function workspaceEffectiveDateTimeZone(sb: ZoneClient, orgId: string | null | undefined): Promise<string> {
  if (!orgId || !workspaceEffectiveZoneHonoured()) return effectiveDateTimeZone();
  if (inBrowser()) {
    const d = await fetchWorkspaceZoneDecision(orgId);
    if (!d) { warnUnread(orgId, "the workspace's effective-date calendar", "the server did not answer"); return effectiveDateTimeZone(); }
    return d.zone;
  }
  return (await decideWorkspaceEffectiveZone(sb, orgId)).zone;
}

/** VFY-15, for the browser: the same answer, kept per workspace for a few
 *  minutes so a page of badges reads the setting once. */
const ZONE_CACHE_MS = 5 * 60_000;
const zoneCache = new Map<string, { at: number; zone: Promise<string> }>();
export function cachedWorkspaceEffectiveDateTimeZone(sb: ZoneClient, orgId: string, now: number = Date.now()): Promise<string> {
  const hit = zoneCache.get(orgId);
  if (hit && now - hit.at < ZONE_CACHE_MS) return hit.zone;
  const zone = workspaceEffectiveDateTimeZone(sb, orgId).catch(() => effectiveDateTimeZone());
  zoneCache.set(orgId, { at: now, zone });
  return zone;
}
/** Forget one workspace's cached calendar (after its Admin saves or
 *  re-confirms the zone). */
export function forgetWorkspaceEffectiveZone(orgId: string): void {
  zoneCache.delete(orgId);
  warnedUnreadOrgs.delete(orgId);
}
/** Tests only: forget the browser cache and the once-per-workspace warnings. */
export function resetWorkspaceZoneCacheForTests(): void {
  zoneCache.clear();
  warnedUnreadOrgs.clear();
}

/** Today's date (YYYY-MM-DD) in the effective-date calendar — the ONE
 *  "today" the badge, the suppression watermark, the daily scan and the
 *  public verify endpoint share. `now` is injectable for tests. */
export function effectiveTodayISO(now: Date = new Date(), timeZone: string = effectiveDateTimeZone()): string {
  // en-CA formats as YYYY-MM-DD; formatToParts keeps it locale-proof.
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The YYYY-MM-DD head of a stored date, or null when it is not a real
 *  calendar date (never parsed through the local zone). */
function isoDay(value: string): string | null {
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [y, m, d] = day.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return day;
}

const todayISO = (timeZone?: string) => effectiveTodayISO(new Date(), timeZone);

/** `none` = no future effective date (effective immediately / already in force);
 *  `pending` = a future effective date not yet reached; `effective` = the date
 *  has arrived/passed. Only `pending` warrants a badge. Decided in the
 *  effective-date calendar (REV-9), the same one the scan announces in —
 *  `timeZone` is the document's workspace calendar when the caller resolved
 *  it (VFY-15: workspaceEffectiveDateTimeZone), else the deployment's. */
export function effectiveStatusFor(effectiveDate?: string | null, now: Date = new Date(), timeZone?: string): EffectiveStatus {
  if (!effectiveDate) return "none";
  const eff = isoDay(effectiveDate);
  if (!eff) return "none";
  return eff > effectiveTodayISO(now, timeZone) ? "pending" : "effective";
}

/** Whole days until the effective date (negative = already effective), in
 *  the effective-date calendar (REV-9). */
export function daysUntilEffective(effectiveDate?: string | null, now: Date = new Date(), timeZone?: string): number | null {
  if (!effectiveDate) return null;
  const eff = isoDay(effectiveDate);
  if (!eff) return null;
  const toUtc = (day: string) => { const [y, m, d] = day.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUtc(eff) - toUtc(effectiveTodayISO(now, timeZone))) / 86_400_000);
}

/** Persist an effective date onto a version + denormalize it onto the document.
 *  If the date is immediate (null / today / past) we pre-stamp the notify
 *  watermark so the "now in effect" notice never fires for it — only a genuinely
 *  FUTURE effective date gets announced when it arrives. VFY-15: "today" is
 *  the document's workspace calendar (`orgId`), the one scanEffectiveDates
 *  announces in — a watermark decided in another calendar could pre-suppress
 *  a date the scan has not reached yet (REV-9's defect, between two zones). */
export async function applyEffectiveDate(input: { documentId: string; versionId: string; effectiveDate: string | null; orgId?: string | null }): Promise<void> {
  const eff = input.effectiveDate ? input.effectiveDate.slice(0, 10) : null;
  const zone = eff && input.orgId ? await workspaceEffectiveDateTimeZone(supabase, input.orgId) : undefined;
  const suppress = !eff || eff <= todayISO(zone);
  // OWN-14: checked — both call sites treat this as best-effort, but a
  // refusal must at least THROW so their catch is a decision, not a default.
  const { error: verErr } = await supabase.from("document_versions")
    .update({ effective_date: eff }).eq("id", input.versionId).select("id");
  if (verErr) throw new Error(verErr.message);
  const { error: docErr } = await supabase.from("documents").update({
    effective_date: eff,
    effective_notified_at: suppress ? new Date().toISOString() : null,
  }).eq("id", input.documentId).select("id");
  if (docErr) throw new Error(docErr.message);
}

/** How far back the effective-date scan reads its dead letters: a notice lost
 *  this long ago (the cron down for a week) is no longer told apart, and its
 *  document is announced to every recipient again. */
const EFFECTIVE_RETRY_LOOKBACK_MS = 7 * 86_400_000;

/** Daily scan: announce revisions whose future effective date has arrived. Fires
 *  once per document (watermark), telling the owner + Admin/DocCtrl (and anyone
 *  who had to acknowledge it) that the revision is now in force. */
export async function scanEffectiveDates(orgId: string): Promise<number> {
  // VFY-15: decided in this workspace's calendar (the watermark's too).
  const zone = await workspaceEffectiveDateTimeZone(supabase, orgId);
  const { data } = await supabase
    .from("documents")
    .select("id, library_id, collection_id, document_number, title, name, rev, effective_date, owner_user_id, owner_name, current_version_id")
    .eq("org_id", orgId)
    .not("effective_date", "is", null)
    .lte("effective_date", todayISO(zone))
    .is("effective_notified_at", null);
  const docs = (data ?? []) as Array<Record<string, unknown>>;
  if (!docs.length) return 0;

  // REV-13: the date on the document row is a denormalized copy of the
  // CURRENT version's. A revert, or any path that moved the pointer without
  // reconciling, can leave a withdrawn revision's future date behind — and
  // announcing it would tell the roster a pulled revision came into force.
  // Announce only when the current version itself carries that date; a
  // stale copy is watermarked (silenced) instead, never announced.
  const currentIds = docs.map((d) => d.current_version_id as string | null).filter((v): v is string => !!v);
  const versionDate = new Map<string, string | null>();
  if (currentIds.length) {
    const { data: vers, error: verErr } = await supabase
      .from("document_versions").select("id, effective_date").in("id", currentIds);
    if (verErr) throw new Error(`effective-date scan: current versions unreadable (${verErr.message}) — nothing announced`);
    for (const v of (vers ?? []) as Array<Record<string, unknown>>) {
      versionDate.set(v.id as string, (v.effective_date as string | null) ?? null);
    }
  }

  const controllers = await getOrgControllers(orgId);
  // DELIV-7 dw1 (notifications N14 integrator pass): what the last run lost
  const plan = await loadScanRetryPlan(orgId, "effective-dates", EFFECTIVE_RETRY_LOOKBACK_MS);
  let n = 0;
  for (const d of docs) {
    const docId = d.id as string;
    if (!belongsToCurrentVersion(d.effective_date as string | null, (d.current_version_id as string | null) ?? null, versionDate)) {
      const { error: quietErr } = await supabase.from("documents")
        .update({ effective_notified_at: new Date().toISOString() }).eq("id", docId).select("id");
      if (quietErr) console.error(`[effectiveDate] could not silence a stale effective date on ${docId}:`, quietErr.message);
      continue;
    }
    const label = (d.document_number as string) || (d.title as string) || (d.name as string) || "Document";
    const link = `/documents/${d.library_id as string}?doc=${docId}`;
    const owner = await effectiveOwnerForDocument({
      ownerUserId: (d.owner_user_id as string | null) ?? null, ownerName: (d.owner_name as string | null) ?? null,
      collectionId: (d.collection_id as string | null) ?? null, libraryId: d.library_id as string,
    });
    // Owner (or the controllers if unowned) + anyone still/already on the ack roster.
    const { data: ackRows } = await supabase.from("document_acknowledgments")
      .select("assignee_user_id").eq("document_id", docId).in("status", ["pending", "acknowledged"]);
    const ackUsers = ((ackRows ?? []) as Array<Record<string, unknown>>).map((r) => r.assignee_user_id as string);
    const targets = Array.from(new Set([...(owner.userId ? [owner.userId] : controllers), ...ackUsers].filter(Boolean)));
    // A document whose last run dead-lettered a notice tells only that recipient now.
    const retryKey = `effective-dates:${docId}`;
    const wants = plan.only(retryKey, null);
    const landed = await Promise.all(targets.filter((uid) => wants("effective_now", uid)).map((uid) =>
      notify({
        orgId, userId: uid, kind: "effective_now",
        title: `Now in effect: ${label}${d.rev ? ` Rev ${d.rev}` : ""}`,
        body: `This revision's effective date (${(d.effective_date as string).slice(0, 10)}) has arrived — it is now the in-force controlled copy.`,
        link, resourceType: "document", resourceId: docId,
      }, { retryKey })
    ));
    // DELIV-7 dw1: the one-shot watermark is set only when every notice
    // landed — a lost one is sent again on the next run, to its recipient only.
    if (landed.every(Boolean)) {
      await supabase.from("documents").update({ effective_notified_at: new Date().toISOString() }).eq("id", docId);
    }
    n++;
  }
  return n;
}

/** REV-13: does the document's denormalized effective date belong to the
 *  version now in force? Pure; exported for the scan's tests. A document
 *  with no current version, or whose current version carries a different
 *  (or no) effective date, is NOT announced. */
export function belongsToCurrentVersion(
  documentEffectiveDate: string | null,
  currentVersionId: string | null,
  versionDates: Map<string, string | null>,
): boolean {
  if (!documentEffectiveDate || !currentVersionId) return false;
  if (!versionDates.has(currentVersionId)) return false;
  const v = versionDates.get(currentVersionId) ?? null;
  return !!v && v.slice(0, 10) === documentEffectiveDate.slice(0, 10);
}
