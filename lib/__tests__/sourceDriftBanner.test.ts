// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P2 — HAND-7 done-when 2 (the banner half) and
// GAP-8 acceptance 1 (the Impact panel reads both source fields).
//
// SourceDriftBanner reads each source document's LIVE current_version_id and
// says "the source revision has moved" only when the version the request was
// raised against is no longer current — by version id when the ticket
// captured one, by rev label for a historical row. A failed read, a document
// it cannot see and a ticket that captured nothing say nothing: never
// "current", never "moved". The ticket page mounts it (DF-P9, one line).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  docs: [] as Row[],
  tickets: [] as Row[],
  fail: false,
  reads: [] as Array<{ table: string; filters: Array<[string, string, unknown]> }>,
}));

vi.mock("@/lib/supabase", () => {
  const from = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return q; },
      in: (c: string, v: unknown) => { filters.push(["in", c, v]); return q; },
      contains: (c: string, v: unknown) => { filters.push(["contains", c, v]); return q; },
      limit: () => q,
      then: (resolve: (v: unknown) => void) => {
        s.reads.push({ table, filters });
        if (s.fail) return resolve({ data: null, error: { message: "boom" } });
        if (table === "documents") {
          const ids = (filters.find((f) => f[0] === "in")?.[2] ?? []) as string[];
          return resolve({ data: s.docs.filter((d) => ids.includes(String(d.id))), error: null });
        }
        if (table === "tickets") {
          const single = filters.find((f) => f[1] === "metadata->source_document->>id");
          const listed = filters.find((f) => f[0] === "contains");
          const rows = s.tickets.filter((t) => {
            const m = t.metadata as Row;
            if (single) return (m.source_document as Row | undefined)?.id === single[2];
            if (listed) {
              const want = (JSON.parse(String(listed[2])) as Row[])[0].id;
              return Array.isArray(m.source_documents) && (m.source_documents as Row[]).some((d) => d.id === want);
            }
            return false;
          });
          return resolve({ data: rows, error: null });
        }
        return resolve({ data: [], error: null, count: 0 });
      },
    };
    return q;
  };
  return { supabase: { from } };
});

import SourceDriftBanner, { driftedSources } from "@/components/requests/SourceDriftBanner";
import { parseSourceDocuments } from "@/lib/sourceDocRef";
import { getDocumentImpact } from "@/lib/impact";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => {
  s.docs = [{ id: "d1", rev: "4", current_version_id: "v4" }, { id: "d2", rev: "2", current_version_id: "v2" }];
  s.tickets = [];
  s.fail = false;
  s.reads = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});
const render = async (metadata: Row | null) => {
  await act(async () => { root!.render(React.createElement(SourceDriftBanner, { metadata, orgId: "o1" })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host!.textContent ?? "";
};

describe("HAND-7 — the source revision has moved", () => {
  it("a request raised against v3 of a document now at v4 shows the banner, naming both revisions", async () => {
    const text = await render({ source_document: { id: "d1", document_number: "P-101", rev: "3", version_id: "v3" } });
    expect(text).toContain("The source revision has moved since this request was raised");
    expect(text).toContain("P-101 was Rev 3 when the request was raised");
    expect(text).toContain("now at Rev 4");
    expect(s.reads[0].filters).toEqual(expect.arrayContaining([["eq", "org_id", "o1"], ["in", "id", ["d1"]]]));
  });

  it("the version still current says nothing — even when the label reads differently", async () => {
    expect(await render({ source_document: { id: "d1", document_number: "P-101", rev: "4-old-label", version_id: "v4" } })).toBe("");
  });

  it("a historical row (no version captured) falls back to the rev label, as the source card does", async () => {
    expect(await render({ source_document: { id: "d1", document_number: "P-101", rev: "3" } })).toContain("now at Rev 4");
    expect(await render({ source_document: { id: "d1", document_number: "P-101", rev: "4" } })).toBe("");
  });

  it("a failed read, an unreadable document and a ticket with no source say nothing", async () => {
    s.fail = true;
    expect(await render({ source_document: { id: "d1", rev: "3", version_id: "v3" } })).toBe("");
    s.fail = false;
    expect(await render({ source_document: { id: "gone", rev: "3", version_id: "v3" } })).toBe("");
    expect(await render({})).toBe("");
  });

  it("GAP-8: every sheet is checked — only the one that moved is named", async () => {
    const text = await render({
      source_document: { id: "d1", document_number: "P-101", rev: "4", version_id: "v4" },
      source_documents: [{ id: "d1", version_id: "v4" }, { id: "d2", document_number: "P-102", rev: "1", version_id: "v1" }],
    });
    expect(text).toContain("P-102 was Rev 1");
    expect(text).not.toContain("P-101 was");
  });

  it("driftedSources is pure over what the register answered", () => {
    const refs = parseSourceDocuments({ source_document: { id: "d1", rev: "3", version_id: "v3" } });
    expect(driftedSources(refs, new Map([["d1", { currentVersionId: "v4", rev: "4" }]]))).toHaveLength(1);
    expect(driftedSources(refs, new Map())).toEqual([]);
  });
});

describe("GAP-8 — the Impact panel lists a ticket on every sheet it names", () => {
  it("a multi-sheet ticket appears in the panel of a non-primary sheet; a single-source ticket exactly as before; no duplicates", async () => {
    s.tickets = [
      { id: "t-multi", ticket_id: "N-1", title: "Markups: 2 sheets", status: "DRAFTING", metadata: { source_document: { id: "d1" }, source_documents: [{ id: "d1" }, { id: "d2" }] } },
      { id: "t-single", ticket_id: "N-2", title: "Single", status: "PENDING_ASSIGNMENT", metadata: { source_document: { id: "d2" } } },
    ];
    const onD2 = await getDocumentImpact("d2", "o1");
    expect(onD2.openTickets.map((t) => t.id).sort()).toEqual(["t-multi", "t-single"]);
    const onD1 = await getDocumentImpact("d1", "o1");
    expect(onD1.openTickets.map((t) => t.id)).toEqual(["t-multi"]);   // found by both reads, listed once
  });
});
