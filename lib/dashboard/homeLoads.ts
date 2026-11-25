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
/** The checklist only asks "none, one or more?": each count reads at most
 *  two rows (capped at 2) instead of counting a whole table. A count that
 *  fails REJECTS: a busy database must not read as an empty workspace (an
 *  established one was shown "Set up your workspace"). The checklist then
 *  keeps its last answer, or stays hidden. A table that doesn't exist yet
 *  (an older database) is still 0. */
export async function loadSetupCounts(orgId: string): Promise<SetupCounts> {
  const countOf = async (table: string) => {
    const { data, error } = await supabase.from(table).select("id").eq("org_id", orgId).limit(2);
    if (error) {
      if (isMissingTable(error)) return 0;
      throw new Error(`Couldn't count ${table}: ${error.message}`);
    }
    return (data ?? []).length;
  };
  const [libs, members, assets, tickets, plots] = await Promise.all([
    countOf("libraries"), countOf("org_members"), countOf("assets"), countOf("tickets"), countOf("plot_plans"),
  ]);
  return { libs, members, assets, tickets, plots };
}

/** The table isn't in this database (yet): a real zero, not a failure. */
function isMissingTable(e: { code?: string; message?: string }): boolean {
  return e.code === "42P01" || e.code === "PGRST205" || /does not exist|could not find the table/i.test(e.message ?? "");
}

// ─── The "Needs you" deck's three tool counts ──────────────────────
export interface DeckPillars { openRequests: number; lockedDocs: number; activeProjects: number }
export const deckPillarsKey = (orgId: string, uid: string | null) => `pillars:${orgId}|${uid ?? ""}`;
export async function loadDeckPillars(orgId: string): Promise<DeckPillars> {
  // A missing table (an older database: the count comes back empty, with no
  // error) degrades that one stat to 0. A count that FAILED is unknown, not
  // zero: the load rejects, and the deck keeps its last numbers or shows "-"
  // (it used to say "0 open requests" whenever the database was busy).
  // "estimated": exact for small numbers, the planner's figure for big
  // ones, without counting every row.
  const head = async (build: () => PromiseLike<{ count: number | null; error: unknown }>) => {
    const r = await build();
    if (r.error) throw new Error("A count on Home couldn't be read.");
    return r.count ?? 0;
  };
  const [openRequests, lockedDocs, activeProjects] = await Promise.all([
    head(() => supabase.from("tickets").select("id", { count: "estimated", head: true })
      .eq("org_id", orgId).not("status", "in", '("CLOSED","CANCELED")')),
    head(() => supabase.from("documents").select("id", { count: "estimated", head: true })
      .eq("org_id", orgId).not("checked_out_by", "is", null)),
    head(() => supabase.from("projects").select("id", { count: "estimated", head: true })
      .eq("org_id", orgId).eq("status", "active")),
  ]);
  return { openRequests, lockedDocs, activeProjects };
}

// ─── Start Home's loads (sign-in) ──────────────────────────────────
export interface HomeWho { uid: string; orgId: string; roles: Role[]; email?: string | null; isAdmin: boolean }

/** The loads that need only the account and the workspace (not the
 *  account's roles there): the layout, the deck and the widgets. Sign-in
 *  starts these the moment the password is accepted when this device
 *  knows its workspace, alongside the server's check; they are only ever
 *  shown in that workspace, once the server says the account is in it.
 *  `header`: the loads the top of Home shows, one round trip each;
 *  `deck`: what's waiting on you (it looks up a few details after). */
export async function warmHomeOrg(who: { uid: string; orgId: string; email?: string | null }): Promise<{ header: Promise<unknown>[]; deck: Promise<unknown>; startWidgets: () => void }> {
  const { uid, orgId, email } = who;
  const [{ loadDashboardConfig }, { loadInbox }, widgets] = await Promise.all([
    import("@/lib/dashboard/config"),
    import("@/lib/inbox"),
    import("@/lib/dashboard/widgetLoads"),
  ]);
  const config = sharedLoad(dashKey(uid), () => loadDashboardConfig(uid));
  const header = [config, sharedLoad(deckPillarsKey(orgId, uid), () => loadDeckPillars(orgId))];
  const deck = sharedLoad(inboxKey(orgId, uid), () => loadInbox(orgId, uid, email ?? undefined));
  // The widgets the layout holds, and the libraries and projects under
  // them, come after what the first screen shows: dozens of counts asked
  // at once would hold up the answers needed first.
  let started = false;
  const startWidgets = () => {
    if (started) return;
    started = true;
    void config.then((cfg) => widgets.warmWidgets(cfg.widgets.map((w) => w.type), orgId, uid), () => undefined);
  };
  return { header, deck, startWidgets };
}

/** Start Home's loads for this account in this workspace. Resolves when
 *  the top of Home can be drawn (what needs you, the layout, the setup
 *  list, the deck's counts): one round trip. What waits on you in the deck
 *  and the widgets below come in as their own loads finish. */
export async function warmHome(who: HomeWho): Promise<void> {
  const { uid, orgId, roles, isAdmin } = who;
  const [{ attentionKey, loadAttention }, org] = await Promise.all([
    import("@/hooks/useTicketNotifications"),
    warmHomeOrg(who),
  ]);
  const header: Promise<unknown>[] = [
    ...org.header,
    sharedLoad(attentionKey(orgId, uid, roles), () => loadAttention(orgId, uid, roles)),
    ...(isAdmin ? [sharedLoad(setupCountsKey(orgId, uid), () => loadSetupCounts(orgId))] : []),
  ];
  await Promise.allSettled(header);
  org.startWidgets();
}
