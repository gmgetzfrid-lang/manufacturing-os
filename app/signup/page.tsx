"use client";

import React, { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Layout, ArrowRight, Loader2, Building2, User, Mail, Lock, AlertCircle, Users } from 'lucide-react';

type Mode = "new-org" | "request-access";

export default function SignupPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("new-org");

  const [formData, setFormData] = useState({
    displayName: '',
    email: '',
    password: '',
    confirmPassword: '',
    companyName: '',
  });

  const [requestData, setRequestData] = useState({
    displayName: '',
    email: '',
    orgName: '',
    message: '',
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestSent, setRequestSent] = useState(false);

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
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: formData.email,
          password: formData.password,
          displayName: formData.displayName,
          companyName: formData.companyName,
        }),
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Registration failed.");

      // Sign in immediately after account creation
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: formData.email,
        password: formData.password,
      });

      if (signInError) throw new Error("Account created. Please sign in.");

      if (typeof window !== 'undefined') {
        localStorage.setItem('manufacturingos.activeOrgId', result.orgId);
      }

      router.push('/workspace');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const handleRequestAccess = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await fetch('/api/auth/request-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData),
      });
      setRequestSent(true);
    } catch {
      setError("Failed to send request. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black z-0" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-orange-900/50 to-transparent z-10" />

      <div className="w-full max-w-lg relative z-20">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-gradient-to-br from-orange-500 to-orange-700 rounded-2xl mb-4 shadow-lg shadow-orange-900/40 ring-1 ring-white/10">
            <Layout className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-3xl font-black text-white tracking-tight">ManufacturingOS</h1>
          <p className="text-slate-400 text-sm mt-2">Enterprise Document Control Platform</p>
        </div>

        {/* Mode Toggle */}
        <div className="flex bg-slate-900 rounded-2xl p-1 mb-6 border border-slate-800">
          <button
            onClick={() => { setMode("new-org"); setError(null); }}
            className={`flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-bold transition-all ${mode === "new-org" ? "bg-orange-600 text-white shadow-lg" : "text-slate-400 hover:text-white"}`}
          >
            <Building2 className="w-4 h-4" />
            New Organization
          </button>
          <button
            onClick={() => { setMode("request-access"); setError(null); }}
            className={`flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-bold transition-all ${mode === "request-access" ? "bg-blue-600 text-white shadow-lg" : "text-slate-400 hover:text-white"}`}
          >
            <Users className="w-4 h-4" />
            Request Access
          </button>
        </div>

        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden border border-slate-200">

          {/* NEW ORG MODE */}
          {mode === "new-org" && (
            <>
              <div className="bg-slate-900 px-8 py-6 border-b border-slate-800">
                <h2 className="text-lg font-black text-white">Create Your Workspace</h2>
                <p className="text-slate-400 text-sm mt-1">Set up a new organization — you'll be the Admin</p>
              </div>
              <div className="p-8">
                {error && (
                  <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-xl flex items-start">
                    <AlertCircle className="w-5 h-5 text-red-600 mr-3 shrink-0 mt-0.5" />
                    <p className="text-sm text-red-700 font-medium">{error}</p>
                  </div>
                )}
                <form onSubmit={handleSignup} className="space-y-5">
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Company / Organization Name</label>
                    <div className="relative">
                      <Building2 className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                      <input type="text" value={formData.companyName} onChange={(e) => setFormData({...formData, companyName: e.target.value})}
                        className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-bold focus:ring-2 focus:ring-orange-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                        placeholder="Acme Manufacturing Inc." required />
                    </div>
                  </div>

                  <div className="h-px bg-slate-100" />

                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Your Full Name</label>
                    <div className="relative">
                      <User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                      <input type="text" value={formData.displayName} onChange={(e) => setFormData({...formData, displayName: e.target.value})}
                        className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-orange-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                        placeholder="John Doe" required />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Work Email</label>
                    <div className="relative">
                      <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                      <input type="email" value={formData.email} onChange={(e) => setFormData({...formData, email: e.target.value})}
                        className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-orange-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                        placeholder="name@company.com" required />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Password</label>
                    <div className="relative">
                      <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                      <input type="password" value={formData.password} onChange={(e) => setFormData({...formData, password: e.target.value})}
                        className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-orange-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                        placeholder="Create a strong password" minLength={6} required />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Confirm Password</label>
                    <div className="relative">
                      <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                      <input type="password" value={formData.confirmPassword} onChange={(e) => setFormData({...formData, confirmPassword: e.target.value})}
                        className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-orange-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                        placeholder="Repeat your password" minLength={6} required />
                    </div>
                  </div>

                  <button type="submit" disabled={loading}
                    className="w-full py-4 bg-orange-600 hover:bg-orange-500 text-white font-bold rounded-xl shadow-lg transition-all flex items-center justify-center disabled:opacity-70 disabled:cursor-not-allowed mt-2">
                    {loading ? (
                      <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Creating Workspace...</>
                    ) : (
                      <span className="flex items-center">Create Organization <ArrowRight className="w-5 h-5 ml-2" /></span>
                    )}
                  </button>
                </form>
              </div>
            </>
          )}

          {/* REQUEST ACCESS MODE */}
          {mode === "request-access" && (
            <>
              <div className="bg-slate-900 px-8 py-6 border-b border-slate-800">
                <h2 className="text-lg font-black text-white">Request Access</h2>
                <p className="text-slate-400 text-sm mt-1">Your organization's admin will create your account</p>
              </div>
              <div className="p-8">
                {requestSent ? (
                  <div className="text-center py-6">
                    <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                      <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <h3 className="text-lg font-bold text-slate-900 mb-2">Request Sent</h3>
                    <p className="text-slate-500 text-sm">Your organization's admin will receive your request and create your account. You'll get an email with login instructions.</p>
                  </div>
                ) : (
                  <>
                    {error && (
                      <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-xl flex items-start">
                        <AlertCircle className="w-5 h-5 text-red-600 mr-3 shrink-0 mt-0.5" />
                        <p className="text-sm text-red-700 font-medium">{error}</p>
                      </div>
                    )}
                    <div className="mb-6 p-4 bg-blue-50 border border-blue-100 rounded-xl">
                      <p className="text-sm text-blue-800 font-medium">Your account will be created by your organization's Admin. This form notifies them of your request.</p>
                    </div>
                    <form onSubmit={handleRequestAccess} className="space-y-5">
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Your Full Name</label>
                        <div className="relative">
                          <User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                          <input type="text" value={requestData.displayName} onChange={(e) => setRequestData({...requestData, displayName: e.target.value})}
                            className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-blue-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                            placeholder="John Doe" required />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Your Work Email</label>
                        <div className="relative">
                          <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                          <input type="email" value={requestData.email} onChange={(e) => setRequestData({...requestData, email: e.target.value})}
                            className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-blue-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                            placeholder="name@company.com" required />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Organization Name</label>
                        <div className="relative">
                          <Building2 className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                          <input type="text" value={requestData.orgName} onChange={(e) => setRequestData({...requestData, orgName: e.target.value})}
                            className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-blue-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                            placeholder="Acme Manufacturing Inc." required />
                        </div>
                      </div>
                      <button type="submit" disabled={loading}
                        className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl shadow-lg transition-all flex items-center justify-center disabled:opacity-70 disabled:cursor-not-allowed">
                        {loading ? (
                          <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Sending Request...</>
                        ) : (
                          <span className="flex items-center">Send Access Request <ArrowRight className="w-5 h-5 ml-2" /></span>
                        )}
                      </button>
                    </form>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        <div className="text-center mt-6">
          <p className="text-sm text-slate-500">
            Already have an account?{' '}
            <Link href="/" className="text-orange-500 hover:text-orange-400 font-bold">Sign In</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
