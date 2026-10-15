//! Natural-language search: "talk to it like a person".
//!
//! "the report from when they did thickness readings on the debutanizer
//! receiver up in the LRU a couple years ago" becomes: equipment 5610.15
//! (found from its description and unit), document type UT inspection, years
//! 2023–2025, newest first. Filler is ignored, plant-speak is translated into
//! THOR's document types, and files are ranked by best fit instead of
//! requiring every word. Every decision is shown back to the user as a chip.

use crate::classify::Category;
use crate::engine::{Ambiguity, Chip, Engine, Facet, Facets, SearchRequest, SearchResponse};
use crate::index::*;
use crate::text::{self, IdKind};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// Words that carry no search meaning in a spoken request.
static FILLER: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    "i im i'm id need needs want wanted wanna looking look looked find found finding get getting got show showing give me my mine can could would should will you your please pls the a an of for on in at to with where wheres when which what whats that thats this these those they them their there theres we our us was were did do does done doing had has have having been be being is are it its it's about some any one ones thing things stuff document documents doc docs file files paper papers paperwork record records info information anything everything something all out up down over by around back while like kind sort maybe think thought guess remember recall believe just also again still really pretty guy guys someone somebody contractor company so and or but if then than into onto during until through unit units area plant refinery kern oil thor drive folder folders hey hi hello thanks thank tell know who whom whose why how many much more most here dont don't not no yes ok okay copy version"
        .split(' ')
        .collect()
});

/// A plant-speak concept: what people say → what THOR files are.
#[derive(Debug)]
pub struct Concept {
    pub id: &'static str,
    pub label: &'static str,
    pub phrases: &'static [&'static str],
    pub category: Option<Category>,
    pub doctypes: &'static [&'static str],
    /// File words (stemmed) that signal this concept.
    pub terms: &'static [&'static str],
}

pub static CONCEPTS: &[Concept] = &[
    Concept { id: "ut", label: "UT / thickness readings", phrases: &["thickness readings", "thickness reading", "thickness survey", "wall thickness", "wall loss", "ultrasonic", "ut survey", "ut readings", "thickness", "readings", "ut", "ultrapipe", "cml", "cmls", "corrosion rate", "corrosion rates"], category: Some(Category::Inspection), doctypes: &["UT Inspection", "Field Data", "Inspection Drawing"], terms: &["ut", "thickness", "ultrapipe", "survey", "field", "data", "cml", "technique"] },
    Concept { id: "external", label: "External inspection", phrases: &["external", "outside", "ext", "exterior"], category: Some(Category::Inspection), doctypes: &["External Inspection", "Visual Inspection"], terms: &["external", "ext", "visual"] },
    Concept { id: "internal", label: "Internal inspection", phrases: &["internal", "inside", "entry", "int", "interior", "opened up"], category: Some(Category::Inspection), doctypes: &["Internal Inspection"], terms: &["internal", "int"] },
    Concept { id: "visual", label: "Visual / API inspection", phrases: &["visual", "api 510", "api 570", "api 653", "api-510", "api-570", "api-653", "walkdown", "walk down"], category: Some(Category::Inspection), doctypes: &["Visual Inspection"], terms: &["visual", "api", "510", "570", "653"] },
    Concept { id: "osi", label: "On-stream inspection", phrases: &["on stream", "onstream", "on-stream", "osi"], category: Some(Category::Inspection), doctypes: &["On-Stream Inspection"], terms: &["onstream", "osi"] },
    Concept { id: "inspection", label: "Inspection records", phrases: &["inspection", "inspections", "inspected", "checked", "check", "looked at", "examined", "survey", "surveyed", "assessment", "evaluation", "mi"], category: Some(Category::Inspection), doctypes: &[], terms: &["inspection", "survey", "report", "checklist"] },
    Concept { id: "report", label: "Report", phrases: &["report", "reports", "write up", "write-up", "writeup", "findings", "results", "summary"], category: None, doctypes: &["Inspection Report", "Report", "Service Report"], terms: &["report", "findings", "summary", "complete"] },
    Concept { id: "fieldnotes", label: "Field notes / field data", phrases: &["field notes", "field data", "field sheet", "notes", "handwritten"], category: Some(Category::Inspection), doctypes: &["Field Notes", "Field Data"], terms: &["field", "notes", "data"] },
    Concept { id: "checklist", label: "Checklist", phrases: &["checklist", "check list", "checklists"], category: Some(Category::Inspection), doctypes: &["Inspection Checklist"], terms: &["checklist", "check", "list"] },
    Concept { id: "photo", label: "Photos", phrases: &["photo", "photos", "picture", "pictures", "pic", "pics", "image", "images", "snapshot"], category: Some(Category::Photos), doctypes: &[], terms: &["photo"] },
    Concept { id: "drawing", label: "Drawings", phrases: &["drawing", "drawings", "print", "prints", "blueprint", "blueprints", "dwg", "sketch", "schematic", "general arrangement", "ga", "cad", "autocad"], category: Some(Category::Drawings), doctypes: &["Drawing", "CAD Drawing", "Inspection Drawing", "Drawing Image"], terms: &["drawing", "dwg", "sketch", "autocad"] },
    Concept { id: "iso", label: "Isometric drawings", phrases: &["iso", "isos", "isometric", "isometrics"], category: Some(Category::Drawings), doctypes: &["Drawing"], terms: &["iso", "isometric"] },
    Concept { id: "pid", label: "P&IDs", phrases: &["p&id", "p&ids", "pid", "pids", "p and id", "flow diagram", "process flow", "piping and instrumentation", "pfd"], category: Some(Category::Pid), doctypes: &["P&ID"], terms: &["pid", "circuitized"] },
    Concept { id: "datasheet", label: "Datasheets", phrases: &["datasheet", "data sheet", "datasheets", "data sheets", "spec", "specs", "specification", "specifications", "spec sheet"], category: Some(Category::Datasheets), doctypes: &["Datasheet"], terms: &["datasheet", "data", "spec"] },
    Concept { id: "code", label: "Code documents (U-1A, MDR, nameplate)", phrases: &["nameplate", "name plate", "u1a", "u-1a", "u 1a", "data report", "manufacturers data report", "mdr", "national board", "code stamp", "r1", "r-1", "r2", "r-2", "code documents", "asme"], category: Some(Category::CodeDocuments), doctypes: &["Code Document"], terms: &["u1a", "mdr", "nameplate", "code", "r1", "national", "board"] },
    Concept { id: "psv", label: "Relief valves / PSV service", phrases: &["relief valve", "relief valves", "safety valve", "safety valves", "psv", "psvs", "prv", "prvs", "pop test", "set pressure", "valve service", "relief"], category: Some(Category::ServiceReports), doctypes: &["Service Report"], terms: &["psv", "prv", "relief", "service", "pop"] },
    Concept { id: "calc", label: "Calculations", phrases: &["calc", "calcs", "calculation", "calculations", "mawp", "remaining life", "retirement", "retirement thickness", "fitness for service", "ffs", "t-min", "tmin", "minimum thickness"], category: Some(Category::Calculations), doctypes: &["Calculation"], terms: &["calculation", "mawp", "retirement", "remaining", "ffs", "tmin"] },
    Concept { id: "repair", label: "Repairs", phrases: &["repair", "repairs", "repaired", "fixed", "fix", "patched", "patch", "weld", "welded", "welding", "sleeve", "clamp", "replaced", "replacement", "leak", "leaking"], category: None, doctypes: &["Work Record"], terms: &["repair", "replace", "weld", "sleeve", "clamp", "leak", "patch"] },
    Concept { id: "certs", label: "Material certs / MTRs", phrases: &["mtr", "mtrs", "material cert", "material certs", "mill cert", "mill certs", "heat number", "heat numbers", "certificate", "certificates", "cert", "certs"], category: Some(Category::Certificates), doctypes: &["Certificate / MTR"], terms: &["mtr", "heat", "cert", "certificate", "material"] },
    Concept { id: "email", label: "Emails", phrases: &["email", "emails", "e-mail", "correspondence", "message", "messages"], category: Some(Category::Email), doctypes: &["Email"], terms: &["email", "msg", "fw", "re"] },
    Concept { id: "procedure", label: "Procedures & manuals", phrases: &["procedure", "procedures", "manual", "manuals", "instructions", "sop", "wps", "pqr", "o&m"], category: Some(Category::Procedures), doctypes: &["Procedure / Manual"], terms: &["procedure", "manual", "instruction", "wps", "pqr"] },
    Concept { id: "template", label: "Blank templates / forms", phrases: &["template", "templates", "blank", "blank form", "form", "forms"], category: None, doctypes: &[], terms: &["blank", "template", "form"] },
    Concept { id: "turnaround", label: "Turnaround work", phrases: &["turnaround", "turnarounds", "ta", "shutdown", "outage", "pit stop"], category: None, doctypes: &[], terms: &["turnaround", "ta", "shutdown", "pit"] },
    Concept { id: "ir", label: "IR / thermography", phrases: &["ir", "infrared", "thermography", "thermal", "hot spot", "hot spots", "ir scan"], category: Some(Category::Inspection), doctypes: &["IR Inspection"], terms: &["ir", "infrared", "thermography", "scan"] },
    Concept { id: "nde", label: "NDE (MT/PT/RT/PMI)", phrases: &["nde", "ndt", "mt", "pt", "rt", "pmi", "x-ray", "xray", "radiograph", "dye pen", "mag particle", "hardness"], category: Some(Category::Inspection), doctypes: &["NDE Record"], terms: &["nde", "evt", "pmi", "rt", "mt", "pt", "hardness"] },
    Concept { id: "cui", label: "CUI / insulation", phrases: &["cui", "corrosion under insulation", "insulation"], category: Some(Category::Inspection), doctypes: &[], terms: &["cui", "insulation"] },
    Concept { id: "hydro", label: "Hydrotest / pressure test", phrases: &["hydro", "hydrotest", "hydro test", "pressure test", "leak test"], category: None, doctypes: &[], terms: &["hydro", "hydrotest", "pressure", "test"] },
];

/// Equipment-type words people use; matched against equipment descriptions
/// and kinds (VESSELS, EXCHANGERS…).
static KIND_SYNONYMS: &[(&str, &[&str])] = &[
    ("drum", &["drum", "receiver", "accumulator", "pot", "vessel"]),
    ("receiver", &["receiver", "reciever", "drum", "accumulator"]),
    ("tower", &["tower", "column", "fractionator", "stripper", "splitter", "absorber", "stabilizer"]),
    ("column", &["column", "tower"]),
    ("vessel", &["vessel", "drum", "separator", "receiver", "tower"]),
    ("exchanger", &["exchanger", "cooler", "condenser", "reboiler", "heater", "bundle"]),
    ("hx", &["exchanger"]),
    ("cooler", &["cooler", "exchanger", "fin", "fan"]),
    ("heater", &["heater", "furnace", "reboiler"]),
    ("furnace", &["furnace", "heater"]),
    ("tank", &["tank"]),
    ("pump", &["pump"]),
    ("compressor", &["compressor", "comp"]),
    ("pipe", &["piping", "pipe", "line", "circuit"]),
    ("line", &["line", "piping", "circuit"]),
    ("piping", &["piping", "pipe", "line", "circuit"]),
    ("bottle", &["bottle", "pulsation"]),
    ("separator", &["separator", "knockout", "ko", "drum"]),
    ("ko", &["knockout", "ko", "separator"]),
    ("knockout", &["knockout", "ko"]),
    ("scrubber", &["scrubber"]),
    ("reactor", &["reactor"]),
    ("boiler", &["boiler"]),
    ("filter", &["filter", "strainer"]),
];

/// Plant shorthand. Each group means one thing; the first entry is the form
/// used for matching equipment descriptions ("FRAC OVHD ACCUM" reads as
/// fractionator overhead accumulator). File names are matched on every form.
pub static SHORTHAND: &[&[&str]] = &[
    &["fractionator", "frac", "fract"],
    &["prefractionator", "prefrac"],
    &["overhead", "ovhd", "ohd"],
    &["accumulator", "accum"],
    &["receiver", "rcvr", "recv", "reciever"],
    &["exchanger", "exch", "exchgr", "xchgr", "hx"],
    &["heater", "htr"],
    &["compressor", "comp", "cmp"],
    &["debutanizer", "debut", "debutaniser"],
    &["stabilizer", "stab", "stabiliser"],
    &["separator", "sep"],
    &["knockout", "ko"],
    &["bottoms", "btms", "btm"],
    &["regenerator", "regen"],
    &["condenser", "cond"],
    &["reboiler", "reb"],
    &["vacuum", "vac"],
    &["atmospheric", "atm"],
    &["header", "hdr"],
    &["transfer", "xfer"],
    &["discharge", "disch"],
    &["suction", "suct"],
    &["tower", "twr"],
    &["column", "col"],
];

fn shorthand_group(w: &str) -> Option<&'static [&'static str]> {
    SHORTHAND.iter().copied().find(|g| g.iter().any(|v| *v == w || text::stem(v) == w))
}

/// The matching form of a (stemmed) word: "frac" → "fractionator".
pub fn canonical_word(w: &str) -> String {
    shorthand_group(w).map(|g| text::stem(g[0])).unwrap_or_else(|| w.to_string())
}

/// Every form of a (stemmed) word, itself included.
pub fn word_variants(w: &str) -> Vec<String> {
    let mut v: Vec<String> = shorthand_group(w).map(|g| g.iter().map(|x| text::stem(x)).collect()).unwrap_or_default();
    if !v.iter().any(|x| x == w) {
        v.push(w.to_string());
    }
    v.dedup();
    v
}

/// Relief devices and piping circuits often carry the name of the equipment
/// they protect or connect ("PSV-001 FRACTIONATOR TOWER RELIEF"). They only
/// fit a description when the person asked for that kind of thing.
fn is_relief(eq: &crate::index::Equip) -> bool {
    let k = eq.kind.to_lowercase();
    k.contains("relief") || k.contains("psv") || eq.tags.iter().any(|t| {
        let t = t.to_uppercase();
        t.starts_with("PSV") || t.starts_with("PRV") || t.starts_with("RV-") || t.starts_with("TSV")
    })
}
pub fn is_relief_pub(eq: &crate::index::Equip) -> bool {
    is_relief(eq)
}
fn is_piping(eq: &crate::index::Equip) -> bool {
    let k = eq.kind.to_lowercase();
    k.contains("piping") || k.contains("circuit")
}

#[derive(Default, Debug, Clone)]
pub struct Understood {
    pub concepts: Vec<&'static Concept>,
    pub equipment: Vec<(u32, f32, Vec<String>)>,
    pub equipment_strong: bool,
    pub units: Vec<u16>,
    pub year_min: Option<i32>,
    pub year_max: Option<i32>,
    pub year_label: Option<String>,
    pub prefer_recent: bool,
    pub prefer_oldest: bool,
    /// "newest first", "by date": order the good matches by date.
    pub sort_newest: bool,
    pub sort_oldest: bool,
    /// Misspellings that were corrected: (typed, meant).
    pub corrections: Vec<(String, String)>,
    pub words: Vec<String>,
    pub ignored: Vec<String>,
    pub ids: Vec<text::IdTok>,
}

pub fn now_year() -> i32 {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    1970 + (secs / 31_556_952) as i32
}

/// Does this look like a spoken request rather than a TracePoint keyword
/// search? Short keyword queries keep TracePoint's exact rules.
pub fn is_natural(q: &str) -> bool {
    let lower = q.to_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();
    let filler = words.iter().filter(|w| FILLER.contains(w.trim_matches(|c: char| !c.is_alphanumeric()))).count();
    let questiony = lower.ends_with('?')
        || ["where ", "what ", "which ", "who ", "when ", "how ", "find ", "show ", "i need", "looking for", "can you", "do we have", "is there", "the one", "anything on", "anything about"]
            .iter()
            .any(|p| lower.starts_with(p) || lower.contains(&format!(" {p}")));
    questiony || words.len() >= 6 || (words.len() >= 4 && filler >= 2)
}

static RE_YEARS_AGO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(a couple(?: of)?|couple(?: of)?|a few|few|several|(\d{1,2})|one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\s+(ago|back)\b").unwrap());
static RE_DECADE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:the\s+)?(early|mid|late)?\s*(?:'|19|20)?(\d0)'?s\b").unwrap());
static RE_RANGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:between|from)\s+((?:19|20)\d{2})\s+(?:and|to|-|through)\s+((?:19|20)\d{2})\b|\b((?:19|20)\d{2})\s*(?:-|–|to)\s*((?:19|20)\d{2})\b").unwrap());
static RE_BEFORE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:before|prior to|older than|earlier than)\s+(?:the\s+)?((?:19|20)\d{2})\b").unwrap());
static RE_AFTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:after|since|newer than|later than|from)\s+(?:the\s+)?((?:19|20)\d{2})\b").unwrap());
static RE_SPOKEN_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(tank|tk|vessel|drum|pump|exchanger|exch|heater|furnace|compressor|psv|relief valve|safety valve)\s*(?:number|no\.?|#)?\s*(\d{1,5}[a-z]?)\b").unwrap());
/// Unit words that name a unit on their own in conversation.
static UNIT_WORDS: &[&str] = &["crude", "dht", "kht", "nht", "lru", "sru", "mtr", "platformer", "reformer", "transmix", "cogen", "amine", "sulferox", "treater", "rerun", "laboratory"];
/// Everyday names for groups of units.
static UNIT_ALIASES: &[(&str, &[&str])] = &[("sulfur", &["sru", "sulferox"]), ("sulphur", &["sru", "sulferox"]), ("lab", &["laboratory"]), ("tank farm", &["storage"]), ("tankfarm", &["storage"]), ("flare", &["flare"])];
static RE_YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[^0-9.])((?:19[5-9]|20[0-3])\d)(?:[^0-9.]|$)").unwrap());

fn word_number(s: &str) -> Option<i32> {
    match s.to_lowercase().as_str() {
        "one" => Some(1),
        "two" => Some(2),
        "three" => Some(3),
        "four" => Some(4),
        "five" => Some(5),
        "six" => Some(6),
        "seven" => Some(7),
        "eight" => Some(8),
        "nine" => Some(9),
        "ten" => Some(10),
        x => x.parse().ok(),
    }
}

impl Engine {
    /// Turn a spoken request into concepts, equipment, units and time.
    pub fn understand(&self, raw: &str) -> Understood {
        let mut u = Understood::default();
        let now = now_year();
        let mut q = format!(" {} ", raw.to_lowercase().replace('\u{2019}', "'"));

        // ── Time ────────────────────────────────────────────────────────
        if let Some(c) = RE_RANGE.captures(&q.clone()) {
            let a: i32 = c.get(1).or(c.get(3)).unwrap().as_str().parse().unwrap_or(0);
            let b: i32 = c.get(2).or(c.get(4)).unwrap().as_str().parse().unwrap_or(0);
            u.year_min = Some(a.min(b));
            u.year_max = Some(a.max(b));
            u.year_label = Some(format!("{}–{}", a.min(b), a.max(b)));
            q = q.replace(&c[0], " ");
        }
        if let Some(c) = RE_BEFORE.captures(&q.clone()) {
            let y: i32 = c[1].parse().unwrap_or(0);
            u.year_max = Some(y - 1);
            u.year_label = Some(format!("before {y}"));
            q = q.replace(&c[0], " ");
        }
        if let Some(c) = RE_AFTER.captures(&q.clone()) {
            let y: i32 = c[1].parse().unwrap_or(0);
            u.year_min = Some(if c[0].starts_with("after") { y + 1 } else { y });
            u.year_label = Some(format!("from {y}"));
            q = q.replace(&c[0], " ");
        }
        if let Some(c) = RE_YEARS_AGO.captures(&q.clone()) {
            let what = c[1].to_lowercase();
            let (lo, hi) = if what.contains("couple") {
                (1, 3)
            } else if what.contains("few") {
                (2, 5)
            } else if what.contains("several") {
                (3, 8)
            } else {
                let n = word_number(&what).unwrap_or(2);
                ((n - 1).max(0), n + 1)
            };
            u.year_min = Some(now - hi);
            u.year_max = Some(now - lo);
            u.year_label = Some(format!("{}–{} ({})", now - hi, now - lo, c[0].trim()));
            q = q.replace(&c[0], " ");
        }
        for (pat, lo, hi, label) in [
            ("last couple years", 0, 2, "last couple of years"),
            ("past couple years", 0, 2, "past couple of years"),
            ("last few years", 0, 4, "last few years"),
            ("past few years", 0, 4, "past few years"),
            ("last year", 1, 1, "last year"),
            ("this year", 0, 0, "this year"),
            ("past year", 0, 1, "past year"),
        ] {
            if q.contains(pat) {
                u.year_min = Some(now - hi);
                u.year_max = Some(now - lo);
                u.year_label = Some(label.to_string());
                q = q.replace(pat, " ");
            }
        }
        if let Some(c) = RE_DECADE.captures(&q.clone()) {
            let d: i32 = c[2].parse().unwrap_or(0);
            let base = if d >= 50 { 1900 + d } else { 2000 + d };
            let (lo, hi) = match c.get(1).map(|m| m.as_str().to_lowercase()) {
                Some(ref s) if s == "early" => (base, base + 3),
                Some(ref s) if s == "mid" => (base + 3, base + 6),
                Some(ref s) if s == "late" => (base + 6, base + 9),
                _ => (base, base + 9),
            };
            u.year_min = Some(lo);
            u.year_max = Some(hi);
            u.year_label = Some(format!("{lo}–{hi}"));
            q = q.replace(&c[0], " ");
        }
        if u.year_min.is_none() && u.year_max.is_none() {
            if let Some(c) = RE_YEAR.captures(&q.clone()) {
                let y: i32 = c[1].parse().unwrap_or(0);
                let unitish = q.contains(&format!("{} unit", &c[1])) || q.contains(&format!("unit {}", &c[1]));
                if !unitish {
                    u.year_min = Some(y);
                    u.year_max = Some(y);
                    u.year_label = Some(y.to_string());
                    q = q.replacen(&c[1], " ", 1);
                }
            }
        }
        for (pat, newest) in [
            ("newest first", true), ("latest first", true), ("most recent first", true), ("recent first", true), ("newest to oldest", true),
            ("newest on top", true), ("latest on top", true), ("sorted by date", true), ("sort by date", true), ("by date", true), ("in date order", true),
            ("newest at the top", true), ("oldest first", false), ("oldest to newest", false), ("earliest first", false), ("chronological", false),
            ("chronologically", false), ("in order", false),
        ] {
            let pat = format!(" {pat} ");
            if q.contains(&pat) {
                if newest {
                    u.sort_newest = true;
                    u.prefer_recent = true;
                } else {
                    u.sort_oldest = true;
                }
                q = q.replace(&pat, " ");
            }
        }
        for w in ["most recent", "latest", "newest", "recent", "recently", "current", "last time", "last one", "lately"] {
            let pat = format!(" {w} ");
            if q.contains(&pat) {
                u.prefer_recent = true;
                q = q.replace(&pat, " ");
            }
        }
        for w in ["oldest", "original", "first time", "first one", "earliest", "initial"] {
            let pat = format!(" {w} ");
            if q.contains(&pat) {
                u.prefer_oldest = true;
                q = q.replace(&pat, " ");
            }
        }

        // ── Spoken tags: "tank 1100" → TK-1100, "vessel 2" → V-2 ───────
        q = RE_SPOKEN_TAG
            .replace_all(&q, |c: &regex::Captures| {
                let prefix = match c[1].to_lowercase().as_str() {
                    "tank" | "tk" => "tk",
                    "vessel" | "drum" => "v",
                    "pump" => "p",
                    "exchanger" | "exch" => "e",
                    "heater" | "furnace" => "h",
                    "compressor" => "c",
                    "psv" | "relief valve" | "safety valve" => "psv",
                    "circuit" | "line" => "",
                    _ => "",
                };
                if prefix.is_empty() {
                    format!(" {} ", &c[2])
                } else {
                    format!(" {}-{} ", prefix, &c[2])
                }
            })
            .to_string();

        // ── Identifiers stay exact ─────────────────────────────────────
        let ids = text::scan_ids(&q);
        let mut idq = q.clone();
        for t in ids.iter().rev() {
            idq.replace_range(t.start..t.end, " ");
        }
        // "u1a", "r1", "api 510" look like tags but name document types here.
        let (doc_like, real): (Vec<text::IdTok>, Vec<text::IdTok>) =
            ids.into_iter().partition(|t| t.kind == IdKind::Tag && (t.key == "u1a" || t.key == "r1" || t.key == "r2" || t.key.starts_with("api")));
        u.ids = real;
        q = idq;
        for t in doc_like {
            q.push(' ');
            q.push_str(&t.raw);
            q.push(' ');
        }

        // ── Concepts (longest phrases first) ───────────────────────────
        let mut phrases: Vec<(&'static str, &'static Concept)> = CONCEPTS.iter().flat_map(|c| c.phrases.iter().map(move |p| (*p, c))).collect();
        phrases.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        let cleaned: String = q.chars().map(|ch| if ch.is_alphanumeric() || ch == '&' || ch == '-' { ch } else { ' ' }).collect();
        let mut spaced = format!(" {} ", cleaned.split_whitespace().collect::<Vec<_>>().join(" "));
        for (p, c) in phrases {
            let pat = format!(" {p} ");
            if spaced.contains(&pat) {
                if !u.concepts.iter().any(|x| x.id == c.id) {
                    u.concepts.push(c);
                }
                spaced = spaced.replacen(&pat, " ", 1);
            }
        }
        q = spaced;
        // A specific inspection kind makes the generic one redundant.
        if u.concepts.iter().any(|c| ["ut", "external", "internal", "visual", "osi", "ir", "nde", "fieldnotes", "checklist"].contains(&c.id)) {
            u.concepts.retain(|c| c.id != "inspection");
        }

        // ── Units ("in the LRU", "crude unit", "sulfur plant") ─────────
        // A word names a unit when it is a unit code, an acronym/known unit
        // name, an everyday alias, or is followed by "unit"/"plant"/"area".
        let rw = text::raw_words(&q);
        let mut remaining: Vec<String> = Vec::new();
        let mut i = 0;
        while i < rw.len() {
            let w = rw[i].clone();
            let next = rw.get(i + 1).map(|s| s.as_str()).unwrap_or("");
            let explicit = matches!(next, "unit" | "units" | "plant" | "area");
            let mut targets: Vec<String> = Vec::new();
            if let Some((_, al)) = UNIT_ALIASES.iter().find(|(a, _)| *a == w.as_str()) {
                targets.extend(al.iter().map(|s| s.to_string()));
            } else if UNIT_WORDS.contains(&w.as_str()) || explicit || (w.len() == 4 && w.chars().all(|c| c.is_ascii_digit()) && explicit) {
                targets.push(w.clone());
            }
            let us: Vec<u16> = if targets.is_empty() {
                vec![]
            } else {
                self.idx.units.iter().enumerate().filter(|(_, x)| x.keys.iter().any(|k| targets.contains(k))).map(|(i, _)| i as u16).collect()
            };
            if !us.is_empty() {
                u.units.extend(us);
                if explicit {
                    i += 1;
                }
                i += 1;
                continue;
            }
            if FILLER.contains(w.as_str()) || w.len() < 2 {
                if !w.is_empty() {
                    u.ignored.push(w);
                }
            } else {
                remaining.push(w);
            }
            i += 1;
        }
        u.units.sort_unstable();
        u.units.dedup();

        // ── Equipment from its description ─────────────────────────────
        // Score each equipment by the description/kind words it shares with
        // the request (rare words count more; typos allowed), plus unit fit.
        let mut words: Vec<String> = remaining.iter().map(|w| canonical_word(&text::stem(w))).collect();
        // Misspellings: a word nobody uses, close to an equipment word.
        for w in words.iter_mut() {
            let known = self.eq_df.contains_key(w.as_str()) || self.idx.term_ids.get(w.as_str()).map(|&t| !self.postings[t as usize].is_empty()).unwrap_or(false);
            if known || w.len() < 5 || KIND_SYNONYMS.iter().any(|(k, _)| *k == w.as_str()) {
                continue;
            }
            let budget = text::typo_budget(w.len());
            let best = self
                .eq_df
                .iter()
                .filter(|(t, _)| t.len() >= 4 && (t.len() as i32 - w.len() as i32).abs() <= budget as i32)
                .filter_map(|(t, df)| {
                    let d = text::edit_distance(w, t, budget);
                    (d <= budget).then_some((d, std::cmp::Reverse(*df), t.clone()))
                })
                .min();
            if let Some((_, _, t)) = best {
                u.corrections.push((w.clone(), t.clone()));
                *w = t;
            }
        }
        let asked_relief = words.iter().any(|w| ["psv", "prv", "relief", "safety", "rv", "valve", "tsv"].contains(&w.as_str())) || u.concepts.iter().any(|c| c.id == "psv");
        let asked_piping = words.iter().any(|w| ["pipe", "piping", "line", "circuit", "loop"].contains(&w.as_str()));
        if !words.is_empty() && u.ids.is_empty() {
            let mut best: Vec<(u32, f32, Vec<String>)> = Vec::new();
            let n_eq = self.eq_tokens.len().max(1) as f32;
            for (ei, toks) in self.eq_tokens.iter().enumerate() {
                if toks.is_empty() || self.idx.equipment[ei].file_count == 0 {
                    continue;
                }
                let mut score = 0f32;
                let mut hit: Vec<String> = Vec::new();
                // Each description word answers one request word only.
                for w in &words {
                    let expansions: Vec<&str> = KIND_SYNONYMS.iter().find(|(k, _)| *k == w.as_str()).map(|(_, v)| v.to_vec()).unwrap_or_else(|| vec![w.as_str()]);
                    let mut found: Option<(f32, String)> = None;
                    for t in toks {
                        if hit.contains(t) {
                            continue;
                        }
                        let exact = expansions.iter().any(|e| *e == t.as_str());
                        let budget = text::typo_budget(w.len().min(t.len()));
                        let typo = !exact && t.len() >= 5 && w.len() >= 5 && text::edit_distance(w, t, budget) <= budget;
                        if exact || typo {
                            let df = *self.eq_df.get(t).unwrap_or(&1) as f32;
                            let idf = (n_eq / df).ln().max(0.3);
                            let s = if exact && t == w { idf } else { idf * 0.8 };
                            if found.as_ref().map(|f| s > f.0).unwrap_or(true) {
                                found = Some((s, t.clone()));
                            }
                        }
                    }
                    if let Some((s, t)) = found {
                        score += s;
                        hit.push(t);
                    }
                }
                if score <= 0.0 {
                    continue;
                }
                let eq = &self.idx.equipment[ei];
                if (asked_relief != is_relief(eq)) || (!asked_piping && is_piping(eq)) {
                    score *= 0.55;
                }
                if !u.units.is_empty() {
                    if eq.unit.map(|x| u.units.contains(&x)).unwrap_or(false) {
                        score += 1.5;
                    } else {
                        continue;
                    }
                }
                // Prefer equipment with real document histories and a folder.
                score += (eq.file_count as f32).ln_1p() * 0.08 + if eq.folder.is_some() { 0.2 } else { 0.0 };
                best.push((ei as u32, score, hit));
            }
            best.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            if let Some(top) = best.first().cloned() {
                // Needs a distinctive word ("debutanizer"), not just "drum".
                let distinctive = top.2.iter().any(|t| *self.eq_df.get(t).unwrap_or(&1) <= 40);
                if distinctive || top.2.len() >= 2 {
                    let keep: Vec<_> = best.iter().filter(|x| x.1 >= top.1 * 0.8).take(5).cloned().collect();
                    u.equipment_strong = keep.len() == 1 || top.1 >= keep[1].1 * 1.35;
                    u.equipment = keep;
                }
            }
        }
        // Words that named the equipment are satisfied by it — only when the
        // match is confident; a guess leaves them as ordinary words too.
        let used: HashSet<String> = if u.equipment_strong { u.equipment.iter().flat_map(|e| e.2.iter().cloned()).collect() } else { HashSet::new() };
        u.words = words
            .into_iter()
            .filter(|w| {
                !used.contains(w)
                    && !used.iter().any(|t| KIND_SYNONYMS.iter().any(|(k, v)| *k == w.as_str() && v.contains(&t.as_str())))
                    && !used.iter().any(|t| t.len() >= 5 && w.len() >= 5 && text::edit_distance(w, t, 2) <= 2)
                    && !text::STOPS.contains(w.as_str())
            })
            .collect();
        u
    }

    /// Best-fit ranking for a spoken request.
    pub fn search_natural(&self, req: &SearchRequest) -> SearchResponse {
        let t0 = std::time::Instant::now();
        let u = self.understand(&req.query);
        let mut resp = SearchResponse { query: req.query.clone(), mode: "natural".into(), ..Default::default() };
        let limit = if req.limit == 0 { 50 } else { req.limit.min(5000) };

        // ── Explain what was understood ─────────────────────────────────
        let mut equip_set: Vec<u32> = Vec::new();
        // Possible equipment: boosts files, never narrows the search.
        let mut weak_equip: Vec<u32> = Vec::new();
        for t in &u.ids {
            if let Some(l) = self.idx.equip_keys.get(&t.key).or_else(|| t.parent.as_ref().and_then(|p| self.idx.equip_keys.get(p))) {
                equip_set.extend(l);
                for &e in l {
                    let eq = &self.idx.equipment[e as usize];
                    resp.chips.push(Chip { kind: "equipment", text: eq.number.clone(), detail: format!("{} {}", t.raw.to_uppercase(), eq.description).trim().into() });
                }
            } else {
                resp.chips.push(Chip { kind: "tag", text: t.raw.to_uppercase(), detail: "Tag in file or folder names".into() });
            }
        }
        if let Some(pin) = req.equipment {
            equip_set = vec![pin];
        } else if !u.equipment.is_empty() && equip_set.is_empty() {
            if u.equipment_strong {
                let (e, _, why) = &u.equipment[0];
                equip_set.push(*e);
                let eq = &self.idx.equipment[*e as usize];
                resp.chips.push(Chip {
                    kind: "equipment",
                    text: eq.number.clone(),
                    detail: format!("{} {} — from “{}”", eq.tags.first().cloned().unwrap_or_default(), eq.description, why.join(" ")).trim().into(),
                });
            } else {
                weak_equip.extend(u.equipment.iter().map(|e| e.0));
                resp.ambiguity.push(Ambiguity {
                    token: "the equipment you described".into(),
                    options: u.equipment.iter().map(|(e, _, _)| self.equip_option_pub(*e)).collect(),
                });
            }
        }
        for &un in &u.units {
            resp.chips.push(Chip { kind: "unit", text: self.idx.units[un as usize].name.clone(), detail: self.idx.units[un as usize].label.clone() });
        }
        let lq = req.query.to_lowercase();
        for c in &u.concepts {
            let said = c.phrases.iter().filter(|p| lq.contains(*p)).max_by_key(|p| p.len()).copied().unwrap_or(c.phrases[0]);
            resp.chips.push(Chip { kind: "concept", text: c.label.into(), detail: format!("from “{said}”") });
        }
        if let Some(l) = &u.year_label {
            resp.chips.push(Chip { kind: "year", text: l.clone(), detail: "Time".into() });
        }
        for (typed, meant) in &u.corrections {
            resp.chips.push(Chip { kind: "fuzzy", text: meant.clone(), detail: format!("you typed “{typed}”") });
        }
        if u.sort_newest {
            resp.chips.push(Chip { kind: "recent", text: "sorted newest first".into(), detail: String::new() });
        } else if u.sort_oldest {
            resp.chips.push(Chip { kind: "recent", text: "sorted oldest first".into(), detail: String::new() });
        } else if u.prefer_recent {
            resp.chips.push(Chip { kind: "recent", text: "newest first".into(), detail: String::new() });
        } else if u.prefer_oldest {
            resp.chips.push(Chip { kind: "recent", text: "oldest first".into(), detail: String::new() });
        }
        for w in &u.words {
            resp.chips.push(Chip { kind: "word", text: w.clone(), detail: "nice to have".into() });
        }
        if !u.ignored.is_empty() {
            let mut seen = HashSet::new();
            let ig: Vec<String> = u.ignored.iter().filter(|w| seen.insert((*w).clone())).take(12).cloned().collect();
            resp.chips.push(Chip { kind: "ignored", text: ig.join(" "), detail: "ignored".into() });
        }

        // ── Candidate pool ──────────────────────────────────────────────
        let mut pool: HashSet<u32> = HashSet::new();
        let n_files = self.idx.files.len().max(1) as f32;
        let word_ids: Vec<(String, Vec<u32>, f32)> = u
            .words
            .iter()
            .map(|w| {
                let mut ids: Vec<u32> = word_variants(w)
                    .iter()
                    .filter_map(|v| self.idx.term_ids.get(v.as_str()).copied())
                    .filter(|&t| !self.postings[t as usize].is_empty())
                    .collect();
                if ids.is_empty() {
                    ids = self.fuzzy_terms_pub(w);
                }
                let df: usize = ids.iter().map(|&t| self.postings[t as usize].len()).sum::<usize>().max(1);
                (w.clone(), ids, (n_files / df as f32).ln().max(0.2))
            })
            .filter(|x| !x.1.is_empty())
            .collect();
        let add = |pool: &mut HashSet<u32>, ids: &[u32]| {
            for &t in ids {
                pool.extend(self.postings[t as usize].iter().copied());
            }
        };
        let add_tags = |pool: &mut HashSet<u32>| {
            for t in &u.ids {
                if let Some(p) = self.idx.term_ids.get(&format!("tag:{}", t.key)).and_then(|t| self.tag_postings.get(t)) {
                    pool.extend(p.iter().copied());
                }
            }
        };
        if !equip_set.is_empty() {
            for &e in &equip_set {
                pool.extend(self.idx.equip_files[e as usize].iter().copied());
            }
            add_tags(&mut pool);
        } else {
            for (_, ids, idf) in &word_ids {
                if *idf > 1.0 {
                    add(&mut pool, ids);
                }
            }
            if u.words.is_empty() || !u.units.is_empty() {
                for c in &u.concepts {
                    let ids: Vec<u32> = c.terms.iter().filter_map(|t| self.idx.term_ids.get(*t).copied()).filter(|&t| self.postings[t as usize].len() < 60_000).collect();
                    add(&mut pool, &ids);
                    // Category alone, e.g. "P&IDs in the crude unit".
                    if let Some(cat) = c.category {
                        if !u.units.is_empty() {
                            for (fi, f) in self.idx.files.iter().enumerate() {
                                if f.cat == cat && self.idx.dirs[f.dir as usize].unit.map(|x| u.units.contains(&x)).unwrap_or(false) {
                                    pool.insert(fi as u32);
                                }
                            }
                        }
                    }
                }
            }
            if pool.is_empty() {
                for (_, ids, _) in &word_ids {
                    add(&mut pool, ids);
                }
            }
            for &e in &weak_equip {
                pool.extend(self.idx.equip_files[e as usize].iter().copied());
            }
            add_tags(&mut pool);
        }

        // ── Score every candidate ──────────────────────────────────────
        let photo_intent = u.concepts.iter().any(|c| c.id == "photo");
        let template_intent = u.concepts.iter().any(|c| c.id == "template");
        let wants_inspection = u.concepts.iter().any(|c| c.category == Some(Category::Inspection));
        let max_word_weight: f32 = word_ids.iter().map(|x| x.2).sum::<f32>().max(0.001);
        let concept_terms: Vec<Vec<u32>> = u.concepts.iter().map(|c| c.terms.iter().filter_map(|t| self.idx.term_ids.get(*t).copied()).collect()).collect();
        struct S {
            fi: u32,
            score: f32,
            reasons: Vec<String>,
            /// Is what was asked for (right kind of document, words present),
            /// not just near it. Date ordering only reorders these.
            fits: bool,
        }
        let mut scored: Vec<S> = Vec::with_capacity(pool.len());
        let mut facet_cat: HashMap<Category, u32> = HashMap::new();
        let mut facet_unit: HashMap<u16, u32> = HashMap::new();
        let mut facet_year: HashMap<i16, u32> = HashMap::new();
        let cat_filter: Vec<Category> = req.categories.iter().filter_map(|c| Category::from_label(c)).collect();
        let unit_filter: Vec<u16> = req.units.iter().filter_map(|l| self.idx.units.iter().position(|x| &x.label == l).map(|i| i as u16)).collect();
        let ext_filter: Vec<String> = req.exts.iter().map(|e| e.to_lowercase()).collect();
        for &fi in &pool {
            let f = &self.idx.files[fi as usize];
            let dir = &self.idx.dirs[f.dir as usize];
            if f.flags & (F_JUNK | F_ZERO) != 0 && !req.include_junk {
                continue;
            }
            if req.hide_archive && f.flags & F_ARCHIVE != 0 {
                continue;
            }
            if let Some(y) = req.year_min {
                if f.year.map(|fy| (fy as i32) < y).unwrap_or(true) {
                    continue;
                }
            }
            if let Some(y) = req.year_max {
                if f.year.map(|fy| (fy as i32) > y).unwrap_or(true) {
                    continue;
                }
            }
            let mut score = 0f32;
            let mut reasons: Vec<String> = Vec::new();
            if !equip_set.is_empty() {
                match f.equip.iter().find(|(e, _)| equip_set.contains(e)) {
                    Some((e, LinkSrc::Filename)) => {
                        score += 160.0;
                        reasons.push(format!("Named for {}", self.idx.equipment[*e as usize].number));
                    }
                    Some((e, _)) => {
                        score += 130.0;
                        reasons.push(format!("In {}'s folder", self.idx.equipment[*e as usize].number));
                    }
                    None => {
                        score += 90.0;
                        reasons.push("Tag in name".into());
                    }
                }
            }
            let weak_hit = !weak_equip.is_empty() && f.equip.iter().any(|(e, _)| weak_equip.contains(e));
            if weak_hit {
                score += 45.0;
                reasons.push("Equipment fits your description".into());
            }
            if !u.units.is_empty() {
                if dir.unit.map(|x| u.units.contains(&x)).unwrap_or(false) {
                    score += 30.0;
                    reasons.push("In the unit you named".into());
                } else {
                    score -= 60.0;
                }
            }
            let mut concept_hits = 0;
            for (ci, c) in u.concepts.iter().enumerate() {
                let ids = &concept_terms[ci];
                let in_name = ids.iter().any(|t| f.name_terms.binary_search(t).is_ok());
                let in_meta = ids.iter().any(|t| f.meta_terms.binary_search(t).is_ok());
                let in_dir = ids.iter().any(|t| dir.terms.binary_search(t).is_ok());
                let cat_ok = c.category.map(|x| x == f.cat).unwrap_or(false);
                let type_ok = c.doctypes.contains(&f.doctype);
                let mut s = 0f32;
                if type_ok {
                    s += 55.0;
                } else if cat_ok {
                    s += 35.0;
                }
                if in_name {
                    s += 30.0;
                } else if in_meta {
                    s += 14.0;
                } else if in_dir {
                    s += 12.0;
                }
                if s > 0.0 {
                    concept_hits += 1;
                    score += s;
                    reasons.push(format!("{}{}", c.label, if type_ok { "" } else if in_name { " (in name)" } else if in_dir { " (folder)" } else { "" }));
                }
            }
            let mut covered = 0f32;
            for (w, ids, idf) in &word_ids {
                let (pts, label) = if ids.iter().any(|t| f.name_terms.binary_search(t).is_ok()) {
                    (3.0, "name")
                } else if ids.iter().any(|t| f.meta_terms.binary_search(t).is_ok()) {
                    (2.0, "description")
                } else if ids.iter().any(|t| dir.terms.binary_search(t).is_ok()) {
                    (1.2, "folder")
                } else {
                    (0.0, "")
                };
                if pts > 0.0 {
                    covered += idf;
                    score += pts * idf * 6.0;
                    reasons.push(format!("“{w}” in {label}"));
                }
            }
            let coverage = covered / max_word_weight;
            // Without equipment, require real evidence of what was asked.
            if equip_set.is_empty() {
                let enough = (word_ids.is_empty() || coverage >= 0.5 || (weak_hit && coverage >= 0.25)) && (u.concepts.is_empty() || concept_hits >= 1);
                if !enough && !(coverage >= 0.8 && concept_hits == 0 && u.concepts.len() <= 1) {
                    continue;
                }
            }
            if let Some(y) = f.year {
                let y = y as i32;
                if u.year_min.is_some() || u.year_max.is_some() {
                    let (lo, hi) = (u.year_min.unwrap_or(i32::MIN), u.year_max.unwrap_or(i32::MAX));
                    if y >= lo && y <= hi {
                        score += 45.0;
                        reasons.push(format!("From {y}"));
                    } else {
                        let off = if y < lo { lo - y } else { y - hi };
                        score -= (off as f32 * 14.0).min(70.0);
                    }
                }
                if u.prefer_recent {
                    score += ((y - 1990).max(0) as f32) * 1.6;
                }
                if u.prefer_oldest {
                    score += ((2040 - y).max(0) as f32) * 1.6;
                }
            } else if u.year_min.is_some() || u.year_max.is_some() {
                score -= 25.0;
            }
            let photo = f.cat == Category::Photos;
            let blank = f.flags & F_BLANK != 0;
            if photo && !photo_intent {
                score -= 90.0;
            }
            if blank && !template_intent {
                score -= 80.0;
            }
            if wants_inspection && f.cat == Category::Inspection && !blank {
                score += 20.0;
                // Within one inspection the report/survey is the answer; the
                // technique, calibration and reader sheets support it.
                let ln = f.name.to_lowercase();
                if ["report", "survey", "summary"].iter().any(|w| ln.contains(w)) {
                    score += 6.0;
                } else if ["technique", "cal sheet", "calibration", "reader sheet", "cal cert"].iter().any(|w| ln.contains(w)) {
                    score -= 5.0;
                }
                if f.ext == ".pdf" {
                    score += 2.0;
                }
            }
            if f.flags & F_ARCHIVE != 0 {
                score -= 15.0;
                reasons.push("Archive folder".into());
            }
            if f.family.is_some() && f.flags & F_LATEST != 0 {
                score += 8.0;
            }
            let fits = (u.concepts.is_empty() || concept_hits >= 1)
                && (!wants_inspection || f.cat == Category::Inspection)
                && (word_ids.is_empty() || coverage >= 0.5 || !equip_set.is_empty())
                && (photo_intent || f.cat != Category::Photos)
                && (template_intent || f.flags & F_BLANK == 0);
            scored.push(S { fi, score, reasons, fits });
        }
        // A named unit is a boundary: keep results inside it when there are any.
        if !u.units.is_empty() {
            let inside = |s: &S| self.idx.dirs[self.idx.files[s.fi as usize].dir as usize].unit.map(|x| u.units.contains(&x)).unwrap_or(false);
            if scored.iter().any(inside) {
                scored.retain(inside);
            } else if !scored.is_empty() {
                resp.notice = Some("Nothing like that inside the unit you named — showing the closest matches from other units.".into());
            }
        }
        // Facets describe everything that matched (inside the boundary), before
        // the person's own filters, so other options stay visible.
        for s in &scored {
            let f = &self.idx.files[s.fi as usize];
            *facet_cat.entry(f.cat).or_default() += 1;
            if let Some(un) = self.idx.dirs[f.dir as usize].unit {
                *facet_unit.entry(un).or_default() += 1;
            }
            if let Some(y) = f.year {
                *facet_year.entry(y).or_default() += 1;
            }
        }
        scored.retain(|s| {
            let f = &self.idx.files[s.fi as usize];
            let unit = self.idx.dirs[f.dir as usize].unit;
            (cat_filter.is_empty() || cat_filter.contains(&f.cat))
                && (unit_filter.is_empty() || unit.map(|x| unit_filter.contains(&x)).unwrap_or(false))
                && (ext_filter.is_empty() || ext_filter.contains(&f.ext))
        });
        let date_sort = if req.sort.is_empty() && (u.sort_newest || u.sort_oldest) { if u.sort_newest { "newest" } else { "oldest" } } else { "" };
        if !date_sort.is_empty() && !scored.is_empty() {
            // The good matches in date order, then the weaker ones by fit.
            let top = scored.iter().filter(|s| s.fits).map(|s| s.score).fold(f32::MIN, f32::max);
            let bar = top - (top.abs() * 0.45).max(60.0);
            // An inspection folder's date is its newest file; files in one
            // folder stay together, best fit first.
            let mut dir_date: HashMap<u32, i64> = HashMap::new();
            for s in scored.iter() {
                let f = &self.idx.files[s.fi as usize];
                let e = dir_date.entry(f.dir).or_insert(f.mtime);
                *e = (*e).max(f.mtime);
            }
            let year = |s: &S| {
                let f = &self.idx.files[s.fi as usize];
                (f.year, dir_date.get(&f.dir).copied().unwrap_or(f.mtime), f.dir)
            };
            scored.sort_by(|a, b| {
                let (ga, gb) = (a.fits && a.score >= bar, b.fits && b.score >= bar);
                gb.cmp(&ga)
                    .then_with(|| {
                        if ga && gb {
                            if date_sort == "newest" {
                                year(b).cmp(&year(a))
                            } else {
                                let (ya, yb) = (year(a), year(b));
                                (ya.0.unwrap_or(9999), ya.1, ya.2).cmp(&(yb.0.unwrap_or(9999), yb.1, yb.2))
                            }
                        } else {
                            std::cmp::Ordering::Equal
                        }
                    })
                    .then_with(|| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal))
                    .then(a.fi.cmp(&b.fi))
            });
        }
        match if date_sort.is_empty() { req.sort.as_str() } else { "kept" } {
            "kept" => {}
            "newest" => scored.sort_by(|a, b| self.idx.files[b.fi as usize].year.cmp(&self.idx.files[a.fi as usize].year)),
            "oldest" => scored.sort_by(|a, b| self.idx.files[a.fi as usize].year.unwrap_or(9999).cmp(&self.idx.files[b.fi as usize].year.unwrap_or(9999))),
            "name" => scored.sort_by(|a, b| self.idx.files[a.fi as usize].name.to_lowercase().cmp(&self.idx.files[b.fi as usize].name.to_lowercase())),
            // Equal fit: newer first (people usually want the current record).
            _ => scored.sort_by(|a, b| {
                let (fa, fb) = (&self.idx.files[a.fi as usize], &self.idx.files[b.fi as usize]);
                b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then(fb.year.cmp(&fa.year)).then(fb.mtime.cmp(&fa.mtime)).then(a.fi.cmp(&b.fi))
            }),
        }
        // Two photos per folder unless photos were asked for.
        let mut per_folder: HashMap<u32, u32> = HashMap::new();
        let mut visible = Vec::with_capacity(scored.len());
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
        resp.total = visible.len();
        let top_fits = visible.first().map(|s| s.fits).unwrap_or(false);
        for (rank, s) in visible.into_iter().enumerate().skip(req.offset).take(limit) {
            resp.hits.push(self.hit(s.fi, rank + 1, s.score.round() as i32, s.reasons));
        }
        // Confident when the top file is the kind of thing asked for, about the
        // equipment described (or matching every described word), with no
        // open "which one?" question.
        if req.offset == 0 && top_fits && resp.ambiguity.is_empty() && resp.notice.is_none() && (!equip_set.is_empty() || !u.concepts.is_empty()) {
            if let Some(h) = resp.hits.first() {
                resp.best = Some(self.best_why(h, u.sort_newest || u.prefer_recent));
            }
        }
        let mut cats: Vec<Facet> = facet_cat.into_iter().map(|(c, n)| Facet { key: c.label().into(), label: c.label().into(), count: n }).collect();
        cats.sort_by(|a, b| b.count.cmp(&a.count));
        let mut units: Vec<Facet> = facet_unit.into_iter().map(|(x, n)| Facet { key: self.idx.units[x as usize].label.clone(), label: self.idx.units[x as usize].label.clone(), count: n }).collect();
        units.sort_by(|a, b| b.count.cmp(&a.count));
        let mut years: Vec<Facet> = facet_year.into_iter().map(|(y, n)| Facet { key: y.to_string(), label: y.to_string(), count: n }).collect();
        years.sort_by(|a, b| b.key.cmp(&a.key));
        resp.facets = Facets { categories: cats, units, years, exts: vec![], equipment: vec![] };
        if equip_set.len() == 1 {
            resp.card = Some(self.equipment_card(equip_set[0]));
        }
        if resp.total == 0 && resp.notice.is_none() {
            resp.notice = Some("Nothing fits that description well. Try naming the equipment, the unit or the kind of document.".into());
        }
        resp.took_ms = t0.elapsed().as_secs_f64() * 1000.0;
        resp
    }
}
