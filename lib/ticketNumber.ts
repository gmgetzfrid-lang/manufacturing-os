// lib/ticketNumber.ts
//
// Human, collision-proof request numbers:  {ORG}-DDRT-{YY}-{NNNN}
// e.g. KE-DDRT-26-0001.
//
// The sequence comes from an ATOMIC per-(org, year) counter in the database
// (the next_ticket_number RPC), so two simultaneous submissions can never get
// the same number, and it resets each year. Prefix / record code / padding are
// per-org settings on the orgs row. Both request-creation paths (the new-request
// form and the document check-in "revision request") go through here.

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

export async function getTicketNumberConfig(orgId: string): Promise<TicketNumberConfig> {
  const { data } = await supabase
    .from("orgs")
    .select("ticket_prefix, ticket_record_code, ticket_number_pad")
    .eq("id", orgId)
    .maybeSingle();
  return {
    prefix: ((data?.ticket_prefix as string | null) ?? "").trim(),
    recordCode: (((data?.ticket_record_code as string | null) ?? "").trim()) || TICKET_NUMBER_DEFAULTS.recordCode,
    pad: (data?.ticket_number_pad as number | null) ?? TICKET_NUMBER_DEFAULTS.pad,
  };
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
