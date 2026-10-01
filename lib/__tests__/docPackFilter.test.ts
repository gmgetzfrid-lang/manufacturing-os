// Field-pack inclusion rules (PKG-4).
//
// The doc pack is the highest-consequence egress surface: a Draft, a
// Superseded sheet, or a document under an active hold riding into the merged
// PDF *looks exactly like* an in-force controlled revision to the crew in the
// field. filterPackDocs is the pure gate in front of the merge — these tests
// pin its refusal rules, including the fail-closed posture when the hold read
// itself errors.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/stamping", () => ({ applyStampToPdfDoc: vi.fn() }));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn() }));
vi.mock("@/lib/publicOrigin", () => ({ publicOrigin: () => "" }));
vi.mock("pdf-lib", () => ({ PDFDocument: class {} }));

import { filterPackDocs } from "@/lib/docPack";

const doc = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "d1",
  document_number: "P-101",
  status: "Issued",
  ...over,
});

const none = new Set<string>();

describe("filterPackDocs (PKG-4)", () => {
  it("passes Issued and Locked documents through", () => {
    const { docs, skipped } = filterPackDocs(
      [doc({ id: "a", status: "Issued" }), doc({ id: "b", status: "Locked" })],
      none,
      false,
    );
    expect(docs.map((d) => d.id)).toEqual(["a", "b"]);
    expect(skipped).toEqual([]);
  });

  it.each(["Draft", "Superseded", "Void", "Archived"])(
    "refuses a %s document with the status named in the reason",
    (status) => {
      const { docs, skipped } = filterPackDocs([doc({ status })], none, false);
      expect(docs).toEqual([]);
      expect(skipped).toHaveLength(1);
      expect(skipped[0].reason).toContain(status.toLowerCase());
      expect(skipped[0].reason).toContain("not an in-force controlled revision");
    },
  );

  // VFY-17 (document-control Round F, P8): the gate is the verify allow-list
  // — a legacy row with no status used to print here and then scan red
  // ("not issued") the minute it reached the field.
  it("refuses a legacy row with no status at all (VFY-17 — the verify allow-list reads it not_issued)", () => {
    const { docs, skipped } = filterPackDocs(
      [doc({ status: "" }), doc({ id: "d2", status: undefined }), doc({ id: "d3", status: null })],
      none,
      false,
    );
    expect(docs).toHaveLength(0);
    expect(skipped).toHaveLength(3);
    for (const s of skipped) {
      expect(s.reason).toBe("no status — not an issued, controlled revision");
      expect(s.code).toBe("not_issued");
    }
  });

  it("refuses a document under an active hold, telling the crew to stop", () => {
    const { docs, skipped } = filterPackDocs(
      [doc({ id: "held" }), doc({ id: "clear" })],
      new Set(["held"]),
      false,
    );
    expect(docs.map((d) => d.id)).toEqual(["clear"]);
    expect(skipped).toEqual([
      { documentId: "held", label: "P-101", reason: "under an active hold — work from this document should stop", code: "on_hold" },
    ]);
  });

  it("fails CLOSED when the hold read errored — every sheet is refused", () => {
    const { docs, skipped } = filterPackDocs(
      [doc({ id: "a" }), doc({ id: "b" })],
      none,
      true,
    );
    expect(docs).toEqual([]);
    expect(skipped.every((s) => s.reason === "hold status could not be verified")).toBe(true);
    expect(skipped).toHaveLength(2);
  });

  it("reports the status refusal, not the hold, when both apply", () => {
    const { skipped } = filterPackDocs(
      [doc({ id: "x", status: "Superseded" })],
      new Set(["x"]),
      true,
    );
    expect(skipped[0].reason).toContain("superseded");
  });

  it("labels a skipped row by document_number, then title, then name", () => {
    const { skipped } = filterPackDocs(
      [
        doc({ document_number: "", title: "Relief header iso", status: "Void" }),
        doc({ document_number: "", title: "", name: "file.pdf", status: "Void" }),
        doc({ document_number: "", title: "", name: "", status: "Void" }),
      ],
      none,
      false,
    );
    expect(skipped.map((s) => s.label)).toEqual(["Relief header iso", "file.pdf", "Document"]);
  });
});
