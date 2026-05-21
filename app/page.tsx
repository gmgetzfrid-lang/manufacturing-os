"use client";

import React, { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { useRouter } from 'next/navigation';
import { Layout, Lock, Mail, Loader2, AlertCircle } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await signInWithEmailAndPassword(auth, email, password);
      // FIXED: Redirects to the Smart Dashboard
      router.push('/dashboard');
    } catch (err: unknown) {
      console.error("Login Error:", err);
      const code = (err as { code?: string })?.code;
      let msg = "Failed to sign in. Please try again.";
      if (code === 'auth/invalid-credential') msg = "Invalid email or password.";
      else if (code === 'auth/user-not-found') msg = "No account found with this email.";
      else if (code === 'auth/wrong-password') msg = "Incorrect password.";
      else if (code === 'auth/too-many-requests') msg = "Too many failed attempts. Try again later.";
      else if (code === 'auth/network-request-failed') msg = "Network error. Check your connection.";
      
      setError(msg);
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black z-0" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-orange-900/50 to-transparent z-10" />

      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden relative z-20 border border-slate-800">
        <div className="bg-slate-900 p-8 text-center border-b border-slate-800">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-gradient-to-br from-orange-500 to-orange-700 rounded-xl mb-4 shadow-lg shadow-orange-900/40 ring-1 ring-white/10">
            <Layout className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-black text-white tracking-tight">Manufacturing<span className="text-orange-500">OS</span></h1>
          <p className="text-slate-400 text-xs uppercase tracking-widest mt-2 font-medium">Enterprise Control System</p>
        </div>

        <div className="p-8 bg-white">
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-xl flex items-start animate-in fade-in slide-in-from-top-2 shadow-sm">
              <AlertCircle className="w-5 h-5 text-red-600 mr-3 shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="text-sm font-bold text-red-900">Access Denied</h4>
                <p className="text-sm text-red-700 mt-0.5">{error}</p>
              </div>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Email Address</label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Mail className="w-5 h-5 text-slate-400 group-focus-within:text-orange-500 transition-colors" />
                </div>
                <input 
                  type="email" 
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-12 pr-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-orange-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                  placeholder="name@company.com"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Password</label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Lock className="w-5 h-5 text-slate-400 group-focus-within:text-orange-500 transition-colors" />
                </div>
                <input 
                  type="password" 
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-12 pr-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:ring-2 focus:ring-orange-500 focus:bg-white focus:border-transparent outline-none transition-all placeholder:text-slate-400"
                  placeholder="••••••••"
                  required
                />
              </div>
            </div>

            <button 
              type="submit" 
              disabled={loading}
              className="w-full py-4 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl shadow-xl hover:shadow-2xl hover:scale-[1.01] active:scale-[0.99] transition-all flex items-center justify-center disabled:opacity-70 disabled:cursor-not-allowed disabled:transform-none"
            >
              {loading ? (
                <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Authenticating...</>
              ) : (
                "Sign In to Dashboard"
              )}
            </button>
          </form>
        </div>
        
        <div className="bg-slate-50 p-6 text-center border-t border-slate-100 flex flex-col items-center gap-3">
          <p className="text-sm text-slate-600 font-medium">
            Don't have a workspace?{' '}
            <a href="/signup" className="text-orange-600 hover:text-orange-700 font-bold hover:underline">
              Create Account
            </a>
          </p>
          <div className="flex justify-between w-full px-2 mt-2">
            <p className="text-[10px] text-slate-400 font-medium">v2.1.0 (Enterprise)</p>
            <p className="text-[10px] text-slate-400 font-medium">Authorized Use Only</p>
          </div>
        </div>
      </div>
    </div>
  );
}