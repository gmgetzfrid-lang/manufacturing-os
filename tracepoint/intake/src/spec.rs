//! Kern's numbering standard (KOR Y-4, 2020-08-17) and the filing
//! conventions already used on the engineering drive.
//!
//! Equipment number `2010.03`: unit 20, item 10 (vessels), sequence 03.
//! Unit folders are `2000 - CRUDE UNIT`, item folders `10 - VESSELS`,
//! equipment folders `2010.03 V-3 PREFRACTIONATOR TOWER`, and inside those the
//! document-type folders (DRAWINGS, CODE DOCUMENTS, ...).

use regex::Regex;
use std::sync::OnceLock;

/// Units (first two digits). Names as the standard lists them; the folder is
/// `<unit>00 - <name>`.
pub const UNITS: &[(u8, &str)] = &[
    (10, "ENGINEERING"),
    (20, "CRUDE UNIT"),
    (25, "DIESEL HYDROTREATER UNIT (DHT)"),
    (30, "KEROSENE HYDROTREATER (KHT)"),
    (31, "NAPTHA HYDROTREATER UNIT (NHT)"),
    (35, "PLATFORMER UNIT"),
    (36, "REFORMER UNIT"),
    (40, "THERMAL CRACKER (OOS)"),
    (45, "SULFEROX (OOS)"),
    (46, "SOUR WATER STRIPPER (SULFUR PLANT)"),
    (47, "AMINE UNIT (SULFUR PLANT)"),
    (48, "SULFUR RECOVERY UNIT (SRU-SULFUR PLANT)"),
    (49, "SULFUR PLANT UTILITIES"),
    (50, "RE-RUN UNIT (OOS)"),
    (55, "TRANSMIX UNIT"),
    (56, "LPG RECOVERY UNIT (LRU)"),
    (57, "S.W.S. NO. 1"),
    (59, "COGEN UNIT"),
    (60, "WATER (UTILITY)"),
    (61, "STEAM (UTILITY)"),
    (62, "AIR (UTILITY)"),
    (63, "ELECTRICITY (UTILITY)"),
    (64, "FUEL (UTILITY)"),
    (65, "SEWER (UTILITY)"),
    (66, "WASTE WATER (UTILITY)"),
    (67, "TREATER UNIT"),
    (68, "CHEMICAL INJECTION (UTILITY)"),
    (69, "LABORATORY"),
    (70, "LOADING"),
    (71, "TRANSFER"),
    (72, "STORAGE"),
    (73, "VAPOR RECOVERY"),
    (74, "NITROGEN"),
    (75, "WAREHOUSE"),
    (76, "CONTROL ROOM"),
    (79, "CRUDE DEPARTMENT"),
    (80, "MAIN OFFICE"),
    (81, "GENERAL PLANT"),
    (82, "PERSONNEL"),
    (83, "MAINTENANCE BUILDING"),
    (89, "COMMUNICATION"),
    (90, "SOIL VAPOR EXTRACTION"),
];

/// Items (second two digits). Where the crude unit's folders already spell an
/// item differently from the standard, the folder spelling wins, so new
/// folders line up with existing ones.
pub const ITEMS: &[(u8, &str)] = &[
    (0, "PROPOSAL"),
    (1, "PLOT PLAN"),
    (2, "P&ID"),
    (3, "PFD"),
    (4, "RAILCAR TRACKS"),
    (5, "FOUNDATIONS"),
    (6, "ELECTRICAL"),
    (7, "CIVIL UNDERGROUND PIPING"),
    (8, "BUILDINGS"),
    (9, "VEHICLE"),
    (10, "VESSELS"),
    (11, "INSULATION"),
    (12, "AIR CONDITIONER"),
    (13, "STRUCTURAL (PIPE RACKS, PLATFORMS, LADDERS)"),
    (14, "FLAME ARRESTOR"),
    (15, "PIPING"),
    (16, "VALVES"),
    (17, "RELIEF VALVES"),
    (18, "PRESSURE REGULATORS"),
    (19, "JET EJECTORS"),
    (20, "FUEL GAS INSTRUMENTS"),
    (21, "AIR DRYER"),
    (22, "MEMBRANES"),
    (23, "MIXERS"),
    (24, "PUMPS (CHEMICAL)"),
    (25, "PUMPS (RECIPROCATING)"),
    (26, "PUMPS (CENTRIFUGAL)"),
    (27, "TURBINES STEAM"),
    (28, "COMPRESSORS"),
    (29, "BLOWERS"),
    (30, "EXCHANGERS"),
    (31, "HOSES"),
    (32, "HATCH"),
    (33, "PITS & SUMPS"),
    (34, "DRAINS"),
    (35, "HEATERS"),
    (36, "BOILERS"),
    (37, "FLARES, INCINERATORS, THERMAL OXIDIZERS"),
    (38, "ELECTRIC HEATERS"),
    (39, "PVRV PRESSURE VACCUUM RELIEF VALVE"),
    (40, "COOLING TOWERS"),
    (42, "12 KV SWITCHING EQUIPMENT"),
    (43, "GAS TURBINE"),
    (44, "GENERATORS"),
    (45, "TRANSFORMERS"),
    (46, "ELECTRIC MOTORS"),
    (47, "CIRCUIT BREAKERS"),
    (48, "GAS ENGINE"),
    (49, "GEAR REDUCERS"),
    (50, "TEMPERATURE TRANSMITTERS & INDICATORS"),
    (51, "PRESSURE TRANSMITTERS & INDICATORS"),
    (52, "LEVEL TRANSMITTERS & INDICATORS"),
    (53, "AIR INSTRUMENTS"),
    (54, "CHEMICALS"),
    (55, "METERS"),
    (56, "GENERAL LAB EQUIPMENT"),
    (57, "CATALYST"),
    (58, "ORIFICE PLATES"),
    (59, "FLOW TRANSMITTERS & INDICATORS"),
    (60, "MISCELLANEOUS"),
    (61, "POWER POLE MAN HOLES & HAND HOLES"),
    (62, "CONDUIT & CONDUCTORS"),
    (63, "480V MCC SWITCH BOARD & RACK"),
    (65, "FILTER PRESSES"),
    (69, "RAILCAR TRACKS"),
    (70, "RAILCAR SWITCHES"),
    (71, "POSITIONERS"),
    (72, "TANKS"),
    (73, "TEMPERATURE CONTROLLERS"),
    (74, "PRESSURE CONTROLLERS"),
    (75, "LEVEL CONTROLLERS"),
    (76, "FLOW CONTROLLERS"),
    (78, "ELECTRICAL SINGLE LINE DIAGRAM"),
    (79, "VARIABLE FREQUENCY DRIVES"),
    (80, "PLCS"),
    (81, "HMIS"),
    (82, "WIRELESS COMMUNICATION"),
    (83, "JUNCTION BOX"),
];

pub fn unit_name(unit: u8) -> String {
    UNITS.iter().find(|(u, _)| *u == unit).map(|(_, n)| n.to_string()).unwrap_or_else(|| format!("UNIT {unit:02}"))
}

pub fn item_name(item: u8) -> String {
    ITEMS.iter().find(|(i, _)| *i == item).map(|(_, n)| n.to_string()).unwrap_or_else(|| format!("ITEM {item:02}"))
}

pub fn unit_folder(unit: u8) -> String {
    format!("{unit:02}00 - {}", sanitize_component(&unit_name(unit)))
}

pub fn item_folder(item: u8) -> String {
    format!("{item:02} - {}", sanitize_component(&item_name(item)))
}

/// The document-type folders inside an equipment folder.
pub const DOC_FOLDERS: &[(&str, &str)] = &[
    ("DRAWINGS", "Fabrication, general arrangement, detail, nozzle, foundation, as-built and field drawings, sketches, isometrics, P&ID or PFD sheets"),
    ("CODE DOCUMENTS", "ASME / National Board / State code records: U-1, U-1A, U-2, U-2A, U-3, U-4, R-1, R-2, R-3, R-4, NB forms, P-forms, manufacturer's data reports, nameplate rubbings and facsimiles, State permits and certificates, State repair / alteration requests and approvals, code repair and alteration packages"),
    ("CALCULATIONS", "Design, MAWP, minimum thickness, remaining life, relief sizing, wind / seismic and other engineering calculations"),
    ("DATASHEETS", "Equipment specification sheets and data sheets, performance curves, nozzle schedules, tray data, rating sheets"),
    ("INSPECTIONS", "Inspection reports and records: internal / external visual, UT thickness surveys and field notes, NDE, inspection checklists, test reports, IR scans, inspection drawings marked up with readings"),
    ("REPAIRS", "Repair and maintenance records that are not code forms: work orders, repair procedures, repair scopes, weld maps for a repair, maintenance history"),
    ("VENDOR DATA", "Purchasing and manufacturer documents: purchase orders, requisitions, quotes, invoices, bills of material, manuals, IOMs, brochures, material test reports and certificates"),
    ("CORRESPONDENCE", "Letters, memos, transmittals, handwritten notes, meeting notes and other correspondence that is not an email and does not belong in a folder above"),
    ("EMAILS", "Printed emails"),
    ("PICTURES", "Photographs"),
];

pub fn doc_folder_names() -> Vec<&'static str> {
    DOC_FOLDERS.iter().map(|(n, _)| *n).collect()
}

/// An equipment (or piping circuit, or tank) number.
#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct EquipNo {
    /// Display form, e.g. `2010.03`, `2010.31B`, `2015-001`, `55004`.
    pub text: String,
    pub unit: Option<u8>,
    pub item: Option<u8>,
}

impl EquipNo {
    /// Key used for matching: upper-case, separators normalised.
    pub fn key(&self) -> String {
        self.text.to_ascii_uppercase()
    }
}

fn re_equip() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    // 2010.03 / 2010.3 / 2010_03 / 2010-03 / 2010 03, optional letter suffix
    // (2010.31B). Piping circuits: 2015-001. Not followed by more digits.
    R.get_or_init(|| Regex::new(r"(?i)(?:^|[^0-9A-Z])(\d{2})(\d{2})\s?([._\- ])\s?(\d{1,3})([A-Z]{1,2})?(?:$|[^0-9A-Z])").unwrap())
}

fn re_tank() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(?:^|[^0-9.])(?:TK|TANK)?\s*-?\s*(\d{5})(?:$|[^0-9.])").unwrap())
}

/// Parse one equipment number from free text (first match). Recognises the
/// KOR Y-4 equipment form, piping circuits and five-digit tank numbers.
pub fn parse_equip(s: &str) -> Option<EquipNo> {
    let s = s.trim();
    if let Some(c) = re_equip().captures(s) {
        let unit: u8 = c[1].parse().ok()?;
        let item: u8 = c[2].parse().ok()?;
        let sep = &c[3];
        let seq = &c[4];
        let suffix = c.get(5).map(|m| m.as_str().to_ascii_uppercase()).unwrap_or_default();
        if unit < 10 {
            return None;
        }
        let text = if seq.len() == 3 && sep == "-" {
            // Piping circuit: 2015-001.
            format!("{unit:02}{item:02}-{seq}{suffix}")
        } else if seq.len() == 3 {
            format!("{unit:02}{item:02}.{seq}{suffix}")
        } else {
            format!("{unit:02}{item:02}.{:02}{suffix}", seq.parse::<u32>().ok()?)
        };
        return Some(EquipNo { text, unit: Some(unit), item: Some(item) });
    }
    if let Some(c) = re_tank().captures(s) {
        return Some(EquipNo { text: c[1].to_string(), unit: None, item: Some(72) });
    }
    None
}

/// Equipment number from a dropped scan's file name (`2010.06.pdf`,
/// `2010.06 (2).pdf`, `2010.06 V-6 part 2.pdf`). Scanner names such as
/// `doc13232423412412.pdf` give nothing.
pub fn equip_from_filename(name: &str) -> Option<EquipNo> {
    let stem = name.rsplit_once('.').map(|(a, _)| a).unwrap_or(name);
    let t = stem.trim();
    // Long digit runs are scanner serials, never equipment numbers.
    if t.chars().all(|c| c.is_ascii_digit()) && t.len() > 5 {
        return None;
    }
    let lower = t.to_ascii_lowercase();
    if ["doc", "scan", "img", "image"].iter().any(|p| lower.starts_with(p) && lower[p.len()..].chars().next().map(|c| c.is_ascii_digit() || c == '_' || c == '-').unwrap_or(true)) {
        return None;
    }
    parse_equip(t)
}

/// Is this folder name an equipment folder? Returns the number and whether
/// it is marked out of service (`O - OOS - 2010.15 ...`).
pub fn equip_folder(name: &str) -> Option<(EquipNo, bool)> {
    let oos_re = {
        static R: OnceLock<Regex> = OnceLock::new();
        R.get_or_init(|| Regex::new(r"(?i)^\s*(?:O\s*-\s*)?OOS\s*-\s*").unwrap())
    };
    let (rest, oos) = match oos_re.find(name) {
        Some(m) => (&name[m.end()..], true),
        None => (name, false),
    };
    let rest = rest.trim_start();
    // The number must lead the folder name.
    let first = rest.split_whitespace().next()?;
    let n = parse_equip(first)?;
    // `2015-001` style must not swallow drawing numbers like `2015-B 2003`.
    Some((n, oos))
}

/// `2000 - CRUDE UNIT` -> 20
pub fn unit_of_folder(name: &str) -> Option<u8> {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| Regex::new(r"^\s*(\d{2})00\s*-\s*\S").unwrap());
    r.captures(name).and_then(|c| c[1].parse().ok())
}

/// `10 - VESSELS` -> 10
pub fn item_of_folder(name: &str) -> Option<u8> {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| Regex::new(r"^\s*(\d{2})\s*-\s*\S").unwrap());
    r.captures(name).and_then(|c| c[1].parse().ok())
}

/// Windows-safe path component: no reserved characters, no trailing dots or
/// spaces, single spaces.
pub fn sanitize_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        let c = match ch {
            '<' | '>' | '"' | '|' | '?' | '*' => ' ',
            ':' => '-',
            '/' | '\\' => '-',
            '\u{2018}' | '\u{2019}' => '\'',
            '\u{201C}' | '\u{201D}' => ' ',
            '\u{2013}' | '\u{2014}' => '-',
            c if c.is_control() => ' ',
            c => c,
        };
        out.push(c);
    }
    let mut collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    while collapsed.ends_with('.') || collapsed.ends_with(' ') {
        collapsed.pop();
    }
    let upper = collapsed.to_ascii_uppercase();
    let base = upper.split('.').next().unwrap_or("");
    if ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3"].contains(&base) {
        collapsed.push('_');
    }
    collapsed
}

/// Cut to at most `max` characters on a word boundary.
pub fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    if let Some(i) = out.rfind(' ') {
        if i > max / 2 {
            out.truncate(i);
        }
    }
    out.trim_end_matches([' ', '-', ',', '.']).to_string()
}

/// A document date as written in file names: `YYYY-MM-DD`, `YYYY-MM` or
/// `YYYY`. Anything else is refused.
pub fn valid_date(s: &str) -> Option<String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| Regex::new(r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$").unwrap());
    let s = s.trim();
    let c = r.captures(s)?;
    let y: i32 = c[1].parse().ok()?;
    if !(1900..=2100).contains(&y) {
        return None;
    }
    if let Some(m) = c.get(2) {
        let m: u32 = m.as_str().parse().ok()?;
        if !(1..=12).contains(&m) {
            return None;
        }
    }
    if let Some(d) = c.get(3) {
        let d: u32 = d.as_str().parse().ok()?;
        if !(1..=31).contains(&d) {
            return None;
        }
    }
    Some(s.to_string())
}

/// `2010.06 V-6 LIGHT NAPHTHA STABILIZER TOWER`
pub fn equipment_folder_name(no: &EquipNo, tag: &str, description: &str) -> String {
    let mut parts = vec![no.text.clone()];
    let tag = tag.trim().to_ascii_uppercase();
    let desc = description.trim().to_ascii_uppercase();
    if !tag.is_empty() && !desc.contains(&tag) {
        parts.push(tag);
    }
    if !desc.is_empty() {
        parts.push(desc);
    }
    clip(&sanitize_component(&parts.join(" ")), 80)
}

/// Strip the equipment number (and an immediately following tag) if the
/// title repeats it; the file name adds it once at the front.
fn strip_leading_number(title: &str, no: &EquipNo) -> String {
    let t = title.trim();
    let alt = no.text.replace('.', "_");
    for p in [no.text.as_str(), alt.as_str()] {
        if let Some(rest) = t.strip_prefix(p) {
            return rest.trim_start_matches([' ', '-', '_', ',']).to_string();
        }
    }
    t.to_string()
}

/// The file name for one filed document:
/// `2010.06 U-1A Manufacturer's Data Report 1978-03-14.pdf`.
/// `as_other`: the number (and tag) the document was written under, when it
/// was written for another number in this equipment's history.
pub fn document_file_name(no: &EquipNo, title: &str, date: Option<&str>, as_other: Option<&str>) -> String {
    let mut title = strip_leading_number(title, no);
    // Dates belong at the end in one format only.
    if let Some(d) = date {
        if let Some(t) = title.strip_suffix(d) {
            title = t.trim_end_matches([' ', '-', ',']).to_string();
        }
    }
    let title = clip(&sanitize_component(&title), 90);
    let mut name = format!("{} {}", no.text, if title.is_empty() { "Document" } else { &title });
    if let Some(o) = as_other.map(str::trim).filter(|o| !o.is_empty()) {
        let o = sanitize_component(o);
        if !name.contains(&format!("(as {o})")) {
            name.push_str(&format!(" (as {o})"));
        }
    }
    match date.and_then(valid_date) {
        Some(d) => name.push_str(&format!(" {d}")),
        None => name.push_str(" Undated"),
    }
    format!("{}.pdf", sanitize_component(&name))
}

/// Compare folder names loosely: `DATA SHEETS` = `DATASHEETS`, `Emails` =
/// `EMAILS`.
pub fn loose(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_numbers() {
        assert_eq!(parse_equip("2010.03").unwrap().text, "2010.03");
        assert_eq!(parse_equip("2010.3").unwrap().text, "2010.03");
        assert_eq!(parse_equip("2010_03 PREFRAC").unwrap().text, "2010.03");
        assert_eq!(parse_equip("2010.31B C-02 DISCHARGE BOTTLE").unwrap().text, "2010.31B");
        assert_eq!(parse_equip("2015-001 Crude Charge").unwrap().text, "2015-001");
        assert_eq!(parse_equip("6110.14 V-14").unwrap().unit, Some(61));
        assert_eq!(parse_equip("TK-55004").unwrap().text, "55004");
        assert!(parse_equip("hello").is_none());
    }

    #[test]
    fn filenames() {
        assert_eq!(equip_from_filename("2010.06.pdf").unwrap().text, "2010.06");
        assert_eq!(equip_from_filename("2010.06 (2).pdf").unwrap().text, "2010.06");
        assert_eq!(equip_from_filename("2026.14A part 2.PDF").unwrap().text, "2026.14A");
        assert!(equip_from_filename("doc13232423412412.pdf").is_none());
        assert!(equip_from_filename("20231012094512.pdf").is_none());
        assert!(equip_from_filename("Scan_0001.pdf").is_none());
    }

    #[test]
    fn folders() {
        assert_eq!(equip_folder("2010.03 (CS) V-3 PREFRACTIONATOR TOWER").unwrap().0.text, "2010.03");
        let (n, oos) = equip_folder("O - OOS - 2010.15 V-15 PREFRACTIONATOR OVERHEAD").unwrap();
        assert_eq!(n.text, "2010.15");
        assert!(oos);
        assert!(equip_folder("10 - VESSELS").is_none());
        assert!(equip_folder("CODE DOCUMENTS").is_none());
        assert_eq!(unit_of_folder("2000 - CRUDE UNIT"), Some(20));
        assert_eq!(item_of_folder("10 - VESSELS"), Some(10));
        assert_eq!(unit_folder(25), "2500 - DIESEL HYDROTREATER UNIT (DHT)");
        assert_eq!(item_folder(26), "26 - PUMPS (CENTRIFUGAL)");
    }

    #[test]
    fn names() {
        let n = parse_equip("2010.06").unwrap();
        assert_eq!(document_file_name(&n, "U-1A Manufacturer's Data Report", Some("1978-03-14"), None), "2010.06 U-1A Manufacturer's Data Report 1978-03-14.pdf");
        assert_eq!(document_file_name(&n, "2010.06 Drawing: Shell / Heads", None, Some("2010.15 V-15")), "2010.06 Drawing- Shell - Heads (as 2010.15 V-15) Undated.pdf");
        assert_eq!(document_file_name(&n, "UT Inspection 1999-10-21", Some("1999-10-21"), None), "2010.06 UT Inspection 1999-10-21.pdf");
        assert_eq!(equipment_folder_name(&n, "v-6", "light naphtha stabilizer tower"), "2010.06 V-6 LIGHT NAPHTHA STABILIZER TOWER");
        assert_eq!(valid_date("1978-03"), Some("1978-03".into()));
        assert!(valid_date("1978-13-01").is_none());
        assert!(valid_date("03/14/1978").is_none());
        assert_eq!(sanitize_component("A: B?. "), "A- B");
    }
}
