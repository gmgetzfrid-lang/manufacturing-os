"use client";

// app/(protected)/admin/layout.tsx — SURF-9 / WF-20: ONE gate for every
// /admin/* page.
//
// Before rendering any admin surface this layout asks /api/admin/gate,
// which decides on the SERVER from the caller's active membership, the full
// role collection and (for analytics / archive-view / audit) the org's
// capability policy including per-person grants. The page renders only on a
// 200 whose surface matches the one asked for. Anything else — a 403, a 503
// (the policy could not be read), a network failure, an unknown /admin path
// — is a DENIAL: this gate never fails open. Nav hiding is not a permission
// model, and neither is a client-side policy read.
//
// The pages' own role checks (writes, banners) are untouched: the registry
// mirrors what each page admitted on 2026-09-17, so no surface changes who
// may open it as a side-effect of the consolidation (DEC-17).

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { adminSurfaceForPath } from "@/lib/adminSurfaces";
import RouteLoader from "@/components/ui/RouteLoader";

type GateState =
  | { status: "checking" }
  | { status: "allowed"; key: string }
  | { status: "denied"; key: string | null; reason: string; retryable: boolean };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { activeOrgId, uid } = useRole();
  const surface = adminSurfaceForPath(pathname);
  const surfaceKey = surface?.key ?? null;
  const [gate, setGate] = React.useState<GateState>({ status: "checking" });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (!activeOrgId || !uid) return; // the protected layout owns the membership screens
    if (!surfaceKey) {
      setGate({ status: "denied", key: null, reason: "This admin page is not registered with the admin gate.", retryable: false });
      return;
    }
    let alive = true;
    setGate({ status: "checking" });
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token ?? "";
        const res = await fetch(`/api/admin/gate?orgId=${encodeURIComponent(activeOrgId)}&surface=${encodeURIComponent(surfaceKey)}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const body = (await res.json().catch(() => null)) as { allowed?: boolean; surface?: string; error?: string } | null;
        if (!alive) return;
        if (res.ok && body?.allowed === true && body?.surface === surfaceKey) {
          setGate({ status: "allowed", key: surfaceKey });
        } else {
          setGate({
            status: "denied", key: surfaceKey,
            reason: body?.error || `The admin gate refused this page (HTTP ${res.status}).`,
            retryable: res.status >= 500,
          });
        }
      } catch {
        if (alive) setGate({ status: "denied", key: surfaceKey, reason: "Could not reach the admin gate — your permissions were not verified.", retryable: true });
      }
    })();
    return () => { alive = false; };
  }, [activeOrgId, uid, surfaceKey, attempt]);

  if (gate.status === "allowed" && gate.key === surfaceKey) return <>{children}</>;
  if (gate.status === "checking" || gate.status === "allowed") return <RouteLoader label="Checking access…" />;

  return (
    <div className="max-w-xl mx-auto p-8">
      <div className="rounded-2xl border border-rose-200 bg-rose-50/60 dark:bg-rose-950/20 dark:border-rose-900 p-5 text-sm text-[var(--color-text)]">
        <div className="flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 mt-0.5 shrink-0 text-rose-600" />
          <div className="min-w-0">
            <div className="font-black">{surface ? `${surface.label}: not available to you` : "Not an admin page"}</div>
            <p className="mt-1 text-[var(--color-text-muted)]">{gate.reason}</p>
            <div className="mt-3 flex items-center gap-3 flex-wrap">
              {gate.retryable && (
                <button type="button" onClick={() => setAttempt((n) => n + 1)}
                  className="px-3 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-xs font-bold hover:bg-[var(--color-surface-2)]">
                  Try again
                </button>
              )}
              <Link href="/dashboard" className="text-xs font-bold text-[var(--color-accent)] hover:underline">Back to the dashboard</Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
