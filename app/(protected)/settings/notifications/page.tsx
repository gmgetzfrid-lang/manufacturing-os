"use client";

// /settings/notifications — per-user notification preferences page.
//
// Backed by the notification_preferences table. Users can toggle email
// for each category independently (mentions, assignments, status
// changes, watcher activity, SLA warnings) and pick a digest frequency.
// In-app bell notifications are always on — they're the persistent
// inbox; the email side is the opt-in noise layer.

import React, { useEffect, useState } from "react";
import {
  Bell, Mail, Save, Check, AlertTriangle, ArrowLeft,
  AtSign, UserPlus, Activity, AlertOctagon, Briefcase,
} from "lucide-react";
import Link from "next/link";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import PushReminders from "@/components/pwa/PushReminders";

interface Prefs {
  email_enabled: boolean;
  email_on_mention: boolean;
  email_on_assignment: boolean;
  email_on_status_change: boolean;
  email_on_watched_activity: boolean;
  email_on_sla_warning: boolean;
  digest_frequency: "immediate" | "hourly" | "daily" | "never";
}

const DEFAULTS: Prefs = {
  email_enabled: true,
  email_on_mention: true,
  email_on_assignment: true,
  email_on_status_change: true,
  email_on_watched_activity: true,
  email_on_sla_warning: true,
  digest_frequency: "immediate",
};

export default function NotificationSettingsPage() {
  const { uid } = useRole();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!uid) return;
    (async () => {
      setLoading(true);
      try {
        const { data } = await supabase
          .from("notification_preferences")
          .select("*")
          .eq("user_id", uid)
          .maybeSingle();
        if (data) {
          setPrefs({
            email_enabled: data.email_enabled ?? true,
            email_on_mention: data.email_on_mention ?? true,
            email_on_assignment: data.email_on_assignment ?? true,
            email_on_status_change: data.email_on_status_change ?? true,
            email_on_watched_activity: data.email_on_watched_activity ?? true,
            email_on_sla_warning: data.email_on_sla_warning ?? true,
            digest_frequency: (data.digest_frequency as Prefs["digest_frequency"]) ?? "immediate",
          });
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [uid]);

  const save = async () => {
    if (!uid) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const { error: upsertErr } = await supabase
        .from("notification_preferences")
        .upsert({ user_id: uid, ...prefs }, { onConflict: "user_id" });
      if (upsertErr) throw upsertErr;
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <PageShell width="form">
        <div className="flex items-start gap-3">
          <Link href="/dashboard" className="p-2 mt-1 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <PageHeaderBar
            className="flex-1 min-w-0"
            icon={Bell}
            title="Notifications"
            subtitle="Control which events email you. In-app bell notifications are always on."
          />
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* Scheduled OS reminders (Web Push) — per device */}
        <div className="mb-4">
          <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mb-2">Reminders</div>
          <PushReminders />
        </div>

        {/* Master switch */}
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-5 mb-4">
          <div className="flex items-start gap-3">
            <Mail className="w-5 h-5 text-[var(--color-text-muted)] shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm font-black text-[var(--color-text)]">Email notifications</div>
              <div className="text-xs text-[var(--color-text-muted)] mt-0.5">Master switch. Off here means no email regardless of the per-event toggles below.</div>
            </div>
            <Toggle on={prefs.email_enabled} onChange={(v) => setPrefs({ ...prefs, email_enabled: v })} />
          </div>
        </div>

        {/* Per-event */}
        <div className={`bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm divide-y divide-[var(--color-border)] ${prefs.email_enabled ? "" : "opacity-50 pointer-events-none"}`}>
          <PrefRow icon={AtSign} title="Mentions" hint="Someone @-mentions you in a comment." on={prefs.email_on_mention} onChange={(v) => setPrefs({ ...prefs, email_on_mention: v })} />
          <PrefRow icon={UserPlus} title="Assignments" hint="You were assigned as drafter or engineer reviewer on a ticket." on={prefs.email_on_assignment} onChange={(v) => setPrefs({ ...prefs, email_on_assignment: v })} />
          <PrefRow icon={Briefcase} title="Status changes" hint="A ticket you're on advanced, was approved, closed, or sent back for revision." on={prefs.email_on_status_change} onChange={(v) => setPrefs({ ...prefs, email_on_status_change: v })} />
          <PrefRow icon={Activity} title="Watched activity" hint="Activity on tickets you're watching (comments, file uploads)." on={prefs.email_on_watched_activity} onChange={(v) => setPrefs({ ...prefs, email_on_watched_activity: v })} />
          <PrefRow icon={AlertOctagon} title="SLA warnings" hint="A ticket you're responsible for is at risk of breaching its target completion date." on={prefs.email_on_sla_warning} onChange={(v) => setPrefs({ ...prefs, email_on_sla_warning: v })} />
        </div>

        {/* Digest cadence */}
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-5 mt-4">
          <div className="text-sm font-black text-[var(--color-text)] mb-1">Delivery cadence</div>
          <div className="text-xs text-[var(--color-text-muted)] mb-3">Currently the backend honors immediate vs. never. Hourly/daily digests are wired into the schema and will batch when implemented.</div>
          <div className="flex flex-wrap gap-2">
            {(["immediate", "hourly", "daily", "never"] as const).map((opt) => (
              <button
                key={opt}
                onClick={() => setPrefs({ ...prefs, digest_frequency: opt })}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${prefs.digest_frequency === opt ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-[var(--color-accent)]" : "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}
              >
                {opt[0].toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          {saved && <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700"><Check className="w-3.5 h-3.5" /> Saved</span>}
          <Button onClick={save} loading={saving}>
            {!saving && <Save className="w-4 h-4" />}
            Save preferences
          </Button>
        </div>
    </PageShell>
  );
}

interface PrefRowProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  on: boolean;
  onChange: (v: boolean) => void;
}
function PrefRow({ icon: Icon, title, hint, on, onChange }: PrefRowProps) {
  return (
    <div className="px-5 py-4 flex items-start gap-3">
      <Icon className="w-4 h-4 text-[var(--color-text-faint)] mt-1 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-[var(--color-text)]">{title}</div>
        <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{hint}</div>
      </div>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)] focus-visible:ring-offset-2 ${on ? "bg-emerald-500" : "bg-slate-300"}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-[var(--color-surface)] shadow transition-transform ${on ? "translate-x-5" : "translate-x-1"}`} />
    </button>
  );
}
