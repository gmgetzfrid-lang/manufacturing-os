// lib/costDocParse.ts — the cost-document read's pure parts
// (/api/projects/cost-docs; projects Round G J12).
//
// PR-2 criterion 3 (intelligence) — the invoice side of the read.
// The quote branch of /api/projects/cost-docs stores `validateParsedQuote`'s
// record (lib/bidTab.ts); the invoice branch stored the model's raw JSON —
// whatever keys and types it chose — and checked only `total > 0`. This is
// the invoice's schema: every field the review screen and the posting path
// read, typed and bounded; anything else the model returned is dropped. It
// is a pure function so the route and its tests share it.

import { isoCurrency } from "@/lib/bidTab";

export interface ParsedInvoiceLine {
  description: string;
  total: number | null;
}

export interface ParsedInvoice {
  vendorName: string | null;
  docNumber: string | null;
  /** YYYY-MM-DD, or null when not printed (or not a calendar date). */
  docDate: string | null;
  /** The amount due — always a positive finite number. */
  total: number;
  /** A known ISO-4217 code, or null (unknown — never the model's free text). */
  currency: string | null;
  lineItems: ParsedInvoiceLine[];
}

/** At most this many billed lines are kept (a runaway extraction never
 *  becomes a megabyte of jsonb on the row). */
export const INVOICE_MAX_LINES = 200;

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A real calendar date in YYYY-MM-DD form ("2026-02-30" is not one). */
function isoDate(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

/** Validate an AI-extracted invoice payload. Throws a plain message when
 *  the amount due cannot be read (the route answers 422 with it). */
export function validateParsedInvoice(raw: unknown): ParsedInvoice {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const total = num(r.total);
  if (total == null || total <= 0) throw new Error("Couldn't read an amount due from the invoice.");
  const lines = Array.isArray(r.lineItems) ? r.lineItems : [];
  const lineItems: ParsedInvoiceLine[] = [];
  for (const li of lines) {
    if (lineItems.length >= INVOICE_MAX_LINES) break;
    if (!li || typeof li !== "object") continue;
    const l = li as Record<string, unknown>;
    const description = str(l.description, 500);
    const lineTotal = num(l.total);
    if (!description && lineTotal == null) continue;
    lineItems.push({ description: description ?? "", total: lineTotal });
  }
  return {
    vendorName: str(r.vendorName, 200),
    docNumber: str(r.docNumber, 60),
    docDate: isoDate(r.docDate),
    total,
    currency: isoCurrency(r.currency),
    lineItems,
  };
}

/** PM-1: a closed project's cost record is read-only (20261103 freezes it
 *  for a signed-in writer; the read route writes as the service role,
 *  which the freeze lets through, so the route refuses it itself — before
 *  the file is fetched and before the caller's AI key is spent). */
export function closedProjectReadMessage(status: string): string {
  return `This project is ${status} — its cost records are read-only, so nothing is read into them. An Admin / Document Control can reopen it.`;
}
