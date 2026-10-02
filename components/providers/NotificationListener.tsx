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
//     same kind, the same resource and the same actor within the toast
//     provider's window — into one card with a count (`coalesceKey`, RT-11 /
//     OS-4). The actor is part of the event: ToastProvider's merge keeps the
//     first card's words, so without it Carol's sign-off on P-1 would merge
//     into Bob's and read "Bob signed off on P-1 ×2". Two people's acts on one
//     resource stay two cards; one person's repeat (Alice posting twice) is
//     one card that still shows the first row's words — the remainder of the
//     trade-off in DEC-44 (N3) item 4, handed to ToastProvider's next holder.
//   * A burst is summarized: at most BURST_SHOWN_MAX informational cards
//     per BURST_WINDOW_MS; the rest of that window's rows become one
//     "N more notifications" card when it closes (TAX-9 dw4 — two cards plus
//     one summary, not one summary alone). A repeat of an event already on
//     screen in the window joins its card (a count, no new card) and is not
//     held. Action rows are never folded into the summary.
//   * The member's "Pop-up toasts" switch (`toast_enabled`) is read through
//     `readToastPreference` — on mount, whenever the tab comes back, and
//     before any toast once the last read is older than PREF_FRESH_MS — and
//     fails open (RT-10 / DEC-74 §7): on an error, and on a read that has not
//     answered within PREF_READ_TIMEOUT_MS (a stalled request on plant Wi-Fi
//     with no route out must not silence every toast in the tab). A refresh
//     never waits on an older read, and a late answer never overwrites a
//     newer one. Bell rows are never affected.

import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { kindMeta } from "@/lib/notificationKinds";
import { readToastPreference } from "@/lib/notificationPrefs";
import { useRole } from "./RoleContext";
import { toastCoalesceKey, useToast, type ToastType } from "./ToastProvider";

/** The columns of a `notifications` INSERT the toast reads. */
export interface ListenedRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  resource_id?: string | null;
  /** Who did it — part of the event's key (two people's acts are two). */
  actor_user_id?: string | null;
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
/** A toast-preference read that has not answered by then fails open. */
export const PREF_READ_TIMEOUT_MS = 3000;
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
    // One card per event (RT-11 dw2 / OS-4 dw2): the same kind, resource
    // and actor. A different actor is a different event (the merged card
    // keeps the first row's words, so it would name the wrong person). A row
    // about no resource keeps the content key, so two unrelated messages
    // never merge.
    coalesceKey: row.resource_id ? `${row.kind}:${row.resource_id}:${row.actor_user_id ?? ""}` : undefined,
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
  // Bumped by every refresh: a read begun before it may still answer, but
  // never writes the cache a newer read owns.
  let generation = 0;
  const prefTimers = new Set<unknown>();
  let windowOpen = false;
  let shownInWindow = 0;
  // The events (coalesce keys) given a card in this window.
  const shownKeys = new Set<string>();
  let burstSeq = 0;
  let held: ListenedRow[] = [];
  let timer: unknown = null;
  let stopped = false;

  /** One read of the switch, failing open on an error and on a read that
   *  has not answered within PREF_READ_TIMEOUT_MS. */
  const readOnce = (): Promise<boolean> => new Promise<boolean>((resolve) => {
    let settled = false;
    let handle: unknown = null;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (handle !== null) { clearTimer(handle); prefTimers.delete(handle); }
      resolve(value);
    };
    handle = setTimer(() => settle(true), PREF_READ_TIMEOUT_MS);
    prefTimers.add(handle);
    let read: Promise<boolean>;
    try { read = deps.readPreference(); } catch { read = Promise.resolve(true); }
    read.then(settle, () => settle(true));
  });

  const ensurePreference = (): Promise<boolean> => {
    if (pref && now() - pref.at < PREF_FRESH_MS) return Promise.resolve(pref.value);
    if (pending) return pending;
    const gen = generation;
    const p: Promise<boolean> = readOnce().then((value) => {
      if (gen === generation) pref = { value, at: now() };
      if (pending === p) pending = null;
      return value;
    });
    pending = p;
    return p;
  };

  const flush = () => {
    timer = null;
    windowOpen = false;
    shownInWindow = 0;
    shownKeys.clear();
    const rows = held;
    held = [];
    if (stopped || rows.length === 0 || pref?.value === false) return;
    // Each summary is its own card: two windows' "3 more" never read as one
    // "3 more ×2".
    deps.show(rows.length === 1 ? toastForRow(rows[0]) : { ...burstSummary(rows.length), coalesceKey: `notification-burst:${++burstSeq}` });
  };

  const route = (row: ListenedRow) => {
    const spec = toastForRow(row);
    // An action is never folded into a summary, and never waits.
    if (isActionRow(row)) { deps.show(spec); return; }
    if (!windowOpen) {
      windowOpen = true;
      shownInWindow = 0;
      shownKeys.clear();
      timer = setTimer(flush, BURST_WINDOW_MS);
    }
    // A repeat of an event already given a card this window joins that card
    // (ToastProvider merges it into a count) — no new card, so it is not
    // held for the summary either.
    const key = toastCoalesceKey(spec);
    if (shownKeys.has(key)) { deps.show(spec); return; }
    if (shownInWindow < BURST_SHOWN_MAX) {
      shownInWindow++;
      shownKeys.add(key);
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
    /** Forget the cached preference and read it again (mount, tab return)
     *  — a fresh read, never the one still in flight. */
    refreshPreference() {
      generation++;
      pref = null;
      pending = null;
      void ensurePreference();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      held = [];
      for (const t of prefTimers) clearTimer(t);
      prefTimers.clear();
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
