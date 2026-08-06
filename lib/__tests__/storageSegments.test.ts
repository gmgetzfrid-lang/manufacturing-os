// A storage total nobody can break down is a storage total nobody believes.
// These pin the two places the numbers used to quietly lie: which bucket of
// bytes a key belongs to, and attachment sizes stored as display strings.

import { describe, it, expect } from "vitest";
import { segmentForKey } from "../storageUsage";
import { attachmentSizeBytes, ticketAttachmentBytes } from "../ticketShed";

describe("segmentForKey", () => {
  it("names each feature's files from its real key layout", () => {
    expect(segmentForKey("orgs/o1/libraries/l1/PID-001__rev2__1.pdf"))
      .toBe("Controlled document revisions");
    expect(segmentForKey("orgs/o1/knowledge/lib-2/1738-crude-pid.pdf"))
      .toBe("Knowledge library files");
    expect(segmentForKey("orgs/o1/assets/a1/photos/1738-pump.jpg")).toBe("Asset photos");
    expect(segmentForKey("orgs/o1/plot-plans/uuid-map.png")).toBe("Plot plans");
    expect(segmentForKey("orgs/o1/output-templates/1738-form.docx")).toBe("Output templates");
    expect(segmentForKey("orgs/o1/output-examples/1738-done.docx")).toBe("Output templates");
    expect(segmentForKey("orgs/o1/project-intake/pkg.zip")).toBe("Project intake uploads");
    expect(segmentForKey("orgs/o1/branding/logo.png")).toBe("Branding & logos");
  });

  it("handles root-level prefixes", () => {
    expect(segmentForKey("avatars/u1/avatar-x.png")).toBe("Avatars");
    expect(segmentForKey("data/archive-1.zip")).toBe("Offline archives");
    expect(segmentForKey("exports/run-9.zip")).toBe("Export artifacts");
  });

  // Unrecognized bytes are the ones worth seeing — folding them into a mute
  // "other" is how an unexplained bucket of storage stays unexplained.
  it("surfaces unknown prefixes by name rather than hiding them", () => {
    expect(segmentForKey("orgs/o1/mystery/file.bin")).toBe("Other — mystery/");
    expect(segmentForKey("stray-file.bin")).toBe("Other — stray-file.bin/");
    expect(segmentForKey("")).toBe("Other — bucket root");
  });
});

describe("attachmentSizeBytes", () => {
  it("reads the formatted strings tickets actually store", () => {
    expect(attachmentSizeBytes("1.23 MB")).toBe(Math.round(1.23 * 1024 ** 2));
    expect(attachmentSizeBytes("500 KB")).toBe(500 * 1024);
    expect(attachmentSizeBytes("2GB")).toBe(2 * 1024 ** 3);
    expect(attachmentSizeBytes("847 B")).toBe(847);
    expect(attachmentSizeBytes("12")).toBe(12);
  });

  it("keeps numeric sizes as-is and rejects junk", () => {
    expect(attachmentSizeBytes(4096)).toBe(4096);
    expect(attachmentSizeBytes(0)).toBe(0);
    expect(attachmentSizeBytes(-5)).toBe(0);
    expect(attachmentSizeBytes("unknown")).toBe(0);
    expect(attachmentSizeBytes(null)).toBe(0);
    expect(attachmentSizeBytes(undefined)).toBe(0);
  });

  it("sums a ticket's attachments — the case that used to total zero", () => {
    expect(ticketAttachmentBytes([
      { size: "1 MB" }, { size: "512 KB" }, { size: 1024 },
    ] as Array<{ size: unknown }> as never)).toBe(1024 ** 2 + 512 * 1024 + 1024);
  });
});
