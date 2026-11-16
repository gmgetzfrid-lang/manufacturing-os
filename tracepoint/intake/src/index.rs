//! Excel indexes: one per unit (inside the unit folder, so it is copied
//! with the unit) and a master index at the root. Links are relative, so
//! they keep working after the folders are copied to the network drive.

use crate::store::Doc;
use rust_xlsxwriter::{DocProperties, Format, FormatAlign, FormatBorder, Url, Workbook};
use std::collections::BTreeMap;
use std::path::Path;

pub const MASTER_NAME: &str = "MASTER INDEX.xlsx";

pub fn unit_index_name(unit_folder: &str) -> String {
    format!("{unit_folder} INDEX.xlsx")
}

fn props(author: &str, title: &str) -> DocProperties {
    DocProperties::new().set_author(author).set_company(author).set_title(title).set_manager(author)
}

const COLS: &[(&str, f64)] = &[
    ("Equipment No.", 12.0),
    ("Equipment Folder", 42.0),
    ("Document Type", 17.0),
    ("Document", 60.0),
    ("Date", 11.0),
    ("Pages", 7.0),
    ("Written Under", 16.0),
    ("Drawing No.", 16.0),
    ("Rev", 6.0),
    ("Description", 70.0),
    ("Link", 10.0),
    ("Folder Path", 70.0),
    ("Note", 50.0),
];

fn write_sheet(wb: &mut Workbook, name: &str, docs: &[&Doc], base: &str) -> Result<(), rust_xlsxwriter::XlsxError> {
    let head = Format::new().set_bold().set_background_color("1F3864").set_font_color("FFFFFF").set_border_bottom(FormatBorder::Thin).set_align(FormatAlign::VerticalCenter);
    let link = Format::new().set_font_color("0563C1").set_underline(rust_xlsxwriter::FormatUnderline::Single);
    let ws = wb.add_worksheet();
    ws.set_name(name)?;
    for (c, (h, w)) in COLS.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, *h, &head)?;
        ws.set_column_width(c as u16, *w)?;
    }
    ws.set_row_height(0, 20)?;
    for (i, d) in docs.iter().enumerate() {
        let r = (i + 1) as u32;
        // Path relative to the workbook's folder.
        let rel = d.file_rel.strip_prefix(base).map(|s| s.trim_start_matches('/')).unwrap_or(&d.file_rel).to_string();
        let folder_name = d.equipment_rel.rsplit('/').next().unwrap_or("");
        let parent = rel.rsplit_once('/').map(|(a, _)| a).unwrap_or("");
        let file_name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        ws.write_string(r, 0, &d.equipment)?;
        ws.write_string(r, 1, folder_name)?;
        ws.write_string(r, 2, &d.folder)?;
        ws.write_string(r, 3, file_name.trim_end_matches(".pdf"))?;
        ws.write_string(r, 4, if d.date.is_empty() { "Undated" } else { &d.date })?;
        ws.write_number(r, 5, d.pages as f64)?;
        ws.write_string(r, 6, &d.as_other)?;
        ws.write_string(r, 7, &d.drawing_number)?;
        ws.write_string(r, 8, &d.revision)?;
        ws.write_string(r, 9, &d.summary)?;
        let url = Url::new(format!("file:///{}", rel.replace('/', "\\"))).set_text("Open");
        ws.write_url_with_format(r, 10, url, &link)?;
        ws.write_string(r, 11, parent.replace('/', "\\"))?;
        ws.write_string(r, 12, &d.note)?;
    }
    let last = docs.len() as u32;
    ws.autofilter(0, 0, last.max(1), (COLS.len() - 1) as u16)?;
    ws.set_freeze_panes(1, 1)?;
    Ok(())
}

fn write_equipment_sheet(wb: &mut Workbook, docs: &[&Doc], base: &str) -> Result<(), rust_xlsxwriter::XlsxError> {
    let head = Format::new().set_bold().set_background_color("1F3864").set_font_color("FFFFFF");
    let link = Format::new().set_font_color("0563C1").set_underline(rust_xlsxwriter::FormatUnderline::Single);
    let ws = wb.add_worksheet();
    ws.set_name("Equipment")?;
    let cols = [("Equipment No.", 12.0), ("Equipment Folder", 50.0), ("Documents", 11.0), ("Pages", 8.0), ("Earliest", 11.0), ("Latest", 11.0), ("Folder", 10.0)];
    for (c, (h, w)) in cols.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, *h, &head)?;
        ws.set_column_width(c as u16, *w)?;
    }
    let mut by: BTreeMap<&str, Vec<&Doc>> = BTreeMap::new();
    for d in docs {
        by.entry(d.equipment_rel.as_str()).or_default().push(d);
    }
    for (i, (rel, ds)) in by.iter().enumerate() {
        let r = (i + 1) as u32;
        let dates: Vec<&str> = ds.iter().map(|d| d.date.as_str()).filter(|d| !d.is_empty()).collect();
        ws.write_string(r, 0, &ds[0].equipment)?;
        ws.write_string(r, 1, rel.rsplit('/').next().unwrap_or(rel))?;
        ws.write_number(r, 2, ds.len() as f64)?;
        ws.write_number(r, 3, ds.iter().map(|d| d.pages).sum::<i64>() as f64)?;
        ws.write_string(r, 4, dates.iter().min().copied().unwrap_or(""))?;
        ws.write_string(r, 5, dates.iter().max().copied().unwrap_or(""))?;
        let relp = rel.strip_prefix(base).map(|s| s.trim_start_matches('/')).unwrap_or(rel);
        ws.write_url_with_format(r, 6, Url::new(format!("file:///{}", relp.replace('/', "\\"))).set_text("Open"), &link)?;
    }
    ws.autofilter(0, 0, by.len().max(1) as u32, 6)?;
    ws.set_freeze_panes(1, 0)?;
    Ok(())
}

/// Rebuild every unit index and the master index from the ledger.
/// Returns the files that could not be written (open in Excel).
pub fn rebuild(root: &Path, docs: &[Doc], author: &str) -> Vec<String> {
    let mut failed = vec![];
    let mut units: BTreeMap<String, Vec<&Doc>> = BTreeMap::new();
    for d in docs {
        let unit = d.file_rel.split('/').next().unwrap_or("").to_string();
        units.entry(unit).or_default().push(d);
    }
    for (unit, ds) in &units {
        if unit.is_empty() {
            continue;
        }
        let path = root.join(unit).join(unit_index_name(unit));
        let mut wb = Workbook::new();
        wb.set_properties(&props(author, &format!("{unit} Index")));
        let ok = write_sheet(&mut wb, "Documents", ds, unit).and_then(|_| write_equipment_sheet(&mut wb, ds, unit)).and_then(|_| wb.save_to_buffer());
        match ok {
            Ok(b) => {
                if crate::util::write_atomic(&path, &b).is_err() {
                    failed.push(path.display().to_string());
                }
            }
            Err(_) => failed.push(path.display().to_string()),
        }
    }
    let all: Vec<&Doc> = docs.iter().collect();
    let mut wb = Workbook::new();
    wb.set_properties(&props(author, "Master Index"));
    let ok = write_sheet(&mut wb, "Documents", &all, "").and_then(|_| write_equipment_sheet(&mut wb, &all, "")).and_then(|_| wb.save_to_buffer());
    let path = root.join(MASTER_NAME);
    match ok {
        Ok(b) => {
            if crate::util::write_atomic(&path, &b).is_err() {
                failed.push(path.display().to_string());
            }
        }
        Err(_) => failed.push(path.display().to_string()),
    }
    failed
}
