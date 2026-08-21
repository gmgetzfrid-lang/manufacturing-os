import { describe, expect, it } from "vitest";
import {
  buildFolderPlan,
  filesFromDirectoryInput,
  isJunkFile,
  FolderUploadLimitError,
  MAX_FOLDER_UPLOAD_FILES,
  type PathedFile,
} from "@/lib/folderUpload";

const pf = (name: string, relPath: string[]): PathedFile =>
  ({ file: { name } as File, relPath });

describe("isJunkFile", () => {
  it("filters OS metadata noise", () => {
    expect(isJunkFile(".DS_Store")).toBe(true);
    expect(isJunkFile("Thumbs.db")).toBe(true);
    expect(isJunkFile("desktop.ini")).toBe(true);
    expect(isJunkFile("._resource-fork.pdf")).toBe(true);
    expect(isJunkFile("P-101.pdf")).toBe(false);
  });
});

describe("filesFromDirectoryInput", () => {
  it("recreates the picked folder itself and strips filenames", () => {
    const out = filesFromDirectoryInput([
      { name: "a.pdf", webkitRelativePath: "Drawings/a.pdf" },
      { name: "b.pdf", webkitRelativePath: "Drawings/PIDs/Crude/b.pdf" },
    ]);
    expect(out[0].relPath).toEqual(["Drawings"]);
    expect(out[1].relPath).toEqual(["Drawings", "PIDs", "Crude"]);
  });

  it("drops junk and tolerates a missing webkitRelativePath", () => {
    const out = filesFromDirectoryInput([
      { name: ".DS_Store", webkitRelativePath: "Drawings/.DS_Store" },
      { name: "loose.pdf" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].relPath).toEqual([]);
  });

  it("throws loudly past the file cap", () => {
    const many = Array.from({ length: MAX_FOLDER_UPLOAD_FILES + 1 }, (_, i) => ({
      name: `f${i}.pdf`, webkitRelativePath: `Root/f${i}.pdf`,
    }));
    expect(() => filesFromDirectoryInput(many)).toThrow(FolderUploadLimitError);
  });
});

describe("buildFolderPlan", () => {
  it("emits every distinct folder, parents strictly before children", () => {
    const plan = buildFolderPlan([
      pf("x.pdf", ["Drawings", "PIDs", "Crude"]),
      pf("y.pdf", ["Drawings", "PFDs"]),
      pf("z.pdf", ["Drawings"]),
    ]);
    const keys = plan.folders.map((f) => f.key);
    expect(keys).toEqual(["drawings", "drawings/pfds", "drawings/pids", "drawings/pids/crude"]);
    expect(plan.folders[0].parentKey).toBeNull();
    expect(plan.folders.find((f) => f.key === "drawings/pids/crude")?.parentKey).toBe("drawings/pids");
  });

  it("dedupes case-insensitively but keeps first-seen display casing", () => {
    const plan = buildFolderPlan([
      pf("a.pdf", ["Crude Unit"]),
      pf("b.pdf", ["crude unit", "PIDs"]),
    ]);
    expect(plan.folders).toHaveLength(2);
    expect(plan.folders[0].name).toBe("Crude Unit");
  });

  it("maps each file to its deepest folder; root files map to null", () => {
    const inFolder = pf("a.pdf", ["Drawings", "PIDs"]);
    const atRoot = pf("b.pdf", []);
    const plan = buildFolderPlan([inFolder, atRoot]);
    expect(plan.keyForFile(inFolder)).toBe("drawings/pids");
    expect(plan.keyForFile(atRoot)).toBeNull();
  });

  it("intermediate folders exist even when only deep files were dropped", () => {
    const plan = buildFolderPlan([pf("a.pdf", ["A", "B", "C"])]);
    expect(plan.folders.map((f) => f.key)).toEqual(["a", "a/b", "a/b/c"]);
  });
});
