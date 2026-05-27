"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useRole } from "@/components/providers/RoleContext";
import { Loader2 } from "lucide-react";

export default function DashboardRedirect() {
  const router = useRouter();
  const { activeRole, loading } = useRole();

  useEffect(() => {
    if (loading) return;

    // Not logged in / no role resolved — send to the auth page
    // (/ is the marketing page; auth lives at /login)
    if (!activeRole) {
      router.push("/login");
      return;
    }

    // Default landing: Doc Control Page (Library View)
    router.push("/documents");

  }, [activeRole, loading, router]);

  return (
    <div className="h-screen w-full flex flex-col items-center justify-center bg-slate-50">
      <Loader2 className="w-12 h-12 text-orange-600 animate-spin mb-4" />
      <h2 className="text-xl font-bold text-slate-800">Loading Workspace...</h2>
      <p className="text-sm text-slate-500 mt-2">Connecting to secure libraries</p>
    </div>
  );
}