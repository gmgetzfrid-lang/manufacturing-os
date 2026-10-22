// drafting-flow Round G, DF-P25 — the DF-P22 follow-ups (a) and (d) on a
// standing pre-authorization's grantor membership (DEC-90 ruling (2) for
// DF-P25):
//   (a) org_members.status_changed_at (20261267 — a BEFORE UPDATE trigger
//       stamps every status change, whoever writes it) is read: a status
//       flipped straight on the table and flipped back, with no audit row,
//       now lapses the record. NULL = not changed since the column existed;
//       the audit rows stay the second source. Before the paste (42703 /
//       PGRST204 on the column) today's read is taken.
//   (d) the history window is computed from records still IN FORCE, and a
//       slice whose window holds more history than one read is read again
//       grantor by grantor (latest change only) — the Admin list never fails
//       on history volume.

import { describe, it, expect } from "vitest";
import { preauthGrantorMembership, readGrantorMemberships, isMissingStatusChangedAt, type Preauthorization } from "@/lib/ticketPreauthorization";

type Row = Record<string, unknown>;
const NOW = Date.parse("2026-10-22T12:00:00Z");
const ORG = "o1";
const rec = (id: string, grantorId: string, createdAt: string, extra: Partial<Preauthorization> = {}) =>
  ({ id, grantorId, createdAt, expiresAt: "2027-01-01T00:00:00Z", revokedAt: null, ...extra });

describe("(a) preauthGrantorMembership reads status_changed_at", () => {
  const p = { grantorId: "g1", createdAt: "2026-09-01T00:00:00Z" };
  const active = { status: "active", created_at: "2026-01-01T00:00:00Z" };
  it("a status change at or after the record's creation lapses it — even with no audit row (a direct flip and flip back)", () => {
    expect(preauthGrantorMembership(p, { ...active, status_changed_at: "2026-10-01T00:00:00Z" }, [])).toBe("lapsed");
    expect(preauthGrantorMembership(p, { ...active, status_changed_at: "2026-09-01T00:00:00Z" }, [])).toBe("lapsed");
  });
  it("a change before the record (or NULL — not changed since the column existed) keeps today's judgement", () => {
    expect(preauthGrantorMembership(p, { ...active, status_changed_at: "2026-08-31T23:59:59Z" }, [])).toBe("continuous");
    expect(preauthGrantorMembership(p, { ...active, status_changed_at: null }, [])).toBe("continuous");
    expect(preauthGrantorMembership(p, active, [])).toBe("continuous");
  });
  it("the audit rows remain a second source; an unreadable stamp is unproven", () => {
    expect(preauthGrantorMembership(p, { ...active, status_changed_at: null }, [{ resource_id: "g1", timestamp: "2026-09-15T00:00:00Z" }])).toBe("lapsed");
    expect(preauthGrantorMembership(p, { ...active, status_changed_at: "garbage" }, [])).toBe("unproven");
  });
  it("isMissingStatusChangedAt names only that column's absence", () => {
    expect(isMissingStatusChangedAt({ code: "42703", message: 'column org_members.status_changed_at does not exist' })).toBe(true);
    expect(isMissingStatusChangedAt({ code: "PGRST204", message: "Could not find the 'status_changed_at' column" })).toBe(true);
    expect(isMissingStatusChangedAt({ code: "42703", message: "column x does not exist" })).toBe(false);
    expect(isMissingStatusChangedAt({ code: "08006", message: "status_changed_at" })).toBe(false);
  });
});

/** A tiny PostgREST stand-in: select / eq / in / gte / order / limit. */
function fakeDb(tables: Record<string, Row[]>, opts: { missingChangedAt?: boolean } = {}) {
  const calls: Array<{ table: string; select: string; filters: string[]; limit?: number; order?: string }> = [];
  const from = (table: string) => {
    const call = { table, select: "", filters: [] as string[], limit: undefined as number | undefined, order: undefined as string | undefined };
    calls.push(call);
    const preds: Array<(r: Row) => boolean> = [];
    let desc = false;
    const q: Record<string, unknown> = {
      select: (c: string) => { call.select = c; return q; },
      eq: (k: string, v: unknown) => { call.filters.push(`eq:${k}`); preds.push((r) => r[k] === v); return q; },
      in: (k: string, vs: unknown[]) => { call.filters.push(`in:${k}`); preds.push((r) => vs.includes(r[k])); return q; },
      gte: (k: string, v: string) => { call.filters.push(`gte:${k}=${v}`); preds.push((r) => typeof r[k] === "string" && (r[k] as string) >= v); return q; },
      order: (k: string, o?: { ascending?: boolean }) => { call.order = k; desc = o?.ascending === false; return q; },
      limit: (n: number) => { call.limit = n; return q; },
      then: (resolve: (v: unknown) => void) => {
        if (table === "org_members" && opts.missingChangedAt && call.select.includes("status_changed_at")) {
          return resolve({ data: null, error: { code: "42703", message: "column org_members.status_changed_at does not exist" } });
        }
        let rows = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
        if (call.order) rows = [...rows].sort((a, b) => String(a[call.order!]).localeCompare(String(b[call.order!])) * (desc ? -1 : 1));
        if (call.limit !== undefined) rows = rows.slice(0, call.limit);
        const cols = call.select.split(",").map((c) => c.trim());
        return resolve({ data: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))), error: null });
      },
    };
    return q;
  };
  return { db: { from }, calls };
}

describe("(a) readGrantorMemberships reads the stamp, and falls back before the paste", () => {
  const member = (uid: string, extra: Row = {}) => ({ org_id: ORG, uid, status: "active", created_at: "2026-01-01T00:00:00Z", status_changed_at: null, ...extra });
  it("a grantor whose row was flipped and flipped back (stamped, no audit row) is lapsed; another is continuous", async () => {
    const { db } = fakeDb({
      org_members: [member("g1", { status_changed_at: "2026-10-01T00:00:00Z" }), member("g2")],
      audit_logs: [],
    });
    const r = await readGrantorMemberships(db, ORG, [rec("p1", "g1", "2026-09-01T00:00:00Z"), rec("p2", "g2", "2026-09-01T00:00:00Z")], NOW);
    expect(r.ok && Object.fromEntries(r.byId)).toEqual({ p1: "lapsed", p2: "continuous" });
  });
  it("before 20261267 the column is missing: today's read (no stamp), the audit rows decide — the same answer as before", async () => {
    const { db, calls } = fakeDb({ org_members: [member("g1")], audit_logs: [{ org_id: ORG, resource_id: "g1", action: "MEMBER_SUSPENDED", timestamp: "2026-09-10T00:00:00Z" }] }, { missingChangedAt: true });
    const r = await readGrantorMemberships(db, ORG, [rec("p1", "g1", "2026-09-01T00:00:00Z")], NOW);
    expect(r.ok && r.byId.get("p1")).toBe("lapsed");
    expect(calls.filter((c) => c.table === "org_members").map((c) => c.select)).toEqual(["uid, status, created_at, status_changed_at", "uid, status, created_at"]);
  });
});

describe("(d) the history window is the in-force records', and volume never refuses the list", () => {
  const member = (uid: string) => ({ org_id: ORG, uid, status: "active", created_at: "2020-01-01T00:00:00Z", status_changed_at: null });
  it("revoked / expired records are not judged and do not widen the window", async () => {
    const { db, calls } = fakeDb({ org_members: [member("g1")], audit_logs: [] });
    const r = await readGrantorMemberships(db, ORG, [
      rec("old-revoked", "g1", "2021-01-01T00:00:00Z", { revokedAt: "2021-02-01T00:00:00Z", expiresAt: "2021-12-01T00:00:00Z" }),
      rec("old-expired", "g1", "2022-01-01T00:00:00Z", { expiresAt: "2022-06-01T00:00:00Z" }),
      rec("live", "g1", "2026-09-01T00:00:00Z"),
    ], NOW);
    expect(r.ok && [...r.byId.keys()]).toEqual(["live"]);
    expect(calls.find((c) => c.table === "audit_logs")!.filters).toContain("gte:timestamp=2026-09-01T00:00:00.000Z");
  });
  it("nothing in force: no read at all", async () => {
    const { db, calls } = fakeDb({ org_members: [member("g1")], audit_logs: [] });
    const r = await readGrantorMemberships(db, ORG, [rec("x", "g1", "2021-01-01T00:00:00Z", { revokedAt: "2021-02-01T00:00:00Z" })], NOW);
    expect(r.ok && r.byId.size).toBe(0);
    expect(calls).toEqual([]);
  });
  it("a slice with more history than one read: each grantor's latest change is read instead — judged exactly, never an error", async () => {
    const noisy: Row[] = [];
    // 600 status changes for g1, all before its record; one for g2 after its record.
    for (let i = 0; i < 600; i++) noisy.push({ org_id: ORG, resource_id: "g1", action: i % 2 ? "MEMBER_SUSPENDED" : "MEMBER_RESTORED", timestamp: new Date(Date.parse("2026-01-02T00:00:00Z") + i * 60_000).toISOString() });
    noisy.push({ org_id: ORG, resource_id: "g2", action: "MEMBER_SUSPENDED", timestamp: "2026-10-05T00:00:00Z" });
    const { db, calls } = fakeDb({ org_members: [member("g1"), member("g2")], audit_logs: noisy });
    const r = await readGrantorMemberships(db, ORG, [rec("p1", "g1", "2026-09-01T00:00:00Z"), rec("p0", "g1", "2026-01-01T00:00:00Z"), rec("p2", "g2", "2026-09-01T00:00:00Z")], NOW);
    expect(r.ok).toBe(true);
    expect(r.ok && Object.fromEntries(r.byId)).toEqual({ p1: "continuous", p0: "lapsed", p2: "lapsed" });
    const perGrantor = calls.filter((c) => c.table === "audit_logs" && c.limit === 1);
    expect(perGrantor).toHaveLength(2);
    expect(perGrantor.every((c) => c.order === "timestamp")).toBe(true);
  });
  it("REGRESSION: a small history reads once per slice, as before", async () => {
    const { db, calls } = fakeDb({ org_members: [member("g1")], audit_logs: [{ org_id: ORG, resource_id: "g1", action: "MEMBER_SUSPENDED", timestamp: "2026-08-01T00:00:00Z" }] });
    const r = await readGrantorMemberships(db, ORG, [rec("p1", "g1", "2026-09-01T00:00:00Z")], NOW);
    expect(r.ok && r.byId.get("p1")).toBe("continuous");
    expect(calls.map((c) => c.table)).toEqual(["org_members", "audit_logs"]);
  });
});
