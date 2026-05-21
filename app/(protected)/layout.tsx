"use client";

import React from 'react';
// Ensure this import points to the correct folder
import Sidebar from '@/components/navigation/Sidebar'; 
import { RoleProvider, useRole } from '@/components/providers/RoleContext';
import { ToastProvider } from '@/components/providers/ToastProvider';
import { NotificationListener } from '@/components/providers/NotificationListener';
import { Loader2 } from 'lucide-react';

// Wrapper component to handle Auth Loading safely
const ProtectedContent = ({ children }: { children: React.ReactNode }) => {
  const { loading, activeRole } = useRole();

  // 1. Show Spinner while checking Role
  if (loading) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-slate-50">
        <Loader2 className="w-12 h-12 text-orange-600 animate-spin mb-4" />
        <h2 className="text-xl font-bold text-slate-800">Authenticating...</h2>
      </div>
    );
  }

  // 2. Render App (Sidebar + Page)
  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar />
      <main className="flex-1 overflow-auto relative">
        <NotificationListener />
        {children}
      </main>
    </div>
  );
};

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ToastProvider>
      <RoleProvider>
        <ProtectedContent>{children}</ProtectedContent>
      </RoleProvider>
    </ToastProvider>
  );
}