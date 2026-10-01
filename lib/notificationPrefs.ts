// lib/notificationPrefs.ts
//
// ONE vocabulary for notification_preferences, and ONE email preference rule,
// for every reader (notifications Round G, N1 — GAP-203).
//
//   * DIGEST_FREQUENCIES is the digest_frequency CHECK list
//     (20260529_phase_b_notifications.sql:77-78) verbatim. The settings page
//     used to spell the default 'immediate', which the CHECK refuses, so the
//     first save of every member with no row failed (NEDGE-2 / DELIV-12).
//     A test parses the CHECK and pins this list to it.
//   * emailAllowedByPrefs / shouldSendForEvent are the email rule: the master
//     switch, the cadence ('never'), and the per-event toggle — none of which
//     stops a drawing recall or a PSM alert (PREFERENCE_EXEMPT_EVENT_TYPES).
//     email_gate() in 20261148 is the SAME rule evaluated where the
//     recipient's row is visible (DELIV-2); a test pins its CASE to
//     shouldSendForEvent and its exemption to this list. The compliance
//     digest is to import emailAllowedByPrefs rather than re-derive it
//     (NEDGE-9, N6); until it does, it reads only email_enabled.
//   * readToastPreference is the pop-up toast switch (RT-10) for the toast
//     listener. It fails OPEN: a toast is the ephemeral echo of a bell row that
//     is always written, so an unreadable preference shows toasts.

import { supabase } from "@/lib/supabase";

/** The digest_frequency CHECK list, in the constraint's order. */
export const DIGEST_FREQUENCIES = ["instant", "hourly", "daily", "never"] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

/** What the settings page offers. 'hourly' and 'daily' stay in the CHECK (a
 *  stored row keeps validating) but are not offered: nothing batches them —
 *  every reader treats them as 'instant' — so offering them advertised a
 *  feature that does not exist. */
export const OFFERED_DIGEST_FREQUENCIES = ["instant", "never"] as const satisfies readonly DigestFrequency[];
export type OfferedDigestFrequency = (typeof OFFERED_DIGEST_FREQUENCIES)[number];

export const DIGEST_LABELS: Record<DigestFrequency, string> = {
  instant: "Immediately",
  hourly: "Hourly",
  daily: "Daily",
  never: "Never",
};

/** The columns the settings page reads and writes. push_enabled is the push
 *  channel's (N10) and inapp_enabled is deprecated (20261148) — neither is
 *  written here, so an upsert never touches them. */
export interface NotificationPrefs {
  email_enabled: boolean;
  email_on_mention: boolean;
  email_on_assignment: boolean;
  email_on_status_change: boolean;
  email_on_watched_activity: boolean;
  email_on_sla_warning: boolean;
  toast_enabled: boolean;
  digest_frequency: DigestFrequency;
}

/** The column defaults: a member with no row behaves exactly like this. */
export const PREF_DEFAULTS: Readonly<NotificationPrefs> = Object.freeze({
  email_enabled: true,
  email_on_mention: true,
  email_on_assignment: true,
  email_on_status_change: true,
  email_on_watched_activity: true,
  email_on_sla_warning: true,
  toast_enabled: true,
  digest_frequency: "instant",
});

/** Whether the toast listener reads toast_enabled yet. The listener
 *  (components/providers/NotificationListener.tsx) belongs to N3; until it
 *  reads the preference (readToastPreference, or the column directly) the
 *  settings page does not offer a switch that would save and do nothing. A
 *  test flips with the listener: it fails when the listener mentions
 *  readToastPreference or toast_enabled and this is still false, and the
 *  reverse — whoever wires the listener flips this in the same change. */
export const TOAST_PREFERENCE_HONOURED = false;

/** A stored digest_frequency read into the CHECK vocabulary. 'immediate' was
 *  the page's old spelling (the CHECK refused it, so no row holds it — mapped
 *  anyway); anything outside the CHECK reads as the default. */
export function normalizeDigestFrequency(value: unknown): DigestFrequency {
  if (value === "immediate") return "instant";
  return (DIGEST_FREQUENCIES as readonly unknown[]).includes(value) ? (value as DigestFrequency) : "instant";
}

/** A stored row (or none) read into the page's shape. A column the row does
 *  not carry — a row that predates toast_enabled, or a database 20261148 has
 *  not reached — reads as its default. */
export function prefsFromRow(row: Record<string, unknown> | null | undefined): NotificationPrefs {
  const b = (k: keyof NotificationPrefs) => (row?.[k] === false ? false : true);
  return {
    email_enabled: b("email_enabled"),
    email_on_mention: b("email_on_mention"),
    email_on_assignment: b("email_on_assignment"),
    email_on_status_change: b("email_on_status_change"),
    email_on_watched_activity: b("email_on_watched_activity"),
    email_on_sla_warning: b("email_on_sla_warning"),
    toast_enabled: b("toast_enabled"),
    digest_frequency: normalizeDigestFrequency(row?.digest_frequency),
  };
}

/** Event types no preference may silence — no per-event toggle, not the
 *  master switch, not 'never': a drawing recall and a PSM alert
 *  (lib/notify/dispatch.ts categoryToEventType, DIST-13 / LIFE-7; "recall/
 *  safety categories are un-mutable regardless"). The 60-second dedupe still
 *  applies to them, and their bell row is always written. email_gate()
 *  (20261148) exempts the same list; a test pins the two equal. DEC-74
 *  §9. */
export const PREFERENCE_EXEMPT_EVENT_TYPES: readonly string[] = Object.freeze(["safety_recall", "safety_alert"]);

export function isPreferenceExempt(eventType: string): boolean {
  return PREFERENCE_EXEMPT_EVENT_TYPES.includes(eventType);
}

/** The per-event email toggle. An event type with no case — 'system', the
 *  compliance digest, and the preference-exempt recall / PSM alert — has no
 *  toggle. email_gate() (20261148) carries the same cases; a test pins the
 *  two equal. */
export function shouldSendForEvent(
  prefs: Record<string, unknown> | null,
  eventType: string
): boolean {
  if (!prefs) return true;
  switch (eventType) {
    case "comment_mention":           return prefs.email_on_mention !== false;
    case "assignment":
    case "engineer_review_requested": return prefs.email_on_assignment !== false;
    case "ticket_status_changed":
    case "ticket_approved":
    case "ticket_revision_requested":
    case "ticket_closed":             return prefs.email_on_status_change !== false;
    case "watcher_activity":          return prefs.email_on_watched_activity !== false;
    case "sla_warning":               return prefs.email_on_sla_warning !== false;
    default:                          return true;
  }
}

/** The whole email preference rule for one recipient's row (null = no row =
 *  the defaults): the master switch, the 'never' cadence, the per-event
 *  toggle. Exported once, for queueEmail's fallback and the digest (N6).
 *  A recall or a PSM alert passes all three (isPreferenceExempt): the plan's
 *  "un-mutable regardless". GAP-203 acceptance 2's stricter reading — the
 *  master switch stops every email, these included — is DEC-74 §9's
 *  item for the integrator to ratify. */
export function emailAllowedByPrefs(prefs: Record<string, unknown> | null, eventType: string): boolean {
  if (isPreferenceExempt(eventType)) return true;
  if (prefs?.email_enabled === false) return false;
  if (prefs?.digest_frequency === "never") return false;
  return shouldSendForEvent(prefs, eventType);
}

type PgError = { code?: string; message?: string } | null | undefined;

/** A column the API does not know: Postgres 42703 on a read, PostgREST
 *  PGRST204 on a write — the migration that adds it has not been applied. */
export function isMissingColumnError(err: PgError, column: string): boolean {
  if (!err) return false;
  const msg = err.message ?? "";
  return (err.code === "42703" || err.code === "PGRST204") && msg.includes(column);
}

/** A CHECK constraint refused the row (Postgres 23514). */
export function isCheckViolation(err: PgError): boolean {
  return !!err && err.code === "23514";
}

/** email_gate() is not deployed yet: PostgREST PGRST202 (not in the schema
 *  cache), or Postgres 42883 naming the function itself (a 42883 raised
 *  INSIDE a deployed body names something else and is a real failure). */
export function isMissingEmailGate(err: PgError): boolean {
  if (!err) return false;
  if (err.code === "PGRST202") return true;
  return err.code === "42883" && /email_gate/.test(err.message ?? "");
}

/** Whether this member wants pop-up toasts. Fails open — no row, a column
 *  20261148 has not added yet, or any read error all mean true. */
export async function readToastPreference(uid: string | null | undefined): Promise<boolean> {
  if (!uid) return true;
  try {
    const { data, error } = await supabase
      .from("notification_preferences")
      .select("toast_enabled")
      .eq("user_id", uid)
      .maybeSingle();
    if (error) {
      if (!isMissingColumnError(error, "toast_enabled")) {
        console.warn("toast preference unreadable; showing toasts:", error.message);
      }
      return true;
    }
    return (data as { toast_enabled?: unknown } | null)?.toast_enabled !== false;
  } catch (e) {
    console.warn("toast preference unreadable; showing toasts:", (e as Error).message);
    return true;
  }
}
