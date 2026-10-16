//! Connections between files, worked out on each PC from the files that PC
//! loaded (so a connection can never point at a file this person can't
//! open): copies of the same file, revisions of the same document, the
//! equipment a document is about (from its contents), documents stranded
//! away from their equipment's folder, and files that moved.
//!
//! Every conclusion is a score with its reasons. Revision order trusts what
//! the documents say over file dates: a superseded copy dropped into a
//! folder last week is still the older revision.

use crate::card::{rev_rank, Card};
use crate::index::{Index, LinkSrc, F_ARCHIVE, F_GONE, F_JUNK, F_ZERO};
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

pub const F_PRIVATE: u8 = 64;

#[derive(Clone, Debug, Default, Serialize)]
pub struct FileLink {
    /// Other copies of this exact file (same bytes, or same name and size).
    pub copies: u32,
    /// The copy in the best-kept place, when this isn't it.
    pub home: Option<u32>,
    /// Is this the copy in the best-kept place?
    pub is_home: bool,
    /// The newest revision of this document, when this file is older.
    pub newer: Option<u32>,
    pub newer_why: Option<String>,
    /// Other revisions known.
    pub versions: u32,
    /// Saved more recently than the newest revision, yet older itself.
    pub stale_copy: bool,
    /// This file wasn't seen in the last scan; the same file is now here.
    pub moved_to: Option<u32>,
    /// Equipment found from the document's contents: (equipment, why).
    pub content_equip: Vec<(u32, String)>,
    /// About this equipment, but not in its folder.
    pub stranded_for: Vec<u32>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct LinkStats {
    pub cards: usize,
    pub copy_groups: usize,
    pub extra_copies: usize,
    pub version_groups: usize,
    pub superseded: usize,
    pub stale_copies: usize,
    pub content_links: usize,
    pub stranded: usize,
    pub moved: usize,
    pub nameplate_matches: usize,
    pub ms: u128,
}

#[derive(Default)]
pub struct Links {
    pub files: HashMap<u32, FileLink>,
    /// Equipment → documents about it that live elsewhere.
    pub stranded: HashMap<u32, Vec<u32>>,
    pub stats: LinkStats,
}

impl Links {
    pub fn get(&self, fi: u32) -> Option<&FileLink> {
        self.files.get(&fi)
    }
}

struct Uf(Vec<u32>);
impl Uf {
    fn new(n: usize) -> Uf {
        Uf((0..n as u32).collect())
    }
    fn find(&mut self, x: u32) -> u32 {
        let mut r = x;
        while self.0[r as usize] != r {
            r = self.0[r as usize];
        }
        let mut x = x;
        while self.0[x as usize] != r {
            let n = self.0[x as usize];
            self.0[x as usize] = r;
            x = n;
        }
        r
    }
    fn union(&mut self, a: u32, b: u32) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.0[ra.max(rb) as usize] = ra.min(rb);
        }
    }
}

static RE_STEM_NOISE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?ix)
        \b(?:rev(?:ision)?|ver(?:sion)?)[\s._-]*[a-z0-9]{1,3}\b |
        \bv\d{1,3}\b | \br\d{1,2}\b |
        \b(?:19|20)\d{2}[\s._-]?\d{2}[\s._-]?\d{2}\b | \b\d{1,2}[\s._-]\d{1,2}[\s._-](?:19|20)?\d{2}\b |
        \bcopy\s+of\b | \s-\s?copy\b | \bcopy\b | \(\d+\)$ | \(\d+\) |
        \b(?:old|superseded|obsolete|final|draft|latest|current|updated|signed|scanned?)\b
    ").unwrap()
});

/// A file name with revision marks, dates and "copy of" removed, if what's
/// left is specific enough to identify a document.
fn stem_key(name: &str) -> Option<String> {
    let stem = name.rsplit_once('.').map(|x| x.0).unwrap_or(name).to_lowercase();
    let cleaned = RE_STEM_NOISE.replace_all(&stem, " ");
    let words: Vec<&str> = cleaned.split(|c: char| !c.is_alphanumeric() && c != '.').filter(|w| !w.is_empty() && *w != ".").collect();
    let has_id = words.iter().any(|w| w.chars().any(|c| c.is_ascii_digit()) && w.len() >= 3);
    (has_id && words.len() >= 2 || words.len() >= 4).then(|| words.join(" "))
}

fn is_under(idx: &Index, mut dir: u32, ancestor: u32) -> bool {
    loop {
        if dir == ancestor {
            return true;
        }
        match idx.dirs[dir as usize].parent {
            Some(p) => dir = p,
            None => return false,
        }
    }
}

fn year_of_mtime(ns: i64) -> i32 {
    // yyyymmdd from a Unix-nanosecond time.
    let secs = ns / 1_000_000_000;
    let s = crate::auth::format_utc(secs);
    s[..10].replace('-', "").parse().unwrap_or(0)
}

/// Work out all connections and add content-found equipment to the index
/// (so searching an equipment number also finds its stranded documents).
pub fn apply(idx: &mut Index, cards: &HashMap<u32, Card>) -> Links {
    let t0 = std::time::Instant::now();
    let n = idx.files.len();
    let mut links = Links::default();
    links.stats.cards = cards.len();
    let live = |idx: &Index, fi: u32| idx.files[fi as usize].flags & (F_GONE | F_JUNK | F_ZERO) == 0;

    // ── Equipment from contents ──────────────────────────────────────
    // Nameplate numbers (National Board, serial) seen in the header of a
    // document that sits in an equipment's folder identify that equipment.
    let mut plate: HashMap<(String, String), HashSet<u32>> = HashMap::new();
    for (&fi, c) in cards {
        // Filed inside an equipment's folder (at any depth).
        let Some(folder_eq) = idx.dirs[idx.files[fi as usize].dir as usize].equip else { continue };
        for s in c.ids.iter().filter(|s| (s.k == "nb" || s.k == "serial") && s.w >= 4.0) {
            plate.entry((s.k.clone(), s.v.clone())).or_default().insert(folder_eq);
        }
    }
    plate.retain(|_, v| v.len() == 1);
    let mut added: Vec<(u32, u32, String)> = Vec::new();
    for (&fi, c) in cards {
        let f = &idx.files[fi as usize];
        let unit = idx.dirs[f.dir as usize].unit;
        let mut score: HashMap<u32, (f32, String)> = HashMap::new();
        for s in &c.ids {
            match s.k.as_str() {
                "equip" | "tag" | "numbered" => {
                    let Some(eqs) = idx.equip_keys.get(&s.v) else { continue };
                    // A tag used in many units only counts inside this file's unit.
                    let cands: Vec<u32> = if eqs.len() == 1 { eqs.clone() } else { eqs.iter().copied().filter(|e| unit.is_some() && idx.equipment[*e as usize].unit == unit).collect() };
                    if cands.len() != 1 {
                        continue;
                    }
                    let w = if s.k == "equip" { s.w } else { s.w * 0.8 };
                    let e = score.entry(cands[0]).or_insert((0.0, String::new()));
                    e.0 += w;
                    if e.1.is_empty() {
                        e.1 = if s.w >= 4.0 { format!("\"{}\" in the document's title/header", s.v.to_uppercase()) } else { format!("\"{}\" in the document text", s.v.to_uppercase()) };
                    }
                }
                "nb" | "serial" => {
                    if let Some(eqs) = plate.get(&(s.k.clone(), s.v.clone())) {
                        let ei = *eqs.iter().next().unwrap();
                        let e = score.entry(ei).or_insert((0.0, String::new()));
                        e.0 += 20.0;
                        e.1 = format!("{} {} matches its nameplate", if s.k == "nb" { "National Board No." } else { "Serial No." }, s.v);
                        links.stats.nameplate_matches += 1;
                    }
                }
                _ => {}
            }
        }
        let best = score.values().map(|x| x.0).fold(0.0f32, f32::max);
        // One mention in the title block / header is enough; mentions only
        // deeper in the text need to add up.
        if best < 4.0 {
            continue;
        }
        let mut picks: Vec<(u32, f32, String)> = score.into_iter().filter(|(_, (w, _))| *w >= 4.0 && *w >= best * 0.5).map(|(e, (w, why))| (e, w, why)).collect();
        picks.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        picks.truncate(3);
        for (ei, _, why) in picks {
            if !f.equip.iter().any(|x| x.0 == ei) {
                added.push((fi, ei, why));
            }
        }
    }
    for (fi, ei, why) in added {
        idx.files[fi as usize].equip.push((ei, LinkSrc::Content));
        idx.equip_files[ei as usize].push(fi);
        idx.equipment[ei as usize].file_count += 1;
        links.files.entry(fi).or_default().content_equip.push((ei, why));
        links.stats.content_links += 1;
    }
    // Stranded: about an equipment (by name or contents) but not in its folder.
    for fi in 0..n as u32 {
        if !live(idx, fi) {
            continue;
        }
        let f = &idx.files[fi as usize];
        let mut strands = Vec::new();
        for &(ei, src) in &f.equip {
            if !matches!(src, LinkSrc::Filename | LinkSrc::Content) {
                continue;
            }
            if let Some(home) = idx.equipment[ei as usize].folder {
                if is_under(idx, f.dir, home) {
                    continue;
                }
                // Filed with a sub-item of the same number (6117.12C with
                // 6117.12): that's its own folder, not stranded.
                if let Some(de) = idx.dirs[f.dir as usize].equip {
                    let (own, other) = (&idx.equipment[ei as usize].number, &idx.equipment[de as usize].number);
                    if de != ei && (other.to_lowercase().starts_with(&own.to_lowercase()) || own.to_lowercase().starts_with(&other.to_lowercase())) {
                        continue;
                    }
                }
                strands.push(ei);
            }
        }
        if !strands.is_empty() {
            for &ei in &strands {
                links.stranded.entry(ei).or_default().push(fi);
            }
            links.stats.stranded += 1;
            links.files.entry(fi).or_default().stranded_for = strands;
        }
    }

    // ── Copies ───────────────────────────────────────────────────────
    let mut copy_key: HashMap<String, Vec<u32>> = HashMap::new();
    for fi in 0..n as u32 {
        if !live(idx, fi) {
            continue;
        }
        let f = &idx.files[fi as usize];
        let key = match cards.get(&fi).and_then(|c| c.sha256.clone()) {
            Some(h) => format!("h:{h}"),
            None if f.size >= 2048 => format!("n:{}:{}", f.name.to_lowercase(), f.size),
            None => continue,
        };
        copy_key.entry(key).or_default().push(fi);
    }
    let place = |idx: &Index, fi: u32| -> (i32, i64, usize) {
        let f = &idx.files[fi as usize];
        let path = idx.full_path(fi).to_lowercase();
        let mut s = 0;
        if let Some(de) = idx.dirs[f.dir as usize].equip {
            s += 2;
            // The folder of the equipment the file itself names: its home.
            if f.equip.iter().any(|(e, src)| *e == de && matches!(src, LinkSrc::Filename | LinkSrc::Content)) {
                s += 3;
            }
        }
        if path.contains("equipment files") {
            s += 1;
        }
        if f.flags & F_ARCHIVE != 0 {
            s -= 2;
        }
        if ["copy", "\\old", "backup", "temp", "personal", "desktop", "superseded", "obsolete", "downloads"].iter().any(|w| path.contains(w)) {
            s -= 1;
        }
        if f.flags & F_PRIVATE != 0 {
            s -= 5;
        }
        (s, f.mtime, path.len())
    };
    // Copies of one file collapse to one member for revision ordering.
    let mut copy_of: HashMap<u32, u32> = HashMap::new();
    for (_, mut group) in copy_key.into_iter().filter(|(_, g)| g.len() > 1) {
        group.sort_by(|a, b| {
            let (pa, pb) = (place(idx, *a), place(idx, *b));
            pb.0.cmp(&pa.0).then(pa.1.cmp(&pb.1)).then(pa.2.cmp(&pb.2))
        });
        let home = group[0];
        links.stats.copy_groups += 1;
        links.stats.extra_copies += group.len() - 1;
        for &fi in &group {
            let l = links.files.entry(fi).or_default();
            l.copies = group.len() as u32 - 1;
            if fi == home {
                l.is_home = true;
            } else {
                l.home = Some(home);
                copy_of.insert(fi, home);
            }
        }
    }

    // ── Moved files ──────────────────────────────────────────────────
    let mut current: HashMap<(String, i64, i64), u32> = HashMap::new();
    for fi in 0..n as u32 {
        let f = &idx.files[fi as usize];
        if f.flags & F_GONE == 0 && f.size > 0 {
            current.insert((f.name.to_lowercase(), f.size, f.mtime), fi);
        }
    }
    for fi in 0..n as u32 {
        let f = &idx.files[fi as usize];
        if f.flags & F_GONE != 0 {
            if let Some(&to) = current.get(&(f.name.to_lowercase(), f.size, f.mtime)) {
                links.files.entry(fi).or_default().moved_to = Some(to);
                links.stats.moved += 1;
            }
        }
    }

    // ── Revisions of the same document ───────────────────────────────
    let mut uf = Uf::new(n);
    let mut keyed: HashMap<String, Vec<u32>> = HashMap::new();
    for fi in 0..n as u32 {
        if !live(idx, fi) || copy_of.contains_key(&fi) {
            continue;
        }
        let f = &idx.files[fi as usize];
        if f.cat == crate::classify::Category::Photos {
            continue;
        }
        let sheet = f.sheet.clone().unwrap_or_default().to_lowercase();
        if let Some(fam) = f.family {
            keyed.entry(format!("fam:{fam}:{sheet}")).or_default().push(fi);
        }
        if let Some(c) = cards.get(&fi) {
            for s in c.ids.iter().filter(|s| (s.k == "drawing" || s.k == "pid") && s.w >= 4.0) {
                keyed.entry(format!("dwg:{}:{sheet}", s.v)).or_default().push(fi);
            }
        }
        if let Some(stem) = stem_key(&f.name) {
            let anchor = f.equip.first().map(|e| format!("e{}", e.0)).unwrap_or_else(|| format!("r{}", idx.dirs[f.dir as usize].root));
            keyed.entry(format!("name:{stem}|{anchor}|{}", f.ext)).or_default().push(fi);
        }
    }
    for (_, g) in keyed.iter().filter(|(_, g)| g.len() > 1 && g.len() <= 60) {
        for w in g.windows(2) {
            uf.union(w[0], w[1]);
        }
    }
    // Near-identical text (a scan and the native PDF; a light revision).
    let mut bands: HashMap<(u8, u16), Vec<u32>> = HashMap::new();
    for (&fi, c) in cards {
        if copy_of.contains_key(&fi) || !live(idx, fi) || c.chars < 300 {
            continue;
        }
        if let Some(h) = c.simhash {
            for b in 0..4u8 {
                bands.entry((b, (h >> (b * 16)) as u16)).or_default().push(fi);
            }
        }
    }
    for (_, g) in bands.iter().filter(|(_, g)| g.len() > 1 && g.len() <= 40) {
        for i in 0..g.len() {
            for j in i + 1..g.len() {
                let (a, b) = (g[i], g[j]);
                let (ha, hb) = (cards[&a].simhash.unwrap(), cards[&b].simhash.unwrap());
                if (ha ^ hb).count_ones() <= 8 && cards[&a].sha256 != cards[&b].sha256 {
                    uf.union(a, b);
                }
            }
        }
    }
    let mut clusters: HashMap<u32, Vec<u32>> = HashMap::new();
    for fi in 0..n as u32 {
        if !live(idx, fi) || copy_of.contains_key(&fi) {
            continue;
        }
        let r = uf.find(fi);
        clusters.entry(r).or_default().push(fi);
    }
    for (_, members) in clusters.into_iter().filter(|(_, m)| m.len() > 1 && m.len() <= 80) {
        // Evidence for each member: revision (document > file name), date
        // written in the document, file date.
        struct Ev {
            fi: u32,
            rev: Option<i32>,
            rev_label: Option<String>,
            rev_from_doc: bool,
            doc_date: Option<i32>,
            file_date: i32,
        }
        let ev: Vec<Ev> = members
            .iter()
            .map(|&fi| {
                let f = &idx.files[fi as usize];
                let c = cards.get(&fi);
                let doc_rev = c.and_then(|c| c.rev_rank.map(|r| (r, c.rev.clone())));
                let name_rev = f.rev.as_deref().and_then(|r| rev_rank(r).map(|k| (k, Some(r.to_string()))));
                let (rev, rev_label, rev_from_doc) = match (doc_rev, name_rev) {
                    (Some((r, l)), _) => (Some(r), l, true),
                    (None, Some((r, l))) => (Some(r), l, false),
                    _ => (None, None, false),
                };
                Ev { fi, rev, rev_label, rev_from_doc, doc_date: c.and_then(|c| c.doc_date), file_date: year_of_mtime(f.mtime) }
            })
            .collect();
        let with_rev = ev.iter().filter(|e| e.rev.is_some()).count();
        let distinct_revs: HashSet<i32> = ev.iter().filter_map(|e| e.rev).collect();
        let distinct_dates: HashSet<i32> = ev.iter().filter_map(|e| e.doc_date).collect();
        // Pick the newest, and how sure we are.
        let (newest, basis) = if with_rev >= 2 && distinct_revs.len() >= 2 {
            let top = ev.iter().filter(|e| e.rev.is_some()).max_by_key(|e| (e.rev, e.doc_date, e.file_date)).unwrap();
            (top.fi, "rev")
        } else if ev.iter().filter(|e| e.doc_date.is_some()).count() >= 2 && distinct_dates.len() >= 2 {
            let top = ev.iter().filter(|e| e.doc_date.is_some()).max_by_key(|e| (e.doc_date, e.file_date)).unwrap();
            (top.fi, "date")
        } else {
            // Only file dates: list as related versions, claim nothing.
            for e in &ev {
                links.files.entry(e.fi).or_default().versions = members.len() as u32 - 1;
            }
            continue;
        };
        links.stats.version_groups += 1;
        let top = ev.iter().find(|e| e.fi == newest).unwrap();
        for e in &ev {
            let l = links.files.entry(e.fi).or_default();
            l.versions = members.len() as u32 - 1;
            if e.fi == newest {
                continue;
            }
            let older = match basis {
                "rev" => e.rev.map(|r| r < top.rev.unwrap_or(r)).unwrap_or(false),
                _ => e.doc_date.map(|d| d < top.doc_date.unwrap_or(d)).unwrap_or(false),
            };
            if !older {
                continue;
            }
            l.newer = Some(newest);
            l.newer_why = Some(match basis {
                "rev" => format!(
                    "Rev {} {} vs Rev {} here{}",
                    top.rev_label.clone().unwrap_or_default(),
                    if top.rev_from_doc { "(stated in the document)" } else { "(from its name)" },
                    e.rev_label.clone().unwrap_or_default(),
                    if e.rev_from_doc { "" } else { " (from its name)" }
                ),
                _ => format!("Dated {} in the document vs {} here", fmt_ymd(top.doc_date.unwrap_or(0)), fmt_ymd(e.doc_date.unwrap_or(0))),
            });
            links.stats.superseded += 1;
            if e.file_date > top.file_date {
                l.stale_copy = true;
                links.stats.stale_copies += 1;
            }
        }
    }
    // Copies inherit their home's revision status.
    for (&fi, &home) in &copy_of {
        if let Some(h) = links.files.get(&home).cloned() {
            let l = links.files.entry(fi).or_default();
            l.newer = h.newer;
            l.newer_why = h.newer_why.clone();
            l.versions = h.versions;
        }
    }
    links.stats.ms = t0.elapsed().as_millis();
    links
}

pub fn fmt_ymd(d: i32) -> String {
    if d <= 0 {
        return "?".into();
    }
    format!("{:04}-{:02}-{:02}", d / 10000, d / 100 % 100, d % 100)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::card::{Card, Seen};

    #[test]
    fn stems_ignore_revision_and_copy_marks() {
        assert_eq!(stem_key("5610.15 Nozzle Repair Rev 3.pdf"), stem_key("Copy of 5610.15 Nozzle Repair REV2 (1).pdf"));
        assert_eq!(stem_key("inspection report.pdf"), None, "too generic");
        assert!(stem_key("D-2010-04 sheet 2 2021-06-22.dwg").is_some());
    }

    fn card(ids: &[(&str, &str, f32)], rev: Option<&str>, date: Option<i32>, sha: &str) -> Card {
        Card {
            sha256: Some(sha.into()),
            ids: ids.iter().map(|(k, v, w)| Seen { k: k.to_string(), v: v.to_string(), w: *w }).collect(),
            rev: rev.map(str::to_string),
            rev_rank: rev.and_then(rev_rank),
            doc_date: date,
            chars: 1000,
            ..Default::default()
        }
    }

    #[test]
    fn links_a_real_mess() {
        // THOR: the equipment folder, a project folder, a scan from the copier.
        let dir = std::env::temp_dir().join(format!("tp-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let c = rusqlite::Connection::open_in_memory().unwrap();
        crate::crawl::ensure_schema(&c).unwrap();
        c.execute_batch(r"insert into roots values('r1','\\thor\Equipment Files','\\thor\equipment files','2026',null,null,1);
                          insert into roots values('r2','\\thor\Engineering','\\thor\engineering','2026',null,null,1);").unwrap();
        let files = [
            ("f1", "r1", r"\\thor\Equipment Files\5600 - LRU\10 - VESSELS\5610.15 V-2 Debutanizer Receiver\U1A\U-1A.pdf", 1000),
            ("f2", "r1", r"\\thor\Equipment Files\5600 - LRU\10 - VESSELS\5610.15 V-2 Debutanizer Receiver\DRAWINGS\D-5610-15 Nozzle Repair Rev 2.pdf", 2000),
            ("f3", "r2", r"\\thor\Engineering\Projects\2023 LRU Turnaround\D-5610-15 Nozzle Repair Rev 3.pdf", 3000),
            ("f4", "r2", r"\\thor\Engineering\Scans\DOC20230514123456.pdf", 4000),
            ("f5", "r2", r"\\thor\Engineering\Old stuff\D-5610-15 Nozzle Repair Rev 2 - Copy.pdf", 2000),
        ];
        for (id, root, path, size) in files {
            let parent = path.rsplit_once('\\').unwrap().0;
            let name = path.rsplit_once('\\').unwrap().1;
            c.execute(
                "insert into files(file_id,root_id,path,norm_path,filename,stem,extension,parent_path,depth,filename_class,useful,first_seen,last_seen,first_crawl,last_crawl,observation_state,change_state,size_bytes,mtime_ns)
                 values(?1,?2,?3,lower(?3),?4,?4,'.pdf',?5,4,'SEMANTIC',1,'','','','','current','new',?6,?7)",
                rusqlite::params![id, root, path, name, parent, size, 1_700_000_000_000_000_000i64 + size * 1_000_000_000_000],
            )
            .unwrap();
        }
        let mut idx = Index::load_conn(&c).unwrap();
        let fi = |name: &str| idx.files.iter().position(|f| f.name.starts_with(name)).unwrap() as u32;
        let (u1a, rev2, rev3, scan, copy2) = (fi("U-1A"), fi("D-5610-15 Nozzle Repair Rev 2.pdf"), fi("D-5610-15 Nozzle Repair Rev 3"), fi("DOC2023"), fi("D-5610-15 Nozzle Repair Rev 2 - Copy"));
        let mut cards = HashMap::new();
        cards.insert(u1a, card(&[("nb", "33127", 8.0), ("equip", "5610.15", 4.0)], None, Some(19870514), "a"));
        cards.insert(rev2, card(&[("drawing", "D-5610-15", 4.0)], Some("2"), Some(20190104), "b"));
        cards.insert(rev3, card(&[("drawing", "D-5610-15", 4.0), ("equip", "5610.15", 4.0)], Some("3"), Some(20230301), "c"));
        // The copier scan: only its nameplate photo copy identifies it.
        cards.insert(scan, card(&[("nb", "33127", 8.0)], None, Some(20230514), "d"));
        // A copy of Rev 2 dropped somewhere later: same bytes as rev2.
        cards.insert(copy2, card(&[("drawing", "D-5610-15", 4.0)], Some("2"), Some(20190104), "b"));
        let eq = idx.equip_keys["5610.15"][0];
        let l = apply(&mut idx, &cards);
        // The scan is about 5610.15, found by its National Board number.
        assert!(idx.files[scan as usize].equip.iter().any(|x| x.0 == eq && x.1 == LinkSrc::Content), "{:?}", l.get(scan));
        assert!(l.get(scan).unwrap().content_equip[0].1.contains("National Board"));
        // Rev 3 lives in a project folder: stranded away from 5610.15.
        assert!(l.stranded.get(&eq).map(|v| v.contains(&rev3)).unwrap_or(false), "{:?}", l.stranded);
        // Rev 2 (in the equipment folder) is superseded by Rev 3 (stated in the drawings).
        assert_eq!(l.get(rev2).unwrap().newer, Some(rev3));
        assert!(l.get(rev2).unwrap().newer_why.as_ref().unwrap().contains("Rev 3"));
        // The dropped copy is a copy of Rev 2 — home is the equipment folder — and also superseded.
        let cp = l.get(copy2).unwrap();
        assert_eq!(cp.home, Some(rev2));
        assert_eq!(cp.newer, Some(rev3));
        assert!(l.get(rev3).unwrap().newer.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
