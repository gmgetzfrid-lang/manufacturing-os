// lib/pdfjsConfig.ts — the one knob every pdf.js document we open shares.
//
// pdf.js defaults to VerbosityLevel.WARNINGS, and an AutoCAD-exported drawing
// with an embedded TrueType subset emits
//
//     Warning: TT: undefined function: 32
//
// once per glyph whose hinting bytecode it can't run. One drawing produces
// hundreds of lines; staging a forty-file batch produces tens of thousands,
// from the worker thread, faster than devtools can render them. Nothing is
// wrong — the text still extracts and the page still renders — but real
// errors end up buried under the flood, which is how a genuinely stuck
// upload goes unnoticed.
//
// ERRORS only. Anything that actually breaks still reports.

/** pdf.js VerbosityLevel.ERRORS. Passed to getDocument, which forwards it to
 *  the worker — where these warnings are emitted from. */
export const PDFJS_VERBOSITY = 0;

/** For react-pdf's <Document options={...}>, which hands this to getDocument.
 *  Frozen and module-level ON PURPOSE: react-pdf tears down and reloads the
 *  document whenever `options` changes identity, so an object literal written
 *  inline in render would re-parse the PDF on every render. */
export const PDF_DOC_OPTIONS: Readonly<{ verbosity: number }> =
  Object.freeze({ verbosity: PDFJS_VERBOSITY });
