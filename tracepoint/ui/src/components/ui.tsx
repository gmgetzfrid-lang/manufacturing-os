import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from "lucide-react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** The TracePoint triangle mark, drawn as SVG so it is crisp at any size and
 *  follows the theme accent. Mirrors the shipped logo: three striped triangles
 *  split by a "Y". */
export function Mark({ size = 28, mono = false, className }: { size?: number; mono?: boolean; className?: string }) {
  const id = useId().replace(/:/g, "");
  const stripes = Array.from({ length: 19 }, (_, i) => 3 + i * 2.85);
  return (
    <svg width={size} height={size * 0.6} viewBox="0 0 100 60" className={className} aria-label="TracePoint">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={mono ? "currentColor" : "#ef4444"} />
          <stop offset="1" stopColor={mono ? "currentColor" : "#dc2626"} />
        </linearGradient>
        <mask id={`m${id}`}>
          <polygon points="1,58 50,2 99,58" fill="white" />
          <path d="M33.5,21.2 L50,39 L66.5,21.2 M50,39 L50,60" stroke="black" strokeWidth="4.2" fill="none" strokeLinejoin="miter" />
          {stripes.map((y) => <rect key={y} x="0" y={y + 1.9} width="100" height="0.95" fill="black" />)}
        </mask>
      </defs>
      <rect x="0" y="0" width="100" height="60" fill={`url(#g${id})`} mask={`url(#m${id})`} />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cx("flex items-center gap-2.5", className)}>
      <Mark size={34} />
      <div className="leading-none">
        <div className="text-[15px] font-[800] tracking-[0.18em] text-[var(--color-text)]">TRACEPOINT</div>
        <div className="mt-1 text-[10px] font-medium tracking-[0.08em] text-[var(--color-text-faint)] uppercase">THOR document intelligence</div>
      </div>
    </div>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "soft";
const VARIANT: Record<Variant, string> = {
  primary: "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] shadow-sm shadow-[color-mix(in_srgb,var(--color-accent)_30%,transparent)]",
  secondary: "bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] shadow-xs",
  ghost: "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)]",
  danger: "bg-[var(--color-bad)] text-white hover:brightness-110",
  soft: "bg-[var(--color-accent-soft)] text-[var(--color-accent)] hover:brightness-[0.97]",
};

export function Button({ variant = "secondary", size = "md", loading, icon, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean; icon?: ReactNode }) {
  const sz = size === "sm" ? "h-8 px-2.5 text-[12.5px] gap-1.5 rounded-lg" : size === "lg" ? "h-11 px-5 text-[14.5px] gap-2 rounded-xl" : "h-9 px-3.5 text-[13px] gap-2 rounded-[10px]";
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx("inline-flex items-center justify-center font-medium whitespace-nowrap transition-all duration-150 focus-ring disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] cursor-pointer", sz, VARIANT[variant], className)}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      {...rest}
      title={label}
      aria-label={label}
      className={cx(
        "inline-flex size-9 items-center justify-center rounded-[10px] transition-colors focus-ring cursor-pointer",
        active ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)]",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label?: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="block">
      {label && <div className="mb-1.5 text-[12.5px] font-medium text-[var(--color-text-muted)]">{label}</div>}
      {children}
      {error ? <div className="mt-1.5 text-[12px] text-[var(--color-bad)]">{error}</div> : hint ? <div className="mt-1.5 text-[12px] text-[var(--color-text-faint)]">{hint}</div> : null}
    </label>
  );
}

export function Input({ className, icon, ...rest }: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }) {
  return (
    <div className="relative">
      {icon && <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[var(--color-text-faint)]">{icon}</div>}
      <input
        {...rest}
        className={cx(
          "h-10 w-full rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none transition focus:border-[var(--color-accent)] focus:ring-4 focus:ring-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]",
          icon ? "pl-9" : "",
          className,
        )}
      />
    </div>
  );
}

export function Select({ value, onChange, options, className }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cx("h-9 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] cursor-pointer", className)}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={() => onChange(!checked)} className="flex w-full items-start gap-3 text-left disabled:opacity-50 cursor-pointer">
      <span className={cx("relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-[var(--color-accent)]" : "bg-[var(--color-border-strong)]")}>
        <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform duration-200", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
      </span>
      {(label || hint) && (
        <span>
          {label && <span className="block text-[13.5px] font-medium">{label}</span>}
          {hint && <span className="block text-[12.5px] text-[var(--color-text-muted)]">{hint}</span>}
        </span>
      )}
    </button>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string }[] }) {
  return (
    <div className="inline-flex rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-7 whitespace-nowrap rounded-[8px] px-2.5 text-[12.5px] font-medium transition cursor-pointer inline-flex items-center gap-1.5",
            value === o.value ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Pill({ children, color, className, title }: { children: ReactNode; color?: string; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap", className)}
      style={color ? { color, background: `color-mix(in srgb, ${color} 13%, transparent)` } : undefined}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-sans text-[11px] font-medium text-[var(--color-text-muted)] shadow-xs">{children}</kbd>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-4 animate-spin text-[var(--color-text-faint)]", className)} />;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center animate-[var(--animate-rise)]">
      {icon && <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-[var(--color-surface-3)] text-[var(--color-text-muted)]">{icon}</div>}
      <div className="text-[15px] font-semibold">{title}</div>
      {children && <div className="mt-1.5 max-w-md text-[13px] text-[var(--color-text-muted)]">{children}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, subtitle, children, footer, width = 520 }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 animate-[var(--animate-fade)]">
      <div className="absolute inset-0 bg-[rgb(2_6_23/0.55)] backdrop-blur-[3px]" onClick={onClose} />
      <div className="relative card max-h-[90vh] w-full overflow-hidden shadow-2xl animate-[var(--animate-pop)] flex flex-col" style={{ maxWidth: width }}>
        <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-5 py-4">
          <div>
            <div className="text-[15.5px] font-semibold">{title}</div>
            {subtitle && <div className="mt-0.5 text-[12.5px] text-[var(--color-text-muted)]">{subtitle}</div>}
          </div>
          <IconButton label="Close" onClick={onClose} className="-mr-2 -mt-1"><X className="size-4" /></IconButton>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ── Toasts ────────────────────────────────────────────────────────────
type ToastKind = "ok" | "error" | "info" | "warn";
interface Toast { id: number; kind: ToastKind; text: string }
const ToastCtx = createContext<(kind: ToastKind, text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((kind: ToastKind, text: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3800);
  }, []);
  const icon = { ok: <CheckCircle2 className="size-4 text-[var(--color-ok)]" />, error: <XCircle className="size-4 text-[var(--color-bad)]" />, info: <Info className="size-4 text-[var(--color-info)]" />, warn: <AlertTriangle className="size-4 text-[var(--color-warn)]" /> };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[360px] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto card flex items-start gap-2.5 px-3.5 py-3 text-[13px] shadow-xl animate-[var(--animate-rise)]">
            <div className="mt-0.5">{icon[t.kind]}</div>
            <div className="flex-1 leading-snug">{t.text}</div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Avatar({ text, size = 32 }: { text: string; size?: number }) {
  return (
    <div className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white shadow-sm" style={{ width: size, height: size, fontSize: size * 0.38, background: "var(--brand-gradient)" }}>
      {text}
    </div>
  );
}

export function Section({ title, subtitle, action, children, className }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("card", className)}>
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-5 py-4">
        <div>
          <div className="text-[14.5px] font-semibold">{title}</div>
          {subtitle && <div className="mt-0.5 text-[12.5px] text-[var(--color-text-muted)]">{subtitle}</div>}
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card px-4 py-3.5">
      <div className="flex items-center justify-between text-[12px] font-medium text-[var(--color-text-muted)]">
        {label}
        {icon && <span className="text-[var(--color-text-faint)]">{icon}</span>}
      </div>
      <div className="mt-1.5 text-[22px] font-semibold tracking-tight tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-[var(--color-text-faint)]">{sub}</div>}
    </div>
  );
}
