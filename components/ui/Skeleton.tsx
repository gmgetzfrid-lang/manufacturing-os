// Skeleton — shimmer placeholder block for loading states. Token-driven
// so it reads correctly on both themes. Compose into page-shaped
// skeletons in loading.tsx files instead of bare centered spinners.

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`rounded-lg bg-[linear-gradient(100deg,var(--color-surface-2)_40%,var(--color-border)_50%,var(--color-surface-2)_60%)] bg-[length:200%_100%] animate-shimmer ${className}`}
    />
  );
}

export default Skeleton;
