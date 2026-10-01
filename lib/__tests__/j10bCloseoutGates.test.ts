// @vitest-environment jsdom
//
// projects Round G — J10b UI REMAINDERS: projects-and-cost QUAL-8 (the
// closeout-dialog limb). The "Mark project complete" dialog gathered the
// snapshot with `.catch(() => undefined)`: a failed gather left `gates` null,
// the gate panel was simply not drawn, and Confirm stayed live — the operator
// saw no gates rather than failing ones, and the completion recorded no gate
// state. Now:
//   * while the gates load the dialog says so, and Confirm waits;
//   * a failed gather is said — the reason, and a Retry that gathers again —
//     and Confirm waits;
//   * once the gates are on screen the dialog is as before (the recorded
//     gate lines, the override line) and Confirm works — the gates stay
//     warnings, not walls.
// The page needs the whole project to render, so its wiring is pinned by
// source (as projectPageRoundG.test.ts does); the panel is rendered.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import CloseoutGatesPending, { CLOSEOUT_GATES_WAIT } from "@/components/projects/CloseoutGatesPending";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const page = readFileSync(join(process.cwd(), "app/(protected)/projects/[id]/page.tsx"), "utf8");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("QUAL-8 — the closeout dialog never omits its gates silently", () => {
  it("rendered, loading: 'Checking the closeout gates…' as a status, no alert", async () => {
    await act(async () => { root.render(React.createElement(CloseoutGatesPending, { error: null, onRetry: vi.fn() })); });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Checking the closeout gates…");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("Closeout gates");
  });

  it("rendered, failed: the reason is said as an alert with what Confirm does, and Retry gathers again", async () => {
    const onRetry = vi.fn();
    await act(async () => {
      root.render(React.createElement(CloseoutGatesPending, { error: "The database took too long to answer. Try again in a moment.", onRetry }));
    });
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("The closeout gates could not be loaded — The database took too long to answer. Try again in a moment.");
    expect(alert.textContent).toContain(CLOSEOUT_GATES_WAIT);
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry") as HTMLButtonElement;
    expect(retry.className).toContain("pointer-coarse:min-h-11");
    await act(async () => { retry.click(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("page: a rejected gather is kept (never swallowed) and Retry re-runs the gather", () => {
    const effect = page.slice(page.indexOf("// Closeout gates load when the Complete confirmation opens."), page.indexOf("useEffect(() => { void refresh(); }, [refresh]);"));
    expect(effect).not.toContain(".catch(() => undefined)");
    expect(effect).toContain('.catch((e) => { if (!cancelled) setGatesError(userFacingCaughtError(e, { action: "read", context: "closeout gates" })); });');
    expect(effect).toContain("setGates(null); setGatesError(null);");
    expect(effect).toContain("}, [pendingStatus, projectId, gatesTry]);");
  });

  it("page: while the gates are not in hand the panel says why and Confirm waits; once they are, the dialog is as before", () => {
    const dialog = page.slice(page.indexOf("{/* TRANSITION CONFIRM */}"));
    expect(dialog).toContain('{pendingStatus === "completed" && !gates && (\n              <CloseoutGatesPending error={gatesError} onRetry={() => setGatesTry((n) => n + 1)} />\n            )}');
    // the loaded panel is unchanged — the recorded lines and the override line
    expect(dialog).toContain('{pendingStatus === "completed" && gates && (() => {');
    expect(dialog).toContain("const gateLines = closeoutGateLines(gates);");
    expect(dialog).toContain("{CLOSEOUT_GATE_POLICY.overrideNote} The gate state above is recorded with the completion.");
    // Confirm: disabled while busy, and for a completion until the gates are on screen
    expect(dialog).toContain('<button onClick={handleTransition} disabled={transitionBusy || (pendingStatus === "completed" && !gates)}');
    expect(dialog).toContain('title={pendingStatus === "completed" && !gates ? CLOSEOUT_GATES_WAIT : undefined}');
    // the transition still records the gates the actor was shown
    expect(page).toContain('gateSnapshot: pendingStatus === "completed" ? gates : undefined,');
    // and the handler itself refuses a completion with no gates in hand (the review's cheap hardening):
    // the guard sits before the busy flag and the write
    const handler = page.slice(page.indexOf("const handleTransition = async () => {"));
    const guard = 'if (pendingStatus === "completed" && !gates) return;';
    expect(handler).toContain(guard);
    expect(handler.indexOf(guard)).toBeLessThan(handler.indexOf("setTransitionBusy(true);"));
    expect(handler.indexOf(guard)).toBeLessThan(handler.indexOf("await transitionProjectStatus({"));
  });
});
