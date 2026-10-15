// lib/estate3d.ts — the estate tree as a globe in 3D.
//
// The same tree as the Map (operating area → equipment type → equipment →
// documents). The site sits at the centre; operating areas spread evenly
// around it; each area's equipment types fan outward in a cone, equipment
// beyond them. Every position is fixed — no physics — so the view is a
// place you can learn.
//
// Documents are FOLDED by default: a piece of equipment says "V-14 · 12
// docs" instead of growing a starburst of twelve labels. Opening it (a
// click) shows them; more than a handful at once are split into named
// groups by how they are numbered ("EP-10 (24)", "EP-11 (31)") or into
// ranges, each opened the same way. Opening one never moves anything else:
// the space a thing's documents will need is reserved whether they are
// shown or not. Every link carries why it exists. Pure.

import { buildEstateTree, type TreeNode } from "@/lib/estateTree";
import type { GraphNode, GraphEdge, GraphNodeType } from "@/lib/orgGraph";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
export const HUB = "__estate__";
/** More documents than this under one parent are split into groups. */
const GROUP_AT = 14;
type V3 = [number, number, number];
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** k directions spread evenly over a cap of half-angle `angle` around `u`
 *  (the whole sphere when angle is π). */
export function capDirections(u: V3, k: number, angle: number): V3[] {
  if (k <= 0) return [];
  if (k === 1) return [norm(u)];
  const z = norm(u);
  const helper: V3 = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = norm(cross(helper, z)), y = cross(z, x);
  const out: V3[] = [];
  const span = 1 - Math.cos(angle);
  for (let i = 0; i < k; i++) {
    const cz = 1 - span * ((i + 0.5) / k);
    const r = Math.sqrt(Math.max(0, 1 - cz * cz));
    const phi = i * GOLDEN;
    const lx = r * Math.cos(phi), ly = r * Math.sin(phi);
    out.push(norm([x[0] * lx + y[0] * ly + z[0] * cz, x[1] * lx + y[1] * ly + z[1] * cz, x[2] * lx + y[2] * ly + z[2] * cz]));
  }
  return out;
}

export type GlobeKind = "site" | "area" | "category" | "asset" | "project" | "group" | "library" | "document" | "docgroup";

/** What the hover card and the side panel say about a node. */
export interface GlobeInfo {
  kind: GlobeKind;
  /** "Operating area", "Equipment type", … */
  kindLabel: string;
  /** Documents under it, shown or not. */
  docs: number;
  /** Equipment under it. */
  equipment: number;
  /** Has documents to open (or a group to open). */
  openable: boolean;
  open: boolean;
  parentId: string | null;
}

const KIND_LABEL: Record<GlobeKind, string> = {
  site: "The site", area: "Operating area", category: "Equipment type", asset: "Equipment", project: "Project",
  group: "Group", library: "Library", document: "Document", docgroup: "Group of documents",
};

const tokens = (s: string) => s.toUpperCase().split(/[-_ ./]+/).filter(Boolean);

/** Split documents into at most GROUP_AT named groups: by the shared start
 *  of their numbers when that gives a sensible split, else by ranges. */
export function groupDocuments(docs: Array<{ id: string; label: string }>): Array<{ key: string; label: string; ids: string[] }> {
  const sorted = [...docs].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const labelOf = new Map(docs.map((d) => [d.id, d.label]));
  /** Runs of documents as ranges: "EP-30 … EP-89 (60)". */
  const ranges = (ids: string[], n: number, tag: string) => {
    const out: Array<{ key: string; label: string; ids: string[] }> = [];
    const size = Math.ceil(ids.length / Math.max(1, n));
    for (let i = 0; i < ids.length; i += size) {
      const part = ids.slice(i, i + size);
      const first = labelOf.get(part[0])!, last = labelOf.get(part[part.length - 1])!;
      out.push({ key: `${tag}${i}`, label: part.length === 1 ? first : `${first.slice(0, 12)} … ${last.slice(0, 12)} (${part.length})`, ids: part });
    }
    return out;
  };
  for (let depth = 1; depth <= 3; depth++) {
    const by = new Map<string, string[]>();
    for (const d of sorted) {
      const t = tokens(d.label);
      const key = t.length > depth ? t.slice(0, depth).join("-") : t.join("-") || "Other";
      by.set(key, [...(by.get(key) ?? []), d.id]);
    }
    if (by.size < 2 || [...by.values()].some((l) => l.length >= docs.length * 0.8)) continue;
    if (by.size <= GROUP_AT) return [...by.entries()].map(([key, ids]) => ({ key, label: `${key} (${ids.length})`, ids }));
    // Too many keys: the series that hold several documents keep their
    // names, the one-offs become ranges.
    const big = [...by.entries()].filter(([, l]) => l.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, GROUP_AT - 3);
    if (big.length >= 2) {
      const named = new Set(big.flatMap(([, l]) => l));
      const rest = sorted.map((d) => d.id).filter((id) => !named.has(id));
      return [
        ...big.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([key, ids]) => ({ key, label: `${key} (${ids.length})`, ids })),
        ...(rest.length ? ranges(rest, Math.min(3, GROUP_AT - big.length), "rest") : []),
      ];
    }
  }
  return ranges(sorted.map((d) => d.id), GROUP_AT, "r");
}

export function estateGlobe(
  nodes: GraphNode[], edges: GraphEdge[],
  opts: { open?: Set<string>; hiddenTypes?: GraphNodeType[] } = {},
): { nodes: GraphNode[]; edges: GraphEdge[]; pos: Record<string, [number, number, number]>; info: Map<string, GlobeInfo> } {
  const hidden = new Set(opts.hiddenTypes ?? []);
  const open = opts.open ?? new Set<string>();
  const shown = nodes.filter((n) => !hidden.has(n.type));
  const shownIds = new Set(shown.map((n) => n.id));
  const tree = buildEstateTree(shown, edges.filter((e) => shownIds.has(e.a) && shownIds.has(e.b)));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const treeById = new Map(tree.map((t) => [t.id, t]));

  // Why a parent and child are linked: the source edge's own reason.
  const why = new Map<string, string>();
  for (const e of edges) if (e.why) { why.set(`${e.a}|${e.b}`, e.why); why.set(`${e.b}|${e.a}`, e.why); }

  // Nothing is dropped: documents not placed anywhere yet sit, folded,
  // under "Not placed yet" by library — open it to see which.
  const keep = tree;

  // The Map's "Documents (n)" group is just a container: its documents
  // belong to the area itself here.
  const container = new Map<string, string>();
  for (const t of keep) if (t.kind === "group" && t.id.startsWith("docs:") && t.parentId) container.set(t.id, t.parentId);
  const parentOf = (t: TreeNode) => (t.parentId && container.has(t.parentId) ? container.get(t.parentId)! : t.parentId);
  const structural = keep.filter((t) => t.kind !== "document" && !container.has(t.id));
  const docsOf = new Map<string, TreeNode[]>();
  for (const t of keep) if (t.kind === "document") { const p = parentOf(t); if (p) docsOf.set(p, [...(docsOf.get(p) ?? []), t]); }
  const kidsOf = new Map<string | null, TreeNode[]>();
  for (const t of structural) kidsOf.set(t.parentId, [...(kidsOf.get(t.parentId) ?? []), t]);

  // Totals under each node (for labels, cards and room on the globe).
  const docTotal = new Map<string, number>(), eqTotal = new Map<string, number>(), weight = new Map<string, number>();
  const tally = (t: TreeNode): void => {
    let d = docsOf.get(t.id)?.length ?? 0, q = t.kind === "asset" ? 1 : 0, w = 1 + Math.sqrt(d) * 2;
    for (const k of kidsOf.get(t.id) ?? []) { tally(k); d += docTotal.get(k.id)!; q += eqTotal.get(k.id)!; w += weight.get(k.id)!; }
    docTotal.set(t.id, d); eqTotal.set(t.id, q); weight.set(t.id, w);
  };
  const roots = kidsOf.get(null) ?? [];
  for (const r of roots) tally(r);

  const outNodes: GraphNode[] = [];
  const outEdges: GraphEdge[] = [];
  const info = new Map<string, GlobeInfo>();
  const pos: Record<string, V3> = {};
  const kindOf = (t: TreeNode): GlobeKind => (t.kind === "area" ? "area" : t.kind === "category" ? "category" : t.kind === "asset" ? "asset" : t.kind === "project" ? "project" : t.kind === "library" ? "library" : t.kind === "document" ? "document" : "group");
  const typeOf = (k: GlobeKind): GraphNodeType => (k === "area" ? "unit" : k === "category" ? "plant" : k === "asset" ? "asset" : k === "project" ? "project" : k === "document" ? "document" : "library");
  const docsLabel = (n: number) => (n ? ` · ${n} doc${n === 1 ? "" : "s"}` : "");

  const emit = (id: string, kind: GlobeKind, label: string, parentId: string | null, at: V3, extra: Partial<GlobeInfo> = {}, sub?: string) => {
    const g = byId.get(id);
    const own = docsOf.get(id)?.length ?? 0;
    const i: GlobeInfo = { kind, kindLabel: KIND_LABEL[kind], docs: docTotal.get(id) ?? 0, equipment: eqTotal.get(id) ?? 0, openable: own > 0, open: open.has(id), parentId, ...extra };
    info.set(id, i);
    const shownLabel = kind === "asset" || kind === "area" || kind === "project" ? `${label}${!i.open ? docsLabel(own) : ""}` : label;
    outNodes.push(g ? { ...g, label: shownLabel } : { id, type: typeOf(kind), label: shownLabel, href: "#", degree: (kidsOf.get(id)?.length ?? 0) + own, sub: sub ?? KIND_LABEL[kind] });
    pos[id] = at;
    if (parentId) {
      const pa = byId.get(parentId)?.label ?? treeById.get(parentId)?.label ?? "";
      const reason = why.get(`${parentId}|${id}`)
        ?? (kind === "area" ? `${label} is an operating area of the site`
          : kind === "category" ? `Equipment in ${pa.replace(/ · .*$/, "")} grouped by type`
          : kind === "asset" && treeById.get(parentId)?.kind === "category" ? `${label} is ${pa.replace(/ \(\d+\)$/, "").toLowerCase()} equipment`
          : kind === "docgroup" ? `Documents numbered ${label.replace(/ \(\d+\)$/, "")}`
          : `${label} sits under ${pa}`);
      outEdges.push({ a: parentId, b: id, type: kind === "document" || kind === "docgroup" ? "tag" : kind === "library" || kind === "group" ? "library" : "unit", why: reason });
    }
  };

  // Documents of a node, around one reserved direction.
  const placeDocs = (ownerId: string, docs: TreeNode[], at: V3, dir: V3, depth: number, groupId: string) => {
    if (docs.length > GROUP_AT) {
      const groups = groupDocuments(docs.map((d) => ({ id: d.id, label: d.label })));
      const dirs = capDirections(dir, groups.length, Math.min(1.2, 0.3 + 0.12 * Math.sqrt(groups.length)));
      groups.forEach((g, i) => {
        const gid = `${groupId}:${g.key}`;
        const len = 60 + 10 * Math.sqrt(g.ids.length);
        const p: V3 = [at[0] + dirs[i][0] * len, at[1] + dirs[i][1] * len, at[2] + dirs[i][2] * len];
        const isOpen = open.has(gid);
        emit(gid, "docgroup", g.label, ownerId, p, { docs: g.ids.length, equipment: 0, openable: true, open: isOpen });
        if (isOpen) placeDocs(gid, g.ids.map((d) => treeById.get(d)!).filter(Boolean), p, dirs[i], depth + 1, gid);
      });
      return;
    }
    const dirs = capDirections(dir, docs.length, Math.min(1.1, 0.25 + 0.12 * Math.sqrt(docs.length)));
    docs.forEach((d, i) => {
      const len = 45 + 3 * Math.sqrt(docs.length);
      emit(d.id, "document", d.label, ownerId, [at[0] + dirs[i][0] * len, at[1] + dirs[i][1] * len, at[2] + dirs[i][2] * len]);
    });
  };

  const byWeight = (l: TreeNode[]) => [...l].sort((p, q) => weight.get(q.id)! - weight.get(p.id)! || p.label.localeCompare(q.label));
  const place = (t: TreeNode, parentId: string | null, at: V3, dir: V3, depth: number) => {
    emit(t.id, kindOf(t), t.label, parentId, at);
    const kids = byWeight(kidsOf.get(t.id) ?? []);
    const docs = docsOf.get(t.id) ?? [];
    // One slot is always kept for the documents, so opening them moves
    // nothing else.
    const slots = kids.length + (docs.length ? 1 : 0);
    if (!slots) return;
    const angle = Math.min(1.3, (0.32 + 0.15 * Math.sqrt(slots)) * Math.pow(0.78, depth));
    const dirs = capDirections(dir, slots, angle);
    kids.forEach((k, i) => {
      const len = 70 + 22 * Math.sqrt(weight.get(k.id)!) + (slots > 12 ? 40 : 0);
      place(k, t.id, [at[0] + dirs[i][0] * len, at[1] + dirs[i][1] * len, at[2] + dirs[i][2] * len], dirs[i], depth + 1);
    });
    if (docs.length && open.has(t.id)) {
      const d = dirs[slots - 1];
      // Out past the node, on the reserved direction.
      const hubLen = 30;
      placeDocs(t.id, docs, [at[0] + d[0] * hubLen, at[1] + d[1] * hubLen, at[2] + d[2] * hubLen], d, depth + 1, `dg:${t.id}`);
    }
  };

  const total = roots.reduce((s2, r) => s2 + weight.get(r.id)!, 0);
  const R0 = 110 + 12 * Math.sqrt(total) + 30 * Math.sqrt(roots.length);
  const rootDirs = capDirections([0, 1, 0], roots.length, Math.PI);
  const hasHub = roots.length > 1;
  if (hasHub) {
    const docs = roots.reduce((s2, r) => s2 + docTotal.get(r.id)!, 0);
    const eq = roots.reduce((s2, r) => s2 + eqTotal.get(r.id)!, 0);
    info.set(HUB, { kind: "site", kindLabel: KIND_LABEL.site, docs, equipment: eq, openable: false, open: false, parentId: null });
    outNodes.push({ id: HUB, type: "plant", label: "Site", href: "#", degree: roots.length, sub: `${roots.length} areas and groups · ${eq} equipment · ${docs} documents` });
    pos[HUB] = [0, 0, 0];
  }
  byWeight(roots).forEach((r, i) => place(r, hasHub ? HUB : null, [rootDirs[i][0] * R0, rootDirs[i][1] * R0, rootDirs[i][2] * R0], rootDirs[i], 0));

  return { nodes: outNodes, edges: outEdges, pos, info };
}
