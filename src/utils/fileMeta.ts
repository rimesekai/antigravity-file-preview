import type { FileStatInfo, PreviewKind } from '../types/preview';

const EXT_KIND_MAP: Readonly<Record<string, PreviewKind>> = {
  '.pptx': 'ppt',
  '.ppt': 'ppt',
  '.docx': 'word',
  '.doc': 'word',
  '.xlsx': 'excel',
  '.xls': 'excel',
  '.csv': 'excel',
  '.tsv': 'excel',
  '.pdf': 'pdf',
  '.mp4': 'mp4',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.html': 'html',
  '.htm': 'html',
};

/**
 * 从原始路径中提取文件基础名（兼容 Windows `\` 与 POSIX `/`，忽略末尾斜杠及 `?`/`#` 查询片段）。
 */
function extractFileName(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return rawPath;

  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? '';
  const withoutTrailingSlash = withoutQuery.replace(/[\\/]+$/, '');
  const segments = withoutTrailingSlash.split(/[\\/]/);
  const lastSegment = segments[segments.length - 1]?.trim() ?? '';

  return lastSegment || withoutTrailingSlash || trimmed;
}

/**
 * 从文件名中提取小写扩展名（如 `.pptx`）；无有效扩展名时返回空字符串 `''`。
 */
function extractLowerExtension(fileName: string): string {
  const dotIdx = fileName.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx >= fileName.length - 1) {
    return '';
  }
  return fileName.slice(dotIdx).toLowerCase();
}

/**
 * 当服务端 stat 尚未返回或加载失败时，根据原始路径推断兜底文件元信息，
 * 避免工具栏格式徽标错误回退为 Word/DOCX。
 */
export function inferFallbackFileStat(rawPath: string): FileStatInfo {
  const name = extractFileName(rawPath);
  const ext = extractLowerExtension(name);
  const kind: PreviewKind = EXT_KIND_MAP[ext] ?? 'word';

  return {
    path: rawPath,
    name,
    ext,
    kind,
    size: 0,
    mtimeMs: 0,
  };
}

/**
 * 根据预览类型与文件扩展名生成工具栏左上角的大写格式徽标文本。
 */
export function formatKindBadge(kind: PreviewKind, ext: string): string {
  const normalized = ext.toLowerCase();
  switch (kind) {
    case 'ppt':
      return normalized === '.ppt' ? 'PPT' : 'PPTX';
    case 'word':
      return normalized === '.doc' ? 'DOC' : 'DOCX';
    case 'excel':
      if (normalized === '.csv') return 'CSV';
      if (normalized === '.tsv') return 'TSV';
      if (normalized === '.xls') return 'XLS';
      return 'XLSX';
    case 'pdf':
      return 'PDF';
    case 'mp4':
      return 'MP4';
    case 'image':
      if (normalized === '.png') return 'PNG';
      if (normalized === '.jpeg') return 'JPEG';
      return 'JPG';
    case 'html':
      return normalized === '.htm' ? 'HTM' : 'HTML';
  }
}
