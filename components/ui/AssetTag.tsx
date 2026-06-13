import React from 'react';
import { Settings, Zap, Droplet, Box, Activity } from 'lucide-react';

interface AssetTagProps {
  tag: string;
  type?: string; // 'Pump', 'Exchanger', 'Valve', etc.
}

const getIcon = (type: string) => {
  const t = (type || '').toLowerCase();
  if (t.includes('pump')) return <Activity className="w-3 h-3" />;
  if (t.includes('exchanger') || t.includes('heat')) return <Zap className="w-3 h-3" />;
  if (t.includes('vessel') || t.includes('tank')) return <Box className="w-3 h-3" />;
  if (t.includes('valve')) return <Droplet className="w-3 h-3" />;
  return <Settings className="w-3 h-3" />;
};

export default function AssetTag({ tag, type = 'Equipment' }: AssetTagProps) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] mr-1 mb-1 whitespace-nowrap hover:bg-[var(--color-surface)] hover:border-[var(--color-accent-ring)] hover:text-[var(--color-accent)] transition-colors cursor-pointer shadow-sm">
      <span className="text-[var(--color-text-faint)] mr-1.5">{getIcon(type)}</span>
      {tag}
    </span>
  );
}