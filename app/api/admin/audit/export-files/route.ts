// GET /api/admin/audit/export-files?orgId=…&recordId=…
//
// admin-and-org ALOG-11's hand-off (A&O P3 handoff 2 / fix-pass-8 item 2,
// built by package P13): the audit viewer's "who took which drawing" for a
// DATA_EXPORT row. lib/dataExport.ts rebuildExportList(sb, orgId, recordId)
// rebuilds that export's file list from the audit trail alone (DEC-87 §3),
// checked against the record's digest, and says whether a failure to deliver
// is recorded. It is server-only (node:crypto), hence this route.
//
// Who may ask: the Audit log surface's holders (lib/adminSurfaces.ts "audit",
// admin.audit_view), through the one gate (lib/adminGate.ts). The list is
// rebuilt from DATA_EXPORT / DATA_EXPORT_FILES / DATA_EXPORT_UNDELIVERED rows,
// which audit_logs_admin_trail already shows that same audience (DATA_EXPORT%
// actions), so the answer hands the reader nothing their own session could not
// read; no document title is added (a title is ACL-scoped, a path is not new).
//
// Two rules the hand-off states, both kept here:
//   * `undelivered: null` is "no delivery failure recorded", NEVER
//     "delivered" — a delivery killed mid-flight records nothing.
//   * the exporter is shown as `exporter.userId`'s CURRENT member of this
//     workspace (email, role, status read now), never the email stored on the
//     row, which a member's insert could set before 20261201; the stored email
//     and role are returned apart, labelled as stored. A machine row (user_id
//     NULL) is the scheduled push.
//   * (P13 integrator fix pass) the exporter's roles are every role they hold
//     now — the headline `role` and the additive `roles` collection
//     (lib/roleHeld.ts heldRoles, ADD-1) — never the headline alone, which
//     hides an additive role. `role` stays the headline, as before.

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { rebuildExportList } from "@/lib/dataExport";
import { heldRoles } from "@/lib/roleHeld";

export const runtime = "nodejs";

export type ExportFilesExporter =
  | { kind: "machine"; label: string | null }
  | { kind: "member"; userId: string; email: string | null; role: string | null; roles: string[]; status: string | null }
  | { kind: "former"; userId: string }
  | { kind: "unread"; userId: string; error: string };

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const recordId = (req.nextUrl.searchParams.get("recordId") || "").trim();
  const actor = await authorizeAdminSurface(req, orgId, "audit");
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  if (!recordId || recordId.length > 200) return NextResponse.json({ error: "recordId is required" }, { status: 400 });

  const { list, problem } = await rebuildExportList(actor.admin, orgId, recordId);
  if (!list) {
    return NextResponse.json({ error: problem ?? `the export ${recordId} could not be rebuilt` }, { status: 422 });
  }

  let exporter: ExportFilesExporter;
  const uid = list.exporter.userId;
  if (!uid) {
    exporter = { kind: "machine", label: list.exporter.email };
  } else {
    const { data, error } = await actor.admin
      .from("org_members").select("email, role, roles, status")
      .eq("org_id", orgId).eq("uid", uid)
      .maybeSingle();
    if (error) exporter = { kind: "unread", userId: uid, error: error.message };
    else if (!data) exporter = { kind: "former", userId: uid };
    else {
      const m = data as { email?: unknown; role?: unknown; roles?: unknown; status?: unknown };
      exporter = {
        kind: "member", userId: uid,
        email: typeof m.email === "string" ? m.email : null,
        role: typeof m.role === "string" ? m.role : null,
        roles: heldRoles(m),
        status: typeof m.status === "string" ? m.status : null,
      };
    }
  }

  return NextResponse.json({
    recordId: list.recordId,
    exportedAt: list.exporter.at,
    exporter,
    /** What the DATA_EXPORT row itself says — the writer's word on a row written before 20261201. */
    stored: { email: list.exporter.email, role: list.exporter.role },
    fileRecord: list.fileRecord,
    files: list.files,
    delivery: list.undelivered
      ? { failureRecorded: true as const, error: list.undelivered.error, at: list.undelivered.at }
      : { failureRecorded: false as const },
  });
}
