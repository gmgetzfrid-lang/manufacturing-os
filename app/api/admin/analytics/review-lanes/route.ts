// /api/admin/analytics/review-lanes — drafting-flow GAP-101 acceptance 5
// (Round G, DF-P19 second fix pass, review major 1): the Review Lanes
// report's data for ONE period, whole.
//
//   GET ?orgId=&from=YYYY-MM-DD&to=YYYY-MM-DD  (either end may be omitted)
//     → 200 { tickets: row[], total: number | null, complete: boolean }
//
// "A report can count, for any period: tickets by lane, and every
// declaration with its author and text." The analytics page's shared read
// (/api/admin/analytics) returns at most PostgREST's max-rows of the newest
// requests, so a period older than the oldest loaded filing date could not
// be counted. This read filters created_at ON THE SERVER and pages through
// the row limit (lib/reviewLaneReport.ts readReviewLanePeriod) until every
// request of the period is read — `complete` is false only past
// REVIEW_LANE_READ_CAP rows, and the panel then says so.
//
// The same gate as the analytics page (lib/adminGate.ts, the "analytics"
// surface: admin.analytics_view, fail closed), and the READ runs AS THE
// CALLER (their own bearer, RLS applied) — never wider than their own
// session, exactly like /api/admin/analytics. It reads only the columns the
// report needs (no comments, history or attachments). Nothing is written.

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { callerScopedClient } from "@/lib/serverAuth";
import { periodBound, readReviewLanePeriod } from "@/lib/reviewLaneReport";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const orgId = sp.get("orgId") || "";
  const actor = await authorizeAdminSurface(req, orgId, "analytics");
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  const rawFrom = (sp.get("from") || "").trim();
  const rawTo = (sp.get("to") || "").trim();
  const from = periodBound(rawFrom);
  const to = periodBound(rawTo);
  if ((rawFrom && !from) || (rawTo && !to)) {
    return NextResponse.json({ error: "from and to must be calendar dates (YYYY-MM-DD)" }, { status: 400 });
  }
  if (from && to && from > to) {
    return NextResponse.json({ error: "The period ends before it starts" }, { status: 400 });
  }

  const asCaller = callerScopedClient(req);
  if ("error" in asCaller) return NextResponse.json({ error: asCaller.error }, { status: asCaller.status });

  try {
    const out = await readReviewLanePeriod(asCaller as unknown as Parameters<typeof readReviewLanePeriod>[0], orgId, { from, to });
    return NextResponse.json({ tickets: out.rows, total: out.total, complete: out.complete });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "The period could not be read" }, { status: 500 });
  }
}
