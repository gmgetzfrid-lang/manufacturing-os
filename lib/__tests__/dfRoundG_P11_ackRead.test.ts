// @vitest-environment jsdom
//
// drafting-flow EVID-7 (DF-P11): a distribution record that could not be read
// is never drawn as "none requested". The reads answer ok / unavailable /
// error per call (no module latch), and the panel renders the two faults
// apart from an empty roster.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  /** answers for successive distribution_acks reads, in order (then the last repeats) */
  answers: [] as Array<{ data: unknown; error: null | { message: string; code?: string } }>,
  reads: 0,
  /** answers for the single-row read (my pending ack); null = mirror the list answer's error */
  single: null as null | { data: unknown; error: null | { message: string; code?: string } },
}));

vi.mock("@/lib/supabase", () => {
  const next = () => {
    const a = s.answers[Math.min(s.reads, s.answers.length - 1)] ?? { data: [], error: null };
    s.reads++;
    return a;
  };
  const chain = (tableName: string): unknown => {
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (res: (v: unknown) => void) => res(tableName === "distribution_acks" ? next() : { data: [], error: null });
        }
        if (prop === "maybeSingle") {
          return () => {
            if (tableName !== "distribution_acks") return Promise.resolve({ data: null, error: null });
            if (s.single) return Promise.resolve(s.single);
            const a = next();
            return Promise.resolve({ data: Array.isArray(a.data) ? (a.data[0] ?? null) : a.data, error: a.error });
          };
        }
        return () => new Proxy(c, h);
      },
    };
    return new Proxy(c, h);
  };
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/complianceNotify", () => ({ notifyCompliance: vi.fn(async () => undefined) }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => undefined) }));
vi.mock("@/lib/holdGate", () => ({ assertNotOnHold: vi.fn(async () => undefined) }));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { readAcksForVersion, readMyPendingAck, listAcksForVersion } from "@/lib/distributionAcks";
import DistributionAcks from "@/components/documents/DistributionAcks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROW = {
  id: "a1", document_id: "d1", version_id: "v1", rev_label: "B", recipient_user_id: "u2",
  recipient_email: "field@x", requested_by_name: "DC", requested_at: "2026-10-01T00:00:00Z", acknowledged_at: null,
};
const MISSING = { data: null, error: { message: "relation \"distribution_acks\" does not exist", code: "42P01" } };
const FAILED = { data: null, error: { message: "statement timeout", code: "57014" } };

beforeEach(() => { s.answers = []; s.reads = 0; s.single = null; });

describe("EVID-7 — the reads say which of three things they found", () => {
  it("ok: the rows; an empty list is 'none requested'", async () => {
    s.answers = [{ data: [ROW], error: null }];
    const r = await readAcksForVersion("v1");
    expect(r.status).toBe("ok");
    expect(r.status === "ok" && r.value.map((a) => a.recipientEmail)).toEqual(["field@x"]);
    s.answers = [{ data: [], error: null }];
    expect(await readAcksForVersion("v1")).toEqual({ status: "ok", value: [] });
  });
  it("a missing table or column is 'unavailable' (named), a failed query is 'error' (with its reason)", async () => {
    s.answers = [MISSING];
    expect((await readAcksForVersion("v1")).status).toBe("unavailable");
    s.answers = [{ data: null, error: { message: "column distribution_acks.rev_label does not exist", code: "42703" } }];
    expect((await readAcksForVersion("v1")).status).toBe("unavailable");
    s.answers = [FAILED];
    expect(await readAcksForVersion("v1")).toEqual({ status: "error", message: "statement timeout" });
    s.answers = [FAILED];
    expect(await readMyPendingAck("v1", "u2")).toEqual({ status: "error", message: "statement timeout" });
  });
  it("no latch: a schema miss does not blind the next call (it used to, for the whole session)", async () => {
    s.answers = [MISSING, { data: [ROW], error: null }];
    expect((await readAcksForVersion("v1")).status).toBe("unavailable");
    const second = await readAcksForVersion("v1");
    expect(second.status).toBe("ok");
    expect(s.reads).toBe(2);
    // the compatibility wrapper asks again too
    s.answers = [MISSING, { data: [ROW], error: null }]; s.reads = 0;
    expect(await listAcksForVersion("v1")).toEqual([]);
    expect(await listAcksForVersion("v1")).toHaveLength(1);
  });
});

describe("EVID-7 — the panel never draws a fault as an empty roster", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  const mount = async (isController: boolean) => {
    await act(async () => {
      root.render(React.createElement(DistributionAcks, {
        documentId: "d1", orgId: "o1", libraryId: "l1", docLabel: "P-101", currentRev: "B", currentVersionId: "v1",
        currentUserId: "u9", currentUserName: "Viewer Person", isController,
      }));
    });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
  };
  const banner = () => host.querySelector("[data-ack-read]");

  it("a failed read says so, with the reason, to a non-controller too — not 'nothing to show'", async () => {
    s.answers = [FAILED];
    await mount(false);
    expect(banner()?.getAttribute("data-ack-read")).toBe("error");
    expect(host.textContent).toContain("Couldn't load the distribution record");
    expect(host.textContent).toContain("statement timeout");
    expect(host.textContent).toContain("this is not \"none requested\"");
  });
  it("a missing table is named as unavailable", async () => {
    s.answers = [MISSING];
    await mount(true);
    expect(banner()?.getAttribute("data-ack-read")).toBe("unavailable");
    expect(host.textContent).toContain("Distribution confirmations are unavailable");
  });
  it("Try again re-reads, and a healthy read draws the roster", async () => {
    s.answers = [FAILED, { data: [ROW], error: null }];
    s.single = { data: null, error: null };
    await mount(true);
    expect(banner()).not.toBeNull();
    const retry = Array.from(host.querySelectorAll("button")).find((b) => /Try again/.test(b.textContent ?? ""));
    await act(async () => { retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(banner()).toBeNull();
    expect(host.textContent).toMatch(/0 of 1/);
  });
  it("REGRESSION: a healthy empty read for a non-controller still renders nothing", async () => {
    s.answers = [{ data: [], error: null }];
    s.single = { data: null, error: null };
    await mount(false);
    expect(banner()).toBeNull();
    expect(host.textContent).toBe("");
  });
});
