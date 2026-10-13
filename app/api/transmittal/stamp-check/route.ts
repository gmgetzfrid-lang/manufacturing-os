// /api/transmittal/stamp-check — document-control TRX-16: the issue-time
// stampability check.
//
// Before a draft transmittal is issued, the issue flow (lib/transmittals.ts
// issueTransmittal) asks whether the recipient's portal will be able to
// stamp each file — a size bound plus a pdf-lib load of the file the issue
// will pin (lib/transmittalStampCheck.ts) — so the ISSUER is warned at
// issue, not the recipient at download. Done here, where the files are, so
// the browser never fetches them.
//
// Who may ask: the caller proves a session, and must be an ACTIVE member of
// the transmittal's workspace holding transmit authority for every document
// on it (TRX-1, `transmittal.issue` per item library — the people who can
// issue it). Only a DRAFT is checked (an issued transmittal's files are what
// was sent). The answer carries each item's verdict (and why), never file
// content.
//
// TRX-17 (20261199): the verdicts are RECORDED on the draft row
// (transmittals.stamp_check: the draft's updated_at as read, who checked,
// when, and each document's verdict with the version it was decided on),
// written with the service role and only on the draft as read (an
// updated_at match), so the issue trigger can require a server-recorded
// verdict for the draft as issued instead of trusting the browser's mark.
// That is the route's one write. Before 20261199 the column does not exist
// (PGRST204 / 42703): the check is answered exactly as before, unrecorded
// (the older trigger does not ask for it). A record that cannot be written
// for any other reason answers 503, and a draft saved while it was being
// checked answers 409 — both read as a check that could not run, so the
// issuer is asked for a yes on every file.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { evaluateTransmitAuthority, rowToTransmittal } from "@/lib/transmittals";
import { checkItemsStampableWithFiles } from "@/lib/transmittalStampCheck";
import { isMissingSchemaError } from "@/lib/checkedWrite";

export const runtime = "nodejs";
// The check reads each file once (up to the portal's stamping bound) within
// its own time budget (STAMP_CHECK_TIME_BUDGET_MS); this is the ceiling.
export const maxDuration = 120;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Unauthorized", 401);

  let body: { transmittalId?: string };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const transmittalId = String(body.transmittalId ?? "").trim();
  if (!transmittalId) return bad("transmittalId is required");

  const { data: row, error: rowErr } = await supabaseAdmin
    .from("transmittals").select("*").eq("id", transmittalId).maybeSingle();
  if (rowErr) return bad(`Couldn't load the transmittal: ${rowErr.message}`, 500);
  if (!row) return bad("Transmittal not found.", 404);
  const t = rowToTransmittal(row as Record<string, unknown>);

  const authority = await evaluateTransmitAuthority(supabaseAdmin, { orgId: t.orgId, uid: user.id, items: t.items });
  if (authority.error) return bad(authority.error, 503);
  // Not a member: answer as if the transmittal did not exist (no oracle).
  if (!authority.member) return bad("Transmittal not found.", 404);
  if (!authority.allowed) {
    return bad("Only a transmit authority (the \"Issue transmittals\" capability) can check a transmittal before issuing it.", 403);
  }
  if (t.status !== "draft") return bad(`${t.number} is ${t.status} — only a draft is checked before issue.`, 409);

  // TRX-15 (P22 review fix): the transmittal's number is stamped too — the
  // check stamps what the download will.
  const checked = await checkItemsStampableWithFiles(supabaseAdmin, { orgId: t.orgId, items: t.items, transmittalNumber: t.number });
  const items = checked.map((c) => c.check);
  const noStore = { headers: { "Cache-Control": "no-store" } };

  // TRX-17: record the verdicts on the draft as it was read.
  const raw = row as Record<string, unknown>;
  const draftUpdatedAt = typeof raw.updated_at === "string" && raw.updated_at ? raw.updated_at : null;
  if (!draftUpdatedAt) return bad("The check ran, but it cannot be recorded: the draft carries no save time. Issue again, or issue anyway — your yes is recorded.", 503);
  const record = {
    draftUpdatedAt,
    checkedAt: new Date().toISOString(),
    checkedBy: user.id,
    items: checked.map(({ check, versionId }) => ({
      documentId: check.documentId,
      versionId,
      verdict: check.verdict,
      ...(check.detail ? { detail: check.detail } : {}),
    })),
  };
  const { data: wrote, error: recErr } = await supabaseAdmin
    .from("transmittals")
    .update({ stamp_check: record })
    .eq("id", t.id)
    .eq("status", "draft")
    .eq("updated_at", draftUpdatedAt)
    .select("id");
  if (recErr) {
    if (isMissingSchemaError(recErr)) {
      // Before 20261199: nothing to record into, and nothing asks for it.
      console.warn("[stamp-check] transmittals.stamp_check is missing (apply 20261199) — the check is answered unrecorded");
      return NextResponse.json({ items, recorded: false }, noStore);
    }
    return bad(`The check ran, but its result could not be recorded (${recErr.message}). Issue again, or issue anyway — your yes is recorded.`, 503);
  }
  if (!Array.isArray(wrote) || wrote.length === 0) {
    return bad(`${t.number} was saved while its files were being checked — the check was not recorded. Open the draft, check it and issue again.`, 409);
  }
  return NextResponse.json({ items, recorded: true }, noStore);
}
