// @vitest-environment jsdom
//
// notifications Round G, N3 SURFACES — TAX-15: one component owns "a newer
// build exists". components/system/UpdatePill.tsx is fed by both detectors —
// its own build-id poll and the service worker's waiting worker, which
// components/pwa/ServiceWorkerManager.tsx reports — with one wording, one
// place (top-centre) and one prompt at a time; its tap is the one reload path
// (ask over an upload, then loadLatestBuild). PKG-1's service-worker
// behaviour is unchanged: registration, the waiting-worker detection, the
// SKIP_WAITING handshake and the offline pill.
//
// REGRESSION: the prompt still appears on BOTH detection paths, inside the
// protected shell and on a page without it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import UpdatePill, { UPDATE_PROMPT_TEXT, UpdatePillForWaitingWorker } from "@/components/system/UpdatePill";
import ServiceWorkerManager, { __resetWaitingWorkerForTests, waitingWorkerSnapshot, OFFLINE_PILL_TEXT } from "@/components/pwa/ServiceWorkerManager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const prompts = () => [...document.querySelectorAll("[data-update-prompt]")];

let versions: string[] = [];
const waiting = { postMessage: vi.fn() };
function installServiceWorker(withWaiting: boolean) {
  const reg = {
    waiting: withWaiting ? waiting : null,
    installing: null,
    addEventListener: vi.fn(),
  };
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

async function mount(el: React.ReactNode) {
  await act(async () => { root.render(el as React.ReactElement); });
  await flush();
}

beforeEach(() => {
  __resetWaitingWorkerForTests();
  waiting.postMessage.mockReset();
  versions = ["build-1"];
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ id: versions.shift() ?? "build-1" }) })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

describe("TAX-15 — one component, one wording, one prompt", () => {
  it("the version poll alone: the shell's pill shows the one wording (the poll path still works)", async () => {
    installServiceWorker(false);
    versions = ["build-1", "build-2"];
    await mount(React.createElement(UpdatePill));
    expect(prompts()).toHaveLength(0);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await flush();
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0].textContent).toBe(UPDATE_PROMPT_TEXT);
  });

  it("the waiting worker alone, inside the shell: the shell's pill shows it — the service worker renders no button of its own", async () => {
    installServiceWorker(true);
    await mount(React.createElement(React.Fragment, null, React.createElement(ServiceWorkerManager), React.createElement(UpdatePill)));
    expect(waitingWorkerSnapshot()).toBe(true);
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0].textContent).toBe(UPDATE_PROMPT_TEXT);
    expect(document.body.textContent).not.toContain("Update available");
  });

  it("both signals at once: exactly one prompt", async () => {
    installServiceWorker(true);
    versions = ["build-1", "build-2"];
    await mount(React.createElement(React.Fragment, null, React.createElement(ServiceWorkerManager), React.createElement(UpdatePill)));
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await flush();
    expect(prompts()).toHaveLength(1);
    expect(document.body.textContent?.split(UPDATE_PROMPT_TEXT).length).toBe(2);
  });

  it("a page without the shell (sign-in, a share link): the waiting worker still gets the same prompt, from ServiceWorkerManager", async () => {
    installServiceWorker(true);
    await mount(React.createElement(ServiceWorkerManager));
    await flush(12);
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0].textContent).toBe(UPDATE_PROMPT_TEXT);
    // and the stand-in steps aside the moment a shell instance mounts
    await mount(React.createElement(React.Fragment, null, React.createElement(ServiceWorkerManager), React.createElement(UpdatePill)));
    await flush(12);
    expect(prompts()).toHaveLength(1);
  });

  it("the stand-in renders nothing while the shell's pill is mounted, and nothing without a waiting worker", async () => {
    installServiceWorker(false);
    await mount(React.createElement(React.Fragment, null, React.createElement(UpdatePillForWaitingWorker)));
    expect(prompts()).toHaveLength(0);
  });

  it("the tap is the one reload path: it activates the waiting worker (SKIP_WAITING) through loadLatestBuild", async () => {
    installServiceWorker(true);
    await mount(React.createElement(React.Fragment, null, React.createElement(ServiceWorkerManager), React.createElement(UpdatePill)));
    await act(async () => { (prompts()[0].querySelector("button") as HTMLButtonElement).click(); });
    await flush();
    expect(waiting.postMessage).toHaveBeenCalledWith("SKIP_WAITING");
  });

  it("PKG-1 unchanged: the offline pill still shows bottom-left; the service worker's own update button and its words are gone", async () => {
    installServiceWorker(false);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    try {
      await mount(React.createElement(ServiceWorkerManager));
      expect(document.body.textContent).toContain(OFFLINE_PILL_TEXT);
    } finally {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    }
    // code, not comments (the comments name the retired wording)
    const code = (f: string) => readFileSync(resolve(f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const swm = code("components/pwa/ServiceWorkerManager.tsx");
    expect(swm).not.toContain("Update available — tap to refresh");
    expect(swm).not.toContain("applyUpdate");
    expect(swm).toContain('worker.state === "installed" && sw.controller');
    const pill = code("components/system/UpdatePill.tsx");
    expect(pill).not.toContain("This tab is running an old version");
    expect(UPDATE_PROMPT_TEXT).toBe("A newer version of the app is available — tap to load it");
  });
});
