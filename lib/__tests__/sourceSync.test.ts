// intelligence Round G (I-06) — the document-control → knowledge sync.
//
//   ING-3 / DWG-1  a rev-up refresh drops the WHOLE derived index (chunks,
//                  page entities, machine mentions, cached traces) through
//                  the shared reset, zeroes vision_pages (ING-12), keeps a
//                  person's explicit mention, and — re-ingested — a revision
//                  with fewer sheets carries nothing past its last page
//   ING-1          the refresh never lands under a batch holding the claim:
//                  it is deferred to the next pass
//   IRLS-7         a source whose container is gone is reported
//   ILIFE-13       the cron reaches every library: paged past 1,000 source
//                  rows, oldest first, orgs interleaved, time-bounded, with
//                  the libraries left for next time counted

import { describe, it, expect, vi, beforeEach } from "vitest";
import { db, resetDb, rowsOf, type Row } from "./knowledgeFakeDb";
import { makePdf, drawingSheet } from "./knowledgePdfFixtures";

const r2 = vi.hoisted(() => ({ objects: new Map<string, Uint8Array>() }));
vi.mock("@/lib/supabaseAdmin", async () => ({ supabaseAdmin: (await import("./knowledgeFakeDb")).fakeAdmin }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "bucket",
  r2: {
    send: async (cmd: { input: { Key: string } }) => {
      const bytes = r2.objects.get(cmd.input.Key);
      if (!bytes) throw new Error(`NoSuchKey ${cmd.input.Key}`);
      return { Body: bytes };
    },
  },
}));
vi.mock("@/lib/knowledgeVision", () => ({ transcribePageImage: vi.fn() }));
vi.mock("@/lib/equipmentBridgeServer", () => ({ computeForKnowledgeDoc: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/usageServer", () => ({ getMonthUsage: vi.fn(), getCapUsd: vi.fn(), recordAskUsage: vi.fn() }));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));

import { syncKnowledgeLibrarySources, syncAllKnowledgeSources } from "@/lib/knowledgeSourceSync";
import { ingestKnowledgeDocBatch, resetKnowledgeIndex } from "@/lib/knowledgeIngest";

const MIRROR = "kd-1";
const landscape = (): Record<string, Row[]> => ({
  knowledge_sources: [{ id: "src-1", org_id: "o1", library_id: "kl-1", source_type: "library", source_id: "lib-dc", source_name: "Piping", last_synced_at: null }],
  libraries: [{ id: "lib-dc", org_id: "o1", name: "Piping", acl: null, visibility: null, owner_user_id: null, owner_team_id: null }],
  collections: [],
  teams: [],
  documents: [{
    id: "dc-1", org_id: "o1", library_id: "lib-dc", collection_id: null, name: "025-PID-0101", title: "Crude P&ID",
    document_number: "025-PID-0101", status: "Released", archived_at: null, current_version_id: "ver-4", ai_excluded: false,
  }],
  document_versions: [
    { id: "ver-3", file_url: "orgs/o1/dc/rev3.pdf", file_type: "application/pdf", revision_label: "3", size: 10 },
    { id: "ver-4", file_url: "orgs/o1/dc/rev4.pdf", file_type: "application/pdf", revision_label: "4", size: 10 },
  ],
  knowledge_documents: [{
    id: MIRROR, org_id: "o1", library_id: "kl-1", name: "025-PID-0101 — Crude P&ID", file_key: "orgs/o1/dc/rev3.pdf",
    status: "ready", pages_indexed: 3, page_count: 3, last_section: null, created_by: null, created_at: "2026-09-01", error: null,
    source_id: "src-1", source_document_id: "dc-1", source_version_id: "ver-3", source_rev: "3",
    vision_pages: 3, empty_pages: 1, vision_failed_pages: [2], vision_partial_accepted: true, chunk_version: null,
    ingest_claimed_by: null, ingest_claimed_at: null,
  }],
  knowledge_chunks: [1, 2, 3].map((p) => ({ id: `c${p}`, document_id: MIRROR, org_id: "o1", library_id: "kl-1", page: p, seq: 0, content: `rev 3 sheet ${p}` })),
  knowledge_page_entities: [1, 2, 3].map((p) => ({ id: `e${p}`, document_id: MIRROR, org_id: "o1", library_id: "kl-1", page: p, kind: "equipment", tag: `V-14${p}` })),
  entity_mentions: [
    { id: "m-machine", org_id: "o1", asset_id: "a1", knowledge_document_id: MIRROR, document_id: "dc-1", page: 3, is_explicit: false },
    { id: "m-human", org_id: "o1", asset_id: "a2", knowledge_document_id: MIRROR, document_id: "dc-1", page: 1, is_explicit: true },
  ],
  knowledge_line_traces: [{ id: "t1", document_id: MIRROR, org_id: "o1", page: 3, from_tag: "X-32", to_tag: "X-33" }],
});
const mirror = () => rowsOf("knowledge_documents").find((r) => r.id === MIRROR)!;

beforeEach(() => { r2.objects.clear(); resetDb(landscape()); });

describe("ING-3 / DWG-1 — a rev-up drops the whole derived index", () => {
  it("chunks, page entities, machine mentions and cached traces go; a person's pin stays; the row restarts", async () => {
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out).toMatchObject({ refreshed: 1, deferred: 0, errors: [] });
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    expect(rowsOf("knowledge_page_entities")).toHaveLength(0);
    expect(rowsOf("knowledge_line_traces")).toHaveLength(0);
    expect(rowsOf("entity_mentions").map((m) => m.id)).toEqual(["m-human"]);
    expect(mirror()).toMatchObject({
      status: "stale", pages_indexed: 0, page_count: null, error: null,
      file_key: "orgs/o1/dc/rev4.pdf", source_version_id: "ver-4", source_rev: "4",
      // ING-12: every counter belongs to the index generation it counted.
      vision_pages: 0, empty_pages: 0, vision_failed_pages: [], vision_partial_accepted: false,
      ingest_claimed_by: null,
    });
  });

  it("rev N has fewer sheets than rev N-1: after the re-read no entity survives past the new page count", async () => {
    r2.objects.set("orgs/o1/dc/rev4.pdf", await makePdf([
      drawingSheet(1, ["V-101", "P-201A", "E-301"]), drawingSheet(2, ["V-102", "P-202A", "E-302"]),
    ]));
    await syncKnowledgeLibrarySources("kl-1");
    const res = await ingestKnowledgeDocBatch(mirror() as unknown as Parameters<typeof ingestKnowledgeDocBatch>[0]);
    expect(res.done).toBe(true);
    expect(mirror()).toMatchObject({ status: "ready", page_count: 2, source_rev: "4" });
    const pages = rowsOf("knowledge_page_entities").map((e) => Number(e.page));
    expect(pages.length).toBeGreaterThan(0);
    expect(Math.max(...pages)).toBeLessThanOrEqual(2);
    expect(rowsOf("knowledge_page_entities").some((e) => String(e.tag).startsWith("V-14"))).toBe(false);
  });

  it("a failed entity purge skips the refresh (the row keeps the old version, so the next pass repeats it)", async () => {
    db.hooks.push((op) => op.table === "knowledge_page_entities" && op.kind === "delete"
      ? { error: { code: "57014", message: "statement timeout" } } : undefined);
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out.refreshed).toBe(0);
    expect(out.errors.join(" ")).toMatch(/refresh 025-PID-0101 — Crude P&ID: kd-1: page entities: statement timeout/);
    expect(mirror()).toMatchObject({ source_version_id: "ver-3", ingest_claimed_by: null });
  });

  it("ING-1: a mirror mid-batch is deferred, not reset under the batch", async () => {
    Object.assign(mirror(), { status: "indexing", ingest_claimed_by: "ingest:x", ingest_claimed_at: new Date().toISOString() });
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out).toMatchObject({ refreshed: 0, deferred: 1 });
    expect(rowsOf("knowledge_chunks")).toHaveLength(3);
    expect(mirror().source_version_id).toBe("ver-3");
  });

  it("the shared reset without a file change keeps cached traces (a rebuild of the same file)", async () => {
    const res = await resetKnowledgeIndex([MIRROR]);
    expect(res).toEqual({ reset: [MIRROR], busy: [], errors: [] });
    expect(rowsOf("knowledge_line_traces")).toHaveLength(1);
    expect(rowsOf("knowledge_page_entities")).toHaveLength(0);
    expect(mirror()).toMatchObject({ status: "stale", vision_pages: 0, file_key: "orgs/o1/dc/rev3.pdf" });
  });

  it("on a database without 20261122 the reset still clears the index and resets the old counters", async () => {
    const cols = ["ingest_claimed_by", "ingest_claimed_at", "empty_pages", "vision_failed_pages", "vision_partial_accepted", "chunk_version"];
    db.missingColumns.knowledge_documents = cols;
    for (const c of cols) delete mirror()[c];
    const res = await resetKnowledgeIndex([MIRROR], { rowUpdate: () => ({ file_key: "x.pdf" }) });
    expect(res.reset).toEqual([MIRROR]);
    expect(mirror()).toMatchObject({ status: "stale", pages_indexed: 0, vision_pages: 0, file_key: "x.pdf" });
  });
});

describe("IRLS-7 — a dangling source is reported", () => {
  it("a source whose library was deleted is named, and its mirrors leave", async () => {
    db.tables.knowledge_sources.push({ id: "src-2", org_id: "o1", library_id: "kl-1", source_type: "folder", source_id: "gone-folder", source_name: "Piping / Old", last_synced_at: null });
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out.danglingSources).toBe(1);
    expect(out.errors).toContain('dangling source "Piping / Old": its document-control folder no longer exists — unlink it from this library');
  });
});

describe("ILIFE-13 — every library is reached", () => {
  const manyLibraries = (n: number, org: (i: number) => string, stamp: (i: number) => string | null) => {
    resetDb({
      knowledge_sources: Array.from({ length: n }, (_, i) => ({
        id: `s${i}`, org_id: org(i), library_id: `lib-${String(i).padStart(4, "0")}`, source_type: "library",
        source_id: `dc-${i}`, source_name: `L${i}`, last_synced_at: stamp(i),
      })),
      libraries: [], collections: [], teams: [], documents: [], document_versions: [], knowledge_documents: [],
    });
  };
  const synced = () => db.ops
    .filter((o) => o.table === "knowledge_sources" && o.kind === "update")
    .map((o) => String(o.filters.find((f) => f.col === "library_id")?.value));

  it("reads past 1,000 source rows, never-synced libraries first, then the oldest", async () => {
    manyLibraries(1200, () => "o1", (i) => (i < 1100 ? `2026-09-${String(10 + (i % 20)).padStart(2, "0")}T00:00:00+00:00` : null));
    const out = await syncAllKnowledgeSources({ maxLibraries: 150 });
    expect(out.libraries).toBe(150);
    expect(out.unsynced).toBe(1050);
    const order = synced();
    // The 100 never-synced libraries (1100..1199) come first — the old
    // unordered slice(0, 25) of the first 1,000 rows could never see them.
    expect(order.slice(0, 100).every((id) => Number(id.slice(4)) >= 1100)).toBe(true);
    const stamps = order.slice(100).map((id) => Number(id.slice(4)) % 20);
    expect(stamps.every((s) => s === 0)).toBe(true);
    // …and each reconciled library now carries its stamp.
    const stamped = rowsOf("knowledge_sources").filter((s) => String(s.last_synced_at).startsWith("2026") && order.includes(String(s.library_id)));
    expect(stamped.length).toBe(150);
  });

  it("orgs are interleaved so one tenant's shelf count cannot starve another", async () => {
    manyLibraries(40, (i) => (i < 36 ? "big" : "small"), () => null);
    await syncAllKnowledgeSources({ maxLibraries: 8 });
    const order = synced();
    const smallIds = new Set(["lib-0036", "lib-0037", "lib-0038", "lib-0039"]);
    expect(order.filter((id) => smallIds.has(id))).toHaveLength(4);
  });

  it("stops at its time budget and says how many wait", async () => {
    manyLibraries(30, () => "o1", () => null);
    const out = await syncAllKnowledgeSources({ deadlineMs: Date.now() - 1 });
    expect(out.libraries).toBe(0);
    expect(out.unsynced).toBe(30);
  });

  it("without the cursor column it still rotates by the day rather than repeating one prefix", async () => {
    manyLibraries(60, () => "o1", () => null);
    db.missingColumns.knowledge_sources = ["last_synced_at"];
    const out = await syncAllKnowledgeSources({ maxLibraries: 25 });
    expect(out.libraries).toBe(25);
    expect(out.errors).toEqual([]);                       // a missing cursor column is not an error
    const shift = (Math.floor(Date.now() / 86_400_000) * 25) % 60;
    const expected = Array.from({ length: 25 }, (_, k) => `lib-${String((shift + k) % 60).padStart(4, "0")}`);
    expect(synced()).toEqual(expected);
    // Tomorrow's pass starts 25 further on: the whole set is reached in 3 days.
  });
});
