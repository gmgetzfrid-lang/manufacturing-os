// /api/projects/budget-doc — the budget-document reader, end to end except
// the model: who may read, the tenant-prefix guard, each source format
// turned into model input (real PDF render, real xlsx/docx text), blank
// page detection, and validation of what comes back.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as XLSX from "xlsx";
import JSZip from "jszip";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  tables: {} as Record<string, { data?: unknown; error?: unknown }>,
  file: null as Buffer | null,
  aiInputs: [] as Array<{ user: string; images?: Array<{ mediaType: string }> }>,
  aiText: "",
}));

function chain(table: string) {
  const res = () => state.tables[table] ?? { data: null, error: null };
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: res().data ?? null, error: res().error ?? null });
      return () => (prop === "maybeSingle" || prop === "single")
        ? Promise.resolve({ data: res().data ?? null, error: res().error ?? null })
        : new Proxy({}, h);
    },
  };
  return new Proxy({}, h);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@/lib/r2Bytes", () => ({
  fetchBytes: vi.fn(async () => { if (!state.file) throw new Error("NoSuchKey"); return state.file; }),
}));
vi.mock("@/lib/ai/governedCall", () => ({
  GovernedCallError: class extends Error { constructor(m: string, public status: number) { super(m); } },
  governedAiCall: vi.fn(async (input: { user: string; images?: Array<{ mediaType: string }> }) => {
    state.aiInputs.push({ user: input.user, images: input.images });
    return { text: state.aiText };
  }),
}));

import { POST } from "@/app/api/projects/budget-doc/route";

const ORG = "org-1";
const GOOD_JSON = JSON.stringify({
  docType: "AFE", docNumber: "100", authorizedAmount: 150000,
  lines: [{ name: "Mechanical Labor", amount: 100000, supplier: "{Acme}" }, { name: "Scaffolding", amount: 50000, supplier: "Brand" }],
  budgetReferences: [{ label: "Item 1", amount: 100000 }],
});

const req = (body: Record<string, unknown>, token = "t") => new NextRequest("http://x/api/projects/budget-doc", {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

async function pdfFixture(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  const lines = ["AUTHORIZATION FOR EXPENDITURE  AFE No. 100", "Mechanical Labor   $100,000   {Acme}", "Scaffolding   $50,000   {Brand}", "Total   $150,000"];
  lines.forEach((t, i) => page.drawText(t, { x: 50, y: 720 - i * 24, size: 14, font }));
  pdf.addPage([612, 792]); // intentionally blank
  return Buffer.from(await pdf.save());
}

beforeEach(() => {
  state.user = { id: "u1", email: "u1@x.test" };
  state.tables = { org_members: { data: { role: "Member", status: "active" } } };
  state.file = Buffer.from("Mechanical Labor,100000,Acme");
  state.aiInputs = [];
  state.aiText = GOOD_JSON;
});

describe("budget-doc route: access", () => {
  it("401 without a session", async () => {
    const res = await POST(req({ orgId: ORG, fileKey: `orgs/${ORG}/project-setup/a.csv`, fileName: "a.csv" }, ""));
    expect(res.status).toBe(401);
  });

  it("403 for a file outside the org's prefix, or a path escape", async () => {
    for (const fileKey of ["orgs/other-org/x/a.csv", `orgs/${ORG}/../other-org/a.csv`]) {
      const res = await POST(req({ orgId: ORG, fileKey, fileName: "a.csv" }));
      expect(res.status).toBe(403);
    }
    expect(state.aiInputs).toHaveLength(0);
  });

  it("403 for a non-member", async () => {
    state.tables.org_members = { data: null };
    const res = await POST(req({ orgId: ORG, fileKey: `orgs/${ORG}/project-setup/a.csv`, fileName: "a.csv" }));
    expect(res.status).toBe(403);
  });

  it("an existing project needs its owner or a controller", async () => {
    state.tables.projects = { data: { id: "p1", owner_user_id: "someone-else" } };
    const denied = await POST(req({ orgId: ORG, projectId: "p1", fileKey: `orgs/${ORG}/project-costs/p1/a.csv`, fileName: "a.csv" }));
    expect(denied.status).toBe(403);
    state.tables.projects = { data: { id: "p1", owner_user_id: "u1" } };
    const ok = await POST(req({ orgId: ORG, projectId: "p1", fileKey: `orgs/${ORG}/project-costs/p1/a.csv`, fileName: "a.csv" }));
    expect(ok.status).toBe(200);
  });

  it("415 for formats it can't read", async () => {
    const res = await POST(req({ orgId: ORG, fileKey: `orgs/${ORG}/project-setup/a.doc`, fileName: "a.doc", mimeType: "application/msword" }));
    expect(res.status).toBe(415);
  });
});

describe("budget-doc route: formats", () => {
  it("PDF: renders every page as an image, adds the text layer, flags blank pages", async () => {
    state.file = await pdfFixture();
    const res = await POST(req({ orgId: ORG, fileKey: `orgs/${ORG}/project-setup/afe.pdf`, fileName: "afe.pdf", mimeType: "application/pdf" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.pagesRead).toEqual([1, 2]);
    expect(body.blankPages).toEqual([2]);
    expect(state.aiInputs[0].images).toHaveLength(2);
    expect(state.aiInputs[0].images?.[0].mediaType).toBe("image/png");
    expect(state.aiInputs[0].user).toMatch(/Mechanical Labor/);
    expect(body.parsed.lines[0].supplier).toBe("Acme");
    expect(body.reconciliation).toMatchObject({ linesTotal: 150000, balanced: true, overBudgetBy: 50000 });
  }, 30_000);

  it("Excel: every sheet goes in as CSV text", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Line", "Amount", "Supplier"], ["Hydro blasting", 100000, "Ancon"]]), "Estimate");
    state.file = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const res = await POST(req({ orgId: ORG, fileKey: `orgs/${ORG}/project-setup/est.xlsx`, fileName: "est.xlsx" }));
    expect(res.status).toBe(200);
    expect(state.aiInputs[0].images).toBeUndefined();
    expect(state.aiInputs[0].user).toMatch(/## Sheet: Estimate/);
    expect(state.aiInputs[0].user).toMatch(/Hydro blasting,100000,Ancon/);
  });

  it("Word: paragraphs and table cells come through as text", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml",
      '<w:document><w:body><w:p><w:r><w:t>Capital Request CR-7 &amp; scope</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Insulation</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$12,000</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
    state.file = await zip.generateAsync({ type: "nodebuffer" });
    const res = await POST(req({ orgId: ORG, fileKey: `orgs/${ORG}/project-setup/cr.docx`, fileName: "cr.docx" }));
    expect(res.status).toBe(200);
    expect(state.aiInputs[0].user).toMatch(/Capital Request CR-7 & scope/);
    expect(state.aiInputs[0].user).toMatch(/Insulation\s*\|\s*\n?\s*\$12,000/);
  });
});

describe("budget-doc route: what comes back", () => {
  it("502 when the model returns no JSON", async () => {
    state.aiText = "I could not read this.";
    const res = await POST(req({ orgId: ORG, fileKey: `orgs/${ORG}/project-setup/a.csv`, fileName: "a.csv" }));
    expect(res.status).toBe(502);
  });

  it("422 when the extraction has neither lines nor a total", async () => {
    state.aiText = JSON.stringify({ title: "Something", lines: [] });
    const res = await POST(req({ orgId: ORG, fileKey: `orgs/${ORG}/project-setup/a.csv`, fileName: "a.csv" }));
    expect(res.status).toBe(422);
  });

  it("404 when the uploaded file is gone", async () => {
    state.file = null;
    const res = await POST(req({ orgId: ORG, fileKey: `orgs/${ORG}/project-setup/a.csv`, fileName: "a.csv" }));
    expect(res.status).toBe(404);
  });
});
