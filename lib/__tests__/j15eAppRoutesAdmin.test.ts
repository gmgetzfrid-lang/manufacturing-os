// projects-joint J15e APP AND COMPONENT WRITE SWEEP, batch J15e-app
// (projects-tab SAF-22) — the admin storage routes: the two produces (space
// and ticket shed), the space commit, archive-cancel and the purge, plus the
// count adapter (lib/checkedWriteCount.ts) and the guard builders
// (lib/writeFilters.ts) they and the other routes use.
//
// Driven against lib/__tests__/helpers/fakeSupabase.ts (the admin client the
// gate hands the route). A table in `refuseWrites` answers an UPDATE / DELETE
// with zero rows; a `beforeUpdate` trigger that throws is the database's
// error. Every zero-row / error case is paired with the ordinary path.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import JSZip from "jszip";
import { newFakeDb, type FakeDb, type Row } from "./helpers/fakeSupabase";
import { checkedWrite } from "@/lib/checkedWrite";
import { counted, countKept } from "@/lib/checkedWriteCount";
import { eqOrNull, withFilters } from "@/lib/writeFilters";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, objects: {} as Record<string, Uint8Array>, r2Deletes: [] as string[] }));

vi.mock("@/lib/serverAuth", async () => {
  const { makeFakeSupabase } = await import("./helpers/fakeSupabase");
  return {
    authorizeOrgRole: vi.fn(async () => ({ admin: { from: (t: string) => makeFakeSupabase(h.db).from(t) }, userId: "admin1", email: "a@x", role: "Admin", roles: ["Admin"] })),
  };
});
vi.mock("@/lib/r2", () => ({
  r2: {
    send: vi.fn(async (cmd: { input?: Record<string, unknown> }) => {
      const del = cmd.input?.Delete as { Objects: Array<{ Key: string }> } | undefined;
      if (del) { h.r2Deletes.push(...del.Objects.map((o) => o.Key)); return { Errors: [] }; }
      const key = cmd.input?.Key as string | undefined;
      const buf = key ? h.objects[key] : undefined;
      if (!buf) throw new Error("NoSuchKey");
      return { Body: { transformToByteArray: async () => buf } };
    }),
  },
  R2_BUCKET: "b",
}));
vi.mock("@/lib/shed", () => ({ selectShedCandidates: (rows: unknown[]) => ({ selected: rows, skipped: 0 }) }));
vi.mock("@/lib/shedKeyGuard", async (orig) => ({ ...(await orig<typeof import("@/lib/shedKeyGuard")>()), sharedLiveKeys: async () => new Set<string>() }));
vi.mock("@/lib/storageKeyRegistry", () => ({ keysReferencedOutside: async () => new Set<string>() }));
vi.mock("@/lib/ticketShed", async (orig) => ({
  ...(await orig<typeof import("@/lib/ticketShed")>()),
  selectTicketShedCandidates: (rows: Array<{ id: string }>) => ({ selected: rows, totalCount: rows.length, skipped: 0 }),
}));
vi.mock("@/lib/ai/usageServer", () => ({ monthStartIso: () => "2026-11-01T00:00:00.000Z" }));

import { POST as SHED_PRODUCE } from "@/app/api/admin/shed/route";
import { POST as TICKET_PRODUCE } from "@/app/api/admin/ticket-shed/route";
import { POST as CANCEL } from "@/app/api/admin/archive-cancel/route";
import { POST as SHED_COMMIT } from "@/app/api/admin/shed/commit/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const key = (n: string) => `orgs/${ORG}/libraries/l/${n}.pdf`;
const post = (url: string, body: unknown) => new NextRequest(`https://app${url}`, {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" }, body: JSON.stringify(body),
});
const rows = (t: string) => (h.db.tables[t] ??= []);
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.db = newFakeDb();
  h.objects = {};
  h.r2Deletes = [];
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  errSpy.mockClear();
});

describe("lib/checkedWriteCount — a count-only write, read the way checkedWrite reads rows", () => {
  it("a positive count is a match, zero is a refusal (the verdict), the count and the whole error are kept", async () => {
    const k1 = countKept();
    expect(await checkedWrite(counted(Promise.resolve({ count: 3, error: null }), k1))).toMatchObject({ ok: true });
    expect(k1).toEqual({ count: 3, error: null });
    const k0 = countKept();
    expect(await checkedWrite(counted(Promise.resolve({ count: 0, error: null }), k0))).toMatchObject({ ok: false, code: "refused" });
    expect(k0.count).toBe(0);
    const ke = countKept();
    const err = { code: "PGRST204", message: "Could not find the 'embed_attempts' column of 'knowledge_chunks' in the schema cache" };
    expect(await checkedWrite(counted(Promise.resolve({ count: null, error: err }), ke))).toMatchObject({ ok: false, code: "db" });
    expect(ke.error).toBe(err);
    // an answer with no count (a proxy that drops it) keeps null — the caller decides
    const kn = countKept();
    await checkedWrite(counted(Promise.resolve({ error: null }), kn));
    expect(kn.count).toBeNull();
    // a request that throws is kept as the error and reported, never thrown
    const kt = countKept();
    expect(await checkedWrite(counted(Promise.reject(new Error("fetch failed")), kt))).toMatchObject({ ok: false, code: "db" });
    expect(kt.error?.message).toBe("fetch failed");
  });
});

describe("lib/writeFilters — the guard legs, sent exactly as the `let q` form sent them", () => {
  const rec = () => {
    const calls: unknown[][] = [];
    const q: Record<string, (...a: unknown[]) => unknown> = {};
    q.eq = (...a) => { calls.push(["eq", ...a]); return q; };
    q.is = (...a) => { calls.push(["is", ...a]); return q; };
    q.in = (...a) => { calls.push(["in", ...a]); return q; };
    return { q, calls };
  };
  it("eqOrNull: a value is `.eq`, a null / empty value is `.is(col, null)`", () => {
    for (const [v, want] of [["t1", ["eq", "last_modified", "t1"]], [null, ["is", "last_modified", null]], [undefined, ["is", "last_modified", null]], ["", ["is", "last_modified", null]]] as const) {
      const { q, calls } = rec();
      expect(eqOrNull(q, "last_modified", v)).toBe(q);
      expect(calls).toEqual([want]);
    }
  });
  it("withFilters applies the conditional legs in order", () => {
    const { q, calls } = rec();
    withFilters(q, (b) => (b.in("org_id", ["o1"]) as typeof q));
    expect(calls).toEqual([["in", "org_id", ["o1"]]]);
  });
});

describe("space produce (admin/shed) — the claim, the un-claim, the catalog and the reservation", () => {
  const seed = (names: string[], readable = names) => {
    h.db.tables.document_versions = names.map((n, i) => ({ id: `v${i + 1}`, org_id: ORG, file_url: key(n), size: 3, record_id: `d${i + 1}`, archived_at: null, archive_id: null, created_at: "2020-01-01" }));
    for (const n of readable) h.objects[key(n)] = new TextEncoder().encode(n);
  };
  const produce = () => SHED_PRODUCE(post("/api/admin/shed", { orgId: ORG, confirm: true }));

  it("ordinary path: the versions are claimed, bundled and the catalog row counts them — as before", async () => {
    seed(["a", "b"]);
    const res = await produce();
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Archive-Files")).toBe("2");
    const archiveId = res.headers.get("X-Archive-Id");
    expect(rows("document_versions").map((v) => v.archive_id)).toEqual([archiveId, archiveId]);
    expect(rows("archives")[0]).toMatchObject({ archive_id: archiveId, file_count: 2, total_bytes: 2 });
    expect(errSpy).not.toHaveBeenCalled();
  });
  it("REPRODUCED: a claim the database refused read as 'just archived by another run' (409); now its reason (503), and the reservation is dropped", async () => {
    seed(["a"]);
    h.db.beforeUpdate!.document_versions = () => { throw { code: "40001", message: "could not serialize access" }; };
    const res = await produce();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("The revisions could not be claimed for the archive (could not serialize access). Nothing was archived.");
    expect(rows("archives")).toEqual([]);
  });
  it("a claim that loses the race (zero rows) answers as before: 409, the reservation dropped", async () => {
    seed(["a"]);
    h.db.refuseWrites.add("document_versions");
    const res = await produce();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Those revisions were just archived by another run.");
    expect(rows("archives")).toEqual([]);
  });
  it("an un-claim of an unreadable binary that fails is logged and never fails the produce (class b)", async () => {
    seed(["a", "b"], ["a"]);
    h.db.beforeUpdate!.document_versions = (next) => { if (next.archive_id === null) throw { message: "statement timeout" }; return next; };
    const res = await produce();
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Archive-Files")).toBe("1");
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/1 of 1 unreadable revision\(s\) were not un-claimed from .*; Discard frees them/), "statement timeout");
  });
  it("a catalog finalize that fails is logged; the archive is still produced (class b)", async () => {
    seed(["a"]);
    h.db.beforeUpdate!.archives = () => { throw { message: "permission denied for table archives" }; };
    const res = await produce();
    expect(res.status).toBe(200);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/the catalog row of .* was not updated with its counts/), "permission denied for table archives");
  });
  it("a reservation that cannot be dropped on an abandoned produce is logged (class c); the abort answers as before", async () => {
    seed(["a"], []);
    h.db.deleteErrors!.archives = { message: "delete refused" };
    const res = await produce();
    expect(res.status).toBe(502);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/the reserved catalog row .* could not be dropped/), "delete refused");
  });
});

describe("ticket produce (admin/ticket-shed) — the claim and the catalog", () => {
  const tkey = `orgs/${ORG}/tickets/KE-1/1_a.pdf`;
  const seed = () => {
    h.db.tables.tickets = [{ id: "t1", org_id: ORG, status: "CLOSED", archive_id: null, archived_at: null, attachments: [{ url: tkey }], last_modified: "2020-01-01", created_at: "2020-01-01" }];
    h.objects[tkey] = new TextEncoder().encode("x");
  };
  const produce = () => TICKET_PRODUCE(post("/api/admin/ticket-shed", { orgId: ORG, confirm: true }));
  it("ordinary path: the ticket is claimed and bundled, the catalog counts it", async () => {
    seed();
    const res = await produce();
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(zip.files)).toContain("tickets/t1.json");
    expect(rows("tickets")[0].archive_id).toBe(res.headers.get("X-Archive-Id"));
    expect(rows("archives")[0]).toMatchObject({ file_count: 1 });
  });
  it("a claim the database refused is said (503), never 'archived by another run'", async () => {
    seed();
    h.db.beforeUpdate!.tickets = () => { throw { message: "deadlock detected" }; };
    const res = await produce();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("The tickets could not be claimed for the archive (deadlock detected). Nothing was archived.");
    expect(rows("archives")).toEqual([]);
  });
  it("a catalog finalize that fails is logged, the archive stands", async () => {
    seed();
    h.db.beforeUpdate!.archives = () => { throw { message: "nope" }; };
    expect((await produce()).status).toBe(200);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/\[admin\/ticket-shed\] the catalog row of .* was not updated/), "nope");
  });
});

describe("archive-cancel — the catalog row is said removed only when the delete matched it", () => {
  const seed = () => {
    h.db.tables.tickets = [{ id: "t1", org_id: ORG, archive_id: "MOS-X", archived_at: null }];
    h.db.tables.document_versions = [{ id: "v1", org_id: ORG, archive_id: "MOS-X", archived_at: null }];
    h.db.tables.archives = [{ id: "a1", org_id: ORG, archive_id: "MOS-X" }];
  };
  it("ordinary path: catalogRemoved true, as before", async () => {
    seed();
    const body = await (await CANCEL(post("/api/admin/archive-cancel", { orgId: ORG, archiveId: "MOS-X" }))).json();
    expect(body).toMatchObject({ ok: true, ticketsUnlinked: 1, versionsUnlinked: 1, catalogRemoved: true });
    expect(rows("archives")).toEqual([]);
  });
  it("REPRODUCED: a catalog delete that matched no row (a concurrent Discard) answered catalogRemoved: true; now false, and the row says so", async () => {
    seed();
    h.db.refuseWrites.add("archives");
    const body = await (await CANCEL(post("/api/admin/archive-cancel", { orgId: ORG, archiveId: "MOS-X" }))).json() as Row;
    expect(body).toMatchObject({ ok: true, catalogRemoved: false });
    const audit = rows("audit_logs").find((r) => r.action === "ARCHIVE_PRODUCE_CANCELED")!;
    expect((audit.details as Row).catalogRemoved).toBe(false);
  });
  it("an archive with no uncommitted revision unlinks none (class c) and still answers ok", async () => {
    seed();
    h.db.tables.document_versions = [];
    const body = await (await CANCEL(post("/api/admin/archive-cancel", { orgId: ORG, archiveId: "MOS-X" }))).json();
    expect(body).toMatchObject({ ok: true, versionsUnlinked: 0 });
  });
});

describe("space commit (admin/shed/commit) — the stamp counts only the rows it matched (class c)", () => {
  const seed = () => {
    h.db.tables.archives = [{ id: "a1", org_id: ORG, archive_id: "MOS-S", note: "2 superseded revision binaries" }];
    h.db.tables.document_versions = [
      { id: "v1", org_id: ORG, archive_id: "MOS-S", archived_at: null, file_url: key("a"), record_id: "d1" },
      { id: "v2", org_id: ORG, archive_id: "MOS-S", archived_at: null, file_url: key("b"), record_id: "d2" },
    ];
  };
  const commit = () => SHED_COMMIT(post("/api/admin/shed/commit", { orgId: ORG, archiveId: "MOS-S", confirm: true }));
  it("ordinary path: both stamped, both keys freed, as before", async () => {
    seed();
    const body = await (await commit()).json() as Row;
    expect(body).toMatchObject({ ok: true, reclaimed: 2, keysDeleted: 2 });
    expect(h.r2Deletes.sort()).toEqual([key("a"), key("b")]);
  });
  it("a stamp a concurrent commit already made matches nothing: nothing is counted reclaimed and no byte is freed for it", async () => {
    seed();
    h.db.refuseWrites.add("document_versions");
    const body = await (await commit()).json() as Row;
    expect(body).toMatchObject({ ok: true, reclaimed: 0, keysDeleted: 0 });
    expect(h.r2Deletes).toEqual([]);
  });
  it("a stamp the database refused is named in errors, as before", async () => {
    seed();
    h.db.beforeUpdate!.document_versions = () => { throw { message: "permission denied for table document_versions" }; };
    const body = await (await commit()).json() as { errors: string[]; reclaimed: number };
    expect(body.reclaimed).toBe(0);
    expect(body.errors).toContain("stamp[0]: permission denied for table document_versions");
  });
});
