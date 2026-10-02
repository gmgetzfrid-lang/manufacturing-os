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
 *  controller, naming the destination and who last configured it. */
export async function alertAdminsOfExport(
  admin: SupabaseClient,
  info: {
    orgId: string;
    actorUserId: string | null;
    actorEmail: string;
    destination: string;
    /** A scheduled push: the destination's name and its last configurer's uid. */
    scheduled?: { destinationName: string; configuredBy: string | null };
  },
): Promise<ExportAlertResult> {
  const when = new Date().toISOString();
  const what = info.scheduled
    ? `A scheduled export pushed the entire workspace to "${info.scheduled.destinationName}" (${info.destination}).`
    : `${info.actorEmail} exported the entire workspace (${info.destination}).`;
  const body = (forAdmin: boolean) => info.scheduled
    ? `${what} If you don't recognise this destination, ${forAdmin
      ? "disable it under Admin → Data export."
      : "ask an Admin to disable it under Admin → Data export. The run is recorded in the audit log."}`
    : `${what} If this wasn't expected, ${forAdmin
      ? "review the account immediately."
      : "tell an Admin now so they can review the account. The export is recorded in the audit log."}`;
  return alertControllers(admin, info.orgId, info.actorUserId, {
    title: info.scheduled ? "Scheduled workspace export ran" : "Full workspace export was run",
    body,
    actorUserId: info.actorUserId,
    actorName: info.actorEmail,
    metadata: {
      destination: info.destination, at: when,
      ...(info.scheduled ? { scheduled: true, destinationName: info.scheduled.destinationName, configuredBy: info.scheduled.configuredBy } : {}),
    },
  });
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
