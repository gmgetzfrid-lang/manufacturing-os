// admin-and-org Round G — package P7 second review fix, ALOG-7 done-when 2:
// the compliance evidence packs (document and project) print, beside each
// audit row's identity, whose word that identity is — the same note
// /admin/audit shows (lib/auditActions.ts auditActorNote). A row written
// before 20261201, or by the service role, is never printed as plain fact.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: { from: () => { throw new Error("not read in this test"); } } }));

import { renderEvidenceHtml, renderProjectEvidenceHtml } from "@/lib/evidencePack";

const audit = [
  { action: "VIEW", user_email: "member@x.io", user_role: "Drafter", actor_kind: "member", details: null, timestamp: "2026-10-01T00:00:00Z" },
  { action: "DATA_PURGE", user_email: "admin@x.io", user_role: "Admin", actor_kind: "server", details: null, timestamp: "2026-10-02T00:00:00Z" },
  { action: "STATUS_CHANGE", user_email: "old@x.io", user_role: "Admin", details: null, timestamp: "2026-01-02T00:00:00Z" }, // before 20261201
];

describe("ALOG-7 — the evidence packs say whose word each audit row's identity is", () => {
  it("document pack: each actor cell carries the actor note", () => {
    const html = renderEvidenceHtml({ doc: { document_number: "P-101" }, versions: [], holds: [], audit });
    expect(html).toMatch(/member@x\.io <span class="muted">\(Drafter\)<\/span> <span class="muted">· identity resolved by the database at write time<\/span>/);
    expect(html).toMatch(/admin@x\.io <span class="muted">\(Admin\)<\/span> <span class="muted">· recorded by the server<\/span>/);
    expect(html).toMatch(/old@x\.io <span class="muted">\(Admin\)<\/span> <span class="muted">· as sent by the writer/);
  });
  it("project pack: each actor cell carries the actor note", () => {
    const html = renderProjectEvidenceHtml({ project: { name: "Unit 4" }, members: [], milestones: [], audit, transmittals: [] });
    expect(html).toMatch(/member@x\.io <span class="muted">· identity resolved by the database at write time<\/span>/);
    expect(html).toMatch(/old@x\.io <span class="muted">· as sent by the writer/);
  });
});
