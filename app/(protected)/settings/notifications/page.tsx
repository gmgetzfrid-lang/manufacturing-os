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
  Bell, Mail, Loader2, Save, Check, AlertTriangle, ArrowLeft,
  AtSign, UserPlus, Activity, AlertOctagon, Briefcase,
} from "lucide-react";
import Link from "next/link";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";

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
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-24">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/dashboard" className="p-2 rounded-lg hover:bg-slate-100 text-slate-600">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-black text-slate-900 flex items-center gap-2">
              <Bell className="w-6 h-6 text-slate-500" /> Notifications
            </h1>
            <p className="text-sm text-slate-500">Control which events email you. In-app bell notifications are always on.</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* Master switch */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-4">
          <div className="flex items-start gap-3">
            <Mail className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm font-black text-slate-900">Email notifications</div>
              <div className="text-xs text-slate-500 mt-0.5">Master switch. Off here means no email regardless of the per-event toggles below.</div>
            </div>
            <Toggle on={prefs.email_enabled} onChange={(v) => setPrefs({ ...prefs, email_enabled: v })} />
          </div>
        </div>

        {/* Per-event */}
        <div className={`bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100 ${prefs.email_enabled ? "" : "opacity-50 pointer-events-none"}`}>
          <PrefRow icon={AtSign} title="Mentions" hint="Someone @-mentions you in a comment." on={prefs.email_on_mention} onChange={(v) => setPrefs({ ...prefs, email_on_mention: v })} />
          <PrefRow icon={UserPlus} title="Assignments" hint="You were assigned as drafter or engineer reviewer on a ticket." on={prefs.email_on_assignment} onChange={(v) => setPrefs({ ...prefs, email_on_assignment: v })} />
          <PrefRow icon={Briefcase} title="Status changes" hint="A ticket you're on advanced, was approved, closed, or sent back for revision." on={prefs.email_on_status_change} onChange={(v) => setPrefs({ ...prefs, email_on_status_change: v })} />
          <PrefRow icon={Activity} title="Watched activity" hint="Activity on tickets you're watching (comments, file uploads)." on={prefs.email_on_watched_activity} onChange={(v) => setPrefs({ ...prefs, email_on_watched_activity: v })} />
          <PrefRow icon={AlertOctagon} title="SLA warnings" hint="A ticket you're responsible for is at risk of breaching its target completion date." on={prefs.email_on_sla_warning} onChange={(v) => setPrefs({ ...prefs, email_on_sla_warning: v })} />
        </div>

        {/* Digest cadence */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mt-4">
          <div className="text-sm font-black text-slate-900 mb-1">Delivery cadence</div>
          <div className="text-xs text-slate-500 mb-3">Currently the backend honors immediate vs. never. Hourly/daily digests are wired into the schema and will batch when implemented.</div>
          <div className="flex flex-wrap gap-2">
            {(["immediate", "hourly", "daily", "never"] as const).map((opt) => (
              <button
                key={opt}
                onClick={() => setPrefs({ ...prefs, digest_frequency: opt })}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${prefs.digest_frequency === opt ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"}`}
              >
                {opt[0].toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          {saved && <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700"><Check className="w-3.5 h-3.5" /> Saved</span>}
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-sm font-bold disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save preferences
          </button>
        </div>
      </div>
    </div>
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
      <Icon className="w-4 h-4 text-slate-400 mt-1 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-slate-900">{title}</div>
        <div className="text-xs text-slate-500 mt-0.5">{hint}</div>
      </div>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ${on ? "bg-emerald-500" : "bg-slate-300"}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-1"}`} />
    </button>
  );
}
