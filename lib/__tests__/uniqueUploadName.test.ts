// PKG-3: every document-creation storage key must carry a per-upload unique
// component. Two same-named uploads into one library folder used to collapse
// to ONE R2 object (a PUT overwrites), while both document rows survived —
// the older document then served the newer drawing's bytes under its own
// title block, invisibly (the doc-number auto-rename hid the collision).

import { describe, it, expect, vi, afterEach } from "vitest";
import { uniqueUploadName } from "@/lib/storage";

afterEach(() => vi.restoreAllMocks());

describe("uniqueUploadName (PKG-3)", () => {
  it("two same-named uploads produce DISTINCT storage names", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
    const a = uniqueUploadName("P-101.pdf", "0");
    const b = uniqueUploadName("P-101.pdf", "0");
    expect(a).not.toBe(b);
  });

  it("keeps the stem, the rev, and the extension", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_755_000_000_000);
    expect(uniqueUploadName("P-101.pdf", "3A")).toBe("P-101__rev3A__1755000000000.pdf");
  });

  it("sanitizes a hostile rev label and defaults a missing one to 0", () => {
    vi.spyOn(Date, "now").mockReturnValue(5);
    expect(uniqueUploadName("iso.dwg", "3 / A")).toBe("iso__rev3_A__5.dwg");
    expect(uniqueUploadName("iso.dwg")).toBe("iso__rev0__5.dwg");
    expect(uniqueUploadName("iso.dwg", "   ")).toBe("iso__rev0__5.dwg");
  });

  it("tolerates missing names and extensionless files", () => {
    vi.spyOn(Date, "now").mockReturnValue(7);
    expect(uniqueUploadName("", "0")).toBe("drawing__rev0__7.pdf");
    expect(uniqueUploadName("scan", "1")).toBe("scan__rev1__7.pdf");
  });
});
