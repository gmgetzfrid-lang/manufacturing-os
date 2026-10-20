// drafting-flow Round G, DF-P11 AFTER-DC — the closed-ticket space-saver:
//   SM-4  a ticket captured into an archive and REOPENED before the reclaim
//         is never stamped or freed: the commit refuses (409, naming it),
//         returns it to the live list and deletes nothing;
//   SM-9  the same for a ticket WRITTEN after capture (a comment posted on a
//         closed ticket); the stamp is a compare-and-set on the status and the
//         last_modified the commit read; the restore writes only from the
//         archive the stub was reclaimed into, compare-and-set on the stub;
//   AUTHZ-5 a key is deleted only when it is one of this workspace's request
//         files (orgs/<org>/tickets/… or an intake redline), no live revision
//         shares it and no OTHER live ticket names it; the produce applies the
//         same rule before reading bytes into the archive.
// The vi.hoisted state + recorded-ops Proxy chain of dcRoundFShed.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { NextRequest } from "next/server";

type Op = { m: string; args: unknown[] };
const state = vi.hoisted(() => ({
  resolve: ((_table: string, _ops: Array<{ m: string; args: unknown[] }>) => ({ data: [], error: null })) as
    (table: string, ops: Array<{ m: string; args: unknown[] }>) => { data?: unknown; error?: unknown; count?: number },
  r2Deletes: [] as string[],
  r2Puts: [] as string[],
  objects: {} as Record<string, Uint8Array>,
  calls: [] as Array<{ table: string; ops: Array<{ m: string; args: unknown[] }> }>,
}));

const argOf = (ops: Op[], m: string) => ops.find((o) => o.m === m)?.args;
const filter = (ops: Op[], m: string, col: string) => ops.find((o) => o.m === m && o.args[0] === col)?.args[1];
const hasOp = (ops: Op[], m: string, col: string) => ops.some((o) => o.m === m && o.args[0] === col);

function chain(table: string) {
  const ops: Op[] = [];
  state.calls.push({ table, ops });
  const run = () => state.resolve(table, ops);
  const c: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (res: (v: unknown) => void, rej?: (e: unknown) => void) => Promise.resolve().then(run).then(res, rej);
      }
      return (...args: unknown[]) => {
        ops.push({ m: prop, args });
        if (prop === "maybeSingle") return Promise.resolve(run());
        if (prop === "select" && ops.some((o) => o.m === "update" || o.m === "insert" || o.m === "delete")) {
          return Promise.resolve(run());
        }
        return new Proxy(c, handler);
      };
    },
  };
  return new Proxy(c, handler);
}

vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async () => ({ admin: { from: (t: string) => chain(t) }, userId: "admin1", email: "a@x", role: "Admin", roles: ["Admin"] })),
}));
vi.mock("@/lib/r2", () => ({
  r2: {
    send: vi.fn(async (cmd: { input?: Record<string, unknown> }) => {
      const input = cmd.input ?? {};
      if (input.Delete) {
        for (const o of (input.Delete as { Objects: Array<{ Key: string }> }).Objects) state.r2Deletes.push(o.Key);
        return { Errors: [] };
      }
      if (input.Body !== undefined) { state.r2Puts.push(input.Key as string); return {}; }
      const buf = state.objects[input.Key as string];
      if (!buf) throw new Error("NoSuchKey");
      return { Body: { transformToByteArray: async () => buf } };
    }),
  },
  R2_BUCKET: "b",
}));

import { POST as TICKET_PRODUCE } from "@/app/api/admin/ticket-shed/route";
import { POST as TICKET_COMMIT } from "@/app/api/admin/ticket-shed/commit/route";
import { POST as TICKET_RESTORE } from "@/app/api/admin/ticket-shed/restore/route";
import { isShedTicketKey, changedSinceCapture, TICKET_CAPTURE_SKEW_MS } from "@/lib/ticketShed";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PRODUCED = "2026-10-01T12:00:00.000Z";
const OLD = "2025-01-01T00:00:00.000Z";
const bytes = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const post = (url: string, body: unknown) => new NextRequest(url, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const commit = async () => {
  const res = await TICKET_COMMIT(post("https://app/api/admin/ticket-shed/commit", { orgId: ORG, archiveId: "arch1", confirm: true }));
  return { res, body: (await res.json()) as Record<string, unknown> };
};

type Opts = {
  tickets: Array<Record<string, unknown>>;
  liveRevisionKeys?: string[];
  /** key → ids of live tickets that name it (the other-live-ticket check). */
  liveTicketsNaming?: Record<string, string[]>;
  liveTicketReadError?: boolean;
  stampCount?: number;
};
let stamps: Array<{ id: unknown; ops: Op[] }>;
let unclaims: Array<{ id: unknown; ops: Op[] }>;
let commentDeletes: number;

function resolver(o: Opts) {
  return (table: string, ops: Op[]) => {
    if (table === "archives") {
      if (argOf(ops, "update")) return { data: [], error: null };
      if (argOf(ops, "maybeSingle")) return { data: { note: "1 closed ticket(s)", created_at: PRODUCED }, error: null };
      return { data: [], error: null };
    }
    if (table === "tickets") {
      const upd = argOf(ops, "update")?.[0] as Record<string, unknown> | undefined;
      if (upd && "archived_at" in upd) { stamps.push({ id: filter(ops, "eq", "id"), ops }); return { data: null, error: null, count: o.stampCount ?? 1 }; }
      if (upd && "archive_id" in upd && upd.archive_id === null) { unclaims.push({ id: filter(ops, "eq", "id"), ops }); return { data: null, error: null }; }
      if (hasOp(ops, "contains", "attachments")) {
        if (o.liveTicketReadError) return { data: null, error: { message: "down" } };
        const key = (JSON.parse(String(filter(ops, "contains", "attachments"))) as Array<{ url: string }>)[0].url;
        return { data: (o.liveTicketsNaming?.[key] ?? []).map((id) => ({ id })), error: null };
      }
      if (hasOp(ops, "not", "archived_at")) {
        // the commit's "still archived" re-check: every stamped / pre-stamped id
        const ids = (filter(ops, "in", "id") as string[] | undefined) ?? [];
        return { data: ids.map((id) => ({ id })), error: null };
      }
      return { data: o.tickets, error: null };
    }
    if (table === "document_versions") {
      const keys = (filter(ops, "in", "file_url") as string[] | undefined) ?? [];
      return { data: (o.liveRevisionKeys ?? []).filter((k) => keys.includes(k)).map((k, i) => ({ id: `v${i}`, file_url: k })), error: null };
    }
    if (table === "ticket_comments" && argOf(ops, "delete")) { commentDeletes++; return { data: null, error: null }; }
    return { data: [], error: null };
  };
}

const captured = (over: Record<string, unknown>) => ({
  id: "t1", ticket_id: "KE-26-0117", status: "CLOSED", last_modified: OLD, archived_at: null,
  attachments: [{ url: `orgs/${ORG}/tickets/KE-26-0117/1_ifc.pdf`, name: "ifc.pdf" }],
  comments: [{ id: "c1", text: "done" }], history: [{ action: "Close" }], metadata: {},
  ...over,
});

beforeEach(() => {
  state.resolve = () => ({ data: [], error: null });
  state.r2Deletes = []; state.r2Puts = []; state.objects = {}; state.calls = [];
  stamps = []; unclaims = []; commentDeletes = 0;
});

describe("lib/ticketShed — the pure halves (DF-P11)", () => {
  it("isShedTicketKey: this workspace's request files only", () => {
    expect(isShedTicketKey(`orgs/${ORG}/tickets/KE-1/1_a.pdf`, ORG)).toBe(true);
    expect(isShedTicketKey(`orgs/${ORG}/tickets/pending/${OTHER}/b/1_a.pdf`, ORG)).toBe(true);
    expect(isShedTicketKey(`orgs/${ORG}/project-intake/p1/redlines/abc-r.png`, ORG)).toBe(true);
    expect(isShedTicketKey(`orgs/${ORG}/project-intake/p1/abc-drawing.pdf`, ORG)).toBe(false);
    expect(isShedTicketKey(`orgs/${ORG}/libraries/l/P-101.pdf`, ORG)).toBe(false);
    expect(isShedTicketKey(`orgs/${OTHER}/tickets/KE-1/1_a.pdf`, ORG)).toBe(false);
    expect(isShedTicketKey(`orgs/${ORG}/tickets/../libraries/x.pdf`, ORG)).toBe(false);
    expect(isShedTicketKey(`orgs/${ORG}/tickets/`, ORG)).toBe(false);
    expect(isShedTicketKey(null, ORG)).toBe(false);
  });
  it("changedSinceCapture: left terminal, written since (with the clock margin), or free", () => {
    expect(changedSinceCapture({ status: "PENDING_REVIEW", last_modified: OLD }, PRODUCED)).toBe("left_terminal");
    expect(changedSinceCapture({ status: "CLOSED", last_modified: "2026-10-02T00:00:00Z" }, PRODUCED)).toBe("changed_since_capture");
    const justBefore = new Date(Date.parse(PRODUCED) - TICKET_CAPTURE_SKEW_MS / 2).toISOString();
    expect(changedSinceCapture({ status: "CLOSED", last_modified: justBefore }, PRODUCED)).toBe("changed_since_capture");
    expect(changedSinceCapture({ status: "CLOSED", last_modified: OLD }, PRODUCED)).toBeNull();
    expect(changedSinceCapture({ status: "CANCELED", last_modified: null }, PRODUCED)).toBeNull();
    expect(changedSinceCapture({ status: "CLOSED", last_modified: OLD }, null)).toBeNull();
  });
});

describe("SM-4 — produce → reopen → commit: the live ticket survives", () => {
  it("a reopened ticket is refused 409 by name, returned to the live list, and NOTHING is stamped or deleted", async () => {
    state.resolve = resolver({ tickets: [captured({ status: "PENDING_REVIEW", last_modified: "2026-10-03T09:00:00Z" })] });
    const { res, body } = await commit();
    expect(res.status).toBe(409);
    expect(body.code).toBe("changed_since_capture");
    expect(String(body.error)).toContain("KE-26-0117 (now PENDING_REVIEW)");
    expect(body.changed).toEqual([{ id: "t1", ticketId: "KE-26-0117", status: "PENDING_REVIEW", reason: "left_terminal" }]);
    expect(stamps).toEqual([]);
    expect(state.r2Deletes).toEqual([]);
    expect(commentDeletes).toBe(0);
    // returned to the live list: archive_id cleared only on this archive's unstamped claim
    expect(unclaims).toHaveLength(1);
    const u = unclaims[0].ops;
    expect(filter(u, "eq", "archive_id")).toBe("arch1");
    expect(hasOp(u, "is", "archived_at")).toBe(true);
  });

  it("one reopened ticket among several: still nothing freed in that call; the re-run frees the rest", async () => {
    const tickets = [captured({}), captured({ id: "t2", ticket_id: "KE-26-0118", status: "DRAFTING" })];
    state.resolve = resolver({ tickets });
    expect((await commit()).res.status).toBe(409);
    expect(stamps).toEqual([]);
    // re-run: t2 was returned to the live list, so it is no longer selected
    state.resolve = resolver({ tickets: [tickets[0]] });
    const again = await commit();
    expect(again.res.status).toBe(200);
    expect(stamps.map((s) => s.id)).toEqual(["t1"]);
    expect(state.r2Deletes).toEqual([`orgs/${ORG}/tickets/KE-26-0117/1_ifc.pdf`]);
  });
});

describe("SM-9 — a comment posted after capture is never wiped unarchived", () => {
  it("a closed ticket written after the archive was produced is refused and returned to the live list", async () => {
    state.resolve = resolver({ tickets: [captured({ last_modified: "2026-10-02T08:00:00Z" })] });
    const { res, body } = await commit();
    expect(res.status).toBe(409);
    expect(String(body.error)).toContain("KE-26-0117 (changed since the archive was made)");
    expect(stamps).toEqual([]);
    expect(state.r2Deletes).toEqual([]);
  });

  it("the stamp compare-and-sets on terminal status and the last_modified it read (and on the null itself)", async () => {
    state.resolve = resolver({ tickets: [captured({}), captured({ id: "t2", ticket_id: "KE-26-0118", last_modified: null })] });
    const { res } = await commit();
    expect(res.status).toBe(200);
    expect(stamps).toHaveLength(2);
    const [a, b] = stamps.map((s) => s.ops);
    expect(filter(a, "in", "status")).toEqual(["CLOSED", "CANCELED"]);
    expect(filter(a, "eq", "last_modified")).toBe(OLD);
    expect(filter(b, "in", "status")).toEqual(["CLOSED", "CANCELED"]);
    expect(hasOp(b, "is", "last_modified")).toBe(true);
    expect(hasOp(b, "eq", "last_modified")).toBe(false);
  });

  it("a stamp that loses the race (count 0) frees nothing for that ticket", async () => {
    state.resolve = resolver({ tickets: [captured({})], stampCount: 0 });
    const { res, body } = await commit();
    expect(res.status).toBe(200);
    expect(body.reclaimedTickets).toBe(0);
    expect(state.r2Deletes).toEqual([]);
    expect((body.errors as string[]).some((e) => /raced — left untouched/.test(e))).toBe(true);
  });

  it("regression: an already-stamped stub (an interrupted earlier commit) is re-freed as before", async () => {
    state.resolve = resolver({ tickets: [captured({ archived_at: "2026-10-02T00:00:00Z", status: "CLOSED" })] });
    const { res, body } = await commit();
    expect(res.status).toBe(200);
    expect(stamps).toEqual([]);
    expect(body.processed).toBe(1);
    expect(state.r2Deletes).toEqual([`orgs/${ORG}/tickets/KE-26-0117/1_ifc.pdf`]);
  });
});

describe("AUTHZ-5 — the reclaim deletes only this workspace's request files nobody else still uses", () => {
  const T = (n: string) => `orgs/${ORG}/tickets/KE-26-0117/${n}`;
  const REDLINE = `orgs/${ORG}/project-intake/p1/redlines/abc-markup.png`;
  const tickets = [captured({
    attachments: [
      { url: T("1_draft.pdf") }, { url: T("2_ifc.pdf") }, { url: T("3_shared.pdf") }, { url: T("4_copied.pdf") },
      { url: REDLINE },
      { url: `orgs/${ORG}/libraries/l/P-101-RevD.pdf` }, // a controlled drawing's key, planted
      { url: `orgs/${ORG}/knowledge/k1/manual.pdf` },   // another of this workspace's files, planted
      { url: `orgs/${OTHER}/tickets/KE-9/1_x.pdf` },     // another workspace's, planted
    ],
  })];

  it("deletes the request's own files and its redline; refuses the planted keys; skips a key a live revision or another live ticket still uses", async () => {
    state.resolve = resolver({ tickets, liveRevisionKeys: [T("3_shared.pdf")], liveTicketsNaming: { [T("4_copied.pdf")]: ["t-live"], [T("1_draft.pdf")]: ["t1"] } });
    const { res, body } = await commit();
    expect(res.status).toBe(200);
    expect(state.r2Deletes.sort()).toEqual([T("1_draft.pdf"), T("2_ifc.pdf"), REDLINE].sort());
    expect(body.rejectedKeys).toBe(3);
    expect(body.sharedSkipped).toBe(1);
    expect(body.sharedTicketSkipped).toBe(1);
  });

  it("a live-ticket read that fails stops the reclaim before any delete (503, the stubs say so)", async () => {
    state.resolve = resolver({ tickets, liveTicketReadError: true });
    const { res, body } = await commit();
    expect(res.status).toBe(503);
    expect(String(body.error)).toMatch(/refusing to delete/);
    expect(state.r2Deletes).toEqual([]);
    expect(commentDeletes).toBe(0);
  });

  it("produce: a ticket carrying a planted non-request key is skipped whole and counted; a redline is captured", async () => {
    const t1 = { id: "t1", org_id: ORG, ticket_id: "KE-1", title: "ok", status: "CLOSED", closed_at: OLD, last_modified: OLD, created_at: OLD, archived_at: null,
      attachments: [{ url: `orgs/${ORG}/tickets/KE-1/1_a.pdf`, size: 1 }, { url: REDLINE, size: 1 }], comments: [], history: [], metadata: {} };
    const t2 = { ...t1, id: "t2", ticket_id: "KE-2", attachments: [{ url: `orgs/${ORG}/libraries/l/P-101-RevD.pdf`, size: 1 }] };
    state.objects[`orgs/${ORG}/tickets/KE-1/1_a.pdf`] = bytes("a");
    state.objects[REDLINE] = bytes("r");
    state.objects[`orgs/${ORG}/libraries/l/P-101-RevD.pdf`] = bytes("controlled");
    const claimed: string[] = [];
    const unclaimed: string[] = [];
    state.resolve = (table, ops) => {
      if (table === "tickets") {
        const upd = argOf(ops, "update")?.[0] as Record<string, unknown> | undefined;
        const ids = (filter(ops, "in", "id") as string[] | undefined) ?? [];
        if (upd && upd.archive_id) { claimed.push(...ids); return { data: ids.map((id) => ({ id })), error: null }; }
        if (upd && upd.archive_id === null) { unclaimed.push(...ids); return { data: [], error: null }; }
        return { data: [t1, t2], error: null };
      }
      return { data: [], error: null };
    };
    const res = await TICKET_PRODUCE(post("https://app/api/admin/ticket-shed", { orgId: ORG, days: 30, confirm: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Archive-Tickets")).toBe("1");
    expect(res.headers.get("X-Archive-Rejected-Keys")).toBe("1");
    expect(unclaimed).toEqual(["t2"]);
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    expect(zip.files[`files/${REDLINE}`]).toBeDefined();
    expect(zip.files[`files/orgs/${ORG}/libraries/l/P-101-RevD.pdf`]).toBeUndefined();
  });
});

describe("SM-9 (restore) — only from the archive the stub was reclaimed into, compare-and-set on the stub", () => {
  const key = `orgs/${ORG}/tickets/KE-1/1_a.pdf`;
  async function restore(snapshotArchive: string | null, stub: { archive_id: string | null; last_modified: string | null }) {
    const zip = new JSZip();
    const b = bytes("abc");
    zip.file("tickets/t1.json", JSON.stringify({ id: "t1", org_id: ORG, archive_id: snapshotArchive, comments: [{ id: "c1" }], history: [], metadata: {}, attachments: [{ url: key }] }));
    zip.file(`files/${key}`, b);
    zip.file("files-manifest.json", JSON.stringify({ [key]: { sha256: sha(b), size: b.byteLength } }));
    const body = await zip.generateAsync({ type: "uint8array" });
    const updates: Op[][] = [];
    state.resolve = (table, ops) => {
      if (table === "tickets") {
        if (argOf(ops, "update")) { updates.push(ops); return { data: null, error: null, count: 1 }; }
        return { data: [{ id: "t1", attachments: [{ url: key }], ...stub }], error: null };
      }
      return { data: [], error: null };
    };
    const res = await TICKET_RESTORE(new NextRequest(`https://app/api/admin/ticket-shed/restore?orgId=${ORG}&confirm=true`, {
      method: "POST", body: body as unknown as BodyInit, headers: { "content-length": String(body.byteLength) },
    }));
    return { res, body: (await res.json()) as Record<string, unknown>, updates };
  }

  it("the matching archive restores, the write compare-and-sets on the stub's archive and last_modified", async () => {
    const { res, body, updates } = await restore("arch2", { archive_id: "arch2", last_modified: OLD });
    expect(res.status).toBe(200);
    expect(body.restored).toBe(1);
    expect(updates).toHaveLength(1);
    expect(filter(updates[0], "eq", "archive_id")).toBe("arch2");
    expect(filter(updates[0], "eq", "last_modified")).toBe(OLD);
  });

  it("a snapshot from an OLDER archive writes nothing (no bytes, no arrays) and is counted", async () => {
    const { res, body, updates } = await restore("arch1", { archive_id: "arch2", last_modified: OLD });
    expect(res.status).toBe(200);
    expect(body.restored).toBe(0);
    expect(body.staleSnapshot).toBe(1);
    expect(updates).toEqual([]);
    expect(state.r2Puts).toEqual([]);
  });

  it("regression: a snapshot that names no archive (older producer) restores as before; a null token is its own leg", async () => {
    const { body, updates } = await restore(null, { archive_id: "arch2", last_modified: null });
    expect(body.restored).toBe(1);
    expect(hasOp(updates[0], "is", "last_modified")).toBe(true);
  });
});
