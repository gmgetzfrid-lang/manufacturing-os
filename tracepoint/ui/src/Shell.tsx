import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bot, Boxes, ChevronDown, Command, Database, FileSearch, Info, LogOut, Moon, Network, Palette as PaletteIcon, Search, Settings2, Shield, Sun, UserRound } from "lucide-react";
import { api } from "./lib/api";
import type { AppState } from "./lib/types";
import { PALETTES, useTheme } from "./lib/theme";
import { Avatar, IconButton, Kbd, Mark, cx } from "./components/ui";
import { initials } from "./lib/format";
import { SearchPage } from "./pages/Search";
import { EquipmentPage } from "./pages/Equipment";
import { GraphPage } from "./pages/Graph";
import { SourcesPage } from "./pages/Sources";
import { AdminPage } from "./pages/Admin";
import { ProfilePage } from "./pages/Profile";
import { AboutPage } from "./pages/About";
import { AskPage } from "./pages/Ask";

export type Page = "search" | "equipment" | "graph" | "ask" | "sources" | "admin" | "profile" | "about";

export interface Nav {
  go: (p: Page, params?: Record<string, string | number | null | undefined>) => void;
  params: Record<string, string>;
}

function readHash(): { page: Page; params: Record<string, string> } {
  const h = window.location.hash.replace(/^#\/?/, "");
  const [p, q] = h.split("?");
  const params: Record<string, string> = {};
  new URLSearchParams(q ?? "").forEach((v, k) => (params[k] = v));
  const pages: Page[] = ["search", "equipment", "graph", "ask", "sources", "admin", "profile", "about"];
  return { page: (pages.includes(p as Page) ? p : "search") as Page, params };
}

export function Shell({ state, setState, refresh }: { state: AppState; setState: (s: AppState) => void; refresh: () => void }) {
  const [route, setRoute] = useState(readHash);
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const f = () => setRoute(readHash());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const nav: Nav = useMemo(
    () => ({
      go: (p, params) => {
        const q = new URLSearchParams();
        Object.entries(params ?? {}).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && q.set(k, String(v)));
        const qs = q.toString();
        window.location.hash = `/${p}${qs ? `?${qs}` : ""}`;
      },
      params: route.params,
    }),
    [route.params],
  );
  const user = state.user!;
  const isAdmin = user.role === "admin";
  const items: { page: Page; label: string; icon: ReactNode; show: boolean }[] = [
    { page: "search", label: "Search", icon: <FileSearch className="size-[18px]" />, show: true },
    { page: "equipment", label: "Equipment", icon: <Boxes className="size-[18px]" />, show: true },
    { page: "graph", label: "Graph", icon: <Network className="size-[18px]" />, show: true },
    { page: "ask", label: "Ask THOR", icon: <Bot className="size-[18px]" />, show: isAdmin },
    { page: "sources", label: "Sources", icon: <Database className="size-[18px]" />, show: true },
    { page: "admin", label: "Admin", icon: <Shield className="size-[18px]" />, show: isAdmin },
  ];
  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="flex w-[232px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-2)]">
        <div className="flex h-[60px] items-center gap-2.5 px-4">
          <Mark size={30} />
          <div className="leading-none">
            <div className="text-[13.5px] font-[800] tracking-[0.2em]">TRACEPOINT</div>
            <div className="mt-1 text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--color-text-faint)]">THOR intelligence</div>
          </div>
        </div>
        <button onClick={() => setPalette(true)} className="mx-3 mb-3 flex h-9 items-center gap-2 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[12.5px] text-[var(--color-text-faint)] shadow-xs hover:border-[var(--color-border-strong)] cursor-pointer">
          <Search className="size-3.5" /> Jump to…
          <span className="ml-auto flex gap-0.5"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>
        </button>
        <nav className="flex-1 space-y-0.5 px-2">
          {items.filter((i) => i.show).map((i) => {
            const active = route.page === i.page;
            return (
              <button
                key={i.page}
                onClick={() => nav.go(i.page)}
                className={cx(
                  "group relative flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-[13.5px] font-medium transition cursor-pointer",
                  active ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm ring-1 ring-[var(--color-border)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)]",
                )}
              >
                {active && <span className="absolute -left-2 top-2 h-5 w-[3px] rounded-r-full bg-[var(--color-accent)]" />}
                <span className={active ? "text-[var(--color-accent)]" : ""}>{i.icon}</span>
                {i.label}
              </button>
            );
          })}
        </nav>
        <div className="space-y-0.5 px-2 pb-2">
          <div className="flex items-center gap-1">
            <button onClick={() => nav.go("about")} className={cx("flex h-8 flex-1 items-center gap-2.5 rounded-[10px] px-2.5 text-[12.5px] transition cursor-pointer", route.page === "about" ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)] hover:text-[var(--color-text)]")}>
              <Info className="size-4" /> About · For IT
            </button>
            <ThemeControls />
          </div>
        </div>
        <IndexBadge state={state} onClick={() => nav.go("sources")} />
        <UserMenu state={state} setState={setState} nav={nav} />
      </aside>

      {/* Main */}
      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          {route.page === "search" && <SearchPage state={state} nav={nav} />}
          {route.page === "equipment" && <EquipmentPage nav={nav} />}
          {route.page === "graph" && <GraphPage nav={nav} />}
          {route.page === "ask" && isAdmin && <AskPage state={state} nav={nav} />}
          {route.page === "sources" && <SourcesPage state={state} refresh={refresh} />}
          {route.page === "admin" && isAdmin && <AdminPage state={state} setState={setState} />}
          {route.page === "profile" && <ProfilePage state={state} setState={setState} refresh={refresh} />}
          {route.page === "about" && <AboutPage state={state} />}
        </div>
      </main>
      {palette && <CommandPalette onClose={() => setPalette(false)} nav={nav} isAdmin={isAdmin} />}
    </div>
  );
}

function ThemeControls() {
  const { mode, toggle, palette, setPalette } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center">
      <div className="relative">
        <IconButton label="Accent colour" onClick={() => setOpen(!open)} className="size-8"><PaletteIcon className="size-4" /></IconButton>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute bottom-10 left-0 z-20 w-56 card p-1.5 shadow-xl animate-[var(--animate-pop)]">
              {PALETTES.map((p) => (
                <button key={p.id} onClick={() => { setPalette(p); setOpen(false); }} className={cx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] hover:bg-[var(--color-surface-3)] cursor-pointer", palette.id === p.id && "bg-[var(--color-surface-3)]")}>
                  <span className="size-4 rounded-full shadow-inner" style={{ background: `linear-gradient(135deg, ${p.primary}, ${p.secondary})` }} />
                  {p.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <IconButton label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={toggle} className="size-8">
        {mode === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </IconButton>
    </div>
  );
}

function IndexBadge({ state, onClick }: { state: AppState; onClick: () => void }) {
  const kind = state.index.source_kind;
  const label = kind === "team" ? "Team index" : kind === "local" ? "Local index" : "Built-in index";
  return (
    <button onClick={onClick} className="mx-3 mb-2 flex items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-[11.5px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] cursor-pointer">
      <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--color-ok)] opacity-40" /><span className="relative inline-flex size-2 rounded-full bg-[var(--color-ok)]" /></span>
      <span className="truncate">{label} · {state.index.message}</span>
    </button>
  );
}

function UserMenu({ state, setState, nav }: { state: AppState; setState: (s: AppState) => void; nav: Nav }) {
  const [open, setOpen] = useState(false);
  const u = state.user!;
  const roleLabel = { admin: "Administrator", indexer: "Indexer", user: "User" }[u.role];
  return (
    <div className="relative border-t border-[var(--color-border)] p-2">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 rounded-[10px] p-2 text-left hover:bg-[var(--color-surface-3)] cursor-pointer">
        <Avatar text={initials(u.name, u.email)} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{u.name || u.email.split("@")[0]}</div>
          <div className="truncate text-[11.5px] text-[var(--color-text-faint)]">{roleLabel}</div>
        </div>
        <ChevronDown className="size-4 text-[var(--color-text-faint)]" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-[62px] left-2 right-2 z-20 card p-1.5 shadow-xl animate-[var(--animate-pop)]">
            <div className="px-2.5 py-2 text-[12px] text-[var(--color-text-faint)] truncate">{u.email}</div>
            <MenuItem icon={<UserRound className="size-4" />} onClick={() => { setOpen(false); nav.go("profile"); }}>Profile & password</MenuItem>
            {u.role === "admin" && <MenuItem icon={<Settings2 className="size-4" />} onClick={() => { setOpen(false); nav.go("profile", { tab: "ai" }); }}>AI assistant setup</MenuItem>}
            <div className="my-1 h-px bg-[var(--color-border)]" />
            <MenuItem icon={<LogOut className="size-4" />} onClick={() => api<AppState>("auth.logout").then(setState)}>Sign out</MenuItem>
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({ icon, children, onClick }: { icon: ReactNode; children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] hover:bg-[var(--color-surface-3)] cursor-pointer">
      <span className="text-[var(--color-text-muted)]">{icon}</span>
      {children}
    </button>
  );
}

interface Suggest { key: string; label: string; count: number }

function CommandPalette({ onClose, nav, isAdmin }: { onClose: () => void; nav: Nav; isAdmin: boolean }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Suggest[]>([]);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim().length < 2) { setItems([]); return; }
      api<Suggest[]>("suggest", { q }).then(setItems).catch(() => setItems([]));
    }, 90);
    return () => clearTimeout(t);
  }, [q]);
  const pages: { label: string; run: () => void; hint: string }[] = [
    { label: "Search documents", hint: "Page", run: () => nav.go("search") },
    { label: "Browse equipment", hint: "Page", run: () => nav.go("equipment") },
    { label: "Knowledge graph", hint: "Page", run: () => nav.go("graph") },
    { label: "Sources & index", hint: "Page", run: () => nav.go("sources") },
    ...(isAdmin ? [
      { label: "Ask THOR (AI)", hint: "Page", run: () => nav.go("ask") },
      { label: "Admin: profiles & policy", hint: "Page", run: () => nav.go("admin") },
      { label: "AI assistant setup", hint: "Page", run: () => nav.go("profile", { tab: "ai" }) },
    ] : []),
    { label: "About · For IT", hint: "Page", run: () => nav.go("about") },
  ].filter((p) => !q || p.label.toLowerCase().includes(q.toLowerCase()));
  const rows = [
    ...(q.trim() ? [{ label: `Search for “${q.trim()}”`, hint: "Enter", run: () => nav.go("search", { q: q.trim() }) }] : []),
    ...items.map((s) => ({
      label: s.label,
      hint: s.key.startsWith("equip:") ? `${s.count} files` : "word",
      run: () => (s.key.startsWith("equip:") ? nav.go("search", { eq: s.key.slice(6) }) : nav.go("search", { q: s.label })),
    })),
    ...pages,
  ];
  const run = (i: number) => { rows[i]?.run(); onClose(); };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] animate-[var(--animate-fade)]">
      <div className="absolute inset-0 bg-[rgb(2_6_23/0.5)] backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative card w-full max-w-[620px] overflow-hidden shadow-2xl animate-[var(--animate-pop)]">
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4">
          <Command className="size-4 text-[var(--color-text-faint)]" />
          <input
            ref={input}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, rows.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              if (e.key === "Enter") run(sel);
            }}
            placeholder="Equipment, tag, words or a page…"
            className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--color-text-faint)]"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {rows.map((r, i) => (
            <button key={i} onMouseEnter={() => setSel(i)} onClick={() => run(i)} className={cx("flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-[13.5px] cursor-pointer", sel === i && "bg-[var(--color-accent-soft)]")}>
              <span className="truncate">{r.label}</span>
              <span className="shrink-0 text-[11.5px] text-[var(--color-text-faint)]">{r.hint}</span>
            </button>
          ))}
          {rows.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-[var(--color-text-faint)]">Type an equipment number, a tag like V-2, or words.</div>}
        </div>
      </div>
    </div>
  );
}
