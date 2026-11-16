import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, ClipboardCheck, Inbox, Moon, Settings as SettingsIcon, Sun } from "lucide-react";
import { api, onEvent } from "../lib/api";
import { useTheme } from "../lib/theme";
import { IconButton, Spinner, cx } from "../components/ui";
import type { IntakeState } from "./types";
import { HomePage } from "./pages/Home";
import { ReviewPage } from "./pages/Review";
import { FiledPage } from "./pages/Filed";
import { SettingsPage } from "./pages/Settings";

export type Page = "home" | "review" | "filed" | "settings";

export interface Nav {
  page: Page;
  params: Record<string, string>;
  go: (p: Page, params?: Record<string, string | number>) => void;
}

function readHash(): { page: Page; params: Record<string, string> } {
  const h = window.location.hash.replace(/^#\/?/, "");
  const [p, q] = h.split("?");
  const params: Record<string, string> = {};
  new URLSearchParams(q ?? "").forEach((v, k) => (params[k] = v));
  const pages: Page[] = ["home", "review", "filed", "settings"];
  return { page: (pages.includes(p as Page) ? p : "home") as Page, params };
}

/** Bumps whenever the service reports a change (throttled), so pages can
 *  refetch their lists. */
export function useTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let pending = false;
    const off = onEvent("changed", () => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; setTick((t) => t + 1); }, 400);
    });
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => { off(); clearInterval(t); };
  }, []);
  return tick;
}

export function IntakeApp() {
  const [state, setState] = useState<IntakeState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [route, setRoute] = useState(readHash);
  const tick = useTick();
  const busy = useRef(false);
  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setState(await api<IntakeState>("state"));
      setFailed(null);
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh, tick]);
  useEffect(() => {
    const f = () => setRoute(readHash());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  const nav: Nav = {
    page: route.page,
    params: route.params,
    go: (p, params) => {
      const q = new URLSearchParams();
      Object.entries(params ?? {}).forEach(([k, v]) => q.set(k, String(v)));
      const qs = q.toString();
      window.location.hash = `/${p}${qs ? `?${qs}` : ""}`;
    },
  };
  if (!state) {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-[13.5px] text-[var(--color-text-muted)]">
        {failed ? <span className="text-[var(--color-bad)]">{failed}</span> : <><Spinner /> Starting Scan Intake…</>}
      </div>
    );
  }
  const review = state.counts.by_status?.review ?? 0;
  const items: { page: Page; label: string; icon: ReactNode; badge?: number }[] = [
    { page: "home", label: "Intake", icon: <Inbox className="size-[18px]" /> },
    { page: "review", label: "Review", icon: <ClipboardCheck className="size-[18px]" />, badge: review },
    { page: "filed", label: "Filed", icon: <Archive className="size-[18px]" /> },
    { page: "settings", label: "Settings", icon: <SettingsIcon className="size-[18px]" /> },
  ];
  return (
    <div className="flex h-full">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-2)]">
        <div className="flex h-[60px] items-center gap-2.5 px-4">
          <div className="flex size-8 items-center justify-center rounded-[9px] text-white shadow-sm" style={{ background: "var(--brand-gradient)" }}>
            <Inbox className="size-[17px]" />
          </div>
          <div className="leading-none">
            <div className="text-[13.5px] font-[800] tracking-[0.14em]">SCAN INTAKE</div>
            <div className="mt-1 text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--color-text-faint)]">Hard files to digital</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-2 pt-2">
          {items.map((i) => {
            const active = route.page === i.page;
            return (
              <button key={i.page} onClick={() => nav.go(i.page)} className={cx("group relative flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-[13.5px] font-medium transition cursor-pointer", active ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm ring-1 ring-[var(--color-border)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)]")}>
                {active && <span className="absolute -left-2 top-2 h-5 w-[3px] rounded-r-full bg-[var(--color-accent)]" />}
                <span className={active ? "text-[var(--color-accent)]" : ""}>{i.icon}</span>
                {i.label}
                {!!i.badge && <span className="ml-auto rounded-full bg-[var(--color-warn)] px-1.5 py-px text-[11px] font-semibold text-white tabular-nums">{i.badge}</span>}
              </button>
            );
          })}
        </nav>
        <StatusFoot state={state} />
      </aside>
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {route.page === "home" && <HomePage state={state} nav={nav} refresh={refresh} tick={tick} />}
        {route.page === "review" && <ReviewPage state={state} nav={nav} tick={tick} />}
        {route.page === "filed" && <FiledPage nav={nav} tick={tick} />}
        {route.page === "settings" && <SettingsPage state={state} refresh={refresh} />}
      </main>
    </div>
  );
}

function StatusFoot({ state }: { state: IntakeState }) {
  const { mode, toggle } = useTheme();
  const working = state.running.length > 0;
  const ok = state.root_ok && !!state.settings.key && state.pdf_engine;
  const color = !ok ? "var(--color-bad)" : state.settings.paused ? "var(--color-warn)" : "var(--color-ok)";
  const label = !ok ? "Not ready" : state.settings.paused ? "Paused" : working ? "Working" : "Watching";
  return (
    <div className="border-t border-[var(--color-border)] p-3">
      <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
        <span className="relative flex size-2">
          {ok && !state.settings.paused && <span className="absolute inline-flex size-full animate-ping rounded-full opacity-40" style={{ background: color }} />}
          <span className="relative inline-flex size-2 rounded-full" style={{ background: color }} />
        </span>
        <span className="font-medium text-[var(--color-text)]">{label}</span>
        <span className="ml-auto">
          <IconButton label={mode === "dark" ? "Light mode" : "Dark mode"} onClick={toggle} className="size-7">
            {mode === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
          </IconButton>
        </span>
      </div>
      <div className="mt-1 truncate text-[11px] text-[var(--color-text-faint)]" title={state.settings.root}>{state.settings.root}</div>
      <div className="mt-0.5 text-[11px] text-[var(--color-text-faint)]">Version {state.version}</div>
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-end justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-7 py-5">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-0.5 text-[13px] text-[var(--color-text-muted)]">{subtitle}</div>}
      </div>
      {action}
    </div>
  );
}
