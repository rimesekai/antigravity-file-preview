import './styles/tokens.css';
import './styles/liquid-glass.css';
import './styles.css';
import './renderers/renderers.css';
import type {
  FileStatInfo,
  HtmlPreviewMode,
  ImageBackgroundMode,
  PptLayoutMode,
  PreviewKind,
  PreviewRenderer,
  PreviewStateInfo,
  WorkspaceFileItem,
} from './types/preview';
import { createWordRenderer } from './renderers/wordRenderer';
import { createPptRenderer } from './renderers/pptRenderer';
import { createExcelRenderer } from './renderers/excelRenderer';
import { createHtmlRenderer } from './renderers/htmlRenderer';
import { createPdfRenderer } from './renderers/pdfRenderer';
import { createVideoRenderer } from './renderers/videoRenderer';
import { createAudioRenderer } from './renderers/audioRenderer';
import { createImageRenderer } from './renderers/imageRenderer';
import {
  SidecarApiError,
  listWorkspaceFiles,
  mountAudioFile,
  mountHtmlFile,
  mountImageFile,
  mountPdfFile,
  mountVideoFile,
  readFileBuffer,
  readFileText,
  revealFileInExplorer,
  statFile,
} from './services/sidecarClient';
import {
  attachLiquidGlass,
  refreshAllLiquidGlass,
  refreshLiquidGlass,
} from './services/liquidGlass';
import {
  cycleThemePreference,
  getThemePreference,
  startThemeSync,
  subscribeAppearanceChanges,
  subscribeWorkspaceChanges,
} from './services/themeSync';
import { createAppearancePopover } from './components/AppearancePopover';
import { createSelectionToolbar } from './components/SelectionToolbar';
import { createToolbar, type ToolbarFileMeta } from './components/Toolbar';
import { createWorkspaceBrowser } from './components/WorkspaceBrowser';
import { copyTextToClipboard } from './utils/clipboard';
import { inferFallbackFileStat } from './utils/fileMeta';
import { createIcon } from './utils/icons';
import {
  cycleLocalePreference,
  getLocalePreference,
  onLocaleChange,
  syncDocumentLang,
  tr,
} from './utils/i18n';

type ActiveSource =
  | { type: 'disk'; path: string; stat: FileStatInfo }
  | { type: 'local'; name: string; ext: string; kind: PreviewKind; size: number };

const AUTO_REFRESH_INTERVAL_MS = 2500;

function classifyDroppedFile(fileName: string): {
  kind: PreviewKind | null;
  ext: string;
  errorTitle?: string;
  errorMessage?: string;
} {
  const dotIdx = fileName.lastIndexOf('.');
  const ext = dotIdx >= 0 ? fileName.slice(dotIdx).toLowerCase() : '';
  if (ext === '.pptx') return { kind: 'ppt', ext };
  if (ext === '.docx') return { kind: 'word', ext };
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv' || ext === '.tsv') {
    return { kind: 'excel', ext };
  }
  if (ext === '.pdf') return { kind: 'pdf', ext };
  if (ext === '.mp4' || ext === '.webm') return { kind: 'mp4', ext };
  if (ext === '.mp3' || ext === '.wav' || ext === '.m4a' || ext === '.ogg' || ext === '.flac') {
    return { kind: 'audio', ext };
  }
  if (
    ext === '.jpg' ||
    ext === '.jpeg' ||
    ext === '.png' ||
    ext === '.webp' ||
    ext === '.gif' ||
    ext === '.svg' ||
    ext === '.bmp' ||
    ext === '.ico' ||
    ext === '.avif'
  ) {
    return { kind: 'image', ext };
  }
  if (ext === '.html' || ext === '.htm') return { kind: 'html', ext };

  if (ext === '.ppt') {
    return {
      kind: null,
      ext,
      errorTitle: tr('暂不支持旧版 .ppt 格式', 'Legacy .ppt format not supported'),
      errorMessage: tr(
        '请先在 PowerPoint 或 WPS 中将文件另存为 .pptx 格式后再拖入预览。',
        'Please save this file as .pptx in PowerPoint or WPS before previewing.',
      ),
    };
  }
  if (ext === '.doc') {
    return {
      kind: null,
      ext,
      errorTitle: tr('暂不支持旧版 .doc 格式', 'Legacy .doc format not supported'),
      errorMessage: tr(
        '请先在 Word 或 WPS 中将文件另存为 .docx 格式后再拖入预览。',
        'Please save this file as .docx in Word or WPS before previewing.',
      ),
    };
  }
  return {
    kind: null,
    ext,
    errorTitle: tr('不支持的文件格式', 'Unsupported file format'),
    errorMessage: tr(
      `当前仅支持 .pptx、.docx、.xlsx、.xls、.csv、.tsv、.pdf、.mp4、.webm、.mp3、.wav、.m4a、.ogg、.flac、.jpg、.jpeg、.png、.webp、.gif、.svg、.bmp、.ico、.avif、.html 和 .htm 文件（收到：${ext || '无扩展名'}）。`,
      `Only .pptx, .docx, .xlsx, .xls, .csv, .tsv, .pdf, .mp4, .webm, .mp3, .wav, .m4a, .ogg, .flac, .jpg, .jpeg, .png, .webp, .gif, .svg, .bmp, .ico, .avif, .html, and .htm files are supported (got: ${ext || 'no extension'}).`,
    ),
  };
}

function createRendererForKind(kind: PreviewKind): PreviewRenderer {
  switch (kind) {
    case 'word':
      return createWordRenderer();
    case 'ppt':
      return createPptRenderer();
    case 'excel':
      return createExcelRenderer();
    case 'pdf':
      return createPdfRenderer();
    case 'mp4':
      return createVideoRenderer();
    case 'audio':
      return createAudioRenderer();
    case 'image':
      return createImageRenderer();
    case 'html':
      return createHtmlRenderer();
  }
}

function bootstrap(): void {
  syncDocumentLang();

  const appRoot = document.getElementById('app');
  if (!appRoot) {
    return;
  }

  appRoot.innerHTML = '';

  // 主壳结构
  const shell = document.createElement('div');
  shell.className = 'fp-shell';

  const toolbarHost = document.createElement('header');
  toolbarHost.className = 'fp-toolbar-host';

  const mainStage = document.createElement('main');
  mainStage.className = 'fp-main';

  const welcomeHost = document.createElement('div');
  welcomeHost.className = 'fp-welcome-host';

  const previewHost = document.createElement('div');
  previewHost.className = 'fp-preview-host';
  previewHost.hidden = true;

  const rendererContainer = document.createElement('div');
  rendererContainer.className = 'fp-renderer-container';

  const loadingOverlay = document.createElement('div');
  loadingOverlay.className = 'fp-loading-overlay';
  loadingOverlay.hidden = true;
  const loadingCard = document.createElement('div');
  loadingCard.className = 'fp-loading-card';
  loadingCard.setAttribute('role', 'status');
  loadingCard.setAttribute('aria-live', 'polite');
  loadingCard.innerHTML = `<div class="fp-spinner" aria-hidden="true"><svg class="fp-spinner-svg" viewBox="0 0 24 24"><circle class="fp-spinner-track" cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5"/><circle class="fp-spinner-arc" cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg></div><div class="fp-loading-text">${tr('正在加载并渲染文档...', 'Loading and rendering document...')}</div>`;
  loadingOverlay.appendChild(loadingCard);
  const loadingTextEl = loadingCard.querySelector('.fp-loading-text') as HTMLElement;
  const detachLoadingGlass = attachLiquidGlass(loadingCard, 'pill');

  const errorCardHost = document.createElement('div');
  errorCardHost.className = 'fp-error-host';
  errorCardHost.hidden = true;

  const toastEl = document.createElement('div');
  toastEl.className = 'fp-toast';
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  toastEl.hidden = true;
  const detachToastGlass = attachLiquidGlass(toastEl, 'pill');

  previewHost.append(rendererContainer, loadingOverlay, errorCardHost, toastEl);

  // 文件列表抽屉（采用原生 <dialog> Top Layer 实现，自动隔离背景与归还焦点）
  const drawerDialog = document.createElement('dialog');
  drawerDialog.id = 'fp-drawer-dialog';
  drawerDialog.className = 'fp-drawer-dialog';
  drawerDialog.setAttribute('aria-label', tr('工作区文档列表', 'Workspace file list'));

  const drawerPanel = document.createElement('aside');
  drawerPanel.className = 'fp-drawer-panel';
  drawerDialog.appendChild(drawerPanel);

  // 全屏拖拽遮罩
  const dropOverlay = document.createElement('div');
  dropOverlay.className = 'fp-drop-overlay';
  dropOverlay.hidden = true;
  const dropBox = document.createElement('div');
  dropBox.className = 'fp-drop-box';
  const dropIconWell = document.createElement('div');
  dropIconWell.className = 'fp-drop-icon-well';
  dropIconWell.appendChild(createIcon('upload', 24));
  const dropTitleEl = document.createElement('div');
  dropTitleEl.className = 'fp-drop-title';
  const dropSubEl = document.createElement('div');
  dropSubEl.className = 'fp-drop-sub';
  dropBox.append(dropIconWell, dropTitleEl, dropSubEl);
  dropOverlay.appendChild(dropBox);
  const detachDropGlass = attachLiquidGlass(dropBox, 'menu');

  const applyStaticShellLocale = (): void => {
    drawerDialog.setAttribute('aria-label', tr('工作区文档列表', 'Workspace file list'));
    dropTitleEl.textContent = tr('松开鼠标即可预览', 'Drop file to preview');
    dropSubEl.textContent = tr(
      '支持 Office 文档 / PDF / 常见图片 / 音视频 / HTML 本地文件',
      'Supports Office docs / PDF / Images / Audio & Video / HTML files',
    );
  };
  applyStaticShellLocale();

  // 错误页内使用的隐藏文件选择器
  const fallbackFileInput = document.createElement('input');
  fallbackFileInput.type = 'file';
  fallbackFileInput.accept = '.pptx,.docx,.xlsx,.xls,.csv,.tsv,.pdf,.mp4,.webm,.mp3,.wav,.m4a,.ogg,.flac,.jpg,.jpeg,.png,.webp,.gif,.svg,.bmp,.ico,.avif,.html,.htm';
  fallbackFileInput.hidden = true;

  const shellStage = document.createElement('div');
  shellStage.className = 'fp-shell-stage';
  mainStage.append(welcomeHost, previewHost);
  shellStage.append(toolbarHost, mainStage);
  shell.append(shellStage, drawerDialog, dropOverlay, fallbackFileInput);
  appRoot.appendChild(shell);

  const appearancePopover = createAppearancePopover(shell);

  // 应用状态
  let viewMode: 'welcome' | 'preview' = 'welcome';
  let drawerOpen = false;
  let workspaceFiles: WorkspaceFileItem[] = [];
  let workspaceLoading = false;
  let workspaceError: string | null = null;

  let currentSource: ActiveSource | null = null;
  let activeRenderer: PreviewRenderer | null = null;
  let previewState: PreviewStateInfo | null = null;
  let isLoading = false;
  let activeError: { title: string; message: string; code?: string; retryPath?: string } | null = null;
  let autoRefreshEnabled = true;
  let isPollingStat = false;
  let loadRequestSeq = 0;
  let toastTimer: number | null = null;
  let toastHideTimer: number | null = null;

  /** 在预览区底部展示轻提示，2.6 秒后平滑淡出隐藏。 */
  function showToast(message: string, isError = false): void {
    if (toastTimer !== null) {
      window.clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (toastHideTimer !== null) {
      window.clearTimeout(toastHideTimer);
      toastHideTimer = null;
    }
    toastEl.textContent = message;
    toastEl.classList.toggle('is-error', isError);
    toastEl.hidden = false;
    toastEl.classList.remove('is-visible');
    void toastEl.offsetWidth;
    toastEl.classList.add('is-visible');
    refreshLiquidGlass(toastEl);

    toastTimer = window.setTimeout(() => {
      toastTimer = null;
      toastEl.classList.remove('is-visible');
      toastHideTimer = window.setTimeout(() => {
        toastHideTimer = null;
        if (!toastEl.classList.contains('is-visible')) {
          toastEl.hidden = true;
        }
      }, 220);
    }, 2600);
  }

  // 预览区划词悬浮提示条（展示已选字数与一键复制）
  const selectionToolbar = createSelectionToolbar({
    hostEl: previewHost,
    getSelectionRoot: () => rendererContainer,
    isActive: () => viewMode === 'preview' && !drawerOpen && !isLoading && !activeError,
    onCopy: copyTextToClipboard,
    onCopyFeedback: (ok) => {
      showToast(
        ok
          ? tr('已复制选中文字到剪贴板', 'Copied selection to clipboard')
          : tr('复制失败，请使用 Ctrl+C 手动复制', 'Copy failed. Press Ctrl+C to copy manually.'),
        !ok,
      );
    },
  });

  // 工具栏实例
  const toolbar = createToolbar(toolbarHost, {
    onToggleDrawer: () => {
      drawerOpen = !drawerOpen;
      if (drawerOpen) {
        appearancePopover.close();
        selectionToolbar.hide();
        selectionToolbar.clearSentMark();
      }
      if (drawerOpen && workspaceFiles.length === 0 && !workspaceLoading) {
        void refreshWorkspaceList(currentSource?.type === 'disk' ? currentSource.path : null);
      }
      syncUi();
    },
    onRefresh: () => {
      if (currentSource?.type === 'disk') {
        void openDiskFile(currentSource.path, { isRefresh: true });
      }
    },
    onRevealInExplorer: () => {
      if (currentSource?.type === 'disk') {
        void revealFileInExplorer(currentSource.path).catch((err) => {
          const detail = err instanceof Error ? err.message : String(err);
          showToast(
            tr(`打开文件位置失败：${detail}`, `Failed to reveal file: ${detail}`),
            true,
          );
        });
      }
    },
    onToggleAutoRefresh: () => {
      if (currentSource?.type !== 'disk') {
        return;
      }
      autoRefreshEnabled = !autoRefreshEnabled;
      syncUi();
    },
    onCycleTheme: () => {
      cycleThemePreference();
      syncUi();
    },
    onOpenAppearance: (anchorEl) => {
      appearancePopover.toggle(anchorEl);
    },
    onCycleLocale: () => {
      cycleLocalePreference();
    },
    onZoomChange: (zoom) => {
      activeRenderer?.setZoom?.(zoom);
    },
    onPrevPage: () => {
      activeRenderer?.prevPage?.();
    },
    onNextPage: () => {
      activeRenderer?.nextPage?.();
    },
    onGoToPage: (page) => {
      activeRenderer?.goToPage?.(page);
    },
    onLayoutModeChange: (mode: PptLayoutMode) => {
      activeRenderer?.setLayoutMode?.(mode);
    },
    onToggleThumbnails: () => {
      activeRenderer?.toggleThumbnails?.();
    },
    onSearch: async (query) => {
      if (!activeRenderer?.search) return;
      const result = await activeRenderer.search(query);
      previewState = {
        ...(previewState ?? { kind: currentSource?.type === 'disk' ? currentSource.stat.kind : 'ppt' }),
        searchMatches: result.total,
        activeMatch: result.current,
      };
      syncUi();
    },
    onNextMatch: () => {
      activeRenderer?.nextMatch?.();
    },
    onPrevMatch: () => {
      activeRenderer?.prevMatch?.();
    },
    onHtmlModeChange: (mode: HtmlPreviewMode) => {
      selectionToolbar.hide();
      selectionToolbar.clearSentMark();
      activeRenderer?.setHtmlMode?.(mode);
    },
    onRotateImage: (deltaDeg: number) => {
      activeRenderer?.rotateImage?.(deltaDeg);
    },
    onImageBgChange: (mode: ImageBackgroundMode) => {
      activeRenderer?.setImageBackground?.(mode);
    },
  });

  const browserCallbacks = {
    onOpenDiskFile: (filePath: string) => {
      appearancePopover.close();
      drawerOpen = false;
      void openDiskFile(filePath);
    },
    onOpenLocalFile: (file: File) => {
      appearancePopover.close();
      drawerOpen = false;
      void openLocalDroppedFile(file);
    },
    onRefreshList: () => {
      void refreshWorkspaceList(currentSource?.type === 'disk' ? currentSource.path : null);
    },
    onCloseDrawer: () => {
      drawerOpen = false;
      syncUi();
    },
    onOpenAppearance: (anchorEl: HTMLElement) => {
      appearancePopover.toggle(anchorEl);
    },
  };

  const welcomeBrowser = createWorkspaceBrowser(welcomeHost, browserCallbacks);
  const drawerBrowser = createWorkspaceBrowser(drawerPanel, browserCallbacks);

  drawerDialog.addEventListener('click', (e) => {
    // Light-dismiss：点击 dialog 遮罩区（抽屉主体之外）自动关闭
    if (e.target === drawerDialog) {
      drawerOpen = false;
      syncUi();
    }
  });

  drawerDialog.addEventListener('close', () => {
    if (drawerOpen) {
      drawerOpen = false;
      syncUi();
    }
  });

  fallbackFileInput.addEventListener('change', () => {
    const picked = fallbackFileInput.files?.[0];
    fallbackFileInput.value = '';
    if (picked) {
      void openLocalDroppedFile(picked);
    }
  });

  function renderErrorCard(): void {
    errorCardHost.hidden = !activeError;
    if (!activeError) {
      errorCardHost.innerHTML = '';
      return;
    }

    errorCardHost.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'fp-error-card fc-card';

    const headRow = document.createElement('div');
    headRow.className = 'fp-error-head';

    const iconWell = document.createElement('span');
    iconWell.className = 'fp-error-icon-well';
    iconWell.setAttribute('aria-hidden', 'true');
    iconWell.appendChild(createIcon('alert', 20));

    const titleEl = document.createElement('h2');
    titleEl.className = 'fp-error-title';
    titleEl.textContent = activeError.title;

    headRow.append(iconWell, titleEl);

    const msgEl = document.createElement('p');
    msgEl.className = 'fp-error-message';
    msgEl.textContent = activeError.message;

    card.append(headRow, msgEl);

    if (activeError.code) {
      const codeEl = document.createElement('div');
      codeEl.className = 'fp-error-code fc-mono';
      codeEl.textContent = tr(`错误代码：${activeError.code}`, `Error code: ${activeError.code}`);
      card.appendChild(codeEl);
    }

    const actions = document.createElement('div');
    actions.className = 'fp-error-actions';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'fp-btn fp-btn-primary';
    backBtn.textContent = tr('返回文件列表', 'Back to Files');
    backBtn.addEventListener('click', () => {
      selectionToolbar.hide();
      selectionToolbar.clearSentMark();
      destroyActiveRenderer();
      currentSource = null;
      activeError = null;
      viewMode = 'welcome';
      drawerOpen = false;
      syncUi();
      void refreshWorkspaceList();
    });
    actions.appendChild(backBtn);

    if (activeError.retryPath) {
      const retryPath = activeError.retryPath;
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'fp-btn fp-btn-tonal';
      retryBtn.textContent = tr('重试加载', 'Retry');
      retryBtn.addEventListener('click', () => {
        void openDiskFile(retryPath);
      });
      actions.appendChild(retryBtn);
    }

    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'fp-btn fp-btn-ghost';
    pickBtn.textContent = tr('选择其他本地文件', 'Choose Local File');
    pickBtn.addEventListener('click', () => fallbackFileInput.click());
    actions.appendChild(pickBtn);

    card.appendChild(actions);
    errorCardHost.appendChild(card);
  }

  function getToolbarFileMeta(): ToolbarFileMeta | null {
    if (!currentSource) return null;
    if (currentSource.type === 'disk') {
      return {
        name: currentSource.stat.name,
        path: currentSource.stat.path,
        ext: currentSource.stat.ext,
        kind: currentSource.stat.kind,
        size: currentSource.stat.size,
        isLocalDrop: false,
      };
    }
    return {
      name: currentSource.name,
      path: currentSource.name,
      ext: currentSource.ext,
      kind: currentSource.kind,
      size: currentSource.size,
      isLocalDrop: true,
    };
  }

  function syncDrawerDialog(showDrawer: boolean): void {
    const supportsModal = typeof drawerDialog.showModal === 'function';
    if (showDrawer) {
      if (supportsModal) {
        if (!drawerDialog.open) {
          drawerDialog.showModal();
        }
      } else {
        drawerDialog.setAttribute('open', '');
      }
    } else if (drawerDialog.open || drawerDialog.hasAttribute('open')) {
      if (typeof drawerDialog.close === 'function') {
        drawerDialog.close();
      } else {
        drawerDialog.removeAttribute('open');
      }
    }
  }

  function syncUi(): void {
    welcomeHost.hidden = viewMode !== 'welcome';
    previewHost.hidden = viewMode !== 'preview';
    loadingOverlay.hidden = !isLoading;
    if (isLoading) {
      refreshLiquidGlass(loadingCard);
    }

    const showDrawer = viewMode === 'preview' && drawerOpen;
    syncDrawerDialog(showDrawer);

    renderErrorCard();

    const activePath = currentSource?.type === 'disk' ? currentSource.path : null;
    if (viewMode === 'welcome') {
      welcomeBrowser.update({
        mode: 'welcome',
        files: workspaceFiles,
        loading: workspaceLoading,
        error: workspaceError,
        activePath,
      });
    } else if (showDrawer) {
      drawerBrowser.update({
        mode: 'drawer',
        files: workspaceFiles,
        loading: workspaceLoading,
        error: workspaceError,
        activePath,
      });
    }

    toolbar.update({
      visible: viewMode === 'preview',
      file: getToolbarFileMeta(),
      preview: previewState,
      loading: isLoading,
      hasError: Boolean(activeError),
      autoRefresh: autoRefreshEnabled,
      drawerOpen: showDrawer,
      themePreference: getThemePreference(),
      localePreference: getLocalePreference(),
    });
  }

  function destroyActiveRenderer(): void {
    selectionToolbar.hide();
    selectionToolbar.clearSentMark();
    if (activeRenderer) {
      try {
        activeRenderer.destroy();
      } catch (err) {
        console.error('[file-preview] 销毁渲染器失败:', err);
      }
      activeRenderer = null;
    }
    rendererContainer.innerHTML = '';
    previewState = null;
  }

  function mountRendererWithState(
    kind: PreviewKind,
    preservedState?: PreviewStateInfo | null,
  ): PreviewRenderer {
    destroyActiveRenderer();
    const renderer = createRendererForKind(kind);
    activeRenderer = renderer;
    previewState = preservedState
      ? { ...preservedState, kind }
      : {
          kind,
          ...(kind === 'html' ? { htmlMode: 'sandbox' } : {}),
        };

    renderer.onStateChange?.((nextState) => {
      if (activeRenderer !== renderer) return;
      const prevPage = previewState?.page;
      const prevLayout = previewState?.layoutMode;
      const prevHtmlMode = previewState?.htmlMode;
      const prevZoom = previewState?.zoom;
      previewState = nextState;
      syncUi();
      if (
        prevPage !== nextState.page ||
        prevLayout !== nextState.layoutMode ||
        prevHtmlMode !== nextState.htmlMode ||
        prevZoom !== nextState.zoom
      ) {
        selectionToolbar.hide();
        selectionToolbar.clearSentMark();
      } else {
        selectionToolbar.refresh();
      }
    });

    renderer.mount(rendererContainer);
    return renderer;
  }

  function applyPreservedViewOptions(
    renderer: PreviewRenderer,
    kind: PreviewKind,
    preserved: PreviewStateInfo | null,
  ): void {
    if (!preserved || preserved.kind !== kind) return;
    if (kind === 'html' && preserved.htmlMode && preserved.htmlMode !== 'sandbox') {
      renderer.setHtmlMode?.(preserved.htmlMode);
    } else if (kind === 'ppt' || kind === 'pdf') {
      // 先恢复缩略图栏与缩放（会影响可视区宽度），再恢复目标页码与布局模式，避免布局切换覆盖页码
      if (preserved.thumbnailsVisible !== undefined) {
        renderer.toggleThumbnails?.(preserved.thumbnailsVisible);
      }
      if (preserved.fitMode) {
        renderer.setZoom?.('fit');
      } else if (typeof preserved.zoom === 'number') {
        renderer.setZoom?.(preserved.zoom);
      }
      if (typeof preserved.page === 'number' && preserved.page > 1) {
        renderer.goToPage?.(preserved.page);
      }
      if (preserved.layoutMode) {
        renderer.setLayoutMode?.(preserved.layoutMode);
      }
    } else if (kind === 'word') {
      if (preserved.fitMode === false && typeof preserved.zoom === 'number') {
        renderer.setZoom?.(preserved.zoom);
      }
    } else if (kind === 'excel') {
      if (preserved.fitMode) {
        renderer.setZoom?.('fit');
      } else if (typeof preserved.zoom === 'number') {
        renderer.setZoom?.(preserved.zoom);
      }
      if (typeof preserved.page === 'number' && preserved.page > 1) {
        renderer.goToPage?.(preserved.page);
      }
    } else if (kind === 'image') {
      if (preserved.imageBg) {
        renderer.setImageBackground?.(preserved.imageBg);
      }
      if (typeof preserved.rotation === 'number' && preserved.rotation !== 0) {
        renderer.rotateImage?.(preserved.rotation);
      }
      if (preserved.fitMode) {
        renderer.setZoom?.('fit');
      } else if (typeof preserved.zoom === 'number') {
        renderer.setZoom?.(preserved.zoom);
      }
    }
  }

  function setErrorState(
    title: string,
    message: string,
    code?: string,
    retryPath?: string,
  ): void {
    destroyActiveRenderer();
    isLoading = false;
    activeError = { title, message, code, retryPath };
    viewMode = 'preview';
    syncUi();
  }

  async function refreshWorkspaceList(targetFile?: string | null): Promise<void> {
    workspaceLoading = true;
    workspaceError = null;
    syncUi();

    try {
      const activeDiskPath =
        (typeof targetFile === 'string' && targetFile.trim())
          ? targetFile.trim()
          : (currentSource?.type === 'disk' ? currentSource.path : null);
      workspaceFiles = await listWorkspaceFiles(activeDiskPath);
    } catch (err) {
      workspaceError =
        err instanceof SidecarApiError
          ? err.userMessage
          : tr('扫描工作区文件失败，请稍后重试。', 'Failed to scan workspace files. Please try again.');
    } finally {
      workspaceLoading = false;
      syncUi();
    }
  }

  async function openDiskFile(
    rawPath: string,
    options: { isRefresh?: boolean; isAutoRefresh?: boolean } = {},
  ): Promise<void> {
    const reqId = ++loadRequestSeq;
    const isSameDiskFile =
      currentSource?.type === 'disk' &&
      (currentSource.path === rawPath || options.isRefresh || options.isAutoRefresh);
    const preserved = isSameDiskFile && previewState ? { ...previewState } : null;
    // 在 try 之前暂存已确认的磁盘文件元信息，避免后续渲染出错时丢失真实格式与 mtimeMs
    let resolvedStat: FileStatInfo | null =
      isSameDiskFile && currentSource?.type === 'disk' ? currentSource.stat : null;

    if (!options.isAutoRefresh) {
      selectionToolbar.hide();
      selectionToolbar.clearSentMark();
      viewMode = 'preview';
      activeError = null;
      isLoading = true;
      loadingTextEl.textContent = options.isRefresh
        ? tr('正在重新加载文档...', 'Reloading document...')
        : tr('正在读取并渲染文档...', 'Reading and rendering document...');
      if (!isSameDiskFile) {
        toolbar.resetSearch();
      }
      syncUi();
    }

    try {
      const stat = await statFile(rawPath);
      if (reqId !== loadRequestSeq) return;
      resolvedStat = stat;

      const canReuseRenderer = Boolean(
        isSameDiskFile && activeRenderer && previewState?.kind === stat.kind,
      );

      if (stat.kind === 'html') {
        const [mountInfo, sourceText] = await Promise.all([
          mountHtmlFile(stat.path),
          readFileText(stat.path),
        ]);
        if (reqId !== loadRequestSeq) return;

        currentSource = { type: 'disk', path: stat.path, stat };
        const htmlMeta = {
          name: stat.name,
          path: stat.path,
          ext: stat.ext,
        };
        if (canReuseRenderer && activeRenderer?.loadHtml) {
          await activeRenderer.loadHtml(mountInfo, sourceText, htmlMeta);
        } else {
          const renderer = mountRendererWithState('html', preserved);
          await renderer.loadHtml?.(mountInfo, sourceText, htmlMeta);
          if (reqId !== loadRequestSeq) return;
          applyPreservedViewOptions(renderer, 'html', preserved);
        }
        if (reqId !== loadRequestSeq) return;
      } else if (stat.kind === 'pdf') {
        const mountInfo = await mountPdfFile(stat.path);
        if (reqId !== loadRequestSeq) return;

        currentSource = { type: 'disk', path: stat.path, stat };
        const renderer = mountRendererWithState('pdf', preserved);
        await renderer.loadPdf?.(mountInfo, null, {
          name: stat.name,
          path: stat.path,
          ext: stat.ext,
          size: stat.size,
        });
        if (reqId !== loadRequestSeq) return;
        applyPreservedViewOptions(renderer, 'pdf', preserved);
      } else if (stat.kind === 'mp4') {
        const mountInfo = await mountVideoFile(stat.path);
        if (reqId !== loadRequestSeq) return;

        currentSource = { type: 'disk', path: stat.path, stat };
        const renderer = mountRendererWithState('mp4', preserved);
        await renderer.loadVideo?.(mountInfo, null, {
          name: stat.name,
          path: stat.path,
          ext: stat.ext,
          size: stat.size,
        });
        if (reqId !== loadRequestSeq) return;
      } else if (stat.kind === 'audio') {
        const mountInfo = await mountAudioFile(stat.path);
        if (reqId !== loadRequestSeq) return;

        currentSource = { type: 'disk', path: stat.path, stat };
        const renderer = mountRendererWithState('audio', preserved);
        await renderer.loadAudio?.(mountInfo, null, {
          name: stat.name,
          path: stat.path,
          ext: stat.ext,
          size: stat.size,
        });
        if (reqId !== loadRequestSeq) return;
      } else if (stat.kind === 'image') {
        const mountInfo = await mountImageFile(stat.path);
        if (reqId !== loadRequestSeq) return;

        currentSource = { type: 'disk', path: stat.path, stat };
        const imageMeta = {
          name: stat.name,
          path: stat.path,
          ext: stat.ext,
          size: stat.size,
        };
        if (canReuseRenderer && activeRenderer?.loadImage) {
          await activeRenderer.loadImage(mountInfo, null, imageMeta);
        } else {
          const renderer = mountRendererWithState('image', preserved);
          await renderer.loadImage?.(mountInfo, null, imageMeta);
          if (reqId !== loadRequestSeq) return;
          applyPreservedViewOptions(renderer, 'image', preserved);
        }
        if (reqId !== loadRequestSeq) return;
      } else {
        const buffer = await readFileBuffer(stat.path);
        if (reqId !== loadRequestSeq) return;

        currentSource = { type: 'disk', path: stat.path, stat };
        const bufferMeta = {
          name: stat.name,
          path: stat.path,
          ext: stat.ext,
        };
        if (canReuseRenderer && activeRenderer?.reloadBuffer) {
          await activeRenderer.reloadBuffer(buffer, bufferMeta);
        } else {
          const renderer = mountRendererWithState(stat.kind, preserved);
          await renderer.loadBuffer?.(buffer, bufferMeta);
          if (reqId !== loadRequestSeq) return;
          applyPreservedViewOptions(renderer, stat.kind, preserved);
        }
        if (reqId !== loadRequestSeq) return;
      }

      activeError = null;
      isLoading = false;
      syncUi();
      selectionToolbar.refresh();
      if (workspaceFiles.length === 0 && !workspaceLoading) {
        void refreshWorkspaceList(stat.path);
      }
    } catch (err) {
      if (reqId !== loadRequestSeq) return;
      if (options.isAutoRefresh) {
        // 自动刷新遇到原子写入短暂锁定或缺失时静默跳过本轮
        console.debug('[file-preview] 自动刷新本轮跳过:', err);
        return;
      }

      const apiErr = err instanceof SidecarApiError ? err : null;
      const title =
        apiErr?.status === 415
          ? tr('暂不支持的文件格式', 'Unsupported file format')
          : apiErr?.status === 404
            ? tr('未找到目标文件', 'File not found')
            : apiErr?.status === 403
              ? tr('无法访问该路径', 'Access denied')
              : tr('文档加载失败', 'Failed to load document');
      const message =
        apiErr?.userMessage ||
        (err instanceof Error
          ? err.message
          : tr('加载或渲染文件时出现未知错误。', 'An unknown error occurred while loading or rendering the file.'));

      const fallbackStat = inferFallbackFileStat(rawPath);
      // 404 表示文件不存在，使用 mtimeMs: 0 的兜底信息停止轮询；其余错误优先保留真实 stat 以支持徽标展示与自动刷新恢复
      const nextStat: FileStatInfo =
        apiErr?.status === 404 ? fallbackStat : (resolvedStat ?? fallbackStat);

      currentSource = {
        type: 'disk',
        path: nextStat.path,
        stat: nextStat,
      };
      setErrorState(title, message, apiErr?.code, nextStat.path || rawPath);
    }
  }

  async function openLocalDroppedFile(file: File): Promise<void> {
    const reqId = ++loadRequestSeq;
    const classified = classifyDroppedFile(file.name);

    selectionToolbar.hide();
    selectionToolbar.clearSentMark();
    drawerOpen = false;
    viewMode = 'preview';
    toolbar.resetSearch();

    if (!classified.kind) {
      currentSource = null;
      setErrorState(
        classified.errorTitle || tr('不支持的文件格式', 'Unsupported file format'),
        classified.errorMessage ||
          tr(
            '不支持该文件格式，请确认文件为受支持的文档、图片、音视频或网页格式。',
            'Unsupported file format. Please choose a supported document, image, audio, video, or HTML file.',
          ),
      );
      return;
    }

    currentSource = {
      type: 'local',
      name: file.name,
      ext: classified.ext,
      kind: classified.kind,
      size: file.size,
    };
    activeError = null;
    isLoading = true;
    loadingTextEl.textContent = tr(
      `正在解析本地文件 ${file.name}...`,
      `Parsing local file ${file.name}...`,
    );
    syncUi();

    try {
      if (classified.kind === 'html') {
        const sourceText = await file.text();
        if (reqId !== loadRequestSeq) return;

        const renderer = mountRendererWithState('html');
        await renderer.loadHtml?.(null, sourceText, {
          name: file.name,
          path: file.name,
          ext: classified.ext,
        });
      } else if (classified.kind === 'pdf') {
        const buffer = await file.arrayBuffer();
        if (reqId !== loadRequestSeq) return;

        const renderer = mountRendererWithState('pdf');
        await renderer.loadPdf?.(null, buffer, {
          name: file.name,
          path: file.name,
          ext: classified.ext,
          size: file.size,
        });
      } else if (classified.kind === 'mp4') {
        const objectUrl = URL.createObjectURL(file);
        const renderer = mountRendererWithState('mp4');
        await renderer.loadVideo?.(null, objectUrl, {
          name: file.name,
          path: file.name,
          ext: classified.ext,
          size: file.size,
        });
      } else if (classified.kind === 'audio') {
        const objectUrl = URL.createObjectURL(file);
        const renderer = mountRendererWithState('audio');
        await renderer.loadAudio?.(null, objectUrl, {
          name: file.name,
          path: file.name,
          ext: classified.ext,
          size: file.size,
        });
      } else if (classified.kind === 'image') {
        const objectUrl = URL.createObjectURL(file);
        const renderer = mountRendererWithState('image');
        await renderer.loadImage?.(null, objectUrl, {
          name: file.name,
          path: file.name,
          ext: classified.ext,
          size: file.size,
        });
      } else {
        const buffer = await file.arrayBuffer();
        if (reqId !== loadRequestSeq) return;

        const renderer = mountRendererWithState(classified.kind);
        await renderer.loadBuffer?.(buffer, {
          name: file.name,
          path: file.name,
          ext: classified.ext,
        });
      }

      if (reqId !== loadRequestSeq) return;
      isLoading = false;
      syncUi();
    } catch (err) {
      if (reqId !== loadRequestSeq) return;
      const message =
        err instanceof Error
          ? err.message
          : tr('本地文件解析失败，请确认文件未损坏。', 'Failed to parse local file. Verify it is not corrupted.');
      setErrorState(tr('本地文件渲染失败', 'Failed to render local file'), message);
    }
  }

  // 全屏文件拖拽支持
  let dragDepth = 0;
  const hasDraggedFiles = (event: DragEvent): boolean =>
    Boolean(event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files'));

  window.addEventListener('dragenter', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    dropOverlay.hidden = false;
    refreshLiquidGlass(dropBox);
  });

  window.addEventListener('dragover', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  window.addEventListener('dragleave', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropOverlay.hidden = true;
    }
  });

  window.addEventListener('drop', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    const droppedFile = e.dataTransfer?.files?.[0];
    if (droppedFile) {
      void openLocalDroppedFile(droppedFile);
    }
  });

  // 检查当前磁盘文件是否有更新（结合 Page Visibility，后台/折叠时休眠节流）
  async function checkDiskFileUpdate(): Promise<void> {
    if (!autoRefreshEnabled || isLoading || isPollingStat) {
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    if (currentSource?.type !== 'disk' || currentSource.stat.mtimeMs <= 0) {
      return;
    }

    const targetPath = currentSource.path;
    const prevMtime = currentSource.stat.mtimeMs;
    const prevSize = currentSource.stat.size;

    isPollingStat = true;
    try {
      const nextStat = await statFile(targetPath);
      if (
        currentSource?.type === 'disk' &&
        currentSource.path === targetPath &&
        (nextStat.mtimeMs !== prevMtime || nextStat.size !== prevSize)
      ) {
        await openDiskFile(targetPath, { isAutoRefresh: true });
      }
    } catch {
      // 轮询期间文件可能正处于写入替换中，忽略单次检测错误
    } finally {
      isPollingStat = false;
    }
  }

  // 自动刷新监听（每 2.5s 检查一次磁盘文件 mtimeMs，前台可见时生效）
  const pollTimer = window.setInterval(() => {
    void checkDiskFileUpdate();
  }, AUTO_REFRESH_INTERVAL_MS);

  // 页面从后台恢复可见或窗口聚焦时，立即触发一次静默检查，无需等待 2.5s 计时器
  const handleVisibilityOrFocus = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void checkDiskFileUpdate();
    }
  };
  document.addEventListener('visibilitychange', handleVisibilityOrFocus);
  window.addEventListener('focus', handleVisibilityOrFocus);

  // 启动主题、外观、语言与工作区事件同步
  const stopThemeSync = startThemeSync();
  const stopAppearanceGlassSync = subscribeAppearanceChanges(() => {
    refreshAllLiquidGlass();
  });
  const stopLocaleSync = onLocaleChange(() => {
    applyStaticShellLocale();
    if (isLoading) {
      loadingTextEl.textContent = tr('正在加载并渲染文档...', 'Loading and rendering document...');
    }
    syncUi();
  });
  const stopWorkspaceSync = subscribeWorkspaceChanges(() => {
    void refreshWorkspaceList(currentSource?.type === 'disk' ? currentSource.path : null);
  });

  window.addEventListener('beforeunload', () => {
    window.clearInterval(pollTimer);
    document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
    window.removeEventListener('focus', handleVisibilityOrFocus);
    if (toastTimer !== null) {
      window.clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (toastHideTimer !== null) {
      window.clearTimeout(toastHideTimer);
      toastHideTimer = null;
    }
    stopThemeSync();
    stopAppearanceGlassSync();
    stopLocaleSync();
    stopWorkspaceSync();
    detachLoadingGlass();
    detachToastGlass();
    detachDropGlass();
    appearancePopover.destroy();
    selectionToolbar.destroy();
    destroyActiveRenderer();
    toolbar.destroy();
    welcomeBrowser.destroy();
    drawerBrowser.destroy();
  });

  // 启动路由：检查 URL ?file= 参数
  const initialFile = new URLSearchParams(window.location.search).get('file')?.trim();
  if (initialFile) {
    void openDiskFile(initialFile);
    void refreshWorkspaceList(initialFile);
  } else {
    syncUi();
    void refreshWorkspaceList();
  }
}

bootstrap();
