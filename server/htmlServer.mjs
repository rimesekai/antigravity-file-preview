import { randomBytes } from 'node:crypto';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import {
  HttpError,
  findDeepestWorkspaceRoot,
  isForbiddenSystemPath,
  isPathWithinRoot,
} from './pathSecurity.mjs';

const MAX_ACTIVE_MOUNTS = 32;

export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
});

/** @type {Map<string, { mountRoot: string, entryRelPath: string, createdAt: number }>} */
const mounts = new Map();

/** @type {Map<string, { filePath: string, fileName: string, size: number, contentType?: string, createdAt: number }>} */
const pdfMounts = new Map();
const videoMounts = new Map();
const imageMounts = new Map();

const PDF_CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type, If-None-Match, If-Modified-Since',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Encoding, Content-Length, Content-Range',
});

/** @type {import('node:http').Server | null} */
let httpServer = null;
/** @type {Promise<number> | null} */
let listeningPromise = null;
let serverPort = 0;

function sendText(res, status, text, extraHeaders = {}) {
  res.writeHead(status, {
    ...extraHeaders,
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * 解析单个 HTTP Range 请求头（支持 bytes=start-end / bytes=start- / bytes=-suffix）。
 * @param {string} rangeHeader
 * @param {number} totalSize
 * @returns {{ ok: true, start: number, end: number } | { ok: false }}
 */
function parseByteRange(rangeHeader, totalSize) {
  if (totalSize <= 0) {
    return { ok: false };
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) {
    return { ok: false };
  }
  const startStr = match[1];
  const endStr = match[2];
  if (!startStr && !endStr) {
    return { ok: false };
  }

  let start;
  let end;
  if (!startStr) {
    const suffixLength = Number(endStr);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { ok: false };
    }
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(startStr);
    if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) {
      return { ok: false };
    }
    if (!endStr) {
      end = totalSize - 1;
    } else {
      end = Number(endStr);
      if (!Number.isSafeInteger(end) || end < start) {
        return { ok: false };
      }
      if (end >= totalSize) {
        end = totalSize - 1;
      }
    }
  }

  return { ok: true, start, end };
}

/**
 * 处理独立端口 HTTP Range 流式预览请求：OPTIONS/GET/HEAD /<prefix>/<mountId>/<fileName>
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} rawPathname
 * @param {Map<string, { filePath: string, fileName: string, size: number, createdAt: number }>} mountMap
 * @param {'p' | 'v'} routePrefix
 * @param {string} contentType
 */
function handleRangeMountRequest(req, res, rawPathname, mountMap, routePrefix, contentType) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...PDF_CORS_HEADERS,
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed', PDF_CORS_HEADERS);
    return;
  }

  const routeRegex = new RegExp(`^\\/${routePrefix}\\/([0-9a-f]{48})\\/([^/]+)$`);
  const match = routeRegex.exec(rawPathname);
  if (!match) {
    sendText(res, 404, 'Not Found', PDF_CORS_HEADERS);
    return;
  }

  const mountId = match[1];
  const rawFileName = match[2];

  let decodedName;
  try {
    decodedName = decodeURIComponent(rawFileName);
  } catch {
    sendText(res, 400, 'Bad Request', PDF_CORS_HEADERS);
    return;
  }

  const mount = mountMap.get(mountId);
  if (!mount || decodedName !== mount.fileName) {
    sendText(res, 404, 'Mount Not Found', PDF_CORS_HEADERS);
    return;
  }

  // 刷新 LRU 位置
  mountMap.delete(mountId);
  mountMap.set(mountId, mount);

  if (isForbiddenSystemPath(mount.filePath)) {
    sendText(res, 403, 'Forbidden', PDF_CORS_HEADERS);
    return;
  }

  let stat;
  try {
    stat = statSync(mount.filePath);
  } catch {
    sendText(res, 404, 'Not Found', PDF_CORS_HEADERS);
    return;
  }

  if (!stat.isFile()) {
    sendText(res, 404, 'Not Found', PDF_CORS_HEADERS);
    return;
  }

  const totalSize = stat.size;
  const baseHeaders = {
    ...PDF_CORS_HEADERS,
    'Accept-Ranges': 'bytes',
    'Content-Type': mount.contentType || contentType,
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };

  const rangeHeader = req.headers.range;
  if (typeof rangeHeader === 'string' && rangeHeader.trim() !== '') {
    const parsed = parseByteRange(rangeHeader, totalSize);
    if (!parsed.ok) {
      res.writeHead(416, {
        ...PDF_CORS_HEADERS,
        'Content-Range': `bytes */${totalSize}`,
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      res.end('Range Not Satisfiable');
      return;
    }

    const { start, end } = parsed;
    const contentLength = end - start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': contentLength,
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = createReadStream(mount.filePath, { start, end });
    stream.on('error', () => {
      if (!res.headersSent) {
        sendText(res, 500, 'Internal Server Error', PDF_CORS_HEADERS);
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
    return;
  }

  res.writeHead(200, {
    ...baseHeaders,
    'Content-Length': totalSize,
  });

  if (req.method === 'HEAD' || totalSize === 0) {
    res.end();
    return;
  }

  const stream = createReadStream(mount.filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      sendText(res, 500, 'Internal Server Error', PDF_CORS_HEADERS);
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

/**
 * 解码并校验挂载路径中的相对段，阻止 .. 穿越与空字节。
 * @param {string} rawRelPath
 * @returns {string[] | null}
 */
function parseSafeSegments(rawRelPath) {
  if (!rawRelPath) return null;
  const parts = rawRelPath.split('/');
  const decodedParts = [];

  for (const part of parts) {
    if (!part) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return 'BAD_ENCODING';
    }
    if (!decoded || decoded.includes('\0') || decoded.includes('\\') || decoded.includes('/')) {
      return null;
    }
    if (decoded === '..' || decoded === '.') {
      return null;
    }
    decodedParts.push(decoded);
  }

  return decodedParts;
}

/**
 * 处理独立端口 HTML 静态预览请求：GET/HEAD /m/<mountId>/<relPath...>
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function handlePreviewRequest(req, res) {
  const rawPathname = (req.url || '/').split('?')[0].split('#')[0];
  if (rawPathname.startsWith('/p/')) {
    handleRangeMountRequest(req, res, rawPathname, pdfMounts, 'p', 'application/pdf');
    return;
  }

  if (rawPathname.startsWith('/v/')) {
    handleRangeMountRequest(req, res, rawPathname, videoMounts, 'v', 'video/mp4');
    return;
  }

  if (rawPathname.startsWith('/i/')) {
    handleRangeMountRequest(req, res, rawPathname, imageMounts, 'i', 'application/octet-stream');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  const match = /^\/m\/([0-9a-f]{48})\/(.+)$/.exec(rawPathname);
  if (!match) {
    sendText(res, 404, 'Not Found');
    return;
  }

  const mountId = match[1];
  const rawRelPath = match[2];

  const mount = mounts.get(mountId);
  if (!mount) {
    sendText(res, 404, 'Mount Not Found');
    return;
  }

  // 刷新 LRU 位置
  mounts.delete(mountId);
  mounts.set(mountId, mount);

  const segments = parseSafeSegments(rawRelPath);
  if (segments === 'BAD_ENCODING') {
    sendText(res, 400, 'Bad Request');
    return;
  }
  if (!segments) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  const candidate = resolve(mount.mountRoot, ...segments);
  if (!isPathWithinRoot(candidate, mount.mountRoot) || isForbiddenSystemPath(candidate)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let realCandidate;
  try {
    realCandidate = realpathSync(candidate);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      sendText(res, 404, 'Not Found');
      return;
    }
    sendText(res, 403, 'Forbidden');
    return;
  }

  if (!isPathWithinRoot(realCandidate, mount.mountRoot) || isForbiddenSystemPath(realCandidate)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let stat;
  try {
    stat = statSync(realCandidate);
  } catch {
    sendText(res, 404, 'Not Found');
    return;
  }

  if (!stat.isFile()) {
    sendText(res, 404, 'Not Found');
    return;
  }

  const ext = extname(realCandidate).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(realCandidate);
  stream.on('error', () => {
    if (!res.headersSent) {
      sendText(res, 500, 'Internal Server Error');
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

/**
 * 按需懒启动 127.0.0.1:0 原生静态 HTTP 服务。
 * @returns {Promise<number>}
 */
export async function ensureHtmlServerStarted() {
  if (httpServer && serverPort > 0) {
    return serverPort;
  }
  if (listeningPromise) {
    return listeningPromise;
  }

  listeningPromise = new Promise((resolvePromise, rejectPromise) => {
    const server = createServer(handlePreviewRequest);
    server.once('error', (err) => {
      listeningPromise = null;
      rejectPromise(err);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        listeningPromise = null;
        rejectPromise(new Error('无法获取 HTML 预览服务监听端口'));
        return;
      }
      httpServer = server;
      serverPort = addr.port;
      resolvePromise(serverPort);
    });
  });

  return listeningPromise;
}

/**
 * 将合法的本地 .html/.htm 文件注册为独立跨源预览挂载点。
 * 若文件位于工作区根目录内，以该工作区根目录为 mountRoot，否则限定在其所在目录。
 * @param {string} resolvedFilePath 已通过安全校验的真实文件路径
 * @param {string[]} [allowedWorkspaceRoots]
 * @returns {Promise<{ url: string, mountId: string, entryRelPath: string, mountRoot: string }>}
 */
export async function mountHtmlTarget(resolvedFilePath, allowedWorkspaceRoots = []) {
  const realFilePath = realpathSync(resolvedFilePath);
  const ext = extname(realFilePath).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') {
    throw new HttpError(415, '仅支持挂载 .html 或 .htm 文件', 'INVALID_HTML_TARGET');
  }

  const normalizedWorkspaceRoots = [];
  for (const root of allowedWorkspaceRoots) {
    try {
      normalizedWorkspaceRoots.push(realpathSync(root));
    } catch {
      // 忽略不存在的候选工作区路径
    }
  }

  const matchedRoot = findDeepestWorkspaceRoot(realFilePath, normalizedWorkspaceRoots);
  const mountRoot = matchedRoot || dirname(realFilePath);

  const relPathNative = relative(mountRoot, realFilePath);
  if (!relPathNative || relPathNative.startsWith('..')) {
    throw new HttpError(403, '入口文件不在挂载根目录内', 'MOUNT_BOUNDARY_ERROR');
  }

  const entrySegments = relPathNative.split(sep).filter(Boolean);
  const entryRelPath = entrySegments.join('/');
  const encodedEntry = entrySegments.map((seg) => encodeURIComponent(seg)).join('/');

  const port = await ensureHtmlServerStarted();
  const mountId = randomBytes(24).toString('hex');

  mounts.set(mountId, {
    mountRoot,
    entryRelPath,
    createdAt: Date.now(),
  });

  // LRU 上限控制，保留最近 32 个活跃挂载
  while (mounts.size > MAX_ACTIVE_MOUNTS) {
    const oldestKey = mounts.keys().next().value;
    if (!oldestKey) break;
    mounts.delete(oldestKey);
  }

  return {
    url: `http://127.0.0.1:${port}/m/${mountId}/${encodedEntry}`,
    mountId,
    entryRelPath,
    mountRoot,
  };
}

async function mountRangeTarget(
  resolvedFilePath,
  expectedExts,
  routePrefix,
  mountMap,
  invalidCode,
  invalidMessage,
) {
  const realFilePath = realpathSync(resolvedFilePath);
  if (isForbiddenSystemPath(realFilePath)) {
    throw new HttpError(403, '禁止访问受保护的系统生成日志或消息目录', 'FORBIDDEN_SYSTEM_PATH');
  }

  const allowedExts = Array.isArray(expectedExts) ? expectedExts : [expectedExts];
  const ext = extname(realFilePath).toLowerCase();
  if (!allowedExts.includes(ext)) {
    throw new HttpError(415, invalidMessage, invalidCode);
  }

  const stat = statSync(realFilePath);
  if (!stat.isFile()) {
    throw new HttpError(400, '目标路径不是普通文件', 'NOT_A_FILE');
  }

  const port = await ensureHtmlServerStarted();
  const mountId = randomBytes(24).toString('hex');
  const fileName = basename(realFilePath);
  const contentType = MIME_TYPES[ext] || undefined;

  mountMap.set(mountId, {
    filePath: realFilePath,
    fileName,
    size: stat.size,
    contentType,
    createdAt: Date.now(),
  });

  // LRU 上限控制，保留最近 32 个活跃挂载
  while (mountMap.size > MAX_ACTIVE_MOUNTS) {
    const oldestKey = mountMap.keys().next().value;
    if (!oldestKey) break;
    mountMap.delete(oldestKey);
  }

  return {
    url: `http://127.0.0.1:${port}/${routePrefix}/${mountId}/${encodeURIComponent(fileName)}`,
    mountId,
    fileName,
    size: stat.size,
  };
}

/**
 * 将合法的本地 .pdf 文件注册为独立端口 HTTP Range 流式预览挂载点。
 * @param {string} resolvedFilePath 已通过安全校验的真实文件路径
 * @returns {Promise<{ url: string, mountId: string, fileName: string, size: number }>}
 */
export async function mountPdfTarget(resolvedFilePath) {
  return mountRangeTarget(
    resolvedFilePath,
    '.pdf',
    'p',
    pdfMounts,
    'INVALID_PDF_TARGET',
    '仅支持挂载 .pdf 文件',
  );
}

/**
 * 将合法的本地 .mp4 文件注册为独立端口 HTTP Range 流式播放挂载点。
 * @param {string} resolvedFilePath 已通过安全校验的真实文件路径
 * @returns {Promise<{ url: string, mountId: string, fileName: string, size: number }>}
 */
export async function mountVideoTarget(resolvedFilePath) {
  return mountRangeTarget(
    resolvedFilePath,
    '.mp4',
    'v',
    videoMounts,
    'INVALID_VIDEO_TARGET',
    '仅支持挂载 .mp4 文件',
  );
}

/**
 * 将合法的本地 .jpg / .jpeg / .png 图片文件注册为独立端口静态预览挂载点。
 * @param {string} resolvedFilePath 已通过安全校验的真实文件路径
 * @returns {Promise<{ url: string, mountId: string, fileName: string, size: number }>}
 */
export async function mountImageTarget(resolvedFilePath) {
  return mountRangeTarget(
    resolvedFilePath,
    ['.jpg', '.jpeg', '.png'],
    'i',
    imageMounts,
    'INVALID_IMAGE_TARGET',
    '仅支持挂载 .jpg、.jpeg 或 .png 图片文件',
  );
}

/**
 * 获取当前活跃挂载数量（供测试与监控使用）。
 * @returns {number}
 */
export function getActiveMountCount() {
  return mounts.size;
}

/**
 * 获取当前活跃 PDF 挂载数量（供测试与监控使用）。
 * @returns {number}
 */
export function getActivePdfMountCount() {
  return pdfMounts.size;
}

/**
 * 获取当前活跃视频挂载数量（供测试与监控使用）。
 * @returns {number}
 */
export function getActiveVideoMountCount() {
  return videoMounts.size;
}

/**
 * 获取当前活跃图片挂载数量（供测试与监控使用）。
 * @returns {number}
 */
export function getActiveImageMountCount() {
  return imageMounts.size;
}

/**
 * 关闭独立 HTML/PDF/MP4/Image 静态预览服务并清理所有挂载点。
 * @returns {Promise<void>}
 */
export async function closeHtmlServer() {
  mounts.clear();
  pdfMounts.clear();
  videoMounts.clear();
  imageMounts.clear();
  listeningPromise = null;
  serverPort = 0;

  if (!httpServer) {
    return;
  }

  const server = httpServer;
  httpServer = null;

  await new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
}
