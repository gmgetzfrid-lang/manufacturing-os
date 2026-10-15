//! The TracePoint search engine.
//!
//! Base: TracePoint 1.x ranking (validated on THOR queries) — exact equipment
//! identity, every meaningful word required, inspection-record priority,
//! blank templates and photos demoted unless asked for, two photos per folder,
//! and a reason for every point. Added from the Manufacturing OS finder:
//! typo tolerance, sheet/revision awareness, latest revision, unit words,
//! tag canonical forms, facets, and "which V-2?" clarification when a tag
//! names several pieces of equipment (as the THOR index contract requires).

use crate::classify::Category;
use crate::index::*;
use crate::text::{self, IdKind};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

pub struct Engine {
    pub idx: Index,
    pub(crate) postings: Vec<Vec<u32>>,
    pub(crate) tag_postings: HashMap<u32, Vec<u32>>,
    vocab_by_len: Vec<Vec<u32>>,
    /// Stemmed description + kind words per equipment (natural-language search).
    pub(crate) eq_tokens: Vec<Vec<String>>,
    pub(crate) eq_df: HashMap<String, u32>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SearchRequest {
    pub query: String,
    pub limit: usize,
    pub offset: usize,
    pub categories: Vec<String>,
    pub units: Vec<String>,
    pub exts: Vec<String>,
    pub year_min: Option<i32>,
    pub year_max: Option<i32>,
    pub include_photos: bool,
    pub include_junk: bool,
    pub hide_archive: bool,
    /// Pin results to one piece of equipment (from a "which V-2?" choice).
    pub equipment: Option<u32>,
    pub sort: String,
    /// "" / "auto": spoken requests use natural-language ranking, keyword
    /// searches stay exact. "exact": TracePoint rules only. "natural".
    pub mode: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct EquipRef {
    pub id: u32,
    pub number: String,
    pub tag: Option<String>,
    pub description: String,
    pub unit: Option<String>,
    pub via: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct Hit {
    pub id: u32,
    pub rank: usize,
    pub name: String,
    pub path: String,
    pub folder: String,
    pub unit: Option<String>,
    pub category: &'static str,
    pub doctype: &'static str,
    pub year: Option<i16>,
    pub ext: String,
    pub size: i64,
    pub modified: i64,
    pub score: i32,
    pub reasons: Vec<String>,
    pub equipment: Vec<EquipRef>,
    pub sheet: Option<String>,
    pub rev: Option<String>,
    pub latest: bool,
    pub archived: bool,
    pub blank: bool,
    pub junk: bool,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct Facet {
    pub key: String,
    pub label: String,
    pub count: u32,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct Facets {
    pub categories: Vec<Facet>,
    pub units: Vec<Facet>,
    pub years: Vec<Facet>,
    pub exts: Vec<Facet>,
    pub equipment: Vec<Facet>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Chip {
    pub kind: &'static str,
    pub text: String,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Ambiguity {
    pub token: String,
    pub options: Vec<EquipOption>,
}

#[derive(Clone, Debug, Serialize)]
pub struct EquipOption {
    pub id: u32,
    pub number: String,
    pub tag: Option<String>,
    pub description: String,
    pub unit: Option<String>,
    pub files: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct EquipCard {
    pub id: u32,
    pub number: String,
    pub tags: Vec<String>,
    pub description: String,
    pub kind: String,
    pub unit: Option<String>,
    pub folder: Option<String>,
    pub historical: Vec<String>,
    pub hint_numbers: Vec<String>,
    pub files: u32,
    pub by_category: Vec<Facet>,
    pub latest_inspection: Option<i16>,
    pub first_year: Option<i16>,
    pub drawing_families: Vec<String>,
    pub related: Vec<EquipOption>,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct SearchResponse {
    pub query: String,
    pub total: usize,
    pub suppressed_photos: usize,
    pub took_ms: f64,
    pub hits: Vec<Hit>,
    pub facets: Facets,
    pub chips: Vec<Chip>,
    pub ambiguity: Vec<Ambiguity>,
    pub card: Option<EquipCard>,
    pub suggestions: Vec<String>,
    pub notice: Option<String>,
    /// "exact" or "natural": which engine produced these results.
    pub mode: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Via {
    Filename,
    Folder,
    Family,
    Literal,
    Renumbered,
    Hint,
}

struct Group {
    raw: String,
    /// file -> how it matched (best).
    members: HashMap<u32, (Via, u32)>,
    equipment: Vec<u32>,
}

struct Term {
    word: String,
    ids: Vec<u32>,
    fuzzy: bool,
    wildcard: bool,
    posting: Vec<u32>,
}

fn intersect(a: &[u32], b: &[u32]) -> Vec<u32> {
    let (mut i, mut j, mut out) = (0, 0, Vec::with_capacity(a.len().min(b.len())));
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                out.push(a[i]);
                i += 1;
                j += 1;
            }
        }
    }
    out
}

fn union_sorted(lists: &[&Vec<u32>]) -> Vec<u32> {
    let mut v: Vec<u32> = lists.iter().flat_map(|l| l.iter().copied()).collect();
    v.sort_unstable();
    v.dedup();
    v
}

static BEFORE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:before|prior to|until)\s+((?:19|20)\d{2})\b").unwrap());
static AFTER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:after|since|from)\s+((?:19|20)\d{2})\b").unwrap());
static RANGE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:between\s+)?((?:19|20)\d{2})\s*(?:-|–|\.\.|to|and|through)\s*((?:19|20)\d{2})\b").unwrap());
static YEAR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:^|[^0-9.])((?:19[5-9]|20[0-3])\d)(?:[^0-9.]|$)").unwrap());
static RECENT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(latest|recent|current|newest|last)\b").unwrap());
static SHEET_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:sht|sheet|sh)\.?\s*#?\s*(\d{1,3})\b").unwrap());
static REV_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:rev|revision)\.?\s*#?\s*([a-z0-9]{1,3})\b").unwrap());
static PHRASE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""([^"]{2,})""#).unwrap());
static UNIT_WORD_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bunit\s+(\d{4})\b|\b(\d{4})\s+unit\b").unwrap());
static WILD_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{Nd}._-]*\*[\p{L}\p{Nd}*._-]*").unwrap());
static RELIEF_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bPSV[-_ ]?\d|\bPRV[-_ ]?\d|\brelief\b").unwrap());
static REPORTISH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\breport\b|check ?list|field[-_ ]*notes|complete[-_ ]report").unwrap());
static CALIB_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bcalibration\b").unwrap());

fn norm_rev(s: &str) -> String {
    s.trim().trim_start_matches(['r', 'R']).trim_start_matches('0').to_lowercase()
}
fn norm_sheet(s: &str) -> String {
    let t = s.trim().trim_start_matches('0');
    if t.is_empty() { "0".into() } else { t.to_lowercase() }
}

impl Engine {
    pub fn new(idx: Index) -> Engine {
        let mut postings: Vec<Vec<u32>> = vec![Vec::new(); idx.terms.len()];
        let mut tag_postings: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut buf: Vec<u32> = Vec::with_capacity(64);
        for (fi, f) in idx.files.iter().enumerate() {
            buf.clear();
            buf.extend_from_slice(&f.name_terms);
            buf.extend_from_slice(&f.meta_terms);
            buf.extend_from_slice(&idx.dirs[f.dir as usize].terms);
            buf.sort_unstable();
            buf.dedup();
            for &t in &buf {
                postings[t as usize].push(fi as u32);
            }
            let dir_tags = &idx.dirs[f.dir as usize].tags;
            for &t in f.tags.iter().chain(dir_tags.iter()) {
                let p = tag_postings.entry(t).or_default();
                if p.last() != Some(&(fi as u32)) {
                    p.push(fi as u32);
                }
            }
        }
        for p in tag_postings.values_mut() {
            p.sort_unstable();
            p.dedup();
        }
        let mut vocab_by_len: Vec<Vec<u32>> = vec![Vec::new(); 40];
        for (i, t) in idx.terms.iter().enumerate() {
            if t.starts_with("tag:") || postings[i].is_empty() {
                continue;
            }
            let l = t.chars().count().min(39);
            vocab_by_len[l].push(i as u32);
        }
        let mut eq_tokens: Vec<Vec<String>> = Vec::with_capacity(idx.equipment.len());
        let mut eq_df: HashMap<String, u32> = HashMap::new();
        for e in &idx.equipment {
            let mut t: Vec<String> = text::word_tokens(&format!("{} {}", e.description, e.kind))
                .into_iter()
                .filter(|w| w.len() >= 2 && !w.chars().all(|c| c.is_ascii_digit()) && !text::STOPS.contains(w.as_str()))
                .collect();
            t.sort();
            t.dedup();
            for w in &t {
                *eq_df.entry(w.clone()).or_default() += 1;
            }
            eq_tokens.push(t);
        }
        Engine { idx, postings, tag_postings, vocab_by_len, eq_tokens, eq_df }
    }

    fn term_posting(&self, word: &str) -> Option<&Vec<u32>> {
        self.idx.term_ids.get(word).map(|&t| &self.postings[t as usize]).filter(|p| !p.is_empty())
    }

    /// Vocabulary words within the typo budget, most frequent first.
    pub(crate) fn fuzzy_terms_pub(&self, word: &str) -> Vec<u32> {
        self.fuzzy_terms(word)
    }

    pub(crate) fn equip_option_pub(&self, ei: u32) -> EquipOption {
        self.equip_option(ei)
    }

    fn fuzzy_terms(&self, word: &str) -> Vec<u32> {
        let n = word.chars().count();
        let budget = text::typo_budget(n);
        if budget == 0 || word.chars().all(|c| c.is_ascii_digit()) {
            return vec![];
        }
        let mut out: Vec<(usize, usize, u32)> = Vec::new();
        for l in n.saturating_sub(budget)..=(n + budget).min(39) {
            for &t in &self.vocab_by_len[l] {
                let cand = &self.idx.terms[t as usize];
                let d = text::edit_distance(word, cand, budget);
                if d <= budget {
                    out.push((d, usize::MAX - self.postings[t as usize].len(), t));
                }
            }
        }
        out.sort();
        out.into_iter().take(4).map(|x| x.2).collect()
    }

    fn equip_option(&self, ei: u32) -> EquipOption {
        let e = &self.idx.equipment[ei as usize];
        EquipOption {
            id: ei,
            number: e.number.clone(),
            tag: e.tags.first().cloned(),
            description: e.description.clone(),
            unit: e.unit.map(|u| self.idx.units[u as usize].label.clone()),
            files: e.file_count,
        }
    }

    pub fn equipment_card(&self, ei: u32) -> EquipCard {
        let e = &self.idx.equipment[ei as usize];
        let files = &self.idx.equip_files[ei as usize];
        let mut by_cat: HashMap<Category, u32> = HashMap::new();
        let mut latest_insp: Option<i16> = None;
        let mut first_year: Option<i16> = None;
        let mut fams: HashSet<u32> = HashSet::new();
        for &fi in files {
            let f = &self.idx.files[fi as usize];
            *by_cat.entry(f.cat).or_default() += 1;
            if let Some(y) = f.year {
                if f.cat == Category::Inspection {
                    latest_insp = Some(latest_insp.map_or(y, |c| c.max(y)));
                }
                first_year = Some(first_year.map_or(y, |c| c.min(y)));
            }
            if let Some(fa) = f.family {
                fams.insert(fa);
            }
        }
        let mut by_category: Vec<Facet> = by_cat
            .into_iter()
            .map(|(c, n)| Facet { key: c.label().into(), label: c.label().into(), count: n })
            .collect();
        by_category.sort_by(|a, b| b.count.cmp(&a.count));
        let mut related: Vec<(f32, u32)> = self
            .idx
            .cooccur
            .iter()
            .filter_map(|&(a, b, c)| if a == ei { Some((c, b)) } else if b == ei { Some((c, a)) } else { None })
            .collect();
        related.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        related.dedup_by_key(|x| x.1);
        EquipCard {
            id: ei,
            number: e.number.clone(),
            tags: e.tags.clone(),
            description: e.description.clone(),
            kind: e.kind.clone(),
            unit: e.unit.map(|u| self.idx.units[u as usize].label.clone()),
            folder: e.folder_path.clone(),
            historical: e.historical.clone(),
            hint_numbers: e.hint_numbers.clone(),
            files: files.len() as u32,
            by_category,
            latest_inspection: latest_insp,
            first_year,
            drawing_families: fams.into_iter().map(|f| self.idx.families[f as usize].base.clone()).take(12).collect(),
            related: related.into_iter().take(8).map(|(_, b)| self.equip_option(b)).collect(),
        }
    }

    fn group_for_equipment(&self, raw: &str, list: &[u32], via_override: Option<Via>) -> Group {
        let mut members: HashMap<u32, (Via, u32)> = HashMap::new();
        for &ei in list {
            for &fi in &self.idx.equip_files[ei as usize] {
                let f = &self.idx.files[fi as usize];
                let src = f.equip.iter().find(|(x, _)| *x == ei).map(|x| x.1).unwrap_or(LinkSrc::Folder);
                let via = via_override.unwrap_or(match src {
                    LinkSrc::Filename => Via::Filename,
                    LinkSrc::Folder => Via::Folder,
                    LinkSrc::Family => Via::Family,
                });
                let rank = |v: Via| match v {
                    Via::Filename => 0,
                    Via::Renumbered => 1,
                    Via::Folder => 2,
                    Via::Family => 3,
                    Via::Literal => 4,
                    Via::Hint => 5,
                };
                let ent = members.entry(fi).or_insert((via, ei));
                if rank(via) < rank(ent.0) {
                    *ent = (via, ei);
                }
            }
        }
        Group { raw: raw.to_string(), members, equipment: list.to_vec() }
    }

    pub fn search(&self, req: &SearchRequest) -> SearchResponse {
        let mode = req.mode.as_str();
        if mode == "natural" || ((mode.is_empty() || mode == "auto") && crate::nl::is_natural(&req.query)) {
            return self.search_natural(req);
        }
        let exact = self.search_exact(req);
        // Nothing matched every word: fall back to best-fit matches.
        if exact.total == 0 && (mode.is_empty() || mode == "auto") && req.query.split_whitespace().count() >= 2 && exact.notice.as_deref().map(|n| !n.starts_with("No equipment numbered")).unwrap_or(true) {
            let mut nl = self.search_natural(req);
            if nl.total > 0 {
                nl.notice = Some(format!("Nothing matched every word of “{}”, so these are the closest matches for what you described.", req.query.trim()));
                return nl;
            }
        }
        exact
    }

    fn search_exact(&self, req: &SearchRequest) -> SearchResponse {
        let t0 = std::time::Instant::now();
        let mut resp = SearchResponse { query: req.query.clone(), mode: "exact".into(), ..Default::default() };
        let limit = if req.limit == 0 { 50 } else { req.limit.min(5000) };
        let mut q = format!(" {} ", req.query.trim());

        // ── Dates, recency, sheet and revision ─────────────────────────
        let (mut min_y, mut max_y) = (req.year_min.unwrap_or(0), req.year_max.unwrap_or(0));
        if let Some(c) = RANGE_RE.captures(&q.clone()) {
            min_y = c[1].parse().unwrap_or(0);
            max_y = c[2].parse().unwrap_or(0);
            q = q.replace(&c[0], " ");
            resp.chips.push(Chip { kind: "year", text: format!("{min_y}–{max_y}"), detail: "Year range".into() });
        }
        if let Some(c) = BEFORE_RE.captures(&q.clone()) {
            max_y = c[1].parse::<i32>().unwrap_or(0) - 1;
            q = q.replace(&c[0], " ");
            resp.chips.push(Chip { kind: "year", text: format!("before {}", max_y + 1), detail: "Year bound".into() });
        }
        if let Some(c) = AFTER_RE.captures(&q.clone()) {
            min_y = c[1].parse::<i32>().unwrap_or(0) + if c[0].to_lowercase().starts_with("after") { 1 } else { 0 };
            q = q.replace(&c[0], " ");
            resp.chips.push(Chip { kind: "year", text: format!("from {min_y}"), detail: "Year bound".into() });
        }
        let recent = RECENT_RE.is_match(&q);
        if recent {
            resp.chips.push(Chip { kind: "recent", text: "newest first".into(), detail: "Recent documents score higher".into() });
        }
        let mut want_sheet: Option<String> = None;
        if let Some(c) = SHEET_RE.captures(&q.clone()) {
            want_sheet = Some(norm_sheet(&c[1]));
            q = q.replace(&c[0], " ");
            resp.chips.push(Chip { kind: "sheet", text: format!("sheet {}", &c[1]), detail: "Sheet".into() });
        }
        let mut want_rev: Option<String> = None;
        if let Some(c) = REV_RE.captures(&q.clone()) {
            want_rev = Some(norm_rev(&c[1]));
            q = q.replace(&c[0], " ");
            resp.chips.push(Chip { kind: "rev", text: format!("rev {}", &c[1]), detail: "Revision".into() });
        }
        let mut phrases: Vec<String> = Vec::new();
        for c in PHRASE_RE.captures_iter(&q.clone()) {
            phrases.push(c[1].to_lowercase());
            resp.chips.push(Chip { kind: "phrase", text: format!("\"{}\"", &c[1]), detail: "Exact phrase in name or folder".into() });
        }
        q = PHRASE_RE.replace_all(&q, " ").to_string();

        // ── Units named in the query ("unit 2000", "crude", "LRU") ─────
        let mut unit_hits: Vec<u16> = Vec::new();
        for c in UNIT_WORD_RE.captures_iter(&q.clone()) {
            let code = c.get(1).or(c.get(2)).unwrap().as_str().to_string();
            for (ui, u) in self.idx.units.iter().enumerate() {
                if u.code == code {
                    unit_hits.push(ui as u16);
                }
            }
            q = q.replace(&c[0], " ");
        }
        // Bare years after unit codes are removed.
        if min_y == 0 && max_y == 0 {
            if let Some(c) = YEAR_RE.captures(&q.clone()) {
                let y: i32 = c[1].parse().unwrap_or(0);
                let is_unit = self.idx.units.iter().any(|u| u.code == c[1].to_string()) && y >= 2040;
                if !is_unit {
                    min_y = y;
                    max_y = y;
                    q = q.replacen(&c[1], " ", 1);
                    resp.chips.push(Chip { kind: "year", text: y.to_string(), detail: "Year".into() });
                }
            }
        } else {
            q = YEAR_RE.replace_all(&q, " ").to_string();
        }

        // ── Wildcards ──────────────────────────────────────────────────
        let mut terms: Vec<Term> = Vec::new();
        let mut wild_groups: Vec<Group> = Vec::new();
        for m in WILD_RE.find_iter(&q.clone()) {
            let pat = m.as_str().to_lowercase();
            if pat == "*" {
                continue;
            }
            let looks_equip = pat.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) && (pat.contains('.') || pat.contains('_'));
            if looks_equip {
                let pp = pat.replace('_', ".");
                let list: Vec<u32> = self
                    .idx
                    .equipment
                    .iter()
                    .enumerate()
                    .filter(|(_, e)| e.keys.iter().any(|k| text::star_match(k, &pp)))
                    .map(|(i, _)| i as u32)
                    .collect();
                resp.chips.push(Chip { kind: "wildcard", text: pat.clone(), detail: format!("{} equipment", list.len()) });
                wild_groups.push(self.group_for_equipment(&pat, &list, None));
            } else {
                let wp = if pat.ends_with('*') && pat.matches('*').count() == 1 { format!("{}*", text::stem(&pat[..pat.len() - 1])) } else { pat.clone() };
                let ids: Vec<u32> = self
                    .idx
                    .terms
                    .iter()
                    .enumerate()
                    .filter(|(i, t)| !t.starts_with("tag:") && !self.postings[*i].is_empty() && text::star_match(t, &wp))
                    .map(|(i, _)| i as u32)
                    .collect();
                let posting = union_sorted(&ids.iter().map(|&t| &self.postings[t as usize]).collect::<Vec<_>>());
                resp.chips.push(Chip { kind: "wildcard", text: pat.clone(), detail: format!("{} words", ids.len()) });
                terms.push(Term { word: pat.clone(), ids, fuzzy: false, wildcard: true, posting });
            }
            q = q.replacen(m.as_str(), " ", 1);
        }

        // ── Identifiers: equipment numbers, tags, circuits ─────────────
        let mut groups: Vec<Group> = wild_groups;
        let ids = text::scan_ids(&q);
        let mut consumed: Vec<(usize, usize)> = Vec::new();
        for tok in &ids {
            consumed.push((tok.start, tok.end));
            let mut list: Vec<u32> = Vec::new();
            if let Some(e) = self.idx.equip_keys.get(&tok.key) {
                list.extend(e);
            } else if let Some(p) = tok.parent.as_ref().and_then(|p| self.idx.equip_keys.get(p)) {
                list.extend(p);
            }
            if let Some(pin) = req.equipment {
                if list.contains(&pin) {
                    list = vec![pin];
                }
            }
            let tag_term = self.idx.term_ids.get(&format!("tag:{}", tok.key)).and_then(|t| self.tag_postings.get(t));
            match tok.kind {
                IdKind::Equip => {
                    if list.is_empty() {
                        // Same number written with/without a leading zero (2510.2 / 2510.02).
                        let alt = match tok.key.split_once('.') {
                            Some((a, b)) if b.len() == 1 => Some(format!("{a}.0{b}")),
                            Some((a, b)) if b.len() == 2 && b.starts_with('0') => Some(format!("{a}.{}", &b[1..])),
                            _ => None,
                        };
                        if let Some(l) = alt.as_ref().and_then(|k| self.idx.equip_keys.get(k)) {
                            list.extend(l);
                            resp.chips.push(Chip { kind: "equipment", text: tok.raw.clone(), detail: format!("read as {}", alt.unwrap().to_uppercase()) });
                        }
                    }
                    let hint = self.idx.hint_keys.get(&tok.key).cloned().unwrap_or_default();
                    if list.is_empty() && hint.is_empty() {
                        // TracePoint rule: a partial or unknown equipment number returns nothing.
                        let near: Vec<String> = self
                            .idx
                            .equipment
                            .iter()
                            .filter(|e| e.keys.iter().any(|k| k.starts_with(&tok.key[..tok.key.len().min(6)])))
                            .take(6)
                            .map(|e| e.number.clone())
                            .collect();
                        resp.notice = Some(format!("No equipment numbered {} is in the index.", tok.raw));
                        resp.suggestions = near;
                        resp.took_ms = t0.elapsed().as_secs_f64() * 1000.0;
                        return resp;
                    }
                    let renumbered: Vec<u32> = list
                        .iter()
                        .copied()
                        .filter(|&ei| self.idx.equipment[ei as usize].historical.iter().any(|h| h.eq_ignore_ascii_case(&tok.key)))
                        .collect();
                    let mut g = self.group_for_equipment(&tok.raw, &list.iter().copied().filter(|e| !renumbered.contains(e)).collect::<Vec<_>>(), None);
                    let gr = self.group_for_equipment(&tok.raw, &renumbered, Some(Via::Renumbered));
                    for (k, v) in gr.members {
                        g.members.entry(k).or_insert(v);
                    }
                    let gh = self.group_for_equipment(&tok.raw, &hint, Some(Via::Hint));
                    for (k, v) in gh.members {
                        g.members.entry(k).or_insert(v);
                    }
                    g.equipment.extend(renumbered.iter().chain(hint.iter()));
                    for &ei in &list {
                        let e = &self.idx.equipment[ei as usize];
                        let detail = if renumbered.contains(&ei) {
                            format!("renumbered: {} is now {}", tok.raw.to_uppercase(), e.number)
                        } else {
                            format!("{} {}", e.tags.first().cloned().unwrap_or_default(), e.description).trim().to_string()
                        };
                        resp.chips.push(Chip { kind: "equipment", text: e.number.clone(), detail });
                    }
                    for &ei in &hint {
                        resp.chips.push(Chip {
                            kind: "hint",
                            text: self.idx.equipment[ei as usize].number.clone(),
                            detail: format!("{} only appears inside this equipment's folder (unconfirmed)", tok.raw.to_uppercase()),
                        });
                    }
                    groups.push(g);
                }
                IdKind::Tag | IdKind::Numbered => {
                    if list.is_empty() && tag_term.is_none() {
                        resp.notice = Some(format!("Nothing in the index is tagged {}.", tok.raw.to_uppercase()));
                        resp.took_ms = t0.elapsed().as_secs_f64() * 1000.0;
                        return resp;
                    }
                    let mut g = self.group_for_equipment(&tok.raw, &list, None);
                    if let Some(tp) = tag_term {
                        for &fi in tp {
                            g.members.entry(fi).or_insert((Via::Literal, u32::MAX));
                        }
                    }
                    if list.len() > 1 {
                        let units: HashSet<Option<u16>> = list.iter().map(|&e| self.idx.equipment[e as usize].unit).collect();
                        if units.len() > 1 && req.equipment.is_none() {
                            let mut opts: Vec<EquipOption> = list.iter().map(|&e| self.equip_option(e)).collect();
                            opts.sort_by(|a, b| b.files.cmp(&a.files));
                            resp.ambiguity.push(Ambiguity { token: tok.raw.to_uppercase(), options: opts });
                        }
                    }
                    if list.len() == 1 {
                        let e = &self.idx.equipment[list[0] as usize];
                        resp.chips.push(Chip { kind: "equipment", text: e.number.clone(), detail: format!("{} {}", tok.raw.to_uppercase(), e.description).trim().into() });
                    } else if list.is_empty() {
                        resp.chips.push(Chip { kind: "tag", text: tok.raw.to_uppercase(), detail: "Tag in file or folder names".into() });
                    } else {
                        resp.chips.push(Chip { kind: "tag", text: tok.raw.to_uppercase(), detail: format!("{} pieces of equipment", list.len()) });
                    }
                    groups.push(g);
                }
            }
        }
        let mut rest = q.clone();
        for (s, e) in consumed.iter().rev() {
            rest.replace_range(*s..*e, " ");
        }

        // ── Words ─────────────────────────────────────────────────────
        let mut words: Vec<String> = text::word_tokens(&rest);
        words.retain(|w| !text::STOPS.contains(w.as_str()) && w != "unit" && !(w.chars().all(|c| c.is_ascii_digit()) && w.len() < 3));
        if words.contains(&"onstream".to_string()) {
            words.retain(|w| w != "osi" && w != "stream" && w != "on");
        }
        let mut seen = HashSet::new();
        words.retain(|w| seen.insert(w.clone()));
        // Unit words ("crude", "lru", "dht") satisfy themselves by unit or name.
        let mut unit_words: Vec<(String, Vec<u16>)> = Vec::new();
        words.retain(|w| {
            let us: Vec<u16> = self.idx.units.iter().enumerate().filter(|(_, u)| u.keys.iter().any(|k| k == w)).map(|(i, _)| i as u16).collect();
            if !us.is_empty() && w.len() >= 3 {
                unit_words.push((w.clone(), us));
                false
            } else {
                true
            }
        });
        for (w, us) in &unit_words {
            resp.chips.push(Chip {
                kind: "unit",
                text: w.to_uppercase(),
                detail: us.iter().map(|&u| self.idx.units[u as usize].label.clone()).collect::<Vec<_>>().join(", "),
            });
        }
        for &u in &unit_hits {
            resp.chips.push(Chip { kind: "unit", text: self.idx.units[u as usize].code.clone(), detail: self.idx.units[u as usize].label.clone() });
        }
        for w in &words {
            match self.term_posting(w) {
                Some(p) => terms.push(Term { word: w.clone(), ids: vec![self.idx.term_ids[w]], fuzzy: false, wildcard: false, posting: p.clone() }),
                None => {
                    let near = self.fuzzy_terms(w);
                    if near.is_empty() {
                        resp.notice = Some(format!("No file or folder name mentions \"{w}\"."));
                        resp.suggestions = self.drop_one_suggestions(req, w);
                        resp.took_ms = t0.elapsed().as_secs_f64() * 1000.0;
                        return resp;
                    }
                    let posting = union_sorted(&near.iter().map(|&t| &self.postings[t as usize]).collect::<Vec<_>>());
                    resp.chips.push(Chip {
                        kind: "fuzzy",
                        text: w.clone(),
                        detail: format!("≈ {}", near.iter().map(|&t| self.idx.terms[t as usize].clone()).collect::<Vec<_>>().join(", ")),
                    });
                    terms.push(Term { word: w.clone(), ids: near, fuzzy: true, wildcard: false, posting });
                }
            }
        }
        for t in &terms {
            if !t.fuzzy && !t.wildcard {
                resp.chips.push(Chip { kind: "word", text: t.word.clone(), detail: format!("{} files", t.posting.len()) });
            }
        }

        // ── Candidates: every group and every word must match ──────────
        let browse = groups.is_empty() && terms.is_empty() && phrases.is_empty();
        let pinned = req.equipment.filter(|&e| (e as usize) < self.idx.equipment.len());
        if let Some(pin) = pinned {
            if groups.iter().all(|g| !g.equipment.contains(&pin)) {
                groups.push(self.group_for_equipment(&self.idx.equipment[pin as usize].number, &[pin], None));
            }
        }
        let has_filter = !req.categories.is_empty() || !req.units.is_empty() || !req.exts.is_empty() || min_y > 0 || max_y > 0 || !unit_words.is_empty() || !unit_hits.is_empty();
        if browse && pinned.is_none() && !has_filter {
            resp.took_ms = t0.elapsed().as_secs_f64() * 1000.0;
            return resp;
        }
        let mut cand: Option<Vec<u32>> = None;
        let mut ordered: Vec<&Vec<u32>> = terms.iter().map(|t| &t.posting).collect();
        ordered.sort_by_key(|p| p.len());
        let group_lists: Vec<Vec<u32>> = groups
            .iter()
            .map(|g| {
                let mut v: Vec<u32> = g.members.keys().copied().collect();
                v.sort_unstable();
                v
            })
            .collect();
        let mut all_lists: Vec<&Vec<u32>> = group_lists.iter().collect();
        all_lists.extend(ordered);
        all_lists.sort_by_key(|p| p.len());
        for p in all_lists {
            cand = Some(match cand {
                None => p.clone(),
                Some(c) => intersect(&c, p),
            });
            if cand.as_ref().map(|c| c.is_empty()).unwrap_or(false) {
                break;
            }
        }
        let cand: Vec<u32> = cand.unwrap_or_else(|| (0..self.idx.files.len() as u32).collect());

        // ── Filters ──────────────────────────────────────────────────
        let cat_filter: Vec<Category> = req.categories.iter().filter_map(|c| Category::from_label(c)).collect();
        let unit_filter: Vec<u16> = req.units.iter().filter_map(|l| self.idx.units.iter().position(|u| &u.label == l).map(|i| i as u16)).collect();
        let ext_filter: Vec<String> = req.exts.iter().map(|e| e.to_lowercase()).collect();
        let photo_intent = terms.iter().any(|t| t.word == "photo") || cat_filter.contains(&Category::Photos);
        let template_intent = terms.iter().any(|t| t.word == "blank" || t.word == "template");
        let inspection_intent = terms.iter().any(|t| ["inspection", "external", "internal", "ut", "onstream", "visual"].contains(&t.word.as_str()));
        let drawing_intent = terms.iter().any(|t| t.word == "drawing" || t.word == "iso");
        let code_intent = terms.iter().any(|t| t.word == "code" || t.word == "u1a");
        let pid_intent = terms.iter().any(|t| t.word == "pid");
        let bottle_rule = groups.is_empty() && terms.iter().any(|t| t.word == "bottle") && !terms.iter().any(|t| ["relief", "valve", "psv", "prv"].contains(&t.word.as_str()));
        let now_year = 2026;

        struct Scored {
            fi: u32,
            score: i32,
            reasons: Vec<String>,
        }
        let mut scored: Vec<Scored> = Vec::with_capacity(cand.len());
        let mut facet_cat: HashMap<Category, u32> = HashMap::new();
        let mut facet_unit: HashMap<u16, u32> = HashMap::new();
        let mut facet_year: HashMap<i16, u32> = HashMap::new();
        let mut facet_ext: HashMap<String, u32> = HashMap::new();
        let mut facet_eq: HashMap<u32, u32> = HashMap::new();
        for &fi in &cand {
            let f = &self.idx.files[fi as usize];
            let dir = &self.idx.dirs[f.dir as usize];
            if f.flags & (F_JUNK | F_ZERO) != 0 && !req.include_junk {
                continue;
            }
            if req.hide_archive && f.flags & F_ARCHIVE != 0 {
                continue;
            }
            if min_y > 0 || max_y > 0 {
                match f.year {
                    Some(y) if (min_y == 0 || y as i32 >= min_y) && (max_y == 0 || y as i32 <= max_y) => {}
                    _ => continue,
                }
            }
            if !unit_hits.is_empty() && !dir.unit.map(|u| unit_hits.contains(&u)).unwrap_or(false) {
                continue;
            }
            let lname = f.name.to_lowercase();
            let mut unit_ok = true;
            for (w, us) in &unit_words {
                let in_unit = dir.unit.map(|u| us.contains(&u)).unwrap_or(false);
                if !in_unit && !lname.contains(w.as_str()) && !dir.path.to_lowercase().contains(w.as_str()) {
                    unit_ok = false;
                }
            }
            if !unit_ok {
                continue;
            }
            if !phrases.is_empty() {
                let hay = format!("{}\\{}", dir.path.to_lowercase(), lname);
                if !phrases.iter().all(|p| hay.contains(p.as_str())) {
                    continue;
                }
            }
            // Facets are counted before the user's facet filters so chips show what is available.
            *facet_cat.entry(f.cat).or_default() += 1;
            if let Some(u) = dir.unit {
                *facet_unit.entry(u).or_default() += 1;
            }
            if let Some(y) = f.year {
                *facet_year.entry(y).or_default() += 1;
            }
            *facet_ext.entry(f.ext.clone()).or_default() += 1;
            if let Some(&(e, _)) = f.equip.first() {
                *facet_eq.entry(e).or_default() += 1;
            }
            if !cat_filter.is_empty() && !cat_filter.contains(&f.cat) {
                continue;
            }
            if !unit_filter.is_empty() && !dir.unit.map(|u| unit_filter.contains(&u)).unwrap_or(false) {
                continue;
            }
            if !ext_filter.is_empty() && !ext_filter.contains(&f.ext) {
                continue;
            }

            let mut score = 0i32;
            let mut reasons: Vec<String> = Vec::new();
            for g in &groups {
                match g.members.get(&fi) {
                    Some((Via::Filename, _)) => {
                        score += 200;
                        reasons.push(format!("Equipment {} in filename", g.raw.to_uppercase()));
                    }
                    Some((Via::Folder, _)) => {
                        score += 150;
                        reasons.push(format!("In {} equipment folder", g.raw.to_uppercase()));
                    }
                    Some((Via::Renumbered, ei)) => {
                        score += 140;
                        reasons.push(format!("Renumbered: {} is now {}", g.raw.to_uppercase(), self.idx.equipment[*ei as usize].number));
                    }
                    Some((Via::Family, _)) => {
                        score += 120;
                        reasons.push(format!("Drawing family of {}", g.raw.to_uppercase()));
                    }
                    Some((Via::Literal, _)) => {
                        score += 110;
                        reasons.push(format!("Tag {} in name/folder", g.raw.to_uppercase()));
                    }
                    Some((Via::Hint, ei)) => {
                        score += 60;
                        reasons.push(format!("Possible old number for {} (unconfirmed)", self.idx.equipment[*ei as usize].number));
                    }
                    None => {}
                }
            }
            let mut matched = 0;
            for t in &terms {
                let in_set = |set: &[u32]| t.ids.iter().any(|id| set.binary_search(id).is_ok());
                let (pts, label) = if in_set(&f.name_terms) {
                    (30, "Title")
                } else if in_set(&f.meta_terms) {
                    (16, "Type/description")
                } else if in_set(&dir.terms) {
                    (5, "Folder")
                } else {
                    (8, "Related")
                };
                matched += 1;
                let pts = if t.fuzzy { pts * 6 / 10 } else { pts };
                score += pts;
                reasons.push(if t.fuzzy { format!("{label}: ≈{}", t.word) } else { format!("{label}: {}", t.word) });
            }
            if matched == terms.len() && !terms.is_empty() {
                score += 30;
                reasons.push("All search words".into());
            }
            for (w, us) in &unit_words {
                if dir.unit.map(|u| us.contains(&u)).unwrap_or(false) {
                    score += 20;
                    reasons.push(format!("In {} unit", w.to_uppercase()));
                }
            }
            let photo = f.cat == Category::Photos;
            let blank = f.flags & F_BLANK != 0;
            if drawing_intent && (f.cat == Category::Drawings || f.doctype.contains("Drawing")) {
                score += 35;
                reasons.push("Requested drawing type".into());
            }
            if code_intent && f.cat == Category::CodeDocuments {
                score += 35;
                reasons.push("Requested code document".into());
            }
            if pid_intent && f.cat == Category::Pid {
                score += 35;
                reasons.push("Requested P&ID".into());
            }
            if inspection_intent && f.cat == Category::Inspection && !blank {
                score += 90;
                reasons.push("Inspection record priority".into());
                if REPORTISH_RE.is_match(&f.name) {
                    score += 15;
                    reasons.push("Report/checklist/field notes".into());
                }
                if CALIB_RE.is_match(&f.name) {
                    score -= 15;
                    reasons.push("Supporting calibration record".into());
                }
            }
            if blank && !template_intent {
                score -= 90;
                reasons.push("Blank/template lower priority".into());
            }
            if blank && template_intent {
                score += 90;
                reasons.push("Requested blank/template".into());
            }
            if photo && !photo_intent {
                score -= 100;
                reasons.push("Supporting photo lower priority".into());
            }
            if photo && photo_intent {
                score += 60;
                reasons.push("Requested photo".into());
            }
            if bottle_rule {
                let desc = f.equip.first().map(|(e, _)| self.idx.equipment[*e as usize].description.as_str()).unwrap_or("");
                if RELIEF_RE.is_match(desc) {
                    score -= 30;
                    reasons.push("Bottle-related relief component lower priority".into());
                }
            }
            if let Some(ws) = &want_sheet {
                match &f.sheet {
                    Some(s) if norm_sheet(s) == *ws => {
                        score += 30;
                        reasons.push(format!("Sheet {s}"));
                    }
                    Some(s) => {
                        score -= 15;
                        reasons.push(format!("Different sheet ({s})"));
                    }
                    None => {}
                }
            }
            if let Some(wr) = &want_rev {
                match &f.rev {
                    Some(r) if norm_rev(r) == *wr => {
                        score += 20;
                        reasons.push(format!("Revision {r}"));
                    }
                    Some(r) => {
                        score -= 8;
                        reasons.push(format!("Different revision ({r})"));
                    }
                    None => {}
                }
            } else if f.family.is_some() {
                if f.flags & F_LATEST != 0 {
                    score += 10;
                    reasons.push("Latest revision".into());
                } else {
                    score -= 5;
                    reasons.push("Older revision".into());
                }
            }
            if f.flags & F_ARCHIVE != 0 {
                score -= 15;
                reasons.push("In an archive folder".into());
            }
            if f.flags & F_GONE != 0 {
                score -= 40;
                reasons.push("Not seen in the latest scan".into());
            }
            if f.flags & F_JUNK != 0 {
                score -= 50;
                reasons.push("System/shortcut file".into());
            }
            if recent {
                if let Some(y) = f.year {
                    score += 0.max(12 - 0.max(now_year - y as i32));
                    reasons.push(format!("Recent ({y})"));
                }
            }
            scored.push(Scored { fi, score, reasons });
        }

        let by_path = |a: u32, b: u32| {
            let fa = &self.idx.files[a as usize];
            let fb = &self.idx.files[b as usize];
            self.idx.dirs[fa.dir as usize].path.cmp(&self.idx.dirs[fb.dir as usize].path).then_with(|| fa.name.to_lowercase().cmp(&fb.name.to_lowercase()))
        };
        match req.sort.as_str() {
            "newest" => scored.sort_by(|a, b| {
                let (fa, fb) = (&self.idx.files[a.fi as usize], &self.idx.files[b.fi as usize]);
                fb.year.cmp(&fa.year).then(fb.mtime.cmp(&fa.mtime))
            }),
            "oldest" => scored.sort_by(|a, b| {
                let (fa, fb) = (&self.idx.files[a.fi as usize], &self.idx.files[b.fi as usize]);
                fa.year.unwrap_or(9999).cmp(&fb.year.unwrap_or(9999)).then(fa.mtime.cmp(&fb.mtime))
            }),
            "name" => scored.sort_by(|a, b| self.idx.files[a.fi as usize].name.to_lowercase().cmp(&self.idx.files[b.fi as usize].name.to_lowercase())),
            "folder" => scored.sort_by(|a, b| by_path(a.fi, b.fi)),
            _ => scored.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| by_path(a.fi, b.fi))),
        }

        // TracePoint photo grouping: two supporting photos per folder.
        let total_before = scored.len();
        let mut visible: Vec<Scored> = Vec::with_capacity(scored.len());
        let mut per_folder: HashMap<u32, u32> = HashMap::new();
        for s in scored {
            let f = &self.idx.files[s.fi as usize];
            if !req.include_photos && !photo_intent && f.cat == Category::Photos {
                let c = per_folder.entry(f.dir).or_default();
                if *c >= 2 {
                    resp.suppressed_photos += 1;
                    continue;
                }
                *c += 1;
            }
            visible.push(s);
        }
        let _ = total_before;
        resp.total = visible.len();
        for (rank, s) in visible.into_iter().enumerate().skip(req.offset).take(limit) {
            resp.hits.push(self.hit(s.fi, rank + 1, s.score, s.reasons));
        }

        // ── Facets ───────────────────────────────────────────────────
        let mut cats: Vec<Facet> = facet_cat.into_iter().map(|(c, n)| Facet { key: c.label().into(), label: c.label().into(), count: n }).collect();
        cats.sort_by(|a, b| b.count.cmp(&a.count));
        let mut units: Vec<Facet> = facet_unit
            .into_iter()
            .map(|(u, n)| Facet { key: self.idx.units[u as usize].label.clone(), label: self.idx.units[u as usize].label.clone(), count: n })
            .collect();
        units.sort_by(|a, b| b.count.cmp(&a.count));
        let mut years: Vec<Facet> = facet_year.into_iter().map(|(y, n)| Facet { key: y.to_string(), label: y.to_string(), count: n }).collect();
        years.sort_by(|a, b| b.key.cmp(&a.key));
        let mut exts: Vec<Facet> = facet_ext.into_iter().map(|(e, n)| Facet { key: e.clone(), label: e.trim_start_matches('.').to_uppercase(), count: n }).collect();
        exts.sort_by(|a, b| b.count.cmp(&a.count));
        let mut eqs: Vec<Facet> = facet_eq
            .into_iter()
            .map(|(e, n)| {
                let eq = &self.idx.equipment[e as usize];
                Facet { key: e.to_string(), label: format!("{} {}", eq.number, eq.tags.first().cloned().unwrap_or_default()).trim().into(), count: n }
            })
            .collect();
        eqs.sort_by(|a, b| b.count.cmp(&a.count));
        eqs.truncate(12);
        resp.facets = Facets { categories: cats, units, years, exts: exts.into_iter().take(15).collect(), equipment: eqs };

        // ── Equipment card when the query means one piece of equipment ─
        let mut eq_set: Vec<u32> = groups.iter().flat_map(|g| g.equipment.iter().copied()).collect();
        eq_set.sort_unstable();
        eq_set.dedup();
        if let Some(pin) = pinned {
            resp.card = Some(self.equipment_card(pin));
        } else if eq_set.len() == 1 {
            resp.card = Some(self.equipment_card(eq_set[0]));
        } else if eq_set.len() > 1 && resp.ambiguity.is_empty() {
            // Renumbered pair: show the current one.
            let current: Vec<u32> = eq_set.iter().copied().filter(|&e| !self.idx.equipment[e as usize].historical.iter().any(|h| h.starts_with("now "))).collect();
            if current.len() == 1 {
                resp.card = Some(self.equipment_card(current[0]));
            }
        }
        if resp.total == 0 && resp.notice.is_none() {
            resp.notice = Some("No file matches every part of this search.".into());
            if let Some(w) = terms.first() {
                resp.suggestions = self.drop_one_suggestions(req, &w.word);
            }
        }
        resp.took_ms = t0.elapsed().as_secs_f64() * 1000.0;
        resp
    }

    /// "Without 'xyz'" alternatives when a word blocks every result.
    fn drop_one_suggestions(&self, req: &SearchRequest, word: &str) -> Vec<String> {
        let q = req.query.to_lowercase();
        let words: Vec<&str> = q.split_whitespace().collect();
        if words.len() < 2 {
            return vec![];
        }
        let without: Vec<&str> = words.iter().copied().filter(|w| text::stem(w) != word && *w != word).collect();
        if without.is_empty() || without.len() == words.len() {
            return vec![];
        }
        vec![without.join(" ")]
    }

    pub fn hit(&self, fi: u32, rank: usize, score: i32, reasons: Vec<String>) -> Hit {
        let f = &self.idx.files[fi as usize];
        Hit {
            id: fi,
            rank,
            name: f.name.clone(),
            path: self.idx.full_path(fi),
            folder: self.idx.relative_folder(f.dir),
            unit: self.idx.unit_label(f.dir).map(|s| s.to_string()),
            category: f.cat.label(),
            doctype: f.doctype,
            year: f.year,
            ext: f.ext.clone(),
            size: f.size,
            modified: f.mtime,
            score,
            reasons,
            equipment: f
                .equip
                .iter()
                .map(|&(e, src)| {
                    let eq = &self.idx.equipment[e as usize];
                    EquipRef {
                        id: e,
                        number: eq.number.clone(),
                        tag: eq.tags.first().cloned(),
                        description: eq.description.clone(),
                        unit: eq.unit.map(|u| self.idx.units[u as usize].label.clone()),
                        via: match src {
                            LinkSrc::Filename => "filename",
                            LinkSrc::Folder => "folder",
                            LinkSrc::Family => "family",
                        },
                    }
                })
                .collect(),
            sheet: f.sheet.clone(),
            rev: f.rev.clone(),
            latest: f.flags & F_LATEST != 0,
            archived: f.flags & F_ARCHIVE != 0,
            blank: f.flags & F_BLANK != 0,
            junk: f.flags & (F_JUNK | F_ZERO) != 0,
        }
    }

    /// Type-ahead: equipment and words that start with what was typed.
    pub fn suggest(&self, prefix: &str, limit: usize) -> Vec<Facet> {
        let p = prefix.trim().to_lowercase();
        if p.len() < 2 {
            return vec![];
        }
        let mut out: Vec<Facet> = Vec::new();
        let pk = text::scan_ids(&p).into_iter().next().map(|t| t.key).unwrap_or_else(|| p.replace(['-', ' ', '_'], ""));
        let mut eqs: Vec<(u32, u32)> = self
            .idx
            .equipment
            .iter()
            .enumerate()
            .filter(|(_, e)| e.keys.iter().any(|k| k.starts_with(&pk)) || e.description.to_lowercase().contains(&p))
            .map(|(i, e)| (e.file_count, i as u32))
            .collect();
        eqs.sort_by(|a, b| b.0.cmp(&a.0));
        for (n, ei) in eqs.into_iter().take(limit) {
            let e = &self.idx.equipment[ei as usize];
            let unit = e.unit.map(|u| self.idx.units[u as usize].label.clone()).unwrap_or_default();
            out.push(Facet {
                key: format!("equip:{ei}"),
                label: format!("{} {} — {} · {}", e.number, e.tags.first().cloned().unwrap_or_default(), e.description, unit).replace("  ", " "),
                count: n,
            });
        }
        let last = p.split_whitespace().last().unwrap_or("");
        if last.len() >= 2 {
            let mut words: Vec<(usize, &String)> = self
                .idx
                .terms
                .iter()
                .enumerate()
                .filter(|(_, t)| !t.starts_with("tag:") && t.starts_with(last) && t.len() > last.len())
                .map(|(i, t)| (self.postings[i].len(), t))
                .collect();
            words.sort_by(|a, b| b.0.cmp(&a.0));
            for (n, w) in words.into_iter().take(limit / 2) {
                out.push(Facet { key: format!("word:{w}"), label: w.clone(), count: n as u32 });
            }
        }
        out
    }
}
