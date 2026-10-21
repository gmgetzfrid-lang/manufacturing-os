// drafting-flow Round G, DF-P7 CONSENT — the wiring, pinned on code:
//   * ONE step in the maintenance cron (5c), NO new cron entry (vercel.json
//     keeps its two — a third fails every deployment on this plan);
//   * the request page mounts ConsentWindowCard ONCE, only behind
//     consentWindowMarker — and DF-P6's and DF-P17's page hunks stay intact;
//   * the card's headline reads the record honestly in every state.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { consentWindowHeadline } from "@/components/requests/ConsentWindowCard";
import type { TicketReviewRoster, TicketReviewSlot } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the cron: one step, no new entry", () => {
  it("vercel.json still has exactly its two cron entries", () => {
    const v = JSON.parse(src("vercel.json")) as { crons: Array<{ path: string }> };
    expect(v.crons.map((c) => c.path)).toEqual(["/api/data-export/run-scheduled", "/api/cron/maintenance"]);
  });
  it("the maintenance route calls runConsentWindowScan exactly once, bounded, and reports every line", () => {
    const r = src("app/api/cron/maintenance/route.ts");
    expect(r.match(/await runConsentWindowScan\(/g)).toHaveLength(1);
    expect(r).toContain("const consentDeadlineAt = Math.min(Date.now() + CONSENT_WINDOW_MS, runEnd - TICKET_SLA_RESERVE_MS);");
    expect(r).toContain("for (const line of cwErrors) { result.errors.push(line); console.error(`[cron/maintenance] ${line}`); }");
    // after the SLA step (DF-P3's), before the acl rebuild
    expect(r.indexOf("await runTicketSlaScan(")).toBeLessThan(r.indexOf("await runConsentWindowScan("));
    expect(r.indexOf("await runConsentWindowScan(")).toBeLessThan(r.indexOf("await rebuildAclIndexes("));
  });
});

describe("the request page: one mount, behind the marker; the DF-P6 / DF-P17 hunks intact", () => {
  const page = src("app/(protected)/requests/[id]/page.tsx");
  it("ConsentWindowCard is mounted once, only when the ticket carries a window", () => {
    expect(page.match(/<ConsentWindowCard /g)).toHaveLength(1);
    expect(page).toContain("{consentWindowMarker(ticket) && <div className=\"max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 pt-6\"><ConsentWindowCard ticket={ticket} uid={uid} /></div>}");
  });
  it("DF-P6's hunks (DeclarationCard, the declaration check fed to the roster panel, the review-model fields) and DF-P17's waiting-on line are still there", () => {
    expect(page).toContain("<DeclarationCard ticket={ticket} onDeclarationCheck={setDeclarationCheck} />");
    expect(page).toContain("<TicketRosterPanel ticket={ticketAsDeclarationChecked(ticket, declarationCheck)}");
    expect(page).toContain("...reviewModelFieldsFromRow(r),");
    expect(page).toContain("const holders = holdersFor(ticket, { queueNames, requesterRoles, memberNames: rosterNames, activeMemberCount });");
  });
});

describe("the card's headline", () => {
  const ops = (over: Partial<TicketReviewSlot> = {}): TicketReviewSlot => ({
    id: "r:ops", kind: "ops", label: "Operations", mode: "consent_window", primaries: ["o-1"], alternates: [], overriders: [], independentOf: [],
    timeoutDays: null, fallback: false, status: "open", ...over,
  });
  const r = (slot: TicketReviewSlot, w: Record<string, unknown> = {}, over: Partial<TicketReviewRoster> = {}) => ({
    slots: [slot], closedAt: null, closedReason: null,
    consentWindow: { slot: "ops", openedAt: "2026-10-19T09:00:00Z", warnAt: "2026-10-21T09:00:00Z", closesAt: "2026-10-22T09:00:00Z", recipients: ["o-1"], ...w },
    ...over,
  }) as Pick<TicketReviewRoster, "consentWindow" | "slots" | "closedAt" | "closedReason">;
  it("running, objected, advanced, held, signed, closed — each said as the record reads", () => {
    expect(consentWindowHeadline(r(ops()))).toBe('"Operations" goes ahead without objection when the window closes 2026-10-22 09:00 UTC.');
    expect(consentWindowHeadline(r(ops(), { objectedAt: "2026-10-20T10:00:00Z" }))).toMatch(/objected to 2026-10-20 10:00 UTC — it waits for a sign-off/);
    expect(consentWindowHeadline(r(ops({ status: "satisfied", via: "consent", satisfiedAt: "2026-10-23T03:00:00Z" }), { expiredAt: "2026-10-23T03:00:00Z" }))).toMatch(/closed 2026-10-23 03:00 UTC with no objection — recorded as given without objection/);
    expect(consentWindowHeadline(r(ops(), { expiredAt: "2026-10-23T03:00:00Z" }))).toMatch(/still needs a sign-off/);
    expect(consentWindowHeadline(r(ops({ status: "satisfied", via: "primary" })))).toMatch(/signed off before the window closed/);
    expect(consentWindowHeadline(r(ops({ status: "void" }), {}, { closedAt: "2026-10-20T00:00:00Z", closedReason: "request_revision" }))).toMatch(/the review closed \(request_revision\) before the window did/);
    expect(consentWindowHeadline(null)).toBeNull();
  });
});
