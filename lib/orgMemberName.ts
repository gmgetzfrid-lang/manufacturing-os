// lib/orgMemberName.ts — server-side "who did this" lookup.
//
// Audit rows carry a display name alongside the uid so history stays readable
// after someone leaves and their membership row is gone. One helper so every
// route spells the fallback (display name → email → null) the same way.

import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function memberDisplayName(orgId: string, uid: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("org_members").select("display_name, email")
    .eq("org_id", orgId).eq("uid", uid).maybeSingle();
  return (data?.display_name as string) || (data?.email as string) || null;
}
