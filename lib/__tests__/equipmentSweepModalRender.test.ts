// @vitest-environment jsdom
//
// intelligence Round G (I-11) fix pass 2 — BR-9, RENDERED: the sweep modal's
// picked-tag actions on a FULLY-APPLIED document.
//
// Every document of a library that "Apply all" has run over reads status
// 'applied' with nothing fresh. That is exactly where a person dismisses a
// machine-read link (a misread tag), takes back a dismissed tag ("pick it and
// apply to take it back"), and where the registry drawer's Unlink sends them
// for a drawing link. The fix-pass-1 modal rendered only the green "applied"
// label there: a picked chip offered no button. Also pinned here: an
// apply's / correction's audit failure stays on screen after the re-read
// (refresh clears the error line first), and the vanished delta marks a
// sheet read off an AI transcription as unconfirmed (GOV-9).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement("a", { href }, children) }));
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } } }));
vi.mock("@/lib/codebook", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/codebook")>();
  return { ...real, loadCodebook: async () => real.EMPTY_CODEBOOK };
});
vi.mock("@/components/assets/CoverageReport", () => ({ default: () => null }));

import EquipmentSweepModal from "@/components/documents/EquipmentSweepModal";

type Body = Record<string, unknown>;
const st = {
  posts: [] as Body[],
  postAnswer: (_b: Body): Body => ({ ok: true }),
};

const LISTING = {
  suggestions: [{
    document_id: "d1", documentLabel: "2002-D-10001", status: "applied", applied: ["E-22", "V-101"],
    suggested: [
      { tag: "E-22", code: null, pages: [1], assetId: "a-e22", assetStatus: "existing", appliedColumn: "equipment" },
      { tag: "V-101", code: null, pages: [1], assetId: "a-v101", assetStatus: "existing", appliedColumn: "equipment" },
      { tag: "P-7", code: null, pages: [2], assetId: null, assetStatus: "new", dismissed: true },
    ],
  }],
  relations: [{ document_id: "d1", tag_text: "V-101", sheet_label: "2002-D-10001 SHT 5", vanished_at: "2026-10-01T00:00:00Z", superseded_at: null, source_revision: "B", model: "vision-model-x" }],
  relationNote: null,
  linkedDocs: [{ documentId: "d1", status: "ready" }],
  unreadable: 0, uploadOrigin: 0,
  bridge: { targetColumnKey: "equipment" },
  customColumns: [{ key: "equipment", type: "tags" }],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  st.posts = [];
  st.postAnswer = () => ({ ok: true });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Body;
      st.posts.push(body);
      return { ok: true, json: async () => st.postAnswer(body) };
    }
    return { ok: true, json: async () => LISTING };
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function open() {
  await act(async () => {
    root.render(React.createElement(EquipmentSweepModal, { orgId: "o1", libraryId: "lib1", libraryName: "P&IDs", onClose: () => {}, onApplied: () => {} }));
  });
  await settle();
}
const button = (starts: string) => [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(starts)) as HTMLButtonElement | undefined;
const chip = (tag: string) => [...container.querySelectorAll("button[aria-pressed]")].find((b) => (b.textContent ?? "").trim() === tag) as HTMLButtonElement;
const click = async (b: HTMLButtonElement) => { await act(async () => { b.click(); }); await settle(); };

describe("BR-9 — the picked-tag actions on a fully-applied document", () => {
  it("picking an applied chip offers Dismiss beside the 'applied' label, and Dismiss posts action 'dismiss' with that tag", async () => {
    await open();
    expect(container.textContent).toContain("applied");
    expect(button("Dismiss")).toBeUndefined();
    await click(chip("E-22"));
    // Reproduction: the fix-pass-1 modal showed only the label — no button for the picked chip.
    expect(button("Dismiss 1")).toBeDefined();
    expect(button("Apply 1 picked")).toBeDefined();
    expect(container.textContent).toContain("applied");
    st.postAnswer = () => ({ ok: true, dismissed: ["E-22"], relationsRemoved: 1, remembered: true });
    await click(button("Dismiss 1")!);
    expect(st.posts).toEqual([{ orgId: "o1", action: "dismiss", documentId: "d1", tags: ["E-22"] }]);
  });
  it("picking a dismissed chip offers Apply ('pick it and apply to take it back'), which posts the tag", async () => {
    await open();
    expect(chip("P-7").getAttribute("title")).toMatch(/dismissed — pick it and apply to take it back/);
    await click(chip("P-7"));
    st.postAnswer = () => ({ ok: true, results: [{ documentId: "d1", appliedTags: ["P-7"], createdAssets: 1, relations: { written: 1 } }], unreadable: 0 });
    await click(button("Apply 1 picked")!);
    expect(st.posts).toEqual([{ action: "apply", orgId: "o1", documentIds: ["d1"], tags: ["P-7"] }]);
  });
  it("an apply or a dismissal whose audit row was refused stays on screen after the re-read", async () => {
    await open();
    await click(chip("E-22"));
    st.postAnswer = () => ({ ok: true, dismissed: ["E-22"], relationsRemoved: 1, remembered: true, auditError: "The dismissal was saved, but its audit record could not be written: refused" });
    await click(button("Dismiss 1")!);
    expect(container.textContent).toContain("its audit record could not be written");
    await click(chip("P-7"));
    st.postAnswer = () => ({ ok: true, results: [{ documentId: "d1", appliedTags: ["P-7"], auditError: "The tags were applied, but the audit record could not be written: refused" }], unreadable: 0 });
    await click(button("Apply 1 picked")!);
    expect(container.textContent).toContain("The tags were applied, but the audit record could not be written");
  });
});

describe("GOV-9 — the vanished delta marks a sheet read off an AI transcription", () => {
  it("'was on <sheet> (AI-read, unconfirmed)'", async () => {
    await open();
    const delta = container.querySelector("[data-testid=vanished-delta]")!;
    expect(delta.textContent).toContain("V-101 is no longer read on the current revision (was on 2002-D-10001 SHT 5 (AI-read, unconfirmed), read from Rev B)");
  });
});
