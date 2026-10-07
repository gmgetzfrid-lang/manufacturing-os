// @vitest-environment jsdom
//
// admin-and-org Round G — package P9, ALOG-2 done-when 1, RENDERED: the
// access-recertification modal shows a refused attestation (and a refused
// cadence save) to the reviewer instead of quietly returning to the form, says
// when the access list could not be read (and offers no attestation from it),
// and lists expired grants apart from current access.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  recertify: vi.fn(),
  setPolicy: vi.fn(),
  detailed: vi.fn(),
  lib: { data: { recert_policy: { enabled: true, intervalMonths: 6 }, last_recertified_at: null, next_recertification_date: null } as unknown, error: null as unknown },
}));

vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => {
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void) => res(s.lib);
        if (prop === "maybeSingle") return () => Promise.resolve(s.lib);
        return () => new Proxy(c, h);
      },
    };
    return new Proxy(c, h);
  };
  return { supabase: { from: () => chain() } };
});
vi.mock("@/lib/accessRecert", async () => {
  const actual = await vi.importActual<typeof import("@/lib/accessRecert")>("@/lib/accessRecert");
  return {
    ...actual,
    recertifyAccess: (...a: unknown[]) => s.recertify(...a),
    setRecertPolicy: (...a: unknown[]) => s.setPolicy(...a),
    listAccessGrantsDetailed: (...a: unknown[]) => s.detailed(...a),
  };
});

import AccessRecertModal from "@/components/documents/AccessRecertModal";

let host: HTMLDivElement;
let root: Root;
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const text = () => host.textContent ?? "";
const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? "")) as HTMLButtonElement;

async function mount() {
  await act(async () => {
    root.render(React.createElement(AccessRecertModal, { libraryId: "l1", orgId: "o1", name: "P&ID", uid: "u-eng", userName: "eng@x", onClose: () => undefined }));
  });
  await flush();
}

const LIVE = [{ subjectType: "user", subjectId: "u-eng", subjectName: "Eng", actions: ["read"], expiresAt: null, status: "active" }];
const EXPIRED = [{ subjectType: "user", subjectId: "u-gone", subjectName: "Departed Contractor", actions: ["read"], expiresAt: "2020-01-01T00:00:00Z", status: "expired" }];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  s.recertify.mockReset(); s.setPolicy.mockReset(); s.detailed.mockReset();
  s.lib = { data: { recert_policy: { enabled: true, intervalMonths: 6 }, last_recertified_at: null, next_recertification_date: null }, error: null };
  s.detailed.mockResolvedValue({ live: LIVE, expired: EXPIRED, complete: true, issues: [], visibility: "private" });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("ALOG-2 — AccessRecertModal never hides a refusal", () => {
  it("a refused attestation is shown in the modal (it used to be an unhandled rejection with the form unchanged)", async () => {
    s.recertify.mockRejectedValue(new Error("Recertification was NOT recorded: the attestation record was refused (new row violates row-level security policy). The library's recertification dates were put back."));
    await mount();
    await act(async () => { button(/Recertify — access reviewed/).click(); });
    await flush();
    expect(s.recertify).toHaveBeenCalledTimes(1);
    const alert = [...host.querySelectorAll('[role="alert"]')].map((n) => n.textContent).join(" ");
    expect(alert).toContain("Recertification was NOT recorded: the attestation record was refused");
    expect(button(/Recertify — access reviewed/).disabled).toBe(false); // busy cleared
  });

  it("a refused cadence save is shown too", async () => {
    s.setPolicy.mockRejectedValue(new Error("The recertification cadence was saved on the library, but its record was refused (denied)"));
    await mount();
    await act(async () => { button(/Save cadence/).click(); });
    await flush();
    expect(text()).toContain("its record was refused (denied)");
  });

  it("regression: a successful attestation clears the note, reloads and calls onSaved — no error shown", async () => {
    s.recertify.mockResolvedValue({ grantCount: 1, nextDate: "2027-04-07" });
    const onSaved = vi.fn();
    await act(async () => {
      root.render(React.createElement(AccessRecertModal, { libraryId: "l1", orgId: "o1", uid: "u-eng", onClose: () => undefined, onSaved }));
    });
    await flush();
    await act(async () => { button(/Recertify — access reviewed/).click(); });
    await flush();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(s.detailed).toHaveBeenCalledTimes(2); // mount + reload
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(s.recertify.mock.calls[0][0]).toMatchObject({ libraryId: "l1", orgId: "o1", actorId: "u-eng" });
  });

  it("done-when 4 (label): expired grants are listed apart, struck through, never in Current access", async () => {
    await mount();
    expect(text()).toContain("Current access · 1");
    expect(text()).toContain("Expired grants · 1 — not attested as current");
    expect(text()).toContain("Departed Contractor");
  });

  it("fix pass 2: a library row that could not be read turns Save / Remove cadence off — the form's defaults never overwrite a cadence nobody saw", async () => {
    s.lib = { data: null, error: { message: "upstream timeout" } };
    await mount();
    expect(text()).toContain("The library's cadence could not be read (upstream timeout)");
    expect(button(/Save cadence/).disabled).toBe(true);
    await act(async () => { button(/Save cadence/).click(); });
    await flush();
    expect(s.setPolicy).not.toHaveBeenCalled();
    expect(button(/Recertify — access reviewed/).disabled).toBe(true);
    // not found reads the same way
    act(() => root.unmount()); root = createRoot(host);
    s.lib = { data: null, error: null };
    await mount();
    expect(text()).toContain("The library's cadence could not be read (the library was not found)");
    expect(button(/Save cadence/).disabled).toBe(true);
  });

  it("regression: a readable library leaves the cadence controls on (an access-list issue alone does not turn them off)", async () => {
    s.detailed.mockResolvedValue({ live: [], expired: [], complete: false, issues: ["members: timeout"], visibility: null });
    await mount();
    expect(text()).not.toContain("cadence could not be read");
    expect(button(/Save cadence/).disabled).toBe(false);
    expect(button(/Remove cadence/).disabled).toBe(false);
  });

  it("an access list that could not be resolved is said, and attesting from it is off", async () => {
    s.detailed.mockResolvedValue({ live: [], expired: [], complete: false, issues: ["members: timeout"], visibility: null });
    await mount();
    expect(text()).toContain("The access list could not be read (members: timeout)");
    expect(text()).not.toContain("No member can read this library today.");
    expect(button(/Recertify — access reviewed/).disabled).toBe(true);
  });
});
