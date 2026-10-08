// @vitest-environment jsdom
//
// admin-and-org Round G, package P6 — ORG-5 fix pass 2, rendered: the
// sidebar's logo modal (components/branding/LogoUploadModal.tsx) mints the
// logo's key with the extension of the type the server signs
// (lib/storageKey.ts logoExtensionForType), never the extension of the file's
// NAME. Windows saves a JPEG as "….jfif", and a name may have none; a key
// named after its type is one a backup restore reads the right type back from.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ORG = "12345678-1234-1234-1234-123456789abc";
const calls = vi.hoisted(() => ({
  uploads: [] as Array<{ path: string; contentType?: string; name: string }>,
  saves: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ activeOrgId: ORG }) }));
vi.mock("@/components/providers/OrgBrandingProvider", () => ({
  useOrgBranding: () => ({
    branding: { logoShape: "full" }, logoUrl: null,
    save: async (b: Record<string, unknown>) => { calls.saves.push(b); },
  }),
}));
vi.mock("@/lib/storage", () => ({
  uploadToPath: async (file: File, path: string, opts?: { contentType?: string }) => {
    calls.uploads.push({ path, contentType: opts?.contentType, name: file.name });
    return path;
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));

import LogoUploadModal from "@/components/branding/LogoUploadModal";
import { contentTypeForKey, restoreUploadRequest } from "@/lib/storageKey";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  calls.uploads = [];
  calls.saves = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function pick(file: File) {
  await act(async () => { root.render(React.createElement(LogoUploadModal, { onClose: () => {} })); });
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const KEY = new RegExp(`^orgs/${ORG}/branding/logo-[^/]+\\.(png|jpg|webp)$`);

describe("ORG-5 fix pass 2 — the logo modal names the key by the signed type", () => {
  it("REPRODUCED: 'Company Logo.jfif' (image/jpeg) is stored at '….jpg' — it was '….jfif', which a restore read as octet-stream and refused", async () => {
    await pick(new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "Company Logo.jfif", { type: "image/jpeg" }));
    expect(calls.uploads).toHaveLength(1);
    const { path, contentType } = calls.uploads[0];
    expect(path).toMatch(KEY);
    expect(path.endsWith(".jpg")).toBe(true);
    expect(contentType).toBe("image/jpeg");
    // the key is the one the pointer saves, and a restore of it is signed as the same type
    expect(calls.saves[0]).toMatchObject({ logoPath: path });
    expect(contentTypeForKey(path)).toBe("image/jpeg");
    expect(restoreUploadRequest(path, 4).logoProblem).toBeNull();
  });

  it("a file with no extension ('CompanyLogo', image/png) and a WebP get '.png' and '.webp'", async () => {
    await pick(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "CompanyLogo", { type: "image/png" }));
    act(() => root.unmount());
    root = createRoot(container);
    await pick(new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], "mark.final.WEBP", { type: "image/webp" }));
    expect(calls.uploads.map((u) => u.path.split(".").pop())).toEqual(["png", "webp"]);
    for (const u of calls.uploads) expect(contentTypeForKey(u.path)).toBe(u.contentType);
  });

  it("a type the server refuses is still stopped before any upload (the pre-check is unchanged)", async () => {
    await pick(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }));
    expect(calls.uploads).toEqual([]);
    expect(container.textContent).toContain("A workspace logo must be a PNG, JPEG or WebP image (SVG is not accepted).");
  });
});
