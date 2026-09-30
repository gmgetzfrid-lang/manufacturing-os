import RouteLoader from "@/components/ui/RouteLoader";

// In-shell skeleton for /companies (REL-1): without this, a cold navigation
// fell through to app/loading.tsx OUTSIDE the protected shell and flashed
// the whole application — sidebar included — away.
export default function Loading() {
  return <RouteLoader label="Loading the registry…" />;
}
