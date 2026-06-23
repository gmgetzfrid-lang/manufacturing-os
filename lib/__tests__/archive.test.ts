import { describe, it, expect } from "vitest";
import { makeArchiveId, archivedNotice, findInBackup, archiveLocation } from "@/lib/archive";

describe("makeArchiveId", () => {
  it("builds a stable, sortable quarter label", () => {
    expect(makeArchiveId({ at: new Date("2026-06-23T00:00:00Z"), token: "a1b2c3" })).toBe("MOS-2026Q2-A1B2");
    expect(makeArchiveId({ at: new Date("2026-01-05T00:00:00Z"), token: "ff" })).toBe("MOS-2026Q1-FF00");
    expect(makeArchiveId({ at: new Date("2026-12-31T00:00:00Z"), token: "zzzz" })).toBe("MOS-2026Q4-ZZZZ");
  });

  it("sanitizes non-alphanumerics out of the token", () => {
    expect(makeArchiveId({ at: new Date("2026-06-01T00:00:00Z"), token: "a-b_c!" })).toBe("MOS-2026Q2-ABC0");
  });
});

describe("archiveLocation", () => {
  it("composes <root>/data/<id>.zip for space-saver exports (POSIX)", () => {
    expect(archiveLocation("/mnt/nas/mos", "space", "MOS-2026Q2-A1B2")).toBe("/mnt/nas/mos/data/MOS-2026Q2-A1B2.zip");
  });
  it("composes <root>/full-backups/<id>.zip for full backups", () => {
    expect(archiveLocation("/mnt/nas/mos", "full", "MOS-2026Q2-A1B2")).toBe("/mnt/nas/mos/full-backups/MOS-2026Q2-A1B2.zip");
  });
  it("uses backslash style + trims trailing slash for Windows UNC roots", () => {
    expect(archiveLocation("\\\\NAS\\drafting\\archives\\", "space", "X-1")).toBe("\\\\NAS\\drafting\\archives\\data\\X-1.zip");
  });
  it("falls back to a relative convention path when no root is set", () => {
    expect(archiveLocation("", "space", "X-1")).toBe("data/X-1.zip");
  });
});

describe("archivedNotice", () => {
  it("names the EXACT path (root/data/<id>.zip) to fetch", () => {
    const n = archivedNotice({ archiveId: "MOS-2026Q2-A1B2", root: "/mnt/nas/mos", fileName: "P-101 Rev C.pdf" });
    expect(n.archiveId).toBe("MOS-2026Q2-A1B2");
    expect(n.location).toBe("/mnt/nas/mos/data/MOS-2026Q2-A1B2.zip");
    expect(n.message).toContain("/mnt/nas/mos/data/MOS-2026Q2-A1B2.zip");
    expect(n.message).toContain("P-101 Rev C.pdf");
    expect(n.message.toLowerCase()).toContain("storage");
  });

  it("degrades gracefully when the archive id is unknown", () => {
    const n = archivedNotice({ archiveId: null, fileName: "x.pdf" });
    expect(n.archiveId).toBe("");
    expect(n.message.toLowerCase()).toContain("admin");
  });
});

describe("findInBackup", () => {
  const key = "orgs/ORG1/libraries/LIB1/folder/P-101__revC.pdf";

  it("matches the files/-wrapped entry exactly", () => {
    const entries = ["manifest.json", `files/${key}`, "tables/documents.json"];
    expect(findInBackup(entries, key)).toBe(`files/${key}`);
  });

  it("matches when the entry has a leading slash", () => {
    expect(findInBackup([`/files/${key}`], key)).toBe(`/files/${key}`);
  });

  it("matches a future layout that stripped the orgs/<id>/ prefix", () => {
    const stripped = "files/libraries/LIB1/folder/P-101__revC.pdf";
    expect(findInBackup([stripped], key)).toBe(stripped);
  });

  it("returns null when the file isn't in the backup", () => {
    expect(findInBackup(["files/orgs/ORG1/libraries/LIB1/other.pdf"], key)).toBeNull();
  });

  it("prefers an exact match over a suffix match", () => {
    const exact = `files/${key}`;
    const suffix = `files/something/${key}`;
    expect(findInBackup([suffix, exact], key)).toBe(exact);
  });
});
