// @vitest-environment jsdom
//
// document-control Round G — P27: DIST-17, the transmittal register RENDERED
// with rows the server filtered for the viewer (lib/transmittals
// listTransmittals → /api/transmittal/register → redactTransmittalForViewer).
// A transmit authority who may not read one item of a transmittal: the row
// says how many items are restricted, its portal-link copy is held back with
// the reason, Revoke / Void / Receipt stay (REGRESSION — cutting a link is a
// safety action, judged by transmit authority, not by reading), and a draft
// carrying a restricted item is not editable by them while every other draft
// is (REGRESSION). A register whose access check failed says so.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  rows: [] as unknown[],
  role: { activeOrgId: "org-a", uid: "u-eng", userEmail: "eng@a", activeRole: "Engineer-2", roles: ["Engineer-2"] },
}));

vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => {
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], error: null, count: 0 });
        return () => new Proxy(c, h);
      },
    };
    return new Proxy(c, h);
  };
  return { supabase: { from: () => chain(), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/lib/capabilityPolicy", async (orig) => ({
  ...(await orig<typeof import("@/lib/capabilityPolicy")>()),
  // this org grants transmit authority to Engineer-2 (a non-controller)
  loadCapabilityPolicyEntry: vi.fn(async () => ({ policy: { caps: { "transmittal.issue": ["Engineer-2"] } }, version: "v1" })),
}));
vi.mock("@/lib/transmittals", async (orig) => {
  const real = await orig<typeof import("@/lib/transmittals")>();
  return { ...real, listTransmittals: vi.fn(async () => s.rows) };
});
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => s.role }));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => false), appPrompt: vi.fn(async () => null) }));
vi.mock("@/components/navigation/ViewTabs", () => ({ default: () => null, DOCUMENT_VIEWS: [] }));
vi.mock("@/components/documents/DocThumb", () => ({ default: () => null }));
vi.mock("@/components/documents/DocHoverPreview", () => ({ default: () => null }));

import TransmittalsPage from "@/app/(protected)/transmittals/page";
import { redactTransmittalForViewer, rowToTransmittal } from "@/lib/transmittals";

const PID = "d-pid", OPEN = "d-open";
const base = (over: Record<string, unknown>) => rowToTransmittal({
  org_id: "org-a", purpose: "For Construction", recipient_name: "Jane Doe", recipient_company: "BuildCo",
  created_by: "u-other", subject: "Unit 3 relief package",
  items: [{ documentId: PID, number: "PID-4412", title: "HF alkylation relief", rev: "C" }, { documentId: OPEN, number: "P-101", rev: "B" }],
  ...over,
});
const eng = { uid: "u-eng", isController: false };
const ISSUED_RESTRICTED = redactTransmittalForViewer(base({ id: "t7", seq: 7, number: "TR-0007", status: "issued", issued_at: "2026-10-01T00:00:00Z", portal_token: "tok7", portal_expires_at: "2099-01-01T00:00:00Z" }), eng, new Set([OPEN]));
const ISSUED_OPEN = redactTransmittalForViewer(base({ id: "t6", seq: 6, number: "TR-0006", status: "issued", issued_at: "2026-10-01T00:00:00Z", portal_token: "tok6", portal_expires_at: "2099-01-01T00:00:00Z" }), eng, new Set([PID, OPEN]));
const DRAFT_RESTRICTED = redactTransmittalForViewer(base({ id: "t5", seq: 5, number: "TR-0005", status: "draft" }), eng, new Set([OPEN]));
const DRAFT_OPEN = redactTransmittalForViewer(base({ id: "t4", seq: 4, number: "TR-0004", status: "draft" }), eng, new Set([PID, OPEN]));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://mfg.yourplant.com");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  s.rows = [ISSUED_RESTRICTED, ISSUED_OPEN, DRAFT_RESTRICTED, DRAFT_OPEN];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllEnvs();
});

async function render() {
  await act(async () => { root.render(React.createElement(TransmittalsPage)); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
const rowOf = (number: string) => Array.from(host.querySelectorAll("div.rounded-2xl")).find((d) => (d.textContent ?? "").includes(number)) as HTMLElement | undefined;
const buttonIn = (row: HTMLElement | undefined, re: RegExp) => Array.from(row?.querySelectorAll("button") ?? []).find((b) => re.test(b.getAttribute("title") ?? "") || re.test(b.textContent ?? "")) as HTMLButtonElement | undefined;

describe("DIST-17 — the register drawn from the viewer's rows", () => {
  it("never shows the restricted document's number, title or the transmittal's subject; the row says how many are restricted", async () => {
    await render();
    const r = rowOf("TR-0007");
    expect(r).toBeDefined();
    expect(host.textContent).not.toMatch(/PID-4412|HF alkylation/);
    expect(r!.querySelector('[data-testid="transmittal-restricted"]')?.textContent).toMatch(/1 restricted/);
    expect(r!.textContent).not.toContain("Unit 3 relief package");
    expect(r!.textContent).toContain("Document Transmittal");
    expect(r!.textContent).toContain("2 docs"); // the count stays
  });

  it("ruling 2: the portal-link copy is held back (disabled, with the reason) where the token was withheld; REGRESSION: offered as before where it was not", async () => {
    await render();
    const held = buttonIn(rowOf("TR-0007"), /Portal link/);
    expect(held).toBeDefined();
    expect(held!.disabled).toBe(true);
    expect(held!.getAttribute("title")).toMatch(/you may not read every document on this transmittal/);
    const offered = buttonIn(rowOf("TR-0006"), /Portal link/);
    expect(offered!.disabled).toBe(false);
    expect(offered!.getAttribute("title")).toMatch(/Copy the recipient's secure portal link/);
  });

  it("REGRESSION: Revoke, Void and Receipt stay for the transmit authority on the restricted row (the link's lifecycle is drawn from the withheld token)", async () => {
    await render();
    const r = rowOf("TR-0007");
    expect(buttonIn(r, /Revoke the portal link/)).toBeDefined();
    expect(buttonIn(r, /Void — issued in error/)).toBeDefined();
    expect(buttonIn(r, /Record recipient receipt/)).toBeDefined();
    expect(buttonIn(r, /Cover sheet/)).toBeDefined();
  });

  it("a draft carrying a restricted item is not editable by this viewer; REGRESSION: every other draft is", async () => {
    await render();
    expect(buttonIn(rowOf("TR-0005"), /Edit draft/)).toBeUndefined();
    expect(buttonIn(rowOf("TR-0004"), /Edit draft/)).toBeDefined();
  });

  it("REGRESSION: with nothing restricted there is no chip and no notice", async () => {
    s.rows = [ISSUED_OPEN, DRAFT_OPEN];
    await render();
    expect(host.querySelector('[data-testid="transmittal-restricted"]')).toBeNull();
    expect(host.querySelector('[data-testid="transmittal-access-unchecked"]')).toBeNull();
    expect(host.textContent).toContain("Unit 3 relief package");
  });

  it("REGRESSION: the recipient's portal usage stays on the row whose token was withheld, as on the row whose token was not", async () => {
    s.rows = [
      redactTransmittalForViewer(base({ id: "t8", seq: 8, number: "TR-0008", status: "issued", issued_at: "2026-10-01T00:00:00Z", portal_token: "tok8", portal_expires_at: "2099-01-01T00:00:00Z", portal_open_count: 3, portal_download_count: 2 }), eng, new Set([OPEN])),
      redactTransmittalForViewer(base({ id: "t3", seq: 3, number: "TR-0003", status: "issued", issued_at: "2026-10-01T00:00:00Z", portal_token: "tok3", portal_expires_at: "2099-01-01T00:00:00Z", portal_open_count: 1, portal_download_count: 1 }), eng, new Set([PID, OPEN])),
    ];
    await render();
    expect(rowOf("TR-0008")!.textContent).toContain("Portal opened 3× · 2 downloads");
    expect(rowOf("TR-0003")!.textContent).toContain("Portal opened 1× · 1 download");
  });

  it("an access check that failed is said on the page", async () => {
    s.rows = [redactTransmittalForViewer(base({ id: "t9", seq: 9, number: "TR-0009", status: "issued", portal_token: "tok9" }), eng, null)];
    await render();
    expect(host.querySelector('[data-testid="transmittal-access-unchecked"]')?.textContent).toMatch(/couldn.t be checked/);
  });
});
