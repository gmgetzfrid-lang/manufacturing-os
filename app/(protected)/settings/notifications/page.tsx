"use client";

// /settings/notifications: which emails a person gets.
//
// Backed by the notification_preferences table. Email can be switched on
// for each kind of event (mentions, assignments, status changes, watched
// activity, due date warnings), plus how often. The bell in the app always
// shows everything; email is the opt-in part.

import React, { useCallback, useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import { bandSeg, bandSegItem } from "@/components/admin/band";
import { said } from "@/components/admin/said";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";
import { Button, useActionFeedback } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonRows } from "@/components/ui/Skeleton";

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

const EVENTS: Array<{ key: keyof Prefs; title: string; hint: string }> = [
  { key: "email_on_mention", title: "Mentions", hint: "Someone @-mentions you in a comment." },
  { key: "email_on_assignment", title: "Assignments", hint: "You're assigned as drafter or engineer reviewer on a request." },
  { key: "email_on_status_change", title: "Status changes", hint: "A request you're on moves ahead, is approved, closed, or sent back." },
  { key: "email_on_watched_activity", title: "Watched activity", hint: "Comments and new files on requests you watch." },
  { key: "email_on_sla_warning", title: "Due date warnings", hint: "A request you're responsible for is close to its target date." },
];

const same = (a: Prefs, b: Prefs) => (Object.keys(a) as Array<keyof Prefs>).every((k) => a[k] === b[k]);

export default function NotificationSettingsPage() {
  const { uid } = useRole();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  // What's saved, so Save stays quiet until something changes.
  const [savedPrefs, setSavedPrefs] = useState<Prefs>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const save = useActionFeedback();

  const load = useCallback(async () => {
    if (!uid) return;
    setLoading(true);
    try {
      const { data, error: readErr } = await supabase
        .from("notification_preferences")
        .select("*")
        .eq("user_id", uid)
        .maybeSingle();
      if (readErr) throw readErr;
      setLoadError(null);
      const next: Prefs = data ? {
        email_enabled: data.email_enabled ?? true,
        email_on_mention: data.email_on_mention ?? true,
        email_on_assignment: data.email_on_assignment ?? true,
        email_on_status_change: data.email_on_status_change ?? true,
        email_on_watched_activity: data.email_on_watched_activity ?? true,
        email_on_sla_warning: data.email_on_sla_warning ?? true,
        digest_frequency: (data.digest_frequency as Prefs["digest_frequency"]) ?? "immediate",
      } : DEFAULTS;
      setPrefs(next);
      setSavedPrefs(next);
    } catch (e) {
      // Don't show the defaults as if they were saved: saving them would
      // overwrite the real choices.
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }, [uid]);
  useEffect(() => { void load(); }, [load]);

  const doSave = async () => {
    if (!uid) return;
    setError(null);
    try {
      await save.run(async () => {
        const { error: upsertErr } = await supabase
          .from("notification_preferences")
          .upsert({ user_id: uid, ...prefs }, { onConflict: "user_id" });
        if (upsertErr) throw upsertErr;
      });
      setSavedPrefs(prefs);
    } catch (e) {
      setError(said(e, "Couldn't save your settings."));
    }
  };

  const back = { href: "/settings", label: "Back to Settings" };
  if (loading && !loadError) {
    return (
      <PageShell width="form">
        <PageHero kicker="Settings · Notifications" title="Notifications" size="md" back={back} />
        <PageBody><SkeletonRows rows={5} cols={1} what="your notification settings" /></PageBody>
      </PageShell>
    );
  }
  if (loadError) {
    return (
      <PageShell width="form">
        <PageHero kicker="Settings · Notifications" title="Couldn't load your settings." size="md" back={back} />
        <PageBody><ErrorNote error={loadError} onRetry={() => void load()} /></PageBody>
      </PageShell>
    );
  }

  const onCount = EVENTS.filter((e) => prefs[e.key]).length;
  const dirty = !same(prefs, savedPrefs);
  const saveButton = (
    <Button {...save.state} doneLabel="Saved" onClick={() => void doSave()} disabled={!dirty && !save.done}
      title={!dirty ? "Nothing changed yet" : undefined}>
      Save
    </Button>
  );

  return (
    <PageShell width="form">
        <PageHero
          kicker="Settings · Notifications"
          back={back}
          size="md"
          title={prefs.email_enabled ? `Email on for ${onCount} of ${EVENTS.length} events.` : "Email is off."}
          sub="The bell in the app always shows everything."
          primary={saveButton}
        />

        <PageBody>
        {error && <p role="alert" className="text-body font-medium text-[var(--state-overdue-text)] flex items-start gap-1.5"><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-px" /><span>{error}</span></p>}

        <Card pad={false} className="overflow-hidden">
          <PrefRow title="Email notifications" hint="Off means no email at all, whatever is set below."
            on={prefs.email_enabled} onChange={(v) => setPrefs({ ...prefs, email_enabled: v })} strong />
        </Card>

        <Card label="Email me when" pad={false} className={`py-2 overflow-hidden ${prefs.email_enabled ? "" : "opacity-50"}`}>
          {EVENTS.map((ev) => (
            <PrefRow key={ev.key} title={ev.title} hint={ev.hint} disabled={!prefs.email_enabled}
              on={prefs[ev.key] as boolean} onChange={(v) => setPrefs({ ...prefs, [ev.key]: v })} />
          ))}
        </Card>

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
          <p className="mt-2 text-body text-[var(--color-text-muted)]">Only Right away and Never work today. Hourly and daily batching isn&apos;t built yet.</p>
        </Card>
        </PageBody>
    </PageShell>
  );
}

function PrefRow({ title, hint, on, onChange, disabled, strong }: {
  title: string; hint: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean; strong?: boolean;
}) {
  return (
    <div className={`px-4 sm:px-5 ${strong ? "py-4" : "py-3"} flex items-start gap-4`}>
      <div className="flex-1 min-w-0">
        <div className="text-reading font-medium text-[var(--color-text)]">{title}</div>
        <div className="text-body text-[var(--color-text-muted)] mt-0.5">{hint}</div>
      </div>
      <Toggle label={title} on={on} onChange={onChange} disabled={disabled} />
    </div>
  );
}

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`ui-hit relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 mt-0.5 disabled:cursor-not-allowed ${on ? "bg-[var(--color-main)]" : "bg-[var(--color-border-control)]"}`}
    >
      <span className={`inline-block h-5 w-5 rounded-full bg-[var(--color-surface)] transition-transform motion-reduce:transition-none ${on ? "translate-x-[22px]" : "translate-x-0.5"}`} />
    </button>
  );
}
