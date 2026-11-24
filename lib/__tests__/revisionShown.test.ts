import { describe, it, expect } from "vitest";
import { shownRevision, isGuessedFromWord, uploadedName } from "@/lib/revisionShown";
import { parseFilename } from "@/lib/filenameParser";

describe("the revision shown for a document", () => {
  it("1-Emergency Planning and Response ERP.docx has no revision, not Rev esponse", () => {
    const file = "1-Emergency Planning and Response ERP.docx";
    // What the old reader stored, and no revision at all: neither is shown.
    expect(shownRevision("esponse", file)).toBeNull();
    expect(shownRevision(null, file)).toBeNull();
    expect(shownRevision("", file)).toBeNull();
    expect(isGuessedFromWord("esponse", file)).toBe(true);
    // Today's reader finds no revision in that name ("0" is the upload default).
    expect(parseFilename(file).rev).toBe("0");
  });

  it("drops other words the old reader cut a revision out of", () => {
    expect(shownRevision("elief", "EP 5-3-10 - Relief Valve.pdf")).toBeNull();
    expect(shownRevision("ELIEF", "EP 5-3-10 - Relief Valve.pdf")).toBeNull();
  });

  it("keeps real revisions, from the name or typed by a person", () => {
    expect(shownRevision("7", "100-PID-001_R7.pdf")).toBe("7");
    expect(shownRevision("A", "200-ISO-014_RevA.pdf")).toBe("A");
    expect(shownRevision("38", "2002-D-2001_SHT01_R38.pdf")).toBe("38");
    // Someone typed C on a document whose name has a word starting with r.
    expect(shownRevision("C", "1-Emergency Planning and Response ERP.docx")).toBe("C");
    expect(shownRevision("0", "1-Emergency Planning and Response ERP.docx")).toBe("0");
    expect(shownRevision("B", undefined)).toBe("B");
  });

  it("reads the name the file was uploaded as", () => {
    expect(uploadedName({ name: "x.pdf", metadata: { original_name: "Orig Response.docx" } })).toBe("Orig Response.docx");
    expect(uploadedName({ name: "x.pdf", metadata: null })).toBe("x.pdf");
    expect(uploadedName(null)).toBe("");
  });
});
