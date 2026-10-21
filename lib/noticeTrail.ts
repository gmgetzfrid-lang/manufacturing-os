// lib/noticeTrail.ts
//
// drafting-flow EVID-9 done-when 4 and EVID-13 done-when 4 (notifications
// Round G, N18 DELIVERY RECORD; DEC-90 ruling (4)): ONE server function that
// answers "what reached this person about this item" across every channel
// and status — read-only.
//
// For one (workspace, person, item) it reads, on the caller's service-role
// client:
//   * the bell rows (notifications) — created; seen (read_at, the person's
//     own act — EVID-13); retired unopened by the workflow
//     (metadata.superseded_at, a mark — never a read);
//   * the email rows (email_notifications) — queued / retrying / failed /
//     handed to the provider (sent) / the provider's outcome (delivered,
//     delayed, bounced, complained, failed — 20261258) / not emailed by
//     their choice (not_emailed) / parked by an earlier build (suppressed);
//   * a request's notice record (ticket_notice_events, 20261255) — the
//     consent window's delivered / warned / objected / expired / advanced /
//     blocked events and its not_emailed rows (whether by their choice, never
//     the preference itself — a preference is theirs);
//   * the first act the person recorded on the item after the first notice
//     (audit_logs) — "acted on".
// Each entry carries one column per state, and the summary says what reached
// them, what they opened, and whether an email was never attempted.
//
// Works before and after every paste it reads: without 20261258 the email
// leg reads today's columns (42703 / PGRST204 — said in `notes`); without
// 20261255 the request leg is absent (42P01 / PGRST205 — said in `notes`). A leg that
// fails otherwise is reported unavailable, never shown as "nothing".
//
// WHO MAY ASK is the route's to decide (app/api/notifications/trail): the
// person themselves, or an Admin of the workspace. This module never writes.

import { isMissingSchemaError } from "@/lib/checkedWrite";

export type TrailChannel = "bell" | "email" | "request_record";

export type TrailState =
  | "unopened" | "opened" | "retired_unopened"
  | "queued" | "retrying" | "failed" | "sent" | "delivered" | "delayed" | "bounced" | "complained" | "provider_failed"
  | "not_emailed_by_choice" | "not_emailed" | "parked"
  | "delivered_in_app" | "warned" | "objected" | "expired" | "advanced" | "blocked" | "recorded";

export interface TrailEntry {
  channel: TrailChannel;
  id: string;
  createdAt: string | null;
  /** The bell kind, the email's event type, or the request record's kind. */
  kind: string | null;
  /** The bell title or the email subject (the request record has none). */
  title: string | null;
  state: TrailState;
  /** One column per state (null when it did not happen or is not known). */
  seenAt: string | null;
  supersededAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
  providerOutcome: string | null;
  providerDetail: string | null;
  attempts: number | null;
  /** Whether a not-emailed row was the person's own choice (null: not that row). */
  byTheirChoice: boolean | null;
  /** A request record's bell row (ticket_notice_events.notification_id); null otherwise. */
  notificationId: string | null;
}

export type LegState = "read" | "absent" | "unavailable";

export interface NoticeTrail {
  orgId: string;
  userId: string;
  resourceId: string;
  entries: TrailEntry[];
  summary: {
    toldInApp: number;
    opened: boolean;
    /** Email rows attempted for this item: queued, retrying, dead-lettered
     *  (failed), handed to the provider (sent) and every provider outcome,
     *  refusals included (bounced, provider_failed). Not a not-emailed record
     *  and not a row an earlier build parked. Says nothing about arrival. */
    emailAttempted: number;
    /** Email rows handed to the provider and not refused by it: sent,
     *  delivered, delayed, complained (a complaint means it arrived). Never a
     *  queued, retrying, dead-lettered, bounced or provider-failed row. */
    emailReached: number;
    /** The strongest email fact: delivered > sent > queued; null when none. */
    bestEmail: "delivered" | "sent" | "queued" | null;
    bounced: boolean;
    notEmailedByChoice: boolean;
    /** No email row and no decision about an email (a not-emailed record by
     *  their choice) for this item. A not-emailed record that was NOT their
     *  choice (e.g. no address on record) is no attempt: it still reads true. */
    emailNeverAttempted: boolean;
    /** The person's first recorded act on the item at or after the first notice. */
    actedAt: string | null;
    /** Told (a notice in the app, or an email that reached the provider and
     *  was not refused — `emailReached`), never opened, never acted on. An
     *  email that never left (queued, retrying, dead-lettered) or was refused
     *  (bounced, provider_failed) is not "told". */
    neverResponded: boolean;
  };
  legs: { bell: LegState; email: LegState; requestRecord: LegState; acted: LegState };
  notes: string[];
}

type Row = Record<string, unknown>;
type Res = { data?: unknown; error?: { message?: string; code?: string } | null };
type Q = PromiseLike<Res> & { eq: (c: string, v: unknown) => Q; gte: (c: string, v: unknown) => Q; order: (c: string, o: { ascending: boolean }) => Q; limit: (n: number) => Q };
type Client = { from: (t: string) => { select: (c: string) => Q } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most rows read per leg — a person's notices about ONE item. */
export const TRAIL_ROWS_PER_LEG = 200;

const EMAIL_BASE = "id, event_type, subject, status, attempt_count, sent_at, created_at, error_message";
const EMAIL_DELIVERY = "provider_message_id, delivery_status, delivery_detail, delivered_at, bounced_at, complained_at";

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function bellEntry(r: Row): TrailEntry {
  const meta = (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Row;
  const seenAt = str(r.read_at);
  const supersededAt = str(meta.superseded_at);
  return {
    channel: "bell", id: String(r.id), createdAt: str(r.created_at), kind: str(r.kind), title: str(r.title),
    state: seenAt ? "opened" : supersededAt ? "retired_unopened" : "unopened",
    seenAt, supersededAt, sentAt: null, deliveredAt: str(r.created_at), bouncedAt: null, complainedAt: null,
    providerOutcome: null, providerDetail: null, attempts: null, byTheirChoice: null, notificationId: null,
  };
}

function emailState(r: Row): TrailState {
  const status = str(r.status);
  if (status === "not_emailed") return "not_emailed_by_choice";
  if (status === "suppressed") return "parked";
  if (status === "queued" || status === "sending") return "queued";
  if (status === "failed") return Number(r.attempt_count ?? 0) >= 5 ? "failed" : "retrying";
  if (status === "sent") {
    const o = str(r.delivery_status);
    if (o === "delivered" || o === "delayed" || o === "bounced" || o === "complained") return o;
    if (o === "failed") return "provider_failed";
    return "sent";
  }
  return "queued";
}

function emailEntry(r: Row): TrailEntry {
  const status = str(r.status);
  return {
    channel: "email", id: String(r.id), createdAt: str(r.created_at), kind: str(r.event_type), title: str(r.subject),
    state: emailState(r),
    seenAt: null, supersededAt: null, sentAt: str(r.sent_at), deliveredAt: str(r.delivered_at),
    bouncedAt: str(r.bounced_at), complainedAt: str(r.complained_at),
    providerOutcome: str(r.delivery_status), providerDetail: str(r.delivery_detail) ?? (status === "failed" ? str(r.error_message) : null),
    attempts: typeof r.attempt_count === "number" ? r.attempt_count : null,
    byTheirChoice: status === "not_emailed" ? true : null,
    notificationId: null,
  };
}

const RECORD_STATES: Record<string, TrailState> = {
  delivered: "delivered_in_app", warned: "warned", objected: "objected", expired: "expired", advanced: "advanced", blocked: "blocked",
};

function requestEntry(r: Row): TrailEntry {
  const kind = str(r.kind);
  const details = (r.details && typeof r.details === "object" ? r.details : {}) as Row;
  const choice = kind === "not_emailed" ? details.byTheirChoice !== false : null;
  return {
    channel: "request_record", id: String(r.id), createdAt: str(r.created_at), kind, title: null,
    state: kind === "not_emailed" ? (choice ? "not_emailed_by_choice" : "not_emailed") : (kind && RECORD_STATES[kind]) || "recorded",
    seenAt: null, supersededAt: null, sentAt: null, deliveredAt: kind === "delivered" ? str(r.created_at) : null,
    bouncedAt: null, complainedAt: null, providerOutcome: null, providerDetail: null, attempts: null,
    // never the preference itself — only whether it was their choice
    byTheirChoice: choice,
    notificationId: str(r.notification_id),
  };
}

/** What reached `userId` about `resourceId` in `orgId`. Read-only; never throws. */
export async function noticeTrailFor(client: unknown, input: { orgId: string; userId: string; resourceId: string }): Promise<NoticeTrail> {
  const sb = client as Client;
  const { orgId, userId, resourceId } = input;
  const notes: string[] = [];
  const legs: NoticeTrail["legs"] = { bell: "read", email: "read", requestRecord: "read", acted: "read" };
  const entries: TrailEntry[] = [];
  const isUuid = UUID_RE.test(resourceId);

  const read = async (table: string, columns: string, filters: Array<[string, unknown]>): Promise<Res> => {
    try {
      let q = sb.from(table).select(columns);
      for (const [c, v] of filters) q = q.eq(c, v);
      return await q.order("created_at", { ascending: true }).limit(TRAIL_ROWS_PER_LEG);
    } catch (e) {
      return { data: null, error: { message: (e as Error)?.message || String(e) } };
    }
  };

  // 1) the bell
  const bell = await read("notifications", "id, kind, title, created_at, read_at, metadata", [["org_id", orgId], ["user_id", userId], ["resource_id", resourceId]]);
  if (bell.error) { legs.bell = "unavailable"; notes.push(`The in-app notices could not be read: ${bell.error.message ?? "error"}.`); }
  else for (const r of (bell.data as Row[] | null) ?? []) entries.push(bellEntry(r));

  // 2) email (its resource_id is a uuid column: another id matches no email row)
  if (!isUuid) {
    legs.email = "absent";
  } else {
    const filters: Array<[string, unknown]> = [["org_id", orgId], ["to_user_id", userId], ["resource_id", resourceId]];
    let mail = await read("email_notifications", `${EMAIL_BASE}, ${EMAIL_DELIVERY}`, filters);
    if (mail.error && isMissingSchemaError({ message: mail.error.message ?? "", code: mail.error.code })) {
      notes.push("The provider's delivery outcome is not recorded yet (migration 20261258 is not applied): emails show as queued, sent or failed only.");
      mail = await read("email_notifications", EMAIL_BASE, filters);
    }
    if (mail.error) { legs.email = "unavailable"; notes.push(`The emails could not be read: ${mail.error.message ?? "error"}.`); }
    else for (const r of (mail.data as Row[] | null) ?? []) entries.push(emailEntry(r));
  }

  // 3) a request's own notice record (20261255)
  if (!isUuid) {
    legs.requestRecord = "absent";
  } else {
    const rec = await read("ticket_notice_events", "id, kind, created_at, details, notification_id", [["org_id", orgId], ["recipient", userId], ["ticket_id", resourceId]]);
    if (rec.error && isMissingSchemaError({ message: rec.error.message ?? "", code: rec.error.code })) {
      legs.requestRecord = "absent";
      notes.push("The request's own notice record is not installed yet (migration 20261255 is not applied).");
    }
    else if (rec.error) { legs.requestRecord = "unavailable"; notes.push(`The request's notice record could not be read: ${rec.error.message ?? "error"}.`); }
    else for (const r of (rec.data as Row[] | null) ?? []) entries.push(requestEntry(r));
  }

  entries.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || a.channel.localeCompare(b.channel));

  // 4) acted on: the person's first recorded act on the item at or after the first notice
  let actedAt: string | null = null;
  const first = entries.find((e) => e.createdAt)?.createdAt ?? null;
  if (first) {
    try {
      const { data, error } = await sb.from("audit_logs").select("created_at")
        .eq("org_id", orgId).eq("user_id", userId).eq("resource_id", resourceId)
        .gte("created_at", first).order("created_at", { ascending: true }).limit(1);
      if (error) { legs.acted = "unavailable"; notes.push(`Whether they acted could not be read: ${error.message ?? "error"}.`); }
      else actedAt = str(((data as Row[] | null) ?? [])[0]?.created_at);
    } catch (e) {
      legs.acted = "unavailable";
      notes.push(`Whether they acted could not be read: ${(e as Error)?.message || String(e)}.`);
    }
  }

  const bells = entries.filter((e) => e.channel === "bell");
  const mails = entries.filter((e) => e.channel === "email");
  const sentish = mails.filter((m) => m.state !== "not_emailed_by_choice" && m.state !== "parked");
  // Reached: handed to the provider and not refused by it.
  const reached = mails.filter((m) => m.state === "sent" || m.state === "delivered" || m.state === "delayed" || m.state === "complained").length;
  const bestEmail = sentish.some((m) => m.state === "delivered") ? "delivered"
    : sentish.some((m) => m.state === "sent" || m.state === "delayed" || m.state === "complained") ? "sent"
      : sentish.some((m) => m.state === "queued" || m.state === "retrying") ? "queued" : null;
  const notEmailedByChoice = entries.some((e) => e.state === "not_emailed_by_choice");
  const opened = bells.some((b) => b.seenAt !== null);
  // A consent window's "delivered" event names the bell row it wrote
  // (20261255 open_consent_window): that notice is counted once, by its bell
  // row; a delivered event counts only when its bell row is not in the trail.
  const bellIds = new Set(bells.map((b) => b.id));
  const toldInApp = bells.length + entries.filter((e) => e.state === "delivered_in_app" && !(e.notificationId && bellIds.has(e.notificationId))).length;
  return {
    orgId, userId, resourceId, entries,
    summary: {
      toldInApp,
      opened,
      emailAttempted: sentish.length,
      emailReached: reached,
      bestEmail,
      bounced: mails.some((m) => m.state === "bounced"),
      notEmailedByChoice,
      emailNeverAttempted: legs.email === "read" && mails.length === 0 && !entries.some((e) => e.channel === "request_record" && e.kind === "not_emailed" && e.byTheirChoice === true),
      actedAt,
      neverResponded: (toldInApp > 0 || reached > 0) && !opened && actedAt === null && legs.acted === "read",
    },
    legs,
    notes,
  };
}
