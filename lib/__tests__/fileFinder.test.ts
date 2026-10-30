// The finder's whole value is behaving like a careful person in a messy
// drive. These tests pin the scenario it was designed around: "U1-A for the
// born heater pilot valve in 2018" against a share where the file is in a
// transmix folder it doesn't belong in, an AFE project folder dated a year
// late, and an empty 0 KB copy.

import { describe, it, expect } from "vitest";
import {
  canonicalForm, tagVariants, findIdentifiers, isLooserIdentifier,
  parseQuery, parseDirectoryListing, entriesFromListing, entryFromDocument,
  clusterByHash, rankEntries, type FinderAlias, type IndexEntry,
} from "@/lib/fileFinder";

const UNITS = [
  { code: "20", label: "Crude Unit" },
  { code: "45", label: "Transmix" },
  { code: "30", label: "Alky" },
];

const bornAlias: FinderAlias = {
  id: "a1", orgId: "o", term: "born", termCanonical: "BORN", means: "crude", meansCanonical: "CRUDE",
  kind: "unit", origin: "human", hits: 0, misses: 0, note: null, createdByName: "DC", createdAt: "",
};

describe("tag forms", () => {
  it("collapses every spelling of U1-A to one identity", () => {
    for (const s of ["U1-A", "U1A", "U-1A", "u 1 a", "U-1-A", "u1a"]) expect(canonicalForm(s)).toBe("U1A");
  });
  it("offers the spellings a person might have used", () => {
    expect(tagVariants("U1A")).toEqual(expect.arrayContaining(["U1A", "U-1A", "U1-A", "U-1-A"]));
  });
  it("finds identifiers in filenames and ignores revision stubs", () => {
    expect(findIdentifiers("born-u1a_R7.pdf")).toEqual(["U1A"]);
    expect(findIdentifiers("AFE200155/Crude/E-101 datasheet rev3")).toEqual(expect.arrayContaining(["AFE200155", "E101"]));
    const plumbing = findIdentifiers("100-PID-001_SHT01_R38.pdf");
    expect(plumbing).not.toContain("SHT01");
    expect(plumbing).not.toContain("R38");
    expect(findIdentifiers("U-1-A and PSV-2001A")).toEqual(["U1A", "PSV2001A"]);
  });
  it("knows U1 is a looser form of U1A, not the other way round", () => {
    expect(isLooserIdentifier("U1", "U1A")).toBe(true);
    expect(isLooserIdentifier("U1A", "U1")).toBe(false);
    expect(isLooserIdentifier("E1", "EA1")).toBe(false);
  });
});

describe("query parsing", () => {
  it("turns the sentence into chips a person can check", () => {
    const q = parseQuery("U1-A for the born heater pilot valve in 2018", { units: UNITS, aliases: [bornAlias] });
    expect(q.identifiers.map((c) => c.value)).toEqual(["U1A"]);
    expect(q.years.map((c) => c.value)).toEqual(["2018"]);
    expect(q.words.map((c) => c.value)).toEqual(expect.arrayContaining(["born", "heater", "pilot", "valve"]));
    expect(q.phrases.map((c) => c.value)).toEqual(expect.arrayContaining(["pilot valve", "born heater"]));
    const unit = q.units.find((c) => c.value === "20");
    expect(unit?.via).toBe("alias");
    expect(unit?.aliasId).toBe("a1");
  });
  it("names a unit straight from the codebook without an alias", () => {
    const q = parseQuery("crude heater", { units: UNITS });
    expect(q.units[0]).toMatchObject({ value: "20", via: "codebook" });
  });
  it("never treats the identifier as a word too", () => {
    const q = parseQuery("u1a datasheet", { units: UNITS });
    expect(q.words.map((c) => c.value)).toEqual(["datasheet"]);
  });
});

describe("directory listings", () => {
  it("reads one full path per line", () => {
    const out = parseDirectoryListing([
      "\\\\thor\\eng\\Crude\\Heaters\\born-u1a.pdf",
      "T:\\Transmix\\misc\\U1A.pdf",
      "T:\\Transmix\\misc\\",
    ].join("\n"));
    expect(out.format).toBe("paths");
    expect(out.files).toHaveLength(2);
    expect(out.files[0]).toMatchObject({ path: ["thor", "eng", "Crude", "Heaters"], name: "born-u1a.pdf" });
    expect(out.files[1].path).toEqual(["Transmix", "misc"]);
    expect(out.folders).toContain("Transmix/misc");
  });
  it("reads dir /s output with sizes and dates", () => {
    const out = parseDirectoryListing(`
 Volume in drive T is THOR
 Directory of T:\\Crude\\Heaters

01/15/2019  03:22 PM    <DIR>          .
01/15/2019  03:22 PM    <DIR>          ..
01/15/2019  03:22 PM         1,234,567 U1A.pdf
01/15/2019  03:22 PM                 0 U1A - Copy.pdf
               2 File(s)      1,234,567 bytes

 Directory of T:\\Crude\\Heaters\\old

12/02/2016  09:00 AM            88,000 u1-a_2016.pdf
`);
    expect(out.format).toBe("dir");
    expect(out.files).toHaveLength(3);
    expect(out.files[0]).toMatchObject({ path: ["Crude", "Heaters"], name: "U1A.pdf", sizeBytes: 1234567, date: "2019-01-15" });
    expect(out.files[1].sizeBytes).toBe(0);
    expect(out.files[2].path).toEqual(["Crude", "Heaters", "old"]);
  });
  it("reads windows tree /f output", () => {
    const out = parseDirectoryListing(`Folder PATH listing
Volume serial number is 1234-ABCD
T:.
├───Crude
│   │   index.xlsx
│   └───Heaters
│           born-u1a.pdf
└───Transmix
        U1A.pdf
`);
    expect(out.format).toBe("tree-win");
    expect(out.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["Crude"], name: "index.xlsx" }),
      expect.objectContaining({ path: ["Crude", "Heaters"], name: "born-u1a.pdf" }),
      expect.objectContaining({ path: ["Transmix"], name: "U1A.pdf" }),
    ]));
  });
  it("reads unix tree output", () => {
    const out = parseDirectoryListing(`thor
├── Crude
│   └── Heaters
│       └── born-u1a.pdf
└── Transmix
    └── U1A.pdf

3 directories, 2 files
`);
    expect(out.format).toBe("tree-unix");
    expect(out.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["Crude", "Heaters"], name: "born-u1a.pdf" }),
      expect.objectContaining({ path: ["Transmix"], name: "U1A.pdf" }),
    ]));
  });
});

describe("ranking", () => {
  const folders = new Map([
    ["f-afe", { id: "f-afe", libraryId: "L", parentId: null, name: "AFE200155" }],
    ["f-crude", { id: "f-crude", libraryId: "L", parentId: "f-afe", name: "Crude" }],
    ["f-born", { id: "f-born", libraryId: "L", parentId: "f-crude", name: "Born" }],
    ["f-tmx", { id: "f-tmx", libraryId: "L", parentId: null, name: "Transmix" }],
    ["f-rand", { id: "f-rand", libraryId: "L", parentId: null, name: "random" }],
  ]);
  const libraries = new Map([["L", { id: "L", name: "Engineering" }]]);
  const ctx = { folders, libraries };

  const good = entryFromDocument(
    { id: "d1", library_id: "L", collection_id: "f-born", name: "u1a.pdf", title: "U1-A heater pilot valve", effective_date: "2019-03-01", created_at: "2019-03-02" },
    { ...ctx, version: { fileHash: "h1", fileSize: 500_000 } },
  );
  const transmix = entryFromDocument(
    { id: "d2", library_id: "L", collection_id: "f-tmx", name: "U1A heater.pdf", effective_date: "2018-06-01" },
    { ...ctx, version: { fileHash: "h1", fileSize: 500_000 } },
  );
  const empty = entryFromDocument(
    { id: "d3", library_id: "L", collection_id: "f-rand", name: "born-u1.pdf", effective_date: "2018-01-01" },
    { ...ctx, version: { fileHash: "h3", fileSize: 0 } },
  );
  const unrelated = entryFromDocument(
    { id: "d4", library_id: "L", collection_id: "f-crude", name: "E-101 datasheet.pdf" },
    { ...ctx, version: { fileSize: 100 } },
  );

  it("indexes the folder chain, identifiers and years", () => {
    expect(good.path).toEqual(["AFE200155", "Crude", "Born"]);
    expect(good.pathIdents).toContain("AFE200155");
    expect(good.idents).toContain("U1A");
    expect(good.years).toEqual([2019]);
  });

  it("ranks the AFE copy above the transmix copy, rejects the empty one, drops the unrelated one", () => {
    const q = parseQuery("U1-A for the born heater pilot valve in 2018", { units: UNITS, aliases: [bornAlias] });
    const hits = rankEntries([transmix, empty, good, unrelated], q, { units: UNITS, sameBytes: clusterByHash([good, transmix]) });
    expect(hits.map((h) => h.entry.id)).toEqual(["doc:d1", "doc:d2", "doc:d3"]);
    const [top, tmx, dead] = hits;
    expect(top.verdict).toBe("strong");
    expect(top.evidence.map((e) => e.label)).toEqual(expect.arrayContaining([
      expect.stringMatching(/Name says U1-A/),
      expect.stringMatching(/Lives under Crude Unit \(via alias\)/),
      expect.stringMatching(/one year off/),
      expect.stringMatching(/Same bytes in 2 places/),
    ]));
    expect(tmx.evidence.map((e) => e.label)).toContain("Folder says Transmix, a different unit");
    expect(tmx.score).toBeLessThan(top.score);
    expect(dead.verdict).toBe("rejected");
    expect(dead.evidence.map((e) => e.label)).toContain("0 KB - empty file");
  });

  it("reports a drive listing hit as a prospect outside the system", () => {
    const listing = entriesFromListing({ id: "thor", name: "Thor drive", files: [
      { path: ["eng", "Crude", "Heaters"], name: "born-u1a.pdf", date: "2018-05-01" },
    ] });
    const q = parseQuery("U1A born heater", { units: UNITS, aliases: [bornAlias] });
    const [hit] = rankEntries(listing as IndexEntry[], q, { units: UNITS });
    expect(hit.entry.source).toBe("listing");
    expect(hit.evidence.map((e) => e.label)).toContain("Listed on Thor drive, not in the system");
    expect(hit.verdict).toBe("strong");
  });
});

describe("thinking like a person who has never seen the drive", () => {
  const folders = new Map([["f", { id: "f", libraryId: "L", parentId: null, name: "Crude" }]]);
  const libraries = new Map([["L", { id: "L", name: "Engineering" }]]);
  const ctx = { folders, libraries };
  const mk = (id: string, name: string, number?: string) =>
    entryFromDocument({ id, library_id: "L", collection_id: "f", name, document_number: number ?? null }, ctx);
  const ep = mk("ep", "EP10-1-15 pilot valve.pdf");
  const pid = mk("pid", "100-PID-001_R7.pdf", "100-PID-001");
  const f101 = mk("f101", "F-101 heater datasheet.pdf");
  const other = mk("other", "Alky pump curve.pdf");

  it("finds EP10-1-15 when the EP is left off, and says what was missing", () => {
    const hits = rankEntries([ep, pid, f101, other], parseQuery("10-1-15"), {});
    expect(hits.map((h) => h.entry.id)).toEqual(["doc:ep"]);
    expect(hits[0].verdict).not.toBe("weak");
    expect(hits[0].evidence[0].label).toMatch(/EP-?10115|EP10-1-15/i);
    expect(hits[0].evidence[0].label).toMatch(/contains 10-1-15/);
    expect(hits[0].evidence[0].label).toMatch(/missing the EP prefix/);
  });
  it("still ranks the exact spelling above the partial one", () => {
    const exact = rankEntries([ep], parseQuery("EP10-1-15"), {})[0];
    const partial = rankEntries([ep], parseQuery("10-1-15"), {})[0];
    expect(exact.score).toBeGreaterThan(partial.score);
    expect(exact.verdict).toBe("strong");
  });
  it("does not read 10-1-15 as the year 2015", () => {
    const q = parseQuery("10-1-15");
    expect(q.years).toEqual([]);
    expect(q.identifiers.map((c) => c.label)).toEqual(["10-1-15"]);
  });
  it("finds a drawing by the tail of its number", () => {
    const hits = rankEntries([ep, pid, f101, other], parseQuery("PID-001"), {});
    expect(hits[0].entry.id).toBe("doc:pid");
    expect(hits[0].evidence[0].tier).toBe("contains");
  });
  it("forgives a typo and says so", () => {
    const hits = rankEntries([ep, pid, f101, other], parseQuery("EP10-1-51 heatr"), {});
    const byId = Object.fromEntries(hits.map((h) => [h.entry.id.replace("doc:", ""), h]));
    expect(byId.ep.evidence[0]).toMatchObject({ tier: "close" });
    expect(byId.ep.evidence[0].label).toMatch(/2 characters off/);
    expect(byId.f101.evidence.map((e) => e.label)).toEqual(expect.arrayContaining([expect.stringMatching(/"heater", close to "heatr"/)]));
  });
  it("suggests the same number under a different prefix", () => {
    const hits = rankEntries([ep, pid, f101, other], parseQuery("P-101"), {});
    expect(hits[0].entry.id).toBe("doc:f101");
    expect(hits[0].evidence[0]).toMatchObject({ tier: "number" });
  });
  it("comes back empty only when nothing is near", () => {
    expect(rankEntries([ep, pid, f101, other], parseQuery("ZZ-9999 compressor"), {})).toEqual([]);
  });
});

describe("asking the way people actually ask", () => {
  const folders = new Map([
    ["lib-d", { id: "lib-d", libraryId: "L", parentId: null, name: "P&ID's" }],
    ["crude", { id: "crude", libraryId: "L", parentId: "lib-d", name: "20 - Crude" }],
    ["alky", { id: "alky", libraryId: "L", parentId: "lib-d", name: "30 - Alky" }],
  ]);
  const libraries = new Map([["L", { id: "L", name: "Drawings" }]]);
  const ctx = { folders, libraries };
  const sheets = [1, 2, 3, 4, 5, 6].map((n) =>
    entryFromDocument({ id: `s${n}`, library_id: "L", collection_id: "crude", name: `2002-D 2001_SHT0${n}_R3${n}.pdf`, rev: `3${n}` }, ctx));
  const alkySheet5 = entryFromDocument({ id: "a5", library_id: "L", collection_id: "alky", name: `2002-D 3001_SHT05_R02.pdf`, rev: "02" }, ctx);
  const isoCrude = entryFromDocument({ id: "iso", library_id: "L", collection_id: "crude", name: "Crude ISO-2001-05.pdf" }, ctx);

  it("reads P&ID as a drawing type, not the word pandid", () => {
    const q = parseQuery("crude P&ID sheet 5", { units: UNITS });
    expect(q.docTypes.map((c) => c.value)).toEqual(["pid"]);
    expect(q.sheets.map((c) => c.value)).toEqual(["5"]);
    expect(q.words.map((c) => c.value)).not.toContain("pandid");
    expect(q.words.map((c) => c.value)).not.toContain("sheet");
    expect(q.identifiers).toEqual([]);
  });
  it("indexes sheet, rev and type from a conventional drawing name", () => {
    expect(sheets[4]).toMatchObject({ sheet: 5, revCanon: "35" });
    expect(sheets[4].docTypes).toContain("pid");
  });
  it("puts sheet 5 of the crude P&IDs first and says why the others are not it", () => {
    const q = parseQuery("crude P&ID sheet 5", { units: UNITS });
    const hits = rankEntries([...sheets, alkySheet5, isoCrude], q, { units: UNITS });
    expect(hits[0].entry.id).toBe("doc:s5");
    expect(hits[0].verdict).toBe("strong");
    expect(hits[0].evidence.map((e) => e.label)).toEqual(expect.arrayContaining(["Sheet 5", "It's a P&ID"]));
    const s1 = hits.find((h) => h.entry.id === "doc:s1")!;
    expect(s1.evidence.map((e) => e.label)).toContain("This is sheet 1; you asked for sheet 5");
    expect(s1.score).toBeLessThan(hits[0].score - 30);
    // Sheet 5 of the alky set is the right page in the wrong unit: below the crude one.
    const a5 = hits.find((h) => h.entry.id === "doc:a5")!;
    expect(a5.score).toBeLessThan(hits[0].score);
    expect(a5.evidence.map((e) => e.label)).toContain("Folder says Alky, a different unit");
  });
  it("knows the ISO is not the P&ID asked for", () => {
    const q = parseQuery("crude P&ID", { units: UNITS });
    const hits = rankEntries([sheets[0], isoCrude], q, { units: UNITS });
    const iso = hits.find((h) => h.entry.id === "doc:iso")!;
    expect(iso.evidence.map((e) => e.label)).toContain("It's a Isometric, not a P&ID");
    expect(hits[0].entry.id).toBe("doc:s1");
  });
  it("matches a revision when asked, and says which one the file is otherwise", () => {
    const hits = rankEntries(sheets, parseQuery("2002-D 2001 rev 33"), {});
    expect(hits[0].entry.id).toBe("doc:s3");
    expect(hits[0].evidence.map((e) => e.label)).toContain("Rev 33");
    const s1 = hits.find((h) => h.entry.id === "doc:s1")!;
    expect(s1.evidence.map((e) => e.label)).toContain("This is rev 31; you asked for rev 33");
  });
  it("accepts sht 5, SHT05 and page 5 as the same ask", () => {
    for (const ask of ["sht 5", "SHT05", "page 5", "sheet #5"]) {
      expect(parseQuery(ask).sheets.map((c) => c.value)).toEqual(["5"]);
    }
  });
});

describe("scanner listings and triage", () => {
  it("reads the scanner's JSON with hashes", () => {
    const json = JSON.stringify({ format: "thor-scan/1", folders: ["Crude", "Dave's stuff"], files: [
      { path: ["Crude"], name: "2002-D-2001_SHT05.pdf", sizeBytes: 100, date: "2019-01-15", hash: "a".repeat(64) },
      { path: ["Dave's stuff"], name: "OC74321.pdf", sizeBytes: 90, hash: "b".repeat(64) },
      { path: ["Dave's stuff"], name: "copy of sheet.pdf", sizeBytes: 100, hash: "a".repeat(64) },
      { path: ["Dave's stuff"], name: "empty.pdf", sizeBytes: 0 },
    ] });
    const out = parseDirectoryListing(json);
    expect(out.format).toBe("scan");
    expect(out.files).toHaveLength(4);
    expect(out.files[0].hash).toBe("a".repeat(64));
    const entries = entriesFromListing({ id: "t", name: "Thor", files: out.files });
    expect(entries[0].hash).toBe("a".repeat(64));
  });
  it("triages: duplicates, known-by-hash, drawings, copier scans, personal folders", async () => {
    const { triageListing } = await import("@/lib/fileFinder/triage");
    const out = parseDirectoryListing(JSON.stringify({ format: "thor-scan/1", folders: ["Crude", "Dave's stuff"], files: [
      { path: ["Crude"], name: "2002-D-2001_SHT05.pdf", sizeBytes: 100, hash: "a".repeat(64) },
      { path: ["Dave's stuff"], name: "OC74321.pdf", sizeBytes: 90, hash: "b".repeat(64) },
      { path: ["Dave's stuff"], name: "copy of sheet.pdf", sizeBytes: 100, hash: "a".repeat(64) },
      { path: ["Dave's stuff"], name: "empty.pdf", sizeBytes: 0 },
    ] }));
    const t = triageListing(out.files, out.folders, new Set(["a".repeat(64)]));
    expect(t).toMatchObject({ files: 4, duplicateGroups: 1, duplicateFiles: 1, knownInSystem: 2, drawingLike: 1, copierLike: 1, empty: 1 });
    expect(t.personalFolders).toEqual(["Dave's stuff"]);
    expect(t.readFirst.map((f) => f.name)).toEqual(["OC74321.pdf"]);
  });
  it("tells a drive file apart from its twin already in the system", () => {
    const folders = new Map([["f", { id: "f", libraryId: "L", parentId: null, name: "Crude" }]]);
    const libraries = new Map([["L", { id: "L", name: "Drawings" }]]);
    const sys = entryFromDocument({ id: "d1", library_id: "L", collection_id: "f", name: "2002-D-2001_SHT05.pdf" }, { folders, libraries, version: { fileHash: "a".repeat(64) } });
    const [drive] = entriesFromListing({ id: "t", name: "Thor", files: [{ path: ["Dave's stuff"], name: "copy of sheet.pdf", hash: "a".repeat(64) }] });
    const hits = rankEntries([sys, drive as IndexEntry], parseQuery("2002-D-2001 sheet 5"), { sameBytes: clusterByHash([sys, drive as IndexEntry]) });
    const d = hits.find((h) => h.entry.id === drive.id);
    expect(d?.evidence.map((e) => e.label)).toEqual(expect.arrayContaining([expect.stringMatching(/same bytes as "2002-D-2001_SHT05.pdf", already in the system/)]));
  });
});
