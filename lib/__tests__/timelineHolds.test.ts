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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// A recording supabase mock for the BUILDER tests: static rows per table,
// filtered by eq/in, sorted by order(), cut by limit() — so a paged holds
// query can be made to miss a row that still exists.
const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));
function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  let order: [string, boolean] | null = null;
  let limit: number | null = null;
  const result = () => {
    let out = (state.rows[table] ?? []).filter((r) => filters.every(([k, v]) =>
      k.startsWith("in:") ? (v as unknown[]).includes(r[k.slice(3)]) : r[k] === v));
    if (order) {
      const [col, asc] = order;
      out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : String(a[col]) > String(b[col]) ? (asc ? 1 : -1) : 0));
    }
    if (limit !== null) out = out.slice(0, limit);
    return out;
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: result(), error: null });
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "eq") filters.push([String(args[0]), args[1]]);
        if (prop === "in") filters.push([`in:${String(args[0])}`, args[1]]);
        if (prop === "order") order = [String(args[0]), (args[1] as { ascending?: boolean } | undefined)?.ascending !== false];
        if (prop === "limit") limit = Number(args[0]);
        if (prop === "maybeSingle") return Promise.resolve({ data: result()[0] ?? null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));

import {
  mergeHoldHistory, holdIdsReferencedBy, getDocumentTimeline, getProjectTimeline,
  summarizeAudit, HOLD_RECORD_REMOVED, type AuditRow, type HoldRow,
} from "@/lib/timeline";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
beforeEach(() => { state.rows = {}; state.calls = []; });

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
      new Set(["h1"]),
    );
    expect(auditEvents).toEqual([]);
    expect(holdEvents.map((e) => e.action)).toEqual(["HOLD_OPENED"]);
  });

  it("an audit row whose hold row is GONE (confirmed by the lookup) renders as an explicit 'hold record removed' event, in the hold lane", () => {
    const { auditEvents } = mergeHoldHistory(
      [
        audit({ id: "a1", action: "HOLD_OPENED", details: { holdId: "deleted-hold", reason: "Field Verification Needed" } }),
        audit({ id: "a2", action: "HOLD_RELEASED", timestamp: "2026-09-03T10:00:00Z", details: { holdId: "deleted-hold", reason: "Field Verification Needed", releasedReason: "walkdown done" } }),
      ],
      [],
      new Set(), // the targeted lookup found nothing
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
      new Set(["h1"]),
    );
    expect(auditEvents.map((e) => e.details?.holdId)).toEqual(["h-deleted"]);
    expect(auditEvents[0].action).toBe(HOLD_RECORD_REMOVED);
    expect(holdEvents.map((e) => e.details?.holdId)).toEqual(["h1"]);
  });

  it("an audit row with no holdId cannot be correlated and is kept as an ordinary audit event (never silently dropped)", () => {
    const { auditEvents } = mergeHoldHistory([audit({ details: { reason: "legacy" } })], [hold({})], new Set(["h1"]));
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].kind).toBe("audit");
    expect(auditEvents[0].action).toBe("HOLD_OPENED");
  });

  it("non-hold audit rows pass through untouched", () => {
    const { auditEvents } = mergeHoldHistory([audit({ action: "CHECK_OUT", details: null })], [], new Set());
    expect(auditEvents.map((e) => [e.kind, e.action, e.summary])).toEqual([["audit", "CHECK_OUT", "Checked out"]]);
  });

  it("released_reason is in the release event's SUMMARY line, not only in details", () => {
    const { holdEvents } = mergeHoldHistory([], [hold({ released_at: "2026-09-04T10:00:00Z", released_by: "u2", released_by_name: "bob", released_reason: "vendor data received" })], new Set(["h1"]));
    const release = holdEvents.find((e) => e.action === "HOLD_RELEASED");
    expect(release?.summary).toBe('Hold released — Field Verification Needed (3d) — "vendor data received"');
    expect(release?.details).toMatchObject({ releasedReason: "vendor data received", durationDays: 3 });
    const { holdEvents: bare } = mergeHoldHistory([], [hold({ released_at: "2026-09-04T10:00:00Z" })], new Set(["h1"]));
    expect(bare.find((e) => e.action === "HOLD_RELEASED")?.summary).toBe("Hold released — Field Verification Needed (3d)");
  });

  it("absence from the holds PAGE is not deletion: a hold the lookup confirms exists renders as a plain audit event, never 'record removed'", () => {
    const { auditEvents } = mergeHoldHistory(
      [audit({ id: "a2", action: "HOLD_RELEASED", details: { holdId: "h-old", reason: "Awaiting Engineering", releasedReason: "package issued" } })],
      [hold({ id: "h-new" })],       // the page is full of newer holds
      new Set(["h-old"]),            // …but h-old is still there
    );
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].kind).toBe("audit");
    expect(auditEvents[0].action).toBe("HOLD_RELEASED");
    expect(auditEvents[0].summary).not.toMatch(/record removed/);
    expect(auditEvents[0].details).not.toHaveProperty("holdRecordRemoved");
  });

  it("with no lookup run (null) nothing is ever declared removed", () => {
    const { auditEvents } = mergeHoldHistory([audit({ details: { holdId: "h-?", reason: "x" } })], [], null);
    expect(auditEvents.map((e) => [e.kind, e.action])).toEqual([["audit", "HOLD_OPENED"]]);
  });

  it("holdIdsReferencedBy collects the distinct holdIds of the hold audit rows only", () => {
    expect(holdIdsReferencedBy([
      audit({ id: "a1", details: { holdId: "h1" } }),
      audit({ id: "a2", action: "HOLD_RELEASED", details: { holdId: "h1" } }),
      audit({ id: "a3", action: "HOLD_RELEASED", details: { holdId: "h2" } }),
      audit({ id: "a4", action: "CHECK_OUT", details: { holdId: "not-a-hold-row" } }),
      audit({ id: "a5", details: { reason: "no id" } }),
    ])).toEqual(["h1", "h2"]);
  });

  it("the two timeline builders both route holds through mergeHoldHistory; the by-name filter is gone", () => {
    const t = src("lib/timeline.ts");
    expect(t.match(/mergeHoldHistory\(/g)?.length).toBeGreaterThanOrEqual(3); // definition + 2 call sites
    expect(t).not.toMatch(/\.filter\(\(r\) => r\.action !== "HOLD_OPENED" && r\.action !== "HOLD_RELEASED"\)/);
  });
});

describe("VFY-6 (P15) — the timeline names a custom (Other) hold by its description", () => {
  it("the hold row's opened and released lines name an Other hold by its note; a predefined hold reads exactly as before", () => {
    const { holdEvents } = mergeHoldHistory([], [
      hold({ id: "h-o", reason: "Other", notes: " waiting on vendor weld map ", released_at: "2026-09-04T10:00:00Z", released_reason: "map received" }),
      hold({ id: "h-p", reason: "Client Review", notes: "see RFI 12", released_at: "2026-09-04T10:00:00Z" }),
      hold({ id: "h-n", reason: "Other", notes: null }),
    ], new Set(["h-o", "h-p", "h-n"]));
    expect(holdEvents.map((e) => e.summary)).toEqual([
      "Hold opened — Other: waiting on vendor weld map",
      'Hold released — Other: waiting on vendor weld map (3d) — "map received"',
      "Hold opened — Client Review",
      "Hold released — Client Review (3d)",
      "Hold opened — Other", // an Other hold with no note (placed before P15's description rule)
    ]);
    // details keep the stored reason (a consumer may read it)
    expect(holdEvents[0].details).toMatchObject({ reason: "Other", notes: " waiting on vendor weld map " });
    expect(holdEvents[1].details).toMatchObject({ reason: "Other" });
  });

  it("the record-removed fallback names an Other hold by the audit row's notes; a predefined hold, or an Other row with no notes, as before", () => {
    const { auditEvents } = mergeHoldHistory([
      audit({ id: "a1", action: "HOLD_OPENED", details: { holdId: "gone", reason: "Other", notes: "crane survey pending" } }),
      audit({ id: "a2", action: "HOLD_RELEASED", details: { holdId: "gone", reason: "Other", notes: "crane survey pending", releasedReason: "survey done" } }),
      audit({ id: "a3", action: "HOLD_RELEASED", details: { holdId: "gone-2", reason: "Other", releasedReason: "cleared" } }),
      audit({ id: "a4", action: "HOLD_OPENED", details: { holdId: "gone-3", reason: "Client Review", notes: "see RFI 12" } }),
    ], [], new Set());
    expect(auditEvents.map((e) => e.summary)).toEqual([
      "Hold opened — Other: crane survey pending — hold record removed (the audit row is the only surviving evidence)",
      'Hold released — Other: crane survey pending — "survey done" — hold record removed',
      'Hold released — Other — "cleared" — hold record removed',
      "Hold opened — Client Review — hold record removed (the audit row is the only surviving evidence)",
    ]);
    // the audit row's own reason is untouched in details
    expect(auditEvents[0].details).toMatchObject({ reason: "Other", notes: "crane survey pending", holdRecordRemoved: true });
  });
});

describe("the builders confirm deletion with a targeted lookup, not with the page (HLD-11 review fix)", () => {
  // h-old: opened in January, released in September → its HOLD_RELEASED audit
  // row is the newest audit row, its hold row the OLDEST on the document.
  const hOld = { id: "h-old", org_id: "o1", document_id: "d1", reason: "Awaiting Engineering", notes: null, expected_release_at: null,
    opened_by: "u1", opened_by_name: "ann", opened_at: "2026-01-05T10:00:00Z", released_by: "u2", released_by_name: "bob",
    released_at: "2026-09-20T10:00:00Z", released_reason: "package issued" };
  const hNew = { ...hOld, id: "h-new", reason: "Field Verification Needed", opened_at: "2026-09-10T10:00:00Z", released_by: null, released_by_name: null, released_at: null, released_reason: null };
  const releasedAudit = { id: "a-rel", action: "HOLD_RELEASED", resource_id: "d1", resource_type: "document", org_id: "o1", user_id: "u2",
    user_email: "bob@x.io", user_role: "DocCtrl", details: { holdId: "h-old", reason: "Awaiting Engineering", releasedReason: "package issued" }, metadata: null,
    timestamp: "2026-09-20T10:00:00Z" };
  const lookups = () => state.calls.filter((c) => c.table === "document_holds" && c.method === "in" && c.args[0] === "id").map((c) => c.args[1]);

  it("document timeline: a hold outside the holds page but still in the table is NOT 'record removed' — it is looked up by id", async () => {
    state.rows.audit_logs = [releasedAudit];
    state.rows.document_holds = [hOld, hNew];
    const events = await getDocumentTimeline({ documentId: "d1", limit: 1 }); // the holds page holds only h-new
    expect(events.some((e) => e.action === HOLD_RECORD_REMOVED)).toBe(false);
    const rel = events.find((e) => e.id === "audit:a-rel");
    expect(rel).toMatchObject({ kind: "audit", action: "HOLD_RELEASED" });
    expect(lookups()).toEqual([["h-old"]]); // only the id the page lacked
  });

  it("document timeline: the same audit row whose hold row is genuinely gone IS 'record removed'", async () => {
    state.rows.audit_logs = [releasedAudit];
    state.rows.document_holds = [hNew]; // h-old deleted
    const events = await getDocumentTimeline({ documentId: "d1", limit: 1 });
    const rel = events.find((e) => e.id === "audit:a-rel");
    expect(rel).toMatchObject({ kind: "hold", action: HOLD_RECORD_REMOVED });
    expect(rel?.summary).toBe('Hold released — Awaiting Engineering — "package issued" — hold record removed');
    expect(lookups()).toEqual([["h-old"]]);
  });

  it("document timeline: when every referenced hold is on the page no lookup is issued", async () => {
    state.rows.audit_logs = [releasedAudit];
    state.rows.document_holds = [hOld, hNew];
    const events = await getDocumentTimeline({ documentId: "d1" });
    expect(events.find((e) => e.id === "audit:a-rel")).toBeUndefined(); // the row renders it
    expect(events.filter((e) => e.kind === "hold").map((e) => e.action).sort()).toEqual(["HOLD_OPENED", "HOLD_OPENED", "HOLD_RELEASED"]);
    expect(lookups()).toEqual([]);
  });

  it("project timeline: the pooled holds page of a busy project does not turn a surviving hold into 'record removed'", async () => {
    state.rows.project_documents = [{ project_id: "p1", document_id: "d1" }, { project_id: "p1", document_id: "d2" }];
    state.rows.project_activity = [];
    state.rows.audit_logs = [releasedAudit];
    state.rows.document_holds = [hOld, hNew, { ...hNew, id: "h-d2", document_id: "d2", opened_at: "2026-09-11T10:00:00Z" }];
    const events = await getProjectTimeline({ projectId: "p1", limit: 2 }); // the pooled page: h-d2, h-new
    expect(events.some((e) => e.action === HOLD_RECORD_REMOVED)).toBe(false);
    expect(lookups()).toEqual([["h-old"]]);
    state.calls = [];
    state.rows.document_holds = state.rows.document_holds.filter((h) => h.id !== "h-old");
    const gone = await getProjectTimeline({ projectId: "p1", limit: 2 });
    expect(gone.find((e) => e.id === "audit:a-rel")).toMatchObject({ action: HOLD_RECORD_REMOVED });
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
