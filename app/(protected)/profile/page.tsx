"use client";

// /profile — personal account page. Display name, email, role,
// org memberships, password change link, and quick links to the
// settings surfaces (notification prefs, sign out).

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, LogOut, Check, Camera, Loader2, UserRound, Building2 } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase, setPreferMicrosoft } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { Pill } from "@/components/admin/kit";
import LoadingBlock from "@/components/ui/LoadingBlock";
import FileThumb from "@/components/ui/FileThumb";
import { useFileDrag } from "@/hooks/useFileDrag";
import { tryUpload } from "@/lib/uploadRetry";

import UserAvatar from "@/components/ui/UserAvatar";
import { saveMyAvatar, clearProfileCache } from "@/lib/userProfiles";
import { formatBytes } from "@/lib/formatBytes";

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
    return <PageShell width="form"><PageHero kicker="Your profile" title="Your profile" size="md" /><PageBody><Card><LoadingBlock what="your profile" className="border-0 p-0" /></Card></PageBody></PageShell>;
  }

  const shownName = displayName.trim() || (userEmail ? userEmail.split("@")[0] : "you");
  return (
    <PageShell width="form">
        <PageHero
          kicker="Your profile"
          size="md"
          title={`Signed in as ${shownName}.`}
          sub={userEmail ?? undefined}
          facts={[
            { label: "Role", value: activeRole || "None" },
            { label: "Workspaces", value: orgs.length },
          ]}
          tools={
            <>
              <Link href="/settings/notifications" className={heroQuiet} aria-label="Notification settings">
                <Bell className="w-4 h-4" /><span className="max-sm:hidden">Notifications</span>
              </Link>
              <button type="button" onClick={handleSignOut} className={heroQuiet} aria-label="Sign out">
                <LogOut className="w-4 h-4" /><span className="max-sm:hidden">Sign out</span>
              </button>
            </>
          }
        />

        <PageBody>
        <Card label={<span className="inline-flex items-center gap-2.5"><span aria-hidden className="ui-icon-tile is-sm is-solid"><UserRound className="w-4 h-4" /></span>Your details</span>} pad={false}>
          <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="px-5 sm:px-6 py-5 space-y-5">
              {error && (
                <p role="alert" className="relative pl-3 text-[15px] text-[var(--color-text)]">
                  <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />{error}
                </p>
              )}

              {/* Photo if set, otherwise initials from the display name. This
                  is the face shown everywhere. Drop an image here to use it. */}
              <div>
                <div className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">Photo</div>
                <div {...avatarDrag.bind} className={`flex items-center gap-4 rounded-md ${avatarDrag.ring}`}>
                  {avatarDrag.over ? (
                    <div className="w-16 h-16 rounded-xl grid place-items-center border border-dashed border-[var(--color-border-strong)] text-[13px] font-semibold text-[var(--color-text)] text-center">{avatarDrag.say}</div>
                  ) : (
                    <UserAvatar uid={uid} name={displayName || undefined} email={userEmail} size={64} rounded="xl" />
                  )}
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-3">
                      <button type="button" onClick={() => avatarInputRef.current?.click()} disabled={avatarBusy} className={heroQuiet}>
                        {avatarBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
                        {hasAvatar ? "Change photo" : "Add photo"}
                      </button>
                      {hasAvatar && (
                        <button
                          type="button"
                          disabled={avatarBusy}
                          onClick={async () => {
                            if (!uid) return;
                            setAvatarBusy(true); setAvatarError(null);
                            try { await saveMyAvatar(uid, null); clearProfileCache(); setHasAvatar(false); }
                            catch (e) { setAvatarError(`Couldn't remove the photo: ${(e as Error).message}`); }
                            finally { setAvatarBusy(false); }
                          }}
                          className="text-[14px] text-[var(--state-overdue)] hover:underline underline-offset-2 disabled:opacity-50"
                        >
                          Remove photo
                        </button>
                      )}
                    </div>
                    {avatarFile ? (
                      <div className="flex items-center gap-2">
                        <FileThumb file={avatarFile} size={28} />
                        <span className="min-w-0 text-[13px]">
                          <span className="block font-semibold text-[var(--color-text)] truncate max-w-[14rem]">{avatarFile.name}</span>
                          <span className="block text-[var(--color-text-muted)]">{formatBytes(avatarFile.size)}{avatarBusy ? ", uploading…" : ""}</span>
                        </span>
                        {!avatarBusy && avatarError && (
                          <button type="button" onClick={() => void uploadAvatar(avatarFile)} className={`${heroQuiet} h-8`}>Try again</button>
                        )}
                      </div>
                    ) : (
                      <p className="text-[13px] text-[var(--color-text-muted)]">No photo shows your initials. Under 5 MB.</p>
                    )}
                    {avatarError && <p role="alert" className="text-[13px] font-semibold text-[var(--state-overdue)]">{avatarError}</p>}
                  </div>
                </div>
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

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div>
                  <label htmlFor="profile-display-name" className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">Display name</label>
                  <input
                    id="profile-display-name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={userEmail ? userEmail.split("@")[0] : "Your name"}
                    aria-describedby="profile-name-hint"
                    className="w-full h-10 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[15px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40"
                  />
                  <p id="profile-name-hint" className="mt-1 text-[13px] text-[var(--color-text-muted)]">Blank uses the first part of your email.</p>
                </div>
                <div>
                  <div className="block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">Email</div>
                  <div className="h-10 flex items-center text-[15px] text-[var(--color-text)] truncate">{userEmail ?? "None"}</div>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-5 sm:px-6 py-3 border-t border-[var(--color-border)]">
              {saved && <span role="status" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text)]"><Check className="w-4 h-4 text-[var(--state-released)]" /> Saved</span>}
              <button type="submit" disabled={saving || loadFailed} className={heroPrimary}>
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                Save
              </button>
            </div>
          </form>
        </Card>

        <Card label={<span className="inline-flex items-center gap-2.5"><span aria-hidden className="ui-icon-tile is-sm is-solid"><Building2 className="w-4 h-4" /></span>Workspaces{orgs.length > 1 ? <span className="ui-count is-solid">{orgs.length}</span> : null}</span>} pad={false} className="overflow-hidden">
          {orgs.length === 0 ? (
            <p className="px-5 py-4 text-[15px] text-[var(--color-text-muted)]">You aren&apos;t in any workspace.</p>
          ) : (
            <table className="w-full text-[15px]">
              <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
                <tr>
                  <th className="font-semibold px-4 sm:px-5 h-10 w-full">Workspace</th>
                  <th className="font-semibold px-4 h-10 whitespace-nowrap">Your role</th>
                  <th className="h-10 pr-4 sm:pr-5"><span className="sr-only">Current</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {orgs.map((o) => (
                  <tr key={o.org_id}>
                    <td className="px-4 sm:px-5 py-3 font-semibold text-[var(--color-text)] max-w-0">
                      <span className="flex items-center gap-3 min-w-0">
                        <span aria-hidden className={`ui-icon-tile is-sm ${o.org_id === activeOrgId ? "is-solid" : ""}`}><Building2 className="w-4 h-4" /></span>
                        <span className="truncate">{o.org_name}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap"><span className="ui-tag">{o.role}</span></td>
                    <td className="pr-4 sm:pr-5 py-3 whitespace-nowrap text-right">{o.org_id === activeOrgId && <Pill tone="solid">Current</Pill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        </PageBody>
    </PageShell>
  );
}
