"use client";

import React, { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Layout, ArrowRight, Loader2, Building2, User, Mail, Lock, AlertCircle } from 'lucide-react';

export default function SignupPage() {
  const router = useRouter();

  const [formData, setFormData] = useState({
    displayName: '',
    email: '',
    password: '',
    confirmPassword: '',
    companyName: ''
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (formData.password.length < 6) {
      setError("Password must be at least 6 characters.");
      setLoading(false);
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      setError("Passwords do not match.");
      setLoading(false);
      return;
    }

    try {
      // 1. Create auth user
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: formData.email,
        password: formData.password,
        options: { data: { display_name: formData.displayName } },
      });

      if (authError) throw new Error(authError.message);
      if (!authData.user) throw new Error("Authentication failed.");

      const userId = authData.user.id;

      // 2. Create organization
      const { data: orgData, error: orgError } = await supabase
        .from('orgs')
        .insert({
          name: formData.companyName,
          type: 'business',
          created_by: userId,
          billing: { status: 'active', plan: 'starter' },
        })
        .select('id')
        .single();

      if (orgError || !orgData) throw new Error("Failed to create organization.");
      const orgId = (orgData as { id: string }).id;

      // 3. Add user as Admin member
      await supabase.from('org_members').insert({
        org_id: orgId,
        uid: userId,
        email: formData.email,
        display_name: formData.displayName,
        role: 'Admin',
        status: 'active',
        created_by: userId,
      });

      // 4. Create user profile with default org
      await supabase.from('users').upsert({
        id: userId,
        email: formData.email,
        display_name: formData.displayName,
        default_org_id: orgId,
        updated_at: new Date().toISOString(),
      });

      // 5. Persist org in localStorage
      if (typeof window !== 'undefined') {
        localStorage.setItem('manufacturingos.activeOrgId', orgId);
      }

      router.push('/dashboard');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "An unexpected error occurred.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black z-0" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-orange-900/50 to-transparent z-10" />

      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden relative z-20 border border-slate-800">
        <div className="bg-slate-900 p-8 text-center border-b border-slate-800">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-gradient-to-br from-orange-500 to-orange-700 rounded-xl mb-4 shadow-lg shadow-orange-900/40 ring-1 ring-white/10">
            <Layout className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-black text-white tracking-tight">Get Started</h1>
          <p className="text-slate-400 text-sm mt-2 font-medium">Create your private ManufacturingOS workspace</p>
        </div>

        <div className="p-8 bg-white">
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-xl flex items-start animate-in fade-in slide-in-from-top-2">
              <AlertCircle className="w-5 h-5 text-red-600 mr-3 shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="text-sm font-bold text-red-900">Registration Failed</h4>
                <p className="text-sm text-red-700 mt-0.5">{error}</p>
              </div>
            </div>
          )}

          <form onSubmit={handleSignup} className="space-y-5">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Company / Workspace Name</label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Building2 className="w-5 h-5 text-slate-400 group-focus-within:text-orange-500 transition-colors" />
                </div>
                <input type="text" value={formData.companyName} onChange={(e) => setFormData({...formData, companyName: e.target.value})}
                  className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-bold focus:ring-2 focus:ring-orange-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                  placeholder="Acme Manufacturing Inc." required />
              </div>
            </div>

            <div className="h-px bg-slate-100 my-4" />

            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Full Name</label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <User className="w-5 h-5 text-slate-400 group-focus-within:text-orange-500 transition-colors" />
                </div>
                <input type="text" value={formData.displayName} onChange={(e) => setFormData({...formData, displayName: e.target.value})}
                  className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-orange-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                  placeholder="John Doe" required />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Work Email</label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Mail className="w-5 h-5 text-slate-400 group-focus-within:text-orange-500 transition-colors" />
                </div>
                <input type="email" value={formData.email} onChange={(e) => setFormData({...formData, email: e.target.value})}
                  className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-orange-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                  placeholder="name@company.com" required />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Password</label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Lock className="w-5 h-5 text-slate-400 group-focus-within:text-orange-500 transition-colors" />
                </div>
                <input type="password" value={formData.password} onChange={(e) => setFormData({...formData, password: e.target.value})}
                  className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-orange-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                  placeholder="Create a strong password" minLength={6} required />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Confirm Password</label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Lock className="w-5 h-5 text-slate-400 group-focus-within:text-orange-500 transition-colors" />
                </div>
                <input type="password" value={formData.confirmPassword} onChange={(e) => setFormData({...formData, confirmPassword: e.target.value})}
                  className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-orange-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                  placeholder="Repeat your password" minLength={6} required />
              </div>
            </div>

            <button type="submit" disabled={loading}
              className="w-full py-4 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl shadow-xl hover:shadow-2xl hover:scale-[1.01] active:scale-[0.99] transition-all flex items-center justify-center disabled:opacity-70 disabled:cursor-not-allowed mt-6">
              {loading ? (
                <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Creating Workspace...</>
              ) : (
                <span className="flex items-center">Create Account <ArrowRight className="w-5 h-5 ml-2" /></span>
              )}
            </button>
          </form>
        </div>

        <div className="bg-slate-50 p-6 text-center border-t border-slate-100">
          <p className="text-sm text-slate-600 font-medium">
            Already have an account?{' '}
            <Link href="/" className="text-orange-600 hover:text-orange-700 font-bold hover:underline">Sign In</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
