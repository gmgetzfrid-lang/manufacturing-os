// @vitest-environment jsdom
//
// document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS, review
// fix: roles-and-permissions GAP-9's inspector read, AS RENDERED.
//
//   InspectorPanel is also P15's file (DIST-9's stale-holder banner), so P14's
//   GAP-9 change there is kept to one import, one hook call and one pill; the
//   read itself is useFieldVerification, beside VerificationPill. This drives
//   the hook through a rendered pill: the currency it reads is shown, a read
//   that throws is "unknown" (never "never verified"), a document with no
//   library reads nothing, and a later document's answer is never overwritten
//   by an earlier one's.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  load: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/reviewCycles", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewCycles")>();
  return { ...real, loadFieldVerification: (...a: unknown[]) => s.load(...a) };
});

import VerificationPill, { useFieldVerification } from "@/components/documents/VerificationPill";
import type { ReviewPolicy } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Doc = { id?: string | null; libraryId?: string | null; collectionId?: string | null; reviewPolicy?: ReviewPolicy | null };
function Probe({ doc }: { doc: Doc | null }) {
  const v = useFieldVerification(doc);
  return React.createElement(VerificationPill, { verification: v });
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.load.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (doc: Doc | null) => act(async () => { root.render(React.createElement(Probe, { doc })); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const pill = () => host.querySelector("span");

describe("GAP-9 (P14 review fix) — the inspector's read lives in useFieldVerification", () => {
  it("shows the currency the read returns, asked with the document's own policy chain", async () => {
    s.load.mockResolvedValue({ verifiedAt: "2026-09-01T12:00:00.000Z", rev: "3", by: "Ann", supersededBy: null, nextVerificationDate: "2029-09-01", status: "current", cadence: "Every 3 years" });
    await render({ id: "d1", libraryId: "L1", collectionId: "c1", reviewPolicy: null });
    await settle();
    expect(s.load).toHaveBeenCalledWith({ id: "d1", reviewPolicy: null, collectionId: "c1", libraryId: "L1" });
    expect(pill()?.textContent).toContain("Field-verified · current to 2029-09-01");
  });

  it("a read that THROWS is unknown, with its reason — never 'never verified'", async () => {
    s.load.mockRejectedValue(new Error("statement timeout"));
    await render({ id: "d1", libraryId: "L1" });
    await settle();
    expect(pill()?.textContent).toContain("Field verification unknown");
    expect(pill()?.getAttribute("title")).toContain("Currency unknown: statement timeout.");
    expect(pill()?.textContent).not.toMatch(/Never/);
  });

  it("no document, or one with no library: nothing is read and nothing is shown", async () => {
    await render(null);
    await settle();
    await render({ id: "d1", libraryId: null });
    await settle();
    expect(s.load).not.toHaveBeenCalled();
    expect(pill()).toBeNull();
  });

  it("switching documents: the earlier document's late answer never lands on the later one", async () => {
    let releaseFirst: (v: unknown) => void = () => {};
    s.load.mockImplementationOnce(() => new Promise((r) => { releaseFirst = r; }));
    s.load.mockResolvedValueOnce({ verifiedAt: null, rev: null, by: null, supersededBy: null, nextVerificationDate: null, status: "never", cadence: "Every 3 years" });
    await render({ id: "d1", libraryId: "L1" });
    await render({ id: "d2", libraryId: "L1" });
    await settle();
    expect(pill()?.textContent).toContain("Never field-verified");
    await act(async () => { releaseFirst({ verifiedAt: "2026-09-01T12:00:00.000Z", rev: "9", by: "Old", supersededBy: null, nextVerificationDate: "2029-09-01", status: "current", cadence: null }); });
    await settle();
    expect(pill()?.textContent).toContain("Never field-verified");
  });
});
