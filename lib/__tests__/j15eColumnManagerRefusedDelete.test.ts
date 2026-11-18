// @vitest-environment jsdom
//
// projects-joint J15e (projects-tab SAF-22, the integrator's ruling R2) — the
// Column Manager after a column delete the library page refused: the page
// says why (appAlert) and answers `false`; the manager keeps the column in
// its draft view, so Apply does not hide a column that still exists. A
// delete that landed drops it from the draft, as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true) }));

import ColumnManager from "@/components/documents/ColumnManager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function deleteThenApply(answer: boolean | undefined): Promise<string[]> {
  const onChange = vi.fn();
  const onDeleteColumn = vi.fn(async () => answer);
  await act(async () => {
    root.render(React.createElement(ColumnManager, {
      isOpen: true, onClose: () => {}, isController: true,
      columns: [{ key: "title", label: "Title", locked: true }, { key: "a", label: "Area" }],
      active: ["title", "a"], onChange, onDeleteColumn,
    }));
  });
  const del = host.querySelector('button[title="Delete \\"Area\\" column"]') as HTMLButtonElement;
  expect(del).toBeTruthy();
  await act(async () => { del.click(); });
  expect(onDeleteColumn).toHaveBeenCalledWith("a");
  const apply = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Apply") as HTMLButtonElement;
  await act(async () => { apply.click(); });
  return onChange.mock.calls[0][0] as string[];
}

describe("ColumnManager — a refused column delete keeps the column in the view (SAF-22 R2)", () => {
  it("a delete the page refused (false) leaves the column in the draft that Apply sends", async () => {
    expect(await deleteThenApply(false)).toEqual(["title", "a"]);
  });
  it("regression: a delete that landed (true) drops it from the draft, as before", async () => {
    expect(await deleteThenApply(true)).toEqual(["title"]);
  });
  it("regression: a handler that answers nothing (void) is read as landed, as before", async () => {
    expect(await deleteThenApply(undefined)).toEqual(["title"]);
  });
});
