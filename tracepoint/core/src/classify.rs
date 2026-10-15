//! What kind of document a file is, read from its folder roles, name and
//! extension. Category names match the TracePoint 1.x CSV so its ranking
//! rules (inspection priority, photo grouping, drawing intent) carry over.

use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, PartialOrd, Ord)]
pub enum Category {
    Inspection,
    Drawings,
    Pid,
    Datasheets,
    CodeDocuments,
    Calculations,
    ServiceReports,
    Procedures,
    Certificates,
    Photos,
    Email,
    General,
}

impl Category {
    pub const ALL: [Category; 12] = [
        Category::Inspection,
        Category::Drawings,
        Category::Pid,
        Category::Datasheets,
        Category::CodeDocuments,
        Category::Calculations,
        Category::ServiceReports,
        Category::Procedures,
        Category::Certificates,
        Category::Photos,
        Category::Email,
        Category::General,
    ];
    pub fn label(self) -> &'static str {
        match self {
            Category::Inspection => "Inspection / MI",
            Category::Drawings => "Drawings",
            Category::Pid => "P&ID",
            Category::Datasheets => "Datasheets",
            Category::CodeDocuments => "Code Documents",
            Category::Calculations => "Calculations",
            Category::ServiceReports => "Service Reports",
            Category::Procedures => "Procedures & Manuals",
            Category::Certificates => "Certificates & MTRs",
            Category::Photos => "Photos",
            Category::Email => "Email",
            Category::General => "General",
        }
    }
    pub fn from_label(s: &str) -> Option<Category> {
        Category::ALL.into_iter().find(|c| c.label().eq_ignore_ascii_case(s))
    }
    /// Words a query can use to mean this category (stemmed forms).
    pub fn words(self) -> &'static [&'static str] {
        match self {
            Category::Inspection => &["inspection", "mi"],
            Category::Drawings => &["drawing", "iso"],
            Category::Pid => &["pid"],
            Category::Datasheets => &["datasheet", "data"],
            Category::CodeDocuments => &["code", "u1a", "mrb", "nameplate"],
            Category::Calculations => &["calculation"],
            Category::ServiceReports => &["service"],
            Category::Procedures => &["procedure", "manual"],
            Category::Certificates => &["certificate", "mtr"],
            Category::Photos => &["photo"],
            Category::Email => &["email"],
            Category::General => &[],
        }
    }
}

/// Folder role as recorded by the THOR indexer or recognised by name here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirRole {
    None,
    Inspection,
    Drawings,
    Pid,
    Datasheets,
    CodeDocuments,
    Calculations,
    Archive,
    Photos,
    Email,
    ServiceReports,
    Procedures,
    Certificates,
    Templates,
}

impl DirRole {
    pub fn from_indexer(role: &str) -> DirRole {
        match role {
            "inspection" => DirRole::Inspection,
            "drawings" => DirRole::Drawings,
            "p_and_id" => DirRole::Pid,
            "datasheets" => DirRole::Datasheets,
            "code_documents" => DirRole::CodeDocuments,
            "calculations" => DirRole::Calculations,
            "archive" => DirRole::Archive,
            _ => DirRole::None,
        }
    }

    /// Recognise a folder by its own name (covers names the indexer missed,
    /// e.g. "DATA SHEETS", "PICTURES", "2018-02-22 EXT UT").
    pub fn from_name(name: &str) -> DirRole {
        static R: LazyLock<Vec<(Regex, DirRole)>> = LazyLock::new(|| {
            let v: Vec<(&str, DirRole)> = vec![
                (r"(?i)\barchive[sd]?\b|\bold\b|\bsuperseded\b|\bobsolete\b|\bvoid(ed)?\b", DirRole::Archive),
                (r"(?i)\btemplates?\b|\bblanks?\b|\bforms\b", DirRole::Templates),
                (r"(?i)\bp\s*&\s*id|\bpids?\b", DirRole::Pid),
                (r"(?i)\bphotos?\b|\bpictures?\b|\bimages\b|\bpics\b|screen ?shots", DirRole::Photos),
                (r"(?i)\be-?mails?\b|\bcorrespondence\b", DirRole::Email),
                (r"(?i)data ?sheets?\b", DirRole::Datasheets),
                (r"(?i)\bcalc(ulation)?s?\b", DirRole::Calculations),
                (r"(?i)\bcode doc|\bu-?1a\b|\bmrb\b|\bnameplate", DirRole::CodeDocuments),
                (r"(?i)\bservice reports?\b|\bpsv service", DirRole::ServiceReports),
                (r"(?i)\bprocedures?\b|\bmanuals?\b|\bsops?\b|\bwps\b|\bpqr\b", DirRole::Procedures),
                (r"(?i)\bcerts?\b|\bcertificates?\b|\bmtrs?\b|\bheat numbers\b", DirRole::Certificates),
                (r"(?i)\biso(metric)?s?\b.*draw|\bdrawings?\b|\bdwgs?\b|\bsketch", DirRole::Drawings),
                (r"(?i)\binspections?\b|\b(ext|int)(ernal)?\b.*\b(ut|insp|visual)|\but survey\b|\but\b|\bosi\b|\bvisual\b|\bapi[- ]?(510|570|653)\b|\bthickness\b|\bcorrosion\b|\bturnaround\b|\bpit stop\b|\bcui\b", DirRole::Inspection),
            ];
            v.into_iter().map(|(p, r)| (Regex::new(p).unwrap(), r)).collect()
        });
        for (re, role) in R.iter() {
            if re.is_match(name) {
                return *role;
            }
        }
        DirRole::None
    }
}

pub const PHOTO_EXT: &[&str] = &[".jpg", ".jpeg", ".png", ".heic", ".bmp", ".gif", ".webp", ".jfif"];
pub const JUNK_EXT: &[&str] = &[".db", ".lnk", ".bak", ".tmp", ".ini", ".log", ".dwl", ".dwl2", ".plf", ".fm3track", ".sv$", ".ds_store"];

pub fn is_photo_ext(ext: &str) -> bool {
    PHOTO_EXT.contains(&ext)
}

pub fn is_junk(name: &str, ext: &str) -> bool {
    let n = name.to_ascii_lowercase();
    JUNK_EXT.contains(&ext) || n == "thumbs.db" || n == "desktop.ini" || n.starts_with("~$") || n.starts_with("._")
}

pub fn is_blank_template(name: &str) -> bool {
    static R: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(^|[^a-z])(blank|template)([^a-z]|$)").unwrap());
    R.is_match(name)
}

/// Category and a finer document type from the folder role chain (nearest
/// first), the file name and its extension.
pub fn classify(name: &str, ext: &str, roles: &[DirRole]) -> (Category, &'static str) {
    static NAME_RULES: LazyLock<Vec<(Regex, Category, &'static str)>> = LazyLock::new(|| {
        let v: Vec<(&str, Category, &str)> = vec![
            (r"(?i)inspection drawing|field[-_ ]?drawing|\bisometric\b.*insp", Category::Inspection, "Inspection Drawing"),
            (r"(?i)field[-_ ]?notes", Category::Inspection, "Field Notes"),
            (r"(?i)field[-_ ]?data", Category::Inspection, "Field Data"),
            (r"(?i)check ?list", Category::Inspection, "Inspection Checklist"),
            (r"(?i)\but\b.*\b(survey|inspection|technique|report)|\but survey\b|\bultrapipe\b|thickness", Category::Inspection, "UT Inspection"),
            (r"(?i)\bosi\b|on[-_ ]?stream", Category::Inspection, "On-Stream Inspection"),
            (r"(?i)\b(ext|external)\b.*\b(insp|visual|report)|\bexternal inspection", Category::Inspection, "External Inspection"),
            (r"(?i)\b(int|internal)\b.*\b(insp|visual|report)|\binternal inspection", Category::Inspection, "Internal Inspection"),
            (r"(?i)\bvisual\b|\bapi[- ]?(510|570|653)\b", Category::Inspection, "Visual Inspection"),
            (r"(?i)\bir scan\b|\binfrared\b|\bthermograph", Category::Inspection, "IR Inspection"),
            (r"(?i)\bevt\b|\bnde\b|\bmt\b.*test|\bpt\b.*test|\brt\b.*test|\bpmi\b|\bhardness\b", Category::Inspection, "NDE Record"),
            (r"(?i)complete[-_ ]?report|inspection report|\breport\b.*\binsp|\binsp.*\breport\b", Category::Inspection, "Inspection Report"),
            (r"(?i)\bservice report\b|\bpsv\b.*(test|service)|\bpop test\b|\bset pressure\b", Category::ServiceReports, "Service Report"),
            (r"(?i)\bclosure form\b|\bturnover package\b|\bwork order\b|\bmoc\b", Category::General, "Work Record"),
            (r"(?i)\bu-?1a\b|\bmrb\b|\bnameplate\b|\bnational board\b|\bman(ufacturer)?'?s? data report\b|\bmdr\b|\br-?1\b report|\br-?2\b", Category::CodeDocuments, "Code Document"),
            (r"(?i)\bp\s*&\s*id\b|\bpid\b", Category::Pid, "P&ID"),
            (r"(?i)data ?sheet|\bspec sheet\b|\bdata\b\.", Category::Datasheets, "Datasheet"),
            (r"(?i)\bcalc(ulation)?s?\b|\bmawp\b|\bretirement\b|\bfitness\b|\bffs\b|\bremaining life\b", Category::Calculations, "Calculation"),
            (r"(?i)\bmtrs?\b|\bheat numbers?\b|\bcert(ificate|s)?\b|\bmaterial report\b|\bsds\b", Category::Certificates, "Certificate / MTR"),
            (r"(?i)\bprocedure\b|\bmanual\b|\bsop\b|\bwps\b|\bpqr\b|\binstruction", Category::Procedures, "Procedure / Manual"),
            (r"(?i)(^|[^a-z])(sht|sheet)[\s_-]*\d|\d{4}[\s_-]?[a-z][\s_-]?\d{3,}|\bdrawing|\bdwg\b|\bga\b|\bsketch|\bautocad\b|\bplot plan\b|(^|[^a-z])iso([^a-z]|$)", Category::Drawings, "Drawing"),
            (r"(?i)\breport\b", Category::Inspection, "Report"),
        ];
        v.into_iter().map(|(p, c, t)| (Regex::new(p).unwrap(), c, t)).collect()
    });

    if ext == ".msg" || ext == ".eml" {
        return (Category::Email, "Email");
    }
    let nearest = roles.iter().copied().find(|r| !matches!(r, DirRole::None | DirRole::Archive | DirRole::Templates));
    if is_photo_ext(ext) {
        // A scanned drawing saved as JPG under DRAWINGS is still a drawing.
        if matches!(nearest, Some(DirRole::Drawings) | Some(DirRole::Pid)) {
            return (Category::Drawings, "Drawing Image");
        }
        if matches!(nearest, Some(DirRole::Datasheets)) {
            return (Category::Datasheets, "Datasheet Image");
        }
        let insp = roles.iter().any(|r| *r == DirRole::Inspection);
        return (Category::Photos, if insp { "Inspection Photo" } else { "Photo" });
    }
    if ext == ".dwg" || ext == ".dxf" || ext == ".dgn" {
        return (Category::Drawings, "CAD Drawing");
    }
    // Underscores join words in THOR names ("56_5610.15_report_022218");
    // treat them as spaces so word rules see "report".
    let stem = name.rsplit_once('.').map(|(a, _)| a).unwrap_or(name).replace('_', " ");
    let by_name = NAME_RULES.iter().find(|(re, _, _)| re.is_match(&stem)).map(|(_, c, t)| (*c, *t));
    let by_role = nearest.map(|r| match r {
        DirRole::Inspection => (Category::Inspection, "Inspection / MI Record"),
        DirRole::Drawings => (Category::Drawings, "Drawing"),
        DirRole::Pid => (Category::Pid, "P&ID"),
        DirRole::Datasheets => (Category::Datasheets, "Datasheet"),
        DirRole::CodeDocuments => (Category::CodeDocuments, "Code Document"),
        DirRole::Calculations => (Category::Calculations, "Calculation"),
        DirRole::Photos => (Category::Photos, "Photo Document"),
        DirRole::Email => (Category::Email, "Email Attachment"),
        DirRole::ServiceReports => (Category::ServiceReports, "Service Report"),
        DirRole::Procedures => (Category::Procedures, "Procedure / Manual"),
        DirRole::Certificates => (Category::Certificates, "Certificate / MTR"),
        _ => (Category::General, "Document"),
    });
    match (by_name, by_role) {
        // An inspection-specific name wins inside any folder; a generic
        // "Report"/"Drawing" name defers to a more specific folder role.
        (Some((c, t)), Some((rc, rt))) => {
            if (t == "Report" || t == "Drawing") && rc != Category::General && rc != c {
                (rc, rt)
            } else {
                (c, t)
            }
        }
        (Some(x), None) => x,
        (None, Some(x)) => x,
        (None, None) => (Category::General, "Document"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn categories() {
        let insp = [DirRole::Inspection];
        assert_eq!(classify("56_5610.15_report_022218.pdf", ".pdf", &insp).0, Category::Inspection);
        assert_eq!(classify("kern-oil_v-02_field-notes_111412.pdf", ".pdf", &insp).1, "Field Notes");
        assert_eq!(classify("IMG_2201.jpg", ".jpg", &insp), (Category::Photos, "Inspection Photo"));
        assert_eq!(classify("5610.15 DRAWING.pdf", ".pdf", &[DirRole::Drawings]).0, Category::Drawings);
        assert_eq!(classify("3002-D 1086_SHT06_R50_02-27-25.pdf", ".pdf", &[]).0, Category::Drawings);
        assert_eq!(classify("U-1A.pdf", ".pdf", &[]).0, Category::CodeDocuments);
        assert_eq!(classify("V-02 report.msg", ".msg", &[]).0, Category::Email);
        assert_eq!(classify("CRU-FE-100_P&ID.pdf", ".pdf", &[]).0, Category::Pid);
        assert_eq!(classify("56_5610.15_field-notes_022218.pdf", ".pdf", &[]).1, "Field Notes");
        assert_eq!(DirRole::from_name("DATA SHEETS"), DirRole::Datasheets);
        assert_eq!(DirRole::from_name("2018-02-22 EXT UT"), DirRole::Inspection);
        assert_eq!(DirRole::from_name("PICTURES"), DirRole::Photos);
        assert!(is_blank_template("BLANK_5610.15 V-2.pdf"));
        assert!(is_junk("Thumbs.db", ".db"));
    }
}
