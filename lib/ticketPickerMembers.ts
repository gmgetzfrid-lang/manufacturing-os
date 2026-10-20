// lib/ticketPickerMembers.ts
//
// drafting-flow Round G, DF-P9 TICKET-PAGE — EDGE-6 / ROUTE-8 (integrator
// fix pass, DEC-90): the drafter picker's member read, PAGED.
//
// The picker offers every active member whose role collection the policy
// lets do drafting work (lib/ticketPage.ts drafterCandidates), so it must
// read EVERY active member — the old `.eq('role', 'Drafter')` filter is gone
// (it hid a member holding Drafter beside a higher-ranked role). A single
// unordered read stops at PostgREST's max-rows (1000 by default, set per
// project), and the members past it vanished from the picker without a word,
// though the workflow route accepts them.
//
// So the read is keyset-paged on `uid` (UNIQUE (org_id, uid), NOT NULL):
// each page asks for the members after the last uid it received, so a page
// the server shortened to its own max-rows never skips anyone, whatever that
// limit is. The first page carries an exact count; the read stops once it
// holds that many, or at the first page that adds nobody new (the end). A
// failed page fails the whole read — the picker then says the list could not
// be read, never shows a partial list as if it were whole.
//
// Read only; the caller reads as the signed-in member (RLS decides).

import { supabase } from "@/lib/supabase";

/** Rows asked for per page. A server whose max-rows is lower returns fewer;
 *  the keyset carries on from the last row it did return. */
export const PICKER_MEMBER_PAGE = 1000;

/** The columns the picker needs (lib/ticketPage.ts MemberPickRow). */
export const PICKER_MEMBER_COLUMNS = "uid, email, role, roles, display_name";

type Client = Pick<typeof supabase, "from">;

export type PickerMembersResult =
  | { ok: true; rows: Array<Record<string, unknown>> }
  | { ok: false; error: string };

/** Every ACTIVE member of `orgId` with the picker's columns, in uid order. */
export async function loadPickerMembers(orgId: string, client: Client = supabase): Promise<PickerMembersResult> {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let last: string | null = null;
  let total: number | null = null;
  try {
    for (;;) {
      let q = client
        .from("org_members")
        .select(PICKER_MEMBER_COLUMNS, last === null ? { count: "exact" } : undefined)
        .eq("org_id", orgId)
        .eq("status", "active");
      if (last !== null) q = q.gt("uid", last);
      const { data, error, count } = await q.order("uid", { ascending: true }).limit(PICKER_MEMBER_PAGE);
      if (error) return { ok: false, error: error.message || "the members list could not be read" };
      if (last === null && typeof count === "number") total = count;
      const page = (data ?? []) as Array<Record<string, unknown>>;
      let added = 0;
      for (const r of page) {
        const uid = typeof r.uid === "string" ? r.uid : "";
        // Each member once: a server that ignored the keyset cannot loop the
        // read or duplicate anyone.
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        rows.push(r);
        added++;
      }
      if (added === 0) break;
      if (total !== null && rows.length >= total) break;
      const tail = page[page.length - 1]?.uid;
      if (typeof tail !== "string" || !tail) break;
      last = tail;
    }
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || "the members list could not be read" };
  }
}
