"use client";

// /profile — personal account page. Display name, email, role,
// org memberships, password change link, and quick links to the
// settings surfaces (notification prefs, sign out).

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Mail, Shield, Bell, LogOut, Save,
  AlertTriangle, Check, Briefcase, Edit3, Camera, Trash2, Loader2,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase, setPreferMicrosoft } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary } from "@/components/ui/PageHero";
import { Input } from "@/components/ui/Field";
import LoadingBlock from "@/components/ui/LoadingBlock";
import FileThumb from "@/components/ui/FileThumb";
import { useFileDrag } from "@/hooks/useFileDrag";
import { tryUpload } from "@/lib/uploadRetry";

const formatBytes = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
import UserAvatar from "@/components/ui/UserAvatar";
import { saveMyAvatar, clearProfileCache } from "@/lib/userProfiles";

export default function ProfilePage() {
  const router = useRouter();
  const { uid, userEmail, activeRole, activeOrgId } = useRole();
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<Array<{ org_id: string; org_name: string; role: string }>>([]);
  const [hasAvatar, setHasAvatar] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // One photo: upload, then point the profile at it. Safe to repeat (a new
  // path each time, and the profile just points at the latest).
  const uploadAvatar = async (file: File) => {
    if (!uid) return;
    if (!file.type.startsWith("image/")) { setAvatarError("Choose an image file."); return; }
    if (file.size > 5 * 1024 * 1024) { setAvatarError("Keep the photo under 5 MB."); return; }
    setAvatarBusy(true); setAvatarError(null); setAvatarFile(file);
    try {
      await tryUpload(file.name, () => saveMyAvatar(uid, file), {
        onRetried: () => { clearProfileCache(); setHasAvatar(true); setAvatarFile(null); setAvatarError(null); },
      });
      clearProfileCache(); setHasAvatar(true); setAvatarFile(null);
    } catch (err) { setAvatarError(`The photo didn't upload: ${(err as Error).message}`); }
    finally { setAvatarBusy(false); }
  };
  const avatarDrag = useFileDrag((files) => { if (files[0]) void uploadAvatar(files[0]); }, avatarBusy);

  useEffect(() => {
    if (!uid) return;
    (async () => {
      setLoading(true);
      try {
        // Display name + avatar from users
        const { data: u, error: uErr } = await supabase
          .from("users").select("display_name, avatar_path").eq("id", uid).maybeSingle();
        if (uErr) throw uErr;
        setDisplayName((u?.display_name as string) ?? "");
        setHasAvatar(!!(u as { avatar_path?: string | null } | null)?.avatar_path);
        // Org memberships with org name
        const { data: members, error: mErr } = await supabase
          .from("org_members")
          .select("org_id, role, orgs ( name )")
          .eq("uid", uid)
          .eq("status", "active");
        if (mErr) throw mErr;
        setLoadFailed(false);
        setOrgs(((members ?? []) as unknown as Array<{ org_id: string; role: string; orgs: { name: string } | { name: string }[] | null }>).map((m) => {
          const o = m.orgs;
          const name = Array.isArray(o) ? (o[0]?.name ?? "(unknown)") : (o?.name ?? "(unknown)");
          return { org_id: m.org_id, org_name: name, role: m.role };
        }));
      } catch (e) {
        setLoadFailed(true);
        setError(`Couldn't load your profile: ${(e as Error).message}`);
      } finally { setLoading(false); }
    })();
  }, [uid]);

  const save = async () => {
    if (!uid) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const { error: upsertErr } = await supabase.from("users")
        .upsert({ id: uid, display_name: displayName.trim() || null, updated_at: new Date().toISOString() }, { onConflict: "id" });
      if (upsertErr) throw upsertErr;
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  const handleSignOut = async () => {
    setPreferMicrosoft(false);
    await supabase.auth.signOut();
    router.push("/");
  };

  if (loading) {
    return <PageShell width="form"><PageHero kicker="Your profile" title="Your profile" size="md" overlap={false} /><LoadingBlock what="your profile" /></PageShell>;
  }

  return (
    <PageShell width="form">
        <PageHero
          kicker="Your profile"
          size="md"
          title={`Signed in as ${displayName.trim() || (userEmail ? userEmail.split("@")[0] : "you")}.`}
          sub={`${activeRole ? `${activeRole} · ` : ""}${orgs.length} workspace${orgs.length === 1 ? "" : "s"}${userEmail ? ` · ${userEmail}` : ""}`}
        />

        <PageBody>
        {/* Identity */}
        <Card label="Identity">
          {error && (
            <p role="alert" className="mb-3 text-[13px] text-red-700 dark:text-red-400 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </p>
          )}

          {/* Avatar — photo if set, otherwise initials from the display name
              (Grant Getzfrid → GG). This is the face shown everywhere. */}
          <div {...avatarDrag.bind} className={`flex items-center gap-4 mb-4 rounded-xl ${avatarDrag.ring}`}>
            {avatarDrag.over ? (
              <div className="w-16 h-16 rounded-xl grid place-items-center text-[11px] font-bold text-[var(--color-text)] text-center">{avatarDrag.say}</div>
            ) : (
              <UserAvatar uid={uid} name={displayName || undefined} email={userEmail} size={64} rounded="xl" />
            )}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={avatarBusy}
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-semibold border border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] transition-colors disabled:opacity-50"
                >
                  {avatarBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
                  {hasAvatar ? "Change photo" : "Add photo"}
                </button>
                {hasAvatar && (
                  <button
                    onClick={async () => {
                      if (!uid) return;
                      setAvatarBusy(true); setAvatarError(null);
                      try { await saveMyAvatar(uid, null); clearProfileCache(); setHasAvatar(false); }
                      catch (e) { setAvatarError(`Couldn't remove the photo: ${(e as Error).message}`); }
                      finally { setAvatarBusy(false); }
                    }}
                    type="button"
                    disabled={avatarBusy}
                    className="inline-flex items-center gap-1 h-9 px-2.5 rounded-lg text-[13px] font-semibold text-rose-600 hover:bg-[var(--color-surface-2)] transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Remove
                  </button>
                )}
              </div>
              {avatarFile ? (
                <div className="flex items-center gap-2">
                  <FileThumb file={avatarFile} size={28} />
                  <span className="min-w-0">
                    <span className="block text-[11px] font-bold text-[var(--color-text)] truncate max-w-[12rem]">{avatarFile.name}</span>
                    <span className="block text-[11px] text-[var(--color-text-muted)]">{formatBytes(avatarFile.size)}{avatarBusy ? " · uploading…" : ""}</span>
                  </span>
                  {!avatarBusy && avatarError && (
                    <button type="button" onClick={() => void uploadAvatar(avatarFile)} className="px-2 py-1 rounded-md border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">Try again</button>
                  )}
                </div>
              ) : (
                <div className="text-[12px] text-[var(--color-text-muted)]">
                  No photo? Your initials show instead, so set your display name below.
                </div>
              )}
              {avatarError && <div role="alert" className="text-[11px] text-red-700 dark:text-red-400">{avatarError}</div>}
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void uploadAvatar(file);
                }}
              />
            </div>
          </div>

          <Row icon={Mail} label="Email" value={userEmail ?? "-"} mono />
          <div className="mt-3">
            <label htmlFor="profile-display-name" className="text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-[0.12em] inline-flex items-center gap-1">
              <Edit3 className="w-3 h-3" /> Display name
            </label>
            <Input
              id="profile-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your display name (defaults to email handle)"
              className="mt-1"
            />
          </div>
          <div className="mt-4 flex items-center justify-end gap-3">
            {saved && <span role="status" className="inline-flex items-center gap-1 text-[13px] font-bold text-emerald-700 dark:text-emerald-400"><Check className="w-3.5 h-3.5" /> Saved</span>}
            <button type="button" onClick={save} disabled={saving || loadFailed} className={heroPrimary}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save name
            </button>
          </div>
        </Card>

        {/* Workspaces */}
        <Card label="Workspaces">
          {orgs.length === 0 ? (
            <p className="text-[14px] text-[var(--color-text-muted)]">You aren&apos;t a member of any workspaces.</p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {orgs.map((o) => (
                <li key={o.org_id} className="py-2 flex items-center gap-3">
                  <Briefcase className="w-4 h-4 text-[var(--color-text-muted)]" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-bold text-[var(--color-text)] truncate">{o.org_name}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)] font-mono uppercase tracking-wider">{o.role}</div>
                  </div>
                  {o.org_id === activeOrgId && <span className="text-[11px] font-bold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-1.5 py-0.5 rounded">current</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Current session */}
        <Card label="Current session">
          <Row icon={Shield} label="Role" value={activeRole || "-"} />
        </Card>

        {/* Quick links */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Link
            href="/settings/notifications"
            className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-card)] p-4 flex items-center gap-3 hover-lift"
          >
            <div className="p-2.5 rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><Bell className="w-4 h-4" /></div>
            <div className="flex-1">
              <div className="text-[14px] font-bold text-[var(--color-text)]">Notification preferences</div>
              <div className="text-[13px] text-[var(--color-text-muted)]">What gets emailed to you, and when.</div>
            </div>
          </Link>
          <button
            type="button"
            onClick={handleSignOut}
            className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-card)] p-4 flex items-center gap-3 hover-lift text-left"
          >
            <div className="p-2.5 rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><LogOut className="w-4 h-4" /></div>
            <div className="flex-1">
              <div className="text-[14px] font-bold text-[var(--color-text)]">Sign out</div>
              <div className="text-[13px] text-[var(--color-text-muted)]">End your session on this device.</div>
            </div>
          </button>
        </div>
        </PageBody>
    </PageShell>
  );
}

function Row({ icon: Icon, label, value, mono }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <Icon className="w-4 h-4 text-[var(--color-text-faint)]" />
      <span className="text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-[0.12em] w-16">{label}</span>
      <span className={`text-[14px] text-[var(--color-text)] min-w-0 truncate ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
