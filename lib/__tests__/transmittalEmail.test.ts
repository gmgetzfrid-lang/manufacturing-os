// The transmittal issue email — the artifact that makes "transmit" true.

import { describe, it, expect } from "vitest";
import { renderTransmittalEmail, type Transmittal } from "@/lib/transmittals";

const base: Transmittal = {
  id: "t1", orgId: "o1", seq: 7, number: "TR-0007",
  subject: "IFC set — Area 200",
  recipientName: "Jane Doe", recipientCompany: "BuildCo",
  recipientEmail: "jane@buildco.com",
  purpose: "For Construction", status: "issued",
  notes: "Supersedes TR-0004.",
  items: [
    { documentId: "d1", number: "P-200-001", title: "P&ID Area 200", rev: "C" },
    { documentId: "d2", number: "P-200-002", title: null, rev: null },
  ],
};
const PORTAL = "https://app.example.com/transmittal/tok123";

describe("renderTransmittalEmail", () => {
  it("subject carries the number, subject line, and purpose", () => {
    const { subject } = renderTransmittalEmail(base, PORTAL);
    expect(subject).toBe("Transmittal TR-0007 — IFC set — Area 200 (For Construction)");
  });

  it("text body lists every document and the portal link", () => {
    const { text } = renderTransmittalEmail(base, PORTAL);
    expect(text).toContain("Hello Jane Doe,");
    expect(text).toContain("P-200-001 (Rev C) — P&ID Area 200");
    expect(text).toContain("P-200-002");
    expect(text).toContain(PORTAL);
    expect(text).toContain("Supersedes TR-0004.");
  });

  it("html escapes recipient-controlled fields", () => {
    const evil = { ...base, subject: '<img src=x onerror=alert(1)>', recipientName: 'A<b>' };
    const { html } = renderTransmittalEmail(evil, PORTAL);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain("A<b>");
  });

  it("copes with a bare transmittal (no name, no purpose, no items)", () => {
    const bare: Transmittal = { id: "t2", orgId: "o1", seq: 8, number: "TR-0008", status: "issued", items: [] };
    const { subject, text } = renderTransmittalEmail(bare, PORTAL);
    expect(subject).toBe("Transmittal TR-0008");
    expect(text).toContain("Hello,");
    expect(text).toContain(PORTAL);
  });
});
