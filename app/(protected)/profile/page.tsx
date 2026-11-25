"use client";

// /profile: your own account. Your photo and the name people see, your
// email, the password section, the workspaces you're in and your role in
// each, and the two things people come here for (notification settings,
// sign out) as quiet tools in the header.

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, LogOut, Camera, Loader2, CircleAlert } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase, setPreferMicrosoft } from "@/lib/supabase";
import { signOutHere } from "@/lib/membershipClient";
import { useRouter } from "next/navigation";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroQuiet } from "@/components/ui/PageHero";
import { Button } from "@/components/ui/Button";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import ChangePassword from "@/components/admin/ChangePassword";
import { StatusTag, field, label as labelCls, btnLink, tbl } from "@/components/admin/kit";
import FileThumb from "@/components/ui/FileThumb";
import { useFileDrag } from "@/hooks/useFileDrag";
import { tryUpload } from "@/lib/uploadRetry";
import { friendlyError } from "@/lib/friendlyError";
import { appConfirm } from "@/components/providers/DialogProvider";

import UserAvatar from "@/components/ui/UserAvatar";
import { saveMyAvatar, clearProfileCache } from "@/lib/userProfiles";
import { formatBytes } from "@/lib/formatBytes";

export default function ProfilePage() {
  const router = useRouter();
  const { uid, userEmail, activeOrgId } = useRole();
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [orgs, setOrgs] = useState<Array<{ org_id: string; org_name: string; role: string }>>([]);
  const [hasAvatar, setHasAvatar] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);

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
    } catch (err) { setAvatarError(`The photo didn't upload. ${friendlyError(err)}`); }
    finally { setAvatarBusy(false); }
  };
  const avatarDrag = useFileDrag((files) => { if (files[0]) void uploadAvatar(files[0]); }, avatarBusy);

  const removeAvatar = async () => {
    if (!uid) return;
    if (!(await appConfirm({ title: "Remove your photo?", message: "Your initials show in its place.", confirmLabel: "Remove photo", tone: "danger" }))) return;
    setAvatarBusy(true); setAvatarError(null);
    try { await saveMyAvatar(uid, null); clearProfileCache(); setHasAvatar(false); }
    catch (e) { setAvatarError(`The photo wasn't removed. ${friendlyError(e)}`); }
    finally { setAvatarBusy(false); }
  };

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
        setLoadError(null);
        setOrgs(((members ?? []) as unknown as Array<{ org_id: string; role: string; orgs: { name: string } | { name: string }[] | null }>).map((m) => {
          const o = m.orgs;
          const name = Array.isArray(o) ? (o[0]?.name ?? "") : (o?.name ?? "");
          return { org_id: m.org_id, org_name: name, role: m.role };
        }));
      } catch (e) {
        setLoadError(e ?? "error");
      } finally { setLoading(false); }
    })();
  }, [uid, reload]);

  const save = async () => {
    if (!uid) return;
    setSaving(true); setSaveError(null); setSaved(false);
    try {
      // The person's own profile, which their admin's add made: changed, never made here.
      const { error: upsertErr } = await supabase.from("users")
        .update({ display_name: displayName.trim() || null, updated_at: new Date().toISOString() }).eq("id", uid);
      if (upsertErr) throw upsertErr;
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (e) { setSaveError(`Not saved. ${friendlyError(e)}`); }
    finally { setSaving(false); }
  };

  const handleSignOut = async () => {
    setPreferMicrosoft(false);
    // This device is signed out at once, even when the server is busy
    // (plant PCs are shared); everywhere else follows when it answers.
    await signOutHere();
    router.push("/");
  };

  if (loading) {
    return (
      <PageShell width="form">
        <PageHero kicker="Your profile" title="Your profile" size="md" />
        <PageBody><Card label="Your details"><SkeletonText lines={4} /></Card></PageBody>
      </PageShell>
    );
  }

  const shownName = displayName.trim() || (userEmail ? userEmail.split("@")[0] : "you");
  return (
    <PageShell width="form">
        <PageHero
          kicker="Your profile"
          size="md"
          title={`Signed in as ${shownName}.`}
          // Your role and workspaces are in the Workspaces list below, so
          // the header doesn't repeat them as a row of facts.
          sub={userEmail ?? undefined}
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
        {!!loadError && <ErrorNote error={loadError} title="Your profile didn't load." onRetry={() => setReload((n) => n + 1)} />}

        <Card label="Your details" pad={false}>
          <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="px-5 sm:px-6 py-5 space-y-6">
              {/* Photo if set, otherwise initials from the display name. This
                  is the face shown everywhere. Drop an image here to use it. */}
              <div>
                <div className={labelCls}>Photo</div>
                <div {...avatarDrag.bind} className={`flex items-center gap-4 rounded-lg ${avatarDrag.ring}`}>
                  {avatarDrag.over ? (
                    <div className="w-16 h-16 rounded-panel grid place-items-center border border-dashed border-[var(--color-border-strong)] text-body font-medium text-[var(--color-text)] text-center">{avatarDrag.say}</div>
                  ) : (
                    <UserAvatar uid={uid} name={displayName || undefined} email={userEmail} size={64} rounded="xl" />
                  )}
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <button type="button" onClick={() => avatarInputRef.current?.click()} disabled={avatarBusy} className={heroQuiet}>
                        {avatarBusy ? <Loader2 className="w-4 h-4 motion-safe:animate-spin" /> : <Camera className="w-4 h-4" />}
                        {hasAvatar ? "Change photo" : "Add photo"}
                      </button>
                      {hasAvatar && (
                        <button type="button" disabled={avatarBusy} onClick={() => void removeAvatar()}
                          className={`${btnLink} !text-[var(--color-text-muted)] hover:!text-[var(--color-text)]`}>
                          Remove photo
                        </button>
                      )}
                    </div>
                    {avatarFile ? (
                      <div className="flex items-center gap-2">
                        <FileThumb file={avatarFile} size={28} />
                        <span className="min-w-0 text-body">
                          <span className="block font-medium text-[var(--color-text)] truncate max-w-[14rem]">{avatarFile.name}</span>
                          <span className="block text-[var(--color-text-muted)]">{formatBytes(avatarFile.size)}{avatarBusy ? ", uploading" : ""}</span>
                        </span>
                        {!avatarBusy && avatarError && (
                          <button type="button" onClick={() => void uploadAvatar(avatarFile)} className={btnLink}>Try again</button>
                        )}
                      </div>
                    ) : (
                      <p className="text-body text-[var(--color-text-muted)]">Without a photo, your initials show. Under 5 MB.</p>
                    )}
                    {avatarError && <p role="alert" className="text-body font-medium text-[var(--state-overdue-text)] flex items-start gap-1.5"><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-px" /><span>{avatarError}</span></p>}
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
                  <label htmlFor="profile-display-name" className={labelCls}>Display name</label>
                  <input
                    id="profile-display-name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={userEmail ? userEmail.split("@")[0] : "Your name"}
                    autoComplete="name"
                    aria-describedby="profile-name-hint"
                    className={field}
                  />
                  <p id="profile-name-hint" className="mt-1.5 text-body text-[var(--color-text-muted)]">Blank uses the first part of your email.</p>
                </div>
                <div>
                  <div className={labelCls}>Email</div>
                  <div className="h-10 flex items-center text-reading text-[var(--color-text)] truncate">{userEmail ?? "None"}</div>
                </div>
              </div>
              {saveError && <p role="alert" className="text-body font-medium text-[var(--state-overdue-text)] flex items-start gap-1.5"><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-px" /><span>{saveError}</span></p>}
            </div>
            <div className="flex items-center justify-end gap-3 px-5 sm:px-6 py-3 border-t border-[var(--color-border)]">
              <Button type="submit" loading={saving} done={saved} doneLabel="Saved" disabled={!!loadError}>{saving ? "Saving" : "Save"}</Button>
            </div>
          </form>
        </Card>

        <ChangePassword />

        <section aria-label="Workspaces" className="min-w-0">
          <div className="flex items-end gap-2 mb-3 min-h-8">
            <h2 className="font-display text-section font-semibold text-[var(--color-text)]">Workspaces</h2>
            {orgs.length > 1 && <span className="mb-0.5 text-body tabular-nums text-[var(--color-text-muted)]">{orgs.length}</span>}
          </div>
          {orgs.length === 0 ? (
            <p className="rounded-panel border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-reading text-[var(--color-text-muted)]">You aren&apos;t in a workspace. Your workspace admin adds you.</p>
          ) : (
            <div className={tbl.wrap}>
              <table className={tbl.table}>
                <thead className={tbl.thead}>
                  <tr>
                    <th className={`${tbl.th} w-full`}>Workspace</th>
                    <th className={tbl.th}>Your role</th>
                    <th className={tbl.th}><span className="sr-only">Current</span></th>
                  </tr>
                </thead>
                {/* A few workspaces: space between them, no rule under each. */}
                <tbody className="ui-stagger">
                  {orgs.map((o) => (
                    <tr key={o.org_id}>
                      <td className={`${tbl.td} font-medium text-reading text-[var(--color-text)] max-w-0`}>
                        <span className="block truncate">{o.org_name || <span className="font-normal text-[var(--color-text-muted)]">Name not set</span>}</span>
                      </td>
                      <td className={`${tbl.td} whitespace-nowrap`}><span className="ui-tag">{o.role}</span></td>
                      <td className={`${tbl.td} whitespace-nowrap text-right`}>{o.org_id === activeOrgId && <StatusTag tone="good" colored={false}>Current</StatusTag>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        </PageBody>
    </PageShell>
  );
}
