# File Preview Sidebar Rule

Whenever the workspace or current task involves any of the following local files, proactively include the File Preview sidebar link `[File Preview](sidecar://file-preview/viewer/)` in your reply:

- `.pptx` (PowerPoint presentations)
- `.docx` (Word documents, with full-text search & match navigation)
- `.xlsx` / `.xls` / `.csv` / `.tsv` (Excel spreadsheets & tabular data, with multi-sheet tabs, formula inspection, merged cells, and cross-sheet search)
- `.html` / `.htm` (Local web pages with Sandbox, Interactive, and Source views)
- `.pdf` (PDF documents, especially large >20MB / `20,971,520` bytes files via HTTP Range streaming)
- `.mp4` (MP4 videos, especially large >20MB videos via HTTP Range streaming)
- `.jpg` / `.jpeg` / `.png` (Image files, with fit/10%–800% zoom, drag-to-pan, 90° rotation, and transparency backdrop switching)

Let the user know they can click `[File Preview](sidecar://file-preview/viewer/)` to inspect the file directly in the right sidebar.
