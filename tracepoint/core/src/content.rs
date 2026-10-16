//! Reading what's inside THOR documents, for full-text search and Ask THOR.
//!
//! Free and local first:
//! * PDFs: the text layer, through PDFium (the PDF engine in Google Chrome).
//! * Word / Excel / PowerPoint: the text in the file's XML.
//! * Text files.
//! * Scanned pages and image drawings: the OCR engine built into Windows
//!   10/11 (no install, no internet). Big drawings are OCR'd in tiles so the
//!   title block text is legible.
//!
//! Only files worth reading are read (`value`): photos, blank templates and
//! zero-byte files are skipped; inspection records, U-1As, datasheets,
//! drawings and calculations come first. Pages that still have no readable
//! text after OCR, on valuable files, are staged for optional AI reading,
//! which an administrator approves with a cost preview.
//!
//! THOR is only read: each file is read into memory and parsed from there.

use crate::classify::Category;
use crate::index::{FileRec, F_ARCHIVE, F_BLANK, F_JUNK, F_LATEST, F_ZERO};
use std::io::Read;

/// Characters on a page below which it's treated as having no text layer.
pub const MIN_PAGE_CHARS: usize = 40;
pub const MAX_FILE_BYTES: u64 = 120 * 1024 * 1024;
pub const MAX_PAGES: usize = 300;

#[derive(Clone, Debug, Default)]
pub struct PageText {
    pub page: u32,
    pub text: String,
    /// "text", "ocr", "xml", "plain" or "none".
    pub method: &'static str,
}

#[derive(Clone, Debug, Default)]
pub struct Extracted {
    pub pages: Vec<PageText>,
    pub page_count: u32,
    /// 1-based pages that have no usable text even after local OCR.
    pub unreadable: Vec<u32>,
    pub ocr_pages: u32,
    pub error: Option<String>,
    /// Document properties (PDF info / Office core.xml).
    pub meta: crate::card::DocMeta,
}

/// How much a file is worth reading (0..1). Drives order, OCR and AI staging.
pub fn value(f: &FileRec) -> f32 {
    if f.flags & (F_JUNK | F_ZERO | F_BLANK) != 0 || f.cat == Category::Photos || f.cat == Category::Email {
        return 0.0;
    }
    let base = match f.cat {
        Category::Inspection => 1.0,
        Category::CodeDocuments => 0.95,
        Category::Datasheets => 0.9,
        Category::Drawings | Category::Pid => 0.85,
        Category::Calculations => 0.85,
        Category::ServiceReports => 0.8,
        Category::Certificates => 0.6,
        Category::Procedures => 0.55,
        _ => 0.4,
    };
    let mut v: f32 = base;
    if f.flags & F_ARCHIVE != 0 {
        v *= 0.5;
    }
    if f.family.is_some() {
        v *= if f.flags & F_LATEST != 0 { 1.1 } else { 0.6 };
    }
    if !f.equip.is_empty() {
        v *= 1.1;
    }
    if let Some(y) = f.year {
        if y >= 2018 {
            v += 0.05;
        }
    }
    // A scan named by the copier says nothing; only its contents can.
    if crate::crawl::classify_filename(&f.name) == "MACHINE_GENERATED" && (f.ext == ".pdf" || is_image_ext(&f.ext)) {
        v = v.max(0.75);
    }
    v.min(1.0)
}

/// File types we can read.
pub fn readable_ext(ext: &str) -> bool {
    matches!(ext, ".pdf" | ".docx" | ".docm" | ".xlsx" | ".xlsm" | ".pptx" | ".txt" | ".csv" | ".log" | ".tif" | ".tiff" | ".png" | ".jpg" | ".jpeg" | ".bmp")
}

pub fn is_image_ext(ext: &str) -> bool {
    matches!(ext, ".tif" | ".tiff" | ".png" | ".jpg" | ".jpeg" | ".bmp")
}

// ── OCR ───────────────────────────────────────────────────────────────────

pub trait Ocr: Send + Sync {
    /// Largest image side the engine accepts.
    fn max_side(&self) -> u32;
    fn recognize(&self, img: &image::RgbaImage) -> Result<String, String>;
}

/// OCR with tiling for images larger than the engine accepts.
pub fn ocr_image(ocr: &dyn Ocr, img: &image::RgbaImage) -> Result<String, String> {
    let max = ocr.max_side().max(1000);
    let (w, h) = img.dimensions();
    if w <= max && h <= max {
        return ocr.recognize(img);
    }
    let overlap = max / 20;
    let step = max - overlap;
    let mut out = String::new();
    let mut y = 0;
    while y < h {
        let th = max.min(h - y);
        let mut x = 0;
        while x < w {
            let tw = max.min(w - x);
            let tile = image::imageops::crop_imm(img, x, y, tw, th).to_image();
            let t = ocr.recognize(&tile)?;
            if !t.trim().is_empty() {
                out.push_str(t.trim());
                out.push('\n');
            }
            if x + tw >= w {
                break;
            }
            x += step;
        }
        if y + th >= h {
            break;
        }
        y += step;
    }
    Ok(out)
}

#[cfg(windows)]
pub mod winocr {
    //! Windows.Media.Ocr: part of Windows 10/11, offline, uses the languages
    //! installed for the signed-in user.
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;

    pub struct WinOcr {
        engine: OcrEngine,
        max: u32,
    }

    // OcrEngine is an agile WinRT object; calls are made from one worker at a time.
    unsafe impl Send for WinOcr {}
    unsafe impl Sync for WinOcr {}

    impl WinOcr {
        pub fn new() -> Option<WinOcr> {
            unsafe {
                let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED);
            }
            let engine = OcrEngine::TryCreateFromUserProfileLanguages().ok()?;
            let max = OcrEngine::MaxImageDimension().unwrap_or(2600);
            Some(WinOcr { engine, max })
        }
    }

    impl super::Ocr for WinOcr {
        fn max_side(&self) -> u32 {
            self.max
        }
        fn recognize(&self, img: &image::RgbaImage) -> Result<String, String> {
            let (w, h) = img.dimensions();
            let mut bgra = img.as_raw().clone();
            for px in bgra.chunks_exact_mut(4) {
                px.swap(0, 2);
            }
            let e = |x: windows::core::Error| x.message().to_string();
            let buf = CryptographicBuffer::CreateFromByteArray(&bgra).map_err(e)?;
            let bmp = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&buf, BitmapPixelFormat::Bgra8, w as i32, h as i32, BitmapAlphaMode::Premultiplied).map_err(e)?;
            let res = self.engine.RecognizeAsync(&bmp).map_err(e)?.join().map_err(e)?;
            let mut out = String::new();
            for line in res.Lines().map_err(e)? {
                out.push_str(&line.Text().map_err(e)?.to_string_lossy());
                out.push('\n');
            }
            Ok(out)
        }
    }
}

// ── Extraction ────────────────────────────────────────────────────────────

pub struct Extractor {
    pdfium: Option<pdfium_render::prelude::Pdfium>,
    pub pdfium_error: Option<String>,
    ocr: Option<Box<dyn Ocr>>,
}

impl Extractor {
    /// `pdfium_lib`: path to pdfium.dll / libpdfium.so. `use_ocr`: try the
    /// Windows OCR engine.
    pub fn new(pdfium_lib: Option<&std::path::Path>, use_ocr: bool) -> Extractor {
        use pdfium_render::prelude::Pdfium;
        let (pdfium, pdfium_error) = match pdfium_lib {
            Some(p) => match Pdfium::bind_to_library(p.display().to_string()) {
                Ok(b) => (Some(Pdfium::new(b)), None),
                Err(e) => (None, Some(format!("PDF engine could not load: {e}"))),
            },
            None => (None, Some("PDF engine not available".into())),
        };
        #[allow(unused_mut)]
        let mut ocr: Option<Box<dyn Ocr>> = None;
        #[cfg(windows)]
        if use_ocr {
            ocr = winocr::WinOcr::new().map(|o| Box::new(o) as Box<dyn Ocr>);
        }
        let _ = use_ocr;
        Extractor { pdfium, pdfium_error, ocr }
    }

    pub fn with_ocr(mut self, ocr: Box<dyn Ocr>) -> Extractor {
        self.ocr = Some(ocr);
        self
    }

    /// One page as a PNG for AI reading, longest side `long_side` px.
    pub fn page_png(&self, bytes: Vec<u8>, ext: &str, page: u32, long_side: u32) -> Result<Vec<u8>, String> {
        use pdfium_render::prelude::*;
        let img = if ext == ".pdf" {
            let pdfium = self.pdfium.as_ref().ok_or("PDF engine not available")?;
            let doc = pdfium.load_pdf_from_byte_vec(bytes, None).map_err(|e| format!("Can't open PDF: {e}"))?;
            let pg = doc.pages().get((page.max(1) - 1) as i32).map_err(|e| format!("No page {page}: {e}"))?;
            let w = pg.width().value.max(1.0);
            let h = pg.height().value.max(1.0);
            let scale = long_side as f32 / w.max(h);
            let cfg = PdfRenderConfig::new().set_target_width((w * scale) as i32).set_maximum_height((h * scale) as i32);
            let bmp = pg.render_with_config(&cfg).map_err(|e| e.to_string())?;
            let img = bmp.as_image().map_err(|e| e.to_string())?;
            img
        } else {
            image::load_from_memory(&bytes).map_err(|e| e.to_string())?
        };
        let img = if img.width().max(img.height()) > long_side { img.thumbnail(long_side, long_side) } else { img };
        let mut out = std::io::Cursor::new(Vec::new());
        img.to_luma8().write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
        Ok(out.into_inner())
    }

    pub fn has_pdf(&self) -> bool {
        self.pdfium.is_some()
    }
    pub fn has_ocr(&self) -> bool {
        self.ocr.is_some()
    }

    /// Read one file's text. `ocr_budget`: most pages to OCR in this file.
    pub fn extract(&self, bytes: Vec<u8>, ext: &str, ocr_budget: u32) -> Extracted {
        let mut out = Extracted::default();
        let office_meta = matches!(ext, ".docx" | ".docm" | ".xlsx" | ".xlsm" | ".pptx").then(|| zip_text(&bytes, "docProps/core.xml").map(|x| crate::card::office_meta(&x))).flatten();
        let r = match ext {
            ".pdf" => self.pdf(bytes, ocr_budget, &mut out),
            ".docx" | ".docm" => office(&bytes, &["word/document.xml"], "w:t", &["w:p", "w:tab", "w:br"], &mut out),
            ".pptx" => office_prefix(&bytes, "ppt/slides/slide", "a:t", &["a:p"], &mut out),
            ".xlsx" | ".xlsm" => office(&bytes, &["xl/sharedStrings.xml"], "t", &["si"], &mut out),
            ".txt" | ".csv" | ".log" => {
                let t = String::from_utf8_lossy(&bytes[..bytes.len().min(2_000_000)]).into_owned();
                out.page_count = 1;
                out.pages.push(PageText { page: 1, text: t, method: "plain" });
                Ok(())
            }
            e if is_image_ext(e) => self.image(&bytes, ocr_budget, &mut out),
            _ => Err("unsupported type".into()),
        };
        if let Err(e) = r {
            out.error = Some(e);
        }
        if let Some(m) = office_meta {
            out.meta = m;
        }
        for p in out.pages.iter_mut() {
            p.text = tidy(&p.text);
        }
        out
    }

    fn image(&self, bytes: &[u8], ocr_budget: u32, out: &mut Extracted) -> Result<(), String> {
        out.page_count = 1;
        let Some(ocr) = &self.ocr else {
            out.unreadable.push(1);
            return Ok(());
        };
        if ocr_budget == 0 {
            out.unreadable.push(1);
            return Ok(());
        }
        let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
        // Keep big drawings legible but bounded: at most ~8000 px on a side.
        let img = if img.width().max(img.height()) > 8000 { img.thumbnail(8000, 8000) } else { img };
        let t = ocr_image(ocr.as_ref(), &img.to_rgba8())?;
        out.ocr_pages = 1;
        if t.trim().chars().count() < MIN_PAGE_CHARS {
            out.unreadable.push(1);
        }
        out.pages.push(PageText { page: 1, text: t, method: "ocr" });
        Ok(())
    }

    fn pdf(&self, bytes: Vec<u8>, mut ocr_budget: u32, out: &mut Extracted) -> Result<(), String> {
        use pdfium_render::prelude::*;
        let Some(pdfium) = &self.pdfium else {
            return Err(self.pdfium_error.clone().unwrap_or_else(|| "PDF engine not available".into()));
        };
        let doc = pdfium.load_pdf_from_byte_vec(bytes, None).map_err(|e| format!("Can't open PDF: {e}"))?;
        {
            let md = doc.metadata();
            let get = |t: PdfDocumentMetadataTagType| md.get(t).map(|x| x.value().trim().to_string()).filter(|v| !v.is_empty());
            out.meta = crate::card::DocMeta {
                title: get(PdfDocumentMetadataTagType::Title),
                author: get(PdfDocumentMetadataTagType::Author),
                creator: get(PdfDocumentMetadataTagType::Creator),
                producer: get(PdfDocumentMetadataTagType::Producer),
                created: get(PdfDocumentMetadataTagType::CreationDate).and_then(|d| crate::card::pdf_date(&d)),
                modified: get(PdfDocumentMetadataTagType::ModificationDate).and_then(|d| crate::card::pdf_date(&d)),
                ..Default::default()
            };
        }
        let pages = doc.pages();
        out.page_count = pages.len() as u32;
        for (i, page) in pages.iter().enumerate().take(MAX_PAGES) {
            let n = i as u32 + 1;
            let text = page.text().map(|t| t.all()).unwrap_or_default();
            if text.trim().chars().count() >= MIN_PAGE_CHARS {
                out.pages.push(PageText { page: n, text, method: "text" });
                continue;
            }
            // No text layer: OCR it if we can.
            match (&self.ocr, ocr_budget > 0) {
                (Some(ocr), true) => {
                    ocr_budget -= 1;
                    let w = page.width().value.max(1.0);
                    let h = page.height().value.max(1.0);
                    // ~200 dpi, longest side at most 6000 px.
                    let scale = (200.0 / 72.0f32).min(6000.0 / w.max(h));
                    let cfg = PdfRenderConfig::new().set_target_width((w * scale) as i32).set_maximum_height((h * scale) as i32);
                    let t = page
                        .render_with_config(&cfg)
                        .map_err(|e| e.to_string())
                        .and_then(|b| b.as_image().map_err(|e| e.to_string()))
                        .and_then(|img| ocr_image(ocr.as_ref(), &img.to_rgba8()))
                        .unwrap_or_default();
                    out.ocr_pages += 1;
                    if t.trim().chars().count() < MIN_PAGE_CHARS {
                        out.unreadable.push(n);
                    }
                    out.pages.push(PageText { page: n, text: t, method: "ocr" });
                }
                _ => {
                    out.unreadable.push(n);
                    if !text.trim().is_empty() {
                        out.pages.push(PageText { page: n, text, method: "text" });
                    }
                }
            }
        }
        Ok(())
    }
}

fn zip_text(bytes: &[u8], name: &str) -> Option<String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut f = z.by_name(name).ok()?;
    if f.size() > 50_000_000 {
        return None;
    }
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

/// Text of the `tag` elements, with a line break after each `breaks` element.
fn xml_text(xml: &str, tag: &str, breaks: &[&str]) -> String {
    let mut out = String::with_capacity(xml.len() / 4);
    let mut i = 0;
    let b = xml.as_bytes();
    let open = format!("<{tag}");
    while i < b.len() {
        if b[i] == b'<' {
            let end = match xml[i..].find('>') {
                Some(e) => i + e,
                None => break,
            };
            let el = &xml[i + 1..end];
            if let Some(name) = el.strip_prefix('/') {
                let name = name.trim();
                if breaks.contains(&name) {
                    out.push('\n');
                }
            } else if el.ends_with('/') {
                let name = el.trim_end_matches('/').split_whitespace().next().unwrap_or("");
                if breaks.contains(&name) {
                    out.push(if name.ends_with("tab") { '\t' } else { '\n' });
                }
            } else if xml[i..].starts_with(&open) && (el.len() == tag.len() || el.as_bytes().get(tag.len()).map(|c| *c == b' ').unwrap_or(false)) {
                let close = format!("</{tag}>");
                if let Some(c) = xml[end + 1..].find(&close) {
                    out.push_str(&unescape(&xml[end + 1..end + 1 + c]));
                    i = end + 1 + c + close.len();
                    continue;
                }
            }
            i = end + 1;
        } else {
            i += 1;
        }
    }
    out
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn office(bytes: &[u8], names: &[&str], tag: &str, breaks: &[&str], out: &mut Extracted) -> Result<(), String> {
    let mut text = String::new();
    for n in names {
        if let Some(x) = zip_text(bytes, n) {
            text.push_str(&xml_text(&x, tag, breaks));
        }
    }
    out.page_count = 1;
    out.pages.push(PageText { page: 1, text, method: "xml" });
    Ok(())
}

fn office_prefix(bytes: &[u8], prefix: &str, tag: &str, breaks: &[&str], out: &mut Extracted) -> Result<(), String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = (0..z.len()).filter_map(|i| z.by_index(i).ok().and_then(|f| f.name().ok().map(|n| n.to_string()))).filter(|n| n.starts_with(prefix) && n.ends_with(".xml")).collect();
    names.sort_by_key(|n| n.trim_start_matches(prefix).trim_end_matches(".xml").parse::<u32>().unwrap_or(0));
    for (i, n) in names.iter().enumerate() {
        let x = zip_text(bytes, n).unwrap_or_default();
        out.pages.push(PageText { page: i as u32 + 1, text: xml_text(&x, tag, breaks), method: "xml" });
    }
    out.page_count = names.len() as u32;
    Ok(())
}

/// Collapse runs of blank space; keep line structure (tables read row by row).
fn tidy(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank = 0;
    for line in s.lines() {
        let l = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if l.is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(&l);
        out.push('\n');
    }
    out.trim().to_string()
}

// ── AI reading (approved, paid) ───────────────────────────────────────────

/// Instructions for reading one page image (from Manufacturing OS's vision
/// indexing, tuned for THOR documents).
pub const AI_READ_PROMPT: &str = "You transcribe one page of a refinery mechanical-integrity document (inspection report, U-1A / data report, datasheet, drawing, calculation) so it can be searched. Output plain text only, no commentary.
- Transcribe all legible text in reading order.
- Tables: one row per line, cells separated by \" | \"; put the table's caption on the line above it.
- Drawings: first write the title block as lines \"DRAWING NO:\", \"SHEET:\", \"REV:\", \"TITLE:\", \"DATE:\"; then every equipment number, tag (V-2, E-814, PSV-601B, TK-1100), nozzle schedule, dimension callout and note you can read.
- Keep numbers, units and designations exactly as written (e.g. 0.312\", t-min, SA-516-70, ASME VIII Div 1).
- Mark unreadable parts as [illegible]. Never guess.
- If the page has no text at all (blank, or a photo without writing), reply exactly: EMPTY";

/// The cheapest model with vision for each provider, used for AI reading.
pub fn vision_model(provider: crate::ai::Provider) -> &'static str {
    match provider {
        crate::ai::Provider::Anthropic => "claude-haiku-5-5",
        crate::ai::Provider::Openai => "gpt-5-mini",
        crate::ai::Provider::Gemini => "gemini-2.5-flash-lite",
    }
}

/// Typical tokens per page read by AI: (input incl. the image, output).
pub const AI_PAGE_TOKENS: (u64, u64) = (1900, 600);
pub const AI_PAGE_MAX_OUTPUT: u32 = 1500;

pub fn save_ai_page(c: &rusqlite::Connection, file_id: &str, page: u32, text: &str, cost: f64, now: &str) -> rusqlite::Result<()> {
    use rusqlite::params;
    let t = text.trim();
    if !t.is_empty() && t != "EMPTY" {
        c.execute("DELETE FROM content_fts WHERE file_id=?1 AND page=?2", params![file_id, page])?;
        c.execute("INSERT INTO content_fts(text, file_id, page, method) VALUES(?1,?2,?3,'ai')", params![tidy(t), file_id, page])?;
    }
    c.execute(
        "UPDATE ai_stage SET status=?3, done_at=?4, cost_usd=?5 WHERE file_id=?1 AND page=?2",
        params![file_id, page, if t == "EMPTY" { "empty" } else { "done" }, now, cost],
    )?;
    Ok(())
}

// ── Storage ───────────────────────────────────────────────────────────────

/// The content database lives next to the index (thor_content.db), so the
/// index stays small to copy and the text is shared with the team.
pub fn ensure_schema(c: &rusqlite::Connection) -> rusqlite::Result<()> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS content_files(file_id TEXT PRIMARY KEY, path TEXT, size INTEGER, mtime_ns INTEGER, value REAL,
           pages INTEGER, text_pages INTEGER, ocr_pages INTEGER, unreadable INTEGER, chars INTEGER, status TEXT, error TEXT, extracted_at TEXT);
         CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(text, file_id UNINDEXED, page UNINDEXED, method UNINDEXED, tokenize='porter unicode61');
         CREATE TABLE IF NOT EXISTS cards(file_id TEXT PRIMARY KEY, card TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS ai_stage(file_id TEXT NOT NULL, page INTEGER NOT NULL, value REAL NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'staged',
           staged_at TEXT, done_at TEXT, cost_usd REAL, PRIMARY KEY(file_id, page));",
    )
}

/// Saves one file's text, replacing what was there.
#[allow(clippy::too_many_arguments)]
pub fn save(c: &rusqlite::Connection, file_id: &str, path: &str, size: i64, mtime_ns: i64, value: f32, x: &Extracted, card: Option<&crate::card::Card>, allow_ai: bool, now: &str) -> rusqlite::Result<()> {
    use rusqlite::params;
    match card {
        Some(k) => {
            c.execute("INSERT OR REPLACE INTO cards(file_id, card) VALUES(?1,?2)", params![file_id, crate::card::to_json(k)])?;
        }
        None => {
            c.execute("DELETE FROM cards WHERE file_id=?1", [file_id])?;
        }
    }
    c.execute("DELETE FROM content_fts WHERE file_id=?1", [file_id])?;
    let mut chars = 0usize;
    let mut text_pages = 0;
    {
        let mut st = c.prepare_cached("INSERT INTO content_fts(text, file_id, page, method) VALUES(?1,?2,?3,?4)")?;
        for p in &x.pages {
            if p.text.trim().is_empty() {
                continue;
            }
            chars += p.text.len();
            text_pages += 1;
            st.execute(params![p.text, file_id, p.page, p.method])?;
        }
    }
    let status = if x.error.is_some() { "error" } else if x.unreadable.is_empty() { "read" } else if text_pages > 0 { "partly_read" } else { "unreadable" };
    c.execute(
        "INSERT OR REPLACE INTO content_files VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![file_id, path, size, mtime_ns, value, x.page_count, text_pages, x.ocr_pages, x.unreadable.len() as i64, chars as i64, status, x.error, now],
    )?;
    // Valuable pages nobody can read locally are offered for AI reading.
    c.execute("DELETE FROM ai_stage WHERE file_id=?1 AND status='staged'", [file_id])?;
    if allow_ai && value >= 0.55 && x.error.is_none() {
        let mut st = c.prepare_cached("INSERT OR IGNORE INTO ai_stage(file_id,page,value,reason,status,staged_at) VALUES(?1,?2,?3,?4,'staged',?5)")?;
        for &pg in x.unreadable.iter().take(20) {
            st.execute(params![file_id, pg, value, if x.ocr_pages > 0 { "OCR found no readable text" } else { "No text layer" }, now])?;
        }
    }
    Ok(())
}

/// A one-page PDF with a text layer (tests and the self-test).
#[doc(hidden)]
    /// A one-page PDF with a text layer.
pub fn minimal_pdf(text: &str) -> Vec<u8> {
    let stream = format!("BT /F1 12 Tf 72 720 Td ({text}) Tj ET");
    let objs = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
        format!("<< /Length {} >>\nstream\n{}\nendstream", stream.len(), stream),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offs = Vec::new();
    for (i, o) in objs.iter().enumerate() {
        offs.push(out.len());
        out.extend(format!("{} 0 obj\n{}\nendobj\n", i + 1, o).as_bytes());
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).as_bytes());
    for o in offs {
        out.extend(format!("{o:010} 00000 n \n").as_bytes());
    }
    out.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1).as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn office_xml_text() {
        let x = r#"<w:document><w:body><w:p><w:r><w:t>Minimum thickness</w:t></w:r><w:r><w:t xml:space="preserve"> 0.312 &amp; OK</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r></w:p></w:body></w:document>"#;
        let t = xml_text(x, "w:t", &["w:p"]);
        assert_eq!(t, "Minimum thickness 0.312 & OK\nNext\n");
        assert_eq!(tidy("  a   b \n\n\n c "), "a b\n\nc");
    }

    struct FakeOcr;
    impl Ocr for FakeOcr {
        fn max_side(&self) -> u32 {
            1000
        }
        fn recognize(&self, img: &image::RgbaImage) -> Result<String, String> {
            Ok(format!("tile {}x{}", img.width(), img.height()))
        }
    }

    #[test]
    fn big_images_are_tiled() {
        let img = image::RgbaImage::new(2500, 1200);
        let t = ocr_image(&FakeOcr, &img).unwrap();
        assert!(t.lines().count() >= 4, "{t}");
        assert!(t.lines().all(|l| l.starts_with("tile ")));
    }

    #[test]
    fn pdf_text_layer_when_engine_available() {
        // Runs where a PDFium library is provided (TP_PDFIUM=/path/libpdfium.so).
        let Ok(lib) = std::env::var("TP_PDFIUM") else { return };
        let ex = Extractor::new(Some(std::path::Path::new(&lib)), false);
        assert!(ex.has_pdf(), "{:?}", ex.pdfium_error);
        let pdf = minimal_pdf("Minimum thickness readings shell course 0.312 inch nozzle N1 UT survey");
        let x = ex.extract(pdf, ".pdf", 0);
        assert_eq!(x.page_count, 1, "{:?}", x.error);
        assert!(x.pages[0].text.contains("thickness"), "{:?}", x.pages);
    }

}
