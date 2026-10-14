import { describe, it, expect } from "vitest";
import { classifyAttachment, ATTACHMENT_LIMITS } from "@/lib/chatClient";
import { relativeTime } from "@/components/chat/shared";

const file = (name: string, type: string, size: number) =>
  ({ name, type, size } as unknown as File);

describe("classifyAttachment", () => {
  it("accepts images and PDFs within their limits", () => {
    expect(classifyAttachment(file("nameplate.jpg", "image/jpeg", 1024))).toEqual({ kind: "image" });
    expect(classifyAttachment(file("spec.pdf", "application/pdf", 1024))).toEqual({ kind: "pdf" });
    // A PDF with no browser-reported type still classifies by extension.
    expect(classifyAttachment(file("spec.PDF", "", 1024))).toEqual({ kind: "pdf" });
  });

  it("rejects oversized files with a reason naming the file", () => {
    const big = classifyAttachment(file("huge.png", "image/png", ATTACHMENT_LIMITS.imageBytes + 1));
    expect("error" in big && big.error).toMatch(/huge\.png/);
    const bigPdf = classifyAttachment(file("book.pdf", "application/pdf", ATTACHMENT_LIMITS.pdfBytes + 1));
    expect("error" in bigPdf && bigPdf.error).toMatch(/book\.pdf/);
  });

  it("rejects anything that is not an image or a PDF", () => {
    const r = classifyAttachment(file("model.step", "application/octet-stream", 10));
    expect("error" in r && r.error).toMatch(/image .* or a PDF/);
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 9, 14, 12, 0, 0);
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  it("reads like a rail timestamp", () => {
    expect(relativeTime(at(10_000), now)).toBe("now");
    expect(relativeTime(at(5 * 60_000), now)).toBe("5m");
    expect(relativeTime(at(3 * 3_600_000), now)).toBe("3h");
    // Within a week: a weekday name; beyond: month + day.
    expect(relativeTime(at(2 * 86_400_000), now)).toMatch(/^[A-Z][a-z]{2}$/);
    expect(relativeTime(at(30 * 86_400_000), now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});
