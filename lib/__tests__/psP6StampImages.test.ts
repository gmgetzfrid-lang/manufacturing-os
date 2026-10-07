// @vitest-environment jsdom
//
// public-surfaces Round G — package PS-P6 STAMP IMAGES PER ACCOUNT.
//
//   OFF-15  The full-screen viewer kept the stamp images a person uploads
//           under ONE device-wide localStorage key
//           (manufacturingos.customStamps), so the next person on a shared
//           field tablet was offered the last person's uploaded initials.
//           Now the list is the signed-in person's own
//           (manufacturingos.customStamps:<uid>, lib/customStamps.ts;
//           CLIENT_STORAGE_INVENTORY class "uid-scoped" — never offered to
//           another identity, kept across the person's own sign-out AND
//           across another person's run of the app here, as their stamps
//           were before); with no uid no stamps are offered or written; the
//           legacy device-wide list is MOVED, once, to the first identity
//           that signs in here after the change (claimLegacyStampsAtSignIn,
//           which RoleContext's noteIdentity runs BEFORE any purge — review
//           fix 3: it was ended by a different identity's arrival before
//           anyone had read it), and the device is marked so no later
//           identity is offered it; the viewer's first read applies the same
//           rule when that move was refused.
//   OFF-16  Review fix 3: once a SECOND account keeps a list on the device,
//           an upload that would take every account's lists together past
//           DEVICE_STAMP_BUDGET is refused and the menu says so — the lists
//           of many people on a shared tablet no longer fill the quota and
//           starve the app's other keys (a person alone on their device is
//           never refused by it, as before).
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
import { DEVICE_STAMP_BUDGET, claimLegacyStampsAtSignIn, stampUploadOverDeviceBudget } from "@/lib/customStamps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Every case mounts the real viewer (react-pdf and fabric stubbed); under a loaded full run a mount alone can pass the 5 s default,
// and a case that times out leaves its act() open for the next one.
vi.setConfig({ testTimeout: 30_000 });

const LEGACY = "manufacturingos.customStamps";
const MOVED = "manufacturingos.customStamps.moved";
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

describe("OFF-15 — the same person's stamps survive their sign-out and another person's run of the app, never offered to that person (DEC-91 §2, \"uid-scoped\")", () => {
  it("the inventory classes the uid key uid-scoped (no purge takes it), the legacy key account / identity and the moved marker device; the purge keeps a person's list across SIGNED_OUT and an evaporated session", async () => {
    const row = (key: string) => CLIENT_STORAGE_INVENTORY.find((r) => r.store === "local" && r.key === key);
    expect(row("manufacturingos.customStamps:")).toMatchObject({ match: "prefix", class: "uid-scoped", owners: ["lib/customStamps.ts", "components/viewers/FullScreenViewer.tsx"] });
    expect(row("manufacturingos.customStamps:")?.kind).toBeUndefined();
    expect(row(LEGACY)).toMatchObject({ match: "exact", class: "account", kind: "identity", owners: ["lib/customStamps.ts"] });
    expect(row(MOVED)).toMatchObject({ match: "exact", class: "device", owners: ["lib/customStamps.ts"] });
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

  it("a DIFFERENT identity running the app here (noteIdentity's \"all\" purge) leaves the person's list — uid-scoped — and ends a legacy list not yet moved; the device marker stays", async () => {
    await openAs("u1");
    await upload("initials-u1.png");
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1)]));
    window.localStorage.setItem(MOVED, "1");
    purgeAccountStorage(window.localStorage, "local", "signout");
    purgeAccountStorage(window.localStorage, "local", "cache");
    expect(stored(LEGACY)).toEqual(["legacy-1.png"]); // kept across a sign-out and an evaporation
    purgeAccountStorage(window.localStorage, "local", "all");
    expect(stored(keyOf("u1"))).toEqual(["initials-u1.png"]);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
    expect(window.localStorage.getItem(MOVED)).toBe("1");
  });

  it("second review fix (done-when 1 on a shared device): a person's stamps outlive ANOTHER person's run of the app, as before OFF-15 — and that person is never offered them (was: kind \"identity\" ended them at the other person's boot, so they were uploaded again after every other shift)", async () => {
    await openAs("u1");
    await upload("initials-u1.png");
    purgeAccountStorage(window.localStorage, "local", "signout"); // u1 signs out
    purgeAccountStorage(window.localStorage, "local", "all");     // u2 boots on the same tablet
    await reopenAs("u2");                                          // u2 opens a drawing
    expect(offered()).toEqual([]);
    expect(window.localStorage.getItem(keyOf("u2"))).toBeNull();
    purgeAccountStorage(window.localStorage, "local", "signout"); // u2 signs out
    purgeAccountStorage(window.localStorage, "local", "all");     // u1 boots again: the "all" purge for u2's data
    await reopenAs("u1");                                          // u1 signs back in
    expect(offered()).toEqual(["initials-u1.png"]);
  });
});

describe("OFF-15 — the legacy device-wide list moves once, to the first identity, and is never read again after the move", () => {
  it("u1's first open takes the legacy list (moved to u1's key, the legacy key removed, the device marked); u2 later gets nothing; u1 keeps it", async () => {
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1), stamp(2)]));
    await openAs("u1");
    expect(offered()).toEqual(["legacy-1.png", "legacy-2.png"]);
    expect(stored(keyOf("u1"))).toEqual(["legacy-1.png", "legacy-2.png"]);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
    expect(window.localStorage.getItem(MOVED)).toBe("1");

    await reopenAs("u2");
    expect(offered()).toEqual([]);
    expect(window.localStorage.getItem(keyOf("u2"))).toBeNull();

    await reopenAs("u1");
    expect(offered()).toEqual(["legacy-1.png", "legacy-2.png"]);
  });

  it("review fix 3 (the first reviewer's path, the move now at the sign-in): u1 signs in and never opens a drawing — the list is u1's already; u2 signs in next and is offered nothing; u1 opens a drawing later and has it (was: u2's boot ended it, or, as \"device\", handed it to u2)", async () => {
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1)]));
    claimLegacyStampsAtSignIn("u1");                               // u1's sign-in (noteIdentity)
    expect(stored(keyOf("u1"))).toEqual(["legacy-1.png"]);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
    expect(window.localStorage.getItem(MOVED)).toBe("1");
    purgeAccountStorage(window.localStorage, "local", "signout"); // u1 signs out without opening the viewer
    claimLegacyStampsAtSignIn("u2");                               // u2's sign-in: the device is marked — nothing for u2
    purgeAccountStorage(window.localStorage, "local", "all");     // then noteIdentity's "all" purge
    await openAs("u2");
    expect(offered()).toEqual([]);
    expect(window.localStorage.getItem(keyOf("u2"))).toBeNull();
    await reopenAs("u1");
    expect(offered()).toEqual(["legacy-1.png"]);
  });

  it("review fix 3 (the second reviewer's path): the device remembers B; A, who uploaded the list under the old code, signs in first — A's sign-in takes it before the purge for B runs, so A has their stamps (was: the purge ended it before A opened a drawing, without a word)", async () => {
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1), stamp(2)]));
    claimLegacyStampsAtSignIn("uA");                               // noteIdentity, BEFORE its purge (sessSixRoleNull pins the order, rendered)
    purgeAccountStorage(window.localStorage, "local", "all");     // the purge for the remembered B
    await openAs("uA");
    expect(offered()).toEqual(["legacy-1.png", "legacy-2.png"]);
    await reopenAs("uB");
    expect(offered()).toEqual([]);
  });

  it("review fix 3: the sign-in move runs once per device — marked at the first sign-in even with nothing to move, so a value a tab still running the old code writes later is never read by any sign-in or viewer; a uid that has a list of its own marks the device and leaves the legacy value unread", async () => {
    claimLegacyStampsAtSignIn("u1");
    expect(window.localStorage.getItem(MOVED)).toBe("1");
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1)])); // an old-code tab
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    claimLegacyStampsAtSignIn("u2");
    await openAs("u2");
    expect(offered()).toEqual([]);
    expect(getItem.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([MOVED, keyOf("u2")])); // not vacuous
    expect(getItem.mock.calls.map((c) => c[0])).not.toContain(LEGACY);
    getItem.mockRestore();
    // a fresh device where the arriving uid somehow already keeps a list: marked, the legacy value left unread (the next identity change ends it)
    window.localStorage.clear();
    window.localStorage.setItem(keyOf("u3"), JSON.stringify([stamp(3)]));
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1)]));
    claimLegacyStampsAtSignIn("u3");
    expect(stored(keyOf("u3"))).toEqual(["legacy-3.png"]);
    expect(window.localStorage.getItem(MOVED)).toBe("1");
    expect(stored(LEGACY)).toEqual(["legacy-1.png"]);
  });

  it("review fix 3: a sign-in move the store refuses leaves the list where it was and the device unmarked — the person's first viewer open offers it to them, pending, and their next write lands it", async () => {
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1), stamp(2)]));
    const real = Storage.prototype.setItem;
    let refuse = true;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (refuse && k.startsWith("manufacturingos.customStamps:")) throw new DOMException("quota", "QuotaExceededError");
      return real.call(this, k, v);
    });
    claimLegacyStampsAtSignIn("u1");
    expect(stored(LEGACY)).toEqual(["legacy-1.png", "legacy-2.png"]); // put back
    expect(window.localStorage.getItem(MOVED)).toBeNull();
    await openAs("u1");
    expect(offered()).toEqual(["legacy-1.png", "legacy-2.png"]);
    refuse = false;
    await click(Array.from(host.querySelectorAll("button[title='Remove']"))[0]);
    expect(stored(keyOf("u1"))).toEqual(["legacy-2.png"]);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
    expect(window.localStorage.getItem(MOVED)).toBe("1");
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

  it("review fix: after the move the legacy key is never read again — a value a tab still running the old code writes there later is offered to no one, and the next identity change ends it", async () => {
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1)]));
    await openAs("u1");
    expect(stored(keyOf("u1"))).toEqual(["legacy-1.png"]);
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1), stamp(2)])); // a stale tab writes the device-wide key again
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    await reopenAs("u2");
    expect(offered()).toEqual([]);
    expect(getItem.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([keyOf("u2"), MOVED])); // not vacuous
    expect(getItem.mock.calls.map((c) => c[0])).not.toContain(LEGACY);
    expect(window.localStorage.getItem(keyOf("u2"))).toBeNull();
    purgeAccountStorage(window.localStorage, "local", "all");
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
  });

  it("review fix: the move removes the legacy list FIRST, so a list that fills most of the quota still moves (copying it beside the original would not fit)", async () => {
    // jsdom's localStorage quota is 5,000,000 code units; this list is ~3,000,000
    const big = { id: "cs-1", name: "legacy-big.png", src: `data:image/png;base64,${"A".repeat(3_000_000)}` };
    window.localStorage.setItem(LEGACY, JSON.stringify([big]));
    expect(() => window.localStorage.setItem("probe", JSON.stringify([big]))).toThrow(); // a copy beside it does not fit
    await openAs("u1");
    expect(offered()).toEqual(["legacy-big.png"]);
    expect(stored(keyOf("u1"))).toEqual(["legacy-big.png"]);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
    expect(window.localStorage.getItem(MOVED)).toBe("1");
  });

  it("review fix: a store that refuses the move puts the legacy list back and offers it to this person; their first write that lands finishes the move, so the next person is offered nothing (was: the legacy key stayed and went to the next person, a removed stamp included)", async () => {
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1), stamp(2)]));
    const real = Storage.prototype.setItem;
    let refuse = true;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (refuse && k.startsWith("manufacturingos.customStamps:")) throw new DOMException("quota", "QuotaExceededError");
      return real.call(this, k, v);
    });
    await openAs("u1");
    expect(offered()).toEqual(["legacy-1.png", "legacy-2.png"]);
    expect(stored(LEGACY)).toEqual(["legacy-1.png", "legacy-2.png"]); // put back: never lost
    expect(window.localStorage.getItem(keyOf("u1"))).toBeNull();
    expect(window.localStorage.getItem(MOVED)).toBeNull();

    refuse = false; // room again: u1 removes legacy-1, and that write lands
    const removeFirst = Array.from(host.querySelectorAll("button[title='Remove']"))[0] as HTMLButtonElement;
    await click(removeFirst);
    expect(offered()).toEqual(["legacy-2.png"]);
    expect(stored(keyOf("u1"))).toEqual(["legacy-2.png"]);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
    expect(window.localStorage.getItem(MOVED)).toBe("1");

    await reopenAs("u2");
    expect(offered()).toEqual([]);
    await reopenAs("u1");
    expect(offered()).toEqual(["legacy-2.png"]);
  });

  it("second review fix: in a near-full store, a removal while the move is pending lands and stays removed — the pending write removes the legacy copy first, as the move does (was: written beside the legacy copy, refused, and the removed stamp offered again on the next open)", async () => {
    // jsdom's quota is 5,000,000 code units (keys and values). A real uid makes the uid key 37 units longer than the legacy key, and the
    // store leaves 10 free: the list cannot be written under the uid in the room the legacy list frees, so the move at the first open is
    // refused; one stamp removed fits in it.
    const U = "11111111-2222-3333-4444-555555555555";
    const big = (n: number) => ({ id: `cs-${n}`, name: `big-${n}.png`, src: `data:image/png;base64,${"A".repeat(1_000_000)}` });
    window.localStorage.setItem(LEGACY, JSON.stringify([big(1), big(2)]));
    const used = () => Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!).reduce((t, k) => t + k.length + window.localStorage.getItem(k)!.length, 0);
    window.localStorage.setItem("filler", "x".repeat(5_000_000 - used() - 10 - "filler".length));
    expect(5_000_000 - used()).toBe(10);
    expect(keyOf(U).length - LEGACY.length).toBe(37);

    await openAs(U);
    expect(offered()).toEqual(["big-1.png", "big-2.png"]);
    expect(window.localStorage.getItem(keyOf(U))).toBeNull(); // refused: pending
    expect(stored(LEGACY)).toEqual(["big-1.png", "big-2.png"]);
    expect(window.localStorage.getItem(MOVED)).toBeNull();

    await click(Array.from(host.querySelectorAll("button[title='Remove']"))[0]);
    expect(offered()).toEqual(["big-2.png"]);
    expect(stored(keyOf(U))).toEqual(["big-2.png"]);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
    expect(window.localStorage.getItem(MOVED)).toBe("1");

    await reopenAs(U);
    expect(offered()).toEqual(["big-2.png"]); // the removal stayed removed
    await reopenAs("u2");
    expect(offered()).toEqual([]);
  });

  it("a refused move retried: while every write is refused the legacy list stays put and is offered again to the same person on their next open", async () => {
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1)]));
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith("manufacturingos.customStamps:")) throw new DOMException("quota", "QuotaExceededError");
      return real.call(this, k, v);
    });
    await openAs("u1");
    await upload("new.png"); // refused too — ignored, as before
    expect(stored(LEGACY)).toEqual(["legacy-1.png"]);
    await reopenAs("u1");
    expect(offered()).toEqual(["legacy-1.png"]);
    expect(window.localStorage.getItem(MOVED)).toBeNull();
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

  it("source: every stamp read and write is keyed by the uid (lib/customStamps.ts — the viewer touches storage only through it); the device-wide key is read only before the device is marked (after the marker check, at a sign-in or a first read, or while the move is pending), removed before the uid list is written, and written only to put back the value it held", () => {
    const v = src("components/viewers/FullScreenViewer.tsx");
    const lib = src("lib/customStamps.ts");
    expect(v).not.toMatch(/localStorage\.(get|set|remove)Item/);
    expect(v).toMatch(/import \{ loadStampShelf, moveLegacyStamps, stampUploadOverDeviceBudget, writeStampList, type CustomStamp, type StampShelf \} from "@\/lib\/customStamps";/);
    expect(lib).toMatch(/export const customStampsKey = \(uid: string\) => `manufacturingos\.customStamps:\$\{uid\}`;/);
    expect(lib.match(/\.setItem\(LEGACY_CUSTOM_STAMPS_KEY/g)).toEqual([".setItem(LEGACY_CUSTOM_STAMPS_KEY"]);
    expect(lib).toMatch(/catch \{\n\s*if \(legacy !== null\) \{ try \{ window\.localStorage\.setItem\(LEGACY_CUSTOM_STAMPS_KEY, legacy\); \}/);
    expect(lib.match(/\.getItem\(LEGACY_CUSTOM_STAMPS_KEY\)/g)).toHaveLength(3); // the sign-in's read; loadStampShelf's; moveLegacyStamps' (the value it puts back)
    expect(lib.match(/\.removeItem\(LEGACY_CUSTOM_STAMPS_KEY\)/g)).toHaveLength(1); // the move, only
    const move = lib.slice(lib.indexOf("export function moveLegacyStamps("), lib.indexOf("export function claimLegacyStampsAtSignIn("));
    expect(move.indexOf("removeItem(LEGACY_CUSTOM_STAMPS_KEY)")).toBeGreaterThan(0);
    expect(move.indexOf("removeItem(LEGACY_CUSTOM_STAMPS_KEY)")).toBeLessThan(move.indexOf("setItem(customStampsKey(uid)"));
    expect(move.indexOf("setItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY")).toBeGreaterThan(move.indexOf("setItem(customStampsKey(uid)"));
    for (const [from, to] of [["export function claimLegacyStampsAtSignIn(", "export function loadStampShelf("], ["export function loadStampShelf(", "export function writeStampList("]]) {
      const fn = lib.slice(lib.indexOf(from), lib.indexOf(to));
      expect(fn.indexOf("getItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY)"), from).toBeGreaterThan(0);
      expect(fn.indexOf("getItem(LEGACY_CUSTOM_STAMPS_KEY)"), from).toBeGreaterThan(fn.indexOf("getItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY)"));
      expect(fn.indexOf("moveLegacyStamps("), from).toBeGreaterThan(fn.indexOf("getItem(LEGACY_CUSTOM_STAMPS_KEY)"));
    }
    // the move runs only from the sign-in and the first read (above) and, while it is pending, from the viewer's persistCustomStamps
    expect(lib.match(/moveLegacyStamps\(/g)).toHaveLength(3); // the definition and its two callers here
    expect(v.match(/moveLegacyStamps\(/g)).toHaveLength(1);
    expect(v).toMatch(/if \(legacyPending\) saved = moveLegacyStamps\(stampUid, next\);/);
    expect(v).not.toMatch(/"manufacturingos\.customStamps/);
  });
});

describe("OFF-16 (review fix 3) — every account's stamp lists on a device together stay within its stamp budget, so they cannot starve the app's other keys", () => {
  const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? null;
  const REFUSED = "Stamp storage on this device is full, so this image was not added. Remove one of your stamps, or upload a smaller image.";
  // count the viewer's finished file reads, so each upload is awaited to its end (accepted or refused)
  let reads = 0;
  beforeEach(() => {
    reads = 0;
    const realRead = FileReader.prototype.readAsDataURL;
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader, blob: Blob) {
      this.addEventListener("loadend", () => { reads++; });
      return realRead.call(this, blob);
    });
  });
  /** Choose a file and wait until the viewer has read it and either kept or refused it. */
  async function tryUpload(name: string, bytes: string) {
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File([bytes], name, { type: "image/png" })], configurable: true });
    const before = reads;
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    for (let i = 0; i < 200 && reads === before; i++) await settle();
    expect(reads).toBe(before + 1);
    await settle();
  }
  const used = () => Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!).reduce((t, k) => t + k.length + window.localStorage.getItem(k)!.length, 0);
  const stampRoom = () => Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!)
    .filter((k) => k.startsWith("manufacturingos.customStamps:")).reduce((t, k) => t + k.length + window.localStorage.getItem(k)!.length, 0);
  /** Another account's list of `units` code units (key + value). */
  const seedOther = (uid: string, units: number) => {
    const pad = units - keyOf(uid).length - JSON.stringify([{ id: "cs-1", name: "o.png", src: "" }]).length;
    window.localStorage.setItem(keyOf(uid), JSON.stringify([{ id: "cs-1", name: "o.png", src: "A".repeat(pad) }]));
  };

  it("the reviewer's reproduction, driven through the viewer: 40 people on one tablet each upload 3 stamps of 10–80 KB — the stamp lists never pass the budget, the uploads past it are refused and said, and a 20,000-unit graph-layout write and a session write still land (was: 34 people filled the 5,000,000-unit store and those writes were refused)", async () => {
    const sizes = [10_000, 45_000, 80_000];
    let accepted = 0, refused = 0;
    for (let p = 1; p <= 40; p++) {
      await reopenAs(`person-${p}`);
      for (let j = 0; j < 3; j++) {
        await tryUpload(`p${p}-s${j}.png`, String.fromCharCode(65 + j).repeat(sizes[j]));
        if (offered().includes(`p${p}-s${j}.png`)) accepted++;
        else { expect(alertText()).toBe(REFUSED); refused++; }
      }
      expect(stampRoom()).toBeLessThanOrEqual(DEVICE_STAMP_BUDGET);
    }
    expect(accepted).toBeGreaterThan(10);
    expect(refused).toBeGreaterThan(60);
    expect(5_000_000 - used()).toBeGreaterThan(3_400_000);
    expect(() => window.localStorage.setItem("orgGraph:pos:o1", "x".repeat(20_000))).not.toThrow();
    expect(() => window.localStorage.setItem("sb-ref-auth-token", "t".repeat(4_000))).not.toThrow();
  }, 60_000);

  it("seeded to the budget by other accounts: the upload is refused with a visible message, nothing is written, nobody's list is touched; a smaller image that fits lands and clears the message", async () => {
    seedOther("u2", 900_000);
    seedOther("u3", DEVICE_STAMP_BUDGET - 900_000 - 20_000);
    const before = { u2: window.localStorage.getItem(keyOf("u2")), u3: window.localStorage.getItem(keyOf("u3")) };
    await openAs("u1");
    expect(alertText()).toBeNull();
    await tryUpload("big.png", "B".repeat(30_000)); // ~40,000 units as a data URL
    expect(alertText()).toBe(REFUSED);
    expect(offered()).toEqual([]);
    expect(window.localStorage.getItem(keyOf("u1"))).toBeNull();
    expect({ u2: window.localStorage.getItem(keyOf("u2")), u3: window.localStorage.getItem(keyOf("u3")) }).toEqual(before);
    await tryUpload("small.png", "s".repeat(3_000));
    expect(offered()).toEqual(["small.png"]);
    expect(alertText()).toBeNull();
    expect(stored(keyOf("u1"))).toEqual(["small.png"]);
    expect(stampRoom()).toBeLessThanOrEqual(DEVICE_STAMP_BUDGET);
  });

  it("the message is the refused person's only: another person signing in on the open viewer does not see it", async () => {
    seedOther("u2", DEVICE_STAMP_BUDGET);
    await openAs("u1");
    await tryUpload("big.png", "B".repeat(30_000));
    expect(alertText()).toBe(REFUSED);
    await act(async () => {
      root.render(React.createElement(FullScreenViewer, {
        isOpen: true, onClose: () => {}, url: "https://files.example/p101.pdf", title: "Overhead P&ID", docNumber: "P-101", rev: "C",
        currentUserId: "u3", currentUserEmail: "u3@x.io",
      }));
    });
    await settle();
    expect(alertText()).toBeNull();
  });

  it("REGRESSION: a person alone on their device is never refused by the budget — their one list is bounded by the store only, as the device-wide list was before", async () => {
    window.localStorage.setItem(keyOf("u1"), JSON.stringify([{ id: "cs-1", name: "huge.png", src: "A".repeat(DEVICE_STAMP_BUDGET) }]));
    await openAs("u1");
    await tryUpload("more.png", "m".repeat(30_000));
    expect(alertText()).toBeNull();
    expect(offered()).toEqual(["more.png", "huge.png"]);
    expect(stored(keyOf("u1"))).toEqual(["more.png", "huge.png"]);
  });

  it("a write that does not grow the person's list is never refused: a removal lands over the budget, and so does the 13th upload that drops a larger oldest stamp", async () => {
    // u1's list built while u1 was alone here, then u2 kept a small list: together past the budget
    const twelve = Array.from({ length: 12 }, (_, i) => ({ id: `cs-${i + 1}`, name: `mine-${i + 1}.png`, src: "A".repeat(i === 11 ? 400_000 : 100_000) }));
    window.localStorage.setItem(keyOf("u1"), JSON.stringify(twelve));
    seedOther("u2", 50_000);
    expect(stampUploadOverDeviceBudget("u1", [{ id: "x", name: "x", src: "x" }, ...twelve])).toBe(true);
    await openAs("u1");
    await tryUpload("grow.png", "g".repeat(30_000)); // the cap drops mine-12 (400,000) for ~40,000: the list shrinks
    expect(alertText()).toBeNull();
    expect(offered()[0]).toBe("grow.png");
    expect(offered()).not.toContain("mine-12.png");
    await click(Array.from(host.querySelectorAll("button[title='Remove']"))[1]);
    expect(stored(keyOf("u1"))).not.toContain("mine-1.png");
    expect(stored(keyOf("u1"))).toHaveLength(11);
  });

  it("the budget counts only the uid-keyed lists of OTHER accounts, by the units a browser counts (key + value)", () => {
    expect(stampUploadOverDeviceBudget("u1", [stamp(1)])).toBe(false); // nobody else
    window.localStorage.setItem(LEGACY, "x".repeat(2_000_000));          // the legacy list is not counted
    window.localStorage.setItem("orgGraph:pos:o1", "x".repeat(2_000_000)); // nor any other key
    expect(stampUploadOverDeviceBudget("u1", [stamp(1)])).toBe(false);
    window.localStorage.clear();
    seedOther("u2", DEVICE_STAMP_BUDGET - 100);
    const fits = [{ id: "a", name: "a", src: "" }];
    const room = DEVICE_STAMP_BUDGET - (DEVICE_STAMP_BUDGET - 100) - keyOf("u1").length - JSON.stringify(fits).length;
    expect(stampUploadOverDeviceBudget("u1", [{ id: "a", name: "a", src: "x".repeat(room) }])).toBe(false);
    expect(stampUploadOverDeviceBudget("u1", [{ id: "a", name: "a", src: "x".repeat(room + 1) }])).toBe(true);
  });
});
