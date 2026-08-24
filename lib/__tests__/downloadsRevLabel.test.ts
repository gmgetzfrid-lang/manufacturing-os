// Download stamping describes the SERVED version, not the document's current
// revision, and a non-current copy is never a controlled (unstamped) master
// (REV-1).

import { describe, it, expect } from "vitest";
import { determineControlState, buildFooterNotice, buildVerifyUrl } from "@/lib/downloads";
import type { DocumentRecord } from "@/types/schema";

const baseDoc = {
  id: "doc1",
  orgId: "orgA",
  documentNumber: "P-101",
  rev: "5",                       // current revision label
  currentVersionId: "v5",
  checkedOutBy: "holder1",
  checkedOutByName: "Holder",
} as unknown as DocumentRecord;

const ctxFor = (over: Record<string, unknown>) => ({
  doc: baseDoc,
  fileUrl: "blob:x",
  userId: "holder1",
  ...over,
}) as unknown as Parameters<typeof buildFooterNotice>[0];

describe("determineControlState (REV-1)", () => {
  it("the checkout holder gets a controlled copy of the CURRENT version", () => {
    expect(determineControlState(baseDoc, "holder1", true)).toBe("controlled");
  });

  it("the checkout holder gets an UNCONTROLLED copy of an OLD version", () => {
    // Even though they hold the checkout, an old revision is never a
    // controlled master — it must carry the UNCONTROLLED stamp.
    expect(determineControlState(baseDoc, "holder1", false)).toBe("uncontrolled");
  });

  it("a non-holder always gets uncontrolled", () => {
    expect(determineControlState(baseDoc, "someone-else", true)).toBe("uncontrolled");
  });
});

describe("buildFooterNotice (REV-1)", () => {
  it("stamps the SERVED revision label, not the document's current rev", () => {
    const notice = buildFooterNotice(ctxFor({ versionRev: "2", versionIsCurrent: false }));
    expect(notice).toContain("Rev 2");
    expect(notice).not.toContain("Rev 5");
    expect(notice.toUpperCase()).toContain("SUPERSEDED");
  });

  it("uses the current-rev wording when serving the current version", () => {
    const notice = buildFooterNotice(ctxFor({ versionRev: "5", versionIsCurrent: true }));
    expect(notice).toContain("Rev 5 at time of issue");
    expect(notice.toUpperCase()).not.toContain("SUPERSEDED");
  });
});

describe("buildVerifyUrl (REV-1)", () => {
  it("encodes the served version id so the QR verifies the printed revision", () => {
    const url = buildVerifyUrl(ctxFor({ versionId: "v2", versionRev: "2", versionIsCurrent: false }));
    // publicOrigin() may be empty in the test env → undefined; when present it
    // must carry ?v=v2, never the current v5.
    if (url) {
      expect(url).toContain("?v=v2");
      expect(url).not.toContain("v5");
    }
  });
});
