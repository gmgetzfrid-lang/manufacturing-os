// lib/requestTypes.ts
//
// The org's configured request types (Admin → Requests → Request Types),
// read from org_configurations key "drafting" → requestTypes.options. One
// parser for every consumer — the workflow route, the ticket page, the
// permissions console and the simulator — so a type-level flag
// (`closeWithoutReview`, `engineeringFirst`) or a type-scoped capability
// rule (DEC-13) is keyed to the same `value` strings everywhere, and the
// ticket-insert trigger (20261038) validates against the same list.

import { supabase } from "@/lib/supabase";

export interface RequestTypeOption {
  value: string;
  label: string;
  closeWithoutReview?: boolean;
  engineeringFirst?: boolean;
}

type FlagKey = "closeWithoutReview" | "engineeringFirst";

/** The option list out of a raw `org_configurations.data` (key "drafting").
 *  Tolerates a missing / malformed shape (→ []) and numeric values. */
export function requestTypeOptionsFrom(cfgData: unknown): RequestTypeOption[] {
  const opts = (cfgData as { requestTypes?: { options?: unknown } } | null | undefined)?.requestTypes?.options;
  if (!Array.isArray(opts)) return [];
  const out: RequestTypeOption[] = [];
  for (const o of opts) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    const value = r.value === undefined || r.value === null ? "" : String(r.value);
    if (!value) continue;
    out.push({
      value,
      label: typeof r.label === "string" && r.label ? r.label : value,
      ...(r.closeWithoutReview === true ? { closeWithoutReview: true } : {}),
      ...(r.engineeringFirst === true ? { engineeringFirst: true } : {}),
    });
  }
  return out;
}

/** The `value`s of every option carrying `flag === true`. */
export function flaggedRequestTypes(cfgData: unknown, flag: FlagKey): string[] {
  return requestTypeOptionsFrom(cfgData).filter((o) => o[flag] === true).map((o) => o.value);
}

/** Load the org's request types. `client` lets server routes pass their own
 *  (service-role) client. Errors → [] (callers treat "no types" as "nothing
 *  type-specific is configured"). */
export async function loadRequestTypeOptions(
  orgId: string,
  client?: Pick<typeof supabase, "from">,
): Promise<RequestTypeOption[]> {
  try {
    const { data, error } = await (client ?? supabase)
      .from("org_configurations")
      .select("data")
      .eq("org_id", orgId)
      .eq("key", "drafting")
      .maybeSingle();
    if (error) return [];
    return requestTypeOptionsFrom(data?.data);
  } catch {
    return [];
  }
}
