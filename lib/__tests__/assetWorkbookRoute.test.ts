// intelligence Round G (I-10) — the master-list door's spreadsheet half:
// POST /api/assets/parse-workbook runs lib/xlsxData.ts parseWorkbook for the
// asset importer (GAP-307's list half; BR-4 / AREA-7). Authority is the
// registry writer tier by the role COLLECTION; nothing is written.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";

const state = vi.hoisted(() => ({
  user: null as null | { id: string },
  member: null as null | { role: string; roles: string[] },
}));
function chain() {
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: state.member, error: null });
      return () => (prop === "maybeSingle" ? Promise.resolve({ data: state.member, error: null }) : new Proxy(c, h));
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => (state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } })) },
    from: () => chain(),
  },
}));

import { POST } from "@/app/api/assets/parse-workbook/route";

function workbookB64(sheets: Record<string, unknown[][]>): string {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer).toString("base64");
}
const post = (body: unknown, auth = true) => POST(new NextRequest("http://x/api/assets/parse-workbook", {
  method: "POST",
  headers: { ...(auth ? { authorization: "Bearer t" } : {}), "content-type": "application/json" },
  body: JSON.stringify(body),
}));

const MASTER = {
  "Equipment list": [
    ["Master Equipment List — Refinery", ""],
    [],
    ["Tag", "Description", "Unit", "Site code"],
    ["E-22", "Crude preheat exchanger", "20", "2030.22"],
    ["P-101", "Charge pump", "Crude Unit", ""],
  ],
  Notes: [["Revision", "By"], ["A", "JD"]],
};

beforeEach(() => {
  state.user = { id: "u1" };
  state.member = { role: "Supervisor", roles: ["Supervisor"] };
});

describe("POST /api/assets/parse-workbook", () => {
  it("401 without a bearer; 403 for a member outside the writer tier (by collection)", async () => {
    expect((await post({ orgId: "o1", fileBase64: workbookB64(MASTER) }, false)).status).toBe(401);
    state.member = { role: "Viewer", roles: ["Viewer"] };
    expect((await post({ orgId: "o1", fileBase64: workbookB64(MASTER) })).status).toBe(403);
    state.member = null;
    expect((await post({ orgId: "o1", fileBase64: workbookB64(MASTER) })).status).toBe(403);
  });
  it("an additively held writer role is enough (ADD-1): headline Requester + roles [Manager]", async () => {
    state.member = { role: "Requester", roles: ["Requester", "Manager"] };
    expect((await post({ orgId: "o1", fileBase64: workbookB64(MASTER) })).status).toBe(200);
  });
  it("finds the header row below a title block and returns rows in header order, sheet names for the picker", async () => {
    const res = await post({ orgId: "o1", fileBase64: workbookB64(MASTER), fileName: "MEL.xlsx" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sheetNames).toEqual(["Equipment list", "Notes"]);
    expect(json.sheetName).toBe("Equipment list");
    expect(json.headers).toEqual(["Tag", "Description", "Unit", "Site code"]);
    expect(json.rows).toEqual([
      ["E-22", "Crude preheat exchanger", "20", "2030.22"],
      ["P-101", "Charge pump", "Crude Unit", ""],
    ]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("each row carries its REAL sheet row number — the title block above the header and blank separator rows counted", async () => {
    const json = await (await post({ orgId: "o1", fileBase64: workbookB64(MASTER) })).json();
    expect(json.rowNumbers).toEqual([4, 5]);
    const spaced = {
      List: [
        ["Refinery — master equipment list", ""], ["Rev C", ""], [],
        ["Tag", "Unit"],
        ["E-22", "20"], [], [], ["P-101", "20"], [], ["V-1", "25"],
      ],
    };
    const j2 = await (await post({ orgId: "o1", fileBase64: workbookB64(spaced) })).json();
    expect(j2.rows.map((r: string[]) => r[0])).toEqual(["E-22", "P-101", "V-1"]);
    expect(j2.rowNumbers).toEqual([5, 8, 10]);
    // A .csv through the same door counts its lines the same way.
    const csv = Buffer.from("Master list,\n\nTag,Unit\nE-22,20\n\nP-101,20\n").toString("base64");
    const j3 = await (await post({ orgId: "o1", fileBase64: csv, fileName: "mel.csv" })).json();
    expect(j3.rowNumbers).toEqual([4, 6]);
  });
  it("reads the sheet asked for", async () => {
    const json = await (await post({ orgId: "o1", fileBase64: workbookB64(MASTER), sheet: "Notes" })).json();
    expect(json.headers).toEqual(["Revision", "By"]);
  });
  it("a sheet refused for its size answers 422 WITH the workbook's sheet names, so another sheet can be picked (XEDGE-12)", async () => {
    // A register whose last used column (ZZ, 702) under 10,001 rows is past the
    // 5,128,192-cell budget, beside a small sheet.
    const wide: unknown[][] = [Array.from({ length: 702 }, (_, i) => (i === 701 ? "Last" : i === 0 ? "Tag" : null))];
    for (let r = 0; r < 10_000; r++) wide.push(["P-" + r]);
    const fileBase64 = workbookB64({ Register: wide, Notes: [["Revision", "By"], ["A", "JD"]] });
    const res = await post({ orgId: "o1", fileBase64 });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/^Sheet "Register" spans 10,001 rows × 702 columns; the generator reads at most 5,128,192 cells per sheet/);
    expect(json.sheetNames).toEqual(["Register", "Notes"]);
    expect(json.sheetName).toBe("Register");
    const other = await post({ orgId: "o1", fileBase64, sheet: "Notes" });
    expect(other.status).toBe(200);
    expect((await other.json()).headers).toEqual(["Revision", "By"]);
  }, 60_000);
  it("refuses an empty or over-size upload before parsing", async () => {
    expect((await post({ orgId: "o1", fileBase64: "" })).status).toBe(400);
    const big = Buffer.alloc(3 * 1024 * 1024 + 10, 65).toString("base64");
    const res = await post({ orgId: "o1", fileBase64: big });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/import limit is 3 MB/);
  });
});
