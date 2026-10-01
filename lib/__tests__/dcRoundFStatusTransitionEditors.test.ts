// @vitest-environment jsdom
//
// document-control Round F wave 2 — P13 STATUS-TRANSITION (REV-18, done-when
// 2): the app's status editors surface the database's refusal of an issue.
//
//   * the metadata editor says, before the save, that saving the status
//     issues the current revision as a controlled copy (and what the
//     database refuses); a refused save keeps the dialog open with the
//     guard's own sentence and says nothing else was saved;
//   * the bulk editor says which selected rows the status change would
//     ISSUE before the apply, then names EVERY refused row (none hidden
//     behind "+N more"), marks the issue rule's refusals, and keeps the
//     other rows (each row is its own write).
//
// Driven as rendered (jsdom) with the refusal the database answers
// (20261144's sentences, the same ones lib/issueStatus.ts recognises).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; payload: Record<string, unknown>; id: string }>,
  answers: {} as Record<string, { data: Array<{ id: string }> | null; error: { message: string } | null }>,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => ({
        eq: (_col: string, val: unknown) => ({
          select: () => {
            s.calls.push({ table, payload, id: String(val) });
            return Promise.resolve(s.answers[String(val)] ?? { data: [{ id: String(val) }], error: null });
          },
        }),
      }),
    }),
  },
}));
vi.mock("@/components/documents/CheckoutStatusCell", () => ({ default: () => null }));
vi.mock("@/components/assets/AssetTagChip", () => ({ default: () => null }));

import MetadataEditor from "@/components/documents/MetadataEditor";
import BulkEditModal from "@/components/documents/BulkEditModal";
import type { DocumentRecord, LibraryConfig } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOLD = "Document has an active hold; release the hold before issuing it.";
const UNREVIEWED = "This library requires reviewer sign-off, so a revision that was not reviewed can't be made a controlled issue; submit it for review, or ask Document Control.";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  s.calls = []; s.answers = {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (label: string) => {
  const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.trim() === label || x.textContent?.includes(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
};
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}
const labelled = (label: string) => {
  const l = Array.from(host.querySelectorAll("label")).find((x) => x.textContent?.trim() === label);
  if (!l) throw new Error(`no label "${label}"`);
  return l.parentElement!.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;
};
const text = () => host.textContent ?? "";

const DRAFT = {
  id: "d1", documentNumber: "P-101", title: "Overhead P&ID", rev: "0", status: "Draft",
  metadata: {}, libraryId: "lib", currentVersionId: "d1-v0",
} as unknown as DocumentRecord;

describe("REV-18 — the metadata editor", () => {
  async function open(onSave: (p: unknown) => Promise<void>, document: DocumentRecord = DRAFT) {
    const onClose = vi.fn();
    await act(async () => {
      root.render(React.createElement(MetadataEditor, {
        isOpen: true, onClose, document, columns: [] as never,
        userRole: "Manager", userRoles: ["Manager", "DocCtrl"], onSave: onSave as never,
      }));
    });
    return onClose;
  }

  it("says nothing while the status is unchanged; says the save ISSUES the revision once an issue status is picked on a Draft with a current revision", async () => {
    await open(vi.fn(async () => {}));
    expect(host.querySelector('[data-testid="issue-transition-note"]')).toBeNull();
    await act(async () => setValue(labelled("Status") as HTMLSelectElement, "Issued"));
    const note = host.querySelector('[data-testid="issue-transition-note"]');
    expect(note?.textContent).toMatch(/Saving issues Rev 0 as a controlled copy/);
    expect(note?.textContent).toMatch(/on hold/);
    expect(note?.textContent).toMatch(/requires reviewer sign-off/);
    // back to a status that is not an issue: the note goes
    await act(async () => setValue(labelled("Status") as HTMLSelectElement, "Void"));
    expect(host.querySelector('[data-testid="issue-transition-note"]')).toBeNull();
  });

  it("no note for a register row with no current revision (nothing to issue) or a document already issued", async () => {
    await open(vi.fn(async () => {}), { ...DRAFT, currentVersionId: undefined } as unknown as DocumentRecord);
    await act(async () => setValue(labelled("Status") as HTMLSelectElement, "Issued"));
    expect(host.querySelector('[data-testid="issue-transition-note"]')).toBeNull();
    await act(async () => root.render(React.createElement("div")));
    await open(vi.fn(async () => {}), { ...DRAFT, status: "Issued" } as unknown as DocumentRecord);
    await act(async () => setValue(labelled("Status") as HTMLSelectElement, "Locked"));
    expect(host.querySelector('[data-testid="issue-transition-note"]')).toBeNull();
  });

  it("a refused issue keeps the dialog open, shows the guard's sentence and says nothing else was saved; retry is possible", async () => {
    const onSave = vi.fn(async () => { throw new Error(`Save refused — nothing was saved: ${HOLD}`); });
    const onClose = await open(onSave);
    await act(async () => setValue(labelled("Status") as HTMLSelectElement, "Issued"));
    await click(button("Save"));
    await tick();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(((onSave.mock.calls[0] as unknown[])[0] as { core: { status: string } }).core.status).toBe("Issued");
    expect(onClose).not.toHaveBeenCalled();
    const alert = host.querySelector('[role="alert"]')!.textContent!;
    expect(alert).toContain(HOLD);
    expect(alert).toMatch(/The status was not changed to Issued, and nothing else in this edit was saved/);
    expect(button("Save").disabled).toBe(false);
  });

  it("the require-mode refusal is shown the same way; a refusal that is not the issue rule is shown as it came", async () => {
    await open(vi.fn(async () => { throw new Error(`Save refused — nothing was saved: ${UNREVIEWED}`); }));
    await act(async () => setValue(labelled("Status") as HTMLSelectElement, "Issued"));
    await click(button("Save"));
    await tick();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(UNREVIEWED);
    await act(async () => root.render(React.createElement("div")));
    await open(vi.fn(async () => { throw new Error("Save refused — nothing was saved: permission denied"); }));
    await click(button("Save"));
    await tick();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Save refused — nothing was saved: permission denied");
  });
});

describe("REV-18 — the bulk editor", () => {
  const LIB = { id: "lib", customColumns: [], uniquenessKeys: ["documentNumber"] } as unknown as LibraryConfig;
  const row = (id: string, status: string, current: boolean) =>
    ({ id, documentNumber: id.toUpperCase(), title: id, rev: "0", status, metadata: {}, currentVersionId: current ? `${id}-v0` : undefined });
  const DOCS = [
    row("a1", "Draft", true),     // issued by Issued — refused (hold)
    row("a2", "Draft", true),     // issued by Issued — applied
    row("a3", "In Review", true), // issued by Issued — refused (unreviewed)
    row("a4", "Draft", false),    // no current revision: not an issue
    row("a5", "Issued", true),    // already an issue
    row("a6", "Void", true),      // issued by Issued — refused (unreviewed)
    row("a7", "Archived", true),  // issued by Issued — refused (hold)
    row("a8", "Draft", true),     // issued by Issued — refused (unreviewed)
    row("a9", "Draft", true),     // issued by Issued — refused (unreviewed)
  ] as unknown as DocumentRecord[];
  async function open(docs = DOCS) {
    await act(async () => {
      root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs, library: LIB, actorUserId: "me" }));
    });
  }

  it("before the apply, names the rows the status change would ISSUE (current revision, not issued yet) — and nothing for a status that is not an issue", async () => {
    await open();
    expect(host.querySelector('[data-testid="bulk-issue-note"]')).toBeNull(); // default value Draft
    await act(async () => setValue(labelled("New value") as HTMLSelectElement, "Issued"));
    const note = host.querySelector('[data-testid="bulk-issue-note"]')!.textContent!;
    expect(note).toMatch(/^7 of the selected rows \(A1, A2, A3, A6, A7, \+2 more\) are not issued yet: setting Issued issues their current revision/);
    expect(note).not.toMatch(/A4|A5/);
    expect(note).toMatch(/A refused row is named after the apply; the others keep the change/);
  });

  it("after the apply, EVERY refused row is named with the database's reason (no '+N more'), the issue rule's refusals are marked, and the other rows were applied", async () => {
    s.answers.a1 = { data: null, error: { message: HOLD } };
    s.answers.a3 = { data: null, error: { message: UNREVIEWED } };
    s.answers.a6 = { data: null, error: { message: UNREVIEWED } };
    s.answers.a7 = { data: null, error: { message: HOLD } };
    s.answers.a8 = { data: null, error: { message: UNREVIEWED } };
    s.answers.a9 = { data: null, error: { message: UNREVIEWED } };
    await open();
    await act(async () => setValue(labelled("New value") as HTMLSelectElement, "Issued"));
    await click(button("Apply to 9"));
    await tick();
    // every row was its own write
    expect(s.calls.map((c) => c.id)).toEqual(DOCS.map((d) => d.id));
    for (const c of s.calls) expect(c.payload.status).toBe("Issued");
    expect(text()).toMatch(/Applied to 3 documents\./); // a2, a4, a5
    const list = host.querySelector('[data-testid="bulk-refused-rows"]')!;
    const items = Array.from(list.querySelectorAll("li")).map((li) => li.textContent);
    expect(items).toEqual([
      `A1 — not issued: ${HOLD}`,
      `A3 — not issued: ${UNREVIEWED}`,
      `A6 — not issued: ${UNREVIEWED}`,
      `A7 — not issued: ${HOLD}`,
      `A8 — not issued: ${UNREVIEWED}`,
      `A9 — not issued: ${UNREVIEWED}`,
    ]);
    expect(text()).not.toMatch(/more<\/li>|\+\d+ more/);
    expect(text()).toMatch(/The other 3 rows were applied — each row is its own write, so nothing was rolled back\./);
  });

  it("a refusal of a row that was not an issue (any other reason) is named as it came, unmarked", async () => {
    s.answers.a5 = { data: null, error: { message: "permission denied for table documents" } };
    await open([DOCS[4]]);
    await act(async () => setValue(labelled("New value") as HTMLSelectElement, "IFC"));
    await click(button("Apply to 1"));
    await tick();
    const items = Array.from(host.querySelectorAll('[data-testid="bulk-refused-rows"] li')).map((li) => li.textContent);
    expect(items).toEqual(["A5 — permission denied for table documents"]);
  });
});
