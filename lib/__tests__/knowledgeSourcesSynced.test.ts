// intelligence Round G (I-06b) — ILIFE-13's remainder: the heartbeat says
// what it left, and a library says when it last synced.
//
//   * the maintenance cron's JSON carries the sync's `unsynced` (libraries
//     this run left for the next — the rotation reaches them oldest first)
//     and `deferred` (rev-ups another sync landed first) beside its counts;
//   * GET /api/knowledge/sources answers each source's last_synced_at and
//     the library's (its oldest — one never-synced source makes the library
//     never-synced, as the cron orders it), and says when the database has
//     no such column (a database without 20261122) rather than inventing a
//     time; the library's Sources strip renders it (sourcesPanelSynced.test).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { db, resetDb, type Row } from "./knowledgeFakeDb";

vi.mock("@/lib/supabaseAdmin", async () => ({ supabaseAdmin: (await import("./knowledgeFakeDb")).fakeAdmin }));
vi.mock("@/lib/knowledgeAccess", () => ({
  loadPrincipal: vi.fn(async (_org: string, uid: string) => (uid === "u-ctrl" ? { uid, isController: true } : null)),
  loadDcLandscape: vi.fn(),
  containerReadable: vi.fn(),
}));
vi.mock("@/lib/knowledgeSourceSync", () => ({ syncKnowledgeLibrarySources: vi.fn() }));

import { GET } from "@/app/api/knowledge/sources/route";
import { lastSyncedLabel } from "@/lib/knowledge";

const get = () => GET(new NextRequest("http://x/api/knowledge/sources?orgId=o1&libraryId=kl-1", {
  headers: { authorization: "Bearer good" },
}));
const source = (id: string, over: Row = {}): Row => ({
  id, org_id: "o1", library_id: "kl-1", source_type: "library", source_id: `lib-${id}`, source_name: `Library ${id}`,
  created_by_name: "Dana", created_at: `2026-09-0${id.length}T00:00:00Z`, last_synced_at: null, ...over,
});

beforeEach(() => {
  resetDb({ knowledge_sources: [], knowledge_documents: [] });
});

describe("ILIFE-13 — the library's last sync, from the sources route", () => {
  it("answers each source's last sync and the library's: the oldest of them", async () => {
    db.tables.knowledge_sources = [
      source("a", { last_synced_at: "2026-10-02T01:00:00.000Z" }),
      source("bb", { last_synced_at: "2026-10-01T03:00:00.000Z" }),
    ];
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources.map((s: { lastSyncedAt: string | null }) => s.lastSyncedAt))
      .toEqual(["2026-10-02T01:00:00.000Z", "2026-10-01T03:00:00.000Z"]);
    expect(body).toMatchObject({ syncTracked: true, lastSyncedAt: "2026-10-01T03:00:00.000Z" });
  });

  it("one source never synced (or due first) makes the library never synced — as the cron orders it", async () => {
    db.tables.knowledge_sources = [source("a", { last_synced_at: "2026-10-02T01:00:00.000Z" }), source("bb")];
    expect(await (await get()).json()).toMatchObject({ syncTracked: true, lastSyncedAt: null });
  });

  it("a database without 20261122 has no such column: the sources still list, and the time is said to be unknown — never invented", async () => {
    db.tables.knowledge_sources = [source("a")].map(({ last_synced_at: _l, ...rest }) => rest);
    db.missingColumns.knowledge_sources = ["last_synced_at"];
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources).toHaveLength(1);
    expect(body).toMatchObject({ syncTracked: false, lastSyncedAt: null });
    expect(body.sources[0].lastSyncedAt).toBeNull();
  });

  it("the label: how long ago, or that the next sync reaches it first", () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    expect(lastSyncedLabel("2026-10-02T11:55:00Z", now)).toBe("Last synced with Document Control 5 minutes ago.");
    expect(lastSyncedLabel("2026-10-02T11:59:50Z", now)).toBe("Last synced with Document Control just now.");
    expect(lastSyncedLabel("2026-10-02T09:00:00Z", now)).toBe("Last synced with Document Control 3 hours ago.");
    expect(lastSyncedLabel("2026-09-28T12:00:00Z", now)).toBe("Last synced with Document Control 4 days ago.");
    expect(lastSyncedLabel(null, now)).toBe(
      "Not synced with Document Control yet — the nightly run reaches it first, or Sync now reconciles it at once.",
    );
  });
});

describe("ILIFE-13 — the maintenance cron's JSON says what the sync left", () => {
  it("forwards `unsynced` and `deferred` from syncAllKnowledgeSources beside its counts", () => {
    const route = readFileSync(join(process.cwd(), "app/api/cron/maintenance/route.ts"), "utf8");
    expect(route).toMatch(/knowledgeSync\?: \{ libraries: number; added: number; refreshed: number; removed: number; deferred: number; unsynced: number \}/);
    const at = route.indexOf("const sync = await syncAllKnowledgeSources();");
    expect(at).toBeGreaterThan(0);
    expect(route.slice(at, at + 600)).toMatch(/deferred: sync\.deferred, unsynced: sync\.unsynced,/);
  });
});
