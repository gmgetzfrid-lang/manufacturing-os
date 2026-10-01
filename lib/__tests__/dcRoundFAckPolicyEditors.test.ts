// @vitest-environment jsdom
//
// document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS, final
// review: PKG-9's residual, the editors' half. setAckPolicy can reject — a
// refused save ("…was NOT saved…"), or a save that landed whose rosters were
// not all recomputed (AckRosterRecomputeError) — and AckPolicyModal /
// AckSection awaited it in try/finally with no catch: an unhandled rejection,
// nothing on screen. Both now show the error in plain words; after the
// recompute error (the policy WAS saved) the modal tells its parent and the
// inspector panel leaves the editor and re-reads the policy.
//
// Driven as rendered (jsdom); setAckPolicy is mocked (its behaviour is driven
// in dcRoundFAckPolicyRecompute.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  setAckPolicy: vi.fn(),
}));

vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => {
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: null, error: null });
        return () => new Proxy({}, h);
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: () => chain() } };
});
vi.mock("@/lib/acknowledgments", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/acknowledgments")>();
  return {
    ...real,
    setAckPolicy: (...a: unknown[]) => s.setAckPolicy(...a),
    listRoster: vi.fn(async () => []),
  };
});
vi.mock("@/lib/notifications", () => ({ searchOrgUsers: vi.fn(async () => []) }));
vi.mock("@/lib/teams", () => ({ listTeams: vi.fn(async () => []) }));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ uid: "ctl1", userEmail: "ctl@example.com", activeRole: "DocCtrl", member: { displayName: "Ctl" } }),
}));

import AckPolicyModal from "@/components/documents/AckPolicyModal";
import AckSection from "@/components/documents/AckSection";
import { AckRosterRecomputeError } from "@/lib/acknowledgments";
import type { DocumentRecord } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RECOMPUTE = () => new AckRosterRecomputeError({ level: "library", failedDocumentIds: ["d03", "d25"], total: 45, reason: "statement timeout" });
const SAVED_BUT = "The read-&-understood policy was saved, but 2 of the 45 issued documents it covers did not have their acknowledgment roster recomputed (first error: statement timeout). Save the policy again to retry.";
const REFUSED = "Read-&-understood policy was NOT saved — you don't have authority over this library.";

let host: HTMLDivElement;
let root: Root;
const unhandled: unknown[] = [];
const onUnhandled = (e: PromiseRejectionEvent | unknown) => { unhandled.push(e); };
beforeEach(() => {
  s.setAckPolicy.mockReset().mockResolvedValue(undefined);
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  process.off("unhandledRejection", onUnhandled);
});

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (label: string) => {
  const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.trim() === label || x.textContent?.includes(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
};
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await tick(); };
const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? null;

async function openModal() {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  await act(async () => {
    root.render(React.createElement(AckPolicyModal, { level: "library", id: "L1", orgId: "o1", name: "P&IDs", uid: "ctl1", userName: "ctl@example.com", onClose, onSaved }));
  });
  await tick();
  return { onClose, onSaved };
}

describe("PKG-9 (P14 final review) — AckPolicyModal says what setAckPolicy could not do", () => {
  it("saved, but rosters not recomputed: the message is shown, the parent is told the policy saved, the dialog stays open", async () => {
    s.setAckPolicy.mockRejectedValueOnce(RECOMPUTE());
    const { onClose, onSaved } = await openModal();
    await click(button("Save"));
    expect(alertText()).toBe(SAVED_BUT);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it("a refused save is shown as itself — nothing was saved, so the parent is not told it was", async () => {
    s.setAckPolicy.mockRejectedValueOnce(new Error(REFUSED));
    const { onClose, onSaved } = await openModal();
    await click(button("Save"));
    expect(alertText()).toBe(REFUSED);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(button("Save").disabled).toBe(false);
  });

  it("regression — a save that recomputed every roster closes the dialog as before, with nothing shown", async () => {
    const { onClose, onSaved } = await openModal();
    await click(button("Save"));
    expect(s.setAckPolicy).toHaveBeenCalledWith(expect.objectContaining({ level: "library", id: "L1", orgId: "o1", actorId: "ctl1" }));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(alertText()).toBeNull();
  });
});

describe("PKG-9 (P14 final review) — the inspector's AckSection says it too", () => {
  const doc = { id: "d1", orgId: "o1", libraryId: "L1", collectionId: null, documentNumber: "P-101", title: "P-101", rev: "2", currentVersionId: "v2" } as unknown as DocumentRecord;
  async function openEditor() {
    await act(async () => { root.render(React.createElement(AckSection, { doc, orgId: "o1", canManage: true })); });
    await tick();
    await click(button("Set requirement"));
    expect(button("Save")).toBeTruthy();
  }

  it("saved, but its roster not recomputed: the message is shown and the panel leaves the editor (the policy is saved)", async () => {
    s.setAckPolicy.mockRejectedValueOnce(new AckRosterRecomputeError({ level: "document", failedDocumentIds: ["d1"], total: 1, reason: "Couldn't read the library's read-&-understood policy (statement timeout); the acknowledgment roster was not recomputed." }));
    await openEditor();
    await click(button("Save"));
    expect(alertText()).toMatch(/^The read-&-understood policy was saved, but this document's acknowledgment roster was not recomputed/);
    expect(() => button("Save")).toThrow(); // back in view mode
    expect(unhandled).toEqual([]);
  });

  it("a refused save stays in the editor and says why", async () => {
    s.setAckPolicy.mockRejectedValueOnce(new Error("Read-&-understood policy was NOT saved — you don't have authority over this document."));
    await openEditor();
    await click(button("Save"));
    expect(alertText()).toBe("Read-&-understood policy was NOT saved — you don't have authority over this document.");
    expect(button("Save").disabled).toBe(false);
  });

  it("regression — a save that landed returns to the view, nothing shown", async () => {
    await openEditor();
    await click(button("Save"));
    expect(s.setAckPolicy).toHaveBeenCalledWith(expect.objectContaining({ level: "document", id: "d1" }));
    expect(alertText()).toBeNull();
    expect(() => button("Save")).toThrow();
  });
});
