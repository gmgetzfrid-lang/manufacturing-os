// lib/featureAtlas.ts — the app's knowledge of ITSELF.
//
// Fragmentation isn't having many tools; it's the person having to carry
// the map in their head. This module is the map, as data, in ONE place:
// every destination, what actually lives there, and the words a person
// would use when they can't remember its name ("numbering system",
// "decoder", "where did my import go"). Two consumers keep it honest:
//
//   * the ⌘K palette — type what you're looking for, land on the place
//   * the assistant — "where do I manage our numbering?" answers with the
//     real place and its path, not a guess
//
// Rule for entries: the blurb says what LIVES there in the user's words,
// and aliases capture how people actually ask — including the wrong words.

export interface AtlasEntry {
  label: string;
  href: string;
  area: "work" | "intelligence" | "admin";
  /** What lives here — written for the person searching, not the sitemap. */
  blurb: string;
  /** Lowercase search words, including the ways people misremember it. */
  aliases: string[];
}

export const FEATURE_ATLAS: AtlasEntry[] = [
  // ── Work ────────────────────────────────────────────────────────────────
  {
    label: "Home", href: "/dashboard", area: "work",
    blurb: "Your dashboard — widgets, attention feed, live coordination.",
    aliases: ["dashboard", "home", "widgets", "my desk", "attention"],
  },
  {
    label: "Documents", href: "/documents", area: "work",
    blurb: "Controlled libraries: revisions, locks, checkouts, distribution, packages, the title-block ingest wizard, and the per-library Equipment sweep.",
    aliases: ["library", "libraries", "drawings", "revisions", "checkout", "locks", "dms", "files", "title block", "ingest", "equipment sweep", "bulk import"],
  },
  {
    label: "Operating areas", href: "/admin/assets", area: "work",
    blurb: "The equipment registry, unit by unit: categories (auto-categorized from your Site Codebook), photos, linked documents, and each unit's process-flows panel.",
    aliases: ["equipment", "assets", "registry", "units", "unit hub", "categorize", "uncategorized", "asset types", "photos", "process flows panel", "read pfd"],
  },
  {
    label: "Plot plans", href: "/plot-plans", area: "work",
    blurb: "Spatial maps — plot plans and layouts with clickable equipment markers.",
    aliases: ["plot map", "plot plan", "layout", "map", "spatial", "site map"],
  },
  {
    label: "Projects", href: "/projects", area: "work",
    blurb: "Project workspaces, milestones, document travel, and external intake.",
    aliases: ["project", "milestones", "intake", "contractor"],
  },
  {
    label: "Drafting requests", href: "/requests", area: "work",
    blurb: "The drafting and design request portal with tickets and deliverable revisions.",
    aliases: ["tickets", "drafting", "design request", "work request"],
  },
  {
    label: "Transmittals", href: "/transmittals", area: "work",
    blurb: "Issue documents to outside parties with cover sheets and recipient portals.",
    aliases: ["transmittal", "send documents", "issue", "external"],
  },
  {
    label: "Output docs", href: "/output-templates", area: "work",
    blurb: "Generate scopes and letters from templates plus live data.",
    aliases: ["templates", "generate", "letters", "scope of work", "docx"],
  },
  {
    label: "Activity", href: "/activity", area: "work",
    blurb: "History and the audit trail of everything that happened.",
    aliases: ["history", "audit", "log", "who did what"],
  },
  // ── Intelligence ───────────────────────────────────────────────────────
  {
    label: "Intelligence overview", href: "/intelligence", area: "intelligence",
    blurb: "The AI status board — what's indexed, what's connected, what needs attention.",
    aliases: ["ai", "intelligence", "overview", "status"],
  },
  {
    label: "Ask the assistant", href: "/assistant", area: "intelligence",
    blurb: "Talk to the whole workspace — the assistant searches, reads, and proposes actions you approve.",
    aliases: ["assistant", "ask", "chat", "orchestrator", "agent"],
  },
  {
    label: "Knowledge libraries", href: "/knowledge", area: "intelligence",
    blurb: "Indexed PDFs you can question — answers cite the exact page, with proof highlighting and shape-the-graph for admins.",
    aliases: ["knowledge", "ask a document", "questions", "citations", "indexed", "pdf", "standards", "shape the graph"],
  },
  {
    label: "Org graph", href: "/graph", area: "intelligence",
    blurb: "The whole org as one map, with lenses: Everything, Process (flow map), Equipment ↔ Docs, Documents. Draw links and flows with Connect.",
    aliases: ["graph", "map", "web", "connections view", "lenses", "process lens", "flow map", "draw connection", "3d"],
  },
  {
    label: "Connection review", href: "/admin/proposed-links", area: "intelligence",
    blurb: "Run Find connections, review what the skills discovered (each with its evidence), and see exactly why nothing was found.",
    aliases: ["proposed links", "find connections", "review", "link discovery", "auto detect", "proposals"],
  },
  {
    label: "Skill library", href: "/intelligence/skills", area: "intelligence",
    blurb: "Connection Skills (how links are discovered) and Reasoning Skills (how the AI answers) — built-ins and your own, org-wide or private, with the AI-assisted Skill Studio.",
    aliases: ["skills", "skill studio", "reasoning skills", "connection skills", "detectors", "basis of design", "shift handover", "plain language"],
  },
  {
    label: "AI settings", href: "/intelligence/setup", area: "intelligence",
    blurb: "Your own AI key, provider, spend caps, and the acceptable-use agreement.",
    aliases: ["ai key", "api key", "openai", "claude", "anthropic", "budget", "cap", "provider", "ai setup"],
  },
  // ── Admin ──────────────────────────────────────────────────────────────
  {
    label: "Facility setup", href: "/setup", area: "admin",
    blurb: "The resumable setup navigator — live counts across every subsystem, flagged where to continue. Launch it any time; it knows where you left off.",
    aliases: ["setup", "onboarding", "getting started", "wizard", "continue setup", "what now", "next step"],
  },
  {
    label: "Site Codebook", href: "/admin/codebook", area: "admin",
    blurb: "Your facility's language: unit names and numbers, equipment-type prefixes, the drawing-number decoder, and the AI import that reads them from your own documents. Structure imports land HERE.",
    aliases: ["codebook", "numbering system", "numbering", "naming convention", "decoder", "unit numbers", "prefixes", "equipment types", "drawing number format", "structure", "where did my import go", "legend"],
  },
  {
    label: "Operational scope", href: "/admin/scope", area: "admin",
    blurb: "Plants, units, and systems — the operational hierarchy behind filing.",
    aliases: ["plants", "scope", "hierarchy", "systems"],
  },
  {
    label: "Users", href: "/admin/users", area: "admin",
    blurb: "Members, roles, and invitations.",
    aliases: ["users", "members", "roles", "invite", "people"],
  },
  {
    label: "Teams", href: "/admin/teams", area: "admin",
    blurb: "Team groupings for assignment and distribution.",
    aliases: ["teams", "groups", "crews"],
  },
  {
    label: "Library config", href: "/admin/libraries", area: "admin",
    blurb: "Create and configure document libraries — numbering rules, review controls, columns.",
    aliases: ["library settings", "library config", "columns", "auto numbering", "review control"],
  },
  {
    label: "Permissions", href: "/admin/permissions", area: "admin",
    blurb: "The access control truth: per-library ACLs and workspace capability policy.",
    aliases: ["permissions", "acl", "access", "who can", "capabilities", "view as"],
  },
  {
    label: "Request forms", href: "/admin/requests", area: "admin",
    blurb: "Configure the drafting-request portal's forms.",
    aliases: ["request forms", "form builder"],
  },
  {
    label: "Analytics", href: "/admin/analytics", area: "admin",
    blurb: "Workspace analytics and usage.",
    aliases: ["analytics", "stats", "usage", "metrics"],
  },
  {
    label: "Audit log", href: "/admin/audit", area: "admin",
    blurb: "The full administrative audit trail.",
    aliases: ["audit log", "security log"],
  },
  {
    label: "Storage & backup", href: "/admin/storage", area: "admin",
    blurb: "Storage usage, ceilings, and backup state.",
    aliases: ["storage", "backup", "disk", "space"],
  },
  {
    label: "Data export", href: "/admin/data-export", area: "admin",
    blurb: "Export the workspace — every table and file, for portability.",
    aliases: ["export", "download everything", "portability"],
  },
  {
    label: "Restore", href: "/admin/restore", area: "admin",
    blurb: "Restore a workspace from a backup, with a previewed reconciliation plan.",
    aliases: ["restore", "import backup", "recover"],
  },
  {
    label: "Billing", href: "/admin/billing", area: "admin",
    blurb: "Subscription and seats.",
    aliases: ["billing", "subscription", "plan", "seats", "payment"],
  },
  {
    label: "Branding", href: "/admin/branding", area: "admin",
    blurb: "Workspace name, logo, and appearance.",
    aliases: ["branding", "logo", "appearance", "theme"],
  },
  {
    label: "Workspace settings", href: "/admin/settings", area: "admin",
    blurb: "Org-wide settings.",
    aliases: ["settings", "workspace settings", "org settings"],
  },
];

/** Palette search: token match over label, aliases, and blurb. Every typed
 *  token must land somewhere — "unit numbering" matches the Codebook even
 *  though no single field contains that phrase. */
export function searchAtlas(query: string, limit = 5): AtlasEntry[] {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];
  const scored: Array<{ e: AtlasEntry; score: number }> = [];
  for (const e of FEATURE_ATLAS) {
    const label = e.label.toLowerCase();
    const hay = `${label} ${e.aliases.join(" ")} ${e.blurb.toLowerCase()}`;
    let score = 0;
    let allHit = true;
    for (const t of tokens) {
      if (label.includes(t)) score += 3;
      else if (e.aliases.some((a) => a.includes(t))) score += 2;
      else if (hay.includes(t)) score += 1;
      else { allHit = false; break; }
    }
    if (allHit) scored.push({ e, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.e);
}

/** Compact app map for the assistant's prompt: when someone asks WHERE a
 *  thing lives or HOW to find a feature, the answer comes from here — the
 *  real place and its path — instead of a guess. */
export function atlasForPrompt(): string {
  const lines = FEATURE_ATLAS.map((e) => `- ${e.label} (${e.href}): ${e.blurb}`);
  return (
    "\n\nAPP MAP — where everything in this application lives. When the user asks where a " +
    "feature, setting, or piece of imported knowledge is, or how to do something in the app, " +
    "answer from this map: name the place, give its path, and say what to do there. Never " +
    "invent destinations that are not on this map.\n" + lines.join("\n")
  );
}
