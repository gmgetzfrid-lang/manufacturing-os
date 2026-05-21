"use client";

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import {
  Users,
  UserPlus,
  Shield,
  Trash2,
  AlertCircle,
  Loader2,
  Building2
} from 'lucide-react';

export default function AdminUsersPage() {
  const { activeRole, activeOrgId } = useRole();

  const [members, setMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [orgName, setOrgName] = useState<string>('');

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    role: 'Viewer'
  });
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeOrgId) return;
    const fetchOrgName = async () => {
      try {
        const { data } = await supabase.from('orgs').select('name').eq('id', activeOrgId).single();
        if (data) setOrgName(data.name || 'Unnamed Org');
      } catch (e) {
        console.error("Failed to fetch org name", e);
      }
    };
    fetchOrgName();
  }, [activeOrgId]);

  const fetchMembers = async () => {
    if (!activeOrgId) return;
    setLoading(true);
    try {
      const { data } = await supabase
        .from('org_members')
        .select('*')
        .eq('org_id', activeOrgId)
        .order('created_at', { ascending: false });
      setMembers(data || []);
    } catch (e) {
      console.error("Fetch members error:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMembers();
  }, [activeOrgId]);

  const handleCreateMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeOrgId) return;
    setProcessing(true);
    setError(null);

    const displayName = `${formData.firstName} ${formData.lastName}`.trim();

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not authenticated");

      const res = await fetch('/api/admin/create-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          email: formData.email,
          password: formData.password,
          orgId: activeOrgId,
          role: formData.role,
          displayName,
        }),
      });

      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to create user');

      setFormData({ firstName: '', lastName: '', email: '', password: '', role: 'Viewer' });
      setIsModalOpen(false);
      fetchMembers();

    } catch (err: any) {
      console.error("Create user failed:", err);
      setError(err.message || "Failed to create user.");
    } finally {
      setProcessing(false);
    }
  };

  if (!['Admin', 'Manager'].includes(activeRole)) {
    return <div className="p-8 text-red-600">Access Denied. Admins Only.</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-20">

      {/* Header */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center">
                <Users className="w-6 h-6 mr-3 text-orange-600" />
                Team Management
              </h1>
              <div className="flex items-center mt-1 space-x-2 text-sm text-slate-500 font-medium">
                 <Building2 className="w-4 h-4" />
                 <span>Organization: <span className="text-slate-900 font-bold">{orgName || 'Loading...'}</span></span>
              </div>
            </div>
            <button
              onClick={() => setIsModalOpen(true)}
              className="flex items-center px-5 py-2.5 bg-slate-900 text-white rounded-xl text-sm font-bold shadow hover:bg-slate-800 transition-all hover:scale-105 active:scale-95"
            >
              <UserPlus className="w-4 h-4 mr-2" />
              Add Team Member
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {loading ? (
            <div className="p-12 text-center text-slate-500"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50/50">
                  <tr>
                    <th className="px-6 py-4 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">User</th>
                    <th className="px-6 py-4 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">Role</th>
                    <th className="px-6 py-4 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">Status</th>
                    <th className="px-6 py-4 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">Joined</th>
                    <th className="px-6 py-4 text-right text-xs font-bold text-slate-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-slate-200">
                  {members.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 font-bold text-sm">
                            {m.display_name?.charAt(0) || m.email?.charAt(0) || '?'}
                          </div>
                          <div className="ml-4">
                            <div className="text-sm font-bold text-slate-900">{m.display_name || 'No Name'}</div>
                            <div className="text-sm text-slate-500">{m.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="px-3 py-1 inline-flex text-xs leading-5 font-bold rounded-full bg-slate-100 text-slate-800 border border-slate-200">
                          {m.role}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`px-2 py-1 inline-flex text-xs leading-5 font-bold rounded-full ${m.status === 'active' ? 'text-emerald-700 bg-emerald-50' : 'text-slate-500 bg-slate-100'}`}>
                          {m.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500 font-medium">
                        {m.created_at ? new Date(m.created_at).toLocaleDateString() : '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button className="text-slate-400 hover:text-red-600 transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {members.length === 0 && (
                    <tr><td colSpan={5} className="px-6 py-12 text-center text-slate-400 italic">No team members found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Add User Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <h3 className="text-lg font-bold text-slate-900">Add Team Member</h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <span className="sr-only">Close</span>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <form onSubmit={handleCreateMember} className="p-6 space-y-4">
              {error && (
                <div className="p-3 rounded-lg bg-red-50 text-red-600 text-sm font-medium flex items-center">
                  <AlertCircle className="w-4 h-4 mr-2" />
                  {error}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">First Name</label>
                  <input
                    required type="text" value={formData.firstName}
                    onChange={e => setFormData({...formData, firstName: e.target.value})}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium focus:ring-2 focus:ring-orange-500 outline-none"
                    placeholder="Jane"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Last Name</label>
                  <input
                    required type="text" value={formData.lastName}
                    onChange={e => setFormData({...formData, lastName: e.target.value})}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium focus:ring-2 focus:ring-orange-500 outline-none"
                    placeholder="Doe"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Work Email</label>
                <input
                  required type="email" value={formData.email}
                  onChange={e => setFormData({...formData, email: e.target.value})}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium focus:ring-2 focus:ring-orange-500 outline-none"
                  placeholder="jane.doe@company.com"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Temporary Password</label>
                <input
                  required type="text" value={formData.password}
                  onChange={e => setFormData({...formData, password: e.target.value})}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium focus:ring-2 focus:ring-orange-500 outline-none font-mono"
                  placeholder="e.g. Welcome2024!"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Role</label>
                <select
                  value={formData.role}
                  onChange={e => setFormData({...formData, role: e.target.value})}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium focus:ring-2 focus:ring-orange-500 outline-none"
                >
                  <option value="Viewer">Viewer (Read Only)</option>
                  <option value="Drafter">Drafter</option>
                  <option value="Engineer-1">Engineer</option>
                  <option value="Manager">Manager</option>
                  <option value="Admin">Admin</option>
                </select>
              </div>

              <div className="pt-2">
                <button
                  type="submit" disabled={processing}
                  className="w-full py-3 bg-slate-900 text-white font-bold rounded-xl shadow hover:bg-slate-800 transition-all flex items-center justify-center disabled:opacity-50"
                >
                  {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create Account"}
                </button>
                <p className="text-xs text-center text-slate-400 mt-3">
                  User will be able to log in immediately with these credentials.
                </p>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
