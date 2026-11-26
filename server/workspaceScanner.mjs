import { readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { isForbiddenSystemPath, parseWorkspaceRoot } from './pathSecurity.mjs';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.system_generated',
  '__pycache__',
  'coverage',
  '_work',
  '_tmp',
  '_temp',
  '_cache',
  '_build',
  '_out',
  '_output',
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
  ['.webm', 'mp4'],
  ['.mp3', 'audio'],
  ['.wav', 'audio'],
  ['.m4a', 'audio'],
  ['.ogg', 'audio'],
  ['.flac', 'audio'],
  ['.jpg', 'image'],
  ['.jpeg', 'image'],
  ['.png', 'image'],
  ['.webp', 'image'],
  ['.gif', 'image'],
  ['.svg', 'image'],
  ['.bmp', 'image'],
  ['.ico', 'image'],
  ['.avif', 'image'],
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
 * 按文档类型分配保底配额并填充剩余名额（内部假定 items 已按 mtimeMs 降序排列）。
 * @template {{ kind: string, mtimeMs: number }} T
 * @param {T[]} sortedItems
 * @param {number} limit
 * @returns {T[]}
 */
function selectByKindQuota(sortedItems, limit) {
  if (limit <= 0) return [];
  if (sortedItems.length <= limit) return sortedItems;

  const byKind = new Map();
  for (const item of sortedItems) {
    let list = byKind.get(item.kind);
    if (!list) {
      list = [];
      byKind.set(item.kind, list);
    }
    list.push(item);
  }

  const baseQuota = Math.floor(limit / byKind.size);
  if (baseQuota <= 0) {
    return sortedItems.slice(0, limit);
  }

  const pickedSet = new Set();
  const selected = [];
  for (const list of byKind.values()) {
    const takeCount = Math.min(list.length, baseQuota);
    for (let i = 0; i < takeCount; i += 1) {
      pickedSet.add(list[i]);
      selected.push(list[i]);
    }
  }

  if (selected.length < limit) {
    for (const item of sortedItems) {
      if (selected.length >= limit) break;
      if (!pickedSet.has(item)) {
        selected.push(item);
      }
    }
  }

  return selected;
}

/**
 * 当候选文件数超过 limit 时，同时按工作区根目录与文档类型分配保底配额，
 * 避免单个多文件文件夹或大量图片把其他工作区文件夹和 PDF/Word/PPT 挤出返回列表。
 * @template {{ kind: string, mtimeMs: number, workspaceRoot: string }} T
 * @param {T[]} sortedResults 已按 mtimeMs 降序排列的候选文件列表
 * @param {number} limit
 * @returns {T[]}
 */
function selectBalancedResults(sortedResults, limit) {
  if (limit <= 0) return [];
  if (sortedResults.length <= limit) return sortedResults;

  const byRoot = new Map();
  for (const item of sortedResults) {
    const rootKey =
      process.platform === 'win32' ? item.workspaceRoot.toLowerCase() : item.workspaceRoot;
    let list = byRoot.get(rootKey);
    if (!list) {
      list = [];
      byRoot.set(rootKey, list);
    }
    list.push(item);
  }

  let selected;
  if (byRoot.size <= 1) {
    selected = selectByKindQuota(sortedResults, limit);
  } else {
    const rootQuota = Math.floor(limit / byRoot.size);
    if (rootQuota <= 0) {
      selected = selectByKindQuota(sortedResults, limit);
    } else {
      const pickedSet = new Set();
      selected = [];
      for (const rootItems of byRoot.values()) {
        for (const item of selectByKindQuota(rootItems, rootQuota)) {
          pickedSet.add(item);
          selected.push(item);
        }
      }

      if (selected.length < limit) {
        const remaining = sortedResults.filter((item) => !pickedSet.has(item));
        selected.push(...selectByKindQuota(remaining, limit - selected.length));
      }
    }
  }

  selected.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return selected;
}

/**
 * 递归扫描工作区中的可预览文件。
 * @param {string[] | string} [workspaceUris]
 * @param {object} [options]
 * @param {string} [options.currentFile] 当前打开的文件路径或 URI，在无可用根目录时回退扫描其所在目录
 * @param {number} [options.maxDepth] 最大递归深度（默认 5）
 * @param {number} [options.limit] 返回条数上限（默认 200）
 * @returns {Array<{
 *   path: string,
 *   name: string,
 *   ext: string,
 *   kind: 'ppt' | 'word' | 'excel' | 'html' | 'pdf' | 'mp4' | 'audio' | 'image',
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
  const rootStates = [];

  function enqueueDirectory(state, currentDir, depth) {
    if (isForbiddenSystemPath(currentDir)) return;
    const dirKey = process.platform === 'win32' ? currentDir.toLowerCase() : currentDir;
    if (visitedDirs.has(dirKey)) return;
    visitedDirs.add(dirKey);
    state.queue.push({ currentDir, depth });
  }

  for (const rootDir of uniqueRoots) {
    const state = {
      rootDir,
      queue: [],
      head: 0,
      collected: 0,
    };
    enqueueDirectory(state, rootDir, 0);
    rootStates.push(state);
  }

  // 第一阶段：为每个工作区根目录预留均等扫描配额，防止前序大目录提前吃光 HARD_COLLECT_CAP
  if (rootStates.length > 0) {
    const perRootBudget = Math.max(1, Math.floor(HARD_COLLECT_CAP / rootStates.length));
    for (const state of rootStates) {
      while (
        state.head < state.queue.length &&
        state.collected < perRootBudget &&
        results.length < HARD_COLLECT_CAP
      ) {
        const { currentDir, depth } = state.queue[state.head++];
        scanDirectory(state, currentDir, depth);
      }
    }
  }

  // 第二阶段：若仍有剩余总采集额度，按根目录轮转广度扫描剩余目录
  while (results.length < HARD_COLLECT_CAP) {
    let progressed = false;
    for (const state of rootStates) {
      if (results.length >= HARD_COLLECT_CAP) break;
      if (state.head < state.queue.length) {
        const { currentDir, depth } = state.queue[state.head++];
        scanDirectory(state, currentDir, depth);
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return selectBalancedResults(results, limit);

  /**
   * 广度优先扫描单个目录：先收录本层文件再将未超深的子目录入队，避免深层大量素材阻塞上层文档发现。
   * @param {{ rootDir: string, queue: Array<{ currentDir: string, depth: number }>, head: number, collected: number }} state
   * @param {string} currentDir
   * @param {number} depth
   */
  function scanDirectory(state, currentDir, depth) {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    const subDirs = [];

    for (const entry of entries) {
      if (results.length >= HARD_COLLECT_CAP) break;

      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (depth < maxDepth && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name.toLowerCase())) {
          subDirs.push(fullPath);
        }
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

      state.collected += 1;
      results.push({
        path: realFile,
        name: entry.name,
        ext,
        kind,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        relPath: relative(state.rootDir, fullPath).split(sep).join('/'),
        workspaceRoot: state.rootDir,
      });
    }

    for (const subDir of subDirs) {
      enqueueDirectory(state, subDir, depth + 1);
    }
  }
}
