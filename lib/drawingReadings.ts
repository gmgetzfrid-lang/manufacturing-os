// drawingReadings - what the drawing reader found on the sheets, fetched
// for the browser from /api/drawings/readings (the table behind it is
// server-only, and the route keeps to drawings the person can open).

import { supabase } from "@/lib/supabase";

/** One thing the reader found on a sheet's page: a tag, an instrument, or
 *  an off-page reference ("xref"). `documentId` is the drawing's. */
export interface SheetReading { documentId: string; page: number; kind: string; tag: string; raw: string | null }

/** Every reading on the drawings this person can open; with `id`, only the
 *  places a sheet prints that equipment ID. */
export async function fetchReadings(orgId: string, id?: string): Promise<SheetReading[]> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Sign in again.");
  const q = new URLSearchParams({ orgId, ...(id ? { id } : {}) });
  const res = await fetch(`/api/drawings/readings?${q}`, { headers: { authorization: `Bearer ${session.access_token}` } });
  const body = (await res.json().catch(() => null)) as { readings?: SheetReading[]; error?: string } | null;
  if (!res.ok || !body?.readings) throw new Error(body?.error ?? `The server answered ${res.status}.`);
  return body.readings;
}
