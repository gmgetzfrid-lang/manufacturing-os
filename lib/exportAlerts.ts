// lib/exportAlerts.ts — SERVER-ONLY.
//
// The bell notification that tells a workspace's controllers its data left,
// or that a new way for it to leave was set up (admin-and-org BKP-13).
//
// The manual export route raised one before this file; the nightly scheduled
// push raised none, and creating or enabling a destination raised none, so a
// webhook destination was an unannounced daily channel. Every export route
// and every destination write now calls one of the two functions below.
//
// The write is CHECKED: a refused insert comes back as `{ ok: false, error }`
// for the caller to record (the run's diagnostics, the response), never a
// silent success. A failed alert never blocks the export or the destination
// write it announces: it is detection, not prevention, and the act it
// reports has already happened when it is sent.

import type { SupabaseClient } from "@supabase/supabase-js";
import { roleFilter } from "@/lib/roleHeld";

export interface ExportAlertResult {
  ok: boolean;
  /** How many controllers were told. */
  notified: number;
  error?: string;
}

async function alertControllers(
  admin: SupabaseClient,
  orgId: string,
  exceptUserId: string | null,
  row: { title: string; body: string; actorUserId: string | null; actorName: string; metadata: Record<string, unknown> },
): Promise<ExportAlertResult> {
  const { data: members, error: readErr } = await admin
    .from("org_members")
    .select("uid")
    .eq("org_id", orgId)
    .eq("status", "active")
    // Who is told: the controller tier, by the FULL role collection.
    .or(roleFilter(["Admin", "DocCtrl"]));
  if (readErr) return { ok: false, notified: 0, error: `could not read who to alert (${readErr.message})` };
  const recipients = Array.from(new Set((Array.isArray(members) ? members as Array<{ uid?: string | null }> : [])
    .map((m) => m.uid)
    .filter((uid): uid is string => !!uid && uid !== exceptUserId)));
  if (recipients.length === 0) return { ok: true, notified: 0 };
  const { error } = await admin.from("notifications").insert(
    recipients.map((uid) => ({
      org_id: orgId,
      user_id: uid,
      kind: "security_export",
      title: row.title,
      body: row.body,
      link: "/admin/data-export",
      resource_type: "export",
      actor_user_id: row.actorUserId,
      actor_name: row.actorName,
      metadata: row.metadata,
    })),
  );
  if (error) return { ok: false, notified: 0, error: `the alert could not be written (${error.message})` };
  return { ok: true, notified: recipients.length };
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
  const body = info.scheduled
    ? `A scheduled export pushed the entire workspace to "${info.scheduled.destinationName}" (${info.destination}). If you don't recognise this destination, disable it under Admin → Data export.`
    : `${info.actorEmail} exported the entire workspace (${info.destination}). If this wasn't expected, review the account immediately.`;
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
    body:
      `${info.actorEmail} ${act}` +
      `${info.enabled && info.schedule !== "manual" ? `; it pushes the entire workspace ${info.schedule}` : ""}. If this wasn't expected, review the account immediately.`,
    actorUserId: info.actorUserId,
    actorName: info.actorEmail,
    metadata: {
      destinationId: info.destinationId, destinationType: info.destinationType, change: info.change,
      enabled: info.enabled, schedule: info.schedule, at: new Date().toISOString(),
    },
  });
}
