// projects Round G — J11 PROJECTS RESIDUALS, projects-and-cost INTK-15 (fix
// pass): the intake door's direct-upload staging (lib/intakeStaging.ts).
//
//   * one top-level staging root; a link's own prefix; only `<prefix><uuid>`
//   * a begin's reservation is an intake_attempts 'staged' row keyed by the
//     staged object's UUID, the link and the declared bytes
//   * a claim is ONE delete bound to the id, the presenting token's hash, the
//     'staged' outcome and the TTL — exactly one claimant wins
//   * a begin sweeps its link's expired reservations (object first, then the
//     row; a row whose object could not be removed keeps counting)
//   * the maintenance cron sweeps the whole root: objects older than the TTL,
//     then the reservations as old — never the rows while an object delete
//     failed or the listing was truncated; it never throws

import { describe, it, expect, vi, beforeEach } from "vitest";

const r2 = vi.hoisted(() => ({
  objects: [] as Array<{ Key: string; Size: number; LastModified: Date }>,
  deleted: [] as string[],
  listCalls: [] as Array<Record<string, unknown>>,
  failKeys: new Set<string>(),
  listError: null as null | Error,
  pageSize: 1000,
}));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "bucket",
  r2: {
    send: vi.fn(async (cmd: { op: string; input: Record<string, unknown> }) => {
      if (cmd.op === "list") {
        r2.listCalls.push(cmd.input);
        if (r2.listError) throw r2.listError;
        const start = Number(cmd.input.ContinuationToken ?? 0);
        const all = r2.objects.filter((o) => o.Key.startsWith(String(cmd.input.Prefix)));
        const page = all.slice(start, start + r2.pageSize);
        const more = start + r2.pageSize < all.length;
        return { Contents: page, IsTruncated: more, NextContinuationToken: more ? String(start + r2.pageSize) : undefined };
      }
      if (cmd.op === "deleteMany") {
        const keys = ((cmd.input.Delete as { Objects: Array<{ Key: string }> }).Objects).map((o) => o.Key);
        const errors = keys.filter((k) => r2.failKeys.has(k)).map((k) => ({ Key: k, Message: "AccessDenied" }));
        for (const k of keys) if (!r2.failKeys.has(k)) r2.deleted.push(k);
        return { Errors: errors };
      }
      return {};
    }),
  },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  ListObjectsV2Command: class { op = "list"; constructor(public input: unknown) {} },
  DeleteObjectsCommand: class { op = "deleteMany"; constructor(public input: unknown) {} },
}));

import {
  STAGING_ROOT, STAGING_TTL_MS, stagingPrefix, stagedIdUnder, begunIdOf,
  reserveStaged, claimStaged, sweepAndReserved, sweepIntakeStaging,
} from "@/lib/intakeStaging";

type Row = Record<string, unknown>;
type Q = { table: string; op: string; filters: Array<[string, string, unknown]>; payload?: unknown; select?: string; limit?: number };

/** A recording PostgREST-shaped client over an in-memory intake_attempts. */
function fakeDb(seed: Row[] = [], fail: Partial<Record<string, string>> = {}) {
  const rows = [...seed];
  const calls: Q[] = [];
  const match = (r: Row, f: Q["filters"]) => f.every(([op, col, v]) =>
    op === "eq" ? r[col] === v : op === "gte" ? String(r[col]) >= String(v) : op === "lt" ? String(r[col]) < String(v) : true);
  const client = {
    from(table: string) {
      const q: Q = { table, op: "select", filters: [] };
      const run = () => {
        calls.push(q);
        if (fail[q.op]) return { data: null, error: { message: fail[q.op] } };
        if (q.op === "insert") { rows.push({ created_at: new Date().toISOString(), ...(q.payload as Row) }); return { data: null, error: null }; }
        const hit = rows.filter((r) => match(r, q.filters));
        if (q.op === "delete") {
          for (const h of hit) rows.splice(rows.indexOf(h), 1);
          return { data: hit.map((h) => ({ id: h.id })), error: null };
        }
        return { data: q.limit != null ? hit.slice(0, q.limit) : hit, error: null };
      };
      const self: Record<string, unknown> = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") return (res: (v: unknown) => void) => res(run());
          return (...args: unknown[]) => {
            if (prop === "insert" || prop === "delete") { q.op = prop; q.payload = args[0]; }
            if (prop === "select" && q.op === "select") q.select = String(args[0]);
            if (prop === "eq" || prop === "gte" || prop === "lt") q.filters.push([prop, String(args[0]), args[1]]);
            if (prop === "limit") q.limit = Number(args[0]);
            return self;
          };
        },
      });
      return self;
    },
  };
  return { client, rows, calls };
}

const ID1 = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";
const NOW = Date.parse("2026-10-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

beforeEach(() => {
  r2.objects = []; r2.deleted = []; r2.listCalls = []; r2.failKeys = new Set(); r2.listError = null; r2.pageSize = 1000;
});

describe("the staging root and a link's prefix", () => {
  it("one top-level root, never inside an org's tree; a key is only <prefix><uuid>", () => {
    expect(STAGING_ROOT).toBe("intake-staging/");
    const p = stagingPrefix("o1", "p1", "l1");
    expect(p).toBe("intake-staging/o1/p1/l1/");
    expect(stagedIdUnder(`${p}${ID1}`, p)).toBe(ID1);
    for (const bad of [`${p}${ID1}/x`, `${p}../x`, `intake-staging/o1/p1/l2/${ID1}`, `orgs/o1/project-intake/p1/staging/l1/${ID1}`, `${p}0000000A-0000-4000-8000-00000000000B`]) {
      expect(stagedIdUnder(bad, p), bad).toBeNull();
    }
    expect(begunIdOf(`${p}${ID1}`)).toBe(ID1);
    for (const bad of [null, "", `orgs/o1/${ID1}`, `${p}not-a-uuid`, `${p}${ID1}`.padStart(600, "x")]) expect(begunIdOf(bad)).toBeNull();
  });
});

describe("a begin's reservation and a finalize's claim", () => {
  it("the reservation is a 'staged' row keyed by the staged UUID, with the link and the declared bytes — checked", async () => {
    const db = fakeDb();
    expect(await reserveStaged(db.client, { id: ID1, tokenHash: "h", ip: "1.2.3.4", linkId: "l1", bytes: 100 })).toBe(true);
    expect(db.rows).toEqual([expect.objectContaining({ id: ID1, token_hash: "h", ip: "1.2.3.4", link_id: "l1", outcome: "staged", bytes: 100 })]);
    const failing = fakeDb([], { insert: "relation intake_attempts does not exist" });
    expect(await reserveStaged(failing.client, { id: ID1, tokenHash: "h", ip: "x", linkId: "l1", bytes: 1 })).toBe(false);
  });

  it("a claim is ONE delete bound to the id, the presenting token, the 'staged' outcome and the TTL — the first claimant wins, every later one is refused", async () => {
    const db = fakeDb([{ id: ID1, token_hash: "h", link_id: "l1", outcome: "staged", bytes: 100, created_at: ago(60_000) }]);
    expect(await claimStaged(db.client, { id: ID1, tokenHash: "other", now: NOW })).toEqual({ claimed: false });
    expect(await claimStaged(db.client, { id: ID1, tokenHash: "h", now: NOW })).toEqual({ claimed: true });
    expect(await claimStaged(db.client, { id: ID1, tokenHash: "h", now: NOW })).toEqual({ claimed: false });
    const del = db.calls.filter((c) => c.op === "delete").at(-1)!;
    expect(del.filters).toEqual([
      ["eq", "id", ID1], ["eq", "token_hash", "h"], ["eq", "outcome", "staged"],
      ["gte", "created_at", new Date(NOW - STAGING_TTL_MS).toISOString()],
    ]);
    // an expired reservation is not claimable — the sweep owns it
    const old = fakeDb([{ id: ID2, token_hash: "h", outcome: "staged", created_at: ago(STAGING_TTL_MS + 1000) }]);
    expect(await claimStaged(old.client, { id: ID2, tokenHash: "h", now: NOW })).toEqual({ claimed: false });
    // an unreadable table is an error, never a claim
    expect(await claimStaged(fakeDb([], { delete: "boom" }).client, { id: ID1, tokenHash: "h" })).toEqual({ error: "boom" });
  });

  it("the begin's reserved bytes: fresh reservations count; expired ones are swept — the object first, then the row — and one whose object stayed keeps counting", async () => {
    const db = fakeDb([
      { id: ID1, link_id: "l1", outcome: "staged", bytes: 100, created_at: ago(60_000) },
      { id: ID2, link_id: "l1", outcome: "staged", bytes: 40, created_at: ago(STAGING_TTL_MS + 60_000) },
      { id: "00000000-0000-4000-8000-000000000003", link_id: "l1", outcome: "staged", bytes: 7, created_at: ago(STAGING_TTL_MS + 60_000) },
      { id: "00000000-0000-4000-8000-000000000004", link_id: "l2", outcome: "staged", bytes: 999, created_at: ago(60_000) },
      { id: "00000000-0000-4000-8000-000000000005", link_id: "l1", outcome: "attempt", bytes: null, created_at: ago(60_000) },
    ]);
    const removed: string[] = [];
    const out = await sweepAndReserved(db.client, {
      linkId: "l1", prefix: "intake-staging/o1/p1/l1/", now: NOW,
      removeObject: async (key) => { removed.push(key); return !key.endsWith("3"); },
    });
    expect(out).toEqual({ reservedBytes: 100 + 7, swept: 1 });
    expect(removed).toEqual([`intake-staging/o1/p1/l1/${ID2}`, "intake-staging/o1/p1/l1/00000000-0000-4000-8000-000000000003"]);
    expect(db.rows.map((r) => r.id)).not.toContain(ID2);
    expect(db.rows.map((r) => r.id)).toContain("00000000-0000-4000-8000-000000000003");
    expect(await sweepAndReserved(fakeDb([], { select: "down" }).client, { linkId: "l1", prefix: "p/", removeObject: async () => true }))
      .toEqual({ error: "down" });
  });
});

describe("the maintenance cron's staging sweep", () => {
  const OLD = new Date(NOW - STAGING_TTL_MS - 60_000);
  const YOUNG = new Date(NOW - 60_000);

  it("deletes every object under the root older than the TTL — only under the root — then the reservations as old", async () => {
    r2.objects = [
      { Key: `intake-staging/o1/p1/l1/${ID1}`, Size: 100, LastModified: OLD },
      { Key: `intake-staging/o2/p9/l7/${ID2}`, Size: 50, LastModified: OLD },
      { Key: "intake-staging/o1/p1/l1/00000000-0000-4000-8000-000000000003", Size: 9, LastModified: YOUNG },
      { Key: "orgs/o1/project-intake/p1/abc-old.pdf", Size: 1000, LastModified: OLD },
    ];
    const db = fakeDb([
      { id: ID1, outcome: "staged", created_at: OLD.toISOString() },
      { id: "00000000-0000-4000-8000-000000000003", outcome: "staged", created_at: YOUNG.toISOString() },
      { id: "a", outcome: "attempt", created_at: OLD.toISOString() },
    ]);
    const out = await sweepIntakeStaging(db.client, { now: NOW });
    expect(out).toEqual({ objectsDeleted: 2, bytesFreed: 150, reservationsExpired: 1, truncated: false, errors: [] });
    expect(r2.listCalls[0]).toMatchObject({ Prefix: "intake-staging/" });
    expect(r2.deleted.sort()).toEqual([`intake-staging/o1/p1/l1/${ID1}`, `intake-staging/o2/p9/l7/${ID2}`]);
    expect(db.rows.map((r) => r.id).sort()).toEqual(["00000000-0000-4000-8000-000000000003", "a"]);
    const del = db.calls.find((c) => c.op === "delete")!;
    expect(del.filters).toEqual([["eq", "outcome", "staged"], ["lt", "created_at", new Date(NOW - STAGING_TTL_MS).toISOString()]]);
  });

  it("an object that would not delete keeps every reservation — and is reported; a failed listing is a line, never a throw", async () => {
    r2.objects = [{ Key: `intake-staging/o1/p1/l1/${ID1}`, Size: 100, LastModified: OLD }];
    r2.failKeys.add(`intake-staging/o1/p1/l1/${ID1}`);
    const db = fakeDb([{ id: ID1, outcome: "staged", created_at: OLD.toISOString() }]);
    const out = await sweepIntakeStaging(db.client, { now: NOW });
    expect(out.objectsDeleted).toBe(0);
    expect(out.errors).toEqual([`staged object intake-staging/o1/p1/l1/${ID1} not deleted: AccessDenied`]);
    expect(db.rows).toHaveLength(1);
    r2.listError = new Error("no credentials");
    const failed = await sweepIntakeStaging(db.client, { now: NOW });
    expect(failed.errors).toEqual(["staging list failed: no credentials"]);
    expect(db.calls.filter((c) => c.op === "delete")).toEqual([]);
  });

  it("a listing past its page cap deletes what it saw and leaves the reservations for the next run", async () => {
    r2.pageSize = 1;
    r2.objects = [
      { Key: `intake-staging/o1/p1/l1/${ID1}`, Size: 1, LastModified: OLD },
      { Key: `intake-staging/o1/p1/l1/${ID2}`, Size: 1, LastModified: OLD },
    ];
    const db = fakeDb([{ id: ID1, outcome: "staged", created_at: OLD.toISOString() }]);
    const out = await sweepIntakeStaging(db.client, { now: NOW, maxPages: 1 });
    expect(out).toMatchObject({ objectsDeleted: 1, truncated: true, reservationsExpired: 0 });
    expect(db.rows).toHaveLength(1);
  });
});
