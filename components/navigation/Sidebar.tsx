"use client";

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import {
  LayoutDashboard,
  Settings,
  Users,
  Layers,
  Shield,
  LogOut,
  Server,
  FileText,
  BarChart3,
  Briefcase,
  KeyRound,
  Tag,
  Factory,
  AlertOctagon,
  LayoutGrid,
  StickyNote,
  ScrollText,
  Inbox,
  Activity,
} from 'lucide-react';
import { useTicketNotifications } from '@/hooks/useTicketNotifications';
import NotificationBell from '@/components/notifications/NotificationBell';

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { activeRole, userEmail, activeOrgId, setActiveOrgId, uid } = useRole();
  const { actionRequiredCount, unreadCount } = useTicketNotifications();
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string; type?: string }>>([]);
  const [orgLoading, setOrgLoading] = useState(false);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/');
  };

  const isActive = (path: string) => pathname?.startsWith(path);

  useEffect(() => {
    if (!uid) return;
    let alive = true;

    const loadOrgs = async () => {
      setOrgLoading(true);
      try {
        const { data: memberships } = await supabase
          .from("org_members")
          .select("org_id, orgs(id, name, type)")
          .eq("uid", uid)
          .eq("status", "active");

        if (alive && memberships) {
          const results = (memberships as unknown as Array<{
            org_id: string;
            orgs: { id: string; name: string; type?: string } | null;
          }>)
            .filter((m) => m.orgs)
            .map((m) => ({
              id: m.orgs!.id,
              name: m.orgs!.name,
              type: m.orgs!.type,
            }));
          setOrgs(results);
        }
      } catch (e) {
        console.error("Failed to load org list", e);
        if (alive) setOrgs([]);
      } finally {
        if (alive) setOrgLoading(false);
      }
    };

    loadOrgs();

    return () => {
      alive = false;
    };
  }, [uid]);

  const orgOptions = useMemo(() => {
    return orgs.slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [orgs]);

  return (
    <div className="w-64 bg-slate-900 h-screen flex flex-col border-r border-slate-800 text-slate-300">
      
      {/* BRAND HEADER */}
      <div className="h-16 flex items-center px-6 border-b border-slate-800 shrink-0">
        <div className="w-8 h-8 bg-orange-600 rounded-lg flex items-center justify-center mr-3 shadow-lg shadow-orange-900/20">
          <LayoutDashboard className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="font-bold text-white tracking-tight text-lg leading-none">Manufacturing<span className="text-orange-500">OS</span></h1>
          <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider mt-1">Enterprise Platform</p>
        </div>
      </div>

      {/* NAVIGATION CONTENT */}
      <div className="flex-1 overflow-y-auto py-6 space-y-8 custom-scrollbar">
        
        {/* WORKSPACE SELECTOR — only shown for multi-org users */}
        {orgOptions.length > 1 && (
          <div className="px-4">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 px-1">Workspace</p>
            <select
              value={activeOrgId ?? ""}
              onChange={(e) => setActiveOrgId(e.target.value || null)}
              className="w-full bg-slate-950 border border-slate-800 text-xs font-bold text-slate-300 rounded-lg px-3 py-2.5 focus:ring-1 focus:ring-orange-500/50 focus:border-orange-500/50 outline-none transition-all shadow-sm cursor-pointer hover:border-slate-700"
              disabled={orgLoading}
            >
              {orgOptions.map((org) => (
                <option key={org.id} value={org.id}>{org.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* WORKSPACE NAME — shown for single-org users */}
        {orgOptions.length === 1 && activeOrgId && (
          <div className="px-4">
            <div className="bg-slate-800/60 rounded-lg px-3 py-2.5 border border-slate-700/50">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">Workspace</p>
              <p className="text-xs font-bold text-white truncate">{orgOptions[0].name}</p>
            </div>
          </div>
        )}
        
        {/* MODULE 1: DCS (THE VAULT) */}
        <div className="px-4">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 px-2 flex items-center">
            <Server className="w-3 h-3 mr-1.5" /> System of Record
          </p>

          <Link href="/inbox">
            <div className={`flex items-center px-3 py-3 rounded-xl transition-all group border border-transparent mb-2 ${isActive('/inbox') ? 'bg-orange-600 text-white shadow-lg shadow-orange-900/20 border-orange-500' : 'hover:bg-slate-800 hover:text-white hover:border-slate-700'}`}>
              <Inbox className={`w-5 h-5 mr-3 ${isActive('/inbox') ? 'text-white' : 'text-orange-500 group-hover:text-orange-400'}`} />
              <div className="flex flex-col">
                <span className="text-sm font-bold">My Inbox</span>
                <span className={`text-[10px] ${isActive('/inbox') ? 'text-orange-100' : 'text-slate-500 group-hover:text-slate-400'}`}>Everything for you</span>
              </div>
            </div>
          </Link>

          <Link href="/documents">
            <div className={`flex items-center px-3 py-3 rounded-xl transition-all group border border-transparent ${isActive('/documents') ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20 border-blue-500' : 'hover:bg-slate-800 hover:text-white hover:border-slate-700'}`}>
              <Shield className={`w-5 h-5 mr-3 ${isActive('/documents') ? 'text-white' : 'text-blue-500 group-hover:text-blue-400'}`} />
              <div className="flex flex-col">
                <span className="text-sm font-bold">Document Control</span>
                <span className={`text-[10px] ${isActive('/documents') ? 'text-blue-100' : 'text-slate-500 group-hover:text-slate-400'}`}>The Vault</span>
              </div>
            </div>
          </Link>

          <Link href="/projects" className="mt-2 block">
            <div className={`flex items-center px-3 py-3 rounded-xl transition-all group border border-transparent ${isActive('/projects') ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-900/20 border-indigo-500' : 'hover:bg-slate-800 hover:text-white hover:border-slate-700'}`}>
              <Briefcase className={`w-5 h-5 mr-3 ${isActive('/projects') ? 'text-white' : 'text-indigo-400 group-hover:text-indigo-300'}`} />
              <div className="flex flex-col">
                <span className="text-sm font-bold">Projects</span>
                <span className={`text-[10px] ${isActive('/projects') ? 'text-indigo-100' : 'text-slate-500 group-hover:text-slate-400'}`}>Who&apos;s working on what</span>
              </div>
            </div>
          </Link>

          <Link href="/checkouts" className="mt-2 block">
            <div className={`flex items-center px-3 py-3 rounded-xl transition-all group border border-transparent ${isActive('/checkouts') ? 'bg-amber-600 text-white shadow-lg shadow-amber-900/20 border-amber-500' : 'hover:bg-slate-800 hover:text-white hover:border-slate-700'}`}>
              <KeyRound className={`w-5 h-5 mr-3 ${isActive('/checkouts') ? 'text-white' : 'text-amber-400 group-hover:text-amber-300'}`} />
              <div className="flex flex-col">
                <span className="text-sm font-bold">Active Checkouts</span>
                <span className={`text-[10px] ${isActive('/checkouts') ? 'text-amber-100' : 'text-slate-500 group-hover:text-slate-400'}`}>Every locked file org-wide</span>
              </div>
            </div>
          </Link>

          <Link href="/whiteboard" className="mt-2 block">
            <div className={`flex items-center px-3 py-3 rounded-xl transition-all group border border-transparent ${isActive('/whiteboard') ? 'bg-cyan-600 text-white shadow-lg shadow-cyan-900/20 border-cyan-500' : 'hover:bg-slate-800 hover:text-white hover:border-slate-700'}`}>
              <LayoutGrid className={`w-5 h-5 mr-3 ${isActive('/whiteboard') ? 'text-white' : 'text-cyan-400 group-hover:text-cyan-300'}`} />
              <div className="flex flex-col">
                <span className="text-sm font-bold">Whiteboard</span>
                <span className={`text-[10px] ${isActive('/whiteboard') ? 'text-cyan-100' : 'text-slate-500 group-hover:text-slate-400'}`}>Equipment by state</span>
              </div>
            </div>
          </Link>

          <Link href="/scratchpad" className="mt-2 block">
            <div className={`flex items-center px-3 py-3 rounded-xl transition-all group border border-transparent ${isActive('/scratchpad') ? 'bg-amber-600 text-white shadow-lg shadow-amber-900/20 border-amber-500' : 'hover:bg-slate-800 hover:text-white hover:border-slate-700'}`}>
              <StickyNote className={`w-5 h-5 mr-3 ${isActive('/scratchpad') ? 'text-white' : 'text-amber-400 group-hover:text-amber-300'}`} />
              <div className="flex flex-col">
                <span className="text-sm font-bold">Scratchpad</span>
                <span className={`text-[10px] ${isActive('/scratchpad') ? 'text-amber-100' : 'text-slate-500 group-hover:text-slate-400'}`}>Notes & open tasks</span>
              </div>
            </div>
          </Link>

          <Link href="/activity" className="mt-2 block">
            <div className={`flex items-center px-3 py-3 rounded-xl transition-all group border border-transparent ${isActive('/activity') ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/20 border-emerald-500' : 'hover:bg-slate-800 hover:text-white hover:border-slate-700'}`}>
              <Activity className={`w-5 h-5 mr-3 ${isActive('/activity') ? 'text-white' : 'text-emerald-400 group-hover:text-emerald-300'}`} />
              <div className="flex flex-col">
                <span className="text-sm font-bold">Activity Feed</span>
                <span className={`text-[10px] ${isActive('/activity') ? 'text-emerald-100' : 'text-slate-500 group-hover:text-slate-400'}`}>What&apos;s happening</span>
              </div>
            </div>
          </Link>
        </div>

        {/* MODULE 2: WORKFLOWS (THE KITCHEN) */}
        <div className="px-4">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 px-2 flex items-center">
            <FileText className="w-3 h-3 mr-1.5" /> Active Workflows
          </p>
          
          <Link href="/requests">
            <div className={`flex items-center justify-between px-3 py-3 rounded-xl transition-all group border border-transparent ${isActive('/requests') ? 'bg-orange-600 text-white shadow-lg shadow-orange-900/20 border-orange-500' : 'hover:bg-slate-800 hover:text-white hover:border-slate-700'}`}>
              <div className="flex items-center">
                <Layers className={`w-5 h-5 mr-3 ${isActive('/requests') ? 'text-white' : 'text-orange-500 group-hover:text-orange-400'}`} />
                <div className="flex flex-col">
                  <span className="text-sm font-bold">Request Portal</span>
                  <span className={`text-[10px] ${isActive('/requests') ? 'text-orange-100' : 'text-slate-500 group-hover:text-slate-400'}`}>Work Orders & Tasks</span>
                </div>
              </div>
              
              {/* NOTIFICATION BADGES */}
              <div className="flex flex-col gap-1 items-end">
                {actionRequiredCount > 0 && (
                  <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[10px] font-bold text-white bg-red-600 rounded-full shadow-sm animate-pulse">
                    {actionRequiredCount}
                  </span>
                )}
                {actionRequiredCount === 0 && unreadCount > 0 && (
                  <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[10px] font-bold text-white bg-blue-500 rounded-full shadow-sm">
                    {unreadCount}
                  </span>
                )}
              </div>
            </div>
          </Link>
        </div>

        {/* MODULE 3: ADMIN (GOD MODE) */}
        {['Admin', 'DocCtrl'].includes(activeRole) && (
          <div className="px-4">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 px-2">Configuration</p>
            <div className="space-y-1">
              <Link href="/admin/analytics">
                <div className={`flex items-center px-3 py-2.5 rounded-lg transition-all group ${isActive('/admin/analytics') ? 'bg-slate-800 text-white' : 'hover:bg-slate-800 hover:text-white'}`}>
                  <BarChart3 className="w-5 h-5 mr-3 text-slate-400 group-hover:text-white" />
                  <span className="text-sm font-medium">Metrics Analysis</span>
                </div>
              </Link>
              <Link href="/admin/users">
                <div className={`flex items-center px-3 py-2.5 rounded-lg transition-all group ${isActive('/admin/users') ? 'bg-slate-800 text-white' : 'hover:bg-slate-800 hover:text-white'}`}>
                  <Users className="w-5 h-5 mr-3 text-slate-400 group-hover:text-white" />
                  <span className="text-sm font-medium">User Management</span>
                </div>
              </Link>
                          <Link href="/admin/libraries">
                            <div className={`flex items-center px-3 py-2.5 rounded-lg transition-all group ${isActive('/admin/libraries') ? 'bg-slate-800 text-white' : 'hover:bg-slate-800 hover:text-white'}`}>
                              <Settings className="w-5 h-5 mr-3 text-slate-400 group-hover:text-white" />
                              <span className="text-sm font-medium">Library Config</span>
                            </div>
                          </Link>
                          <Link href="/admin/requests">
                            <div className={`flex items-center px-3 py-2.5 rounded-lg transition-all group ${isActive('/admin/requests') ? 'bg-slate-800 text-white' : 'hover:bg-slate-800 hover:text-white'}`}>
                              <FileText className="w-5 h-5 mr-3 text-slate-400 group-hover:text-white" />
                              <span className="text-sm font-medium">Request Forms</span>
                            </div>
                          </Link>
                          <Link href="/admin/assets">
                            <div className={`flex items-center px-3 py-2.5 rounded-lg transition-all group ${isActive('/admin/assets') ? 'bg-purple-700 text-white' : 'hover:bg-slate-800 hover:text-white'}`}>
                              <Tag className="w-5 h-5 mr-3 text-slate-400 group-hover:text-white" />
                              <span className="text-sm font-medium">Asset Registry</span>
                            </div>
                          </Link>
                          <Link href="/admin/scope">
                            <div className={`flex items-center px-3 py-2.5 rounded-lg transition-all group ${isActive('/admin/scope') ? 'bg-blue-700 text-white' : 'hover:bg-slate-800 hover:text-white'}`}>
                              <Factory className="w-5 h-5 mr-3 text-slate-400 group-hover:text-white" />
                              <span className="text-sm font-medium">Operational Scope</span>
                            </div>
                          </Link>
                          <Link href="/admin/holds">
                            <div className={`flex items-center px-3 py-2.5 rounded-lg transition-all group ${isActive('/admin/holds') ? 'bg-amber-700 text-white' : 'hover:bg-slate-800 hover:text-white'}`}>
                              <AlertOctagon className="w-5 h-5 mr-3 text-slate-400 group-hover:text-white" />
                              <span className="text-sm font-medium">Hold Queue</span>
                            </div>
                          </Link>
                          <Link href="/admin/audit">
                            <div className={`flex items-center px-3 py-2.5 rounded-lg transition-all group ${isActive('/admin/audit') ? 'bg-slate-700 text-white' : 'hover:bg-slate-800 hover:text-white'}`}>
                              <ScrollText className="w-5 h-5 mr-3 text-slate-400 group-hover:text-white" />
                              <span className="text-sm font-medium">Audit Log</span>
                            </div>
                          </Link>
                          <Link href="/admin/permissions">
                            <div className={`flex items-center px-3 py-2.5 rounded-lg transition-all group ${isActive('/admin/permissions') ? 'bg-slate-700 text-white' : 'hover:bg-slate-800 hover:text-white'}`}>
                              <Shield className="w-5 h-5 mr-3 text-slate-400 group-hover:text-white" />
                              <span className="text-sm font-medium">Permissions Matrix</span>
                            </div>
                          </Link>
                          <Link href="/admin/settings">
                            <div className={`flex items-center px-3 py-2.5 rounded-lg transition-all group ${isActive('/admin/settings') ? 'bg-slate-700 text-white' : 'hover:bg-slate-800 hover:text-white'}`}>
                              <Settings className="w-5 h-5 mr-3 text-slate-400 group-hover:text-white" />
                              <span className="text-sm font-medium">Workspace Settings</span>
                            </div>
                          </Link>
                          <Link href="/admin/data-export">
                            <div className={`flex items-center px-3 py-2.5 rounded-lg transition-all group ${isActive('/admin/data-export') ? 'bg-emerald-700 text-white' : 'hover:bg-slate-800 hover:text-white'}`}>
                              <Server className="w-5 h-5 mr-3 text-slate-400 group-hover:text-white" />
                              <span className="text-sm font-medium">Data Export</span>
                            </div>
                          </Link>
                        </div>
                      </div>
                    )}      </div>

      {/* NOTIFICATIONS BELL — above the user card */}
      {uid && (
        <div className="px-4 pb-2">
          <NotificationBell userId={uid} />
        </div>
      )}

      {/* USER FOOTER */}
      <div className="p-4 border-t border-slate-800 bg-slate-900/50">
         <div className="flex items-center justify-between bg-slate-800/50 p-3 rounded-xl border border-slate-800">
            <Link href="/profile" className="flex items-center min-w-0 flex-1 hover:bg-slate-700/30 rounded-md -ml-1 pl-1 py-1 transition-colors" title="Open profile">
               <div className="w-9 h-9 rounded-lg bg-gradient-to-tr from-slate-700 to-slate-600 flex items-center justify-center text-sm font-bold text-white border border-slate-500 shadow-sm shrink-0">
                  {activeRole?.charAt(0) || 'U'}
               </div>
               <div className="ml-3 overflow-hidden">
                  <p className="text-sm font-bold text-white truncate">{userEmail?.split('@')[0] || 'Loading...'}</p>
                  <p className="text-[10px] text-orange-500 truncate font-mono uppercase tracking-wide">
                    {activeOrgId ? (activeRole || 'Authenticating') : 'No Workspace'}
                  </p>
               </div>
            </Link>
            <button
              onClick={handleLogout}
              className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg transition-colors ml-2"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
         </div>
      </div>
    </div>
  );
}
