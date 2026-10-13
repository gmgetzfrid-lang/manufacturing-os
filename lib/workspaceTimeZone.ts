// lib/workspaceTimeZone.ts
//
// notifications NEDGE-19 / public-surfaces VFY-15 (admin-and-org Round G,
// P8): the workspace's IANA time zone, set by an Admin on /admin/settings.
// Stored as org_configurations key "timezone", data { timeZone } — the shape
// lib/recordTime.ts orgTimeZone already reads, so every server-composed
// notification and email body is written in it from the moment it is saved
// (no change in recordTime's callers). The compliance digest's SEND time
// stays the one daily UTC run (vercel.json "0 3 * * *" — no cron entry per
// zone); its body and its window are labelled in this zone (DEC-90 ruling
// for this package, recorded on NEDGE-19).
//
// Writes are checked: the row read back is the success, a write RLS refused
// (20261203 makes the key an Admin's) is a refusal — never "Saved" over
// nothing — and every change is audited (WORKSPACE_TIMEZONE_CHANGED, before
// and after), with a refused audit row said, not swallowed.

import { isValidTimeZone } from "@/lib/recordTime";
import { logAuditAction } from "@/lib/audit";
import { checkedWrite } from "@/lib/checkedWrite";

export const WORKSPACE_TIMEZONE_KEY = "timezone";

/** The IANA zones this runtime knows, for the picker. Falls back to a short
 *  list where Intl.supportedValuesOf is missing. */
export function knownTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    const all = intl.supportedValuesOf?.("timeZone");
    if (Array.isArray(all) && all.length > 0) return all.includes("UTC") ? all : ["UTC", ...all];
  } catch { /* fall through */ }
  return ["UTC", "America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles", "Europe/London", "Australia/Perth"];
}

/** The picker's options: every zone this runtime lists except UTC (the
 *  "Not set" option stands for it), with the STORED zone first when the
 *  list omits it — a stored "UTC", an alias (US/Central), a zone this browser's ICU names
 *  differently (Asia/Calcutta for Asia/Kolkata), or a value this browser
 *  does not know at all. The select must show what the database holds,
 *  never "Not set" over a stored zone (fix pass 3). */
export function timeZoneOptions(zones: string[], stored: string | null): Array<{ value: string; label: string }> {
  const listed = zones.filter((z) => z !== "UTC").map((z) => ({ value: z, label: z }));
  if (!stored || listed.some((o) => o.value === stored)) return listed;
  const label = isValidTimeZone(stored) ? `${stored} (stored)` : `${stored} (stored — not a zone this browser knows)`;
  return [{ value: stored, label }, ...listed];
}

type Sb = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export type TimeZoneRead = { ok: true; timeZone: string | null; stored: string | null } | { ok: false; error: string };

/** The stored zone (null = none set: bodies read UTC). A read error is said.
 *  `timeZone` is the stored zone when this runtime accepts it (what
 *  orgTimeZone writes bodies in); `stored` is the value exactly as read,
 *  valid or not — what the picker shows and an audit row's "before" names
 *  (an audit row never states a value it did not read). */
export async function readWorkspaceTimeZone(sb: Sb, orgId: string): Promise<TimeZoneRead> {
  try {
    const { data, error } = await sb.from("org_configurations").select("data").eq("org_id", orgId).eq("key", WORKSPACE_TIMEZONE_KEY).maybeSingle();
    if (error) return { ok: false, error: error.message ?? "the workspace time zone could not be read" };
    const raw = (data as { data?: { timeZone?: unknown } } | null)?.data?.timeZone ?? null;
    const stored = raw === null ? null : typeof raw === "string" ? raw : JSON.stringify(raw);
    return { ok: true, timeZone: typeof raw === "string" && isValidTimeZone(raw) ? raw : null, stored };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

export type TimeZoneSave =
  | { ok: true; timeZone: string | null; auditError: string | null }
  | { ok: false; error: string };

/** Set (an IANA zone) or clear (null → UTC) the workspace zone. */
export async function saveWorkspaceTimeZone(
  sb: Sb,
  input: { orgId: string; timeZone: string | null; before: string | null; actorId: string; actorEmail?: string | null; actorRole?: string | null },
): Promise<TimeZoneSave> {
  const tz = input.timeZone && input.timeZone.trim() ? input.timeZone.trim() : null;
  if (tz !== null && !isValidTimeZone(tz)) return { ok: false, error: `"${tz}" is not a time zone this browser knows (an IANA name such as America/Chicago).` };
  const res = tz === null
    ? await checkedWrite(sb.from("org_configurations").delete().eq("org_id", input.orgId).eq("key", WORKSPACE_TIMEZONE_KEY).select("id"))
    : await checkedWrite(sb.from("org_configurations").upsert(
        { org_id: input.orgId, key: WORKSPACE_TIMEZONE_KEY, data: { timeZone: tz }, updated_at: new Date().toISOString() },
        { onConflict: "org_id,key" },
      ).select("id"));
  // Clearing a zone that was never set deletes nothing — that is not a refusal.
  if (!res.ok && !(tz === null && input.before === null && res.code === "refused")) {
    return { ok: false, error: res.code === "refused" ? "the database saved nothing — only an Admin can set the workspace time zone." : res.error };
  }
  const audit = await logAuditAction({
    action: "WORKSPACE_TIMEZONE_CHANGED", resourceType: "org", resourceId: input.orgId, orgId: input.orgId,
    userId: input.actorId, userEmail: input.actorEmail ?? undefined, userRole: input.actorRole ?? undefined,
    details: { before: input.before, after: tz },
  });
  return { ok: true, timeZone: tz, auditError: audit.ok ? null : (audit.error ?? "audit insert refused") };
}
