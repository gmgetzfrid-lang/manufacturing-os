// notifications Round G — N19 NOTICE RECORD REMAINDERS (DEC-90 — fail-safe, no
// regression).
//
//   DELIV-18   lib/notifications.ts recordNotEmailedFor — the record queueEmail
//              writes for a person whose own preference turned an email off,
//              for a server producer that inserts its own email rows: the same
//              row, ONE insert through the producer's client, behind the same
//              latch (lib/deliveryRecordLatch.ts — a plain flag). The two
//              producers are pinned through their real handlers in
//              n19CommentNotEmailed.test.ts and n19DigestNotEmailed.test.ts.
//   NEDGE-24   limb 1: lib/accessRequestOutcome.ts clearAccessRequestNotices
//              retires a decided request's pool notices with the mark
//              (metadata.superseded_at / superseded_by), never read_at.
//              limb 2: 20261260 re-creates clear_resolved_branch_alerts from
//              its NEWEST earlier body (found by scanning; lineDiff + exact
//              cut) to mark instead of stamping; lib/branches.ts retires the
//              caller's own alert through the reconcile pass; the purge's
//              plain read line keeps both kinds (rows stamped before cannot be
//              told from rows their recipients opened).
//   The runtime proof of 20261260 on the replayed PostgreSQL 16 is
//   lib/__tests__/rls/n19BranchAlertMark.test.ts (`npm run test:db`).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; payload: unknown }>,
  insertError: null as null | { code?: string; message?: string },
  rpcAnswer: { data: 2 as unknown, error: null as null | { code?: string; message?: string } },
  ownRows: [] as Array<{ id: string; org_id: string }>,
  ownReadError: null as null | { message: string },
  reads: [] as Array<{ table: string; ops: unknown[][] }>,
  reconcile: [] as Array<{ orgId: string; ids: string[] }>,
}));

vi.mock("@/lib/supabase", () => {
  const from = (table: string) => {
    const ops: unknown[][] = [];
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "contains", "not"]) c[m] = (...a: unknown[]) => { ops.push([m, ...a]); return c; };
    c.insert = async (payload: unknown) => { h.inserts.push({ table, payload }); return { error: h.insertError }; };
    c.then = (res: (v: unknown) => unknown) => { h.reads.push({ table, ops }); return Promise.resolve(h.ownReadError ? { data: null, error: h.ownReadError } : { data: h.ownRows, error: null }).then(res); };
    return c;
  };
  return {
    supabase: {
      from,
      rpc: async (fn: string) => (fn === "clear_resolved_branch_alerts" ? h.rpcAnswer : { data: true, error: null }),
      auth: { getSession: async () => ({ data: { session: null } }) },
    },
  };
});
vi.mock("@/lib/notificationReconcile", () => ({
  requestReconcile: vi.fn(async (orgId: string, ids: string[]) => { h.reconcile.push({ orgId, ids }); return { retired: ids, kept: 0, failed: 0 }; }),
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => ({ recipients: 0 })) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ error: null })) }));

import { recordNotEmailedFor, type NotEmailedRecordClient, type QueueEmailInput } from "@/lib/notifications";
import { notEmailedRecordLatch, resetDeliveryRecordLatches } from "@/lib/deliveryRecordLatch";
import { clearAccessRequestNotices } from "@/lib/accessRequestOutcome";
import { clearBranchOpenAlerts, retireOwnBranchAlerts } from "@/lib/branches";

const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => {
  h.inserts = []; h.insertError = null; h.rpcAnswer = { data: 2, error: null };
  h.ownRows = []; h.ownReadError = null; h.reads = []; h.reconcile = [];
  resetDeliveryRecordLatches();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

// ═════════════════════════════════════════════════════════════════════════════
describe("DELIV-18 — recordNotEmailedFor: the record queueEmail writes, for a server producer", () => {
  const client = (): NotEmailedRecordClient & { rows: unknown[] } => {
    const rows: unknown[] = [];
    return {
      rows,
      from: () => ({ insert: async (payload: unknown) => { rows.push(payload); return { error: h.insertError }; } }),
    };
  };
  const input = (over: Partial<QueueEmailInput> = {}): QueueEmailInput => ({
    orgId: "o1", toUserId: "u1", toEmail: "u1@x.io", subject: "New comment on REQ-1", bodyText: "composed",
    bodyHtml: "<p>composed</p>", resourceType: "ticket", resourceId: "t1", eventType: "watcher_activity",
    metadata: { mention: false, commentId: "c1" }, ...over,
  });

  it("one insert of the producer's rows: the columns a queued row carries, status not_emailed, the cause named as their preference (no switch named)", async () => {
    const c = client();
    expect(await recordNotEmailedFor(c, [input(), input({ toUserId: "u2", toEmail: "u2@x.io", rendered: { bodyText: "R", bodyHtml: "<p>R</p>" } })], "test")).toBe("recorded");
    expect(c.rows.length).toBe(1);
    expect(c.rows[0]).toEqual([
      { org_id: "o1", to_user_id: "u1", to_email: "u1@x.io", subject: "New comment on REQ-1", body_text: "composed", body_html: "<p>composed</p>",
        resource_type: "ticket", resource_id: "t1", event_type: "watcher_activity",
        metadata: { mention: false, commentId: "c1", not_emailed: { byTheirChoice: true, reason: "preference" } }, status: "not_emailed" },
      { org_id: "o1", to_user_id: "u2", to_email: "u2@x.io", subject: "New comment on REQ-1", body_text: "R", body_html: "<p>R</p>",
        resource_type: "ticket", resource_id: "t1", event_type: "watcher_activity",
        metadata: { mention: false, commentId: "c1", rendered: true, not_emailed: { byTheirChoice: true, reason: "preference" } }, status: "not_emailed" },
    ]);
  });

  it("no rows: nothing asked", async () => {
    const c = client();
    expect(await recordNotEmailedFor(c, [], "test")).toBe("skipped");
    expect(c.rows).toEqual([]);
  });

  it("before 20261258: the old status CHECK refuses it (23514) — answered not_installed, the latch set, and the next producer call asks nothing", async () => {
    const c = client();
    h.insertError = { code: "23514", message: 'new row for relation "email_notifications" violates check constraint "email_notifications_status_check"' };
    expect(await recordNotEmailedFor(c, [input()], "test")).toBe("not_installed");
    expect(notEmailedRecordLatch.held()).toBe(true);
    expect(await recordNotEmailedFor(c, [input()], "test")).toBe("skipped");
    expect(c.rows.length).toBe(1);
  });

  it("another refusal is answered with its message; the latch is not set; a write that lands clears a held latch", async () => {
    const c = client();
    h.insertError = { code: "42501", message: "permission denied" };
    expect(await recordNotEmailedFor(c, [input()], "test")).toEqual({ error: "42501: permission denied" });
    expect(notEmailedRecordLatch.held()).toBe(false);
    h.insertError = null;
    notEmailedRecordLatch.set();
    notEmailedRecordLatch.clear();
    expect(await recordNotEmailedFor(c, [input()], "test")).toBe("recorded");
  });

  it("never throws: a client that throws answers an error", async () => {
    const bad: NotEmailedRecordClient = { from: () => ({ insert: () => { throw new Error("socket closed"); } }) };
    expect(await recordNotEmailedFor(bad, [input()], "test")).toEqual({ error: "socket closed" });
  });

  it("REGRESSION: queueEmail's own record is the same row through the same insert (one object, the shared client) — unchanged", () => {
    const lib = src("lib/notifications.ts");
    expect(lib).toContain('return (await insertNotEmailed(supabase as unknown as NotEmailedRecordClient, notEmailedRow(input), "queueEmail")) === "recorded";');
    // the drain never sends not_emailed (N18's pin, re-read here)
    expect(src("app/api/notifications/send-queued/route.ts")).not.toMatch(/["']not_emailed["']\s*\]/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("NEDGE-24 limb 1 — a decided access request's pool notices are retired with the mark, never read_at", () => {
  type Op = [string, ...unknown[]];
  const make = (opts: { rows?: Array<{ id: string; metadata: Record<string, unknown> | null }>; readError?: { message: string }; refuse?: Set<string>; gone?: Set<string> } = {}) => {
    const updates: Array<{ payload: Record<string, unknown>; ops: Op[] }> = [];
    const reads: Op[][] = [];
    const sb = {
      from: () => {
        const ops: Op[] = [];
        let payload: Record<string, unknown> | null = null;
        const c: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "is"]) c[m] = (...a: unknown[]) => { ops.push([m, ...a]); return c; };
        c.update = (p: Record<string, unknown>) => { payload = p; return c; };
        c.then = (res: (v: unknown) => unknown) => {
          if (payload) {
            updates.push({ payload, ops });
            const id = String((ops.find((o) => o[0] === "eq" && o[1] === "id") ?? [])[2]);
            if (opts.refuse?.has(id)) return Promise.resolve({ data: null, error: { message: "refused" } }).then(res);
            return Promise.resolve({ data: opts.gone?.has(id) ? [] : [{ id }], error: null }).then(res);
          }
          reads.push(ops);
          return Promise.resolve(opts.readError ? { data: null, error: opts.readError } : { data: opts.rows ?? [], error: null }).then(res);
        };
        return c;
      },
    };
    return { sb: sb as never, updates, reads };
  };

  it("reads the pool's still-unread, unmarked rows about the decided requests, in the org (the same keys as before)", async () => {
    const t = make({ rows: [] });
    expect(await clearAccessRequestNotices(t.sb, "o1", ["r1", "r1", "r2", ""])).toBe(0);
    expect(t.reads[0]).toEqual([
      ["select", "id, metadata"], ["eq", "org_id", "o1"], ["eq", "kind", "access_request_pending"], ["eq", "resource_type", "access_request"],
      ["in", "resource_id", ["r1", "r2"]], ["is", "read_at", null], ["is", "metadata->>superseded_at", null],
    ]);
  });

  it("marks each row superseded_at / superseded_by, keeping its metadata, conditional on still unread and unmarked — and writes no read_at", async () => {
    const t = make({ rows: [{ id: "n1", metadata: { requestEmail: "a@b.c" } }, { id: "n2", metadata: null }] });
    expect(await clearAccessRequestNotices(t.sb, "o1", ["r1"])).toBe(2);
    expect(t.updates.length).toBe(2);
    for (const u of t.updates) {
      expect(u.payload).not.toHaveProperty("read_at");
      expect(Object.keys(u.payload)).toEqual(["metadata"]);
      const meta = u.payload.metadata as Record<string, unknown>;
      expect(meta.superseded_by).toBe("access_request_decided");
      expect(Number.isFinite(Date.parse(String(meta.superseded_at)))).toBe(true);
      expect(u.ops).toEqual(expect.arrayContaining([["eq", "org_id", "o1"], ["is", "read_at", null], ["is", "metadata->>superseded_at", null], ["select", "id"]]));
    }
    expect((t.updates[0].payload.metadata as Record<string, unknown>).requestEmail).toBe("a@b.c");
  });

  it("a row opened or retired meanwhile is not counted; a refused mark answers null (logged); a failed read answers null", async () => {
    expect(await clearAccessRequestNotices(make({ rows: [{ id: "n1", metadata: {} }, { id: "n2", metadata: {} }], gone: new Set(["n2"]) }).sb, "o1", ["r1"])).toBe(1);
    expect(await clearAccessRequestNotices(make({ rows: [{ id: "n1", metadata: {} }], refuse: new Set(["n1"]) }).sb, "o1", ["r1"])).toBeNull();
    expect(await clearAccessRequestNotices(make({ readError: { message: "down" } }).sb, "o1", ["r1"])).toBeNull();
    expect(await clearAccessRequestNotices(make().sb, "", ["r1"])).toBe(0);
  });

  it("REGRESSION: both decide routes still call it after their own write (unchanged call sites)", () => {
    expect(src("app/api/admin/access-requests/route.ts")).toContain("await clearAccessRequestNotices(supabaseAdmin, request.org_id as string, [String(request.id ?? id)]);");
    expect(src("app/api/admin/create-user/route.ts")).toContain("await clearAccessRequestNotices(supabaseAdmin, orgId, rows.map((r) => String(r.id)));");
    expect(src("lib/accessRequestOutcome.ts")).not.toMatch(/\.update\(\{\s*read_at/);
  });

  it("every screen that hides a decided request's notice today still hides it: the bell's unread list, its badge, the beyond-window tally and the inbox count all leave a marked row out", () => {
    const bellLib = src("lib/inAppNotifications.ts");
    expect(bellLib).toContain('if (opts?.onlyUnread) q = q.is("read_at", null).is("metadata->>superseded_at", null);');
    expect(bellLib.match(/\.is\("read_at", null\)\s*\n\s*\.is\("metadata->>superseded_at", null\);/g)?.length).toBe(2); // countUnread + listUnreadKindsBeyond
    expect(src("lib/inbox.ts")).toContain('.is("read_at", null).is("metadata->>superseded_at", null)');
    // the bell feed reads only the unread list (no "all rows" view in the bell)
    expect(src("hooks/useTicketNotifications.ts")).toContain("listMyNotifications({ onlyUnread: true,");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("NEDGE-24 limb 2 — lib/branches.ts: the function's call, then the caller's own alert through the reconcile pass", () => {
  it("REGRESSION: the call and its answer are as before; then the caller's own still-unread, unmarked alerts about the branch go to the reconcile pass, per org", async () => {
    h.ownRows = [{ id: "n-own", org_id: "o1" }];
    expect(await clearBranchOpenAlerts("b1")).toBe(2);
    await flush();
    const read = h.reads.find((r) => r.table === "notifications")!;
    expect(read.ops).toEqual([
      ["select", "id, org_id"], ["eq", "kind", "branch_open"], ["is", "read_at", null], ["is", "metadata->>superseded_at", null], ["contains", "metadata", { branchId: "b1" }],
    ]);
    expect(h.reconcile).toEqual([{ orgId: "o1", ids: ["n-own"] }]);
  });

  it("before 20261260 the old body stamped the caller's row read too: the own-row read finds nothing and nothing is asked", async () => {
    h.ownRows = [];
    expect(await clearBranchOpenAlerts("b1")).toBe(2);
    await flush();
    expect(h.reconcile).toEqual([]);
  });

  it("before 20261181 (42883 / PGRST202): null, logged, and no own-row retire — today's path", async () => {
    h.rpcAnswer = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    expect(await clearBranchOpenAlerts("b1")).toBeNull();
    await flush();
    expect(h.reads).toEqual([]);
    expect(h.reconcile).toEqual([]);
  });

  it("retireOwnBranchAlerts never throws: a failed read retires nothing", async () => {
    h.ownReadError = { message: "down" };
    expect(await retireOwnBranchAlerts("b1")).toBe(0);
    h.ownReadError = null;
    h.ownRows = [{ id: "a", org_id: "o1" }, { id: "b", org_id: "o2" }];
    expect(await retireOwnBranchAlerts("b1")).toBe(2);
    expect(h.reconcile).toEqual([{ orgId: "o1", ids: ["a"] }, { orgId: "o2", ids: ["b"] }]);
  });

  it("the reconcile pass retires a resolved branch's branch_open with the mark on the caller's own rows only (the server side it relies on)", () => {
    const server = src("lib/notificationReconcileServer.ts");
    expect(server).toContain('.update({ metadata: { ...(r.metadata ?? {}), superseded_at: supersededAt } })');
    expect(server).toContain('.eq("user_id", input.uid)');
    expect(src("lib/notificationReconcile.ts")).toMatch(/case "branch_open":\s*\n\s*return meta && typeof meta\.branchId === "string" && meta\.branchId \? "branch" : null;/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("NEDGE-24 — the purge's plain read line keeps both once-stamped kinds (as a mark is kept)", () => {
  it("the plain line's floor leaves access_request_pending and branch_open out; the record line is unchanged; both floors still require read_at", () => {
    const route = src("app/api/admin/purge/route.ts");
    expect(route).toContain('const PURGE_KEEPS_SYSTEM_STAMPED_KINDS = ["access_request_pending", "branch_open"];');
    const floor = route.slice(route.indexOf("function floorOf"), route.indexOf("/** What purging the abandoned-email line drops"));
    const plain = floor.slice(floor.indexOf('if (key === "notifications")'), floor.indexOf('if (key === "notifications_record")'));
    expect(plain).toContain('.not("kind", "in", `(${PURGE_KEEPS_SYSTEM_STAMPED_KINDS.join(",")})`)');
    expect(floor.match(/let n = q\.not\("read_at", "is", null\)/g)?.length).toBe(2);
    // neither kind is a record notice: the record line never reaches them
    const kinds = src("lib/notificationKinds.ts");
    expect(kinds).toMatch(/branch_open:\s+\{[^}]*compliance: false/);
    expect(kinds).toMatch(/access_request_pending:\s+\{[^}]*compliance: false/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
const dir = join(ROOT, "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261260_notif_roundG_branch_alert_mark.sql";
const M = mig(FILE);
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b + to.length);
}
function lineDiff(a: string, b: string) {
  const L = a.split("\n"), R = b.split("\n");
  return { onlyInA: L.filter((l) => !R.includes(l)), onlyInB: R.filter((l) => !L.includes(l)) };
}
const HEAD = "CREATE OR REPLACE FUNCTION clear_resolved_branch_alerts(";
const defining = files.filter((f) => stripComments(mig(f)).includes(HEAD));
const PREV = defining[defining.indexOf(FILE) - 1];
const G = { live: between(mig(PREV), HEAD, "\n$$;"), next: between(M, HEAD, "\n$$;") };
const REMOVED = ["     SET read_at = now()"];
const ADDED = [
  "  -- NEDGE-24 (20261260): a mark, never a read; the caller's own row is the app's (20261161's rail).",
  "     SET metadata = COALESCE(n.metadata, '{}'::jsonb) || jsonb_build_object(",
  "           'superseded_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),",
  "           'superseded_by', 'branch_resolved')",
  "     AND n.metadata ->> 'superseded_at' IS NULL",
  "     AND n.user_id IS DISTINCT FROM v_uid",
];

describe("20261260 — clear_resolved_branch_alerts re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261181 — the scan, not this comment, decides)", () => {
    expect(defining).toContain(FILE);
    expect(PREV < FILE).toBe(true);
    expect(PREV >= "20261181_notif_roundG_producers_free.sql").toBe(true);
  });

  it("lineDiff: one base line goes (the read_at stamp), the mark, its two conditions and one comment come in", () => {
    const d = lineDiff(G.live, G.next);
    expect(d.onlyInA).toEqual(REMOVED);
    expect(d.onlyInB).toEqual(ADDED);
  });

  it("exact cut: putting the stamp back and taking the added lines out IS the base, byte for byte", () => {
    const mark = ADDED.slice(1, 4).join("\n");
    let back = G.next.replace(`${mark}\n`, `${REMOVED[0]}\n`);
    for (const l of [ADDED[0], ADDED[4], ADDED[5]]) back = back.replace(`${l}\n`, "");
    expect(back).toBe(G.live);
    expect(G.next).toMatch(/AND n\.read_at IS NULL\n {5}AND n\.metadata ->> 'superseded_at' IS NULL\n {5}AND n\.user_id IS DISTINCT FROM v_uid\n {5}AND n\.metadata @> jsonb_build_object\('branchId', p_branch::text\);/);
  });

  it("TRIPWIRE: every later re-create keeps the mark and never stamps read_at (start from the NEWEST body)", () => {
    for (const later of defining.filter((f) => f > FILE)) {
      const body = between(mig(later), HEAD, "\n$$;");
      expect(body, later).toContain("'superseded_by', 'branch_resolved')");
      expect(body, later).not.toMatch(/SET read_at/);
    }
  });

  it("DRLS-16: SECURITY DEFINER with search_path pinned; EXECUTE restated as 20261181 has it (authenticated; never PUBLIC or anon)", () => {
    expect(G.next).toContain("RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(M).toContain("REVOKE ALL ON FUNCTION clear_resolved_branch_alerts(uuid) FROM PUBLIC, anon;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION clear_resolved_branch_alerts(uuid) TO authenticated;");
    expect(stripComments(M)).not.toMatch(/GRANT[^;]*\b(anon|PUBLIC)\b/);
    // the definer census records the function's grants: re-created, they are unchanged
    expect(src("lib/__tests__/rls/definerDecisions.ts")).toMatch(/signature: "clear_resolved_branch_alerts\(uuid\)",\s*\n\s*decision: "signed-in",\s*\n\s*execute: \{ anon: false, authenticated: true, service_role: true \}/);
  });
});

describe("20261260 — the DEC-30 one-paste shape", () => {
  const code = stripComments(M);
  const begin = code.indexOf("\nBEGIN;");
  const commit = code.indexOf("\nCOMMIT;");

  it("one BEGIN and one COMMIT; the prerequisite check and the counts-only inventory come BEFORE the transaction", () => {
    expect(code.split("\nBEGIN;").length).toBe(2);
    expect(code.split("\nCOMMIT;").length).toBe(2);
    expect(code.indexOf("RAISE EXCEPTION '20261260 needs 20261181")).toBeLessThan(begin);
    const temp = code.indexOf("CREATE TEMP TABLE notif_round_g_260_before AS");
    expect(temp).toBeGreaterThan(0);
    expect(temp).toBeLessThan(begin);
    const inventory = code.slice(temp, begin);
    // aggregate counts only — never a customer row (one EXISTS sub-select in row 3)
    expect(inventory.match(/COUNT\(\*\)::text/g)!.length).toBe(5);
    expect(inventory.match(/SELECT /g)!.length).toBe(6);
    expect(inventory).not.toMatch(/\btitle\b|\bbody\b|user_id,|\bemail\b/);
  });

  it("the transaction changes no row: the function, its comment and its grants only", () => {
    const tx = code.slice(begin, commit).replace(/AS \$\$[\s\S]*?\n\$\$;/g, "AS $$ <body> $$;");
    expect(tx).toContain("<body>");
    expect(tx).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/m);
  });

  it("ONE final SELECT after COMMIT with the fixed shape (check, ok, n), ordered by the outer ORDER BY", () => {
    const tail = code.slice(commit + "\nCOMMIT;".length);
    expect(tail.trim().startsWith('SELECT "check", ok, n FROM (')).toBe(true);
    expect(tail.trim().endsWith("ORDER BY sec, ord;")).toBe(true);
    expect(tail.replace(/'(?:[^']|'')*'/g, "''").match(/;\s*(?=\S)/g)).toBeNull();
    expect(tail).toContain("FROM notif_round_g_260_before");
  });

  it("a prosrc probe doubles every apostrophe inside its pattern; the probes check the mark, the absent stamp, the gate and the own-row clause", () => {
    expect(code).toContain("p.prosrc LIKE '%''superseded_by'', ''branch_resolved'')%'");
    expect(code).toContain("p.prosrc NOT LIKE '%SET read_at%'");
    expect(code).toContain("p.prosrc LIKE '%AND n.user_id IS DISTINCT FROM v_uid%'");
    expect(code).toContain("p.prosrc LIKE '%AND b.resolved_at IS NOT NULL%AND m.status = ''active''%'");
  });

  it("refuses to run without the base (20261181), changing nothing", () => {
    const pre = code.slice(0, code.indexOf("CREATE TEMP TABLE"));
    expect(pre).toContain("to_regprocedure('public.clear_resolved_branch_alerts(uuid)') IS NULL");
  });
});
