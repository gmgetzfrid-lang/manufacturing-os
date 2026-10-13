// lib/complianceNotifyScope.ts
//
// SERVER-ONLY. One cron compliance scan's collector for lib/complianceNotify
// (notifications Round G, N14 fix pass — DELIV-7 done-when 1, DELIV-16).
//
// The step-6 scans write their notices through notifyCompliance on the
// shared client. What a scan's notices LOST (dead-lettered) is reported in
// the run's errors under that scan and org. A module-wide list would also
// collect what any other request on the same instance lost meanwhile
// (Vercel fluid compute, a long-lived Node process); AsyncLocalStorage scopes
// the collector to the async context the scan runs in, as
// lib/serverClientScope.ts scopes the service-role client. The same scope
// carries the run's retry deadline: past it a failing notice is not retried,
// so a systematic refusal cannot spend the time of the steps after step 6.
//
// Never import this from a client component — node:async_hooks does not
// exist in the browser.

import { AsyncLocalStorage } from "node:async_hooks";
import { __registerComplianceScope, type ComplianceScope, type ComplianceNoticeTally } from "@/lib/complianceNotify";

const scope = new AsyncLocalStorage<ComplianceScope>();
__registerComplianceScope(() => scope.getStore());

/**
 * Run one compliance scan with its own collector; answer the scan's count
 * (what the scan returns: the rows — roster rows, documents, libraries — it
 * sent notices for, ATTEMPTED). Its dead-lettered notices are ONE line in
 * `errors` under `label` (written whether the scan returns or throws — a
 * throw is re-raised for the caller's own line), and a note the scan raised
 * (a retry plan it could not read) is a line too. `deadlineMs` (epoch ms, or
 * null): no retry past it. `tally` (optional): the scan's bell notices are
 * added to it — attempted, delivered (landed) and dead-lettered (DELIV-7:
 * the count of notices that reached someone, labelled apart from the count
 * of rows attempted).
 *
 * Call it only where the shared client is the SERVICE ROLE (the cron's step
 * 6): inside the scope a failed notice is read back and retried on the
 * premise that the read sees every row.
 */
export async function runComplianceScan(
  label: string,
  fn: () => Promise<number>,
  errors: string[],
  deadlineMs: number | null,
  tally?: ComplianceNoticeTally,
): Promise<number> {
  const store: ComplianceScope = { lost: [], lostCount: 0, lostRetried: 0, deadlineMs, attempted: 0, delivered: 0, notes: [] };
  try {
    return await scope.run(store, fn);
  } finally {
    for (const note of store.notes) errors.push(`${label}: ${note}`);
    const first = store.lost[0];
    if (store.lostCount > 0 && first) {
      const again = store.lostRetried === 0 ? ""
        : store.lostRetried === store.lostCount ? "; the next run sends them again"
          : `; the next run sends ${store.lostRetried} of them again`;
      errors.push(`${label}: ${store.lostCount} compliance notice(s) were not written (dead-lettered to the audit log${again}; the scan's count still includes them) — e.g. ${first.kind} to ${first.userId}: ${first.error}`);
    }
    if (tally) {
      tally.attempted += store.attempted;
      tally.delivered += store.delivered;
      tally.deadLettered += store.lostCount;
    }
  }
}
