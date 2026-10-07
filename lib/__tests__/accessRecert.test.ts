// lib/__tests__/accessRecert.test.ts
//
// The pure clock helpers, and (admin-and-org Round G, P9 — ALOG-2) the
// attestation writes: the cadence's and the attestation's event rows are
// CHECKED — a refused record throws, a refused attestation puts the library's
// dates back — and the snapshot never counts an expired rule as current.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Op = { m: string; args: unknown[] };
const st = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; ops: Op[] }>,
  /** answer for one finished chain */
  answer: ((_t: string, _ops: Op[]) => ({ data: null, error: null })) as (table: string, ops: Op[]) => { data?: unknown; error?: unknown },
  audits: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/supabase", () => {
  function chain(table: string) {
    const ops: Op[] = [];
    st.calls.push({ table, ops });
    const run = () => st.answer(table, ops);
    const target: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void, rej?: (e: unknown) => void) => Promise.resolve().then(run).then(res, rej);
        return (...args: unknown[]) => { ops.push({ m: prop, args }); return prop === "maybeSingle" ? Promise.resolve(run()) : new Proxy(target, handler); };
      },
    };
    return new Proxy(target, handler);
  }
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (a: Record<string, unknown>) => { st.audits.push(a); }) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("@/lib/ownership", () => ({ getOrgControllers: vi.fn(async () => []) }));

import { computeNextRecertDate, recertStatusFor, daysUntilRecert, describeRecert, recertifyAccess, setRecertPolicy } from "@/lib/accessRecert";

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe("computeNextRecertDate", () => {
  it("adds the interval months to the basis date", () => {
    expect(computeNextRecertDate("2026-01-15T00:00:00Z", 6)).toBe("2026-07-15");
    expect(computeNextRecertDate("2026-01-15T00:00:00Z", 12)).toBe("2027-01-15");
  });
  it("clamps month-end dates instead of overflowing into the next month", () => {
    expect(computeNextRecertDate("2026-08-31T00:00:00Z", 6)).toBe("2027-02-28"); // not Mar 3
    expect(computeNextRecertDate("2026-01-31T00:00:00Z", 1)).toBe("2026-02-28"); // not Mar 3
    expect(computeNextRecertDate("2027-08-31T00:00:00Z", 6)).toBe("2028-02-29"); // leap year
  });
});

describe("recertStatusFor", () => {
  it("is 'none' with no date", () => {
    expect(recertStatusFor(null)).toBe("none");
  });
  it("is 'overdue' in the past, 'due_soon' within lead, 'current' beyond", () => {
    expect(recertStatusFor(iso(-1))).toBe("overdue");
    expect(recertStatusFor(iso(10))).toBe("due_soon");
    expect(recertStatusFor(iso(120))).toBe("current");
  });
});

describe("daysUntilRecert", () => {
  it("returns forward days / null", () => {
    expect(daysUntilRecert(null)).toBeNull();
    expect(daysUntilRecert(iso(5))).toBe(5);
  });
});

describe("describeRecert", () => {
  it("describes the cadence", () => {
    expect(describeRecert({ enabled: true, intervalMonths: 6 })).toBe("Recertify every 6 months");
    expect(describeRecert({ enabled: true, intervalMonths: 1 })).toBe("Recertify every 1 month");
    expect(describeRecert(null)).toBe("No recertification cadence");
    expect(describeRecert({ enabled: false })).toBe("No recertification cadence");
  });
});

// ── ALOG-2 (admin-and-org Round G, P9) ──────────────────────────────────────
describe("ALOG-2 — a recertification cannot fail silently, and the snapshot is the live population", () => {
  const PRIOR = { recert_policy: { enabled: true, intervalMonths: 6 }, last_recertified_at: "2026-01-01T00:00:00Z", last_recertified_by: "old", next_recertification_date: "2026-07-01", recert_notified_at: "2026-06-01T00:00:00Z" };
  const members = [{ uid: "admin", display_name: "Ada", email: "a@x", role: "Admin", roles: ["Admin"] }, { uid: "eng", display_name: "Eng", email: "e@x", role: "Engineer-2", roles: ["Engineer-2"] }];
  const lib = {
    ...PRIOR, visibility: "private", owner_user_id: null, owner_team_id: null,
    acl: { rules: [
      { effect: "allow", subject: { type: "user", id: "eng" }, actions: ["read"] },
      { effect: "allow", subject: { type: "user", id: "gone" }, actions: ["read"], expiresAt: "2020-01-01T00:00:00Z" },
    ] },
    acl_index: { allow: { users: { read: ["eng", "gone"] } } },
  };
  const isWrite = (ops: Op[], m: "update" | "insert") => ops.some((o) => o.m === m);
  const answers = (opts: { eventError?: unknown; certRows?: unknown[]; backRows?: unknown[] }) => (table: string, ops: Op[]) => {
    if (table === "libraries" && isWrite(ops, "update")) {
      const patch = ops.find((o) => o.m === "update")!.args[0] as Record<string, unknown>;
      return patch.last_recertified_by === "old" ? { data: opts.backRows ?? [{ id: "l1" }], error: null } : { data: opts.certRows ?? [{ id: "l1" }], error: null };
    }
    if (table === "libraries") return { data: lib, error: null };
    if (table === "org_members") return { data: members, error: null };
    if (table === "team_members" || table === "teams") return { data: [], error: null };
    if (table === "access_recertification_events") return { data: null, error: opts.eventError ?? null };
    return { data: [], error: null };
  };
  const writes = (table: string, m: "update" | "insert") => st.calls.filter((c) => c.table === table && isWrite(c.ops, m));
  beforeEach(() => { st.calls = []; st.audits = []; });

  it("done-when 4: grant_count and grants_snapshot are the live population — the expired rule is not counted", async () => {
    st.answer = answers({});
    const out = await recertifyAccess({ libraryId: "l1", orgId: "o1", actorId: "admin", actorName: "Ada" });
    const ev = writes("access_recertification_events", "insert")[0].ops.find((o) => o.m === "insert")!.args[0] as Record<string, unknown>;
    const snap = (ev.grants_snapshot as Array<{ subjectId: string }>).map((g) => g.subjectId).sort();
    expect(snap).toEqual(["admin", "eng"]);
    expect(ev.grant_count).toBe(2);
    expect(out.grantCount).toBe(2);
    expect(ev.performed_by).toBe("admin"); // the row names the signed-in reviewer (20261188 binds it)
    expect(st.audits.map((a) => a.action)).toEqual(["ACCESS_RECERTIFIED"]);
  });

  it("done-when 1: a refused attestation RECORD throws, puts the library's dates back, and writes no audit row", async () => {
    st.answer = answers({ eventError: { message: 'new row violates row-level security policy for table "access_recertification_events"', code: "42501" } });
    await expect(recertifyAccess({ libraryId: "l1", orgId: "o1", actorId: "eng" }))
      .rejects.toThrow(/Recertification was NOT recorded: the attestation record was refused \(new row violates row-level security.*The library's recertification dates were put back/);
    const ups = writes("libraries", "update").map((c) => c.ops.find((o) => o.m === "update")!.args[0] as Record<string, unknown>);
    expect(ups).toHaveLength(2);
    expect(ups[1]).toEqual({ last_recertified_at: PRIOR.last_recertified_at, last_recertified_by: "old", next_recertification_date: PRIOR.next_recertification_date, recert_notified_at: PRIOR.recert_notified_at });
    expect(st.audits).toEqual([]);
  });

  it("done-when 1: when the dates cannot be put back either, the reviewer is told the library shows an unrecorded recertification", async () => {
    st.answer = answers({ eventError: { message: "denied" }, backRows: [] });
    await expect(recertifyAccess({ libraryId: "l1", orgId: "o1", actorId: "eng" }))
      .rejects.toThrow(/could not be put back \(no row was updated\) — the library now shows a recertification that has no record/);
  });

  it("done-when 1: an unreadable library refuses BEFORE anything is written (it used to read as 'no cadence' and clear the next date)", async () => {
    // The population resolves from the same library row (the first read),
    // so make only recertifyAccess's own read — the second — fail.
    let n = 0;
    const base = answers({});
    st.answer = (t, ops) => (t === "libraries" && !isWrite(ops, "update") && ++n === 2 ? { data: null, error: { message: "timeout" } } : base(t, ops));
    await expect(recertifyAccess({ libraryId: "l1", orgId: "o1", actorId: "admin" })).rejects.toThrow(/Recertification refused: the library could not be read \(timeout\)\. Nothing was attested\./);
    expect(writes("libraries", "update")).toEqual([]);
    expect(writes("access_recertification_events", "insert")).toEqual([]);
  });

  it("done-when 1: the library update refused (zero rows) is still a refusal and writes no record", async () => {
    st.answer = answers({ certRows: [] });
    await expect(recertifyAccess({ libraryId: "l1", orgId: "o1", actorId: "eng" })).rejects.toThrow(/Recertification was NOT recorded — you don't have authority/);
    expect(writes("access_recertification_events", "insert")).toEqual([]);
  });

  // fix pass 2: the cadence is read first and PUT BACK when its record is
  // refused — a cadence in force with no history row is the unrecorded change.
  const cadenceAnswers = (opts: { eventError?: unknown; backRows?: unknown[]; readError?: unknown }) => (t: string, ops: Op[]) => {
    if (t === "libraries" && isWrite(ops, "update")) {
      const patch = ops.find((o) => o.m === "update")!.args[0] as Record<string, unknown>;
      const isPutBack = patch.recert_notified_at === PRIOR.recert_notified_at;
      return isPutBack ? { data: opts.backRows ?? [{ id: "l1" }], error: null } : { data: [{ id: "l1" }], error: null };
    }
    if (t === "libraries") return opts.readError ? { data: null, error: opts.readError } : { data: PRIOR, error: null };
    if (t === "access_recertification_events") return { data: null, error: opts.eventError ?? null };
    return { data: [], error: null };
  };
  it("the cadence's event row is checked: a refusal puts the previous cadence and dates back (count-checked) and says so", async () => {
    st.answer = cadenceAnswers({ eventError: { message: "new row violates row-level security policy", code: "42501" } });
    await expect(setRecertPolicy({ libraryId: "l1", orgId: "o1", policy: { enabled: true, intervalMonths: 3 }, actorId: "mgr" }))
      .rejects.toThrow(/The recertification cadence was NOT changed: its record was refused \(new row violates row-level security policy\), so the library's previous cadence and dates were put back\. Only an Admin, a Document Controller or the library's owner can record it/);
    const ups = writes("libraries", "update").map((c) => c.ops.find((o) => o.m === "update")!.args[0] as Record<string, unknown>);
    expect(ups).toHaveLength(2);
    expect(ups[1]).toEqual({ recert_policy: PRIOR.recert_policy, next_recertification_date: PRIOR.next_recertification_date, recert_notified_at: PRIOR.recert_notified_at });
    // the put-back is count-checked (.select("id"))
    expect(writes("libraries", "update")[1].ops.some((o) => o.m === "select" && o.args[0] === "id")).toBe(true);
    expect(st.audits).toEqual([]);
  });
  it("a refusal that is NOT an authority refusal (a timeout) does not blame authority; a failed put-back says the cadence is in force unrecorded", async () => {
    st.answer = cadenceAnswers({ eventError: { message: "canceling statement due to statement timeout", code: "57014" }, backRows: [] });
    const err = await setRecertPolicy({ libraryId: "l1", orgId: "o1", policy: { enabled: true, intervalMonths: 3 }, actorId: "admin" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/was saved on the library, but its record was refused \(canceling statement due to statement timeout\) and the previous cadence could not be put back \(no row was updated\) — the change is in force with no recertification-history record\. Tell an Admin\.$/);
    expect((err as Error).message).not.toMatch(/Only an Admin/);
  });
  it("a library whose cadence cannot be read is refused before anything is written", async () => {
    st.answer = cadenceAnswers({ readError: { message: "timeout" } });
    await expect(setRecertPolicy({ libraryId: "l1", orgId: "o1", policy: null, actorId: "admin" }))
      .rejects.toThrow(/The recertification cadence was NOT saved: the library could not be read \(timeout\)\./);
    expect(writes("libraries", "update")).toEqual([]);
    expect(writes("access_recertification_events", "insert")).toEqual([]);
  });
  it("the attestation's refusal names the authority rule only on 42501 (the same wording rule)", async () => {
    st.answer = answers({ eventError: { message: "fetch failed" } });
    const err = await recertifyAccess({ libraryId: "l1", orgId: "o1", actorId: "admin" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/The library's recertification dates were put back\.$/);
    expect((err as Error).message).not.toMatch(/Only an Admin/);
  });

  it("regression: a controller's or owner's attestation still records exactly as before (one library update, one event, one audit row)", async () => {
    st.answer = answers({});
    const out = await recertifyAccess({ libraryId: "l1", orgId: "o1", actorId: "admin", note: "removed 2 contractors" });
    expect(writes("libraries", "update")).toHaveLength(1);
    expect(writes("access_recertification_events", "insert")).toHaveLength(1);
    expect(out.nextDate).toBe(computeNextRecertDate(new Date().toISOString(), 6));
    st.calls = []; st.audits = [];
    st.answer = cadenceAnswers({});
    await setRecertPolicy({ libraryId: "l1", orgId: "o1", policy: { enabled: true, intervalMonths: 3 }, actorId: "admin" });
    expect(writes("access_recertification_events", "insert")).toHaveLength(1);
    expect(writes("libraries", "update")).toHaveLength(1); // no put-back on success
    expect(st.audits.map((a) => a.action)).toEqual(["ACCESS_RECERT_POLICY_SET"]);
  });
});
