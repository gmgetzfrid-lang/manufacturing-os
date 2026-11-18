// Document-control XEDGE-12 — the workbook parser is the vendored SheetJS
// 0.20.3 (vendor/xlsx-0.20.3.tgz, pinned by its lockfile integrity hash),
// and every spreadsheet a person imported under 0.18.5 reads the same.
//
//   1. The dependency: package.json names the vendored tarball, the lockfile
//      pins its version / resolved path / sha512, the committed tarball hashes
//      to that sha512, and the module that loads is 0.20.3.
//   2. Real LibreOffice-written workbooks (fixtures/xlsx/libreoffice-typed.*:
//      .xlsx, BIFF8 .xls, an HTML-table ".xls", .csv, .ods, flat .fods; one
//      sheet typed from the same csv) parse to the values
//      0.18.5 produced — every cell, header and row number — except the
//      recorded binary deltas (pinned below; each was already wrong or
//      meaningless under 0.18.5).
//   3. Text cells (CSV / TSV / HTML table) keep 0.18.5's typing: the rules
//      0.20.x changed ("15-Mar-2026", "13:45", "#N/A", "=SUM()", an HTML
//      "1:45 PM" that refused the file) read as before.
//   4. A binary workbook's text-looking STRING cells stay strings.
//   5. Round trips: read → write → parse gives the same rows.
//
// Expected values were produced by running lib/xlsxData.ts parseWorkbook on
// xlsx 0.18.5 (the base dependency) over the same bytes, in UTC (the server
// runtime's zone).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import * as XLSX from "xlsx";
import { parseWorkbook, MAX_SHEET_CELLS } from "@/lib/xlsxData";

const root = resolve(__dirname, "../..");
const fixture = (name: string) => readFileSync(resolve(__dirname, "fixtures/xlsx", name));
const inZone = <T,>(zone: string, fn: () => T): T => {
  const tz = process.env.TZ;
  try { process.env.TZ = zone; return fn(); } finally { process.env.TZ = tz; }
};
const values = (bytes: Buffer, col = "Value") => parseWorkbook(bytes).rows.map((r) => r[col]);

describe("XEDGE-12 — the dependency is the vendored SheetJS 0.20.3", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
  const entry = lock.packages["node_modules/xlsx"];

  it("package.json and the lockfile name the committed tarball, pinned by its sha512", () => {
    expect(pkg.dependencies.xlsx).toBe("file:vendor/xlsx-0.20.3.tgz");
    expect(lock.packages[""].dependencies.xlsx).toBe("file:vendor/xlsx-0.20.3.tgz");
    expect(entry.version).toBe("0.20.3");
    expect(entry.resolved).toBe("file:vendor/xlsx-0.20.3.tgz");
    expect(entry.integrity).toBe("sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==");
    // 0.20.3 bundles what 0.18.5 pulled from the registry.
    expect(entry.dependencies).toBeUndefined();
    expect(JSON.stringify(lock)).not.toContain("registry.npmjs.org/xlsx/");
  });

  it("the committed tarball hashes to the lockfile's integrity (npm ci refuses any other bytes)", () => {
    const tgz = readFileSync(resolve(root, "vendor/xlsx-0.20.3.tgz"));
    expect("sha512-" + createHash("sha512").update(tgz).digest("base64")).toBe(entry.integrity);
    expect(createHash("sha256").update(tgz).digest("hex")).toBe("8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8");
  });

  it("every install path has the tarball: committed (not ignored), and copied into the Docker build before npm ci", () => {
    const ignores = (file: string) => readFileSync(resolve(root, file), "utf8").split("\n").map((l) => l.trim());
    for (const file of [".gitignore", ".dockerignore"]) {
      expect(ignores(file).filter((l) => /^\/?vendor\/?(\*.*)?$|^\*\.tgz$|^\*\*\/\*\.tgz$/.test(l))).toEqual([]);
    }
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
    const copied = dockerfile.indexOf("COPY vendor ./vendor");
    expect(copied).toBeGreaterThan(-1);
    expect(copied).toBeLessThan(dockerfile.indexOf("RUN npm ci"));
    expect(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")).toMatch(/run: npm ci\b/);
  });

  it("the module the parser loads is 0.20.3", () => {
    expect(XLSX.version).toBe("0.20.3");
  });
});

describe("XEDGE-12 — real LibreOffice workbooks read as they did under 0.18.5", () => {
  // The csv a person typed into LibreOffice (rows 4..32 of the sheet).
  const CSV_018 = [
    "2026-03-15", "2026-03-15", "2026-03-15", "2026-03-15", "2026-03-15", "13:45", "1:45 PM", "0:00", "23:59:59",
    "1.5", "7", "1234.5", "-123", "0.5", "Yes", "No", "", "", "", "txt", "#N/A", "N/A", "PSV-101", "1 2",
    "1899-12-30", "1900-01-01", "1900-02-28", "1900-03-01", "9999-12-31",
  ];
  const HTML_018 = [
    "2026-03-15", "2026-03-15", "2026-03-15", "2026-03-15", "2026-03-15", "01:45:00 PM", "01:45:00 PM", "12:00:00 AM", "11:59:59 PM",
    "1.5", "7", "1234.5", "-123", "0.5", "Yes", "No", "3", "#DIV/0!", "#N/A", "txt", "#N/A", "N/A", "PSV-101", "1 2",
    "1899-12-30", "1900-01-01", "1900-02-28", "1900-03-01", "9999-12-31",
  ];
  const XLSX_018 = [
    "2026-03-15", "2026-03-15", "2026-03-15", "2026-03-15", "2026-03-15", "1899-12-30", "1899-12-30", "1899-12-30", "1899-12-30",
    "1.5", "7", "1234.5", "-123", "0.5", "Yes", "No", "3", "", "", "txt", "#N/A", "N/A", "PSV-101", "1 2",
    "1899-12-30", "1900-01-01", "1900-02-28", "1900-03-01", "9999-12-31",
  ];
  const XLS_018 = [
    "2026-03-15", "2026-03-15", "2026-03-15", "2026-03-15", "2026-03-15", "1899-12-31", "1899-12-31", "1899-12-31", "1899-12-31",
    "1.5", "7", "1234.5", "-123", "0.5", "No", "No", "3", "", "", "0", "#N/A", "N/A", "PSV-101", "1 2",
    "1899-12-31", "1900-01-02", "1900-03-01", "1900-03-01", "9999-12-31",
  ];

  it("the text formats (csv, the HTML-table .xls) are identical, cell for cell", () => inZone("UTC", () => {
    expect(values(fixture("libreoffice-typed.csv"))).toEqual(CSV_018);
    expect(values(fixture("libreoffice-typed.html.xls"))).toEqual(HTML_018);
  }));

  it("an OpenDocument sheet keeps its formula errors as text and its dates as stated, in every zone", () => {
    // 0.20.3 alone reads the errors blank, and the dates a day early east of
    // Greenwich; only the time-only cells (rows 5-8: a meaningless 1899 date
    // before and after) moved, as in xlsx.
    const odsNow = [...HTML_018];
    for (const i of [5, 6, 7, 8]) odsNow[i] = "1899-12-31";
    for (const name of ["libreoffice-typed.ods", "libreoffice-typed.fods"]) {
      for (const zone of ["UTC", "Europe/Berlin", "America/Chicago"]) {
        const got = inZone(zone, () => values(fixture(name)));
        expect(got.filter((_, i) => ![5, 6, 7, 8].includes(i))).toEqual(odsNow.filter((_, i) => ![5, 6, 7, 8].includes(i)));
      }
      expect(inZone("UTC", () => values(fixture(name)))).toEqual(odsNow);
    }
  });

  it("headers, sheet names and row numbers are identical for every format", () => inZone("UTC", () => {
    for (const [name, sheet] of [["csv", "Sheet1"], ["html.xls", "Sheet1"], ["xlsx", "lotypes"], ["xls", "lotypes"], ["ods", "lotypes"], ["fods", "lotypes"]]) {
      const got = parseWorkbook(fixture(`libreoffice-typed.${name}`));
      expect(got.sheetName).toBe(sheet);
      expect(got.sheetNames).toEqual([sheet]);
      expect(got.headers).toEqual(["Tag", "Value", "Note"]);
      expect(got.rowNumbers).toEqual(Array.from({ length: 29 }, (_, i) => i + 4));
      expect(got.rows.map((r) => r.Note)).toEqual(Array.from({ length: 29 }, (_, i) => `n${i}`));
    }
  }));

  it("the binary formats are identical but for the recorded deltas, each already wrong under 0.18.5", () => inZone("UTC", () => {
    // Recorded deltas (XEDGE-12, 2026-11-18). 0.20.x reads Excel serial dates
    // below 61 (before 1900-03-01, and every time-only cell) by Excel's own
    // calendar where 0.18.5 was a day early, and leaves serial 60 (Excel's
    // phantom 1900-02-29) a number; no work order or equipment date falls
    // there, and a time-only cell read as a meaningless 1899 date both before
    // and after. 0.18.5 read LibreOffice's BIFF8 TRUE as "No"; 0.20.3 reads "Yes".
    const xlsxNow = [...XLSX_018];
    for (const i of [5, 6, 7, 8, 24]) xlsxNow[i] = "1899-12-31";
    xlsxNow[25] = "1900-01-02";
    xlsxNow[26] = "60";
    expect(values(fixture("libreoffice-typed.xlsx"))).toEqual(xlsxNow);
    const xlsNow = [...XLS_018];
    xlsNow[14] = "Yes";
    expect(values(fixture("libreoffice-typed.xls"))).toEqual(xlsNow);
    // Every date from 1900-03-01 on, and every number, string and boolean but
    // that one, is exactly as before.
    const unchanged = (now: string[], before: string[], skip: number[]) =>
      now.filter((_, i) => !skip.includes(i)).every((v, i) => v === before.filter((_, j) => !skip.includes(j))[i]);
    expect(unchanged(xlsxNow, XLSX_018, [5, 6, 7, 8, 24, 25, 26])).toBe(true);
    expect(unchanged(xlsNow, XLS_018, [14])).toBe(true);
  }));
});

describe("XEDGE-12 — text cells keep the 0.18.5 typing rules", () => {
  // [as typed, as 0.18.5 read it] — the first block is where 0.20.3's own
  // guesser differs; the rest pin the rules that did not move.
  const CASES: Array<[string, string]> = [
    ["15-Mar-2026", "2026-03-15"], ["15 Mar 2026", "2026-03-15"], ["Mar 15, 2026", "2026-03-15"], ["March 15 2026", "2026-03-15"],
    ["2026-03-15T13:45:00Z", "2026-03-15T13:45:00Z"], ["2026-03-15T13:45:00", "2026-03-15T13:45:00"],
    ["13:45", "13:45"], ["1:45 PM", "1:45 PM"],
    ["#N/A", "#N/A"], ["#DIV/0!", "#DIV/0!"], ["#REF!", "#REF!"], ["1 2", "1 2"],
    ["2026-03-15", "2026-03-15"], ["2026/03/15", "2026-03-15"], ["3/15/2026", "2026-03-15"], ["03/15/26", "2026-03-15"],
    ["15/03/2026", "15/03/2026"], ["Mar-26", "Mar-26"], ["2026-03-15 13:45", "2026-03-15"], ["3/15", "2001-03-15"],
    ["1.50", "1.5"], ["007", "7"], ["1e3", "1000"], ["$1,234.50", "1234.5"], ["(123)", "-123"], ["((12))", "((12))"],
    ["50%", "0.5"], ["TRUE", "Yes"], ["FALSE", "No"], ["true", "true"], ["N/A", "N/A"], ["PSV-101", "PSV-101"],
    ["Infinity", "Infinity"], ["  padded  ", "padded"], ["Q1-2026", "Q1-2026"],
  ];
  const csv = (rows: string[]) => Buffer.from("Tag,Value\n" + rows.map((v, i) => `R${i},"${v.replace(/"/g, '""')}"`).join("\n") + "\n");
  const html = (rows: string[]) => Buffer.from(
    "<html><body><table><tr><td>Tag</td><td>Value</td></tr>"
    + rows.map((v, i) => `<tr><td>R${i}</td><td>${v.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</td></tr>`).join("")
    + "</table></body></html>",
  );

  it("a CSV, a TSV, a BOM'd CSV and a UTF-16 CSV read each cell as 0.18.5 did", () => inZone("UTC", () => {
    const typed = CASES.map(([t]) => t);
    const want = CASES.map(([, w]) => w);
    expect(values(csv(typed))).toEqual(want);
    const tsv = Buffer.from("Tag\tValue\n" + typed.map((v, i) => `R${i}\t${v}`).join("\n") + "\n");
    expect(values(tsv)).toEqual(want);
    expect(values(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv(typed)]))).toEqual(want);
    expect(values(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv(typed).toString(), "utf16le")]))).toEqual(want);
  }));

  it("an HTML table (the .xls many systems export) reads each cell as 0.18.5 did, and a time no longer refuses the file", () => inZone("UTC", () => {
    expect(values(html(CASES.map(([t]) => t)))).toEqual(CASES.map(([, w]) => w));
    expect(values(html(["1:45 PM", "13:45"]))).toEqual(["1:45 PM", "13:45"]);
  }));

  it("an HTML cell marked as text (six spellings, td or th) keeps its text exactly, as 0.18.5 kept it", () => {
    const marked = ["00123", "1-2", "1/2", "1e5", "TRUE", "(12)", "50%", "12345678901234567890", "#N/A", "15-Mar-2026", "13:45", "1:45 PM", "2026-03-15", " padded "];
    const table = (attr: string) => Buffer.from(
      "<table><tr><td>Tag</td><td>Value</td></tr>"
      + marked.map((v, i) => `<tr><td>R${i}</td><td${attr}>${v}</td></tr>`).join("")
      + "</table>",
    );
    for (const zone of ["UTC", "America/Chicago", "Asia/Kolkata"]) {
      for (const attr of [' data-t="s"', ' t="s"', " t=s", " T='s'", ' data-t = "s"', ' x:t="s"']) {
        expect(inZone(zone, () => values(table(attr)))).toEqual(marked.map((v) => v.trim()));
      }
    }
  });

  it("CSV formulas read blank, a quoted =\"x\" reads x, a CRLF inside a quoted field reads LF", () => inZone("UTC", () => {
    const bytes = Buffer.from('Tag,Value\r\nA,=SUM(A1:B1)\r\nB,"=""x"""\r\nC,=\r\nD,"one\r\ntwo"\r\n');
    expect(values(bytes)).toEqual(["", "x", "=", "one\ntwo"]);
  }));

  it("text dates are read in the server's own zone, as 0.18.5 read them", () => {
    const bytes = csv(["2026-03-15", "15-Mar-2026"]);
    expect(inZone("America/Chicago", () => values(bytes))).toEqual(["2026-03-15", "2026-03-15"]);
    // 0.18.5 handed the text to the engine's Date parser: an ISO date-only
    // string is UTC, any other form local midnight — which, rendered in UTC,
    // lands the day before east of Greenwich. The production runtime is UTC.
    expect(inZone("Europe/Berlin", () => values(bytes))).toEqual(["2026-03-15", "2026-03-14"]);
  });

  it("a pathological parenthesised number cell parses in linear time (the regex 0.20.2 retired is not reintroduced)", () => {
    const cell = "1" + "(".repeat(200_000);
    const started = Date.now();
    expect(values(csv([cell]))).toEqual([cell]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("XEDGE-12 — a binary workbook's string cells stay strings", () => {
  it("text that looks like a date, time, boolean, error or number is kept exactly in xlsx, xls and xlsb", () => inZone("UTC", () => {
    const looks = ["15-Mar-2026", "2026-03-15", "13:45", "TRUE", "#N/A", "007", "=SUM(A1)", "1 2"];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Tag", "Value"], ...looks.map((v, i) => [`R${i}`, v])]), "Data");
    for (const bookType of ["xlsx", "xls", "xlsb"] as const) {
      expect(values(XLSX.write(wb, { type: "buffer", bookType }) as Buffer)).toEqual(looks);
    }
  }));
});

describe("XEDGE-12 — a sheet's used range is read within a cell budget", () => {
  it("a range a few bytes declare is trimmed to the cells present: an xlsx dimension to XFD, a CSV line of commas", () => inZone("UTC", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Tag", "Desc", "Qty"], ["P-1", "pump", 1], ["P-2", "valve", 2]]);
    ws["!ref"] = "A1:XFD200"; // 3.3M cells declared, 9 present
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const bytes = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer; // the writer walks the range; not timed
    let started = Date.now();
    const out = parseWorkbook(bytes);
    expect(out.headers).toEqual(["Tag", "Desc", "Qty"]);
    expect(out.rows).toEqual([{ Tag: "P-1", Desc: "pump", Qty: "1" }, { Tag: "P-2", Desc: "valve", Qty: "2" }]);
    expect(Date.now() - started).toBeLessThan(3000);
    started = Date.now();
    const commas = parseWorkbook(Buffer.from("Tag,Desc\n" + "a" + ",".repeat(1_000_000) + "\n" + "x,y\n".repeat(1000)));
    expect(commas.headers).toEqual(["Tag", "Desc"]);
    expect(commas.rows).toHaveLength(1001);
    expect(Date.now() - started).toBeLessThan(3000);
  }), 60_000);

  it("real data spanning more than MAX_SHEET_CELLS is refused in plain words; a range within it reads exactly as before", () => inZone("UTC", () => {
    const far = Buffer.from("Tag,Desc\n" + "a" + ",".repeat(1_000_000) + "b\n" + "x,y\n".repeat(1000));
    expect(MAX_SHEET_CELLS).toBe(2_003_200); // the 10,016-row read window × 200 columns
    expect(() => parseWorkbook(far)).toThrow(/spans 1,002 rows × 1,000,001 columns; the generator reads at most 2,003,200 cells per sheet/);
    // Within the budget nothing is trimmed: an A1:Z5 dimension still reads 26 columns, as 0.18.5 read it.
    const ws = XLSX.utils.aoa_to_sheet([["Tag", "Desc", "Qty"], ["P-1", "pump", 1]]);
    ws["!ref"] = "A1:Z5";
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    expect(parseWorkbook(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer).headers).toHaveLength(26);
  }));
});

describe("XEDGE-12 — round trips", () => {
  it("a LibreOffice workbook read and written back (xlsx, xlsb) parses to the same rows", () => inZone("UTC", () => {
    for (const name of ["libreoffice-typed.xlsx", "libreoffice-typed.xls"]) {
      const original = fixture(name);
      const wb = XLSX.read(original, { type: "buffer", cellDates: true });
      const before = parseWorkbook(original);
      for (const bookType of ["xlsx", "xlsb"] as const) {
        const again = parseWorkbook(XLSX.write(wb, { type: "buffer", bookType }) as Buffer);
        expect(again.rows).toEqual(before.rows);
        expect(again.headers).toEqual(before.headers);
        expect(again.rowNumbers).toEqual(before.rowNumbers);
      }
    }
  }));

  it("a workbook written as xlsx, xls and csv parses to the cells it was built from", () => inZone("UTC", () => {
    const rows = [
      ["Plant register"], [],
      ["Tag", "Due", "Qty", "Rate", "Done", "Notes"],
      ["PSV-101", new Date(Date.UTC(2026, 2, 15)), 12, 1.5, true, "Ünïcødé — ½"],
      [],
      ["PSV-102", new Date(Date.UTC(2030, 0, 1)), 0, -12.25, false, "line, with \"quotes\""],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), "Work Orders");
    for (const bookType of ["xlsx", "xls", "csv"] as const) {
      const got = parseWorkbook(XLSX.write(wb, { type: "buffer", bookType }) as Buffer);
      expect(got.headers).toEqual(["Tag", "Due", "Qty", "Rate", "Done", "Notes"]);
      expect(got.rowNumbers).toEqual([4, 6]);
      expect(got.rows).toEqual([
        { Tag: "PSV-101", Due: "2026-03-15", Qty: "12", Rate: "1.5", Done: "Yes", Notes: "Ünïcødé — ½" },
        { Tag: "PSV-102", Due: "2030-01-01", Qty: "0", Rate: "-12.25", Done: "No", Notes: "line, with \"quotes\"" },
      ]);
    }
  }));
});
