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
     *  it takes, e.g. "Admin"). */
    scheduled?: { destinationName: string; configuredBy: string | null; unconfirmed?: { by: string; holds: string }; grace?: UnconfirmedGrace };
  },
): Promise<ExportAlertResult> {
  const when = new Date().toISOString();
  const unconfirmed = info.scheduled?.unconfirmed;
  // DEC-87 §1 as amended under DEC-90 (admin-and-org Round G, P14): the
  // night's place in the bounded grace, said in every Admin's bell.
  const grace = unconfirmed ? info.scheduled?.grace : undefined;
  const graceText = grace ? ` ${graceSentence(grace)}` : "";
  const what = info.scheduled
    ? `A scheduled export pushed the entire workspace to "${info.scheduled.destinationName}" (${info.destination}).`
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
      ? (grace?.pausing ? "Scheduled export paused until an Admin confirms it" : "Scheduled export needs an Admin to confirm it")
      : info.scheduled ? "Scheduled workspace export ran" : "Full workspace export was run",
    body,
    actorUserId: info.actorUserId,
    actorName: info.actorEmail,
    metadata: {
      destination: info.destination, at: when,
      ...(info.scheduled ? { scheduled: true, destinationName: info.scheduled.destinationName, configuredBy: info.scheduled.configuredBy } : {}),
      ...(unconfirmed ? { unconfirmed: { by: unconfirmed.by, holds: unconfirmed.holds } } : {}),
      ...(grace ? { grace: { night: grace.night, of: grace.of, pausing: grace.pausing } } : {}),
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
// Admin's bell names the night; the last night's push is followed by a pause
// (its bell says so); from the next night the sweep skips it with a
// cancelled run row (GRACE_PAUSED_STEP) and no bell, until an Admin opens it
// and saves it (which stamps updated_by: confirmed — it runs as any other
// destination) or disables it. The count reads only rows this rule wrote, so
// the night the change deploys is night 1 for every such destination, never
// the night a backup stops. A run the gate skipped for another reason
// (cancelled, no grace step) neither counts nor breaks the count; any other
// run (a confirmed push, a run from before this rule) ends it.

/** DEC-87 §1 (amended): consecutive unconfirmed nightly runs before a pause. */
export const UNCONFIRMED_GRACE_NIGHTS = 7;
/** The run row's diagnostics step for an unconfirmed night (`night=<n>/<of>`, `n` "?" when unread). */
export const GRACE_NIGHT_STEP = "grace:unconfirmed-night";
/** The run row's diagnostics step for a night the destination stayed paused. */
export const GRACE_PAUSED_STEP = "grace:paused";

export interface UnconfirmedGrace {
  /** Tonight's unconfirmed night (1-based), or null when the count could not be read (it runs). */
  night: number | null;
  of: number;
  /** Tonight is the last night: it runs, and is paused from the next night. */
  pausing: boolean;
}

/** What the bell, run row and card say about tonight's place in the grace. */
export function graceSentence(g: UnconfirmedGrace): string {
  if (g.night === null) {
    return `It runs tonight; how many unconfirmed nights it has had could not be read, so the count resumes at the next run (it is paused after ${g.of} unconfirmed nights).`;
  }
  return g.pausing
    ? `This was unconfirmed night ${g.night} of ${g.of}, so it is now PAUSED: no scheduled push leaves until an Admin opens it and saves it to confirm it (or disables it).`
    : `This is unconfirmed night ${g.night} of ${g.of}: unless an Admin confirms it, it is paused after night ${g.of}'s push.`;
}

/** The run row's diagnostics entry for tonight's unconfirmed night. */
export function graceNightStep(g: UnconfirmedGrace, ts: string): { ts: string; step: string; detail: string } {
  return { ts, step: GRACE_NIGHT_STEP, detail: `night=${g.night ?? "?"}/${g.of}` };
}

/** What a paused night's run row, card and sweep result say. */
export function pausedNote(u: { by: string; holds: string }, of = UNCONFIRMED_GRACE_NIGHTS): string {
  return `Paused: no Admin has confirmed this destination after ${of} unconfirmed nightly pushes, so no scheduled push leaves until an Admin opens it under Admin → Data export and saves it to confirm it (or disables it). ${unconfirmedSentence(u)}`;
}

/** Tonight's place in the grace for an unconfirmed destination, read from
 *  its recent scheduled run rows (newest first). `paused` when the previous
 *  counted night was the last one, or a paused night; otherwise tonight's
 *  night. A read that fails answers `night: null` — the push runs (a backup
 *  is never stopped on a guess) and says the count could not be read. */
export async function unconfirmedGraceTonight(
  sb: Pick<SupabaseClient, "from">,
  destinationId: string,
  of = UNCONFIRMED_GRACE_NIGHTS,
): Promise<{ paused: true } | ({ paused: false } & UnconfirmedGrace) | ({ paused: false; error: string } & UnconfirmedGrace)> {
  const { data, error } = await sb
    .from("export_runs")
    .select("id, status, diagnostics, started_at")
    .eq("destination_id", destinationId)
    .eq("trigger_type", "scheduled")
    .order("started_at", { ascending: false })
    .limit(4 * of);
  if (error) return { paused: false, night: null, of, pausing: false, error: error.message };
  let previous = 0;
  for (const run of (Array.isArray(data) ? data : []) as Array<{ status?: unknown; diagnostics?: unknown }>) {
    const steps = Array.isArray(run.diagnostics) ? run.diagnostics as Array<{ step?: unknown; detail?: unknown }> : [];
    if (steps.some((d) => d?.step === GRACE_PAUSED_STEP)) return { paused: true };
    const night = steps.find((d) => d?.step === GRACE_NIGHT_STEP);
    if (night) {
      const m = /^night=(\d+)\/\d+$/.exec(String(night.detail ?? ""));
      if (!m) continue; // an unread count: it neither counts nor breaks the run of nights
      previous = Number(m[1]);
      break;
    }
    if (run.status === "cancelled") continue; // a gate skip for another reason
    break; // a confirmed push, or a run from before this rule: the count starts again
  }
  if (previous >= of) return { paused: true };
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
 *  said (the push ran; checked again at the next run). Read by the
 *  scheduled sweep (whose gate has already checked the configurer is an
 *  active member) and by Run Now, so neither leaves the card saying less
 *  than the truth. Never throws. */
export async function destinationConfirmation(
  sb: Pick<SupabaseClient, "from">,
  dest: { org_id: string; updated_by?: string | null; created_by?: string | null },
): Promise<{ unconfirmed?: { by: string; holds: string }; notice?: string }> {
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
      return { notice: `whether the member who last configured this destination holds ${entry.join(" or ")} could not be verified (${error.message}); the push ran, and this is checked again at the next run` };
    }
    const member = data as { role?: unknown; roles?: unknown; email?: unknown } | null;
    if (!memberHoldsAny(member, entry)) {
      const email = typeof member?.email === "string" && member.email ? member.email : null;
      return { unconfirmed: { by: email ?? configurer, holds: entry.join(" or ") } };
    }
    return {};
  } catch (e) {
    return { notice: `whether the member who last configured this destination holds ${entry.join(" or ")} could not be verified (${(e as Error).message}); the push ran, and this is checked again at the next run` };
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
