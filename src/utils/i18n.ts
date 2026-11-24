export type Locale = 'zh' | 'en';
export type LocalePreference = 'auto' | 'zh' | 'en';

const LOCALE_PREF_STORAGE_KEY = 'file-preview:locale-preference';

type LocaleListener = (locale: Locale, pref: LocalePreference) => void;

const listeners = new Set<LocaleListener>();
let inMemoryPref: LocalePreference | null = null;

/**
 * 规范化语言标签数组并解析系统首选语言（zh* 映射为 zh，其余均回落为 en）。
 */
export function detectSystemLocale(navLanguages?: readonly string[] | string): Locale {
  if (typeof navLanguages === 'string') {
    return navLanguages.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  if (Array.isArray(navLanguages)) {
    const first = navLanguages.find((item) => typeof item === 'string' && item.trim().length > 0);
    if (!first) return 'en';
    return first.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  // 非浏览器环境（如 Node 单元测试无显式参数时）默认保留中文以确保既有测试兼容
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'zh';
  }

  const candidate =
    (Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages[0]
      : navigator.language) || '';
  if (!candidate.trim()) {
    return 'en';
  }
  return candidate.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * 将用户偏好（auto / zh / en）解析为当前生效的界面语言。
 */
export function resolveLocale(
  pref: LocalePreference,
  navLanguages?: readonly string[] | string,
): Locale {
  if (pref === 'zh' || pref === 'en') {
    return pref;
  }
  return detectSystemLocale(navLanguages);
}

/**
 * 读取持久化的语言偏好设置（默认 auto）。
 */
export function getLocalePreference(): LocalePreference {
  if (typeof window !== 'undefined') {
    try {
      const saved = window.localStorage.getItem(LOCALE_PREF_STORAGE_KEY);
      if (saved === 'auto' || saved === 'zh' || saved === 'en') {
        inMemoryPref = saved;
        return saved;
      }
    } catch {
      // 忽略沙箱存储禁用异常
    }
  }
  return inMemoryPref ?? 'auto';
}

/**
 * 返回当前生效的界面语言。
 */
export function getCurrentLocale(): Locale {
  return resolveLocale(getLocalePreference());
}

/**
 * 按当前生效语言返回对应中英文文本。
 */
export function tr(zh: string, en: string): string {
  return getCurrentLocale() === 'en' ? en : zh;
}

/**
 * 同步 HTML 根元素 lang 属性与页面标题。
 */
export function syncDocumentLang(): void {
  if (typeof document === 'undefined') return;
  const locale = getCurrentLocale();
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  document.title =
    locale === 'zh' ? 'File Preview - 侧边栏文档预览' : 'File Preview - Sidebar Document Preview';
}

/**
 * 设置语言偏好并持久化，同时通知所有已注册组件即时刷新文案。
 */
export function setLocalePreference(pref: LocalePreference): LocalePreference {
  inMemoryPref = pref;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LOCALE_PREF_STORAGE_KEY, pref);
    } catch {
      // 忽略沙箱存储禁用异常
    }
  }
  syncDocumentLang();
  const resolved = resolveLocale(pref);
  for (const listener of listeners) {
    try {
      listener(resolved, pref);
    } catch (err) {
      console.error('[i18n] locale listener error:', err);
    }
  }
  return pref;
}

/**
 * 在 auto -> zh -> en -> auto 之间循环切换界面语言。
 */
export function cycleLocalePreference(): LocalePreference {
  const current = getLocalePreference();
  const next: LocalePreference =
    current === 'auto' ? 'zh' : current === 'zh' ? 'en' : 'auto';
  return setLocalePreference(next);
}

/**
 * 订阅语言切换事件，返回取消订阅函数。
 */
export function onLocaleChange(listener: LocaleListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 返回语言切换按钮的紧凑展示文本与悬浮提示。
 */
export function getLocaleToggleDisplay(
  pref: LocalePreference,
  locale: Locale,
): { label: string; title: string } {
  if (pref === 'zh') {
    return {
      label: '中文',
      title: '语言：简体中文（点击切换为 English）',
    };
  }
  if (pref === 'en') {
    return {
      label: 'EN',
      title: 'Language: English (click to switch to Auto)',
    };
  }
  if (locale === 'zh') {
    return {
      label: '中/EN',
      title: '语言：跟随系统（当前中文，点击切换为固定中文）',
    };
  }
  return {
    label: 'EN/中',
    title: 'Language: Auto (English) — click to switch to Chinese',
  };
}

/**
 * 将后端 HTTP / 路径校验错误码映射为当前界面语言的友好提示。
 */
export function translateApiErrorMessage(
  code: string,
  status: number,
  serverMessage: string,
): string {
  const locale = getCurrentLocale();
  if (locale === 'zh') {
    return serverMessage;
  }

  switch (code) {
    case 'UNSUPPORTED_LEGACY_PPT':
      return 'Legacy binary .ppt format is not supported. Please save it as .pptx in PowerPoint or WPS first.';
    case 'UNSUPPORTED_LEGACY_DOC':
      return 'Legacy binary .doc format is not supported. Please save it as .docx in Word or WPS first.';
    case 'UNSUPPORTED_FORMAT':
      return 'Unsupported file format. Only .pptx, .docx, .xlsx, .xls, .csv, .tsv, .pdf, .mp4, .jpg, .jpeg, .png, .html, and .htm are supported.';
    case 'INVALID_PATH':
      return 'Invalid file path parameter; expected a string.';
    case 'NULL_BYTE_PATH':
      return 'File path contains an illegal null byte.';
    case 'EMPTY_PATH':
      return 'File path cannot be empty.';
    case 'INVALID_FILE_URI':
      return 'Invalid file:// URI.';
    case 'FORBIDDEN_SYSTEM_PATH':
      return 'Access to protected .system_generated logs or messages directories is forbidden.';
    case 'OUTSIDE_ALLOWED_ROOTS':
      return 'File path is outside the allowed workspace or local root directories.';
    case 'FILE_NOT_FOUND':
      return 'Target file does not exist or may have been moved/deleted.';
    case 'STAT_ERROR':
      return 'Unable to inspect target file metadata.';
    case 'SYMLINK_ESCAPE':
      return 'Symbolic link target escapes the allowed root directory boundaries.';
    case 'NOT_A_FILE':
      return 'Target path is not a regular file.';
    case 'NOT_HTML_FILE':
      return 'Only .html or .htm files can be mounted to the HTML preview server.';
    case 'NOT_PDF_FILE':
      return 'Only .pdf files can be mounted to the PDF streaming server.';
    case 'NOT_VIDEO_FILE':
      return 'Only .mp4 files can be mounted to the video streaming server.';
    case 'NOT_IMAGE_FILE':
      return 'Only .jpg, .jpeg, or .png image files can be mounted to the image preview server.';
    case 'FILE_TOO_LARGE':
      return 'File size exceeds the safety limit for direct preview.';
    default:
      break;
  }

  // 若服务端消息本身是纯 ASCII 英文，直接保留；否则走英文状态码兜底
  if (serverMessage && !/[\u4e00-\u9fa5]/.test(serverMessage)) {
    return serverMessage;
  }

  switch (status) {
    case 400:
      return 'Invalid request parameters. Please check the file path.';
    case 401:
      return 'Sidebar access token unauthorized. Please reopen the plugin panel.';
    case 403:
      return 'Permission denied for this path. Ensure the file is inside your workspace or allowed directories.';
    case 404:
      return 'Target file not found. It may have been moved or deleted.';
    case 413:
      return 'File size exceeds the in-memory preview limit (60MB for parsed documents).';
    case 415:
      return 'Unsupported file format. Only .pptx, .docx, .xlsx, .xls, .csv, .tsv, .pdf, .mp4, .jpg, .jpeg, .png, .html, and .htm are supported.';
    default:
      return status >= 500
        ? `Preview service internal error (HTTP ${status}). Please try again later.`
        : `Request failed (HTTP ${status}).`;
  }
}
