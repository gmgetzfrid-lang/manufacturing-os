"use client";

// /scratchpad — personal cockpit for operational memory.
//
// Two tabs:
//   "Brief"  — Daily Brief cockpit: overdue / today / this week
//              counts up top; tasks grouped by urgency; latest note
//              preview to jump back into.
//   "Notes"  — the embeddable ScratchpadPanel scoped to the user.
//              Standalone notes here are PRIVATE per RLS migration
//              20260630_scratchpad_private.sql.
//
// Autonomous loop:
//   - Every time the page loads, getDailyBrief() runs.
//   - If the user has any overdue tasks AND we haven't already sent
//     a digest today, one bell notification is queued. Idempotent
//     by date so opening the page 50x doesn't spam.
//
// Task syntax recognized by the parser (lib/notes.ts):
//   - [ ] thing                              → undated task
//   - [ ] thing @2026-06-15                  → ISO date
//   - [ ] thing @06-15                       → MM-DD (current year)
//   - [ ] thing due tomorrow                 → relative
//   - [ ] thing due friday                   → next occurrence
//   - [ ] thing by next week                 → +7 days

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  StickyNote, ListChecks, Loader2, ExternalLink, Sparkles,
  AlertTriangle, Sun, CalendarDays, Calendar, CircleSlash, ArrowRight,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  getDailyBrief, maybeNotifyOverdueDigest,
  toggleTaskInBody, updateNoteBody,
  type DailyBrief, type TaskWithNote, type Note,
} from "@/lib/notes";
import ScratchpadPanel from "@/components/notes/ScratchpadPanel";
import MorningBriefing from "@/components/notes/MorningBriefing";

type Tab = "brief" | "notes";

export default function ScratchpadPage() {
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const [tab, setTab] = useState<Tab>("brief");

  if (!activeOrgId || !uid) {
    return <div className="p-6 text-sm text-slate-500">No active organization.</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6 pb-20">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-black text-slate-900 flex items-center gap-2">
              <StickyNote className="w-5 h-5 text-amber-600" /> Scratchpad
            </h1>
            <p className="text-xs text-slate-500 mt-1">
              Your personal operational memory. Only you see notes here. Add <code className="font-mono bg-slate-100 px-1 rounded">- [ ] something due friday</code> to track follow-ups; overdue items get a notification.
            </p>
          </div>
          <Link href="/scratchpad/prototype" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 text-amber-400 text-xs font-black hover:bg-slate-800 shadow-sm">
            <Sparkles className="w-3.5 h-3.5" /> Preview the new cockpit
          </Link>
        </div>

        <div className="flex items-center gap-1 border-b border-slate-200 -mb-px">
          <TabButton active={tab === "brief"} onClick={() => setTab("brief")}>
            <ListChecks className="w-3.5 h-3.5" /> Daily Brief
          </TabButton>
          <TabButton active={tab === "notes"} onClick={() => setTab("notes")}>
            <StickyNote className="w-3.5 h-3.5" /> Notes
          </TabButton>
        </div>

        {tab === "brief" && (
          <BriefTab orgId={activeOrgId} actorUserId={uid} />
        )}

        {tab === "notes" && (
          <ScratchpadPanel
            orgId={activeOrgId}
            userId={uid}
            userName={userEmail ?? undefined}
            userEmail={userEmail ?? undefined}
            userRole={activeRole ?? undefined}
            listMaxHeight="60vh"
          />
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-bold inline-flex items-center gap-1 border-b-2 ${
        active ? "border-amber-600 text-amber-700" : "border-transparent text-slate-500 hover:text-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Daily Brief ────────────────────────────────────────────────

function BriefTab({ orgId, actorUserId }: { orgId: string; actorUserId: string }) {
  const [brief, setBrief] = useState<DailyBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const b = await getDailyBrief(orgId, actorUserId);
      setBrief(b);
      // Fire-and-forget — never blocks the UI.
      void maybeNotifyOverdueDigest(orgId, actorUserId, b);
    } finally {
      setLoading(false);
    }
  }, [orgId, actorUserId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const onCheck = async (note: Note, lineIndex: number) => {
    setBusy(`${note.id}:${lineIndex}`);
    try {
      const newBody = toggleTaskInBody(note.body, lineIndex);
      await updateNoteBody({ id: note.id, body: newBody, updatedBy: actorUserId });
      await refresh();
    } finally { setBusy(null); }
  };

  if (loading && !brief) {
    return <div className="text-xs text-slate-500 py-10 text-center"><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1" />Building your brief…</div>;
  }
  if (!brief) return null;

  const isEmpty = brief.totals.total === 0;

  return (
    <div className="space-y-4">
      <MorningBriefing orgId={orgId} userId={actorUserId} brief={brief} />

      {/* Counts strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <CountPill label="Overdue"  count={brief.totals.overdue} tone="rose" icon={AlertTriangle} loud />
        <CountPill label="Today"    count={brief.totals.today}   tone="amber" icon={Sun} />
        <CountPill label="This week" count={brief.totals.soon}   tone="blue"  icon={CalendarDays} />
        <CountPill label="Later"    count={brief.totals.later}   tone="slate" icon={Calendar} />
        <CountPill label="No date"  count={brief.totals.noDate}  tone="slate" icon={CircleSlash} />
      </div>

      {isEmpty ? (
        <EmptyBrief />
      ) : (
        <>
          {brief.overdue.length > 0 && (
            <Section title="Overdue" subtitle="Was due before today" tone="rose">
              <TaskGroup tasks={brief.overdue} busy={busy} onCheck={onCheck} />
            </Section>
          )}
          {brief.today.length > 0 && (
            <Section title="Today" subtitle="Due before end of day" tone="amber">
              <TaskGroup tasks={brief.today} busy={busy} onCheck={onCheck} />
            </Section>
          )}
          {brief.soon.length > 0 && (
            <Section title="This week" subtitle="Next 7 days" tone="blue">
              <TaskGroup tasks={brief.soon} busy={busy} onCheck={onCheck} />
            </Section>
          )}
          {brief.later.length > 0 && (
            <Section title="Later" subtitle="More than a week out" tone="slate">
              <TaskGroup tasks={brief.later} busy={busy} onCheck={onCheck} />
            </Section>
          )}
          {brief.noDate.length > 0 && (
            <Section title="No date" subtitle="Add a due date with — for example — `due friday`" tone="slate">
              <TaskGroup tasks={brief.noDate} busy={busy} onCheck={onCheck} />
            </Section>
          )}
        </>
      )}

      {brief.latestNote && (
        <LatestNotePreview note={brief.latestNote} />
      )}
    </div>
  );
}

function EmptyBrief() {
  return (
    <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-8">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-amber-100 text-amber-700">
          <Sparkles className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-black text-slate-900">Your brief is empty — let&apos;s prime it.</h3>
          <p className="text-xs text-slate-600 mt-1">
            Open the <b>Notes</b> tab and write tasks using checkbox syntax. The brief will surface them grouped by urgency.
          </p>
          <div className="mt-3 space-y-1.5">
            <SyntaxLine example="- [ ] Call Joe about MOC-2024-051 due tomorrow" hint="creates a task due tomorrow" />
            <SyntaxLine example="- [ ] Inspect E-204 tube bundle @2026-07-15"   hint="ISO date — most reliable form" />
            <SyntaxLine example="- [ ] Submit revision package by friday"        hint="next upcoming friday" />
            <SyntaxLine example="- [ ] Follow up on hold #42"                    hint="no date — lives in the No-date bucket" />
          </div>
          <p className="text-[11px] text-slate-500 mt-3 italic">
            Anything overdue triggers a once-per-day notification in the bell drawer — so even if you forget to open the scratchpad, you&apos;ll get reminded.
          </p>
        </div>
      </div>
    </div>
  );
}

function SyntaxLine({ example, hint }: { example: string; hint: string }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <code className="font-mono bg-slate-100 px-2 py-0.5 rounded text-slate-800">{example}</code>
      <span className="text-slate-500">→ {hint}</span>
    </div>
  );
}

function CountPill({
  label, count, tone, icon: Icon, loud,
}: {
  label: string; count: number;
  tone: "rose" | "amber" | "blue" | "slate";
  icon: React.ComponentType<{ className?: string }>;
  loud?: boolean;
}) {
  const tones: Record<string, string> = {
    rose:  loud && count > 0 ? "bg-rose-50 border-rose-300 text-rose-700 ring-1 ring-rose-200" : "bg-white border-slate-200 text-slate-700",
    amber: count > 0 ? "bg-amber-50 border-amber-200 text-amber-700" : "bg-white border-slate-200 text-slate-700",
    blue:  count > 0 ? "bg-blue-50 border-blue-200 text-blue-700"   : "bg-white border-slate-200 text-slate-700",
    slate: "bg-white border-slate-200 text-slate-700",
  };
  return (
    <div className={`rounded-xl border p-3 ${tones[tone]}`}>
      <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div className="text-2xl font-black mt-1">{count}</div>
    </div>
  );
}

function Section({
  title, subtitle, tone, children,
}: {
  title: string; subtitle: string;
  tone: "rose" | "amber" | "blue" | "slate";
  children: React.ReactNode;
}) {
  const borderTones: Record<string, string> = {
    rose:  "border-l-rose-400",
    amber: "border-l-amber-400",
    blue:  "border-l-blue-400",
    slate: "border-l-slate-300",
  };
  return (
    <div className={`bg-white rounded-xl border border-slate-200 border-l-4 ${borderTones[tone]} p-3`}>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs font-black text-slate-900 uppercase tracking-wider">{title}</div>
        <div className="text-[10px] text-slate-500">{subtitle}</div>
      </div>
      {children}
    </div>
  );
}

function TaskGroup({
  tasks, busy, onCheck,
}: {
  tasks: TaskWithNote[];
  busy: string | null;
  onCheck: (note: Note, lineIndex: number) => void;
}) {
  return (
    <ul className="space-y-1">
      {tasks.map(({ note, task }) => {
        const key = `${note.id}:${task.lineIndex}`;
        const isBusy = busy === key;
        return (
          <li key={key} className="flex items-start gap-2 text-xs text-slate-800 group">
            <input
              type="checkbox"
              checked={false}
              disabled={isBusy}
              onChange={() => onCheck(note, task.lineIndex)}
              className="mt-[3px] cursor-pointer accent-amber-600"
            />
            <div className="flex-1 min-w-0">
              <div className="truncate">
                {/* Strip the due-marker span so the text reads cleanly */}
                {task.dueText ? task.body.replace(task.dueText, "").trim() : task.body}
                {task.dueAt && (
                  <span className={`ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${dueTone(task.dueAt)}`}>
                    {humanDue(task.dueAt)}
                  </span>
                )}
              </div>
              {note.createdAt && (
                <div className="text-[10px] text-slate-400 mt-0.5">from a note · {formatWhen(note.createdAt)}</div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function dueTone(dueAt: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (dueAt < today)  return "bg-rose-100 text-rose-800";
  if (dueAt === today) return "bg-amber-100 text-amber-800";
  return "bg-blue-100 text-blue-800";
}

function humanDue(dueAt: string): string {
  const today = new Date(); today.setHours(0,0,0,0);
  const due = new Date(`${dueAt}T00:00:00`);
  const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diff < 0)  return `${-diff}d overdue`;
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff < 7)  return `${diff}d`;
  return dueAt;
}

function LatestNotePreview({ note }: { note: Note }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs font-black text-slate-900 uppercase tracking-wider">Pick up where you left off</div>
        <div className="text-[10px] text-slate-500">{formatWhen(note.createdAt)}</div>
      </div>
      <pre className="text-xs text-slate-700 font-mono whitespace-pre-wrap line-clamp-6 bg-slate-50 rounded p-2 border border-slate-100">{note.body}</pre>
      <Link href="/scratchpad?tab=notes" className="text-[11px] text-amber-700 hover:text-amber-900 font-bold inline-flex items-center gap-1 mt-2">
        Open Notes tab <ArrowRight className="w-3 h-3" />
      </Link>
    </div>
  );
}

function formatWhen(ts: string): string {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function DeepLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-0.5 text-blue-700 hover:text-blue-900">
      <ExternalLink className="w-3 h-3" /> {label}
    </Link>
  );
}
