"use client";

// /settings/notifications — per-user notification preferences page.
//
// Backed by the notification_preferences table. Users can toggle email
// for each category independently (mentions, assignments, status
// changes, watcher activity, SLA warnings) and pick a delivery cadence.
// In-app bell notifications are always on — they're the persistent
// inbox; the email side is the opt-in noise layer. Pop-up toasts (the
// ephemeral echo of a new bell item) have their own switch, toast_enabled.
//
// One vocabulary (notifications Round G, N1): the values, defaults and
// cadence list come from lib/notificationPrefs.ts, which a test pins to the
// digest_frequency CHECK. The page used to write 'immediate', which the
// CHECK refuses, so a member with no row could never save (NEDGE-2).

import React, { useEffect, useState } from "react";
import {
  Bell, Mail, Save, Check, AlertTriangle, ArrowLeft,
  AtSign, UserPlus, Activity, AlertOctagon, Briefcase, MessageSquare,
} from "lucide-react";
import Link from "next/link";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import {
  PREF_DEFAULTS, OFFERED_DIGEST_FREQUENCIES, DIGEST_LABELS, TOAST_PREFERENCE_HONOURED,
  prefsFromRow, isCheckViolation, isMissingColumnError,
  type NotificationPrefs,
} from "@/lib/notificationPrefs";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";

type Prefs = NotificationPrefs;
type PgError = { code?: string; message: string; details?: string };

/** A save the database refused, worded for the person: a CHECK violation is
 *  the page and the schema disagreeing about an allowed value (the NEDGE-2
 *  class) — say so, with the constraint's own message, so the next drift is
 *  diagnosable rather than a raw dump. */
function saveFailure(err: PgError): string {
  if (isCheckViolation(err)) {
    return `The server refused a preference value (check constraint): ${err.message}. Nothing was saved — the page and the database disagree about an allowed value; please report this.`;
  }
  return err.message;
}

export default function NotificationSettingsPage() {
  const { uid } = useRole();
  const [prefs, setPrefs] = useState<Prefs>({ ...PREF_DEFAULTS });
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A stored cadence the page no longer offers ('hourly' / 'daily': accepted
  // by the CHECK, never implemented — email went out immediately).
  const [legacyCadence, setLegacyCadence] = useState<string | null>(null);

  useEffect(() => {
    if (!uid) return;
    (async () => {
      setLoading(true);
      try {
        const { data, error: loadErr } = await supabase
          .from("notification_preferences")
          .select("*")
          .eq("user_id", uid)
          .maybeSingle();
        if (loadErr) throw loadErr;
        if (data) {
          const row = data as Record<string, unknown>;
          const loaded = prefsFromRow(row);
          if (!(OFFERED_DIGEST_FREQUENCIES as readonly string[]).includes(loaded.digest_frequency)) {
            setLegacyCadence(DIGEST_LABELS[loaded.digest_frequency]);
            loaded.digest_frequency = "instant";
          }
          setPrefs(loaded);
        }
      } catch (e) {
        // Never fall back to the defaults silently: saving them would
        // overwrite a row that exists but could not be read.
        setLoadFailed(true);
        setError(`Your saved preferences could not be loaded: ${(e as Error).message}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [uid]);

  const save = async () => {
    if (!uid || loadFailed) return;
    setSaving(true); setError(null); setSaved(false); setNotice(null);
    try {
      let { error: upsertErr } = await supabase
        .from("notification_preferences")
        .upsert({ user_id: uid, ...prefs }, { onConflict: "user_id" });
      if (upsertErr && isMissingColumnError(upsertErr, "toast_enabled")) {
        // The database has not had 20261148 pasted yet: save everything else.
        const { toast_enabled, ...rest } = prefs;
        ({ error: upsertErr } = await supabase
          .from("notification_preferences")
          .upsert({ user_id: uid, ...rest }, { onConflict: "user_id" }));
        if (!upsertErr && toast_enabled === false) {
          setNotice("Your email preferences were saved; the pop-up setting was not saved — the database update that adds it has not been applied yet.");
        }
      }
      if (upsertErr) throw upsertErr;
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(saveFailure(e as PgError));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-full flex items-center justify-center">
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
          <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}
        {notice && (
          <div role="status" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {notice}
          </div>
        )}

        {/* Master switch */}
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-5 mb-4">
          <div className="flex items-start gap-3">
            <Mail className="w-5 h-5 text-[var(--color-text-muted)] shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm font-black text-[var(--color-text)]">Email notifications</div>
              <div className="text-xs text-[var(--color-text-muted)] mt-0.5">Master switch. Off here means no email regardless of the per-event toggles below — except drawing recalls and safety notices, which always email.</div>
            </div>
            <Toggle label="Email notifications" on={prefs.email_enabled} onChange={(v) => setPrefs({ ...prefs, email_enabled: v })} />
          </div>
        </div>

        {/* Per-event */}
        <div className={`bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm divide-y divide-[var(--color-border)] ${prefs.email_enabled ? "" : "opacity-50 pointer-events-none"}`}>
          <PrefRow icon={AtSign} title="Mentions" hint="Someone @-mentions you in a comment." on={prefs.email_on_mention} onChange={(v) => setPrefs({ ...prefs, email_on_mention: v })} />
          <PrefRow icon={UserPlus} title="Assignments" hint="You were assigned as drafter or engineer reviewer on a ticket." on={prefs.email_on_assignment} onChange={(v) => setPrefs({ ...prefs, email_on_assignment: v })} />
          <PrefRow icon={Briefcase} title="Ticket status changes" hint="A ticket you're on advanced, was approved, closed, or sent back for revision. Drawing recalls and safety notices are never affected by this toggle." on={prefs.email_on_status_change} onChange={(v) => setPrefs({ ...prefs, email_on_status_change: v })} />
          <PrefRow icon={Activity} title="Watched activity" hint="Activity on tickets you're watching (comments, file uploads)." on={prefs.email_on_watched_activity} onChange={(v) => setPrefs({ ...prefs, email_on_watched_activity: v })} />
          <PrefRow icon={AlertOctagon} title="SLA warnings" hint="A ticket you're responsible for is at risk of breaching its target completion date." on={prefs.email_on_sla_warning} onChange={(v) => setPrefs({ ...prefs, email_on_sla_warning: v })} />
        </div>

        {/* Digest cadence */}
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-5 mt-4">
          <div className="text-sm font-black text-[var(--color-text)] mb-1">Delivery cadence</div>
          <div className="text-xs text-[var(--color-text-muted)] mb-3">Immediately sends each email as it happens; Never turns event email off, except drawing recalls and safety notices. (The master switch above also stops the daily compliance digest.)</div>
          {legacyCadence && (
            <div className="text-xs text-amber-800 mb-3">Your saved cadence “{legacyCadence}” was never implemented — email has been sent immediately. Saving stores Immediately.</div>
          )}
          <div className="flex flex-wrap gap-2">
            {OFFERED_DIGEST_FREQUENCIES.map((opt) => (
              <button
                key={opt}
                type="button"
                aria-pressed={prefs.digest_frequency === opt}
                onClick={() => setPrefs({ ...prefs, digest_frequency: opt })}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${prefs.digest_frequency === opt ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-[var(--color-accent)]" : "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}
              >
                {DIGEST_LABELS[opt]}
              </button>
            ))}
          </div>
        </div>

        {/* In-app */}
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm divide-y divide-[var(--color-border)] mt-4">
          <div className="px-5 py-4 flex items-start gap-3">
            <Bell className="w-5 h-5 text-[var(--color-text-muted)] shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm font-black text-[var(--color-text)]">In-app</div>
              <div className="text-xs text-[var(--color-text-muted)] mt-0.5">Bell notifications are always on — they are the record of what needs your attention, and nothing here turns them off.</div>
            </div>
          </div>
          {TOAST_PREFERENCE_HONOURED && (
            <PrefRow icon={MessageSquare} title="Pop-up toasts" hint="A brief card in the corner when a new bell notification arrives. Off: the bell still counts it." on={prefs.toast_enabled} onChange={(v) => setPrefs({ ...prefs, toast_enabled: v })} />
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          {saved && <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700"><Check className="w-3.5 h-3.5" /> Saved</span>}
          <Button onClick={save} loading={saving} disabled={loadFailed}>
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
      <Toggle label={title} on={on} onChange={onChange} />
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)] focus-visible:ring-offset-2 ${on ? "bg-emerald-500" : "bg-slate-300"}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-[var(--color-surface)] shadow transition-transform ${on ? "translate-x-5" : "translate-x-1"}`} />
    </button>
  );
}
