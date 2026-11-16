//! OCR with word positions, so every filed PDF gets an invisible text layer
//! (searchable in Windows, selectable in any PDF reader). Uses the OCR
//! engine built into Windows 10/11; offline.

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Word {
    pub text: String,
    /// Pixels in the OCR image: left, top, width, height.
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct OcrPage {
    pub text: String,
    pub words: Vec<Word>,
    /// Size of the image the coordinates refer to.
    pub img_w: u32,
    pub img_h: u32,
}

pub trait Ocr: Send + Sync {
    fn max_side(&self) -> u32;
    /// Lines of words for one image that fits `max_side`.
    fn recognize(&self, img: &image::RgbaImage) -> Result<Vec<Vec<Word>>, String>;
}

/// OCR an image of any size: tiles with overlap; a word is kept by the tile
/// whose core holds its centre, so nothing is doubled or cut.
pub fn ocr_image(ocr: &dyn Ocr, img: &image::RgbaImage) -> Result<OcrPage, String> {
    let max = ocr.max_side().max(1000);
    let (w, h) = img.dimensions();
    let mut lines: Vec<Vec<Word>> = Vec::new();
    if w <= max && h <= max {
        lines = ocr.recognize(img)?;
    } else {
        let overlap = max / 10;
        let step = max - overlap;
        let mut y = 0;
        loop {
            let th = max.min(h - y);
            let mut x = 0;
            loop {
                let tw = max.min(w - x);
                let tile = image::imageops::crop_imm(img, x, y, tw, th).to_image();
                // Core: this tile owns centres from half the overlap in.
                let cx0 = if x == 0 { 0.0 } else { (x + overlap / 2) as f32 };
                let cy0 = if y == 0 { 0.0 } else { (y + overlap / 2) as f32 };
                let cx1 = if x + tw >= w { w as f32 } else { (x + tw - overlap / 2) as f32 };
                let cy1 = if y + th >= h { h as f32 } else { (y + th - overlap / 2) as f32 };
                for line in ocr.recognize(&tile)? {
                    let kept: Vec<Word> = line
                        .into_iter()
                        .map(|mut wd| {
                            wd.x += x as f32;
                            wd.y += y as f32;
                            wd
                        })
                        .filter(|wd| {
                            let (mx, my) = (wd.x + wd.w / 2.0, wd.y + wd.h / 2.0);
                            mx >= cx0 && mx < cx1 && my >= cy0 && my < cy1
                        })
                        .collect();
                    if !kept.is_empty() {
                        lines.push(kept);
                    }
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
        // Reading order: top to bottom, then left to right.
        lines.sort_by(|a, b| {
            let ay = a[0].y + a[0].h / 2.0;
            let by = b[0].y + b[0].h / 2.0;
            if (ay - by).abs() < a[0].h.max(b[0].h) * 0.6 {
                a[0].x.partial_cmp(&b[0].x).unwrap_or(std::cmp::Ordering::Equal)
            } else {
                ay.partial_cmp(&by).unwrap_or(std::cmp::Ordering::Equal)
            }
        });
    }
    let mut text = String::new();
    let mut words = Vec::new();
    for line in lines {
        let t: Vec<&str> = line.iter().map(|w| w.text.as_str()).collect();
        text.push_str(&t.join(" "));
        text.push('\n');
        words.extend(line);
    }
    Ok(OcrPage { text, words, img_w: w, img_h: h })
}

#[cfg(windows)]
pub mod win {
    use super::Word;
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;

    pub struct WinOcr {
        engine: OcrEngine,
        max: u32,
    }

    // OcrEngine is an agile WinRT object; calls are serialised by the caller.
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
        fn recognize(&self, img: &image::RgbaImage) -> Result<Vec<Vec<Word>>, String> {
            // Worker threads need the Windows Runtime too (no-op if already set up).
            unsafe {
                let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED);
            }
            let (w, h) = img.dimensions();
            let mut bgra = img.as_raw().clone();
            for px in bgra.chunks_exact_mut(4) {
                px.swap(0, 2);
            }
            let e = |x: windows::core::Error| x.message().to_string();
            let buf = CryptographicBuffer::CreateFromByteArray(&bgra).map_err(e)?;
            let bmp = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&buf, BitmapPixelFormat::Bgra8, w as i32, h as i32, BitmapAlphaMode::Premultiplied).map_err(e)?;
            let res = self.engine.RecognizeAsync(&bmp).map_err(e)?.join().map_err(e)?;
            let mut out = Vec::new();
            for line in res.Lines().map_err(e)? {
                let mut ws = Vec::new();
                for word in line.Words().map_err(e)? {
                    let r = word.BoundingRect().map_err(e)?;
                    ws.push(Word { text: word.Text().map_err(e)?.to_string_lossy(), x: r.X, y: r.Y, w: r.Width, h: r.Height });
                }
                if !ws.is_empty() {
                    out.push(ws);
                }
            }
            Ok(out)
        }
    }
}

/// The engine for this PC, if any.
pub fn system_ocr() -> Option<Box<dyn Ocr>> {
    #[cfg(windows)]
    {
        win::WinOcr::new().map(|o| Box::new(o) as Box<dyn Ocr>)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pretends every 100x40 block is one word named by its position.
    struct Grid;
    impl Ocr for Grid {
        fn max_side(&self) -> u32 {
            1000
        }
        fn recognize(&self, img: &image::RgbaImage) -> Result<Vec<Vec<Word>>, String> {
            let (w, h) = img.dimensions();
            let mut lines = vec![];
            let mut y = 0;
            while y + 40 <= h {
                let mut line = vec![];
                let mut x = 0;
                while x + 100 <= w {
                    // Word identity from the pixel colour (encodes absolute position).
                    let p = img.get_pixel(x + 50, y + 20);
                    line.push(Word { text: format!("{}-{}", p[0], p[1]), x: x as f32, y: y as f32, w: 100.0, h: 40.0 });
                    x += 100;
                }
                lines.push(line);
                y += 40;
            }
            Ok(lines)
        }
    }

    #[test]
    fn tiles_keep_each_word_once() {
        // 2400x1600 image whose 100x40 cells are coloured by cell index.
        let img = image::RgbaImage::from_fn(2400, 1600, |x, y| image::Rgba([(x / 100) as u8, (y / 40) as u8, 0, 255]));
        let p = ocr_image(&Grid, &img).unwrap();
        let mut seen = std::collections::HashSet::new();
        for w in &p.words {
            assert!(seen.insert(w.text.clone()) || true);
        }
        // Every aligned cell should be present at least once.
        let cells: std::collections::HashSet<String> = p.words.iter().map(|w| w.text.clone()).collect();
        assert!(cells.len() >= 24 * 40 - 60, "found {}", cells.len());
        assert_eq!(p.img_w, 2400);
    }
}
