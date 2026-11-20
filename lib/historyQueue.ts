// lib/historyQueue.ts
//
// History lines (the audit log and project activity) must not be lost when
// a write fails. A failed one is kept on this device and sent again: right
// away when the connection comes back, every few minutes, and on the next
// visit. Browser only; on the server a failure is still logged.

import { supabase } from "@/lib/supabase";

type Table = "audit_logs" | "project_activity";
type Item = { table: Table; row: Record<string, unknown>; at: number };
const KEY = "history-queue:v1";
const CAP = 300;

function read(): Item[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]") as Item[]; } catch { return []; }
}
function write(items: Item[]) {
  try { localStorage.setItem(KEY, JSON.stringify(items.slice(-CAP))); } catch { /* full or private mode */ }
}

/** Keep a history line that didn't save, to send again later. */
export function queueHistory(table: Table, row: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  write([...read(), { table, row, at: Date.now() }]);
}

let flushing = false;
/** Send every kept line, oldest first; stop at the first failure. */
export async function flushHistory(): Promise<number> {
  if (typeof window === "undefined" || flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    let items = read();
    while (items.length) {
      const [first, ...rest] = items;
      const { error } = await supabase.from(first.table).insert(first.row);
      if (error) break;
      items = rest; write(items); sent++;
    }
  } catch { /* offline: try again later */ }
  finally { flushing = false; }
  return sent;
}

/** How many lines are waiting to be sent. */
export function pendingHistory(): number {
  return typeof window === "undefined" ? 0 : read().length;
}
