//! Writing the filed PDFs: the chosen pages of the original scan, an
//! invisible OCR text layer (searchable / selectable), and clean document
//! properties (Author, Creator and Producer all the company name; no tool
//! names, no XMP left over from the scanner).

use crate::ocr::OcrPage;
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use pdfium_render::prelude::*;

pub struct Properties {
    pub title: String,
    pub subject: String,
    pub keywords: String,
    pub author: String,
    /// PDF date string, `D:20261116143000`.
    pub date: String,
}

/// `pages`: zero-based page indexes of the source, in output order.
pub fn extract_pages(pdfium: &Pdfium, source: &[u8], pages: &[u32]) -> Result<Vec<u8>, String> {
    let src = pdfium.load_pdf_from_byte_slice(source, None).map_err(|e| format!("Can't open the scan: {e}"))?;
    let mut out = pdfium.create_new_pdf().map_err(|e| e.to_string())?;
    // Contiguous runs keep the copy fast; order is preserved.
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for &p in pages {
        match runs.last_mut() {
            Some((_, e)) if *e + 1 == p => *e = p,
            _ => runs.push((p, p)),
        }
    }
    let spec = runs.iter().map(|(a, b)| if a == b { format!("{}", a + 1) } else { format!("{}-{}", a + 1, b + 1) }).collect::<Vec<_>>().join(",");
    out.pages_mut().copy_pages_from_document(&src, &spec, 0).map_err(|e| format!("Can't copy pages {spec}: {e}"))?;
    if out.pages().len() as usize != pages.len() {
        return Err(format!("Copied {} pages, expected {}", out.pages().len(), pages.len()));
    }
    out.save_to_bytes().map_err(|e| e.to_string())
}

fn inherited<'a>(doc: &'a Document, page: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
    let mut d = page;
    for _ in 0..32 {
        if let Ok(v) = d.get(key) {
            return Some(v);
        }
        let parent = d.get(b"Parent").ok()?.as_reference().ok()?;
        d = doc.get_object(parent).ok()?.as_dict().ok()?;
    }
    None
}

fn resolve<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    doc.dereference(o).map(|(_, o)| o).unwrap_or(o)
}

fn rect(doc: &Document, o: Option<&Object>) -> Option<[f32; 4]> {
    let a = resolve(doc, o?).as_array().ok()?;
    if a.len() != 4 {
        return None;
    }
    let mut v = [0f32; 4];
    for (i, x) in a.iter().enumerate() {
        v[i] = resolve(doc, x).as_float().ok()?;
    }
    Some([v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])])
}

/// Bytes in WinAnsi (Latin-1 subset) for a document property; the writer
/// escapes them.
fn latin1(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for ch in s.chars() {
        match ch {
            '\u{2018}' | '\u{2019}' => out.push(b'\''),
            '\u{201C}' | '\u{201D}' => out.push(b'"'),
            '\u{2013}' | '\u{2014}' => out.push(b'-'),
            c if (c as u32) >= 0x20 && (c as u32) < 0x7f => out.push(c as u8),
            c if (c as u32) >= 0xa0 && (c as u32) <= 0xff => out.push(c as u32 as u8),
            _ => {}
        }
    }
    out
}

/// PDF string bytes in WinAnsi (Latin-1 subset), escaped for a content stream.
fn pdf_text(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for ch in s.chars() {
        let b: u8 = match ch {
            '\u{2018}' | '\u{2019}' => b'\'',
            '\u{201C}' | '\u{201D}' => b'"',
            '\u{2013}' | '\u{2014}' => b'-',
            c if (c as u32) >= 0x20 && (c as u32) < 0x7f => c as u8,
            c if (c as u32) >= 0xa0 && (c as u32) <= 0xff => c as u32 as u8,
            _ => continue,
        };
        if b == b'(' || b == b')' || b == b'\\' {
            out.push(b'\\');
        }
        out.push(b);
    }
    out
}

/// Approximate Helvetica advance width (per 1000 em) for scaling.
fn helv_width(s: &str) -> f32 {
    s.chars()
        .map(|c| match c {
            'i' | 'j' | 'l' | '\'' | '.' | ',' | ':' | ';' | '|' | '!' => 240.0,
            'f' | 't' | 'r' | 'I' | ' ' | '(' | ')' | '-' | '/' => 320.0,
            'm' | 'w' | 'M' | 'W' => 830.0,
            c if c.is_ascii_uppercase() => 680.0,
            c if c.is_ascii_digit() => 556.0,
            _ => 540.0,
        })
        .sum()
}

/// The invisible text for one page, in that page's own coordinate space.
fn text_layer(ocr: &OcrPage, crop: [f32; 4], rotate: i64) -> Vec<u8> {
    let (x0, y0) = (crop[0], crop[1]);
    let (w, h) = (crop[2] - crop[0], crop[3] - crop[1]);
    let r = rotate.rem_euclid(360);
    // Displayed size (as rendered, rotation applied).
    let (dw, dh) = if r == 90 || r == 270 { (h, w) } else { (w, h) };
    let sx = dw / ocr.img_w.max(1) as f32;
    let sy = dh / ocr.img_h.max(1) as f32;
    let mut out: Vec<u8> = b"q\nBT\n3 Tr\n".to_vec();
    for wd in &ocr.words {
        let t = pdf_text(&wd.text);
        if t.is_empty() {
            continue;
        }
        // Displayed point coordinates, origin bottom-left.
        let fs = (wd.h * sy * 0.92).clamp(1.0, 400.0);
        let dx = wd.x * sx;
        let dy = dh - (wd.y + wd.h) * sy + wd.h * sy * 0.18;
        let target = wd.w * sx;
        let natural = helv_width(&wd.text) * fs / 1000.0;
        let tz = if natural > 0.1 { (target / natural * 100.0).clamp(10.0, 1000.0) } else { 100.0 };
        // Back to unrotated page space, with the text running along the
        // displayed direction.
        let (ux, uy, a, b, c, d) = match r {
            90 => (x0 + w - dy, y0 + dx, 0.0, 1.0, -1.0, 0.0),
            180 => (x0 + w - dx, y0 + h - dy, -1.0, 0.0, 0.0, -1.0),
            270 => (x0 + dy, y0 + h - dx, 0.0, -1.0, 1.0, 0.0),
            _ => (x0 + dx, y0 + dy, 1.0, 0.0, 0.0, 1.0),
        };
        out.extend_from_slice(format!("/TPF1 {fs:.2} Tf\n{tz:.1} Tz\n{a} {b} {c} {d} {ux:.2} {uy:.2} Tm\n(").as_bytes());
        out.extend_from_slice(&t);
        out.extend_from_slice(b") Tj\n");
    }
    out.extend_from_slice(b"ET\nQ\n");
    out
}

/// Add text layers and set document properties. `layers[i]` is the OCR of
/// output page i, or None when the page already carries text.
pub fn finalize(bytes: &[u8], layers: &[Option<OcrPage>], props: &Properties) -> Result<Vec<u8>, String> {
    let mut doc = Document::load_mem(bytes).map_err(|e| format!("PDF writer: {e}"))?;
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
        "Encoding" => "WinAnsiEncoding",
    });
    let pages: Vec<(u32, ObjectId)> = doc.get_pages().into_iter().collect();
    for (n, page_id) in pages {
        let Some(Some(ocr)) = layers.get(n as usize - 1) else { continue };
        if ocr.words.is_empty() {
            continue;
        }
        let page = doc.get_object(page_id).and_then(|o| o.as_dict()).map_err(|e| e.to_string())?.clone();
        let crop = rect(&doc, inherited(&doc, &page, b"CropBox")).or_else(|| rect(&doc, inherited(&doc, &page, b"MediaBox"))).unwrap_or([0.0, 0.0, 612.0, 792.0]);
        let rotate = inherited(&doc, &page, b"Rotate").map(|o| resolve(&doc, o)).and_then(|o| o.as_i64().ok()).unwrap_or(0);
        // Effective resources, made local to the page, plus our font.
        let mut res: Dictionary = inherited(&doc, &page, b"Resources").map(|o| resolve(&doc, o)).and_then(|o| o.as_dict().ok()).cloned().unwrap_or_default();
        let mut fonts: Dictionary = res.get(b"Font").ok().map(|o| resolve(&doc, o)).and_then(|o| o.as_dict().ok()).cloned().unwrap_or_default();
        fonts.set("TPF1", Object::Reference(font_id));
        res.set("Font", Object::Dictionary(fonts));
        // Wrap the original content so its graphics state can't leak.
        let mut contents: Vec<Object> = match page.get(b"Contents") {
            Ok(Object::Reference(r)) => vec![Object::Reference(*r)],
            Ok(Object::Array(a)) => a.clone(),
            _ => vec![],
        };
        let q = doc.add_object(Stream::new(Dictionary::new(), b"q\n".to_vec()));
        let qq = doc.add_object(Stream::new(Dictionary::new(), b"\nQ\n".to_vec()));
        let mut layer = Stream::new(Dictionary::new(), text_layer(ocr, crop, rotate));
        let _ = layer.compress();
        let layer_id = doc.add_object(layer);
        contents.insert(0, Object::Reference(q));
        contents.push(Object::Reference(qq));
        contents.push(Object::Reference(layer_id));
        let p = doc.get_object_mut(page_id).and_then(|o| o.as_dict_mut()).map_err(|e| e.to_string())?;
        p.set("Resources", Object::Dictionary(res));
        p.set("Contents", Object::Array(contents));
        p.remove(b"Metadata");
        p.remove(b"PieceInfo");
    }
    // Properties: replace whatever the scanner wrote; drop XMP.
    let info = doc.add_object(dictionary! {
        "Title" => Object::string_literal(latin1(&props.title)),
        "Author" => Object::string_literal(latin1(&props.author)),
        "Subject" => Object::string_literal(latin1(&props.subject)),
        "Keywords" => Object::string_literal(latin1(&props.keywords)),
        "Creator" => Object::string_literal(latin1(&props.author)),
        "Producer" => Object::string_literal(latin1(&props.author)),
        "CreationDate" => Object::string_literal(props.date.clone()),
        "ModDate" => Object::string_literal(props.date.clone()),
    });
    doc.trailer.set("Info", Object::Reference(info));
    if let Ok(cat) = doc.catalog_mut() {
        cat.remove(b"Metadata");
        cat.remove(b"PieceInfo");
        cat.set("PageMode", Object::Name(b"UseNone".to_vec()));
    }
    doc.prune_objects();
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| format!("PDF writer: {e}"))?;
    Ok(out)
}

/// `D:YYYYMMDDHHMMSS` for now (UTC).
pub fn pdf_now() -> String {
    let (y, mo, d, h, mi, s) = crate::util::utc_parts(crate::util::now_secs());
    format!("D:{y:04}{mo:02}{d:02}{h:02}{mi:02}{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ocr::Word;

    #[test]
    fn layer_coordinates() {
        let ocr = OcrPage { text: "HELLO".into(), words: vec![Word { text: "HELLO (1)".into(), x: 100.0, y: 100.0, w: 200.0, h: 50.0 }], img_w: 1000, img_h: 1000 };
        let t = String::from_utf8_lossy(&text_layer(&ocr, [0.0, 0.0, 1000.0, 1000.0], 0)).to_string();
        assert!(t.contains("3 Tr"));
        assert!(t.contains("(HELLO \\(1\\)) Tj"));
        // x = 100, y = 1000 - 150 + 9 = 859
        assert!(t.contains("1 0 0 1 100.00 859.00 Tm"), "{t}");
        let t = String::from_utf8_lossy(&text_layer(&ocr, [0.0, 0.0, 1000.0, 1000.0], 90)).to_string();
        assert!(t.contains("0 1 -1 0 141.00 100.00 Tm"), "{t}");
    }
}
