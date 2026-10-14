// lib/find/types.ts — what the one find service returns, to every surface.
//
// A result is a document with its score, its verdict, the evidence that put
// it there (which layer found it and why), and its RELATIONS to whatever the
// query resolved to — drawn on, mentioned in, tagged to, filed under, in
// project. Around the results: the entities the query named, the work in
// flight around them, what was hidden and why, and how much of the scope
// has actually been read.

import type { QueryChip } from "@/lib/fileFinder/queryParse";
import type { Evidence, Verdict } from "@/lib/fileFinder/rank";

export type FindLayer = "L0" | "L1" | "L2" | "L3";

export interface FindEvidence extends Evidence { layer: FindLayer }

export type RelationKind = "drawn_on" | "mentioned_in" | "tagged_to" | "filed_under" | "in_project" | "linked_unit";

export interface FindRelation {
  rel: RelationKind;
  /** Which entity it relates to (asset / project / unit node id). */
  node: string;
  label: string;        // "X-35", "AFE200155", "Crude Unit"
  detail: string;       // "sheet 7, upper left" / the sentence / "Equipment/Crude/X-35"
  page?: number;
  x?: number; y?: number;
  snippet?: string;
  /** The knowledge document id, for opening at the page. */
  knowledgeDocId?: string;
}

export interface FindResult {
  id: string;              // "doc:<id>"
  documentId: string;
  name: string;
  title: string | null;
  number: string | null;
  rev: string | null;
  status: string | null;
  libraryId: string;
  libraryName: string | null;
  folderId: string | null;
  path: string[];
  href: string;
  docTypes: string[];
  sheet?: number;
  score: number;
  verdict: Verdict;
  evidence: FindEvidence[];
  relations: FindRelation[];
  read?: { knowledgeDocId: string; status: string; pages: number; fileKey?: string };
  /** Page-level hits from the text, best first. */
  pages: Array<{ page: number; snippet: string; knowledgeDocId: string }>;
  sameBytes: number;
}

export interface FindEntity {
  node: string;            // asset:<id> / cbunit:<code> / proj:<id>
  kind: "asset" | "unit" | "project";
  label: string;           // "X-35"
  sub?: string;            // "Exchanger · Crude Unit" / "AFE200155"
  via: string;             // "typed" / "alias 'north furnace'" / "codebook"
  href?: string;
}

export interface FindActivity {
  tickets: Array<{ id: string; ticketId: string; title: string; status: string; unit: string | null; requester: string | null; drafter: string | null; createdAt: string; href: string; why: string }>;
  checkouts: Array<{ id: string; documentId: string; documentName: string; user: string | null; since: string; projectId: string | null; projectName: string | null; mode: string | null; href: string }>;
  markups: Array<{ id: string; documentId: string; documentName: string; requestedBy: string | null; requestedFrom: string | null; status: string; createdAt: string; href: string }>;
  holds: Array<{ id: string; documentId: string; documentName: string; reason: string | null; openedBy: string | null; openedAt: string; href: string }>;
  projects: Array<{ id: string; name: string; status: string | null; why: string; href: string }>;
  milestones: Array<{ id: string; name: string; plannedAt: string | null; status: string | null; projectId: string | null; projectName: string | null; href: string }>;
}

export interface FindCoverage {
  inScope: number;
  read: number;
  unread: number;
  /** Folders with the most unread files, for the "read these" action. */
  unreadFolders: Array<{ folderId: string | null; libraryId: string; path: string; count: number }>;
}

export interface FindResponse {
  chips: QueryChip[];
  entities: FindEntity[];
  results: FindResult[];
  /** Results dropped because the query asked for a different document type. */
  hidden: { count: number; byType: Record<string, number> };
  groups: Array<{ key: string; label: string; ids: string[] }>;
  activity: FindActivity;
  coverage: FindCoverage;
  layers: FindLayer[];
  notes: string[];
  tookMs: number;
}

export interface FindRequest {
  orgId: string;
  query: string;
  scope?: { folderId?: string; libraryId?: string; unitCode?: string; projectId?: string; assetId?: string };
  limit?: number;
  /** Skip the activity layer (cheaper) — e.g. for a palette. */
  activity?: boolean;
  /** Skip the meaning layer (an embedding call) — e.g. for a palette. */
  semantic?: boolean;
}
