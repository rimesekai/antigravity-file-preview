import type {
  FileStatInfo,
  HtmlMountInfo,
  ImageMountInfo,
  PdfMountInfo,
  VideoMountInfo,
  WorkspaceFileItem,
} from '../types/preview';
import { tr, translateApiErrorMessage } from '../utils/i18n';

interface SidecarBridgeLike {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getWorkspaceUris?: () => Promise<string[]>;
  onWorkspaceChange?: (listener: (uris: string[]) => void) => () => void;
}

interface SidecarWindowLike {
  sidecar?: SidecarBridgeLike;
}

/**
 * Sidecar API 调用异常，包含 HTTP 状态码、机器错误码与中文可读提示。
 */
export class SidecarApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly userMessage: string;

  constructor(status: number, code: string, userMessage: string) {
    super(userMessage);
    this.name = 'SidecarApiError';
    this.status = status;
    this.code = code;
    this.userMessage = userMessage;
  }
}

let cachedWorkspaceUris: string[] | null = null;

/**
 * 供主题/工作区同步模块写入最新推送的工作区 URI 列表。
 */
export function updateCachedWorkspaceUris(uris: string[]): void {
  if (Array.isArray(uris) && uris.length > 0) {
    cachedWorkspaceUris = [...uris];
  } else {
    cachedWorkspaceUris = null;
  }
}

function getSidecarBridge(): SidecarBridgeLike | undefined {
  return (window as unknown as SidecarWindowLike).sidecar;
}

function getUrlToken(): string | null {
  try {
    const token = new URLSearchParams(window.location.search).get('token');
    return token && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 安全获取当前会话工作区 URI 列表；非 plugin:// 环境或异常时返回空数组而不抛出错误。
 * 当获取为空或超时，不永久缓存空数组，避免首次启动宿主 bridge 延迟导致后续无法获取工作区。
 */
export async function getWorkspaceUrisSafe(): Promise<string[]> {
  if (cachedWorkspaceUris !== null && cachedWorkspaceUris.length > 0) {
    return [...cachedWorkspaceUris];
  }

  const bridge = getSidecarBridge();
  if (!bridge || typeof bridge.getWorkspaceUris !== 'function') {
    return [];
  }

  try {
    const timeoutFallback = new Promise<string[]>((resolve) => {
      window.setTimeout(() => resolve([]), 1200);
    });
    const uris = await Promise.race([bridge.getWorkspaceUris(), timeoutFallback]);
    if (Array.isArray(uris) && uris.length > 0) {
      cachedWorkspaceUris = [...uris];
      return [...uris];
    }
    return Array.isArray(uris) ? [...uris] : [];
  } catch {
    return [];
  }
}

/**
 * 统一发起 Sidecar HTTP 请求：优先使用 window.sidecar.fetch，否则回退到原生 fetch 并附带 ?token= 中的 X-Sidecar-Token。
 */
async function sidecarFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const bridge = getSidecarBridge();
  if (bridge && typeof bridge.fetch === 'function') {
    return bridge.fetch(url, init);
  }

  const headers = new Headers(init.headers || undefined);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  const token = getUrlToken();
  if (token && !headers.has('X-Sidecar-Token')) {
    headers.set('X-Sidecar-Token', token);
  }

  return window.fetch(url, {
    ...init,
    headers,
  });
}

function fallbackMessageByStatus(status: number): string {
  switch (status) {
    case 400:
      return tr('请求参数无效，请检查文件路径是否正确。', 'Invalid request parameters. Please check the file path.');
    case 401:
      return tr('侧边栏访问令牌未授权，请尝试重新打开插件面板。', 'Sidebar access token unauthorized. Please reopen the plugin panel.');
    case 403:
      return tr(
        '无权访问目标路径，请确认文件位于当前工作区或允许的本地目录内。',
        'Permission denied for this path. Ensure the file is inside your workspace or allowed directories.',
      );
    case 404:
      return tr('未找到目标文件，可能已被移动或删除。', 'Target file not found. It may have been moved or deleted.');
    case 413:
      return tr(
        '文件体积超过内存解析预览上限（常规文档上限 60MB），无法直接加载。',
        'File size exceeds the in-memory preview limit (60MB for parsed documents).',
      );
    case 415:
      return tr(
        '暂不支持该文件格式，当前仅支持 .pptx、.docx、.xlsx、.xls、.csv、.tsv、.pdf、.mp4、.jpg、.jpeg、.png、.html 和 .htm。',
        'Unsupported file format. Only .pptx, .docx, .xlsx, .xls, .csv, .tsv, .pdf, .mp4, .jpg, .jpeg, .png, .html, and .htm are supported.',
      );
    default:
      return status >= 500
        ? tr(
            `预览服务内部异常（HTTP ${status}），请稍后重试。`,
            `Preview service internal error (HTTP ${status}). Please try again later.`,
          )
        : tr(`请求失败（HTTP ${status}）。`, `Request failed (HTTP ${status}).`);
  }
}

async function parseErrorResponse(res: Response): Promise<SidecarApiError> {
  let code = `HTTP_${res.status}`;
  let message = '';

  try {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const payload = (await res.json()) as { error?: unknown; code?: unknown } | null;
      if (payload && typeof payload === 'object') {
        if (typeof payload.code === 'string' && payload.code.trim()) {
          code = payload.code.trim();
        }
        if (typeof payload.error === 'string' && payload.error.trim()) {
          message = payload.error.trim();
        }
      }
    } else {
      const text = (await res.text()).trim();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: unknown; code?: unknown };
          if (typeof parsed.code === 'string' && parsed.code.trim()) {
            code = parsed.code.trim();
          }
          if (typeof parsed.error === 'string' && parsed.error.trim()) {
            message = parsed.error.trim();
          }
        } catch {
          // 非 JSON 错误正文时保留默认状态说明
        }
      }
    }
  } catch {
    // 忽略响应解析异常，使用状态码兜底说明
  }

  const localized = translateApiErrorMessage(code, res.status, message);
  return new SidecarApiError(
    res.status,
    code,
    localized || fallbackMessageByStatus(res.status),
  );
}

async function postJson<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await sidecarFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SidecarApiError(
      0,
      'NETWORK_ERROR',
      tr(
        '无法连接到 Sidecar 预览服务，请确认插件服务正常运行。',
        'Cannot connect to the Sidecar preview service. Please ensure the plugin server is running.',
      ),
    );
  }

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new SidecarApiError(
      res.status,
      'INVALID_JSON',
      tr('服务端返回了无法解析的响应数据。', 'The server returned an unparseable response.'),
    );
  }
}

/**
 * 校验目标文件并获取基础元信息（路径、格式分类、大小、修改时间）。
 */
export async function statFile(file: string): Promise<FileStatInfo> {
  const workspaceUris = await getWorkspaceUrisSafe();
  return postJson<FileStatInfo>('/api/fs/stat', { file, workspaceUris });
}

/**
 * 以二进制 ArrayBuffer 读取本地 .pptx / .docx / .xlsx / .xls / .csv / .tsv / .html 文件内容。
 */
export async function readFileBuffer(file: string): Promise<ArrayBuffer> {
  const workspaceUris = await getWorkspaceUrisSafe();
  let res: Response;
  try {
    res = await sidecarFetch('/api/fs/read', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file, workspaceUris }),
    });
  } catch {
    throw new SidecarApiError(
      0,
      'NETWORK_ERROR',
      tr('读取文件时网络中断，请检查 Sidecar 服务状态。', 'Network interrupted while reading the file. Please check the Sidecar service.'),
    );
  }

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  return res.arrayBuffer();
}

/**
 * 以 UTF-8 文本读取文件内容（主要用于 HTML 源码展示）。
 */
export async function readFileText(file: string): Promise<string> {
  const buffer = await readFileBuffer(file);
  return new TextDecoder('utf-8').decode(buffer);
}

/**
 * 扫描当前工作区中所有可预览文档。
 * 支持传入 currentFile 当前打开的文件路径，以便在无显式工作区时服务端回退扫描其所在目录。
 */
export async function listWorkspaceFiles(currentFile?: string | null): Promise<WorkspaceFileItem[]> {
  const workspaceUris = await getWorkspaceUrisSafe();
  const body: Record<string, unknown> = {
    workspaceUris,
  };
  const trimmed = typeof currentFile === 'string' ? currentFile.trim() : '';
  if (trimmed) {
    body.currentFile = trimmed;
  }
  const data = await postJson<{ files?: WorkspaceFileItem[] }>('/api/fs/list', body);
  return Array.isArray(data.files) ? data.files : [];
}

/**
 * 在系统文件资源管理器中定位并选中指定磁盘文件。
 */
export async function revealFileInExplorer(file: string): Promise<void> {
  const workspaceUris = await getWorkspaceUrisSafe();
  try {
    await postJson<{ ok: boolean }>('/api/fs/reveal', {
      file,
      workspaceUris,
    });
  } catch (err) {
    if (err instanceof SidecarApiError && err.status === 404 && err.code === 'HTTP_404') {
      throw new SidecarApiError(
        404,
        'SIDECAR_OUTDATED',
        tr(
          '后台服务尚未加载新接口，请重启 Antigravity 后再试。',
          'Backend service has not loaded the new endpoint yet. Please restart Antigravity.',
        ),
      );
    }
    throw err;
  }
}

/**
 * 将本地 HTML 文件挂载到独立跨源预览端口，返回可加载的 URL 与挂载信息。
 */
export async function mountHtmlFile(file: string): Promise<HtmlMountInfo> {
  const workspaceUris = await getWorkspaceUrisSafe();
  return postJson<HtmlMountInfo>('/api/html/mount', { file, workspaceUris });
}

/**
 * 将本地 PDF 文件挂载到流式 Range 预览端点，返回可流式加载的 URL 与挂载信息。
 */
export async function mountPdfFile(file: string): Promise<PdfMountInfo> {
  const workspaceUris = await getWorkspaceUrisSafe();
  return postJson<PdfMountInfo>('/api/pdf/mount', { file, workspaceUris });
}

/**
 * 将本地 MP4 文件挂载到流式 Range 播放端点，返回可流式播放的 URL 与挂载信息。
 */
export async function mountVideoFile(file: string): Promise<VideoMountInfo> {
  const workspaceUris = await getWorkspaceUrisSafe();
  return postJson<VideoMountInfo>('/api/video/mount', { file, workspaceUris });
}

/**
 * 将本地图片（.jpg / .jpeg / .png）挂载到静态预览端点，返回可加载的 URL 与挂载信息。
 */
export async function mountImageFile(file: string): Promise<ImageMountInfo> {
  const workspaceUris = await getWorkspaceUrisSafe();
  return postJson<ImageMountInfo>('/api/image/mount', { file, workspaceUris });
}

/**
 * 检查 Sidecar 后端健康状态。
 */
export async function checkHealth(): Promise<{ status: string; version: string }> {
  const res = await sidecarFetch('/api/health', { method: 'GET' });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return (await res.json()) as { status: string; version: string };
}
