// Document-control Round F — the destructive-delete class (sequencing item 6):
//   RET-6  keys read from member-writable columns are trusted for deletion
//          only under this org's prefix (produce AND commit, documents AND
//          tickets);
//   RET-8  a storage key a live revision outside the archive still shares is
//          never claimed at produce and never freed at commit;
//   RET-12 produce hashes the bytes it captured; a mismatch un-claims;
//   RET-13 the delete shortfall is persisted on the catalog row;
//   RET-14 restore writes only exact-path, manifest-verified bytes;
//   RET-7  the orphan sweep is confined to the caller's org prefix.
//   intelligence ILIFE-5 (admin-and-org Round G P2, second review fix pass):
//          a key a knowledge-library mirror still names is never claimed at
//          produce and never freed at commit.
//
// Route tests use the vi.hoisted state + Proxy-chain mock shape of
// shedLegalHold.test.ts, generalised: every builder call is recorded and a
// per-test resolver answers from the recorded ops.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { NextRequest } from "next/server";

type Op = { m: string; args: unknown[] };
const state = vi.hoisted(() => ({
  resolve: ((_table: string, _ops: Array<{ m: string; args: unknown[] }>) => ({ data: [], error: null })) as
    (table: string, ops: Array<{ m: string; args: unknown[] }>) => { data?: unknown; error?: unknown; count?: number },
  r2Deletes: [] as string[],
  r2Errors: [] as Array<{ Key: string; Message: string }>,
  r2Puts: [] as string[],
  objects: {} as Record<string, Uint8Array>,
  listPrefixes: [] as Array<string | undefined>,
  listing: [] as Array<{ Key: string; Size: number; LastModified: Date }>,
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
      const input = cmd.input ?? {};
      if (input.Delete) {
        for (const o of (input.Delete as { Objects: Array<{ Key: string }> }).Objects) state.r2Deletes.push(o.Key);
        return { Errors: state.r2Errors };
      }
      if (input.Body !== undefined) { state.r2Puts.push(input.Key as string); return {}; }
      if (input.Key !== undefined) {
        const buf = state.objects[input.Key as string];
        if (!buf) throw new Error("NoSuchKey");
        return { Body: { transformToByteArray: async () => buf } };
      }
      state.listPrefixes.push(input.Prefix as string | undefined);
      return { Contents: state.listing, IsTruncated: false };
    }),
  },
  R2_BUCKET: "b",
}));

import { isOrgOwnedKey, partitionOrgKeys, keysSharedOutside } from "@/lib/shedKeyGuard";
import { exactEntryFor, bytesMatchManifest } from "@/lib/restoreVerify";
import { GET as SHED_GET, POST as SHED_PRODUCE } from "@/app/api/admin/shed/route";
import { POST as SHED_COMMIT } from "@/app/api/admin/shed/commit/route";
import { POST as TICKET_PRODUCE } from "@/app/api/admin/ticket-shed/route";
import { POST as TICKET_COMMIT } from "@/app/api/admin/ticket-shed/commit/route";
import { POST as TICKET_RESTORE } from "@/app/api/admin/ticket-shed/restore/route";
import { scanOrphans, deleteOrphans } from "@/lib/storageOrphans";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

const post = (url: string, body: unknown) => new NextRequest(url, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  state.resolve = () => ({ data: [], error: null });
  state.r2Deletes = []; state.r2Errors = []; state.r2Puts = []; state.objects = {};
  state.listPrefixes = []; state.listing = [];
});

describe("lib/shedKeyGuard — the pure halves", () => {
  it("isOrgOwnedKey: only a safe key under orgs/<orgId>/", () => {
    expect(isOrgOwnedKey(`orgs/${ORG}/libraries/l/a.pdf`, ORG)).toBe(true);
    expect(isOrgOwnedKey(`orgs/${OTHER}/libraries/l/a.pdf`, ORG)).toBe(false);
    expect(isOrgOwnedKey(`orgs/${ORG}/../${OTHER}/a.pdf`, ORG)).toBe(false);
    expect(isOrgOwnedKey(`/orgs/${ORG}/a.pdf`, ORG)).toBe(false);
    expect(isOrgOwnedKey("", ORG)).toBe(false);
    expect(isOrgOwnedKey(null, ORG)).toBe(false);
    expect(isOrgOwnedKey(`orgs/${ORG}/a.pdf`, "")).toBe(false);
  });
  it("partitionOrgKeys splits rows by key ownership, preserving order", () => {
    const rows = [{ k: `orgs/${ORG}/1` }, { k: `orgs/${OTHER}/2` }, { k: null }, { k: `orgs/${ORG}/3` }];
    const { owned, rejected } = partitionOrgKeys(rows, ORG, (r) => r.k);
    expect(owned.map((r) => r.k)).toEqual([`orgs/${ORG}/1`, `orgs/${ORG}/3`]);
    expect(rejected.map((r) => r.k)).toEqual([`orgs/${OTHER}/2`, null]);
  });
  it("keysSharedOutside: a key is shared when a live row OUTSIDE the set references it", () => {
    const live = [{ id: "old", file_url: "k1" }, { id: "cur", file_url: "k1" }, { id: "solo", file_url: "k2" }];
    expect([...keysSharedOutside(live, new Set(["old", "solo"]))]).toEqual(["k1"]);
    expect([...keysSharedOutside(live, new Set(["old", "cur", "solo"]))]).toEqual([]);
    expect([...keysSharedOutside(live, new Set(["solo"]))]).toEqual(["k1"]);
    expect([...keysSharedOutside(live, new Set(["old", "cur"]))]).toEqual(["k2"]);
  });
});

// ── document shed ────────────────────────────────────────────────────────────

const version = (id: string, key: string, extra: Record<string, unknown> = {}) => ({
  id, record_id: `doc-${id}`, file_url: key, size: 10, superseded_at: "2026-01-01T00:00:00Z",
  archived_at: null, archive_id: null, created_at: "2026-01-01T00:00:00Z", revision_label: "1", file_hash: null, ...extra,
});
/** Two revisions per document (keep=1 → the older one is eligible). */
const pair = (id: string, key: string, extra: Record<string, unknown> = {}) => [
  version(id, key, extra),
  { ...version(`${id}-cur`, `orgs/${ORG}/cur-${id}.pdf`), record_id: `doc-${id}`, superseded_at: null, created_at: "2026-02-01T00:00:00Z" },
];

function shedResolver(opts: {
  versions: Array<Record<string, unknown>>; liveRows?: Array<{ id: string; file_url: string }>;
  liveError?: string; claims?: string[][]; unclaims?: string[][]; stamps?: string[][]; archiveUpdates?: Array<Record<string, unknown>>;
  archiveUpdateError?: { code?: string; message: string };
  /** ILIFE-5: knowledge_documents.file_key values (a mirror of a controlled revision names the SAME key). */
  mirrorKeys?: string[]; mirrorError?: string;
  /** The mirror read is cut by a server row cap: its exact count is above the rows it returns. */
  mirrorCapped?: boolean;
}) {
  return (table: string, ops: Op[]) => {
    if (table === "documents") return { data: [], error: null };
    if (table === "knowledge_documents") {
      const keys = (filter(ops, "in", "file_key") as string[] | undefined) ?? [];
      if (opts.mirrorError) return { data: null, error: { message: opts.mirrorError } };
      const hits = (opts.mirrorKeys ?? []).filter((k) => keys.includes(k)).map((k) => ({ file_key: k }));
      if (opts.mirrorCapped) return { data: [], count: hits.length + 1000, error: null };
      return { data: hits, error: null };
    }
    if (table === "archives") {
      if (argOf(ops, "update")) {
        opts.archiveUpdates?.push(argOf(ops, "update")![0] as Record<string, unknown>);
        return opts.archiveUpdateError ? { data: null, error: opts.archiveUpdateError } : { data: [], error: null };
      }
      if (argOf(ops, "maybeSingle")) return { data: { note: "saved" }, error: null };
      return { data: [], error: null };
    }
    if (table === "document_versions") {
      const upd = argOf(ops, "update")?.[0] as Record<string, unknown> | undefined;
      const ids = (filter(ops, "in", "id") as string[] | undefined) ?? [];
      if (upd && "archive_id" in upd && upd.archive_id) { opts.claims?.push(ids); return { data: ids.map((id) => ({ id })), error: null }; }
      if (upd && "archive_id" in upd && !upd.archive_id) { opts.unclaims?.push(ids); return { data: [], error: null }; }
      if (upd && "archived_at" in upd) {
        opts.stamps?.push(ids);
        return { data: opts.versions.filter((v) => ids.includes(v.id as string)).map((v) => ({ file_url: v.file_url })), error: null };
      }
      const keys = filter(ops, "in", "file_url") as string[] | undefined;
      if (keys) {
        if (opts.liveError) return { data: null, error: { message: opts.liveError } };
        return { data: (opts.liveRows ?? []).filter((r) => keys.includes(r.file_url)), error: null };
      }
      if (filter(ops, "in", "source_file_key")) return { data: [], error: null };
      return { data: opts.versions, error: null };
    }
    return { data: [], error: null };
  };
}

describe("shed produce — RET-6 prefix, RET-8 shared key, RET-12 hash at capture", () => {
  it("preview excludes a foreign-prefixed key and a key a current revision shares, and reports both counts", async () => {
    const versions = [
      ...pair("ok", `orgs/${ORG}/ok.pdf`),
      ...pair("foreign", `orgs/${OTHER}/stolen.pdf`),
      ...pair("shared", `orgs/${ORG}/shared.pdf`),
    ];
    state.resolve = shedResolver({ versions, liveRows: [{ id: "shared", file_url: `orgs/${ORG}/shared.pdf` }, { id: "revert-row", file_url: `orgs/${ORG}/shared.pdf` }] });
    const res = await SHED_GET(new NextRequest(`https://app/api/admin/shed?orgId=${ORG}&keep=1`));
    const body = (await res.json()) as { selectedCount: number; rejectedKeys: number; sharedSkipped: number; sample: Array<{ id: string }> };
    expect(res.status).toBe(200);
    expect(body.sample.map((s) => s.id)).toEqual(["ok"]);
    expect(body.selectedCount).toBe(1);
    expect(body.rejectedKeys).toBe(1);
    expect(body.sharedSkipped).toBe(1);
  });

  it("preview fails CLOSED when the shared-key read errors", async () => {
    state.resolve = shedResolver({ versions: pair("ok", `orgs/${ORG}/ok.pdf`), liveError: "db down" });
    const res = await SHED_GET(new NextRequest(`https://app/api/admin/shed?orgId=${ORG}&keep=1`));
    expect(res.status).toBe(503);
  });

  it("produce never claims a foreign or shared key; hashes what it captured; un-claims a hash mismatch", async () => {
    const good = bytes("good bytes");
    const drifted = bytes("not what the record says");
    state.objects[`orgs/${ORG}/ok.pdf`] = good;
    state.objects[`orgs/${ORG}/drift.pdf`] = drifted;
    state.objects[`orgs/${ORG}/nohash.pdf`] = bytes("unhashed");
    const versions = [
      ...pair("ok", `orgs/${ORG}/ok.pdf`, { file_hash: sha(good).toUpperCase() }),
      ...pair("drift", `orgs/${ORG}/drift.pdf`, { file_hash: sha("the original upload") }),
      ...pair("nohash", `orgs/${ORG}/nohash.pdf`),
      ...pair("foreign", `orgs/${OTHER}/stolen.pdf`),
      ...pair("shared", `orgs/${ORG}/shared.pdf`),
    ];
    const claims: string[][] = [], unclaims: string[][] = [], archiveUpdates: Array<Record<string, unknown>> = [];
    state.resolve = shedResolver({
      versions, claims, unclaims, archiveUpdates,
      liveRows: [{ id: "shared", file_url: `orgs/${ORG}/shared.pdf` }, { id: "revert-row", file_url: `orgs/${ORG}/shared.pdf` }],
    });
    const res = await SHED_PRODUCE(post("https://app/api/admin/shed", { orgId: ORG, keep: 1, confirm: true }));
    expect(res.status).toBe(200);
    // Only org-owned, unshared rows were ever claimed.
    expect(claims.flat().sort()).toEqual(["drift", "nohash", "ok"]);
    // The hash-mismatched row was un-claimed (commit can never free it).
    expect(unclaims.flat()).toEqual(["drift"]);
    expect(res.headers.get("X-Archive-Files")).toBe("2");
    expect(res.headers.get("X-Archive-Hash-Mismatch")).toBe("1");
    expect(res.headers.get("X-Archive-Unhashed")).toBe("1");
    expect(res.headers.get("X-Archive-Rejected-Keys")).toBe("1");
    expect(res.headers.get("X-Archive-Shared-Skipped")).toBe("1");
    // The manifest records the hash of the bytes CAPTURED beside the DB claim.
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    const manifest = JSON.parse(await zip.files["files-manifest.json"].async("string")) as Record<string, { sha256: string; dbSha256: string | null }>;
    expect(Object.keys(manifest).sort()).toEqual([`orgs/${ORG}/nohash.pdf`, `orgs/${ORG}/ok.pdf`]);
    expect(manifest[`orgs/${ORG}/ok.pdf`]).toMatchObject({ sha256: sha(good), dbSha256: sha(good).toUpperCase() });
    expect(manifest[`orgs/${ORG}/nohash.pdf`]).toMatchObject({ sha256: sha("unhashed"), dbSha256: null });
    expect(zip.files[`files/orgs/${ORG}/drift.pdf`]).toBeUndefined();
    expect(await zip.files["ARCHIVE.txt"].async("string")).toMatch(/1 file\(s\) whose live bytes disagreed/);
    expect(archiveUpdates.at(-1)?.note).toMatch(/1 hash mismatch, left in place; 1 without a recorded hash/);
  });
});

describe("shed commit — RET-6 / RET-8 at the destructive step, RET-13 shortfall persisted", () => {
  it("frees only org-owned, unshared keys; leaves the rest linked, unstamped, undeleted; persists the shortfall", async () => {
    const versions = [
      version("ok", `orgs/${ORG}/ok.pdf`, { archive_id: "arch1" }),
      version("foreign", `orgs/${OTHER}/stolen.pdf`, { archive_id: "arch1" }),
      version("shared", `orgs/${ORG}/shared.pdf`, { archive_id: "arch1" }),
      version("fails", `orgs/${ORG}/fails.pdf`, { archive_id: "arch1" }),
    ];
    const stamps: string[][] = [], archiveUpdates: Array<Record<string, unknown>> = [];
    state.resolve = shedResolver({
      versions, stamps, archiveUpdates,
      liveRows: [{ id: "shared", file_url: `orgs/${ORG}/shared.pdf` }, { id: "current", file_url: `orgs/${ORG}/shared.pdf` }],
    });
    state.r2Errors = [{ Key: `orgs/${ORG}/fails.pdf`, Message: "boom" }];
    const res = await SHED_COMMIT(post("https://app/api/admin/shed/commit", { orgId: ORG, archiveId: "arch1", confirm: true }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(stamps.flat().sort()).toEqual(["fails", "ok"]);
    expect(state.r2Deletes.sort()).toEqual([`orgs/${ORG}/fails.pdf`, `orgs/${ORG}/ok.pdf`]);
    expect(body.rejectedKeys).toBe(1);
    expect(body.sharedSkipped).toBe(1);
    expect(body.keysDeleted).toBe(1);
    expect(body.keysFailed).toBe(1);
    expect(body.shortfallPersisted).toBe(true);
    expect(archiveUpdates).toEqual([{ reclaim_shortfall: 1 }]);
  });

  it("a REFUSED shortfall write is named, never dropped: shortfallPersisted false + an error (supabase-js never throws)", async () => {
    const versions = [version("ok", `orgs/${ORG}/ok.pdf`, { archive_id: "arch1" }), version("fails", `orgs/${ORG}/fails.pdf`, { archive_id: "arch1" })];
    const archiveUpdates: Array<Record<string, unknown>> = [];
    state.resolve = shedResolver({ versions, archiveUpdates, archiveUpdateError: { message: "transient 5xx" } });
    state.r2Errors = [{ Key: `orgs/${ORG}/fails.pdf`, Message: "boom" }];
    const res = await SHED_COMMIT(post("https://app/api/admin/shed/commit", { orgId: ORG, archiveId: "arch1", confirm: true }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.keysFailed).toBe(1);
    expect(body.shortfallPersisted).toBe(false);
    expect(body.errors).toContain("shortfall persist: transient 5xx");
    expect(archiveUpdates).toEqual([{ reclaim_shortfall: 1 }]);
    // A database that predates the column says so by name.
    state.resolve = shedResolver({ versions, archiveUpdateError: { code: "PGRST204", message: "Could not find the 'reclaim_shortfall' column of 'archives' in the schema cache" } });
    state.r2Errors = [{ Key: `orgs/${ORG}/fails.pdf`, Message: "boom" }];
    const pre = (await (await SHED_COMMIT(post("https://app/api/admin/shed/commit", { orgId: ORG, archiveId: "arch1", confirm: true }))).json()) as Record<string, unknown>;
    expect(pre.shortfallPersisted).toBe(false);
    expect((pre.errors as string[]).some((e) => /reclaim_shortfall is not applied yet \(migration 20261077 §6\)/.test(e))).toBe(true);
  });

  it("when nothing deletable remains (every row shared or foreign) the stale shortfall is cleared, checked", async () => {
    const versions = [version("shared", `orgs/${ORG}/shared.pdf`, { archive_id: "arch1", archived_at: "2026-01-01T00:00:00Z" })];
    const archiveUpdates: Array<Record<string, unknown>> = [];
    state.resolve = shedResolver({ versions, archiveUpdates, liveRows: [{ id: "shared", file_url: `orgs/${ORG}/shared.pdf` }, { id: "current", file_url: `orgs/${ORG}/shared.pdf` }] });
    const body = (await (await SHED_COMMIT(post("https://app/api/admin/shed/commit", { orgId: ORG, archiveId: "arch1", confirm: true }))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, keysDeleted: 0, keysFailed: 0, sharedSkipped: 1, shortfallPersisted: true, errors: [] });
    expect(archiveUpdates).toEqual([{ reclaim_shortfall: 0 }]);
    expect(state.r2Deletes).toEqual([]);
    state.resolve = shedResolver({ versions, liveRows: [{ id: "shared", file_url: `orgs/${ORG}/shared.pdf` }, { id: "current", file_url: `orgs/${ORG}/shared.pdf` }], archiveUpdateError: { message: "refused" } });
    const refused = (await (await SHED_COMMIT(post("https://app/api/admin/shed/commit", { orgId: ORG, archiveId: "arch1", confirm: true }))).json()) as Record<string, unknown>;
    expect(refused).toMatchObject({ shortfallPersisted: false, errors: ["shortfall persist: refused"] });
  });

  it("fails CLOSED (nothing stamped, nothing deleted) when the shared-key read errors", async () => {
    const stamps: string[][] = [];
    state.resolve = shedResolver({ versions: [version("ok", `orgs/${ORG}/ok.pdf`, { archive_id: "arch1" })], stamps, liveError: "db down" });
    const res = await SHED_COMMIT(post("https://app/api/admin/shed/commit", { orgId: ORG, archiveId: "arch1", confirm: true }));
    expect(res.status).toBe(503);
    expect(stamps).toEqual([]);
    expect(state.r2Deletes).toEqual([]);
  });

  it("RET-8 end to end: revert to an old revision, shed it beyond keep-N — the shared key survives", async () => {
    // Rev A (old, superseded) and the revert row (current) share A's key.
    const key = `orgs/${ORG}/revA.pdf`;
    const revA = version("revA", key);
    const revert = { ...version("revert", key), record_id: "doc-revA", superseded_at: null, created_at: "2026-03-01T00:00:00Z" };
    const claims: string[][] = [];
    state.resolve = shedResolver({ versions: [revA, revert], claims, liveRows: [{ id: "revA", file_url: key }, { id: "revert", file_url: key }] });
    const produce = await SHED_PRODUCE(post("https://app/api/admin/shed", { orgId: ORG, keep: 1, confirm: true }));
    expect(produce.status).toBe(400); // nothing eligible once the shared key is excluded
    expect(claims).toEqual([]);
    // Even if a pre-fix produce had linked revA, commit refuses to free the key.
    const stamps: string[][] = [];
    state.resolve = shedResolver({ versions: [{ ...revA, archive_id: "arch1" }], stamps, liveRows: [{ id: "revA", file_url: key }, { id: "revert", file_url: key }] });
    const commit = await SHED_COMMIT(post("https://app/api/admin/shed/commit", { orgId: ORG, archiveId: "arch1", confirm: true }));
    const body = (await commit.json()) as { sharedSkipped: number; keysDeleted: number };
    expect(body.sharedSkipped).toBe(1);
    expect(body.keysDeleted).toBe(0);
    expect(state.r2Deletes).toEqual([]);
    expect(stamps).toEqual([]);
  });
});

describe("document shed — intelligence ILIFE-5: a key a knowledge-library mirror still names is never claimed, never freed", () => {
  // lib/knowledgeSourceSync.ts mirrors a controlled revision with `file_key: version.file_url`: the
  // SAME object. Between a rev-up and the next sync, the superseded revision is shed-eligible while a
  // 'ready' mirror still points at its bytes.
  const mirrored = `orgs/${ORG}/mirrored.pdf`;

  it("preview and produce leave the mirrored revision out, counted with the shared ones", async () => {
    const versions = [...pair("ok", `orgs/${ORG}/ok.pdf`), ...pair("mirrored", mirrored)];
    state.resolve = shedResolver({ versions, mirrorKeys: [mirrored] });
    const preview = (await (await SHED_GET(new NextRequest(`https://app/api/admin/shed?orgId=${ORG}&keep=1`))).json()) as { sample: Array<{ id: string }>; sharedSkipped: number };
    expect(preview.sample.map((r) => r.id)).toEqual(["ok"]);
    expect(preview.sharedSkipped).toBe(1);

    state.objects[`orgs/${ORG}/ok.pdf`] = bytes("ok");
    state.objects[mirrored] = bytes("mirrored");
    const claims: string[][] = [];
    state.resolve = shedResolver({ versions, claims, mirrorKeys: [mirrored] });
    const res = await SHED_PRODUCE(post("https://app/api/admin/shed", { orgId: ORG, keep: 1, confirm: true }));
    expect(res.status).toBe(200);
    expect(claims.flat()).toEqual(["ok"]);
    expect(res.headers.get("X-Archive-Shared-Skipped")).toBe("1");
  });

  it("commit (a pre-fix produce linked it): the mirrored key is not stamped and not deleted; the rest is freed", async () => {
    const versions = [
      version("ok", `orgs/${ORG}/ok.pdf`, { archive_id: "arch1" }),
      version("mirrored", mirrored, { archive_id: "arch1" }),
    ];
    const stamps: string[][] = [];
    state.resolve = shedResolver({ versions, stamps, mirrorKeys: [mirrored] });
    const res = await SHED_COMMIT(post("https://app/api/admin/shed/commit", { orgId: ORG, archiveId: "arch1", confirm: true }));
    const body = (await res.json()) as { sharedSkipped: number; keysDeleted: number; note?: string };
    expect(res.status).toBe(200);
    expect(stamps.flat()).toEqual(["ok"]);
    expect(state.r2Deletes).toEqual([`orgs/${ORG}/ok.pdf`]);
    expect(body.sharedSkipped).toBe(1);
    expect(body.note).toMatch(/1 row\(s\) share their storage key with a current revision or a knowledge-library copy/);
  });

  it("fails CLOSED when the mirror read errors: preview and produce 503, commit 503 with nothing stamped or deleted", async () => {
    const versions = pair("ok", `orgs/${ORG}/ok.pdf`);
    state.resolve = shedResolver({ versions, mirrorError: "db down" });
    expect((await SHED_GET(new NextRequest(`https://app/api/admin/shed?orgId=${ORG}&keep=1`))).status).toBe(503);
    const claims: string[][] = [];
    state.resolve = shedResolver({ versions, claims, mirrorError: "db down" });
    expect((await SHED_PRODUCE(post("https://app/api/admin/shed", { orgId: ORG, keep: 1, confirm: true }))).status).toBe(503);
    expect(claims).toEqual([]);
    const stamps: string[][] = [];
    state.resolve = shedResolver({ versions: [version("ok", `orgs/${ORG}/ok.pdf`, { archive_id: "arch1" })], stamps, mirrorError: "db down" });
    const commit = await SHED_COMMIT(post("https://app/api/admin/shed/commit", { orgId: ORG, archiveId: "arch1", confirm: true }));
    expect(commit.status).toBe(503);
    expect(((await commit.json()) as { error: string }).error).toMatch(/knowledge_documents\.file_key.*Nothing was freed/);
    expect(stamps).toEqual([]);
    expect(state.r2Deletes).toEqual([]);
  });

  it("fails CLOSED when a server row cap cuts the mirror read short: preview and produce 503, commit 503 with nothing stamped or deleted", async () => {
    const versions = pair("ok", `orgs/${ORG}/ok.pdf`);
    state.resolve = shedResolver({ versions, mirrorKeys: [`orgs/${ORG}/ok.pdf`], mirrorCapped: true });
    expect((await SHED_GET(new NextRequest(`https://app/api/admin/shed?orgId=${ORG}&keep=1`))).status).toBe(503);
    const claims: string[][] = [];
    state.resolve = shedResolver({ versions, claims, mirrorKeys: [`orgs/${ORG}/ok.pdf`], mirrorCapped: true });
    expect((await SHED_PRODUCE(post("https://app/api/admin/shed", { orgId: ORG, keep: 1, confirm: true }))).status).toBe(503);
    expect(claims).toEqual([]);
    const stamps: string[][] = [];
    state.resolve = shedResolver({ versions: [version("ok", `orgs/${ORG}/ok.pdf`, { archive_id: "arch1" })], stamps, mirrorCapped: true });
    const commit = await SHED_COMMIT(post("https://app/api/admin/shed/commit", { orgId: ORG, archiveId: "arch1", confirm: true }));
    expect(commit.status).toBe(503);
    expect(((await commit.json()) as { error: string }).error).toMatch(/knowledge_documents\.file_key .*server row cap cut it short.*Nothing was freed/);
    expect(stamps).toEqual([]);
    expect(state.r2Deletes).toEqual([]);
  });
});

// ── ticket shed ──────────────────────────────────────────────────────────────

function ticketResolver(opts: {
  tickets: Array<Record<string, unknown>>; liveRows?: Array<{ id: string; file_url: string }>;
  claims?: string[][]; unclaims?: string[][]; archiveUpdates?: Array<Record<string, unknown>>; stamps?: string[];
  archiveUpdateError?: { code?: string; message: string };
}) {
  return (table: string, ops: Op[]) => {
    if (table === "archives") {
      if (argOf(ops, "update")) {
        opts.archiveUpdates?.push(argOf(ops, "update")![0] as Record<string, unknown>);
        return opts.archiveUpdateError ? { data: null, error: opts.archiveUpdateError } : { data: [], error: null };
      }
      if (argOf(ops, "maybeSingle")) return { data: { note: "saved" }, error: null };
      return { data: [], error: null };
    }
    if (table === "tickets") {
      const upd = argOf(ops, "update")?.[0] as Record<string, unknown> | undefined;
      const ids = (filter(ops, "in", "id") as string[] | undefined) ?? [];
      if (upd && "archive_id" in upd && upd.archive_id && !("archived_at" in upd)) { opts.claims?.push(ids); return { data: ids.map((id) => ({ id })), error: null }; }
      if (upd && "archive_id" in upd && !upd.archive_id) { opts.unclaims?.push(ids); return { data: [], error: null }; }
      if (upd && "archived_at" in upd) { opts.stamps?.push(filter(ops, "eq", "id") as string); return { data: null, error: null, count: 1 }; }
      return { data: opts.tickets, error: null };
    }
    if (table === "document_versions") {
      const keys = (filter(ops, "in", "file_url") as string[] | undefined) ?? [];
      return { data: (opts.liveRows ?? []).filter((r) => keys.includes(r.file_url)), error: null };
    }
    return { data: [], error: null };
  };
}

describe("ticket shed — RET-6 on both halves", () => {
  it("produce skips (and un-claims) a ticket carrying an attachment key outside the org prefix", async () => {
    state.objects[`orgs/${ORG}/tickets/t1/a.pdf`] = bytes("a");
    const old = "2025-01-01T00:00:00Z";
    const tickets = [
      { id: "t1", org_id: ORG, ticket_id: "T-1", title: "ok", status: "CLOSED", closed_at: old, last_modified: old, created_at: old, archived_at: null, attachments: [{ url: `orgs/${ORG}/tickets/t1/a.pdf`, size: 1 }], comments: [], history: [], metadata: {} },
      { id: "t2", org_id: ORG, ticket_id: "T-2", title: "tampered", status: "CLOSED", closed_at: old, last_modified: old, created_at: old, archived_at: null, attachments: [{ url: `orgs/${ORG}/libraries/l/P-101-RevD.pdf`, size: 1 }, { url: `orgs/${OTHER}/x.pdf`, size: 1 }], comments: [], history: [], metadata: {} },
    ];
    const claims: string[][] = [], unclaims: string[][] = [];
    state.resolve = ticketResolver({ tickets, claims, unclaims });
    const res = await TICKET_PRODUCE(post("https://app/api/admin/ticket-shed", { orgId: ORG, days: 30, confirm: true }));
    expect(res.status).toBe(200);
    expect(claims.flat().sort()).toEqual(["t1", "t2"]);
    expect(unclaims.flat()).toEqual(["t2"]);
    expect(res.headers.get("X-Archive-Tickets")).toBe("1");
    expect(res.headers.get("X-Archive-Rejected-Keys")).toBe("1");
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    expect(zip.files["tickets/t2.json"]).toBeUndefined();
    expect(zip.files[`files/orgs/${OTHER}/x.pdf`]).toBeUndefined();
  });

  it("commit deletes only org-owned keys that no live revision references, and persists the shortfall", async () => {
    const tickets = [{
      id: "t1", archived_at: "2026-01-01T00:00:00Z", comments: [], history: [], metadata: {},
      attachments: [
        { url: `orgs/${ORG}/tickets/t1/a.pdf` },
        { url: `orgs/${OTHER}/stolen.pdf` },
        { url: `orgs/${ORG}/libraries/l/P-101-RevD.pdf` }, // a live controlled revision's key, substituted in
      ],
    }];
    const archiveUpdates: Array<Record<string, unknown>> = [];
    state.resolve = ticketResolver({ tickets, archiveUpdates, liveRows: [{ id: "v-current", file_url: `orgs/${ORG}/libraries/l/P-101-RevD.pdf` }] });
    const res = await TICKET_COMMIT(post("https://app/api/admin/ticket-shed/commit", { orgId: ORG, archiveId: "arch1", confirm: true }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(state.r2Deletes).toEqual([`orgs/${ORG}/tickets/t1/a.pdf`]);
    expect(body.rejectedKeys).toBe(1);
    expect(body.sharedSkipped).toBe(1);
    expect(body.keysFailed).toBe(0);
    expect(body.shortfallPersisted).toBe(true);
    expect(archiveUpdates).toEqual([{ reclaim_shortfall: 0 }]);
  });

  it("ticket commit: a refused shortfall write is named in errors and shortfallPersisted is false", async () => {
    const tickets = [{ id: "t1", archived_at: "2026-01-01T00:00:00Z", comments: [], history: [], metadata: {}, attachments: [{ url: `orgs/${ORG}/tickets/t1/a.pdf` }] }];
    state.resolve = ticketResolver({ tickets, archiveUpdateError: { message: "refused" } });
    state.r2Errors = [{ Key: `orgs/${ORG}/tickets/t1/a.pdf`, Message: "boom" }];
    const res = await TICKET_COMMIT(post("https://app/api/admin/ticket-shed/commit", { orgId: ORG, archiveId: "arch1", confirm: true }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.keysFailed).toBe(1);
    expect(body.shortfallPersisted).toBe(false);
    expect(body.errors).toContain("shortfall persist: refused");
  });
});

describe("ticket restore — RET-14 exact entries, manifest-verified bytes", () => {
  it("exactEntryFor tolerates the files/ wrapper and a leading slash, never a suffix", () => {
    const key = `orgs/${ORG}/tickets/t1/a.pdf`;
    expect(exactEntryFor([`files/${key}`], key)).toBe(`files/${key}`);
    expect(exactEntryFor([`/${key}`], key)).toBe(`/${key}`);
    expect(exactEntryFor(["files/a.pdf", "files/tickets/t1/a.pdf"], key)).toBeNull();
  });
  it("bytesMatchManifest requires a well-formed sha256 that matches, and the recorded size", () => {
    const b = bytes("hello");
    expect(bytesMatchManifest(b, { sha256: sha(b), size: 5 })).toBe(true);
    expect(bytesMatchManifest(b, { sha256: sha(b).toUpperCase() })).toBe(true);
    expect(bytesMatchManifest(b, { sha256: sha(b), size: 6 })).toBe(false);
    expect(bytesMatchManifest(b, { sha256: sha("other"), size: 5 })).toBe(false);
    expect(bytesMatchManifest(b, { sha256: "nope" })).toBe(false);
    expect(bytesMatchManifest(b, undefined)).toBe(false);
  });

  async function restoreZip(opts: { tamper?: boolean; noManifest?: boolean; suffixOnly?: boolean }) {
    const key = `orgs/${ORG}/tickets/t1/a.pdf`;
    const good = bytes("original attachment");
    const zip = new JSZip();
    zip.file("tickets/t1.json", JSON.stringify({ id: "t1", org_id: ORG, comments: [{ x: 1 }], history: [], metadata: {}, attachments: [{ url: key }] }));
    zip.file(opts.suffixOnly ? "files/a.pdf" : `files/${key}`, opts.tamper ? bytes("substituted bytes") : good);
    if (!opts.noManifest) zip.file("files-manifest.json", JSON.stringify({ [key]: { sha256: sha(good), size: good.byteLength } }));
    const body = await zip.generateAsync({ type: "uint8array" });
    const updates: Array<Record<string, unknown>> = [];
    state.resolve = (table, ops) => {
      if (table === "tickets") {
        const upd = argOf(ops, "update")?.[0] as Record<string, unknown> | undefined;
        if (upd) { updates.push(upd); return { data: null, error: null, count: 1 }; }
        return { data: [{ id: "t1", attachments: [{ url: key }] }], error: null };
      }
      return { data: [], error: null };
    };
    const req = new NextRequest(`https://app/api/admin/ticket-shed/restore?orgId=${ORG}&confirm=true`, {
      method: "POST", body: body as unknown as BodyInit, headers: { "content-length": String(body.byteLength) },
    });
    const res = await TICKET_RESTORE(req);
    return { res, body: (await res.json()) as Record<string, unknown>, updates };
  }

  it("restores a verified archive: bytes written, stub cleared", async () => {
    const { res, body, updates } = await restoreZip({});
    expect(res.status).toBe(200);
    expect(state.r2Puts).toEqual([`orgs/${ORG}/tickets/t1/a.pdf`]);
    expect(body.restored).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ archived_at: null, archive_id: null });
  });
  it("a tampered file: nothing written, the ticket stays a stub, the mismatch is counted", async () => {
    const { res, body, updates } = await restoreZip({ tamper: true });
    expect(res.status).toBe(200);
    expect(state.r2Puts).toEqual([]);
    expect(updates).toEqual([]);
    expect(body.restored).toBe(0);
    expect(body.partial).toBe(1);
    expect(body.filesMismatched).toBe(1);
  });
  it("a suffix-only entry no longer sources a write", async () => {
    const { body, updates } = await restoreZip({ suffixOnly: true });
    expect(state.r2Puts).toEqual([]);
    expect(updates).toEqual([]);
    expect(body.filesMissing).toBe(1);
  });
  it("an archive without files-manifest.json is refused outright (fail closed)", async () => {
    const { res, updates } = await restoreZip({ noManifest: true });
    expect(res.status).toBe(400);
    expect(state.r2Puts).toEqual([]);
    expect(updates).toEqual([]);
  });
});

// ── orphans ──────────────────────────────────────────────────────────────────

describe("orphan sweep — RET-7 confined to the caller's org prefix", () => {
  const old = new Date(Date.now() - 30 * 86400_000);
  it("scanOrphans lists with Prefix orgs/<orgId>/ and ignores anything outside it, totals included", async () => {
    state.listing = [
      { Key: `orgs/${ORG}/orphan.pdf`, Size: 100, LastModified: old },
      { Key: `orgs/${ORG}/referenced.pdf`, Size: 50, LastModified: old },
      { Key: `orgs/${OTHER}/their-orphan.pdf`, Size: 999, LastModified: old }, // must never appear even if listed
    ];
    state.resolve = (table, ops) => {
      if (argOf(ops, "select")?.[1]) return { data: null, error: null, count: table === "document_versions" ? 1 : 0 };
      if (table === "document_versions") return { data: [{ file_url: `orgs/${ORG}/referenced.pdf`, source_file_key: null }], error: null };
      return { data: [], error: null };
    };
    const scan = await scanOrphans({ from: (t: string) => chain(t) } as never, ORG);
    expect(state.listPrefixes).toEqual([`orgs/${ORG}/`]);
    expect(scan.scope).toBe(`orgs/${ORG}/`);
    expect(scan.orphans.map((o) => o.key)).toEqual([`orgs/${ORG}/orphan.pdf`]);
    expect(scan.totalObjects).toBe(2);
    expect(scan.totalBytes).toBe(150);
  });
  it("deleteOrphans never sends a key outside the prefix to DeleteObjects", async () => {
    state.listing = [
      { Key: `orgs/${ORG}/orphan.pdf`, Size: 100, LastModified: old },
      { Key: `orgs/${OTHER}/their-orphan.pdf`, Size: 999, LastModified: old },
    ];
    state.resolve = (_table, ops) => (argOf(ops, "select")?.[1] ? { data: null, error: null, count: 0 } : { data: [], error: null });
    const out = await deleteOrphans({ from: (t: string) => chain(t) } as never, ORG);
    expect(state.r2Deletes).toEqual([`orgs/${ORG}/orphan.pdf`]);
    expect(out.deleted).toBe(1);
    expect(out.scope).toBe(`orgs/${ORG}/`);
  });
  it("refuses to walk without an orgId", async () => {
    await expect(scanOrphans({ from: (t: string) => chain(t) } as never, "")).rejects.toThrow(/orgId is required/);
  });
});
