// @vitest-environment jsdom
//
// document-control Round F wave 3 — P15 SURFACE REMAINDERS, third review fix:
// public-surfaces SHR-14 done-when 3, RENDERED. The share modal asks the
// database's download-deny predicate (user_download_denied, 20261140) and
// says why instead of offering the Create box. The earlier pins were regexes
// over the modal's source; this drives the real ShareLinkModal (jsdom) over
// the real lib/documentShares.ts shareMintDownloadDenial / mintDenialNotice,
// with only supabase.rpc answering:
//   * true (a deny names the minter)          → the deny box, no Create box;
//   * an error (the check failed — unknown)   → the deny box, no Create box
//     (fail closed);
//   * PGRST202 / 42883 (20261140 not pasted)  → the Create box, as before,
//     and the reason logged (unchecked);
//   * false (clear)                           → the Create box (regression).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Rpc = { data: unknown; error: { message: string; code?: string } | null } | "throw";
const s = vi.hoisted(() => ({
  rpc: { data: false, error: null } as Rpc,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      s.rpcCalls.push({ fn, args });
      if (s.rpc === "throw") throw new Error("network down");
      return s.rpc;
    },
    from: () => { throw new Error("no table read is expected from the modal in this test"); },
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ error: null })) }));
// The document context, the listing and the status / hold refusal are the
// modal's other reads — answered here so only the deny predicate varies.
vi.mock("@/lib/documentShares", async (orig) => ({
  ...(await orig<typeof import("@/lib/documentShares")>()),
  listShareLinks: vi.fn(async () => ({ readable: true, shares: [] })),
  loadShareDocumentContext: vi.fn(async () => ({
    rev: "B", status: "Issued", archivedAt: null, libraryId: "lib1",
    served: { kind: "served", rev: "B" }, aclIndex: { deny: { teams: { download: ["team-vendor"] } } },
  })),
  shareRefusalState: vi.fn(async () => null),
}));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ hasAnyRole: () => true }) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => false) }));
vi.mock("@/components/ui/QrBadge", () => ({ default: () => null }));
vi.mock("@/lib/publicOrigin", () => ({ publicOrigin: () => "https://app.example" }));

import ShareLinkModal from "@/components/documents/ShareLinkModal";
import { SHARE_DOWNLOAD_DENIED } from "@/lib/documentShares";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  s.rpc = { data: false, error: null };
  s.rpcCalls = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  warn.mockRestore();
});

async function open() {
  await act(async () => {
    root.render(React.createElement(ShareLinkModal, {
      isOpen: true, onClose: () => {}, orgId: "orgA", documentId: "docA", documentLabel: "P-101", createdBy: "u1", createdByName: "Dana",
    }));
  });
  // the refresh's reads settle
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const createButton = () => Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Create link"));
const denyBox = () => host.querySelector('[data-testid="share-mint-denied"]');

describe("SHR-14 dw3 (rendered) — the modal asks user_download_denied for the minter and says why instead of offering Create", () => {
  it("a deny that names the minter: the deny box with the reason, and NO Create box", async () => {
    s.rpc = { data: true, error: null };
    await open();
    expect(s.rpcCalls).toEqual([{ fn: "user_download_denied", args: { p_acl_index: { deny: { teams: { download: ["team-vendor"] } } }, p_uid: "u1", p_org: "orgA" } }]);
    expect(denyBox()?.textContent).toBe(`No new link can be created: ${SHARE_DOWNLOAD_DENIED}`);
    expect(createButton()).toBeUndefined();
    expect(host.textContent).not.toContain("Create new");
  });

  it("the check failed (unknown): fails CLOSED — the deny box says it could not be confirmed, and NO Create box", async () => {
    s.rpc = { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
    await open();
    expect(denyBox()?.textContent).toMatch(/^No new link can be created: Couldn't confirm that you may download this document \(canceling statement due to statement timeout\)/);
    expect(createButton()).toBeUndefined();
    // a thrown call is unknown too
    s.rpc = "throw";
    await act(async () => root.unmount());
    root = createRoot(host);
    await open();
    expect(denyBox()?.textContent).toMatch(/Couldn't confirm that you may download this document \(network down\)/);
    expect(createButton()).toBeUndefined();
  });

  it("the predicate is not installed (PGRST202 / 42883 — 20261140 not pasted): unchecked — the Create box is offered as before, and the reason is logged", async () => {
    s.rpc = { data: null, error: { message: "Could not find the function public.user_download_denied", code: "PGRST202" } };
    await open();
    expect(denyBox()).toBeNull();
    expect(createButton()).toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/user_download_denied is not installed \(migration 20261140 is not applied\)/));
    s.rpc = { data: null, error: { message: "function user_download_denied(jsonb, uuid, uuid) does not exist", code: "42883" } };
    await act(async () => root.unmount());
    root = createRoot(host);
    await open();
    expect(denyBox()).toBeNull();
    expect(createButton()).toBeDefined();
  });

  it("REGRESSION: a clear answer offers the Create box exactly as before — no deny box", async () => {
    s.rpc = { data: false, error: null };
    await open();
    expect(denyBox()).toBeNull();
    expect(createButton()).toBeDefined();
    expect(host.textContent).toContain("Create new");
  });
});
