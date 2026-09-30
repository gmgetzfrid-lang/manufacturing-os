// @vitest-environment jsdom
//
// projects Round G — PT SCH-2 done-when 2 / GAP-403 acceptance 2: the plan the
// user reviews is the change set "Import N changes" writes. The modal's column
// review (include / rename / map-to) feeds the rows the importer receives, so
// any change to it after "Review changes" discards the reviewed plan and the
// user reviews again — "Import N changes" never writes a set nobody saw.
//
// Rendered with react-dom in jsdom; the importer is mocked (the plan itself is
// scheduleImportWriters.test.ts's subject), the parser is real.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Call = { dryRun?: boolean; rows: Array<{ name: string; attributes?: Record<string, unknown> | null; responsibleParty?: string | null; startHasTime?: boolean }> };
const calls = vi.hoisted(() => [] as Call[]);
vi.mock("@/lib/milestones", () => ({
  importMilestonesFromParsed: vi.fn(async (input: Call) => {
    calls.push(input);
    return {
      inserted: 0, updated: 0, skipped: 0, errors: [], batchId: "b1",
      plan: {
        added: 0, changed: 0, unchanged: input.rows.length, notInFile: 0, notInFileNames: [], localProgressAtRisk: [],
        structure: { rows: 0, onlyStructure: 0, parents: 0, linksAdded: 0, linksRemoved: 0 }, rekeyed: 0, rekeyedOnly: 0, rowCap: 5000,
      },
    };
  }),
}));

import ScheduleImportModal from "@/components/projects/ScheduleImportModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const csv = [
  "ID,Name,Start,Finish,Contractor",
  "1,Scaffold,2026-06-01 08:00,2026-06-01 17:00,Acme",
  "2,Paint,2026-06-02,2026-06-03,Acme",
].join("\n");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  calls.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const buttonNamed = (re: RegExp) => Array.from(host.querySelectorAll("button")).find((b) => re.test(b.textContent ?? "")) ?? null;
const flush = () => act(async () => { await Promise.resolve(); });

async function openWithFile() {
  await act(async () => {
    root.render(createElement(ScheduleImportModal, { orgId: "o1", projectId: "p1", userId: "u1", onClose: () => {}, onDone: () => {} }));
  });
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  const bytes = new TextEncoder().encode(csv);
  const file = new File([bytes], "plan.csv", { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  Object.defineProperty(input, "files", { value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
}

async function review() {
  const btn = buttonNamed(/Review changes/);
  expect(btn, "Review changes is offered").not.toBeNull();
  await act(async () => { btn!.click(); });
  await flush();
  expect(buttonNamed(/^Import \d+ changes?$/), "the reviewed plan offers the write").not.toBeNull();
}

function setNativeValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
}

describe("SCH-2 · a column change after 'Review changes' discards the reviewed plan", () => {
  it("unticking a column: the Import button goes, Review is offered again, and the new review sends the new rows", async () => {
    await openWithFile();
    await review();
    expect(calls).toHaveLength(1);
    expect(calls[0].dryRun).toBe(true);
    expect(calls[0].rows[0].attributes).toEqual({ contractor: "Acme" }); // the parser keys extra columns by the lower-cased header
    // SCHED-9: the parser's time-of-day flag reaches the importer.
    expect(calls[0].rows.map((r) => r.startHasTime)).toEqual([true, false]);

    const include = host.querySelector('input[type="checkbox"][title="Include this column"]') as HTMLInputElement;
    await act(async () => { include.click(); });
    expect(buttonNamed(/^Import \d+ changes?$/)).toBeNull();
    expect(buttonNamed(/Review changes/)).not.toBeNull();

    await review();
    expect(calls).toHaveLength(2);
    expect(calls[1].rows[0].attributes).toBeUndefined();
  });

  it("renaming a column or mapping it to a field discards the plan the same way", async () => {
    await openWithFile();
    await review();
    const rename = host.querySelector('input[placeholder="contractor"]') as HTMLInputElement;
    expect(rename).not.toBeNull();
    await act(async () => {
      setNativeValue(rename, "Vendor");
      rename.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(buttonNamed(/^Import \d+ changes?$/)).toBeNull();
    await review();
    expect(calls.at(-1)!.rows[0].attributes).toEqual({ Vendor: "Acme" });

    const mapTo = host.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      setNativeValue(mapTo, "responsibleParty");
      mapTo.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(buttonNamed(/^Import \d+ changes?$/)).toBeNull();
    await review();
    expect(calls.at(-1)!.rows[0]).toMatchObject({ responsibleParty: "Acme" });
    expect(calls.at(-1)!.rows[0].attributes).toBeUndefined();
  });

  it("'Choose another' drops the plan with the file", async () => {
    await openWithFile();
    await review();
    await act(async () => { buttonNamed(/Choose another/)!.click(); });
    expect(buttonNamed(/^Import \d+ changes?$/)).toBeNull();
    expect(host.textContent).toMatch(/Drop your schedule here/);
  });
});
