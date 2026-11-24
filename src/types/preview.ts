export type PreviewKind = 'ppt' | 'word' | 'excel' | 'html' | 'pdf' | 'mp4' | 'audio' | 'image';

export const LARGE_PDF_THRESHOLD_BYTES = 20 * 1024 * 1024;

export interface FileStatInfo {
  path: string;
  name: string;
  ext: string;
  kind: PreviewKind;
  size: number;
  mtimeMs: number;
}

export interface WorkspaceFileItem extends FileStatInfo {
  relPath: string;
  workspaceRoot: string;
}

export interface HtmlMountInfo {
  url: string;
  entryRelPath: string;
  mountId: string;
  mountRoot: string;
}

export interface PdfMountInfo {
  url: string;
  mountId: string;
  fileName: string;
  size: number;
}

export interface VideoMountInfo {
  url: string;
  mountId: string;
  fileName: string;
  size: number;
}

export interface AudioMountInfo {
  url: string;
  mountId: string;
  fileName: string;
  size: number;
}

export interface ImageMountInfo {
  url: string;
  mountId: string;
  fileName: string;
  size: number;
}

export type HtmlPreviewMode = 'sandbox' | 'interactive' | 'source';
export type PptLayoutMode = 'slide' | 'list';
export type ImageBackgroundMode = 'checker' | 'light' | 'dark';

export interface PreviewStateInfo {
  kind: PreviewKind;
  page?: number;
  totalPages?: number;
  zoom?: number;
  fitMode?: boolean;
  layoutMode?: PptLayoutMode;
  thumbnailsVisible?: boolean;
  searchMatches?: number;
  activeMatch?: number;
  htmlMode?: HtmlPreviewMode;
  sheetNames?: string[];
  activeSheet?: string;
  rowCount?: number;
  colCount?: number;
  fileSize?: number;
  rotation?: number;
  imageWidth?: number;
  imageHeight?: number;
  imageBg?: ImageBackgroundMode;
  warning?: string;
}

export interface PreviewRenderer {
  mount(container: HTMLElement): void;
  loadBuffer?(buffer: ArrayBuffer, meta: { name: string; path: string; ext: string }): Promise<void>;
  /** 原地重载新缓冲区并尽量保留当前页/工作表/选区与搜索状态 */
  reloadBuffer?(buffer: ArrayBuffer, meta: { name: string; path: string; ext: string }): Promise<void>;
  loadHtml?(
    mountInfo: HtmlMountInfo | null,
    sourceText: string,
    meta: { name: string; path: string; ext: string }
  ): Promise<void>;
  loadPdf?(
    mountInfo: PdfMountInfo | null,
    buffer: ArrayBuffer | null,
    meta: { name: string; path: string; ext: string; size?: number }
  ): Promise<void>;
  loadVideo?(
    mountInfo: VideoMountInfo | null,
    objectUrl: string | null,
    meta: { name: string; path: string; ext: string; size?: number }
  ): Promise<void>;
  loadAudio?(
    mountInfo: AudioMountInfo | null,
    objectUrl: string | null,
    meta: { name: string; path: string; ext: string; size?: number }
  ): Promise<void>;
  loadImage?(
    mountInfo: ImageMountInfo | null,
    objectUrl: string | null,
    meta: { name: string; path: string; ext: string; size?: number }
  ): Promise<void>;
  refresh?(): Promise<void>;
  setZoom?(zoom: number | 'fit'): void;
  rotateImage?(deltaDeg: number): void;
  setImageBackground?(mode: ImageBackgroundMode): void;
  nextPage?(): void;
  prevPage?(): void;
  goToPage?(page: number): void;
  setLayoutMode?(mode: PptLayoutMode): void;
  toggleThumbnails?(visible?: boolean): void;
  search?(query: string): Promise<{ total: number; current: number }>;
  nextMatch?(): void;
  prevMatch?(): void;
  setHtmlMode?(mode: HtmlPreviewMode): void;
  onStateChange?(cb: (info: PreviewStateInfo) => void): void;
  destroy(): void;
}
