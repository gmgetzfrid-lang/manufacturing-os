// Tests for the output-template decision layer: what a template needs,
// how spreadsheet columns map to it, and what the generated files are named.

import { describe, it, expect } from "vitest";
import {
  findPlaceholders, proposePlaceholders, normalizeHeader, autoMapColumns,
  missingRequirements, renderFilename, uniqueFilenames, cellToText,
  type Placeholder,
} from "../outputTemplateText";

describe("findPlaceholders", () => {
  it("separates fill fields from loop/section tags", () => {
    const found = findPlaceholders(
      "Project {project_name} for {client}. {#work_items}{item_no} {desc}{/work_items} {^none}None{/none}",
    );
    expect(found.fields.sort()).toEqual(["client", "desc", "item_no", "project_name"]);
    expect(found.loops.sort()).toEqual(["none", "work_items"]);
  });

  it("tolerates spacing and ignores numeric noise", () => {
    const found = findPlaceholders("{ unit } and {3} and {rev_no}");
    expect(found.fields.sort()).toEqual(["rev_no", "unit"]);
  });

  it("returns nothing for a template with no tags", () => {
    expect(findPlaceholders("Plain document with no placeholders.")).toEqual({ fields: [], loops: [] });
  });
});

describe("proposePlaceholders", () => {
  it("guesses AI-drafted prose vs mapped data by tag name", () => {
    const props = proposePlaceholders(["scope_description", "wo_number", "unit"]);
    const byTag = Object.fromEntries(props.map((p) => [p.tag, p]));
    expect(byTag.scope_description.kind).toBe("ai");
    expect(byTag.scope_description.guidance).toBeTruthy();
    expect(byTag.wo_number.kind).toBe("data");
    expect(byTag.unit.kind).toBe("data");
  });

  it("humanizes labels", () => {
    expect(proposePlaceholders(["wo_number"])[0].label).toBe("Wo number");
    expect(proposePlaceholders(["projectName"])[0].label).toBe("Project name");
  });
});

describe("normalizeHeader / autoMapColumns", () => {
  it("matches headers regardless of case, spaces, and punctuation", () => {
    expect(normalizeHeader("WO Number")).toBe(normalizeHeader("wo_number"));
    expect(normalizeHeader("Work-Order #")).toBe("workorder");
  });

  it("maps exact matches first, then containment", () => {
    const map = autoMapColumns(
      ["wo_number", "unit", "scope_description"],
      ["WO Number", "Unit", "Description of Scope"],
    );
    expect(map.wo_number).toBe("WO Number");
    expect(map.unit).toBe("Unit");
    // "scope_description" has no exact match; containment finds nothing
    // sensible here, which is correct — the user maps it explicitly.
    expect(map.scope_description).toBeUndefined();
  });
});

describe("missingRequirements", () => {
  const ph: Placeholder[] = [
    { tag: "wo_number", label: "WO", kind: "data", required: true },
    { tag: "completion_date", label: "Completion", kind: "data", required: true },
    { tag: "scope_description", label: "Scope", kind: "ai", required: true },
    { tag: "company", label: "Company", kind: "static", value: "", required: true },
  ];

  it("reports only data tags with no usable column, plus empty statics", () => {
    const missing = missingRequirements(ph, { wo_number: "WO Number" }, ["WO Number"]);
    expect(missing.map((m) => m.tag).sort()).toEqual(["company", "completion_date"]);
  });

  it("never reports AI-drafted fields as missing", () => {
    const missing = missingRequirements(
      ph.filter((p) => p.kind === "ai"), {}, [],
    );
    expect(missing).toEqual([]);
  });
});

describe("renderFilename", () => {
  it("substitutes tags and appends the extension", () => {
    expect(renderFilename("SOW-{wo}", { wo: "12345" }, "document", "docx"))
      .toBe("SOW-12345.docx");
  });

  it("strips filesystem-hostile characters", () => {
    // Illegal runs collapse to a single dash and trailing dashes are trimmed.
    expect(renderFilename("{a}", { a: 'x/y\\z:*?"<>|' }, "doc", "docx")).toBe("x-y-z.docx");
  });

  it("falls back when the pattern resolves to nothing", () => {
    expect(renderFilename("{missing}", {}, "scope", "docx", 2)).toBe("scope-3.docx");
    expect(renderFilename(null, {}, "scope", "docx")).toBe("scope.docx");
  });
});

describe("uniqueFilenames", () => {
  it("suffixes duplicates so no file is lost in a zip", () => {
    expect(uniqueFilenames(["a.docx", "a.docx", "b.docx", "A.docx"]))
      .toEqual(["a.docx", "a (2).docx", "b.docx", "A (3).docx"]);
  });
});

describe("cellToText", () => {
  it("formats dates, numbers, booleans, and blanks predictably", () => {
    expect(cellToText(new Date("2026-03-04T12:00:00Z"))).toBe("2026-03-04");
    expect(cellToText(42)).toBe("42");
    expect(cellToText(3.14159)).toBe("3.142");
    expect(cellToText(true)).toBe("Yes");
    expect(cellToText(null)).toBe("");
    expect(cellToText(undefined)).toBe("");
    expect(cellToText("  spaced  ")).toBe("spaced");
  });
});
