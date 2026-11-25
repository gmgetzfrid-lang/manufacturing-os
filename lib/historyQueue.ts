// lib/historyQueue.ts
//
// History lines (the audit log and project activity) must not be lost when
// a write fails. A failed one is kept on this device and sent again: right
// away when the connection comes back, every few minutes, and on the next
// visit. Browser only; on the server a failure is still logged.

import { supabase } from "@/lib/supabase";

type Table = "audit_logs" | "project_activity";
type Item = { id?: string; table: Table; row: Record<string, unknown>; at: number };
const KEY = "history-queue:v1";
/** Lines the server turned down (a bad row): kept, never sent again, so
 *  one can't hold up the rest. */
const ASIDE_KEY = "history-queue:aside:v1";
const CAP = 300;

function read(key = KEY): Item[] {
  try { return JSON.parse(localStorage.getItem(key) || "[]") as Item[]; } catch { return []; }
}
function write(items: Item[], key = KEY) {
  try { localStorage.setItem(key, JSON.stringify(items.slice(-CAP))); } catch { /* full or private mode */ }
}
/** Each line's own id (lines kept before ids had one: what they say). */
const idOf = (i: Item) => i.id ?? `${i.table}:${i.at}:${JSON.stringify(i.row)}`;
const newId = () => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Keep a history line that didn't save, to send again later. */
export function queueHistory(table: Table, row: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  write([...read(), { id: newId(), table, row, at: Date.now() }]);
}

/** Take one line off the queue as it is now (a line queued meanwhile, here
 *  or in another tab, stays). */
function remove(id: string) {
  write(read().filter((i) => idOf(i) !== id));
}

/** A line the server turned down for what it says, not for being busy or
 *  for a sign-in that ran out (those are sent again). */
const turnedDown = (status: number) => status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;

async function sendAll(): Promise<number> {
  let sent = 0;
  const tried = new Set<string>();
  for (;;) {
    // Read again each time: never write back an old copy of the queue.
    const next = read().find((i) => !tried.has(idOf(i)));
    if (!next) break;
    const id = idOf(next);
    tried.add(id);
    const { error, status } = await supabase.from(next.table).insert(next.row);
    if (!error) { remove(id); sent++; continue; }
    if (turnedDown(status)) { write([...read(ASIDE_KEY), next], ASIDE_KEY); remove(id); continue; }
    // Offline or busy: the rest wait for the next try.
    break;
  }
  return sent;
}

type Locks = { request: (name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<number>) => Promise<number> };

let flushing = false;
/** Send every kept line, oldest first; stop at the first one that can't be
 *  sent now. One tab at a time, so two tabs never send the same lines. */
export async function flushHistory(): Promise<number> {
  if (typeof window === "undefined" || flushing) return 0;
  flushing = true;
  try {
    const locks = (navigator as unknown as { locks?: Locks }).locks;
    // Another tab is already sending: it sends these too.
    if (locks) return await locks.request("history-queue", { ifAvailable: true }, async (lock) => (lock ? sendAll() : 0));
    return await sendAll();
  } catch { /* offline: try again later */ return 0; }
  finally { flushing = false; }
}

/** How many lines are waiting to be sent. */
export function pendingHistory(): number {
  return typeof window === "undefined" ? 0 : read().length;
}
