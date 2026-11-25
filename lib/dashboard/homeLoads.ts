// lib/dashboard/homeLoads.ts - the loads Home shows, in one place, so the
// screen and the sign-in page start the very same ones.
//
// Sign-in knows the account (and soon the workspace) before Home opens: it
// starts these (warmHome) while the server checks the sign-in, and Home
// picks them up instead of asking again (lib/warmLoads). Home opened again
// shows the last answers at once and loads afresh behind them. Every key
// names the workspace and the account: a load is never shown to another.

import { supabase } from "@/lib/supabase";
import { sharedLoad } from "@/lib/warmLoads";
import { dashKey, inboxKey } from "@/lib/warmLoads";
import type { Role } from "@/types/schema";

// ─── The setup checklist's counts (admins) ─────────────────────────
export interface SetupCounts { libs: number; members: number; assets: number; tickets: number; plots: number }
export const setupCountsKey = (orgId: string, uid: string | null) => `setup:${orgId}|${uid ?? ""}`;
export async function loadSetupCounts(orgId: string): Promise<SetupCounts> {
  const countOf = async (table: string) => {
    const { count } = await supabase.from(table).select("id", { count: "exact", head: true }).eq("org_id", orgId);
    return count ?? 0;
  };
  const [libs, members, assets, tickets, plots] = await Promise.all([
    countOf("libraries"), countOf("org_members"), countOf("assets"), countOf("tickets"), countOf("plot_plans"),
  ]).catch(() => [0, 0, 0, 0, 0]);
  return { libs, members, assets, tickets, plots };
}

// ─── The "Needs you" deck's three tool counts ──────────────────────
export interface DeckPillars { openRequests: number; lockedDocs: number; activeProjects: number }
export const deckPillarsKey = (orgId: string, uid: string | null) => `pillars:${orgId}|${uid ?? ""}`;
export async function loadDeckPillars(orgId: string): Promise<DeckPillars> {
  // Independent + best-effort: a missing table/column degrades that one
  // stat to 0, never blanks the deck.
  const head = async (build: () => Promise<{ count: number | null }>) => {
    try { return (await build()).count ?? 0; } catch { return 0; }
  };
  const [openRequests, lockedDocs, activeProjects] = await Promise.all([
    head(() => supabase.from("tickets").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).not("status", "in", '("CLOSED","CANCELED")') as unknown as Promise<{ count: number | null }>),
    head(() => supabase.from("documents").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).not("checked_out_by", "is", null) as unknown as Promise<{ count: number | null }>),
    head(() => supabase.from("projects").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("status", "active") as unknown as Promise<{ count: number | null }>),
  ]);
  return { openRequests, lockedDocs, activeProjects };
}

// ─── Start Home's loads (sign-in) ──────────────────────────────────
export interface HomeWho { uid: string; orgId: string; roles: Role[]; email?: string | null; isAdmin: boolean }

/** The loads that need only the account and the workspace (not the
 *  account's roles there): the layout, the deck and the widgets. Sign-in
 *  starts these the moment the password is accepted when this device
 *  knows its workspace, alongside the server's check; they are only ever
 *  shown in that workspace, once the server says the account is in it. */
export async function warmHomeOrg(who: { uid: string; orgId: string; email?: string | null }): Promise<Promise<unknown>[]> {
  const { uid, orgId, email } = who;
  const [{ loadDashboardConfig }, { loadInbox }, widgets] = await Promise.all([
    import("@/lib/dashboard/config"),
    import("@/lib/inbox"),
    import("@/lib/dashboard/widgetLoads"),
  ]);
  const config = sharedLoad(dashKey(uid), () => loadDashboardConfig(uid));
  // The widgets the layout holds, and the libraries and projects under them.
  void config.then((cfg) => widgets.warmWidgets(cfg.widgets.map((w) => w.type), orgId, uid), () => undefined);
  return [
    config,
    sharedLoad(inboxKey(orgId, uid), () => loadInbox(orgId, uid, email ?? undefined)),
    sharedLoad(deckPillarsKey(orgId, uid), () => loadDeckPillars(orgId)),
  ];
}

/** Start the loads Home's first screen shows, for this account in this
 *  workspace; resolves when they have all answered (or failed). The
 *  widgets below come in as their own loads finish. */
export async function warmHome(who: HomeWho): Promise<void> {
  const { uid, orgId, roles, isAdmin } = who;
  const [{ attentionKey, loadAttention }, org] = await Promise.all([
    import("@/hooks/useTicketNotifications"),
    warmHomeOrg(who),
  ]);
  const first: Promise<unknown>[] = [
    ...org,
    sharedLoad(attentionKey(orgId, uid, roles), () => loadAttention(orgId, uid, roles)),
    ...(isAdmin ? [sharedLoad(setupCountsKey(orgId, uid), () => loadSetupCounts(orgId))] : []),
  ];
  await Promise.allSettled(first);
}
