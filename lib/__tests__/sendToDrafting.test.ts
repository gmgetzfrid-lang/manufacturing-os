import { describe, expect, it } from "vitest";
import { draftingRequestText } from "@/lib/sendToDrafting";
import type { DocumentRecord } from "@/types/schema";

const doc = (n: string, extra: Partial<DocumentRecord> = {}) =>
  ({ id: n, documentNumber: n, title: `Title ${n}`, rev: "3", libraryId: "L", metadata: { unit: "200" }, ...extra }) as unknown as DocumentRecord;

describe("draftingRequestText", () => {
  it("all marked up: the markups request, as before", () => {
    const t = draftingRequestText([{ doc: doc("P-1"), markedUp: true }, { doc: doc("P-2"), markedUp: true }]);
    expect(t.title).toBe("Markups: 2 sheets · Unit 200");
    expect(t.description).toContain("Marked-up sheets, attached as Source files:");
    expect(t.description).toContain("• P-1 Rev 3 - Title P-1");
    expect(t.unit).toBe("200");
  });

  it("some marked up: says which", () => {
    const t = draftingRequestText([{ doc: doc("P-1"), markedUp: true }, { doc: doc("P-2"), markedUp: false }]);
    expect(t.title).toBe("Markups: 2 sheets, 1 marked up · Unit 200");
    expect(t.description).toContain("Sheets attached as Source files, 1 marked up:");
    expect(t.description).toContain("• P-1 Rev 3 - Title P-1 (marked up)");
    expect(t.description).toContain("• P-2 Rev 3 - Title P-2\n");
  });

  it("none marked up, units differ, a file not read", () => {
    const t = draftingRequestText(
      [{ doc: doc("P-1"), markedUp: false }, { doc: doc("P-2", { metadata: { unit: "300" } }), markedUp: false }],
      [doc("P-9")],
    );
    expect(t.title).toBe("2 sheets for drafting");
    expect(t.unit).toBe("");
    expect(t.description).toContain("Not attached, the file could not be read: P-9 Rev 3");
    expect(t.description).not.toMatch(/\u2014/);
  });
});
