// POST /api/audit/dead-letter — drafting-flow EVID-6 (admin-and-org package
// P13): the browser's door into the audit dead-letter outbox
// (public.audit_dead_letters, 20261219).
//
// lib/audit.ts logAuditAction posts here when a signed-in member's audit
// insert is refused. The route VERIFIES the caller before it writes anything
// as the service role:
//   * a valid session and an ACTIVE membership of the workspace the row names
//     (lib/serverAuth.ts authorizeOrgRole, any role);
//   * the row names the caller (user_id = their uid) or no person (a stand-in
//     logAuditAction already writes as user_id NULL) — never someone else,
//     which the audit insert policy would have refused too;
//   * a bounded body, and at most DEAD_LETTER_HOURLY_CAP undrained rows per
//     reporter per hour (a flood is refused, 429).
// What it keeps is the writer's word, labelled as such: the row as sent
// (entry.row) and the verified reporter (entry.reporter, reported_by). The
// maintenance cron drains it into the audit trail as an AUDIT_DEAD_LETTER
// machine row (lib/auditOutboxDrain.ts) — never as the lost action itself, so
// a refusal the database meant cannot be laundered through the service role.
//
// Before 20261219 is pasted the table is missing: 503 "not installed" — the
// caller keeps today's path (the refusal returned and logged).

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { isMissingSchemaError } from "@/lib/checkedWrite";
import { ALL_ROLES } from "@/types/schema";
import { DEAD_LETTER_MAX_BODY, DEAD_LETTER_HOURLY_CAP } from "@/lib/auditOutbox";

export const runtime = "nodejs";

const SENTINELS = new Set(["", "unknown", "system"]);
const NOT_INSTALLED = "the audit dead-letter outbox is not installed yet (20261219 not applied)";

const str = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => "");
  if (raw.length > DEAD_LETTER_MAX_BODY) return NextResponse.json({ error: "Dead letter too large" }, { status: 413 });
  let parsed: unknown;
  try { parsed = JSON.parse(raw || "{}"); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  // Fix pass: `null`, an array or a primitive parses too — answered 400, never
  // a TypeError on `body.orgId` (an unhandled 500).
  const body = obj(parsed) as { orgId?: unknown; entry?: unknown; error?: unknown } | null;
  if (!body) return NextResponse.json({ error: "The body must be a JSON object" }, { status: 400 });

  const orgId = typeof body.orgId === "string" ? body.orgId : "";
  const actor = await authorizeOrgRole(req, orgId, ALL_ROLES as string[]);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  const entry = obj(body.entry);
  const action = str(entry?.action, 120);
  if (!entry || !action || !/^[A-Z][A-Z0-9_]*$/.test(action)) {
    return NextResponse.json({ error: "entry.action is required" }, { status: 400 });
  }
  if (entry.org_id !== undefined && entry.org_id !== orgId) {
    return NextResponse.json({ error: "the row names another workspace" }, { status: 403 });
  }
  const named = entry.user_id;
  const namesNoOne = named === null || named === undefined || (typeof named === "string" && SENTINELS.has(named.trim().toLowerCase()));
  if (!namesNoOne && named !== actor.userId) {
    return NextResponse.json({ error: "a member may dead-letter only their own audit row" }, { status: 403 });
  }

  const sb = actor.admin;
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const { count, error: countError } = await sb.from("audit_dead_letters")
    .select("id", { count: "exact", head: true })
    .eq("reported_by", actor.userId).is("drained_at", null).gte("reported_at", hourAgo);
  if (countError) {
    const missing = isMissingSchemaError(countError);
    return NextResponse.json({ error: missing ? NOT_INSTALLED : `the outbox could not be read: ${countError.message}` }, { status: missing ? 503 : 500 });
  }
  if ((count ?? 0) >= DEAD_LETTER_HOURLY_CAP) {
    return NextResponse.json({ error: `more than ${DEAD_LETTER_HOURLY_CAP} undrained dead letters from you in the last hour` }, { status: 429 });
  }

  const row = {
    action,
    resource_id: str(entry.resource_id, 200),
    resource_type: str(entry.resource_type, 80),
    org_id: orgId,
    user_id: namesNoOne ? null : actor.userId,
    user_email: str(entry.user_email, 320),
    user_role: str(entry.user_role, 80),
    details: obj(entry.details),
    metadata: obj(entry.metadata),
  };
  // Fix pass: the outbox id is not returned — the drain writes the recovered
  // audit row under that id (lib/auditOutboxDrain.ts), so the browser never
  // learns a key it could pre-empt with an audit row of its own.
  const { error } = await sb.from("audit_dead_letters").insert({
    org_id: orgId,
    action,
    entry: { row, reporter: { uid: actor.userId, email: actor.email, role: actor.role, roles: actor.roles } },
    error: str(body.error, 2000),
    source: "browser",
    reported_by: actor.userId,
  });
  if (error) {
    const missing = isMissingSchemaError(error);
    return NextResponse.json({ error: missing ? NOT_INSTALLED : `the dead letter was not kept: ${error.message}` }, { status: missing ? 503 : 500 });
  }
  return NextResponse.json({ ok: true }, { status: 201 });
}
