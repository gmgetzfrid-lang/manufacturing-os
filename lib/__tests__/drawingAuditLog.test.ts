// What gets written to a permanent audit record has to be right, because
// somebody will cite it in a turnaround meeting a year from now. The cases
// that matter: a sheet we couldn't read is never "passed", severity doesn't
// get averaged away, and a re-drawn sheet is never considered done because
// its OLD revision was checked.

import { describe, it, expect } from "vitest";
import {
  verdictsForSheets, sheetsNeedingAudit, verdictRows,
  type AuditSheet, type AuditFindings,
} from "@/lib/drawingAuditLog";

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

describe("verdictRows", () => {
  it("shapes rows for the unique (org, sheet, revision) key", () => {
    const [row] = verdictRows("org-1", verdictsForSheets([sheet()], NOTHING), "u-1");
    expect(row.org_id).toBe("org-1");
    expect(row.sheet_number).toBe("PID-44-012");
    expect(row.revision_code).toBe("C");
    expect(row.status).toBe("passed");
    expect(row.document_id).toBe("d-1");
  });

  it("keeps a null controlled document rather than inventing one", () => {
    const verdicts = verdictsForSheets([sheet({ controlledDocumentId: null })], NOTHING);
    expect(verdictRows("org-1", verdicts, "u-1")[0].document_id).toBeNull();
  });

  it("records who ran it", () => {
    const [row] = verdictRows("org-1", verdictsForSheets([sheet()], NOTHING), "u-1");
    expect((row.audit_details as { by: string }).by).toBe("u-1");
  });
});
