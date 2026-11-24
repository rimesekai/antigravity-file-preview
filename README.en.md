<div align="center">
  <img src="./assets/logo.svg" alt="File Preview Logo" width="88" height="88" />
  <h1>Antigravity File Preview</h1>
  <p>High-fidelity local preview for PPTX, DOCX, XLSX/CSV, PDF, MP4 (&gt;20MB streaming), Images (JPG/PNG), and HTML in Antigravity's desktop Aux Pane</p>

  <p>
    <a href="https://github.com/rimesekai/antigravity-file-preview/actions/workflows/ci.yml">
      <img src="https://github.com/rimesekai/antigravity-file-preview/actions/workflows/ci.yml/badge.svg" alt="CI Status" />
    </a>
    <a href="https://github.com/rimesekai/antigravity-file-preview/releases/latest">
      <img src="https://img.shields.io/github/v/release/rimesekai/antigravity-file-preview?label=version&amp;color=2563eb" alt="Version" />
    </a>
    <a href="./LICENSE">
      <img src="https://img.shields.io/badge/License-MIT-16a34a.svg" alt="License: MIT" />
    </a>
    <a href="https://nodejs.org/">
      <img src="https://img.shields.io/badge/node-%3E%3D20-339933.svg" alt="Node >= 20" />
    </a>
  </p>

  <p>
    <a href="./README.md">简体中文</a> | <strong>English</strong> | <a href="./CHANGELOG.md">Changelog</a>
  </p>
</div>

---

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <img src="./assets/screenshots/welcome-light.png" alt="Welcome Light Theme" width="100%" /><br />
      <sub><b>Welcome · Light Mode (Custom Accent Seed)</b></sub>
    </td>
    <td align="center" width="50%">
      <img src="./assets/screenshots/welcome-dark.png" alt="Welcome Dark Theme" width="100%" /><br />
      <sub><b>Welcome · Dark Mode</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="./assets/screenshots/preview-ppt-light.png" alt="PPT Preview Light Mode" width="100%" /><br />
      <sub><b>PPTX Preview · Light Azure</b></sub>
    </td>
    <td align="center" width="50%">
      <img src="./assets/screenshots/preview-ppt-dark.png" alt="PPT Preview Dark Mode" width="100%" /><br />
      <sub><b>PPTX Preview · Dark Warm Amber</b></sub>
    </td>
  </tr>
</table>

## Supported Formats Overview

| Format | Engine / Transport | Size Limit | Highlights |
| --- | --- | --- | --- |
| **PPT** (`.pptx`) | `@aiden0z/pptx-renderer` | `60 MB` | Slide / list view, fit & zoom with drag-to-pan, thumbnail rail, text search, up to `50,000` ZIP entries & in-place reload |
| **Word** (`.docx`) | `docx-preview` | `60 MB` | Pagination, headers / footers & tables, fit-width zoom with drag-to-pan, cross-run search (`Ctrl/Cmd+F`) |
| **Excel / CSV** (`.xlsx` / `.xls` / `.csv` / `.tsv`) | `xlsx` (SheetJS `0.20.3`) | `60 MB` | Multi-sheet tabs, formula bar & `Ctrl/Cmd+C` copy, merged cell span highlighting, sparse `!ref` trim & batched expansion |
| **PDF** (`.pdf`) | `pdfjs-dist` + local HTTP Range | `1 GB` | Bypass >20MB limit via HTTP `206` chunk streaming, drag-to-pan when zoomed, thumbnails, cross-page search, instant far-page jump |
| **MP4** (`.mp4`) | HTML5 Video + local HTTP Range | `4 GB` | Bypass >20MB limit via HTTP `206` streaming, scrubbing, `0.5x–2x` speed, loop |
| **Images** (`.jpg` / `.jpeg` / `.png`) | Native Image + local static server | `256 MB` | Fit / `1:1` / `10%–800%` zoom, drag-to-pan, 90° rotation, checkerboard/light/dark backdrop & flicker-free auto-reload |
| **HTML** (`.html` / `.htm`) | Isolated static server (`127.0.0.1:0`) | `80 MB` (source text) | Loads relative CSS / JS / images / fonts safely across Sandbox, Interactive, and Source modes |

## Key Features

- **PPT Preview (`.pptx`)**: Powered by `@aiden0z/pptx-renderer` with slide / list layout modes, fit / zoom controls, collapsible thumbnails, and text search; expands ZIP entry (`50,000`) and embedded font limits for dense decks, fixes horizontal overflow clipping when zoomed in slide mode, supports blank-area left-drag or anywhere middle-drag to pan (auto text-cursor selection when hovering over text) when zoomed, and reloads in place preserving active slide, scroll offset, and search highlights.
- **Word Preview (`.docx`)**: Powered by `docx-preview` preserving pagination, headers / footers, footnotes / endnotes, and tables; supports fit-width zoom, blank-area left-drag or anywhere middle-drag to pan (auto text selection on hover) when zoomed, and full-text search across runs (`Ctrl/Cmd+F` shortcut focus, match counter, and next / previous jump highlighting).
- **Excel Preview (`.xlsx` / `.xls` / `.csv` / `.tsv`)**: Powered by `xlsx` (SheetJS `0.20.3`) with multi-sheet tab switching, top inspection / formula bar (showing raw formula `=` and evaluated value, with button and `Ctrl/Cmd+C` copy), merged cell (`rowSpan` / `colSpan`) rendering with full-span header highlighting, sparse `!ref` bounds trimming, batched row / column loading with hard safety caps, zoom controls, and cross-sheet search; `.csv` / `.tsv` auto-detect UTF-8 (with BOM) and GB18030 encoding.
- **PDF Preview (`.pdf`, >20MB streaming)**: Powered by `pdfjs-dist` over a dedicated local HTTP Range (`206 Partial Content`) server so large PDFs load on demand without buffering the entire file into memory; supports slide / list views, collapsible thumbnails, zoom / fit, blank-area left-drag or anywhere middle-drag to pan (auto text selection over the text layer) when zoomed, page jump, and cross-page text search.
- **MP4 Playback (`.mp4`, >20MB streaming)**: Streams local videos up to 4GB via local HTTP Range (`206 Partial Content`) with scrubbing, `0.5x–2x` playback speed, and loop toggle.
- **Image Preview (`.jpg` / `.jpeg` / `.png`)**: Served via the dedicated local HTTP server with Fit / `1:1` / `10%–800%` zoom (`Ctrl/Cmd + Scroll` cursor-anchored zoom and double-click toggle), drag-to-pan when zoomed, 90° rotation (`R` / `Shift+R` with recalculated rotated bounding box), transparent PNG canvas backdrop switching (Checkerboard / Light / Dark), and flicker-free in-place reload on file changes.
- **HTML Preview (`.html` / `.htm`)**: Served on demand from an isolated local static server (`127.0.0.1:0`) supporting relative assets (CSS / JS / images / fonts) within the file / workspace root; provides Sandbox, Interactive, and Read-only Source views.
- **In-Place Auto-Refresh, Appearance Engine & Bilingual UI**: Watches disk file `mtimeMs` / `size` every 2.5s and reloads active renderers in place when supported (preserving active slide / sheet, zoom, scroll offset, and search highlights); preserves accurate format badges on load errors and recovers automatically once the file is fixed; features a borderless 4-level surface hierarchy with tabular numerals, `flclash-ui` (`prism_ui`) 5-layer optical Liquid Glass system (canvas bevel displacement mapping with SVG `feDisplacementMap` RGB edge dispersion, directional rim specular rings, and interactive pointer glow with pure-solid fallback), and physics motion (continuous sliding segmented capsule, drawer backdrop recess scale, droplet spring switches, elastic button press, ink-only list rows, Hero Cookie-9 geometric watermark, and `prefers-reduced-motion` support), automatically follows Antigravity light / dark themes, and includes an Appearance popover (`Auto / Light / Dark`, auto-paired Light Azure / Dark Warm Amber plus 6 accent seed presets, 4 color styles, Pure Black OLED, Liquid Glass overlays, and `Auto / 简体中文 / English` language switcher).
- **Direct Text Selection, Smart Blank-Area Panning & Selection Feedback**: Text selection is enabled by default across preview renderers (PPT, Word, Excel, PDF, HTML source, etc.) with high-contrast `::selection` highlighting and no manual mode toggle; when zoomed in on PPT / PDF / Word, hovering over text automatically switches to a text cursor for left-drag selection, while dragging blank areas (or middle-dragging anywhere) switches to a grab cursor and pans the viewport. Selecting text shows a floating hint bar with a live character count badge and one-click **Copy**, rendering a tracked highlight overlay and status badge over the copied selection.
- **Workspace Discovery & Associations**: Automatically opens supported extensions from the workspace via `file_extensions`, plus a workspace file drawer, direct path input, and drag-and-drop preview.

## Quick Install (Prebuilt Bundle Included)

This repository includes the prebuilt runtime assets in `dist/`. After cloning, you can install directly into `~/.gemini/config/plugins/file-preview/` without installing dependencies or building from scratch:

```powershell
git clone https://github.com/rimesekai/antigravity-file-preview.git
cd antigravity-file-preview
npm.cmd run install:local
```

On macOS / Linux, run:

```bash
node scripts/install-local.mjs
```

After installation, reload or restart Antigravity plugins, then trigger `/file-preview`, click `[File Preview](sidecar://file-preview/viewer/)`, or click any `.pptx`, `.docx`, `.xlsx`, `.xls`, `.csv`, `.tsv`, `.pdf`, `.mp4`, `.jpg`, `.jpeg`, `.png`, `.html`, or `.htm` file in your workspace.

## Build & Test from Source

On Windows PowerShell, use `npm.cmd`. Note that `vite` / `esbuild` rely on platform-specific binaries inside `optionalDependencies`, so run a standard `npm install` without `--omit=optional` when building from source:

```powershell
npm.cmd install
npx.cmd tsc --noEmit
npm.cmd test
npm.cmd run build
npm.cmd run install:local
```

Build outputs are emitted to `dist/` (`dist/index.html`, `dist/app.js`, `dist/styles.css`, `dist/server.mjs`, `dist/pdf.worker.js`), with no `node_modules/` required at runtime.

## Supported Formats & Security Notes

- **Not Supported**: Legacy binary `.ppt` and `.doc` files (cannot be parsed natively in browser; re-save as `.pptx` or `.docx` in PowerPoint / Word / WPS first).
- **Path & Memory Boundaries**: Backend file APIs strictly validate paths against workspace / allowed roots and block traversal, out-of-root symlinks, and internal agent log paths. Formats parsed in browser memory (`.pptx` / `.docx` / `.xlsx` / `.xls` / `.csv` / `.tsv`) are capped at `60MB`; Excel sheets default to the first `2,000` rows × `100` columns with hard rendering caps; PDF (`1GB` limit), MP4 (`4GB` limit), and images (`256MB` limit) are served directly from the dedicated local HTTP server.
- **PDF.js & Third-Party Dependencies**:
  1. `pdfRenderer` passes `isEvalSupported: false` to `pdfjs-dist` to disable `Function` / `eval`-based glyph evaluation, mitigating CVE-2024-4367 (GHSA-wgrm-67xf-hhpq).
  2. `@aiden0z/pptx-renderer` internally calls `pdfjsLib.getDocument` with upstream defaults when handling embedded PDF data inside `.pptx` files—avoid opening untrusted `.pptx` files.
  3. The optional `canvas` dependency of `pdfjs-dist` pulls in legacy `tar` in the dev lockfile only; it is not bundled into `dist/`.

## License

Released under the [MIT License](./LICENSE).
