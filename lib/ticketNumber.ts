// lib/ticketNumber.ts
//
// Human, collision-proof request numbers:  {ORG}-DDRT-{YY}-{NNNN}
// e.g. KE-DDRT-26-0001.
//
// The sequence comes from an ATOMIC per-(org, year) counter in the database
// (the next_ticket_number RPC), so two simultaneous submissions can never get
// the same number, and it resets each year. Prefix / record code / padding are
// per-org settings on the orgs row.
//
// drafting-flow Round G, DF-P2 (EDGE-13): every request is numbered by
// /api/tickets/create, and only AFTER it has validated the request — so a
// refused submit never spends a number. That route allocates through the
// same RPC (as the caller: the function admits active members by auth.uid()),
// reads the prefix / code / pad with a CHECKED read (ticketNumberConfigFromRow
// below; a failed read is a 503, never a number in the wrong format) and
// formats with formatTicketNumber. What it guarantees, exactly:
//   * a number is allocated only after validation;
//   * a number is given back (compare-and-set on next_seq) only when the
//     insert DEFINITELY did not commit — Postgres refused it with its own
//     SQLSTATE, no row carries the number, and no later number was issued;
//   * a number an insert MAY have committed (a dropped connection, a lost
//     reply) is never given back — the route looks for its own row and, if
//     it is there, carries on as filed;
//   * a number already on a row (23505) is left as it is, and the request is
//     filed under a fresh number once.
// So the sequence keeps gaps: an insert that failed after a concurrent
// submission took the next number, an ambiguous failure, a number some other
// row already held, and a function that died between allocating and
// inserting. 20260724's header says "gap-free" (migrations are not edited;
// the record is drafting-flow EDGE-13). generateTicketNumber is kept for a
// caller that numbers something outside that route; no request path calls it.

import { supabase } from "@/lib/supabase";

export interface TicketNumberConfig {
  /** Org abbreviation, e.g. "KE". Empty = omitted from the number. */
  prefix: string;
  /** Record-type code, e.g. "DDRT". */
  recordCode: string;
  /** Zero-pad width for the sequence. */
  pad: number;
}

export const TICKET_NUMBER_DEFAULTS: TicketNumberConfig = { prefix: "", recordCode: "DDRT", pad: 4 };

/** The orgs row's numbering columns as a config (the defaults where a
 *  column is unset). Pure: the caller reads the row — and checks the read. */
export function ticketNumberConfigFromRow(data: Record<string, unknown> | null | undefined): TicketNumberConfig {
  return {
    prefix: ((data?.ticket_prefix as string | null) ?? "").trim(),
    recordCode: (((data?.ticket_record_code as string | null) ?? "").trim()) || TICKET_NUMBER_DEFAULTS.recordCode,
    pad: (data?.ticket_number_pad as number | null) ?? TICKET_NUMBER_DEFAULTS.pad,
  };
}

/** Unchecked: a failed read yields the defaults (no prefix). Fine for a
 *  preview; the create route reads the row itself and refuses on an error. */
export async function getTicketNumberConfig(orgId: string): Promise<TicketNumberConfig> {
  const { data } = await supabase
    .from("orgs")
    .select("ticket_prefix, ticket_record_code, ticket_number_pad")
    .eq("id", orgId)
    .maybeSingle();
  return ticketNumberConfigFromRow(data as Record<string, unknown> | null);
}

/** Render a number string from its parts. Pure — also used for live previews. */
export function formatTicketNumber(cfg: TicketNumberConfig, year: number, seq: number): string {
  const yy = String(year).slice(-2);
  const num = String(seq).padStart(Math.max(1, cfg.pad), "0");
  return [cfg.prefix, cfg.recordCode, yy, num].filter((p) => p && p.length > 0).join("-");
}

/**
 * Allocate the next collision-proof request number for an org (current year).
 * Throws (surfaced to the user) rather than inventing a fallback, so a missing
 * migration is loud instead of silently producing duplicate-prone numbers.
 */
export async function generateTicketNumber(orgId: string): Promise<string> {
  if (!orgId) throw new Error("No workspace selected.");
  const year = new Date().getFullYear();
  const cfg = await getTicketNumberConfig(orgId);
  const { data: seq, error } = await supabase.rpc("next_ticket_number", { p_org: orgId, p_year: year });
  if (error || seq == null) {
    const msg = error?.message ?? "";
    throw new Error(
      /function|schema|does not exist/i.test(msg)
        ? "Ticket numbering isn't set up yet — apply migration 20260724_ticket_numbering.sql."
        : `Couldn't generate a request number: ${msg || "unknown error"}`,
    );
  }
  return formatTicketNumber(cfg, year, seq as number);
}
