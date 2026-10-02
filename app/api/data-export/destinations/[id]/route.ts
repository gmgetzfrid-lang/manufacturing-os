// PATCH  /api/data-export/destinations/[id]   — update fields (creds optional)
// DELETE /api/data-export/destinations/[id]   — remove a destination
//
// PATCH treats credential fields as set-only-if-provided. Omitting them
// leaves the existing encrypted value in place, which lets the UI hide
// the actual key after creation and still let the user edit other fields.
//
// Admin-only (admin-and-org BKP-8 / BKP-13), through the one gate. ENABLING a
// destination (turning a disabled one on), or RE-POINTING an enabled one (its
// type, endpoint, bucket, prefix or webhook URL changes), is held to rules:
//   - BKP-11 Done-when 3: it must carry its credentials — an s3 / r2 row its
//     access key and secret, a webhook row its signing secret — stored or in
//     this request (lib/exportRunner.ts destinationCredentialGap, the check
//     "Run Now" applies too). A restored destination lands disabled with none
//     of them (lib/dataRestore.ts landRestoredRow), so this is where an Admin
//     must re-enter them, and, for a webhook, look at the URL the backup named;
//   - BILL-3 Done-when 3: a bucket row is the Growth feature, so enabling one
//     passes the same plan gate as creating one (the scheduled runner
//     disables a bucket destination whose plan lapsed);
//   - BKP-13 Done-when 3: every other controller is told, as they are when an
//     enabled destination is pointed somewhere new.
// `enabled` must be a JSON boolean (400 otherwise): PostgREST would store
// "true", "on" or 1 as true while the rules above, keyed on `true`, never ran.
// The EXPORT_DESTINATION_UPDATED / _DELETED rows are CHECKED: a refused one
// is said in the answer as a warning (the change itself stands), never
// swallowed.

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { encryptSecret } from "@/lib/serverCrypto";
import { computeNextRunAt, destinationCredentialGap } from "@/lib/exportRunner";
import { assertCloudBucketEntitlement } from "@/lib/exportEntitlement";
import { alertAdminsOfDestination } from "@/lib/exportAlerts";

/** The stored row PATCH judges a change against. */
interface CurrentDestination {
  enabled?: boolean | null;
  name?: string | null;
  destination_type?: string | null;
  schedule_kind?: string | null;
  endpoint?: string | null;
  bucket?: string | null;
  prefix?: string | null;
  webhook_url?: string | null;
  retention_days?: number | null;
  access_key_id_encrypted?: string | null;
  secret_access_key_encrypted?: string | null;
  webhook_secret_encrypted?: string | null;
}
const CURRENT_COLUMNS =
  "enabled, name, destination_type, schedule_kind, endpoint, bucket, prefix, webhook_url, retention_days, " +
  "access_key_id_encrypted, secret_access_key_encrypted, webhook_secret_encrypted";
/** Where a destination sends the workspace: changing one of these on an enabled destination re-points the channel. */
const TARGET_FIELDS = ["destination_type", "endpoint", "bucket", "prefix", "webhook_url"] as const;

const given = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
const norm = (v: unknown): string => String(v ?? "").trim();

type ScheduleParams = Parameters<typeof computeNextRunAt>[0];

interface DestinationPatchBody {
  orgId: string;
  name?: string;
  destination_type?: string;
  enabled?: boolean;
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  webhook_url?: string;
  schedule_kind?: ScheduleParams["schedule_kind"];
  schedule_hour_utc?: ScheduleParams["schedule_hour_utc"];
  schedule_day_of_week?: ScheduleParams["schedule_day_of_week"];
  schedule_day_of_month?: ScheduleParams["schedule_day_of_month"];
  include_files?: boolean;
  retention_days?: number;
  access_key_id?: string;
  secret_access_key?: string;
  webhook_secret?: string;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let body: DestinationPatchBody;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const orgId = String(body?.orgId ?? "");
  const auth = await authorizeAdminSurface(req, orgId, "data-export");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // The rules below key on `enabled === true`; a string or a number would
  // skip them and still be stored as true (PostgREST casts it).
  if ("enabled" in body && typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be true or false." }, { status: 400 });
  }

  // XEDGE-8: the Growth gate that create applies must hold on edit too —
  // adding a bucket to an existing (webhook / bucket-less) destination is the
  // same act as creating one with a bucket.
  if ("bucket" in body && String(body.bucket ?? "").trim()) {
    const gate = await assertCloudBucketEntitlement(auth.admin, orgId);
    if (gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
  }

  // The row as stored, read CHECKED: every rule below judges the change against it.
  const { data: currentRow, error: currentErr } = await auth.admin
    .from("export_destinations")
    .select(CURRENT_COLUMNS)
    .eq("id", id).eq("org_id", orgId)
    .maybeSingle();
  if (currentErr) return NextResponse.json({ error: `Could not read the destination (${currentErr.message}) — nothing was changed.` }, { status: 500 });
  if (!currentRow) return NextResponse.json({ error: "Destination not found" }, { status: 404 });
  const current = currentRow as CurrentDestination;

  const enabling = body.enabled === true && current.enabled !== true;
  const nextEnabled = "enabled" in body ? body.enabled === true : current.enabled === true;
  const retargeting = nextEnabled && TARGET_FIELDS.some((f) => f in body && norm(body[f]) !== norm(current[f]));
  if (enabling || retargeting) {
    // BKP-11 Done-when 3: a destination is enabled, or an enabled one moved,
    // only with its credentials — stored, or entered in this save.
    const gap = destinationCredentialGap(
      "destination_type" in body ? body.destination_type : current.destination_type,
      {
        accessKey: given(body.access_key_id) || !!current.access_key_id_encrypted,
        secretKey: given(body.secret_access_key) || !!current.secret_access_key_encrypted,
        webhookSecret: given(body.webhook_secret) || !!current.webhook_secret_encrypted,
      },
      { requireWebhookSecret: true, then: enabling ? "enable it again" : "save it again" },
    );
    if (gap) return NextResponse.json({ error: gap }, { status: 409 });
  }
  if (enabling) {
    // BILL-3 Done-when 3: enabling a bucket destination is the act the plan
    // gate guards (a body that sets the bucket was gated above).
    if (norm("bucket" in body ? body.bucket : current.bucket) && !("bucket" in body && norm(body.bucket))) {
      const gate = await assertCloudBucketEntitlement(auth.admin, orgId);
      if (gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
    }
  }
  const retargeted = !enabling && retargeting;

  const updates: Record<string, unknown> = { updated_by: auth.userId, updated_at: new Date().toISOString() };
  const fields: (keyof DestinationPatchBody)[] = [
    "name", "destination_type", "enabled", "endpoint", "region", "bucket",
    "prefix", "webhook_url", "schedule_kind", "schedule_hour_utc",
    "schedule_day_of_week", "schedule_day_of_month", "include_files",
    "retention_days",
  ];
  for (const f of fields) if (f in body) updates[f] = body[f];

  // XEDGE-4: validate the RESULTING (prefix, retention_days) pair — a patch
  // that adds retention to a prefix-less destination, or clears the prefix on
  // a retained one, would arm a purge that scans the whole bucket.
  if ("retention_days" in body || "prefix" in body) {
    const nextPrefix = String(("prefix" in body ? body.prefix : current.prefix) ?? "").trim();
    const nextRetention = Number(("retention_days" in body ? body.retention_days : current.retention_days) ?? 0);
    if (nextRetention > 0 && !nextPrefix) {
      return NextResponse.json(
        { error: "Retention requires a prefix: the purge only ever deletes this app's export archives under the destination's own prefix. Set a Prefix or clear Retention." },
        { status: 400 },
      );
    }
  }

  // Re-encrypt creds only if provided
  try {
    if (body.access_key_id !== undefined && body.access_key_id !== null && body.access_key_id !== "") {
      updates.access_key_id_encrypted = encryptSecret(String(body.access_key_id));
    }
    if (body.secret_access_key !== undefined && body.secret_access_key !== null && body.secret_access_key !== "") {
      updates.secret_access_key_encrypted = encryptSecret(String(body.secret_access_key));
    }
    if (body.webhook_secret !== undefined && body.webhook_secret !== null && body.webhook_secret !== "") {
      updates.webhook_secret_encrypted = encryptSecret(String(body.webhook_secret));
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  // Recompute next_run_at if any schedule field changed
  if (["schedule_kind", "schedule_hour_utc", "schedule_day_of_week", "schedule_day_of_month"].some((f) => f in body)) {
    updates.next_run_at = computeNextRunAt({
      schedule_kind: (updates.schedule_kind as ScheduleParams["schedule_kind"]) ?? "manual",
      schedule_hour_utc: updates.schedule_hour_utc as ScheduleParams["schedule_hour_utc"],
      schedule_day_of_week: updates.schedule_day_of_week as ScheduleParams["schedule_day_of_week"],
      schedule_day_of_month: updates.schedule_day_of_month as ScheduleParams["schedule_day_of_month"],
    });
  }

  const { data, error } = await auth.admin
    .from("export_destinations")
    .update(updates)
    .eq("id", id)
    .eq("org_id", orgId)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const warnings: string[] = [];
  const { error: auditErr } = await auth.admin.from("audit_logs").insert({
    action: "EXPORT_DESTINATION_UPDATED",
    resource_id: id,
    resource_type: "export_destination",
    org_id: orgId,
    user_id: auth.userId,
    user_email: auth.email,
    user_role: auth.role,
    details: { changedFields: Object.keys(updates) },
  });
  if (auditErr) {
    console.error(`[data-export/destinations] org ${orgId}: the EXPORT_DESTINATION_UPDATED audit row was not written: ${auditErr.message}`);
    warnings.push(`Saved, but the change could not be recorded in the audit log: ${auditErr.message}`);
  }

  // BKP-13 Done-when 3: enabling a destination, or re-pointing an enabled
  // one, tells every other controller. A refused alert is said, never
  // swallowed; the change stands either way.
  if (enabling || retargeted) {
    const saved = data as CurrentDestination & { id?: string };
    const alert = await alertAdminsOfDestination(auth.admin, {
      orgId, actorUserId: auth.userId, actorEmail: auth.email, change: enabling ? "enabled" : "retargeted",
      destinationId: id, destinationName: String(saved?.name ?? current.name ?? id),
      destinationType: String(saved?.destination_type ?? current.destination_type ?? ""),
      enabled: true, schedule: String(saved?.schedule_kind ?? current.schedule_kind ?? "manual"),
    }).catch((e) => ({ ok: false, notified: 0, error: (e as Error).message }));
    if (!alert.ok) {
      console.error(`[data-export/destinations] org ${orgId}: the destination alert was not sent: ${alert.error}`);
      warnings.push(`Saved, but the other Admins could not be alerted: ${alert.error}`);
    }
  }

  return NextResponse.json({
    destination: { ...data, access_key_id_encrypted: undefined, secret_access_key_encrypted: undefined, webhook_secret_encrypted: undefined },
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const orgId = new URL(req.url).searchParams.get("orgId") || "";
  const auth = await authorizeAdminSurface(req, orgId, "data-export");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { error } = await auth.admin
    .from("export_destinations")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { error: auditErr } = await auth.admin.from("audit_logs").insert({
    action: "EXPORT_DESTINATION_DELETED",
    resource_id: id,
    resource_type: "export_destination",
    org_id: orgId,
    user_id: auth.userId,
    user_email: auth.email,
    user_role: auth.role,
  });
  if (auditErr) {
    console.error(`[data-export/destinations] org ${orgId}: the EXPORT_DESTINATION_DELETED audit row was not written: ${auditErr.message}`);
    return NextResponse.json({ ok: true, warning: `Deleted, but the deletion could not be recorded in the audit log: ${auditErr.message}` });
  }

  return NextResponse.json({ ok: true });
}
