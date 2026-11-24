import { realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 携带 HTTP 状态码与可选错误码的业务异常。
 */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} message 中文错误描述
   * @param {string} [code] 机器可读错误码
   */
  constructor(status, message, code = 'ERROR') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

const SUPPORTED_FORMATS = new Map([
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

const LEGACY_BINARY_FORMATS = new Map([
  [
    '.ppt',
    {
      code: 'UNSUPPORTED_LEGACY_PPT',
      message: '暂不支持旧版二进制 .ppt 格式，请在 PowerPoint 或 WPS 中将其另存为 .pptx 后再预览。',
    },
  ],
  [
    '.doc',
    {
      code: 'UNSUPPORTED_LEGACY_DOC',
      message: '暂不支持旧版二进制 .doc 格式，请在 Word 或 WPS 中将其另存为 .docx 后再预览。',
    },
  ],
]);

/**
 * 将原始输入路径（Windows 绝对路径、file:// URI、~/ 路径等）解析为规范化本地绝对路径。
 * @param {unknown} rawInput
 * @returns {string}
 */
export function parseInputPath(rawInput) {
  if (typeof rawInput !== 'string') {
    throw new HttpError(400, '文件路径参数必须为字符串', 'INVALID_PATH');
  }

  if (rawInput.includes('\0')) {
    throw new HttpError(400, '文件路径包含非法空字节', 'NULL_BYTE_PATH');
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new HttpError(400, '文件路径不能为空', 'EMPTY_PATH');
  }

  let localPath = trimmed;

  if (/^file:\/\//i.test(trimmed)) {
    try {
      localPath = fileURLToPath(trimmed);
    } catch {
      throw new HttpError(400, '无效的 file:// 文件路径 URI', 'INVALID_FILE_URI');
    }
  } else if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    localPath = join(homedir(), trimmed.slice(1));
  }

  if (localPath.includes('\0')) {
    throw new HttpError(400, '文件路径包含非法空字节', 'NULL_BYTE_PATH');
  }

  return resolve(localPath);
}

/**
 * 尝试将工作区 URI 或本地路径条目转换为规范化本地目录路径，无效条目返回 null。
 * @param {unknown} entry
 * @returns {string | null}
 */
export function parseWorkspaceRoot(entry) {
  if (typeof entry !== 'string') return null;
  const trimmed = entry.trim();
  if (!trimmed || trimmed.includes('\0')) return null;

  try {
    return parseInputPath(trimmed);
  } catch {
    return null;
  }
}

/**
 * 检查路径是否命中受保护的 .system_generated/logs 或 .system_generated/messages 目录。
 * @param {string} targetPath
 * @returns {boolean}
 */
export function isForbiddenSystemPath(targetPath) {
  const normalized = targetPath.replace(/\\/g, '/');
  return /(^|\/)\.system_generated\/(logs|messages)(\/|$)/i.test(normalized);
}

/**
 * 判断 targetPath 是否位于 rootPath 之内（支持 Windows 大小写不敏感与盘符根目录如 D:\）。
 * @param {string} targetPath
 * @param {string} rootPath
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function isPathWithinRoot(targetPath, rootPath, platform = process.platform) {
  const pathApi = platform === 'win32' ? win32 : posix;
  let target = pathApi.resolve(targetPath);
  let root = pathApi.resolve(rootPath);

  if (platform === 'win32') {
    target = target.toLowerCase();
    root = root.toLowerCase();
  }

  const prefix = root.endsWith(pathApi.sep) ? root : `${root}${pathApi.sep}`;
  return target === root || target.startsWith(prefix);
}

/**
 * 去重并追加根目录（若目录存在则同时包含 realpathSync 结果）。
 * @param {Set<string>} set
 * @param {string | null | undefined} candidate
 */
function addRootCandidate(set, candidate) {
  if (!candidate || typeof candidate !== 'string') return;
  const parsed = parseWorkspaceRoot(candidate);
  if (!parsed) return;
  set.add(parsed);
  try {
    set.add(realpathSync(parsed));
  } catch {
    // 根目录可能尚未创建或不可访问，保留解析后的绝对路径即可
  }
}

/**
 * 构建工作区根目录列表与全局允许根目录白名单。
 * @param {string[] | string} [workspaceUris]
 * @param {string[]} [extraAllowedRoots]
 * @returns {{ workspaceRoots: string[], allowedRoots: string[] }}
 */
export function resolveRootSets(workspaceUris = [], extraAllowedRoots = []) {
  const workspaceSet = new Set();
  const uriList = Array.isArray(workspaceUris)
    ? workspaceUris
    : typeof workspaceUris === 'string'
      ? [workspaceUris]
      : [];

  for (const uri of uriList) {
    addRootCandidate(workspaceSet, uri);
  }
  addRootCandidate(workspaceSet, process.env.WORKSPACE_ROOT);

  const allowedSet = new Set(workspaceSet);
  addRootCandidate(allowedSet, homedir());
  addRootCandidate(allowedSet, tmpdir());
  addRootCandidate(allowedSet, process.cwd());
  addRootCandidate(allowedSet, process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR);

  if (Array.isArray(extraAllowedRoots)) {
    for (const root of extraAllowedRoots) {
      addRootCandidate(allowedSet, root);
    }
  }

  return {
    workspaceRoots: Array.from(workspaceSet),
    allowedRoots: Array.from(allowedSet),
  };
}

/**
 * 判断路径是否位于允许的根目录列表中。
 * @param {string} targetPath
 * @param {string[]} roots
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function isWithinAnyRoot(targetPath, roots, platform = process.platform) {
  return roots.some((root) => isPathWithinRoot(targetPath, root, platform));
}

/**
 * 在匹配的工作区根目录中选择层级最深（最长前缀）的一个。
 * @param {string} targetPath
 * @param {string[]} workspaceRoots
 * @param {NodeJS.Platform} [platform]
 * @returns {string | null}
 */
export function findDeepestWorkspaceRoot(targetPath, workspaceRoots, platform = process.platform) {
  let best = null;
  for (const root of workspaceRoots) {
    if (isPathWithinRoot(targetPath, root, platform)) {
      if (!best || root.length > best.length) {
        best = root;
      }
    }
  }
  return best;
}

/**
 * 根据文件扩展名校验并返回格式分类。
 * @param {string} filePath
 * @returns {{ ext: string, kind: 'ppt' | 'word' | 'excel' | 'html' | 'pdf' | 'mp4' | 'image' }}
 */
export function classifyFormat(filePath) {
  const ext = extname(filePath).toLowerCase();
  const kind = SUPPORTED_FORMATS.get(ext);
  if (kind) {
    return { ext, kind };
  }

  const legacy = LEGACY_BINARY_FORMATS.get(ext);
  if (legacy) {
    throw new HttpError(415, legacy.message, legacy.code);
  }

  throw new HttpError(
    415,
    `不支持的文件格式（${ext || '无扩展名'}），目前仅支持 .pptx、.docx、.xlsx、.xls、.csv、.tsv、.pdf、.mp4、.jpg、.jpeg、.png、.html 和 .htm 文件。`,
    'UNSUPPORTED_FORMAT',
  );
}

/**
 * 对待预览文件执行完整的路径解析、白名单检查、symlink 逃逸防护与格式校验。
 * @param {unknown} rawFile
 * @param {object} [options]
 * @param {string[] | string} [options.workspaceUris]
 * @param {string[]} [options.extraAllowedRoots]
 * @param {string[] | null} [options.allowedRootsOverride] 仅用于测试覆盖默认白名单
 * @returns {{
 *   path: string,
 *   requestedPath: string,
 *   name: string,
 *   ext: string,
 *   kind: 'ppt' | 'word' | 'excel' | 'html' | 'pdf' | 'mp4' | 'image',
 *   size: number,
 *   mtimeMs: number,
 *   workspaceRoot: string | null,
 *   workspaceRoots: string[],
 * }}
 */
export function validateFilePath(rawFile, options = {}) {
  const {
    workspaceUris = [],
    extraAllowedRoots = [],
    allowedRootsOverride = null,
  } = options;

  const resolved = parseInputPath(rawFile);

  if (isForbiddenSystemPath(resolved)) {
    throw new HttpError(403, '禁止访问受保护的系统生成日志或消息目录', 'FORBIDDEN_SYSTEM_PATH');
  }

  const { workspaceRoots, allowedRoots } = resolveRootSets(workspaceUris, extraAllowedRoots);
  const effectiveAllowedRoots = Array.isArray(allowedRootsOverride)
    ? allowedRootsOverride.map((r) => resolve(r))
    : allowedRoots;

  if (!isWithinAnyRoot(resolved, effectiveAllowedRoots)) {
    throw new HttpError(403, '文件路径不在允许的工作区或本地目录白名单范围内', 'OUTSIDE_ALLOWED_ROOTS');
  }

  // 先检查扩展名（便于直接反馈 .doc/.ppt/未知格式的 415 提示）
  classifyFormat(resolved);

  let realPath;
  try {
    realPath = realpathSync(resolved);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      throw new HttpError(404, '目标文件不存在', 'FILE_NOT_FOUND');
    }
    throw new HttpError(403, `无法读取目标文件路径: ${err?.message || '未知错误'}`, 'STAT_ERROR');
  }

  if (isForbiddenSystemPath(realPath)) {
    throw new HttpError(403, '禁止访问受保护的系统生成日志或消息目录', 'FORBIDDEN_SYSTEM_PATH');
  }

  if (!isWithinAnyRoot(realPath, effectiveAllowedRoots)) {
    throw new HttpError(403, '符号链接指向路径超出允许的根目录边界', 'SYMLINK_ESCAPE');
  }

  const { ext, kind } = classifyFormat(realPath);

  let stat;
  try {
    stat = statSync(realPath);
  } catch (err) {
    throw new HttpError(404, `无法获取文件信息: ${err?.message || '未知错误'}`, 'STAT_ERROR');
  }

  if (!stat.isFile()) {
    throw new HttpError(400, '目标路径不是普通文件', 'NOT_A_FILE');
  }

  const workspaceRoot = findDeepestWorkspaceRoot(realPath, workspaceRoots);

  return {
    path: realPath,
    requestedPath: resolved,
    name: basename(realPath),
    ext,
    kind,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    workspaceRoot,
    workspaceRoots,
  };
}
