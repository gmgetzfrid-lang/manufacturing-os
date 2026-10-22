// lib/noticeRecordAfterResponse.ts
//
// SERVER-ONLY. document-control Round G — P39 merge-time fix (DIST-20;
// DEC-90: bookkeeping never delays a user's action). The scheduler a server
// route a person waits on hands a request path, so the document notice
// record write (lib/documentNoticeRecord.ts recordRequestNotices —
// verifiedRequestRows and noticeRecorder) runs AFTER the route's response:
// today the intake door's auto-publish, whose read-&-understood roster
// (lib/postPublish.ts → lib/acknowledgments.ts recomputeDocumentAck) is
// opened on the server. lib/push/afterResponsePush.ts's pattern.
//
// next/server after() runs the job in the async context it was scheduled
// from (Next binds an AsyncLocalStorage snapshot), so the service-role
// binding of the shared client (lib/serverClientScope.ts runWithServerClient)
// is the one the job sees. Outside a request (after() cannot schedule) the
// job is started without being awaited, and said. Never throws; the bell
// rows, emails, pushes and the roster are never touched here.
//
// Not imported by any browser module: lib/postPublish.ts only carries the
// scheduler its caller passes (PostPublishInput.serverRecord).

import { after } from "next/server";
import type { NoticeRecordScheduler } from "@/lib/documentNoticeRecord";

/** A scheduler that runs the record write after the response. `where`
 *  labels the log line. Never throws. */
export function afterResponseNoticeRecord(where: string): NoticeRecordScheduler {
  return (job) => {
    const run = async () => {
      try { await job(); } catch (e) {
        console.warn(`[${where}] the document notice record write failed (the notices were sent as before):`, (e as Error)?.message ?? e);
      }
    };
    try {
      after(run);
    } catch (e) {
      console.warn(`[${where}] the document notice record write could not be scheduled after the response — started now, not awaited:`, (e as Error)?.message ?? e);
      void run();
    }
  };
}
