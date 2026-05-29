"use client";

// /profile — personal account page. Display name, email, role,
// org memberships, password change link, and quick links to the
// settings surfaces (notification prefs, sign out).

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  User as UserIcon, Mail, Shield, Bell, LogOut, Loader2, Save,
  AlertTriangle, Check, Briefcase, Edit3,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";

export default function ProfilePage() {
  const router = useRouter();
  const { uid, userEmail, activeRole, activeOrgId } = useRole();
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<Array<{ org_id: string; org_name: string; role: string }>>([]);

  useEffect(() => {
    if (!uid) return;
    (async () => {
      setLoading(true);
      try {
        // Display name from users
        const { data: u } = await supabase
          .from("users").select("display_name").eq("id", uid).maybeSingle();
        setDisplayName((u?.display_name as string) ?? "");
        // Org memberships with org name
        const { data: members } = await supabase
          .from("org_members")
          .select("org_id, role, orgs ( name )")
          .eq("uid", uid)
          .eq("status", "active");
        setOrgs(((members ?? []) as unknown as Array<{ org_id: string; role: string; orgs: { name: string } | { name: string }[] | null }>).map((m) => {
          const o = m.orgs;
          const name = Array.isArray(o) ? (o[0]?.name ?? "(unknown)") : (o?.name ?? "(unknown)");
          return { org_id: m.org_id, org_name: name, role: m.role };
        }));
      } catch (e) {
        setError((e as Error).message);
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
    await supabase.auth.signOut();
    router.push("/");
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
        <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3 mb-6">
          <UserIcon className="w-7 h-7 text-slate-500" /> My Profile
        </h1>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* Identity */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-4">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Identity</div>
          <Row icon={Mail} label="Email" value={userEmail ?? "—"} mono />
          <div className="mt-3">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest inline-flex items-center gap-1">
              <Edit3 className="w-2.5 h-2.5" /> Display name
            </label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your display name (defaults to email handle)"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm"
            />
          </div>
          <div className="mt-3 flex items-center justify-end gap-3">
            {saved && <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700"><Check className="w-3.5 h-3.5" /> Saved</span>}
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save
            </button>
          </div>
        </div>

        {/* Workspaces */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-4">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Workspaces</div>
          {orgs.length === 0 ? (
            <p className="text-xs text-slate-500 italic">You aren&apos;t a member of any workspaces.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {orgs.map((o) => (
                <li key={o.org_id} className="py-2 flex items-center gap-3">
                  <Briefcase className="w-4 h-4 text-indigo-600" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-slate-900 truncate">{o.org_name}</div>
                    <div className="text-[10px] text-slate-500 font-mono uppercase tracking-wider">{o.role}</div>
                  </div>
                  {o.org_id === activeOrgId && <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">active</span>}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Current session */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-4">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Current session</div>
          <Row icon={Shield} label="Role" value={activeRole || "—"} />
        </div>

        {/* Quick links */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Link
            href="/settings/notifications"
            className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex items-center gap-3 hover:border-slate-300 transition-colors"
          >
            <div className="p-2.5 rounded-lg bg-amber-50 text-amber-700 border border-amber-200"><Bell className="w-4 h-4" /></div>
            <div className="flex-1">
              <div className="text-sm font-bold text-slate-900">Notification preferences</div>
              <div className="text-[11px] text-slate-500">What gets emailed to you, and when.</div>
            </div>
          </Link>
          <button
            onClick={handleSignOut}
            className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex items-center gap-3 hover:border-rose-300 hover:bg-rose-50/30 transition-colors text-left"
          >
            <div className="p-2.5 rounded-lg bg-rose-50 text-rose-700 border border-rose-200"><LogOut className="w-4 h-4" /></div>
            <div className="flex-1">
              <div className="text-sm font-bold text-slate-900">Sign out</div>
              <div className="text-[11px] text-slate-500">End your session on this device.</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ icon: Icon, label, value, mono }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <Icon className="w-4 h-4 text-slate-400" />
      <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest w-16">{label}</span>
      <span className={`text-sm text-slate-900 ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
