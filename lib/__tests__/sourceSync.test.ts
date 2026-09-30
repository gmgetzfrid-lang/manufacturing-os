// intelligence Round G (I-06) — the document-control → knowledge sync.
//
//   ING-3 / DWG-1  a rev-up refresh drops the WHOLE derived index (chunks,
//                  page entities, machine mentions, cached traces) through
//                  the shared reset, zeroes vision_pages (ING-12), keeps a
//                  person's explicit mention, and — re-ingested — a revision
//                  with fewer sheets carries nothing past its last page
//   ING-1          a refresh that finds a batch writing the OLD revision
//                  re-points the row at once; that batch's commit misses and
//                  withdraws, so the superseded revision never reaches
//                  'ready'. A refresh that did not land leaves its library
//                  never-synced, so the next run reaches it first
//   ING-1          a second sync that read the mirror before the first one
//                  re-pointed it (the publish-triggered sync and the cron's,
//                  say) never resets the NEW revision: not under its first
//                  batch (which would end 'ready' with no chunks), and not
//                  between its batches (which would re-bill its vision pages)
//   ING-3          the reset queues the row BEFORE deleting, so an
//                  interrupted reset never leaves a 'ready' row without its
//                  chunks; the re-index's first batch clears what is left
//   mentions       a cron-drained rev-up gets its document↔equipment edges
//                  back when the re-index reaches 'ready'
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
import { ingestKnowledgeDocBatch, resetKnowledgeIndex, drainKnowledgeIngestQueue } from "@/lib/knowledgeIngest";

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
    vision_retry_after: null, ingest_claimed_by: null, ingest_claimed_at: null,
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

  it("the row is queued BEFORE the index is deleted: a purge that fails part-way never leaves a 'ready' row without its chunks", async () => {
    // Chunks go, then the entity delete fails — the old order left the row
    // 'ready' with pages_indexed 3 and nothing under it for Ask.
    db.hooks.push((op) => op.table === "knowledge_page_entities" && op.kind === "delete"
      ? { error: { code: "57014", message: "statement timeout" } } : undefined);
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out.refreshed).toBe(1);
    expect(out.errors.join(" ")).toMatch(/refresh 025-PID-0101 — Crude P&ID: kd-1: page entities: statement timeout \(the row is queued; the re-index's first batch clears what is left\)/);
    expect(mirror()).toMatchObject({ status: "stale", pages_indexed: 0, source_version_id: "ver-4", ingest_claimed_by: null });
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    // The re-index's first batch clears the old revision's tags it left.
    db.hooks = [];
    r2.objects.set("orgs/o1/dc/rev4.pdf", await makePdf([drawingSheet(1, ["V-101", "P-201A", "E-301"])]));
    await ingestKnowledgeDocBatch(mirror() as unknown as Parameters<typeof ingestKnowledgeDocBatch>[0]);
    expect(rowsOf("knowledge_page_entities").some((e) => String(e.tag).startsWith("V-14"))).toBe(false);
  });

  it("a purge that fails before the row moves leaves the old version, and the library comes round FIRST next run", async () => {
    db.hooks.push((op) => op.table === "knowledge_line_traces" && op.kind === "delete"
      ? { error: { code: "57014", message: "statement timeout" } } : undefined);
    const out = await syncKnowledgeLibrarySources("kl-1");
    expect(out.refreshed).toBe(0);
    expect(out.errors.join(" ")).toMatch(/kd-1: line traces: statement timeout/);
    expect(mirror()).toMatchObject({ status: "ready", source_version_id: "ver-3", ingest_claimed_by: null });
    expect(rowsOf("knowledge_chunks")).toHaveLength(3);
    // Never-synced sorts first in the cron's rotation.
    expect(rowsOf("knowledge_sources")[0].last_synced_at).toBeNull();
  });

  it("ING-1: a rev-up that finds a batch writing the old revision re-points the row at once — Rev 3 never reaches 'ready'", async () => {
    // The mirror is mid-re-index of Rev 3 (its first batch) when Rev 4 is
    // published and the sync runs, start to finish, before that batch commits.
    r2.objects.set("orgs/o1/dc/rev3.pdf", await makePdf([drawingSheet(1, ["V-141", "P-241A", "E-341"])]));
    Object.assign(mirror(), { status: "stale", pages_indexed: 0, page_count: null });
    db.tables.knowledge_chunks = [];
    db.tables.knowledge_page_entities = [];
    let sync: Awaited<ReturnType<typeof syncKnowledgeLibrarySources>> | null = null;
    let running = false;
    db.asyncHooks.push(async (op, filters) => {
      if (running || sync || op.table !== "knowledge_documents" || op.kind !== "update") return;
      if (!filters.some((f) => f.col === "pages_indexed")) return;   // the batch's compare-and-set
      running = true;
      sync = await syncKnowledgeLibrarySources("kl-1");
      running = false;
    });
    const res = await ingestKnowledgeDocBatch(mirror() as unknown as Parameters<typeof ingestKnowledgeDocBatch>[0]);
    expect(sync).toMatchObject({ refreshed: 1, deferred: 0, errors: [] });
    expect(res).toMatchObject({ superseded: true, done: false });
    expect(mirror()).toMatchObject({ status: "stale", source_version_id: "ver-4", source_rev: "4", file_key: "orgs/o1/dc/rev4.pdf", ingest_claimed_by: null });
    expect(rowsOf("knowledge_chunks")).toHaveLength(0);
    expect(rowsOf("knowledge_page_entities")).toHaveLength(0);
    // It landed, so the library is stamped as reconciled.
    expect(String(rowsOf("knowledge_sources")[0].last_synced_at)).toMatch(/^20/);
  });

  /** Sync C reads the mirror while it still names Rev 3, then is held at
   *  its reset's claim — exactly the window in which sync A re-points it. */
  const staleSync = () => {
    let claims = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    db.asyncHooks.push(async (op) => {
      if (op.table !== "knowledge_documents" || op.kind !== "update") return;
      if (!String((op.payload as Row).ingest_claimed_by ?? "").startsWith("reset:")) return;
      if (++claims === 1) await gate;
    });
    const run = syncKnowledgeLibrarySources("kl-1");
    return { run, parked: () => claims >= 1, release: () => open() };
  };
  const REV4 = () => makePdf([drawingSheet(1, ["V-101", "P-201A", "E-301"]), drawingSheet(2, ["V-102", "P-202A", "E-302"])]);

  it("ING-1: a second sync that read Rev 3 lands under Rev 4's first batch — it resets nothing, and the batch's pages stay", async () => {
    r2.objects.set("orgs/o1/dc/rev4.pdf", await REV4());
    const c = staleSync();
    await vi.waitFor(() => expect(c.parked()).toBe(true));
    // Sync A re-points the mirror at Rev 4 while C is held.
    expect(await syncKnowledgeLibrarySources("kl-1")).toMatchObject({ refreshed: 1, deferred: 0, errors: [] });
    expect(mirror()).toMatchObject({ source_version_id: "ver-4", status: "stale", pages_indexed: 0 });
    // Rev 4's first batch runs; C lands just before its commit (the probe:
    // the batch's compare-and-set still matched, and the row ended 'ready'
    // with every chunk gone).
    let cOut: Awaited<ReturnType<typeof syncKnowledgeLibrarySources>> | null = null;
    db.asyncHooks.push(async (op, filters) => {
      if (cOut || op.table !== "knowledge_documents" || op.kind !== "update") return;
      if (!filters.some((f) => f.col === "pages_indexed")) return;       // the batch's compare-and-set
      c.release();
      cOut = await c.run;
    });
    const res = await ingestKnowledgeDocBatch(mirror() as unknown as Parameters<typeof ingestKnowledgeDocBatch>[0]);
    expect(cOut).toMatchObject({ refreshed: 0, deferred: 1, errors: [] });
    expect(res).toMatchObject({ done: true, superseded: false });
    expect(mirror()).toMatchObject({ status: "ready", pages_indexed: 2, page_count: 2, source_version_id: "ver-4", ingest_claimed_by: null });
    expect(rowsOf("knowledge_chunks").length).toBeGreaterThan(0);
    expect(rowsOf("knowledge_page_entities").map((e) => e.tag)).toEqual(expect.arrayContaining(["V-101", "V-102"]));
    // C did not land: its library comes round first next run, and finds
    // nothing to do.
    expect(rowsOf("knowledge_sources")[0].last_synced_at).toBeNull();
    expect(await syncKnowledgeLibrarySources("kl-1")).toMatchObject({ refreshed: 0, deferred: 0 });
    expect(mirror().status).toBe("ready");
  });

  it("ING-1: the same stale sync after Rev 4 was re-indexed (no batch running) leaves it alone — nothing re-reset, nothing re-billed", async () => {
    r2.objects.set("orgs/o1/dc/rev4.pdf", await REV4());
    const c = staleSync();
    await vi.waitFor(() => expect(c.parked()).toBe(true));
    await syncKnowledgeLibrarySources("kl-1");
    await ingestKnowledgeDocBatch(mirror() as unknown as Parameters<typeof ingestKnowledgeDocBatch>[0]);
    mirror().vision_pages = 2;                                   // as if its sheets were read by vision
    const chunks = rowsOf("knowledge_chunks").length;
    expect(mirror()).toMatchObject({ status: "ready", source_version_id: "ver-4" });
    c.release();
    expect(await c.run).toMatchObject({ refreshed: 0, deferred: 1, errors: [] });
    expect(mirror()).toMatchObject({ status: "ready", pages_indexed: 2, vision_pages: 2, source_version_id: "ver-4" });
    expect(rowsOf("knowledge_chunks")).toHaveLength(chunks);
  });

  it("a cron-drained rev-up gets its document↔equipment mentions back when the re-index reaches 'ready'", async () => {
    db.tables.assets = [
      { id: "a-v101", org_id: "o1", tag: "V-101", archived: false },
      { id: "a-p201a", org_id: "o1", tag: "P-201A", archived: false },
    ];
    db.tables.asset_aliases = [];
    r2.objects.set("orgs/o1/dc/rev4.pdf", await makePdf([
      drawingSheet(1, ["V-101", "P-201A", "E-301"]), drawingSheet(2, ["V-102", "P-202A", "E-302"]),
    ]));
    await syncKnowledgeLibrarySources("kl-1");
    // The reset dropped the machine mention; the pin stays.
    expect(rowsOf("entity_mentions").map((m) => m.id)).toEqual(["m-human"]);
    const out = await drainKnowledgeIngestQueue({ maxPages: 100, deadlineMs: Date.now() + 30_000 });
    expect(out.completed).toBe(1);
    expect(mirror().status).toBe("ready");
    const machine = rowsOf("entity_mentions").filter((m) => m.is_explicit === false);
    expect(machine).toEqual(expect.arrayContaining([
      expect.objectContaining({ asset_id: "a-v101", knowledge_document_id: MIRROR, document_id: "dc-1", page: 1 }),
      expect.objectContaining({ asset_id: "a-p201a", knowledge_document_id: MIRROR, document_id: "dc-1", page: 1 }),
    ]));
    expect(rowsOf("entity_mentions").some((m) => m.id === "m-human")).toBe(true);
  });

  it("the shared reset without a file change keeps cached traces (a rebuild of the same file)", async () => {
    const res = await resetKnowledgeIndex([MIRROR]);
    expect(res).toEqual({ reset: [MIRROR], busy: [], errors: [] });
    expect(rowsOf("knowledge_line_traces")).toHaveLength(1);
    expect(rowsOf("knowledge_page_entities")).toHaveLength(0);
    expect(mirror()).toMatchObject({ status: "stale", vision_pages: 0, file_key: "orgs/o1/dc/rev3.pdf" });
  });

  it("on a database without 20261122 the reset still clears the index and resets the old counters", async () => {
    const cols = ["ingest_claimed_by", "ingest_claimed_at", "empty_pages", "vision_failed_pages", "vision_partial_accepted", "chunk_version", "vision_retry_after"];
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
