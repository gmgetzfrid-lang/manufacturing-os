// @vitest-environment jsdom
//
// public-surfaces Round G — package PS-P6 STAMP IMAGES PER ACCOUNT.
//
//   OFF-15  The full-screen viewer kept the stamp images a person uploads
//           under ONE device-wide localStorage key
//           (manufacturingos.customStamps), so the next person on a shared
//           field tablet was offered the last person's uploaded initials.
//           Now the list is the signed-in person's own
//           (manufacturingos.customStamps:<uid>; CLIENT_STORAGE_INVENTORY
//           class "account", kind "identity" — kept across the person's own
//           sign-out, ended when a different identity runs the app here);
//           with no uid no stamps are offered or written; the legacy
//           device-wide list is MOVED, once, to the first signed-in uid that
//           opens the viewer with no list of its own.
//
// Driven AS RENDERED: the real FullScreenViewer (jsdom; react-pdf and fabric
// stubbed — the harness of dcRoundFP15MarkupExportRendered.test.ts), its
// stamp menu opened, a file chosen through the real hidden input, a stamp
// placed and removed through the real buttons. The sign-out / different
// identity ends are RoleContext's own purge (purgeAccountStorage, the scope
// noteIdentity and SIGNED_OUT use), driven by the real inventory row.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const s = vi.hoisted(() => ({
  added: [] as unknown[],
  fromURL: [] as string[],
}));

vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => {
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], error: null });
        return () => new Proxy(c, h);
      },
    };
    return new Proxy(c, h);
  };
  return { supabase: { from: () => chain(), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/lib/stamping", () => ({ applyStampToPdfDoc: vi.fn(), downloadStampedPdf: vi.fn(), stampPdf: vi.fn() }));
vi.mock("@/lib/downloads", async (orig) => ({
  ...(await orig<typeof import("@/lib/downloads")>()),
  logDownloadAudit: vi.fn(async () => ({ recorded: true })),
  downloadDocumentPdf: vi.fn(),
  printDocumentPdf: vi.fn(),
}));
vi.mock("@/lib/markupExport", () => ({ bakeMarkupIntoDoc: vi.fn(async () => undefined), bakeMarkupIntoPdf: vi.fn(async () => undefined) }));
vi.mock("@/lib/draftHandoff", () => ({ stashDraft: vi.fn() }));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn(async () => undefined) }));
vi.mock("@/lib/revisions", () => ({ listVersions: vi.fn(async () => []) }));
vi.mock("@/lib/publicOrigin", () => ({ publicOrigin: () => "" }));
vi.mock("@/lib/pdfjsConfig", () => ({ PDF_DOC_OPTIONS: {} }));
vi.mock("react-pdf", () => ({ Document: () => null, Page: () => null, pdfjs: { GlobalWorkerOptions: {} } }));
vi.mock("react-pdf/dist/Page/AnnotationLayer.css", () => ({}));
vi.mock("react-pdf/dist/Page/TextLayer.css", () => ({}));
vi.mock("fabric", () => {
  class Canvas {
    isDrawingMode = false; selection = true; defaultCursor = "default"; hoverCursor = "move";
    on() {} off() {} dispose() {} requestRenderAll() {} remove() {} clear() {} calcOffset() {} setDimensions() {}
    add(o: unknown) { s.added.push(o); }
    discardActiveObject() {} setActiveObject() {}
    getActiveObject() { return null; }
    getActiveObjects() { return []; }
    toJSON() { return { objects: [] }; }
    async loadFromJSON() {}
  }
  class PencilBrush { color = ""; width = 1; }
  class FabricImage {
    width = 200;
    src: string;
    constructor(src: string) { this.src = src; }
    set() { return this; }
    static async fromURL(url: string) { s.fromURL.push(url); return new FabricImage(url); }
  }
  return { Canvas, PencilBrush, FabricImage };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: vi.fn() }));
vi.mock("@/components/documents/CheckoutStatusCell", () => ({ default: () => null }));
vi.mock("@/components/assets/EquipmentTagsStrip", () => ({ default: () => null }));
vi.mock("@/components/documents/CompareRevisionsModal", () => ({ default: () => null }));
vi.mock("@/components/archive/BackupViewer", () => ({ default: () => null }));
vi.mock("@/components/ui/QrBadge", () => ({ default: () => null }));

import FullScreenViewer from "@/components/viewers/FullScreenViewer";
import { CLIENT_STORAGE_INVENTORY, purgeAccountStorage, purgeTakes } from "@/components/providers/RoleContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEGACY = "manufacturingos.customStamps";
const keyOf = (uid: string) => `manufacturingos.customStamps:${uid}`;
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

let host: HTMLDivElement;
let root: Root;
const quiet: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  s.added.length = 0;
  s.fromURL.length = 0;
  quiet.push(vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  quiet.length = 0;
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const button = (pred: (b: HTMLButtonElement) => boolean) => Array.from(host.querySelectorAll("button")).find(pred);

/** Render the viewer as `uid` (undefined = no signed-in uid) and open its stamp menu. */
async function openAs(uid: string | undefined) {
  await act(async () => {
    root.render(React.createElement(FullScreenViewer, {
      isOpen: true, onClose: () => {}, url: "https://files.example/p101.pdf", title: "Overhead P&ID", docNumber: "P-101", rev: "C",
      currentUserId: uid, currentUserEmail: uid ? `${uid}@x.io` : undefined,
    }));
  });
  await settle();
  await click(button((b) => b.title === "Stamp")!);
}
/** A fresh mount (closing the viewer and opening it again — a later visit). */
async function reopenAs(uid: string | undefined) {
  act(() => root.unmount());
  root = createRoot(host);
  await openAs(uid);
}
/** The custom stamps the open menu offers, by name. */
const offered = () => Array.from(host.querySelectorAll("button img")).map((i) => (i as HTMLImageElement).alt);
const uploadBtn = () => button((b) => b.textContent === "+ Upload")!;
const hint = () => Array.from(host.querySelectorAll("div")).find((d) => /PNG\/JPG\/SVG|Sign in to upload/.test(d.textContent ?? "") && d.children.length === 0)?.textContent;

async function upload(name: string, bytes = name) {
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([bytes], name, { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  for (let i = 0; i < 10 && !offered().includes(name); i++) await settle();
}
const stored = (key: string) => {
  const raw = window.localStorage.getItem(key);
  return raw === null ? null : (JSON.parse(raw) as Array<{ id: string; name: string; src: string }>).map((x) => x.name);
};
const stamp = (n: number) => ({ id: `cs-${n}`, name: `legacy-${n}.png`, src: `data:image/png;base64,${btoa(`legacy-${n}`)}` });

describe("OFF-15 — a stamp uploaded by one person is never offered to another", () => {
  it("u1 uploads; u2 on the same device is offered nothing; u1 still has it (was: one device-wide list u2 was offered)", async () => {
    await openAs("u1");
    await upload("initials-u1.png");
    expect(offered()).toEqual(["initials-u1.png"]);
    expect(stored(keyOf("u1"))).toEqual(["initials-u1.png"]);
    expect(window.localStorage.getItem(LEGACY)).toBeNull(); // nothing device-wide is written

    await reopenAs("u2");
    expect(offered()).toEqual([]);
    await upload("initials-u2.png");
    expect(offered()).toEqual(["initials-u2.png"]);
    expect(stored(keyOf("u2"))).toEqual(["initials-u2.png"]);
    expect(stored(keyOf("u1"))).toEqual(["initials-u1.png"]);

    await reopenAs("u1");
    expect(offered()).toEqual(["initials-u1.png"]);
  });

  it("a different person signing in while the viewer is open reads their own list at once — never the last person's (and an upload lands on their key)", async () => {
    await openAs("u1");
    await upload("initials-u1.png");
    await act(async () => {
      root.render(React.createElement(FullScreenViewer, {
        isOpen: true, onClose: () => {}, url: "https://files.example/p101.pdf", title: "Overhead P&ID", docNumber: "P-101", rev: "C",
        currentUserId: "u2", currentUserEmail: "u2@x.io",
      }));
    });
    await settle();
    expect(offered()).toEqual([]);
    await upload("initials-u2.png");
    expect(stored(keyOf("u2"))).toEqual(["initials-u2.png"]);
    expect(stored(keyOf("u1"))).toEqual(["initials-u1.png"]);
  });

  it("with no signed-in uid, no stamps are offered or written — the upload is disabled and says why", async () => {
    window.localStorage.setItem(keyOf("u1"), JSON.stringify([stamp(1)]));
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(2)]));
    await openAs(undefined);
    expect(offered()).toEqual([]);
    expect(uploadBtn().disabled).toBe(true);
    expect(hint()).toBe("Sign in to upload and use your stamps.");
    await upload("nobody.png");
    expect(offered()).toEqual([]);
    // untouched: u1's list, and the legacy list (left for a signed-in person to take)
    expect(stored(keyOf("u1"))).toEqual(["legacy-1.png"]);
    expect(stored(LEGACY)).toEqual(["legacy-2.png"]);
    expect(Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)).sort()).toEqual([LEGACY, keyOf("u1")].sort());
  });
});

describe("OFF-15 — the same person's stamps survive their sign-out; a different identity ends them (DEC-91 §2, kind \"identity\")", () => {
  it("the inventory classes the uid key account / identity and the legacy key device; the purge keeps a person's list across SIGNED_OUT and an evaporated session", async () => {
    const row = (key: string) => CLIENT_STORAGE_INVENTORY.find((r) => r.store === "local" && r.key === key);
    expect(row("manufacturingos.customStamps:")).toMatchObject({ match: "prefix", class: "account", kind: "identity", owners: ["components/viewers/FullScreenViewer.tsx"] });
    expect(row(LEGACY)).toMatchObject({ match: "exact", class: "device", owners: ["components/viewers/FullScreenViewer.tsx"] });
    expect([purgeTakes("signout", "identity"), purgeTakes("cache", "identity"), purgeTakes("all", "identity")]).toEqual([false, false, true]);

    await openAs("u1");
    await upload("initials-u1.png");
    // SIGNED_OUT (a sign-out button or an expired token): RoleContext's "signout" purge
    purgeAccountStorage(window.localStorage, "local", "signout");
    purgeAccountStorage(window.sessionStorage, "session", "signout");
    expect(stored(keyOf("u1"))).toEqual(["initials-u1.png"]);
    // the same person signs back in and opens a drawing: their stamp is there
    await reopenAs("u1");
    expect(offered()).toEqual(["initials-u1.png"]);
    // a session that merely evaporated keeps it too
    purgeAccountStorage(window.localStorage, "local", "cache");
    await reopenAs("u1");
    expect(offered()).toEqual(["initials-u1.png"]);
  });

  it("a DIFFERENT identity running the app here ends the last person's list before it reads anything (noteIdentity's \"all\" purge); the legacy device key is not an account read and is left for its one-time move", async () => {
    await openAs("u1");
    await upload("initials-u1.png");
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1)]));
    purgeAccountStorage(window.localStorage, "local", "all");
    expect(window.localStorage.getItem(keyOf("u1"))).toBeNull();
    expect(stored(LEGACY)).toEqual(["legacy-1.png"]);
  });
});

describe("OFF-15 — the legacy device-wide list moves once, to the first signed-in person, and is never read again", () => {
  it("u1's first open takes the legacy list (moved to u1's key, the legacy key removed); u2 later gets nothing; u1 keeps it", async () => {
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1), stamp(2)]));
    await openAs("u1");
    expect(offered()).toEqual(["legacy-1.png", "legacy-2.png"]);
    expect(stored(keyOf("u1"))).toEqual(["legacy-1.png", "legacy-2.png"]);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();

    await reopenAs("u2");
    expect(offered()).toEqual([]);
    expect(window.localStorage.getItem(keyOf("u2"))).toBeNull();

    await reopenAs("u1");
    expect(offered()).toEqual(["legacy-1.png", "legacy-2.png"]);
  });

  it("a person who already has a list of their own never reads the legacy list (it waits for a person with none)", async () => {
    window.localStorage.setItem(keyOf("u1"), JSON.stringify([]));
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1)]));
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    await openAs("u1");
    expect(offered()).toEqual([]);
    expect(getItem.mock.calls.map((c) => c[0])).toContain(keyOf("u1")); // the spy sees the viewer's reads (not vacuous)
    expect(getItem.mock.calls.map((c) => c[0])).not.toContain(LEGACY);
    expect(stored(LEGACY)).toEqual(["legacy-1.png"]);
  });

  it("a store that refuses the write keeps the legacy list in place (never lost) and still offers it this once", async () => {
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1)]));
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith("manufacturingos.customStamps:")) throw new DOMException("quota", "QuotaExceededError");
      return real.call(this, k, v);
    });
    await openAs("u1");
    expect(offered()).toEqual(["legacy-1.png"]);
    expect(stored(LEGACY)).toEqual(["legacy-1.png"]);
    expect(window.localStorage.getItem(keyOf("u1"))).toBeNull();
  });

  it("an unreadable legacy list is not a stamp list: nothing is offered, and it is not carried forward", async () => {
    window.localStorage.setItem(LEGACY, "{not json");
    await openAs("u1");
    expect(offered()).toEqual([]);
    expect(stored(keyOf("u1"))).toEqual([]);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
  });
});

describe("OFF-15 REGRESSION — upload, use, removal and the 12-stamp cap behave exactly as before", () => {
  it("upload: a PNG lands first in the list; a non-image is ignored", async () => {
    await openAs("u1");
    expect(hint()).toBe("Upload PNG/JPG/SVG stamps — saved on this device for your account.");
    expect(uploadBtn().disabled).toBe(false);
    await upload("a.png");
    await upload("b.png");
    expect(offered()).toEqual(["b.png", "a.png"]);
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["x"], "notes.txt", { type: "text/plain" })], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle(); await settle();
    expect(offered()).toEqual(["b.png", "a.png"]);
    expect(stored(keyOf("u1"))).toEqual(["b.png", "a.png"]);
    // the stored entry is the data URL, as before
    const saved = JSON.parse(window.localStorage.getItem(keyOf("u1"))!) as Array<{ id: string; src: string }>;
    expect(saved[0].src).toBe(`data:image/png;base64,${btoa("b.png")}`);
    expect(saved[0].id).toMatch(/^cs-\d+$/);
  });

  it("use: clicking a stamp places that image on the canvas and closes the menu", async () => {
    await openAs("u1");
    await upload("a.png");
    await click(button((b) => b.title === "a.png")!);
    await settle();
    expect(s.fromURL).toEqual([`data:image/png;base64,${btoa("a.png")}`]);
    expect(s.added).toHaveLength(1);
    expect(offered()).toEqual([]); // the menu closed
  });

  it("removal: × takes the stamp out of the menu and out of the person's stored list", async () => {
    await openAs("u1");
    await upload("a.png");
    await upload("b.png");
    const removeA = Array.from(host.querySelectorAll("button[title='Remove']"))[1] as HTMLButtonElement;
    await click(removeA);
    expect(offered()).toEqual(["b.png"]);
    expect(stored(keyOf("u1"))).toEqual(["b.png"]);
  });

  it("the cap: the 13th upload keeps the newest 12", async () => {
    window.localStorage.setItem(keyOf("u1"), JSON.stringify(Array.from({ length: 12 }, (_, i) => stamp(i + 1))));
    await openAs("u1");
    expect(offered()).toHaveLength(12);
    await upload("newest.png");
    expect(offered()).toHaveLength(12);
    expect(offered()[0]).toBe("newest.png");
    expect(offered()).not.toContain("legacy-12.png");
    expect(stored(keyOf("u1"))).toEqual(["newest.png", ...Array.from({ length: 11 }, (_, i) => `legacy-${i + 1}.png`)]);
  });

  it("source: the viewer keys every read and write by the uid; the device-wide key is only read to be moved and removed", () => {
    const v = src("components/viewers/FullScreenViewer.tsx");
    expect(v).toMatch(/const customStampsKey = \(uid: string\) => `manufacturingos\.customStamps:\$\{uid\}`;/);
    expect(v.match(/localStorage\.setItem\(LEGACY_CUSTOM_STAMPS_KEY/g)).toBeNull();
    expect(v.match(/\.setItem\(LEGACY_CUSTOM_STAMPS_KEY/g)).toBeNull();
    expect(v.match(/\.getItem\(LEGACY_CUSTOM_STAMPS_KEY\)/g)).toHaveLength(1);
    expect(v.match(/\.removeItem\(LEGACY_CUSTOM_STAMPS_KEY\)/g)).toHaveLength(1);
    expect(v).not.toMatch(/"manufacturingos\.customStamps"\)/);
  });
});
