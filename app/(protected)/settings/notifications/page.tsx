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
  Save, Check, Loader2,
  AtSign, UserPlus, Activity, AlertOctagon, Briefcase,
} from "lucide-react";
import { bandSeg, bandSegItem } from "@/components/admin/band";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary } from "@/components/ui/PageHero";
import LoadingBlock from "@/components/ui/LoadingBlock";

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
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!uid) return;
    (async () => {
      setLoading(true);
      try {
        const { data, error: readErr } = await supabase
          .from("notification_preferences")
          .select("*")
          .eq("user_id", uid)
          .maybeSingle();
        if (readErr) throw readErr;
        setLoadFailed(false);
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
        // Don't show the defaults as if they were saved: saving them would
        // overwrite the real choices.
        setLoadFailed(true);
        setError(`Couldn't load your notification settings: ${(e as Error).message}`);
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
    return <PageShell width="form"><PageHero kicker="Settings · Notifications" title="Notifications" size="md" overlap={false} back={{ href: "/dashboard", label: "Back to Home" }} /><LoadingBlock what="your notification settings" /></PageShell>;
  }

  const onCount = [prefs.email_on_mention, prefs.email_on_assignment, prefs.email_on_status_change, prefs.email_on_watched_activity, prefs.email_on_sla_warning].filter(Boolean).length;
  const saveButton = (
    <button type="button" onClick={save} disabled={saving || loadFailed} className={heroPrimary}
      title={loadFailed ? "Reload the page to load your settings first" : undefined}>
      {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
      {saved ? "Saved" : "Save preferences"}
    </button>
  );

  return (
    <PageShell width="form">
        <PageHero
          kicker="Settings · Notifications"
          back={{ href: "/dashboard", label: "Back to Home" }}
          size="md"
          title={loadFailed ? "Couldn't load your settings." : prefs.email_enabled ? `Email on for ${onCount} of 5 events.` : "Email is off."}
          sub="The bell in the app always shows everything."
          primary={saveButton}
        />

        <PageBody>
        {/* Master switch */}
        <Card label="Email">
          {error && (
            <p role="alert" className="mb-3 relative pl-3 text-[15px] text-[var(--color-text)]">
              <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />{error}
            </p>
          )}
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="text-[15px] font-semibold text-[var(--color-text)]">Email notifications</div>
              <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5">Off means no email at all, whatever is set below.</div>
            </div>
            <Toggle label="Email notifications" on={prefs.email_enabled} onChange={(v) => setPrefs({ ...prefs, email_enabled: v })} />
          </div>
        </Card>

        {/* Per-event */}
        <Card label="Email me when" pad={false} className={`overflow-hidden ${prefs.email_enabled ? "" : "opacity-50 pointer-events-none"}`}>
        <div className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
          <PrefRow icon={AtSign} title="Mentions" hint="Someone @-mentions you in a comment." on={prefs.email_on_mention} onChange={(v) => setPrefs({ ...prefs, email_on_mention: v })} />
          <PrefRow icon={UserPlus} title="Assignments" hint="You were assigned as drafter or engineer reviewer on a request." on={prefs.email_on_assignment} onChange={(v) => setPrefs({ ...prefs, email_on_assignment: v })} />
          <PrefRow icon={Briefcase} title="Status changes" hint="A request you're on moved ahead, was approved, closed, or sent back for revision." on={prefs.email_on_status_change} onChange={(v) => setPrefs({ ...prefs, email_on_status_change: v })} />
          <PrefRow icon={Activity} title="Watched activity" hint="Comments and new files on requests you watch." on={prefs.email_on_watched_activity} onChange={(v) => setPrefs({ ...prefs, email_on_watched_activity: v })} />
          <PrefRow icon={AlertOctagon} title="Due date warnings" hint="A request you're responsible for is close to its target completion date." on={prefs.email_on_sla_warning} onChange={(v) => setPrefs({ ...prefs, email_on_sla_warning: v })} />
        </div>
        </Card>

        {/* Digest cadence */}
        <Card label="How often">
          <div className={bandSeg} role="radiogroup" aria-label="How often to email">
            {(["immediate", "hourly", "daily", "never"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                role="radio"
                onClick={() => setPrefs({ ...prefs, digest_frequency: opt })}
                aria-checked={prefs.digest_frequency === opt}
                className={bandSegItem(prefs.digest_frequency === opt)}
              >
                {opt === "immediate" ? "Right away" : opt[0].toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">Only Right away and Never work today. Hourly and daily batching isn&apos;t built yet.</p>
        </Card>
        {saved && <p role="status" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text)]"><Check className="w-4 h-4 text-[var(--state-released)]" /> Saved</p>}
        </PageBody>
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
        <div className="text-[15px] font-semibold text-[var(--color-text)]">{title}</div>
        <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5">{hint}</div>
      </div>
      <Toggle label={title} on={on} onChange={onChange} />
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)] focus-visible:ring-offset-2 ${on ? "bg-[var(--color-text)]" : "bg-[var(--color-border-strong)]"}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-[var(--color-surface)] shadow transition-transform ${on ? "translate-x-5" : "translate-x-1"}`} />
    </button>
  );
}
