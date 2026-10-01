// lib/effectiveDate.ts
//
// Effective date — the date a controlled revision comes INTO FORCE, which may be
// later than its issue date (e.g. a procedure that takes effect after a training
// window). This is a date + badge + notification concept: the revision is still
// the current controlled version (which rev is served never changes here); it
// simply shows "Effective <date>" until the day arrives, then flips and the
// owner + acknowledgment assignees are told it's now in force.

import { supabase } from "@/lib/supabase";
import { notify } from "@/lib/inAppNotifications";
import { effectiveOwnerForDocument, getOrgControllers } from "@/lib/ownership";

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
// is late, by the facility's offset plus twelve hours at most (Houston: the
// badge flips at 07:00 instead of midnight). Late is the safe side of a
// procedure that must not be in force before the training. REV-9 stays open
// until every deployment names its zone (or an org / library zone setting
// lands, which changes effectiveDateTimeZone() and nothing else). Dates are
// compared as YYYY-MM-DD strings, never by parsing a bare datetime (which JS
// reads in the local zone).

/** The calendar used when the deployment names no (valid) facility zone:
 *  UTC-12. IANA spells it "Etc/GMT+12" — the POSIX sign is inverted, so
 *  this is twelve hours BEHIND UTC, the last place any date begins. */
export const EFFECTIVE_DATE_FALLBACK_TIME_ZONE = "Etc/GMT+12";

let warnedZone: string | null = null;

/** The calendar every effective-date decision is made in (REV-9): the
 *  deployment's facility zone, read at call time — the literal
 *  `process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE` reference is what Next
 *  inlines into the browser bundle, and the cron scan reads the same name
 *  on the server — else the latest calendar (UTC-12), which can only be
 *  late, never early. */
export function effectiveDateTimeZone(): string {
  const raw = (process.env.NEXT_PUBLIC_FACILITY_TIME_ZONE ?? "").trim();
  if (!raw) return EFFECTIVE_DATE_FALLBACK_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: raw });
    return raw;
  } catch {
    if (warnedZone !== raw) {
      warnedZone = raw;
      console.error(`[effectiveDate] NEXT_PUBLIC_FACILITY_TIME_ZONE="${raw}" is not a time zone this runtime knows — effective dates are decided in ${EFFECTIVE_DATE_FALLBACK_TIME_ZONE} (UTC-12: never early, up to a day late) until it is fixed.`);
    }
    return EFFECTIVE_DATE_FALLBACK_TIME_ZONE;
  }
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

const todayISO = () => effectiveTodayISO();

/** `none` = no future effective date (effective immediately / already in force);
 *  `pending` = a future effective date not yet reached; `effective` = the date
 *  has arrived/passed. Only `pending` warrants a badge. Decided in the
 *  effective-date calendar (REV-9), the same one the scan announces in. */
export function effectiveStatusFor(effectiveDate?: string | null, now: Date = new Date()): EffectiveStatus {
  if (!effectiveDate) return "none";
  const eff = isoDay(effectiveDate);
  if (!eff) return "none";
  return eff > effectiveTodayISO(now) ? "pending" : "effective";
}

/** Whole days until the effective date (negative = already effective), in
 *  the effective-date calendar (REV-9). */
export function daysUntilEffective(effectiveDate?: string | null, now: Date = new Date()): number | null {
  if (!effectiveDate) return null;
  const eff = isoDay(effectiveDate);
  if (!eff) return null;
  const toUtc = (day: string) => { const [y, m, d] = day.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUtc(eff) - toUtc(effectiveTodayISO(now))) / 86_400_000);
}

/** Persist an effective date onto a version + denormalize it onto the document.
 *  If the date is immediate (null / today / past) we pre-stamp the notify
 *  watermark so the "now in effect" notice never fires for it — only a genuinely
 *  FUTURE effective date gets announced when it arrives. */
export async function applyEffectiveDate(input: { documentId: string; versionId: string; effectiveDate: string | null }): Promise<void> {
  const eff = input.effectiveDate ? input.effectiveDate.slice(0, 10) : null;
  const suppress = !eff || eff <= todayISO();
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

/** Daily scan: announce revisions whose future effective date has arrived. Fires
 *  once per document (watermark), telling the owner + Admin/DocCtrl (and anyone
 *  who had to acknowledge it) that the revision is now in force. */
export async function scanEffectiveDates(orgId: string): Promise<number> {
  const { data } = await supabase
    .from("documents")
    .select("id, library_id, collection_id, document_number, title, name, rev, effective_date, owner_user_id, owner_name, current_version_id")
    .eq("org_id", orgId)
    .not("effective_date", "is", null)
    .lte("effective_date", todayISO())
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
    await Promise.all(targets.map((uid) =>
      notify({
        orgId, userId: uid, kind: "effective_now",
        title: `Now in effect: ${label}${d.rev ? ` Rev ${d.rev}` : ""}`,
        body: `This revision's effective date (${(d.effective_date as string).slice(0, 10)}) has arrived — it is now the in-force controlled copy.`,
        link, resourceType: "document", resourceId: docId,
      })
    ));
    await supabase.from("documents").update({ effective_notified_at: new Date().toISOString() }).eq("id", docId);
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
