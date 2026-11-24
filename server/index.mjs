import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { closeHtmlServer, mountHtmlTarget, mountImageTarget, mountPdfTarget, mountVideoTarget } from './htmlServer.mjs';
import { HttpError, validateFilePath } from './pathSecurity.mjs';
import { scanWorkspaceFiles } from './workspaceScanner.mjs';

/**
 * 解析插件版本号。单一来源为根目录 package.json：
 * - 构建产物 dist/server.mjs 由 build-server.mjs 通过 esbuild define 注入 __PLUGIN_VERSION__；
 * - 直接以源码运行（开发/测试）时按相对路径回退读取清单文件，
 *   兼容 dist/ 内运行（无 package.json 时回退 plugin.json）。
 */
function resolvePluginVersion() {
  if (typeof __PLUGIN_VERSION__ === 'string') {
    return __PLUGIN_VERSION__;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  for (const manifest of ['../package.json', 'plugin.json', '../plugin.json']) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(here, manifest), 'utf8'));
      if (typeof parsed.version === 'string' && parsed.version) {
        return parsed.version;
      }
    } catch {
      // 尝试下一个清单文件
    }
  }
  return '0.0.0';
}

const PLUGIN_VERSION = resolvePluginVersion();
const MAX_PARSED_READ_BYTES = 60 * 1024 * 1024; // 60 MB：Excel/PPT/Word 等需一次性载入渲染进程内存解析的格式上限
const MAX_TEXT_READ_BYTES = 80 * 1024 * 1024; // 80 MB：其余由 /api/fs/read 直接读取的文件上限
const MAX_PDF_BYTES = 1024 * 1024 * 1024; // 1 GB PDF 流式预览安全上限
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB MP4 流式播放安全上限
const MAX_IMAGE_BYTES = 256 * 1024 * 1024; // 256 MB 图片预览安全上限

// 按文件路径缓存静态资源内容，并以 stat.mtimeMs + size 判定失效，兼顾高并发读取性能与开发热构建刷新
const staticFileCache = new Map();

function getReadLimitBytes(kind) {
  if (kind === 'excel' || kind === 'ppt' || kind === 'word') {
    return MAX_PARSED_READ_BYTES;
  }
  return MAX_TEXT_READ_BYTES;
}

function revealFileInExplorer(targetPath) {
  if (process.platform === 'win32') {
    const winPath = win32.normalize(targetPath).replaceAll('"', '');
    const child = spawn('explorer.exe', [`/select,"${winPath}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
    child.unref();
    return;
  }
  if (process.platform === 'darwin') {
    const child = spawn('open', ['-R', targetPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }
  const child = spawn('xdg-open', [dirname(targetPath)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/**
 * 解析插件根目录与 dist/ 产物目录（兼容从 server/index.mjs 与 dist/server.mjs 运行）。
 * @returns {{ pluginRoot: string, distDir: string, assetsDir: string }}
 */
export function resolvePluginPaths() {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const runningInDist =
    existsSync(join(currentDir, 'index.html')) || basename(currentDir) === 'dist';

  const pluginRoot = resolve(currentDir, '..');
  const distDir = runningInDist ? currentDir : join(pluginRoot, 'dist');
  const assetsDir = join(pluginRoot, 'assets');

  return { pluginRoot, distDir, assetsDir };
}

/**
 * 构造 JSON 响应。
 * @param {unknown} payload
 * @param {number} [status]
 * @param {typeof Response} [ResponseClass]
 * @returns {Response}
 */
function jsonResponse(payload, status = 200, ResponseClass = Response) {
  return new ResponseClass(JSON.stringify(payload), {
    contentType: 'application/json; charset=utf-8',
    status,
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * 包装 API 处理器，统一捕获 HttpError 与未知异常并转换为规范 HTTP 状态码。
 * @template T
 * @param {(data: Record<string, any>) => Promise<T> | T} handler
 * @param {typeof Response} [ResponseClass]
 * @returns {(data: Record<string, any>) => Promise<T | Response>}
 */
export function withErrorHandling(handler, ResponseClass = Response) {
  return async (data = {}) => {
    try {
      return await handler(data || {});
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonResponse({ error: err.message, code: err.code }, err.status, ResponseClass);
      }
      const message = err instanceof Error ? err.message : '服务器内部错误';
      return jsonResponse({ error: message, code: 'INTERNAL_ERROR' }, 500, ResponseClass);
    }
  };
}

/**
 * 读取静态文件内容并构造 Response（带 mtimeMs/size 校验的内存缓存）；若缺失则返回 404。
 * @param {string} filePath
 * @param {string} contentType
 * @param {typeof Response} [ResponseClass]
 * @returns {Response}
 */
function serveStaticFile(filePath, contentType, ResponseClass = Response) {
  let stat;
  try {
    stat = statSync(filePath);
    if (!stat.isFile()) {
      stat = null;
    }
  } catch {
    stat = null;
  }

  if (!stat) {
    staticFileCache.delete(filePath);
    return new ResponseClass('Not Found', {
      contentType: 'text/plain; charset=utf-8',
      status: 404,
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  }

  const cached = staticFileCache.get(filePath);
  let content;
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    content = cached.content;
  } else {
    content = readFileSync(filePath);
    staticFileCache.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      content,
    });
  }

  return new ResponseClass(content, {
    contentType,
    status: 200,
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * 注册所有页面路由与 API 路由到指定的 SidecarApp 实例。
 * @param {SidecarApp} app
 * @param {object} [options]
 * @param {typeof Response} [options.ResponseClass]
 * @param {string} [options.distDir]
 * @param {string} [options.assetsDir]
 * @param {typeof mountHtmlTarget} [options.mountHtml]
 * @param {string[] | null} [options.allowedRootsOverride] 仅用于测试覆盖
 */
export function registerRoutes(app, options = {}) {
  const defaultPaths = resolvePluginPaths();
  const ResponseClass = options.ResponseClass || Response;
  const distDir = options.distDir || defaultPaths.distDir;
  const assetsDir = options.assetsDir || defaultPaths.assetsDir;
  const mountHtml = options.mountHtml || mountHtmlTarget;
  const mountPdf = options.mountPdf || mountPdfTarget;
  const mountVideo = options.mountVideo || mountVideoTarget;
  const mountImage = options.mountImage || mountImageTarget;
  const revealFile = options.revealFile || revealFileInExplorer;
  const allowedRootsOverride = options.allowedRootsOverride || null;

  // 静态页面与脚本资源路由（SidecarApp 为精确匹配）
  app.page('/', () => serveStaticFile(join(distDir, 'index.html'), 'text/html; charset=utf-8', ResponseClass));
  app.page('/index.html', () =>
    serveStaticFile(join(distDir, 'index.html'), 'text/html; charset=utf-8', ResponseClass),
  );
  app.page('/app.js', () =>
    serveStaticFile(join(distDir, 'app.js'), 'application/javascript; charset=utf-8', ResponseClass),
  );
  app.page('/pdf.worker.js', () =>
    serveStaticFile(join(distDir, 'pdf.worker.js'), 'application/javascript; charset=utf-8', ResponseClass),
  );
  app.page('/styles.css', () =>
    serveStaticFile(join(distDir, 'styles.css'), 'text/css; charset=utf-8', ResponseClass),
  );
  app.page('/assets/logo.svg', () =>
    serveStaticFile(join(assetsDir, 'logo.svg'), 'image/svg+xml', ResponseClass),
  );

  // 健康检查
  app.api(
    '/api/health',
    withErrorHandling(() => ({ status: 'ok', version: PLUGIN_VERSION }), ResponseClass),
    'GET',
  );

  // 文件元信息校验与读取
  app.api(
    '/api/fs/stat',
    withErrorHandling((data) => {
      const info = validateFilePath(data.file, {
        workspaceUris: data.workspaceUris,
        allowedRootsOverride,
      });
      return {
        path: info.path,
        name: info.name,
        ext: info.ext,
        kind: info.kind,
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    }, ResponseClass),
    'POST',
  );

  // 二进制流异步读取（用于 .pptx / .docx / .xlsx / .xls / .csv / .tsv / .html 等）
  app.api(
    '/api/fs/read',
    withErrorHandling(async (data) => {
      const info = validateFilePath(data.file, {
        workspaceUris: data.workspaceUris,
        allowedRootsOverride,
      });

      const limitBytes = getReadLimitBytes(info.kind);
      if (info.size > limitBytes) {
        const limitMb = Math.round(limitBytes / (1024 * 1024));
        throw new HttpError(413, `文件体积超过 ${limitMb}MB 内存解析预览上限`, 'FILE_TOO_LARGE');
      }

      const buffer = await readFile(info.path);
      return new ResponseClass(buffer, {
        contentType: 'application/octet-stream',
        status: 200,
        headers: {
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    }, ResponseClass),
    'POST',
  );

  // 扫描工作区中的可预览文件
  app.api(
    '/api/fs/list',
    withErrorHandling((data) => {
      const files = scanWorkspaceFiles(data.workspaceUris, {
        currentFile: data.currentFile,
        maxDepth: data.maxDepth,
        limit: data.limit,
      });
      return { files };
    }, ResponseClass),
    'POST',
  );

  // 在系统文件资源管理器中定位并选中指定文件
  app.api(
    '/api/fs/reveal',
    withErrorHandling((data) => {
      const info = validateFilePath(data.file, {
        workspaceUris: data.workspaceUris,
        allowedRootsOverride,
      });
      revealFile(info.path);
      return { ok: true, path: info.path };
    }, ResponseClass),
    'POST',
  );

  // 挂载 HTML 文件到独立跨源预览子端口
  app.api(
    '/api/html/mount',
    withErrorHandling(async (data) => {
      const info = validateFilePath(data.file, {
        workspaceUris: data.workspaceUris,
        allowedRootsOverride,
      });

      if (info.kind !== 'html') {
        throw new HttpError(415, '仅支持将 .html 或 .htm 文件挂载到预览服务', 'NOT_HTML_FILE');
      }

      const mounted = await mountHtml(info.path, info.workspaceRoots);
      return {
        url: mounted.url,
        entryRelPath: mounted.entryRelPath,
        mountId: mounted.mountId,
        mountRoot: mounted.mountRoot,
      };
    }, ResponseClass),
    'POST',
  );

  // 挂载 PDF 文件到独立端口 HTTP Range 流式预览服务
  app.api(
    '/api/pdf/mount',
    withErrorHandling(async (data) => {
      const info = validateFilePath(data.file, {
        workspaceUris: data.workspaceUris,
        allowedRootsOverride,
      });

      if (info.kind !== 'pdf') {
        throw new HttpError(415, '仅支持将 .pdf 文件挂载到流式预览服务', 'NOT_PDF_FILE');
      }

      if (info.size > MAX_PDF_BYTES) {
        throw new HttpError(413, 'PDF 文件体积超过 1GB 预览上限', 'FILE_TOO_LARGE');
      }

      const mounted = await mountPdf(info.path);
      return {
        url: mounted.url,
        mountId: mounted.mountId,
        fileName: info.name,
        size: info.size,
      };
    }, ResponseClass),
    'POST',
  );

  // 挂载 MP4 文件到独立端口 HTTP Range 流式播放服务
  app.api(
    '/api/video/mount',
    withErrorHandling(async (data) => {
      const info = validateFilePath(data.file, {
        workspaceUris: data.workspaceUris,
        allowedRootsOverride,
      });

      if (info.kind !== 'mp4') {
        throw new HttpError(415, '仅支持将 .mp4 文件挂载到流式播放服务', 'NOT_VIDEO_FILE');
      }

      if (info.size > MAX_VIDEO_BYTES) {
        throw new HttpError(413, 'MP4 文件体积超过 4GB 预览上限', 'FILE_TOO_LARGE');
      }

      const mounted = await mountVideo(info.path);
      return {
        url: mounted.url,
        mountId: mounted.mountId,
        fileName: info.name,
        size: info.size,
      };
    }, ResponseClass),
    'POST',
  );

  // 挂载图片文件（.jpg / .jpeg / .png）到独立端口静态预览服务
  app.api(
    '/api/image/mount',
    withErrorHandling(async (data) => {
      const info = validateFilePath(data.file, {
        workspaceUris: data.workspaceUris,
        allowedRootsOverride,
      });

      if (info.kind !== 'image') {
        throw new HttpError(415, '仅支持将 .jpg、.jpeg 或 .png 图片挂载到预览服务', 'NOT_IMAGE_FILE');
      }

      if (info.size > MAX_IMAGE_BYTES) {
        throw new HttpError(413, '图片文件体积超过 256MB 预览上限', 'FILE_TOO_LARGE');
      }

      const mounted = await mountImage(info.path);
      return {
        url: mounted.url,
        mountId: mounted.mountId,
        fileName: info.name,
        size: info.size,
      };
    }, ResponseClass),
    'POST',
  );

  return app;
}

/**
 * 创建并配置 SidecarApp 实例。
 * @param {object} [options]
 * @returns {SidecarApp}
 */
export function createSidecarApp(options = {}) {
  const SidecarAppClass = options.SidecarAppClass || SidecarApp;
  const app = new SidecarAppClass();
  return registerRoutes(app, options);
}

/**
 * 启动 File Preview Sidecar 主服务。
 * @param {object} [options]
 * @returns {Promise<{ app: SidecarApp, server: import('node:http').Server, close: () => Promise<void> }>}
 */
export async function startServer(options = {}) {
  const app = createSidecarApp(options);
  const server = await app.run();

  const close = async () => {
    await closeHtmlServer();
    if (typeof app.close === 'function') {
      await app.close();
    }
  };

  return { app, server, close };
}

// 当直接作为主模块运行时自动启动
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err) => {
    console.error('[file-preview] 启动失败:', err);
    process.exit(1);
  });
}
