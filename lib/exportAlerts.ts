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

import type { SupabaseClient } from "@supabase/supabase-js";
import { roleFilter, memberHoldsAny } from "@/lib/roleHeld";
import { adminSurface } from "@/lib/adminSurfaces";

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
  const { error } = await admin.from("notifications").insert(
    [...recipients].map(([uid, isAdmin]) => ({
      org_id: orgId,
      user_id: uid,
      kind: "security_export",
      title: row.title,
      body: row.body(isAdmin),
      link: isAdmin ? ALERT_LINKS.admin : ALERT_LINKS.other,
      resource_type: "export",
      actor_user_id: row.actorUserId,
      actor_name: row.actorName,
      metadata: row.metadata,
    })),
  );
  if (error) return { ok: false, notified: 0, error: `the alert could not be written (${error.message})` };
  return { ok: true, notified: recipients.size };
}

/** A full workspace export ran. A person's export tells every OTHER
 *  controller; a scheduled push (no person: `actorUserId` null) tells every
 *  controller, naming the destination and who last configured it.
 *
 *  DEC-44 (A&O P3) §1: a scheduled push whose last configurer does not hold
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
    scheduled?: { destinationName: string; configuredBy: string | null; unconfirmed?: { by: string; holds: string } };
  },
): Promise<ExportAlertResult> {
  const when = new Date().toISOString();
  const unconfirmed = info.scheduled?.unconfirmed;
  const what = info.scheduled
    ? `A scheduled export pushed the entire workspace to "${info.scheduled.destinationName}" (${info.destination}).`
    : `${info.actorEmail} exported the entire workspace (${info.destination}).`;
  const body = (forAdmin: boolean) => unconfirmed
    ? `${what} ${unconfirmedSentence(unconfirmed)} ${forAdmin
      ? "Open it under Admin → Data export and save it to confirm it, or disable it."
      : "Ask an Admin to open it under Admin → Data export and save it to confirm it, or disable it. The run is recorded in the audit log."}`
    : info.scheduled
      ? `${what} If you don't recognise this destination, ${forAdmin
        ? "disable it under Admin → Data export."
        : "ask an Admin to disable it under Admin → Data export. The run is recorded in the audit log."}`
      : `${what} If this wasn't expected, ${forAdmin
        ? "review the account immediately."
        : "tell an Admin now so they can review the account. The export is recorded in the audit log."}`;
  return alertControllers(admin, info.orgId, info.actorUserId, {
    title: unconfirmed
      ? "Scheduled export needs an Admin to confirm it"
      : info.scheduled ? "Scheduled workspace export ran" : "Full workspace export was run",
    body,
    actorUserId: info.actorUserId,
    actorName: info.actorEmail,
    metadata: {
      destination: info.destination, at: when,
      ...(info.scheduled ? { scheduled: true, destinationName: info.scheduled.destinationName, configuredBy: info.scheduled.configuredBy } : {}),
      ...(unconfirmed ? { unconfirmed: { by: unconfirmed.by, holds: unconfirmed.holds } } : {}),
    },
  });
}

/** DEC-44 (A&O P3) §1: what an unconfirmed scheduled push's bell (and its
 *  run row and destination card) says about who last confirmed it. */
export function unconfirmedSentence(u: { by: string; holds: string }): string {
  return `It was last confirmed by ${u.by}, who does not hold ${u.holds} — which setting up a data export now requires.`;
}

/** DEC-44 (A&O P3) §1: the sentence an unconfirmed destination's run row,
 *  card and sweep result carry — on a push that left and on one that
 *  failed, and kept on the card by a Run Now (which does not confirm it). */
export function unconfirmedNote(u: { by: string; holds: string }): string {
  return `${unconfirmedSentence(u)} An Admin should open it and save it to confirm it, or disable it.`;
}

/** DEC-44 (A&O P3) §1: does the member who last confirmed this destination
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
