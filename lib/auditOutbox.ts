// lib/auditOutbox.ts — drafting-flow EVID-6 (admin-and-org package P13): the
// audit dead-letter outbox's WRITE side.
//
// lib/audit.ts logAuditAction calls deadLetterAuditRow when its insert is
// refused (or throws), so a lost audit row is kept somewhere durable that the
// maintenance cron drains and reports (lib/auditOutboxDrain.ts), instead of
// living only in a console line nobody reads.
//
//   * In the browser the row cannot be written where the insert was refused
//     (the same RLS would refuse it), so it goes to /api/audit/dead-letter,
//     which verifies the caller (an active member of the workspace, writing
//     about themself) and writes public.audit_dead_letters as the service
//     role (20261219).
//   * On the server the shared client is the service role wherever audit
//     rows are written for the cron and the request-scoped routes
//     (__setServerSupabaseClient / runWithServerClient), so the outbox row is
//     written directly. Anywhere else (an anon server client) RLS refuses it
//     and that is said in the log.
//
// Never throws; answers whether the row was kept. Before 20261219 is pasted
// the table is missing: the route answers 503 and the server write 42P01 —
// "not kept", today's path (the refusal is still returned and logged).

import { supabase } from "@/lib/supabase";

/** The audit row as logAuditAction meant to write it (the writer's word). */
export interface DeadLetterRow {
  action: string;
  resource_id: string;
  resource_type: string;
  org_id: string;
  user_id: string | null;
  user_email: string | null;
  user_role: string | null;
  details: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export const DEAD_LETTER_ROUTE = "/api/audit/dead-letter";
/** The route refuses a body larger than this (413). */
export const DEAD_LETTER_MAX_BODY = 256_000;
/** At most this many undrained dead letters per reporter per hour (429 past it). */
export const DEAD_LETTER_HOURLY_CAP = 200;
/** The browser waits at most this long for the dead-letter route. */
export const DEAD_LETTER_TIMEOUT_MS = 8_000;

export async function deadLetterAuditRow(row: DeadLetterRow, error: string): Promise<{ kept: boolean; why?: string }> {
  try {
    if (typeof window !== "undefined") {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) return { kept: false, why: "no signed-in session to verify" };
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), DEAD_LETTER_TIMEOUT_MS) : null;
      try {
        const res = await fetch(DEAD_LETTER_ROUTE, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ orgId: row.org_id, entry: row, error }),
          ...(ctrl ? { signal: ctrl.signal } : {}),
        });
        if (res.ok) return { kept: true };
        const body = await res.json().catch(() => null) as { error?: string } | null;
        return { kept: false, why: body?.error ?? `HTTP ${res.status}` };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    const { error: insertError } = await supabase.from("audit_dead_letters").insert({
      org_id: row.org_id,
      action: row.action,
      entry: { row, reporter: null },
      error: error.slice(0, 2000),
      source: "server",
      reported_by: null,
    });
    if (insertError) return { kept: false, why: insertError.message || "outbox insert refused" };
    return { kept: true };
  } catch (e) {
    return { kept: false, why: (e as Error)?.message ?? String(e) };
  }
}
