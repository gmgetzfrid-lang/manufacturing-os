//! Text rules shared by the index builder and the search engine.
//!
//! Words are stemmed with TracePoint's explicit list (validated against real
//! THOR queries) plus a light plural rule. Identifiers are read the way people
//! write them: "V-02", "v2" and "V 2" are one tag; "5610.15" and "5610_15" are
//! one equipment number; "crude_crude-028-2" carries circuit CRUDE-28 sub 2.

use std::collections::HashSet;
use std::sync::LazyLock;

pub static STOPS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    "a an the and or of on in for to from with show me all everything ever has had have been was were is are it its this that documents document records record file files find please any at by about do did does you can get related my our before after since between through than latest recent current year years"
        .split(' ')
        .collect()
});

/// TracePoint's explicit stems, then a light plural rule for everything else.
pub fn stem(t: &str) -> String {
    let s = match t {
        "inspections" | "inspection" | "inspect" | "inspected" | "insp" => "inspection",
        "drawings" | "drawing" | "dwg" | "dwgs" | "drw" => "drawing",
        "valves" | "valve" => "valve",
        "regulators" | "regulator" => "regulator",
        "replaced" | "replacing" | "replacement" | "replace" | "replacements" => "replace",
        "repairs" | "repaired" | "repair" => "repair",
        "externals" | "ext" | "external" | "exterior" => "external",
        "internals" | "int" | "internal" | "interior" => "internal",
        "procedures" | "procedure" | "sop" | "sops" => "procedure",
        "manuals" | "manual" => "manual",
        "calculations" | "calculation" | "calc" | "calcs" => "calculation",
        "photos" | "pictures" | "picture" | "photo" | "images" | "image" | "pics" | "pic" => "photo",
        "controls" | "control" => "control",
        "burners" | "burner" => "burner",
        "datasheet" | "datasheets" => "datasheet",
        "checklists" | "checklist" => "checklist",
        "reports" | "report" => "report",
        "surveys" | "survey" => "survey",
        "exchangers" | "exchanger" | "hx" => "exchanger",
        "vessels" | "vessel" | "vsl" => "vessel",
        "tanks" | "tank" => "tank",
        "pumps" | "pump" => "pump",
        "towers" | "tower" | "column" | "columns" => "tower",
        "heaters" | "heater" | "furnace" | "furnaces" => "heater",
        "circuits" | "circuit" => "circuit",
        "isos" | "iso" | "isometric" | "isometrics" => "iso",
        "templates" | "template" => "template",
        "certs" | "cert" | "certificate" | "certificates" => "certificate",
        "emails" | "email" | "msg" => "email",
        _ => {
            let n = t.chars().count();
            if n > 4 && t.ends_with("ies") {
                return format!("{}y", &t[..t.len() - 3]);
            }
            if n > 4 && t.ends_with('s') && !t.ends_with("ss") && !t.ends_with("us") && !t.ends_with("is") {
                return t[..t.len() - 1].to_string();
            }
            t
        }
    };
    s.to_string()
}

/// Lowercased alphanumeric runs. "P&ID" and "PID" become "pid"; "on stream"
/// and "OSI" add "onstream" (TracePoint rule).
pub fn raw_words(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        if ch.is_alphanumeric() {
            cur.extend(ch.to_lowercase());
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

pub fn word_tokens(s: &str) -> Vec<String> {
    let lower = s.to_lowercase();
    let mut out: Vec<String> = raw_words(s).iter().map(|w| stem(w)).collect();
    let compact: String = lower.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.contains("p&id") {
        out.push("pid".into());
    }
    if lower.contains("on stream") || lower.contains("on-stream") || lower.contains("onstream") || out.iter().any(|w| w == "osi") {
        out.push("onstream".into());
        out.push("inspection".into());
    }
    // Split glued letter/digit words so "sht06" also yields "sht" (sheet cue).
    let mut extra = Vec::new();
    for w in &out {
        let lead: String = w.chars().take_while(|c| c.is_alphabetic()).collect();
        if lead.len() >= 2 && lead.len() < w.len() && w[lead.len()..].chars().all(|c| c.is_ascii_digit()) {
            extra.push(stem(&lead));
        }
    }
    out.extend(extra);
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IdKind {
    /// 5610.15 — a THOR equipment number.
    Equip,
    /// V-2, PSV-601B, CRUDE-028-2, TK-1100 — a tag or circuit.
    Tag,
    /// 2515-060 — a unit-prefixed number (often a piping circuit).
    Numbered,
}

#[derive(Clone, Debug)]
pub struct IdTok {
    pub kind: IdKind,
    /// Canonical comparison key: "5610.15", "v2", "crude28-2", "n2515-60".
    pub key: String,
    /// Parent key without a sub-circuit: "crude28" for "crude28-2".
    pub parent: Option<String>,
    pub raw: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum SegK {
    Alpha,
    Digit,
}

#[derive(Debug)]
struct Seg {
    k: SegK,
    s: String,
    start: usize,
    end: usize,
}

fn segments(s: &str) -> Vec<Seg> {
    let mut out: Vec<Seg> = Vec::new();
    for (i, ch) in s.char_indices() {
        let k = if ch.is_ascii_digit() {
            Some(SegK::Digit)
        } else if ch.is_alphabetic() {
            Some(SegK::Alpha)
        } else {
            None
        };
        match k {
            Some(k) => {
                if let Some(last) = out.last_mut() {
                    if last.k == k && last.end == i {
                        last.s.push(ch);
                        last.end = i + ch.len_utf8();
                        continue;
                    }
                }
                out.push(Seg { k, s: ch.to_string(), start: i, end: i + ch.len_utf8() });
            }
            None => {}
        }
    }
    out
}

fn trim_zeros(d: &str) -> String {
    let t = d.trim_start_matches('0');
    if t.is_empty() { "0".into() } else { t.into() }
}

/// Plumbing words that look like tags but are not: REV 2, SHT 3, PG 4, NO 5.
const NOT_TAGS: &[&str] = &["rev", "r", "sht", "sh", "sheet", "pg", "page", "no", "of", "dwg", "doc", "ver", "version", "api", "asme", "afe", "moc", "con", "sn", "icn", "sds", "tr", "q"];

/// Find equipment numbers, tags and unit-prefixed numbers in free text.
pub fn scan_ids(s: &str) -> Vec<IdTok> {
    let segs = segments(s);
    let bytes = s.as_bytes();
    let gap = |a: &Seg, b: &Seg| -> Option<char> {
        if a.end == b.start {
            return Some('\0');
        }
        if b.start == a.end + 1 {
            let c = bytes[a.end] as char;
            if c == '-' || c == '_' || c == ' ' || c == '.' {
                return Some(c);
            }
        }
        None
    };
    let mut out = Vec::new();
    let mut i = 0;
    while i < segs.len() {
        let a = &segs[i];
        // Equipment number: 4 digits '.'|'_' 1-4 digits [letter]
        if a.k == SegK::Digit && a.s.len() == 4 && i + 1 < segs.len() {
            let b = &segs[i + 1];
            let g = gap(a, b);
            if b.k == SegK::Digit && (g == Some('.') || g == Some('_')) && b.s.len() <= 4 {
                // A date like 2022_0414 is not an equipment number.
                let looks_date = (a.s.starts_with("19") || a.s.starts_with("20")) && b.s.len() == 4 && g == Some('_');
                if !looks_date {
                    let mut key = format!("{}.{}", a.s, b.s);
                    let mut end = b.end;
                    if i + 2 < segs.len() {
                        let c = &segs[i + 2];
                        if c.k == SegK::Alpha && c.s.len() == 1 && c.start == b.end {
                            let after_ok = i + 3 >= segs.len() || segs[i + 3].start > c.end;
                            if after_ok {
                                key.push_str(&c.s.to_lowercase());
                                end = c.end;
                            }
                        }
                    }
                    let parent = if key.len() > 4 + 1 + b.s.len() { Some(format!("{}.{}", a.s, b.s)) } else { None };
                    out.push(IdTok { kind: IdKind::Equip, key, parent, raw: s[a.start..end].to_string(), start: a.start, end });
                    i += 2;
                    continue;
                }
            }
            // Unit-prefixed number: 4 digits '-' 2-4 digits (2515-060). Not a date.
            if b.k == SegK::Digit && g == Some('-') && (2..=4).contains(&b.s.len()) {
                let is_year = (a.s.starts_with("19") || a.s.starts_with("20")) && b.s.len() == 4 || (a.s.starts_with("20") && b.s.len() == 2);
                if !is_year {
                    let key = format!("n{}-{}", a.s, trim_zeros(&b.s));
                    out.push(IdTok { kind: IdKind::Numbered, key, parent: None, raw: s[a.start..b.end].to_string(), start: a.start, end: b.end });
                    i += 2;
                    continue;
                }
            }
        }
        // Tag: 1-6 letters [sep] 1-5 digits [letter] [-sub]
        if a.k == SegK::Alpha && a.s.len() <= 6 && i + 1 < segs.len() {
            let before_ok = a.start == 0 || !s[..a.start].chars().last().map(|c| c.is_alphanumeric()).unwrap_or(false);
            let b = &segs[i + 1];
            let g = gap(a, b);
            let letters = a.s.to_lowercase();
            if before_ok && b.k == SegK::Digit && b.s.len() <= 5 && matches!(g, Some('\0') | Some('-') | Some('_') | Some(' '))
                && !NOT_TAGS.contains(&letters.as_str())
            {
                // "word 12" with a space is only a tag for short all-caps prefixes (V 2, PSV 601).
                let spaced_ok = g != Some(' ') || (a.s.len() <= 4 && a.s.chars().all(|c| c.is_uppercase()));
                if spaced_ok {
                    let mut key = format!("{}{}", letters, trim_zeros(&b.s));
                    let mut end = b.end;
                    let mut j = i + 2;
                    if j < segs.len() {
                        let c = &segs[j];
                        if c.k == SegK::Alpha && c.s.len() == 1 && c.start == b.end {
                            let after = j + 1 >= segs.len() || segs[j + 1].start > c.end || segs[j + 1].k == SegK::Digit && gap(c, &segs[j + 1]) == Some('-');
                            if after {
                                key.push_str(&c.s.to_lowercase());
                                end = c.end;
                                j += 1;
                            }
                        }
                    }
                    let base = key.clone();
                    let mut parent = None;
                    if j < segs.len() {
                        let d = &segs[j];
                        let prev_end = end;
                        if d.k == SegK::Digit && d.s.len() <= 2 && d.start == prev_end + 1 && bytes[prev_end] == b'-' {
                            let after_ok = j + 1 >= segs.len() || segs[j + 1].start > d.end + 1 || !segs[j + 1].s.chars().all(|c| c.is_ascii_digit());
                            if after_ok {
                                key = format!("{}-{}", base, trim_zeros(&d.s));
                                parent = Some(base.clone());
                                end = d.end;
                                j += 1;
                            }
                        }
                    }
                    let after_ok = end == s.len() || !s[end..].chars().next().map(|c| c.is_alphanumeric()).unwrap_or(false);
                    if after_ok {
                        out.push(IdTok { kind: IdKind::Tag, key, parent, raw: s[a.start..end].to_string(), start: a.start, end });
                        i = j;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    out
}

/// Canonical form of any label: uppercase alphanumerics only ("U1-A" -> "U1A").
pub fn canonical(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_uppercase()).collect()
}

/// A year 1950..=2039 read from text, preferring full dates.
pub fn find_year(s: &str) -> Option<i32> {
    static FULL: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?:^|[^0-9])((?:19[5-9]|20[0-3])[0-9])[-_. ]?(0[1-9]|1[0-2])(?:[-_. ]?([0-2][0-9]|3[01]))?(?:[^0-9]|$)").unwrap()
    });
    static US: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?:^|[^0-9])(0[1-9]|1[0-2])[-_. ]([0-2][0-9]|3[01])[-_. ]((?:19|20)?[0-9]{2})(?:[^0-9]|$)").unwrap()
    });
    static PACKED6: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?:^|[_ -])(0[1-9]|1[0-2])([0-2][0-9]|3[01])([0-9]{2})(?:[_ .-]|$)").unwrap()
    });
    static BARE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?:^|[^0-9.])((?:19[5-9]|20[0-3])[0-9])(?:[^0-9.]|$)").unwrap());
    let two = |y: &str| -> i32 {
        let v: i32 = y.parse().unwrap_or(0);
        if y.len() == 4 { v } else if v <= 39 { 2000 + v } else { 1900 + v }
    };
    if let Some(c) = FULL.captures(s) {
        return c[1].parse().ok();
    }
    if let Some(c) = US.captures(s) {
        return Some(two(&c[3]));
    }
    if let Some(c) = PACKED6.captures(s) {
        return Some(two(&c[3]));
    }
    if let Some(c) = BARE.captures(s) {
        return c[1].parse().ok();
    }
    None
}

/// Levenshtein distance with an early exit above `max`.
pub fn edit_distance(a: &str, b: &str, max: usize) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > max {
        return max + 1;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        let mut row_min = cur[0];
        for j in 1..=b.len() {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
            row_min = row_min.min(cur[j]);
        }
        if row_min > max {
            return max + 1;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// Allowed typos by word length (from the web finder): <5: 0, 5-6: 1, 7+: 2.
pub fn typo_budget(len: usize) -> usize {
    if len < 5 { 0 } else if len < 7 { 1 } else { 2 }
}

/// "*" wildcard match, case-insensitive (TracePoint StarMatch.Full).
pub fn star_match(text: &str, pattern: &str) -> bool {
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let (mut i, mut j, mut star, mut mark) = (0usize, 0usize, usize::MAX, 0usize);
    while i < t.len() {
        if j < p.len() && p[j] != '*' && t[i] == p[j] {
            i += 1;
            j += 1;
        } else if j < p.len() && p[j] == '*' {
            star = j;
            j += 1;
            mark = i;
        } else if star != usize::MAX {
            j = star + 1;
            mark += 1;
            i = mark;
        } else {
            return false;
        }
    }
    while j < p.len() && p[j] == '*' {
        j += 1;
    }
    j == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(s: &str) -> Vec<String> {
        scan_ids(s).into_iter().map(|t| t.key).collect()
    }

    #[test]
    fn identifiers() {
        assert_eq!(keys("5610.15 V-2-Inspection Drawing.pdf"), vec!["5610.15", "v2"]);
        assert_eq!(keys("kern-oil_v-02_field-notes_111412.pdf"), vec!["v2"]);
        assert_eq!(keys("crude_crude-028-2_report_020419.pdf"), vec!["crude28-2"]);
        assert_eq!(keys("2515-060 (DHT-060).pdf"), vec!["n2515-60", "dht60"]);
        assert_eq!(keys("PSV-601B test"), vec!["psv601b"]);
        assert_eq!(keys("4730.21B HEAT NUMBERS.PDF"), vec!["4730.21b"]);
        assert_eq!(keys("TK1100 drawing"), vec!["tk1100"]);
        assert_eq!(keys("2022-0414 - UT INSPECTION.pdf"), Vec::<String>::new());
        assert_eq!(keys("3002-D 1086_SHT06_R50_02-27-25.pdf"), Vec::<String>::new().into_iter().chain(["d1086".to_string()]).collect::<Vec<_>>());
        assert_eq!(keys("REFRMR-77 Ext. Check List"), vec!["refrmr77"]);
        assert_eq!(keys("Rev 2 Sht 3"), Vec::<String>::new());
        assert_eq!(keys("5510.06-V02_R_0.pdf"), vec!["5510.06", "v2"]);
    }

    #[test]
    fn years() {
        assert_eq!(find_year("56_5610.15_report_022218.pdf"), Some(2018));
        assert_eq!(find_year("2018-02-22 EXT UT"), Some(2018));
        assert_eq!(find_year("BLANK_5610.15 V-2 Debutanizer Receiver_09-21-22.pdf"), Some(2022));
        assert_eq!(find_year("2022-0414 - UT INSPECTION.pdf"), Some(2022));
        assert_eq!(find_year("5610.15 DRAWING.pdf"), None);
        assert_eq!(find_year("TK-1100"), None);
    }

    #[test]
    fn stars_and_typos() {
        assert!(star_match("inspection", "insp*"));
        assert!(star_match("5610.15", "5610.*"));
        assert!(!star_match("5611.15", "5610.*"));
        assert_eq!(edit_distance("inspction", "inspection", 2), 1);
        assert!(edit_distance("valve", "drawing", 2) > 2);
    }

    #[test]
    fn words() {
        let w = word_tokens("P&ID OSI Ext. Inspections SHT06");
        assert!(w.contains(&"pid".to_string()));
        assert!(w.contains(&"onstream".to_string()));
        assert!(w.contains(&"external".to_string()));
        assert!(w.contains(&"inspection".to_string()));
        assert!(w.contains(&"sht".to_string()));
    }
}
