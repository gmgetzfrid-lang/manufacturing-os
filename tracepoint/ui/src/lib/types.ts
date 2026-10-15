export type Role = "admin" | "indexer" | "user";

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  must_change: boolean;
  disabled: boolean;
  can_ai: boolean;
  created_at: string;
  created_by?: string | null;
  pw_changed_at?: string | null;
  last_login_at?: string | null;
  has_ai_key: boolean;
}

export interface IndexState { ready: boolean; message: string; source: string; source_kind: string; error?: string | null }

export interface AppState {
  stage: "login" | "change_password" | "ready";
  version: string;
  user: User | null;
  keys_unlocked: boolean;
  index: IndexState;
  policy: { ai_enabled: boolean; ai_providers: string[] };
  prefs: Record<string, string>;
  profiles_location: string;
}

export interface EquipRef { id: number; number: string; tag?: string | null; description: string; unit?: string | null; via: string }

export interface Hit {
  id: number;
  rank: number;
  name: string;
  path: string;
  folder: string;
  unit?: string | null;
  category: string;
  doctype: string;
  year?: number | null;
  ext: string;
  size: number;
  modified: number;
  score: number;
  reasons: string[];
  equipment: EquipRef[];
  sheet?: string | null;
  rev?: string | null;
  latest: boolean;
  archived: boolean;
  blank: boolean;
  junk: boolean;
  page?: number;
  snippet?: string;
}

export interface Facet { key: string; label: string; count: number }
export interface Chip { kind: string; text: string; detail: string }
export interface EquipOption { id: number; number: string; tag?: string | null; description: string; unit?: string | null; files: number }

export interface EquipCard {
  id: number;
  number: string;
  tags: string[];
  description: string;
  kind: string;
  unit?: string | null;
  folder?: string | null;
  historical: string[];
  hint_numbers: string[];
  files: number;
  by_category: Facet[];
  latest_inspection?: number | null;
  first_year?: number | null;
  drawing_families: string[];
  related: EquipOption[];
}

export interface SearchResponse {
  query: string;
  mode?: string;
  total: number;
  suppressed_photos: number;
  took_ms: number;
  hits: Hit[];
  facets: { categories: Facet[]; units: Facet[]; years: Facet[]; exts: Facet[]; equipment: Facet[] };
  chips: Chip[];
  ambiguity: { token: string; options: EquipOption[] }[];
  card?: EquipCard | null;
  suggestions: string[];
  notice?: string | null;
  best?: string | null;
  inside?: Hit[];
}

export interface SearchRequest {
  query: string;
  mode?: string;
  limit?: number;
  offset?: number;
  categories?: string[];
  units?: string[];
  exts?: string[];
  year_min?: number | null;
  year_max?: number | null;
  include_photos?: boolean;
  include_junk?: boolean;
  hide_archive?: boolean;
  equipment?: number | null;
  sort?: string;
}
