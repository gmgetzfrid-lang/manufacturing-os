// @vitest-environment jsdom
//
// projects-tab SAF-18 — the J15 checked-write sweep, batch J15a: the callers
// of every function whose failure mode changed (DEC-90 ruling 3). A refusal
// the data layer now throws is caught and said in plain language on the
// surface's own error display — never an unhandled rejection.
//
//   Rendered: the folder customize modal and the folder home board (the lost
//   attempt's review MAJOR — updateCollectionAppearance /
//   updateCollectionHomeConfig threw through onSave with no catch).
//   Pinned: the inspector panels and the library page handlers, each now a
//   try / catch to appAlert (or the page's error line).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const s = vi.hoisted(() => ({ toasts: [] as Array<Record<string, unknown>>, alerts: [] as Array<Record<string, unknown>> }));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: (t: Record<string, unknown>) => { s.toasts.push(t); } }) }));
vi.mock("@/components/providers/DialogProvider", () => ({
  appAlert: vi.fn(async (o: Record<string, unknown>) => { s.alerts.push(o); }),
  appConfirm: vi.fn(async () => true), appPrompt: vi.fn(async () => null),
}));
vi.mock("@/components/ui/CornerDock", () => ({ useDockAvoid: () => undefined, useDockRaise: () => undefined }));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn() }));
vi.mock("@/components/documents/NodeCover", () => ({ default: () => null }));

import CustomizeNodeModal from "@/components/documents/CustomizeNodeModal";
import LibraryHomeBoard from "@/components/documents/LibraryHomeBoard";
import { CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const REFUSAL = `The folder's appearance was not saved. ${CHECKED_WRITE_REFUSED}`;

let host: HTMLDivElement;
let root: Root;
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => { unhandled.push(e); };
beforeEach(() => {
  s.toasts.length = 0; s.alerts.length = 0; unhandled.length = 0;
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
const click = async (label: RegExp) => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => label.test(x.textContent ?? ""));
  if (!b) throw new Error(`no button ${label}`);
  await act(async () => { b.click(); });
  await tick();
};

describe("CustomizeNodeModal — a refused appearance save is said; the modal stays open", () => {
  it("onSave rejects: an error toast with the refusal, onClose not called, no unhandled rejection", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn(async () => { throw new Error(REFUSAL); });
    await act(async () => { root.render(React.createElement(CustomizeNodeModal, { open: true, initial: {}, onClose, onSave })); });
    await click(/^\s*Save\s*$/);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(s.toasts).toEqual([{ type: "error", title: "Not saved", message: REFUSAL }]);
    expect(unhandled).toEqual([]);
  });
  it("a landed save closes as before, with no toast", async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(React.createElement(CustomizeNodeModal, { open: true, initial: {}, onClose, onSave: async () => undefined })); });
    await click(/^\s*Save\s*$/);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(s.toasts).toEqual([]);
  });
});

describe("LibraryHomeBoard — a refused home save is said; the editor stays open", () => {
  const render = (onSave: () => Promise<void>) => act(async () => {
    root.render(React.createElement(LibraryHomeBoard, { node: { name: "F" }, folders: [], documents: [], canEdit: true, onOpenFolder: () => undefined, onOpenDoc: () => undefined, onSave }));
  });
  it("Save and Turn off home: onSave rejects → appAlert with the refusal, still editing, no unhandled rejection", async () => {
    const refusal = `The folder's home was not saved. ${CHECKED_WRITE_REFUSED}`;
    const onSave = vi.fn(async () => { throw new Error(refusal); });
    await render(onSave);
    await click(/Set up a custom home/);
    await click(/^\s*Save\s*$/);
    expect(s.alerts).toEqual([{ message: refusal, tone: "danger" }]);
    expect(document.body.textContent).toMatch(/Turn off home/);
    await click(/Turn off home/);
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(s.alerts).toHaveLength(2);
    expect(unhandled).toEqual([]);
  });
  it("a landed save leaves the editor as before, with no alert", async () => {
    await render(async () => undefined);
    await click(/Set up a custom home/);
    await click(/^\s*Save\s*$/);
    expect(s.alerts).toEqual([]);
    expect(document.body.textContent).not.toMatch(/Turn off home/);
  });
});

describe("the other callers catch the new refusals and say them (pins)", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("the inspector panels: waive, mark reviewed, origin, activate alternate, retention policy — each a catch to appAlert", () => {
    expect(src("components/documents/AckSection.tsx")).toMatch(/await waiveAcknowledgment\([^;]*\); await load\(\); \}\s*\n\s*catch \(e\) \{[\s\S]{0,200}?await appAlert\(\{ message: \(e as Error\)\?\.message \|\| "The acknowledgment could not be waived\.", tone: "danger" \}\);/);
    expect(src("components/documents/ReviewSection.tsx")).toMatch(/await markReviewed\([\s\S]{0,320}?\} catch \(e\) \{[\s\S]{0,200}?await appAlert\(\{ message: \(e as Error\)\?\.message \|\| "The review could not be recorded\.", tone: "danger" \}\);/);
    const origin = src("components/documents/OriginSection.tsx");
    expect(origin).toMatch(/import \{ appAlert \} from "@\/components\/providers\/DialogProvider";/);
    expect(origin).toMatch(/await setDocumentOrigin\([\s\S]{0,320}?\} catch \(e\) \{[\s\S]{0,200}?await appAlert\(\{ message: \(e as Error\)\?\.message \|\| "The document's origin could not be saved\.", tone: "danger" \}\);/);
    expect(src("components/documents/ReviewGateSection.tsx")).toMatch(/await activateAlternate\([^;]*\); await load\(\); \}\s*\n\s*catch \(e\) \{[\s\S]{0,200}?await appAlert\(\{ message: \(e as Error\)\?\.message \|\| "The alternate could not be activated\.", tone: "danger" \}\);/);
    for (const f of ["components/documents/RetentionPolicyModal.tsx", "components/documents/RetentionSection.tsx"]) {
      const m = src(f).match(/await setRetentionPolicy\([^;]*\);[^\n]*\n[\s\S]{0,260}?catch \(e\) \{?\s*(?:\/\/[^\n]*\n\s*)?await appAlert\(/g) ?? [];
      expect(m.length, f).toBe(2);
    }
  });
  it("the library page: a refused rename / reorder says why on its error line", () => {
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(page).toMatch(/await renameFolderAndDescendants\(renameFolderId, name\);[\s\S]{0,260}?setError\(e instanceof Error && e\.message \? e\.message : "Failed to rename folder\."\);/);
    expect(page).toMatch(/await reorderFolders\(siblings\);[\s\S]{0,260}?setError\(e instanceof Error && e\.message \? `Couldn't reorder that folder: \$\{e\.message\}` : "Couldn't reorder that folder\."\);/);
  });
  it("the callers that already caught (verified one by one): collections, views, doc class, renumber, label correction, photos, follow", () => {
    expect(src("components/documents/CollectionModal.tsx").match(/await (?:updateCollection|deleteCollection|removeItem|reorderItems)\(/g)?.length).toBe(5);
    expect(src("components/documents/ViewSelector.tsx")).toMatch(/try \{ await deleteView\(id\); void refresh\(\); \} catch \(e\) \{ showToast/);
    expect(src("components/documents/DocClassControl.tsx")).toMatch(/await setDocClass\([\s\S]{0,300}?\} catch \(e\) \{\s*\n\s*setDeclared\(prev\);\s*\n\s*showToast/);
    expect(src("components/documents/lifecycle/RenumberModal.tsx")).toMatch(/await renumberDocument\([\s\S]{0,200}?\} catch \(e\) \{\s*\n\s*setError\(\(e as Error\)\.message\);/);
    expect(src("components/documents/VersionHistoryPanel.tsx")).toMatch(/await correctRevisionLabel\([\s\S]{0,400}?\} catch \(e\) \{\s*\n\s*setLabelError\(\(e as Error\)\.message\);/);
    expect(src("app/(protected)/admin/assets/page.tsx")).toMatch(/await updatePhoto\(p\.id, \{ status \}, userId\);[\s\S]{0,140}?\} catch \(e\) \{ await appAlert\(/);
    expect(src("components/ui/WatchButton.tsx")).toMatch(/await unwatch\(\{ userId, resourceType, resourceId \}\);\s*\n\s*setState\("off"\);[\s\S]{0,200}?\} catch \(e\) \{\s*\n\s*console\.warn\("\[WatchButton\] toggle failed", e\);/);
  });
});
