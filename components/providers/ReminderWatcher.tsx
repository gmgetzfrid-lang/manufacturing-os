"use client";

// ReminderWatcher — fires precise scratchpad alarms while the app is open.
//
// A task's `task_meta.remindAt` ("remind me in 2 hours / at 3pm") previously
// had NO consumer: it was only tallied into the once-a-day push digest, so an
// afternoon alarm never actually interrupted anyone. This watcher is the
// missing half of "it doesn't let me forget": every minute (and whenever the
// tab regains focus) it scans the user's own open notes for elapsed alarms
// and fires each one ONCE — an in-app bell notification (kind
// "task_reminder", deep-linked to the scratchpad) plus a native OS
// notification when the browser permission is already granted.
//
// Dedupe is per (note, task, alarm-time) in localStorage, so a snooze (which
// writes a NEW remindAt) re-arms the alarm, while a re-render never re-fires
// the old one. The daily server push still covers the app-closed case.

import { useEffect, useRef } from "react";
import { useRole } from "@/components/providers/RoleContext";
import { listNotes, extractTasks, taskRemindAt, taskKeyFor, cleanTaskText } from "@/lib/notes";
import { notify } from "@/lib/inAppNotifications";

const CHECK_MS = 60_000;
const LS_KEY = "mfg.alarms.fired.v1";
const KEEP_LAST = 200;

export default function ReminderWatcher() {
  const { activeOrgId, uid } = useRole();
  const busy = useRef(false);

  useEffect(() => {
    if (!activeOrgId || !uid) return;

    const loadFired = (): string[] => {
      try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]") as string[]; } catch { return []; }
    };
    const saveFired = (arr: string[]) => {
      try { localStorage.setItem(LS_KEY, JSON.stringify(arr.slice(-KEEP_LAST))); } catch { /* private mode */ }
    };

    const check = async () => {
      if (busy.current) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      busy.current = true;
      try {
        const notes = await listNotes({ orgId: activeOrgId, actorUserId: uid, resolved: false, limit: 200 });
        const fired = loadFired();
        const firedSet = new Set(fired);
        const now = Date.now();
        for (const n of notes) {
          for (const t of extractTasks(n)) {
            if (t.completed) continue;
            const at = taskRemindAt(n.taskMeta, t.body);
            if (!at || Date.parse(at) > now) continue;
            const key = `${n.id}:${taskKeyFor(t.body)}:${at}`;
            if (firedSet.has(key)) continue;
            firedSet.add(key);
            fired.push(key);
            const text = cleanTaskText(t);
            await notify({
              orgId: activeOrgId,
              userId: uid,
              kind: "task_reminder",
              title: `⏰ ${text}`,
              body: "You asked to be reminded — it's time.",
              link: "/scratchpad",
              resourceType: "note",
              resourceId: n.id,
              actorName: "Scratchpad",
              metadata: { alarm: at },
            });
            try {
              if ("Notification" in window && Notification.permission === "granted") {
                new Notification("⏰ Reminder", { body: text, tag: key });
              }
            } catch { /* OS notification is a bonus, never a blocker */ }
          }
        }
        saveFired(fired);
      } catch { /* transient — next tick retries */ } finally {
        busy.current = false;
      }
    };

    void check();
    const id = window.setInterval(() => { void check(); }, CHECK_MS);
    const onVis = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [activeOrgId, uid]);

  return null;
}
