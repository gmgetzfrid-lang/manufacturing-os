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
//           CLIENT_STORAGE_INVENTORY class "uid-scoped", as the finding's
//           done-whens say — taken by no purge, so kept across the person's
//           own sign-out, an expiry AND another identity's run of the app
//           here, as before OFF-15, and never offered to anyone else); with
//           no uid no stamps are offered or written; the legacy device-wide
//           list (class "device") is MOVED, once, to the first identity that
//           signs in here after the change (claimLegacyStampsAtSignIn, which
//           RoleContext's noteIdentity runs AFTER its purge), the device is
//           marked so no later identity is offered it, and the moved list is
//           that identity's from then on (OFF-8's one-time transition); the
//           viewer's first read applies the same rule when that move was
//           refused.
//   Review fix 4: the per-device stamp budget of review fix 3 is gone. It
//           refused uploads that land at c537602 (another account's list on
//           the device was enough). Upload, use, removal and the 12-stamp cap
//           are the code of before.
//   Review fix 5: kind "identity" (review fix 4, the brief's class) ended a
//           person's stamps whenever a colleague ran the app on the device —
//           a loss against c537602, where they outlived the colleague's
//           shift. The list is uid-scoped again; what ends the lists of the
//           people who no longer sign in here is the device's ring of the
//           last STAMP_LISTS_KEPT_PER_DEVICE (8) identities
//           (manufacturingos.customStamps.recentUids, keepRecentStampLists,
//           run by noteIdentity at every sign-in through noteStampsAtSignIn),
//           which refuses nothing.
//
// Driven AS RENDERED: the real FullScreenViewer (jsdom; react-pdf and fabric
// stubbed — the harness of dcRoundFP15MarkupExportRendered.test.ts), its
// stamp menu opened, a file chosen through the real hidden input, a stamp
// placed and removed through the real buttons. The sign-out / different
// identity ends are RoleContext's own purge (purgeAccountStorage, the scope
// noteIdentity and SIGNED_OUT use), driven by the real inventory rows, then
// the sign-in's stamp step (noteStampsAtSignIn: the ring, then the legacy
// claim); the provider's own order is pinned rendered in sessSixRoleNull.test.ts.

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
import { claimLegacyStampsAtSignIn, noteStampsAtSignIn, readRecentStampUids, writeStampList, STAMP_LISTS_KEPT_PER_DEVICE } from "@/lib/customStamps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Every case mounts the real viewer (react-pdf and fabric stubbed); under a loaded full run a mount alone can pass the 5 s default,
// and a case that times out leaves its act() open for the next one.
vi.setConfig({ testTimeout: 30_000 });

const LEGACY = "manufacturingos.customStamps";
const MOVED = "manufacturingos.customStamps.moved";
const RECENT = "manufacturingos.customStamps.recentUids";
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
  for (let i = 0; i < 200 && !offered().includes(name); i++) await settle(); // a file read can take a few turns
}
const stored = (key: string) => {
  const raw = window.localStorage.getItem(key);
  return raw === null ? null : (JSON.parse(raw) as Array<{ id: string; name: string; src: string }>).map((x) => x.name);
};
const stamp = (n: number) => ({ id: `cs-${n}`, name: `legacy-${n}.png`, src: `data:image/png;base64,${btoa(`legacy-${n}`)}` });
/** RoleContext's noteIdentity for `uid` signing in on a browser that last ran as `last`: the "all" purge when the identity differs,
 *  THEN the stamp step — the device's ring, then the legacy claim (the order the provider runs them in — pinned rendered in sessSixRoleNull). */
function signIn(uid: string, last: string | null) {
  if (last && last !== uid) {
    purgeAccountStorage(window.localStorage, "local", "all");
    purgeAccountStorage(window.sessionStorage, "session", "all");
  }
  noteStampsAtSignIn(uid);
}
/** SIGNED_OUT: RoleContext's "signout" purge (the person's own work, kind "identity", stays). */
function signOut() {
  purgeAccountStorage(window.localStorage, "local", "signout");
  purgeAccountStorage(window.sessionStorage, "session", "signout");
}
const localKeys = () => Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!);

describe("OFF-15 — a stamp uploaded by one person is never offered to another", () => {
  it("u1 uploads; u2 opening the viewer on the same device is offered nothing, and u2's upload lands on u2's key, not u1's (was: one device-wide list u2 was offered) — the viewer alone; the end of u1's list at u2's sign-in is driven below", async () => {
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
    expect(localKeys().sort()).toEqual([LEGACY, keyOf("u1")].sort());
  });
});

describe("OFF-15 — the same person's stamps survive their sign-out, an expiry and a DIFFERENT identity's run of the app (uid-scoped: taken by no purge, as the finding's done-whens 1 and 3 say)", () => {
  it("the inventory classes the uid key uid-scoped (no kind), the legacy key, the moved marker and the ring device; no purge takes a person's list — SIGNED_OUT, an evaporated session or a different identity", async () => {
    const row = (key: string) => CLIENT_STORAGE_INVENTORY.find((r) => r.store === "local" && r.key === key);
    expect(row("manufacturingos.customStamps:")).toMatchObject({ match: "prefix", class: "uid-scoped", owners: ["lib/customStamps.ts", "components/viewers/FullScreenViewer.tsx"] });
    expect(row("manufacturingos.customStamps:")?.kind).toBeUndefined();
    expect(row(LEGACY)).toMatchObject({ match: "exact", class: "device", owners: ["lib/customStamps.ts"] });
    expect(row(LEGACY)?.kind).toBeUndefined();
    expect(row(MOVED)).toMatchObject({ match: "exact", class: "device", owners: ["lib/customStamps.ts"] });
    expect(row(RECENT)).toMatchObject({ match: "exact", class: "device", owners: ["lib/customStamps.ts"] });
    expect([purgeTakes("signout", "identity"), purgeTakes("cache", "identity"), purgeTakes("all", "identity")]).toEqual([false, false, true]); // what an account row would lose — the list is not one
    // review fix 5: no "account" stamp row is left (review fix 4's kind "identity" ended a person's list at a colleague's sign-in)
    expect(CLIENT_STORAGE_INVENTORY.filter((r) => r.key.startsWith(LEGACY)).map((r) => r.class).sort()).toEqual(["device", "device", "device", "uid-scoped"]);

    await openAs("u1");
    await upload("initials-u1.png");
    signOut(); // a sign-out button or an expired token
    expect(stored(keyOf("u1"))).toEqual(["initials-u1.png"]);
    // the same person signs back in and opens a drawing: their stamp is there
    signIn("u1", "u1");
    await reopenAs("u1");
    expect(offered()).toEqual(["initials-u1.png"]);
    // a session that merely evaporated keeps it too
    purgeAccountStorage(window.localStorage, "local", "cache");
    await reopenAs("u1");
    expect(offered()).toEqual(["initials-u1.png"]);
    // and so does a different identity's run of the app (review fix 5)
    purgeAccountStorage(window.localStorage, "local", "all");
    await reopenAs("u1");
    expect(offered()).toEqual(["initials-u1.png"]);
  });

  it("a DIFFERENT identity running the app here (noteIdentity's \"all\" purge) leaves every uid's stamp list, the legacy list (class \"device\", for the next sign-in's claim), the marker and the ring (was, review fix 4: every uid's list ended)", async () => {
    await openAs("u1");
    await upload("initials-u1.png");
    window.localStorage.setItem(keyOf("u9"), JSON.stringify([stamp(9)])); // say, another tab's identity
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1)]));
    window.localStorage.setItem(MOVED, "1");
    window.localStorage.setItem(RECENT, JSON.stringify(["u1", "u9"]));
    signOut();
    purgeAccountStorage(window.localStorage, "local", "cache");
    expect(stored(keyOf("u1"))).toEqual(["initials-u1.png"]); // kept across a sign-out and an evaporation
    expect(stored(LEGACY)).toEqual(["legacy-1.png"]);
    purgeAccountStorage(window.localStorage, "local", "all");
    expect(stored(keyOf("u1"))).toEqual(["initials-u1.png"]); // and across a different identity's run
    expect(stored(keyOf("u9"))).toEqual(["legacy-9.png"]);
    expect(stored(LEGACY)).toEqual(["legacy-1.png"]);
    expect(window.localStorage.getItem(MOVED)).toBe("1");
    expect(readRecentStampUids()).toEqual(["u1", "u9"]);
  });

  it("review fix 5 (the fifth reviewer's major — done-when 1 on a shared device): u1's stamps survive u2's shift — u2 is offered none of them, and u1 signing in the next morning has them; u2's survive u1's in turn (was, review fix 4: ended by u2's sign-in, so u1 uploaded them again after every shift change; at c537602 they outlived u2's shift, but in the one list u2 was offered)", async () => {
    signIn("u1", null);
    await openAs("u1");
    await upload("A-initials.png");
    await upload("VERIFIED-IN-FIELD.png");
    signOut();
    signIn("u2", "u1");                                            // u2 boots on the same tablet for the night shift
    expect(stored(keyOf("u1"))).toEqual(["VERIFIED-IN-FIELD.png", "A-initials.png"]); // kept
    await reopenAs("u2");
    expect(offered()).toEqual([]);                                 // never offered to u2
    await upload("initials-u2.png");
    signOut();
    signIn("u1", "u2");                                            // u1 signs in the next morning
    await reopenAs("u1");
    expect(offered()).toEqual(["VERIFIED-IN-FIELD.png", "A-initials.png"]);
    expect(stored(keyOf("u2"))).toEqual(["initials-u2.png"]);      // u2's kept too, offered to u1 no more than u1's to u2
    expect(readRecentStampUids()).toEqual(["u1", "u2"]);
  });
});

describe("OFF-15 — the end for the lists of the people who no longer sign in here: the device's ring of the last eight identities (review fix 5)", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const listsHeld = () => localKeys().filter((k) => k.startsWith("manufacturingos.customStamps:")).map((k) => k.slice("manufacturingos.customStamps:".length)).sort();

  it("nine people sign in one after another, each keeping a list: the eighth sign-in keeps all eight; the ninth removes the first person's list and no other; a returning person goes to the front of the ring, and the person who signed in longest ago is the next to go — nothing is refused, and the ninth, driven through the viewer, uploads and is offered only their own", async () => {
    expect(STAMP_LISTS_KEPT_PER_DEVICE).toBe(8);
    let last: string | null = null;
    for (const uid of ids(8)) {
      if (last) signOut();
      signIn(uid, last);
      expect(writeStampList(uid, [stamp(Number(uid.slice(1)))])).toBe(true);
      last = uid;
    }
    expect(listsHeld()).toEqual(ids(8).sort());
    expect(readRecentStampUids()).toEqual([...ids(8)].reverse());
    signOut();
    signIn("p9", "p8");
    expect(window.localStorage.getItem(keyOf("p1"))).toBeNull();   // the person who signed in longest ago
    expect(listsHeld()).toEqual([...ids(8).slice(1)].sort());       // p9 has no list yet
    expect(readRecentStampUids()).toEqual([...ids(9).slice(1)].reverse());
    await reopenAs("p9");
    expect(offered()).toEqual([]);
    await upload("p9-own.png");
    expect(offered()).toEqual(["p9-own.png"]);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(listsHeld()).toEqual([...ids(9).slice(1)].sort());
    // p2 comes back: to the front, their list kept
    signOut();
    signIn("p2", "p9");
    expect(stored(keyOf("p2"))).toEqual(["legacy-2.png"]);
    expect(readRecentStampUids()).toEqual(["p2", "p9", "p8", "p7", "p6", "p5", "p4", "p3"]);
    expect(listsHeld()).toEqual([...ids(9).slice(1)].sort());
    // a tenth person: p3 (now the oldest) goes, p2 stays
    signOut();
    signIn("p10", "p2");
    expect(window.localStorage.getItem(keyOf("p3"))).toBeNull();
    expect(stored(keyOf("p2"))).toEqual(["legacy-2.png"]);
    expect(listsHeld()).toEqual(["p2", "p4", "p5", "p6", "p7", "p8", "p9"]);       // p10 has no list yet
    // the same person again: no change, nothing written
    const set = vi.spyOn(Storage.prototype, "setItem");
    signIn("p10", "p10");
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
  });

  it("a ring write the store refuses ends nothing a person still uses and never throws: the lists past the ring's end are removed first (their room is what the write needed), the sign-in and the person's upload go on, and the ring is recomputed at the next sign-in; a person the refused write left out of the ring is never dropped by it (kept, not lost) until they sign in again; an unreadable ring is an empty one", async () => {
    let last: string | null = null;
    for (const uid of ids(8)) { if (last) signOut(); signIn(uid, last); writeStampList(uid, [stamp(Number(uid.slice(1)))]); last = uid; }
    const realSet = Storage.prototype.setItem;
    const refuseRing = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === RECENT) throw new DOMException("QuotaExceededError", "QuotaExceededError");
      return realSet.call(this, k, v);
    });
    signOut();
    expect(() => signIn("p9", "p8")).not.toThrow();
    expect(window.localStorage.getItem(keyOf("p1"))).toBeNull();   // past the ring's end: removed before the refused write
    expect(readRecentStampUids()).toEqual([...ids(8)].reverse());  // the ring is as it was
    await reopenAs("p9");
    await upload("p9-own.png");                                    // the person's upload lands all the same
    expect(stored(keyOf("p9"))).toEqual(["p9-own.png"]);
    refuseRing.mockRestore();
    signOut();
    signIn("p10", "p9");                                           // the next sign-in recomputes the ring from the store
    expect(readRecentStampUids()).toEqual(["p10", "p8", "p7", "p6", "p5", "p4", "p3", "p2"]);
    expect(window.localStorage.getItem(keyOf("p1"))).toBeNull();
    expect(stored(keyOf("p9"))).toEqual(["p9-own.png"]);           // not in the ring, so never dropped by it: kept
    signOut();
    signIn("p9", "p10");                                           // p9 signs in again: remembered now
    expect(readRecentStampUids()).toEqual(["p9", "p10", "p8", "p7", "p6", "p5", "p4", "p3"]);
    expect(window.localStorage.getItem(keyOf("p2"))).toBeNull();
    window.localStorage.setItem(RECENT, "not a list");
    signOut();
    signIn("p11", "p9");
    expect(readRecentStampUids()).toEqual(["p11"]);                // an unreadable ring: nothing dropped, started over
    expect(stored(keyOf("p9"))).toEqual(["p9-own.png"]);
  });
});

describe("OFF-15 — the legacy device-wide list moves once, to the first identity, is that identity's from then on, and is never read again after the move", () => {
  it("u1's first open takes the legacy list (the viewer's fallback: moved to u1's key, the legacy key removed, the device marked); u2's viewer never reads it; u2's sign-in leaves it with the rest of u1's list (uid-scoped)", async () => {
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1), stamp(2)]));
    await openAs("u1");
    expect(offered()).toEqual(["legacy-1.png", "legacy-2.png"]);
    expect(stored(keyOf("u1"))).toEqual(["legacy-1.png", "legacy-2.png"]);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
    expect(window.localStorage.getItem(MOVED)).toBe("1");

    await reopenAs("u2");
    expect(offered()).toEqual([]);
    expect(window.localStorage.getItem(keyOf("u2"))).toBeNull();

    signIn("u2", "u1");
    expect(stored(keyOf("u1"))).toEqual(["legacy-1.png", "legacy-2.png"]); // review fix 5: u1's, kept
    await reopenAs("u2");
    expect(offered()).toEqual([]);
  });

  it("review fix 5: the list the first identity takes at its sign-in is that identity's own from then on — kept across their sign-out AND across B's run of the app, offered to B no more than A's own uploads are, until A falls off the device's ring or removes them (what the brief's MOVE means on a shared tablet, stated in OFF-15's Scope: the first identity after the deploy is offered what every shift left in the old shared list; review fix 4 ended it at B's sign-in, with A's own uploads)", async () => {
    window.localStorage.setItem(LEGACY, JSON.stringify([{ id: "cs-b", name: "BJ-verified-in-field.png", src: "data:image/png;base64,Qko=" }])); // B's, uploaded under the old code
    signIn("uA", null);                                            // A is the first to sign in after the deploy
    expect(stored(keyOf("uA"))).toEqual(["BJ-verified-in-field.png"]);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
    expect(window.localStorage.getItem(MOVED)).toBe("1");
    await openAs("uA");
    await upload("AA-own.png");
    expect(offered()).toEqual(["AA-own.png", "BJ-verified-in-field.png"]);
    signOut();
    signIn("uA", "uA");                                            // A's own next sign-in: kept (the one-time transition, as OFF-8's)
    await reopenAs("uA");
    expect(offered()).toEqual(["AA-own.png", "BJ-verified-in-field.png"]);
    signOut();
    signIn("uB", "uA");                                            // B runs the app: A's list is kept, the inherited stamps with it
    expect(stored(keyOf("uA"))).toEqual(["AA-own.png", "BJ-verified-in-field.png"]);
    await reopenAs("uB");
    expect(offered()).toEqual([]);                                 // B is offered nothing of it — not even B's own old initials
    signOut();
    signIn("uA", "uB");                                            // A signs back in: both still there
    await reopenAs("uA");
    expect(offered()).toEqual(["AA-own.png", "BJ-verified-in-field.png"]);
    await click(Array.from(host.querySelectorAll("button[title='Remove']"))[1]); // A removes B's initials: gone from the device
    expect(offered()).toEqual(["AA-own.png"]);
    expect(JSON.stringify(Object.fromEntries(localKeys().map((k) => [k, window.localStorage.getItem(k)])))).not.toContain("BJ-verified-in-field.png");
    // and had A not removed them, eight later identities would end A's list, the inherited stamps with it (the ring, above)
  });

  it("the second reviewer's path: the device remembers B; A, who uploaded the list under the old code, signs in first — the purge for B leaves the legacy list (class \"device\") and A's claim, after it, takes it, so A has their stamps (was: the purge ended it before A opened a drawing, without a word)", async () => {
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1), stamp(2)]));
    window.localStorage.setItem(keyOf("uB"), JSON.stringify([stamp(7)]));
    signIn("uA", "uB");
    expect(stored(keyOf("uB"))).toEqual(["legacy-7.png"]);          // review fix 5: B's own list is kept (was: ended by the purge for B)
    await openAs("uA");
    expect(offered()).toEqual(["legacy-1.png", "legacy-2.png"]);
    signOut();
    signIn("uB", "uA");
    await reopenAs("uB");
    expect(offered()).toEqual(["legacy-7.png"]);                   // B's own, and nothing of A's
  });

  it("the sign-in move runs once per device — marked at the first sign-in even with nothing to move, so a value a tab still running the old code writes later is read by no sign-in and no viewer, and the next sign-in removes it; a uid that has a list of its own marks the device and leaves the legacy value unread", async () => {
    claimLegacyStampsAtSignIn("u1");
    expect(window.localStorage.getItem(MOVED)).toBe("1");
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1)])); // an old-code tab
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    claimLegacyStampsAtSignIn("u2");
    expect(localKeys()).not.toContain(LEGACY);                       // removed, unread (read here by key, not getItem)
    await openAs("u2");
    expect(offered()).toEqual([]);
    expect(getItem.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([MOVED, keyOf("u2")])); // not vacuous
    expect(getItem.mock.calls.map((c) => c[0])).not.toContain(LEGACY);
    getItem.mockRestore();
    // a fresh device where the arriving uid somehow already keeps a list: marked, the legacy value left unread, then removed at the next sign-in
    window.localStorage.clear();
    window.localStorage.setItem(keyOf("u3"), JSON.stringify([stamp(3)]));
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1)]));
    claimLegacyStampsAtSignIn("u3");
    expect(stored(keyOf("u3"))).toEqual(["legacy-3.png"]);
    expect(window.localStorage.getItem(MOVED)).toBe("1");
    expect(stored(LEGACY)).toEqual(["legacy-1.png"]);
    claimLegacyStampsAtSignIn("u3");
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
    expect(stored(keyOf("u3"))).toEqual(["legacy-3.png"]);
  });

  it("a sign-in move the store refuses leaves the list where it was and the device unmarked — the person's first viewer open offers it to them, pending, and their next write lands it", async () => {
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1), stamp(2)]));
    const real = Storage.prototype.setItem;
    let refuse = true;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (refuse && k.startsWith("manufacturingos.customStamps:")) throw new DOMException("quota", "QuotaExceededError");
      return real.call(this, k, v);
    });
    claimLegacyStampsAtSignIn("u1");
    expect(stored(LEGACY)).toEqual(["legacy-1.png", "legacy-2.png"]); // put back
    expect(window.localStorage.getItem(MOVED)).toBeNull();            // the marker the move wrote is removed again
    await openAs("u1");
    expect(offered()).toEqual(["legacy-1.png", "legacy-2.png"]);
    refuse = false;
    await click(Array.from(host.querySelectorAll("button[title='Remove']"))[0]);
    expect(stored(keyOf("u1"))).toEqual(["legacy-2.png"]);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
    expect(window.localStorage.getItem(MOVED)).toBe("1");
  });

  it("review fix 4 (minor): a move never lands with the device unmarked — a store that refuses ONLY the marker write refuses the move: the legacy list is put back as it was, nothing is written under the uid, the device stays unmarked; the person's open offers it pending, and the first write that lands with its marker finishes it (was: the move landed, the marker failure was swallowed, and an old-code tab's later write went to the NEXT identity)", async () => {
    const legacyValue = JSON.stringify([stamp(1), stamp(2)]);
    window.localStorage.setItem(LEGACY, legacyValue);
    const real = Storage.prototype.setItem;
    let refuseMarker = true;
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (refuseMarker && k === MOVED) throw new DOMException("quota", "QuotaExceededError");
      return real.call(this, k, v);
    });
    signIn("u1", null);
    expect(setItem.mock.calls.map((c) => c[0])).toContain(MOVED);       // the marker write was tried (and refused)
    expect(window.localStorage.getItem(LEGACY)).toBe(legacyValue);      // put back, byte for byte
    expect(window.localStorage.getItem(keyOf("u1"))).toBeNull();        // the move did not land
    expect(window.localStorage.getItem(MOVED)).toBeNull();
    await openAs("u1");
    expect(offered()).toEqual(["legacy-1.png", "legacy-2.png"]);        // offered to u1, pending
    expect(window.localStorage.getItem(keyOf("u1"))).toBeNull();
    refuseMarker = false;
    await click(Array.from(host.querySelectorAll("button[title='Remove']"))[0]);
    expect(stored(keyOf("u1"))).toEqual(["legacy-2.png"]);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
    expect(window.localStorage.getItem(MOVED)).toBe("1");
    // the reviewer's sequence after it: an old-code tab writes the legacy key, B signs in — B takes nothing
    window.localStorage.setItem(LEGACY, JSON.stringify([stamp(1), stamp(2), stamp(3)]));
    signOut();
    signIn("u2", "u1");
    expect(window.localStorage.getItem(keyOf("u2"))).toBeNull();
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
    await reopenAs("u2");
    expect(offered()).toEqual([]);
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

  it("after the move the legacy key is never read again — a value a tab still running the old code writes there later is offered to no one, and the next sign-in removes it unread", async () => {
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
    signIn("u2", "u1");
    expect(getItem.mock.calls.map((c) => c[0])).not.toContain(LEGACY);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();
  });

  it("the move removes the legacy list FIRST, so a list that fills most of the quota still moves (copying it beside the original would not fit)", async () => {
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

  it("a store that refuses the move puts the legacy list back and offers it to this person; their first write that lands finishes the move, so the next person is offered nothing (was: the legacy key stayed and went to the next person, a removed stamp included)", async () => {
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

  it("in a near-full store, a removal while the move is pending lands and stays removed — the pending write removes the legacy copy first, as the move does (was: written beside the legacy copy, refused, and the removed stamp offered again on the next open)", async () => {
    // jsdom's quota is 5,000,000 code units (keys and values). A real uid makes the uid key 37 units longer than the legacy key, the
    // marker takes 35, and the store leaves 10 free: the list cannot be written under the uid in the room the legacy list frees, so the
    // move at the first open is refused; one stamp removed fits in it.
    const U = "11111111-2222-3333-4444-555555555555";
    const big = (n: number) => ({ id: `cs-${n}`, name: `big-${n}.png`, src: `data:image/png;base64,${"A".repeat(1_000_000)}` });
    window.localStorage.setItem(LEGACY, JSON.stringify([big(1), big(2)]));
    const used = () => localKeys().reduce((t, k) => t + k.length + window.localStorage.getItem(k)!.length, 0);
    window.localStorage.setItem("filler", "x".repeat(5_000_000 - used() - 10 - "filler".length));
    expect(5_000_000 - used()).toBe(10);
    expect(keyOf(U).length - LEGACY.length).toBe(37);
    expect(MOVED.length + 1).toBe(35);

    await openAs(U);
    expect(offered()).toEqual(["big-1.png", "big-2.png"]);
    expect(window.localStorage.getItem(keyOf(U))).toBeNull(); // refused: pending
    expect(stored(LEGACY)).toEqual(["big-1.png", "big-2.png"]);
    expect(window.localStorage.getItem(MOVED)).toBeNull();
    expect(5_000_000 - used()).toBe(10);                      // put back exactly: nothing lost, nothing left over

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

  it("removal: × takes the stamp out of the menu and out of the person's stored list; the last one removed leaves an empty list, as before", async () => {
    await openAs("u1");
    await upload("a.png");
    await upload("b.png");
    const removeA = Array.from(host.querySelectorAll("button[title='Remove']"))[1] as HTMLButtonElement;
    await click(removeA);
    expect(offered()).toEqual(["b.png"]);
    expect(stored(keyOf("u1"))).toEqual(["b.png"]);
    await click(Array.from(host.querySelectorAll("button[title='Remove']"))[0]);
    expect(offered()).toEqual([]);
    expect(window.localStorage.getItem(keyOf("u1"))).toBe("[]");
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

  it("review fix 4 (the blocker): an upload is never refused for room another account's list holds — the reviewer's reproduction, A's 1.6M-unit list on the device and B's 4.5 KB upload, lands with no message (was: refused by a per-device stamp budget, with advice B could not follow)", async () => {
    window.localStorage.setItem(keyOf("uA"), JSON.stringify([{ id: "cs-1", name: "phone-photo.jpg", src: `data:image/jpeg;base64,${"A".repeat(1_600_000)}` }]));
    await openAs("uB");
    await upload("initials-B.png", "b".repeat(4_500));
    expect(offered()).toEqual(["initials-B.png"]);
    expect(stored(keyOf("uB"))).toEqual(["initials-B.png"]);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    // and a person whose own list is larger than any bound uploads more, as before
    await upload("more.png", "m".repeat(30_000));
    expect(offered()).toEqual(["more.png", "initials-B.png"]);
  });

  it("review fix 5: the many-people reproduction under the ring — 40 people sign in one after another on one tablet and each keeps 3 stamps of 10–80 KB: every list is written, the device holds the last eight people's lists and no more (about 1,440,000 units of the 5,000,000), the last two people, driven through the viewer, upload and are offered only their own, and a 20,000-unit graph-layout write and a session write still land (was: 34 people's kept lists filled the store; then a budget refused more than 60 of these uploads; then kind \"identity\" kept one list by ending a person's at every shift change)", async () => {
    const sizes = [10_000, 45_000, 80_000];
    // the list the viewer would build from three uploads (newest first), as data URLs
    const listOf = (p: number) => sizes.map((n, j) => ({ id: `cs-${p}-${j}`, name: `p${p}-s${j}.png`, src: `data:image/png;base64,${String.fromCharCode(65 + j).repeat(Math.ceil((n * 4) / 3))}` })).reverse();
    let last: string | null = null;
    for (let p = 1; p <= 40; p++) {
      const uid = `person-${p}`;
      if (last) signOut();
      signIn(uid, last);
      if (p <= 38) {
        expect(writeStampList(uid, listOf(p))).toBe(true); // the viewer's own write (persistCustomStamps → writeStampList)
      } else {
        await reopenAs(uid);
        expect(offered()).toEqual([]);                     // nothing of the 38 people before
        for (let j = 0; j < 3; j++) await upload(`p${p}-s${j}.png`, String.fromCharCode(65 + j).repeat(sizes[j]));
        expect(offered()).toEqual([`p${p}-s2.png`, `p${p}-s1.png`, `p${p}-s0.png`]);
      }
      const kept = Array.from({ length: Math.min(p, STAMP_LISTS_KEPT_PER_DEVICE) }, (_, i) => keyOf(`person-${p - i}`)).sort();
      expect(localKeys().filter((k) => k.startsWith("manufacturingos.customStamps:")).sort()).toEqual(kept);
      last = uid;
    }
    expect(stored(keyOf("person-33"))).toEqual(["p33-s2.png", "p33-s1.png", "p33-s0.png"]); // the eighth most recent, kept
    expect(window.localStorage.getItem(keyOf("person-32"))).toBeNull();
    expect(() => window.localStorage.setItem("orgGraph:pos:o1", "x".repeat(20_000))).not.toThrow();
    expect(() => window.localStorage.setItem("sb-ref-auth-token", "t".repeat(4_000))).not.toThrow();
  }, 60_000);

  it("source: every stamp read and write is keyed by the uid (lib/customStamps.ts — the viewer touches storage only through it, and refuses nothing an upload of before would land); the device-wide key is read only before the device is marked (after the marker check, at a sign-in or a first read, or while the move is pending), removed before the marker and the uid list are written, and written only to put back the value it held", () => {
    const v = src("components/viewers/FullScreenViewer.tsx");
    const lib = src("lib/customStamps.ts");
    expect(v).not.toMatch(/localStorage\.(get|set|remove)Item/);
    expect(v).toMatch(/import \{ loadStampShelf, moveLegacyStamps, writeStampList, type CustomStamp, type StampShelf \} from "@\/lib\/customStamps";/);
    // review fix 4: no per-device budget, no refusal
    expect(lib).not.toMatch(/BUDGET|OverDeviceBudget/);
    expect(v).not.toMatch(/stampRefusedFor|OverDeviceBudget|Stamp storage on this device is full/);
    // upload and removal are the code of before (only the uid guard is new)
    expect(v).toMatch(/const next = \[\{ id: `cs-\$\{Date\.now\(\)\}`, name: file\.name, src \}, \.\.\.customStamps\]\.slice\(0, 12\);\n\s*persistCustomStamps\(next\);/);
    expect(v).toMatch(/const removeCustomStamp = \(id: string\) => \{\n\s*persistCustomStamps\(customStamps\.filter\(\(s\) => s\.id !== id\)\);\n\s*\};/);
    expect(lib).toMatch(/export const customStampsKey = \(uid: string\) => `manufacturingos\.customStamps:\$\{uid\}`;/);
    // review fix 5: the sign-in's stamp step is the ring, then the legacy claim; RoleContext calls that and nothing else here
    expect(lib).toMatch(/export const STAMP_LISTS_KEPT_PER_DEVICE = 8;/);
    expect(lib).toMatch(/export function noteStampsAtSignIn\(uid: string\): void \{\n\s*keepRecentStampLists\(uid\);\n\s*claimLegacyStampsAtSignIn\(uid\);\n\}/);
    const rc = src("components/providers/RoleContext.tsx");
    expect(rc.match(/noteStampsAtSignIn\(/g)).toHaveLength(1);
    expect(rc).not.toMatch(/claimLegacyStampsAtSignIn\(|keepRecentStampLists\(/); // named in a row's why, called from neither
    const keep = lib.slice(lib.indexOf("export function keepRecentStampLists("), lib.indexOf("export function noteStampsAtSignIn("));
    expect(keep.indexOf("removeItem(customStampsKey(u))")).toBeGreaterThan(0);
    expect(keep.indexOf("removeItem(customStampsKey(u))")).toBeLessThan(keep.indexOf("setItem(RECENT_STAMP_UIDS_KEY")); // the dropped lists go first
    expect(keep).toMatch(/\} catch \{/);                                                                          // and it never throws
    expect(lib.match(/\.removeItem\(customStampsKey\(/g)).toHaveLength(1);                                           // the ring is the only end for a uid's list
    expect(lib.match(/\.setItem\(LEGACY_CUSTOM_STAMPS_KEY/g)).toEqual([".setItem(LEGACY_CUSTOM_STAMPS_KEY"]);
    expect(lib).toMatch(/if \(legacy !== null\) \{ try \{ window\.localStorage\.setItem\(LEGACY_CUSTOM_STAMPS_KEY, legacy\); \}/);
    expect(lib.match(/\.getItem\(LEGACY_CUSTOM_STAMPS_KEY\)/g)).toHaveLength(3); // the sign-in's read; loadStampShelf's; moveLegacyStamps' (the value it puts back)
    expect(lib.match(/\.removeItem\(LEGACY_CUSTOM_STAMPS_KEY\)/g)).toHaveLength(2); // the move; a marked device's sign-in (unread)
    const move = lib.slice(lib.indexOf("export function moveLegacyStamps("), lib.indexOf("export function claimLegacyStampsAtSignIn("));
    const at = (needle: string) => move.indexOf(needle);
    expect(at("removeItem(LEGACY_CUSTOM_STAMPS_KEY)")).toBeGreaterThan(0);
    // review fix 4: legacy removed (room) → marker → uid list, so a move that lands has always marked the device
    expect(at("removeItem(LEGACY_CUSTOM_STAMPS_KEY)")).toBeLessThan(at("setItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY"));
    expect(at("setItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY")).toBeLessThan(at("setItem(customStampsKey(uid)"));
    expect(at("removeItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY)")).toBeGreaterThan(at("catch {"));
    const claim = lib.slice(lib.indexOf("export function claimLegacyStampsAtSignIn("), lib.indexOf("export function loadStampShelf("));
    expect(claim.indexOf("removeItem(LEGACY_CUSTOM_STAMPS_KEY)")).toBeGreaterThan(claim.indexOf("getItem(LEGACY_CUSTOM_STAMPS_MOVED_KEY)"));
    expect(claim.indexOf("removeItem(LEGACY_CUSTOM_STAMPS_KEY)")).toBeLessThan(claim.indexOf("getItem(LEGACY_CUSTOM_STAMPS_KEY)"));
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
