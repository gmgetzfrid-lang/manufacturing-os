// What gets written to a permanent audit record has to be right, because
// somebody will cite it in a turnaround meeting a year from now. The cases
// that matter: a sheet we couldn't read is never "passed", severity doesn't
// get averaged away, and a re-drawn sheet is never considered done because
// its OLD revision was checked.

import { describe, it, expect } from "vitest";
import {
  verdictsForSheets, sheetsNeedingAudit, verdictRows, RANK, wouldLowerSeverity,
  seriesHeldBySet, seriesNotJudged, missingWithinHeldSeries, mayReplaceStored, AUDIT_SET_LIST_MAX,
  indexFingerprint, digest, type AuditSheet, type AuditFindings,
} from "@/lib/drawingAuditLog";
import { sheetIdentities } from "@/lib/drawingText";

const sheet = (over: Partial<AuditSheet> = {}): AuditSheet => ({
  documentId: "k-1", controlledDocumentId: "d-1",
  name: "PID-44-012.pdf", sheetNumber: "PID-44-012", revision: "C",
  indexed: true, ...over,
});

const NOTHING: AuditFindings = {
  connectorsWithNoTarget: [], unreturnedConnectors: [], missingInSeries: [], oneWay: [],
};

describe("verdictsForSheets", () => {
  it("passes a clean sheet", () => {
    const [v] = verdictsForSheets([sheet()], NOTHING);
    expect(v.status).toBe("passed");
    expect(v.details.brokenConnectors).toEqual([]);
  });

  it("never passes a sheet nothing was read from", () => {
    // A scan that yielded no text has no findings — which looks identical to
    // a perfect sheet if you only count findings. It isn't.
    const [v] = verdictsForSheets([sheet({ indexed: false })], NOTHING);
    expect(v.status).toBe("skipped");
  });

  it("calls a connector with no destination broken", () => {
    const [v] = verdictsForSheets([sheet()], {
      ...NOTHING,
      connectorsWithNoTarget: [{ sheet: "PID-44-012.pdf", box: "7" }],
    });
    expect(v.status).toBe("broken_connectors");
    expect(v.details.brokenConnectors[0]).toMatch(/names no destination/);
  });

  it("calls a connector the receiving sheet never catches broken", () => {
    const [v] = verdictsForSheets([sheet()], {
      ...NOTHING,
      unreturnedConnectors: [{ from: "PID-44-012.pdf", to: "PID-44-013", box: "3" }],
    });
    expect(v.status).toBe("broken_connectors");
    expect(v.details.brokenConnectors[0]).toContain("PID-44-013");
  });

  it("flags a missing sheet against everyone who pointed at it", () => {
    const sheets = [
      sheet({ name: "A.pdf", sheetNumber: "A" }),
      sheet({ documentId: "k-2", name: "B.pdf", sheetNumber: "B" }),
    ];
    const out = verdictsForSheets(sheets, {
      ...NOTHING,
      missingInSeries: [{ ref: "PID-44-020", referencedBy: ["A.pdf", "B.pdf"] }],
    });
    expect(out.every((v) => v.status === "flagged")).toBe(true);
    expect(out[1].details.missingReferences[0]).toContain("PID-44-020");
  });

  it("ranks a broken connector above a missing reference on the same sheet", () => {
    // Both findings are recorded; the STATUS is the one to act on first.
    const [v] = verdictsForSheets([sheet()], {
      ...NOTHING,
      connectorsWithNoTarget: [{ sheet: "PID-44-012.pdf", box: "7" }],
      missingInSeries: [{ ref: "X-1", referencedBy: ["PID-44-012.pdf"] }],
    });
    expect(v.status).toBe("broken_connectors");
    expect(v.details.missingReferences).toHaveLength(1);
  });

  it("doesn't attribute another sheet's findings", () => {
    const [v] = verdictsForSheets([sheet({ name: "A.pdf" })], {
      ...NOTHING,
      connectorsWithNoTarget: [{ sheet: "SOMETHING-ELSE.pdf", box: "1" }],
    });
    expect(v.status).toBe("passed");
  });

  it("doesn't repeat an identical finding", () => {
    const [v] = verdictsForSheets([sheet()], {
      ...NOTHING,
      oneWay: [
        { from: "PID-44-012.pdf", to: "PID-44-013" },
        { from: "PID-44-012.pdf", to: "PID-44-013" },
      ],
    });
    expect(v.details.oneWay).toHaveLength(1);
  });

  it("carries the revision through untouched, empty included", () => {
    const [v] = verdictsForSheets([sheet({ revision: "" })], NOTHING);
    expect(v.revision).toBe("");
  });
});

describe("sheetsNeedingAudit", () => {
  // k-1's index as it stands now, and a row that covered exactly that.
  const FP = new Map([["k-1", "fp-a"], ["k-2", "fp-b"]]);
  const covered = { "k-1": "fp-a" };

  it("skips a sheet already audited at this revision", () => {
    const out = sheetsNeedingAudit(
      [sheet({ sheetNumber: "P-1", revision: "C" })],
      [{ sheet_number: "P-1", revision_code: "C", status: "passed", coverage: covered }], FP,
    );
    expect(out).toEqual([]);
  });

  it("re-audits a sheet that has been revised since", () => {
    // The old verdict describes a drawing that no longer exists.
    const out = sheetsNeedingAudit(
      [sheet({ sheetNumber: "P-1", revision: "D" })],
      [{ sheet_number: "P-1", revision_code: "C", status: "passed", coverage: covered }], FP,
    );
    expect(out).toHaveLength(1);
  });

  it("re-audits a sheet whose last verdict was 'skipped'", () => {
    // "Couldn't read it" is not "checked it".
    const out = sheetsNeedingAudit(
      [sheet({ sheetNumber: "P-1", revision: "C" })],
      [{ sheet_number: "P-1", revision_code: "C", status: "skipped", coverage: covered }], FP,
    );
    expect(out).toHaveLength(1);
  });

  it("treats a broken verdict as done for this revision", () => {
    // It's recorded and open; re-running the same check doesn't help anyone.
    const out = sheetsNeedingAudit(
      [sheet({ sheetNumber: "P-1", revision: "C" })],
      [{ sheet_number: "P-1", revision_code: "C", status: "broken_connectors", coverage: covered }], FP,
    );
    expect(out).toEqual([]);
  });

  it("audits everything when there's no history", () => {
    expect(sheetsNeedingAudit([sheet(), sheet({ sheetNumber: "P-2" })], [], FP)).toHaveLength(2);
  });

  it("never treats a verdict under an UNKNOWN revision as done — 'unrevised' can't be established (fix pass)", () => {
    // A library-only PDF: revision "". The base froze its first verdict for good.
    for (const status of ["passed", "flagged", "broken_connectors"]) {
      const out = sheetsNeedingAudit(
        [sheet({ sheetNumber: "025-PID-0101", revision: "" })],
        [{ sheet_number: "025-PID-0101", revision_code: "", status, coverage: covered }], FP,
      );
      expect(out, status).toHaveLength(1);
    }
  });

  it("a row is done only for the documents it covered — a sibling sheet under the same number is not (review fix pass 2)", () => {
    // SH1 and SH2 of 2002-D-2001 are separate documents, both filed under
    // the drawing's number at Rev 0. The row covered SH1 only (SH2 was still
    // indexing, `skipped`, when it was written).
    const sh1 = sheet({ documentId: "k-1", name: "SH1.pdf", sheetNumber: "2002-D-2001", revision: "0" });
    const sh2 = sheet({ documentId: "k-2", name: "SH2.pdf", sheetNumber: "2002-D-2001", revision: "0" });
    const prior = [{ sheet_number: "2002-D-2001", revision_code: "0", status: "passed", coverage: { "k-1": "fp-a" } }];
    // Both are audited again — the row's one verdict is recomputed from both.
    expect(sheetsNeedingAudit([sh1, sh2], prior, FP).map((s) => s.documentId)).toEqual(["k-1", "k-2"]);
    // Once both are covered, neither is.
    expect(sheetsNeedingAudit([sh1, sh2], [{ ...prior[0], coverage: { "k-1": "fp-a", "k-2": "fp-b" } }], FP)).toEqual([]);
  });

  it("a row is done only for the index it was computed from — a rebuild that changed it re-audits (review fix pass 2)", () => {
    const prior = [{ sheet_number: "P-1", revision_code: "C", status: "passed", coverage: { "k-1": "fp-before-rebuild" } }];
    expect(sheetsNeedingAudit([sheet({ sheetNumber: "P-1" })], prior, FP)).toHaveLength(1);
  });

  it("a row with no coverage (written before the rule, or by another writer) is audited once more", () => {
    expect(sheetsNeedingAudit([sheet({ sheetNumber: "P-1" })],
      [{ sheet_number: "P-1", revision_code: "C", status: "passed" }], FP)).toHaveLength(1);
    expect(sheetsNeedingAudit([sheet({ sheetNumber: "P-1" })],
      [{ sheet_number: "P-1", revision_code: "C", status: "passed", coverage: null }], FP)).toHaveLength(1);
  });
});

describe("indexFingerprint — what a verdict was computed from", () => {
  const rows = [{ kind: "equipment", tag: "V-1", occurrences: 2 }, { kind: "ref", tag: "025-PID-0105", occurrences: 1 }];
  it("is the same whatever order the rows came back in", () => {
    expect(indexFingerprint({ rows, opc: [] })).toBe(indexFingerprint({ rows: [...rows].reverse(), opc: [] }));
  });
  it("changes when a rebuild transcribes a connector, rewrites one, or a page goes unread", () => {
    const before = indexFingerprint({ rows, opc: [] });
    const withBox = indexFingerprint({ rows, opc: [{ tag: "15", page: 1, raw: "OPC 15: DWG NONE — TO FLARE" }] });
    expect(withBox).not.toBe(before);
    expect(indexFingerprint({ rows, opc: [{ tag: "15", page: 1, raw: "OPC 15: DWG 025-PID-0105 — TO FLARE" }] })).not.toBe(withBox);
    expect(indexFingerprint({ rows, opc: [], unreadPages: [3] })).not.toBe(before);
  });
  it("digest is stable and short", () => {
    expect(digest("abc")).toBe(digest("abc"));
    expect(digest("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(digest("abc")).not.toBe(digest("abd"));
  });
});

describe("mayReplaceStored — the latest verdict, never a lower one at a known revision", () => {
  it("a known revision's verdict is never lowered", () => {
    expect(mayReplaceStored({ revision_code: "C", status: "flagged" }, "passed")).toBe(false);
    expect(mayReplaceStored({ revision_code: "C", status: "broken_connectors" }, "skipped")).toBe(false);
    expect(mayReplaceStored({ revision_code: "C", status: "passed" }, "flagged")).toBe(true);
    expect(mayReplaceStored(null, "skipped")).toBe(true);
  });
  it("under an unknown revision the latest computation replaces the row — except a skip", () => {
    expect(mayReplaceStored({ revision_code: "", status: "flagged" }, "passed")).toBe(true);
    expect(mayReplaceStored({ revision_code: "", status: "broken_connectors" }, "passed")).toBe(true);
    expect(mayReplaceStored({ revision_code: "", status: "broken_connectors" }, "skipped")).toBe(false);
    expect(mayReplaceStored({ revision_code: "", status: "skipped" }, "skipped")).toBe(true);
  });
});

describe("unread pages keep a sheet from passing (an accepted partial index)", () => {
  it("files the pages nobody read and flags the sheet — never passed, never broken", () => {
    const [v] = verdictsForSheets([sheet()], { ...NOTHING, unreadPages: [{ sheet: "PID-44-012.pdf", pages: [5, 6] }] });
    expect(v.status).toBe("flagged");
    expect(v.details.unreadPages[0]).toMatch(/Page\(s\) 5, 6 were never read by AI vision/);
    const [clean] = verdictsForSheets([sheet()], { ...NOTHING, unreadPages: [{ sheet: "PID-44-012.pdf", pages: [] }] });
    expect(clean.status).toBe("passed");
  });
});

const SCOPE = { libraryId: "kl-1", sheets: ["PID-44-012", "PID-44-013"] };

describe("verdictRows", () => {
  it("shapes rows for the unique (org, library, sheet, revision) key — 20261124", () => {
    const [row] = verdictRows("org-1", verdictsForSheets([sheet()], NOTHING), "u-1", SCOPE);
    expect(row.org_id).toBe("org-1");
    expect(row.library_id).toBe("kl-1");
    expect(row.sheet_number).toBe("PID-44-012");
    expect(row.revision_code).toBe("C");
    expect(row.status).toBe("passed");
    expect(row.document_id).toBe("d-1");
  });

  it("keeps a null controlled document rather than inventing one", () => {
    const verdicts = verdictsForSheets([sheet({ controlledDocumentId: null })], NOTHING);
    expect(verdictRows("org-1", verdicts, "u-1", SCOPE)[0].document_id).toBeNull();
  });

  it("records who ran it, when, in which library, and what 'the set' was (DWG-6 / DWG-13)", () => {
    const [row] = verdictRows("org-1", verdictsForSheets([sheet()], NOTHING), "u-1", SCOPE, "2026-10-01T00:00:00.000Z");
    const d = row.audit_details as { by: string; libraryId: string; set: { count: number; sheets: string[]; truncated: boolean } };
    expect(d.by).toBe("u-1");
    expect(d.libraryId).toBe("kl-1");
    expect(d.set).toEqual({ count: 2, digest: digest("PID-44-012\nPID-44-013"), sheets: ["PID-44-012", "PID-44-013"], truncated: false });
    // Written every time: a re-recorded row says when it was decided.
    expect(row.audited_at).toBe("2026-10-01T00:00:00.000Z");
  });

  it("stores the set list ONCE per run: every row its count and digest, the first row the list (review fix pass 2)", () => {
    const many = Array.from({ length: 600 }, (_, i) => `S-${String(i).padStart(4, "0")}`);
    const verdicts = verdictsForSheets(many.map((n, i) => sheet({ documentId: `k-${i}`, name: `${n}.pdf`, sheetNumber: n })), NOTHING);
    const rows = verdictRows("org-1", verdicts, "u-1", { libraryId: "kl-1", sheets: many });
    type Set = { count: number; digest: string; sheets?: string[] };
    const sets = rows.map((r) => (r.audit_details as { set: Set }).set);
    expect(sets.filter((x) => x.sheets !== undefined)).toHaveLength(1);
    expect(sets[0].sheets).toHaveLength(AUDIT_SET_LIST_MAX);
    expect(new Set(sets.map((x) => `${x.count}:${x.digest}`))).toEqual(new Set([`600:${sets[0].digest}`]));
    // The request is a few hundred KB, not 600 copies of the list.
    expect(JSON.stringify(rows).length).toBeLessThan(400_000);
  });

  it("carries what each verdict covered, when the writer says", () => {
    const [v] = verdictsForSheets([sheet()], NOTHING);
    const [row] = verdictRows("org-1", [{ ...v, coverage: { "k-1": "fp-a", "k-2": "fp-b" } }], "u-1", SCOPE);
    expect((row.audit_details as { coverage: Record<string, string> }).coverage).toEqual({ "k-1": "fp-a", "k-2": "fp-b" });
    const [plain] = verdictRows("org-1", [v], "u-1", SCOPE);
    expect(plain.audit_details).not.toHaveProperty("coverage");
  });

  it("a very large set keeps its count and says when the list was cut", () => {
    const many = Array.from({ length: AUDIT_SET_LIST_MAX + 3 }, (_, i) => `S-${String(i).padStart(4, "0")}`);
    const [row] = verdictRows("org-1", verdictsForSheets([sheet()], NOTHING), "u-1", { libraryId: "kl-1", sheets: many });
    const set = (row.audit_details as { set: { count: number; sheets: string[]; truncated: boolean } }).set;
    expect(set.count).toBe(AUDIT_SET_LIST_MAX + 3);
    expect(set.sheets).toHaveLength(AUDIT_SET_LIST_MAX);
    expect(set.truncated).toBe(true);
  });
});

describe("RANK — a stored verdict is never lowered (DWG-6)", () => {
  it("orders skipped < passed < flagged < broken_connectors", () => {
    expect(RANK.skipped).toBeLessThan(RANK.passed);
    expect(RANK.passed).toBeLessThan(RANK.flagged);
    expect(RANK.flagged).toBeLessThan(RANK.broken_connectors);
  });
  it("refuses to write a less severe verdict over a stored one; an unknown stored status is never overwritten", () => {
    expect(wouldLowerSeverity("broken_connectors", "skipped")).toBe(true);
    expect(wouldLowerSeverity("flagged", "passed")).toBe(true);
    expect(wouldLowerSeverity("skipped", "passed")).toBe(false);
    expect(wouldLowerSeverity("passed", "passed")).toBe(false);
    expect(wouldLowerSeverity(null, "skipped")).toBe(false);
    expect(wouldLowerSeverity("mystery", "broken_connectors")).toBe(true);
  });
});

describe("DWG-4 — a box nobody could pair keeps a sheet from passing, never makes it broken (review fix pass 2)", () => {
  it("files the unpaired connector as a finding and the sheet as flagged", () => {
    const [v] = verdictsForSheets([sheet()], {
      ...NOTHING, unpairedConnectors: [{ from: "PID-44-012.pdf", to: "SH4.pdf", box: "14" }],
    });
    expect(v.status).toBe("flagged");
    expect(v.details.unpairedConnectors[0]).toMatch(/Connector 14 continues to SH4\.pdf, whose box numbers were never read/);
    expect(v.details.brokenConnectors).toEqual([]);
  });
});

describe("DWG-8 — an unreadable connector keeps a sheet from passing, never makes it broken", () => {
  it("files the unreadable destination as a finding and the sheet as flagged", () => {
    const [v] = verdictsForSheets([sheet()], { ...NOTHING, unreadableConnectors: [{ sheet: "PID-44-012.pdf", box: "14" }] });
    expect(v.status).toBe("flagged");
    expect(v.details.unreadableConnectors[0]).toMatch(/Connector 14: its destination could not be read/);
    expect(v.details.brokenConnectors).toEqual([]);
  });
});

describe("seriesHeldBySet — a gap is judged only in a series the library holds (DWG-6)", () => {
  const ids = (docs: Array<[string, string, string[]]>) =>
    new Map(docs.map(([id, name, self]) => [id, sheetIdentities(name, self)]));

  it("a lone mirrored sheet of a series holds nothing of it", () => {
    // "Tank Farm Reference": 025-PID-0104 alone from the 025-PID series.
    const lib = ids([
      ["a", "x.pdf", ["025-PID-0104"]],
      ["b", "y.pdf", ["040-TK-0001"]],
      ["c", "z.pdf", ["040-TK-0002"]],
    ]);
    expect(seriesHeldBySet(lib)).toEqual(["040-TK"]);
    expect(seriesNotJudged(lib)).toEqual(["025-PID"]);
  });

  it("sheets that share their series hold it; a multi-sheet drawing holds its own sheets", () => {
    const lib = ids([
      ["a", "x.pdf", ["025-PID-0104"]],
      ["b", "y.pdf", ["025-PID-0105"]],
      ["m", "set.pdf", ["2002-D-2001", "2002-D-2001-SH1", "2002-D-2001-SH2"]],
    ]);
    expect(seriesHeldBySet(lib)).toEqual(["025-PID", "2002-D-2001"]);
  });

  it("a combined PDF declaring several drawings of one series holds that series itself (fix pass)", () => {
    // 0101/0102/0103 in one file, no SHEET fields.
    const lib = ids([["c", "combined.pdf", ["025-PID-0101", "025-PID-0102", "025-PID-0103"]]]);
    expect(seriesHeldBySet(lib)).toEqual(["025-PID"]);
    expect(seriesNotJudged(lib)).toEqual([]);
  });

  it("ONE multi-sheet drawing holds its sheets, never its parent series — per-sheet PDFs or one combined PDF (review fix pass 2)", () => {
    // Tank Farm holds 025-PID-0104 — as two per-sheet PDFs, or as one PDF of
    // its three sheets — plus TF-PID-0001. Round two counted 025-PID as held
    // and filed "References 025-PID-0107, which isn't in the set".
    const perSheet = ids([
      ["s1", "0104 SH1.pdf", ["025-PID-0104", "025-PID-0104-SH1"]],
      ["s2", "0104 SH2.pdf", ["025-PID-0104", "025-PID-0104-SH2"]],
      ["tf", "TF.pdf", ["TF-PID-0001"]],
    ]);
    const combined = ids([
      ["c", "0104.pdf", ["025-PID-0104", "025-PID-0104-SH1", "025-PID-0104-SH2", "025-PID-0104-SH3"]],
      ["tf", "TF.pdf", ["TF-PID-0001"]],
    ]);
    for (const lib of [perSheet, combined]) {
      const held = seriesHeldBySet(lib);
      expect(held).toEqual(["025-PID-0104"]);
      const missing = [
        { ref: "025-PID-0107", referencedBy: ["0104 SH1.pdf"] },        // another drawing of 025-PID: not judged
        { ref: "025-PID-0107-SH1", referencedBy: ["0104 SH1.pdf"] },    // …nor one of its sheets
        { ref: "025-PID-0104-SH4", referencedBy: ["0104 SH1.pdf"] },    // a sheet of the drawing it holds: a gap
      ];
      expect(missingWithinHeldSeries(missing, held).map((m) => m.ref)).toEqual(["025-PID-0104-SH4"]);
      expect(seriesNotJudged(lib)).toEqual(["025-PID", "TF-PID"]);
    }
  });

  it("a set of single-sheet drawings holds the series, and a sheet of any of its drawings is in scope", () => {
    // The Crude Unit: each drawing one PDF declaring number and -SH1.
    const lib = ids([
      ["a", "a.pdf", ["025-PID-0104", "025-PID-0104-SH1"]],
      ["b", "b.pdf", ["025-PID-0105", "025-PID-0105-SH1"]],
    ]);
    const held = seriesHeldBySet(lib);
    expect(held).toEqual(["025-PID"]);
    const missing = [{ ref: "025-PID-0107", referencedBy: ["a.pdf"] }, { ref: "025-PID-0105-SH2", referencedBy: ["a.pdf"] }];
    expect(missingWithinHeldSeries(missing, held).map((m) => m.ref)).toEqual(["025-PID-0107", "025-PID-0105-SH2"]);
    expect(seriesNotJudged(lib)).toEqual([]);
  });

  it("a single-sheet library, and one sheet per series, hold nothing — and say what was not judged", () => {
    expect(seriesHeldBySet(ids([["a", "x.pdf", ["025-PID-0101"]]]))).toEqual([]);
    const perSeries = ids([["a", "x.pdf", ["025-PID-0101"]], ["b", "y.pdf", ["030-PID-0201"]]]);
    expect(seriesHeldBySet(perSeries)).toEqual([]);
    expect(seriesNotJudged(perSeries)).toEqual(["025-PID", "030-PID"]);
  });

  it("gaps are judged only inside a series the library holds", () => {
    const lib = ids([
      ["a", "x.pdf", ["025-PID-0104"]],             // alone in 025-PID
      ["b", "y.pdf", ["040-TK-0001"]], ["c", "z.pdf", ["040-TK-0002"]],
    ]);
    const held = seriesHeldBySet(lib);
    const missing = [
      { ref: "025-PID-0107", referencedBy: ["x.pdf"] },   // into the lone sheet's series: not a gap here
      { ref: "040-TK-0003", referencedBy: ["x.pdf"] },    // into a held series: a gap, whoever cites it
    ];
    expect(missingWithinHeldSeries(missing, held).map((m) => m.ref)).toEqual(["040-TK-0003"]);
  });
});

describe("verdictRows — the series not judged are on the record", () => {
  it("carries seriesNotJudged in the set when there are any, and nothing extra when not", () => {
    const [row] = verdictRows("org-1", verdictsForSheets([sheet()], NOTHING), "u-1", { ...SCOPE, seriesNotJudged: ["025-PID"] });
    expect((row.audit_details as { set: { seriesNotJudged?: string[] } }).set.seriesNotJudged).toEqual(["025-PID"]);
    const [plain] = verdictRows("org-1", verdictsForSheets([sheet()], NOTHING), "u-1", SCOPE);
    expect((plain.audit_details as { set: Record<string, unknown> }).set).not.toHaveProperty("seriesNotJudged");
  });
});
