// @vitest-environment jsdom
//
// notifications Round G, N3 SURFACES — TAX-15 review fix: the update prompt
// that ServiceWorkerManager loads on demand (UpdatePill's stand-in, on a page
// without the protected shell) is first asked for right after a deploy, when
// the old build's chunk may already be gone. A failed load must not take the
// root layout down with it — ServiceWorkerManager is a sibling of every page
// in app/layout.tsx and no error boundary above it would catch the throw.
//
// Here the dynamic import REJECTS (the module factory throws, as a 404'd
// chunk does): the page beside ServiceWorkerManager survives, exactly one
// prompt still shows (the fallback button: the same words, the same place,
// the same reload path), it stands down while the shell's prompt is mounted,
// and inside the shell the stand-in is never rendered or loaded at all.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/components/system/UpdatePill", () => {
  throw new Error("ChunkLoadError: Loading chunk app/update-pill failed. (missing: /_next/static/chunks/update-pill.js)");
});

import ServiceWorkerManager, { UpdatePromptBoundary } from "@/components/pwa/ServiceWorkerManager";
import { UPDATE_PROMPT_TEXT, __resetWaitingWorkerForTests, registerUpdatePromptShell, reportWaitingWorker } from "@/components/pwa/swUpdate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const prompts = () => [...document.querySelectorAll("[data-update-prompt]")];

const waiting = { postMessage: vi.fn() };
function installServiceWorker(withWaiting: boolean) {
  const reg = { waiting: withWaiting ? waiting : null, installing: null, addEventListener: vi.fn() };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn(async () => reg),
      getRegistration: vi.fn(async () => reg),
      controller: { postMessage: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

/** The page the root layout renders beside ServiceWorkerManager. */
const Page = () => React.createElement("main", { "data-page": true }, "Unsaved work on /submit");

let warn: ReturnType<typeof vi.spyOn>;
let release: (() => void) | null = null;
beforeEach(() => {
  __resetWaitingWorkerForTests();
  waiting.postMessage.mockReset();
  // React reports the caught error, and the boundary says what it did; both are expected here.
  vi.spyOn(console, "error").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  release?.();
  release = null;
  await act(async () => root.unmount());
  host.remove();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  vi.restoreAllMocks();
});

describe("TAX-15 — a failed load of the update prompt never takes the page down", () => {
  it("a page without the shell, the chunk 404s: the page survives and one prompt still shows — the fallback, same words", async () => {
    installServiceWorker(true);
    await act(async () => { root.render(React.createElement(React.Fragment, null, React.createElement(Page), React.createElement(ServiceWorkerManager))); });
    await flush();
    // the tree survived the rejected import
    expect(document.querySelector("[data-page]")?.textContent).toBe("Unsaved work on /submit");
    // and the newer build is still announced, once, in the one wording
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0].hasAttribute("data-update-prompt-fallback")).toBe(true);
    expect(prompts()[0].textContent).toBe(UPDATE_PROMPT_TEXT);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("the update prompt could not load"), expect.any(Error));
  });

  it("the fallback's tap is the one reload path: it activates the waiting worker (SKIP_WAITING) through loadLatestBuild", async () => {
    installServiceWorker(true);
    await act(async () => { root.render(React.createElement(ServiceWorkerManager)); });
    await flush();
    await act(async () => { (prompts()[0].querySelector("button") as HTMLButtonElement).click(); });
    await flush();
    expect(waiting.postMessage).toHaveBeenCalledWith("SKIP_WAITING");
  });

  it("the fallback stands down while the shell's prompt is mounted — still one prompt at a time", async () => {
    await act(async () => { root.render(React.createElement(UpdatePromptBoundary, null, React.createElement(() => { throw new Error("chunk gone"); }))); });
    await flush();
    expect(prompts()).toHaveLength(1);
    await act(async () => { release = registerUpdatePromptShell(); });
    await flush();
    expect(prompts()).toHaveLength(0);
    await act(async () => { release?.(); release = null; });
    await flush();
    expect(prompts()).toHaveLength(1);
  });

  it("inside the protected shell the stand-in is never rendered or loaded: nothing to fail", async () => {
    installServiceWorker(true);
    await act(async () => { release = registerUpdatePromptShell(); });
    await act(async () => { root.render(React.createElement(React.Fragment, null, React.createElement(Page), React.createElement(ServiceWorkerManager))); });
    await flush();
    await act(async () => { reportWaitingWorker(); });
    await flush();
    expect(document.querySelector("[data-page]")).toBeTruthy();
    // the shell's own UpdatePill (not mounted in this file) is the one prompt; ServiceWorkerManager adds none
    expect(prompts()).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
