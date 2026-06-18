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

// Grid geometry shared with the renderer.
export const GRID_COLS = 12;
export const MIN_W = 1;
export const MIN_H = 1;
export const MAX_H = 12;

const KNOWN_TYPES: WidgetType[] = [
  "commandDeck",
  "documentControl",
  "draftingRequests",
  "inbox",
  "dailyBrief",
  "quickLaunch",
  "attention",
  "suggestedActions",
  "outstanding",
  "projects",
  "activity",
  "equipment",
  "scratchpad",
  "adminUsers",
  "adminAnalytics",
  "adminAudit",
];

// Fallback default heights by type, used when migrating legacy widgets that
// only carried a `width` (no row-unit height). List-style widgets get taller
// defaults; banners/summaries stay short.
const DEFAULT_H_BY_TYPE: Record<WidgetType, number> = {
  commandDeck: 4,
  documentControl: 3,
  draftingRequests: 4,
  inbox: 4,
  dailyBrief: 3,
  quickLaunch: 4,
  attention: 6,
  suggestedActions: 4,
  outstanding: 6,
  projects: 4,
  activity: 4,
  equipment: 3,
  scratchpad: 2,
  adminUsers: 2,
  adminAnalytics: 2,
  adminAudit: 2,
};

/** Default layout for a brand-new user: a cockpit-grade home that feels alive
 *  out of the box. The Command Deck hero now leads as a first-class (bare)
 *  widget — same vibrant cockpit band, but customizable like everything else.
 *  Below it: a full-width Document Control banner, then a narrated Daily Brief
 *  beside a Quick Launch sidebar, the rich "Needs You" attention feed beside
 *  the Drafting Requests list, and the Suggested Actions + Outstanding work
 *  surfaces — so a fresh user lands on a full, motion-rich workspace rather
 *  than three lonely tiles. */
export function defaultDashboard(): DashboardConfig {
  return {
    version: 2,
    widgets: [
      { id: newWidgetId(), type: "commandDeck", w: 12, h: 4, settings: {} },
      { id: newWidgetId(), type: "documentControl", w: 12, h: 3, settings: {} },
      { id: newWidgetId(), type: "dailyBrief", w: 6, h: 3 },
      { id: newWidgetId(), type: "quickLaunch", w: 3, h: 5 },
      { id: newWidgetId(), type: "attention", w: 6, h: 6 },
      { id: newWidgetId(), type: "draftingRequests", w: 6, h: 4 },
      { id: newWidgetId(), type: "suggestedActions", w: 6, h: 4 },
      { id: newWidgetId(), type: "outstanding", w: 6, h: 6 },
    ],
  };
}

export function newWidgetId(): string {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Clamp a column span into [MIN_W, GRID_COLS]. */
export function clampW(w: number): number {
  if (!Number.isFinite(w)) return MIN_W;
  return Math.max(MIN_W, Math.min(GRID_COLS, Math.round(w)));
}

/** Clamp a row span into [MIN_H, MAX_H]. */
export function clampH(h: number): number {
  if (!Number.isFinite(h)) return MIN_H;
  return Math.max(MIN_H, Math.min(MAX_H, Math.round(h)));
}

/** Coerce arbitrary stored/parsed JSON into a safe DashboardConfig. Drops
 *  unknown widget types and malformed entries so a bad value never crashes
 *  the dashboard. Migrates legacy `{width}` widgets to the new `{w,h}` shape.
 *  Returns null if there's nothing usable. Never throws. Exported for tests. */
export function sanitizeDashboardConfig(raw: unknown): DashboardConfig | null {
  return sanitize(raw);
}

function sanitize(raw: unknown): DashboardConfig | null {
  try {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as { widgets?: unknown; version?: unknown };
    if (!Array.isArray(obj.widgets)) return null;
    const incomingVersion = typeof obj.version === "number" ? obj.version : 0;
    const seen = new Set<string>();
    const widgets: DashboardWidget[] = [];
    for (const w of obj.widgets) {
      if (!w || typeof w !== "object") continue;
      const cand = w as Record<string, unknown>;
      const type = cand.type as WidgetType | undefined;
      if (!type || !KNOWN_TYPES.includes(type)) continue;
      const id = typeof cand.id === "string" && cand.id ? cand.id : newWidgetId();
      if (seen.has(id)) continue;
      seen.add(id);

      // New shape carries numeric w/h. Legacy shape carried width "full"|"half"
      // and no height — map width → columns and default the height by type.
      let wCols: number;
      let hRows: number;
      if (typeof cand.w === "number" || typeof cand.h === "number") {
        wCols = clampW(typeof cand.w === "number" ? cand.w : 6);
        hRows = clampH(typeof cand.h === "number" ? cand.h : DEFAULT_H_BY_TYPE[type]);
      } else {
        wCols = cand.width === "full" ? 12 : 6;
        hRows = DEFAULT_H_BY_TYPE[type] ?? 3;
      }

      widgets.push({
        id,
        type,
        w: wCols,
        h: hRows,
        settings: cand.settings && typeof cand.settings === "object" ? (cand.settings as Record<string, unknown>) : {},
      });
    }

    // v1 → v2 upgrade: the Command Deck was a pinned masthead in v1 (no widget
    // could carry it). For any real v1 layout, promote it to a first-class
    // widget pinned at the top — exactly once. Once we persist at v2, a user
    // who removes the deck keeps it removed (we never re-inject at v2+).
    if (incomingVersion === 1 && widgets.length > 0 && !widgets.some((w) => w.type === "commandDeck")) {
      widgets.unshift({ id: newWidgetId(), type: "commandDeck", w: GRID_COLS, h: DEFAULT_H_BY_TYPE.commandDeck, settings: {} });
    }

    return { version: 2, widgets };
  } catch {
    return null;
  }
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
