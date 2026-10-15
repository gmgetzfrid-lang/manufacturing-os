import { describe, it, expect } from "vitest";
import { explainThor } from "@/lib/thor/explain";
import { parseThorQuery } from "@/lib/thor/query";
import { thorOpenUrl, handlerScript, installerCmd } from "@/lib/thor/opener";
import type { ThorFile, ThorVocabulary } from "@/lib/thor/client";

const UNITS = [{ code: "2000", folder: "2000 - CRUDE UNIT" }];
const VOCAB: ThorVocabulary = {
  units: [{ code: "2000", folder: "2000 - CRUDE UNIT", files: 25041 }],
  categories: [],
  equipment: [{ number: "2010.03", unit: "2000", tags: ["V-3"], description: "V-3 PREFRACTIONATOR TOWER", files: 1673 }],
};
const FILE: ThorFile = {
  file_id: "f1", root_id: "r", unc_path: "\\\\thor\\Equipment Files\\x.dwg", rel_path: "x", filename: "MN DRAW TRAY UT DRAWING.dwg",
  folder_rel: "2000 - CRUDE UNIT/10 - VESSELS/2010.03 (CS) V-3 PREFRACTIONATOR TOWER/INSPECTIONS/2023-04-25 MN DRAW TRAY UT",
  ext: "dwg", size_bytes: 1, modified_at: null, unit_folder: "2000 - CRUDE UNIT", unit_code: "2000", category_folder: "10 - VESSELS",
  folder_role: "inspection", equipment_numbers: ["2010.03"], observation_state: "current", rank: 0.9, strength: 2,
  matched_terms: ["tower:equipment", "tray:name", "drawing:name", "prefrac:equipment"],
};

describe("explainThor", () => {
  const q = parseThorQuery("prefrac drawings to the crude tower im looking for tray drawings", UNITS);
  it("says, per word, where it hit — file name first — and what was required", () => {
    const r = explainThor(FILE, q, VOCAB, null);
    expect(r.map((x) => x.text)).toEqual([
      '"tray" in the file name',
      '"drawing" in the file name',
      '"tower" — equipment 2010.03 V-3 PREFRACTIONATOR TOWER',
      '"prefrac" — equipment 2010.03 V-3 PREFRACTIONATOR TOWER',
      "in Crude Unit",
    ]);
  });
  it("names the folder a word came from, flags what is missing and backup copies", () => {
    const r = explainThor({ ...FILE, ext: "bak", matched_terms: ["tray:folder"] }, q, VOCAB, null);
    expect(r[0].text).toBe('"tray" — folder 2023-04-25 MN DRAW TRAY UT');
    expect(r.filter((x) => x.where === "missing").map((x) => x.word)).toEqual(["prefrac", "drawing", "tower"]);
    expect(r.at(-1)?.where).toBe("backup");
  });
});

describe("opener", () => {
  it("links carry the path relative to THOR, encoded", () => {
    expect(thorOpenUrl("open", "2000 - CRUDE UNIT/a b&c.pdf")).toBe("thor-open:open?p=2000%20-%20CRUDE%20UNIT%2Fa%20b%26c.pdf");
  });
  it("the handler is pinned to the org's THOR root and refuses escapes", () => {
    const ps = handlerScript("\\\\thor\\Equipment Files");
    expect(ps).toContain("$root = '\\\\thor\\Equipment Files'");
    expect(ps).toContain("GetFullPath");
    expect(ps).toContain("StartsWith($root + '\\'");
    expect(ps).toMatch(/\$rel -match '\(\^\|\[\\\\\/\]\)\\\.\\\.\(\[\\\\\/\]\|\$\)'/);
    // Programs are never started: only document types open, everything else is shown in Explorer.
    expect(ps).not.toMatch(/'exe'|'bat'|'cmd'|'ps1'|'lnk'/);
  });
  it("installs per user with no admin, from plain ASCII", () => {
    const cmd = installerCmd("\\\\thor\\Equipment Files");
    expect(cmd).toContain('reg add "HKCU\\Software\\Classes\\thor-open"');
    expect(cmd).not.toContain("HKLM");
    expect([...cmd].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });
});
