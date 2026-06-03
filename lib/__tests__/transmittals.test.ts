// lib/__tests__/transmittals.test.ts
import { describe, it, expect } from "vitest";
import {
  formatTransmittalNumber,
  transmittalStatusMeta,
  isTransmittalIssuable,
  renderTransmittalSheet,
  rowToTransmittal,
  type Transmittal,
} from "@/lib/transmittals";

function tx(p: Partial<Transmittal> = {}): Transmittal {
  return {
    id: "t1", orgId: "o1", seq: 1, number: "TR-0001", status: "draft",
    items: [], ...p,
  };
}

describe("formatTransmittalNumber", () => {
  it("zero-pads to 4 digits with a TR- prefix", () => {
    expect(formatTransmittalNumber(1)).toBe("TR-0001");
    expect(formatTransmittalNumber(42)).toBe("TR-0042");
    expect(formatTransmittalNumber(1234)).toBe("TR-1234");
  });
  it("does not truncate sequences beyond 4 digits", () => {
    expect(formatTransmittalNumber(12345)).toBe("TR-12345");
  });
  it("guards against non-positive / invalid input", () => {
    expect(formatTransmittalNumber(0)).toBe("TR-0001");
    expect(formatTransmittalNumber(-5)).toBe("TR-0001");
    expect(formatTransmittalNumber(NaN)).toBe("TR-0001");
  });
});

describe("transmittalStatusMeta", () => {
  it("maps each status to a label + tone", () => {
    expect(transmittalStatusMeta("draft")).toEqual({ label: "Draft", tone: "slate" });
    expect(transmittalStatusMeta("issued")).toEqual({ label: "Issued", tone: "blue" });
    expect(transmittalStatusMeta("acknowledged")).toEqual({ label: "Acknowledged", tone: "emerald" });
    expect(transmittalStatusMeta("voided")).toEqual({ label: "Voided", tone: "rose" });
  });
});

describe("isTransmittalIssuable", () => {
  it("requires at least one document AND a recipient", () => {
    expect(isTransmittalIssuable({ items: [], recipientName: "Acme" })).toBe(false);
    expect(isTransmittalIssuable({ items: [{ documentId: "d", number: "P-1" }], recipientName: "" })).toBe(false);
    expect(isTransmittalIssuable({ items: [{ documentId: "d", number: "P-1" }], recipientName: "Acme" })).toBe(true);
  });
  it("accepts a company in lieu of a contact name", () => {
    expect(isTransmittalIssuable({ items: [{ documentId: "d", number: "P-1" }], recipientCompany: "Acme Inc" })).toBe(true);
  });
});

describe("renderTransmittalSheet", () => {
  const t = tx({
    number: "TR-0007",
    subject: "Issued for Construction — Area 200",
    purpose: "For Construction",
    recipientName: "Jane Doe",
    recipientCompany: "BuildCo",
    createdByName: "alice",
    status: "issued",
    issuedAt: "2026-05-01T12:00:00Z",
    items: [
      { documentId: "d1", number: "P-101", title: "Plot Plan", rev: "C" },
      { documentId: "d2", number: "P-102", title: "P&ID", rev: "B" },
    ],
    notes: "Please confirm receipt.",
  });

  it("includes the number, purpose, recipient and every document row", () => {
    const html = renderTransmittalSheet(t);
    expect(html).toContain("TR-0007");
    expect(html).toContain("For Construction");
    expect(html).toContain("Jane Doe");
    expect(html).toContain("BuildCo");
    expect(html).toContain("P-101");
    expect(html).toContain("Plot Plan");
    expect(html).toContain("P-102");
    expect(html).toContain("Please confirm receipt.");
  });

  it("renders a signature block when not yet acknowledged", () => {
    const html = renderTransmittalSheet(t);
    expect(html).toContain("Received by");
    expect(html).not.toContain("Receipt acknowledged");
  });

  it("renders the acknowledgement line once acknowledged", () => {
    const html = renderTransmittalSheet(tx({ ...t, status: "acknowledged", acknowledgedByName: "Jane Doe", acknowledgedAt: "2026-05-02T09:00:00Z" }));
    expect(html).toContain("Receipt acknowledged");
    expect(html).toContain("Jane Doe");
    expect(html).not.toContain("Received by (print");
  });

  it("escapes HTML in user-supplied fields", () => {
    const html = renderTransmittalSheet(tx({ subject: "<script>alert(1)</script>", items: [] }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("rowToTransmittal", () => {
  it("normalizes a DB row, coercing snake_case item keys", () => {
    const t = rowToTransmittal({
      id: "t9", org_id: "o1", seq: 9, number: "TR-0009", status: "issued",
      recipient_name: "Bob", created_by_name: "alice",
      items: [{ document_id: "d1", number: "P-1", title: "T", rev: "A", version_id: "v1" }],
    });
    expect(t.id).toBe("t9");
    expect(t.recipientName).toBe("Bob");
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toEqual({ documentId: "d1", number: "P-1", title: "T", rev: "A", versionId: "v1" });
  });
  it("defaults items to an empty array when absent", () => {
    const t = rowToTransmittal({ id: "t", org_id: "o", seq: 1, number: "TR-0001" });
    expect(t.items).toEqual([]);
    expect(t.status).toBe("draft");
  });
});
