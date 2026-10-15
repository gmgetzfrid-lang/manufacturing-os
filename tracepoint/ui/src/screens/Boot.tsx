import { assetUrl } from "../lib/api";
import { Mark } from "../components/ui";

export function Boot({ message, error }: { message: string; error?: boolean }) {
  return (
    <div className="hero-backdrop relative flex h-full items-center justify-center overflow-hidden">
      <div className="grid-lines absolute inset-0" />
      <div className="relative flex flex-col items-center text-center animate-[var(--animate-rise)]">
        <div className="relative mb-6 overflow-hidden rounded-[28px] border border-[var(--color-border)] bg-[#262626] shadow-2xl">
          <img src={assetUrl("cat.gif")} alt="" className="block h-[200px] w-[230px] object-contain" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
        </div>
        <Mark size={56} />
        <div className="mt-3 text-[22px] font-[800] tracking-[0.22em]">TRACEPOINT</div>
        <div className={`mt-3 max-w-md text-[13.5px] ${error ? "text-[var(--color-bad)]" : "text-[var(--color-text-muted)]"}`}>{message}</div>
        {!error && <div className="mt-5 h-1 w-56 overflow-hidden rounded-full bg-[var(--color-surface-3)]"><div className="h-full w-1/3 rounded-full bg-[var(--color-accent)] animate-[indeterminate_1.2s_ease-in-out_infinite]" /></div>}
      </div>
      <style>{`@keyframes indeterminate { 0% { transform: translateX(-120%) } 100% { transform: translateX(320%) } }`}</style>
    </div>
  );
}
