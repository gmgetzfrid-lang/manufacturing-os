// /api/documents/unit-code — the unit decode at create time (intelligence
// GAP-314, its document-control half; document-control P13).
//
// documents.unit_code is the Site Codebook's decode of a document's number
// (20261138; DEC-67), written only by the service role. Until now only the
// one-off backfill (POST /api/admin/unit-identity) wrote it, so a document
// created or renumbered after a run stayed undecoded. Every creation door and
// renumber path the app owns calls this route right after its write lands —
// best-effort: a decode that fails never fails the creation; it is reported.
//
// What it trusts: nothing the caller sends but WHICH documents. The route
// re-reads each document's stored number with the service role, in the
// caller's org, and decodes it with the backfill's own planner and guarded
// writes (lib/unitCodeDecode.ts decodeDocumentUnitCodes) — a number or a code
// in the body is never read. Who may ask: an active member of the org, and
// only about documents their OWN session can read (the documents RLS —
// node_visible and the ACL — answers that, through a client carrying their
// token), so the answer never names a document, a unit or a reason they could
// not see. The value written is the codebook's, whoever asks.
//
// What is recorded: a document left without a code (the number does not
// decode, decodes to no unit or to a unit the codebook does not hold, has no
// number), a cleared stale code, a refused write and a number that changed
// under the call are recorded on ONE audit row per call (UNIT_CODE_DECODE,
// service role, per document: id, outcome, code, reason) — the "NULL with the
// reason recorded" of GAP-314's acceptance 1. A call that only confirmed
// current codes writes no row.
//
// No opinion (P13 third review fix): before 20261138 is pasted, or while the
// org's Site Codebook cannot decode a number (no number format, or no units),
// the route decides, writes and records NOTHING and answers no note — that is
// no follow-up for the door that asked (its dialog never holds for it), and
// no audit row per created document. The next unit-identity run on
// Operational scope places the documents once a decode can run.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerScopedClient } from "@/lib/serverAuth";
import { decodeDocumentUnitCodes, DECODE_MAX_DOCUMENTS } from "@/lib/unitCodeDecode";

export const runtime = "nodejs";

const VIA = new Set(["upload", "split", "merge", "csv_import", "renumber", "renumber_reversed", "metadata_edit"]);
const bad = (error: string, status = 400) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Not authenticated", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Not authenticated", 401);

  let body: { orgId?: unknown; documentIds?: unknown; via?: unknown };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
  const ids = Array.isArray(body.documentIds)
    ? [...new Set((body.documentIds as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))]
    : [];
  const via = typeof body.via === "string" && VIA.has(body.via) ? body.via : "other";
  if (!orgId || ids.length === 0) return bad("orgId and documentIds are required");
  if (ids.length > DECODE_MAX_DOCUMENTS) return bad(`Decode up to ${DECODE_MAX_DOCUMENTS} documents per call (got ${ids.length}).`);

  const { data: member, error: memberErr } = await supabaseAdmin
    .from("org_members").select("uid, email").eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  if (memberErr) return bad(`Couldn't confirm your membership: ${memberErr.message}`, 500);
  if (!member) return bad("Not an active member of this organization.", 403);

  // Only documents the caller's own session can read (RLS decides).
  const caller = callerScopedClient(req);
  if ("error" in caller) return bad(caller.error, caller.status);
  const { data: seen, error: seenErr } = await caller.from("documents").select("id").eq("org_id", orgId).in("id", ids);
  if (seenErr) return bad(`Couldn't read the documents: ${seenErr.message}`, 500);
  const visible = ((seen ?? []) as Array<{ id: string }>).map((r) => String(r.id));

  let decoded: Awaited<ReturnType<typeof decodeDocumentUnitCodes>>;
  try {
    decoded = await decodeDocumentUnitCodes({ orgId, documentIds: visible });
  } catch (e) {
    return bad(`The unit decode did not run: ${(e as Error).message}`, 500);
  }
  if (decoded.notApplied || decoded.noOpinion) {
    // no opinion: nothing decided, written or recorded — and nothing to report
    return NextResponse.json({ results: [], notes: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  const seenSet = new Set(visible);
  const results = [
    ...decoded.results,
    // a document the caller cannot read is answered as if it did not exist
    ...ids.filter((id) => !seenSet.has(id)).map((id) => ({ documentId: id, unitCode: null, outcome: "not_found" as const, reason: "No such document in this organization." })),
  ];

  const notes: string[] = [];
  // no_opinion is never worth a row (P13 third review fix): it says only that the codebook cannot decode
  const worthRecording = decoded.results.filter((r) => r.outcome !== "unchanged" && r.outcome !== "decoded" && r.outcome !== "not_found" && r.outcome !== "no_opinion");
  const wrote = decoded.results.some((r) => r.outcome === "decoded" || r.outcome === "cleared");
  if (worthRecording.length > 0 || wrote) {
    const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert({
      action: "UNIT_CODE_DECODE",
      resource_type: "org", resource_id: orgId,
      org_id: orgId, user_id: user.id,
      user_email: (member as { email?: string | null }).email ?? user.email ?? null,
      details: {
        via,
        documents: decoded.results
          .filter((r) => r.outcome !== "unchanged" && r.outcome !== "not_found" && r.outcome !== "no_opinion")
          .map((r) => ({ id: r.documentId, outcome: r.outcome, unitCode: r.unitCode, reason: r.reason })),
      },
    });
    if (auditErr) notes.push(`The decode ran, but its audit record could not be written: ${auditErr.message}`);
  }
  return NextResponse.json({ results, notes }, { headers: { "Cache-Control": "no-store" } });
}
