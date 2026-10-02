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
//     is linked — and libraries whose index could not be checked are linked
//     too, marked so. The confirm promises links only when there will be
//     some: an overview that could not be read names no library, so it says
//     to open each library's panel instead.
//   SEM-1 done-when 2, the chat-key path — a member whose meaning search runs
//     on their OpenAI CHAT key (no embeddings key saved) loses it when the
//     chat key moves to another provider or is removed. That save, and that
//     removal, confirm first in the same way, naming the libraries whose
//     index stops answering and the builds on the key that end.
//   SEM-1 done-when 2, the removals (I-20 fix pass 3) — removing the chat key
//     deletes the member's WHOLE connection (DELETE /api/ai/connection), so a
//     saved embeddings key goes with it: that removal says so and names what
//     stops, even when nothing is touched (the key itself is lost), and says
//     how to keep the embeddings key (Verify & save the new chat key
//     instead). Removing the embeddings key alone moves meaning search to the
//     OpenAI chat key's default model, or ends it: that confirm names what
//     stops too, and after a move each library's Rebuild is linked. A removal
//     that ends a background build no longer says "Nobody else is affected".
//   SEM-1, the builds on the key (I-20 fix pass 4) — the confirm said the
//     builds on the key "end" (the next run releases them) or "stop" (held
//     for a model conflict), but the drain does neither to a "keep current"
//     on a library already fully embedded, nor to a run already under way.
//     It now says what happens to each kind (buildFates; embedDrain.test.ts
//     runs the drain against each case).
//   GOV-14 done-when 4 — one place lists every background build running on
//     the member's key, each with a Stop (the route's release action, sent
//     with onlyMine: a row read before another member's build replaced the
//     consent stops nothing); a list that cannot be read says so, never
//     "none running". Its instant is labelled "last confirmed" (fix pass 4):
//     every build pass and "keep current" press re-stamps it.
//
// REGRESSION: saving the same provider and model (a new key, or nothing new)
// asks nothing and reads nothing first — it saves exactly as before; a
// chat-key SAVE that leaves meaning search where it was (a saved embeddings
// key, which a save never touches, or OpenAI kept) asks nothing and reads
// nothing; and removing the embeddings key, with no OpenAI chat key and no
// index or build touched, asks exactly what it asked before. (Corrected in
// fix pass 3: this header used to count the chat key's REMOVAL with an
// embeddings key saved among the changes that leave meaning search where it
// was — that removal deletes the embeddings key.)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const kn = vi.hoisted(() => ({
  saveEmbeddingKey: vi.fn(async () => ({ ok: true })),
  releaseBackgroundBuild: vi.fn(async () => ({ released: true })),
  saveAiConnection: vi.fn(async (_o: Record<string, unknown>) => ({ ok: true })),
  removeAiConnection: vi.fn(async (_o: string, _s: string) => ({ ok: true })),
  removeEmbeddingKey: vi.fn(async (_o: string) => undefined),
}));
const ov = vi.hoisted(() => ({ getEmbedKeyOverview: vi.fn(), releaseBuildOnMyKey: vi.fn(async (_o: string, _l: string): Promise<{ released: boolean }> => ({ released: true })) }));
const dialog = vi.hoisted(() => ({ appConfirm: vi.fn(async (_o: { title: string; message: unknown; confirmLabel?: string }) => true) }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/lib/knowledge", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/knowledge")>();
  return {
    getAiConnections: vi.fn(), saveAiConnection: kn.saveAiConnection, testAiConnection: vi.fn(), removeAiConnection: kn.removeAiConnection,
    saveEmbeddingKey: kn.saveEmbeddingKey, removeEmbeddingKey: kn.removeEmbeddingKey, testEmbeddingKey: vi.fn(),
    getAiUsage: vi.fn(), setAiCap: vi.fn(),
    releaseBackgroundBuild: kn.releaseBackgroundBuild, releaseOutcome: real.releaseOutcome,
  };
});
vi.mock("@/lib/embedKeyOverview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/embedKeyOverview")>()),
  getEmbedKeyOverview: ov.getEmbedKeyOverview,
  releaseBuildOnMyKey: ov.releaseBuildOnMyKey,
}));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => toast }));
vi.mock("@/components/providers/DialogProvider", () => dialog);
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));

import { EmbeddingKeyEditor, BuildsOnMyKey, KeyEditor } from "@/components/knowledge/AiSettingsModal";
import { EMBEDDING_PROVIDERS } from "@/lib/ai/embeddings";
import {
  embeddingSwitchImpact, effectiveEmbeddingSetting, switchImpactIsEmpty, librariesToRebuild, librariesLinkedAfterSwitch,
  embeddingLossImpact, onChatKeyEmbeddings, isSwitchImpact, buildFates,
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
  kn.saveAiConnection.mockClear();
  kn.removeAiConnection.mockClear();
  kn.removeEmbeddingKey.mockClear();
  ov.getEmbedKeyOverview.mockReset();
  ov.getEmbedKeyOverview.mockResolvedValue(OVERVIEW);
  ov.releaseBuildOnMyKey.mockReset();
  ov.releaseBuildOnMyKey.mockResolvedValue({ released: true });
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
  it("what is linked after the switch: the libraries to rebuild, then the unchecked ones (marked); nothing when the overview was unreadable", () => {
    const i = embeddingSwitchImpact(before, { provider: "openai", model: OPENAI[0] }, {
      builds: [], indexes: [...OVERVIEW.indexes!, { libraryId: "L-x", libraryName: "Big library", models: null }],
    })!;
    expect(librariesLinkedAfterSwitch(i)).toEqual([
      { libraryId: "L-std", libraryName: "Standards", unchecked: false },
      { libraryId: "L-pid", libraryName: "P&IDs", unchecked: false },
      { libraryId: "L-x", libraryName: "Big library", unchecked: true },
    ]);
    expect(librariesLinkedAfterSwitch(embeddingSwitchImpact(before, { provider: "openai", model: OPENAI[0] }, null, "HTTP 500")!)).toEqual([]);
  });
  it("a switch that touches no index and no build is empty — nothing to warn about", () => {
    const i = embeddingSwitchImpact(before, { provider: "voyage", model: VOYAGE[2] }, { builds: [], indexes: [{ libraryId: "L-new", libraryName: "Empty", models: {} }] })!;
    expect(switchImpactIsEmpty(i)).toBe(true);
  });
  it("meaning search on the OpenAI chat key: only with no embeddings key saved", () => {
    expect(onChatKeyEmbeddings({ provider: "openai", embeddingProvider: null })).toBe(true);
    expect(onChatKeyEmbeddings({ provider: "openai", embeddingProvider: "voyage" })).toBe(false);
    expect(onChatKeyEmbeddings({ provider: "anthropic", embeddingProvider: null })).toBe(false);
    expect(onChatKeyEmbeddings(null)).toBe(false);
  });
  it("losing the chat-key embeddings altogether: every index OpenAI built stops answering, every build on the key ends; another provider's index and an empty one are untouched", () => {
    const chat = effectiveEmbeddingSetting({ provider: "openai", embeddingProvider: null })!;
    const i = embeddingLossImpact(chat, {
      builds: [build("L-ven", "Vendor manuals"), build("L-std", "Standards", { standing: true })],
      indexes: [...OVERVIEW.indexes!, { libraryId: "L-x", libraryName: "Big library", models: null }],
    });
    expect(i.after).toBeNull();
    expect(i.stopAnswering.map((l) => l.libraryName)).toEqual(["Vendor manuals"]);
    expect(i.cannotGrow).toEqual([]);
    expect(i.buildsStop.map((l) => [l.libraryName, l.standing])).toEqual([["Vendor manuals", false], ["Standards", true]]);
    expect(i.unknown.map((l) => l.libraryName)).toEqual(["Big library"]);
    const u = embeddingLossImpact(chat, null, "HTTP 500");
    expect(u.unreadable).toBe("HTTP 500");
    expect(switchImpactIsEmpty(u)).toBe(false);
    expect(switchImpactIsEmpty(embeddingLossImpact(chat, { builds: [], indexes: [{ libraryId: "L-new", libraryName: "Empty", models: {} }] }))).toBe(true);
  });
  it("a loss names its cause — the chat-key fallback by default; the whole connection removed, or the embeddings key removed, when said — and is never a switch", () => {
    const chat = effectiveEmbeddingSetting({ provider: "openai", embeddingProvider: null })!;
    expect(embeddingLossImpact(chat, OVERVIEW).cause).toBe("chatKey");
    const gone = embeddingLossImpact(before, OVERVIEW, null, "connectionRemoved");
    expect(gone).toMatchObject({ cause: "connectionRemoved", after: null, before: { provider: "voyage", model: VOYAGE[1] } });
    // the Voyage-built indexes stop answering; the build on the key ends
    expect(gone.stopAnswering.map((l) => l.libraryName)).toEqual(["Standards", "P&IDs"]);
    expect(gone.buildsStop.map((l) => l.libraryName)).toEqual(["P&IDs"]);
    expect(embeddingLossImpact(before, OVERVIEW, null, "embeddingsKeyRemoved").cause).toBe("embeddingsKeyRemoved");
    expect(isSwitchImpact(gone)).toBe(false);
    expect(isSwitchImpact(embeddingSwitchImpact(before, { provider: "openai", model: OPENAI[0] }, OVERVIEW)!)).toBe(true);
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
    expect(text).toContain(`Background builds on your key in libraries a build with ${OPENAI[0]} cannot add to:P&IDs`);
    expect(text).toContain(buildFates("switch", OPENAI[0]).embedding);
    expect(text).not.toMatch(/Vendor manuals|Empty/);
    expect(text).toMatch(/Each one comes back with a Rebuild of that library's index with/);
    expect(text).toMatch(/Once you switch, the libraries are linked here\./);
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
    expect(offer.querySelector("[data-unchecked]")).toBeNull();
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

  it("…and that confirm promises no links it cannot show: it says to open each library's panel, and after the switch nothing claims to list them", async () => {
    ov.getEmbedKeyOverview.mockRejectedValueOnce(new Error("HTTP 500"));
    await renderEditor();
    await choose(0, "openai");
    await save();
    const text = await confirmText();
    expect(text).not.toMatch(/linked here/);
    expect(text).toMatch(/Open each library's meaning-index panel to rebuild it\./);
    expect(kn.saveEmbeddingKey).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-rebuild-offer]")).toBeNull();
  });

  it("every library unknown (vectors unreadable): the confirm promises the links, and after the switch each library is linked, marked 'could not be checked'", async () => {
    ov.getEmbedKeyOverview.mockResolvedValueOnce({
      builds: [],
      indexes: [{ libraryId: "L-a", libraryName: "Alpha", models: null }, { libraryId: "L-b", libraryName: "Beta", models: null }],
    });
    await renderEditor();
    await choose(0, "openai");
    await save();
    const text = await confirmText();
    expect(text).toMatch(/could not be read, so they may be affected too:AlphaBeta/);
    expect(text).toMatch(/Once you switch, the libraries are linked here\./);
    const offer = host.querySelector("[data-rebuild-offer]")!;
    expect([...offer.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Alpha", "/knowledge/L-a"],
      ["Beta", "/knowledge/L-b"],
    ]);
    expect(offer.querySelectorAll("[data-unchecked]")).toHaveLength(2);
    expect(offer.textContent).toMatch(/Alpha — could not be checked; open it to see whether it needs a Rebuild/);
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

describe("SEM-1 done-when 2, the chat-key path — moving meaning search's OpenAI chat key off OpenAI, or removing it, confirms first", () => {
  /** Meaning search on the OpenAI chat key: no embeddings key saved. */
  const CHAT_ONLY = { provider: "openai", model: "chat-model-b", keyLast4: "abcd", updatedAt: "2026-10-01T00:00:00Z", embeddingProvider: null, embeddingModel: null, embeddingKeyLast4: null };
  const CHAT_OVERVIEW: EmbedKeyOverview = {
    builds: [build("L-ven", "Vendor manuals", { standing: true })],
    indexes: [
      { libraryId: "L-std", libraryName: "Standards", models: { [VOYAGE[1]]: 900 } },
      { libraryId: "L-ven", libraryName: "Vendor manuals", models: { [OPENAI[0]]: 12 } },
      { libraryId: "L-new", libraryName: "Empty", models: {} },
    ],
  };
  async function renderKeyEditor(current: Record<string, unknown>) {
    await act(async () => { root.render(React.createElement(KeyEditor, { orgId: "o1", current: current as never, onChanged: () => undefined })); });
    await settle();
  }
  async function click(label: RegExp) {
    const btn = [...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""))!;
    await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
  }

  it("reproduction → fix: switching the chat key to Claude names the indexes that stop answering and the builds that end; declining saves nothing", async () => {
    ov.getEmbedKeyOverview.mockResolvedValue(CHAT_OVERVIEW);
    await renderKeyEditor(CHAT_ONLY);
    await choose(0, "anthropic");
    dialog.appConfirm.mockResolvedValueOnce(false);
    await click(/Verify & save/);
    expect(ov.getEmbedKeyOverview).toHaveBeenCalledWith("o1", { models: true });
    expect(dialog.appConfirm).toHaveBeenCalledTimes(1);
    expect(dialog.appConfirm.mock.calls[0][0]).toMatchObject({ title: "Switch your chat key off OpenAI?", confirmLabel: "Switch" });
    const text = await confirmText();
    expect(text).toContain(`Your meaning-based search runs on this OpenAI chat key (${OPENAI[0]}) — you have no embeddings key saved.`);
    expect(text).toMatch(/These meaning indexes stop answering your questions\. They were built with OpenAI, and without an OpenAI key you cannot search them:Vendor manuals/);
    expect(text).toMatch(/Background builds on your key in:Vendor manualsWith no embeddings key:/);
    expect(text).not.toMatch(/Standards|Empty/);
    expect(text).toMatch(/To keep them, add an embeddings key under Meaning-based search first: an OpenAI embeddings key searches these indexes as they are; a key for another provider needs each library's index rebuilt with it — Rebuild index/);
    expect(text).toMatch(/Keyword search is unaffected\./);
    expect(kn.saveAiConnection).not.toHaveBeenCalled();
  });

  it("…confirming saves the switch", async () => {
    ov.getEmbedKeyOverview.mockResolvedValue(CHAT_OVERVIEW);
    await renderKeyEditor(CHAT_ONLY);
    await choose(0, "anthropic");
    await click(/Verify & save/);
    expect(dialog.appConfirm).toHaveBeenCalledTimes(1);
    expect(kn.saveAiConnection).toHaveBeenCalledWith(expect.objectContaining({ provider: "anthropic" }));
  });

  it("…an overview that cannot be read still warns, in general terms", async () => {
    ov.getEmbedKeyOverview.mockRejectedValueOnce(new Error("HTTP 500"));
    await renderKeyEditor(CHAT_ONLY);
    await choose(0, "anthropic");
    dialog.appConfirm.mockResolvedValueOnce(false);
    await click(/Verify & save/);
    const text = await confirmText();
    expect(text).toMatch(/Which libraries are affected could not be checked \(HTTP 500\)\. Every meaning index built with OpenAI stops answering your questions\. A background build on your key, with no embeddings key:/);
    expect(text).not.toMatch(/every background build on your key ends/);
    expect(text).toContain(buildFates("loss").embedded);
    expect(kn.saveAiConnection).not.toHaveBeenCalled();
  });

  it("removing that chat key: ONE confirm carrying both the removal and the meaning-search warning; declining removes nothing", async () => {
    ov.getEmbedKeyOverview.mockResolvedValue(CHAT_OVERVIEW);
    await renderKeyEditor(CHAT_ONLY);
    dialog.appConfirm.mockResolvedValueOnce(false);
    await click(/Remove/);
    expect(dialog.appConfirm).toHaveBeenCalledTimes(1);
    expect(dialog.appConfirm.mock.calls[0][0]).toMatchObject({ title: "Remove your API key?", confirmLabel: "Remove key" });
    const text = await confirmText();
    // fix pass 3: a standing build on the key ends — "Nobody else is affected" is no longer said
    expect(text).toMatch(/^You won't be able to ask AI questions until you add a key again\. No one else's key is affected — but a background build on your key that ends stops filling that library's meaning index for everyone\./);
    expect(text).not.toMatch(/Nobody else is affected/);
    expect(text).toMatch(/These meaning indexes stop answering your questions[\s\S]*Vendor manuals/);
    expect(text).toMatch(/Background builds on your key in:[\s\S]*Vendor manuals/);
    expect(kn.removeAiConnection).not.toHaveBeenCalled();
  });

  it("a switch or removal that touches no index and no build asks only what it asked before", async () => {
    ov.getEmbedKeyOverview.mockResolvedValue({ builds: [], indexes: [{ libraryId: "L-std", libraryName: "Standards", models: { [VOYAGE[1]]: 900 } }] });
    await renderKeyEditor(CHAT_ONLY);
    await choose(0, "anthropic");
    await click(/Verify & save/);
    expect(dialog.appConfirm).not.toHaveBeenCalled();
    expect(kn.saveAiConnection).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: with an embeddings key saved, switching the chat key reads nothing and asks nothing (a save never touches the embeddings key)", async () => {
    await renderKeyEditor(SAVED);
    await choose(0, "openai");
    await click(/Verify & save/);
    expect(ov.getEmbedKeyOverview).not.toHaveBeenCalled();
    expect(dialog.appConfirm).not.toHaveBeenCalled();
    expect(kn.saveAiConnection).toHaveBeenCalledTimes(1);
  });

  it("reproduction → fix (fix pass 3): with an embeddings key saved, removing the chat key — which deletes the embeddings key too — says so, names the indexes that stop answering and the build that ends, and how to keep the key; declining removes nothing", async () => {
    await renderKeyEditor(SAVED);
    dialog.appConfirm.mockResolvedValueOnce(false);
    await click(/Remove/);
    expect(ov.getEmbedKeyOverview).toHaveBeenCalledWith("o1", { models: true });
    expect(dialog.appConfirm).toHaveBeenCalledTimes(1);
    expect(dialog.appConfirm.mock.calls[0][0]).toMatchObject({ title: "Remove your API key?", confirmLabel: "Remove key" });
    const text = await confirmText();
    expect(text).toMatch(/^You won't be able to ask AI questions until you add a key again\. No one else's key is affected — but a background build on your key that ends stops filling that library's meaning index for everyone\./);
    expect(text).toContain(`This also removes your embeddings key (Voyage AI, ${VOYAGE[1]}): it is saved with your chat key, and removing the chat key deletes both. After this you have no embeddings connection at all.`);
    expect(text).toMatch(/These meaning indexes stop answering your questions\. They were built with Voyage AI, and without a Voyage AI key you cannot search them:StandardsP&IDs/);
    expect(text).toMatch(/Background builds on your key in:P&IDsWith no embeddings key:/);
    expect(text).not.toMatch(/Vendor manuals|Empty/);
    expect(text).toMatch(/To change your chat key and keep your embeddings key, paste the new key above and press Verify & save instead — saving replaces only the chat key\./);
    expect(text).not.toMatch(/you have no embeddings key saved|add an embeddings key under/);
    expect(kn.removeAiConnection).not.toHaveBeenCalled();
  });

  it("…confirming removes the key", async () => {
    await renderKeyEditor(SAVED);
    await click(/Remove/);
    expect(dialog.appConfirm).toHaveBeenCalledTimes(1);
    expect(kn.removeAiConnection).toHaveBeenCalledWith("o1", "personal");
  });

  it("…with no index and no build touched, the confirm still says the embeddings key goes (and how to keep it) — and that nobody else is affected", async () => {
    ov.getEmbedKeyOverview.mockResolvedValue({ builds: [], indexes: [{ libraryId: "L-ven", libraryName: "Vendor manuals", models: { [OPENAI[0]]: 12 } }] });
    await renderKeyEditor(SAVED);
    dialog.appConfirm.mockResolvedValueOnce(false);
    await click(/Remove/);
    const text = await confirmText();
    expect(text).toMatch(/^You won't be able to ask AI questions until you add a key again\. Nobody else is affected\./);
    expect(text).toMatch(/This also removes your embeddings key \(Voyage AI, /);
    expect(text).not.toMatch(/stop answering|Background builds on your key/);
    expect(text).toMatch(/To change your chat key and keep your embeddings key/);
  });

  it("…and an overview that cannot be read still says the embeddings key goes, and warns in general terms", async () => {
    ov.getEmbedKeyOverview.mockRejectedValueOnce(new Error("HTTP 500"));
    await renderKeyEditor(SAVED);
    dialog.appConfirm.mockResolvedValueOnce(false);
    await click(/Remove/);
    const text = await confirmText();
    expect(text).toMatch(/This also removes your embeddings key/);
    expect(text).toMatch(/Which libraries are affected could not be checked \(HTTP 500\)\. Every meaning index built with Voyage AI stops answering your questions\. A background build on your key, with no embeddings key:/);
    expect(text).not.toMatch(/Nobody else is affected/);
  });

  it("REGRESSION: with no AI key setting for meaning search at all (an Anthropic chat key, no embeddings key), removal reads nothing and asks exactly what it asked before", async () => {
    await renderKeyEditor({ ...SAVED, embeddingProvider: null, embeddingModel: null, embeddingKeyLast4: null });
    await click(/Remove/);
    expect(ov.getEmbedKeyOverview).not.toHaveBeenCalled();
    expect(dialog.appConfirm.mock.calls[0][0]).toEqual({
      title: "Remove your API key?",
      message: "You won't be able to ask AI questions until you add a key again. Nobody else is affected.",
      confirmLabel: "Remove key",
    });
  });

  it("REGRESSION: on the OpenAI chat key, another OpenAI model keeps meaning search where it was — nothing read, nothing asked", async () => {
    await renderKeyEditor(CHAT_ONLY);
    const input = host.querySelector('input:not([type="password"])') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "chat-model-c"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(/Verify & save/);
    expect(ov.getEmbedKeyOverview).not.toHaveBeenCalled();
    expect(dialog.appConfirm).not.toHaveBeenCalled();
    expect(kn.saveAiConnection).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai", model: "chat-model-c" }));
  });
});

describe("SEM-1 done-when 2 — removing the embeddings key names what stops (fix pass 3)", () => {
  async function clickRemove() {
    const btn = [...host.querySelectorAll("button")].find((b) => /Remove/.test(b.textContent ?? ""))!;
    await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
  }
  const SEM3 = "Vectors already built stay in place, but they work again only with a key for the provider that built them — "
    + "a key for another provider cannot search them until the library's index is rebuilt with it.";

  it("reproduction → fix: no OpenAI chat key to fall back on — the confirm names the indexes that stop answering and the build that ends; declining removes nothing", async () => {
    await renderEditor();                                   // Anthropic chat key, Voyage embeddings key
    dialog.appConfirm.mockResolvedValueOnce(false);
    await clickRemove();
    expect(ov.getEmbedKeyOverview).toHaveBeenCalledWith("o1", { models: true });
    expect(dialog.appConfirm.mock.calls[0][0]).toMatchObject({ title: "Remove your embeddings key?", confirmLabel: "Remove key" });
    const text = await confirmText();
    expect(text).toMatch(new RegExp(`^Meaning-based search stops for you; keyword search is unaffected\\. ${SEM3.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(text).toContain(`Your meaning-based search runs on this Voyage AI embeddings key (${VOYAGE[1]}), and you have no OpenAI chat key for it to fall back on.`);
    expect(text).toMatch(/These meaning indexes stop answering your questions\. They were built with Voyage AI, and without a Voyage AI key you cannot search them:StandardsP&IDs/);
    expect(text).toMatch(/Background builds on your key in:P&IDsWith no embeddings key:/);
    expect(text).toMatch(/To change this key instead, paste the new key and press Verify & save rather than Remove: a Voyage AI key searches these indexes as they are/);
    expect(kn.removeEmbeddingKey).not.toHaveBeenCalled();
  });

  it("reproduction → fix: with an OpenAI chat key, meaning search MOVES to it — the confirm says so, names the switch's impact, and after the removal each library's Rebuild is linked", async () => {
    await renderEditor({ ...SAVED, provider: "openai" });
    await clickRemove();
    const text = await confirmText();
    expect(text).toMatch(new RegExp(`^Meaning-based search moves to your OpenAI chat key \\(${OPENAI[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\); keyword search is unaffected\\.`));
    expect(text).not.toMatch(/stops for you/);
    expect(text).toContain(`You are switching from ${VOYAGE[1]} (Voyage AI) to ${OPENAI[0]} (OpenAI).`);
    expect(text).toMatch(/These meaning indexes stop answering your questions\.[\s\S]*StandardsP&IDs/);
    expect(text).toContain(`Background builds on your key in libraries a build with ${OPENAI[0]} cannot add to:P&IDs`);
    expect(text).toMatch(/Once you switch, the libraries are linked here\./);
    expect(kn.removeEmbeddingKey).toHaveBeenCalledWith("o1");
    const offer = host.querySelector("[data-rebuild-offer]")!;
    expect([...offer.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/knowledge/L-std", "/knowledge/L-pid"]);
  });

  it("REGRESSION: no OpenAI chat key and no index or build touched — the confirm is exactly the one it always was", async () => {
    ov.getEmbedKeyOverview.mockResolvedValueOnce({ builds: [], indexes: [{ libraryId: "L-ven", libraryName: "Vendor manuals", models: { [OPENAI[0]]: 12 } }] });
    await renderEditor();
    await clickRemove();
    expect(dialog.appConfirm.mock.calls[0][0]).toEqual({
      title: "Remove your embeddings key?",
      message: "Meaning-based search stops for you; keyword search is unaffected. Vectors already built "
        + "stay in place, but they work again only with a key for the provider that built them — "
        + "a key for another provider cannot search them until the library's index is rebuilt with it.",
      confirmLabel: "Remove key",
    });
    expect(kn.removeEmbeddingKey).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-rebuild-offer]")).toBeNull();
  });

  it("an OpenAI embeddings key on the chat key's own default model, with an OpenAI chat key, is no switch — nothing read, the chat key named", async () => {
    await renderEditor({ ...SAVED, provider: "openai", embeddingProvider: "openai", embeddingModel: OPENAI[0] });
    await clickRemove();
    expect(ov.getEmbedKeyOverview).not.toHaveBeenCalled();
    expect(dialog.appConfirm.mock.calls[0][0].message).toBe(
      `Meaning-based search moves to your OpenAI chat key (${OPENAI[0]}); keyword search is unaffected. ${SEM3}`,
    );
  });
});

describe("SEM-1 (I-20 fix pass 4) — the confirm says what happens to each kind of build on the key, never that every one ends or holds at the next run", () => {
  const fates = async (call = 0) => {
    const node = dialog.appConfirm.mock.calls[call][0].message as React.ReactElement;
    const box = document.createElement("div");
    const r = createRoot(box);
    await act(async () => { r.render(node); });
    const items = [...box.querySelectorAll("[data-build-fate]")].map((li) => [li.getAttribute("data-build-fate"), li.textContent]);
    const kind = box.querySelector("[data-build-fates]")?.getAttribute("data-build-fates") ?? null;
    const text = box.textContent ?? "";
    act(() => r.unmount());
    return { items, kind, text };
  };
  async function clickRemove() {
    const btn = [...host.querySelectorAll("button")].find((b) => /Remove/.test(b.textContent ?? ""))!;
    await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
  }

  it("reproduction → fix: a switch names the build's library, then each kind — a run under way, one with passages left (held), a 'keep current' on a fully embedded library (left as it is) — never 'the builds stop (held for a model conflict)'", async () => {
    await renderEditor();
    await choose(0, "openai");
    dialog.appConfirm.mockResolvedValueOnce(false);
    await save();
    const f = buildFates("switch", OPENAI[0]);
    const { items, kind, text } = await fates();
    expect(kind).toBe("switch");
    expect(items).toEqual([["running", f.running], ["embedding", f.embedding], ["embedded", f.embedded]]);
    expect(text).not.toMatch(/builds on your key stop|held for a model conflict\) in/);
    expect(f.embedded).toMatch(/“keep current” consent stays \(listed under Background builds on your key\) until new documents give it passages to embed — it is then held as above\. Stop it there to end it now\./);
    // I-20 fix pass 5: held for at least an hour and looked at again by the next background run — never "every hour"
    expect(f.embedding).toMatch(/Such a hold lasts at least an hour; after that the next background run — the nightly one, or one started when a member opens a library in this workspace — looks at it again\./);
    expect(f.embedding).toMatch(/a library that already mixes two models stays held until it is rebuilt\.$/);
    expect(f.embedding).not.toMatch(/every hour|hourly/);
  });

  it("reproduction → fix: a loss (the embeddings key removed, no OpenAI chat key) says the same per kind — ended, not 'the next background run releases them'", async () => {
    await renderEditor();
    dialog.appConfirm.mockResolvedValueOnce(false);
    await clickRemove();
    const f = buildFates("loss");
    const { items, kind, text } = await fates();
    expect(kind).toBe("loss");
    expect(items).toEqual([["running", f.running], ["embedding", f.embedding], ["embedded", f.embedded]]);
    expect(text).not.toMatch(/the next background run releases them|builds on your key end\b/);
    expect(f.embedding).toBe("One with passages still to embed — a build you started, or one kept current — is ended (its consent released) by the next background run that finds a passage there it can take. (A run takes none while every passage left is being embedded by another run or waits to be retried, nor while an earlier hold is still in force.)");
    expect(f.embedded).toMatch(/it is then ended as above\. Stop it there to end it now\./);
  });

  it("an overview that cannot be read still says, per kind, what happens to a build on the key — for a switch and for a loss", async () => {
    ov.getEmbedKeyOverview.mockRejectedValue(new Error("HTTP 500"));
    await renderEditor();
    await choose(0, "openai");
    dialog.appConfirm.mockResolvedValueOnce(false);
    await save();
    expect((await fates(0)).items.map(([k]) => k)).toEqual(["running", "embedding", "embedded"]);
    expect((await fates(0)).kind).toBe("switch");
    act(() => root.unmount());
    root = createRoot(host);
    await renderEditor();
    dialog.appConfirm.mockResolvedValueOnce(false);
    await clickRemove();
    expect((await fates(1)).kind).toBe("loss");
    expect((await fates(1)).text).not.toMatch(/every background build on your key ends/);
  });

  it("negative control: with no build on the key (and every library read), no build case is described", async () => {
    ov.getEmbedKeyOverview.mockResolvedValue({ ...OVERVIEW, builds: [] });
    await renderEditor();
    await choose(0, "openai");
    dialog.appConfirm.mockResolvedValueOnce(false);
    await save();
    const { items, text } = await fates();
    expect(items).toEqual([]);
    expect(text).toMatch(/These meaning indexes stop answering your questions/);
    expect(text).not.toMatch(/Background builds on your key/);
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
    // I-20 fix pass 4: the instant is the last confirmation (every build pass re-stamps it), not the consent's first recording
    expect(rows[0].querySelector("[data-build-confirmed]")?.textContent).toBe(
      `Consent last confirmed ${new Date("2026-09-01T00:00:00Z").toLocaleString()}; last ran ${new Date("2026-09-02T00:00:00Z").toLocaleString()}.`,
    );
    expect(rows[0].textContent).not.toMatch(/Consent recorded/);
    // fix pass 5: "keep current" switched off re-stamps the instant too — the footer says so
    expect(host.textContent).toMatch(/“Last confirmed” is the last time the consent was stamped again — by a build\s+pass, or by “keep current” being switched on or off on that library \(switching it off leaves the\s+build to finish on your key\) — not when it was first given\./);
    expect(rows[1].textContent).toMatch(/kept current as documents arrive/);
    expect(rows[1].textContent).toMatch(/not run in the background yet/);
    expect(rows[1].textContent).toMatch(/Waiting until .* — your monthly AI budget is reached\./);
  });

  it("a consent with no instant on its marker claims no time: 'Consent recorded', nothing 'last confirmed'", async () => {
    ov.getEmbedKeyOverview.mockResolvedValue({ builds: [build("L-pid", "P&IDs", { startedAt: null })] });
    await renderList();
    const line = host.querySelector("[data-build-confirmed]")!.textContent;
    expect(line).toBe("Consent recorded; not run in the background yet.");
  });

  it("Stop releases that build through the route and the toast is the route's answer; the list is read again", async () => {
    ov.getEmbedKeyOverview.mockResolvedValueOnce({ builds: [build("L-pid", "P&IDs")] }).mockResolvedValueOnce({ builds: [] });
    await renderList();
    const stop = [...host.querySelectorAll("[data-build-library] button")].find((b) => /Stop/.test(b.textContent ?? "")) as HTMLButtonElement;
    await act(async () => { stop.click(); });
    await settle();
    expect(ov.releaseBuildOnMyKey).toHaveBeenCalledWith("o1", "L-pid");
    expect(kn.releaseBackgroundBuild).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith({ type: "success", title: "Background build stopped." });
    expect(ov.getEmbedKeyOverview).toHaveBeenCalledTimes(2);
    expect(host.textContent).toMatch(/None running\./);
  });

  it("a Stop that found nothing running is never 'stopped'", async () => {
    ov.getEmbedKeyOverview.mockResolvedValue({ builds: [build("L-pid", "P&IDs")] });
    ov.releaseBuildOnMyKey.mockResolvedValueOnce({ released: false });
    await renderList();
    const stop = [...host.querySelectorAll("[data-build-library] button")][0] as HTMLButtonElement;
    await act(async () => { stop.click(); });
    await settle();
    expect(toast.showToast).toHaveBeenCalledWith({ type: "info", title: "No background build was running any more — nothing was stopped." });
  });

  it("reproduction → fix: Stop on a row that is no longer on my key (another member's build replaced it) stops nothing and says so — never 'stopped'", async () => {
    ov.getEmbedKeyOverview.mockResolvedValueOnce({ builds: [build("L-pid", "P&IDs")] }).mockResolvedValueOnce({ builds: [] });
    const refusal = "This background build no longer runs on your key — another member's build replaced it after the list was read — so nothing was stopped.";
    ov.releaseBuildOnMyKey.mockRejectedValueOnce(new Error(refusal));
    await renderList();
    const stop = [...host.querySelectorAll("[data-build-library] button")][0] as HTMLButtonElement;
    await act(async () => { stop.click(); });
    await settle();
    expect(ov.releaseBuildOnMyKey).toHaveBeenCalledWith("o1", "L-pid");
    expect(toast.showToast).toHaveBeenCalledWith({ type: "error", title: refusal });
    expect(toast.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Background build stopped." }));
    expect(ov.getEmbedKeyOverview).toHaveBeenCalledTimes(2);
    expect(host.textContent).toMatch(/None running\./);
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
