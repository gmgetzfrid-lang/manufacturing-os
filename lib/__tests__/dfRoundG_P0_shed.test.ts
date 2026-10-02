// Drafting-flow Round G, package DF-P0 (records only — no application code):
// the EDGE-11 "all-or-nothing archive capture" invariant, pinned by driving
// the real ticket-shed PRODUCE handler rather than by a source string.
//
// The invariant: a ticket is committed to the archive only if EVERY one of
// its attachment binaries was read. One unreadable binary skips the whole
// ticket — nothing of it lands in the zip, it is un-claimed (archive_id
// cleared) so commit can never free a file the saved zip does not hold, and
// the skip is counted. When no selected ticket can be captured, nothing is
// archived at all and the reserved catalog row is removed.
//
// Harness: the vi.hoisted state + Proxy-chain mock of dcRoundFShed.test.ts
// (itself the shedLegalHold.test.ts shape) — every builder call is recorded
// and a per-test resolver answers from the recorded ops; the R2 mock throws
// NoSuchKey for an object it does not hold.

import { describe, it, expect, vi, beforeEach } from "vitest";
import JSZip from "jszip";
import { NextRequest } from "next/server";

type Op = { m: string; args: unknown[] };
const state = vi.hoisted(() => ({
  resolve: ((_table: string, _ops: Array<{ m: string; args: unknown[] }>) => ({ data: [], error: null })) as
    (table: string, ops: Array<{ m: string; args: unknown[] }>) => { data?: unknown; error?: unknown; count?: number },
  objects: {} as Record<string, Uint8Array>,
  reads: [] as string[],
}));

const argOf = (ops: Op[], m: string) => ops.find((o) => o.m === m)?.args;
const filter = (ops: Op[], m: string, col: string) => ops.find((o) => o.m === m && o.args[0] === col)?.args[1];

function chain(table: string) {
  const ops: Op[] = [];
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
  authorizeOrgRole: vi.fn(async () => ({ admin: { from: (t: string) => chain(t) }, userId: "admin1", email: "a@x" })),
}));
vi.mock("@/lib/r2", () => ({
  r2: {
    send: vi.fn(async (cmd: { input?: Record<string, unknown> }) => {
      const key = (cmd.input ?? {}).Key as string | undefined;
      if (key === undefined) return {};
      state.reads.push(key);
      const buf = state.objects[key];
      if (!buf) throw new Error("NoSuchKey");
      return { Body: { transformToByteArray: async () => buf }, ContentType: "application/pdf" };
    }),
  },
  R2_BUCKET: "b",
}));

import { POST as TICKET_PRODUCE } from "@/app/api/admin/ticket-shed/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const OLD = "2025-01-01T00:00:00Z";
const bytes = (s: string) => new TextEncoder().encode(s);
const key = (t: string, f: string) => `orgs/${ORG}/tickets/${t}/${f}`;
const closed = (id: string, files: string[]) => ({
  id, org_id: ORG, ticket_id: `T-${id}`, title: id, status: "CLOSED", closed_at: OLD, last_modified: OLD, created_at: OLD,
  archived_at: null, attachments: files.map((f) => ({ url: key(id, f), size: 1 })), comments: [], history: [], metadata: {},
});
const produce = () => TICKET_PRODUCE(new NextRequest("https://app/api/admin/ticket-shed", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: ORG, days: 30, confirm: true }),
}));

function resolver(opts: { tickets: Array<Record<string, unknown>>; claims: string[][]; unclaims: string[][]; archiveDeletes: number[] }) {
  return (table: string, ops: Op[]) => {
    if (table === "archives") {
      if (argOf(ops, "delete")) opts.archiveDeletes.push(1);
      return { data: [], error: null };
    }
    if (table === "tickets") {
      const upd = argOf(ops, "update")?.[0] as Record<string, unknown> | undefined;
      const ids = (filter(ops, "in", "id") as string[] | undefined) ?? [];
      if (upd && "archive_id" in upd && upd.archive_id) { opts.claims.push(ids); return { data: ids.map((id) => ({ id })), error: null }; }
      if (upd && "archive_id" in upd && !upd.archive_id) { opts.unclaims.push(ids); return { data: [], error: null }; }
      return { data: opts.tickets, error: null };
    }
    return { data: [], error: null };
  };
}

beforeEach(() => {
  state.resolve = () => ({ data: [], error: null });
  state.objects = {};
  state.reads = [];
});

describe("EDGE-11 — all-or-nothing ticket-shed capture (route harness)", () => {
  it("a ticket with one unreadable binary is skipped WHOLE — no row, no comments, none of its files in the zip — un-claimed and counted; a fully readable ticket is captured", async () => {
    state.objects[key("t1", "a.pdf")] = bytes("t1-a");
    state.objects[key("t1", "b.pdf")] = bytes("t1-b");
    state.objects[key("t2", "a.pdf")] = bytes("t2-a"); // t2's second file is missing
    const claims: string[][] = [], unclaims: string[][] = [], archiveDeletes: number[] = [];
    state.resolve = resolver({ tickets: [closed("t1", ["a.pdf", "b.pdf"]), closed("t2", ["a.pdf", "b.pdf"])], claims, unclaims, archiveDeletes });

    const res = await produce();
    expect(res.status).toBe(200);
    expect(claims.flat().sort()).toEqual(["t1", "t2"]);
    expect(unclaims.flat()).toEqual(["t2"]);
    expect(res.headers.get("X-Archive-Tickets")).toBe("1");
    expect(res.headers.get("X-Archive-Skipped")).toBe("1");
    expect(res.headers.get("X-Archive-Files")).toBe("2");
    // the binary that WAS readable for t2 was read, and still left out
    expect(state.reads).toContain(key("t2", "a.pdf"));

    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    expect(zip.files["tickets/t1.json"]).toBeDefined();
    expect(zip.files[`files/${key("t1", "a.pdf")}`]).toBeDefined();
    expect(zip.files[`files/${key("t1", "b.pdf")}`]).toBeDefined();
    expect(zip.files["tickets/t2.json"]).toBeUndefined();
    expect(zip.files[`files/${key("t2", "a.pdf")}`]).toBeUndefined();
    const manifest = JSON.parse(await zip.files["files-manifest.json"].async("string")) as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual([key("t1", "a.pdf"), key("t1", "b.pdf")]);
    expect(archiveDeletes).toHaveLength(0);
  });

  it("when no selected ticket can be fully captured, nothing is archived: 502, every claim released, the reserved catalog row removed", async () => {
    const claims: string[][] = [], unclaims: string[][] = [], archiveDeletes: number[] = [];
    state.resolve = resolver({ tickets: [closed("t1", ["a.pdf"])], claims, unclaims, archiveDeletes });
    const res = await produce();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/Could not fully capture any selected ticket/);
    expect(unclaims.flat()).toEqual(["t1"]);
    expect(archiveDeletes).toHaveLength(1);
  });
});
