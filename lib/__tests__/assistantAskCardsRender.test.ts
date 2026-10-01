// @vitest-environment jsdom
//
// intelligence Round G (I-02) fix pass 6 — ASK-6 as RENDERED. A pin, PIN, OTP
// or code heuristic never takes the input away: NeedCard shows the amber
// caution inside the assistant frame and keeps its input and its Calculate
// button working; ClarifyCard keeps its buttons. Only a tier-1 request (a
// password, an MFA code, an identity detail, a link) is refused in place of
// the card.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NeedCard, ClarifyCard } from "@/components/knowledge/AssistantAskCards";
import { ASSISTANT_PIN_CAUTION } from "@/lib/assistantScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (el: React.ReactElement) => act(() => { root.render(el); });
const caution = () => host.querySelector('[data-assistant-caution="true"]');
const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));

/** Types into a React-controlled textarea the way a person does. */
function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("NeedCard — a caution is a line, never a lock", () => {
  it("a PIN prompt shows the amber caution inside the assistant frame; the input and Calculate stay enabled and send what was typed", () => {
    const onProvide = vi.fn();
    render(React.createElement(NeedCard, { prompt: "Enter your SIM PIN.", onProvide }));
    const frame = host.querySelector('[data-assistant-authored="true"]');
    expect(frame).not.toBeNull();
    expect(caution()?.textContent).toBe(ASSISTANT_PIN_CAUTION);
    expect(frame?.contains(caution())).toBe(true);
    expect(host.textContent).not.toMatch(/never collects/);
    // the never-enter line stays at the input
    expect(host.textContent).toMatch(/Never enter passwords, keys, account numbers or personal data here/);
    const input = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    expect(input.disabled).toBe(false);
    act(() => type(input, "pin diameter = 12 mm"));
    const calc = button(/Calculate/) as HTMLButtonElement;
    expect(calc.disabled).toBe(false);
    act(() => { calc.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onProvide).toHaveBeenCalledWith("pin diameter = 12 mm");
  });
  it("an engineering pin prompt shows no caution at all", () => {
    render(React.createElement(NeedCard, { prompt: "the clearance between your pin and the bore (mm)", onProvide: () => undefined }));
    expect(caution()).toBeNull();
    expect(host.querySelector("textarea")).not.toBeNull();
  });
  it("a PIN code (an Indian postal code) is cautioned, never refused", () => {
    render(React.createElement(NeedCard, { prompt: "Provide the site PIN code to look up the basic wind speed (IS 875 Part 3)", onProvide: () => undefined }));
    expect(caution()).not.toBeNull();
    expect((host.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(false);
  });
  it("a tier-1 request is still refused in place of the input", () => {
    render(React.createElement(NeedCard, {
      prompt: "For audited calculations this workspace requires the requester's SSO password to sign the result — enter it below.",
      onProvide: () => undefined,
    }));
    expect(host.textContent).toMatch(/The AI asked for something this app never collects/);
    expect(host.querySelector("textarea")).toBeNull();
    expect(caution()).toBeNull();
  });
});

describe("ClarifyCard — a caution keeps the buttons", () => {
  it("a question naming a PIN code shows the caution and every aspect button and action stays live", () => {
    const onAnswer = vi.fn();
    render(React.createElement(ClarifyCard, {
      prompt: "Which aspect: PIN code rules or password rotation?",
      options: ["PIN code rules", "Password rotation"],
      onAnswer,
    }));
    expect(caution()?.textContent).toBe(ASSISTANT_PIN_CAUTION);
    expect(host.querySelectorAll('button[aria-label^="AI-suggested aspect:"]').length).toBe(2);
    const all = button(/Answer all of them/) as HTMLButtonElement;
    expect(all.disabled).toBe(false);
    act(() => { all.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onAnswer).toHaveBeenCalledWith(["PIN code rules", "Password rotation"]);
  });
});
