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

    // Not logged in / no role resolved
    if (!activeRole) {
      router.push("/");
      return;
    }

    // Default landing: the inbox cockpit. Aggregates everything the
    // user has to act on so they don't bounce between five pages to
    // plan the day.
    router.push("/inbox");

  }, [activeRole, loading, router]);

  return (
    <div className="h-screen w-full flex flex-col items-center justify-center bg-[var(--color-surface-2)]">
      <Loader2 className="w-12 h-12 text-orange-600 animate-spin mb-4" />
      <h2 className="text-xl font-bold text-[var(--color-text)]">Loading Workspace...</h2>
      <p className="text-sm text-[var(--color-text-muted)] mt-2">Connecting to secure libraries</p>
    </div>
  );
}