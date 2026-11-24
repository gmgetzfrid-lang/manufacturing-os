import { describe, it, expect } from "vitest";
import { previewKind, fileTypeName, sizeWords, extensionOf } from "@/lib/filePreview";

describe("which files preview in place", () => {
  it("never previews a Word document, so opening its panel can't start a download", () => {
    const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(previewKind({ fileName: "1-Emergency Planning and Response ERP.docx", mime })).toBe("none");
    expect(previewKind({ fileName: "1-Emergency Planning and Response ERP.docx" })).toBe("none");
    expect(previewKind({ path: "org/lib/1-Emergency Planning and Response ERP.docx", mime: "application/octet-stream" })).toBe("none");
  });
  it("previews PDFs and pictures", () => {
    expect(previewKind({ fileName: "P-101.pdf", mime: "application/pdf" })).toBe("pdf");
    expect(previewKind({ fileName: "P-101.PDF" })).toBe("pdf");
    expect(previewKind({ path: "a/b/P-101.pdf?x=1", mime: "application/octet-stream" })).toBe("pdf");
    expect(previewKind({ fileName: "photo.jpg", mime: "image/jpeg" })).toBe("image");
    expect(previewKind({ fileName: "photo.png" })).toBe("image");
  });
  it("trusts a specific stored type over the extension", () => {
    expect(previewKind({ fileName: "renamed.pdf", mime: "application/msword" })).toBe("none");
    expect(previewKind({ fileName: "drawing.dwg", mime: "image/vnd.dwg" })).toBe("none");
  });
  it("names the file type and size plainly", () => {
    expect(fileTypeName({ fileName: "a.docx" })).toBe("Word document (.docx)");
    expect(fileTypeName({ fileName: "a.dwg" })).toBe("AutoCAD drawing (.dwg)");
    expect(fileTypeName({ fileName: "a.xyz" })).toBe("XYZ file");
    expect(fileTypeName({ fileName: "noext" })).toBe("File");
    expect(sizeWords(48_213)).toBe("47 KB");
    expect(sizeWords(2_500_000)).toBe("2.4 MB");
    expect(sizeWords(undefined)).toBe("");
    expect(extensionOf("a/b/c.Tar.GZ")).toBe("gz");
  });
});
