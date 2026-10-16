//! A file's fingerprint card: everything in and about a document that can
//! tie it to equipment, to other copies and to other revisions — built once
//! when the file is read (THOR is only read), stored with the file's text in
//! its permission group, and linked on each PC (see `link`).
//!
//! Where an identifier appears matters: an equipment number in the title
//! block or page-1 header says what the document *is*; the same number deep
//! in a table may only be a reference. Weights reflect that.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;

/// Document properties from the file itself (PDF info, Office core.xml).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct DocMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Program that made it ("RICOH IM C3000", "Microsoft Word").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub producer: Option<String>,
    /// yyyymmdd
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<i32>,
    /// Office's own save counter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub office_revision: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_saved_by: Option<String>,
}

/// One identifier seen in the document.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Seen {
    /// "equip", "tag", "numbered", "drawing", "pid", "afe", "moc", "po",
    /// "wo", "nb" (National Board), "serial".
    pub k: String,
    /// Comparison key (as `text::scan_ids` keys, or upper-case for others).
    pub v: String,
    /// Summed position weight: title/header 4, rest of page 1 2, later 1.
    pub w: f32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Card {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// Text fingerprint (64-bit SimHash of word 3-grams); near-identical
    /// text — the same document scanned and native, or a minor revision —
    /// differs in few bits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub simhash: Option<u64>,
    pub meta: DocMeta,
    pub ids: Vec<Seen>,
    /// Highest revision stated in the document, and its rank.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rev_rank: Option<i32>,
    /// Latest plausible date written in the document (yyyymmdd).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_date: Option<i32>,
    /// Made by a scanner / copier (or every page needed OCR).
    pub scanned: bool,
    pub chars: u32,
}

static RE_NB: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:national\s+board|nat'?l\.?\s*b(?:oar)?d\.?|n\.?\s?b\.?)\s*(?:no\.?|number|#|reg(?:istration)?\.?(?:\s*no\.?)?)?\s*[:#]?\s*(\d{3,8})\b").unwrap());
static RE_SERIAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:mfr'?s?\.?\s*)?(?:serial|ser\.?|s/n)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/]{2,19})\b").unwrap());
static RE_MOC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bMOC\s*(?:no\.?|#)?\s*[-:#]?\s*(\d{2,6}(?:-\d{1,4})?)\b").unwrap());
static RE_PO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:P\.?\s?O\.?|purchase\s+order)\s*(?:no\.?|number|#)?\s*[:#]?\s*(\d{5,10})\b").unwrap());
static RE_WO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:W\.?\s?O\.?|work\s+order)\s*(?:no\.?|number|#)?\s*[:#]?\s*(\d{5,10})\b").unwrap());
/// "REV 3", "Rev. B", "Revision: 2", "REV NO. 4", "Version 3"
static RE_REV: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:rev(?:ision)?|ver(?:sion)?)\.?\s*(?:no\.?|number|level|#)?\s*[:#]?\s*([0-9]{1,3}|[A-Z]{1,2})\b").unwrap());
static RE_DATE_NUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})\b|\b(\d{4})-(\d{2})-(\d{2})\b").unwrap());
static RE_DATE_TXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b|\b(\d{1,2})[\s\-](jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[\s\-](\d{2,4})\b").unwrap()
});
const SCANNERS: &[&str] = &["ricoh", "canon", "xerox", "konica", "minolta", "kyocera", "sharp", "toshiba e-studio", "lexmark", "brother", "epson", "fujitsu", "scansnap", "kofax", "paperport", "scansoft", "hp digital sending", "hp scan", "imagerunner", "ir-adv", "bizhub", "workcentre", "scanner", "twain", "abbyy"];

fn month(m: &str) -> Option<i32> {
    let m = m.to_ascii_lowercase();
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].iter().position(|x| m.starts_with(x)).map(|i| i as i32 + 1)
}

fn ymd(y: i32, m: i32, d: i32) -> Option<i32> {
    let y = if y < 100 { if y > 50 { 1900 + y } else { 2000 + y } } else { y };
    let max_y = crate::nl::now_year() + 1;
    ((1950..=max_y).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d)).then_some(y * 10000 + m * 100 + d)
}

/// Dates written in text, as yyyymmdd (US month/day order first).
pub fn dates(text: &str) -> Vec<i32> {
    let mut out = Vec::new();
    for c in RE_DATE_NUM.captures_iter(text) {
        if let (Some(y), Some(m), Some(d)) = (c.get(4), c.get(5), c.get(6)) {
            out.extend(ymd(y.as_str().parse().unwrap_or(0), m.as_str().parse().unwrap_or(0), d.as_str().parse().unwrap_or(0)));
        } else {
            let a: i32 = c[1].parse().unwrap_or(0);
            let b: i32 = c[2].parse().unwrap_or(0);
            let y: i32 = c[3].parse().unwrap_or(0);
            out.extend(ymd(y, a, b).or_else(|| ymd(y, b, a)));
        }
    }
    for c in RE_DATE_TXT.captures_iter(text) {
        if let (Some(m), Some(d), Some(y)) = (c.get(1), c.get(2), c.get(3)) {
            out.extend(month(m.as_str()).and_then(|m| ymd(y.as_str().parse().unwrap_or(0), m, d.as_str().parse().unwrap_or(0))));
        } else if let (Some(d), Some(m), Some(y)) = (c.get(4), c.get(5), c.get(6)) {
            out.extend(month(m.as_str()).and_then(|m| ymd(y.as_str().parse().unwrap_or(0), m, d.as_str().parse().unwrap_or(0))));
        }
    }
    out
}

/// Order of revision marks: letters (A, B… — review issues) come before
/// numbers (0, 1, 2… — issued); within each, by value. None if not a rev.
pub fn rev_rank(raw: &str) -> Option<i32> {
    let r = raw.trim().trim_start_matches(|c: char| c == '-' || c == '_' || c == '.').to_ascii_uppercase();
    let r = r.trim_start_matches("REVISION").trim_start_matches("REV").trim_start_matches("VERSION").trim_start_matches("VER").trim_start_matches('V');
    let r = r.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    if r.is_empty() || r.len() > 3 {
        return None;
    }
    if let Ok(n) = r.parse::<i32>() {
        return (n < 200).then_some(1000 + n);
    }
    if r.chars().all(|c| c.is_ascii_uppercase()) {
        // A..Z, then AA..ZZ.
        let v = r.bytes().fold(0i32, |acc, b| acc * 26 + (b - b'A' + 1) as i32);
        return (v <= 702).then_some(v);
    }
    None
}

fn simhash(text: &str) -> Option<u64> {
    let words: Vec<String> = text.split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() >= 2).map(|w| w.to_lowercase()).collect();
    if words.len() < 30 {
        return None;
    }
    let mut v = [0i32; 64];
    for g in words.windows(3) {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        g.hash(&mut h);
        let x = h.finish();
        for (i, slot) in v.iter_mut().enumerate() {
            *slot += if x >> i & 1 == 1 { 1 } else { -1 };
        }
    }
    Some(v.iter().enumerate().fold(0u64, |acc, (i, s)| if *s > 0 { acc | 1 << i } else { acc }))
}

/// SHA-256 of a file's bytes (exact-copy fingerprint).
pub fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Build a file's card from its extracted text (and its bytes' hash).
pub fn build(sha: Option<String>, x: &crate::content::Extracted) -> Card {
    let mut c = Card { sha256: sha, meta: x.meta.clone(), ..Default::default() };
    let prog = format!("{} {}", c.meta.creator.as_deref().unwrap_or(""), c.meta.producer.as_deref().unwrap_or("")).to_lowercase();
    c.scanned = SCANNERS.iter().any(|s| prog.contains(s)) || (x.ocr_pages > 0 && x.ocr_pages as usize >= x.pages.len().max(1));
    let mut seen: HashMap<(String, String), f32> = HashMap::new();
    let mut add = |k: &str, v: String, w: f32| {
        *seen.entry((k.to_string(), v)).or_default() += w;
    };
    let mut all = String::new();
    let mut revs: Vec<(i32, String, f32)> = Vec::new();
    let mut dts: Vec<i32> = Vec::new();
    for p in &x.pages {
        let t = &p.text;
        all.push_str(t);
        all.push('\n');
        // Position weight: the title block / header of page 1 says what the
        // document is. Drawings put the title block at the end of page 1's
        // text, so both ends of page 1 count as "header".
        let (head, tail, rest): (&str, &str, &str) = if p.page == 1 {
            let n = t.len();
            let a = floor_char(t, 1500.min(n));
            let b = floor_char(t, n.saturating_sub(1200).max(a));
            (&t[..a], &t[b..], &t[a..b])
        } else {
            ("", "", t.as_str())
        };
        for (part, w) in [(head, 4.0f32), (tail, 4.0), (rest, if p.page == 1 { 2.0 } else { 1.0 })] {
            if part.is_empty() {
                continue;
            }
            let w = if p.page > 3 { w * 0.5 } else { w };
            for tok in crate::text::scan_ids(part) {
                let k = match tok.kind {
                    crate::text::IdKind::Equip => "equip",
                    crate::text::IdKind::Tag => "tag",
                    crate::text::IdKind::Numbered => "numbered",
                };
                add(k, tok.key, w);
            }
            for (typ, val, _raw) in crate::crawl::identifiers(part) {
                match typ {
                    "drawing_ke" => add("drawing", val, w),
                    "pid_family" => add("pid", val, w),
                    "afe" => add("afe", val, w),
                    _ => {}
                }
            }
            for cap in RE_NB.captures_iter(part) {
                add("nb", cap[1].to_string(), w * 2.0);
            }
            for cap in RE_SERIAL.captures_iter(part) {
                let v = cap[1].to_uppercase();
                if v.chars().any(|c| c.is_ascii_digit()) {
                    add("serial", v, w);
                }
            }
            for (re, k) in [(&*RE_MOC, "moc"), (&*RE_PO, "po"), (&*RE_WO, "wo")] {
                for cap in re.captures_iter(part) {
                    add(k, cap[1].to_uppercase(), w);
                }
            }
            for cap in RE_REV.captures_iter(part) {
                if let Some(r) = rev_rank(&cap[1]) {
                    revs.push((r, cap[1].to_uppercase(), w));
                }
            }
            if p.page <= 2 {
                dts.extend(dates(part));
            }
        }
    }
    c.chars = all.len().min(u32::MAX as usize) as u32;
    c.simhash = simhash(&all);
    // The revision stated where it counts: the highest one in the title
    // block / revision table area if any, else anywhere on page 1-3.
    let best_w = revs.iter().map(|r| r.2).fold(0.0f32, f32::max);
    if let Some(r) = revs.iter().filter(|r| r.2 >= best_w.min(4.0)).max_by_key(|r| r.0) {
        c.rev_rank = Some(r.0);
        c.rev = Some(r.1.clone());
    }
    let today = {
        let y = crate::nl::now_year();
        y * 10000 + 1231
    };
    c.doc_date = dts.into_iter().filter(|d| *d <= today).max();
    let mut ids: Vec<Seen> = seen.into_iter().map(|((k, v), w)| Seen { k, v, w }).collect();
    ids.sort_by(|a, b| b.w.partial_cmp(&a.w).unwrap_or(std::cmp::Ordering::Equal).then(a.v.cmp(&b.v)));
    ids.truncate(60);
    c.ids = ids;
    c
}

fn floor_char(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// PDF dates: "D:20190514093000-05'00'".
pub fn pdf_date(s: &str) -> Option<i32> {
    let d: String = s.trim_start_matches("D:").chars().take(8).collect();
    if d.len() == 8 && d.chars().all(|c| c.is_ascii_digit()) {
        let n: i32 = d.parse().ok()?;
        ymd(n / 10000, n / 100 % 100, n % 100)
    } else {
        None
    }
}

/// Office docProps/core.xml.
pub fn office_meta(core_xml: &str) -> DocMeta {
    let get = |tag: &str| -> Option<String> {
        let open = format!("<{tag}");
        let i = core_xml.find(&open)?;
        let start = core_xml[i..].find('>')? + i + 1;
        let end = core_xml[start..].find(&format!("</{tag}>"))? + start;
        let v = core_xml[start..end].trim();
        (!v.is_empty()).then(|| v.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
    };
    let date = |tag: &str| get(tag).and_then(|v| {
        let d: String = v.chars().filter(|c| c.is_ascii_digit()).take(8).collect();
        d.parse::<i32>().ok().and_then(|n| ymd(n / 10000, n / 100 % 100, n % 100))
    });
    DocMeta {
        title: get("dc:title"),
        author: get("dc:creator"),
        last_saved_by: get("cp:lastModifiedBy"),
        office_revision: get("cp:revision").and_then(|v| v.parse().ok()),
        created: date("dcterms:created"),
        modified: date("dcterms:modified"),
        ..Default::default()
    }
}

/// Stored form (compact JSON).
pub fn to_json(c: &Card) -> String {
    serde_json::to_string(c).unwrap_or_default()
}

pub fn from_json(s: &str) -> Option<Card> {
    serde_json::from_str(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::{Extracted, PageText};

    fn ex(pages: &[&str]) -> Extracted {
        Extracted { pages: pages.iter().enumerate().map(|(i, t)| PageText { page: i as u32 + 1, text: t.to_string(), method: "text" }).collect(), page_count: pages.len() as u32, ..Default::default() }
    }

    #[test]
    fn nameplate_scan_is_pinned() {
        let x = ex(&["FORM U-1A MANUFACTURER'S DATA REPORT FOR PRESSURE VESSELS\nManufactured by Acme Tank\nMfr Serial No. 88-1047  National Board No. 33127  Year built 1987\nVessel V-2 Debutanizer Receiver 5610.15\nMAWP 250 psi at 650 F\nDate 05/14/1987"]);
        let c = build(Some(sha256(b"bytes")), &x);
        assert!(c.ids.iter().any(|s| s.k == "nb" && s.v == "33127" && s.w >= 8.0), "{:?}", c.ids);
        assert!(c.ids.iter().any(|s| s.k == "serial" && s.v == "88-1047"));
        assert!(c.ids.iter().any(|s| s.k == "equip" && s.v == "5610.15"));
        assert_eq!(c.doc_date, Some(19870514));
        assert!(c.sha256.is_some());
    }

    #[test]
    fn revisions_rank_issued_over_review() {
        assert!(rev_rank("A").unwrap() < rev_rank("B").unwrap());
        assert!(rev_rank("C").unwrap() < rev_rank("0").unwrap(), "issued (0) after review letters");
        assert!(rev_rank("2").unwrap() < rev_rank("10").unwrap());
        assert_eq!(rev_rank("REV-3"), rev_rank("3"));
        assert_eq!(rev_rank("hello"), None);
        let x = ex(&["P&ID CRUDE UNIT\nREV DATE DESCRIPTION\n2 01/04/2019 ISSUED FOR CONSTRUCTION\n3 06/22/2021 AS BUILT\nREV 3"]);
        let c = build(None, &x);
        assert_eq!(c.rev.as_deref(), Some("3"));
        assert_eq!(c.doc_date, Some(20210622));
    }

    #[test]
    fn simhash_near_duplicates() {
        let base = "the ultrasonic thickness survey of the receiver shell found minimum readings at nozzle n3 below the retirement thickness and the inspector recommends repair before the next run with follow up readings at the bottom head and the inlet nozzle area recorded on the attached grid drawing for the vessel";
        let a = simhash(base).unwrap();
        let b = simhash(&base.replace("recommends", "recommended")).unwrap();
        let c = simhash("completely different text about pump seal flush plans and bearing housing oil levels that has nothing to do with vessels or thickness at all whatsoever in any way shape or form for the purpose of this test").unwrap();
        assert!((a ^ b).count_ones() <= 12, "{}", (a ^ b).count_ones());
        assert!((a ^ c).count_ones() > 18, "{}", (a ^ c).count_ones());
    }

    #[test]
    fn office_core_properties() {
        let m = office_meta(r#"<cp:coreProperties><dc:title>V-2 Inspection Plan</dc:title><dc:creator>jsmith</dc:creator><cp:lastModifiedBy>ggetzfrid</cp:lastModifiedBy><cp:revision>14</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2019-03-02T10:00:00Z</dcterms:created></cp:coreProperties>"#);
        assert_eq!(m.title.as_deref(), Some("V-2 Inspection Plan"));
        assert_eq!(m.office_revision, Some(14));
        assert_eq!(m.created, Some(20190302));
        assert_eq!(pdf_date("D:20210622093000-05'00'"), Some(20210622));
    }
}
