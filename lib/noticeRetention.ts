// lib/noticeRetention.ts
//
// drafting-flow EVID-9 done-when 3 and EVID-13 done-when 3 (notifications
// Round G, N18 DELIVERY RECORD; DEC-90 ruling (3) — fail-safe): how long the
// purge keeps the facts of who was told what.
//
// A notice record — an email handed to the provider ('sent', with whatever
// the provider later reported), a "not emailed by their choice" row
// ('not_emailed'), and a read bell row that is itself part of a record (a
// compliance kind: an acknowledgment, a review, a recall, a retention or
// recertification notice — KIND_META's `compliance` flag — or a ticket
// workflow alert, which carries metadata.action) — is purge-eligible only
// once it is older than BOTH the purge's own window and the workspace's
// notice-record retention. So no row is ever kept a shorter time than today:
// the cutoff is the earlier of the two.
//
// The retention is the workspace's configured value (org_configurations key
// "notice_record_retention", data.days — a whole number of days, 1 to 36,500)
// or, with none configured, NOTICE_RECORD_RETENTION_DEFAULT_DAYS (five years —
// the PSM standard's retention for an incident investigation report, OSHA
// 1910.119(m)(7)). A setting that cannot be read is
// never guessed at: the record lines are not purged that run, and the purge
// says why.
//
// Server-safe; reads through the caller's client (the purge's service role).

import { KIND_META } from "@/lib/notificationKinds";

export const NOTICE_RECORD_RETENTION_KEY = "notice_record_retention";
export const NOTICE_RECORD_RETENTION_DEFAULT_DAYS = 1825;
export const NOTICE_RECORD_RETENTION_MAX_DAYS = 36500;

/** The bell kinds that are part of a record (KIND_META's compliance flag). */
export const RECORD_NOTICE_KINDS: readonly string[] = (Object.keys(KIND_META) as Array<keyof typeof KIND_META>)
  .filter((k) => KIND_META[k].compliance)
  .map(String)
  .sort();

export type NoticeRetention =
  | { days: number; source: "configured" | "default" }
  | { days: null; source: "unreadable"; error: string };

/** A configured value the purge may use: a whole number of days from 1 to
 *  NOTICE_RECORD_RETENTION_MAX_DAYS; anything else is null (the default). */
export function boundedRetentionDays(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= NOTICE_RECORD_RETENTION_MAX_DAYS ? n : null;
}

type ConfigRead = PromiseLike<{ data?: unknown; error?: { message?: string; code?: string } | null }>;
type ConfigClient = {
  from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => { limit: (n: number) => ConfigRead } } } };
};

/** The workspace's notice-record retention. Never throws. */
export async function noticeRecordRetention(client: unknown, orgId: string): Promise<NoticeRetention> {
  try {
    const { data, error } = await (client as ConfigClient)
      .from("org_configurations").select("data").eq("org_id", orgId).eq("key", NOTICE_RECORD_RETENTION_KEY).limit(1);
    if (error) return { days: null, source: "unreadable", error: error.message || error.code || "the setting could not be read" };
    const row = (Array.isArray(data) ? data[0] : null) as { data?: { days?: unknown } | null } | null;
    const days = boundedRetentionDays(row?.data?.days);
    return days === null ? { days: NOTICE_RECORD_RETENTION_DEFAULT_DAYS, source: "default" } : { days, source: "configured" };
  } catch (e) {
    return { days: null, source: "unreadable", error: (e as Error)?.message || String(e) };
  }
}

/** The earlier of the purge's cutoff and `days` before now — a record line
 *  never purges a row the window alone would have kept. */
export function recordCutoff(cutoffIso: string, days: number, nowMs: number = Date.now()): string {
  const retention = new Date(nowMs - days * 86400 * 1000).toISOString();
  return retention < cutoffIso ? retention : cutoffIso;
}
