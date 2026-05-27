// PATCH  /api/data-export/destinations/[id]   — update fields (creds optional)
// DELETE /api/data-export/destinations/[id]   — remove a destination
//
// PATCH treats credential fields as set-only-if-provided. Omitting them
// leaves the existing encrypted value in place, which lets the UI hide
// the actual key after creation and still let the user edit other fields.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { encryptSecret } from "@/lib/serverCrypto";
import { computeNextRunAt } from "@/lib/exportRunner";

const ADMIN_ROLES = ["Admin", "Manager", "DocCtrl"];

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const orgId = body?.orgId;
  const auth = await authorizeOrgRole(req, orgId, ADMIN_ROLES);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const updates: Record<string, unknown> = { updated_by: auth.userId, updated_at: new Date().toISOString() };
  const fields = [
    "name", "destination_type", "enabled", "endpoint", "region", "bucket",
    "prefix", "webhook_url", "schedule_kind", "schedule_hour_utc",
    "schedule_day_of_week", "schedule_day_of_month", "include_files",
    "retention_days",
  ];
  for (const f of fields) if (f in body) updates[f] = body[f];

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
      schedule_kind: (updates.schedule_kind as any) ?? "manual",
      schedule_hour_utc: updates.schedule_hour_utc as any,
      schedule_day_of_week: updates.schedule_day_of_week as any,
      schedule_day_of_month: updates.schedule_day_of_month as any,
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

  await auth.admin.from("audit_logs").insert({
    action: "EXPORT_DESTINATION_UPDATED",
    resource_id: id,
    resource_type: "export_destination",
    org_id: orgId,
    user_id: auth.userId,
    user_email: auth.email,
    user_role: auth.role,
    details: { changedFields: Object.keys(updates) },
  });

  return NextResponse.json({ destination: { ...data, access_key_id_encrypted: undefined, secret_access_key_encrypted: undefined, webhook_secret_encrypted: undefined } });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const orgId = new URL(req.url).searchParams.get("orgId") || "";
  const auth = await authorizeOrgRole(req, orgId, ADMIN_ROLES);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { error } = await auth.admin
    .from("export_destinations")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await auth.admin.from("audit_logs").insert({
    action: "EXPORT_DESTINATION_DELETED",
    resource_id: id,
    resource_type: "export_destination",
    org_id: orgId,
    user_id: auth.userId,
    user_email: auth.email,
    user_role: auth.role,
  });

  return NextResponse.json({ ok: true });
}
