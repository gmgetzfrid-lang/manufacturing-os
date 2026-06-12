"use client";

// ScratchpadStrip — the scratchpad's seat on Home/Inbox.
//
// Integration, not relocation: live overdue/today counts, your most
// urgent task, and a jot box that files straight into the scratchpad
// without leaving Home. The full cockpit stays at /scratchpad.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { StickyNote, Flame, Sun, ArrowRight, Check, Loader2 } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { getDailyBrief, createNote, type DailyBrief } from "@/lib/notes";

export default function ScratchpadStrip() {
  const { activeOrgId, uid, userEmail } = useRole();
  const [brief, setBrief] = useState<DailyBrief | null>(null);
  const [jot, setJot] = useState("");
  const [filing, setFiling] = useState(false);
  const [filed, setFiled] = useState(false);

  const load = useCallback(async () => {
    if (!activeOrgId || !uid) return;
    try {
      setBrief(await getDailyBrief(activeOrgId, uid));
    } catch { /* strip renders without counts */ }
  }, [activeOrgId, uid]);

  useEffect(() => { void load(); }, [load]);

  const file = useCallback(async () => {
    const text = jot.trim();
    if (!text || !activeOrgId || !uid || filing) return;
    setFiling(true);
    try {
      await createNote({
        orgId: activeOrgId,
        body: /^\s*[-*]\s*\[/.test(text) ? text : `- [ ] ${text}`,
        createdBy: uid,
        createdByName: userEmail ?? undefined,
      });
      setJot("");
      setFiled(true);
      setTimeout(() => setFiled(false), 2000);
      void load();
    } catch { /* keep the text — nothing lost */ }
    finally { setFiling(false); }
  }, [jot, activeOrgId, uid, userEmail, filing, load]);

  if (!activeOrgId || !uid) return null;
  const top = brief?.overdue[0] ?? brief?.today[0] ?? null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        <StickyNote className="w-4 h-4 text-amber-500" />
        <span className="text-xs font-black uppercase tracking-wider text-slate-500">Scratchpad</span>
        {brief && (brief.totals.overdue > 0 || brief.totals.today > 0) && (
          <span className="ml-auto flex items-center gap-1.5">
            {brief.totals.overdue > 0 && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-rose-50 border border-rose-200 text-rose-700 text-[10px] font-black">
                <Flame className="w-2.5 h-2.5" /> {brief.totals.overdue}
              </span>
            )}
            {brief.totals.today > 0 && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-50 border border-amber-200 text-amber-700 text-[10px] font-black">
                <Sun className="w-2.5 h-2.5" /> {brief.totals.today}
              </span>
            )}
          </span>
        )}
      </div>
      <div className="p-3 space-y-2">
        {top ? (
          <Link href="/scratchpad" className="block text-xs text-slate-700 hover:text-slate-900 truncate">
            <span className={`font-black text-[10px] uppercase tracking-wider mr-1.5 ${brief!.totals.overdue > 0 ? "text-rose-600" : "text-amber-600"}`}>
              {brief!.totals.overdue > 0 ? "overdue" : "today"}
            </span>
            {top.task.dueText ? top.task.body.replace(top.task.dueText, "").replace(/\s{2,}/g, " ").trim() : top.task.body}
          </Link>
        ) : (
          <div className="text-[11px] text-slate-400">Jot it — it becomes a tracked reminder, with a date or without one.</div>
        )}
        <div className="flex items-center gap-1.5">
          <input
            value={jot}
            onChange={(e) => setJot(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void file(); }}
            placeholder='jot — "check E-204 due friday"'
            className="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-amber-400 placeholder:text-slate-400"
          />
          <button
            onClick={() => void file()}
            disabled={filing || !jot.trim()}
            className="shrink-0 inline-flex items-center justify-center min-w-[44px] px-2.5 py-1.5 rounded-lg bg-slate-900 text-amber-400 text-[11px] font-black hover:bg-slate-800 disabled:opacity-40"
          >
            {filing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : filed ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : "File"}
          </button>
        </div>
        <Link href="/scratchpad" className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700 hover:text-amber-900">
          Open scratchpad — jot · ask · organized reminders <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
    </div>
  );
}
