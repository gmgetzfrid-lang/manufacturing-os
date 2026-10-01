// What gets written to a permanent audit record has to be right, because
// somebody will cite it in a turnaround meeting a year from now. The cases
// that matter: a sheet we couldn't read is never "passed", severity doesn't
// get averaged away, and a re-drawn sheet is never considered done because
// its OLD revision was checked.

import { describe, it, expect } from "vitest";
import {
  verdictsForSheets, sheetsNeedingAudit, verdictRows, RANK, wouldLowerSeverity, sheetsAloneInTheirSeries,
  AUDIT_SET_LIST_MAX,
  type AuditSheet, type AuditFindings,
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
  it("skips a sheet already audited at this revision", () => {
    const out = sheetsNeedingAudit(
      [sheet({ sheetNumber: "P-1", revision: "C" })],
      [{ sheet_number: "P-1", revision_code: "C", status: "passed" }],
    );
    expect(out).toEqual([]);
  });

  it("re-audits a sheet that has been revised since", () => {
    // The old verdict describes a drawing that no longer exists.
    const out = sheetsNeedingAudit(
      [sheet({ sheetNumber: "P-1", revision: "D" })],
      [{ sheet_number: "P-1", revision_code: "C", status: "passed" }],
    );
    expect(out).toHaveLength(1);
  });

  it("re-audits a sheet whose last verdict was 'skipped'", () => {
    // "Couldn't read it" is not "checked it".
    const out = sheetsNeedingAudit(
      [sheet({ sheetNumber: "P-1", revision: "C" })],
      [{ sheet_number: "P-1", revision_code: "C", status: "skipped" }],
    );
    expect(out).toHaveLength(1);
  });

  it("treats a broken verdict as done for this revision", () => {
    // It's recorded and open; re-running the same check doesn't help anyone.
    const out = sheetsNeedingAudit(
      [sheet({ sheetNumber: "P-1", revision: "C" })],
      [{ sheet_number: "P-1", revision_code: "C", status: "broken_connectors" }],
    );
    expect(out).toEqual([]);
  });

  it("audits everything when there's no history", () => {
    expect(sheetsNeedingAudit([sheet(), sheet({ sheetNumber: "P-2" })], [])).toHaveLength(2);
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
    expect(d.set).toEqual({ count: 2, sheets: ["PID-44-012", "PID-44-013"], truncated: false });
    // Written every time: a re-recorded row says when it was decided.
    expect(row.audited_at).toBe("2026-10-01T00:00:00.000Z");
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

describe("DWG-8 — an unreadable connector keeps a sheet from passing, never makes it broken", () => {
  it("files the unreadable destination as a finding and the sheet as flagged", () => {
    const [v] = verdictsForSheets([sheet()], { ...NOTHING, unreadableConnectors: [{ sheet: "PID-44-012.pdf", box: "14" }] });
    expect(v.status).toBe("flagged");
    expect(v.details.unreadableConnectors[0]).toMatch(/Connector 14: its destination could not be read/);
    expect(v.details.brokenConnectors).toEqual([]);
  });
});

describe("sheetsAloneInTheirSeries — a verdict needs the set it judges (DWG-6)", () => {
  const ids = (docs: Array<[string, string, string[]]>) =>
    new Map(docs.map(([id, name, self]) => [id, sheetIdentities(name, self)]));

  it("a lone mirrored sheet of a series the library does not hold is not recorded", () => {
    // "Tank Farm Reference": 025-PID-0104 alone from the 025-PID series.
    const alone = sheetsAloneInTheirSeries(ids([
      ["a", "x.pdf", ["025-PID-0104"]],
      ["b", "y.pdf", ["040-TK-0001"]],
      ["c", "z.pdf", ["040-TK-0002"]],
    ]));
    expect([...alone]).toEqual(["a"]);
  });

  it("sheets that share their series are recorded; a multi-sheet document is a series on its own", () => {
    const alone = sheetsAloneInTheirSeries(ids([
      ["a", "x.pdf", ["025-PID-0104"]],
      ["b", "y.pdf", ["025-PID-0105"]],
      ["m", "set.pdf", ["2002-D-2001", "2002-D-2001-SH1", "2002-D-2001-SH2"]],
    ]));
    expect(alone.size).toBe(0);
  });

  it("separate sheet documents of one drawing share its series", () => {
    const alone = sheetsAloneInTheirSeries(ids([
      ["s1", "a.pdf", ["2002-D-2001", "2002-D-2001-SH1"]],
      ["s2", "b.pdf", ["2002-D-2001", "2002-D-2001-SH2"]],
    ]));
    expect(alone.size).toBe(0);
  });
});
