// lib/signinPolicyClient.ts — reading and saving a workspace's sign-in
// rules from the browser (an admin, under RLS). See lib/signinPolicy.

import { supabase } from "@/lib/supabase";
import { normalizePolicy, SIGNIN_KEY, type SigninPolicy } from "@/lib/signinPolicy";

export async function loadSigninPolicy(orgId: string): Promise<SigninPolicy> {
  const { data } = await supabase.from("org_configurations").select("data").eq("org_id", orgId).eq("key", SIGNIN_KEY).maybeSingle();
  return normalizePolicy((data as { data?: unknown } | null)?.data ?? null);
}

export async function saveSigninPolicy(orgId: string, policy: SigninPolicy): Promise<void> {
  const { error } = await supabase.from("org_configurations").upsert(
    { org_id: orgId, key: SIGNIN_KEY, data: normalizePolicy(policy), updated_at: new Date().toISOString() },
    { onConflict: "org_id,key" },
  );
  if (error) throw error;
}
