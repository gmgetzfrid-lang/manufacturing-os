// @vitest-environment jsdom
//
// intelligence Round G — I-03: SEM-1 done-when 2, as RENDERED. Saving a
// different embedding provider or model warns, before anything is saved,
// that every meaning index built with the old model stops answering until
// its library is rebuilt — and says where the rebuild is. Saving the same
// setting (a new key, nothing else) asks nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const kn = vi.hoisted(() => ({ saveEmbeddingKey: vi.fn(async () => ({ ok: true })) }));
const dialog = vi.hoisted(() => ({ appConfirm: vi.fn(async (_o: { title: string; message: string }) => true) }));
vi.mock("@/lib/knowledge", () => ({
  getAiConnections: vi.fn(), saveAiConnection: vi.fn(), testAiConnection: vi.fn(), removeAiConnection: vi.fn(),
  saveEmbeddingKey: kn.saveEmbeddingKey, removeEmbeddingKey: vi.fn(), testEmbeddingKey: vi.fn(),
  getAiUsage: vi.fn(), setAiCap: vi.fn(),
}));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/providers/DialogProvider", () => dialog);
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));

import { EmbeddingKeyEditor } from "@/components/knowledge/AiSettingsModal";
import { EMBEDDING_PROVIDERS } from "@/lib/ai/embeddings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Model names come from the catalogue, never spelled out here.
const models = (id: string) => EMBEDDING_PROVIDERS.find((p) => p.id === id)!.models;
const SAVED = { provider: "anthropic", model: "chat-model-a", keyLast4: "abcd", updatedAt: "2026-10-01T00:00:00Z",
  embeddingProvider: "voyage", embeddingModel: models("voyage")[1], embeddingKeyLast4: "wxyz" };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  kn.saveEmbeddingKey.mockClear();
  dialog.appConfirm.mockReset();
  dialog.appConfirm.mockResolvedValue(true);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function render() {
  await act(async () => { root.render(React.createElement(EmbeddingKeyEditor, { orgId: "o1", current: SAVED, onChanged: () => undefined })); });
  await act(async () => { await Promise.resolve(); });
}
async function choose(index: number, value: string) {
  const select = host.querySelectorAll("select")[index] as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => { setter.call(select, value); select.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function save() {
  const btn = [...host.querySelectorAll("button")].find((b) => /Verify & save/.test(b.textContent ?? ""))!;
  await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("SEM-1 — switching the embedding model warns before it is saved", () => {
  it("reproduction → fix: another provider → the warning names both models and the rebuild; declining saves nothing", async () => {
    await render();
    await choose(0, "openai");
    dialog.appConfirm.mockResolvedValueOnce(false);
    await save();
    expect(dialog.appConfirm).toHaveBeenCalledTimes(1);
    const msg = dialog.appConfirm.mock.calls[0][0].message;
    expect(msg).toContain(`Meaning indexes built with ${models("voyage")[1]} (Voyage AI) can't be searched with ${models("openai")[0]} (OpenAI)`);
    expect(msg).toMatch(/until its index is rebuilt with the new model \(Rebuild index, in that library's meaning-index panel/);
    expect(msg).toMatch(/Keyword search is unaffected\./);
    expect(kn.saveEmbeddingKey).not.toHaveBeenCalled();
  });

  it("another model of the same provider warns too; confirming saves the switch", async () => {
    await render();
    await choose(1, models("voyage")[2]);
    await save();
    expect(dialog.appConfirm).toHaveBeenCalledTimes(1);
    expect(kn.saveEmbeddingKey).toHaveBeenCalledWith(expect.objectContaining({ embeddingProvider: "voyage", embeddingModel: models("voyage")[2] }));
  });

  it("saving the same provider and model (a new key only) asks nothing", async () => {
    await render();
    await save();
    expect(dialog.appConfirm).not.toHaveBeenCalled();
    expect(kn.saveEmbeddingKey).toHaveBeenCalledWith(expect.objectContaining({ embeddingProvider: "voyage", embeddingModel: models("voyage")[1] }));
  });
});
