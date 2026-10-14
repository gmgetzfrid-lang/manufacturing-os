// lib/__tests__/aoRoundGP14ExportStream.test.ts
//
// admin-and-org Round G, package P14 — intelligence ILIFE-11.
//
//   criterion 2  the export streams rows rather than building one JSON string
//                (lib/prettyJsonStream.ts: the server ZIP's table files and
//                the JSON download are written a batch of rows at a time),
//                and the records' size is MEASURED first and said: the
//                X-Export-Bytes header, which the browser reads before it
//                parses the body or builds a part (lib/clientBackup.ts
//                exportSizeWarning, EXPORT_SIZE_WARN_BYTES).
//   README       the server ZIP's README.md names the omitted derived
//                columns (manifest.omittedColumns) with the export
//                contract's reason.
//
// The streamed text must be byte-identical to JSON.stringify(value, null, 2)
// (regression: every export that works today reads the same).

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } } }));

import { prettyJsonChunks, batchedChunks, prettyJsonByteLength } from "@/lib/prettyJsonStream";
import { tableJsonContent, omittedColumnsReadmeSection } from "@/lib/exportRunner";
import { EXPORT_OMITTED_COLUMNS } from "@/lib/exportTables";
import { exportSizeWarning, EXPORT_SIZE_WARN_BYTES, runFullBackup, type BackupProgress } from "@/lib/clientBackup";

const joined = (v: unknown, depth?: number) => [...prettyJsonChunks(v, depth)].join("");

/** A small deterministic generator of JSON-ish values, with the shapes JSON.stringify treats specially. */
function rng(seed: number) { let x = seed; return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; }; }
function value(r: () => number, depth: number): unknown {
  const pick = Math.floor(r() * 14);
  if (depth <= 0 || pick < 6) {
    return [null, true, false, 0, -1.5, 1e21, NaN, Infinity, "", "line\nbreak \"q\" \\ é 漢  ", undefined, () => 1, new Date(Date.UTC(2026, 9, 14)), "x"][Math.floor(r() * 14)];
  }
  if (pick < 10) return Array.from({ length: Math.floor(r() * 4) }, () => value(r, depth - 1));
  const o: Record<string, unknown> = {};
  for (let i = 0; i < Math.floor(r() * 4); i++) o[["a", "b c", "\"k\"", "embedding", "1", "é"][Math.floor(r() * 6)] + i] = value(r, depth - 1);
  return o;
}

describe("ILIFE-11 criterion 2 — prettyJsonChunks is JSON.stringify(value, null, 2), a piece at a time", () => {
  it("the edge cases JSON.stringify treats specially", () => {
    const cases: unknown[] = [
      null, 0, "s", true, [], {}, [[]], [{}], { a: [] }, { a: {} },
      { a: undefined, b: () => 1, c: Symbol("s"), d: 1 },          // left out of an object
      [undefined, () => 1, Symbol("s"), 2],                         // null in an array
      { d: new Date(Date.UTC(2026, 0, 2)) },                         // toJSON
      { custom: { toJSON: (k: string) => ({ key: k, n: 1 }) } },     // toJSON with its key
      [new Number(3), new String("s"), new Boolean(false)],          // boxed primitives
      { nested: { deeper: { deepest: [1, { x: "a\nb" }] } } },
      { "weird\nkey": "v", " ": "w" },
      [NaN, -0, Infinity],
      [1, , 3],
    ];
    for (const c of cases) for (const d of [0, 1, 2, 3, 5]) expect(joined(c, d), `${JSON.stringify(c)} @${d}`).toBe(JSON.stringify(c, null, 2));
    expect(joined(undefined)).toBe("");
    expect(joined(() => 1)).toBe("");
  });

  it("five hundred generated values, at every split depth", () => {
    const r = rng(14);
    for (let i = 0; i < 500; i++) {
      const v = value(r, 4);
      for (const d of [1, 2, 3]) expect(joined(v, d)).toBe(JSON.stringify(v, null, 2) ?? "");
    }
  });

  it("an envelope-shaped value splits to one piece per row, and the batches join to the same text", () => {
    const env = {
      manifest: { orgId: "o", exportedAt: "2026-10-14T00:00:00Z", tables: [{ name: "t", rowCount: 3 }] },
      tables: { t: [{ id: 1, content: "a" }, { id: 2, content: "b" }, { id: 3, content: "c" }], empty: [] },
      files: [{ path: "p", size: 1, presignedUrl: "https://x" }],
    };
    const pieces = [...prettyJsonChunks(env, 3)];
    expect(pieces).toContain(JSON.stringify({ id: 2, content: "b" }, null, 2).replace(/\n/g, "\n      "));
    expect(pieces.join("")).toBe(JSON.stringify(env, null, 2));
    expect([...batchedChunks(prettyJsonChunks(env, 3), 16)].join("")).toBe(JSON.stringify(env, null, 2));
    expect([...batchedChunks(prettyJsonChunks(env, 3), 16)].length).toBeGreaterThan(1);
    expect(prettyJsonByteLength({ s: "é漢" }, 3)).toBe(Buffer.byteLength(JSON.stringify({ s: "é漢" }, null, 2), "utf8"));
  });

  it("the structured route measures, then streams — it never builds the envelope as one string", () => {
    const src = readFileSync(join(process.cwd(), "app/api/data-export/structured/route.ts"), "utf8");
    expect(src).not.toMatch(/=\s*JSON\.stringify\(envelope/);
    expect(src).toMatch(/prettyJsonByteLength\(envelope, 3\)/);
    expect(src).toMatch(/new ReadableStream<Uint8Array>/);
    expect(src).toMatch(/"X-Export-Bytes": String\(totalBytes\)/);
    const runner = readFileSync(join(process.cwd(), "lib/exportRunner.ts"), "utf8");
    expect(runner).not.toMatch(/JSON\.stringify\(rows, null, 2\)\);\n\s*}/); // the per-table string build is gone
    expect(runner).toMatch(/tableFolder\?\.file\(`\$\{name\}\.json`, tableJsonContent\(rows\)\)/);
  });
});

describe("ILIFE-11 criterion 2 — the server ZIP's tables are streamed into the compressor", () => {
  it("tableJsonContent is a stream JSZip reads, and the file holds exactly JSON.stringify(rows, null, 2)", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `c${i}`, content: `passage ${i}\nline`, seq: i, meta: { k: [i, null] } }));
    const content = tableJsonContent(rows);
    expect(typeof content).not.toBe("string");
    const zip = new JSZip();
    zip.file("tables/knowledge_chunks.json", content);
    zip.file("tables/empty.json", tableJsonContent([]));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const back = await JSZip.loadAsync(bytes);
    expect(await back.file("tables/knowledge_chunks.json")!.async("string")).toBe(JSON.stringify(rows, null, 2));
    expect(await back.file("tables/empty.json")!.async("string")).toBe("[]");
  });

  // P14 review fix (blocker): JSZip treats a stream as binary — it skips its
  // UTF-8 encoder and keeps the low byte of each char code of a string chunk —
  // so a stream of JS strings wrote every non-ASCII character back as U+FFFD.
  // The stream yields UTF-8 bytes; the text reads back exactly.
  it("non-ASCII text (°, Ø, µ, —, accents, CJK, an emoji) reads back exactly, on every row and across batch boundaries", async () => {
    const odd = { title: "Ø 50 mm flange — 120 °C ± 2 µm", owner: "Zoë 日本", note: "pump 🔧 — naïve café, Straße, Ελλάδα" };
    const rows = [
      odd,
      ...Array.from({ length: 2500 }, (_, i) => ({ id: `c${i}`, content: `passage ${i} — ${i % 3 === 0 ? "Ø°µ" : "日本語"} 🔧\nline`, seq: i })),
    ];
    const content = tableJsonContent(rows);
    const stream = tableJsonContent([odd]);
    expect(typeof stream).not.toBe("string");
    const chunks: unknown[] = [];
    for await (const c of stream as AsyncIterable<unknown>) chunks.push(c);
    expect(chunks.every((c) => Buffer.isBuffer(c))).toBe(true); // bytes, never a JS string JSZip would cut to its low byte
    expect(Buffer.concat(chunks as Buffer[]).toString("utf8")).toBe(JSON.stringify([odd], null, 2));
    const zip = new JSZip();
    zip.folder("tables")!.file("assets.json", content);
    zip.folder("tables")!.file("one.json", tableJsonContent([odd]));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const back = await JSZip.loadAsync(bytes);
    const text = await back.file("tables/assets.json")!.async("string");
    expect(text).toBe(JSON.stringify(rows, null, 2));
    expect(text).not.toContain("\uFFFD");
    expect(JSON.parse(await back.file("tables/one.json")!.async("string"))).toEqual([odd]);
    expect(await back.file("tables/one.json")!.async("string")).toContain("Ø 50 mm flange — 120 °C ± 2 µm");
  });
});

describe("ILIFE-11 — the README's Omitted derived columns section", () => {
  it("renders each omitted column with the export contract's reason; nothing when none", () => {
    const section = omittedColumnsReadmeSection({ knowledge_chunks: ["embedding"] });
    expect(section).toBe(
      `\n## Omitted derived columns\n\nThese columns are derived data and are NOT in this archive (not exported as null — left out):\n- knowledge_chunks: embedding — ${EXPORT_OMITTED_COLUMNS.knowledge_chunks.reason}\n`,
    );
    expect(section).toMatch(/meaning-index Build on each library/);
    expect(omittedColumnsReadmeSection({})).toBe("");
    expect(omittedColumnsReadmeSection(undefined)).toBe(""); // an older manifest has no such field
    expect(omittedColumnsReadmeSection({ other_table: ["x"] })).toBe(
      "\n## Omitted derived columns\n\nThese columns are derived data and are NOT in this archive (not exported as null — left out):\n- other_table: x\n",
    );
  });
});

describe("ILIFE-11 criterion 2 — the browser says the measured size before it builds", () => {
  it("exportSizeWarning: silent below the threshold or without a measurement; a sentence at or above it", () => {
    expect(exportSizeWarning(null)).toBeNull();
    expect(exportSizeWarning("abc")).toBeNull();
    expect(exportSizeWarning(String(EXPORT_SIZE_WARN_BYTES - 1))).toBeNull();
    expect(exportSizeWarning(String(EXPORT_SIZE_WARN_BYTES))).toMatch(/records are 200 MB before any file.*scheduled export to a bucket/);
  });

  it("the Full ZIP emits the warning BEFORE it parses the records, and the backup goes on to build its part", async () => {
    const env = { manifest: { orgId: "o", orgName: "Acme", exportedAt: "2026-10-14T00:00:00Z" }, tables: { notes: [{ id: "n1" }] }, files: [] };
    const seen: Array<{ phase: string; warning?: string; parsed: boolean }> = [];
    let parsed = false;
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      headers: new Headers({ "X-Export-Bytes": String(EXPORT_SIZE_WARN_BYTES + 5) }),
      json: async () => { parsed = true; return env; },
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const saved: string[] = [];
    try {
      const out = await runFullBackup("o", {
        onProgress: (p: BackupProgress) => seen.push({ phase: p.phase, warning: p.sizeWarning, parsed }),
        save: (_b, name) => { saved.push(name); },
      });
      expect(out.parts).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
    const firstWarned = seen.find((s) => s.warning);
    expect(firstWarned).toMatchObject({ phase: "envelope", parsed: false });
    expect(saved).toEqual(["backup-Acme-2026-10-14-part1.zip"]);
  });

  it("regression: no header (or a small one) — no warning, the same run", async () => {
    const env = { manifest: { orgId: "o", orgName: "Acme", exportedAt: "2026-10-14T00:00:00Z" }, tables: {}, files: [] };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => env, text: async () => "" })));
    const warnings: Array<string | undefined> = [];
    try {
      await runFullBackup("o", { onProgress: (p) => warnings.push(p.sizeWarning), save: () => undefined });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(warnings.every((w) => w === undefined)).toBe(true);
  });
});
