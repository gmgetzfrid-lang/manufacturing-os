//! Working out what is in a scanned manila folder: which equipment it is,
//! where each document starts and ends, what each document is, what to call
//! it and where it goes. Two passes: a first reading, then an independent
//! check of that reading against the pages. Anything either pass is unsure
//! of is held for review instead of being filed.

use crate::claude::{self, Usage};
use crate::pages::PageInfo;
use crate::registry::Registry;
use crate::spec::{self, EquipNo};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Pages per request. Long folders are read in parts that overlap by two
/// pages so documents running across a part boundary are joined.
pub const CHUNK: usize = 36;
const CONTEXT_PAGES: usize = 2;
const MAX_TEXT_PER_PAGE: usize = 2500;
/// Per-request limits, well inside the API's (100 images, 32 MB).
const MAX_IMAGES: usize = 80;
const MAX_BYTES: u64 = 22_000_000;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct EquipmentCall {
    pub number: String,
    pub tag: String,
    pub description: String,
    pub existing_folder: String,
    pub confidence: String,
    pub evidence: String,
    pub matches_file_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct DocCall {
    pub first_page: u32,
    pub last_page: u32,
    pub continues_previous_part: bool,
    pub folder: String,
    pub title: String,
    pub date: String,
    pub date_basis: String,
    pub written_for_number: String,
    pub written_for_tag: String,
    pub relation: String,
    pub drawing_number: String,
    pub revision: String,
    pub summary: String,
    pub drop_pages: Vec<u32>,
    pub confidence: String,
    pub verdict: String,
    pub doubts: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Filing {
    pub equipment: EquipmentCall,
    pub documents: Vec<DocCall>,
    pub notes: String,
}

/// The JSON shape both passes answer in.
pub fn schema() -> Value {
    let s = |d: &str| json!({"type": "string", "description": d});
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["equipment", "documents", "notes"],
        "properties": {
            "equipment": {
                "type": "object",
                "additionalProperties": false,
                "required": ["number", "tag", "description", "existing_folder", "confidence", "evidence", "matches_file_name"],
                "properties": {
                    "number": s("Equipment number this folder belongs to, KOR Y-4 form (2010.06, 2026.14A, 2015-001, 55004). Empty if it cannot be determined."),
                    "tag": s("Plant tag in current use, e.g. V-6, P-32A, E-101, TK-2. Empty if unknown."),
                    "description": s("Short service description in capitals as it would appear on a folder, e.g. LIGHT NAPHTHA STABILIZER TOWER. Empty if unknown."),
                    "existing_folder": s("When existing folders are listed for this number, the exact name of the one these papers belong to; otherwise empty."),
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                    "evidence": s("Where the number and description were read (which pages, which stamp, nameplate or title block)."),
                    "matches_file_name": {"type": "string", "enum": ["yes", "no", "no_file_name"], "description": "Whether the papers are consistent with the equipment number in the scan's file name (history under older numbers counts as consistent)."}
                }
            },
            "documents": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["first_page", "last_page", "continues_previous_part", "folder", "title", "date", "date_basis", "written_for_number", "written_for_tag", "relation", "drawing_number", "revision", "summary", "drop_pages", "confidence", "verdict", "doubts"],
                    "properties": {
                        "first_page": {"type": "integer", "description": "First page of this document (scan page number)."},
                        "last_page": {"type": "integer", "description": "Last page of this document (scan page number)."},
                        "continues_previous_part": {"type": "boolean", "description": "True only for the first document of this part when it is the continuation of the last document of the previous part."},
                        "folder": {"type": "string", "enum": spec::doc_folder_names()},
                        "title": s("What the document is, for the file name: type first, then specifics. No equipment number, no date. E.g. 'U-1A Manufacturer's Data Report', 'Drawing 2010-D 1041 General Arrangement Rev 2', 'UT Thickness Survey', 'Letter - State Repair Approval'."),
                        "date": s("The document's own date as YYYY-MM-DD, YYYY-MM or YYYY. Empty if the document carries no date."),
                        "date_basis": s("What the date is (signed, issued, inspection performed, revision date, stamped received) and where it was read."),
                        "written_for_number": s("Equipment number written on the document if different from the folder's number (older number, other equipment in this equipment's history). Empty otherwise."),
                        "written_for_tag": s("Tag written on the document if different from the current tag. Empty otherwise."),
                        "relation": {"type": "string", "enum": ["same_equipment", "former_identity", "other_equipment_history", "unidentified"], "description": "How this document relates to the folder's equipment."},
                        "drawing_number": s("Drawing number for drawings, as printed. Empty otherwise."),
                        "revision": s("Revision as printed (e.g. 2, B). Empty if none."),
                        "summary": s("One plain sentence describing the content, for the index."),
                        "drop_pages": {"type": "array", "items": {"type": "integer"}, "description": "Pages inside this document that are completely blank (back sides) and can be left out. Never list a page with any writing, stamp or mark."},
                        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                        "verdict": {"type": "string", "enum": ["first_look", "confirmed", "corrected", "uncertain"]},
                        "doubts": s("Anything uncertain about this document's boundaries, type, title or date. Empty if none.")
                    }
                }
            },
            "notes": s("Anything about the folder as a whole a records clerk should know. Empty if nothing.")
        }
    })
}

pub fn system_prompt() -> String {
    let units = spec::UNITS.iter().map(|(u, n)| format!("{u:02} {n}")).collect::<Vec<_>>().join("; ");
    let items = spec::ITEMS.iter().map(|(i, n)| format!("{i:02} {n}")).collect::<Vec<_>>().join("; ");
    let folders = spec::DOC_FOLDERS.iter().map(|(n, d)| format!("- {n}: {d}")).collect::<Vec<_>>().join("\n");
    format!(
        r#"You are the records clerk turning a refinery's paper engineering files into a digital archive. Kern Oil & Refining (Bakersfield) kept one manila folder per piece of equipment in filing cabinets. Each folder is scanned as one PDF. Your job is to read every page and say exactly how to split the scan into separate documents, what each one is, what to call it and where it goes. People will find these files years from now only by their names and folders, so names must say precisely what each document is and which equipment it belongs to.

NUMBERING STANDARD (KOR Y-4)
Equipment number UUII.SS: UU = unit, II = item category, SS = sequence; an optional letter suffix (2010.31B). Example 2010.03 = Crude Unit, Vessels, #03 (V-3 Prefractionator Tower). Piping circuits are written UUII-SSS (2015-001). Tanks have five-digit numbers: capacity in thousands of barrels + sequence (55004).
Drawing numbers look like 2015-B 2003 = unit 20, item 15, sheet size B, drawing 2003. Sheet sizes: A 8.5x11, B 11x17, C 17x22, D 24x36, E 34x44, R roll. Older drawings may carry the superseded chronological numbers (1-1999).
Units: {units}.
Items: {items}.

WHAT IS IN A FOLDER
A folder holds the history of one piece of equipment: drawings, ASME/National Board code forms (U-1, U-1A, R-1, R-2 ...), nameplate rubbings, inspection reports, UT readings, letters, purchase orders, vendor manuals, photos, handwritten notes. Equipment is sometimes repurposed or renumbered, so a folder can hold papers written under another number or tag (for example a drawing titled V-15 in the folder for 2010.06, because this vessel used to be V-15). Those papers belong in this folder as its history: keep them with this equipment and record the number or tag they were written under.

HOW TO SPLIT
A document is one thing a person would file as one item: a whole drawing, one code form with its attached sheets, one report with its appendices and attached readings, one letter with its enclosures only if the enclosure is not a separately identifiable document, one purchase order, one set of photos taken together. Clues that a new document starts: a new title block or letterhead, a different form, "Page 1 of N" or page numbering restarting, a change of date, author, subject or paper type, a cover or transmittal sheet. Clues that pages belong together: continuous page numbers, "continued", the same report number, the same form number, the same handwriting and subject. A transmittal or cover letter that only forwards one document goes with that document; a letter with its own subject stands alone. Each page belongs to exactly one document; together the documents must cover every page of the scan, in order, without gaps or overlaps. Back sides that are completely blank go in drop_pages of the document they sit in; never drop a page with any writing, stamp or mark.

WHERE EACH DOCUMENT GOES (folder inside the equipment folder)
{folders}

TITLES
The file name is built as: <equipment number> <title> <date>.pdf, e.g.
  2010.06 U-1A Manufacturer's Data Report 1978-03-14.pdf
  2010.06 R-1 Repair Report - Shell Nozzle N-3 1994-08-02.pdf
  2010.06 Drawing 2010-D 1041 General Arrangement Rev 2 1981-06-02.pdf
  2010.06 UT Thickness Survey 1999-10-21.pdf
  2010.06 Letter - State Repair Approval 2001-05-03.pdf
  2010.06 Nameplate Rubbing Undated.pdf
Give only the title part: document type first, then the specifics that tell it apart from similar documents (form number, drawing number and name, revision, component or nozzle, report number, vendor, PO number). Title Case, plain words, no equipment number, no date, no file extension, no slashes, at most about 80 characters. Do not invent: use what is on the page. If the document was written under another number or tag, still title it plainly; the app adds "(as 2010.15 V-15)".

DATES
Use the date that best identifies the document: date signed or issued for forms and letters, date performed for inspections, revision date for drawings (the latest revision shown), PO date for orders. Write it YYYY-MM-DD; if only month and year or only year is known, write YYYY-MM or YYYY. Two-digit years are 19xx unless the content makes 20xx clear. If no date is on the document, leave it empty (it will be named "Undated"); never guess a date from nearby documents.

EQUIPMENT
Determine the folder's equipment from the papers (nameplates, U-1A, title blocks, inspection headers, folder labels if scanned). When the scan's file name carries an equipment number, that is the number the person filed it under: confirm the papers fit it (allowing for history under older numbers) and say "no" in matches_file_name only if the papers clearly belong to different equipment. When existing folders are listed for the number, pick the exact folder these papers belong to (for example the carbon-steel vessel versus the out-of-service stainless one) or leave existing_folder empty if you cannot tell. The tag and description are for naming a new folder, so give the equipment's current tag and service in capitals as a folder would show it (e.g. V-6, LIGHT NAPHTHA STABILIZER TOWER).

CONFIDENCE
high: you would stake your name on it. medium: probably right but a careful clerk would glance at it. low: a guess. Use doubts to say exactly what is unclear. It is far better to flag a document than to file it wrong: a wrongly filed document is effectively lost."#
    )
}

/// Build the page content for one part: context pages first (marked), then
/// this part's pages, each with its OCR text and image(s).
fn page_blocks(pages: &[PageInfo], part: std::ops::Range<usize>, context: std::ops::Range<usize>) -> Vec<Value> {
    let mut out = Vec::new();
    let img = |path: &str| -> Option<Value> {
        let b = std::fs::read(path).ok()?;
        Some(json!({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64::engine::general_purpose::STANDARD.encode(b)}}))
    };
    let mut add = |p: &PageInfo, ctx: bool| {
        let mut text: String = p.text.chars().take(MAX_TEXT_PER_PAGE).collect();
        if text.trim().is_empty() {
            text = "(no machine-readable text)".into();
        }
        let blank = if crate::pages::looks_blank(p) { ", appears blank" } else { "" };
        let ctx_note = if ctx { " — CONTEXT ONLY, already assigned in the previous part" } else { "" };
        out.push(json!({"type": "text", "text": format!("=== Scan page {} (sheet size {}{blank}){ctx_note} ===\nOCR text (may contain errors):\n{text}", p.index + 1, p.sheet())}));
        if let Some(v) = img(&p.image) {
            out.push(v);
        }
        if let Some(c) = &p.closeup {
            if let Some(v) = img(c) {
                out.push(json!({"type": "text", "text": format!("Close-up of the lower right (title block area) of scan page {}:", p.index + 1)}));
                out.push(v);
            }
        }
    };
    for p in &pages[context] {
        add(p, true);
    }
    for p in &pages[part] {
        add(p, false);
    }
    out
}

fn page_cost(p: &PageInfo) -> (usize, u64) {
    let size = |f: &str| std::fs::metadata(f).map(|m| m.len()).unwrap_or(400_000);
    let mut images = 1;
    let mut bytes = size(&p.image);
    if let Some(c) = &p.closeup {
        images += 1;
        bytes += size(c);
    }
    // Base64 adds a third.
    (images, bytes * 4 / 3 + p.text.len().min(MAX_TEXT_PER_PAGE) as u64)
}

/// Split the scan into parts that fit one request: at most CHUNK pages,
/// MAX_IMAGES images and MAX_BYTES of encoded content (context pages
/// included).
pub fn partitions(pages: &[PageInfo]) -> Vec<std::ops::Range<usize>> {
    let mut parts = vec![];
    let mut start = 0;
    while start < pages.len() {
        let ctx_start = start.saturating_sub(if start == 0 { 0 } else { CONTEXT_PAGES });
        let (mut images, mut bytes) = (0usize, 0u64);
        for p in &pages[ctx_start..start] {
            let (i, b) = page_cost(p);
            images += i;
            bytes += b;
        }
        let mut end = start;
        while end < pages.len() && end - start < CHUNK {
            let (i, b) = page_cost(&pages[end]);
            if end > start && (images + i > MAX_IMAGES || bytes + b > MAX_BYTES) {
                break;
            }
            images += i;
            bytes += b;
            end += 1;
        }
        parts.push(start..end);
        start = end;
    }
    if parts.is_empty() {
        parts.push(0..0);
    }
    parts
}

pub struct Context<'a> {
    pub file_name: &'a str,
    pub file_equip: Option<&'a EquipNo>,
    pub registry: &'a Registry,
}

fn context_text(ctx: &Context, total: usize, part: &std::ops::Range<usize>, nparts: usize, k: usize, prev_last: Option<&DocCall>) -> String {
    let mut s = format!("Scan file name: {}\nTotal pages in this scan: {total}\n", ctx.file_name);
    match ctx.file_equip {
        Some(n) => {
            s.push_str(&format!("Equipment number from the file name: {}\n", n.text));
            let found = ctx.registry.find(n);
            if found.is_empty() {
                s.push_str("No folder exists yet for this number; a new one will be created from your tag and description.\n");
            } else {
                s.push_str("Existing folders for this number:\n");
                for e in found {
                    s.push_str(&format!("  - {}{}\n", e.folder_name, if e.oos { " (out of service)" } else { "" }));
                }
            }
        }
        None => s.push_str("The file name carries no equipment number: work out the equipment from the papers.\n"),
    }
    if nparts > 1 {
        s.push_str(&format!("This scan is read in {nparts} parts. This is part {} of {nparts}: scan pages {}-{}.\n", k + 1, part.start + 1, part.end));
        if let Some(d) = prev_last {
            s.push_str(&format!(
                "The previous part ended with this document (pages {}-{}): {} [{}], date {}. If the first pages here continue it, start your list with that continuation and set continues_previous_part.\n",
                d.first_page, d.last_page, d.title, d.folder, if d.date.is_empty() { "none" } else { &d.date }
            ));
        }
    }
    s
}

const FIRST_TASK: &str = "Read every page above. Return the folder's equipment and the list of documents for the scan pages of this part (not the context-only pages), in page order, covering every page of this part exactly once. Set verdict to \"first_look\" for every document.";

const CHECK_TASK: &str = "Above is a first reading of these pages by another clerk. Check it page by page against the scan as if your own name goes on the result: the split points (does each document really start and end there; are two documents merged or one split in two?), the folder, the title (accurate, specific, nothing invented), the date and what it is based on, and the equipment. Return the complete corrected filing in the same shape, covering every page of this part exactly once. For each document set verdict: \"confirmed\" if the first reading was right, \"corrected\" if you fixed it and are sure of your fix, \"uncertain\" if a person should look at it (say why in doubts). Keep the first reading's wording where it is already right.";

pub struct Outcome {
    pub filing: Filing,
    pub usage: Usage,
    pub first: Vec<Filing>,
}

/// Read the whole scan: both passes over every part, joined into one filing.
pub fn analyze(key: &str, model: &str, ctx: &Context, pages: &[PageInfo], cancel: &dyn Fn() -> bool, progress: &mut dyn FnMut(&str)) -> Result<Outcome, claude::ClaudeError> {
    let system = system_prompt();
    let schema = schema();
    let total = pages.len();
    let parts = partitions(pages);
    let nparts = parts.len();
    let mut usage = Usage::default();
    let mut joined = Filing::default();
    let mut firsts = Vec::new();
    for (k, part) in parts.into_iter().enumerate() {
        let context = if k == 0 { 0..0 } else { part.start.saturating_sub(CONTEXT_PAGES)..part.start };
        let prev_last = joined.documents.last().cloned();
        let mut content = vec![json!({"type": "text", "text": context_text(ctx, total, &part, nparts, k, prev_last.as_ref())})];
        content.extend(page_blocks(pages, part.clone(), context));
        // Everything so far is identical for both passes: cache it.
        if let Some(last) = content.last_mut() {
            last["cache_control"] = json!({"type": "ephemeral"});
        }
        progress(&format!("Reading pages {}-{}{}", part.start + 1, part.end, if nparts > 1 { format!(" (part {} of {nparts})", k + 1) } else { String::new() }));
        let mut c1 = content.clone();
        c1.push(json!({"type": "text", "text": FIRST_TASK}));
        let r1 = claude::ask(key, &claude::Request { model, effort: "high", system: &system, content: c1, schema: schema.clone(), max_tokens: 48_000 }, cancel)?;
        usage.add(&r1.usage);
        let first: Filing = serde_json::from_value(r1.json.clone()).map_err(|e| claude::ClaudeError { message: format!("Unexpected answer shape: {e}"), retryable: true, retry_after: 0 })?;
        progress(&format!("Checking pages {}-{}", part.start + 1, part.end));
        let mut c2 = content;
        c2.push(json!({"type": "text", "text": format!("FIRST READING:\n{}\n\n{CHECK_TASK}", serde_json::to_string_pretty(&r1.json).unwrap_or_default())}));
        let r2 = claude::ask(key, &claude::Request { model, effort: "high", system: &system, content: c2, schema: schema.clone(), max_tokens: 48_000 }, cancel)?;
        usage.add(&r2.usage);
        let checked: Filing = serde_json::from_value(r2.json).map_err(|e| claude::ClaudeError { message: format!("Unexpected answer shape: {e}"), retryable: true, retry_after: 0 })?;
        // Equipment: the first part decides; later parts only add evidence.
        if k == 0 {
            joined.equipment = checked.equipment.clone();
        } else if joined.equipment.number.is_empty() && !checked.equipment.number.is_empty() {
            joined.equipment = checked.equipment.clone();
        } else if !checked.equipment.number.is_empty() && spec::parse_equip(&checked.equipment.number).map(|n| n.text) != spec::parse_equip(&joined.equipment.number).map(|n| n.text) {
            joined.equipment.confidence = "low".into();
            joined.equipment.evidence.push_str(&format!(" | Part {} points to {} instead.", k + 1, checked.equipment.number));
        }
        if !checked.notes.trim().is_empty() {
            if !joined.notes.is_empty() {
                joined.notes.push(' ');
            }
            joined.notes.push_str(checked.notes.trim());
        }
        let mut docs = checked.documents;
        docs.sort_by_key(|d| (d.first_page, d.last_page));
        for (i, d) in docs.into_iter().enumerate() {
            if i == 0 && d.continues_previous_part && k > 0 {
                if let Some(prev) = joined.documents.last_mut() {
                    prev.last_page = prev.last_page.max(d.last_page);
                    prev.drop_pages.extend(d.drop_pages);
                    if d.verdict == "uncertain" {
                        prev.verdict = "uncertain".into();
                        prev.doubts = format!("{} {}", prev.doubts, d.doubts).trim().to_string();
                    }
                    continue;
                }
            }
            joined.documents.push(d);
        }
        firsts.push(first);
    }
    Ok(Outcome { filing: joined, usage, first: firsts })
}

/// Why a scan must wait for a person, if it must.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Decision {
    pub equipment: Option<EquipNo>,
    /// Relative folder path the documents go into.
    pub equipment_rel: Option<String>,
    pub new_folder: bool,
    pub problems: Vec<String>,
    /// Indexes of documents that need a look.
    pub flagged_docs: Vec<usize>,
}

/// Check a filing against the rules and the folders that exist. Repairs
/// what can safely be repaired (page coverage gaps from blank pages,
/// out-of-range page numbers) and lists everything else.
pub fn decide(f: &mut Filing, pages: &[PageInfo], file_equip: Option<&EquipNo>, reg: &Registry) -> Decision {
    let mut d = Decision::default();
    let total = pages.len() as u32;
    // ---- Equipment ----
    let model_no = spec::parse_equip(&f.equipment.number);
    let no = match (file_equip, &model_no) {
        (Some(fe), _) => {
            if f.equipment.matches_file_name == "no" {
                d.problems.push(format!("The papers look like they belong to {} rather than {} (the file name). {}", if f.equipment.number.is_empty() { "different equipment" } else { &f.equipment.number }, fe.text, f.equipment.evidence));
            }
            Some(fe.clone())
        }
        (None, Some(n)) => {
            if f.equipment.confidence != "high" {
                d.problems.push(format!("Equipment {} was worked out from the papers but not with certainty: {}", n.text, f.equipment.evidence));
            }
            Some(n.clone())
        }
        (None, None) => {
            // A tag alone may identify an existing folder.
            let hits = if f.equipment.tag.trim().is_empty() { vec![] } else { reg.find_by_tag(&f.equipment.tag, None) };
            if hits.len() == 1 && f.equipment.confidence == "high" {
                Some(hits[0].no.clone())
            } else {
                d.problems.push(format!("No equipment number could be found in the papers{}.", if f.equipment.tag.is_empty() { String::new() } else { format!(" (tag {})", f.equipment.tag) }));
                None
            }
        }
    };
    if let Some(n) = &no {
        let found = reg.find(n);
        let chosen = if found.len() == 1 {
            Some(found[0])
        } else if found.len() > 1 {
            let want = f.equipment.existing_folder.trim();
            let pick = found.iter().find(|e| e.folder_name.eq_ignore_ascii_case(want)).copied();
            if pick.is_none() {
                d.problems.push(format!("{} has {} folders ({}); which one these papers belong to isn't clear.", n.text, found.len(), found.iter().map(|e| e.folder_name.as_str()).collect::<Vec<_>>().join(" / ")));
            }
            pick
        } else {
            None
        };
        match chosen {
            Some(e) => d.equipment_rel = Some(e.rel.clone()),
            None if found.is_empty() => {
                if f.equipment.description.trim().is_empty() {
                    d.problems.push(format!("{} has no folder yet and the papers don't say clearly what it is, so the new folder can't be named. Enter its tag and description.", n.text));
                }
                d.equipment_rel = Some(reg.new_equipment_rel(n, &f.equipment.tag, &f.equipment.description));
                d.new_folder = true;
            }
            None => {}
        }
        d.equipment = Some(n.clone());
    }
    // ---- Documents ----
    let folders = spec::doc_folder_names();
    f.documents.retain(|x| x.last_page >= x.first_page && x.first_page >= 1);
    f.documents.sort_by_key(|x| (x.first_page, x.last_page));
    for x in f.documents.iter_mut() {
        x.last_page = x.last_page.min(total);
        x.date = spec::valid_date(&x.date).unwrap_or_default();
        x.title = x.title.trim().to_string();
    }
    // Coverage: every page exactly once.
    let mut owner = vec![usize::MAX; total as usize];
    let mut overlap = false;
    for (i, x) in f.documents.iter().enumerate() {
        for p in x.first_page..=x.last_page {
            let slot = &mut owner[(p - 1) as usize];
            if *slot != usize::MAX {
                overlap = true;
            }
            *slot = i;
        }
    }
    if overlap {
        d.problems.push("The reading assigned some pages to two documents.".into());
    }
    let missing: Vec<u32> = owner.iter().enumerate().filter(|(_, o)| **o == usize::MAX).map(|(p, _)| p as u32 + 1).collect();
    let mut unexplained = vec![];
    for p in missing {
        // A blank page left out between documents is fine: it is dropped.
        if crate::pages::looks_blank(&pages[(p - 1) as usize]) {
            continue;
        }
        unexplained.push(p);
    }
    if !unexplained.is_empty() {
        d.problems.push(format!("Pages not assigned to any document: {}", unexplained.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", ")));
    }
    if f.documents.is_empty() {
        d.problems.push("No documents were identified in this scan.".into());
    }
    for (i, x) in f.documents.iter().enumerate() {
        let mut why = vec![];
        if !folders.contains(&x.folder.as_str()) {
            why.push(format!("unknown folder '{}'", x.folder));
        }
        if x.title.is_empty() {
            why.push("no title".into());
        }
        if x.verdict == "uncertain" {
            why.push("the check was not sure".into());
        }
        if x.confidence == "low" {
            why.push("low confidence".into());
        }
        if !why.is_empty() {
            d.flagged_docs.push(i);
            let pages = if x.first_page == x.last_page { format!("page {}", x.first_page) } else { format!("pages {}-{}", x.first_page, x.last_page) };
            let label = if x.title.is_empty() { String::new() } else { format!(" \"{}\"", x.title) };
            let doubt = if x.doubts.trim().is_empty() { String::new() } else { format!(": {}", x.doubts.trim()) };
            d.problems.push(format!("Document {} ({pages}){label} — {}{doubt}", i + 1, why.join(", ")));
        }
    }
    d
}

/// Pages a document will actually contain: its range minus pages both the
/// reading and the ink measure call blank.
pub fn kept_pages(x: &DocCall, pages: &[PageInfo]) -> Vec<u32> {
    let mut v = vec![];
    for p in x.first_page..=x.last_page {
        let idx = p - 1;
        let Some(info) = pages.get(idx as usize) else { continue };
        if x.drop_pages.contains(&p) && crate::pages::looks_blank(info) {
            continue;
        }
        v.push(idx);
    }
    if v.is_empty() {
        // Never produce an empty document.
        v.push(x.first_page - 1);
    }
    v
}

/// "(as 2010.15 V-15)" for documents written under another identity.
pub fn as_other(x: &DocCall, no: &EquipNo) -> Option<String> {
    if !matches!(x.relation.as_str(), "former_identity" | "other_equipment_history") {
        return None;
    }
    let num = spec::parse_equip(&x.written_for_number).map(|n| n.text).filter(|t| *t != no.text);
    let tag = x.written_for_tag.trim().to_ascii_uppercase();
    match (num, tag.is_empty()) {
        (Some(n), false) => Some(format!("{n} {tag}")),
        (Some(n), true) => Some(n),
        (None, false) => Some(tag),
        (None, true) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(i: u32, ink: f32, text: &str) -> PageInfo {
        PageInfo { index: i, width_pt: 612.0, height_pt: 792.0, text: text.into(), had_text: false, ink, image: String::new(), closeup: None }
    }

    fn doc(a: u32, b: u32, folder: &str) -> DocCall {
        DocCall { first_page: a, last_page: b, folder: folder.into(), title: "Thing".into(), confidence: "high".into(), verdict: "confirmed".into(), relation: "same_equipment".into(), ..Default::default() }
    }

    #[test]
    fn schema_is_strict() {
        let s = schema();
        assert_eq!(s["additionalProperties"], false);
        assert_eq!(s["properties"]["documents"]["items"]["additionalProperties"], false);
        let req = s["properties"]["documents"]["items"]["required"].as_array().unwrap().len();
        let props = s["properties"]["documents"]["items"]["properties"].as_object().unwrap().len();
        assert_eq!(req, props);
        assert!(system_prompt().contains("2010.06 U-1A Manufacturer's Data Report 1978-03-14.pdf"));
    }

    #[test]
    fn decisions() {
        let reg = Registry::default();
        let pages: Vec<PageInfo> = (0..5).map(|i| page(i, if i == 2 { 0.0 } else { 0.05 }, if i == 2 { "" } else { "words words words" })).collect();
        let fe = spec::parse_equip("2010.06").unwrap();
        let mut f = Filing { equipment: EquipmentCall { number: "2010.06".into(), tag: "V-6".into(), description: "STABILIZER".into(), confidence: "high".into(), matches_file_name: "yes".into(), ..Default::default() }, documents: vec![doc(1, 2, "DRAWINGS"), doc(4, 5, "CODE DOCUMENTS")], notes: String::new() };
        let d = decide(&mut f, &pages, Some(&fe), &reg);
        assert!(d.problems.is_empty(), "{:?}", d.problems);
        assert!(d.new_folder);
        assert_eq!(d.equipment_rel.as_deref(), Some("2000 - CRUDE UNIT/10 - VESSELS/2010.06 V-6 STABILIZER"));
        // A page with writing left out is a problem.
        let mut f2 = f.clone();
        f2.documents = vec![doc(1, 1, "DRAWINGS"), doc(4, 5, "CODE DOCUMENTS")];
        let d2 = decide(&mut f2, &pages, Some(&fe), &reg);
        assert!(d2.problems.iter().any(|p| p.contains("not assigned")));
        // Uncertain documents are flagged.
        let mut f3 = f.clone();
        f3.documents[1].verdict = "uncertain".into();
        let d3 = decide(&mut f3, &pages, Some(&fe), &reg);
        assert_eq!(d3.flagged_docs, vec![1]);
        // A new folder needs a description to be named.
        let mut f5 = f.clone();
        f5.equipment.description = String::new();
        assert!(decide(&mut f5, &pages, Some(&fe), &reg).problems.iter().any(|p| p.contains("can't be named")));
        // No number anywhere: held.
        let mut f4 = f.clone();
        f4.equipment.number = String::new();
        f4.equipment.tag = String::new();
        let d4 = decide(&mut f4, &pages, None, &reg);
        assert!(d4.equipment.is_none());
        assert!(!d4.problems.is_empty());
    }

    #[test]
    fn blank_pages_dropped_only_when_both_agree() {
        let pages: Vec<PageInfo> = (0..3).map(|i| page(i, if i == 1 { 0.0 } else { 0.05 }, if i == 1 { "" } else { "a b c d" })).collect();
        let mut x = doc(1, 3, "DRAWINGS");
        x.drop_pages = vec![2, 3];
        assert_eq!(kept_pages(&x, &pages), vec![0, 2]);
    }

    #[test]
    fn parts_respect_limits() {
        let pages: Vec<PageInfo> = (0..100).map(|i| page(i, 0.05, "text")).collect();
        let parts = partitions(&pages);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], 0..36);
        assert_eq!(parts[2].end, 100);
        // Drawings with close-ups: 80 images max, so 40 pages less context.
        let mut big: Vec<PageInfo> = (0..50).map(|i| page(i, 0.05, "t")).collect();
        for p in big.iter_mut() {
            p.closeup = Some("/nonexistent".into());
        }
        let parts = partitions(&big);
        // 400 KB per missing image, x2 per page, x4/3: ~1.07 MB a page -> 20 pages.
        assert!(parts[0].len() <= 21 && parts[0].len() >= 18, "{:?}", parts[0]);
        assert_eq!(parts.last().unwrap().end, 50);
    }

    #[test]
    fn other_identity() {
        let no = spec::parse_equip("2010.06").unwrap();
        let mut x = doc(1, 1, "DRAWINGS");
        x.relation = "former_identity".into();
        x.written_for_number = "2010.15".into();
        x.written_for_tag = "v-15".into();
        assert_eq!(as_other(&x, &no).as_deref(), Some("2010.15 V-15"));
        x.relation = "same_equipment".into();
        assert!(as_other(&x, &no).is_none());
    }
}
