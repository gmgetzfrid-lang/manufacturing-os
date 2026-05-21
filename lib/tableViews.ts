// lib/tableViews.ts
// Table View configuration (dynamic table headers / column sets)
// - Supports per-user views + org-wide defaults
// - Deterministic doc ids (no queries needed)
// - Safe defaults + merge behavior
// - Adds: realtime listeners + delete helper (without changing existing behavior)

import {
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Timestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { TableViewConfig, ViewColumn } from "@/types/schema";

const TABLE_VIEWS = "tableViews";

// -----------------------------
// ID + helpers
// -----------------------------
type ViewScope = "user" | "org";

function safePart(v?: string | null) {
  const s = (v ?? "").trim();
  return s.length ? s.replaceAll("/", "_") : "none";
}

/**
 * Deterministic doc id so we never need compound queries/indexes.
 * Examples:
 * - user scope:  tv_user_org123_uidABC_lib9_col7
 * - org scope:   tv_org_org123_org_lib9_col7
 */
export function tableViewId(params: {
  scope: ViewScope;
  orgId?: string;
  ownerUserId?: string; // required for scope=user
  libraryId?: string;
  collectionId?: string;
}) {
  const orgId = safePart(params.orgId);
  const libraryId = safePart(params.libraryId);
  const collectionId = safePart(params.collectionId);

  if (params.scope === "user") {
    const uid = safePart(params.ownerUserId);
    return `tv_user_${orgId}_${uid}_${libraryId}_${collectionId}`;
  }
  return `tv_org_${orgId}_org_${libraryId}_${collectionId}`;
}

/**
 * Built-in columns (stable keys used across the UI).
 * You can add more later (sheetNumber, setId, etc).
 */
export const BUILTIN_COLUMNS: { key: string; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "documentNumber", label: "Doc No." },
  { key: "rev", label: "Rev" },
  { key: "status", label: "Status" },
  { key: "updatedAt", label: "Updated" },
];

// -----------------------------
// Defaults
// -----------------------------

/**
 * Default columns when a view isn't configured yet.
 * Includes built-ins + visible custom columns (library/folder config).
 */
export function defaultColumnsFromSchema(opts?: {
  customColumns?: ViewColumn[];
  overrides?: ViewColumn[];
}) {
  const builtins = BUILTIN_COLUMNS.map((c) => c.key);

  const columns: string[] = [...builtins];

  // folder overrides win, otherwise library customColumns
  const dynamic =
    (opts?.overrides?.length ? opts.overrides : opts?.customColumns) ?? [];

  for (const c of dynamic) {
    if (!c?.key) continue;
    // include if visible by default
    if (c.visible !== false) columns.push(c.key);
  }

  // de-dupe
  return Array.from(new Set(columns));
}

/**
 * Merge new defaults into an existing column list without destroying user customization:
 * - Keep the user's order
 * - Append any newly introduced columns at the end
 * - Optionally remove columns that no longer exist (we default to NOT removing)
 */
export function mergeColumnsPreserveUserOrder(
  existing: string[],
  defaults: string[],
  opts?: { removeUnknown?: boolean }
) {
  const removeUnknown = opts?.removeUnknown ?? false;

  const existingSet = new Set(existing);
  const defaultsSet = new Set(defaults);

  let next = existing.slice();

  // Append any defaults missing from user config
  for (const d of defaults) {
    if (!existingSet.has(d)) next.push(d);
  }

  // Optionally remove unknown columns (dangerous; off by default)
  if (removeUnknown) {
    next = next.filter((k) => defaultsSet.has(k));
  }

  // De-dupe again (just in case)
  return Array.from(new Set(next));
}

// -----------------------------
// Firestore I/O
// -----------------------------

export async function getTableView(params: {
  scope: ViewScope;
  orgId?: string;
  ownerUserId?: string;
  libraryId?: string;
  collectionId?: string;
}) {
  const id = tableViewId(params);
  const ref = doc(db, TABLE_VIEWS, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return { id: snap.id, ...(snap.data() as Record<string, unknown>) } as TableViewConfig;
}

export async function saveTableView(params: {
  scope: ViewScope;
  orgId?: string;
  ownerUserId?: string; // required for scope=user
  name?: string;
  libraryId?: string;
  collectionId?: string;
  columns: string[];
  columnConfig?: TableViewConfig["columnConfig"];
}) {
  const id = tableViewId(params);
  const ref = doc(db, TABLE_VIEWS, id);

  const now = serverTimestamp();

  // Keep shape consistent with schema.ts
  const payload: Partial<TableViewConfig> = {
    id,
    orgId: params.orgId,
    ownerUserId: params.scope === "user" ? params.ownerUserId : undefined,
    name: params.name ?? (params.scope === "user" ? "My View" : "Org Default View"),
    libraryId: params.libraryId,
    collectionId: params.collectionId,
    columns: params.columns,
    columnConfig: params.columnConfig ?? {},
    updatedAt: now as unknown as Timestamp,
  };

  // createdAt only set once (merge keeps it if already exists)
  await setDoc(
    ref,
    {
      ...payload,
      createdAt: now,
    } as Record<string, unknown>,
    { merge: true }
  );

  return id;
}

/**
 * Resolve effective view:
 * 1) per-user view (if scope=user exists)
 * 2) org default view (scope=org)
 * 3) fallback to defaults passed in
 */
export async function resolveEffectiveColumns(params: {
  orgId?: string;
  ownerUserId?: string;
  libraryId?: string;
  collectionId?: string;
  defaultColumns: string[];
}) {
  // 1) user view
  if (params.ownerUserId) {
    const userView = await getTableView({
      scope: "user",
      orgId: params.orgId,
      ownerUserId: params.ownerUserId,
      libraryId: params.libraryId,
      collectionId: params.collectionId,
    });
    if (userView?.columns?.length) return userView.columns;
  }

  // 2) org view
  const orgView = await getTableView({
    scope: "org",
    orgId: params.orgId,
    libraryId: params.libraryId,
    collectionId: params.collectionId,
  });
  if (orgView?.columns?.length) return orgView.columns;

  // 3) fallback
  return params.defaultColumns;
}

// -----------------------------
// Added helpers (safe additions)
// -----------------------------

export async function deleteTableView(params: {
  scope: ViewScope;
  orgId?: string;
  ownerUserId?: string;
  libraryId?: string;
  collectionId?: string;
}) {
  const id = tableViewId(params);
  await deleteDoc(doc(db, TABLE_VIEWS, id));
}

/**
 * Realtime listener for a single deterministic table view doc.
 * No queries, no indexes needed.
 */
export function listenTableView(
  params: {
    scope: ViewScope;
    orgId?: string;
    ownerUserId?: string;
    libraryId?: string;
    collectionId?: string;
  },
  cb: (view: TableViewConfig | null) => void
) {
  const id = tableViewId(params);
  const ref = doc(db, TABLE_VIEWS, id);

  return onSnapshot(ref, (snap) => {
    if (!snap.exists()) return cb(null);
    cb({ id: snap.id, ...(snap.data() as Record<string, unknown>) } as TableViewConfig);
  }, (err) => {
    console.error("listenTableView error:", err);
    cb(null);
  });
}

/**
 * Realtime effective columns:
 * - user view wins (if exists)
 * - else org view
 * - else defaults
 *
 * This avoids list queries entirely.
 */
export function listenEffectiveColumns(
  params: {
    orgId?: string;
    ownerUserId?: string;
    libraryId?: string;
    collectionId?: string;
    defaultColumns: string[];
  },
  cb: (result: {
    scopeUsed: "user" | "org" | "default";
    columns: string[];
    userView: TableViewConfig | null;
    orgView: TableViewConfig | null;
  }) => void
) {
  let userView: TableViewConfig | null = null;
  let orgView: TableViewConfig | null = null;

  const emit = () => {
    if (params.ownerUserId && userView?.columns?.length) {
      cb({ scopeUsed: "user", columns: userView.columns, userView, orgView });
      return;
    }
    if (orgView?.columns?.length) {
      cb({ scopeUsed: "org", columns: orgView.columns, userView, orgView });
      return;
    }
    cb({
      scopeUsed: "default",
      columns: params.defaultColumns,
      userView,
      orgView,
    });
  };

  const unsubs: Array<() => void> = [];

  // org view listener
  unsubs.push(
    listenTableView(
      {
        scope: "org",
        orgId: params.orgId,
        libraryId: params.libraryId,
        collectionId: params.collectionId,
      },
      (v) => {
        orgView = v;
        emit();
      }
    )
  );

  // user view listener (optional)
  if (params.ownerUserId) {
    unsubs.push(
      listenTableView(
        {
          scope: "user",
          orgId: params.orgId,
          ownerUserId: params.ownerUserId,
          libraryId: params.libraryId,
          collectionId: params.collectionId,
        },
        (v) => {
          userView = v;
          emit();
        }
      )
    );
  }

  // initial emit (in case snapshots are slow)
  emit();

  return () => {
    for (const u of unsubs) u();
  };
}
