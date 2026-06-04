// GET    /api/data-export/destinations?orgId=...
// POST   /api/data-export/destinations             — create a destination
//
// Credentials are encrypted at rest before insert via lib/serverCrypto.
// Sensitive fields are NEVER returned to the client after creation —
// API responses include only a masked preview.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { encryptSecret, maskSecret } from "@/lib/serverCrypto";
import { computeNextRunAt } from "@/lib/exportRunner";

const ADMIN_ROLES = ["Admin", "Manager", "DocCtrl"];

type ScheduleParams = Parameters<typeof computeNextRunAt>[0];

interface EncryptedDestinationRow {
  access_key_id_encrypted?: string | null;
  secret_access_key_encrypted?: string | null;
  webhook_secret_encrypted?: string | null;
}

interface DestinationCreateBody {
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

export async function GET(req: NextRequest) {
  const orgId = new URL(req.url).searchParams.get("orgId") || "";
  const auth = await authorizeOrgRole(req, orgId, ADMIN_ROLES);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { data } = await auth.admin
    .from("export_destinations")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  // Strip + mask encrypted columns before returning
  const safe = (data ?? []).map((d: EncryptedDestinationRow & Record<string, unknown>) => ({
    ...d,
    access_key_id_encrypted: undefined,
    secret_access_key_encrypted: undefined,
    webhook_secret_encrypted: undefined,
    has_access_key: !!d.access_key_id_encrypted,
    has_secret_key: !!d.secret_access_key_encrypted,
    has_webhook_secret: !!d.webhook_secret_encrypted,
    access_key_id_preview: d.access_key_id_encrypted ? maskSecret("****") : "",
  }));
  return NextResponse.json({ destinations: safe });
}

export async function POST(req: NextRequest) {
  let body: DestinationCreateBody;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { orgId } = body || {};
  const auth = await authorizeOrgRole(req, orgId, ADMIN_ROLES);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (!body.name || !body.destination_type) {
    return NextResponse.json({ error: "name and destination_type are required" }, { status: 400 });
  }

  // Plan gate: cloud bucket (S3/R2) backup destinations are a Growth feature.
  // Trials may still configure one to evaluate; Starter cannot.
  if (body.bucket) {
    const { data: org } = await auth.admin
      .from("orgs").select("subscription_status, subscribed_plan").eq("id", orgId).maybeSingle();
    const plan = (org as { subscribed_plan?: string } | null)?.subscribed_plan;
    const status = (org as { subscription_status?: string } | null)?.subscription_status;
    const allowed = plan === "growth" || plan === "enterprise" || status === "trialing";
    if (!allowed) {
      return NextResponse.json(
        { error: "Cloud backup destinations (S3/R2) require the Growth plan. Upgrade in Billing to enable scheduled cloud backups." },
        { status: 402 },
      );
    }
  }

  let access_key_id_encrypted: string | null = null;
  let secret_access_key_encrypted: string | null = null;
  let webhook_secret_encrypted: string | null = null;
  try {
    if (body.access_key_id) access_key_id_encrypted = encryptSecret(String(body.access_key_id));
    if (body.secret_access_key) secret_access_key_encrypted = encryptSecret(String(body.secret_access_key));
    if (body.webhook_secret) webhook_secret_encrypted = encryptSecret(String(body.webhook_secret));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const nextRunAt = computeNextRunAt({
    schedule_kind: body.schedule_kind || "manual",
    schedule_hour_utc: body.schedule_hour_utc,
    schedule_day_of_week: body.schedule_day_of_week,
    schedule_day_of_month: body.schedule_day_of_month,
  });

  const { data, error } = await auth.admin.from("export_destinations").insert({
    org_id: orgId,
    name: body.name,
    destination_type: body.destination_type,
    enabled: body.enabled ?? true,
    endpoint: body.endpoint ?? null,
    region: body.region ?? null,
    bucket: body.bucket ?? null,
    prefix: body.prefix ?? null,
    access_key_id_encrypted,
    secret_access_key_encrypted,
    webhook_url: body.webhook_url ?? null,
    webhook_secret_encrypted,
    schedule_kind: body.schedule_kind || "manual",
    schedule_hour_utc: body.schedule_hour_utc ?? null,
    schedule_day_of_week: body.schedule_day_of_week ?? null,
    schedule_day_of_month: body.schedule_day_of_month ?? null,
    next_run_at: nextRunAt,
    include_files: body.include_files ?? true,
    retention_days: body.retention_days ?? null,
    created_by: auth.userId,
    updated_by: auth.userId,
  }).select("*").single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await auth.admin.from("audit_logs").insert({
    action: "EXPORT_DESTINATION_CREATED",
    resource_id: data.id,
    resource_type: "export_destination",
    org_id: orgId,
    user_id: auth.userId,
    user_email: auth.email,
    user_role: auth.role,
    details: { name: data.name, destination_type: data.destination_type },
  });

  return NextResponse.json({ destination: { ...data, access_key_id_encrypted: undefined, secret_access_key_encrypted: undefined, webhook_secret_encrypted: undefined } });
}
