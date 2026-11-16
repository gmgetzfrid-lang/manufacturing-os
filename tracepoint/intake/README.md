# Scan Intake

Turns scanned manila folders into the engineering drive's equipment
folders: one correctly named, searchable PDF per document, filed under the
KOR Y-4 numbering convention, with Excel indexes. A separate program from
TracePoint search (TracePoint itself stays AI-free and offline).

## Using it

1. Scan one manila folder to one PDF. Name it with the equipment number if
   you can (`2010.06.pdf`; `2010.06 (2).pdf` for a second batch). Scanner
   names like `doc13232423412412.pdf` are fine too; the equipment is then
   worked out from the papers.
2. Save it into the drop folder (default `E:\Digital Project`). It is picked
   up within a few seconds, once the scanner has finished writing it.
3. Each scan is read page by page (Windows OCR for the text layer, Claude
   for reading and sorting), split into documents, named, and filed:

   ```
   E:\Digital Project\2000 - CRUDE UNIT\10 - VESSELS\2010.06 V-6 ...\CODE DOCUMENTS\
       2010.06 U-1A Manufacturer's Data Report 1978-03-14.pdf
   ```

4. Anything uncertain is **held in Review** instead of filed. Review shows
   page thumbnails, the proposed split, folder, title and date. Fix what's
   wrong (merge, split, rename, pick the folder) and press File.
5. When a unit is done, copy its whole folder (`2000 - CRUDE UNIT`) to the
   network drive. `_ORIGINAL SCANS` and `_INTAKE DATA` are not copied.

## What lands where

| Path on the scan drive | What it is |
|---|---|
| `<unit>\<item>\<equipment>\<TYPE>\*.pdf` | The filed documents |
| `<unit>\<unit> INDEX.xlsx` | Index of that unit's documents (relative links, so they work after copying) |
| `MASTER INDEX.xlsx` | Index of everything |
| `_ORIGINAL SCANS\<date>\` | Every scan exactly as dropped in. Never deleted |
| `_INTAKE DATA\intake.db` | The ledger: every scan, every document, page ranges, costs |

Document-type folders: DRAWINGS, CODE DOCUMENTS, CALCULATIONS, DATASHEETS,
INSPECTIONS, REPAIRS, VENDOR DATA, CORRESPONDENCE, EMAILS, PICTURES. An
existing spelling inside an equipment folder (`DATA SHEETS`, `Emails`) is
reused.

File names: `<equipment no.> <document type and specifics> <YYYY-MM-DD>.pdf`,
`Undated` when the document carries no date, and `(as 2010.15 V-15)` when a
document in this equipment's history was written under another number or tag.

## Settings

- **Drop folder**: where scans arrive and output is built.
- **Network equipment folders** (read only, strongly recommended): the
  network folder holding the unit folders. New files go into the folder that
  already exists there, spelled exactly the same, and never take a file name
  already used there. If it becomes unreachable, filing waits until it is
  back.
- **API key**: an Anthropic API key (console.anthropic.com › Settings › API
  keys). Stored encrypted with Windows DPAPI for the signed-in user.
- **Model**: Claude Opus 5.5 (default, most accurate) or Claude Sonnet 5.5.
- **Author / company**: written as Author, Creator and Producer of every PDF
  and as the author of the indexes (default `Kern Energy`). Scanner metadata
  and XMP are removed.

## How the reading works

Each scan is read twice: a first reading proposes the equipment, the split
points, and each document's folder, title and date; a second, independent
pass checks that reading against the pages and corrects or flags it. The
program then checks the result against hard rules (every page in exactly one
document, a valid equipment number, an unambiguous folder, valid dates) and
files only when everything passes. Long scans are read in parts of up to 36
pages that overlap by two pages so documents spanning a boundary are joined.

Blank back sides are left out only when both the reading and the ink measure
agree the page is blank.

Typical cost: about $0.50–$1.50 per manila folder with Opus 5.5, depending
on page count. Spend is shown on the Intake page and recorded per scan.

The API account needs enough rate limit for image-heavy requests (one part
of a scan is roughly 150k input tokens). If requests are rate-limited, the
program waits and tries again; scans are never lost.

## Building

```
cd tracepoint/ui && npm ci && npm run build:intake
cd .. && cargo build --release -p scan-intake --bin ScanIntake      # on Windows
cargo xwin build --release -p scan-intake --bin ScanIntake --target x86_64-pc-windows-msvc   # from Linux
```

`assets/pdfium.dll` (PDFium 159, BSD-3) must be present; it is embedded in
the exe and unpacked to `%LOCALAPPDATA%\Scan Intake\bin` on first start.

Tests: `cargo test -p scan-intake`, and the end-to-end test (no Windows or
API key needed; uses a local stand-in for the API):

```
cargo build -p scan-intake --bin intake-dev
INTAKE_PDFIUM=/path/to/libpdfium.so python3 intake/tests/e2e.py target/debug/intake-dev
```
