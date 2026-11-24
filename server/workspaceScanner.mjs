import { readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { isForbiddenSystemPath, parseWorkspaceRoot } from './pathSecurity.mjs';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.venv',
  'dist',
  'build',
  '.next',
  '.system_generated',
]);

const SUPPORTED_EXTS = new Map([
  ['.pptx', 'ppt'],
  ['.docx', 'word'],
  ['.xlsx', 'excel'],
  ['.xls', 'excel'],
  ['.csv', 'excel'],
  ['.tsv', 'excel'],
  ['.pdf', 'pdf'],
  ['.mp4', 'mp4'],
  ['.jpg', 'image'],
  ['.jpeg', 'image'],
  ['.png', 'image'],
  ['.html', 'html'],
  ['.htm', 'html'],
]);

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_LIMIT = 200;
const HARD_COLLECT_CAP = 2000;

/**
 * 判断文件名是否为 Office 临时锁文件或系统隐藏元数据文件（如 ~$*.docx、.~lock.*、._*）。
 * @param {string} name
 * @returns {boolean}
 */
function isIgnoredTempFile(name) {
  return name.startsWith('~$') || name.startsWith('.~') || name.startsWith('._');
}

/**
 * 递归扫描工作区中的可预览文件（.pptx / .docx / .xlsx / .xls / .csv / .tsv / .pdf / .mp4 / .jpg / .jpeg / .png / .html / .htm）。
 * @param {string[] | string} [workspaceUris]
 * @param {object} [options]
 * @param {string} [options.currentFile] 当前打开的文件路径或 URI，在无可用根目录时回退扫描其所在目录
 * @param {number} [options.maxDepth] 最大递归深度（默认 5）
 * @param {number} [options.limit] 返回条数上限（默认 200）
 * @returns {Array<{
 *   path: string,
 *   name: string,
 *   ext: string,
 *   kind: 'ppt' | 'word' | 'excel' | 'html' | 'pdf' | 'mp4' | 'image',
 *   size: number,
 *   mtimeMs: number,
 *   relPath: string,
 *   workspaceRoot: string,
 * }>}
 */
export function scanWorkspaceFiles(workspaceUris = [], options = {}) {
  const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const limit = typeof options.limit === 'number' ? options.limit : DEFAULT_LIMIT;

  const rawList = Array.isArray(workspaceUris)
    ? workspaceUris
    : typeof workspaceUris === 'string'
      ? [workspaceUris]
      : [];

  const uniqueRoots = [];
  const seenRootKeys = new Set();

  function tryAddRoot(candidate) {
    if (!candidate || typeof candidate !== 'string') return false;
    const parsed = parseWorkspaceRoot(candidate);
    if (!parsed) return false;

    let realRoot;
    try {
      realRoot = realpathSync(parsed);
      const stat = statSync(realRoot);
      if (!stat.isDirectory()) return false;
    } catch {
      return false;
    }

    if (isForbiddenSystemPath(realRoot)) return false;

    const key = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
    if (seenRootKeys.has(key)) return true;
    seenRootKeys.add(key);
    uniqueRoots.push(realRoot);
    return true;
  }

  for (const item of rawList) {
    tryAddRoot(item);
  }

  // 当传入的 workspaceUris 为空或没有有效目录时，自动回退到 process.env.WORKSPACE_ROOT
  if (uniqueRoots.length === 0 && process.env.WORKSPACE_ROOT) {
    tryAddRoot(process.env.WORKSPACE_ROOT);
  }

  // 如果同时传入了 options.currentFile，在无可用根目录时支持回退扫描 dirname(options.currentFile)
  if (uniqueRoots.length === 0 && options.currentFile && typeof options.currentFile === 'string') {
    const parsedFile = parseWorkspaceRoot(options.currentFile);
    if (parsedFile) {
      let candidateDir = dirname(parsedFile);
      try {
        const stat = statSync(parsedFile);
        if (stat.isDirectory()) {
          candidateDir = parsedFile;
        }
      } catch {
        // 若目标路径不是已存在文件或 stat 失败，仍尝试以其父目录作为候选
      }
      tryAddRoot(candidateDir);
    }
  }

  const results = [];
  const seenFiles = new Set();
  const visitedDirs = new Set();

  for (const rootDir of uniqueRoots) {
    walkDirectory(rootDir, rootDir, 0);
    if (results.length >= HARD_COLLECT_CAP) break;
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, limit);

  /**
   * @param {string} currentDir
   * @param {string} rootDir
   * @param {number} depth
   */
  function walkDirectory(currentDir, rootDir, depth) {
    if (results.length >= HARD_COLLECT_CAP) return;
    if (isForbiddenSystemPath(currentDir)) return;

    const dirKey = process.platform === 'win32' ? currentDir.toLowerCase() : currentDir;
    if (visitedDirs.has(dirKey)) return;
    visitedDirs.add(dirKey);

    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= HARD_COLLECT_CAP) break;

      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        walkDirectory(fullPath, rootDir, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      if (isIgnoredTempFile(entry.name)) continue;

      const ext = extname(entry.name).toLowerCase();
      const kind = SUPPORTED_EXTS.get(ext);
      if (!kind) continue;

      let realFile;
      let stat;
      try {
        realFile = realpathSync(fullPath);
        stat = statSync(realFile);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      const fileKey = process.platform === 'win32' ? realFile.toLowerCase() : realFile;
      if (seenFiles.has(fileKey)) continue;
      seenFiles.add(fileKey);

      results.push({
        path: realFile,
        name: entry.name,
        ext,
        kind,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        relPath: relative(rootDir, fullPath).split(sep).join('/'),
        workspaceRoot: rootDir,
      });
    }
  }
}
