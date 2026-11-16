//! Excel export of search results (TracePoint 1.x columns, plus equipment
//! and reasons). Two hyperlinks per row: the file and its folder.

use crate::engine::Hit;
use rust_xlsxwriter::{Color, Format, FormatBorder, Url, Workbook};

pub const ROWS_PER_SHEET: usize = 30_000;

/// file:// URI with each path part percent-encoded (spaces, #, %, Unicode).
pub fn file_uri(path: &str) -> String {
    fn enc(s: &str) -> String {
        let mut o = String::new();
        for b in s.as_bytes() {
            let c = *b as char;
            if c.is_ascii_alphanumeric() || "-_.~".contains(c) {
                o.push(c);
            } else {
                o.push_str(&format!("%{:02X}", b));
            }
        }
        o
    }
    if let Some(rest) = path.strip_prefix("\\\\") {
        let parts: Vec<&str> = rest.split('\\').collect();
        if parts.len() < 2 {
            return String::new();
        }
        return format!("file://{}/{}", parts[0], parts[1..].iter().map(|p| enc(p)).collect::<Vec<_>>().join("/"));
    }
    let b = path.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
        return format!("file:///{}:/{}", (b[0] as char).to_ascii_uppercase(), path[3..].split(['\\', '/']).map(enc).collect::<Vec<_>>().join("/"));
    }
    String::new()
}

pub fn write_xlsx(path: &std::path::Path, hits: &[Hit], query: &str, filters: &str, source: &str) -> Result<(), String> {
    let mut wb = Workbook::new();
    let title = Format::new().set_bold().set_font_size(14);
    let header = Format::new().set_bold().set_font_color(Color::White).set_background_color(Color::RGB(0x1F2937)).set_border_bottom(FormatBorder::Thin);
    let link = Format::new().set_font_color(Color::RGB(0x2563EB)).set_underline(rust_xlsxwriter::FormatUnderline::Single);
    let muted = Format::new().set_font_color(Color::RGB(0x64748B));
    let heads = ["Rank", "Filename", "Equipment", "Unit", "Category", "Document Type", "Year", "Sheet", "Rev", "Type", "Open", "Open Folder", "Full Path", "Folder", "Why", "Score"];
    let widths = [7.0, 48.0, 22.0, 22.0, 18.0, 22.0, 7.0, 7.0, 7.0, 7.0, 10.0, 12.0, 70.0, 50.0, 60.0, 7.0];
    let chunks: Vec<&[Hit]> = if hits.is_empty() { vec![&[]] } else { hits.chunks(ROWS_PER_SHEET).collect() };
    let n_sheets = chunks.len();
    for (si, chunk) in chunks.into_iter().enumerate() {
        let ws = wb.add_worksheet();
        ws.set_name(if n_sheets == 1 { "Search Results".to_string() } else { format!("Results {}", si + 1) }).map_err(|e| e.to_string())?;
        ws.write_string_with_format(0, 0, "TracePoint search results", &title).map_err(|e| e.to_string())?;
        ws.write_string_with_format(1, 0, format!("Search: {query}    Filters: {filters}    Index: {source}    Results: {}", hits.len()), &muted).map_err(|e| e.to_string())?;
        for (c, h) in heads.iter().enumerate() {
            ws.write_string_with_format(3, c as u16, *h, &header).map_err(|e| e.to_string())?;
            ws.set_column_width(c as u16, widths[c]).map_err(|e| e.to_string())?;
        }
        ws.set_freeze_panes(4, 2).map_err(|e| e.to_string())?;
        for (i, h) in chunk.iter().enumerate() {
            let r = (i + 4) as u32;
            let equip = h.equipment.iter().map(|e| format!("{}{}", e.number, e.tag.as_ref().map(|t| format!(" {t}")).unwrap_or_default())).collect::<Vec<_>>().join("; ");
            let folder = h.path.rsplit_once('\\').map(|x| x.0).unwrap_or("");
            let vals: [String; 10] = [
                h.rank.to_string(),
                h.name.clone(),
                equip,
                h.unit.clone().unwrap_or_default(),
                h.category.to_string(),
                h.doctype.to_string(),
                h.year.map(|y| y.to_string()).unwrap_or_default(),
                h.sheet.clone().unwrap_or_default(),
                h.rev.clone().unwrap_or_default(),
                h.ext.clone(),
            ];
            for (c, v) in vals.iter().enumerate() {
                ws.write_string(r, c as u16, v).map_err(|e| e.to_string())?;
            }
            let fu = file_uri(&h.path);
            if !fu.is_empty() {
                ws.write_url_with_format(r, 10, Url::new(fu).set_text("Open"), &link).map_err(|e| e.to_string())?;
            }
            let du = file_uri(folder);
            if !du.is_empty() {
                ws.write_url_with_format(r, 11, Url::new(du).set_text("Open folder"), &link).map_err(|e| e.to_string())?;
            }
            ws.write_string(r, 12, &h.path).map_err(|e| e.to_string())?;
            ws.write_string(r, 13, &h.folder).map_err(|e| e.to_string())?;
            ws.write_string(r, 14, h.reasons.join("; ")).map_err(|e| e.to_string())?;
            ws.write_number(r, 15, h.score as f64).map_err(|e| e.to_string())?;
        }
        ws.autofilter(3, 0, (chunk.len() + 3) as u32, (heads.len() - 1) as u16).map_err(|e| e.to_string())?;
    }
    wb.save(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uris() {
        assert_eq!(file_uri(r"\\THOR\Equipment Files\A #1%.pdf"), "file://THOR/Equipment%20Files/A%20%231%25.pdf");
        assert_eq!(file_uri(r"C:\Test\A%1.pdf"), "file:///C:/Test/A%251.pdf");
    }
}

/// One row of the cleanup report.
pub struct CleanupRow {
    pub file: String,
    pub path: String,
    pub what: String,
    pub better: String,
    pub better_path: String,
    pub why: String,
}

/// Doc-control cleanup report: one sheet per kind of problem. Only files the
/// person exporting can open are in it; THOR is never changed.
pub fn write_cleanup(path: &std::path::Path, sheets: &[(&str, &str, Vec<CleanupRow>)], source: &str) -> Result<(), String> {
    let mut wb = Workbook::new();
    let title = Format::new().set_bold().set_font_size(14);
    let header = Format::new().set_bold().set_font_color(Color::White).set_background_color(Color::RGB(0x1F2937)).set_border_bottom(FormatBorder::Thin);
    let link = Format::new().set_font_color(Color::RGB(0x2563EB)).set_underline(rust_xlsxwriter::FormatUnderline::Single);
    let muted = Format::new().set_font_color(Color::RGB(0x64748B));
    let heads = ["File", "Open", "Folder", "What TracePoint found", "Better copy / where it belongs", "Open it", "Why", "Full path"];
    let widths = [46.0, 8.0, 50.0, 30.0, 46.0, 9.0, 60.0, 80.0];
    for (name, blurb, rows) in sheets {
        let ws = wb.add_worksheet();
        ws.set_name(*name).map_err(|e| e.to_string())?;
        ws.write_string_with_format(0, 0, format!("TracePoint — {name}"), &title).map_err(|e| e.to_string())?;
        ws.write_string_with_format(1, 0, format!("{blurb}  ·  {} rows  ·  {source}  ·  Nothing on THOR was changed.", rows.len()), &muted).map_err(|e| e.to_string())?;
        for (c, h) in heads.iter().enumerate() {
            ws.write_string_with_format(3, c as u16, *h, &header).map_err(|e| e.to_string())?;
            ws.set_column_width(c as u16, widths[c]).map_err(|e| e.to_string())?;
        }
        ws.set_freeze_panes(4, 1).map_err(|e| e.to_string())?;
        for (i, r) in rows.iter().take(ROWS_PER_SHEET).enumerate() {
            let row = (i + 4) as u32;
            ws.write_string(row, 0, &r.file).map_err(|e| e.to_string())?;
            let fu = file_uri(&r.path);
            if !fu.is_empty() {
                ws.write_url_with_format(row, 1, Url::new(fu).set_text("Open"), &link).map_err(|e| e.to_string())?;
            }
            ws.write_string(row, 2, r.path.rsplit_once('\\').map(|x| x.0).unwrap_or("")).map_err(|e| e.to_string())?;
            ws.write_string(row, 3, &r.what).map_err(|e| e.to_string())?;
            ws.write_string(row, 4, &r.better).map_err(|e| e.to_string())?;
            let bu = file_uri(&r.better_path);
            if !bu.is_empty() {
                ws.write_url_with_format(row, 5, Url::new(bu).set_text("Open"), &link).map_err(|e| e.to_string())?;
            }
            ws.write_string(row, 6, &r.why).map_err(|e| e.to_string())?;
            ws.write_string(row, 7, &r.path).map_err(|e| e.to_string())?;
        }
        ws.autofilter(3, 0, (rows.len().min(ROWS_PER_SHEET) + 3) as u32, (heads.len() - 1) as u16).map_err(|e| e.to_string())?;
    }
    wb.save(path).map_err(|e| e.to_string())
}
