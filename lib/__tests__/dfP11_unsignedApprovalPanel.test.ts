// @vitest-environment jsdom
//
// drafting-flow EVID-4 done-when 3 — the gap query on the Control Register
// (DF-P11 integrator fix pass; ruled by the integrator at the DF-P11 merge,
// 2026-10-21, DEC-90): a read-only count and list of the current revisions
// with no complete signed review sign-off; a failed read is said ("not
// known"), never "none".

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { act } from "react";

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  readError: {} as Record<string, { message: string } | undefined>,
}));
function table(name: string) {
  const filters: Array<[string, string, unknown]> = [];
  let range: [number, number] | null = null;
  const match = (r: Record<string, unknown>) => filters.every(([k, f, v]) =>
    f === "eq" ? r[k] === v : f === "in" ? (v as unknown[]).includes(r[k]) : f === "not" ? r[k] != null : true);
  const run = () => {
    if (db.readError[name]) return { data: null, error: db.readError[name] };
    let hit = (db.tables[name] ?? []).filter(match);
    if (range) hit = hit.slice(range[0], range[1] + 1);
    return { data: hit, error: null };
  };
  const q: Record<string, unknown> = {
    select() { return q; },
    eq(k: string, v: unknown) { filters.push([k, "eq", v]); return q; },
    in(k: string, v: unknown[]) { filters.push([k, "in", v]); return q; },
    not(k: string) { filters.push([k, "not", null]); return q; },
    order() { return q; },
    range(a: number, b: number) { range = [a, b]; return q; },
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve().then(run).then(res, rej); },
  };
  return q;
}
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => table(t) } }));

import UnsignedApprovalPanel, { UnsignedApprovalView, unsignedApprovalHeadline } from "@/components/documents/UnsignedApprovalPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const seed = () => {
  db.tables.documents = [
    { id: "d1", org_id: "o1", document_number: "P-1", library_id: "L1", current_version_id: "v1", status: "Issued" },
    { id: "d2", org_id: "o1", document_number: "P-2", library_id: "L1", current_version_id: "v2", status: "Issued" },
    { id: "d3", org_id: "o1", document_number: "P-3", library_id: "L2", current_version_id: "v3", status: "Issued" },
  ];
  db.tables.document_review_signoffs = [
    { document_version_id: "v1", reviewer_user_id: "r1", status: "signed", signature_id: "s1", slot: "primary", activated: true, slot_group: "person:r1" },
    { document_version_id: "v2", reviewer_user_id: "r2", status: "signed", signature_id: "s2", slot: "primary", activated: true, slot_group: "person:r2" },
    { document_version_id: "v2", reviewer_user_id: "r3", status: "pending", slot: "primary", activated: true, slot_group: "person:r3" },
  ];
  db.tables.document_versions = [
    { id: "v2", revision_label: "B", created_by: "pub", created_by_name: "Pat", approved_by_name: "J. Typed" },
    { id: "v3", revision_label: "0", created_by: "pub", created_by_name: "Pat", approved_by_name: null },
  ];
};

async function mount(orgId: string): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(UnsignedApprovalPanel, { orgId })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return el;
}

beforeEach(() => { db.tables = {}; db.readError = {}; document.body.innerHTML = ""; });

describe("EVID-4 dw3 — the Control Register shows the gap read-only", () => {
  it("the count and the list: a partly signed and an unrostered current revision, with the publisher's claim labelled unverified", async () => {
    seed();
    const el = await mount("o1");
    const panel = el.querySelector('[data-testid="unsigned-approval-panel"]')!;
    expect(panel.getAttribute("data-state")).toBe("ok");
    expect(el.querySelector('[data-testid="unsigned-approval-headline"]')?.textContent).toContain("2 current revisions have no complete signed review sign-off");
    const rows = [...el.querySelectorAll('[data-testid="unsigned-approval-list"] tbody tr')].map((r) => r.textContent?.replace(/\s+/g, " "));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("P-2");
    expect(rows[0]).toContain("Partially signed — 1 of 2");
    expect(rows[0]).toContain("“J. Typed”");
    expect(rows[1]).toContain("P-3");
    expect(rows[1]).toContain("No review roster");
    expect(el.textContent).toContain("Approval reference (publisher's note) (unverified)");
    expect(el.querySelector('a[href="/documents/L1?doc=d2"]')).not.toBeNull();
    // nothing writable on the panel
    expect(el.querySelectorAll("button, input, select, form")).toHaveLength(0);
  });

  it("a failed read is said — 'not known', never 'none' and never a zero", async () => {
    seed();
    db.readError.document_review_signoffs = { message: "down" };
    const el = await mount("o1");
    const panel = el.querySelector('[data-testid="unsigned-approval-panel"]')!;
    expect(panel.getAttribute("data-state")).toBe("error");
    const text = panel.textContent ?? "";
    expect(text).toContain("not known");
    expect(text).toContain("The review sign-offs could not be read.");
    expect(text).toContain("This does not mean there are none");
    expect(text).not.toMatch(/Every current revision/);
    expect(text).not.toMatch(/\b0 current/);
  });

  it("a documents read that fails is said too", async () => {
    seed();
    db.readError.documents = { message: "timeout" };
    const el = await mount("o1");
    expect(el.textContent).toContain("The documents could not be read (timeout).");
  });

  it("every current revision signed → says so (a real zero, after a successful read)", async () => {
    seed();
    db.tables.documents = db.tables.documents.slice(0, 1);
    const el = await mount("o1");
    expect(el.textContent).toContain("Every current revision you can see has a complete signed review sign-off.");
  });

  it("while loading it says it is checking — never a count", () => {
    const html = renderToStaticMarkup(React.createElement(UnsignedApprovalView, { state: { status: "loading" } }));
    expect(html).toContain("Checking current revisions");
    expect(unsignedApprovalHeadline({ status: "ok", rows: [{ documentId: "d", documentNumber: "P", libraryId: null, versionId: "v", revisionLabel: null, publishedBy: null, publishedByName: null, claim: null, satisfied: 0, required: 0 }] }))
      .toContain("1 current revision has no complete signed review sign-off");
  });
});
