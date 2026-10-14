// lib/exportAlerts.ts — SERVER-ONLY.
//
// The bell notification that tells a workspace's controllers its data left,
// or that a new way for it to leave was set up (admin-and-org BKP-13).
//
// The manual export route raised one before this file; the nightly scheduled
// push raised none, and creating or enabling a destination raised none, so a
// webhook destination was an unannounced daily channel. Every route that
// takes the workspace out calls alertAdminsOfExport: the JSON export
// (`structured`, also the first step of the browser-built Full ZIP), the
// manual run (download or destination) and the scheduled push. Every
// destination write that opens or moves a channel calls
// alertAdminsOfDestination: create, enable, and re-pointing an enabled one.
// Deleting a destination closes a channel and testing one sends a probe, not
// the workspace; neither alerts (both write their own audit row or none, as
// before).
//
// Who is told: every active Admin and DocCtrl (by the full role collection).
// The data-export page is Admin-only (BKP-8), so an Admin's bell links there
// and says what to do on it; a DocCtrl's says to ask an Admin and links the
// audit log, which DocCtrl can read.
//
// The write is CHECKED: a refused insert comes back as `{ ok: false, error }`
// for the caller to record (the run's diagnostics, the response), never a
// silent success. A failed alert never blocks the export or the destination
// write it announces: it is detection, not prevention, and the act it
// reports has already happened when it is sent.
//
// It is the typed sink's batch insert (notifications TAX-11, N8's review
// fix): `notifyBatchWithReason` on the service-role client — ONE statement
// for every controller, the kind checked by the compiler, the refusal's text
// answered for the caller to record, and `notified` the rows the database
// says it wrote.

import type { SupabaseClient } from "@supabase/supabase-js";
import { roleFilter, memberHoldsAny } from "@/lib/roleHeld";
import { adminSurface } from "@/lib/adminSurfaces";
import { notifyBatchWithReason } from "@/lib/inAppNotifications";

export interface ExportAlertResult {
  ok: boolean;
  /** How many controllers were told. */
  notified: number;
  error?: string;
}

/** Where each audience's bell links: the data-export page is Admin-only. */
export const ALERT_LINKS = { admin: "/admin/data-export", other: "/admin/audit" } as const;

async function alertControllers(
  admin: SupabaseClient,
  orgId: string,
  exceptUserId: string | null,
  row: {
    title: string;
    /** The body for a recipient who holds Admin (`forAdmin`) or only DocCtrl. */
    body: (forAdmin: boolean) => string;
    actorUserId: string | null; actorName: string; metadata: Record<string, unknown>;
  },
): Promise<ExportAlertResult> {
  const { data: members, error: readErr } = await admin
    .from("org_members")
    .select("uid, role, roles")
    .eq("org_id", orgId)
    .eq("status", "active")
    // Who is told: the controller tier, by the FULL role collection.
    .or(roleFilter(["Admin", "DocCtrl"]));
  if (readErr) return { ok: false, notified: 0, error: `could not read who to alert (${readErr.message})` };
  const recipients = new Map<string, boolean>();
  for (const m of (Array.isArray(members) ? members as Array<{ uid?: string | null; role?: unknown; roles?: unknown }> : [])) {
    if (!m.uid || m.uid === exceptUserId) continue;
    recipients.set(m.uid, (recipients.get(m.uid) ?? false) || memberHoldsAny(m, ["Admin"]));
  }
  if (recipients.size === 0) return { ok: true, notified: 0 };
  const { landed, error } = await notifyBatchWithReason(
    [...recipients].map(([uid, isAdmin]) => ({
      orgId,
      userId: uid,
      kind: "security_export" as const,
      title: row.title,
      body: row.body(isAdmin),
      link: isAdmin ? ALERT_LINKS.admin : ALERT_LINKS.other,
      resourceType: "export",
      actorUserId: row.actorUserId ?? undefined,
      actorName: row.actorName,
      metadata: row.metadata,
    })),
    admin,
  );
  if (error) return { ok: false, notified: 0, error: `the alert could not be written (${error})` };
  return { ok: true, notified: landed };
}

/** A full workspace export ran. A person's export tells every OTHER
 *  controller; a scheduled push (no person: `actorUserId` null) tells every
 *  controller, naming the destination and who last configured it.
 *
 *  DEC-87 §1: a scheduled push whose last configurer does not hold
 *  the data-export surface's entry role (a destination a Manager or DocCtrl
 *  set up before the surface became Admin-only) still runs — a nightly
 *  backup does not stop on deploy — and `scheduled.unconfirmed` turns that
 *  night's bell into the request: it names who last confirmed it and asks
 *  every Admin to open it and save it to confirm it, or disable it (a
 *  DocCtrl, to ask an Admin to). It rings every night until an Admin saves
 *  the destination (which stamps updated_by). */
export async function alertAdminsOfExport(
  admin: SupabaseClient,
  info: {
    orgId: string;
    actorUserId: string | null;
    actorEmail: string;
    destination: string;
    /** A scheduled push: the destination's name and its last configurer's
     *  uid; `unconfirmed` when that configurer does not hold the surface's
     *  entry role (`by`: their email, else their uid; `holds`: the role(s)
     *  it takes, e.g. "Admin"). `failed`: an unconfirmed destination's
     *  night in the bounded grace whose push FAILED (its error) — the bell
     *  still rings, because every night of the grace and the pause are said
     *  (DEC-87 §1, amended). It says nothing left only when the push failed
     *  before the archive was sent; `failedAfterSend` (P14 fix pass) when
     *  its transmission to the destination had begun (a webhook that
     *  answered 500 after receiving it, a bucket put that failed after the
     *  bytes went), and then it says the destination may hold the archive.
     *  `pausedNotice` (P14 fix pass): a PAUSED night announcing the pause,
     *  because the bell of the night that paused it could not be sent —
     *  nothing left tonight; `unsure` (P14 integrator fix) when the record
     *  cannot say whether that bell was sent (its run never closed and holds
     *  no `alert:sent`), and then the bell says it MAY not have been sent,
     *  never that it failed. */
    scheduled?: {
      destinationName: string; configuredBy: string | null; unconfirmed?: { by: string; holds: string }; grace?: UnconfirmedGrace;
      failed?: string; failedAfterSend?: boolean; pausedNotice?: { of: number; unsure?: boolean };
    };
  },
): Promise<ExportAlertResult> {
  const when = new Date().toISOString();
  const unconfirmed = info.scheduled?.unconfirmed;
  // DEC-87 §1 as amended under DEC-90 (admin-and-org Round G, P14): the
  // night's place in the bounded grace, said in every Admin's bell.
  const grace = unconfirmed ? info.scheduled?.grace : undefined;
  // P14 fix pass: a paused night that announces the pause (the pausing night's bell was refused).
  const pausedNotice = unconfirmed ? info.scheduled?.pausedNotice : undefined;
  const graceText = pausedNotice ? ` ${pauseAnnouncedLateSentence(pausedNotice.of, pausedNotice.unsure === true)}` : grace ? ` ${graceSentence(grace)}` : "";
  // P14: a failed night of the grace is a bell too (only an unconfirmed
  // destination's grace night passes it). It says nothing left only when the
  // push failed before the archive was sent (P14 fix pass: a webhook that
  // answers 500 has already received the whole ZIP).
  const failed = unconfirmed && grace && !pausedNotice ? info.scheduled?.failed : undefined;
  const failedAfterSend = failed !== undefined && info.scheduled?.failedAfterSend === true;
  const failure = failed !== undefined ? failed.slice(0, 200) || "no error given" : "";
  const what = info.scheduled
    ? (pausedNotice
      ? `A scheduled export to "${info.scheduled.destinationName}" (${info.destination}) was skipped tonight, so nothing left the workspace.`
      : failed !== undefined
        ? (failedAfterSend
          ? `A scheduled export to "${info.scheduled.destinationName}" (${info.destination}) failed tonight after the archive's transmission to it began, so the destination may hold the entire workspace (${failure}).`
          : `A scheduled export to "${info.scheduled.destinationName}" (${info.destination}) failed tonight before the archive was sent, so nothing left the workspace (${failure}).`)
        : `A scheduled export pushed the entire workspace to "${info.scheduled.destinationName}" (${info.destination}).`)
    : `${info.actorEmail} exported the entire workspace (${info.destination}).`;
  const body = (forAdmin: boolean) => unconfirmed
    ? `${what} ${unconfirmedSentence(unconfirmed)} ${forAdmin
      ? "Open it under Admin → Data export and save it to confirm it, or disable it."
      : "Ask an Admin to open it under Admin → Data export and save it to confirm it, or disable it. The run is recorded in the audit log."}${graceText}`
    : info.scheduled
      ? `${what} If you don't recognise this destination, ${forAdmin
        ? "disable it under Admin → Data export."
        : "ask an Admin to disable it under Admin → Data export. The run is recorded in the audit log."}`
      : `${what} If this wasn't expected, ${forAdmin
        ? "review the account immediately."
        : "tell an Admin now so they can review the account. The export is recorded in the audit log."}`;
  return alertControllers(admin, info.orgId, info.actorUserId, {
    title: unconfirmed
      ? (grace?.pausing || pausedNotice ? "Scheduled export paused until an Admin confirms it" : "Scheduled export needs an Admin to confirm it")
      : info.scheduled ? "Scheduled workspace export ran" : "Full workspace export was run",
    body,
    actorUserId: info.actorUserId,
    actorName: info.actorEmail,
    metadata: {
      destination: info.destination, at: when,
      ...(info.scheduled ? { scheduled: true, destinationName: info.scheduled.destinationName, configuredBy: info.scheduled.configuredBy } : {}),
      ...(unconfirmed ? { unconfirmed: { by: unconfirmed.by, holds: unconfirmed.holds } } : {}),
      ...(grace ? { grace: { night: grace.night, of: grace.of, pausing: grace.pausing } } : {}),
      ...(failed !== undefined ? { failed: true, ...(failedAfterSend ? { failedAfterSend: true } : {}) } : {}),
      ...(pausedNotice ? { paused: { of: pausedNotice.of, announcedLate: true, ...(pausedNotice.unsure ? { earlierBellUnsure: true } : {}) } } : {}),
    },
  });
}

// ── DEC-87 §1, the bounded grace (amended 2026-10-13 under DEC-90; built by
// admin-and-org Round G, P14 — intelligence IEDGE-10 / DACL-7) ─────────────
// A destination a Manager or DocCtrl configured before the data-export
// surface became Admin-only, which no Admin has confirmed since, still runs —
// but no longer indefinitely. Each such scheduled push is an unconfirmed
// NIGHT, counted on its run row (diagnostics step GRACE_NIGHT_STEP, detail
// `night=<n>/<of>`); nights 1 to UNCONFIRMED_GRACE_NIGHTS run and every
// Admin's bell names the night (a night whose push FAILED rings it too —
// `scheduled.failed` — saying nothing left only when it failed before the
// archive was sent, else that the destination may hold it); the last night's
// push is followed by a pause (its bell says so, whether it left or failed);
// from the next night the sweep skips it with a cancelled run row
// (GRACE_PAUSED_STEP) and no bell, until an Admin opens it and saves it
// (which stamps updated_by: confirmed — it runs as any other destination) or
// disables it. P14 fix pass: if the pausing night's bell was refused
// (alert:unsent), the next paused night rings it (checked) and records
// GRACE_PAUSE_ANNOUNCED_STEP, so the pause is announced once; every paused
// night after carries that step forward. P14 integrator fix (DEC-90): the
// night that pauses it records ALERT_SENT_STEP on its run row the moment its
// bell is delivered, before the close (a checked write), so a pausing night
// whose closing write is refused (its row left "running") is still read as
// announced and no second pause bell rings; a row that never closed and holds
// no such marker is read as UNSURE (the bell may have rung, then the marker
// and the close were both refused, or the push was killed first), and the
// late bell then says the earlier one may not have been sent, never that it
// failed. The count reads only rows this rule wrote, so
// the night the change deploys is night 1 for every such destination, never
// the night a backup stops. A run the gate skipped for another reason
// (cancelled, no grace step) neither counts nor breaks the count; any other
// run (a confirmed push, a run from before this rule) ends it.
// P14 review fix: a night whose confirmation could not be VERIFIED (the
// configurer's role read failed) never ends the grace. The sweep still reads
// the count: a paused destination stays paused (skipped as on any paused
// night); otherwise it runs (a backup is never stopped on a guess) and its run
// row carries GRACE_UNVERIFIED_STEP, which neither counts nor breaks the count
// — so the next readable night continues it, never restarting at night 1. The
// count reads the destination's run rows page by page (keyset, newest first)
// until a deciding row: a pause is never forgotten behind a long run of gate
// skips or unverified nights.
// P14 fix pass: a count that cannot be read never pushes from a paused
// destination either — the sweep falls back on the destination row in hand:
// one whose card says its last scheduled run was paused, or was the night
// that paused it (pausedAtLastRun), stays paused. And on a night whose
// confirmation cannot be verified, a destination SAVED since its pause (only
// an Admin can save one, and only a save stamps updated_at — savedSince) is
// not held paused on that guess: it runs uncounted (grace:unverified).

/** DEC-87 §1 (amended): consecutive unconfirmed nightly runs before a pause. */
export const UNCONFIRMED_GRACE_NIGHTS = 7;
/** The run row's diagnostics step for an unconfirmed night (`night=<n>/<of>`, `n` "?" when unread). */
export const GRACE_NIGHT_STEP = "grace:unconfirmed-night";
/** The run row's diagnostics step for a night the destination stayed paused. */
export const GRACE_PAUSED_STEP = "grace:paused";
/** The run row's diagnostics step for a night whose confirmation could not be
 *  verified (P14 review fix): it neither counts nor breaks the grace's count. */
export const GRACE_UNVERIFIED_STEP = "grace:unverified";
/** Run rows read per page by the grace's count. */
export const GRACE_COUNT_PAGE = 100;
/** P14 fix pass: the paused run row's step saying the pause was announced —
 *  tonight (the pausing night's bell had been refused) or at an earlier run. */
export const GRACE_PAUSE_ANNOUNCED_STEP = "grace:paused-announced";
/** The run row's step for a bell that could not be sent (as the sweep writes it). */
export const ALERT_UNSENT_STEP = "alert:unsent";
/** P14 integrator fix (DEC-90): the pausing night's run row step written the
 *  moment its bell is delivered, before the run closes (a checked write). */
export const ALERT_SENT_STEP = "alert:sent";
/** P14 integrator fix: on a paused row whose late announcement was refused
 *  (ALERT_UNSENT_STEP), that the pausing night's own bell was UNSURE — so the
 *  next try still says it may not have been sent, never that it failed. */
export const PAUSE_BELL_UNSURE_STEP = "grace:pause-bell-unsure";
/** The paused row's announcement detail when the pause was announced before tonight. */
export const PAUSE_ANNOUNCED_EARLIER = "the pause was announced at an earlier run";

export interface UnconfirmedGrace {
  /** Tonight's unconfirmed night (1-based), or null when the count could not be read (it runs). */
  night: number | null;
  of: number;
  /** Tonight is the last night: it runs, and is paused from the next night. */
  pausing: boolean;
}

/** A paused destination's place in the grace (P14 fix pass): `since` is the
 *  started_at of the row that decided the pause (the newest paused night, or
 *  the night that paused it); `announced` is false only when the pause's
 *  last bell is recorded as not sent (alert:unsent), or the pausing night
 *  never closed and holds no ALERT_SENT_STEP (P14 integrator fix). `unsure`
 *  (only with `announced: false`): the record cannot say whether that bell
 *  was sent — the pausing night never closed and holds no marker (or a late
 *  announcement of such a night was itself refused). */
export interface GracePaused {
  paused: true;
  since: string | null;
  announced: boolean;
  unsure?: true;
}

/** The words graceSentence uses for the night that pauses it — also how a
 *  card in hand says its last run paused it (pausedAtLastRun). */
const PAUSING_MARK = "so it is now PAUSED";
/** P14 integrator fix: the words a card keeps when a gate skip or a refused
 *  run-row open rewrites a paused card (PAUSE_KEPT_SENTENCE) — read by
 *  pausedAtLastRun as the PAUSING_MARK is. */
const PAUSE_KEPT_MARK = "so it is still PAUSED";
/** The first word of every paused night's note (PAUSED_LEAD). */
const PAUSED_WORD = "Paused:";

/** What the bell, run row and card say about tonight's place in the grace. */
export function graceSentence(g: UnconfirmedGrace): string {
  if (g.night === null) {
    return `It runs tonight; how many unconfirmed nights it has had could not be read, so the count resumes at the next run (it is paused after ${g.of} unconfirmed nights).`;
  }
  return g.pausing
    ? `This was unconfirmed night ${g.night} of ${g.of}, ${PAUSING_MARK}: no scheduled push leaves until an Admin opens it and saves it to confirm it (or disables it).`
    : `This is unconfirmed night ${g.night} of ${g.of}: unless an Admin confirms it, it is paused after night ${g.of}'s push.`;
}

/** The run row's diagnostics entry for tonight's unconfirmed night. */
export function graceNightStep(g: UnconfirmedGrace, ts: string): { ts: string; step: string; detail: string } {
  return { ts, step: GRACE_NIGHT_STEP, detail: `night=${g.night ?? "?"}/${g.of}` };
}

/** The run row's diagnostics entry for a night whose confirmation could not
 *  be verified (P14 review fix) — neutral in the grace's count. */
export function graceUnverifiedStep(ts: string): { ts: string; step: string; detail: string } {
  return { ts, step: GRACE_UNVERIFIED_STEP, detail: "whether the destination is confirmed could not be verified tonight; this night neither counts nor breaks its unconfirmed-night count" };
}

const PAUSED_LEAD = (of: number) =>
  `${PAUSED_WORD} no Admin has confirmed this destination after ${of} unconfirmed nightly pushes, so no scheduled push leaves until an Admin opens it under Admin → Data export and saves it to confirm it (or disables it).`;

/** What a paused night's run row, card and sweep result say. */
export function pausedNote(u: { by: string; holds: string }, of = UNCONFIRMED_GRACE_NIGHTS): string {
  return `${PAUSED_LEAD(of)} ${unconfirmedSentence(u)}`;
}

/** P14 review fix: what a paused destination's run row, card and sweep
 *  result say on a night its confirmation could not be verified — it stays
 *  paused (an unverifiable read never ends the pause; only an Admin's save
 *  does — P14 fix pass: a destination saved since its pause runs uncounted
 *  on such a night instead, SAVED_SINCE_PAUSE_NOTE). */
export function pausedUnverifiedNote(reason: string, of = UNCONFIRMED_GRACE_NIGHTS): string {
  const entry = adminSurface("data-export")?.entry ?? ["Admin"];
  const holds = entry === "*" ? "the data-export role" : entry.join(" or ");
  return `${PAUSED_LEAD(of)} Whether the member who last configured it holds ${holds} could not be verified tonight (${reason}), so it stays paused; this is checked again at the next run.`;
}

/** P14 fix pass: what a paused night's bell says when it announces the
 *  pause the pausing night's bell could not. P14 integrator fix: `unsure`
 *  when the record cannot say whether that bell was sent — it then says it
 *  MAY not have been sent, never that it failed. */
export function pauseAnnouncedLateSentence(of = UNCONFIRMED_GRACE_NIGHTS, unsure = false): string {
  return `It was paused after ${of} unconfirmed nightly pushes: no scheduled push leaves until an Admin opens it and saves it to confirm it (or disables it). The bell that should have said so at its last push ${earlierBellFate(unsure)}.`;
}

/** P14 integrator fix: how the late announcement names the pausing night's bell. */
export function earlierBellFate(unsure: boolean): string {
  return unsure ? "may not have been sent" : "could not be sent";
}

/** P14 fix pass: what a paused night's note adds when the count could not be
 *  read and the destination row in hand says its last scheduled run paused it. */
export function pausedCountUnreadSentence(reason: string): string {
  return `How many unconfirmed nights it has had could not be read tonight (${reason}); its last scheduled run left it paused, so it stays paused (checked again at the next run).`;
}

/** P14 fix pass: the note of an unverified night that runs because the
 *  destination was saved since its pause. */
export const SAVED_SINCE_PAUSE_NOTE =
  "it was paused, and it has been saved since (only an Admin can save a destination), so tonight it runs, uncounted; whether it is confirmed is checked again at the next run";

/** P14 fix pass (DEC-87 §1): the destination row in hand says its last
 *  scheduled run left it paused — a paused night's card (`skipped: Paused:`)
 *  or the card of the night that paused it. The sweep's fallback when the
 *  run-row count cannot be read, so an unreadable count never pushes from a
 *  paused destination. P14 integrator fix: also a card a gate skip or a
 *  refused run-row open rewrote with the pause kept (PAUSE_KEPT_SENTENCE). */
export function pausedAtLastRun(dest: { last_run_error?: unknown }): boolean {
  const e = dest.last_run_error;
  return typeof e === "string" && (e.startsWith(`skipped: ${PAUSED_WORD}`) || e.includes(PAUSING_MARK) || e.includes(PAUSE_KEPT_MARK));
}

/** P14 integrator fix (DEC-90 — a paused destination stays paused until an
 *  Admin saves it): the sentence a card keeps when a night that does not run
 *  the push (a gate skip, a refused run-row open) rewrites a card that said
 *  the destination was paused, so the fallback above still holds on the next
 *  night whose count cannot be read. */
export const PAUSE_KEPT_SENTENCE =
  `Its last scheduled run left it paused and no Admin has saved it since, ${PAUSE_KEPT_MARK}: no scheduled push leaves until an Admin opens it under Admin → Data export and saves it to confirm it (or disables it).`;

/** P14 integrator fix: does the card in hand carry a pause that tonight's
 *  rewrite must keep? It said paused (pausedAtLastRun), and no Admin has
 *  saved the destination since that card's run (savedSince — only an Admin's
 *  save stamps updated_at; a save ends the pause). */
export function pauseToKeep(dest: { last_run_error?: unknown; updated_at?: unknown; last_run_at?: unknown }): boolean {
  return pausedAtLastRun(dest) && !savedSince(dest.updated_at, dest.last_run_at);
}

/** P14 integrator fix: `text` with the pause kept — cut so the kept sentence
 *  survives the card's `max` characters, as the unconfirmed note is. */
export function withPauseKept(text: string, max = 500): string {
  return `${text.slice(0, Math.max(0, max - PAUSE_KEPT_SENTENCE.length - 1))} ${PAUSE_KEPT_SENTENCE}`.slice(0, max);
}

/** P14 fix pass: was the destination saved after `since`? Only an Admin can
 *  save one (the data-export surface is Admin-only since P3), and only a save
 *  stamps updated_at (PATCH /api/data-export/destinations/[id]; no trigger,
 *  and the sweep never writes it). An unreadable time answers no. */
export function savedSince(updatedAt: unknown, since: unknown): boolean {
  if (typeof updatedAt !== "string" || typeof since !== "string") return false;
  const u = Date.parse(updatedAt);
  const s = Date.parse(since);
  return Number.isFinite(u) && Number.isFinite(s) && u > s;
}

/** The keyset condition for the run rows after (started_at, id), newest
 *  first. Values are double-quoted — a timestamp carries '.', ':' and '+'. */
function afterRunCursor(c: { at: string; id: string }): string {
  const v = (x: string) => `"${x.replace(/["\\]/g, (ch) => `\\${ch}`)}"`;
  return `started_at.lt.${v(c.at)},and(started_at.eq.${v(c.at)},id.lt.${v(c.id)})`;
}

/** Tonight's place in the grace for an unconfirmed destination, read from
 *  its scheduled run rows (newest first, a page at a time — keyset on
 *  (started_at, id) — until a deciding row). `paused` when the previous
 *  counted night was the last one, or a paused night; otherwise tonight's
 *  night. A read that fails answers `night: null` — the push runs (a backup
 *  is never stopped on a guess) and says the count could not be read; the
 *  sweep then falls back on the destination row in hand (pausedAtLastRun),
 *  so a paused destination stays paused (P14 fix pass).
 *  Neutral rows (a gate skip, an unread count, an unverified night) are paged
 *  past, never taken as the end of the history (P14 review fix: a fixed
 *  window of 28 rows forgot a pause behind 28 gate skips).
 *  P14 fix pass: a pause answers `since` (the deciding row's started_at) and
 *  `announced`. Paused rows that say nothing of the announcement (an
 *  unverified or unread night's) are read past to the row that does: a
 *  paused row's GRACE_PAUSE_ANNOUNCED_STEP (announced) or ALERT_UNSENT_STEP
 *  (its re-announcement was refused), else the night that paused it (its
 *  bell refused — alert:unsent — or, P14 integrator fix, a row that never
 *  closed and holds no ALERT_SENT_STEP: `unsure`, the bell may or may not
 *  have rung; one that holds it is announced, closed or not). A read that
 *  fails once the pause is found still answers the pause, as announced (no
 *  bell on a guess). */
export async function unconfirmedGraceTonight(
  sb: Pick<SupabaseClient, "from">,
  destinationId: string,
  of = UNCONFIRMED_GRACE_NIGHTS,
  pageSize = GRACE_COUNT_PAGE,
): Promise<GracePaused | ({ paused: false } & UnconfirmedGrace) | ({ paused: false; error: string } & UnconfirmedGrace)> {
  let previous = 0;
  let cursor: { at: string; id: string } | null = null;
  let pause: { since: string | null } | null = null;
  const paused = (announced: boolean, unsure = false): GracePaused => ({
    paused: true, since: pause?.since ?? null, announced, ...(!announced && unsure ? { unsure: true as const } : {}),
  });
  const startedAt = (run: { started_at?: unknown }) => (typeof run.started_at === "string" ? run.started_at : null);
  scan: for (;;) {
    let q = sb
      .from("export_runs")
      .select("id, status, diagnostics, started_at")
      .eq("destination_id", destinationId)
      .eq("trigger_type", "scheduled")
      // every scheduled row is written with started_at; a row without one has no place in the order
      .not("started_at", "is", null);
    if (cursor) q = q.or(afterRunCursor(cursor));
    const { data, error } = await q
      .order("started_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(pageSize);
    if (error) {
      if (pause) return paused(true);
      return { paused: false, night: null, of, pausing: false, error: error.message };
    }
    const rows = (Array.isArray(data) ? data : []) as Array<{ id?: unknown; status?: unknown; diagnostics?: unknown; started_at?: unknown }>;
    for (const run of rows) {
      const steps = Array.isArray(run.diagnostics) ? run.diagnostics as Array<{ step?: unknown; detail?: unknown }> : [];
      const has = (step: string) => steps.some((d) => d?.step === step);
      if (has(GRACE_PAUSED_STEP)) {
        pause ??= { since: startedAt(run) };
        if (has(GRACE_PAUSE_ANNOUNCED_STEP)) return paused(true);
        if (has(ALERT_UNSENT_STEP)) return paused(false, has(PAUSE_BELL_UNSURE_STEP));
        continue; // a paused night that says nothing of the announcement: read on to one that does
      }
      const night = steps.find((d) => d?.step === GRACE_NIGHT_STEP);
      if (night) {
        const m = /^night=(\d+)\/\d+$/.exec(String(night.detail ?? ""));
        if (!m) continue; // an unread count: it neither counts nor breaks the run of nights
        // the night that paused it: announced when its bell is recorded as
        // delivered (alert:sent, written before the close — P14 integrator
        // fix) or the run closed without alert:unsent; a run that never closed
        // with no marker is unsure (the bell may have rung, then the marker
        // and the close were refused — or the push was killed before it)
        const closed = run.status === "succeeded" || run.status === "failed";
        const announced = has(ALERT_SENT_STEP) || (closed && !has(ALERT_UNSENT_STEP));
        const unsure = !announced && !has(ALERT_UNSENT_STEP);
        if (pause) return paused(announced, unsure);
        previous = Number(m[1]);
        if (previous >= of) {
          pause = { since: startedAt(run) };
          return paused(announced, unsure);
        }
        break scan;
      }
      if (has(GRACE_UNVERIFIED_STEP)) continue; // an unverified night: neutral
      if (run.status === "cancelled") continue; // a gate skip for another reason
      if (pause) return paused(true); // nothing says the pause went unannounced
      break scan; // a confirmed push, or a run from before this rule: the count starts again
    }
    if (rows.length < pageSize) break; // the destination's whole history was read
    const last = rows[rows.length - 1];
    const next = { at: String(last.started_at ?? ""), id: String(last.id ?? "") };
    if (!next.at || !next.id || (cursor && next.at === cursor.at && next.id === cursor.id)) {
      if (pause) return paused(true);
      return { paused: false, night: null, of, pausing: false, error: "the run history could not be paged" };
    }
    cursor = next;
  }
  if (pause) return paused(true);
  const tonight = previous + 1;
  return { paused: false, night: tonight, of, pausing: tonight >= of };
}

/** DEC-87 §1: what an unconfirmed scheduled push's bell (and its
 *  run row and destination card) says about who last confirmed it. */
export function unconfirmedSentence(u: { by: string; holds: string }): string {
  return `It was last confirmed by ${u.by}, who does not hold ${u.holds} — which setting up a data export now requires.`;
}

/** DEC-87 §1: the sentence an unconfirmed destination's run row,
 *  card and sweep result carry — on a push that left and on one that
 *  failed, and kept on the card by a Run Now (which does not confirm it). */
export function unconfirmedNote(u: { by: string; holds: string }): string {
  return `${unconfirmedSentence(u)} An Admin should open it and save it to confirm it, or disable it.`;
}

/** DEC-87 §1: does the member who last confirmed this destination
 *  (updated_by, else created_by) hold the data-export surface's entry role,
 *  read from lib/adminSurfaces.ts by the full collection (memberHoldsAny)?
 *  Either way the push RUNS (regression first): `unconfirmed` (who, by
 *  email — their uid when they are no longer an active member — and the
 *  role it takes) when they do not, which the night's bell turns into a
 *  request to confirm it; `notice` when the lookup failed and nothing can be
 *  said (the push ran; checked again at the next run), with `unverified` the
 *  read's error — the sweep then still reads the bounded grace, so an
 *  unverifiable night never ends a pause (P14 review fix). Read by the
 *  scheduled sweep (whose gate has already checked the configurer is an
 *  active member) and by Run Now, so neither leaves the card saying less
 *  than the truth. Never throws. */
export async function destinationConfirmation(
  sb: Pick<SupabaseClient, "from">,
  dest: { org_id: string; updated_by?: string | null; created_by?: string | null },
): Promise<{ unconfirmed?: { by: string; holds: string }; notice?: string; unverified?: string }> {
  const entry = adminSurface("data-export")?.entry ?? ["Admin"];
  if (entry === "*") return {};
  const configurer = dest.updated_by || dest.created_by || null;
  // A destination with no configurer: the sweep's gate skips it already.
  if (!configurer) return {};
  try {
    const { data, error } = await sb
      .from("org_members").select("role, roles, email")
      .eq("org_id", dest.org_id).eq("uid", configurer).eq("status", "active")
      .maybeSingle();
    if (error) {
      return {
        notice: `whether the member who last configured this destination holds ${entry.join(" or ")} could not be verified (${error.message}); the push ran, and this is checked again at the next run`,
        unverified: error.message,
      };
    }
    const member = data as { role?: unknown; roles?: unknown; email?: unknown } | null;
    if (!memberHoldsAny(member, entry)) {
      const email = typeof member?.email === "string" && member.email ? member.email : null;
      return { unconfirmed: { by: email ?? configurer, holds: entry.join(" or ") } };
    }
    return {};
  } catch (e) {
    return {
      notice: `whether the member who last configured this destination holds ${entry.join(" or ")} could not be verified (${(e as Error).message}); the push ran, and this is checked again at the next run`,
      unverified: (e as Error).message,
    };
  }
}

/** A destination was created, enabled, or pointed somewhere new — the act
 *  that sets up an unattended channel for the whole workspace. Every OTHER
 *  controller is told. */
export async function alertAdminsOfDestination(
  admin: SupabaseClient,
  info: {
    orgId: string;
    actorUserId: string;
    actorEmail: string;
    change: "created" | "enabled" | "retargeted";
    destinationId: string;
    destinationName: string;
    destinationType: string;
    enabled: boolean;
    schedule: string;
  },
): Promise<ExportAlertResult> {
  const label = `"${info.destinationName}" (${info.destinationType})`;
  const act = info.change === "created"
    ? `created the export destination ${label}`
    : info.change === "enabled"
      ? `enabled the export destination ${label}`
      : `changed where the export destination ${label} sends the workspace`;
  return alertControllers(admin, info.orgId, info.actorUserId, {
    title: info.change === "created" ? "Export destination created" : info.change === "enabled" ? "Export destination enabled" : "Export destination changed",
    body: (forAdmin) =>
      `${info.actorEmail} ${act}` +
      `${info.enabled && info.schedule !== "manual" ? `; it pushes the entire workspace ${info.schedule}` : ""}. If this wasn't expected, ` +
      (forAdmin
        ? "review the account immediately."
        : "tell an Admin now so they can review it under Admin → Data export. The change is recorded in the audit log."),
    actorUserId: info.actorUserId,
    actorName: info.actorEmail,
    metadata: {
      destinationId: info.destinationId, destinationType: info.destinationType, change: info.change,
      enabled: info.enabled, schedule: info.schedule, at: new Date().toISOString(),
    },
  });
}
