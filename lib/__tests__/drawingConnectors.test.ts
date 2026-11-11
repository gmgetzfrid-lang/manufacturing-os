// Off-page connectors checked against the sheets they point at. It says
// only what it can check, and counts the rest apart.

import { describe, it, expect } from "vitest";
import {
  checkConnectors, connectorTagKey, drawingKey, drawingLabel, drawingOf, missingLine, oneWayLine, parseConnector, sheetFromName, tagLine,
  type ConnectorRead, type SheetOnFile,
} from "@/lib/drawingConnectors";

describe("parseConnector", () => {
  it("reads the direction, the tag, and the sheet on this drawing or another", () => {
    expect(parseConnector("TO X-58 SHT 3")).toEqual({ direction: "to", tag: "X-58", drawing: null, sheet: "3" });
    expect(parseConnector("FROM E-21 5502-D 2000 SHT 6")).toEqual({ direction: "from", tag: "E-21", drawing: "5502-D 2000", sheet: "6" });
    expect(parseConnector("to lv-222 2002-D 2001 sht. 012")).toMatchObject({ direction: "to", tag: "lv-222", drawing: "2002-D 2001", sheet: "12" });
  });
  it("is not a connector without a sheet to go to", () => {
    expect(parseConnector("TO FLARE")).toBeNull();
    expect(parseConnector("X-58 SHT 3")).toBeNull();
  });
});

describe("keys", () => {
  it("one drawing, one sheet, one tag however they are written", () => {
    expect(drawingKey("5502-D 2000")).toBe(drawingKey("5502D2000"));
    expect(drawingOf("5602-D 1000-10")).toBe("5602-D 1000");
    expect(drawingOf("PSSR-TRANSMIX-1-2")).toBeNull();
    expect(drawingLabel("6002-D-2000")).toBe("6002-D 2000");
    expect(drawingLabel("6002D2000")).toBe(drawingLabel("6002-D 2000"));
    expect(connectorTagKey("X-058")).toBe(connectorTagKey("x58"));
    expect(sheetFromName("5502-D 2000_SHT04_R22_10-15-26.pdf")).toBe("4");
    expect(sheetFromName("55 - Transmix Unit PFD Book.pdf")).toBeNull();
  });
});

describe("checkConnectors", () => {
  const sheet = (id: string, number: string, s: string | null, name = ""): SheetOnFile => ({ id, libraryId: "L", number, sheet: s, name });
  const sheets = [
    sheet("a1", "5502-D 2000", "01"), sheet("a2", "5502-D 2000-2", "02"), sheet("a3", "5502-D 2000-3", "03"),
    sheet("b1", "5602-D 1000-19", "01"),                       // the number's suffix is not its sheet
    sheet("k1", "2502-D 1000", null, "2502-D 1000_SHT01_R39_10-31-25.pdf"),
    sheet("book", "2003-D 1039", null, "2003-D 1039 CRUDE UNIT 02-04-25.pdf"),
  ];
  const tagsOn = new Map<string, string[]>([
    ["a1", ["E-21", "P-11A"]], ["a2", ["X-58", "V-4"]], ["a3", ["FV-111"]], ["b1", ["E-22"]], ["k1", ["H-1"]],
  ]);
  const read = (sheetId: string, raw: string): ConnectorRead => ({ sheetId, page: 1, tag: raw.split(" ")[1], raw });
  const reads = [
    read("a1", "TO X-58 SHT 2"),                 // holds: sheet 2 has X-58
    read("a2", "FROM E-21 SHT 1"),               // holds, and answers the line above
    read("a1", "TO X-99 SHT 3"),                 // sheet 3 has no X-99
    read("a1", "TO E-22 5602-D 1000 SHT 1"),     // holds on another drawing, by its sheet (not its "-19")
    read("a2", "TO P-9 5502-D 2000 SHT 7"),      // sheet 7 is not on file
    read("a3", "TO H-1 2502-D 1000 SHT 1"),      // its sheet is only in the file name
    read("book", "TO V-1 SHT 4"),                // a book with no sheet numbers recorded
    read("a1", "TO FLARE"),                      // nowhere to go that can be read
    read("a1", "TO X-58 SHT 2"),                 // the same connector read twice
  ];
  const r = checkConnectors(sheets, reads, tagsOn);

  it("counts each connector once, and what holds", () => {
    expect(r.connectors).toBe(8);
    expect(r.holds).toBe(4);
  });
  it("names a sheet a connector points to that is not on file", () => {
    expect(r.missingSheets).toEqual([{ drawing: "5502-D 2000", sheet: "7", askedBy: [{ from: expect.objectContaining({ id: "a2", label: "5502-D 2000 sheet 2" }), direction: "to", tag: "P-9" }] }]);
    expect(missingLine(r.missingSheets[0])).toBe("5502-D 2000 sheet 7 is not on file. 1 connector points to it.");
  });
  it("names a tag that is not on the sheet the connector points at", () => {
    expect(r.tagNotThere.map(tagLine)).toEqual(["5502-D 2000 sheet 1 shows X-99 going to 5502-D 2000 sheet 3. X-99 was not read on that sheet."]);
  });
  it("names sheet pairs where only one side shows the line", () => {
    // Sheet 1 to sheet 2 is answered. Sheet 1 to sheet 3, to the LRU sheet,
    // and sheet 3 to the DHT sheet are not.
    expect(r.oneWay.map(oneWayLine)).toEqual([
      "5502-D 2000 sheet 1 sends 1 line to 5502-D 2000 sheet 3 (X-99). That sheet shows nothing coming from it.",
      "5502-D 2000 sheet 1 sends 1 line to 5602-D 1000 sheet 1 (E-22). That sheet shows nothing coming from it.",
      "5502-D 2000 sheet 3 sends 1 line to 2502-D 1000 sheet 1 (H-1). That sheet shows nothing coming from it.",
    ]);
  });
  it("counts apart what it cannot check, and never calls it a fault", () => {
    expect(r.unchecked).toEqual({ noTarget: 1, targetNotRead: 0, noSheetRecorded: 1, noSheetDrawings: ["2003-D 1039"] });
  });
  it("a target sheet nothing was read on is not said to lack the tag, or to be silent", () => {
    const unread = checkConnectors(sheets, [read("a1", "TO X-58 SHT 2")], new Map([["a1", ["E-21"]]]));
    expect(unread.tagNotThere).toEqual([]);
    expect(unread.oneWay).toEqual([]);
    expect(unread.unchecked.targetNotRead).toBe(1);
  });
});
