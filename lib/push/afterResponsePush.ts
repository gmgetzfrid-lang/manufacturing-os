// lib/push/afterResponsePush.ts
//
// SERVER-ONLY. OS-16 (the integrator's ruling R4 at the notifications N17
// merge, DEC-90): the server push sender a route hands a producer that
// writes its bell rows outside emit() — today the intake door's auto-publish,
// whose read-&-understood roster (lib/postPublish.ts → lib/acknowledgments.ts
// recomputeDocumentAck) is opened on the server.
//
// lib/notify/dispatch.ts pushAfterBellRows calls the sender only AFTER the
// roster's bell rows landed, naming only the recipients whose row landed.
// This schedules lib/push/sendPush.ts sendPushSafe with next/server after(),
// so the route's response never waits on a push service (the ticket routes'
// pattern, OS-14), and names the roster's actor as `writerUid` when there is
// one, so the sender reads only that writer's bell rows and DEC-108's
// per-writer cap (PUSH_WRITER_CAP per PUSH_WRITER_WINDOW_MS) bounds a burst.
// The sender re-checks the bell row, push_enabled, membership and the device
// itself and never throws. Bell rows and emails are never touched here.
//
// Not imported by any browser module: lib/postPublish.ts only carries the
// sender its caller passes (PostPublishInput.serverPush).

import { after } from "next/server";
import type { PushSender } from "@/lib/notify/dispatch";

/** A server push sender that schedules the push after the response, with
 *  `writerUid` (the roster's actor) when given. `where` labels the log line.
 *  Never throws: an after() that cannot schedule (outside a request) is
 *  logged and nothing is pushed. */
export function afterResponsePush(writerUid: string | null, where: string): PushSender {
  return async (input) => {
    try {
      after(async () => {
        // loaded here: web-push and the service role are needed only once
        // there is something to push
        const { sendPushSafe } = await import("@/lib/push/sendPush");
        await sendPushSafe({ ...input, ...(writerUid ? { writerUid } : {}) });
      });
    } catch (e) {
      console.warn(`[${where}] the ${input.kind} push was not scheduled (the action, its bell rows and emails are unaffected):`, (e as Error)?.message ?? e);
    }
  };
}
