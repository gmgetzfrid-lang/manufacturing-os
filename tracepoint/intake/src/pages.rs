//! Reading a scan page by page: an image for the reader (and the review
//! screen), a close-up of the title block on large drawings, OCR text with
//! word positions for the text layer, and a blank-page measure.

use crate::ocr::{self, Ocr, OcrPage};
use pdfium_render::prelude::*;
use std::path::{Path, PathBuf};

/// Long side of the page image sent for reading (within the API's limits
/// for many images per request).
pub const READ_PX: u32 = 1800;
/// Resolution used for OCR.
const OCR_DPI: f32 = 220.0;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct PageInfo {
    /// Zero-based page index in the scan.
    pub index: u32,
    pub width_pt: f32,
    pub height_pt: f32,
    /// Text from the PDF's own text layer or OCR.
    pub text: String,
    /// The PDF already had a text layer (no OCR layer needed).
    pub had_text: bool,
    /// Share of dark pixels (0..1); near zero means a blank page.
    pub ink: f32,
    /// Page image file (JPEG) for reading and review.
    pub image: String,
    /// Title-block close-up for large sheets.
    pub closeup: Option<String>,
}

impl PageInfo {
    /// Sheet size letter per KOR Y-4 (A 8.5x11, B 11x17, C 17x22, D 24x36,
    /// E 34x44), from the scanned size.
    pub fn sheet(&self) -> &'static str {
        let (a, b) = (self.width_pt.min(self.height_pt) / 72.0, self.width_pt.max(self.height_pt) / 72.0);
        if b <= 14.5 && a <= 9.5 {
            "A"
        } else if b <= 18.5 {
            "B"
        } else if b <= 24.5 {
            "C"
        } else if b <= 38.0 {
            "D"
        } else if b <= 48.0 {
            "E"
        } else {
            "R"
        }
    }
}

pub struct Reader<'a> {
    pub pdfium: &'a Pdfium,
    pub ocr: Option<&'a dyn Ocr>,
}

fn ink(img: &image::GrayImage) -> f32 {
    // Ignore a 3% margin (scanner edges, punch holes).
    let (w, h) = img.dimensions();
    let (mx, my) = (w * 3 / 100, h * 3 / 100);
    let mut dark = 0u64;
    let mut total = 0u64;
    for y in (my..h.saturating_sub(my)).step_by(2) {
        for x in (mx..w.saturating_sub(mx)).step_by(2) {
            total += 1;
            if img.get_pixel(x, y)[0] < 140 {
                dark += 1;
            }
        }
    }
    if total == 0 {
        0.0
    } else {
        dark as f32 / total as f32
    }
}

fn save_jpeg(img: &image::DynamicImage, path: &Path, quality: u8) -> Result<(), String> {
    let rgb = img.to_rgb8();
    let mut buf = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    enc.encode_image(&rgb).map_err(|e| e.to_string())?;
    crate::util::write_atomic(path, &buf).map_err(|e| e.to_string())
}

impl<'a> Reader<'a> {
    /// Read every page of `pdf` into `work` (page images and OCR). Calls
    /// `progress(done, total)` after each page. OCR results go to
    /// `work/ocr-NNNN.json` for the text layer.
    pub fn read(&self, pdf: &Path, work: &Path, cancel: &dyn Fn() -> bool, progress: &mut dyn FnMut(u32, u32)) -> Result<Vec<PageInfo>, String> {
        std::fs::create_dir_all(work).map_err(|e| e.to_string())?;
        let doc = self.pdfium.load_pdf_from_file(pdf, None).map_err(|e| format!("Can't open the scan (is it a damaged or password-protected PDF?): {e}"))?;
        let pages = doc.pages();
        let total = pages.len() as u32;
        let mut out = Vec::with_capacity(total as usize);
        for (i, page) in pages.iter().enumerate() {
            if cancel() {
                return Err("Stopped".into());
            }
            let i = i as u32;
            let w = page.width().value.max(1.0);
            let h = page.height().value.max(1.0);
            let existing = page.text().map(|t| t.all()).unwrap_or_default();
            let had_text = existing.split_whitespace().count() >= 8;
            // One high-resolution render serves OCR, the close-up and the
            // reading image.
            let scale = (OCR_DPI / 72.0).min(9000.0 / w.max(h));
            let cfg = PdfRenderConfig::new().set_target_width((w * scale) as i32).set_maximum_height((h * scale) as i32);
            let img = page.render_with_config(&cfg).map_err(|e| e.to_string())?.as_image().map_err(|e| e.to_string())?;
            let gray = img.to_luma8();
            let ink = ink(&image::imageops::thumbnail(&gray, 800, 800));
            let image_path = work.join(format!("p{:04}.jpg", i + 1));
            let small = img.thumbnail(READ_PX, READ_PX);
            save_jpeg(&small, &image_path, 78)?;
            let large = w.max(h) / 72.0 > 18.5;
            let closeup = if large {
                // Title blocks sit bottom-right on Kern drawings.
                let (iw, ih) = (img.width(), img.height());
                let crop = img.crop_imm(iw * 55 / 100, ih * 62 / 100, iw - iw * 55 / 100, ih - ih * 62 / 100).thumbnail(READ_PX, READ_PX);
                let p = work.join(format!("p{:04}-tb.jpg", i + 1));
                save_jpeg(&crop, &p, 85)?;
                Some(p.display().to_string())
            } else {
                None
            };
            let mut text = existing.clone();
            if !had_text && ink > 0.0015 {
                if let Some(o) = self.ocr {
                    match ocr::ocr_image(o, &img.to_rgba8()) {
                        Ok(r) => {
                            text = r.text.clone();
                            let j = serde_json::to_vec(&r).unwrap_or_default();
                            let _ = crate::util::write_atomic(&work.join(format!("ocr-{:04}.json", i + 1)), &j);
                        }
                        Err(e) => text = format!("(OCR failed: {e})"),
                    }
                }
            }
            out.push(PageInfo { index: i, width_pt: w, height_pt: h, text, had_text, ink, image: image_path.display().to_string(), closeup });
            progress(i + 1, total);
        }
        Ok(out)
    }
}

/// The OCR word layer saved for a page, if any.
pub fn load_ocr(work: &Path, index: u32) -> Option<OcrPage> {
    let b = std::fs::read(work.join(format!("ocr-{:04}.json", index + 1))).ok()?;
    serde_json::from_slice(&b).ok()
}

pub fn page_image(work: &Path, index: u32) -> PathBuf {
    work.join(format!("p{:04}.jpg", index + 1))
}

/// A page looks blank: almost no ink and no text worth keeping.
pub fn looks_blank(p: &PageInfo) -> bool {
    p.ink < 0.0012 && p.text.split_whitespace().count() < 3
}
