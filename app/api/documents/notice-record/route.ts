// POST /api/documents/notice-record — document-control Round G, P39 NOTICE
// RECORD REQUESTS (DIST-20): the browser's door into the document notice
// record (document_notice_events, 20261257).
//
// The request paths and the manual reminders run in the browser
// (lib/distributionAcks.ts requestAcks / renudgeUnacked,
// lib/acknowledgments.ts recomputeDocumentAck / nudgeAcknowledgment,
// lib/reviewControl.ts openReviewRoster / activateAlternate), and the record
// has no client write (20261257: no INSERT grant, no write policy). After a
// path's bell rows landed, lib/documentNoticeRecord.ts recordRequestNotices
// posts here. The route VERIFIES before it writes anything as the service
// role:
//   * a valid session and an ACTIVE membership of the workspace named
//     (lib/serverAuth.ts authorizeOrgRole, any role — any member may request
//     a confirmation, distribution_acks_org_insert);
//   * the caller can read the document, as their own session would
//     (callerScopedClient — the documents policies, ACL included);
//   * a bounded body (NOTICE_RECORD_MAX_BODY, REQUEST_NOTICE_MAX notices,
//     known kinds and sources, ids that are UUIDs — parseRequestNoticeBody);
//   * every row is built from the BELL ROW that landed, read here
//     (verifiedRequestRows): this document's, that person's, of the notice's
//     kind, written by the caller (never a row with no actor — a scan's),
//     within NOTICE_VERIFY_WINDOW_MS, and not already on the record under a
//     scan's row — never from what the body claims. The body's `since` is
//     the browser's clock and is ignored when later than the server's; the
//     subject is the recipient and the details are `manual` alone (P39 fix
//     pass); the obligation row's own state must support the notice — an
//     activation only of an activated alternate slot on the draft under
//     review, a request or reminder only of an open obligation — and the
//     row's actor_name is the verified caller (actor.email), never the bell
//     row's free-text actor_name (P39 second fix pass). noticed_at is the
//     bell row's created_at; the row id is derived from the bell row's id,
//     so a repeat writes nothing twice.
// The rows are written by noticeRecorder with the shared client bound to the
// service role for this request (runWithServerClient): checked, retried once,
// and deferred to one DOCUMENT_NOTICE_RECORD_DEFERRED audit row (the system
// actor) that the source's next daily scan replays — exactly as the scans'
// own rows (P38). Before 20261257 is pasted the record is missing: 200 with
// outcome "missing" — nothing written, the caller keeps today's path.
//
// Merge-time fix (DEC-90: bookkeeping never delays a user's action): the
// browser never waits on this route — it starts the post (fetch keepalive,
// bodies within its limit) and the action has already returned. A body may
// be one document's notices (as before) or `{ batch: [...] }` — several
// documents' (setAckPolicy gathers a save's notices and posts once):
// parseRequestNoticeBatch, one workspace, REQUEST_NOTICE_MAX notices in all.
// An entry whose document the caller cannot read is skipped and counted
// (`skippedEntries` / `skippedNotices` — nothing written for it); the rest are
// written; a request where no document is readable is refused (403).

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole, callerScopedClient } from "@/lib/serverAuth";
import { runWithServerClient } from "@/lib/serverClientScope";
import { ALL_ROLES } from "@/types/schema";
import { NOTICE_RECORD_MAX_BODY, noticeRecorder, parseRequestNoticeBatch, verifiedRequestRows, type NoticeWriteOutcome } from "@/lib/documentNoticeRecord";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => "");
  if (raw.length > NOTICE_RECORD_MAX_BODY) return NextResponse.json({ error: "Notice record request too large" }, { status: 413 });
  let parsed: unknown;
  try { parsed = JSON.parse(raw || "{}"); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const inputs = parseRequestNoticeBatch(parsed);
  if ("error" in inputs) return NextResponse.json({ error: inputs.error }, { status: 400 });
  const orgId = inputs[0].orgId;      // a batch names one workspace (parseRequestNoticeBatch)

  const actor = await authorizeOrgRole(req, orgId, ALL_ROLES as string[]);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  // the caller reads each document named as their own session would (ACL
  // included). An entry whose document the caller cannot read (or whose read
  // failed) is SKIPPED and counted — nothing is written for it, never a row
  // for a document the caller cannot read — and the rest are written; when
  // NO document named is readable, the request is refused as before (403, or
  // 500 when a read failed).
  const mine = callerScopedClient(req);
  if ("error" in mine) return NextResponse.json({ error: mine.error }, { status: mine.status });
  const readable = new Set<string>();
  let readError: string | null = null;
  for (const documentId of [...new Set(inputs.map((i) => i.documentId))]) {
    const { data: doc, error: docError } = await mine.from("documents").select("id, org_id").eq("id", documentId).maybeSingle();
    if (docError) { readError ??= docError.message; continue; }
    if (doc && (doc as { org_id?: string }).org_id === orgId) readable.add(documentId);
  }
  const todo = inputs.filter((i) => readable.has(i.documentId));
  const skipped = inputs.filter((i) => !readable.has(i.documentId));
  if (todo.length === 0) {
    if (readError) return NextResponse.json({ error: `the document could not be read: ${readError}` }, { status: 500 });
    return NextResponse.json({ error: "You can't read this document in this workspace" }, { status: 403 });
  }
  const skippedCounts = skipped.length === 0 ? {} : {
    skippedEntries: skipped.length,
    skippedNotices: skipped.reduce((n, i) => n + i.notices.length, 0),
  };

  try {
    const result = await runWithServerClient(actor.admin, async () => {
      const recorder = noticeRecorder();
      let rows = 0;
      let unmatched = 0;
      const outcomes: NoticeWriteOutcome[] = [];
      for (const input of todo) {
        const built = await verifiedRequestRows(actor.admin, input, { uid: actor.userId, name: actor.email || null });
        rows += built.rows.length;
        unmatched += built.unmatched;
        outcomes.push(await recorder.record(built.rows));
      }
      // the worst of the entries' outcomes (one entry: its own, as before)
      const outcome: NoticeWriteOutcome = (["lost", "deferred", "written", "missing"] as const).find((o) => outcomes.includes(o)) ?? "none";
      return { rows, unmatched, outcome, ...skippedCounts };
    });
    if (result.outcome === "lost") {
      return NextResponse.json({ error: "the notices could not be written to the record, nor kept for the next run", ...result }, { status: 500 });
    }
    return NextResponse.json({ ok: true, ...result }, { status: result.outcome === "written" ? 201 : 200 });
  } catch (e) {
    return NextResponse.json({ error: `the notices were not recorded: ${(e as Error)?.message ?? String(e)}` }, { status: 500 });
  }
}
