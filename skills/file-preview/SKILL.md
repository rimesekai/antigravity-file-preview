---
name: file-preview
description: Open and preview local PPT (.pptx), Word (.docx with full-text search), Excel (.xlsx/.xls/.csv/.tsv with multi-sheet switching, formulas, merged cells & search), PDF (.pdf, including >20MB streaming), Video (.mp4/.webm, including >20MB streaming), Audio (.mp3/.wav/.m4a/.ogg/.flac streaming), Images (.jpg/.jpeg/.png/.webp/.gif/.svg/.bmp/.ico/.avif with zoom, pan, rotate & transparency grid), and HTML (.html/.htm) files in the Antigravity desktop sidebar. Trigger whenever the user asks to preview, view, or open these files, or when task outputs include any of these formats.
---

# File Preview

This plugin adds a high-fidelity Aux Pane viewer in Antigravity Desktop for local `.pptx`, `.docx`, `.xlsx`, `.xls`, `.csv`, `.tsv`, `.pdf`, `.mp4`, `.webm`, `.mp3`, `.wav`, `.m4a`, `.ogg`, `.flac`, `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.svg`, `.bmp`, `.ico`, `.avif`, `.html`, and `.htm` files. It supports Word full-text search, Excel multi-sheet tabs / formula bar / merged cells / cross-sheet search, image zoom/pan/rotation/backdrop switching, auto hover-to-select & blank-area drag-to-pan, and HTTP `206 Partial Content` streaming for large (>20MB) PDFs, videos, and audio files.

## Opening the Sidebar Viewer

- Users can trigger `/file-preview` or click the interactive badge below to open the sidebar panel:

  [File Preview](sidecar://file-preview/viewer/)

- Clicking any supported document, image, audio, video, or HTML extension in the Antigravity workspace also opens File Preview automatically via `file_extensions`.

## Usage Guidelines

1. After creating, editing, or inspecting any supported Office, PDF, image (`.jpg`/`.png`/`.webp`/`.gif`/`.svg`/`.avif`/`.bmp`/`.ico`), audio (`.mp3`/`.wav`/`.m4a`/`.ogg`/`.flac`), video (`.mp4`/`.webm`), or HTML file (especially large >20MB files), **proactively** include `[File Preview](sidecar://file-preview/viewer/)` in your final reply.
2. To open a specific file, instruct the user to click the badge and choose the file from the sidebar list (or paste an absolute path / drag & drop the file), or click the file directly in the workspace.
3. For Excel (`.xlsx` / `.xls` / `.csv` / `.tsv`), the viewer provides bottom sheet tabs, a top formula bar showing raw `=` formulas and evaluated values (with one-click / `Ctrl+C` copy), merged-cell spans, zoom controls, and cross-sheet search; `.csv` / `.tsv` auto-detect UTF-8 and GB18030 encodings.
4. For PDFs, videos (`.mp4` / `.webm`), and audio (`.mp3` / `.wav` / `.m4a` / `.ogg` / `.flac`), a local HTTP `206 Partial Content` streaming server loads chunks on demand (PDF supports Slide/Scroll views, thumbnails, zoom, and full-text search; Audio/Video support playback speed `0.5x–2x` and loop toggles).
5. For images (`.jpg` / `.jpeg` / `.png` / `.webp` / `.gif` / `.svg` / `.bmp` / `.ico` / `.avif`), the viewer supports Fit / `1:1` / 10%–800% zoom (`Ctrl+Scroll`, double-click toggle), drag-to-pan when zoomed, 90° rotation (`R` / `Shift+R`), transparent canvas backdrop switching (Checkerboard / Light / Dark), and flicker-free auto-refresh.
6. If legacy binary `.doc` or `.ppt` files are encountered, inform the user that browser-side rendering is not supported for legacy binary formats and advise saving them as `.docx` or `.pptx` in Word / PowerPoint / WPS.
