// lib/nodeIcons.tsx
// Curated icon set for customizing libraries and folders. Keyed by a
// short string stored on the node (collections.icon / libraries.icon).

import { createElement } from "react";
import {
  Folder, FolderOpen, FolderGit2, Wrench, Cog, Factory, FlaskConical, Beaker,
  Zap, Droplets, Flame, Gauge, ShieldCheck, HardHat, FileText, Boxes, Building2,
  Pipette, CircuitBoard, Hammer, Ruler, Microscope, Truck, Recycle, Layers,
  type LucideIcon,
} from "lucide-react";

export const NODE_ICONS: Record<string, LucideIcon> = {
  folder: Folder, folderOpen: FolderOpen, project: FolderGit2,
  wrench: Wrench, cog: Cog, factory: Factory, flask: FlaskConical, beaker: Beaker,
  zap: Zap, water: Droplets, flame: Flame, gauge: Gauge, shield: ShieldCheck,
  safety: HardHat, doc: FileText, boxes: Boxes, building: Building2,
  pipette: Pipette, circuit: CircuitBoard, hammer: Hammer, ruler: Ruler,
  microscope: Microscope, truck: Truck, recycle: Recycle, layers: Layers,
};

export const NODE_ICON_KEYS = Object.keys(NODE_ICONS);

export function resolveNodeIcon(key?: string | null): LucideIcon {
  return (key && NODE_ICONS[key]) || Folder;
}

/** Render an icon by key. Uses createElement with the resolved (stable) icon
 *  component rather than a dynamic `<Icon/>` JSX tag, so it doesn't trip the
 *  "no components created during render" rule. */
export function NodeIcon({ name, className }: { name?: string | null; className?: string }) {
  return createElement(resolveNodeIcon(name), { className });
}
