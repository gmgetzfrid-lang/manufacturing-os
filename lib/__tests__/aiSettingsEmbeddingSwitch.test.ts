// @vitest-environment jsdom
//
// intelligence Round G — I-20, AI settings as RENDERED.
//
//   SEM-1 done-when 2 — saving a different embedding model or provider
//     confirms first, naming the libraries: a meaning index lives in one
//     model's vector space, and a question is embedded with each index's own
//     model on the asker's key (planQueryEmbedding). So a PROVIDER switch
//     stops every index the old provider built from answering this member;
//     a MODEL switch within a provider keeps them answering but no build with
//     the new model can add to them; and the background builds on this key
//     hold. Declining saves nothing. After the switch each library's Rebuild
//     is linked.
//   GOV-14 done-when 4 — one place lists every background build running on
//     the member's key, each with a Stop (the route's release action); a list
//     that cannot be read says so, never "none running".
//
// REGRESSION: saving the same provider and model (a new key, or nothing new)
// asks nothing and reads nothing first — it saves exactly as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const kn = vi.hoisted(() => ({
  saveEmbeddingKey: vi.fn(async () => ({ ok: true })),
  releaseBackgroundBuild: vi.fn(async () => ({ released: true })),
}));
const ov = vi.hoisted(() => ({ getEmbedKeyOverview: vi.fn() }));
const dialog = vi.hoisted(() => ({ appConfirm: vi.fn(async (_o: { title: string; message: unknown; confirmLabel?: string }) => true) }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/lib/knowledge", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/knowledge")>();
  return {
    getAiConnections: vi.fn(), saveAiConnection: vi.fn(), testAiConnection: vi.fn(), removeAiConnection: vi.fn(),
    saveEmbeddingKey: kn.saveEmbeddingKey, removeEmbeddingKey: vi.fn(), testEmbeddingKey: vi.fn(),
    getAiUsage: vi.fn(), setAiCap: vi.fn(),
    releaseBackgroundBuild: kn.releaseBackgroundBuild, releaseOutcome: real.releaseOutcome,
  };
});
vi.mock("@/lib/embedKeyOverview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/embedKeyOverview")>()),
  getEmbedKeyOverview: ov.getEmbedKeyOverview,
}));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => toast }));
vi.mock("@/components/providers/DialogProvider", () => dialog);
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));

import { EmbeddingKeyEditor, BuildsOnMyKey } from "@/components/knowledge/AiSettingsModal";
import { EMBEDDING_PROVIDERS } from "@/lib/ai/embeddings";
import {
  embeddingSwitchImpact, effectiveEmbeddingSetting, switchImpactIsEmpty, librariesToRebuild,
  type EmbedKeyOverview,
} from "@/lib/embedKeyOverview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Model names come from the catalogue, never spelled out here.
const VOYAGE = EMBEDDING_PROVIDERS.find((p) => p.id === "voyage")!.models;
const OPENAI = EMBEDDING_PROVIDERS.find((p) => p.id === "openai")!.models;
const SAVED = {
  provider: "anthropic", model: "chat-model-a", keyLast4: "abcd", updatedAt: "2026-10-01T00:00:00Z",
  embeddingProvider: "voyage", embeddingModel: VOYAGE[1], embeddingKeyLast4: "wxyz",
};
const build = (libraryId: string, libraryName: string, over: Record<string, unknown> = {}) => ({
  libraryId, libraryName, standing: false, startedAt: "2026-09-01T00:00:00Z", lastDrainAt: null,
  blockedUntil: null, blockedReason: null, lastError: null, completedAt: null, ...over,
});
/** Standards: built with the saved model; P&IDs: the saved model, with a
 *  build on this key; Vendor: another provider; Empty: no vectors. */
const OVERVIEW: EmbedKeyOverview = {
  builds: [build("L-pid", "P&IDs")],
  indexes: [
    { libraryId: "L-std", libraryName: "Standards", models: { [VOYAGE[1]]: 900 } },
    { libraryId: "L-pid", libraryName: "P&IDs", models: { [VOYAGE[1]]: 40 } },
    { libraryId: "L-ven", libraryName: "Vendor manuals", models: { [OPENAI[0]]: 12 } },
    { libraryId: "L-new", libraryName: "Empty", models: {} },
  ],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  kn.saveEmbeddingKey.mockClear();
  kn.releaseBackgroundBuild.mockClear();
  ov.getEmbedKeyOverview.mockReset();
  ov.getEmbedKeyOverview.mockResolvedValue(OVERVIEW);
  dialog.appConfirm.mockReset();
  dialog.appConfirm.mockResolvedValue(true);
  toast.showToast.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }); };
async function renderEditor(current: Record<string, unknown> | null = SAVED) {
  await act(async () => { root.render(React.createElement(EmbeddingKeyEditor, { orgId: "o1", current: current as never, onChanged: () => undefined })); });
  await settle();
}
async function choose(index: number, value: string) {
  const select = host.querySelectorAll("select")[index] as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => { setter.call(select, value); select.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function typeKey(value: string) {
  const input = host.querySelector('input[type="password"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function save() {
  const btn = [...host.querySelectorAll("button")].find((b) => /Verify & save/.test(b.textContent ?? ""))!;
  await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}
/** The confirm's message, rendered to text (it is a React node). */
async function confirmText(call = 0): Promise<string> {
  const node = dialog.appConfirm.mock.calls[call][0].message as React.ReactElement;
  const box = document.createElement("div");
  const r = createRoot(box);
  await act(async () => { r.render(node); });
  const text = box.textContent ?? "";
  act(() => r.unmount());
  return text;
}

describe("SEM-1 — the impact of a switch, read from the libraries (pure)", () => {
  const before = effectiveEmbeddingSetting(SAVED)!;
  it("the setting in effect: the saved provider and model; an OpenAI chat key's default; otherwise none", () => {
    expect(before).toEqual({ provider: "voyage", model: VOYAGE[1] });
    expect(effectiveEmbeddingSetting({ ...SAVED, embeddingModel: null })).toEqual({ provider: "voyage", model: VOYAGE[0] });
    expect(effectiveEmbeddingSetting({ provider: "openai", embeddingProvider: null })).toEqual({ provider: "openai", model: OPENAI[0] });
    expect(effectiveEmbeddingSetting({ provider: "anthropic", embeddingProvider: null })).toBeNull();
  });
  it("the same provider and model is no switch (null) — nothing to ask", () => {
    expect(embeddingSwitchImpact(before, { ...before }, OVERVIEW)).toBeNull();
    expect(embeddingSwitchImpact(null, { provider: "openai", model: OPENAI[0] }, OVERVIEW)).toBeNull();
  });
  it("a provider switch: the old provider's indexes stop answering; the build on this key stops; the other provider's index and an empty one are untouched", () => {
    const i = embeddingSwitchImpact(before, { provider: "openai", model: OPENAI[0] }, OVERVIEW)!;
    expect(i.providerChanged).toBe(true);
    expect(i.stopAnswering.map((l) => l.libraryName)).toEqual(["Standards", "P&IDs"]);
    expect(i.cannotGrow).toEqual([]);
    expect(i.buildsStop.map((l) => l.libraryName)).toEqual(["P&IDs"]);
    expect(librariesToRebuild(i).map((l) => l.libraryId)).toEqual(["L-std", "L-pid"]);
  });
  it("a model switch within the provider: the old model's indexes keep answering but cannot grow; the build stops", () => {
    const i = embeddingSwitchImpact(before, { provider: "voyage", model: VOYAGE[2] }, OVERVIEW)!;
    expect(i.providerChanged).toBe(false);
    expect(i.stopAnswering).toEqual([]);
    expect(i.cannotGrow.map((l) => l.libraryName)).toEqual(["Standards", "P&IDs"]);
    expect(i.buildsStop.map((l) => l.libraryName)).toEqual(["P&IDs"]);
  });
  it("a library whose vectors could not be read is named as unknown; an unreadable overview makes the warning general — never 'nothing affected'", () => {
    const i = embeddingSwitchImpact(before, { provider: "voyage", model: VOYAGE[2] }, { builds: [], indexes: [{ libraryId: "L-x", libraryName: "Big library", models: null }] })!;
    expect(i.unknown.map((l) => l.libraryName)).toEqual(["Big library"]);
    expect(switchImpactIsEmpty(i)).toBe(false);
    const u = embeddingSwitchImpact(before, { provider: "voyage", model: VOYAGE[2] }, null, "HTTP 500")!;
    expect(u.unreadable).toBe("HTTP 500");
    expect(switchImpactIsEmpty(u)).toBe(false);
  });
  it("a switch that touches no index and no build is empty — nothing to warn about", () => {
    const i = embeddingSwitchImpact(before, { provider: "voyage", model: VOYAGE[2] }, { builds: [], indexes: [{ libraryId: "L-new", libraryName: "Empty", models: {} }] })!;
    expect(switchImpactIsEmpty(i)).toBe(true);
  });
});

describe("SEM-1 done-when 2 — switching the embedding model or provider confirms, names the libraries and offers the Rebuild", () => {
  it("reproduction → fix: another provider → the confirm names the libraries whose index stops answering and the build that stops; declining saves nothing", async () => {
    await renderEditor();
    await choose(0, "openai");
    dialog.appConfirm.mockResolvedValueOnce(false);
    await save();
    expect(ov.getEmbedKeyOverview).toHaveBeenCalledWith("o1", { models: true });
    expect(dialog.appConfirm).toHaveBeenCalledTimes(1);
    expect(dialog.appConfirm.mock.calls[0][0]).toMatchObject({ title: "Switch your embeddings provider?", confirmLabel: "Switch" });
    const text = await confirmText();
    expect(text).toContain(`You are switching from ${VOYAGE[1]} (Voyage AI) to ${OPENAI[0]} (OpenAI).`);
    expect(text).toMatch(/These meaning indexes stop answering your questions\. They were built with Voyage AI, and an OpenAI key cannot search them:StandardsP&IDs/);
    expect(text).toMatch(/The background builds on your key stop \(held for a model conflict\) in:P&IDs/);
    expect(text).not.toMatch(/Vendor manuals|Empty/);
    expect(text).toMatch(/Each one comes back with a Rebuild of that library's index with/);
    expect(text).toMatch(/Keyword search is unaffected\./);
    expect(kn.saveEmbeddingKey).not.toHaveBeenCalled();
    expect(host.querySelector("[data-rebuild-offer]")).toBeNull();
  });

  it("confirming saves the switch, then links each library's Rebuild (the libraries the confirm named, once each)", async () => {
    await renderEditor();
    await choose(0, "openai");
    await typeKey("sk-new-key-1234");
    await save();
    expect(kn.saveEmbeddingKey).toHaveBeenCalledWith(expect.objectContaining({ embeddingProvider: "openai", embeddingModel: OPENAI[0], embeddingApiKey: "sk-new-key-1234" }));
    const offer = host.querySelector("[data-rebuild-offer]")!;
    expect(offer.textContent).toMatch(new RegExp(`Rebuild to search and grow these with ${OPENAI[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect([...offer.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Standards", "/knowledge/L-std"],
      ["P&IDs", "/knowledge/L-pid"],
    ]);
  });

  it("another model of the same provider: the confirm says the indexes keep answering but stop growing — never that they stop answering", async () => {
    await renderEditor();
    await choose(1, VOYAGE[2]);
    await save();
    expect(dialog.appConfirm.mock.calls[0][0]).toMatchObject({ title: "Switch your embedding model?" });
    const text = await confirmText();
    expect(text).toMatch(/These keep answering, but stop growing for you\./);
    expect(text).toMatch(/StandardsP&IDs/);
    expect(text).not.toMatch(/stop answering your questions/);
    expect(kn.saveEmbeddingKey).toHaveBeenCalledWith(expect.objectContaining({ embeddingProvider: "voyage", embeddingModel: VOYAGE[2] }));
  });

  it("an overview that cannot be read still warns, in general terms, before anything is saved", async () => {
    ov.getEmbedKeyOverview.mockRejectedValueOnce(new Error("Couldn't read this workspace's libraries"));
    await renderEditor();
    await choose(0, "openai");
    dialog.appConfirm.mockResolvedValueOnce(false);
    await save();
    const text = await confirmText();
    expect(text).toMatch(/Which libraries are affected could not be checked \(Couldn't read this workspace's libraries\)\. Every meaning index built with Voyage AI stops answering your questions\./);
    expect(kn.saveEmbeddingKey).not.toHaveBeenCalled();
  });

  it("a switch no library is touched by saves without asking", async () => {
    ov.getEmbedKeyOverview.mockResolvedValueOnce({ builds: [], indexes: [{ libraryId: "L-new", libraryName: "Empty", models: {} }] });
    await renderEditor();
    await choose(1, VOYAGE[2]);
    await save();
    expect(dialog.appConfirm).not.toHaveBeenCalled();
    expect(kn.saveEmbeddingKey).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-rebuild-offer]")).toBeNull();
  });

  it("REGRESSION: saving the same provider and model (a new key only) asks nothing and reads nothing first", async () => {
    await renderEditor();
    await typeKey("pa-new-key-9876");
    await save();
    expect(ov.getEmbedKeyOverview).not.toHaveBeenCalled();
    expect(dialog.appConfirm).not.toHaveBeenCalled();
    expect(kn.saveEmbeddingKey).toHaveBeenCalledWith(expect.objectContaining({ embeddingProvider: "voyage", embeddingModel: VOYAGE[1], embeddingApiKey: "pa-new-key-9876" }));
    expect(host.querySelector("[data-rebuild-offer]")).toBeNull();
  });

  it("REGRESSION: a first embeddings key (nothing in effect before) asks nothing", async () => {
    await renderEditor({ ...SAVED, embeddingProvider: null, embeddingModel: null, embeddingKeyLast4: null });
    await typeKey("pa-first-key-0000");
    await save();
    expect(ov.getEmbedKeyOverview).not.toHaveBeenCalled();
    expect(dialog.appConfirm).not.toHaveBeenCalled();
    expect(kn.saveEmbeddingKey).toHaveBeenCalledTimes(1);
  });
});

describe("GOV-14 done-when 4 — every background build on my key, in one place, each with a Stop", () => {
  async function renderList() {
    await act(async () => { root.render(React.createElement(BuildsOnMyKey, { orgId: "o1" })); });
    await settle();
  }
  it("lists each build with its library, what it is doing, when it last ran and why it waits", async () => {
    ov.getEmbedKeyOverview.mockResolvedValue({
      builds: [
        build("L-pid", "P&IDs", { lastDrainAt: "2026-09-02T00:00:00Z" }),
        build("L-std", "Standards", { standing: true, blockedUntil: "2999-01-01T00:00:00Z", blockedReason: "cap" }),
      ],
    });
    await renderList();
    expect(ov.getEmbedKeyOverview).toHaveBeenCalledWith("o1");
    const rows = [...host.querySelectorAll("[data-build-library]")] as HTMLElement[];
    expect(rows.map((r) => r.getAttribute("data-build-library"))).toEqual(["L-pid", "L-std"]);
    expect(rows[0].textContent).toMatch(/P&IDs— finishing a build you started/);
    expect(rows[0].querySelector("a")?.getAttribute("href")).toBe("/knowledge/L-pid");
    expect(rows[0].textContent).toMatch(/; last ran /);
    expect(rows[1].textContent).toMatch(/kept current as documents arrive/);
    expect(rows[1].textContent).toMatch(/not run in the background yet/);
    expect(rows[1].textContent).toMatch(/Waiting until .* — your monthly AI budget is reached\./);
  });

  it("Stop releases that build through the route and the toast is the route's answer; the list is read again", async () => {
    ov.getEmbedKeyOverview.mockResolvedValueOnce({ builds: [build("L-pid", "P&IDs")] }).mockResolvedValueOnce({ builds: [] });
    await renderList();
    const stop = [...host.querySelectorAll("[data-build-library] button")].find((b) => /Stop/.test(b.textContent ?? "")) as HTMLButtonElement;
    await act(async () => { stop.click(); });
    await settle();
    expect(kn.releaseBackgroundBuild).toHaveBeenCalledWith("o1", "L-pid");
    expect(toast.showToast).toHaveBeenCalledWith({ type: "success", title: "Background build stopped." });
    expect(ov.getEmbedKeyOverview).toHaveBeenCalledTimes(2);
    expect(host.textContent).toMatch(/None running\./);
  });

  it("a Stop that found nothing running is never 'stopped'", async () => {
    ov.getEmbedKeyOverview.mockResolvedValue({ builds: [build("L-pid", "P&IDs")] });
    kn.releaseBackgroundBuild.mockResolvedValueOnce({ released: false });
    await renderList();
    const stop = [...host.querySelectorAll("[data-build-library] button")][0] as HTMLButtonElement;
    await act(async () => { stop.click(); });
    await settle();
    expect(toast.showToast).toHaveBeenCalledWith({ type: "info", title: "No background build was running any more — nothing was stopped." });
  });

  it("a list that cannot be read says so — never 'None running'", async () => {
    ov.getEmbedKeyOverview.mockRejectedValue(new Error("Couldn't read this workspace's libraries, so the background builds on your key can't be listed: connection reset"));
    await renderList();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Couldn't list the background builds on your key: Couldn't read this workspace's libraries/);
    expect(host.textContent).not.toMatch(/None running/);
  });

  it("the AI settings dialog shows the list beside the embeddings key", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/knowledge/AiSettingsModal.tsx", "utf8");
    expect(src).toMatch(/<EmbeddingKeyEditor orgId=\{orgId\} current=\{data\.personal\}[\s\S]{0,120}<BuildsOnMyKey orgId=\{orgId\} refreshKey=\{reloadTick\} \/>/);
  });
});
