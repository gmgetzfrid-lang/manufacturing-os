//! In-memory THOR index, loaded from a THOR Indexer knowledge database
//! (schema 2.0). The database is opened read-only; nothing here writes.
//!
//! Beyond what the database states, the loader derives what TracePoint 1.x
//! read from its CSV: unit, category, document type, year, and equipment
//! association inherited from equipment folders (a report inside
//! "5610.15 V-2 Debutanizer Reciever\INSPECTIONS\..." belongs to 5610.15 even
//! when its filename only says "v-02"). Superseded numbers used inside another
//! equipment's folder (5510.06 inside 5610.15) are learned as history.

use crate::classify::{self, Category, DirRole};
use crate::text::{self, IdKind};
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

pub const F_JUNK: u8 = 1;
pub const F_ZERO: u8 = 2;
pub const F_ARCHIVE: u8 = 4;
pub const F_BLANK: u8 = 8;
pub const F_GONE: u8 = 16;
pub const F_LATEST: u8 = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum LinkSrc {
    /// The equipment number or tag is in the filename.
    Filename,
    /// The file sits inside the equipment's own folder.
    Folder,
    /// A drawing family links it (P&ID sheet that names the equipment).
    Family,
}

#[derive(Clone, Debug, Serialize)]
pub struct RootInfo {
    pub root_id: String,
    pub path: String,
    pub created_at: String,
    pub last_crawl_at: Option<String>,
    pub explorer_completed_at: Option<String>,
    pub enabled: bool,
    pub last_crawl_started: Option<String>,
    pub last_crawl_completed: Option<String>,
    pub last_crawl_status: Option<String>,
    pub files_seen: i64,
    pub dirs_seen: i64,
    pub issues: i64,
    pub files_indexed: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct Unit {
    pub code: String,
    pub name: String,
    pub label: String,
    #[serde(skip)]
    pub keys: Vec<String>,
}

pub struct Dir {
    pub path: String,
    pub name: String,
    pub parent: Option<u32>,
    pub root: u16,
    pub depth: u16,
    pub unit: Option<u16>,
    pub role: DirRole,
    pub roles: Vec<DirRole>,
    pub equip: Option<u32>,
    pub year: Option<i16>,
    pub archived: bool,
    pub terms: Vec<u32>,
    pub tags: Vec<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Equip {
    pub number: String,
    pub tags: Vec<String>,
    pub description: String,
    pub unit: Option<u16>,
    pub kind: String,
    #[serde(skip)]
    pub folder: Option<u32>,
    pub folder_path: Option<String>,
    /// Numbers this equipment was renumbered from (stated in THOR: "(Now 5610.15)").
    pub historical: Vec<String>,
    /// Old numbers that only appear inside this equipment's folder: a learned,
    /// unconfirmed hint used to widen search, never to reassign files.
    pub hint_numbers: Vec<String>,
    pub entity_id: Option<String>,
    pub source: &'static str,
    pub file_count: u32,
    #[serde(skip)]
    pub keys: Vec<String>,
}

pub struct FileRec {
    pub file_id: String,
    pub dir: u32,
    pub name: String,
    pub ext: String,
    pub size: i64,
    pub mtime: i64,
    pub cat: Category,
    pub doctype: &'static str,
    pub year: Option<i16>,
    pub year_from_name: bool,
    pub equip: Vec<(u32, LinkSrc)>,
    pub family: Option<u32>,
    pub sheet: Option<String>,
    pub rev: Option<String>,
    pub flags: u8,
    pub name_terms: Vec<u32>,
    pub meta_terms: Vec<u32>,
    pub tags: Vec<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Family {
    pub base: String,
    pub kind: String,
    pub members: Vec<u32>,
}

pub struct Index {
    pub source_path: String,
    pub generated_at: Option<String>,
    pub roots: Vec<RootInfo>,
    pub units: Vec<Unit>,
    pub dirs: Vec<Dir>,
    pub files: Vec<FileRec>,
    pub equipment: Vec<Equip>,
    pub families: Vec<Family>,
    /// Unverified co-occurrence clues between equipment (retrieval only).
    pub cooccur: Vec<(u32, u32, f32)>,
    pub terms: Vec<String>,
    pub term_ids: HashMap<String, u32>,
    pub equip_keys: HashMap<String, Vec<u32>>,
    /// Learned old-number hints: key -> equipment (weaker than equip_keys).
    pub hint_keys: HashMap<String, Vec<u32>>,
    pub equip_files: Vec<Vec<u32>>,
    pub load_ms: u128,
}

fn root_of(path: &str, roots: &[(String, String)]) -> Option<usize> {
    let lower = path.to_lowercase();
    roots.iter().position(|(_, norm)| lower.starts_with(norm.as_str()))
}

struct Interner {
    terms: Vec<String>,
    ids: HashMap<String, u32>,
}

impl Interner {
    fn id(&mut self, t: &str) -> u32 {
        if let Some(&i) = self.ids.get(t) {
            return i;
        }
        let i = self.terms.len() as u32;
        self.terms.push(t.to_string());
        self.ids.insert(t.to_string(), i);
        i
    }
    fn ids_for(&mut self, words: impl IntoIterator<Item = String>) -> Vec<u32> {
        let mut v: Vec<u32> = words
            .into_iter()
            .filter(|w| !w.is_empty() && !text::STOPS.contains(w.as_str()))
            .map(|w| self.id(&w))
            .collect();
        v.sort_unstable();
        v.dedup();
        v
    }
}

/// Year in a label, ignoring equipment numbers such as 2010.03.
pub fn year_of(s: &str) -> Option<i16> {
    let mut cleaned = s.to_string();
    for t in text::scan_ids(s).iter().rev() {
        if matches!(t.kind, IdKind::Equip | IdKind::Numbered) {
            cleaned.replace_range(t.start..t.end, " ");
        }
    }
    text::find_year(&cleaned).map(|y| y as i16)
}

static UNIT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{4})\s*-\s*(.+)$").unwrap());
static EQUIP_DIR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{4}[._]\d{1,4}[A-Za-z]?)(?:[\s_-]+(.*))?$").unwrap());
static NUMBERED_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\d+\s*-\s*").unwrap());
static RENUMBER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\(\s*(?:now|renumbered(?: to)?|became)\s+(\d{4}[._]\d{1,4}[A-Za-z]?)\s*\)").unwrap());
static PIPING_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bpiping\b|\bcircuits?\b").unwrap());
static PAIR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d{4}-\d{2,4})\s*\(\s*([A-Za-z]{1,6}-?\d{1,5}[A-Za-z]?)\s*\)").unwrap());

fn is_piping_chain(dirs: &[Dir], mut d: u32) -> bool {
    loop {
        let dir = &dirs[d as usize];
        if PIPING_RE.is_match(&dir.name) {
            return true;
        }
        match dir.parent {
            Some(p) if dir.depth > 1 => d = p,
            _ => return false,
        }
    }
}

static PAREN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\([^)]*\)").unwrap());

fn unit_keys(code: &str, name: &str) -> Vec<String> {
    const GENERIC: &[&str] = &["unit", "no", "the", "and", "utilities", "oos", "general", "plant"];
    let mut keys = vec![code.to_string()];
    for w in text::raw_words(name) {
        if w.len() >= 2 && !GENERIC.contains(&w.as_str()) && !w.chars().all(|c| c.is_ascii_digit()) {
            keys.push(w);
        }
    }
    keys
}

fn equip_number_key(raw: &str) -> String {
    raw.trim().to_lowercase().replace('_', ".")
}

impl Index {
    pub fn load(path: &Path) -> Result<Index, String> {
        let t0 = std::time::Instant::now();
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .map_err(|e| format!("Cannot open index database: {e}"))?;
        let mut idx = Self::load_conn(&conn)?;
        idx.source_path = path.display().to_string();
        idx.load_ms = t0.elapsed().as_millis();
        Ok(idx)
    }

    pub fn load_conn(conn: &Connection) -> Result<Index, String> {
        let e = |x: rusqlite::Error| x.to_string();
        let has = |t: &str| -> bool {
            conn.query_row("select count(*) from sqlite_master where type='table' and name=?", [t], |r| r.get::<_, i64>(0)).unwrap_or(0) > 0
        };
        if !has("files") || !has("roots") {
            return Err("This file is not a THOR knowledge database (no files/roots tables).".into());
        }
        let generated_at: Option<String> = conn
            .query_row("select max(coalesce(completed_at, started_at)) from crawls", [], |r| r.get(0))
            .ok()
            .flatten();

        // ── Roots and their latest crawl ────────────────────────────────
        let mut roots: Vec<RootInfo> = Vec::new();
        let mut root_norm: Vec<(String, String)> = Vec::new();
        {
            let mut st = conn
                .prepare("select root_id,path,norm_path,created_at,last_crawl_at,explorer_completed_at,enabled from roots order by path")
                .map_err(e)?;
            let rows = st
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, i64>(6)?,
                    ))
                })
                .map_err(e)?;
            for row in rows {
                let (id, path, norm, created, last, explorer, enabled) = row.map_err(e)?;
                let crawl = conn
                    .query_row(
                        "select started_at,completed_at,status,files_seen,dirs_seen,issues from crawls where root_id=? order by started_at desc limit 1",
                        [&id],
                        |r| {
                            Ok((
                                r.get::<_, Option<String>>(0)?,
                                r.get::<_, Option<String>>(1)?,
                                r.get::<_, Option<String>>(2)?,
                                r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                                r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                                r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                            ))
                        },
                    )
                    .ok();
                let mut norm_slash = norm.to_lowercase();
                if !norm_slash.ends_with('\\') {
                    norm_slash.push('\\');
                }
                root_norm.push((path.clone(), norm_slash));
                roots.push(RootInfo {
                    root_id: id,
                    path,
                    created_at: created,
                    last_crawl_at: last,
                    explorer_completed_at: explorer,
                    enabled: enabled != 0,
                    last_crawl_started: crawl.as_ref().and_then(|c| c.0.clone()),
                    last_crawl_completed: crawl.as_ref().and_then(|c| c.1.clone()),
                    last_crawl_status: crawl.as_ref().and_then(|c| c.2.clone()),
                    files_seen: crawl.as_ref().map(|c| c.3).unwrap_or(0),
                    dirs_seen: crawl.as_ref().map(|c| c.4).unwrap_or(0),
                    issues: crawl.as_ref().map(|c| c.5).unwrap_or(0),
                    files_indexed: 0,
                });
            }
        }

        // ── Folder roles recorded by the indexer ────────────────────────
        let mut indexer_roles: HashMap<String, DirRole> = HashMap::new();
        if has("directory_profiles") {
            let mut st = conn.prepare("select path, role from directory_profiles").map_err(e)?;
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?;
            for row in rows.flatten() {
                let role = DirRole::from_indexer(&row.1);
                if role != DirRole::None {
                    indexer_roles.insert(row.0.trim_end_matches('\\').to_lowercase(), role);
                }
            }
        }

        let mut it = Interner { terms: Vec::new(), ids: HashMap::new() };
        let mut units: Vec<Unit> = Vec::new();
        let mut unit_by_name: HashMap<String, u16> = HashMap::new();
        let mut dirs: Vec<Dir> = Vec::new();
        let mut dir_by_path: HashMap<String, u32> = HashMap::new();
        let mut equipment: Vec<Equip> = Vec::new();
        let mut equip_by_number: HashMap<String, u32> = HashMap::new();

        // Create (or find) a directory and all its parents up to the root.
        fn ensure_dir(
            path: &str,
            root: usize,
            roots: &[(String, String)],
            dirs: &mut Vec<Dir>,
            by_path: &mut HashMap<String, u32>,
            units: &mut Vec<Unit>,
            unit_by_name: &mut HashMap<String, u16>,
            roles: &HashMap<String, DirRole>,
            it: &mut Interner,
            equipment: &mut Vec<Equip>,
            equip_by_number: &mut HashMap<String, u32>,
            renumbered: &mut Vec<(String, String)>,
        ) -> u32 {
            let trimmed = path.trim_end_matches('\\');
            let key = trimmed.to_lowercase();
            if let Some(&i) = by_path.get(&key) {
                return i;
            }
            let root_trim = roots[root].1.trim_end_matches('\\');
            let is_root = key.len() <= root_trim.len();
            let (parent, name) = if is_root {
                (None, roots[root].0.clone())
            } else {
                let (p, n) = trimmed.rsplit_once('\\').unwrap_or(("", trimmed));
                let pi = ensure_dir(p, root, roots, dirs, by_path, units, unit_by_name, roles, it, equipment, equip_by_number, renumbered);
                (Some(pi), n.to_string())
            };
            let depth = parent.map(|p| dirs[p as usize].depth + 1).unwrap_or(0);
            let mut unit = parent.and_then(|p| dirs[p as usize].unit);
            if depth == 1 {
                let label = name.clone();
                let (code, uname) = match UNIT_RE.captures(&name) {
                    Some(c) => (c[1].to_string(), c[2].trim().to_string()),
                    None => (String::new(), name.clone()),
                };
                let ui = *unit_by_name.entry(label.to_lowercase()).or_insert_with(|| {
                    units.push(Unit { keys: unit_keys(&code, &uname), code: code.clone(), name: uname.clone(), label: label.clone() });
                    (units.len() - 1) as u16
                });
                unit = Some(ui);
            }
            let own_role = roles.get(&key).copied().filter(|r| *r != DirRole::None).unwrap_or_else(|| DirRole::from_name(&name));
            let mut role_chain = vec![own_role];
            if let Some(p) = parent {
                role_chain.extend(dirs[p as usize].roles.iter().copied());
            }
            role_chain.retain(|r| *r != DirRole::None);
            let archived = own_role == DirRole::Archive || parent.map(|p| dirs[p as usize].archived).unwrap_or(false);
            let year = if depth >= 1 { year_of(&name).or_else(|| parent.and_then(|p| dirs[p as usize].year)) } else { None };
            let mut terms: Vec<u32> = parent.map(|p| dirs[p as usize].terms.clone()).unwrap_or_default();
            let mut tags: Vec<u32> = parent.map(|p| dirs[p as usize].tags.clone()).unwrap_or_default();
            if depth >= 1 {
                terms.extend(it.ids_for(text::word_tokens(&name)));
                for t in text::scan_ids(&name) {
                    if t.kind != IdKind::Equip {
                        tags.push(it.id(&format!("tag:{}", t.key)));
                        if let Some(p) = &t.parent {
                            tags.push(it.id(&format!("tag:{p}")));
                        }
                    }
                }
                terms.sort_unstable();
                terms.dedup();
                tags.sort_unstable();
                tags.dedup();
            }
            let idx = dirs.len() as u32;
            // An equipment folder: "2010.03 (CS) V-3 PREFRACTIONATOR TOWER".
            let mut equip = parent.and_then(|p| dirs[p as usize].equip);
            if depth >= 2 {
                if let Some(c) = RENUMBER_RE.captures(&name) {
                    if let Some(old) = EQUIP_DIR_RE.captures(&name) {
                        renumbered.push((equip_number_key(&old[1]), equip_number_key(&c[1])));
                    }
                }
                let in_piping = parent.map(|p| is_piping_chain(dirs, p)).unwrap_or(false);
                let circuit = if in_piping && !EQUIP_DIR_RE.is_match(&name) {
                    text::scan_ids(&name).into_iter().find(|t| t.start == 0 && t.kind != IdKind::Equip)
                } else {
                    None
                };
                if let Some(tok) = circuit {
                    let number = tok.raw.to_uppercase();
                    let desc = name[tok.end..].trim_matches(|c: char| c.is_whitespace() || c == '-' || c == '_').to_string();
                    let key = tok.key.clone();
                    let ei = *equip_by_number.entry(key.clone()).or_insert_with(|| {
                        let mut keys = vec![key.clone()];
                        if let Some(p) = &tok.parent {
                            keys.push(p.clone());
                        }
                        equipment.push(Equip {
                            number,
                            tags: vec![],
                            description: desc,
                            unit,
                            kind: "Piping circuit".into(),
                            folder: Some(idx),
                            folder_path: Some(trimmed.to_string()),
                            historical: vec![],
                            hint_numbers: vec![],
                            entity_id: None,
                            source: "folder",
                            file_count: 0,
                            keys,
                        });
                        (equipment.len() - 1) as u32
                    });
                    equip = Some(ei);
                }
                if let Some(c) = EQUIP_DIR_RE.captures(&name) {
                    let number = equip_number_key(&c[1]);
                    let rest = c.get(2).map(|m| m.as_str()).unwrap_or("").to_string();
                    let ids = text::scan_ids(&rest);
                    let tag = ids.iter().find(|t| t.kind == IdKind::Tag && t.start < 12).map(|t| t.raw.to_uppercase());
                    let mut desc = PAREN_RE.replace_all(&rest, " ").to_string();
                    if let Some(t) = ids.iter().find(|t| t.kind == IdKind::Tag && t.start < 12) {
                        desc = desc.replacen(&rest[t.start..t.end], " ", 1);
                    }
                    let desc = desc.trim_matches(|c: char| c.is_whitespace() || c == '-' || c == '_').split_whitespace().collect::<Vec<_>>().join(" ");
                    let kind = parent.map(|p| NUMBERED_PREFIX_RE.replace(&dirs[p as usize].name, "").to_string()).unwrap_or_default();
                    let ei = *equip_by_number.entry(number.clone()).or_insert_with(|| {
                        equipment.push(Equip {
                            number: number.to_uppercase(),
                            tags: vec![],
                            description: String::new(),
                            unit,
                            kind: String::new(),
                            folder: None,
                            folder_path: None,
                            historical: vec![],
                            hint_numbers: vec![],
                            entity_id: None,
                            source: "folder",
                            file_count: 0,
                            keys: vec![number.clone()],
                        });
                        (equipment.len() - 1) as u32
                    });
                    let eq = &mut equipment[ei as usize];
                    if eq.folder.is_none() {
                        eq.folder = Some(idx);
                        eq.folder_path = Some(trimmed.to_string());
                        if eq.kind.is_empty() {
                            eq.kind = kind.trim().to_string();
                        }
                        if eq.description.is_empty() {
                            eq.description = desc;
                        }
                        if eq.unit.is_none() {
                            eq.unit = unit;
                        }
                    }
                    if let Some(t) = tag {
                        if !eq.tags.contains(&t) {
                            eq.tags.push(t);
                        }
                    }
                    equip = Some(ei);
                }
            }
            dirs.push(Dir {
                path: trimmed.to_string(),
                name,
                parent,
                root: root as u16,
                depth,
                unit,
                role: own_role,
                roles: role_chain,
                equip,
                year,
                archived,
                terms,
                tags,
            });
            by_path.insert(key, idx);
            idx
        }

        // ── Files ───────────────────────────────────────────────────────
        struct RawFile {
            id: String,
            path: String,
            name: String,
            ext: String,
            parent: String,
            size: i64,
            mtime: i64,
            current: bool,
        }
        let mut raw: Vec<RawFile> = Vec::new();
        {
            let mut st = conn
                .prepare("select file_id,path,filename,extension,parent_path,coalesce(size_bytes,-1),coalesce(mtime_ns,0),observation_state from files")
                .map_err(e)?;
            let rows = st
                .query_map([], |r| {
                    Ok(RawFile {
                        id: r.get(0)?,
                        path: r.get(1)?,
                        name: r.get(2)?,
                        ext: r.get::<_, String>(3)?.to_lowercase(),
                        parent: r.get(4)?,
                        size: r.get(5)?,
                        mtime: r.get::<_, i64>(6)? / 1_000_000_000,
                        current: r.get::<_, String>(7)? == "current",
                    })
                })
                .map_err(e)?;
            for row in rows {
                raw.push(row.map_err(e)?);
            }
        }
        raw.sort_by(|a, b| a.path.cmp(&b.path));

        // ── Equipment entities and aliases from the indexer ─────────────
        let mut entity_equip: HashMap<String, u32> = HashMap::new();
        if has("entities") {
            let mut st = conn.prepare("select entity_id, canonical_name from entities where entity_type='equipment' and status='active'").map_err(e)?;
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?;
            for row in rows.flatten() {
                let number = equip_number_key(&row.1);
                let ei = *equip_by_number.entry(number.clone()).or_insert_with(|| {
                    equipment.push(Equip {
                        number: number.to_uppercase(),
                        tags: vec![],
                        description: String::new(),
                        unit: None,
                        kind: String::new(),
                        folder: None,
                        folder_path: None,
                        historical: vec![],
                        hint_numbers: vec![],
                        entity_id: None,
                        source: "indexer",
                        file_count: 0,
                        keys: vec![number.clone()],
                    });
                    (equipment.len() - 1) as u32
                });
                equipment[ei as usize].entity_id = Some(row.0.clone());
                entity_equip.insert(row.0, ei);
            }
        }
        // Folders first (they carry units, kinds and descriptions).
        let mut file_dir: Vec<u32> = Vec::with_capacity(raw.len());
        let mut renumbered: Vec<(String, String)> = Vec::new();
        for f in &raw {
            let Some(r) = root_of(&f.parent, &root_norm).or_else(|| root_of(&f.path, &root_norm)) else {
                file_dir.push(u32::MAX);
                continue;
            };
            let d = ensure_dir(&f.parent, r, &root_norm, &mut dirs, &mut dir_by_path, &mut units, &mut unit_by_name, &indexer_roles, &mut it, &mut equipment, &mut equip_by_number, &mut renumbered);
            file_dir.push(d);
        }
        // Rebuild the entity map: folder equipment may have claimed numbers after entities loaded.
        if has("alias_candidates") && has("aliases") {
            let mut st = conn
                .prepare("select ac.entity_id, a.value, a.alias_type from alias_candidates ac join aliases a using(alias_id) where a.status='active'")
                .map_err(e)?;
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).map_err(e)?;
            for row in rows.flatten() {
                let Some(&ei) = entity_equip.get(&row.0) else { continue };
                let eq = &mut equipment[ei as usize];
                match row.2.as_str() {
                    "equipment_tag" => {
                        let t = row.1.to_uppercase();
                        if !eq.tags.contains(&t) {
                            eq.tags.push(t);
                        }
                    }
                    "equipment_description" => {
                        if eq.description.is_empty() {
                            // "V-2 Debutanizer Reciever" -> drop the leading tag.
                            let mut d = row.1.clone();
                            if let Some(t) = text::scan_ids(&d).into_iter().find(|t| t.start == 0) {
                                d = d[t.end..].to_string();
                            }
                            eq.description = d.trim_matches(|c: char| c.is_whitespace() || c == '-').to_string();
                        }
                    }
                    _ => {}
                }
            }
        }

        // ── Links, families, sheets and revisions ───────────────────────
        let file_index: HashMap<&str, u32> = raw.iter().enumerate().map(|(i, f)| (f.id.as_str(), i as u32)).collect();
        let mut links: Vec<Vec<(u32, LinkSrc)>> = vec![Vec::new(); raw.len()];
        if has("document_links") {
            let mut st = conn.prepare("select file_id, entity_id from document_links where link_type='DOCUMENT_FOR_EQUIPMENT'").map_err(e)?;
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?;
            for row in rows.flatten() {
                if let (Some(&fi), Some(&ei)) = (file_index.get(row.0.as_str()), entity_equip.get(&row.1)) {
                    links[fi as usize].push((ei, LinkSrc::Filename));
                }
            }
        }
        let mut families: Vec<Family> = Vec::new();
        let mut file_family: HashMap<u32, (u32, Option<String>, Option<String>)> = HashMap::new();
        if has("doc_families") && has("doc_members") {
            let mut fam_ids: HashMap<String, u32> = HashMap::new();
            let mut st = conn.prepare("select family_id, base_identifier, family_type from doc_families").map_err(e)?;
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).map_err(e)?;
            for row in rows.flatten() {
                fam_ids.insert(row.0, families.len() as u32);
                families.push(Family { base: row.1, kind: row.2, members: vec![] });
            }
            let mut st = conn.prepare("select family_id, file_id, sheet, revision from doc_members").map_err(e)?;
            let rows = st
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?)))
                .map_err(e)?;
            for row in rows.flatten() {
                if let (Some(&fa), Some(&fi)) = (fam_ids.get(&row.0), file_index.get(row.1.as_str())) {
                    families[fa as usize].members.push(fi);
                    file_family.insert(fi, (fa, row.2, row.3));
                }
            }
        }
        let mut sheet_rev: HashMap<u32, (Option<String>, Option<String>)> = HashMap::new();
        if has("identifiers") {
            let mut st = conn.prepare("select file_id, type, value from identifiers where type in ('sheet','revision') and file_id is not null").map_err(e)?;
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).map_err(e)?;
            for row in rows.flatten() {
                if let Some(&fi) = file_index.get(row.0.as_str()) {
                    let ent = sheet_rev.entry(fi).or_default();
                    let v = row.2.trim_start_matches("REV-").trim_start_matches("SHT-").to_string();
                    if row.1 == "sheet" {
                        ent.0.get_or_insert(v);
                    } else {
                        ent.1.get_or_insert(v);
                    }
                }
            }
        }

        // ── Historical numbers: an old number used inside another
        // equipment's folder, with no folder of its own ───────────────────
        let mut pair_counts: HashMap<(u32, u32), u32> = HashMap::new();
        let mut number_files: HashMap<u32, u32> = HashMap::new();
        for (fi, l) in links.iter().enumerate() {
            let d = file_dir[fi];
            for &(ei, _) in l {
                *number_files.entry(ei).or_default() += 1;
                if d == u32::MAX {
                    continue;
                }
                if let Some(fe) = dirs[d as usize].equip {
                    if fe != ei {
                        *pair_counts.entry((ei, fe)).or_default() += 1;
                    }
                }
            }
        }
        let mut history: HashMap<u32, u32> = HashMap::new();
        for (&(old, new), &n) in &pair_counts {
            let o = &equipment[old as usize];
            let total = number_files.get(&old).copied().unwrap_or(0);
            if o.folder.is_none() && n >= 2 && n * 10 >= total * 8 {
                let better = history.get(&old).map(|&cur| pair_counts.get(&(old, cur)).copied().unwrap_or(0) < n).unwrap_or(true);
                if better {
                    history.insert(old, new);
                }
            }
        }
        // Learned hints stay weak; stated renumbering ("(Now 5610.15)") is certain.
        let mut hint_keys: HashMap<String, Vec<u32>> = HashMap::new();
        for (&old, &new) in &history {
            let num = equipment[old as usize].number.clone();
            let eq = &mut equipment[new as usize];
            if !eq.hint_numbers.contains(&num) {
                eq.hint_numbers.push(num.clone());
                hint_keys.entry(num.to_lowercase()).or_default().push(new);
            }
        }
        for (old, new) in &renumbered {
            let (Some(&o), Some(&n)) = (equip_by_number.get(old), equip_by_number.get(new)) else { continue };
            if o == n {
                continue;
            }
            let onum = equipment[o as usize].number.clone();
            let nnum = equipment[n as usize].number.clone();
            if !equipment[n as usize].historical.contains(&onum) {
                equipment[n as usize].historical.push(onum.clone());
                equipment[n as usize].keys.push(old.clone());
            }
            if !equipment[o as usize].historical.iter().any(|h| h == &format!("now {nnum}")) {
                equipment[o as usize].historical.push(format!("now {nnum}"));
            }
        }

        // ── File records ───────────────────────────────────────────────
        let mut files: Vec<FileRec> = Vec::with_capacity(raw.len());
        for (fi, f) in raw.iter().enumerate() {
            let d = file_dir[fi];
            if d == u32::MAX {
                continue;
            }
            let dir = &dirs[d as usize];
            let (cat, doctype) = classify::classify(&f.name, &f.ext, &dir.roles);
            let stem = f.name.strip_suffix(&f.name[f.name.len().saturating_sub(f.ext.len())..]).unwrap_or(&f.name);
            let ny = year_of(stem);
            let mut flags = 0u8;
            if classify::is_junk(&f.name, &f.ext) {
                flags |= F_JUNK;
            }
            if f.size == 0 {
                flags |= F_ZERO;
            }
            if dir.archived {
                flags |= F_ARCHIVE;
            }
            if classify::is_blank_template(&f.name) || dir.roles.contains(&DirRole::Templates) {
                flags |= F_BLANK;
            }
            if !f.current {
                flags |= F_GONE;
            }
            let mut equip: Vec<(u32, LinkSrc)> = Vec::new();
            if let Some(fe) = dir.equip {
                equip.push((fe, LinkSrc::Folder));
            }
            for &(ei, src) in &links[fi] {
                let target = ei;
                if let Some(pos) = equip.iter().position(|(x, _)| *x == target) {
                    equip[pos].1 = LinkSrc::Filename;
                } else {
                    equip.push((target, src));
                }
            }
            let fam = file_family.get(&(fi as u32));
            let sr = sheet_rev.get(&(fi as u32));
            let sheet = fam.and_then(|x| x.1.clone()).or_else(|| sr.and_then(|x| x.0.clone()));
            let rev = fam.and_then(|x| x.2.clone()).or_else(|| sr.and_then(|x| x.1.clone()));
            let mut name_words = text::word_tokens(stem);
            name_words.push(f.ext.trim_start_matches('.').to_string());
            let name_terms = it.ids_for(name_words);
            let mut meta: Vec<String> = Vec::new();
            meta.extend(cat.words().iter().map(|s| s.to_string()));
            meta.extend(text::word_tokens(doctype));
            for &(ei, _) in equip.iter().take(2) {
                meta.extend(text::word_tokens(&equipment[ei as usize].description));
                meta.extend(text::word_tokens(&equipment[ei as usize].kind));
            }
            // TracePoint retrieval expansions: they widen recall, never classification.
            let all: HashSet<String> = meta.iter().cloned().chain(text::word_tokens(stem)).collect();
            if all.contains("replace") {
                meta.push("repair".into());
            }
            if all.contains("repair") {
                meta.push("replace".into());
            }
            if all.contains("onstream") {
                meta.push("external".into());
                meta.push("internal".into());
            }
            if all.contains("visual") && (f.name.to_lowercase().contains("api") || dir.path.to_lowercase().contains("api")) {
                for w in ["external", "internal", "onstream", "inspection"] {
                    meta.push(w.into());
                }
            }
            if cat == Category::Inspection && !dir.roles.is_empty() {
                meta.push("inspection".into());
            }
            let meta_terms = it.ids_for(meta);
            let mut tags: Vec<u32> = Vec::new();
            for t in text::scan_ids(stem) {
                if t.kind != IdKind::Equip {
                    tags.push(it.id(&format!("tag:{}", t.key)));
                    if let Some(p) = &t.parent {
                        tags.push(it.id(&format!("tag:{p}")));
                    }
                }
            }
            tags.sort_unstable();
            tags.dedup();
            files.push(FileRec {
                file_id: f.id.clone(),
                dir: d,
                name: f.name.clone(),
                ext: f.ext.clone(),
                size: f.size,
                mtime: f.mtime,
                cat,
                doctype,
                year: ny.or(dir.year),
                year_from_name: ny.is_some(),
                equip,
                family: fam.map(|x| x.0),
                sheet,
                rev,
                flags,
                name_terms,
                meta_terms,
                tags,
            });
        }
        // `families[].members` were raw-file indices; they equal file indices
        // because every raw file with a root was kept in order. Rebuild to be safe.
        for fam in families.iter_mut() {
            fam.members.clear();
        }
        let raw_to_file: Vec<u32> = {
            let mut v = vec![u32::MAX; raw.len()];
            let mut k = 0u32;
            for (i, d) in file_dir.iter().enumerate() {
                if *d != u32::MAX {
                    v[i] = k;
                    k += 1;
                }
            }
            v
        };
        for (rfi, (fa, _, _)) in &file_family {
            let fi = raw_to_file[*rfi as usize];
            if fi != u32::MAX {
                families[*fa as usize].members.push(fi);
            }
        }
        // Latest revision per family sheet.
        for fam in &families {
            let mut best: HashMap<String, (u32, i64, String)> = HashMap::new();
            for &fi in &fam.members {
                let f = &files[fi as usize];
                let sheet = f.sheet.clone().unwrap_or_default();
                let rv = f.rev.clone().unwrap_or_default();
                let num = rv.parse::<i64>().unwrap_or(-1);
                let ent = best.entry(sheet).or_insert((fi, num, rv.clone()));
                if num > ent.1 || (num == ent.1 && rv > ent.2) {
                    *ent = (fi, num, rv);
                }
            }
            for (_, (fi, _, _)) in best {
                files[fi as usize].flags |= F_LATEST;
            }
        }

        // "2515-060 (DHT-060)": the numbered circuit is also known by its tag.
        for f in &raw {
            for c in PAIR_RE.captures_iter(&f.name) {
                let nkey = text::scan_ids(&c[1]).into_iter().next().map(|t| t.key);
                let tkey = text::scan_ids(&c[2]).into_iter().next().map(|t| t.key);
                if let (Some(nk), Some(tk)) = (nkey, tkey) {
                    if let Some(&ei) = equip_by_number.get(&nk) {
                        let eq = &mut equipment[ei as usize];
                        if !eq.keys.contains(&tk) {
                            eq.keys.push(tk);
                            eq.tags.push(c[2].to_uppercase());
                        }
                    }
                }
            }
        }

        // ── Equipment keys and per-equipment file lists ────────────────
        let mut equip_keys: HashMap<String, Vec<u32>> = HashMap::new();
        for (ei, eq) in equipment.iter_mut().enumerate() {
            let mut keys: Vec<String> = eq.keys.clone();
            for t in &eq.tags {
                for tok in text::scan_ids(t) {
                    keys.push(tok.key);
                }
            }
            keys.sort();
            keys.dedup();
            for k in &keys {
                equip_keys.entry(k.clone()).or_default().push(ei as u32);
            }
            eq.keys = keys;
        }
        let mut equip_files: Vec<Vec<u32>> = vec![Vec::new(); equipment.len()];
        for (fi, f) in files.iter().enumerate() {
            for &(ei, _) in &f.equip {
                equip_files[ei as usize].push(fi as u32);
            }
        }
        for (ei, eq) in equipment.iter_mut().enumerate() {
            eq.file_count = equip_files[ei].len() as u32;
            if eq.unit.is_none() {
                // Most common unit among its files.
                let mut c: HashMap<u16, u32> = HashMap::new();
                for &fi in &equip_files[ei] {
                    if let Some(u) = dirs[files[fi as usize].dir as usize].unit {
                        *c.entry(u).or_default() += 1;
                    }
                }
                eq.unit = c.into_iter().max_by_key(|x| x.1).map(|x| x.0);
            }
        }

        let mut cooccur = Vec::new();
        if has("relationships") {
            let mut st = conn
                .prepare("select from_id, to_id, confidence from relationships where rel_type='CO_OCCURS_OR_BRIDGES' and status='active'")
                .map_err(e)?;
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?))).map_err(e)?;
            for row in rows.flatten() {
                if let (Some(&a), Some(&b)) = (entity_equip.get(&row.0), entity_equip.get(&row.1)) {
                    if a != b {
                        cooccur.push((a, b, row.2 as f32));
                    }
                }
            }
        }

        for f in &files {
            let r = dirs[f.dir as usize].root as usize;
            roots[r].files_indexed += 1;
        }

        Ok(Index {
            source_path: String::new(),
            generated_at,
            roots,
            units,
            dirs,
            files,
            equipment,
            families,
            cooccur,
            terms: it.terms,
            term_ids: it.ids,
            equip_keys,
            hint_keys,
            equip_files,
            load_ms: 0,
        })
    }

    pub fn full_path(&self, fi: u32) -> String {
        let f = &self.files[fi as usize];
        format!("{}\\{}", self.dirs[f.dir as usize].path, f.name)
    }

    pub fn relative_folder(&self, dir: u32) -> String {
        let d = &self.dirs[dir as usize];
        let root = &self.roots[d.root as usize].path;
        d.path.strip_prefix(root.as_str()).unwrap_or(&d.path).trim_start_matches('\\').to_string()
    }

    pub fn unit_label(&self, dir: u32) -> Option<&str> {
        self.dirs[dir as usize].unit.map(|u| self.units[u as usize].label.as_str())
    }
}
