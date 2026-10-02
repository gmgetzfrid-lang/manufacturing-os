"use client";

// NotificationListener — the toast that echoes a new bell row.
//
// notifications Round G, N3 SURFACES. One source, one toast per event:
//
//   * It listens to ONE channel: INSERTs on `notifications` addressed to this
//     member (`user_id=eq.<uid>`). The org-wide `checkout_messages` channel is
//     gone (RT-2 / TAX-4 / TAX-3 dw4): it toasted every checkout-thread post
//     in the workspace to every signed-in member — whatever their access to
//     the document — and a participant got it twice, once per channel. The
//     post's durable `checkout_message` row (lib/activityThread.ts
//     notifyCheckoutActivity) already reaches each participant, session
//     holder and watcher, and is what toasts now. Its first-run seed and
//     unbounded id set went with it (RT-5).
//   * The tone comes from the kind registry (lib/notificationKinds.ts
//     KIND_META): an action-required kind is never a blue info toast — it
//     is amber and stays until dismissed, its bell row being the durable
//     trace (TAX-3 dw1 / dw3; the plan's default, DEC-44 (N3)). A hold
//     placed keeps the amber it always had.
//   * A notification row coalesces with another about the same event — the
//     same kind and resource within the toast provider's window — into one
//     card with a count (`coalesceKey`, RT-11 / OS-4). The card keeps the
//     first row's words (ToastProvider's merge), so two people posting on one
//     document read as the first author "×2" until that merge shows the newest
//     words — a trade-off recorded in DEC-44 (N3) item 4 and handed to
//     ToastProvider's next holder.
//   * A burst is one summary: at most BURST_SHOWN_MAX informational toasts
//     per BURST_WINDOW_MS; the rest of that window's rows become one
//     "N more notifications" card when it closes (TAX-9 dw4). Action rows
//     are never folded into it.
//   * The member's "Pop-up toasts" switch (`toast_enabled`) is read through
//     `readToastPreference` — on mount, whenever the tab comes back, and
//     before any toast once the last read is older than PREF_FRESH_MS — and
//     fails open (RT-10 / DEC-74 §7). Bell rows are never affected.

import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { kindMeta } from "@/lib/notificationKinds";
import { readToastPreference } from "@/lib/notificationPrefs";
import { useRole } from "./RoleContext";
import { useToast, type ToastType } from "./ToastProvider";

/** The columns of a `notifications` INSERT the toast reads. */
export interface ListenedRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  resource_id?: string | null;
}

export interface ToastSpec {
  type: ToastType;
  title: string;
  message: string;
  duration: number;
  coalesceKey?: string;
}

/** An informational notification toast's time on screen (as before). */
export const NOTIFICATION_TOAST_MS = 6000;
/** A burst: rows arriving within this window of the first. */
export const BURST_WINDOW_MS = 6000;
/** Informational toasts shown one by one per window; the rest are summed. */
export const BURST_SHOWN_MAX = 2;
/** A toast-preference read younger than this is reused. */
export const PREF_FRESH_MS = 5000;
/** The newest row ids remembered against a duplicate delivery. */
export const SEEN_IDS_MAX = 500;

/** Whether a row's kind needs the member to act (KIND_META); a legacy kind
 *  no union declares is FYI. */
export function isActionRow(row: Pick<ListenedRow, "kind">): boolean {
  return kindMeta(row.kind)?.actionRequired ?? false;
}

/** The toast for one notification row. */
export function toastForRow(row: ListenedRow): ToastSpec {
  const action = isActionRow(row);
  return {
    // Action-required → amber, never the blue info card (TAX-3 dw1); a hold
    // placed kept its amber warning before the registry and keeps it.
    type: action || row.kind === "hold_opened" ? "warning" : "info",
    title: row.title,
    message: row.body ?? "",
    // Action-required stays until dismissed (TAX-3 dw3): 0 = no timer.
    duration: action ? 0 : NOTIFICATION_TOAST_MS,
    // One card per event (RT-11 dw2 / OS-4 dw2). A row about no resource
    // keeps the content key, so two unrelated messages never merge.
    coalesceKey: row.resource_id ? `${row.kind}:${row.resource_id}` : undefined,
  };
}

/** The one card a burst's remainder becomes. */
export function burstSummary(n: number): ToastSpec {
  return {
    type: "info",
    title: `${n} more notification${n === 1 ? "" : "s"}`,
    message: "They arrived together — the bell lists every one.",
    duration: NOTIFICATION_TOAST_MS,
  };
}

export interface ToasterDeps {
  show: (t: ToastSpec) => void;
  /** The member's pop-up switch; fails open (readToastPreference). */
  readPreference: () => Promise<boolean>;
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** The listener's decisions — preference, dedupe, burst — without React or
 *  the socket, so they can be driven directly. */
export function createNotificationToaster(deps: ToasterDeps) {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  let pref: { value: boolean; at: number } | null = null;
  let pending: Promise<boolean> | null = null;
  let windowOpen = false;
  let shownInWindow = 0;
  let held: ListenedRow[] = [];
  let timer: unknown = null;
  let stopped = false;

  const ensurePreference = (): Promise<boolean> => {
    if (pref && now() - pref.at < PREF_FRESH_MS) return Promise.resolve(pref.value);
    if (!pending) {
      pending = deps.readPreference()
        .catch(() => true)
        .then((value) => {
          pref = { value, at: now() };
          pending = null;
          return value;
        });
    }
    return pending;
  };

  const flush = () => {
    timer = null;
    windowOpen = false;
    shownInWindow = 0;
    const rows = held;
    held = [];
    if (stopped || rows.length === 0 || pref?.value === false) return;
    deps.show(rows.length === 1 ? toastForRow(rows[0]) : burstSummary(rows.length));
  };

  const route = (row: ListenedRow) => {
    const spec = toastForRow(row);
    // An action is never folded into a summary, and never waits.
    if (isActionRow(row)) { deps.show(spec); return; }
    if (!windowOpen) {
      windowOpen = true;
      shownInWindow = 0;
      timer = setTimer(flush, BURST_WINDOW_MS);
    }
    if (shownInWindow < BURST_SHOWN_MAX) {
      shownInWindow++;
      deps.show(spec);
      return;
    }
    held.push(row);
  };

  return {
    /** A `notifications` INSERT for this member. */
    receive(row: ListenedRow | null | undefined) {
      if (stopped || !row || !row.id || seen.has(row.id)) return;
      seen.add(row.id);
      seenOrder.push(row.id);
      if (seenOrder.length > SEEN_IDS_MAX) seen.delete(seenOrder.shift()!);
      void ensurePreference().then((enabled) => {
        if (!stopped && enabled) route(row);
      });
    },
    /** Forget the cached preference and read it again (mount, tab return). */
    refreshPreference() {
      pref = null;
      void ensurePreference();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      held = [];
    },
  };
}

export function NotificationListener() {
  const { activeOrgId, userEmail, uid } = useRole();
  const { showToast } = useToast();

  useEffect(() => {
    if (!activeOrgId || !userEmail || !uid) return;

    const toaster = createNotificationToaster({
      show: (t) => showToast(t),
      readPreference: () => readToastPreference(uid),
    });
    // The pop-up switch: read now, and again whenever the tab comes back
    // (the settings page is one tab away).
    toaster.refreshPreference();
    const onReturn = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") toaster.refreshPreference();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);

    // Scoped to the recipient (uid): only this member's own inbox events.
    const channel = supabase
      .channel(`notifs-listener-${uid}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${uid}` },
        (payload) => toaster.receive(payload.new as ListenedRow),
      )
      .subscribe();

    return () => {
      toaster.stop();
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
      supabase.removeChannel(channel);
    };
  }, [activeOrgId, userEmail, uid, showToast]);

  return null;
}
