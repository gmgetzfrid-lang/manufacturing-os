// Load / save the per-user dashboard layout.
//
// Persistence is layered so nothing breaks and it works before the DB
// migration is applied:
//   1. localStorage (instant, per-device) — always written.
//   2. users.dashboard_config (cross-device) — best-effort; ignored if the
//      column doesn't exist yet.
// Reads prefer the DB (cross-device truth), then fall back to localStorage,
// then the app default.

import { supabase } from "@/lib/supabase";
import type { DashboardConfig, DashboardWidget, WidgetType } from "./types";

const LS_PREFIX = "manufacturingos.dashboard.";

const KNOWN_TYPES: WidgetType[] = [
  "documentControl",
  "draftingRequests",
  "inbox",
  "projects",
  "activity",
  "equipment",
  "scratchpad",
  "adminUsers",
  "adminAnalytics",
  "adminAudit",
];

/** Default layout for a brand-new user: Document Control + Drafting Requests,
 *  with the personal inbox kept one tap away so nothing is lost. */
export function defaultDashboard(): DashboardConfig {
  return {
    version: 1,
    widgets: [
      { id: newWidgetId(), type: "documentControl", width: "full", settings: {} },
      { id: newWidgetId(), type: "draftingRequests", width: "half" },
      { id: newWidgetId(), type: "inbox", width: "half" },
    ],
  };
}

export function newWidgetId(): string {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Coerce arbitrary stored/parsed JSON into a safe DashboardConfig. Drops
 *  unknown widget types and malformed entries so a bad value never crashes
 *  the dashboard. Returns null if there's nothing usable. */
function sanitize(raw: unknown): DashboardConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { widgets?: unknown };
  if (!Array.isArray(obj.widgets)) return null;
  const seen = new Set<string>();
  const widgets: DashboardWidget[] = [];
  for (const w of obj.widgets) {
    if (!w || typeof w !== "object") continue;
    const cand = w as Partial<DashboardWidget>;
    if (!cand.type || !KNOWN_TYPES.includes(cand.type as WidgetType)) continue;
    const id = typeof cand.id === "string" && cand.id ? cand.id : newWidgetId();
    if (seen.has(id)) continue;
    seen.add(id);
    widgets.push({
      id,
      type: cand.type as WidgetType,
      width: cand.width === "full" ? "full" : "half",
      settings: cand.settings && typeof cand.settings === "object" ? cand.settings : {},
    });
  }
  return { version: 1, widgets };
}

function lsKey(uid: string) {
  return `${LS_PREFIX}${uid}`;
}

function readLocal(uid: string): DashboardConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(lsKey(uid));
    return raw ? sanitize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeLocal(uid: string, config: DashboardConfig) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(lsKey(uid), JSON.stringify(config));
  } catch {
    /* ignore */
  }
}

export async function loadDashboardConfig(uid: string): Promise<DashboardConfig> {
  // Prefer the DB so a user's layout follows them across devices.
  try {
    const { data, error } = await supabase
      .from("users")
      .select("dashboard_config")
      .eq("id", uid)
      .maybeSingle();
    if (!error && data) {
      const fromDb = sanitize((data as { dashboard_config?: unknown }).dashboard_config);
      if (fromDb && fromDb.widgets.length) {
        writeLocal(uid, fromDb); // keep local mirror fresh
        return fromDb;
      }
    }
  } catch {
    /* column may not exist yet, or offline — fall through */
  }

  const local = readLocal(uid);
  if (local && local.widgets.length) return local;

  return defaultDashboard();
}

export async function saveDashboardConfig(uid: string, config: DashboardConfig): Promise<void> {
  // Local first so the change is instant and durable even if the DB write
  // can't land (e.g. the column hasn't been migrated yet).
  writeLocal(uid, config);
  try {
    await supabase.from("users").upsert({
      id: uid,
      dashboard_config: config,
      updated_at: new Date().toISOString(),
    });
  } catch {
    /* best-effort — localStorage already has it */
  }
}
