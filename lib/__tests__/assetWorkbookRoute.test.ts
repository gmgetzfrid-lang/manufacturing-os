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
  it("reads the sheet asked for", async () => {
    const json = await (await post({ orgId: "o1", fileBase64: workbookB64(MASTER), sheet: "Notes" })).json();
    expect(json.headers).toEqual(["Revision", "By"]);
  });
  it("refuses an empty or over-size upload before parsing", async () => {
    expect((await post({ orgId: "o1", fileBase64: "" })).status).toBe(400);
    const big = Buffer.alloc(3 * 1024 * 1024 + 10, 65).toString("base64");
    const res = await post({ orgId: "o1", fileBase64: big });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/import limit is 3 MB/);
  });
});
