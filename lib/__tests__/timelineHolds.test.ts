// Document-control Round F — HLD-11 / DCK-12 / DCK-9 (renderers).
//
//   HLD-11  the document timeline dedups hold history by HOLD ID, not by
//           action name — a HOLD_OPENED / HOLD_RELEASED audit row whose
//           mutable document_holds row was deleted still renders, as an
//           explicit "hold record removed" event; released_reason is in the
//           release summary line.
//   DCK-12  FIELD_VERIFIED is legible in every audit renderer (timeline
//           summary, the activity pulse's lock bucket, admin/audit's chip
//           map, TimelineFeed's icon map).
//   DCK-9   the legacy CHECKOUT_RELEASED action (the stale banner's old
//           write) reads as a check-in; nothing writes it any more.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { mergeHoldHistory, summarizeAudit, HOLD_RECORD_REMOVED, type AuditRow, type HoldRow } from "@/lib/timeline";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const audit = (over: Partial<AuditRow>): AuditRow => ({
  id: "a1", action: "HOLD_OPENED", resource_id: "d1", resource_type: "document", org_id: "o1",
  user_id: "u1", user_email: "u1@x.io", user_role: "DocCtrl", details: null, metadata: null,
  timestamp: "2026-09-01T10:00:00Z", ...over,
});
const hold = (over: Partial<HoldRow>): HoldRow => ({
  id: "h1", org_id: "o1", document_id: "d1", reason: "Field Verification Needed", notes: null,
  expected_release_at: null, opened_by: "u1", opened_by_name: "ann", opened_at: "2026-09-01T10:00:00Z",
  released_by: null, released_by_name: null, released_at: null, released_reason: null, ...over,
});

describe("mergeHoldHistory (HLD-11)", () => {
  it("an audit row whose hold row SURVIVES is dropped — the row renders the fact once", () => {
    const { auditEvents, holdEvents } = mergeHoldHistory(
      [audit({ details: { holdId: "h1", reason: "Field Verification Needed" } })],
      [hold({})],
    );
    expect(auditEvents).toEqual([]);
    expect(holdEvents.map((e) => e.action)).toEqual(["HOLD_OPENED"]);
  });

  it("an audit row whose hold row is GONE renders as an explicit 'hold record removed' event, in the hold lane", () => {
    const { auditEvents } = mergeHoldHistory(
      [
        audit({ id: "a1", action: "HOLD_OPENED", details: { holdId: "deleted-hold", reason: "Field Verification Needed" } }),
        audit({ id: "a2", action: "HOLD_RELEASED", timestamp: "2026-09-03T10:00:00Z", details: { holdId: "deleted-hold", reason: "Field Verification Needed", releasedReason: "walkdown done" } }),
      ],
      [],
    );
    expect(auditEvents).toHaveLength(2);
    for (const e of auditEvents) {
      expect(e.kind).toBe("hold");
      expect(e.action).toBe(HOLD_RECORD_REMOVED);
      expect(e.summary).toMatch(/hold record removed/);
      expect(e.details).toMatchObject({ holdId: "deleted-hold", holdRecordRemoved: true });
    }
    expect(auditEvents[0].summary).toMatch(/^Hold opened — Field Verification Needed — hold record removed/);
    expect(auditEvents[0].details).toMatchObject({ originalAction: "HOLD_OPENED" });
    expect(auditEvents[1].summary).toBe('Hold released — Field Verification Needed — "walkdown done" — hold record removed');
    // the actor survives on the audit twin — the reviewer sees WHO placed it
    expect(auditEvents[0].userId).toBe("u1");
    expect(auditEvents[0].userEmail).toBe("u1@x.io");
  });

  it("dedup is by id, not by name: a surviving OTHER hold does not hide the deleted one", () => {
    const { auditEvents, holdEvents } = mergeHoldHistory(
      [
        audit({ id: "a1", details: { holdId: "h1", reason: "Awaiting Engineering" } }),
        audit({ id: "a2", details: { holdId: "h-deleted", reason: "Field Verification Needed" } }),
      ],
      [hold({ id: "h1", reason: "Awaiting Engineering" })],
    );
    expect(auditEvents.map((e) => e.details?.holdId)).toEqual(["h-deleted"]);
    expect(holdEvents.map((e) => e.details?.holdId)).toEqual(["h1"]);
  });

  it("an audit row with no holdId cannot be correlated and is kept as an ordinary audit event (never silently dropped)", () => {
    const { auditEvents } = mergeHoldHistory([audit({ details: { reason: "legacy" } })], [hold({})]);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].kind).toBe("audit");
    expect(auditEvents[0].action).toBe("HOLD_OPENED");
  });

  it("non-hold audit rows pass through untouched", () => {
    const { auditEvents } = mergeHoldHistory([audit({ action: "CHECK_OUT", details: null })], []);
    expect(auditEvents.map((e) => [e.kind, e.action, e.summary])).toEqual([["audit", "CHECK_OUT", "Checked out"]]);
  });

  it("released_reason is in the release event's SUMMARY line, not only in details", () => {
    const { holdEvents } = mergeHoldHistory([], [hold({ released_at: "2026-09-04T10:00:00Z", released_by: "u2", released_by_name: "bob", released_reason: "vendor data received" })]);
    const release = holdEvents.find((e) => e.action === "HOLD_RELEASED");
    expect(release?.summary).toBe('Hold released — Field Verification Needed (3d) — "vendor data received"');
    expect(release?.details).toMatchObject({ releasedReason: "vendor data received", durationDays: 3 });
    const { holdEvents: bare } = mergeHoldHistory([], [hold({ released_at: "2026-09-04T10:00:00Z" })]);
    expect(bare.find((e) => e.action === "HOLD_RELEASED")?.summary).toBe("Hold released — Field Verification Needed (3d)");
  });

  it("the two timeline builders both route holds through mergeHoldHistory; the by-name filter is gone", () => {
    const t = src("lib/timeline.ts");
    expect(t.match(/mergeHoldHistory\(/g)?.length).toBeGreaterThanOrEqual(3); // definition + 2 call sites
    expect(t).not.toMatch(/\.filter\(\(r\) => r\.action !== "HOLD_OPENED" && r\.action !== "HOLD_RELEASED"\)/);
  });
});

describe("audit renderers know the register vocabulary (DCK-12 / DCK-9)", () => {
  it("summarizeAudit: FIELD_VERIFIED names the revision; CHECKOUT_RELEASED (legacy) and auto-released CHECK_IN read as check-ins", () => {
    expect(summarizeAudit({ action: "FIELD_VERIFIED", details: { rev: "4" } })).toBe("Field verified against Rev 4");
    expect(summarizeAudit({ action: "FIELD_VERIFIED", details: null })).toBe("Field verified");
    expect(summarizeAudit({ action: "CHECKOUT_RELEASED", details: { via: "stale_checkout_banner" } })).toBe("Checked in (released from the stale-checkout banner)");
    expect(summarizeAudit({ action: "CHECK_IN", details: { outcome: "auto_released" } })).toBe("Checked in (auto-released)");
    expect(summarizeAudit({ action: "CHECK_IN", details: { outcome: "all_clear" } })).toBe("Checked in");
  });

  it("the activity pulse counts FIELD_VERIFIED and legacy CHECKOUT_RELEASED as lock events", () => {
    const page = src("app/(protected)/activity/page.tsx");
    const bucket = page.match(/else if \(\[([^\]]+)\]\.includes\(r\.action\)\) cat\.locks\+\+;/);
    expect(bucket, "the locks bucket line").not.toBeNull();
    expect(bucket![1]).toContain('"FIELD_VERIFIED"');
    expect(bucket![1]).toContain('"CHECKOUT_RELEASED"');
  });

  it("admin/audit's chip map and TimelineFeed's icon map carry FIELD_VERIFIED", () => {
    expect(src("app/(protected)/admin/audit/page.tsx")).toMatch(/^\s*FIELD_VERIFIED:\s*\{ icon: /m);
    expect(src("components/documents/TimelineFeed.tsx")).toMatch(/case "FIELD_VERIFIED":/);
  });

  it("nothing writes CHECKOUT_RELEASED any more; the stale banner releases through finishMySession with an outcome and a CHECK_IN row", () => {
    const banner = src("components/projects/StaleCheckoutBanner.tsx");
    expect(banner).not.toMatch(/action: "CHECKOUT_RELEASED"/);
    expect(banner).toMatch(/await finishMySession\(\{/);
    expect(banner).toMatch(/outcome: \{ outcome: "all_clear", note: null, ref: null \}/);
    expect(banner).toMatch(/type: "CHECK_IN"/);
    expect(banner).not.toMatch(/from\("checkout_sessions"\)\.update/);
    const writers = execSync(`grep -rln 'action: "CHECKOUT_RELEASED"' app components lib --include=*.ts --include=*.tsx | grep -v __tests__ || true`, { cwd: process.cwd() }).toString().trim();
    expect(writers).toBe("");
  });
});
