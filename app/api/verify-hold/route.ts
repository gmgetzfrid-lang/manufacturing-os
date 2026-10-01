// GET /api/verify-hold?id=<uuid>
//
// The endpoint behind the QR on a printed HOLD card. Unauthenticated by
// design — a physical red tag hangs on equipment for weeks; anyone who sees
// it must be able to check "is this still active?" with a phone, no login.
// Exposure is minimal: hold status, the reason CATEGORY (a predefined
// picker reason, else "On hold" — the reason column is operator text, HLD-7
// / VFY-6 — and `reasonWithheld` says when that happened, so the page can say
// "read it on the tag" instead of printing a category that is not one), dates,
// the document label (document_number, falling back to the title / name) with
// the current rev and the rev the hold was placed against, and how many OTHER
// holds are active on the same document with their categories (VFY-10 /
// PHYS-10: a released card is green only when nothing else holds the
// document — another document_holds row OR the document's legal hold, which
// /api/verify and /api/verify-package also treat as held; the legal hold is
// counted, never named, exactly as those two routes publish it). The ID is
// an unguessable UUID that only exists on cards the org itself printed.
// Every answered scan leaves a verify_scans row and counts toward a generous
// per-IP cap (VFY-12); every answer is no-store (VFY-13).

import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { publicHoldReason } from "@/lib/holds";
import { checkVerifyRate, clientIp, verifyJson, verifyRateLimitedResponse } from "@/lib/verifyRateLimit";
import { recordVerifyScan } from "@/lib/verifyScanLog";
import type { HoldVerdict } from "@/lib/verifyPresent";

// A hold verdict is never prerendered or cached (VFY-13; OFF-1 dw3).
export const dynamic = "force-dynamic";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// VFY-14: the rows are typed to exactly the columns selected — notes, staff
// names and the release reason are never fetched, and an explicit interface
// (not Record<string, unknown>) means a `...hold` spread cannot compile into
// the response with a column the public contract does not list.
interface HoldRow {
  id: string;
  document_id: string;
  reason: string | null;
  opened_at: string | null;
  released_at: string | null;
  /** 20261073 (HLD-7); undefined on a pre-migration database. */
  held_rev_label?: string | null;
}
interface DocLabelRow {
  document_number: string | null; title: string | null; name: string | null; rev: string | null;
  /** Read for the verdict only — never returned (VFY-14's contract, as on /api/verify). */
  legal_hold: boolean | null;
}
interface SiblingRow { id: string; reason: string | null }

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return verifyJson({ error: "Verification unavailable" }, 503);
  }
  const holdId = req.nextUrl.searchParams.get("id") ?? "";
  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const ip = clientIp(req);
  const userAgent = req.headers.get("user-agent");
  const scan = (verdict: string) =>
    recordVerifyScan(sb, { endpoint: "verify-hold", targetId: holdId, verdict, ip, userAgent });

  const rate = await checkVerifyRate(sb, { ip });
  if (rate.limited) return verifyRateLimitedResponse(rate);

  if (!UUID_RE.test(holdId)) {
    await scan("invalid");
    return verifyJson({ error: "Invalid code" }, 400);
  }

  // HLD-7: held_rev_label is the 20261073 column — the rev the hold was
  // placed against. It reads as undefined on a pre-migration database, which
  // the payload reports as null (unknown), never as the current rev.
  const { data: holdData, error: holdErr } = await sb
    .from("document_holds")
    .select("id, document_id, reason, opened_at, released_at, held_rev_label")
    .eq("id", holdId)
    .maybeSingle();
  if (holdErr) {
    // The page's error branch says "treat the hold as ACTIVE" — never green.
    await scan("error");
    return verifyJson({ error: "Verification unavailable — try again" }, 503);
  }
  if (!holdData) {
    await scan("unknown");
    return verifyJson({ error: "Unknown hold" }, 404);
  }
  const h = holdData as HoldRow;

  // The document row carries the label AND its legal hold. A legal hold is a
  // hold on the document like any open document_holds row — /api/verify and
  // /api/verify-package both read it as held (VFY-5 done-when 3) — so a
  // released card must not read green over it. An unreadable (or vanished)
  // document is "unknown", amber — never green.
  let docLabel: string | null = null;
  let docRev: string | null = null;
  let legalHold: boolean | null = null;
  const { data: docData, error: docErr } = await sb
    .from("documents")
    .select("document_number, title, name, rev, legal_hold")
    .eq("id", h.document_id)
    .maybeSingle();
  const d = docErr ? null : (docData as DocLabelRow | null);
  if (d) {
    docLabel = String(d.document_number || d.title || d.name || "");
    docRev = d.rev ?? null;
    legalHold = d.legal_hold === true;
  }

  // VFY-10 / PHYS-10: every OTHER unreleased hold on the same document. A
  // multi-hold document is the design (lib/holds.ts header), so a released
  // card must not read green while a sibling still stops the document. The
  // sibling read failing is "unknown" — amber, never green. (Filtered by id
  // here rather than with a not-equal filter, so the count can never include
  // this hold.) The legal hold counts as one more hold on the document; it
  // carries no public category (its matter and reason are never published).
  // An unknown legal-hold state with no sibling found is "unknown" too.
  let otherActiveHolds: number | null = 0;
  let otherHoldReasons: string[] = [];
  const { data: sibData, error: sibErr } = await sb
    .from("document_holds")
    .select("id, reason")
    .eq("document_id", h.document_id)
    .is("released_at", null);
  if (sibErr) {
    otherActiveHolds = null;
  } else {
    const others = ((sibData as SiblingRow[] | null) ?? []).filter((s) => s.id !== h.id);
    otherActiveHolds = legalHold === null && others.length === 0 ? null : others.length + (legalHold ? 1 : 0);
    otherHoldReasons = [...new Set(others.map((s) => publicHoldReason(s.reason)))];
  }

  const active = !h.released_at;
  let verdict: HoldVerdict;
  if (active) verdict = "active";
  else if (otherActiveHolds === null) verdict = "released_others_unknown";
  else if (otherActiveHolds > 0) verdict = "released_others_active";
  else verdict = "released";

  await scan(verdict);

  // Minimal facts only — same contract as /api/verify. This endpoint is
  // unauthenticated; a photographed hold card must not disclose staff names
  // or free-text operator notes ("waiting on legal re: incident …") to
  // whoever scans it. `reason` is such free text when the picker's "Other…"
  // was used, so it is published only as its predefined category (and
  // `reasonWithheld` is true). Status, category, dates, and the doc label
  // suffice to answer the one field question: is this hold still active —
  // and is anything else still holding the document? `heldRev` is the rev
  // the stop-work was placed against (what the card printed); `docRev` is
  // the document now — they differ after a controller force-publishes over
  // the hold.
  const reason = publicHoldReason(h.reason);
  return verifyJson({
    active,
    verdict,
    reason,
    reasonWithheld: reason !== (h.reason ?? "").trim(),
    openedAt: h.opened_at ?? null,
    releasedAt: h.released_at ?? null,
    docLabel,
    docRev,
    heldRev: h.held_rev_label ?? null,
    otherActiveHolds,
    otherHoldReasons,
    checkedAt: new Date().toISOString(),
  });
}
